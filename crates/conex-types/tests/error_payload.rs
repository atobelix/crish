//! B1.5 错误负载序列化契约测试
//!
//! 对齐 error-propagation.e2e.test.ts:309（cause 链 8 层上限）；错误 payload
//! 结构 `{kind, detail}` 对齐 03 §5.3-5（CoreError）。

use conex_types::error::{codes, CrishError, CrishErrorPayload, CRISH_ERROR_CAUSE_MAX_DEPTH};
use conex_types::error::{ProviderErrorKind, RunTerminal, RunTerminalError};
use conex_types::ipc_error::CoreError;
use conex_types::session::{AgentEndReason, AgentSessionEvent};

// ── cause 链 8 层上限（对齐 error-propagation.e2e.test.ts:309）──

#[test]
fn cause_chain_capped_at_8_layers() {
    // 构造 10 层 cause 链：depth0 -> depth1 -> ... -> depth9
    let mut err = CrishError::new(codes::COMMON_UNKNOWN, "depth 9");
    for i in (0..9).rev() {
        err = CrishError::new(codes::COMMON_UNKNOWN, format!("depth {i}")).with_cause(err);
    }
    let payload = err.to_error_payload(0);
    // 遍历 cause 链，统计到达截断层的深度
    let mut current = &payload;
    let mut depth = 0u8;
    while let Some(cause) = &current.cause {
        current = cause;
        depth += 1;
    }
    assert_eq!(depth, CRISH_ERROR_CAUSE_MAX_DEPTH);
    assert_eq!(current.code, codes::COMMON_UNKNOWN);
    assert!(current.message.contains("truncated"));
    assert_eq!(
        current.metadata.as_ref().and_then(|m| m.get("truncated")),
        Some(&serde_json::json!(true))
    );
    // 序列化往返保持链长
    let json = serde_json::to_string(&payload).unwrap();
    let back: CrishErrorPayload = serde_json::from_str(&json).unwrap();
    let mut depth2 = 0u8;
    let mut current2 = &back;
    while let Some(cause) = &current2.cause {
        current2 = cause;
        depth2 += 1;
    }
    assert_eq!(depth2, 8);
}

#[test]
fn crish_error_payload_camel_case_fields() {
    let err = CrishError::new(codes::PROVIDER_RATE_LIMIT, "rate limited");
    let payload = err.to_error_payload(0);
    let json = serde_json::to_value(&payload).unwrap();
    // CrishErrorPayload 字段名（camelCase；is_public → "public"）
    assert_eq!(json["code"], "provider.rate_limit");
    assert_eq!(json["category"], "transient");
    assert_eq!(json["retryable"], true);
    assert_eq!(json["public"], true);
    assert!(json.get("action").is_some());
    assert!(json["timestamp"].is_i64());
}

// ── 错误 payload {kind, detail}（03 §5.3-5：invoke 错误统一 CoreError）──

#[test]
fn core_error_payload_kind_and_detail() {
    let err = CoreError::InvalidInput("bad run id".into());
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["kind"], "InvalidInput");
    assert_eq!(json["detail"], "bad run id");
    // roundtrip
    let back: CoreError = serde_json::from_value(json).unwrap();
    match back {
        CoreError::InvalidInput(msg) => assert_eq!(msg, "bad run id"),
        other => panic!("期望 InvalidInput，实际 {other:?}"),
    }
    // unit variant：detail 为 null
    let cancelled = serde_json::to_value(CoreError::Cancelled).unwrap();
    assert_eq!(cancelled["kind"], "Cancelled");
    assert!(cancelled.get("detail").is_none() || cancelled["detail"].is_null());
}

// ── ProviderErrorKind 13 类（02 §4.2 分类表逐行）──

