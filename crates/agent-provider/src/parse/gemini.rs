//! Gemini streamGenerateContent SSE 流解析器（任务书 B2.9；02-provider-semantics.md §三.2、§六.6）
//!
//! 帧式解析（对齐 `gemini-stream-parse.ts:18-188`）：
//! - 每帧 `candidates[].content.parts[]`：`part.thought===true` 且带 text →
//!   thought-delta（96-104）；`part.text` → text-delta（106-110）；
//!   `functionCall` / `function_call` → 完整工具调用一次性产出（112-138，
//!   缺 name 丢弃；id 缺失兜底 `gemini_fc_{n}`）
//! - `candidate.finishReason` → 映射（141-154、305-336）：STOP|END_TURN→stop；
//!   MAX_TOKENS→length；SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|
//!   IMAGE_SAFETY|MALFORMED_FUNCTION_CALL|OTHER→error（带 `Gemini finishReason: X` 文案）；
//!   未指定且有工具调用→tool-call
//! - 有工具调用且 reason 为 stop 时强制 tool-call（158-160）
//! - `promptFeedback.blockReason` 且无 candidates → `stop{error}`（60-71、398-414）
//! - `usageMetadata` 每帧合并（73-76、456-479；02 §六.6：Gemini 逐帧合并）
//! - 顶层 `error` 对象 → 立即 `stop{reason:'error'}`（48-58）
//!
//! 空流保护（162-169）：无内容事件且无终态帧且无 usage → `stop{error}`。

use serde_json::{json, Map, Value};

use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError, StreamParser};
use crate::sse::frame::SseFrame;

use super::tool_call::parse_arguments;

/// Gemini 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug)]
pub struct GeminiParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// 当前 stop_reason（默认 stop，32-35）
    stop_reason: StopReason,
    /// 逐帧合并后的 usage（usageMetadata 为累计值）
    usage: Option<ProviderUsage>,
    /// 是否已产出过内容事件（text/thought/tool-call，空流保护判定）
    emitted_content: bool,
    /// 是否已见过终态帧（finishReason 非空，空流保护判定）
    saw_terminal: bool,
    /// 工具调用计数（id 兜底 `gemini_fc_{n}` 与强制 tool-call 判定）
    tool_call_count: u64,
    /// finishReason 映射出的错误文案（reason=error 时携带）
    stream_error: Option<String>,
    /// 已终结（错误帧或 finish 后）
    terminated: bool,
}

impl Default for GeminiParser {
    fn default() -> Self {
        Self {
            stream: StreamParser::new(),
            stop_reason: StopReason::Stop,
            usage: None,
            emitted_content: false,
            saw_terminal: false,
            tool_call_count: 0,
            stream_error: None,
            terminated: false,
        }
    }
}

impl GeminiParser {
    /// 新建解析器
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否已终结（错误帧或 finish 后）
    pub fn is_terminated(&self) -> bool {
        self.terminated
    }

    /// 当前合并到的 usage（stop 事件携带用）
    pub fn usage(&self) -> Option<&ProviderUsage> {
        self.usage.as_ref()
    }

