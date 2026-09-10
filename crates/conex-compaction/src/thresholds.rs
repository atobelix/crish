//! 水位双阈值与元数据判定模型（conex-compaction）

use std::sync::Arc;

use conex_types::AgentMessage;

use crate::tokens::{count_agent_message_tokens, count_tokens};

/// 常规线水位默认（85%，02 Top 4 / 04 C9 触发条件）
pub const COMPACT_THRESHOLD_RATIO_DEFAULT: f64 = 0.85;
/// 临界线水位默认（95%，02 Top 4：同步硬压缩防线）
pub const COMPACT_CRITICAL_RATIO_DEFAULT: f64 = 0.95;
/// session_meta 键：常规线水位（Q1 裁决：默认值配置面、覆盖走 session_meta）
pub const SESSION_META_KEY_COMPACT_THRESHOLD_RATIO: &str = "compact_threshold_ratio";
/// session_meta 键：临界线水位
pub const SESSION_META_KEY_COMPACT_CRITICAL_RATIO: &str = "compact_critical_ratio";
/// session_meta 键：摘要产出 token 上限（04 C9 第 2 条，默认 1500 由
/// 调用方换算进 CompactionPolicy.max_summary_tokens）
pub const SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS: &str = "compact_summary_max_tokens";

/// 双阈值判定结果（M10/C9：85% 常规线 + 95% 临界线，02 Top 4）
///
/// E2（上下文压缩增强）裁决 1 后：**Critical 语义废止**——临界线不再
/// 「同步硬压缩不依赖 AI」，压缩路径与常规线完全同源（统一走
/// [crate::plan::Summarizer]，无 Summarizer 时不压缩 / 溢出默认 fatal，见
/// [crate::plan::StubPolicy]）；本枚举仅作水位判定（classify 消费方：
/// tool_output.rs classify_after_truncation 与既有测试），**不驱动**
/// 任何独立压缩动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThresholdDecision {
    /// 预算内（无需压缩）
    UnderBudget,
    /// 常规线（默认 85% 预算水位线）：触发 AI 摘要（后台预压缩，
    /// grok 两遍借鉴——常规线优先走 [crate::ai_summary] 通道生成
    /// 结构化摘要，失败按 [crate::plan::StubPolicy] 处理，不再无条件降级占位符）
    Regular,
    /// 临界线（默认 95%）：**语义废止（E2 裁决 1）**——保留变体
    /// 供 classify 消费方与既有测试；不再意味着「不依赖 AI 的同步
    /// 硬压缩」，临界线同样走 LLM 摘要（上层按 [crate::plan::StubPolicy] 决策）
    Critical,
}

/// 双阈值配置（可配；session_meta 键
/// `compact_threshold_ratio` / `compact_critical_ratio`，
/// 04 §3.5 键命名空间 compact_*）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CompactionThresholds {
    /// 常规线水位（默认 0.85）
    pub regular_ratio: f64,
    /// 临界线水位（默认 0.95；≥ 常规线；E2 裁决 1 后仅供水位判定，
    /// 不再挂钩「同步硬压缩」语义）
    pub critical_ratio: f64,
}

impl Default for CompactionThresholds {
    fn default() -> Self {
        Self {
            regular_ratio: COMPACT_THRESHOLD_RATIO_DEFAULT,
            critical_ratio: COMPACT_CRITICAL_RATIO_DEFAULT,
        }
    }
}

impl CompactionThresholds {
    /// 边界钳制：常规线 ∈ (0, 1]、临界线 ∈ [常规线, 1]
    pub fn normalized(&self) -> Self {
        let regular = self.regular_ratio.clamp(0.0, 1.0);
        let regular = if regular == 0.0 { 1.0 } else { regular };
        Self {
            regular_ratio: regular,
            critical_ratio: self.critical_ratio.clamp(regular, 1.0),
        }
    }

    /// 水位判定单点：`estimate / window` 与双阈值比较（window = 0 时
    /// 保守判临界——无法估算即按最紧防线处理）
    pub fn classify(&self, estimate: u64, window: u64) -> ThresholdDecision {
        if window == 0 {
            return ThresholdDecision::Critical;
        }
        let thresholds = self.normalized();
        let ratio = estimate as f64 / window as f64;
        if ratio >= thresholds.critical_ratio {
            ThresholdDecision::Critical
        } else if ratio >= thresholds.regular_ratio {
            ThresholdDecision::Regular
        } else {
            ThresholdDecision::UnderBudget
        }
    }
}

/// 估算来源（usage 实测优先 / 本地启发式兜底，P4 §3.3.1）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstimateSource {
    /// usage 实测（服务端口径，含缓存）
    Usage,
    /// 本地启发式兜底（无 usage / usage 作废 / 冷启动）
    Heuristic,
}

/// 上下文占用估算结果（双源统一输出，P4 §3.3.1）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstimateContext {
    /// 估算的上下文占用（含缓存读/写；I6 口径）
    pub tokens: u64,
    /// 估算来源（usage 实测 / 本地启发式）
    pub source: EstimateSource,
    /// usage 来源消息 id（本地兜底时为 None；供事件填充与护栏判定）
    pub usage_message_id: Option<String>,
}

