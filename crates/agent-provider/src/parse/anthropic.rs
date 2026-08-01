//! Anthropic Messages SSE 流解析器（任务书 B2.9；02-provider-semantics.md §三.1、§六.6）
//!
//! 事件驱动（帧内含 `type` 字段，对齐 `anthropic-stream-parse.ts:24-208`）：
//! - `message_start` → usage 初始分片（message.usage，input_tokens 等，67-74、283-315）
//! - `content_block_start` → 按 index 注册 tool_use pending；thinking 块跳过
//!   （内容经 thinking_delta 到达，90-92）
//! - `content_block_delta`：`text_delta`→text-delta（105-112）；`thinking_delta`→
//!   thought-delta（不标 redacted，§1.4，114-124）；`input_json_delta`→argumentsText
//!   追加（半 JSON 分片跨帧拼接，126-137）
//! - `content_block_stop` → pending 有 name 则 emit tool-call（142-156）
//! - `message_delta` → stop_reason 覆盖 + usage 分片补全（169-175、363-388）
//! - `message_stop` → 终态（177-180）
//! - 帧级 `error` → 立即 `stop{reason:'error'}` 终止（55-65）
//!
//! stopReason 映射（272-281）：tool_use→tool-call；max_tokens→length；
//! end_turn|stop_sequence|null→stop；refusal→error；其他→stop。
//!
//! 空流保护（198-205）：无任何内容事件且无 message_stop 且无 usage →
//! `stop{error}`；流结束 flush 未 stop 的 pending tool_use（185-196，防御性）。
//!
//! 说明：同角色合并与首条空 user 前置由请求构建层负责（B2.6，任务书明确不在此层），
//! 本层只产出事件序列；message_start 携带的 model 名仅注释记录，model-mismatch
//! 诊断属外层职责（chat/responses 路径同）。

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError, StreamParser};
use crate::sse::frame::SseFrame;

use super::tool_call::parse_arguments;

/// pending 中的一条 tool_use 块（对齐 TS PendingToolUse 14-18）
#[derive(Debug, Clone)]
struct PendingToolUse {
    /// 调用 id（缺失兜底 `toolu_{index}`，02 §3.3 表）
    id: String,
    /// 工具名（缺失表示尚未捕获到 name）
    name: String,
    /// input_json_delta 追加拼接的 arguments JSON 片段
    arguments_text: String,
}

/// Anthropic Messages 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug)]
pub struct AnthropicParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// 按 block index 分组的 pending tool_use
    pending_tools: BTreeMap<usize, PendingToolUse>,
    /// 当前 stop_reason（默认 stop，39-42）
    stop_reason: StopReason,
    /// 分片补全合并后的 usage（message_start 初始 + message_delta 增量）
    usage: Option<ProviderUsage>,
    /// 是否已产出过内容事件（text/thought/tool-call，空流保护判定）
    emitted_content: bool,
    /// 是否收到过 message_stop（空流保护判定）
    saw_message_stop: bool,
    /// 已终结（错误帧或 finish 后）
    terminated: bool,
}

impl Default for AnthropicParser {
    fn default() -> Self {
        Self {
            stream: StreamParser::new(),
            pending_tools: BTreeMap::new(),
            stop_reason: StopReason::Stop,
            usage: None,
            emitted_content: false,
            saw_message_stop: false,
            terminated: false,
        }
    }
}

impl AnthropicParser {
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

        let event_type = string_field(payload.get("type")).unwrap_or("");

