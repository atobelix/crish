//! 会话缓存跟踪器（P5 S2 / T-36：CacheStatsTracker + RunOutcome.cache_stats）
//!
//! 本模块是 P5 测量层在 session-loop 的接线面。算法真源全部位于
//! `conex-telemetry::cache`（T-35 纯函数模块，叶子约束、协议无关）：
//!
//! - 请求签名 / 基线：`RequestSignature` / `CacheBaseline`（signature.rs）；
//! - 归一化口径：`CacheUsageScalars` → `CacheBreakdownMath`（math.rs，C9 恒等式）；
//! - miss 检测与归因：`MissDetector::detect` + `classify`（miss.rs）；
//! - 冷缓存：`cold_cache_check` / `warm_until` / `is_cold`（cold.rs）。
//!
//! tracker 自身只做状态编排：请求发送前捕获签名 → turn 结束后消费 usage →
//! run 级聚合（[RunCacheStats]，收口移交 `RunOutcome.cache_stats`）→
//! 基线经 [CacheStatsTracker::baseline] 交还调用方（engine 层跨 run 持久化
//! 归 T-40）。
//!
//! 职责边界（P5 §1.3「只测不改」）：只读观测——绝不改变请求字节、绝不触发
//! 重试、绝不干预循环行为。
//!
//! 接线点（T-40 engine 接线时消费本模块 API）：
//! - 经 `SessionLoopOptions.cache_tracking`（[CacheTrackingConfig]）注入
//!   LoopState（provider / model / TTL 由 engine 装配，TTL 走 P3
//!   `cache_ttl_for_provider_model` 查询）；
//! - `streaming::handle` 在 build_request 前捕获签名、turn 后消费 usage；
//! - `apply_compaction`（压缩事件单一广播点）触发 `on_compaction`
//!   （C13：代数 +1、基线作废）；
//! - `converge` 收口 `finish()` → `RunOutcome.cache_stats`。
//!
//! ## C1c 裁决（抽象纪律审计点 · 详案-C1-核心循环瘦身.md C1c 段 / 00-核心逻辑模型草案.md §7）
//!
//! **CacheTelemetry 缝面：登记，不建 trait。** 本模块 [CacheStatsTracker] 是
//! 缓存遥测/查询面（capture/record/finish/on_compaction/model 等）的
//! **唯一实现**；装配缝 = [build_tracker]（构造经 `CacheTrackingConfig`）+
//! LoopState 的 `Option<CacheStatsTracker>` 引用（None = 未装配缓存测量，
//! 行为与现状一致）——C1c 起该引用落在 `CompactionRuntime` 子结构内。
//! 按接口两实现法则（抽象接口只在已有 ≥2 个真实实现时成立；单一实现
//! 一律直接用具体类型），**登记缝面形态、具体类型直连，不强行 trait**；
//! 未来出现第二实现（如会话级跨 run 遥测聚合器）时再升级为
//! `CacheTelemetry` trait。

use std::sync::Arc;

use conex_telemetry::cache::{
    classify, cold_cache_check, is_cold, prefix_diff_index, warm_until, CacheBaseline,
    CacheBreakdownMath, CacheUsageScalars, ColdCacheWarning, MissDetector, MissReason,
    PrefixDiffKind, RequestSignature, LOW_HIT_RATIO_PCT,
};
use conex_types::events::{MissAttribution, RunCacheStats};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use crate::provider::ToolSchema;

/// FNV-1a 64 位偏移基值
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a 64 位素数
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 缓存跟踪配置（经 SessionLoopOptions 注入 LoopState；T-40 engine 接线点——
/// provider / model 由 engine 装配、TTL 走 P3 路由表查询，None 语义 = 未知）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheTrackingConfig {
    /// 供应商标识（基线标识与归因 ProviderSwitch 用）
    pub provider: String,
    /// 模型标识（基线标识与归因 ModelSwitch 用）
    pub model: String,
    /// 缓存 TTL 秒数（P3 路由表；0 = 未知 / 无缓存——跳过 TTL 归因与
    /// 温暖截止计算，对齐 P5 §3.4.4「TTL 查询失败不提示」）
    pub ttl_seconds: u64,
}

/// 单次 miss 审计结果（`record_usage` 产出；T-40 按告警阈值转
/// `cache-waste-alert` 事件，阈值常量在 conex-telemetry）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CacheMiss {
    /// 浪费量（detectMiss 结果，已过噪声地板）
    pub missed_tokens: u64,
    /// 距上次请求完成时刻的空闲时长（毫秒）
    pub idle_ms: u64,
    /// 归因分类（conex-types MissAttribution，wire kebab-case）
    pub attribution: MissAttribution,
    /// 模型是否发生了变化（pi：模型切换不豁免，miss 仍计数）
    pub model_changed: bool,
}

/// 会话缓存跟踪器（每 run 一个；构造 / 复位点 = LoopState 构造 + run() 起始，
/// 与 T-33 的压缩护栏归零点并列——fresh run 语义，P5 §3.4.5 跨会话重建）
pub struct CacheStatsTracker {
    /// 请求前签名基线（run 内跨 turn 维护；收口后经 [`Self::baseline`] 移交
    /// engine 层持久化，供跨 run 冷缓存预警使用）
    baseline: Option<CacheBaseline>,
    /// run 内聚合（`CacheBreakdownMath::add_assign` 逐 turn 累加）
    run_stats: Option<CacheBreakdownMath>,
    /// reportedCache 粘性（pi 语义，P5 §3.4.2）：本 run 内报告过
    /// read / write > 0 才计 miss（无缓存能力的本地服务器不误报）
    reported_cache: bool,
    /// 供应商标识（基线标识与归因 ProviderSwitch 用）
    provider: String,
    /// 模型标识（基线标识与归因 ModelSwitch 用）
    model: String,
    /// 缓存 TTL 秒数（0 = 未知；P3 表查询结果，T-40 注入）
    ttl_seconds: u64,
    /// 压缩代数（C13：`on_compaction` 代数 +1 且基线作废；代数变化
    /// ⇒ 基线作废，双保险对齐 jcode KvCacheBaseline）
    generation: u64,
    /// 请求发送前捕获的最新签名（`capture_signature` 写入；`record_usage`
    /// 刷新基线时消费）
    pending_signature: Option<RequestSignature>,
    /// 压缩后首请求待消费标记（`on_compaction` 置位、`record_usage` 消费
    /// 后清除；run 内生命周期——run 收口未消费时下个 run tracker 新建
    /// 自然丢失，无挂起残留，v1.1 §5.2）
    pending_compaction: bool,
    /// 压缩后重建签名（`capture_post_compaction` 写入——apply_compaction
    /// 对话替换后捕获的"压缩后真实请求前缀"预测；`record_usage` 前缀
    /// 比对消费后清空防陈旧）
    rebuild_signature: Option<RequestSignature>,
    /// 模型切换待归因标记（`on_model_switch` 置位；下一次 `record_usage`
    /// 归因 ModelSwitch，之后随基线刷新清除——「签名基线作废」语义，P5 §3.4.5）
    model_switch_pending: bool,
    /// 上次 `capture_signature` 的签名（增量计算锚点；system/tools 不变且
    /// 消息仅追加时，下一轮只对新消息做哈希并 fold 到本签名的 `messages_hash`，
    /// 避免每轮 O(N) 全量重算——1C-4 优化）。压缩（`on_compaction` /
    /// `capture_post_compaction`）会替换对话 → 置 None 强制下一轮全量重算。
    last_signature: Option<RequestSignature>,
    /// run 级输入 token 累计（wire promptTokens；CacheBreakdownMath 不含此标量）
    prompt_tokens: u64,
    /// run 级输出 token 累计（wire completionTokens）
    completion_tokens: u64,
    /// run 级总 token 累计（wire totalTokens）
    total_tokens: u64,
    /// 有真实 usage 的 turn 数（0 = 无样本，前端隐藏而非显示 0%）
    sample_count: u64,
    /// 本 run 审计出的浪费量（detectMiss 累计，P5 §3.3.1）
    missed_tokens: u64,
}

