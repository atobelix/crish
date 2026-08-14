//! Responses API 解析状态机（SR-06e · 拆分 · ≠ EL）
//!
//! [super::ResponsesParser] 的事件分发（push_frame）与收尾（finish）：
//! 帧级 error 立即终止 → 事件类型分派 → 终态映射与 usage 覆盖式；
//! 无终态事件即流结束 → error（invalid-stream）。pending function_call 管理
//! 在 [super::responses_tool_call]。

use serde_json::{Map, Value};

use conex_types::error::ProviderErrorKind;

use crate::events::{
    stream_error_kind, ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError,
};
use crate::sse::frame::SseFrame;

use super::super::chat::parse_usage;
use super::ResponsesParser;

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
    pub fn push_frame(
        &mut self,
        frame: &SseFrame,
    ) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
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
            let kind = stream_error_kind(&error);
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                error_kind: Some(kind),
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
            // （解析层保护错误 → error_kind=Unknown，不可重试语义保持）
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(
                    "[invalid-stream] Responses stream ended without a terminal response event"
                        .to_string(),
                ),
                error_kind: Some(ProviderErrorKind::Unknown),
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
                // error_kind 跟随 error 文案存在与否：有错误按统一管线分类，
                // 无错误（stop/tool-call/length）为 None（G1-c）
                error_kind: match &self.final_error {
                    Some(err) => Some(stream_error_kind(err)),
                    None => None,
                },
                usage: self.usage.clone(),
            });
        }
        self.stream.extend(events.clone())?;
        self.terminated = true;
        Ok(events)
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
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// 字符串字段
pub(super) fn string_field(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}
