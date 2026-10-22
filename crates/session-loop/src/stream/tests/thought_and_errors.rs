use super::*;

/// 纯思考流（无正文）→ Message（不判定为 Empty），metadata 完整保留 thought 与 thoughtBlocks
#[test]
fn pure_thought_stream_yields_message() {
    let result = consume(
        vec![
            ProviderStreamEvent::thought("纯思考深度分析1", None),
            ProviderStreamEvent::thought("纯思考深度分析2", Some(true)),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    assert!(
        result.response.is_message(),
        "纯思考流必须产出 Message，不得被判定为 Empty"
    );
    assert_eq!(result.response.text(), "");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
    assert_eq!(result.metadata["thought"], "纯思考深度分析1纯思考深度分析2");
    let blocks = result.metadata["thoughtBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["text"], "纯思考深度分析1");
    assert!(blocks[0].get("redacted").is_none());
    assert_eq!(blocks[1]["text"], "纯思考深度分析2");
    assert_eq!(blocks[1]["redacted"], true);
}

/// abort 发生在纯思考流中 → 保留思考内容，stopReason=aborted（partial salvage）
#[test]
fn abort_with_only_thought_keeps_partial_message() {
    let result = consume(
        vec![ProviderStreamEvent::thought(
            "流中被 abort 的思考片段",
            None,
        )],
        true,
    );
    assert!(
        result.response.is_message(),
        "仅有思考内容时 abort 必须保留为 Message"
    );
    assert_eq!(result.response.text(), "");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(result.metadata["aborted"], true);
    assert_eq!(result.metadata["thought"], "流中被 abort 的思考片段");
}

/// 纯思考流 + error stop → Message，思考内容不丢，stopReason 标记为 error（BC02-2）
#[test]
fn thought_with_error_stop_yields_message() {
    let result = consume(
        vec![
            ProviderStreamEvent::thought("思考到一半发生错误", None),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("网络连接重置".to_string()),
                error_kind: Some(ProviderErrorKind::Timeout),
                usage: None,
            },
        ],
        false,
    );
    assert!(
        result.response.is_message(),
        "有思考内容且发生 error stop 时必须产出 Message"
    );
    assert_eq!(
        result.stop_reason(),
        Some(ConsumeStopReason::Error {
            kind: ProviderErrorKind::Timeout,
            message: "网络连接重置".to_string(),
            retryable: true,
        })
    );
    assert_eq!(result.metadata["stopReason"], "error");
    assert_eq!(result.metadata["thought"], "思考到一半发生错误");
    assert_eq!(result.metadata["providerError"], "网络连接重置");
    assert_eq!(result.metadata["providerErrorKind"], "timeout");
}

/// BC02-2：tool-call + error stop → 严禁盖写为 ToolCall，必须为 Error 终态变体！
#[test]
fn tool_call_then_error_stop_yields_error_stop_reason_not_tool_call() {
    let result = consume(
        vec![
            ProviderStreamEvent::tool_call(
                Some("call_1".into()),
                "execute_command",
                serde_json::json!({"cmd": "rm -rf /"}),
            ),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("连接异常中断".to_string()),
                error_kind: Some(ProviderErrorKind::Network),
                usage: None,
            },
        ],
        false,
    );
    assert_eq!(
        result.stop_reason(),
        Some(ConsumeStopReason::Error {
            kind: ProviderErrorKind::Network,
            message: "连接异常中断".to_string(),
            retryable: true,
        }),
        "有 tool-call 时发生 error 严禁被盖写为 ToolCall！"
    );
    assert_eq!(result.metadata["stopReason"], "error");
}

/// BC02-1：纯 error stop 携带 RateLimit 时，无损透传原始分类（保留精确 kind 与 retryable），杜绝被折叠为 Unknown fatal
#[test]
fn pure_error_stop_with_rate_limit_preserves_error_kind() {
    let result = consume(
        vec![ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("429 Too Many Requests".to_string()),
            error_kind: Some(ProviderErrorKind::RateLimit),
            usage: None,
        }],
        false,
    );
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(
        classified.kind,
        ProviderErrorKind::RateLimit,
        "429 RateLimit 错误必须保全精确分类"
    );
    assert!(classified.retryable, "RateLimit 必须可重试");
    assert_eq!(classified.message, "429 Too Many Requests");
}

/// BC02-3：网络诊断事件（如 SseFirstByte）绝不能破坏空流有效载荷判定
#[test]
fn diagnostic_does_not_break_has_salvageable_content() {
    let mut builder = ConsumeBuilder::new();
    assert!(!builder.has_salvageable_content());
    assert!(builder.is_empty());

    // 推入网络诊断事件
    builder.push(ProviderStreamEvent::ProviderDiagnostic {
        diagnostic: ProviderDiagnostic {
            reason: Some("首字节就绪".to_string()),
            ..Default::default()
        },
    });

    // 诊断事件绝不能破坏空流判定
    assert!(
        !builder.has_salvageable_content(),
        "仅有诊断事件时不得视为有效正文载荷"
    );
    assert!(builder.is_empty(), "仅有诊断事件时 is_empty 必须返回 true");

    // 推入正文增量后成为有效载荷
    builder.push(ProviderStreamEvent::text("正文内容"));
    assert!(builder.has_salvageable_content());
    assert!(!builder.is_empty());
}