#[test]
fn provider_error_kind_13_classes_with_retryable_matrix() {
    // 02 §4.2 表 13 行 + 默认 retryable 矩阵
    let cases: &[(ProviderErrorKind, bool)] = &[
        (ProviderErrorKind::Aborted, false),              // 第 1 行
        (ProviderErrorKind::PayloadTooLarge, false),      // 第 2 行
        (ProviderErrorKind::GatewayChallenge, false),     // 第 3 行
        (ProviderErrorKind::Auth, false),                 // 第 4 行
        (ProviderErrorKind::Quota, false),                // 第 5 行
        (ProviderErrorKind::EndpointUnavailable, false),  // 第 6 行
        (ProviderErrorKind::ContextLengthExceeded, true), // 第 7 行（唯一可重试 4xx）
        (ProviderErrorKind::InvalidRequest, false),       // 第 8 行
        (ProviderErrorKind::RateLimit, true),             // 第 9 行
        (ProviderErrorKind::ServerError, true),           // 第 10 行
        (ProviderErrorKind::Timeout, true),               // 第 11 行
        (ProviderErrorKind::Network, true),               // 第 12 行（02 §五.11 裁决）
        (ProviderErrorKind::Unknown, false),              // 第 13 行
    ];
    assert_eq!(cases.len(), 13, "必须与 02 §4.2 表 13 行一一对应");
    for (kind, retryable) in cases {
        assert_eq!(
            kind.default_retryable(),
            *retryable,
            "kind={kind:?} 的默认 retryable 不一致"
        );
    }
}

#[test]
fn provider_error_kind_code_mapping() {
    assert_eq!(
        ProviderErrorKind::ContextLengthExceeded.code(),
        codes::CONTEXT_LENGTH_EXCEEDED
    );
    assert_eq!(
        ProviderErrorKind::RateLimit.code(),
        codes::PROVIDER_RATE_LIMIT
    );
    assert_eq!(ProviderErrorKind::Network.code(), codes::PROVIDER_NETWORK);
    assert_eq!(ProviderErrorKind::Aborted.code(), codes::PROVIDER_CANCELLED);
    assert_eq!(ProviderErrorKind::Unknown.code(), codes::PROVIDER_UNKNOWN);
}

#[test]
fn provider_error_kind_wire_names() {
    // kebab-case wire 值（对齐 shared-types ProviderErrorKind 风格）
    assert_eq!(
        serde_json::to_value(ProviderErrorKind::RateLimit).unwrap(),
        "rate-limit"
    );
    assert_eq!(
        serde_json::to_value(ProviderErrorKind::GatewayChallenge).unwrap(),
        "gateway-challenge"
    );
    assert_eq!(
        serde_json::to_value(ProviderErrorKind::EndpointUnavailable).unwrap(),
        "endpoint-unavailable"
    );
    assert_eq!(
        serde_json::to_value(ProviderErrorKind::ContextLengthExceeded).unwrap(),
        "context-length-exceeded"
    );
    assert_eq!(
        serde_json::to_value(ProviderErrorKind::PayloadTooLarge).unwrap(),
        "payload-too-large"
    );
}

// ── RunTerminal 收口决策（01 §五.2 + §1.6）──

#[test]
fn run_terminal_error_reason_requires_error() {
    let err = CrishError::new(codes::PROVIDER_SERVER, "server error");
    let terminal = RunTerminal::new(AgentEndReason::Error, Some(err.clone())).unwrap();
    assert!(terminal.is_error());
    assert_eq!(terminal.reason, AgentEndReason::Error);
    assert_eq!(terminal.error.as_ref().unwrap().message, "server error");

    // error 收场缺 error → 拒绝
    assert!(matches!(
        RunTerminal::new(AgentEndReason::Error, None),
        Err(RunTerminalError::MissingError)
    ));
}

#[test]
fn run_terminal_non_error_reason_must_not_carry_error() {
    let err = CrishError::new(codes::COMMON_UNKNOWN, "should not attach");
    for reason in [
        AgentEndReason::Stop,
        AgentEndReason::MaxTurns,
        AgentEndReason::Aborted,
        AgentEndReason::Stopped,
    ] {
        assert!(
            matches!(
                RunTerminal::new(reason, Some(err.clone())),
                Err(RunTerminalError::ErrorNotAllowed(r)) if r == reason
            ),
            "reason={reason:?} 不得携带 error（01 §1.6 最小集合）"
        );
        let ok = RunTerminal::new(reason, None).unwrap();
        assert!(!ok.is_error());
        assert_eq!(ok.error, None);
    }
}

