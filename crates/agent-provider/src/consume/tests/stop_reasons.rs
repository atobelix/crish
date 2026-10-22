use super::{message, stop, stop_with, text_delta, tool_call};
use crate::consume::{consume, ConsumeStopReason};
use conex_types::error::ProviderErrorKind;
use conex_types::response::ProviderOutput;
use crate::events::{ProviderStreamEvent, StopReason};

/// 文字 + error stop → Message（不失败）；error 降级为 metadata 标注，stopReason 不为 error。
/// D7 §3.7（T9）：标注含结构化分类 providerErrorKind/providerErrorRetryable
#[test]
fn text_then_error_stop_yields_message() {
    let result = consume(
        vec![
            text_delta("你好"),
            stop_with(StopReason::Error, Some("boom"), None),
        ],
        false,
    );
    assert_eq!(result.response, ProviderOutput::message("你好", vec![]));
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));
    assert_eq!(result.metadata["providerError"], "boom");
    assert_eq!(result.metadata["providerFinishReason"], "error");
    // D7 §3.7：不可分类文案兜底 Unknown（kebab-case "unknown"）+ 不可重试
    assert_eq!(result.metadata["providerErrorKind"], "unknown");
    assert_eq!(result.metadata["providerErrorRetryable"], false);
}

/// D7 §3.7：瞬态文案（限流）+ 已产出内容 → providerErrorKind=rate-limit、
/// providerErrorRetryable=true（E1 续写触发信号数据源，D7 §3.7 消费方扩展）
#[test]
fn in_stream_rate_limit_with_content_marks_transient_kind() {
    let result = consume(
        vec![
            text_delta("部分输出"),
            stop_with(
                StopReason::Error,
                Some("Rate limit exceeded: please retry after 5 seconds"),
                None,
            ),
        ],
        false,
    );
    assert!(result.response.is_message());
    assert_eq!(result.metadata["providerErrorKind"], "rate-limit");
    assert_eq!(result.metadata["providerErrorRetryable"], true);
}

/// D7 §3.7：不可重试文案（鉴权失败）+ 已产出内容 → providerErrorKind=auth、
/// providerErrorRetryable=false（分类管线全量生效，不只放行重试类）
#[test]
fn in_stream_auth_with_content_marks_not_retryable() {
    let result = consume(
        vec![
            text_delta("部分输出"),
            stop_with(
                StopReason::Error,
                Some("invalid api key: authentication failed"),
                None,
            ),
        ],
        false,
    );
    assert!(result.response.is_message());
    assert_eq!(result.metadata["providerErrorKind"], "auth");
    assert_eq!(result.metadata["providerErrorRetryable"], false);
}

/// tool-call + error stop → Message；stopReason=tool-call，错误仅标注
#[test]
fn tool_call_then_error_stop_yields_message() {
    let result = consume(
        vec![
            tool_call(Some("call_1"), "read_file"),
            stop_with(StopReason::Error, Some("boom"), None),
        ],
        false,
    );
    let ProviderOutput::Message { text, tool_calls } = message(&result.response) else {
        unreachable!()
    };
    assert_eq!(text, "");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].id, "call_1");
    assert_eq!(tool_calls[0].tool_name, "read_file");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
    assert_eq!(result.metadata["providerError"], "boom");
}

/// 纯 error 无内容 → StreamError（Unknown 类，不可重试）
#[test]
fn pure_error_stop_yields_stream_error() {
    let result = consume(
        vec![stop_with(StopReason::Error, Some("服务端错误"), None)],
        false,
    );
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Unknown);
    assert!(!classified.retryable);
    assert_eq!(classified.message, "服务端错误");
    assert!(result.stop_reason().is_none());
}

/// F3 盲区 #4：流内 error 帧携带瞬时限流文案（HTTP 200 + SSE error
/// 帧形态）→ 消息模式兜底分类为 RateLimit 且可重试（修复前恒
/// Unknown/retryable=false → 流内错误永不重试）
#[test]
fn in_stream_rate_limit_message_is_retryable() {
    let result = consume(
        vec![stop_with(
            StopReason::Error,
            Some("Rate limit exceeded: please retry after 5 seconds"),
            None,
        )],
        false,
    );
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(
        classified.kind,
        ProviderErrorKind::RateLimit,
        "流内限流文案必须分类为 RateLimit（F3 #4）"
    );
    assert!(
        classified.retryable,
        "流内限流未产出内容应可重试（02 §6.7）"
    );
}