        // 帧级 error → 立即终止（55-65；错误帧后不得再产出任何事件）
        if event_type == "error" {
            let error = anthropic_payload_error(payload)
                .unwrap_or_else(|| "Anthropic streaming error".to_string());
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                usage: self.usage.clone(),
            });
            self.stream.extend(events.clone())?;
            self.terminated = true;
            return Ok(events);
        }

        match event_type {
            // usage 初始分片（message.usage，67-74）
            "message_start" => {
                if let Some(message) = payload.get("message").and_then(Value::as_object) {
                    if let Some(usage) = parse_anthropic_usage(message.get("usage")) {
                        self.usage = Some(usage);
                    }
                }
            }
            // content_block_start：注册 tool_use pending（按 index）或跳过 thinking（76-94）
            "content_block_start" => {
                let index = number_field(payload.get("index")).unwrap_or(0);
                let Some(block) = payload.get("content_block").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                // 仅 tool_use 块需要注册 pending；thinking 块内容经 thinking_delta 到达，
                // 无需维护状态（90-92），其余块类型同样忽略
                if string_field(block.get("type")) == Some("tool_use") {
                    let id = string_field(block.get("id"))
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("toolu_{index}"));
                    let name = string_field(block.get("name")).unwrap_or("").to_owned();
                    self.pending_tools.insert(
                        index,
                        PendingToolUse {
                            id,
                            name,
                            arguments_text: String::new(),
                        },
                    );
                }
            }
            // content_block_delta：text / thinking / input_json（96-140）
            "content_block_delta" => {
                let index = number_field(payload.get("index")).unwrap_or(0);
                let Some(delta) = payload.get("delta").and_then(Value::as_object) else {
                    return Ok(Vec::new());
                };
                let delta_type = string_field(delta.get("type")).unwrap_or("");
                if delta_type == "text_delta" || delta.get("text").is_some_and(Value::is_string) {
                    if let Some(text) = non_empty_string(delta.get("text")) {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::TextDelta {
                            text: text.to_owned(),
                        });
                    }
                } else if delta_type == "thinking_delta"
                    || delta.get("thinking").is_some_and(Value::is_string)
                {
                    // thought-delta 不标 redacted（02 §1.4：Anthropic 不标）
                    if let Some(text) = non_empty_string(delta.get("thinking")) {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::ThoughtDelta {
                            text: text.to_owned(),
                            redacted: None,
                        });
                    }
                } else if delta_type == "input_json_delta"
                    || delta.get("partial_json").is_some_and(Value::is_string)
                {
                    // 半 JSON 分片追加（126-137）；无对应 pending（工具块尚未 start）时忽略
                    if let Some(partial) = string_field(delta.get("partial_json")) {
                        if let Some(pending) = self.pending_tools.get_mut(&index) {
                            pending.arguments_text.push_str(partial);
                        }
                    }
                }
            }
            // content_block_stop：pending 有 name 则 emit tool-call（142-156）
            "content_block_stop" => {
                let index = number_field(payload.get("index")).unwrap_or(0);
                if let Some(pending) = self.pending_tools.get(&index) {
                    if !pending.name.is_empty() {
                        self.emitted_content = true;
                        events.push(ProviderStreamEvent::ToolCall {
                            id: Some(pending.id.clone()),
                            tool_name: pending.name.clone(),
                            input: parse_arguments(&pending.arguments_text),
                        });
                    }
                    self.pending_tools.remove(&index);
                }
            }
            // message_delta：stop_reason 覆盖 + usage 分片补全合并（158-175）
            "message_delta" => {
                if let Some(delta) = payload.get("delta").and_then(Value::as_object) {
                    // TS 判定为 `stop_reason !== undefined`：字段存在即映射（含 null → stop）
                    if delta.get("stop_reason").is_some() {
                        self.stop_reason =
                            anthropic_stop_reason_to_stop(delta.get("stop_reason").and_then(Value::as_str));
                    }
                }
                // message_start 带 input_tokens，message_delta 通常只带 output_tokens → 合并（169-175）
                if let Some(delta_usage) = parse_anthropic_usage(payload.get("usage")) {
                    self.usage = Some(merge_anthropic_usage(self.usage.as_ref(), &delta_usage));
                }
            }
            // message_stop → 终态（177-180）
            "message_stop" => {
                self.saw_message_stop = true;
            }
            // 无 type 或未知事件：代理噪声忽略（182）
            _ => {}
        }

        self.stream.extend(events.clone())?;
        Ok(events)
    }

    /// 流结束：flush 未 stop 的 pending → 空流保护 → 唯一 stop
    ///
    /// 对齐 TS 185-207：先防御性 flush（185-196），再空流保护（198-205），
    /// 最后产出唯一 stop（207）。
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        // 防御性 flush：未收到 content_block_stop 的 pending tool_use（185-196）
        for pending in self.pending_tools.values() {
            if !pending.name.is_empty() {
                self.emitted_content = true;
                events.push(ProviderStreamEvent::ToolCall {
                    id: Some(pending.id.clone()),
                    tool_name: pending.name.clone(),
                    input: parse_arguments(&pending.arguments_text),
                });
            }
        }
        self.pending_tools.clear();

        // 空流保护（198-205）：无内容事件且无 message_stop 且无 usage → error
        if !self.emitted_content && !self.saw_message_stop && self.usage.is_none() {
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(
                    "Anthropic streaming response completed without content events".to_string(),
                ),
                usage: None,
            });
        } else {
            events.push(ProviderStreamEvent::Stop {
                reason: self.stop_reason,
                error: None,
                usage: self.usage.clone(),
            });
        }

        self.stream.extend(events.clone())?;
        self.terminated = true;
        Ok(events)
    }
}

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
/// - `total_tokens` ??（prompt/completion 任一存在时的和）
/// - 全空返回 None（304-306）；非对象入参返回 None
pub fn parse_anthropic_usage(raw: Option<&Value>) -> Option<ProviderUsage> {
    let usage = raw?.as_object()?;
    let prompt_tokens = finite_u64(usage.get("input_tokens"))
        .or_else(|| finite_u64(usage.get("prompt_tokens")));
    let completion_tokens = finite_u64(usage.get("output_tokens"))
        .or_else(|| finite_u64(usage.get("completion_tokens")));
    let cache_read_tokens = finite_u64(usage.get("cache_read_input_tokens"));
    let cache_write_tokens = finite_u64(usage.get("cache_creation_input_tokens"));
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
        reasoning_tokens: None,
    })
}

