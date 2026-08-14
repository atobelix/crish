//! azure_responses.rs 测试旁挂（T5.1 G7-b；经父模 `#[path]` 接线，非直接 mod）
//! 对齐 responses_tests.rs 形态：mock 帧 → push_frame → finish → 断言事件序列 /
//! 错误映射 / usage 归一。聚焦 azure 差异契约（见 azure_responses.rs 模块文档差异清单）：
//! 错误帧 code+message 收敛、usage input_tokens_details 归一、终态映射、C14 净输入。
use super::*;
use crate::events::{stream_error_kind, StopReason};
use crate::sse::frame::SseFrame;
use conex_types::ProviderErrorKind;
use serde_json::json;

/// 便捷构造：处理一帧并立即 finish，返回全部事件
fn parse_all(frames: Vec<&str>) -> Vec<ProviderStreamEvent> {
    let mut parser = AzureResponsesParser::new();
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

fn stop_of(events: &[ProviderStreamEvent]) -> &ProviderStreamEvent {
    events
        .iter()
        .find(|event| matches!(event, ProviderStreamEvent::Stop { .. }))
        .expect("流内应有 stop")
}

/// 便捷断言：stop 事件的 reason
fn reason_of(event: &ProviderStreamEvent) -> StopReason {
    match event {
        ProviderStreamEvent::Stop { reason, .. } => *reason,
        other => panic!("期望 stop，得到事件：{other:?}"),
    }
}

fn terminal_frame(event_type: &str, status: &str) -> String {
    serde_json::to_string(&json!({
        "type": event_type,
        "response": { "status": status },
    }))
    .expect("序列化")
}

// ── azure 差异契约 1：错误帧 code+message 收敛 ──

/// azure/OpenAI SDK 错误帧 `{type:"error", code, message}` → 复用内核 message 优先
#[test]
fn azure_error_frame_message_priotitized_over_code() {
    let data = r#"{"type":"error","code":"context_length_exceeded","message":"这段超长了"}"#;
    let events = parse_all(vec![data]);
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("这段超长了".into()),
            error_kind: Some(stream_error_kind("这段超长了")),
            usage: None,
        }
    );
    assert_eq!(events.len(), 1, "错误帧后不再产出任何事件");
}

/// 仅 code（message 缺失）→ 回退 code 文案（复用内核，覆盖 azure 错误形状）
#[test]
fn azure_error_frame_falls_back_to_code() {
    let data = r#"{"type":"error","code":"rate_limited"}"#;
    match stop_of(&parse_all(vec![data])) {
        ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some(error),
            error_kind: Some(_),
            ..
        } => {
            assert_eq!(error, "rate_limited");
        }
        other => panic!("期望 code 回退的错误 stop，得到：{other:?}"),
    }
}

// ── 正文 / 推理（与 responses 同形状，经包装层透传内核）──

