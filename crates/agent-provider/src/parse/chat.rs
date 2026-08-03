//! chat-completions 流解析器（任务书 B2.5；02-provider-semantics.md §二.2-2.3、§六.3-5）
//!
//! 帧处理顺序（02 §2.2，不可变，§六.3）：
//! 1. 错误帧（error / message / error_description / code）→ 立即 `stop{reason:'error'}` 终止
//! 2. usage 覆盖式解析（任何帧都可能携带；仅接受有限数值，§2.5）
//! 3. `choices[0].delta`：content → text-delta；reasoning_content → thinking → thinking_delta
//!    优先级 → thought-delta（02 §1.4）；tool_calls → 合并进 pending
//! 4. 兼容位置全探测（§五 #7/#8）：delta.tool_calls / delta.function_call /
//!    choice.message.tool_calls / choice.tool_calls / 平铺字段
//! 5. finish_reason → 覆盖式映射（§2.2 末表格）
//!
//! 仅当无 `choice` 时跳过整帧（delta 缺失不得连带跳过 finish_reason，§五 #7）。
//! 流结束（[ChatCompletionsParser::finish]）：flush pending（RU-06 缺 name 诊断）→
//! RU-08 强制 tool-call → RU-09 零捕获诊断 → 唯一 stop（02 §五 #4/#5/#6）。
//!
//! 产出事件全部经 [StreamParser]（events.rs B2.4）校验，保证每流恰好一个 stop。

use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};
use serde_json::{Map, Value};

use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason, StreamParseError, StreamParser};
use crate::sse::frame::SseFrame;