    /// 处理一帧，产出该帧触发的事件
    ///
    /// 分帧层（sse/frame.rs）已保证 data 为合法 JSON 对象或 `[DONE]` 哨兵；
    /// 此处防御性解析失败仅跳过不炸流。
    pub fn push_frame(&mut self, frame: &SseFrame) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let Some(data) = frame.data.as_deref() else {
            return Ok(Vec::new());
        };
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            return Ok(Vec::new());
        };
        let Some(payload) = payload.as_object() else {
            return Ok(Vec::new());
        };
        let mut events = Vec::new();

        // 顶层 error 对象（部分代理 / API 错误帧，48-58）→ 立即终止
        if let Some(error) = gemini_payload_error(payload) {
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                usage: self.usage.clone(),
            });
            self.stream.extend(events.clone())?;
            self.terminated = true;
            return Ok(events);
        }

        // promptFeedback.blockReason 且无 candidates → blocked（60-71、398-414）
        if let Some(block) = prompt_block_reason(payload) {
            if !has_candidates(payload) {
                let block_usage =
                    parse_gemini_usage(payload.get("usageMetadata")).or_else(|| self.usage.clone());
                events.push(ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some(block),
                    usage: block_usage,
                });
                self.stream.extend(events.clone())?;
                self.terminated = true;
                return Ok(events);
            }
        }

        // usageMetadata 每帧合并（73-76、456-479；02 §六.6：Gemini 逐帧合并）
        if let Some(chunk) = parse_gemini_usage(payload.get("usageMetadata")) {
            self.usage = Some(merge_gemini_usage(self.usage.as_ref(), &chunk));
        }

        // candidates[].content.parts[]（78-139）；注意 Gemini 遍历全部 candidates（与 chat 仅取首个不同）
        if let Some(candidates) = payload.get("candidates").and_then(Value::as_array) {
            for raw in candidates {
                let Some(candidate) = raw.as_object() else {
                    continue;
                };
                let parts = candidate
                    .get("content")
                    .and_then(Value::as_object)
                    .and_then(|content| content.get("parts"))
                    .and_then(Value::as_array);
                if let Some(parts) = parts {
                    for raw_part in parts {
                        let Some(part) = raw_part.as_object() else {
                            continue;
                        };
                        // thought 部分（96-104）：thought===true 且带 text → thought-delta
                        if part.get("thought").and_then(Value::as_bool) == Some(true) {
                            if let Some(text) = non_empty_string(part.get("text")) {
                                self.emitted_content = true;
                                events.push(ProviderStreamEvent::ThoughtDelta {
                                    text: text.to_owned(),
                                    redacted: None,
                                });
                            }
                            continue;
                        }
                        // 正文部分（106-110）
                        if let Some(text) = non_empty_string(part.get("text")) {
                            self.emitted_content = true;
                            events.push(ProviderStreamEvent::TextDelta {
                                text: text.to_owned(),
                            });
                            continue;
                        }
                        // functionCall / function_call 完整调用一次性产出（112-138）
                        let function_call = part
                            .get("functionCall")
                            .and_then(Value::as_object)
                            .or_else(|| part.get("function_call").and_then(Value::as_object));
                        if let Some(function_call) = function_call {
                            // 缺 name 丢弃（对齐 TS `if (!name) continue`，120-123）
                            let Some(name) = string_field(function_call.get("name")) else {
                                continue;
                            };
                            self.emitted_content = true;
                            self.tool_call_count += 1;
                            let args = normalize_function_args(
                                function_call
                                    .get("args")
                                    .filter(|value| !value.is_null())
                                    .or_else(|| {
                                        function_call.get("arguments").filter(|value| !value.is_null())
                                    }),
                            );
                            let id = string_field(function_call.get("id"))
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("gemini_fc_{}", self.tool_call_count));
                            events.push(ProviderStreamEvent::ToolCall {
                                id: Some(id),
                                tool_name: name.to_owned(),
                                input: args,
                            });
                        }
                    }
                }
                // finishReason 映射（141-154、305-336；null/缺失不触发）
                if let Some(finish_reason) = candidate.get("finishReason") {
                    if !finish_reason.is_null() {
                        self.saw_terminal = true;
                        let mapped = gemini_finish_reason_to_stop(
                            finish_reason.as_str(),
                            self.tool_call_count > 0,
                        );
                        self.stop_reason = mapped.0;
                        if let Some(error) = mapped.1 {
                            self.stream_error = Some(error);
                        }
                    }
                }
            }
        }

        self.stream.extend(events.clone())?;
        Ok(events)
    }

    /// 流结束：强制 tool-call → 空流保护 → 唯一 stop
    ///
    /// 对齐 TS 158-187：先强制 tool-call（158-160），再空流保护（162-169），
    /// reason=error 时携带错误文案（171-187）。
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        // 有工具调用且 reason 为 stop → 强制 tool-call（158-160）
        if self.tool_call_count > 0 && self.stop_reason == StopReason::Stop {
            self.stop_reason = StopReason::ToolCall;
        }
        // 空流保护（162-169）：无内容事件且无终态帧且无 usage → error
        if !self.emitted_content && !self.saw_terminal && self.usage.is_none() {
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(
                    "Gemini streaming response completed without content events".to_string(),
                ),
                usage: None,
            });
        } else {
            // reason=error 时携带 streamError（171-187）
            let error = if self.stop_reason == StopReason::Error {
                self.stream_error.clone()
            } else {
                None
            };
            events.push(ProviderStreamEvent::Stop {
                reason: self.stop_reason,
                error,
                usage: self.usage.clone(),
            });
        }
        self.stream.extend(events.clone())?;
        self.terminated = true;
        Ok(events)
    }
}

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
/// - `cachedContentTokenCount` ?? `cached_content_token_count` → cacheRead
/// - `thoughtsTokenCount` ?? `thoughts_token_count` → reasoningTokens
/// - `totalTokenCount` ?? `total_token_count` ??（prompt/completion 任一存在时的和）
/// - 全空返回 None（361-369）；非对象入参返回 None
pub fn parse_gemini_usage(raw: Option<&Value>) -> Option<ProviderUsage> {
    let usage = raw?.as_object()?;
    let prompt_tokens = finite_u64(usage.get("promptTokenCount"))
        .or_else(|| finite_u64(usage.get("prompt_token_count")));
    let completion_tokens = finite_u64(usage.get("candidatesTokenCount"))
        .or_else(|| finite_u64(usage.get("responseTokenCount")))
        .or_else(|| finite_u64(usage.get("candidates_token_count")));
    let cache_read_tokens = finite_u64(usage.get("cachedContentTokenCount"))
        .or_else(|| finite_u64(usage.get("cached_content_token_count")));
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
        cache_write_tokens: None,
        reasoning_tokens,
    })
}

