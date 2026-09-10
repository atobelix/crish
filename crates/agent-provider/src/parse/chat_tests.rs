//! chat.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经父模 `#[path]` 接线，非直接 mod）
//!
//! 原 chat.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。

use super::*;
use crate::events::{stream_error_kind, ProviderStreamEvent, StopReason};
use crate::sse::frame::SseFrame;
use conex_types::tool::ProviderDiagnosticPhase;
use serde_json::{json, Value};

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
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            error_kind: None,
            usage: None,
        }
    );
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

    let events = parse_all(vec![&delta_frame(
        json!({ "thinking_delta": "td1" }),
        Value::Null,
    )]);
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
    let events = parse_all(vec![&delta_frame(
        json!({ "content": "", "reasoning_content": "" }),
        Value::Null,
    )]);
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
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::ToolCall,
            error: None,
            error_kind: None,
            usage: None,
        }
    );
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
    assert_eq!(
        tool_calls[0],
        &ProviderStreamEvent::ToolCall {
            id: Some("call_0".into()),
            tool_name: "read_file".into(),
            input: json!({ "path": "/a" }),
        }
    );
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
    assert_eq!(
        tool_calls[0],
        &ProviderStreamEvent::ToolCall {
            id: Some("call_msg".into()),
            tool_name: "read_file".into(),
            input: json!({ "path": "/b" }),
        }
    );
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
    assert_eq!(
        tool_calls[0],
        &ProviderStreamEvent::ToolCall {
            id: Some("call_flat".into()),
            tool_name: "read_file".into(),
            input: json!({ "path": "/c" }),
        }
    );
}

#[test]
fn frame_without_choice_is_skipped_but_usage_still_applies() {
    // 仅无 choice 才跳过；usage 解析在 choice 判定之前（02 §2.2 步骤 2→3 顺序）
    let data = r#"{"id":"chatcmpl-2","usage":{"prompt_tokens":11,"total_tokens":22}}"#;
    let events = parse_all(vec![
        data,
        &delta_frame(json!({ "content": "正文" }), json!("stop")),
    ]);
    assert!(events.iter().any(|event| matches!(
        event,
        ProviderStreamEvent::TextDelta { text } if text == "正文"
    )));
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
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
            error_kind: None,
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
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
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
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
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
    assert_eq!(
        usage.cache_miss_tokens,
        Some(40),
        "顶层 miss 直接取服务端报告值"
    );
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
    assert_eq!(
        usage.cache_read_tokens,
        Some(55),
        "顶层 cached_tokens（Kimi）"
    );
    assert_eq!(
        usage.cache_write_tokens,
        Some(7),
        "顶层 cache_write_tokens 别名"
    );
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
    assert_eq!(
        usage.cache_read_tokens,
        Some(45),
        "details.cached_tokens 先于顶层 cached_tokens"
    );
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
        (
            json!({ "prompt_tokens_details": { "cache_creation_tokens": 6 } }),
            Some(6),
        ),
        (
            json!({ "prompt_tokens_details": { "cache_creation_input_tokens": 8 } }),
            Some(8),
        ),
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
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
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
            error_kind: Some(stream_error_kind("模型超载")),
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
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some(error),
                ..
            } => {
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
            error_kind: None,
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
            error_kind: None,
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
            error_kind: None,
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
                error_kind: None,
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
            error_kind: None,
            usage: None,
        }
    );
}