#[test]
fn azure_text_and_reasoning_deltas_delegate_to_core() {
    let events = parse_all(vec![
        &serde_json::to_string(&json!({ "type": "response.output_text.delta", "delta": "你好" }))
            .expect("序列化"),
        &serde_json::to_string(
            &json!({ "type": "response.reasoning_text.delta", "delta": "在想" }),
        )
        .expect("序列化"),
        &terminal_frame("response.completed", "completed"),
    ]);
    let texts: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            ProviderStreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["你好"]);
    let thought = events
        .iter()
        .filter_map(|event| match event {
            ProviderStreamEvent::ThoughtDelta {
                text, redacted, ..
            } => Some((text.as_str(), *redacted)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(thought, vec![("在想", Some(true))], "azure reasoning 同 responses 标 redacted");
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

// ── 工具调用：增量 + output_item.done（同 responses 形状，透传内核）──

#[test]
fn azure_tool_call_arguments_delta_append_emits_once() {
    let events = parse_all(vec![
        &serde_json::to_string(&json!({
            "type": "response.output_item.added",
            "item": { "id": "item_1", "type": "function_call", "call_id": "call_1", "name": "list_files", "arguments": "" },
        })).expect("序列化"),
        &serde_json::to_string(&json!({ "type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": r#"{"filter":"/tmp""# })).expect("序列化"),
        &serde_json::to_string(&json!({ "type": "response.function_call_arguments.done", "item_id": "item_1", "arguments": r#"{"filter":"/tmp"}"# })).expect("序列化"),
        &terminal_frame("response.completed", "completed"),
    ]);
    let tool_calls: Vec<&ProviderStreamEvent> = events
        .iter()
        .filter(|event| matches!(event, ProviderStreamEvent::ToolCall { .. }))
        .collect();
    assert_eq!(tool_calls.len(), 1);
    match tool_calls[0] {
        ProviderStreamEvent::ToolCall {
            id,
            tool_name,
            input,
            ..
        } => {
            assert_eq!(id.as_deref(), Some("call_1"));
            assert_eq!(tool_name, "list_files");
            assert_eq!(input.as_str(), json!({ "filter": "/tmp" }).as_str());
        }
        _ => unreachable!("已过滤"),
    }
    // sawToolCall → stop 强制 tool-call
    assert_eq!(reason_of(stop_of(&events)), StopReason::ToolCall);
}

// ── 差异契约 2+3：usage 归一（input_tokens_details / C14 净输入）──

/// azure 终态 usage（input_tokens_details.cached_tokens / cache_write_tokens）→
/// parse_usage 收敛到 cache_read/cache_write，C14 净输入经 breakdown 派生
#[test]
fn azure_terminal_usage_map_and_cache_breakdown() {
    let data = serde_json::to_string(&json!({
        "type": "response.completed",
        "response": {
            "status": "completed",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 30,
                "total_tokens": 130,
                "input_tokens_details": { "cached_tokens": 40, "cache_write_tokens": 10 },
                "output_tokens_details": { "reasoning_tokens": 5 },
            },
        },
    }))
    .expect("序列化");
    let events = parse_all(vec![&data]);
    let stop = stop_of(&events);
    let ProviderStreamEvent::Stop { usage: Some(usage), .. } = stop else {
        panic!("期望携带 usage 的 stop：{stop:?}");
    };
    // 原始上报值保留（C14：prompt 不做减法改写）
    assert_eq!(usage.prompt_tokens, Some(100));
    assert_eq!(usage.completion_tokens, Some(30));
    assert_eq!(usage.cache_read_tokens, Some(40));
    assert_eq!(usage.cache_write_tokens, Some(10));
    assert_eq!(usage.reasoning_tokens, Some(5));
    assert_eq!(usage.total_tokens, Some(130));
    // C14 净输入 = prompt - read - write = 100 - 40 - 10 = 50（Included 轨派生）
    let mut parser = AzureResponsesParser::new();
    parser
        .push_frame(&SseFrame {
            event: None,
            data: Some(data),
            id: None,
            retry: None,
        })
        .expect("帧处理");
    parser.finish().expect("流结束");
    let breakdown = parser.cache_breakdown().expect("应可归一");
    assert_eq!(breakdown.miss, 50, "净输入 = prompt - cache_read - cache_write");
    assert_eq!(breakdown.read, 40);
    assert_eq!(breakdown.write, 10);
    assert_eq!(breakdown.input_total, 100, "Included 轨 input_total = prompt");
}

/// 顶层 usage（非 response 嵌套，azure 可能前置帧携带）→ 覆盖式收敛
#[test]
fn azure_top_level_usage_override_later_frame_wins() {
    let first = serde_json::to_string(&json!({
        "type": "response.output_text.delta",
        "delta": "a",
        "usage": { "input_tokens": 5, "output_tokens": 1, "total_tokens": 6 },
    }))
    .expect("序列化");
    let second = serde_json::to_string(&json!({
        "type": "response.output_text.delta",
        "delta": "b",
        "usage": { "input_tokens": 60, "output_tokens": 10, "total_tokens": 70 },
    }))
    .expect("序列化");
    let events = parse_all(vec![&first, &second, &terminal_frame("response.completed", "completed")]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
            assert_eq!(usage.prompt_tokens, Some(60), "后到覆盖式优先（OpenAI 覆盖式）");
            assert_eq!(usage.total_tokens, Some(70));
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }
}

// ── 差异契约 4：终态映射表（逐项，透传内核）──

#[test]
fn azure_terminal_status_mapping_table() {
    let cases = [
        ("response.completed", "completed", StopReason::Stop),
        ("response.completed", "incomplete", StopReason::Length),
        ("response.incomplete", "incomplete", StopReason::Length),
        ("response.failed", "failed", StopReason::Error),
        ("response.failed", "cancelled", StopReason::Error),
    ];
    for (event_type, status, expected) in cases {
        let events = parse_all(vec![&terminal_frame(event_type, status)]);
        assert_eq!(
            reason_of(stop_of(&events)),
            expected,
            "{event_type} status={status} 映射错误"
        );
    }
}

/// failed 终态错误文案（response.error.message）→ error stop + 分类
#[test]
fn azure_failed_terminal_carries_error_message() {
    let data = serde_json::to_string(&json!({
        "type": "response.failed",
        "response": { "status": "failed", "error": { "code": "e1", "message": "azure 拒绝" } },
    }))
    .expect("序列化");
    let events = parse_all(vec![&data]);
    assert_eq!(
        stop_of(&events),
        &ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("azure 拒绝".into()),
            error_kind: Some(ProviderErrorKind::Unknown),
            usage: None,
        }
    );
}

// ── 空流保护 / 收尾 ──

#[test]
fn azure_stream_without_terminal_event_errors() {
    let events = parse_all(vec![&serde_json::to_string(&json!({
        "type": "response.output_text.delta",
        "delta": "正文",
    }))
    .expect("序列化")]);
    match stop_of(&events) {
        ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error,
            ..
        } => {
            assert!(
                error.as_deref().unwrap_or("").contains("terminal response event"),
                "无终态帧应报 invalid-stream：{error:?}"
            );
        }
        other => panic!("期望 error stop，得到：{other:?}"),
    }
}

#[test]
fn azure_finish_is_idempotent() {
    let mut parser = AzureResponsesParser::new();
    assert_eq!(parser.finish().expect("首次 finish").len(), 1);
    assert!(
        parser.finish().expect("二次 finish").is_empty(),
        "重复 finish 不得再产出 stop"
    );
    assert!(parser.is_terminated());
}