impl CacheStatsTracker {
    /// 新建跟踪器（provider / model 为归因与基线标识；TTL 缺省 0 = 未知，
    /// 由 engine 层按 P3 路由表注入）
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            baseline: None,
            run_stats: None,
            reported_cache: false,
            provider: provider.into(),
            model: model.into(),
            ttl_seconds: 0,
            generation: 0,
            pending_signature: None,
            pending_compaction: false,
            rebuild_signature: None,
            model_switch_pending: false,
            last_signature: None,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            sample_count: 0,
            missed_tokens: 0,
        }
    }

    /// 从配置构造（LoopState 构造与 run 起始复位共用入口）
    pub fn from_config(config: &CacheTrackingConfig) -> Self {
        Self::new(config.provider.clone(), config.model.clone()).with_ttl(config.ttl_seconds)
    }

    /// 设置缓存 TTL（秒；0 = 未知 / 无缓存）
    pub fn with_ttl(mut self, ttl_seconds: u64) -> Self {
        self.ttl_seconds = ttl_seconds;
        self
    }

    /// 请求发送前捕获签名（P5 §3.4.1「BEFORE sending」，对齐 jcode
    /// `record_request`）：从 build_request 的输入投影 system / tools /
    /// messages 哈希。投影剔除 created_at / metadata / client_message_id /
    /// content 兜底（timestamp / reasoning_trace / 噪声元数据与缓存前缀无关）。
    ///
    /// 不携带即时性：调用方在 `build_request` 之前调用即可（同一输入快照）。
    pub fn capture_signature(
        &mut self,
        system: Option<&str>,
        tools: &[ToolSchema],
        messages: &[Arc<AgentMessage>],
    ) {
        let sig = build_request_signature_incremental(
            system,
            tools,
            messages,
            self.last_signature.take(),
        );
        self.last_signature = Some(sig.clone());
        self.pending_signature = Some(sig);
    }

    /// 压缩后重建签名（v1.1 §5.1 T-28 / 02 分析 §五 E1）：在 apply_compaction
    /// 把对话替换为压缩产物（`state.conversation = plan.messages.clone()`）
    /// 之后调用，捕获"压缩后真实请求前缀"的预测签名——system / tools /
    /// messages 投影与 [Self::capture_signature] 同一构造路径（`build_request_signature`），
    /// 因此正常路径（无中途改写）下两者相等（评审 02 §3.3 时序已核实）。
    ///
    /// 签名型基线，不携带 token 数。轮次 4（T-31）在 handlers/mod.rs
    /// `apply_compaction` 中接线；本轮仅提供能力——未接线时
    /// `rebuild_signature` 保持 None，[Self::record_usage] 走回退（直接清
    /// pending 不比对，行为与现状一致）。
    pub fn capture_post_compaction(
        &mut self,
        system: Option<&str>,
        tools: &[ToolSchema],
        messages: &[Arc<AgentMessage>],
    ) {
        // 压缩后对话被替换——增量签名锚点失效，强制全量重算（1C-4）
        self.last_signature = None;
        self.rebuild_signature = Some(build_request_signature(system, tools, messages));
    }

    /// turn 结束后消费 usage（标量面 + completion / total），产出可选的
    /// [CacheMiss]（审计命中）；内部完成：
    ///
    /// 1. 归一化派生（[CacheBreakdownMath::from_usage]，C9 口径唯一真源）；
    /// 2. run 级聚合（add_assign 逐 turn 累加；aborted / error 回合的实测
    ///    usage 仍计入，pi estimate.ts:76-78 排除的是"估算"）；
    /// 3. reportedCache 粘性更新；
    /// 4. miss 检测（[MissDetector::detect]：min(prev, cur) - cur.read，
    ///    噪声地板 1024）+ 归因组合（[classify] → [MissAttribution]）；
    /// 5. 基线刷新：当前 turn 成为新基线（签名 + input_total + 完成时刻），
    ///    模型切换待归因标记清除。
    pub fn record_usage(
        &mut self,
        usage: CacheUsageScalars,
        completion_tokens: u64,
        total_tokens: u64,
        completed_at_ms: u64,
    ) -> Option<CacheMiss> {
        // 1. 归一化派生（C9 口径）
        let breakdown = CacheBreakdownMath::from_usage(usage);
        // 2. run 级聚合
        let acc = self.run_stats.as_mut();
        match acc {
            Some(acc) => acc.add_assign(&breakdown),
            None => self.run_stats = Some(breakdown),
        }
        self.prompt_tokens = self.prompt_tokens.saturating_add(usage.prompt);
        self.completion_tokens = self.completion_tokens.saturating_add(completion_tokens);
        self.total_tokens = self.total_tokens.saturating_add(total_tokens);
        self.sample_count += 1;
        // 3. reportedCache 粘性（报告过缓存活动才计 miss）
        self.reported_cache = self.reported_cache || usage.read > 0 || usage.write > 0;
        // 4. miss 检测（无基线 / 未报告缓存 → None）与归因组合
        let baseline = self.baseline.clone();
        // 4.1 压缩后首请求前缀比对（v1.1 §5.1 T-29 / 评审 02 P1-4）：
        //     pending_compaction 且无基线（on_compaction 已作废基线）时，
        //     拿重建签名与本次捕获的 cur 做前缀比对——差异点仅在追加区
        //     （Identical / TailAppend）→ 正常（追加区豁免，不误报 harness
        //     改写）；差异点在历史区（HeadRewrite）→ warn 诊断 + 归因
        //     PrefixChanged。无论结果如何，消费后清 pending / 清空重建
        //     签名（防陈旧）。
        let mut post_compaction_rewritten = false;
        if self.pending_compaction && self.baseline.is_none() {
            let rebuild = self.rebuild_signature.take();
            let cur = self.pending_signature.clone().unwrap_or_default();
            if let Some(rebuild) = rebuild {
                let diff = prefix_diff_index(&rebuild.message_hashes, &cur.message_hashes);
                match diff.kind {
                    PrefixDiffKind::Identical | PrefixDiffKind::TailAppend => {
                        // 正常：压缩后首请求 = 重建前缀（或在其上纯追加）
                        tracing::debug!(
                            index = diff.index,
                            "压缩后首请求前缀与重建签名一致（或纯追加，追加区豁免）"
                        );
                    }
                    PrefixDiffKind::HeadRewrite => {
                        tracing::warn!(
                            index = diff.index,
                            "压缩后首请求前缀被改写（疑似 harness 二次改写）"
                        );
                        post_compaction_rewritten = true;
                    }
                }
            } else {
                // 轮次 4 未接线（capture_post_compaction 未调用）→ 回退：
                // 直接清 pending 不比对，行为与现状一致
                tracing::debug!(
                    "压缩后重建签名缺失（capture_post_compaction 未接线），跳过前缀比对"
                );
            }
            self.pending_compaction = false;
        }
        let miss = if post_compaction_rewritten {
            // 无基线时 detect 恒 None；HeadRewrite 是诊断信号——产出零浪费
            // 的 PrefixChanged 审计记录（attribution 供日志 / 告警消费，
            // missed_tokens 累计 +0 不影响 token 面）
            Some(CacheMiss {
                missed_tokens: 0,
                idle_ms: 0,
                attribution: MissAttribution::PrefixChanged,
                model_changed: false,
            })
        } else {
            MissDetector::detect(baseline.as_ref(), &breakdown, self.reported_cache).map(
                |missed_tokens| {
                    let idle_ms = baseline
                        .as_ref()
                        .map_or(0, |b| completed_at_ms.saturating_sub(b.completed_at_ms));
                    CacheMiss {
                        missed_tokens,
                        idle_ms,
                        attribution: self.classify_miss(&breakdown, completed_at_ms),
                        model_changed: self.model_switch_pending
                            || baseline.as_ref().map_or(false, |b| b.model != self.model),
                    }
                },
            )
        };
        if let Some(miss) = &miss {
            // 5. 浪费量审计累计（本 run 的 detectMiss 总和）
            self.missed_tokens = self.missed_tokens.saturating_add(miss.missed_tokens);
        }
        // 6. 基线刷新（当前 turn 成为新基线；未捕获签名时沿用旧签名——
        //    生产路径 streaming 总是先 capture 再 record）
        let signature = self
            .pending_signature
            .take()
            .or_else(|| baseline.as_ref().map(|b| b.signature.clone()))
            .unwrap_or_default();
        self.baseline = Some(CacheBaseline {
            signature,
            input_total: breakdown.input_total,
            read: breakdown.read,
            provider: self.provider.clone(),
            model: self.model.clone(),
            completed_at_ms,
            generation: self.generation,
        });
        self.model_switch_pending = false;
        miss
    }

    /// 压缩事件（P4 接线，C13）：代数 +1、签名基线作废（压缩是唯一前缀
    /// 重写点——压缩后是新内容非重放，不计 miss，pi prev=undefined 语义）。
    ///
    /// v1.1 §5.1 T-27 扩展：置 `pending_compaction`（压缩后首请求需与重建
    /// 签名做前缀比对，见 [Self::record_usage]）；`rebuild_signature` 清空，
    /// 待 `capture_post_compaction`（apply_compaction 之后）填充。
    pub fn on_compaction(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.baseline = None;
        self.pending_compaction = true;
        self.rebuild_signature = None;
        // 压缩会替换对话——增量签名锚点失效，强制下一轮全量重算（1C-4）
        self.last_signature = None;
    }

    /// 外部代数注入（R-K 单源能力面，v1.1 §5.1 T-30 / 评审 02 P0-5）：
    /// 用会话级权威代数（`SessionContextMeta.last_compaction_generation` /
    /// `LoopState.compact_generation`，u32）校准内部 `generation`——覆盖
    /// 内部自增值，基线代数戳随注入值对齐，消除双计数源漂移。
    ///
    /// 轮次 4（T-31）将在 `apply_compaction` 中接线：压缩事件发生时用
    /// 会话级代数注入本字段，替代内部自增成为唯一消费源；本轮仅提供
    /// API——`on_compaction` 的内部自增保留为回退（外部未注入时语义
    /// 不变，双源场景下注入值随时可校准覆盖）。
    pub fn apply_external_generation(&mut self, gen: u32) {
        self.generation = u64::from(gen);
    }

    /// 模型切换（engine 层 run 启动时比对会话上一 run 的 model）：
    /// 签名基线作废（防 prefix_changed 误报，jcode CacheTracker.reset :190）
    /// 但 miss 仍计——归因 ModelSwitch（pi："Model switches are NOT exempt"）。
    ///
    /// 实现：置模型切换待归因标记（下一次 record_usage 归因 ModelSwitch 并
    /// 刷新基线，token 基线不丢——detect 的 min(prev, cur) 仍可用）。
    pub fn on_model_switch(&mut self) {
        self.model_switch_pending = true;
    }

    /// 当前模型标识（EV-11/D-03：provider-request-anchored 事件 model 载荷
    /// 来源；装配面 = [CacheTrackingConfig] 经 engine 注入，None 语义 = 未
    /// 装配缓存测量时事件 model 为 None）
    pub fn model(&self) -> &str {
        &self.model
    }

    /// 冷缓存预警判定（请求启动路径，P5 §3.4.4）：无基线 / 未超 TTL /
    /// TTL 未知（调用方传 0 时按 ttl_seconds == 0 不判定——P5 约定 TTL
    /// 查询失败不提示，见函数注释）→ None
    ///
    /// 口径登记（2026-08-09 遥测零消费清理，DEEPCHECK-05 #5）：本方法是
    /// **run 内**路径（消费当前 run 的基线），生产侧冷缓存预警现由 engine
    /// 跨 run 路径承担——engine 已统一直接消费 telemetry 纯函数
    /// [`cold_cache_check`] / [`is_cold`]（engine.rs `cold_cache_warning_event`），
    /// 本方法与之一体（同一纯函数底座），待跨 run 基线续接（session-loop
    /// 侧）接线后成为 run 启动路径消费点。
    pub fn cold_cache_check(&self, now_ms: u64) -> Option<ColdCacheWarning> {
        if self.ttl_seconds == 0 {
            return None;
        }
        cold_cache_check(self.baseline.as_ref(), now_ms, self.ttl_seconds)
    }

    /// 缓存温暖截止时刻（毫秒时间戳）：**最后一次完成时刻 + ttl × 1000**；
    /// 无基线或 TTL 未知（0）→ None（与 [Self::finish] 的 warm_until_ms 口径一致，
    /// 截止锚定基线而非查询时刻，避免同一缓存条目到期时间随询问时间漂移）。
    pub fn warm_until_ms(&self, now_ms: u64) -> Option<i64> {
        let _ = now_ms; // 兼容参数：截止与查询时刻无关
        self.baseline.as_ref().and_then(|b| {
            (self.ttl_seconds > 0).then(|| warm_until(b.completed_at_ms, self.ttl_seconds))
        })
    }

    /// 当前是否已冷（`now` 超过温暖截止；无基线 / TTL 未知 → false）
    pub fn is_cold(&self, now_ms: u64) -> bool {
        self.warm_until_ms(now_ms)
            .map_or(false, |warm| is_cold(now_ms, warm))
    }

    /// 当前基线（只读；run 收口后 engine 层据此持久化跨 run 基线，T-40）
    pub fn baseline(&self) -> Option<&CacheBaseline> {
        self.baseline.as_ref()
    }

    /// 压缩后重建签名（只读；T-31 断言面——apply_compaction 接线后可查。
    /// 仅测试消费（handlers/mod.rs 断言接线发生），生产面由 record_usage
    /// 内部消费私有字段）
    #[cfg(test)]
    pub(crate) fn rebuild_signature(&self) -> Option<&RequestSignature> {
        self.rebuild_signature.as_ref()
    }

    /// run 收口：产出 run 级缓存统计（`RunOutcome.cache_stats` 载荷；
    /// 无任何 usage 样本时全零 + 占比 None——前端隐藏而非显示 0%）
    pub fn finish(self) -> RunCacheStats {
        let stats = self.run_stats.unwrap_or_default();
        RunCacheStats {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            total_tokens: self.total_tokens,
            cache_read_tokens: stats.read,
            cache_write_tokens: stats.write,
            cache_miss_tokens: stats.miss,
            sample_count: self.sample_count,
            hit_ratio: stats.hit_ratio,
            write_ratio: stats.write_ratio,
            missed_tokens: self.missed_tokens,
            warm_until_ms: self
                .baseline
                .as_ref()
                .and_then(|b| {
                    (self.ttl_seconds > 0).then(|| {
                        u64::try_from(warm_until(b.completed_at_ms, self.ttl_seconds)).ok()
                    })
                })
                .flatten(),
        }
    }

    /// 归因组合（P5 §3.4.3 分类序 + T-35 `classify` 判定序的映射层）：
    ///
    /// 1. 压缩代数变化 → `Compaction`（C13 防御路径：`on_compaction` 已作废
    ///    基线，正常不可达；此归因用于历史事件解释）；
    /// 2. `classify`（TTL 超时优先 → 供应商 / 模型切换 → 前缀哈希变化，
    ///    任务书 T-35 口径）映射为 7 类；
    /// 3. `Unknown` 兜底细化：read == 0 且报告过缓存 → `ZeroRead`；
    ///    断裂判定（cacheRead 骤降 >5% 且 >2000 token）或命中率低于 85%
    ///    → `LowRead`；其余 `Unknown`（`Cold` 只在无基线时出现——此时
    ///    detect 不计 miss，故不产出）。
    fn classify_miss(
        &self,
        breakdown: &CacheBreakdownMath,
        completed_at_ms: u64,
    ) -> MissAttribution {
        let baseline = self.baseline.as_ref();
        // 1. 压缩代数变化（正常不可达的防御分支）
        if let Some(b) = baseline {
            if b.generation != self.generation {
                return MissAttribution::Compaction;
            }
        }
        let model_changed =
            self.model_switch_pending || baseline.map_or(false, |b| b.model != self.model);
        let provider_changed = baseline.map_or(false, |b| b.provider != self.provider);
        let idle_ms = baseline.map_or(0, |b| completed_at_ms.saturating_sub(b.completed_at_ms));
        // 模型切换待归因 / 无捕获签名时跳过前缀类判定（宁缺勿误报）
        let prev_signature = if self.model_switch_pending {
            None
        } else {
            baseline.map(|b| &b.signature)
        };
        let default_signature = RequestSignature::default();
        let cur_signature = self
            .pending_signature
            .as_ref()
            .unwrap_or(&default_signature);
        let reason = classify(
            prev_signature,
            cur_signature,
            idle_ms,
            self.ttl_seconds,
            model_changed,
            provider_changed,
        );
        match reason {
            MissReason::Expired => MissAttribution::IdleTtlExpired,
            MissReason::ProviderSwitch | MissReason::ModelSwitch => MissAttribution::ModelSwitch,
            MissReason::HarnessSystemChanged
            | MissReason::HarnessToolsChanged
            | MissReason::HarnessPrefixChanged => MissAttribution::PrefixChanged,
            MissReason::Unknown => {
                // 兜底细化（P5 §3.4.3 第 7-8 类；detect 已保证 reported_cache）
                if breakdown.read == 0 {
                    MissAttribution::ZeroRead
                } else if self.is_break_signal(baseline, breakdown)
                    || breakdown.hit_ratio.map_or(true, |r| r < LOW_HIT_RATIO_PCT)
                {
                    MissAttribution::LowRead
                } else {
                    MissAttribution::Unknown
                }
            }
        }
    }

    /// 断裂判定信号（P5 §3.4.2 / DEEPCHECK-05 #5 接线点）：`cacheRead` 较
    /// 上次骤降 >5% 且绝对下降 >2000 token → 缓存条目被驱逐 / 断裂的强
    /// 信号，兜底归因 LowRead（签名未变、未过期、未切换时仍低命中的最
    /// 可能解释；Claude Code 两阶段口径，[`MissDetector::is_break`]）。
    ///
    /// 无基线（首轮 / 压缩后）→ false（无 prev_read 可比较）。
    fn is_break_signal(&self, baseline: Option<&CacheBaseline>, cur: &CacheBreakdownMath) -> bool {
        let Some(b) = baseline else {
            return false;
        };
        MissDetector::is_break(b.read, cur.read, b.input_total)
    }
}

