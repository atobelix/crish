//! responses.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经父模 `#[path]` 接线，非直接 mod）
//! 原 responses.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。
use super::*;
use serde_json::json;
use crate::events::{ProviderStreamEvent, StopReason};
use crate::sse::frame::SseFrame;
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
fn usage_receives_cache_hit_write_miss_aliases() {
    // responses 复用 chat 的 parse_usage（P2 步骤 1b）：hit/write/miss 链自动受益；
    // 顶层 hit 优先于 details（A1-04 hit 链顺序）
    let data = r#"{"type":"response.completed","response":{"status":"completed","usage":{
        "input_tokens": 100,
        "output_tokens": 20,
        "total_tokens": 120,
        "input_tokens_details": { "cached_tokens": 50, "cache_write_tokens": 10 },
        "prompt_cache_hit_tokens": 70,
        "prompt_cache_miss_tokens": 30
    }}}"#;
    let events = parse_all(vec![data]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop { usage: Some(usage), .. } => {
            assert_eq!(usage.cache_read_tokens, Some(70), "顶层 hit 优先于 details（A1-04）");
            assert_eq!(usage.cache_miss_tokens, Some(30), "顶层 miss 透传");
            assert_eq!(usage.cache_write_tokens, Some(10), "details.cache_write_tokens 别名");
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