#[test]
fn ru09_diagnostic_when_finish_reason_tool_calls_but_zero_captured() {
    // RU-09：finish_reason=tool_calls 但零捕获 → 诊断（含 pendingCount）
    let events = parse_all(vec![&delta_frame(
        json!({ "content": "纯文字" }),
        json!("tool_calls"),
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
            assert_eq!(partial["pendingCount"], 0);
        }
        _ => unreachable!("已过滤"),
    }
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::ToolCall,
            error: None,
            error_kind: None,
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
            error_kind: None,
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

// ── TU-04 回归单测：5 级思考字段回退探测链与字段零丢失保证 ──

#[test]
fn thought_delta_five_stage_fallback_chain_complete() {
    // 优先级严格对齐：reasoning_content -> reasoning -> thinking -> thinking_delta -> thought
    // 1. 全部存在时，reasoning_content 胜出
    let events = parse_all(vec![&delta_frame(
        json!({
            "reasoning_content": "lvl1",
            "reasoning": "lvl2",
            "thinking": "lvl3",
            "thinking_delta": "lvl4",
            "thought": "lvl5"
        }),
        Value::Null,
    )]);
    assert_eq!(
        events[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "lvl1".into(),
            redacted: None,
        }
    );

    // 2. 缺 reasoning_content 时，reasoning 胜出
    let events = parse_all(vec![&delta_frame(
        json!({
            "reasoning": "lvl2",
            "thinking": "lvl3",
            "thinking_delta": "lvl4",
            "thought": "lvl5"
        }),
        Value::Null,
    )]);
    assert_eq!(
        events[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "lvl2".into(),
            redacted: None,
        }
    );

    // 3. 缺 reasoning_content 与 reasoning 时，thinking 胜出
    let events = parse_all(vec![&delta_frame(
        json!({
            "thinking": "lvl3",
            "thinking_delta": "lvl4",
            "thought": "lvl5"
        }),
        Value::Null,
    )]);
    assert_eq!(
        events[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "lvl3".into(),
            redacted: None,
        }
    );

    // 4. 缺前三级时，thinking_delta 胜出
    let events = parse_all(vec![&delta_frame(
        json!({
            "thinking_delta": "lvl4",
            "thought": "lvl5"
        }),
        Value::Null,
    )]);
    assert_eq!(
        events[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "lvl4".into(),
            redacted: None,
        }
    );

    // 5. 仅剩 thought 时，thought 胜出
    let events = parse_all(vec![&delta_frame(
        json!({
            "thought": "lvl5"
        }),
        Value::Null,
    )]);
    assert_eq!(
        events[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "lvl5".into(),
            redacted: None,
        }
    );
}

#[test]
fn thought_delta_each_field_individually_captured() {
    let fields = [
        ("reasoning_content", "think_rc"),
        ("reasoning", "think_r"),
        ("thinking", "think_t"),
        ("thinking_delta", "think_td"),
        ("thought", "think_th"),
    ];
    for (field, expected_val) in fields {
        let events = parse_all(vec![&delta_frame(
            json!({ field: expected_val }),
            Value::Null,
        )]);
        let thoughts: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            thoughts,
            vec![expected_val],
            "字段 {field} 必须被捕获为 ThoughtDelta"
        );
    }
}

#[test]
fn thought_delta_streaming_sequence_zero_loss() {
    // 连续推理增量帧序列：按序产出，零丢失
    let events = parse_all(vec![
        &delta_frame(json!({ "reasoning_content": "第一步：" }), Value::Null),
        &delta_frame(json!({ "reasoning_content": "分析问题；" }), Value::Null),
        &delta_frame(
            json!({ "reasoning_content": "第二步：得出结论。" }),
            Value::Null,
        ),
        &delta_frame(json!({ "content": "最终答案是42。" }), Value::Null),
        &delta_frame(json!({}), json!("stop")),
    ]);

    let thoughts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        thoughts,
        vec!["第一步：", "分析问题；", "第二步：得出结论。"]
    );

    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["最终答案是42。"]);

    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Stop,
            error: None,
            error_kind: None,
            usage: None,
        }
    );
}

#[test]
fn thought_delta_nested_object_variants_supported() {
    // 兼容嵌套对象思考方言：{ text: ... } / { content: ... } / { delta: ... }
    let events1 = parse_all(vec![&delta_frame(
        json!({ "thinking": { "text": "嵌套思考文本" } }),
        Value::Null,
    )]);
    assert_eq!(
        events1[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "嵌套思考文本".into(),
            redacted: None,
        }
    );

    let events2 = parse_all(vec![&delta_frame(
        json!({ "reasoning": { "content": "嵌套推理内容" } }),
        Value::Null,
    )]);
    assert_eq!(
        events2[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "嵌套推理内容".into(),
            redacted: None,
        }
    );

    let events3 = parse_all(vec![&delta_frame(
        json!({ "thought": { "delta": "嵌套思考增量" } }),
        Value::Null,
    )]);
    assert_eq!(
        events3[0],
        ProviderStreamEvent::ThoughtDelta {
            text: "嵌套思考增量".into(),
            redacted: None,
        }
    );
}

#[test]
fn thought_delta_in_message_when_delta_is_none() {
    // 非流式格式混入流式：无 delta，由 choice.message 携带思考与正文
    let data = serde_json::to_string(&json!({
        "choices": [{
            "index": 0,
            "message": {
                "reasoning_content": "先思考一下",
                "content": "回答内容",
            },
            "finish_reason": "stop",
        }],
    }))
    .expect("序列化");

    let events = parse_all(vec![&data]);
    let thoughts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::ThoughtDelta { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(thoughts, vec!["先思考一下"]);

    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["回答内容"]);
}

#[test]
fn thought_delta_empty_or_whitespace_only_ignored() {
    // 空思考字段不产生 ThoughtDelta 事件
    let events = parse_all(vec![&delta_frame(
        json!({
            "reasoning_content": "",
            "reasoning": "",
            "thinking": "",
            "thinking_delta": "",
            "thought": ""
        }),
        Value::Null,
    )]);
    let thoughts: Vec<&ProviderStreamEvent> = events
        .iter()
        .filter(|e| matches!(e, ProviderStreamEvent::ThoughtDelta { .. }))
        .collect();
    assert!(thoughts.is_empty(), "全空字段不得产出 ThoughtDelta");
}