/// 从配置构造跟踪器（LoopState 构造与 run 起始复位共用；None = 不启用缓存
/// 测量，行为与现状一致）
pub(crate) fn build_tracker(config: Option<&CacheTrackingConfig>) -> Option<CacheStatsTracker> {
    config.map(CacheStatsTracker::from_config)
}

// ── 请求签名投影（P5 §3.4.1：简单稳定哈希）──────────────────────────────

/// FNV-1a 64 位哈希（简单稳定：跨进程 / 跨编译器版本确定，供基线持久化后
/// 跨 run 比对；对齐 jcode 用 DefaultHasher 的等价目的，P5 §3.4.1「与 jcode
/// 同」——FNV 实现无标准库算法版本漂移风险）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// 折叠两条哈希（FNV 增量风格：两段 8 字节小端拼接再哈希——顺序敏感）
fn fnv1a_mix(a: u64, b: u64) -> u64 {
    let mut buf = [0u8; 16];
    buf[..8].copy_from_slice(&a.to_le_bytes());
    buf[8..].copy_from_slice(&b.to_le_bytes());
    fnv1a(&buf)
}

/// 角色标签（投影输入；显式常量避免依赖 serde 的 rename 细节）
fn role_tag(role: AgentMessageRole) -> &'static str {
    match role {
        AgentMessageRole::System => "system",
        AgentMessageRole::User => "user",
        AgentMessageRole::Assistant => "assistant",
        AgentMessageRole::Tool => "tool",
    }
}

