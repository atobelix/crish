//! 消息转换与映射面（SR-06e · 拆分 · ≠ EL）
//!
//! 从 parse/anthropic.rs 拆出的实现域：
//! - stop_reason 映射（[anthropic_stop_reason_to_stop]）
//! - usage 解析与分片补全（[parse_anthropic_usage] / [merge_anthropic_usage]）
//! - 错误帧文案（[anthropic_payload_error]）与字段辅助函数
//!
//! 门面（parse/anthropic.rs）re-export 全部公开符号，对外路径不变。

use serde_json::{Map, Value};

use crate::events::{merge_usage_shards, ProviderUsage, StopReason};

/// anthropicStopReasonToStop 映射表（02 §三.1 末；对齐 272-281）
///
/// | stop_reason | stop reason |
/// |---|---|
/// | `tool_use` | `tool-call` |
/// | `max_tokens` | `length` |
/// | `end_turn` / `stop_sequence` / null | `stop` |
/// | `refusal` | `error` |
/// | 其他 | `stop` |
pub fn anthropic_stop_reason_to_stop(reason: Option<&str>) -> StopReason {
    match reason {
        Some("tool_use") => StopReason::ToolCall,
        Some("max_tokens") => StopReason::Length,
        Some("end_turn") | Some("stop_sequence") | None => StopReason::Stop,
        Some("refusal") => StopReason::Error,
        Some(_) => StopReason::Stop,
    }
}

/// parseAnthropicUsage（对齐 283-315）
///
/// - `input_tokens` ?? `prompt_tokens` → prompt；`output_tokens` ?? `completion_tokens` → completion
/// - `cache_read_input_tokens` → cacheRead；`cache_creation_input_tokens` → cacheWrite
/// - `reasoning_tokens`（T3.4 G1-d）：`output_tokens_details.reasoning_tokens`（嵌套，对齐
///   chat/responses 约定）→ 顶层 `reasoning_tokens` → 顶层 `thinking_tokens`。Anthropic 官方
///   wire 不单独报告思考 token（output_tokens 已含思考，T3.4 归一语义不把 reasoning 从
///   completion 中减去，completion 保留总输出）；仅当 Anthropic 兼容网关/代理显式上报
///   思考计数时，本字段非 None。官方 wire 缺省时保持 None（从 completion 中拆分取不到）。
/// - `total_tokens` ??（prompt/completion 任一存在时的和）
/// - Anthropic wire 不直接报告 miss（P2 §3.3 D：miss 由 Excluded 口径推导），`cache_miss_tokens` 恒 None
/// - 全空返回 None（304-306）；非对象入参返回 None
pub fn parse_anthropic_usage(raw: Option<&Value>) -> Option<ProviderUsage> {
    let usage = raw?.as_object()?;
    let prompt_tokens =
        finite_u64(usage.get("input_tokens")).or_else(|| finite_u64(usage.get("prompt_tokens")));
    let completion_tokens = finite_u64(usage.get("output_tokens"))
        .or_else(|| finite_u64(usage.get("completion_tokens")));
    let cache_read_tokens = finite_u64(usage.get("cache_read_input_tokens"));
    let cache_write_tokens = finite_u64(usage.get("cache_creation_input_tokens"));
    // reasoning 链（T3.4 G1-d）：嵌套 details.reasoning_tokens 优先，其次顶层 reasoning_tokens /
    // thinking_tokens 别名——仅兼容网关显式报告思考计数时非 None
    let reasoning_tokens = nested_finite_u64(usage, "output_tokens_details", "reasoning_tokens")
        .or_else(|| finite_u64(usage.get("reasoning_tokens")))
        .or_else(|| finite_u64(usage.get("thinking_tokens")));
    let total_tokens = finite_u64(usage.get("total_tokens")).or_else(|| {
        if prompt_tokens.is_some() || completion_tokens.is_some() {
            Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0))
        } else {
            None
        }
    });
    if prompt_tokens.is_none()
        && completion_tokens.is_none()
        && cache_read_tokens.is_none()
        && cache_write_tokens.is_none()
        && reasoning_tokens.is_none()
        && total_tokens.is_none()
    {
        return None;
    }
    Some(ProviderUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_miss_tokens: None,
        reasoning_tokens,
    })
}

/// mergeAnthropicUsage 分片补全（02 §六.6：Anthropic 分片补全；对齐 363-388）
///
/// 合并逻辑已收敛到共享 [merge_usage_shards]（P2 §3.3 D 裁决：分片合并的 max 语义）——
/// 输入侧字段（prompt/cacheRead/cacheWrite/cacheMiss）分片间取 max，
/// 防代理用 0/部分值覆盖 message_start 的完整 input；completion/reasoning 侧
/// 维持"后到优先"；total 恒由合并结果重算（377-378 的既有语义不变）。
pub fn merge_anthropic_usage(base: Option<&ProviderUsage>, next: &ProviderUsage) -> ProviderUsage {
    match base {
        Some(base) => merge_usage_shards(base, next),
        None => merge_usage_shards(&ProviderUsage::default(), next),
    }
}

/// anthropicPayloadError（对齐 317-333）
///
/// 优先级：`error`（trim 非空字符串）→ error 对象（`{type}: {message}` → message →
/// type）→ `type==='error'` 时的顶层 `message`。
pub fn anthropic_payload_error(payload: &Map<String, Value>) -> Option<String> {
    match payload.get("error") {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Some(Value::Object(record)) => {
            let message = string_field(record.get("message"));
            let type_ = string_field(record.get("type"));
            match (message, type_) {
                (Some(message), Some(type_)) => Some(format!("{type_}: {message}")),
                (Some(message), None) => Some(message.to_owned()),
                (None, Some(type_)) => Some(type_.to_owned()),
                (None, None) => None,
            }
        }
        _ => {
            if string_field(payload.get("type")) == Some("error") {
                string_field(payload.get("message")).map(str::to_owned)
            } else {
                None
            }
        }
    }
}

/// 非空字符串字段
pub(super) fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// 字符串字段
pub(super) fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// 非负整数（index 等）
pub(super) fn number_field(value: Option<&Value>) -> Option<usize> {
    value.and_then(Value::as_u64).map(|value| value as usize)
}

/// 仅接受有限数值（对齐 TS numberField，02 §2.5 同款判定）：整数直接取；浮点须有限且非负
pub(super) fn finite_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64)
    })
}

/// 从 usage 的嵌套 details 对象中取数值字段（T3.4 G1-d 的 reasoning 链用：
/// `output_tokens_details.reasoning_tokens`，对齐 chat/responses 的 details 形状）
fn nested_finite_u64(usage: &Map<String, Value>, detail_key: &str, field: &str) -> Option<u64> {
    usage
        .get(detail_key)
        .and_then(Value::as_object)
        .and_then(|details| finite_u64(details.get(field)))
}