/// mergeGeminiUsage 逐帧合并（02 §六.6：Gemini 逐帧合并；对齐 456-479）
///
/// usageMetadata 为累计值：next 显式字段优先，缺失回退 base；total 优先取 next
/// 显式值，其次按合并后的 prompt+completion 重算，最后回退 base（465-469）。
pub fn merge_gemini_usage(base: Option<&ProviderUsage>, next: &ProviderUsage) -> ProviderUsage {
    let prompt_tokens = next.prompt_tokens.or_else(|| base.and_then(|base| base.prompt_tokens));
    let completion_tokens = next
        .completion_tokens
        .or_else(|| base.and_then(|base| base.completion_tokens));
    let cache_read_tokens = next
        .cache_read_tokens
        .or_else(|| base.and_then(|base| base.cache_read_tokens));
    let cache_write_tokens = next
        .cache_write_tokens
        .or_else(|| base.and_then(|base| base.cache_write_tokens));
    let reasoning_tokens = next
        .reasoning_tokens
        .or_else(|| base.and_then(|base| base.reasoning_tokens));
    let total_tokens = next.total_tokens.or_else(|| {
        if prompt_tokens.is_some() || completion_tokens.is_some() {
            Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0))
        } else {
            base.and_then(|base| base.total_tokens)
        }
    });
    ProviderUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
    }
}