use super::tool_call::{parse_full_tool_call, ToolCallCollector};

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
        let mut events = Vec::new();

        // 1. 错误帧 → 立即终止（02 §2.2 步骤 2）
        if let Some(error) = provider_body_error(&payload) {
            events.push(ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                usage: None,
            });
            self.stream.extend(events.clone())?;
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
            if let Some(text) = non_empty_string(delta.get("content")) {
                events.push(ProviderStreamEvent::TextDelta {
                    text: text.to_owned(),
                });
            }
            // thought 优先级：reasoning_content → thinking → thinking_delta（02 §1.4）
            if let Some(thought) = non_empty_string(delta.get("reasoning_content"))
                .or_else(|| non_empty_string(delta.get("thinking")))
                .or_else(|| non_empty_string(delta.get("thinking_delta")))
            {
                events.push(ProviderStreamEvent::ThoughtDelta {
                    text: thought.to_owned(),
                    redacted: None,
                });
            }
            // 标准位置：delta.tool_calls[]（增量合并进 pending）
            if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for raw in tool_calls {
                    self.collector.merge(raw);
                }
            }
            // legacy 兼容：delta.function_call（单对象，OpenAI 旧版格式）
            if let Some(function_call) = delta.get("function_call").filter(|value| value.is_object()) {
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
            // 无 delta 时 message.content 兜底正文（对齐 runtime:provider-openai-chat.ts:128-130）
            if delta.is_none() {
                if let Some(text) = non_empty_string(message.get("content")) {
                    events.push(ProviderStreamEvent::TextDelta {
                        text: text.to_owned(),
                    });
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

        self.stream.extend(events.clone())?;
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
            usage: self.usage.clone(),
        });

        self.stream.extend(events.clone())?;
        self.terminated = true;
        Ok(events)
    }
}

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
    let completion_details =
        nested_details(usage, &["completion_tokens_details", "output_tokens_details"]);
    // hit 链：顶层 prompt_cache_hit_tokens（DeepSeek）→ details.cached_tokens →
    // 顶层 cached_tokens（Kimi），顺序与 P6 R4 一致（A1-04：顶层 hit 优先）
    let cache_read_tokens = finite_u64(usage.get("prompt_cache_hit_tokens"))
        .or_else(|| prompt_details.and_then(|details| finite_u64(details.get("cached_tokens"))))
        .or_else(|| finite_u64(usage.get("cached_tokens")));
    // write 链：details 三别名 → 顶层 cache_write_tokens → 顶层 cache_creation_tokens
    let cache_write_tokens = details_alias(
        prompt_details,
        &["cache_write_tokens", "cache_creation_tokens", "cache_creation_input_tokens"],
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
fn provider_body_error(payload: &Value) -> Option<String> {
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
        let mut parser = ChatCompletionsParser::new();
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

    fn delta_frame(delta: Value, finish_reason: Value) -> String {
        serde_json::to_string(&json!({
            "id": "chatcmpl-1",
            "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }],
        }))
        .expect("序列化")
    }

    fn stop_of(events: &[ProviderStreamEvent]) -> &ProviderStreamEvent {
        events
            .iter()
            .find(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
            .expect("流内应有 stop")
    }

    // ── 帧处理顺序与 delta 内容 ──

    #[test]
    fn text_delta_from_content() {
        let events = parse_all(vec![
            &delta_frame(json!({ "content": "你好" }), Value::Null),
            &delta_frame(json!({ "content": "，世界" }), Value::Null),
            &delta_frame(json!({}), json!("stop")),
        ]);
        let texts: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["你好", "，世界"]);
        assert_eq!(stop_of(&events), &ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            usage: None,
        });
    }

    #[test]
    fn thought_delta_priority_reasoning_content_thinking_thinking_delta() {
        // 优先级：reasoning_content → thinking → thinking_delta（02 §1.4）
        let events = parse_all(vec![&delta_frame(
            json!({ "reasoning_content": "r1", "thinking": "t1" }),
            Value::Null,
        )]);
        assert_eq!(
            events[0],
            ProviderStreamEvent::ThoughtDelta {
                text: "r1".into(),
                redacted: None,
            }
        );

        let events = parse_all(vec![&delta_frame(json!({ "thinking": "t1" }), Value::Null)]);
        assert_eq!(
            events[0],
            ProviderStreamEvent::ThoughtDelta {
                text: "t1".into(),
                redacted: None,
            }
        );

        let events = parse_all(vec![&delta_frame(json!({ "thinking_delta": "td1" }), Value::Null)]);
        assert_eq!(
            events[0],
            ProviderStreamEvent::ThoughtDelta {
                text: "td1".into(),
                redacted: None,
            }
        );
    }

    #[test]
    fn empty_content_and_thought_are_ignored() {
        // 空串内容不产出事件（对齐 TS `length > 0` 判定）
        let events = parse_all(vec![&delta_frame(json!({ "content": "", "reasoning_content": "" }), Value::Null)]);
        assert_eq!(events.len(), 1, "仅剩 stop");
        assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
    }

    #[test]
    fn tool_calls_in_delta_are_collected_and_flushed() {
        let events = parse_all(vec![
            &delta_frame(
                json!({ "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "read_file", "arguments": r#"{"path":"/a"}"# } }] }),
                Value::Null,
            ),
            &delta_frame(json!({}), json!("tool_calls")),
        ]);
        let tool_calls: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ToolCall { .. }))
            .collect();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(
            *tool_calls[0],
            ProviderStreamEvent::ToolCall {
                id: Some("call_1".into()),
                tool_name: "read_file".into(),
                input: json!({ "path": "/a" }),
            }
        );
        assert_eq!(stop_of(&events), &ProviderStreamEvent::Stop {
            reason: StopReason::ToolCall,
            error: None,
            usage: None,
        });
    }

    #[test]
    fn legacy_function_call_in_delta_is_collected() {
        // 兼容位置一：delta.function_call（legacy 单对象格式）
        let events = parse_all(vec![
            &delta_frame(
                json!({ "function_call": { "name": "read_file", "arguments": r#"{"path":"/a"}"# } }),
                Value::Null,
            ),
            &delta_frame(json!({}), json!("function_call")),
        ]);
        let tool_calls: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ToolCall { .. }))
            .collect();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0], &ProviderStreamEvent::ToolCall {
            id: Some("call_0".into()),
            tool_name: "read_file".into(),
            input: json!({ "path": "/a" }),
        });
    }

    #[test]
    fn tool_calls_in_choice_message_emit_immediately() {
        // 兼容位置二：choice.message.tool_calls（非流式格式混入流式，完整调用立即产出）
        let data = serde_json::to_string(&json!({
            "choices": [{
                "index": 0,
                "message": {
                    "content": "附带正文",
                    "tool_calls": [{
                        "id": "call_msg",
                        "type": "function",
                        "function": { "name": "read_file", "arguments": r#"{"path":"/b"}"# },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
        }))
        .expect("序列化");
        let events = parse_all(vec![&data]);
        let tool_calls: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ToolCall { .. }))
            .collect();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0], &ProviderStreamEvent::ToolCall {
            id: Some("call_msg".into()),
            tool_name: "read_file".into(),
            input: json!({ "path": "/b" }),
        });
        // 无 delta 时 message.content 兜底为正文
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderStreamEvent::TextDelta { text } if text == "附带正文"
        )));
    }

    #[test]
    fn tool_calls_on_choice_top_level_are_collected() {
        // 兼容位置三：choice.tool_calls（直接挂在 choice 上的平铺实现）
        let data = serde_json::to_string(&json!({
            "choices": [{
                "index": 0,
                "tool_calls": [{
                    "index": 0,
                    "id": "call_flat",
                    "function_name": "read_file",
                    "arguments": r#"{"path":"/c"}"#,
                }],
                "finish_reason": "tool_calls",
            }],
        }))
        .expect("序列化");
        let events = parse_all(vec![&data]);
        let tool_calls: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ToolCall { .. }))
            .collect();
        assert_eq!(tool_calls.len(), 1);
        assert_eq!(tool_calls[0], &ProviderStreamEvent::ToolCall {
            id: Some("call_flat".into()),
            tool_name: "read_file".into(),
            input: json!({ "path": "/c" }),
        });
    }

    #[test]
    fn frame_without_choice_is_skipped_but_usage_still_applies() {
        // 仅无 choice 才跳过；usage 解析在 choice 判定之前（02 §2.2 步骤 2→3 顺序）
        let data = r#"{"id":"chatcmpl-2","usage":{"prompt_tokens":11,"total_tokens":22}}"#;
        let events = parse_all(vec![data, &delta_frame(json!({ "content": "正文" }), json!("stop"))]);
        assert!(events.iter().any(|event| matches!(
            event,
            ProviderStreamEvent::TextDelta { text } if text == "正文"
        )));
        match stop_of(&events) {
            ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
                assert_eq!(usage.prompt_tokens, Some(11));
                assert_eq!(usage.total_tokens, Some(22));
            }
            other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
        }
    }

    #[test]
    fn frame_without_choice_and_no_delta_still_reads_finish_reason() {
        // 02 §五 #7：delta 缺失不得连带跳过 finish_reason（部分兼容实现最后一帧只有 finish_reason）
        let data = r#"{"choices":[{"index":0,"finish_reason":"length"}]}"#;
        let events = parse_all(vec![data]);
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
    fn multiple_choices_only_first_is_processed() {
        // 多 choice 取首个（02 §2.2 步骤 4：choices[0]）
        let data = serde_json::to_string(&json!({
            "choices": [
                { "index": 0, "delta": { "content": "首个" }, "finish_reason": "stop" },
                { "index": 1, "delta": { "content": "第二个（应被忽略）" }, "finish_reason": "stop" },
            ],
        }))
        .expect("序列化");
        let events = parse_all(vec![&data]);
        let texts: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["首个"]);
    }

    #[test]
    fn usage_override_later_frame_wins() {
        let usage1 = r#"{"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}"#;
        let usage2 = r#"{"choices":[{"index":0,"delta":{"content":"y"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}"#;
        let events = parse_all(vec![usage1, usage2]);
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
    fn usage_accepts_alternate_fields_and_details() {
        // input_tokens/output_tokens 变体 + cached_tokens/reasoning_tokens 细节（02 §2.5）
        let data = r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{
            "input_tokens": 5,
            "output_tokens": 7,
            "total_tokens": 12,
            "input_tokens_details": { "cached_tokens": 3 },
            "output_tokens_details": { "reasoning_tokens": 4 }
        }}"#;
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
    fn parse_usage_deepseek_top_level_hit_miss_shape() {
        // DeepSeek 顶层形状（P2 §5.1）：prompt_cache_hit_tokens / prompt_cache_miss_tokens；
        // 顶层 hit 优先于 details.cached_tokens（A1-04 hit 链顺序）
        let usage = parse_usage(Some(&json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
            "prompt_tokens_details": { "cached_tokens": 30 },
            "prompt_cache_hit_tokens": 60,
            "prompt_cache_miss_tokens": 40,
        })))
        .expect("解析成功");
        assert_eq!(usage.cache_read_tokens, Some(60), "顶层 hit 优先（A1-04）");
        assert_eq!(usage.cache_miss_tokens, Some(40), "顶层 miss 直接取服务端报告值");
    }

    #[test]
    fn parse_usage_kimi_top_level_cached_tokens_shape() {
        // Kimi 顶层形状（P2 §5.1）：usage.cached_tokens（00-catalog 第 5.2 节）
        let usage = parse_usage(Some(&json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
            "cached_tokens": 55,
            "cache_write_tokens": 7,
        })))
        .expect("解析成功");
        assert_eq!(usage.cache_read_tokens, Some(55), "顶层 cached_tokens（Kimi）");
        assert_eq!(usage.cache_write_tokens, Some(7), "顶层 cache_write_tokens 别名");
    }

    #[test]
    fn parse_usage_openai_details_shape_with_write_aliases() {
        // OpenAI details 形状（P2 §5.1）：details.cached_tokens + details 三 write 别名；
        // details 优先于顶层 cached_tokens 与顶层 write 别名（hit/write 链顺序）
        let usage = parse_usage(Some(&json!({
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "total_tokens": 120,
            "cached_tokens": 99,
            "cache_write_tokens": 12,
            "cache_creation_tokens": 98,
            "prompt_tokens_details": {
                "cached_tokens": 45,
                "cache_write_tokens": 9,
                "cache_creation_input_tokens": 3,
            },
        })))
        .expect("解析成功");
        assert_eq!(usage.cache_read_tokens, Some(45), "details.cached_tokens 先于顶层 cached_tokens");
        assert_eq!(
            usage.cache_write_tokens,
            Some(9),
            "details.cache_write_tokens 先于顶层 write 别名（write 链序）"
        );
    }

    #[test]
    fn parse_usage_write_alias_fallback_chain() {
        // write 链回退顺序（P2 §3.3 D）：details.cache_creation_tokens →
        // details.cache_creation_input_tokens（百炼）→ 顶层 cache_creation_tokens
        let cases = [
            (json!({ "prompt_tokens_details": { "cache_creation_tokens": 6 } }), Some(6)),
            (json!({ "prompt_tokens_details": { "cache_creation_input_tokens": 8 } }), Some(8)),
            (json!({ "cache_creation_tokens": 10 }), Some(10)),
            (json!({ "prompt_tokens": 5 }), None),
        ];
        for (usage, expected) in cases {
            let parsed = parse_usage(Some(&usage)).expect("解析成功");
            assert_eq!(parsed.cache_write_tokens, expected, "usage={usage}");
        }
    }

    #[test]
    fn usage_rejects_non_finite_values() {
        // 仅接受有限数值（02 §2.5:319-323）
        let data = r#"{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":"1e3","completion_tokens":null,"total_tokens":3}}"#;
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

    // ── 错误帧 ──

    #[test]
    fn error_frame_terminates_immediately_with_stop_error() {
        let data = r#"{"error":{"message":"模型超载"}}"#;
        let events = parse_all(vec![data]);
        assert_eq!(
            stop_of(&events),
            &ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("模型超载".into()),
                usage: None,
            }
        );
        assert_eq!(events.len(), 1, "错误帧后不得再产出任何事件");
    }

    #[test]
    fn error_frame_variants_error_message_error_description_code() {
        // 优先级：error.message → error → message → error_description → code
        let cases = [
            (r#"{"error":{"message":"m1"}}"#, "m1"),
            (r#"{"error":"m2"}"#, "m2"),
            (r#"{"message":"m3"}"#, "m3"),
            (r#"{"error_description":"m4"}"#, "m4"),
            (r#"{"code":"m5"}"#, "m5"),
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
        let mut parser = ChatCompletionsParser::new();
        let error_frame = SseFrame {
            event: None,
            data: Some(r#"{"error":{"message":"boom"}}"#.to_string()),
            id: None,
            retry: None,
        };
        parser.push_frame(&error_frame).expect("错误帧处理");
        assert!(parser.is_terminated());
        let after = SseFrame {
            event: None,
            data: Some(r#"{"choices":[{"index":0,"delta":{"content":"x"}}]}"#.to_string()),
            id: None,
            retry: None,
        };
        assert!(
            parser.push_frame(&after).expect("已终结帧处理").is_empty(),
            "错误帧后 push 应空产出"
        );
        assert!(
            parser.finish().expect("已终结 finish").is_empty(),
            "错误帧后 finish 不得再产出 stop"
        );
    }

    // ── finishReason 映射表（02 §2.2 末表格逐行）──

    #[test]
    fn finish_reason_mapping_table() {
        let cases = [
            (Some("tool_calls"), StopReason::ToolCall),
            (Some("function_call"), StopReason::ToolCall),
            (Some("length"), StopReason::Length),
            (Some("stop"), StopReason::Stop),
            (None, StopReason::Stop),
            (Some("content_filter"), StopReason::Error),
            (Some("safety"), StopReason::Error),
            (Some("unknown_reason"), StopReason::Error),
            (Some(""), StopReason::Error),
        ];
        for (reason, expected) in cases {
            assert_eq!(
                finish_reason_to_stop(reason),
                expected,
                "finish_reason={reason:?} 映射错误"
            );
        }
    }

    #[test]
    fn finish_reason_null_keeps_previous_value() {
        // null/缺失不覆盖（02 §2.2 步骤 5）
        let events = parse_all(vec![
            &delta_frame(json!({ "content": "a" }), json!("length")),
            &delta_frame(json!({ "content": "b" }), Value::Null),
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

    // ── RU-06/08/09（02 §五 #4/#5/#6）──

    #[test]
    fn ru06_missing_name_reports_diagnostic_at_flush() {
        // RU-06：缺 name 上报 invalid-tool-call 诊断，不静默丢弃
        let events = parse_all(vec![&delta_frame(
            json!({ "tool_calls": [{ "index": 0, "id": "call_x", "function": { "arguments": "{}" } }] }),
            json!("stop"),
        )]);
        let diagnostics: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ProviderDiagnostic { .. }))
            .collect();
        assert_eq!(diagnostics.len(), 1);
        match diagnostics[0] {
            ProviderStreamEvent::ProviderDiagnostic { diagnostic } => {
                assert_eq!(diagnostic.phase, ProviderDiagnosticPhase::InvalidToolCall);
                let partial = diagnostic.partial.as_ref().expect("携带 partial");
                assert_eq!(partial["id"], "call_x");
            }
            _ => unreachable!("已过滤"),
        }
        // 无具名调用 → 不强制 tool-call；finish_reason=stop 保持
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
    fn ru08_forces_tool_call_when_finish_reason_missing() {
        // RU-08：有工具调用但 finish_reason 缺失 → 强制 tool-call
        let events = parse_all(vec![&delta_frame(
            json!({ "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "read_file", "arguments": "{}" } }] }),
            Value::Null,
        )]);
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
    fn ru08_forces_tool_call_when_finish_reason_is_stop_or_length() {
        // RU-08：finish_reason 非 tool-call/error 一律强制（含 stop 与 length）
        for finish in [json!("stop"), json!("length")] {
            let frame = delta_frame(
                json!({ "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "read_file", "arguments": "{}" } }] }),
                finish.clone(),
            );
            let events = parse_all(vec![&frame]);
            assert_eq!(
                stop_of(&events),
                &ProviderStreamEvent::Stop {
                    reason: StopReason::ToolCall,
                    error: None,
                    usage: None,
                },
                "finish_reason={finish} 时应强制 tool-call",
            );
        }
    }

    #[test]
    fn ru08_keeps_error_reason_when_tool_calls_present() {
        // finish_reason 未知值映射为 error 时不得被 RU-08 覆盖（对齐 TS 判定）
        let events = parse_all(vec![&delta_frame(
            json!({ "tool_calls": [{ "index": 0, "id": "c1", "function": { "name": "read_file", "arguments": "{}" } }] }),
            json!("content_filter"),
        )]);
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
    fn ru09_diagnostic_when_finish_reason_tool_calls_but_zero_captured() {
        // RU-09：finish_reason=tool_calls 但零捕获 → 诊断（含 pendingCount）
        let events = parse_all(vec![&delta_frame(json!({ "content": "纯文字" }), json!("tool_calls"))]);
        let diagnostics: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ProviderDiagnostic { .. }))
            .collect();
        assert_eq!(diagnostics.len(), 1);
        match diagnostics[0] {
            ProviderStreamEvent::ProviderDiagnostic { diagnostic } => {
                assert_eq!(diagnostic.phase, ProviderDiagnosticPhase::InvalidToolCall);
                let partial = diagnostic.partial.as_ref().expect("携带 partial");
                assert_eq!(partial["pendingCount"], 0);
            }
            _ => unreachable!("已过滤"),
        }
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
    fn ru09_zero_pending_count_is_reported() {
        // 有 pending 但全部缺 name 时 pendingCount 应如实上报
        let events = parse_all(vec![&delta_frame(
            json!({ "tool_calls": [{ "index": 0, "id": "c0", "function": { "arguments": "{}" } }] }),
            json!("tool_calls"),
        )]);
        let diagnostics: Vec<&ProviderStreamEvent> = events
            .iter()
            .filter(|event| matches!(event, ProviderStreamEvent::ProviderDiagnostic { .. }))
            .collect();
        assert_eq!(diagnostics.len(), 2, "RU-06 与 RU-09 各一条");
        let ru09 = diagnostics
            .iter()
            .find_map(|event| match event {
                ProviderStreamEvent::ProviderDiagnostic { diagnostic }
                    if diagnostic
                        .reason
                        .as_deref()
                        .is_some_and(|r| r.starts_with("finish_reason=tool_calls")) =>
                {
                    Some(diagnostic)
                }
                _ => None,
            })
            .expect("存在 RU-09 诊断");
        let partial = ru09.partial.as_ref().expect("携带 partial");
        assert_eq!(partial["pendingCount"], 1);
    }

    // ── 空流与收尾 ──

    #[test]
    fn empty_stream_produces_only_stop() {
        let events = parse_all(vec![]);
        assert_eq!(
            events,
            vec![ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                usage: None,
            }]
        );
    }

    #[test]
    fn non_json_and_done_frames_are_skipped_defensively() {
        let mut parser = ChatCompletionsParser::new();
        for data in ["[DONE]", "ping", "42"] {
            let frame = SseFrame {
                event: None,
                data: Some(data.to_string()),
                id: None,
                retry: None,
            };
            assert!(
                parser.push_frame(&frame).expect("防御性跳过").is_empty(),
                "非 JSON 对象帧应跳过：{data}"
            );
        }
        let events = parser.finish().expect("流结束");
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], ProviderStreamEvent::Stop { .. }));
    }

    #[test]
    fn finish_is_idempotent() {
        let mut parser = ChatCompletionsParser::new();
        let first = parser.finish().expect("首次 finish");
        assert_eq!(first.len(), 1);
        assert!(
            parser.finish().expect("二次 finish").is_empty(),
            "重复 finish 不得再产出 stop"
        );
    }

    #[test]
    fn parse_usage_non_object_returns_none() {
        assert!(parse_usage(None).is_none());
        assert!(parse_usage(Some(&Value::Null)).is_none());
        assert!(parse_usage(Some(&json!("usage"))).is_none());
        assert!(parse_usage(Some(&json!([1, 2]))).is_none());
        assert!(parse_usage(Some(&json!({ "total_tokens": 1 }))).is_some());
    }
}
