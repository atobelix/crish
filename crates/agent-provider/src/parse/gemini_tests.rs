//! parse/gemini.rs 测试旁挂 · 正常流/工具调用/finishReason 域（SR-06e · 拆分 · ≠ EL；
//! 经 #[path] 接线，非直接 mod）
//!
//! 原 gemini.rs `mod tests` 拆分搬入，零删除零合并；测试名与断言形状不变。
//! usage/阻断/空流/错误帧域见 gemini_tests_usage.rs。共享便捷函数
//! （parse_all / stop_of）在此定义（pub(super)），供 [super::tests_usage] 复用。

use super::*;
use conex_types::error::ProviderErrorKind;
use serde_json::json;

/// 便捷构造：处理一帧并立即 finish，返回全部事件
pub(super) fn parse_all(frames: Vec<&str>) -> Vec<ProviderStreamEvent> {
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

pub(super) fn stop_of(events: &[ProviderStreamEvent]) -> &ProviderStreamEvent {
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
            error_kind: None,
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
            error_kind: None,
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
            error_kind: None,
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
fn function_call_alternate_id_fields_call_id_and_call_id_camel() {
    let events = parse_all(vec![
        &part_frame(
            json!({ "functionCall": { "call_id": "call_snake_1", "name": "read_file", "args": {} } }),
            Value::Null,
        ),
        &part_frame(
            json!({ "functionCall": { "callId": "call_camel_2", "name": "write_file", "args": {} } }),
            Value::Null,
        ),
    ]);
    let ids: Vec<Option<&str>> = events
        .iter()
        .filter_map(|event| match event {
            ProviderStreamEvent::ToolCall { id, .. } => Some(id.as_deref()),
            _ => None,
        })
        .collect();
    assert_eq!(ids, vec![Some("call_snake_1"), Some("call_camel_2")]);
}

#[test]
fn single_frame_array_of_candidate_objects_parsed() {
    let array_payload = serde_json::to_string(&json!([
        {
            "candidates": [{
                "content": { "parts": [{ "text": "第一段 " }] },
            }]
        },
        {
            "candidates": [{
                "content": { "parts": [{ "text": "第二段" }] },
                "finishReason": "STOP",
            }]
        }
    ])).expect("序列化");

    let events = parse_all(vec![&array_payload]);
    let texts: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["第一段 ", "第二段"]);
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
fn function_call_ids_increment_without_explicit_id() {
    let events = parse_all(vec![
        &part_frame(
            json!({ "functionCall": { "name": "a", "args": {} } }),
            Value::Null,
        ),
        &part_frame(
            json!({ "functionCall": { "name": "b", "args": {} } }),
            Value::Null,
        ),
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
    assert_eq!(
        inputs[0],
        json!({ "value": [1, 2] }),
        "非对象参数包裹 {{value}}"
    );
    assert_eq!(inputs[1], json!({}), "args 缺失 → {{}}");
}

// ── finishReason 映射表（02 §三.2，逐项）──

#[test]
fn finish_reason_mapping_table() {
    let cases = [
        (Some("STOP"), None, StopReason::Stop),
        (Some("END_TURN"), None, StopReason::Stop),
        (Some("MAX_TOKENS"), None, StopReason::Length),
        (
            Some("SAFETY"),
            Some("Gemini finishReason: SAFETY"),
            StopReason::Error,
        ),
        (
            Some("RECITATION"),
            Some("Gemini finishReason: RECITATION"),
            StopReason::Error,
        ),
        (
            Some("BLOCKLIST"),
            Some("Gemini finishReason: BLOCKLIST"),
            StopReason::Error,
        ),
        (
            Some("PROHIBITED_CONTENT"),
            Some("Gemini finishReason: PROHIBITED_CONTENT"),
            StopReason::Error,
        ),
        (
            Some("SPII"),
            Some("Gemini finishReason: SPII"),
            StopReason::Error,
        ),
        (
            Some("IMAGE_SAFETY"),
            Some("Gemini finishReason: IMAGE_SAFETY"),
            StopReason::Error,
        ),
        (
            Some("MALFORMED_FUNCTION_CALL"),
            Some("Gemini finishReason: MALFORMED_FUNCTION_CALL"),
            StopReason::Error,
        ),
        (
            Some("OTHER"),
            Some("Gemini finishReason: OTHER"),
            StopReason::Error,
        ),
        (Some("SOMETHING_NEW"), None, StopReason::Stop),
        (None, None, StopReason::Stop),
        (Some(""), None, StopReason::Stop),
        (Some("FINISH_REASON_UNSPECIFIED"), None, StopReason::Stop),
    ];
    for (reason, expected_error, expected) in cases {
        let mapped = gemini_finish_reason_to_stop(reason, false);
        assert_eq!(mapped.0, expected, "finishReason={reason:?} 映射错误");
        assert_eq!(
            mapped.1.as_deref(),
            expected_error,
            "finishReason={reason:?} 文案错误"
        );
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
            error_kind: None,
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
            error_kind: Some(ProviderErrorKind::Unknown),
            usage: None,
        }
    );
}
