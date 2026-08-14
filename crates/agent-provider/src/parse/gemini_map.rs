//! 消息转换与映射面（SR-06e · 拆分 · ≠ EL）
//!
//! 从 parse/gemini.rs 拆出的实现域：
//! - finishReason 映射（[gemini_finish_reason_to_stop]）
//! - usage 解析与逐帧合并（[parse_gemini_usage] / [merge_gemini_usage]）
//! - 错误帧 / 阻断（[gemini_payload_error] / [prompt_block_reason] / [has_candidates]）
//! - 工具参数归一化（[normalize_function_args]）与字段辅助函数
//!
//! 门面（parse/gemini.rs）re-export 全部公开符号，对外路径不变。

use serde_json::{json, Map, Value};

use crate::events::{merge_usage_shards, ProviderUsage, StopReason};

use super::super::tool_call::parse_arguments;

/// geminiFinishReasonToStop 映射（02 §三.2；对齐 305-336）
///
/// 返回 `(stop reason, error 文案)`；error 文案仅 SAFETY 等阻断类携带。
///
/// | finishReason | stop reason |
/// |---|---|
/// | 未设置 / 空串 / `FINISH_REASON_UNSPECIFIED` | 有工具调用→tool-call；否则 stop |
/// | `STOP` / `END_TURN` | 有工具调用→tool-call；否则 stop |
/// | `MAX_TOKENS` | `length` |
/// | `SAFETY` / `RECITATION` / `BLOCKLIST` / `PROHIBITED_CONTENT` / `SPII` / `IMAGE_SAFETY` / `MALFORMED_FUNCTION_CALL` / `OTHER` | `error`（`Gemini finishReason: X`） |
/// | 其他 | 有工具调用→tool-call；否则 stop |
pub fn gemini_finish_reason_to_stop(
    reason: Option<&str>,
    has_tool_call: bool,
) -> (StopReason, Option<String>) {
    let tool_call_or_stop = || {
        if has_tool_call {
            StopReason::ToolCall
        } else {
            StopReason::Stop
        }
    };
    match reason {
        None | Some("") | Some("FINISH_REASON_UNSPECIFIED") => (tool_call_or_stop(), None),
        Some(raw) => match raw.to_uppercase().as_str() {
            "STOP" | "END_TURN" => (tool_call_or_stop(), None),
            "MAX_TOKENS" => (StopReason::Length, None),
            "SAFETY"
            | "RECITATION"
            | "BLOCKLIST"
            | "PROHIBITED_CONTENT"
            | "SPII"
            | "IMAGE_SAFETY"
            | "MALFORMED_FUNCTION_CALL"
            | "OTHER" => (
                StopReason::Error,
                Some(format!("Gemini finishReason: {raw}")),
            ),
            _ => (tool_call_or_stop(), None),
        },
    }
}

/// parseGeminiUsage（对齐 338-378）
///
/// - `promptTokenCount` ?? `prompt_token_count` → prompt
/// - `candidatesTokenCount` ?? `responseTokenCount` ?? `candidates_token_count` → completion
/// - `cachedContentTokenCount` ?? `cached_content_token_count` → cacheRead；
///   `totalCachedTokens` ?? `total_cached_tokens` 别名（camel/snake 双形）回退于其后
///   （00-catalog 第 8.2 节：隐式缓存计量字段为 total_cached_tokens，P2 步骤 1b）
/// - `thoughtsTokenCount` ?? `thoughts_token_count` → reasoningTokens
/// - cacheWrite（T3.4 G1-d）：Gemini 官方 wire 不单列写缓存字段，但兼容网关可能上报
///   `cacheWriteTokenCount` / `cacheWriteTokens`（camel/snake 双形，嵌套 `cache` details
///   的 `writeTokenCount` 别名优先）。官方 wire 缺省保持 None（pi-ai google-generative-ai.js:165
///   恒 0 同向——真实 Gemini 无独立写缓存计数）。
/// - `totalTokenCount` ?? `total_token_count` ??（prompt/completion 任一存在时的和）
/// - 全空返回 None（361-369）；非对象入参返回 None
pub fn parse_gemini_usage(raw: Option<&Value>) -> Option<ProviderUsage> {
    let usage = raw?.as_object()?;
    let prompt_tokens = finite_u64(usage.get("promptTokenCount"))
        .or_else(|| finite_u64(usage.get("prompt_token_count")));
    let completion_tokens = finite_u64(usage.get("candidatesTokenCount"))
        .or_else(|| finite_u64(usage.get("responseTokenCount")))
        .or_else(|| finite_u64(usage.get("candidates_token_count")));
    // hit 链（P2 §3.3 D）：cachedContentTokenCount 优先，total_cached_tokens 别名回退于其后
    let cache_read_tokens = finite_u64(usage.get("cachedContentTokenCount"))
        .or_else(|| finite_u64(usage.get("cached_content_token_count")))
        .or_else(|| finite_u64(usage.get("totalCachedTokens")))
        .or_else(|| finite_u64(usage.get("total_cached_tokens")));
    // write 链（T3.4 G1-d）：嵌套 cache.writeTokenCount 优先，其次顶层 camel/snake 双形别名
    let cache_write_tokens = nested_finite_u64(usage, "cache", "writeTokenCount")
        .or_else(|| finite_u64(usage.get("cacheWriteTokenCount")))
        .or_else(|| finite_u64(usage.get("cacheWriteTokens")))
        .or_else(|| finite_u64(usage.get("cache_write_token_count")))
        .or_else(|| finite_u64(usage.get("cache_write_tokens")));
    let reasoning_tokens = finite_u64(usage.get("thoughtsTokenCount"))
        .or_else(|| finite_u64(usage.get("thoughts_token_count")));
    let total_tokens = finite_u64(usage.get("totalTokenCount"))
        .or_else(|| finite_u64(usage.get("total_token_count")))
        .or_else(|| {
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
        // write（T3.4 G1-d）：兼容网关显式上报时才非 None；真实 Gemini 无独立写缓存计数
        cache_write_tokens,
        cache_miss_tokens: None,
        reasoning_tokens,
    })
}