#[test]
fn run_terminal_from_error_event_only_four_events() {
    let err = CrishError::new(codes::PROVIDER_SERVER, "boom");
    // 01 §1.6 四事件
    for event in [
        AgentSessionEvent::Error,
        AgentSessionEvent::InterventionRequired,
        AgentSessionEvent::ProviderError,
        AgentSessionEvent::SteeringBudgetExhausted,
    ] {
        let terminal = RunTerminal::from_error_event(event, err.clone()).unwrap();
        assert_eq!(terminal.reason, AgentEndReason::Error);
        assert!(terminal.error.is_some());
    }
    // 其余事件一律拒绝（例如 FINISH / SHOULD_STOP 不得构造 error 收场）
    assert!(matches!(
        RunTerminal::from_error_event(AgentSessionEvent::Finish, err.clone()),
        Err(RunTerminalError::NotErrorEvent(_))
    ));
    assert!(matches!(
        RunTerminal::from_error_event(AgentSessionEvent::ShouldStop, err.clone()),
        Err(RunTerminalError::NotErrorEvent(_))
    ));
}

#[test]
fn run_terminal_serialization() {
    let err = CrishError::new(codes::PROVIDER_SERVER, "server error");
    let terminal = RunTerminal::new(AgentEndReason::Error, Some(err)).unwrap();
    let json = serde_json::to_value(&terminal).unwrap();
    assert_eq!(json["reason"], "error");
    assert_eq!(json["error"]["code"], "provider.server");
    assert_eq!(json["error"]["message"], "server error");
    let back: RunTerminal = serde_json::from_value(json).unwrap();
    assert_eq!(terminal, back);

    let stop = RunTerminal::new(AgentEndReason::Stop, None).unwrap();
    let json = serde_json::to_value(&stop).unwrap();
    assert_eq!(json["reason"], "stop");
    assert!(json.get("error").is_none());
}

// ── 跨端动态参数序列化契约与兼容性（AGENT-W4-TAURI-IPC-PAYLOAD）──

#[test]
fn crish_error_and_payload_dynamic_params_serialization() {
    let mut params = std::collections::HashMap::new();
    params.insert("target".to_string(), serde_json::json!("workspace/foo.rs"));
    params.insert("code".to_string(), serde_json::json!(403));
    params.insert(
        "detail".to_string(),
        serde_json::json!({ "subsystem": "sandbox" }),
    );

    let err = CrishError::new(codes::TOOL_WRITE_NOT_ALLOWED, "path access denied")
        .with_params(params)
        .with_param("attempt", 2);

    let payload = err.to_error_payload(0);
    assert_eq!(payload.code, codes::TOOL_WRITE_NOT_ALLOWED);
    assert!(payload.params.is_some());

    let json = serde_json::to_value(&payload).unwrap();
    assert_eq!(json["code"], "tool.write_not_allowed");
    assert_eq!(json["params"]["target"], "workspace/foo.rs");
    assert_eq!(json["params"]["code"], 403);
    assert_eq!(json["params"]["attempt"], 2);
    assert_eq!(json["params"]["detail"]["subsystem"], "sandbox");

    // 反序列化还原验证
    let back: CrishErrorPayload = serde_json::from_value(json).unwrap();
    assert_eq!(
        back.params.as_ref().unwrap().get("target"),
        Some(&serde_json::json!("workspace/foo.rs"))
    );
    assert_eq!(
        back.params.as_ref().unwrap().get("attempt"),
        Some(&serde_json::json!(2))
    );
}

#[test]
fn crish_error_payload_params_forward_backward_compatibility() {
    // 1. 无 params 时 skip_serializing_if 成立，不输出 "params" 字段
    let err_without_params = CrishError::new(codes::PROVIDER_NETWORK, "network down");
    let payload = err_without_params.to_error_payload(0);
    let json_val = serde_json::to_value(&payload).unwrap();
    assert!(json_val.get("params").is_none());

    // 2. 旧版无 params 的 JSON 能无缝反序列化为 None
    let old_json = serde_json::json!({
        "code": "provider.timeout",
        "message": "timed out",
        "category": "transient",
        "retryable": true,
        "public": true,
        "action": "action.provider.retry",
        "timestamp": 1700000000000i64
    });
    let restored: CrishErrorPayload = serde_json::from_value(old_json).unwrap();
    assert!(restored.params.is_none());

    // 3. 直接通过 payload.with_param / with_params 配置动态参数
    let direct_payload = restored.with_param("retryAfterMs", 3000);
    assert_eq!(
        direct_payload.params.as_ref().unwrap().get("retryAfterMs"),
        Some(&serde_json::json!(3000))
    );
}
