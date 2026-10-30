//! 上下文占用估算（conex-compaction）
//!
//! 双源统一输出：usage 实测优先（服务端口径，含缓存读/写），本地启发式兜底
//! （ASCII 4 字符/token、CJK 逐字符、图片固定 token）；时间戳护栏保证压缩
//! 插入新前缀后旧 usage 不再被误用。

use std::sync::Arc;

use conex_shared::time::parse_iso8601_ms;
use conex_types::message::AgentMessage;

use crate::tokens::{count_agent_message_tokens, count_tokens};

/// 估算来源（usage 实测优先 / 本地启发式兜底）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstimateSource {
    /// usage 实测（服务端口径，含缓存）
    Usage,
    /// 本地启发式兜底（无 usage / usage 作废 / 冷启动）
    Heuristic,
}

/// 上下文占用估算结果（双源统一输出）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstimateContext {
    /// 估算的上下文占用（含缓存读/写；I6 口径）
    pub tokens: u64,
    /// 估算来源（usage 实测 / 本地启发式）
    pub source: EstimateSource,
    /// usage 来源消息 id（本地兜底时为 None；供事件填充与护栏判定）
    pub usage_message_id: Option<String>,
}

/// 从尾部向前找最近一条 usage 仍描述当前前缀的消息
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
            match parse_iso8601_ms(&message.created_at) {
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

/// 对话级估算（AgentMessage 面；usage 优先 + 时间戳护栏 + 启发式兜底）
///
/// 双源策略（P4 §3.3.1，对齐 pi estimate.ts）：
///
/// - **源 1：usage 优先**：从尾部向前找最近一条仍描述当前前缀的
///   usage 消息，上下文占用取 `metadata.cacheBreakdown.inputTotal`
///   （P2/C9 归一化口径，I6；Included 系 prompt、Excluded 系
///   prompt+read+write 已由适配层折算）；cacheBreakdown 缺失时回退
///   `metadata.usage.promptTokens`（Included 语义）。排除 aborted /
///   error 回合与零 usage 消息；**时间戳护栏**：消息时间戳早于
///   `last_compaction_at`（压缩边界）时 usage 不再描述当前前缀，作废
///   回退启发式（对齐 pi `usageAppliesToPrefix`）。usage 覆盖其后缀
///   之前的前缀（含 system/tools），其后的尾随消息按块级启发式补算；
/// - **源 2：本地启发式兜底**（无 usage / usage 作废 / 冷启动）：
///   全部消息逐块估算 + `tools`（工具 schema 整体 JSON 体积）与
///   `system`（system prompt 文本）前缀折算（按 P1 透传后的实际字节）。
///
/// `tokens` 为 u64 上下文占用（含缓存读/写，I6 口径）。
pub fn estimate_context_tokens(
    messages: &[Arc<AgentMessage>],
    tools: Option<&str>,
    system: Option<&str>,
    last_compaction_at: Option<i64>,
) -> EstimateContext {
    let usage = find_usage_message(messages, last_compaction_at);
    estimate_with_usage(messages, tools, system, usage)
}

/// 对话级估算（P4 §3.7 签名兼容入口）
///
/// 调用方（session-loop）已按时间戳护栏定位 usage 消息 id 时传入；
/// 该消息存在且带可解析 usage 时以其为准，否则纯启发式。
/// 不带 tools/system 前缀参数（usage 实测已含此前缀；启发式路径按
/// 0 前缀估算）。
pub fn estimate_agent_context(
    messages: &[Arc<AgentMessage>],
    usage_message_id: Option<&str>,
) -> EstimateContext {
    let usage = usage_message_id
        .and_then(|id| messages.iter().position(|m| m.id == id))
        .and_then(|idx| usage_occupancy(&messages[idx]).map(|occupancy| (idx, occupancy)));
    estimate_with_usage(messages, None, None, usage)
}

/// 阈值判定单点：`estimate >= budget_tokens`（T-33 预检触发用，
/// P4 §3.4.1 阈值 = window - reserve，budget_tokens 由调用方换算）
pub fn should_compact(estimate: u64, budget_tokens: u64) -> bool {
    estimate >= budget_tokens
}

#[cfg(test)]
mod tests {
    use conex_shared::time::parse_iso8601_ms;

    /// usage 时间戳护栏依赖的共享解析器契约。
    ///
    /// `find_usage_message` 的保守作废语义建立在 [`parse_iso8601_ms`] 之上；
    /// 常规合法/非法形态已由 conex-shared 单测覆盖，此处只保留其尚未覆盖的
    /// 边界断言（毫秒截断、纪元秒、跨日边界、空小数秒、缺失 Z、月/日/分/秒
    /// 下限），防止护栏判定回退。
    #[test]
    fn usage_guard_shared_iso_parser_contract() {
        // 小数秒超 3 位截断（毫秒精度）
        assert_eq!(
            parse_iso8601_ms("2026-08-03T12:00:00.123456Z"),
            Some(1_785_758_400_123i64)
        );
        // epoch 零点之后的秒级时间戳
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:01Z"), Some(1_000i64));
        // 跨日边界（护栏比较用绝对毫秒，不允许时区漂移）
        assert_eq!(
            parse_iso8601_ms("2026-08-04T00:00:00.000Z"),
            Some(1_785_758_400_000i64 + 12 * 3_600 * 1_000)
        );
        // 非法形态一律 None（护栏保守作废，不回退到「当成 0 时刻」）
        for bad in [
            "",
            "2026-08-03 12:00:00Z",
            "2026-00-03T12:00:00Z",
            "2026-08-00T12:00:00Z",
            "2026-08-03T12:60:00Z",
            "2026-08-03T12:00:61Z",
            "2026-08-03T12:00:00.Z",
            "2026-08-03T12:00:00.500",
        ] {
            assert_eq!(parse_iso8601_ms(bad), None, "非法形态：{bad}");
        }
    }
}
