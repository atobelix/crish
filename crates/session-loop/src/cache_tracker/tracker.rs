//! 会话缓存跟踪器（P5 S2 / T-36：CacheStatsTracker + RunOutcome.cache_stats）

use std::sync::Arc;

use conex_telemetry::cache::{
    prefix_diff_index, CacheBaseline, CacheBreakdownMath, CacheUsageScalars, MissDetector,
    PrefixDiffKind, RequestSignature,
};
use conex_types::events::MissAttribution;
use conex_types::message::AgentMessage;

use super::hash::{build_request_signature, build_request_signature_incremental};
use super::types::{CacheMiss, CacheTrackingConfig};
use crate::provider::ToolSchema;

/// 会话缓存跟踪器（每 run 一个；构造 / 复位点 = LoopState 构造 + run() 起始，
/// 与 T-33 的压缩护栏归零点并列——fresh run 语义，P5 §3.4.5 跨会话重建）
pub struct CacheStatsTracker {
    /// 请求前签名基线（run 内跨 turn 维护；收口后经 [`Self::baseline`] 移交
    /// engine 层持久化，供跨 run 冷缓存预警使用）
    pub(super) baseline: Option<CacheBaseline>,
    /// run 内聚合（`CacheBreakdownMath::add_assign` 逐 turn 累加）
    pub(super) run_stats: Option<CacheBreakdownMath>,
    /// reportedCache 粘性（pi 语义，P5 §3.4.2）：本 run 内报告过
    /// read / write > 0 才计 miss（无缓存能力的本地服务器不误报）
    pub(super) reported_cache: bool,
    /// 供应商标识（基线标识与归因 ProviderSwitch 用）
    pub(super) provider: String,
    /// 模型标识（基线标识与归因 ModelSwitch 用）
    pub(super) model: String,
    /// 缓存 TTL 秒数（0 = 未知；P3 表查询结果，T-40 注入）
    pub(super) ttl_seconds: u64,
    /// 压缩代数（C13：`on_compaction` 代数 +1 且基线作废；代数变化
    /// ⇒ 基线作废，双保险对齐 jcode KvCacheBaseline）
    pub(super) generation: u64,
    /// 请求发送前捕获的最新签名（`capture_signature` 写入；`record_usage`
    /// 刷新基线时消费）
    pub(super) pending_signature: Option<RequestSignature>,
    /// 压缩后首请求待消费标记（`on_compaction` 置位、`record_usage` 消费
    /// 后清除；run 内生命周期——run 收口未消费时下个 run tracker 新建
    /// 自然丢失，无挂起残留，v1.1 §5.2）
    pub(super) pending_compaction: bool,
    /// 压缩后重建签名（`capture_post_compaction` 写入——apply_compaction
    /// 对话替换后捕获的"压缩后真实请求前缀"预测；`record_usage` 前缀
    /// 比对消费后清空防陈旧）
    pub(super) rebuild_signature: Option<RequestSignature>,
    /// 模型切换待归因标记（`on_model_switch` 置位；下一次 `record_usage`
    /// 归因 ModelSwitch，之后随基线刷新清除——「签名基线作废」语义，P5 §3.4.5）
    pub(super) model_switch_pending: bool,
    /// 上次 `capture_signature` 的签名（增量计算锚点；system/tools 不变且
    /// 消息仅追加时，下一轮只对新消息做哈希并 fold 到本签名的 `messages_hash`，
    /// 避免每轮 O(N) 全量重算——1C-4 优化）。压缩（`on_compaction` /
    /// `capture_post_compaction`）会替换对话 → 置 None 强制下一轮全量重算。
    pub(super) last_signature: Option<RequestSignature>,
    /// run 级输入 token 累计（wire promptTokens；CacheBreakdownMath 不含此标量）
    pub(super) prompt_tokens: u64,
    /// run 级输出 token 累计（wire completionTokens）
    pub(super) completion_tokens: u64,
    /// run 级总 token 累计（wire totalTokens）
    pub(super) total_tokens: u64,
    /// 有真实 usage 的 turn 数（0 = 无样本，前端隐藏而非显示 0%）
    pub(super) sample_count: u64,
    /// 本 run 审计出的浪费量（detectMiss 累计，P5 §3.3.1）
    pub(super) missed_tokens: u64,
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
                            || baseline.as_ref().is_some_and(|b| b.model != self.model),
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
}

/// 从配置构造跟踪器（LoopState 构造与 run 起始复位共用；None = 不启用缓存
/// 测量，行为与现状一致）
pub(crate) fn build_tracker(config: Option<&CacheTrackingConfig>) -> Option<CacheStatsTracker> {
    config.map(CacheStatsTracker::from_config)
}
