//! chat-completions 解析状态机（SR-06e · 拆分 · ≠ EL）
//!
//! [ChatCompletionsParser] 持有每流恰好一个 stop 的状态机（StreamParser）、
//! tool_call 增量收集器与覆盖式 usage；push_frame / finish 的帧处理顺序
//! （02 §2.2，不可变）逐行对齐 TS 端 runtime:provider-openai-chat.ts。
//! 帧级映射/usage 工具在 [super::chat_mapping]。

use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};
use serde_json::Value;

use crate::events::{
    stream_error_kind, ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError,
    StreamParser,
};
use crate::sse::frame::SseFrame;

use super::super::think_tags::StreamingTagExtractor;
use super::super::tool_call::{parse_full_tool_call, ToolCallCollector};
use super::chat_mapping::{
    finish_reason_to_stop, non_empty_string, parse_usage, provider_body_error,
};

/// chat-completions 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug, Default)]
pub struct ChatCompletionsParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// tool_call 增量收集器
    collector: ToolCallCollector,
    /// 当前 finish_reason（默认 stop，02 §2.2:85）
    finish_reason: Option<StopReason>,
    /// 覆盖式 usage（任何帧都可能携带）
    usage: Option<ProviderUsage>,
    /// 已终结（错误帧或 finish 后；此后 push_frame/finish 均空产出）
    terminated: bool,
    /// 内嵌思考标签实时提取器（B2.5 / Markdown Stream Refactor）
    tag_extractor: StreamingTagExtractor,
}

impl ChatCompletionsParser {
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
    /// `[DONE]` 由读取层消费（reader.rs），此处防御性解析失败仅跳过不炸流。
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
        let mut events = Vec::new();