/// geminiPayloadError（对齐 380-396）
///
/// 优先级：`error`（trim 非空字符串）→ error 对象（`{status}: {message}` →
/// `{code}: {message}` → message → status）。
fn gemini_payload_error(payload: &Map<String, Value>) -> Option<String> {
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
fn prompt_block_reason(payload: &Map<String, Value>) -> Option<String> {
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
fn has_candidates(payload: &Map<String, Value>) -> bool {
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .is_some_and(|candidates| !candidates.is_empty())
}

/// normalizeFunctionArgs（对齐 420-442）
///
/// - JSON 对象 → 原样
/// - 字符串 → [super::tool_call::parse_arguments]（空→{}、对象→原样、非对象→
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
fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// 字符串字段
fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// 仅接受有限数值（对齐 TS numberField，02 §2.5 同款判定）：整数直接取；浮点须有限且非负
fn finite_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 便捷构造：处理一帧并立即 finish，返回全部事件
    fn parse_all(frames: Vec<&str>) -> Vec<ProviderStreamEvent> {
        let mut parser = GeminiParser::new();
        let mut events = Vec::new();
        for data in frames {
            let frame = SseFrame {
                event: None,
                data: Some(data.to_string()),
                id: None,
                retry: None,
            };
            events.extend(parser.push_frame(&frame).expect("帧处理"));
        }
        events.extend(parser.finish().expect("流结束"));
        events
    }

    /// 单 candidate 单 part 帧
    fn part_frame(part: Value, finish_reason: Value) -> String {
        serde_json::to_string(&json!({
            "candidates": [{
                "content": { "parts": [part] },
                "finishReason": finish_reason,
            }],
        }))
        .expect("序列化")
    }

    fn stop_of(events: &[ProviderStreamEvent]) -> &ProviderStreamEvent {
        events
            .iter()
            .find(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
            .expect("流内应有 stop")
    }

    fn tool_calls_of(events: &[ProviderStreamEvent]) -> Vec<&ProviderStreamEvent> {
        events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ToolCall { .. }))
            .collect()
    }

    // ── 正常流 / thinking ──

    #[test]
    fn text_parts_yield_text_deltas() {
        let events = parse_all(vec![
            &part_frame(json!({ "text": "你好" }), Value::Null),
            &part_frame(json!({ "text": "，世界" }), json!("STOP")),
        ]);
        let texts: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["你好", "，世界"]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn thought_part_yields_thought_without_redacted() {
        let events = parse_all(vec![
            &part_frame(json!({ "text": "推理中", "thought": true }), Value::Null),
            &part_frame(json!({ "text": "正文" }), json!("STOP")),
        ]);
        let thoughts: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ThoughtDelta { .. }))
            .collect();
        assert_eq!(thoughts.len(), 1);
        match thoughts[0] {
            ProviderStreamEvent::ThoughtDelta { text, redacted } => {
                assert_eq!(text, "推理中");
                assert_eq!(redacted, &None, "Gemini thought 不标 redacted（02 §1.4）");
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn thought_part_without_text_is_ignored() {
        let events = parse_all(vec![&part_frame(json!({ "thought": true }), json!("STOP"))]);
        assert_eq!(events.len(), 1, "无 text 的 thought part 不产出事件");
        assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
    }

    #[test]
    fn multiple_parts_and_candidates_in_one_frame() {
        let data = serde_json::to_string(&json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "A" },
                        { "text": "B", "thought": true },
                        { "text": "C" },
                    ],
                },
                "finishReason": "STOP",
            }],
        }))
        .expect("序列化");
        let events = parse_all(vec![&data]);
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| match event {
                ProviderStreamEvent::TextDelta { .. } => "text",
                ProviderStreamEvent::ThoughtDelta { .. } => "thought",
                ProviderStreamEvent::Stop { .. } => "stop",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["text", "thought", "text", "stop"]);
    }

    // ── 工具调用 ──

    #[test]
    fn function_call_part_emits_full_tool_call() {
        // functionCall 完整调用一次产出（name/args）
        let events = parse_all(vec![&part_frame(
            json!({ "functionCall": { "name": "read_file", "args": { "path": "/a" } } }),
            json!("STOP"),
        )]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("gemini_fc_1".into()),
                tool_name: "read_file".into(),
                input: json!({ "path": "/a" }),
            }
        );
        // 有工具调用且 reason=STOP → 强制 tool-call（158-160）
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::ToolCall,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn function_call_snake_case_variant() {
        let events = parse_all(vec![&part_frame(
            json!({ "function_call": { "name": "read_file", "args": {} } }),
            Value::Null,
        )]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        match tool_calls[0] {
            ProviderStreamEvent::ToolCall { tool_name, .. } => {
                assert_eq!(tool_name, "read_file");
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn function_call_without_name_is_dropped() {
        // 缺 name → 丢弃（对齐 TS `if (!name) continue`，120-123）
        let events = parse_all(vec![&part_frame(
            json!({ "functionCall": { "args": {} } }),
            json!("STOP"),
        )]);
        assert!(tool_calls_of(&events).is_empty());
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn function_call_id_present_is_used() {
        let events = parse_all(vec![&part_frame(
            json!({ "functionCall": { "id": "fc_42", "name": "read_file", "args": {} } }),
            Value::Null,
        )]);
        match tool_calls_of(&events)[0] {
            ProviderStreamEvent::ToolCall { id, .. } => {
                assert_eq!(id.as_deref(), Some("fc_42"));
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn function_call_ids_increment_without_explicit_id() {
        let events = parse_all(vec![
            &part_frame(json!({ "functionCall": { "name": "a", "args": {} } }), Value::Null),
            &part_frame(json!({ "functionCall": { "name": "b", "args": {} } }), Value::Null),
        ]);
        let ids: Vec<Option<&str>> = events
            .iter()
            .filter_map(|event| match event {
                ProviderStreamEvent::ToolCall { id, .. } => Some(id.as_deref()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec![Some("gemini_fc_1"), Some("gemini_fc_2")]);
    }

    #[test]
    fn function_call_args_as_json_string_is_parsed() {
        // 参数可为 JSON 字符串（normalizeFunctionArgs，420-442）
        let events = parse_all(vec![&part_frame(
            json!({ "functionCall": { "name": "read_file", "args": r#"{"path":"/a"}"# } }),
            Value::Null,
        )]);
        match tool_calls_of(&events)[0] {
            ProviderStreamEvent::ToolCall { input, .. } => {
                assert_eq!(*input, json!({ "path": "/a" }));
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn function_call_unparseable_args_produce_raw_fallback() {
        let events = parse_all(vec![&part_frame(
            json!({ "functionCall": { "name": "read_file", "args": "{" } }),
            Value::Null,
        )]);
        match tool_calls_of(&events)[0] {
            ProviderStreamEvent::ToolCall { input, .. } => {
                assert_eq!(input["__rawArguments"], "{");
                assert!(input["__parseError"].is_string());
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn function_call_args_non_object_wrap_in_value() {
        let events = parse_all(vec![
            &part_frame(
                json!({ "functionCall": { "name": "t", "args": [1, 2] } }),
                Value::Null,
            ),
            &part_frame(json!({ "functionCall": { "name": "u" } }), Value::Null),
        ]);
        let inputs: Vec<Value> = events
            .iter()
            .filter_map(|event| match event {
                ProviderStreamEvent::ToolCall { input, .. } => Some(input.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(inputs[0], json!({ "value": [1, 2] }), "非对象参数包裹 {{value}}");
        assert_eq!(inputs[1], json!({}), "args 缺失 → {{}}");
    }

    // ── finishReason 映射表（02 §三.2，逐项）──

    #[test]
    fn finish_reason_mapping_table() {
        let cases = [
            (Some("STOP"), None, StopReason::Stop),
            (Some("END_TURN"), None, StopReason::Stop),
            (Some("MAX_TOKENS"), None, StopReason::Length),
            (Some("SAFETY"), Some("Gemini finishReason: SAFETY"), StopReason::Error),
            (Some("RECITATION"), Some("Gemini finishReason: RECITATION"), StopReason::Error),
            (Some("BLOCKLIST"), Some("Gemini finishReason: BLOCKLIST"), StopReason::Error),
            (Some("PROHIBITED_CONTENT"), Some("Gemini finishReason: PROHIBITED_CONTENT"), StopReason::Error),
            (Some("SPII"), Some("Gemini finishReason: SPII"), StopReason::Error),
            (Some("IMAGE_SAFETY"), Some("Gemini finishReason: IMAGE_SAFETY"), StopReason::Error),
            (Some("MALFORMED_FUNCTION_CALL"), Some("Gemini finishReason: MALFORMED_FUNCTION_CALL"), StopReason::Error),
            (Some("OTHER"), Some("Gemini finishReason: OTHER"), StopReason::Error),
            (Some("SOMETHING_NEW"), None, StopReason::Stop),
            (None, None, StopReason::Stop),
            (Some(""), None, StopReason::Stop),
            (Some("FINISH_REASON_UNSPECIFIED"), None, StopReason::Stop),
        ];
        for (reason, expected_error, expected) in cases {
            let mapped = gemini_finish_reason_to_stop(reason, false);
            assert_eq!(mapped.0, expected, "finishReason={reason:?} 映射错误");
            assert_eq!(mapped.1.as_deref(), expected_error, "finishReason={reason:?} 文案错误");
        }
    }

    #[test]
    fn finish_reason_lowercase_is_uppercased() {
        // TS `String(reason).toUpperCase()`：小写输入同样命中
        let mapped = gemini_finish_reason_to_stop(Some("max_tokens"), false);
        assert_eq!(mapped.0, StopReason::Length);
    }

    #[test]
    fn finish_reason_stop_with_tool_call_forces_tool_call() {
        let mapped = gemini_finish_reason_to_stop(Some("STOP"), true);
        assert_eq!(mapped.0, StopReason::ToolCall);
        let mapped = gemini_finish_reason_to_stop(Some("END_TURN"), true);
        assert_eq!(mapped.0, StopReason::ToolCall);
        let mapped = gemini_finish_reason_to_stop(None, true);
        assert_eq!(mapped.0, StopReason::ToolCall);
    }

    #[test]
    fn error_finish_reason_not_overridden_by_tool_call() {
        // SAFETY 等 error 映射不因工具调用被改写（305-336 分支顺序）
        let mapped = gemini_finish_reason_to_stop(Some("SAFETY"), true);
        assert_eq!(mapped.0, StopReason::Error);
        assert!(mapped.1.is_some());
    }

    #[test]
    fn later_finish_reason_overrides_earlier() {
        // finishReason 覆盖式：后帧覆盖前帧（stopReason 每帧重赋）
        let events = parse_all(vec![
            &part_frame(json!({ "text": "a" }), json!("MAX_TOKENS")),
            &part_frame(json!({ "text": "b" }), json!("STOP")),
        ]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn error_finish_reason_carries_message() {
        let events = parse_all(vec![&part_frame(json!({ "text": "x" }), json!("SAFETY"))]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("Gemini finishReason: SAFETY".into()),
                usage: None,
            }
        );
    }

    // ── usage 逐帧合并（02 §六.6：Gemini 逐帧合并）──

    #[test]
    fn usage_merged_across_frames() {
        // usageMetadata 为累计值：帧 2 携带完整计数，帧 1 的部分字段回退保留（456-479）
        let frame1 = serde_json::to_string(&json!({
            "candidates": [{ "content": { "parts": [{ "text": "a" }] }, "finishReason": "STOP" }],
            "usageMetadata": { "promptTokenCount": 10, "cachedContentTokenCount": 4, "thoughtsTokenCount": 3 },
        })).expect("序列化");
        let frame2 = serde_json::to_string(&json!({
            "candidates": [{ "content": { "parts": [{ "text": "b" }] }, "finishReason": "STOP" }],
            "usageMetadata": { "promptTokenCount": 10, "candidatesTokenCount": 20 },
        })).expect("序列化");
        let events = parse_all(vec![&frame1, &frame2]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(10));
                assert_eq!(usage.completion_tokens, Some(20));
                assert_eq!(usage.total_tokens, Some(30), "next 显式 total（累计值）优先");
                assert_eq!(usage.cache_read_tokens, Some(4), "帧 1 字段回退保留");
                assert_eq!(usage.reasoning_tokens, Some(3), "帧 1 字段回退保留");
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn usage_total_prefers_next_explicit_value() {
        // 累计值语义：next 显式 total 优先于重算（465-467）
        let base = ProviderUsage {
            prompt_tokens: Some(10),
            completion_tokens: Some(5),
            total_tokens: Some(15),
            ..ProviderUsage::default()
        };
        let next = ProviderUsage {
            prompt_tokens: Some(10),
            completion_tokens: Some(20),
            total_tokens: Some(30),
            ..ProviderUsage::default()
        };
        let merged = merge_gemini_usage(Some(&base), &next);
        assert_eq!(merged.total_tokens, Some(30), "next 显式 total 优先");
        assert_eq!(merged.prompt_tokens, Some(10));
        assert_eq!(merged.completion_tokens, Some(20));
    }

    #[test]
    fn usage_total_recomputed_when_next_missing() {
        let base = ProviderUsage {
            prompt_tokens: Some(10),
            completion_tokens: Some(5),
            total_tokens: Some(15),
            ..ProviderUsage::default()
        };
        let next = ProviderUsage {
            completion_tokens: Some(20),
            ..ProviderUsage::default()
        };
        let merged = merge_gemini_usage(Some(&base), &next);
        assert_eq!(merged.prompt_tokens, Some(10), "base 字段保留");
        assert_eq!(merged.completion_tokens, Some(20), "next 显式字段优先");
        assert_eq!(merged.total_tokens, Some(30), "next 无 total → 重算 10+20");
    }

    #[test]
    fn parse_gemini_usage_accepts_snake_alternates() {
        let usage = parse_gemini_usage(Some(&json!({
            "prompt_token_count": 3,
            "candidates_token_count": 4,
            "total_token_count": 9,
            "cached_content_token_count": 1,
            "thoughts_token_count": 2,
        })));
        let usage = usage.expect("解析成功");
        assert_eq!(usage.prompt_tokens, Some(3));
        assert_eq!(usage.completion_tokens, Some(4));
        assert_eq!(usage.total_tokens, Some(9), "显式 total 优先于重算");
        assert_eq!(usage.cache_read_tokens, Some(1));
        assert_eq!(usage.reasoning_tokens, Some(2));
    }

    #[test]
    fn parse_gemini_usage_empty_returns_none() {
        assert!(parse_gemini_usage(None).is_none());
        assert!(parse_gemini_usage(Some(&Value::Null)).is_none());
        assert!(parse_gemini_usage(Some(&json!("usage"))).is_none());
        assert!(parse_gemini_usage(Some(&json!({}))).is_none(), "全空字段返回 None");
        assert!(parse_gemini_usage(Some(&json!({ "promptTokenCount": 1 }))).is_some());
    }

    // ── 阻断 / 空流保护 / 收尾 ──

    #[test]
    fn block_reason_without_candidates_errors() {
        // promptFeedback.blockReason 且无 candidates → stop{error}（60-71）
        let data = r#"{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"含违禁内容"}}"#;
        let events = parse_all(vec![data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("Gemini prompt blocked (SAFETY): 含违禁内容".into()),
                usage: None,
            }
        );
    }

    #[test]
    fn block_reason_without_message_uses_reason_only() {
        let data = r#"{"promptFeedback":{"block_reason":"OTHER"}}"#;
        let events = parse_all(vec![data]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { reason: StopReason::Error, error: Some(error), .. } => {
                assert_eq!(error, "Gemini prompt blocked: OTHER");
            }
            other => panic!("期望阻断 error stop，得到：{other:?}"),
        }
    }

    #[test]
    fn block_reason_with_candidates_is_not_an_error() {
        // 有 candidates 时 blockReason 不触发阻断分支（62 判定）
        let data = serde_json::to_string(&json!({
            "candidates": [{ "content": { "parts": [{ "text": "x" }] }, "finishReason": "STOP" }],
            "promptFeedback": { "blockReason": "SAFETY" },
        })).expect("序列化");
        let events = parse_all(vec![&data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn unspecified_block_reason_is_ignored() {
        let cases = [
            r#"{"promptFeedback":{"blockReason":"BLOCK_REASON_UNSPECIFIED"}}"#,
            r#"{"promptFeedback":{"blockReason":""}}"#,
            r#"{"promptFeedback":{}}"#,
            r#"{}"#,
        ];
        for data in cases {
            let events = parse_all(vec![data]);
            assert_eq!(
                stop_of(&events),
                &ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("Gemini streaming response completed without content events".into()),
                    usage: None,
                },
                "{data} 应走空流保护而非阻断"
            );
        }
    }

    #[test]
    fn empty_stream_produces_error_stop() {
        // 无 candidates / usage / 终态 → error（162-169）
        let events = parse_all(vec![]);
        assert_eq!(events.len(), 1);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { reason: StopReason::Error, error, usage } => {
                assert_eq!(
                    error.as_deref(),
                    Some("Gemini streaming response completed without content events")
                );
                assert!(usage.is_none());
            }
            other => panic!("期望 error stop，得到：{other:?}"),
        }
    }

    #[test]
    fn usage_only_stream_is_not_an_error() {
        // 无内容但有 usage → 不算空流（162 判定）
        let data = r#"{"usageMetadata":{"promptTokenCount":5}}"#;
        let events = parse_all(vec![data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: Some(ProviderUsage {
                    prompt_tokens: Some(5),
                    total_tokens: Some(5),
                    ..ProviderUsage::default()
                }),
            }
        );
    }

    #[test]
    fn finish_is_idempotent() {
        let mut parser = GeminiParser::new();
        let first = parser.finish().expect("首次 finish");
        assert_eq!(first.len(), 1);
        assert!(
            parser.finish().expect("二次 finish").is_empty(),
            "重复 finish 不得再产出 stop"
        );
        assert!(parser.is_terminated());
    }

    #[test]
    fn non_object_parts_and_candidates_are_skipped() {
        let data = serde_json::to_string(&json!({
            "candidates": [
                "not-an-object",
                { "content": { "parts": [42, { "text": "正文" }] }, "finishReason": "STOP" },
            ],
        })).expect("序列化");
        let events = parse_all(vec![&data]);
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderStreamEvent::TextDelta { text } if text == "正文"
        )));
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: None,
            }
        );
    }

    // ── 错误帧 ──

    #[test]
    fn error_frame_terminates_immediately() {
        let cases = [
            (r#"{"error":{"status":"INVALID_ARGUMENT","message":"参数错"}}"#, "INVALID_ARGUMENT: 参数错"),
            (r#"{"error":{"code":403,"message":"无权限"}}"#, "403: 无权限"),
            (r#"{"error":{"message":"仅消息"}}"#, "仅消息"),
            (r#"{"error":{"status":"UNAVAILABLE"}}"#, "UNAVAILABLE"),
            (r#"{"error":"字符串错误"}"#, "字符串错误"),
        ];
        for (data, expected) in cases {
            let events = parse_all(vec![data]);
            assert_eq!(
                stop_of(&events),
                &ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some(expected.into()),
                    usage: None,
                },
                "{data}"
            );
        }
    }

    #[test]
    fn frames_after_error_are_ignored() {
        let mut parser = GeminiParser::new();
        parser
            .push_frame(&SseFrame {
                event: None,
                data: Some(r#"{"error":{"message":"boom"}}"#.to_string()),
                id: None,
                retry: None,
            })
            .expect("错误帧处理");
        assert!(parser.is_terminated());
        assert!(
            parser
                .push_frame(&SseFrame {
                    event: None,
                    data: Some(r#"{"candidates":[{"content":{"parts":[{"text":"x"}]},"finishReason":"STOP"}]}"#.to_string()),
                    id: None,
                    retry: None,
                })
                .expect("已终结帧处理")
                .is_empty(),
            "错误帧后 push 应空产出"
        );
    }
}
