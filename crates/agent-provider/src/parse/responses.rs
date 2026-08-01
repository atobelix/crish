//! Responses API SSE 流解析器（任务书 B2.9；02-provider-semantics.md §二.4、§六.6、§六.10）
//!
//! 事件驱动（帧内含 `type` 字段，对齐 `provider-openai-responses.ts:95-236`）：
//! - `response.output_text.delta` → text-delta（151-158）
//! - `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` /
//!   `response.reasoning.delta` → thought-delta{redacted:true}（159-166、373-379，02 §六.10）
//! - `response.output_item.added` / `.done` → 合并 function_call item；`.done` 时若
//!   arguments 已就绪则 emit tool-call（167-184、290-315）
//! - `response.function_call_arguments.delta` → arguments 追加；`.done` → 替换并 emit
//!   tool-call（185-198、317-340）
//! - `response.completed` / `.failed` / `.incomplete` → 终态映射（199-211、381-388）：
//!   status=incomplete→length；failed|cancelled→error；否则 stop
//! - 帧级 `error` 事件 → 立即 `stop{reason:'error'}` 终止（138-150）
//! - usage 覆盖式：任意帧的 `usage` / `response.usage` 都可能携带（133-136；§2.5
//!   同构复用 chat 的 [super::chat::parse_usage]，02 §六.6：OpenAI 覆盖式）
//!
//! 工具调用按 item_id/call_id 分组（key 兜底 `response_call_{n}`），emit 用
//! `emitted` 集合按 call_id/id 去重（357-371）；id 缺失兜底 item_id/key。
//! 无终态事件即流结束 → `stop{reason:'error'}`（invalid-stream，218-229）；
//! `sawToolCall` 时 `stop.reason` 强制为 `tool-call`（232）。
//!
//! 说明：TS 端 parseArguments 解析失败兜底 `{}`（476-486）；本实现复用共享的
//! [super::tool_call::parse_arguments]（`__rawArguments` 兜底，02 §2.3），信息更完整，
//! 与 chat/Anthropic/Gemini 解析器行为一致（有意分歧，注释记录）。

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError, StreamParser};
use crate::sse::frame::SseFrame;

use super::chat::parse_usage;
use super::tool_call::parse_arguments;

/// pending 中的一条 function_call item（对齐 TS ResponsePendingToolCall 29-36）
///
/// TS 端 `itemDone` 字段只写不读，此处省略；`id` 字段仅作 callId 缺失时的兜底，
/// 而兜底链（item_id ?? call_id ?? key）保证 call_id 恒非空，故亦省略（emit 与
/// 去重均只用 call_id）；`argumentsDone` 用于 output_item.done 到达时判断是否
/// 已具备完整参数（172-176）。
#[derive(Debug, Clone)]
struct ResponsePendingToolCall {
    /// Map 分组 key：item_id ?? call_id ?? `response_call_{n}`
    key: String,
    /// item.call_id ?? id ?? key（事件 id 与去重均取此）
    call_id: String,
    /// 工具名（缺失表示尚未捕获到 name）
    name: String,
    /// arguments 文本（delta 追加 / done 替换）
    arguments_text: String,
    /// `response.function_call_arguments.done` 已到达
    arguments_done: bool,
}

/// Responses API 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug)]
pub struct ResponsesParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// 按 item_id/call_id 分组的 pending function_call
    pending: Vec<ResponsePendingToolCall>,
    /// 已 emit 的 call_id/id（去重，357-371）
    emitted: HashSet<String>,
    /// 覆盖式 usage（任意帧都可能携带）
    usage: Option<ProviderUsage>,
    /// 终态映射结果（responseStatusToStop，381-388）
    final_reason: StopReason,
    /// 终态帧的错误文案（responseError，390-395）
    final_error: Option<String>,
    /// 流内已见过工具调用（stop 强制 tool-call，232）
    saw_tool_call: bool,
    /// 已收到终态事件（completed/failed/incomplete）
    saw_terminal: bool,
    /// 已终结（错误帧或 finish 后）
    terminated: bool,
}

impl Default for ResponsesParser {
    fn default() -> Self {
        Self {
            stream: StreamParser::new(),
            pending: Vec::new(),
            emitted: HashSet::new(),
            usage: None,
            final_reason: StopReason::Stop,
            final_error: None,
            saw_tool_call: false,
            saw_terminal: false,
            terminated: false,
        }
    }
}

