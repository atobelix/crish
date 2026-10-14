//! parse/anthropic.rs 测试旁挂 · 正常流/thinking/工具调用/stop_reason 域
//! （SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 anthropic.rs `mod tests` 拆分搬入，零删除零合并；测试名与断言形状不变。
//! usage/空流保护/错误帧域见 anthropic_tests_usage.rs。共享便捷函数
//! （parse_all / event_frame / stop_of）在此定义（pub(super)），供
//! [super::tests_usage] 复用。

use super::*;
use serde_json::json;

/// 便捷构造：处理一帧并立即 finish，返回全部事件
pub(super) fn parse_all(frames: Vec<&str>) -> Vec<ProviderStreamEvent> {
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

pub(super) fn event_frame(event_type: &str, extra: Value) -> String {
    let mut object = Map::new();
    object.insert("type".to_string(), Value::String(event_type.to_string()));
    if let Value::Object(extra) = extra {
        for (key, value) in extra {
            object.insert(key, value);
        }
    }
    serde_json::to_string(&Value::Object(object)).expect("序列化")
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

/// 典型正常流：message_start → text 块 delta → message_delta → message_stop
fn normal_text_stream() -> Vec<String> {
    vec![
        event_frame(
            "message_start",
            json!({
                "message": { "usage": { "input_tokens": 11 } },
            }),
        ),
        event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "text" },
            }),
        ),
        event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "你好" },
            }),
        ),
        event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "，世界" },
            }),
        ),
        event_frame(
            "message_delta",
            json!({
                "delta": { "stop_reason": "end_turn" },
                "usage": { "output_tokens": 7 },
            }),
        ),
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
            error_kind: None,
            usage: Some(ProviderUsage {
                prompt_tokens: Some(11),
                completion_tokens: Some(7),
                total_tokens: Some(18),
                cache_read_tokens: None,
                cache_write_tokens: None,
                cache_miss_tokens: None,
                reasoning_tokens: None,
            }),
        }
    );
}

#[test]
fn thinking_delta_yields_thought_without_redacted() {
    // thinking_delta → thought-delta，不标 redacted（02 §1.4）
    let events = parse_all(vec![
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "thinking" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "让我想想" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "再想想" },
            }),
        ),
        &event_frame(
            "message_delta",
            json!({ "delta": { "stop_reason": "end_turn" } }),
        ),
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
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "thinking": "兼容字段" },
            }),
        ),
        &event_frame("message_stop", json!({})),
    ]);
    assert!(events.iter().any(|event| matches!(
        event,
        ProviderStreamEvent::ThoughtDelta { text, .. } if text == "兼容字段"
    )));
}

#[test]
fn redacted_thinking_start_yields_thought_with_redacted_true() {
    let events = parse_all(vec![
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": {
                    "type": "redacted_thinking",
                    "data": "encrypted_blob_data"
                },
            }),
        ),
        &event_frame("message_stop", json!({})),
    ]);
    let thoughts: Vec<&ProviderStreamEvent> = events
        .iter()
        .filter(|event| matches!(event, ProviderStreamEvent::ThoughtDelta { .. }))
        .collect();
    assert_eq!(thoughts.len(), 1);
    match thoughts[0] {
        ProviderStreamEvent::ThoughtDelta { text, redacted } => {
            assert_eq!(text, "encrypted_blob_data");
            assert_eq!(redacted, &Some(true), "redacted_thinking 必须带有 redacted=true 标识");
        }
        _ => unreachable!(),
    }
}

#[test]
fn signature_delta_is_captured_in_parser() {
    let mut parser = AnthropicParser::new();
    let f1 = SseFrame {
        event: None,
        data: Some(event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "thinking" },
            }),
        )),
        id: None,
        retry: None,
    };
    let f2 = SseFrame {
        event: None,
        data: Some(event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "thinking_delta", "thinking": "thinking text" },
            }),
        )),
        id: None,
        retry: None,
    };
    let f3 = SseFrame {
        event: None,
        data: Some(event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "signature_delta", "signature": "sig_xyz_987" },
            }),
        )),
        id: None,
        retry: None,
    };
    let f4 = SseFrame {
        event: None,
        data: Some(event_frame("message_stop", json!({}))),
        id: None,
        retry: None,
    };

    parser.push_frame(&f1).unwrap();
    parser.push_frame(&f2).unwrap();
    parser.push_frame(&f3).unwrap();
    parser.push_frame(&f4).unwrap();
    parser.finish().unwrap();

    assert_eq!(parser.last_thinking_signature(), Some("sig_xyz_987"));
    assert_eq!(parser.thinking_signatures().get(&0).map(String::as_str), Some("sig_xyz_987"));
}

