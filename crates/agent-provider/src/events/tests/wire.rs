use super::{diagnostic_event, stop_event, text_event};
use crate::events::{
    stream_error_kind, ModelRequestInfo, ModelResponseInfo, ProviderStreamEvent, ProviderUsage,
    StopReason,
};
use conex_types::error::ProviderErrorKind;

#[test]
fn serde_roundtrip_all_variants() {
    let events = vec![
        text_event(),
        ProviderStreamEvent::ThoughtDelta {
            text: "思考".into(),
            redacted: Some(true),
        },
        ProviderStreamEvent::ThoughtDelta {
            text: "思考".into(),
            redacted: None,
        },
        ProviderStreamEvent::ToolCall {
            id: Some("call_1".into()),
            tool_name: "read_file".into(),
            input: serde_json::json!({ "path": "/tmp/a" }),
        },
        diagnostic_event(),
        // M14：请求生命周期观测事件（before-request / after-response）
        ProviderStreamEvent::BeforeRequest {
            info: ModelRequestInfo {
                url: Some("https://api.example.com/v1/chat/completions".into()),
                model: Some("deepseek-v4".into()),
                max_tokens: Some(4096),
                attempt: 2,
            },
        },
        ProviderStreamEvent::AfterResponse {
            info: ModelResponseInfo {
                status: Some(200),
                ok: true,
                error: None,
                duration_ms: 812,
                usage: Some(ProviderUsage {
                    prompt_tokens: Some(100),
                    ..ProviderUsage::default()
                }),
            },
        },
        ProviderStreamEvent::AfterResponse {
            info: ModelResponseInfo {
                status: Some(503),
                ok: false,
                error: Some("upstream down".into()),
                duration_ms: 34,
                usage: None,
            },
        },
        stop_event(StopReason::Stop),
        stop_event(StopReason::ToolCall),
        stop_event(StopReason::Length),
        stop_event(StopReason::Error),
    ];
    for event in events {
        let json = serde_json::to_string(&event).unwrap();
        let back: ProviderStreamEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back, "roundtrip 失败: {json}");
    }
}

/// M14：before-request / after-response 的 wire 形状（kebab-case type +
/// camelCase 字段，复用 ProviderStreamEvent 通道结构）
#[test]
fn model_lifecycle_wire_names() {
    let before = ProviderStreamEvent::BeforeRequest {
        info: ModelRequestInfo {
            url: None,
            model: Some("m".into()),
            max_tokens: None,
            attempt: 1,
        },
    };
    let value = serde_json::to_value(&before).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "type": "before-request",
            "info": { "model": "m", "attempt": 1 }
        })
    );

    let after = ProviderStreamEvent::AfterResponse {
        info: ModelResponseInfo {
            status: None,
            ok: false,
            error: Some("boom".into()),
            duration_ms: 5,
            usage: None,
        },
    };
    let value = serde_json::to_value(&after).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "type": "after-response",
            "info": { "ok": false, "error": "boom", "durationMs": 5 }
        })
    );
}

#[test]
fn serde_wire_names_match_ts() {
    // 顶层 type 为 kebab-case，字段为 camelCase（对齐 shared:tool.ts）
    let event = ProviderStreamEvent::ThoughtDelta {
        text: "x".into(),
        redacted: Some(true),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "type": "thought-delta", "text": "x", "redacted": true })
    );

    let event = ProviderStreamEvent::ToolCall {
        id: None,
        tool_name: "read_file".into(),
        input: serde_json::json!({}),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "type": "tool-call", "toolName": "read_file", "input": {} })
    );

    let event = stop_event(StopReason::ToolCall);
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "type": "stop", "reason": "tool-call" })
    );
}

#[test]
fn stop_reason_wire_names() {
    for (reason, expected) in [
        (StopReason::Stop, "stop"),
        (StopReason::ToolCall, "tool-call"),
        (StopReason::Length, "length"),
        (StopReason::Error, "error"),
    ] {
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::json!(expected)
        );
    }
}

/// G1-c（T3.3）：无错误的 Stop → error_kind 缺省 None，wire 上省略（向后兼容）
#[test]
fn stop_without_error_kind_is_none_and_omitted() {
    let event = ProviderStreamEvent::Stop {
        reason: StopReason::Stop,
        error: None,
        error_kind: None,
        usage: None,
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "type": "stop", "reason": "stop" }),
        "无错误的 Stop 不应携带 errorKind 字段"
    );
    // 反向：缺 errorKind 字段的 Stop JSON 能按 Option 缺省反序列化成功
    let back: ProviderStreamEvent =
        serde_json::from_str(r#"{"type":"stop","reason":"stop"}"#).unwrap();
    assert!(matches!(back, ProviderStreamEvent::Stop { .. }));
}

/// G1-c（T3.3）：error_kind wire 名称为 camelCase errorKind、值为 kebab-case 13 类
#[test]
fn stop_error_kind_wire_name_and_values() {
    for kind in [
        ProviderErrorKind::Unknown,
        ProviderErrorKind::Timeout,
        ProviderErrorKind::Network,
        ProviderErrorKind::Aborted,
        ProviderErrorKind::RateLimit,
        ProviderErrorKind::ServerError,
    ] {
        let event = ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("err".into()),
            error_kind: Some(kind),
            usage: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["reason"], "error");
        assert!(value.get("errorKind").is_some(), "error_kind 应序列化");
        // roundtrip 后 error_kind 还原
        let back: ProviderStreamEvent = serde_json::from_value(value.clone()).unwrap();
        let ProviderStreamEvent::Stop { error_kind, .. } = back else {
            panic!("应为 Stop");
        };
        assert_eq!(error_kind, Some(kind), "roundtrip 后 error_kind 应还原");
    }
}

/// G1-c（T3.3）：流中读取/服务端错误文案 → 走 classify_provider_error 分类
#[test]
fn stream_error_kind_classifies_read_error() {
    assert_eq!(
        stream_error_kind("rate limit exceeded: please retry after 5s"),
        ProviderErrorKind::RateLimit
    );
    assert_eq!(
        stream_error_kind("the server is overloaded, try again later"),
        ProviderErrorKind::ServerError
    );
    assert_eq!(
        stream_error_kind("request timed out after 30 seconds"),
        ProviderErrorKind::Timeout
    );
    assert_eq!(
        stream_error_kind("fetch failed: the connection was reset"),
        ProviderErrorKind::Network
    );
    // 不可分类文案兜底 Unknown（不可重试语义保持）
    assert_eq!(
        stream_error_kind("provider emitted a brand-new opaque message"),
        ProviderErrorKind::Unknown
    );
}

#[test]
fn stop_event_carries_error_and_usage() {
    let event = ProviderStreamEvent::Stop {
        reason: StopReason::Error,
        error: Some("boom".into()),
        error_kind: Some(ProviderErrorKind::Unknown),
        usage: Some(ProviderUsage {
            prompt_tokens: Some(1),
            ..ProviderUsage::default()
        }),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["error"], "boom");
    assert_eq!(value["errorKind"], "unknown");
    assert_eq!(value["usage"]["promptTokens"], 1);
}