/// mergeGeminiUsage 逐帧合并（02 §六.6：Gemini 逐帧合并；对齐 456-479）
///
/// usageMetadata 为累计值：已收敛为共享 [crate::events::merge_usage_shards]
/// （P2 §3.3 D 分片 max 语义，与 anthropic 收敛同向）——输入侧字段
/// （prompt/cacheRead/cacheWrite/cacheMiss）在分片间取 max 防 0/部分值覆盖，
/// completion/reasoning 后到优先，total 恒由合并结果重算（防代理覆盖完整 input）。
pub fn merge_gemini_usage(base: Option<&ProviderUsage>, next: &ProviderUsage) -> ProviderUsage {
    match base {
        Some(base) => merge_usage_shards(base, next),
        None => merge_usage_shards(&ProviderUsage::default(), next),
    }
}

/// geminiPayloadError（对齐 380-396）
///
/// 优先级：`error`（trim 非空字符串）→ error 对象（`{status}: {message}` →
/// `{code}: {message}` → message → status）。
pub(super) fn gemini_payload_error(payload: &Map<String, Value>) -> Option<String> {
    match payload.get("error") {
        Some(Value::String(text)) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Some(Value::Object(record)) => {
            let message = string_field(record.get("message"));
            let status = string_field(record.get("status"));
            match (message, status, record.get("code")) {
                (Some(message), Some(status), _) => Some(format!("{status}: {message}")),
                (Some(message), None, Some(code)) if !code.is_null() => {
                    Some(format!("{code}: {message}"))
                }
                (Some(message), None, _) => Some(message.to_owned()),
                (None, Some(status), _) => Some(status.to_owned()),
                _ => None,
            }
        }
        _ => None,
    }
}

/// promptBlockReason（对齐 398-414）
///
/// `promptFeedback.blockReason` ?? `block_reason`；空串 / `BLOCK_REASON_UNSPECIFIED`
/// 视为未阻断；文案带 `Gemini prompt blocked ({reason}): {message}` 或
/// `Gemini prompt blocked: {reason}`。
pub(super) fn prompt_block_reason(payload: &Map<String, Value>) -> Option<String> {
    let feedback = payload.get("promptFeedback")?.as_object()?;
    let reason = string_field(feedback.get("blockReason"))
        .or_else(|| string_field(feedback.get("block_reason")))?;
    if reason.is_empty() || reason == "BLOCK_REASON_UNSPECIFIED" {
        return None;
    }
    let message = string_field(feedback.get("blockReasonMessage"))
        .or_else(|| string_field(feedback.get("block_reason_message")));
    match message {
        Some(message) => Some(format!("Gemini prompt blocked ({reason}): {message}")),
        None => Some(format!("Gemini prompt blocked: {reason}")),
    }
}

/// 是否有 candidates（blockReason 判定用，416-418）
pub(super) fn has_candidates(payload: &Map<String, Value>) -> bool {
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .is_some_and(|candidates| !candidates.is_empty())
}

/// normalizeFunctionArgs（对齐 420-442）
///
/// - JSON 对象 → 原样
/// - 字符串 → [parse_arguments]（空→{}、对象→原样、非对象→
///   `{value}`、解析失败→`__rawArguments` 兜底）
/// - null / 缺失 → `{}`
/// - 其他 → `{ value: <原值> }`
pub fn normalize_function_args(raw: Option<&Value>) -> Value {
    match raw {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::String(text)) => parse_arguments(text),
        Some(Value::Null) | None => Value::Object(Map::new()),
        Some(other) => json!({ "value": other }),
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

/// 从 usage 的嵌套 details 对象中取数值字段（T3.4 G1-d 的 cache-write 链用：
/// `cache.writeTokenCount`，兼容网关显式上报）
fn nested_finite_u64(usage: &Map<String, Value>, detail_key: &str, field: &str) -> Option<u64> {
    usage
        .get(detail_key)
        .and_then(Value::as_object)
        .and_then(|details| finite_u64(details.get(field)))
}