impl ResponsesParser {
    /// 新建解析器
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否已终结（错误帧或 finish 后）
    pub fn is_terminated(&self) -> bool {
        self.terminated
    }

    /// 当前覆盖到的 usage（stop 事件携带用）
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

        // usage 覆盖式：payload.usage ?? response.usage（133-136，02 §六.6 OpenAI 覆盖式）
        let parsed = parse_usage(payload.get("usage")).or_else(|| {
            payload
                .get("response")
                .and_then(Value::as_object)
                .and_then(|response| parse_usage(response.get("usage")))
        });
        if parsed.is_some() {
            self.usage = parsed;
        }

        let event_type = string_field(payload.get("type")).unwrap_or("");

        // 帧级 error 事件 → 立即终止（138-150；错误帧后不得再产出任何事件）
        if event_type == "error" {
            let error = response_error(payload)
                .or_else(|| string_field(payload.get("message")).map(str::to_owned))
                .or_else(|| string_field(payload.get("code")).map(str::to_owned))
                .unwrap_or_else(|| "Responses stream emitted an error event".to_string());
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
            // 正文增量（151-158）
            "response.output_text.delta" => {
                if let Some(delta) = non_empty_string(payload.get("delta")) {
                    events.push(ProviderStreamEvent::TextDelta {
                        text: delta.to_owned(),
                    });
                }
            }
            // 三种 reasoning delta → thought-delta{redacted:true}（159-166、373-379，02 §六.10）
            "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta"
            | "response.reasoning.delta" => {
                if let Some(delta) = non_empty_string(payload.get("delta")) {
                    events.push(ProviderStreamEvent::ThoughtDelta {
                        text: delta.to_owned(),
                        redacted: Some(true),
                    });
                }
            }
            // function_call item 合并；`.done` 时若参数已就绪则 emit（167-184）
            "response.output_item.added" => {
                self.merge_item(payload.get("item"));
            }
            "response.output_item.done" => {
                if let Some(index) = self.merge_item(payload.get("item")) {
                    let ready = {
                        let call = &self.pending[index];
                        call.arguments_done || !call.arguments_text.trim().is_empty()
                    };
                    if ready {
                        if let Some(event) = self.emit_tool_call(index) {
                            self.saw_tool_call = true;
                            events.push(event);
                        }
                    }
                }
            }
            // arguments 追加（185-188、317-340）
            "response.function_call_arguments.delta" => {
                self.merge_arguments(payload, true);
            }
            // arguments 替换并 emit（189-198）
            "response.function_call_arguments.done" => {
                if let Some(index) = self.merge_arguments(payload, false) {
                    self.pending[index].arguments_done = true;
                    if let Some(event) = self.emit_tool_call(index) {
                        self.saw_tool_call = true;
                        events.push(event);
                    }
                }
            }
            // 终态映射（199-211、381-388）
            "response.completed" | "response.failed" | "response.incomplete" => {
                self.saw_terminal = true;
                let response_payload = payload.get("response").and_then(Value::as_object);
                // 终态帧的 usage 覆盖式更新
                if let Some(usage) =
                    response_payload.and_then(|response| parse_usage(response.get("usage")))
                {
                    self.usage = Some(usage);
                }
                let terminal = response_payload.unwrap_or(payload);
                self.final_reason = response_status_to_stop(terminal.get("status"));
                self.final_error = response_error(terminal);
                // 终态帧携带的 output[] 也要合并（可能含此前未见过的 function_call item，
                // 在 finish flush 时统一 emit，206-210）
                if let Some(output) = response_payload
                    .and_then(|response| response.get("output"))
                    .and_then(Value::as_array)
                {
                    for item in output {
                        self.merge_item(Some(item));
                    }
                }
            }
            // 未知/噪声事件忽略（不炸流）
            _ => {}
        }