#[test]
fn empty_text_delta_is_ignored() {
    let events = parse_all(vec![
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "" },
            }),
        ),
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
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": r#"{"path":"/a""# },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": r#","mode":"r"}"# },
            }),
        ),
        &event_frame("content_block_stop", json!({ "index": 0 })),
        &event_frame(
            "message_delta",
            json!({ "delta": { "stop_reason": "tool_use" } }),
        ),
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
            error_kind: None,
            usage: None,
        }
    );
}

#[test]
fn tool_use_half_json_chunk_fails_gracefully_with_raw_fallback() {
    // 半 JSON 分片拼接后仍无法解析 → `__rawArguments` 兜底（对齐 parseArguments 335-349）
    let events = parse_all(vec![
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_9", "name": "read_file" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"未闭合" },
            }),
        ),
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
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{}" },
            }),
        ),
        &event_frame("content_block_stop", json!({ "index": 0 })),
        &event_frame("message_stop", json!({})),
    ]);
    assert!(tool_calls_of(&events).is_empty());
}

#[test]
fn missing_tool_use_id_falls_back_to_toolu_index() {
    let events = parse_all(vec![
        &event_frame(
            "content_block_start",
            json!({
                "index": 3,
                "content_block": { "type": "tool_use", "name": "read_file" },
            }),
        ),
        &event_frame("content_block_stop", json!({ "index": 3 })),
        &event_frame("message_stop", json!({})),
    ]);
    let tool_calls = tool_calls_of(&events);
    assert_eq!(tool_calls.len(), 1);
    match tool_calls[0] {
        ProviderStreamEvent::ToolCall { id, .. } => {
            assert_eq!(
                id.as_deref(),
                Some("toolu_3"),
                "id 缺失兜底 toolu_{{index}}"
            );
        }
        _ => unreachable!("已过滤"),
    }
}

#[test]
fn unfinished_tool_use_is_flushed_defensively() {
    // 流结束未见 content_block_stop → 防御性 flush（185-196）
    let events = parse_all(vec![
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "read_file" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": r#"{"path":"/a"}"# },
            }),
        ),
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
        &event_frame(
            "content_block_start",
            json!({
                "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_b", "name": "second" },
            }),
        ),
        &event_frame(
            "content_block_start",
            json!({
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_a", "name": "first" },
            }),
        ),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{}" },
            }),
        ),
        &event_frame("content_block_stop", json!({ "index": 0 })),
        &event_frame(
            "content_block_delta",
            json!({
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{}" },
            }),
        ),
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
        &event_frame(
            "content_block_delta",
            json!({
                "index": 0,
                "delta": { "type": "text_delta", "text": "截断前的正文" },
            }),
        ),
        &event_frame(
            "message_delta",
            json!({ "delta": { "stop_reason": "max_tokens" } }),
        ),
        &event_frame("message_stop", json!({})),
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

#[test]
fn refusal_stop_reason_yields_error() {
    let events = parse_all(vec![
        &event_frame(
            "message_delta",
            json!({ "delta": { "stop_reason": "refusal" } }),
        ),
        &event_frame("message_stop", json!({})),
    ]);
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
fn stop_reason_later_frame_overrides() {
    // message_delta 覆盖式：后到的 stop_reason 覆盖先前（163-168）
    let events = parse_all(vec![
        &event_frame(
            "message_delta",
            json!({ "delta": { "stop_reason": "end_turn" } }),
        ),
        &event_frame(
            "message_delta",
            json!({ "delta": { "stop_reason": "max_tokens" } }),
        ),
        &event_frame("message_stop", json!({})),
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