/// 消息哈希投影（保留项 = role + blocks 类型与内容 + 工具调用参数；
/// 剔除项 = created_at / metadata / client_message_id / content 兜底，
/// P5 §3.4.1 投影清单）
fn message_hash(message: &AgentMessage) -> u64 {
    let mut bytes = Vec::with_capacity(64);
    bytes.extend_from_slice(role_tag(message.role).as_bytes());
    for block in &message.blocks {
        block_hash(block, &mut bytes);
    }
    fnv1a(&bytes)
}

/// 块哈希投影（带类型标签前缀——「text」与「thought」同文不混淆）
fn block_hash(block: &AgentMessageBlock, out: &mut Vec<u8>) {
    match block {
        AgentMessageBlock::Text { text } => {
            out.extend_from_slice(b"text\0");
            out.extend_from_slice(text.as_bytes());
        }
        AgentMessageBlock::Thought { text, redacted } => {
            out.extend_from_slice(b"thought\0");
            out.extend_from_slice(text.as_bytes());
            out.push(redacted.unwrap_or(false) as u8);
        }
        AgentMessageBlock::ToolCall(call) => {
            out.extend_from_slice(b"tool-call\0");
            out.extend_from_slice(call.id.as_bytes());
            out.push(0);
            out.extend_from_slice(call.tool_name.as_bytes());
            out.push(0);
            // 入参 JSON（serde_json::Value 为 BTreeMap 键序 → 序列化确定）
            out.extend_from_slice(
                serde_json::to_string(&call.input)
                    .unwrap_or_default()
                    .as_bytes(),
            );
        }
        AgentMessageBlock::ToolResult {
            tool_call_id,
            tool_name,
            output,
            is_error,
        } => {
            out.extend_from_slice(b"tool-result\0");
            out.extend_from_slice(tool_call_id.as_bytes());
            out.push(0);
            out.extend_from_slice(tool_name.as_bytes());
            out.push(0);
            out.push(*is_error as u8);
            // 输出内容投影 text 正文（剔除状态 / 元数据噪声）
            out.extend_from_slice(output.text.as_deref().unwrap_or("").as_bytes());
        }
    }
}

