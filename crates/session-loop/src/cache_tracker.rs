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

use std::sync::Arc;

use conex_telemetry::cache::{
    classify, cold_cache_check, is_cold, warm_until, CacheAccountingKind, CacheBaseline,
    CacheBreakdownMath, CacheUsageScalars, ColdCacheWarning, MissDetector, MissReason,
    RequestSignature, LOW_HIT_RATIO_PCT,
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
    /// 模型切换待归因标记（`on_model_switch` 置位；下一次 `record_usage`
    /// 归因 ModelSwitch，之后随基线刷新清除——「签名基线作废」语义，P5 §3.4.5）
    model_switch_pending: bool,
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
            model_switch_pending: false,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            sample_count: 0,
            missed_tokens: 0,
        }
    }

    /// 从配置构造（LoopState 构造与 run 起始复位共用入口）
    pub fn from_config(config: &CacheTrackingConfig) -> Self {
        Self::new(config.provider.clone(), config.model.clone())
            .with_ttl(config.ttl_seconds)
    }

    /// 设置缓存 TTL（秒；0 = 未知 / 无缓存）
    pub fn with_ttl(mut self, ttl_seconds: u64) -> Self {
        self.ttl_seconds = ttl_seconds;
        self
    }

    /// 覆盖缓存 TTL（秒；0 = 未知 / 无缓存；T-40 在 P3 查询结果可及后调用）
    pub fn set_ttl(&mut self, ttl_seconds: u64) {
        self.ttl_seconds = ttl_seconds;
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
        self.pending_signature = Some(build_request_signature(system, tools, messages));
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
        let miss = MissDetector::detect(baseline.as_ref(), &breakdown, self.reported_cache)
            .map(|missed_tokens| {
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
            });
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
            provider: self.provider.clone(),
            model: self.model.clone(),
            completed_at_ms,
            generation: self.generation,
        });
        self.model_switch_pending = false;
        miss
    }

    /// 压缩事件（P4 接线，C13）：代数 +1、签名基线作废（压缩是唯一前缀
    /// 重写点——压缩后是新内容非重放，不计 miss，pi prev=undefined 语义）
    pub fn on_compaction(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.baseline = None;
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

    /// 冷缓存预警判定（请求启动路径，P5 §3.4.4）：无基线 / 未超 TTL /
    /// TTL 未知（调用方传 0 时按 ttl_seconds == 0 不判定——P5 约定 TTL
    /// 查询失败不提示，见函数注释）→ None
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
        self.warm_until_ms(now_ms).map_or(false, |warm| is_cold(now_ms, warm))
    }

    /// 当前基线（只读；run 收口后 engine 层据此持久化跨 run 基线，T-40）
    pub fn baseline(&self) -> Option<&CacheBaseline> {
        self.baseline.as_ref()
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
                .and_then(|b| (self.ttl_seconds > 0)
                    .then(|| u64::try_from(warm_until(b.completed_at_ms, self.ttl_seconds)).ok()))
                .flatten(),
        }
    }

    /// 归因组合（P5 §3.4.3 分类序 + T-35 `classify` 判定序的映射层）：
    ///
    /// 1. 压缩代数变化 → `Compaction`（C13 防御路径：`on_compaction` 已作废
    ///    基线，正常不可达；此归因用于历史事件解释）；
    /// 2. `classify`（TTL 超时优先 → 供应商 / 模型切换 → 前缀哈希变化，
    ///    任务书 T-35 口径）映射为 8 类；
    /// 3. `Unknown` / `UpstreamSwitch` 兜底细化：read == 0 且报告过缓存 →
    ///    `ZeroRead`；命中率低于 85% → `LowRead`；其余 `Unknown`
    ///    （`Cold` 只在无基线时出现——此时 detect 不计 miss，故不产出）。
    fn classify_miss(&self, breakdown: &CacheBreakdownMath, completed_at_ms: u64) -> MissAttribution {
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
        let cur_signature = self.pending_signature.as_ref().unwrap_or(&default_signature);
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
            MissReason::UpstreamSwitch | MissReason::Unknown => {
                // 兜底细化（P5 §3.4.3 第 7-8 类；detect 已保证 reported_cache）
                if breakdown.read == 0 {
                    MissAttribution::ZeroRead
                } else if breakdown.hit_ratio.map_or(true, |r| r < LOW_HIT_RATIO_PCT) {
                    MissAttribution::LowRead
                } else {
                    MissAttribution::Unknown
                }
            }
        }
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
                serde_json::to_string(&call.input).unwrap_or_default().as_bytes(),
            );
        }
        AgentMessageBlock::ToolResult { tool_call_id, tool_name, output, is_error } => {
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
    let messages_hash = message_hashes
        .iter()
        .copied()
        .fold(0, fnv1a_mix);
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
            blocks: vec![AgentMessageBlock::Text { text: text.to_string() }],
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
            &[msg("m1", AgentMessageRole::User, "你好啊", "2026-01-01T00:00:00Z")],
        );
        assert_ne!(base.messages_hash, other_text.messages_hash);
        assert_ne!(base.message_hashes[0], other_text.message_hashes[0]);
        // 前缀对比：第二条消息被改写 → 前缀被改
        let m2 = msg("m2", AgentMessageRole::Assistant, "回复", "2026-01-01T00:00:00Z");
        let with_m2 = build_request_signature(Some("sys"), &tools(), &[m.clone(), m2.clone()]);
        let rewritten = build_request_signature(
            Some("sys"),
            &tools(),
            &[m.clone(), msg("m2", AgentMessageRole::Assistant, "改写", "2026-01-01T00:00:00Z")],
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
        assert!(t.record_usage(scalars(10_000, 7_000, 1_000, None), 100, 10_100, 1_000).is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t.record_usage(scalars(20_000, 15_000, 2_000, None), 200, 20_200, 2_000).is_none());
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
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
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
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
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
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
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
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        let zero_read = t
            .record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000)
            .expect("read == 0 必须计 miss");
        assert_eq!(zero_read.attribution, MissAttribution::ZeroRead);
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // 命中率 10% < 85% 且 read > 0 → low-read
        let low_read = t
            .record_usage(scalars(10_000, 1_000, 500, None), 100, 10_100, 2_000)
            .expect("低命中率必须计 miss");
        assert_eq!(low_read.attribution, MissAttribution::LowRead);
    }

    /// 噪声地板与 reportedCache 粘性：missed ≤ 1024 不计；从未报告过缓存活动不计
    #[test]
    fn record_usage_respects_noise_floor_and_sticky_flag() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // missed = 1024 恰好等于地板 → 不计
        assert!(t.record_usage(scalars(10_000, 8_976, 0, None), 100, 10_100, 2_000).is_none());
        t.capture_signature(Some("sys"), &tools(), &[]);
        // 从未报告过缓存（首轮 read/write 全 0）→ 粘性挡下
        let mut t2 = tracker(60);
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t2.record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 1_000).is_none());
        t2.capture_signature(Some("sys"), &tools(), &[]);
        assert!(
            t2.record_usage(scalars(10_000, 0, 0, None), 100, 10_100, 2_000).is_none(),
            "从未报告过缓存活动 → 不计 miss"
        );
    }

    // ── 基线重置（压缩）──

    /// C13：on_compaction 代数 +1、基线作废；压缩后首轮 usage 无基线 → 不计 miss
    #[test]
    fn on_compaction_invalidates_baseline_and_bumps_generation() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
        assert!(t.baseline().is_some(), "首轮后基线必须建立");
        t.on_compaction();
        assert!(t.baseline().is_none(), "压缩后基线必须作废");
        t.capture_signature(Some("sys"), &tools(), &[]);
        let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
        assert!(miss.is_none(), "压缩后新内容非重放 → 不计 miss");
        let stats = t.finish();
        // 压缩前的浪费量不因重置而丢失（run 聚合只累计真实 detectMiss）
        assert_eq!(stats.cache_read_tokens, 8_000);
        assert_eq!(stats.prompt_tokens, 15_000);
    }

    // ── 冷缓存 ──

    /// 冷缓存：warm_until_ms = 最后完成时刻 + TTL；超时后 is_cold /
    /// cold_cache_check 命中，resend_estimate = 上次 input_total
    #[test]
    fn finish_reports_warm_until_and_cold_check() {
        let mut t = tracker(60);
        t.capture_signature(Some("sys"), &tools(), &[]);
        assert!(t.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
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
        assert!(t2.record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000).is_none());
        assert_eq!(t2.warm_until_ms(0), None);
        assert!(!t2.is_cold(u64::MAX));
        assert!(t2.cold_cache_check(u64::MAX).is_none());
    }
}