        self.stream.extend(events.clone())?;
        Ok(events)
    }

    /// 流结束：flush 未 emit 的 pending → 无终态事件则 error → 唯一 stop
    ///
    /// 对齐 TS 214-235：先 flush（214-217），再判 sawTerminal（218-229），
    /// sawToolCall 强制 tool-call（232）。
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        for index in 0..self.pending.len() {
            if let Some(event) = self.emit_tool_call(index) {
                self.saw_tool_call = true;
                events.push(event);
            }
        }
        if !self.saw_terminal {
            // 无终态事件即流结束 → error（invalid-stream，218-229）
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(
                    "[invalid-stream] Responses stream ended without a terminal response event"
                        .to_string(),
                ),
                usage: self.usage.clone(),
            });
        } else {
            events.push(ProviderStreamEvent::Stop {
                reason: if self.saw_tool_call {
                    StopReason::ToolCall
                } else {
                    self.final_reason
                },
                error: self.final_error.clone(),
                usage: self.usage.clone(),
            });
        }
        self.stream.extend(events.clone())?;
        self.terminated = true;
        Ok(events)
    }

    /// 合并 function_call item 进 pending（对齐 mergeResponseToolCallItem 290-315）
    ///
    /// 仅 `type === 'function_call'` 的 item 参与；返回 pending 下标（未命中返回 None）。
    fn merge_item(&mut self, item: Option<&Value>) -> Option<usize> {
        let record = item?.as_object()?;
        if string_field(record.get("type")) != Some("function_call") {
            return None;
        }
        let item_id = string_field(record.get("id"));
        let call_id = string_field(record.get("call_id"));
        // key 兜底链：findKey ?? item_id ?? call_id ?? `response_call_{n}`（298-303）
        let key = self
            .find_pending(item_id, call_id)
            .map(|index| self.pending[index].key.clone())
            .unwrap_or_else(|| {
                item_id
                    .map(str::to_owned)
                    .or_else(|| call_id.map(str::to_owned))
                    .unwrap_or_else(|| format!("response_call_{}", self.pending.len()))
            });
        let index = match self.pending.iter().position(|call| call.key == key) {
            Some(index) => index,
            None => {
                self.pending.push(ResponsePendingToolCall {
                    key: key.clone(),
                    call_id: call_id.map(str::to_owned).unwrap_or_else(|| {
                        item_id.map(str::to_owned).unwrap_or_else(|| key.clone())
                    }),
                    name: String::new(),
                    arguments_text: String::new(),
                    arguments_done: false,
                });
                self.pending.len() - 1
            }
        };
        {
            let call = &mut self.pending[index];
            // 覆盖式：call_id / name 仅在提供时覆盖；arguments 字符串整体替换（309-312）
            if let Some(call_id) = call_id {
                call.call_id = call_id.to_owned();
            }
            if let Some(name) = string_field(record.get("name")) {
                call.name = name.to_owned();
            }
            if let Some(arguments) = string_field(record.get("arguments")) {
                call.arguments_text = arguments.to_owned();
            }
        }
        Some(index)
    }

    /// 合并 function_call_arguments 增量（对齐 mergeResponseToolCallArguments 317-340）
    ///
    /// `append=true`（delta 帧）追加拼接；`append=false`（done 帧）整体替换。
    /// 找不到 key（item_id/call_id 均缺失且无法定位）→ 无操作（325-326）。
    fn merge_arguments(&mut self, payload: &Map<String, Value>, append: bool) -> Option<usize> {
        let item_id = string_field(payload.get("item_id"));
        let call_id = string_field(payload.get("call_id"));
        let index = match self.find_pending(item_id, call_id) {
            Some(index) => index,
            None => {
                // key = item_id ?? call_id；均缺失 → 无操作（325-326）
                let key = item_id
                    .map(str::to_owned)
                    .or_else(|| call_id.map(str::to_owned))?;
                let new_index = self.pending.len();
                self.pending.push(ResponsePendingToolCall {
                    key: key.clone(),
                    call_id: call_id.map(str::to_owned).unwrap_or_else(|| key.clone()),
                    name: String::new(),
                    arguments_text: String::new(),
                    arguments_done: false,
                });
                new_index
            }
        };
        // arguments ?? delta（333-335）
        let arguments_text = string_field(payload.get("arguments"))
            .or_else(|| string_field(payload.get("delta")));
        if let Some(arguments_text) = arguments_text {
            let call = &mut self.pending[index];
            if append {
                call.arguments_text.push_str(arguments_text);
            } else {
                call.arguments_text = arguments_text.to_owned();
            }
        }
        Some(index)
    }

    /// 定位已有 pending（对齐 findResponseToolCallKey 342-355）
    ///
    /// 顺序：key==item_id → key==call_id → 扫 call_id 字段。
    fn find_pending(&self, item_id: Option<&str>, call_id: Option<&str>) -> Option<usize> {
        if let Some(item_id) = item_id {
            if let Some(index) = self.pending.iter().position(|call| call.key == item_id) {
                return Some(index);
            }
        }
        if let Some(call_id) = call_id {
            if let Some(index) = self.pending.iter().position(|call| call.key == call_id) {
                return Some(index);
            }
        }
        if let Some(call_id) = call_id {
            if let Some(index) = self.pending.iter().position(|call| call.call_id == call_id) {
                return Some(index);
            }
        }
        None
    }

    /// emit 工具调用（对齐 emitResponseToolCall 357-371）
    ///
    /// 无 name、无 emittedKey 或已 emit → None（去重）；事件 id 取 call_id ?? id。
    fn emit_tool_call(&mut self, index: usize) -> Option<ProviderStreamEvent> {
        let call = &self.pending[index];
        if call.name.is_empty() {
            return None;
        }
        let emitted_key = call.call_id.clone();
        if self.emitted.contains(&emitted_key) {
            return None;
        }
        self.emitted.insert(emitted_key.clone());
        Some(ProviderStreamEvent::ToolCall {
            id: Some(call.call_id.clone()),
            tool_name: call.name.clone(),
            input: parse_arguments(&call.arguments_text),
        })
    }
}