/// 工具集合哈希投影（{name, description, input_schema} 按序序列化；
/// 与 P4 `tools_prefix_json` 同源投影，serde_json::Value 键序确定）
fn tools_hash(tools: &[ToolSchema]) -> u64 {
    let value: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name.clone(),
                "description": t.description.clone(),
                "input_schema": t.input_schema.clone(),
            })
        })
        .collect();
    fnv1a(serde_json::to_string(&value).unwrap_or_default().as_bytes())
}

/// 构建请求签名（system / tools / messages 投影 + 逐消息哈希链）。
/// `messages_hash` = 逐条哈希的顺序折叠（append-only 前缀对比输入）。
pub(crate) fn build_request_signature(
    system: Option<&str>,
    tools: &[ToolSchema],
    messages: &[Arc<AgentMessage>],
) -> RequestSignature {
    let system_hash = fnv1a(system.unwrap_or("").as_bytes());
    let tools_hash = tools_hash(tools);
    let message_hashes: Vec<u64> = messages.iter().map(|m| message_hash(m)).collect();
    let messages_hash = message_hashes.iter().copied().fold(0, fnv1a_mix);
    RequestSignature {
        system_hash,
        tools_hash,
        messages_hash,
        message_hashes,
        message_count: messages.len(),
        tool_count: tools.len(),
    }
}

