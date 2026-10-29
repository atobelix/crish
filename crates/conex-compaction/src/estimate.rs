//! 上下文占用估算（conex-compaction）
//!
//! 双源统一输出：usage 实测优先（服务端口径，含缓存读/写），本地启发式兜底
//! （ASCII 4 字符/token、CJK 逐字符、图片固定 token）；时间戳护栏保证压缩
//! 插入新前缀后旧 usage 不再被误用。

use std::sync::Arc;

use conex_types::AgentMessage;

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
///
/// 只服务 usage 时间戳护栏，故保持本模块私有。
fn parse_iso8601_epoch_ms(value: &str) -> Option<i64> {
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
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
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

#[cfg(test)]
mod tests {
    use super::parse_iso8601_epoch_ms;

    /// 合法形态：UTC + 可选小数秒（缺省按 0、超 3 位截断到毫秒）
    #[test]
    fn parse_iso8601_timestamp() {
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00.000Z"),
            Some(1_785_758_400_000i64)
        );
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00Z"),
            Some(1_785_758_400_000i64)
        );
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00.999Z"),
            Some(1_785_758_400_999i64)
        );
        // 小数秒不足 3 位补零（.5 → 500ms）
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00.5Z"),
            Some(1_785_758_400_500i64)
        );
        // 小数秒超 3 位截断（毫秒精度）
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00.123456Z"),
            Some(1_785_758_400_123i64)
        );
    }

    /// epoch 零点与跨日边界（护栏比较用绝对毫秒，不允许时区漂移）
    #[test]
    fn parse_iso8601_epoch_origin_and_day_boundary() {
        assert_eq!(parse_iso8601_epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso8601_epoch_ms("1970-01-01T00:00:01Z"),
            Some(1_000i64)
        );
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-04T00:00:00.000Z"),
            Some(1_785_758_400_000i64 + 12 * 3_600 * 1_000)
        );
    }

    /// 非法形态一律 None（护栏保守作废，不回退到「当成 0 时刻」）
    #[test]
    fn parse_iso8601_rejects_invalid_shapes() {
        for bad in [
            "",
            "2026-08-03 12:00:00Z",
            "2026-13-03T12:00:00Z",
            "2026-08-03T12:00:00+08:00",
            "2026-00-03T12:00:00Z",
            "2026-08-00T12:00:00Z",
            "2026-08-03T24:00:00Z",
            "2026-08-03T12:60:00Z",
            "2026-08-03T12:00:61Z",
            "2026-08-03T12:00:00.Z",
            "2026-08-03T12:00:00.500",
        ] {
            assert_eq!(parse_iso8601_epoch_ms(bad), None, "非法形态：{bad}");
        }
    }
}