/// responseStatusToStop 终态映射（02 §二.4 表末行；对齐 381-388）
///
/// | status | stop reason |
/// |---|---|
/// | `incomplete` | `length` |
/// | `failed` / `cancelled` | `error` |
/// | 其他（含 `completed`、缺失） | `stop` |
pub fn response_status_to_stop(status: Option<&Value>) -> StopReason {
    match status.and_then(Value::as_str) {
        Some("incomplete") => StopReason::Length,
        Some("failed") | Some("cancelled") => StopReason::Error,
        _ => StopReason::Stop,
    }
}

/// responseError（对齐 390-395）：`error.message`（error 为对象）→ `error`（字符串）
fn response_error(payload: &Map<String, Value>) -> Option<String> {
    let error = payload.get("error");
    error
        .and_then(Value::as_object)
        .and_then(|record| string_field(record.get("message")))
        .map(str::to_owned)
        .or_else(|| error.and_then(Value::as_str).map(str::to_owned))
}

/// 非空字符串字段
fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// 字符串字段
fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 便捷构造：处理一帧并立即 finish，返回全部事件
    fn parse_all(frames: Vec<&str>) -> Vec<ProviderStreamEvent> {
        let mut parser = ResponsesParser::new();
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

    fn frame_with_type(event_type: &str) -> String {
        serde_json::to_string(&json!({ "type": event_type })).expect("序列化")
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

    /// 终态帧：status 挂在 payload.response 上（对齐真实 Responses API）
    fn terminal_frame(event_type: &str, status: &str) -> String {
        serde_json::to_string(&json!({
            "type": event_type,
            "response": { "status": status },
        }))
        .expect("序列化")
    }

    // ── 正文 / thinking ──

    #[test]
    fn text_delta_from_output_text() {
        let events = parse_all(vec![
            &serde_json::to_string(&json!({ "type": "response.output_text.delta", "delta": "你好" })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.output_text.delta", "delta": "，世界" })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
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
    fn reasoning_delta_yields_redacted_thought() {
        // 三种 reasoning delta 均 → thought-delta{redacted:true}（02 §六.10）
        let events = parse_all(vec![
            &serde_json::to_string(&json!({ "type": "response.reasoning_summary_text.delta", "delta": "摘要" })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.reasoning_text.delta", "delta": "推理" })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.reasoning.delta", "delta": "再想" })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        let thoughts: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ThoughtDelta { .. }))
            .collect();
        assert_eq!(thoughts.len(), 3);
        let expected = ["摘要", "推理", "再想"];
        for (event, expected_text) in thoughts.iter().zip(expected) {
            match event {
                ProviderStreamEvent::ThoughtDelta { text, redacted } => {
                    assert_eq!(text, expected_text);
                    assert_eq!(redacted, &Some(true));
                }
                _ => unreachable!("已过滤"),
            }
        }
    }

    #[test]
    fn empty_delta_is_ignored() {
        let events = parse_all(vec![
            &serde_json::to_string(&json!({ "type": "response.output_text.delta", "delta": "" })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        assert_eq!(events.len(), 1, "空 delta 不产出事件，仅剩 stop");
        assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
    }

    // ── 工具调用 ──

    #[test]
    fn function_call_via_arguments_delta_append() {
        // added(item) → arguments.delta 两片 → arguments.done → tool-call 一次性产出
        let events = parse_all(vec![
            &serde_json::to_string(&json!({
                "type": "response.output_item.added",
                "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "" },
            })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": r#"{"path":"/a""# })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": r#","mode":"r"}"# })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.done", "item_id": "item_1", "arguments": r#"{"path":"/a","mode":"r"}"# })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("call_1".into()),
                tool_name: "read_file".into(),
                input: json!({ "path": "/a", "mode": "r" }),
            }
        );
        // sawToolCall → stop 强制 tool-call（232）
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
    fn function_call_item_done_emits_when_arguments_ready() {
        // output_item.added 时 arguments 为 ""（占位）；output_item.done 携带完整参数 → emit
        let events = parse_all(vec![
            &serde_json::to_string(&json!({
                "type": "response.output_item.added",
                "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "write_file", "arguments": "" },
            })).expect("序列化"),
            &serde_json::to_string(&json!({
                "type": "response.output_item.done",
                "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "write_file", "arguments": r#"{"path":"/b"}"# },
            })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("call_1".into()),
                tool_name: "write_file".into(),
                input: json!({ "path": "/b" }),
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
    fn tool_call_emitted_only_once_despite_redelivery() {
        // arguments.done 已 emit 后，终态帧 output[] 再次携带同一 item → 去重不重复 emit
        let events = parse_all(vec![
            &serde_json::to_string(&json!({
                "type": "response.output_item.added",
                "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "" },
            })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.done", "item_id": "item_1", "arguments": r#"{"path":"/a"}"# })).expect("序列化"),
            &serde_json::to_string(&json!({
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": [{ "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": r#"{"path":"/a"}"# }],
                },
            })).expect("序列化"),
        ]);
        assert_eq!(tool_calls_of(&events).len(), 1, "emitted 集合去重后仅一条");
    }

    #[test]
    fn arguments_delta_before_item_creates_pending() {
        // 无 output_item 前置，仅 arguments.delta（item_id 定位）→ 新建 pending → done emit
        let events = parse_all(vec![
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.delta", "item_id": "item_x", "call_id": "call_x", "delta": r#"{"x":1}"# })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.done", "item_id": "item_x", "call_id": "call_x", "arguments": r#"{"x":1}"# })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        let tool_calls = tool_calls_of(&events);
        // done 帧时 name 仍为空 → 不 emit；finish flush 时 name 也为空 → 仍不 emit
        assert!(tool_calls.is_empty(), "无 name 的工具调用不得 emit");
    }

    #[test]
    fn arguments_delta_before_item_but_name_from_item_then_emit() {
        let events = parse_all(vec![
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.delta", "item_id": "item_x", "call_id": "call_x", "delta": r#"{"x":1}"# })).expect("序列化"),
            &serde_json::to_string(&json!({
                "type": "response.output_item.added",
                "item": { "id": "item_x", "type": "function_call", "call_id": "call_x", "name": "read_file" },
            })).expect("序列化"),
            &serde_json::to_string(&json!({ "type": "response.function_call_arguments.done", "item_id": "item_x", "call_id": "call_x" })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("call_x".into()),
                tool_name: "read_file".into(),
                input: json!({ "x": 1 }),
            }
        );
    }

    #[test]
    fn tool_call_without_name_never_emits() {
        let events = parse_all(vec![
            &serde_json::to_string(&json!({
                "type": "response.output_item.done",
                "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "arguments": "{}" },
            })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        assert!(tool_calls_of(&events).is_empty());
        // 无工具调用 → 终态映射原样生效
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
    fn missing_call_id_falls_back_to_item_id() {
        let events = parse_all(vec![
            &serde_json::to_string(&json!({
                "type": "response.output_item.done",
                "item": { "id": "item_9", "type": "function_call", "name": "read_file", "arguments": r#"{"a":1}"# },
            })).expect("序列化"),
            &terminal_frame("response.completed", "completed"),
        ]);
        let tool_calls = tool_calls_of(&events);
        assert_eq!(tool_calls.len(), 1);
        match tool_calls[0] {
            ProviderStreamEvent::ToolCall { id, .. } => {
                assert_eq!(id.as_deref(), Some("item_9"), "id 缺失兜底 item_id");
            }
            _ => unreachable!("已过滤"),
        }
    }

    // ── 终态映射表（02 §二.4，逐项）──

    #[test]
    fn terminal_status_mapping_table() {
        let cases = [
            ("response.completed", "completed", StopReason::Stop),
            ("response.completed", "incomplete", StopReason::Length),
            ("response.incomplete", "incomplete", StopReason::Length),
            ("response.failed", "failed", StopReason::Error),
            ("response.failed", "cancelled", StopReason::Error),
            ("response.completed", "cancelled", StopReason::Error),
        ];
        for (event_type, status, expected) in cases {
            let events = parse_all(vec![&terminal_frame(event_type, status)]);
            assert_eq!(
                stop_of(&events),
                &ProviderStreamEvent::Stop {
                    reason: expected,
                    error: None,
                    usage: None,
                },
                "{event_type} status={status} 映射错误"
            );
        }
    }

    #[test]
    fn terminal_status_missing_maps_to_stop() {
        // responseStatusToStop 兜底：非 incomplete/failed/cancelled → stop（388）
        let events = parse_all(vec![&frame_with_type("response.completed")]);
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
    fn incomplete_with_tool_call_forces_tool_call() {
        // sawToolCall 强制 tool-call 优先于 incomplete→length（232）
        let events = parse_all(vec![
            &serde_json::to_string(&json!({
                "type": "response.output_item.done",
                "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "read_file", "arguments": "{}" },
            })).expect("序列化"),
            &terminal_frame("response.incomplete", "incomplete"),
        ]);
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
    fn failed_terminal_carries_error_message() {
        let data = serde_json::to_string(&json!({
            "type": "response.failed",
            "response": { "status": "failed", "error": { "message": "模型拒绝" } },
        }))
        .expect("序列化");
        let events = parse_all(vec![&data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("模型拒绝".into()),
                usage: None,
            }
        );
    }

    // ── 空流保护 / 收尾 ──

    #[test]
    fn stream_without_terminal_event_errors() {
        // 无终态事件即流结束 → error（invalid-stream，218-229）
        let events = parse_all(vec![&serde_json::to_string(&json!({
            "type": "response.output_text.delta",
            "delta": "正文",
        })).expect("序列化")]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { reason: StopReason::Error, error, .. } => {
                assert_eq!(
                    error.as_deref(),
                    Some("[invalid-stream] Responses stream ended without a terminal response event")
                );
            }
            other => panic!("期望 error stop，得到：{other:?}"),
        }
    }

    #[test]
    fn empty_stream_without_terminal_errors() {
        let events = parse_all(vec![]);
        assert_eq!(events.len(), 1);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { reason: StopReason::Error, .. } => {}
            other => panic!("期望 error stop，得到：{other:?}"),
        }
    }

    #[test]
    fn finish_is_idempotent() {
        let mut parser = ResponsesParser::new();
        let first = parser.finish().expect("首次 finish");
        assert_eq!(first.len(), 1);
        assert!(
            parser.finish().expect("二次 finish").is_empty(),
            "重复 finish 不得再产出 stop"
        );
        assert!(parser.is_terminated());
    }

    // ── 错误帧 ──

    #[test]
    fn error_frame_terminates_immediately() {
        let data = r#"{"type":"error","error":{"message":"上下文超长"}}"#;
        let events = parse_all(vec![data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("上下文超长".into()),
                usage: None,
            }
        );
        assert_eq!(events.len(), 1, "错误帧后不得再产出任何事件");
    }

    #[test]
    fn error_frame_falls_back_to_message_and_code() {
        let cases = [
            (r#"{"type":"error","message":"m1"}"#, "m1"),
            (r#"{"type":"error","code":"c2"}"#, "c2"),
            (r#"{"type":"error"}"#, "Responses stream emitted an error event"),
        ];
        for (data, expected) in cases {
            let events = parse_all(vec![data]);
            match stop_of(&events) {
                ProviderStreamEvent::Stop { reason: StopReason::Error, error: Some(error), .. } => {
                    assert_eq!(error, expected);
                }
                other => panic!("{data} 期望错误 stop，得到：{other:?}"),
            }
        }
    }

    #[test]
    fn frames_after_error_are_ignored() {
        let mut parser = ResponsesParser::new();
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
                    data: Some(r#"{"type":"response.output_text.delta","delta":"x"}"#.to_string()),
                    id: None,
                    retry: None,
                })
                .expect("已终结帧处理")
                .is_empty(),
            "错误帧后 push 应空产出"
        );
    }

    // ── usage 覆盖式（02 §六.6：OpenAI 覆盖式）──

    #[test]
    fn usage_override_later_frame_wins() {
        let first = serde_json::to_string(&json!({
            "type": "response.output_text.delta",
            "delta": "a",
            "usage": { "input_tokens": 1, "output_tokens": 2, "total_tokens": 3 },
        })).expect("序列化");
        let second = serde_json::to_string(&json!({
            "type": "response.output_text.delta",
            "delta": "b",
            "usage": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 },
        })).expect("序列化");
        let events = parse_all(vec![&first, &second, &terminal_frame("response.completed", "completed")]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(10));
                assert_eq!(usage.completion_tokens, Some(20));
                assert_eq!(usage.total_tokens, Some(30));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn terminal_frame_usage_overrides() {
        // response.usage 覆盖式（206）：终态帧的 usage 优于先前帧
        let early = serde_json::to_string(&json!({
            "type": "response.output_text.delta",
            "delta": "a",
            "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 },
        })).expect("序列化");
        let terminal = serde_json::to_string(&json!({
            "type": "response.completed",
            "response": {
                "status": "completed",
                "usage": { "input_tokens": 5, "output_tokens": 7, "total_tokens": 12 },
            },
        })).expect("序列化");
        let events = parse_all(vec![&early, &terminal]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(5));
                assert_eq!(usage.completion_tokens, Some(7));
                assert_eq!(usage.total_tokens, Some(12));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn usage_accepts_chat_style_fields_and_details() {
        // §2.5 同构：prompt_tokens/completion_tokens/details 细节
        let data = r#"{"type":"response.completed","response":{"status":"completed","usage":{
            "prompt_tokens": 5,
            "completion_tokens": 7,
            "total_tokens": 12,
            "prompt_tokens_details": { "cached_tokens": 3 },
            "completion_tokens_details": { "reasoning_tokens": 4 }
        }}}"#;
        let events = parse_all(vec![data]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(5));
                assert_eq!(usage.completion_tokens, Some(7));
                assert_eq!(usage.cache_read_tokens, Some(3));
                assert_eq!(usage.reasoning_tokens, Some(4));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn usage_rejects_non_finite_values() {
        let data = r#"{"type":"response.completed","response":{"status":"completed","usage":{
            "prompt_tokens": "1e3",
            "completion_tokens": null,
            "total_tokens": 3
        }}}"#;
        let events = parse_all(vec![data]);
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, None, "非数值应忽略");
                assert_eq!(usage.completion_tokens, None, "null 应忽略");
                assert_eq!(usage.total_tokens, Some(3));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    // ── 终态映射函数 ──

    #[test]
    fn response_status_to_stop_table() {
        let cases = [
            (Some("incomplete"), StopReason::Length),
            (Some("failed"), StopReason::Error),
            (Some("cancelled"), StopReason::Error),
            (Some("completed"), StopReason::Stop),
            (Some("unknown"), StopReason::Stop),
            (None, StopReason::Stop),
        ];
        for (status, expected) in cases {
            let value = status.map(|s| json!(s));
            assert_eq!(
                response_status_to_stop(value.as_ref()),
                expected,
                "status={status:?} 映射错误"
            );
        }
    }
}