/// 构建请求签名（增量版，1C-4）。
///
/// 常见路径：system / tools 不变，对话仅追加新消息 → 复用上一签名的
/// `message_hashes[..prev_count]` 与已折叠的 `messages_hash`，只对新增
/// 消息 `messages[prev_count..]` 做哈希并 fold，签名计算从每轮 O(N) 降为
/// O(新增消息数)。
///
/// 安全条件（任一不满足 → 回退全量重算，保证增量与全量结果恒等）：
/// - 上一签名存在且 `prev_count <= messages.len()`；
/// - `system_hash` / `tools_hash` 与上一签名一致（重新计算两个标量哈希
///   成本 O(1) / O(T)，远低于全量消息哈希 O(N)）。
///
/// 前缀消息被改写（如压缩）的路径由调用方在压缩时清除 `last_signature`
/// 强制全量重算覆盖（`on_compaction` / `capture_post_compaction`）。
pub(crate) fn build_request_signature_incremental(
    system: Option<&str>,
    tools: &[ToolSchema],
    messages: &[Arc<AgentMessage>],
    prev: Option<RequestSignature>,
) -> RequestSignature {
    let system_hash = fnv1a(system.unwrap_or("").as_bytes());
    let tools_hash = tools_hash(tools);
    // 增量适用判定：上一签名存在、前缀覆盖、system/tools 未变
    let incremental = prev
        .as_ref()
        .filter(|p| {
            p.message_count <= messages.len()
                && p.system_hash == system_hash
                && p.tools_hash == tools_hash
        })
        .is_some();
    if !incremental {
        return build_request_signature(system, tools, messages);
    }
    let prev = prev.unwrap();
    let prev_count = prev.message_count;
    // 复用前缀哈希，只对新增消息计算
    let mut message_hashes = prev.message_hashes;
    let mut messages_hash = prev.messages_hash;
    for m in &messages[prev_count..] {
        let h = message_hash(m);
        messages_hash = fnv1a_mix(messages_hash, h);
        message_hashes.push(h);
    }
    RequestSignature {
        system_hash,
        tools_hash,
        messages_hash,
        message_hashes,
        message_count: messages.len(),
        tool_count: tools.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_telemetry::cache::{CacheAccountingKind, CacheUsageScalars};

    fn msg(id: &str, role: AgentMessageRole, text: &str, created_at: &str) -> Arc<AgentMessage> {
        Arc::new(AgentMessage {
            id: id.to_string(),
            role,
            created_at: created_at.to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: text.to_string(),
            }],
            metadata: Some(serde_json::json!({ "usage": { "promptTokens": 100 } })),
            client_message_id: Some("cm".to_string()),
            content: Some(text.to_string()),
        })
    }

    fn tools() -> Vec<ToolSchema> {
        vec![ToolSchema {
            name: "t1".to_string(),
            description: "测试工具".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
        }]
    }

    fn scalars(prompt: u64, read: u64, write: u64, miss: Option<u64>) -> CacheUsageScalars {
        CacheUsageScalars {
            prompt,
            read,
            write,
            miss,
            accounting: CacheAccountingKind::Included,
        }
    }

    fn tracker(ttl: u64) -> CacheStatsTracker {
        CacheStatsTracker::new("deepseek", "deepseek-v4-flash").with_ttl(ttl)
    }

    // ── 签名捕获 ──

    /// 投影剔除 created_at / metadata / client_message_id / content（P5 §3.4.1）：
    /// 同 role + 同 blocks 内容的消息，时间戳与元数据差异不改变哈希
    #[test]
    fn signature_capture_ignores_timestamps_and_metadata() {
        let a = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let b = msg("m1", AgentMessageRole::User, "你好", "2026-01-02T00:00:00Z");
        let sig_a = build_request_signature(Some("sys"), &tools(), &[a]);
        let sig_b = build_request_signature(Some("sys"), &tools(), &[b]);
        assert_eq!(sig_a, sig_b, "时间戳 / 元数据不得进入签名");
    }

    /// 内容变化可检测：system / 消息正文变化分别改变对应哈希
    #[test]
    fn signature_capture_detects_system_and_message_changes() {
        let m = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let base = build_request_signature(Some("sys"), &tools(), &[m.clone()]);
        let other_system = build_request_signature(Some("sys2"), &tools(), &[m.clone()]);
        assert_ne!(base.system_hash, other_system.system_hash);
        let other_text = build_request_signature(
            Some("sys"),
            &tools(),
            &[msg(
                "m1",
                AgentMessageRole::User,
                "你好啊",
                "2026-01-01T00:00:00Z",
            )],
        );
        assert_ne!(base.messages_hash, other_text.messages_hash);
        assert_ne!(base.message_hashes[0], other_text.message_hashes[0]);
        // 前缀对比：第二条消息被改写 → 前缀被改
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "回复",
            "2026-01-01T00:00:00Z",
        );
        let with_m2 = build_request_signature(Some("sys"), &tools(), &[m.clone(), m2.clone()]);
        let rewritten = build_request_signature(
            Some("sys"),
            &tools(),
            &[
                m.clone(),
                msg(
                    "m2",
                    AgentMessageRole::Assistant,
                    "改写",
                    "2026-01-01T00:00:00Z",
                ),
            ],
        );
        assert!(with_m2.messages_prefix_changed(&rewritten));
    }

    /// 确定性：同输入两次捕获结果一致（稳定哈希）
    #[test]
    fn signature_capture_is_deterministic() {
        let m = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let a = build_request_signature(Some("sys"), &tools(), &[m.clone()]);
        let b = build_request_signature(Some("sys"), &tools(), &[m]);
        assert_eq!(a, b);
    }

    /// 工具集合哈希：投影包含工具名 / 描述 / schema（顺序敏感——排序稳定
    /// 由 P1 T-01 保证）
    #[test]
    fn signature_capture_hashes_tool_set() {
        let m = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let base = build_request_signature(Some("sys"), &tools(), &[m.clone()]);
        let other_tool = build_request_signature(
            Some("sys"),
            &[ToolSchema {
                name: "t2".to_string(),
                description: "另一个工具".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
            }],
            &[m],
        );
        assert_ne!(base.tools_hash, other_tool.tools_hash);
    }

    // ── run 级聚合 ──

    /// 多 turn 聚合：逐项累加 + 派生占比按聚合值重算 + 样本计数
    #[test]
    fn record_usage_aggregates_run_stats() {
        let mut t = tracker(0);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 7_000, 1_000, None), 100, 10_100, 1_000)
            .is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(20_000, 15_000, 2_000, None), 200, 20_200, 2_000)
            .is_none());
        let stats = t.finish();
        assert_eq!(stats.sample_count, 2);
        assert_eq!(stats.prompt_tokens, 30_000);
        assert_eq!(stats.completion_tokens, 300);
        assert_eq!(stats.total_tokens, 30_300);
        assert_eq!(stats.cache_read_tokens, 22_000);
        assert_eq!(stats.cache_write_tokens, 3_000);
        // Included：miss = prompt - read - write（2000 + 3000）
        assert_eq!(stats.cache_miss_tokens, 5_000);
        assert_eq!(stats.hit_ratio, Some(22_000.0 / 30_000.0));
        assert_eq!(stats.missed_tokens, 0);
    }

    /// 无样本 → 全零统计 + 占比 None（前端隐藏而非显示 0%）
    #[test]
    fn finish_without_samples_is_all_zero() {
        let stats = tracker(0).finish();
        assert_eq!(stats.sample_count, 0);
        assert_eq!(stats.prompt_tokens, 0);
        assert_eq!(stats.hit_ratio, None);
        assert_eq!(stats.warm_until_ms, None);
    }

    // ── detect 归因 ──

    /// 首轮无基线 → 不计 miss（Cold 语义：正常首次）；第二轮 read 骤降 → miss
    /// 归因 prefix-changed（system 变化，harness 自伤）
    #[test]
    fn record_usage_prefix_changed_attribution() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        // 第二轮：system 变化 + read 降到 2000（missed = min(10000,10000) - 2000）
        t.capture_signature(Some("sys2"), &tools(), &[]);
        let miss = t
            .record_usage(scalars(10_000, 2_000, 500, None), 100, 10_100, 2_000)
            .expect("超过噪声地板必须计 miss");
        assert_eq!(miss.missed_tokens, 8_000);
        assert_eq!(miss.attribution, MissAttribution::PrefixChanged);
        assert!(!miss.model_changed);
        let stats = t.finish();
        assert_eq!(stats.missed_tokens, 8_000);
    }

    /// 模型切换：miss 仍计（pi 不豁免），归因 ModelSwitch，model_changed = true
    #[test]
    fn record_usage_model_switch_still_counts_miss() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        t.on_model_switch();
        t.capture_signature(Some("sys"), &tools(), &[]);
        let miss = t
            .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
            .expect("模型切换不豁免 miss");
        assert_eq!(miss.attribution, MissAttribution::ModelSwitch);
        assert!(miss.model_changed);
        assert_eq!(miss.missed_tokens, 10_000);
    }

    /// TTL 超时（idle ≥ ttl × 1000）→ 归因 idle-ttl-expired（T-35 classify
    /// 判定序：TTL 优先）
    #[test]
    fn record_usage_ttl_expired_attribution() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // idle = 69_000 ≥ 60_000 → Expired；read 骤降到 0 但 TTL 判定优先
        let miss = t
            .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 70_000)
            .expect("TTL 超时必须计 miss");
        assert_eq!(miss.attribution, MissAttribution::IdleTtlExpired);
    }

    /// 兜底细化：read == 0 且报告过缓存 → zero-read；命中率低于 85% → low-read
    #[test]
    fn record_usage_zero_read_and_low_read_fallback() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        let zero_read = t
            .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
            .expect("read == 0 必须计 miss");
        assert_eq!(zero_read.attribution, MissAttribution::ZeroRead);
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // 命中率 10% < 85% 且 read > 0 → low-read
        let low_read = t
            .record_usage(scalars(10_000, 1_000, 500, None), 100, 10_100, 2_000)
            .expect("低命中率必须计 miss");
        assert_eq!(low_read.attribution, MissAttribution::LowRead);
    }

    /// 断裂判定接线（2026-08-09 零消费清理，DEEPCHECK-05 #5）：cacheRead
    /// 骤降 >5% 且 >2000 token → 兜底归因 LowRead（即使命中率仍在 85% 以上
    /// ——断裂是缓存条目被驱逐的强信号，P5 §3.4.2）；未达断裂阈值且命中率
    /// 正常 → Unknown（不强判）
    #[test]
    fn record_usage_break_signal_forces_low_read() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(40_000, 40_000, 0, None), 100, 40_100, 1_000)
            .is_none());
        // 第二轮：read 骤降 2100 token（5.25% > 5% 且 > 2000）→ 断裂信号
        t.capture_signature(Some("sys"), &tools(), &[]);
        let miss = t
            .record_usage(scalars(40_000, 37_900, 0, None), 100, 40_100, 2_000)
            .expect("超过噪声地板必须计 miss");
        assert_eq!(
            miss.attribution,
            MissAttribution::LowRead,
            "断裂信号强制 LowRead"
        );
        assert_eq!(miss.missed_tokens, 2_100);
        // 对照：下降 1500 token（3.75% < 5%）且命中率 96.25% ≥ 85% → 不强判
        let mut t2 = tracker(60);
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t2
            .record_usage(scalars(40_000, 40_000, 0, None), 100, 40_100, 1_000)
            .is_none());
        t2.capture_signature(Some("sys"), &tools(), &[]);
        let miss = t2
            .record_usage(scalars(40_000, 38_500, 0, None), 100, 40_100, 2_000)
            .expect("超过噪声地板必须计 miss");
        assert_eq!(
            miss.attribution,
            MissAttribution::Unknown,
            "未达断裂阈值不强判"
        );
    }

    /// 噪声地板与 reportedCache 粘性：missed ≤ 1024 不计；从未报告过缓存活动不计
    #[test]
    fn record_usage_respects_noise_floor_and_sticky_flag() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // missed = 1024 恰好等于地板 → 不计
        assert!(t
            .record_usage(scalars(10_000, 8_976, 0, None), 100, 10_100, 2_000)
            .is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // 从未报告过缓存（首轮 read/write 全 0）→ 粘性挡下
        let mut t2 = tracker(60);
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t2
            .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 1_000)
            .is_none());
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(
            t2.record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
                .is_none(),
            "从未报告过缓存活动 → 不计 miss"
        );
    }

    // ── 基线重置（压缩）──

    /// C13：on_compaction 代数 +1、基线作废；压缩后首轮 usage 无基线 → 不计 miss。
    /// v1.1 T-27 扩展断言：pending_compaction 置位、rebuild_signature 初始为空
    /// （待 capture_post_compaction 填充）——压缩后首轮 usage 回退路径（重建
    /// 签名缺失）与既有行为一致。
    #[test]
    fn on_compaction_invalidates_baseline_and_bumps_generation() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        assert!(t.baseline().is_some(), "首轮后基线必须建立");
        t.on_compaction();
        assert!(t.baseline().is_none(), "压缩后基线必须作废");
        assert!(t.pending_compaction, "压缩后必须置 pending 标记");
        assert!(
            t.rebuild_signature.is_none(),
            "重建签名初始为空，待 capture_post_compaction 填充"
        );
        t.capture_signature(Some("sys"), &tools(), &[]);
        let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
        assert!(miss.is_none(), "压缩后新内容非重放 → 不计 miss");
        assert!(
            !t.pending_compaction,
            "压缩后首轮 usage 后 pending 必须清除"
        );
        let stats = t.finish();
        // 压缩前的浪费量不因重置而丢失（run 聚合只累计真实 detectMiss）
        assert_eq!(stats.cache_read_tokens, 8_000);
        assert_eq!(stats.prompt_tokens, 15_000);
    }

    // ── 压缩后重建签名与首请求比对（v1.1 §5.1 T-28 / T-29）──

    /// T-28：压缩后重建签名与相同输入上的 capture_signature 相等（同一构造
    /// 路径，评审 02 §3.3：正常路径下两签名一致，前缀比对不误报）
    #[test]
    fn capture_post_compaction_matches_capture_signature_on_same_input() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "回复",
            "2026-01-01T00:00:00Z",
        );
        let msgs = [m1, m2];
        let mut t = tracker(0);
        t.capture_post_compaction(Some("sys"), &tools(), &msgs);
        t.capture_signature(Some("sys"), &tools(), &msgs);
        assert_eq!(
            t.rebuild_signature.as_ref(),
            t.pending_signature.as_ref(),
            "同一输入上重建签名与请求签名必须相等"
        );
    }

    /// T-29 四态之 Identical：pending + 重建一致 → 无额外记录、pending 清理、
    /// 重建签名清空防陈旧
    #[test]
    fn post_compaction_first_request_identical_clears_pending() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "回复",
            "2026-01-01T00:00:00Z",
        );
        let msgs = vec![m1, m2];
        let mut t = tracker(60);
        t.on_compaction();
        t.capture_post_compaction(Some("sys"), &tools(), &msgs);
        t.capture_signature(Some("sys"), &tools(), &msgs);
        let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
        assert!(miss.is_none(), "压缩后首请求前缀一致 → 无额外记录");
        assert!(!t.pending_compaction, "pending 必须消费清除");
        assert!(t.rebuild_signature.is_none(), "重建签名必须清空防陈旧");
    }

    /// T-29 四态之 TailAppend：压缩后首请求前对话被追加（steering 注入 /
    /// overflow 阶梯）→ 追加区豁免，不计 harness 改写
    #[test]
    fn post_compaction_first_request_tail_append_is_exempt() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "回复",
            "2026-01-01T00:00:00Z",
        );
        let m3 = msg("m3", AgentMessageRole::User, "追加", "2026-01-01T00:00:00Z");
        let mut t = tracker(60);
        t.on_compaction();
        t.capture_post_compaction(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
        // 压缩后、record_usage 前被追加 → pending 签名含新消息、重建不含
        t.capture_signature(Some("sys"), &tools(), &[m1, m2, m3]);
        let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
        assert!(
            miss.is_none(),
            "追加区豁免 → 不计 miss、不误报 harness 改写"
        );
        assert!(!t.pending_compaction, "pending 必须消费清除");
        assert!(t.rebuild_signature.is_none(), "重建签名必须清空防陈旧");
    }

    /// T-29 四态之 HeadRewrite：压缩后历史区被改写（harness 二次改写）→
    /// warn 诊断 + 归因 PrefixChanged（零浪费审计记录）
    #[test]
    fn post_compaction_first_request_head_rewrite_detected() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "回复",
            "2026-01-01T00:00:00Z",
        );
        let mut t = tracker(60);
        t.on_compaction();
        t.capture_post_compaction(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
        // 历史第一条被改写（异常 / harness 二次改写）
        let m1_rewritten = msg("m1", AgentMessageRole::User, "改写", "2026-01-01T00:00:00Z");
        t.capture_signature(Some("sys"), &tools(), &[m1_rewritten, m2]);
        let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
        let miss = miss.expect("历史区改写必须产出诊断审计记录");
        assert_eq!(miss.attribution, MissAttribution::PrefixChanged);
        assert_eq!(miss.missed_tokens, 0, "诊断记录零浪费，不影响 token 累计");
        assert!(!t.pending_compaction, "pending 必须消费清除");
        assert!(t.rebuild_signature.is_none(), "重建签名必须清空防陈旧");
    }

    /// T-29 回归：无 pending（常规路径）行为不变
    #[test]
    fn record_usage_without_pending_compaction_unaffected() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(!t.pending_compaction, "常规路径不得置 pending");
        assert!(t.rebuild_signature.is_none());
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        assert!(!t.pending_compaction, "常规路径不得置 pending");
        assert!(t.rebuild_signature.is_none(), "常规路径不得产生重建签名");
    }

    // ── generation 消费单源（R-K 能力面，T-30）──

    /// T-30：外部代数注入后基线代数戳使用注入值；校准语义（先自增再注入
    /// → 以注入值为准）；on_compaction 自增保留为回退（轮次 4 改单源消费）
    #[test]
    fn apply_external_generation_calibrates_baseline_generation() {
        let mut t = tracker(0);
        t.apply_external_generation(5);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        let baseline = t.baseline().expect("首轮后基线必须建立");
        assert_eq!(baseline.generation, 5, "外部注入代数应覆盖内部自增");
        // 校准语义：on_compaction 自增后注入外部值 → 以注入值为准
        let mut t2 = tracker(0);
        t2.on_compaction();
        t2.apply_external_generation(3);
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t2
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        assert_eq!(t2.baseline().unwrap().generation, 3, "注入值应校准自增值");
    }

    // ── 冷缓存 ──

    /// 冷缓存：warm_until_ms = 最后完成时刻 + TTL；超时后 is_cold /
    /// cold_cache_check 命中，resend_estimate = 上次 input_total
    #[test]
    fn finish_reports_warm_until_and_cold_check() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        // 温暖截止 = 1000 + 60s × 1000 = 61_000
        assert_eq!(t.warm_until_ms(0), Some(61_000));
        assert!(!t.is_cold(61_000), "恰好等于截止仍温暖");
        assert!(t.is_cold(61_001));
        let warning = t.cold_cache_check(61_001).expect("超 TTL 必须预警");
        assert_eq!(warning.ttl_seconds, 60);
        assert_eq!(warning.resend_estimate, 10_000);
        let stats = t.finish();
        assert_eq!(stats.warm_until_ms, Some(61_000));
        // TTL 未知（0）→ 不判定（P3 查询失败不提示）
        let mut t2 = tracker(0);
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t2
            .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
            .is_none());
        assert_eq!(t2.warm_until_ms(0), None);
        assert!(!t2.is_cold(u64::MAX));
        assert!(t2.cold_cache_check(u64::MAX).is_none());
    }

    // ── 1C-4 增量签名 ──

    /// 增量签名与全量签名结果恒等：system/tools 不变、消息追加场景，
    /// 第二轮 `capture_signature` 走增量路径，签名与全量重算一致。
    #[test]
    fn incremental_signature_matches_full_on_append() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "回复",
            "2026-01-01T00:00:00Z",
        );
        // 首轮（全量）
        let mut t = tracker(0);
        t.capture_signature(Some("sys"), &tools(), &[m1.clone()]);
        let sig_after_first = t.pending_signature.clone().unwrap();
        // 第二轮（追加 m2）走增量
        t.capture_signature(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
        let sig_incremental = t.pending_signature.clone().unwrap();
        // 对照：全量重算
        let sig_full = build_request_signature(Some("sys"), &tools(), &[m1, m2]);
        assert_eq!(sig_incremental, sig_full, "增量签名必须与全量签名一致");
        assert_eq!(sig_after_first.message_count, 1);
        assert_eq!(sig_incremental.message_count, 2);
    }

    /// system 变化 → 增量不适用，回退全量重算（结果与全量一致）。
    #[test]
    fn incremental_signature_falls_back_when_system_changes() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg("m2", AgentMessageRole::User, "追加", "2026-01-01T00:00:00Z");
        let mut t = tracker(0);
        t.capture_signature(Some("sys"), &tools(), &[m1.clone()]);
        t.capture_signature(Some("sys2"), &tools(), &[m1.clone(), m2.clone()]);
        let sig = t.pending_signature.clone().unwrap();
        let full = build_request_signature(Some("sys2"), &tools(), &[m1, m2]);
        assert_eq!(sig, full, "system 变化后应回退全量重算");
    }

    /// 消息缩减（prev_count > messages.len()）→ 增量不适用，回退全量。
    #[test]
    fn incremental_signature_falls_back_when_messages_shrink() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg("m2", AgentMessageRole::User, "追加", "2026-01-01T00:00:00Z");
        let mut t = tracker(0);
        t.capture_signature(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
        // 第二轮消息比首轮少 → prev_count(2) > len(1) → 回退全量
        t.capture_signature(Some("sys"), &tools(), &[m1.clone()]);
        let sig = t.pending_signature.clone().unwrap();
        let full = build_request_signature(Some("sys"), &tools(), &[m1]);
        assert_eq!(sig, full, "消息缩减应回退全量重算");
    }

    /// on_compaction 后增量锚点失效 → 下一轮 capture_signature 全量重算。
    #[test]
    fn on_compaction_invalidates_incremental_anchor() {
        let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
        let m2 = msg(
            "m2",
            AgentMessageRole::Assistant,
            "摘要",
            "2026-01-01T00:00:00Z",
        );
        let mut t = tracker(0);
        t.capture_signature(Some("sys"), &tools(), &[m1.clone()]);
        // 压缩后对话被替换
        t.on_compaction();
        t.capture_signature(Some("sys"), &tools(), &[m2.clone()]);
        let sig = t.pending_signature.clone().unwrap();
        let full = build_request_signature(Some("sys"), &tools(), &[m2]);
        assert_eq!(sig, full, "压缩后应全量重算（增量锚点已失效）");
    }
}