/// mergeAnthropicUsage 分片补全（02 §六.6：Anthropic 分片补全；对齐 363-388）
///
/// message_start 与 message_delta 各自只带部分字段：next 显式字段优先，缺失回退 base；
/// total 由合并后的 prompt+completion 重算（377-378）。
pub fn merge_anthropic_usage(base: Option<&ProviderUsage>, next: &ProviderUsage) -> ProviderUsage {
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
    let total_tokens = if prompt_tokens.is_some() || completion_tokens.is_some() {
        Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0))
    } else {
        next.total_tokens.or_else(|| base.and_then(|base| base.total_tokens))
    };
    ProviderUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
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
fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// 字符串字段
fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// 非负整数（index 等）
fn number_field(value: Option<&Value>) -> Option<usize> {
    value.and_then(Value::as_u64).map(|value| value as usize)
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
        let mut parser = AnthropicParser::new();
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

    fn event_frame(event_type: &str, extra: Value) -> String {
        let mut object = Map::new();
        object.insert("type".to_string(), Value::String(event_type.to_string()));
        if let Value::Object(extra) = extra {
            for (key, value) in extra {
                object.insert(key, value);
            }
        }
        serde_json::to_string(&Value::Object(object)).expect("序列化")
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

    /// 典型正常流：message_start → text 块 delta → message_delta → message_stop
    fn normal_text_stream() -> Vec<String> {
        vec![
            event_frame("message_start", json!({
                "message": { "usage": { "input_tokens": 11 } },
            })),
            event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "text" },
            })),
            event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "你好" },
            })),
            event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "，世界" },
            })),
            event_frame("message_delta", json!({
                "delta": { "stop_reason": "end_turn" },
                "usage": { "output_tokens": 7 },
            })),
            event_frame("message_stop", json!({})),
        ]
    }

    // ── 正常流 / thinking ──

    #[test]
    fn normal_text_stream_flow() {
        let frames = normal_text_stream();
        let frame_refs: Vec<&str> = frames.iter().map(String::as_str).collect();
        let events = parse_all(frame_refs);
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
                usage: Some(ProviderUsage {
                    prompt_tokens: Some(11),
                    completion_tokens: Some(7),
                    total_tokens: Some(18),
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    reasoning_tokens: None,
                }),
            }
        );
    }

    #[test]
    fn thinking_delta_yields_thought_without_redacted() {
        // thinking_delta → thought-delta，不标 redacted（02 §1.4）
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "thinking" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "让我想想" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "再想想" },
            })),
            &event_frame("message_delta", json!({ "delta": { "stop_reason": "end_turn" } })),
            &event_frame("message_stop", json!({})),
        ]);
        let thoughts: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ThoughtDelta { .. }))
            .collect();
        assert_eq!(thoughts.len(), 2);
        for (event, expected_text) in thoughts.iter().zip(["让我想想", "再想想"]) {
            match event {
                ProviderStreamEvent::ThoughtDelta { text, redacted } => {
                    assert_eq!(text, expected_text);
                    assert_eq!(redacted, &None, "Anthropic thought 不标 redacted");
                }
                _ => unreachable!("已过滤"),
            }
        }
    }

    #[test]
    fn thinking_field_compat_variant() {
        // 兼容：delta 无 type 但带 thinking 字段（对齐 TS `typeof delta.thinking === 'string'`）
        let events = parse_all(vec![
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "thinking": "兼容字段" },
            })),
            &event_frame("message_stop", json!({})),
        ]);
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderStreamEvent::ThoughtDelta { text, .. } if text == "兼容字段"
        )));
    }

    #[test]
    fn empty_text_delta_is_ignored() {
        let events = parse_all(vec![
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "" },
            })),
            &event_frame("message_stop", json!({})),
        ]);
        assert_eq!(events.len(), 1, "空 delta 不产出事件，仅剩 stop");
        assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
    }

    // ── 工具调用（含 RU 类：input_json_delta 半 JSON 分片追加）──

    #[test]
    fn tool_use_with_input_json_delta_chunks() {
        // 半 JSON 在 JSON 边界处切分跨帧追加（对齐 TS 126-137 的 `+=` 拼接）
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": r#"{"path":"/a""# },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": r#","mode":"r"}"# },
            })),
            &event_frame("content_block_stop", json!({ "index": 0 })),
            &event_frame("message_delta", json!({ "delta": { "stop_reason": "tool_use" } })),
            &event_frame("message_stop", json!({})),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("toolu_1".into()),
                tool_name: "read_file".into(),
                input: json!({ "path": "/a", "mode": "r" }),
            }
        );
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
    fn tool_use_half_json_chunk_fails_gracefully_with_raw_fallback() {
        // 半 JSON 分片拼接后仍无法解析 → `__rawArguments` 兜底（对齐 parseArguments 335-349）
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_9", "name": "read_file" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"未闭合" },
            })),
            &event_frame("content_block_stop", json!({ "index": 0 })),
            &event_frame("message_stop", json!({})),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        match tool_calls[0] {
            ProviderStreamEvent::ToolCall { input, .. } => {
                assert_eq!(input["__rawArguments"], r#"{"未闭合"#);
                assert!(input["__parseError"].is_string());
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn tool_use_without_name_is_not_emitted() {
        // pending 无 name → content_block_stop 不 emit（对齐 TS 145 判定）
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{}" },
            })),
            &event_frame("content_block_stop", json!({ "index": 0 })),
            &event_frame("message_stop", json!({})),
        ]);
        assert!(tool_calls_of(&events).is_empty());
    }

    #[test]
    fn missing_tool_use_id_falls_back_to_toolu_index() {
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 3,
                "content_block": { "type": "tool_use", "name": "read_file" },
            })),
            &event_frame("content_block_stop", json!({ "index": 3 })),
            &event_frame("message_stop", json!({})),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        match tool_calls[0] {
            ProviderStreamEvent::ToolCall { id, .. } => {
                assert_eq!(id.as_deref(), Some("toolu_3"), "id 缺失兜底 toolu_{{index}}");
            }
            _ => unreachable!("已过滤"),
        }
    }

    #[test]
    fn unfinished_tool_use_is_flushed_defensively() {
        // 流结束未见 content_block_stop → 防御性 flush（185-196）
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": r#"{"path":"/a"}"# },
            })),
            &event_frame("message_stop", json!({})),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("toolu_1".into()),
                tool_name: "read_file".into(),
                input: json!({ "path": "/a" }),
            }
        );
    }

    #[test]
    fn multiple_tool_uses_emit_in_index_order() {
        let events = parse_all(vec![
            &event_frame("content_block_start", json!({
                "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_b", "name": "second" },
            })),
            &event_frame("content_block_start", json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_a", "name": "first" },
            })),
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{}" },
            })),
            &event_frame("content_block_stop", json!({ "index": 0 })),
            &event_frame("content_block_delta", json!({
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{}" },
            })),
            &event_frame("content_block_stop", json!({ "index": 1 })),
            &event_frame("message_stop", json!({})),
        ]);
        let names: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                ProviderStreamEvent::ToolCall { tool_name, .. } => Some(tool_name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(names, vec!["first", "second"], "按 block index 升序 emit");
    }

    // ── stop_reason 映射表（02 §三.1，逐项）──

    #[test]
    fn stop_reason_mapping_table() {
        let cases = [
            (Some("tool_use"), StopReason::ToolCall),
            (Some("max_tokens"), StopReason::Length),
            (Some("end_turn"), StopReason::Stop),
            (Some("stop_sequence"), StopReason::Stop),
            (Some("refusal"), StopReason::Error),
            (Some("unknown_reason"), StopReason::Stop),
            (None, StopReason::Stop),
        ];
        for (reason, expected) in cases {
            assert_eq!(
                anthropic_stop_reason_to_stop(reason),
                expected,
                "stop_reason={reason:?} 映射错误"
            );
        }
    }

    #[test]
    fn max_tokens_stop_reason_yields_length() {
        let events = parse_all(vec![
            &event_frame("content_block_delta", json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "截断前的正文" },
            })),
            &event_frame("message_delta", json!({ "delta": { "stop_reason": "max_tokens" } })),
            &event_frame("message_stop", json!({})),
        ]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Length,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn refusal_stop_reason_yields_error() {
        let events = parse_all(vec![
            &event_frame("message_delta", json!({ "delta": { "stop_reason": "refusal" } })),
            &event_frame("message_stop", json!({})),
        ]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: None,
                usage: None,
            }
        );
    }

    #[test]
    fn stop_reason_later_frame_overrides() {
        // message_delta 覆盖式：后到的 stop_reason 覆盖先前（163-168）
        let events = parse_all(vec![
            &event_frame("message_delta", json!({ "delta": { "stop_reason": "end_turn" } })),
            &event_frame("message_delta", json!({ "delta": { "stop_reason": "max_tokens" } })),
            &event_frame("message_stop", json!({})),
        ]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Length,
                error: None,
                usage: None,
            }
        );
    }

    // ── usage 分片补全（02 §六.6：Anthropic 分片补全）──

    #[test]
    fn usage_merged_across_message_start_and_message_delta() {
        // message_start 只带 input；message_delta 只带 output → 合并且 total 重算
        let events = parse_all(vec![
            &event_frame("message_start", json!({
                "message": { "usage": { "input_tokens": 100, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 10 } },
            })),
            &event_frame("message_delta", json!({ "usage": { "output_tokens": 60 } })),
            &event_frame("message_stop", json!({})),
        ]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(100));
                assert_eq!(usage.completion_tokens, Some(60));
                assert_eq!(usage.total_tokens, Some(160), "total 由合并后重算");
                assert_eq!(usage.cache_read_tokens, Some(40));
                assert_eq!(usage.cache_write_tokens, Some(10));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn usage_preserves_explicit_total_when_fields_missing() {
        // prompt/completion 均缺失时保留显式 total（377-378 的 else 分支）
        let base = ProviderUsage {
            total_tokens: Some(50),
            ..ProviderUsage::default()
        };
        let next = ProviderUsage {
            cache_read_tokens: Some(5),
            ..ProviderUsage::default()
        };
        let merged = merge_anthropic_usage(Some(&base), &next);
        assert_eq!(merged.total_tokens, Some(50), "无 prompt/completion 时保留显式 total");
        assert_eq!(merged.cache_read_tokens, Some(5));
    }

    #[test]
    fn usage_next_fields_override_base() {
        let base = ProviderUsage {
            prompt_tokens: Some(10),
            completion_tokens: Some(20),
            total_tokens: Some(30),
            ..ProviderUsage::default()
        };
        let next = ProviderUsage {
            completion_tokens: Some(25),
            ..ProviderUsage::default()
        };
        let merged = merge_anthropic_usage(Some(&base), &next);
        assert_eq!(merged.prompt_tokens, Some(10), "base 字段保留");
        assert_eq!(merged.completion_tokens, Some(25), "next 显式字段优先");
        assert_eq!(merged.total_tokens, Some(35), "total 重算为 10+25");
    }

    #[test]
    fn parse_anthropic_usage_accepts_snake_alternates() {
        let usage = parse_anthropic_usage(Some(&json!({
            "prompt_tokens": 3,
            "completion_tokens": 4,
            "total_tokens": 9,
        })));
        let usage = usage.expect("解析成功");
        assert_eq!(usage.prompt_tokens, Some(3));
        assert_eq!(usage.completion_tokens, Some(4));
        assert_eq!(usage.total_tokens, Some(9), "显式 total 优先于重算");
    }

    #[test]
    fn parse_anthropic_usage_empty_returns_none() {
        assert!(parse_anthropic_usage(None).is_none());
        assert!(parse_anthropic_usage(Some(&Value::Null)).is_none());
        assert!(parse_anthropic_usage(Some(&json!("usage"))).is_none());
        assert!(parse_anthropic_usage(Some(&json!({}))).is_none(), "全空字段返回 None");
        assert!(parse_anthropic_usage(Some(&json!({ "input_tokens": 1 }))).is_some());
    }

    // ── 空流保护 / 收尾 ──

    #[test]
    fn empty_stream_produces_error_stop() {
        // 无 message_start / 内容 / message_stop / usage → error（198-205）
        let events = parse_all(vec![]);
        assert_eq!(events.len(), 1);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { reason: StopReason::Error, error, usage } => {
                assert_eq!(
                    error.as_deref(),
                    Some("Anthropic streaming response completed without content events")
                );
                assert!(usage.is_none());
            }
            other => panic!("期望 error stop，得到：{other:?}"),
        }
    }

    #[test]
    fn message_stop_alone_prevents_empty_stream_error() {
        // 有 message_stop → 不算空流，正常 stop（198 判定）
        let events = parse_all(vec![&event_frame("message_stop", json!({}))]);
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
    fn usage_only_stream_is_not_an_error() {
        // 无内容但有 usage → 不算空流（198 判定）；message_start 即带 usage
        let events = parse_all(vec![
            &event_frame("message_start", json!({
                "message": { "usage": { "input_tokens": 5 } },
            })),
        ]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { reason: StopReason::Stop, usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(5));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn finish_is_idempotent() {
        let mut parser = AnthropicParser::new();
        let first = parser.finish().expect("首次 finish");
        assert_eq!(first.len(), 1);
        assert!(
            parser.finish().expect("二次 finish").is_empty(),
            "重复 finish 不得再产出 stop"
        );
        assert!(parser.is_terminated());
    }

    #[test]
    fn noise_frames_are_ignored() {
        // 无 type 或未知事件：代理噪声忽略，不炸流（182）
        let events = parse_all(vec![
            r#"{"ping":"keep-alive"}"#,
            &event_frame("unknown_event", json!({ "data": "x" })),
            &event_frame("message_stop", json!({})),
        ]);
        assert_eq!(events.len(), 1, "仅剩 stop");
        assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
    }

    // ── 错误帧 ──

    #[test]
    fn error_frame_terminates_immediately() {
        let events = parse_all(vec![r#"{"type":"error","error":{"type":"overloaded_error","message":"过载"}}"#]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("overloaded_error: 过载".into()),
                usage: None,
            }
        );
        assert_eq!(events.len(), 1, "错误帧后不得再产出任何事件");
    }

    #[test]
    fn error_frame_variants() {
        let cases = [
            (r#"{"type":"error","error":"字符串错误"}"#, "字符串错误"),
            (r#"{"type":"error","error":{"message":"仅消息"}}"#, "仅消息"),
            (r#"{"type":"error","error":{"type":"仅类型"}}"#, "仅类型"),
            (r#"{"type":"error","message":"顶层消息"}"#, "顶层消息"),
            (r#"{"type":"error"}"#, "Anthropic streaming error"),
            // 非 error 帧的顶层 message 不视为错误
            (r#"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#, "no-error"),
        ];
        for (data, expected) in cases {
            let events = parse_all(vec![data]);
            if expected == "no-error" {
                assert!(events.iter().all(|event| !matches!(
                    event,
                    ProviderStreamEvent::Stop { reason: StopReason::Error, .. }
                )), "{data} 不应判定为错误帧");
                continue;
            }
            match stop_of(&events) {
                ProviderStreamEvent::Stop { reason: StopReason::Error, error: Some(error), .. } => {
                    assert_eq!(error, expected, "{data}");
                }
                other => panic!("{data} 期望错误 stop，得到：{other:?}"),
            }
        }
    }

    #[test]
    fn frames_after_error_are_ignored() {
        let mut parser = AnthropicParser::new();
        parser
            .push_frame(&SseFrame {
                event: None,
                data: Some(r#"{"type":"error","error":"boom"}"#.to_string()),
                id: None,
                retry: None,
            })
            .expect("错误帧处理");
        assert!(parser.is_terminated());
        assert!(
            parser
                .push_frame(&SseFrame {
                    event: None,
                    data: Some(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}"#.to_string()),
                    id: None,
                    retry: None,
                })
                .expect("已终结帧处理")
                .is_empty(),
            "错误帧后 push 应空产出"
        );
    }
}