        // 1. 错误帧 → 立即终止（02 §2.2 步骤 2）；error_kind 按错误帧文案分类
        if let Some(error) = provider_body_error(&payload) {
            let kind = stream_error_kind(&error);
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                error_kind: Some(kind),
                usage: None,
            });
            self.stream.check_events(&events)?;
            self.terminated = true;
            return Ok(events);
        }

        // 2. usage 覆盖式（02 §2.2 步骤 3；非对象或不含有效数值不覆盖）
        if let Some(usage) = parse_usage(payload.get("usage")) {
            self.usage = Some(usage);
        }

        // 3. 仅无 choice 时跳过（§五 #7；delta 可为 null/缺失，不得连带跳过 finish_reason）
        let Some(choice) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return Ok(Vec::new());
        };
        let Some(choice) = choice.as_object() else {
            return Ok(Vec::new());
        };

        // 4. delta 内容（02 §2.2 步骤 4）
        let delta = choice.get("delta").and_then(Value::as_object);
        if let Some(delta) = delta {
            // thought 5 级优先级探测链：reasoning_content → reasoning → thinking → thinking_delta → thought（02 §1.4）
            if let Some(thought) = extract_thought_string(delta.get("reasoning_content"))
                .or_else(|| extract_thought_string(delta.get("reasoning")))
                .or_else(|| extract_thought_string(delta.get("thinking")))
                .or_else(|| extract_thought_string(delta.get("thinking_delta")))
                .or_else(|| extract_thought_string(delta.get("thought")))
            {
                events.push(ProviderStreamEvent::ThoughtDelta {
                    text: thought.to_owned(),
                    redacted: None,
                });
            }
            if let Some(text) = non_empty_string(delta.get("content")) {
                let extracted = self.tag_extractor.push_text(text);
                events.extend(extracted);
            }
            // 标准位置：delta.tool_calls[]（增量合并进 pending）
            if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for raw in tool_calls {
                    self.collector.merge(raw);
                }
            }
            // legacy 兼容：delta.function_call（单对象，OpenAI 旧版格式）
            if let Some(function_call) =
                delta.get("function_call").filter(|value| value.is_object())
            {
                self.collector.merge(function_call);
            }
        }

        // 5. 非流式格式混入流式：choice.message.tool_calls（完整调用，立即产出，§五 #7）
        let message = choice.get("message").and_then(Value::as_object);
        if let Some(message) = message {
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for raw in tool_calls {
                    if let Some(call) = parse_full_tool_call(raw) {
                        events.push(ProviderStreamEvent::ToolCall {
                            id: call.id,
                            tool_name: call.tool_name,
                            input: call.input,
                        });
                    }
                }
            }
            // 无 delta 时 message 兜底思考与正文（对齐 runtime:provider-openai-chat.ts:128-130）
            if delta.is_none() {
                if let Some(thought) = extract_thought_string(message.get("reasoning_content"))
                    .or_else(|| extract_thought_string(message.get("reasoning")))
                    .or_else(|| extract_thought_string(message.get("thinking")))
                    .or_else(|| extract_thought_string(message.get("thinking_delta")))
                    .or_else(|| extract_thought_string(message.get("thought")))
                {
                    events.push(ProviderStreamEvent::ThoughtDelta {
                        text: thought.to_owned(),
                        redacted: None,
                    });
                }
                if let Some(text) = non_empty_string(message.get("content")) {
                    let extracted = self.tag_extractor.push_text(text);
                    events.extend(extracted);
                }
            }
        }

        // 6. 平铺变体：choice.tool_calls[]（极少数兼容实现，§五 #7）
        if let Some(tool_calls) = choice.get("tool_calls").and_then(Value::as_array) {
            for raw in tool_calls {
                self.collector.merge(raw);
            }
        }

        // 7. finish_reason 覆盖（02 §2.2 步骤 5；null/缺失不覆盖）
        if let Some(reason) = choice.get("finish_reason") {
            if !reason.is_null() {
                self.finish_reason = Some(finish_reason_to_stop(reason.as_str()));
            }
        }

        self.stream.check_events(&events)?;
        Ok(events)
    }

    /// 流结束：flush pending → RU-08/09 → 唯一 stop（02 §2.2 步骤 6、§五 #4/#5/#6）
    pub fn finish(&mut self) -> Result<Vec<ProviderStreamEvent>, StreamParseError> {
        if self.terminated {
            return Ok(Vec::new());
        }
        let mut events = Vec::new();
        let has_tool_calls = self.collector.has_named_calls();
        let flush = self.collector.finish();

        // 冲刷标签状态机未决的缓冲区
        let remaining_tag_events = self.tag_extractor.finish();
        events.extend(remaining_tag_events);

        // flush pending：名完整 → 完整 tool-call；缺 name → RU-06 诊断（不静默丢）
        for call in flush.calls {
            events.push(ProviderStreamEvent::ToolCall {
                id: call.id,
                tool_name: call.tool_name,
                input: call.input,
            });
        }
        for diagnostic in flush.diagnostics {
            events.push(ProviderStreamEvent::ProviderDiagnostic { diagnostic });
        }

        // RU-08：有工具调用但 finish_reason 缺失/非 tool-call → 强制 tool-call（02 §五 #5）
        let mut stop_reason = self.finish_reason.unwrap_or(StopReason::Stop);
        if has_tool_calls && !matches!(stop_reason, StopReason::ToolCall | StopReason::Error) {
            stop_reason = StopReason::ToolCall;
        }
        // RU-09：finish_reason=tool_calls 但零捕获 → 诊断（02 §五 #6）
        if !has_tool_calls && stop_reason == StopReason::ToolCall {
            events.push(ProviderStreamEvent::ProviderDiagnostic {
                diagnostic: ProviderDiagnostic {
                    phase: ProviderDiagnosticPhase::InvalidToolCall,
                    reason: Some(
                        "finish_reason=tool_calls but no tool_calls captured in any known location (delta.tool_calls, delta.function_call, choice.message.tool_calls, choice.tool_calls)"
                            .to_string(),
                    ),
                    partial: Some(serde_json::json!({ "pendingCount": flush.pending_len })),
                    ..ProviderDiagnostic::default()
                },
            });
        }

        // 唯一 stop（02 §2.2 步骤 6；usage 覆盖式携带）
        events.push(ProviderStreamEvent::Stop {
            reason: stop_reason,
            error: None,
            error_kind: None,
            usage: self.usage.clone(),
        });

        self.stream.check_events(&events)?;
        self.terminated = true;
        Ok(events)
    }
}

/// 提取非空思考文本，兼顾纯字符串与常见嵌套对象（{ "text": "..." } 等变体）
fn extract_thought_string(val: Option<&Value>) -> Option<&str> {
    let val = val?;
    if let Some(s) = val.as_str() {
        if !s.is_empty() {
            return Some(s);
        }
    } else if let Some(obj) = val.as_object() {
        for key in &["text", "content", "delta"] {
            if let Some(s) = obj.get(*key).and_then(Value::as_str) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}
