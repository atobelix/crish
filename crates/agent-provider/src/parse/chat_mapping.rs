//! chat 映射 / usage / 错误帧工具面（SR-06e · 拆分 · ≠ EL）
//!
//! 纯函数域：finish_reason 映射表、usage 解析（chat 与 responses 同构复用）、
//! providerBodyError 错误帧识别与 JSON 字段工具。被 [super::chat_core] 消费。

use serde_json::{Map, Value};

use crate::events::{ProviderUsage, StopReason};

/// finishReasonToStop 映射表（02 §2.2 末表格，逐行对齐）
///
/// | finish_reason | stop reason |
/// |---|---|
/// | `tool_calls` / `function_call` | `tool-call` |
/// | `length` | `length` |
/// | `stop` / null（缺失） | `stop` |
/// | 其他（含 `content_filter` 等未知值） | `error` |
pub fn finish_reason_to_stop(reason: Option<&str>) -> StopReason {
    match reason {
        Some("tool_calls") | Some("function_call") => StopReason::ToolCall,
        Some("length") => StopReason::Length,
        Some("stop") | None => StopReason::Stop,
        Some(_) => StopReason::Error,
    }
}

/// usage 解析（02 §2.5；chat 与 responses 同构）
///
/// - `prompt_tokens` ?? `input_tokens`；`completion_tokens` ?? `output_tokens`；`total_tokens`
/// - hit 链（P2 §3.3 D；A1-04：与 P6 R4、TS 降级路径 directFetchBridge.ts 顺序一致）：
///   顶层 `prompt_cache_hit_tokens`（DeepSeek）→ details `cached_tokens`
///   （OpenAI/Responses）→ 顶层 `cached_tokens`（Kimi）——顶层 hit 优先
/// - write 链：details `cache_write_tokens`/`cache_creation_tokens`/
///   `cache_creation_input_tokens`（百炼，00-catalog 11.2）→ 顶层
///   `cache_write_tokens`/`cache_creation_tokens`
/// - `cache_miss_tokens` 取顶层 `prompt_cache_miss_tokens`（DeepSeek 唯一直接报告 miss 的字段）
/// - `completion_tokens_details.reasoning_tokens` ?? `output_tokens_details.reasoning_tokens` → reasoningTokens
/// - 仅接受有限数值（02 §2.5:319-323）；非对象入参返回 None（不覆盖已有 usage）
pub fn parse_usage(raw: Option<&Value>) -> Option<ProviderUsage> {
    let usage = raw?.as_object()?;
    let prompt_details = nested_details(usage, &["prompt_tokens_details", "input_tokens_details"]);
    let completion_details = nested_details(
        usage,
        &["completion_tokens_details", "output_tokens_details"],
    );
    // hit 链：顶层 prompt_cache_hit_tokens（DeepSeek）→ details.cached_tokens →
    // 顶层 cached_tokens（Kimi），顺序与 P6 R4 一致（A1-04：顶层 hit 优先）
    let cache_read_tokens = finite_u64(usage.get("prompt_cache_hit_tokens"))
        .or_else(|| prompt_details.and_then(|details| finite_u64(details.get("cached_tokens"))))
        .or_else(|| finite_u64(usage.get("cached_tokens")));
    // write 链：details 三别名 → 顶层 cache_write_tokens → 顶层 cache_creation_tokens
    let cache_write_tokens = details_alias(
        prompt_details,
        &[
            "cache_write_tokens",
            "cache_creation_tokens",
            "cache_creation_input_tokens",
        ],
    )
    .or_else(|| finite_u64(usage.get("cache_write_tokens")))
    .or_else(|| finite_u64(usage.get("cache_creation_tokens")));
    Some(ProviderUsage {
        prompt_tokens: finite_u64(usage.get("prompt_tokens"))
            .or_else(|| finite_u64(usage.get("input_tokens"))),
        completion_tokens: finite_u64(usage.get("completion_tokens"))
            .or_else(|| finite_u64(usage.get("output_tokens"))),
        total_tokens: finite_u64(usage.get("total_tokens")),
        cache_read_tokens,
        cache_write_tokens,
        // DeepSeek 顶层 miss：唯一直接报告 miss 的字段，落入统一契约（P2 §3.3 D）
        cache_miss_tokens: finite_u64(usage.get("prompt_cache_miss_tokens")),
        reasoning_tokens: completion_details
            .and_then(|details| finite_u64(details.get("reasoning_tokens"))),
    })
}

/// providerBodyError（对齐 `runtime:provider-openai-chat.ts:237-241`）
///
/// 优先级：`error.message`（error 为对象）→ `error`（字符串）→ `message` →
/// `error_description` → `code`。任一命中即视为错误帧。
pub(super) fn provider_body_error(payload: &Value) -> Option<String> {
    let error = payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| string_field(error.get("message")))
        .or_else(|| string_field(payload.get("error")));
    error
        .or_else(|| string_field(payload.get("message")))
        .or_else(|| string_field(payload.get("error_description")))
        .or_else(|| string_field(payload.get("code")))
        .map(str::to_owned)
}

/// 从 usage 对象按名称顺序取第一个嵌套对象（prompt/completion details 变体）
fn nested_details<'a>(usage: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    names
        .iter()
        .find_map(|name| usage.get(*name).filter(|value| value.is_object()))
}

/// 从 details 对象按名称顺序取第一个有限数值字段（write 别名链用，P2 §3.3 D）
fn details_alias(details: Option<&Value>, names: &[&str]) -> Option<u64> {
    details.and_then(|details| names.iter().find_map(|name| finite_u64(details.get(*name))))
}

/// 仅接受有限数值（02 §2.5:319-323）：整数直接取；浮点须有限且非负
fn finite_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64)
    })
}

/// 非空字符串字段
pub(super) fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// 字符串字段
fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}