/// F3 盲区 #4：流内 error 帧携带 5xx 文案（overloaded_error 等网关形态）
/// → ServerError 可重试
#[test]
fn in_stream_server_error_message_is_retryable() {
    let result = consume(
        vec![stop_with(
            StopReason::Error,
            Some("overloaded_error: the server is experiencing high load"),
            None,
        )],
        false,
    );
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(
        classified.kind,
        ProviderErrorKind::ServerError,
        "流内 5xx 文案必须分类为 ServerError（F3 #4）"
    );
    assert!(classified.retryable);
}

/// G1-c（T3.3）：Stop 构造点携带 error_kind → consume 无内容 StreamError
/// 沿用它做分类（不重分类），error_kind 首选通路
#[test]
fn stop_carries_error_kind_used_in_stream_error() {
    let result = consume(
        vec![ProviderStreamEvent::Stop {
            reason: StopReason::Error,
            error: Some("provider opaque message".into()),
            error_kind: Some(ProviderErrorKind::Timeout),
            usage: None,
        }],
        false,
    );
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(
        classified.kind,
        ProviderErrorKind::Timeout,
        "构造点明确分类应优先于文案推断"
    );
    assert!(classified.retryable, "Timeout 按默认矩阵可重试");
}

/// G1-c（T3.3）：Stop 无 error/error_kind（正常终态）→ StreamError 不产生；
/// 有内容 + error_kind → metadata.providerErrorKind 沿用构造点分类
#[test]
fn stop_error_kind_annoted_in_metadata_when_message() {
    let result = consume(
        vec![
            text_delta("部分输出"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("rate limit".into()),
                error_kind: Some(ProviderErrorKind::RateLimit),
                usage: None,
            },
        ],
        false,
    );
    assert!(result.response.is_message());
    assert_eq!(result.metadata["providerErrorKind"], "rate-limit");
    assert_eq!(result.metadata["providerErrorRetryable"], true);
}

/// F3 盲区 #4 反向：流内 error 帧为不可重试文案（如认证失败）→ 仍
/// 分类为 Auth 不可重试（分类管线全量生效，不只放行重试类）
#[test]
fn in_stream_auth_message_stays_not_retryable() {
    let result = consume(
        vec![stop_with(
            StopReason::Error,
            Some("invalid api key: authentication failed"),
            None,
        )],
        false,
    );
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Auth);
    assert!(!classified.retryable, "认证失败不得重试");
}

/// abort 有内容 → 保留部分，stopReason=aborted（partial salvage）
#[test]
fn abort_with_content_keeps_partial_message() {
    let result = consume(vec![text_delta("已流出的部分")], true);
    assert_eq!(
        result.response,
        ProviderOutput::message("已流出的部分", vec![])
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(result.metadata["aborted"], true);
}

/// abort 无内容 → StreamError（Aborted 类，不可重试）
#[test]
fn abort_without_content_yields_stream_error() {
    let result = consume(Vec::<ProviderStreamEvent>::new(), true);
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Aborted);
    assert!(!classified.retryable);
    assert_eq!(classified.message, "aborted");
}

/// abort 无内容且流中有 error 文案 → StreamError 携带该文案
#[test]
fn abort_without_content_uses_collected_error_message() {
    let result = consume(vec![stop_with(StopReason::Error, Some("boom"), None)], true);
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("应为 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Aborted);
    assert_eq!(classified.message, "boom");
}

/// 空流（无任何事件）→ Empty（02 §一.3）
#[test]
fn empty_stream_yields_empty() {
    let result = consume(Vec::<ProviderStreamEvent>::new(), false);
    assert_eq!(result.response, ProviderOutput::Empty);
    assert!(result.diagnostics.is_empty());
}

/// 有 stop 但无 block 无 error → 仍为空响应
#[test]
fn stop_without_content_yields_empty() {
    let result = consume(vec![stop(StopReason::Stop)], false);
    assert_eq!(result.response, ProviderOutput::Empty);
}

/// stop.reason=length → Message + stopReason=length（供上层 length 恢复阶梯）
#[test]
fn length_stop_yields_message_with_length() {
    let result = consume(vec![text_delta("长回复"), stop(StopReason::Length)], false);
    assert_eq!(result.response, ProviderOutput::message("长回复", vec![]));
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Length));
    assert_eq!(result.metadata["providerFinishReason"], "length");
}

/// 有 tool-call 时 stopReason=tool-call 优先于 length（对齐 TS 优先级）
#[test]
fn tool_call_wins_over_length_stop() {
    let result = consume(
        vec![tool_call(Some("c1"), "read_file"), stop(StopReason::Length)],
        false,
    );
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::ToolCall));
}