/// 从尾部向前找最近一条 usage 仍描述当前前缀的消息（P4 §3.3.1）
///
/// 返回 `(消息索引, 归一化输入占用)`。判定规则：
///
/// - 仅取 `metadata.cacheBreakdown.inputTotal`（C9 归一化口径，I6）；
///   cacheBreakdown 缺失时回退 `metadata.usage.promptTokens`
///   （Included 语义，无 cacheBreakdown 的合成数据兜底）；
/// - 排除 aborted / error 回合与零 usage（对齐 pi estimate.ts:76-78）；
/// - **时间戳护栏**：`last_compaction_at` 存在时，消息时间戳早于边界
///   则该 usage 不再描述当前前缀（压缩插入了新的前缀消息），整体作废
///   回退启发式（对齐 pi `usageAppliesToPrefix`）；时间戳无法解析时
///   保守作废（宁可低估护栏能力也不误信旧 usage）。
pub(crate) fn find_usage_message(
    messages: &[Arc<AgentMessage>],
    last_compaction_at: Option<i64>,
) -> Option<(usize, u64)> {
    for (i, message) in messages.iter().enumerate().rev() {
        let Some(occupancy) = usage_occupancy(message) else {
            continue;
        };
        if occupancy == 0 {
            continue;
        }
        // 排除 aborted / error 回合（该回合 usage 不代表可用前缀）
        if let Some(metadata) = &message.metadata {
            if metadata
                .get("aborted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                continue;
            }
            if metadata.get("stopReason").and_then(|v| v.as_str()) == Some("error") {
                continue;
            }
        }
        // 时间戳护栏：早于压缩边界 → 旧 usage 全部作废，回退启发式
        if let Some(boundary) = last_compaction_at {
            match parse_iso8601_epoch_ms(&message.created_at) {
                Some(t) if t < boundary => return None,
                Some(_) => {}
                None => return None,
            }
        }
        return Some((i, occupancy));
    }
    None
}

/// 从消息 metadata 取归一化输入占用（I6 口径）
///
/// 优先级：`cacheBreakdown.inputTotal`（P2/C9 归一化，Included 系 prompt、
/// Excluded 系 prompt+read+write 均已折算）> `usage.promptTokens`
/// （Included 语义兜底）。返回 None = 该消息无可用 usage。
pub(crate) fn usage_occupancy(message: &AgentMessage) -> Option<u64> {
    let metadata = message.metadata.as_ref()?;
    if let Some(breakdown) = metadata.get("cacheBreakdown") {
        if let Some(total) = breakdown.get("inputTotal").and_then(|v| v.as_u64()) {
            return Some(total);
        }
    }
    let usage = metadata.get("usage")?;
    usage.get("promptTokens").and_then(|v| v.as_u64())
}

/// 估算核心：给定可用 usage（None = 纯启发式），
/// usage 覆盖其前缀（含 system/tools，服务端实测口径），其后的
/// 尾随消息按块级启发式补算；纯启发式路径把 tools/system 前缀计入。
pub(crate) fn estimate_with_usage(
    messages: &[Arc<AgentMessage>],
    tools: Option<&str>,
    system: Option<&str>,
    usage: Option<(usize, u64)>,
) -> EstimateContext {
    match usage {
        Some((idx, occupancy)) => {
            let tail_tokens: u64 = messages[idx + 1..]
                .iter()
                .map(|m| count_agent_message_tokens(m) as u64)
                .sum();
            EstimateContext {
                tokens: occupancy.saturating_add(tail_tokens),
                source: EstimateSource::Usage,
                usage_message_id: Some(messages[idx].id.clone()),
            }
        }
        None => {
            let mut tokens: u64 = messages
                .iter()
                .map(|m| count_agent_message_tokens(m) as u64)
                .sum();
            // system/tools 前缀仅在启发式路径计入（usage 实测值已含此前缀）
            if let Some(system) = system {
                tokens = tokens.saturating_add(count_tokens(system) as u64);
            }
            if let Some(tools) = tools {
                tokens = tokens.saturating_add(count_tokens(tools) as u64);
            }
            EstimateContext {
                tokens,
                source: EstimateSource::Heuristic,
                usage_message_id: None,
            }
        }
    }
}

/// ISO8601 时间戳 → epoch 毫秒（无 chrono 依赖的手工解析）
///
/// 期望形态：`YYYY-MM-DDTHH:MM:SS[.mmm]Z`（UTC，`now_iso_utc` 产出
/// `YYYY-MM-DDTHH:MM:SS.mmmZ`）；小数秒缺省按 0 处理；仅接受 Z 结尾
/// （带时区偏移的形态视为不可解析）。解析失败返回 None。
pub fn parse_iso8601_epoch_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let num =
        |start: usize, len: usize| -> Option<i64> { value.get(start..start + len)?.parse().ok() };
    let year = num(0, 4)?;
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    let hour = num(11, 2)?;
    let minute = num(14, 2)?;
    let second = num(17, 2)?;
    // 小数秒（可选；now_iso_utc 恒 3 位）
    let mut millis = 0i64;
    let mut idx = 19;
    if idx < bytes.len() && bytes[idx] == b'.' {
        idx += 1;
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx == start {
            return None;
        }
        let fraction = &value[start..idx];
        // 不足 3 位补零、超 3 位截断（毫秒精度）
        let mut padded = String::with_capacity(3);
        padded.push_str(fraction);
        while padded.len() < 3 {
            padded.push('0');
        }
        padded.truncate(3);
        millis = padded.parse().ok()?;
    }
    if idx >= bytes.len() || bytes[idx] != b'Z' {
        return None;
    }
    // 基本范围校验（护栏判定用；不做逐月天数精确校验）
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32)?;
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis)
}

/// 公历日期 → 1970-01-01 起天数（Howard Hinnant civil-from-days 逆运算）
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if month == 0 || day == 0 {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let day_of_year: i64 = (153 * i64::from(if month > 2 { month - 3 } else { month + 9 }) + 2) / 5
        + i64::from(day)
        - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}
