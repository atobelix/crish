//! B2.10 错误分类端到端测试（05 §5.2 error::classify）
//!
//! mock 返回各状态码/中断场景，经真实 HTTP 链路后走 classify_provider_error
//! 分类管线断言。语义对齐 error-classifier.test.ts:5-416 的状态码表行
//! （401/403/429/400 context_length/500/连接失败/流中断）。

mod common;

use std::time::Duration;

use agent_provider::error::{
    classify_provider_error, source_from_reqwest_error, source_from_sse_read_error,
    NetworkSourceKind, ProviderError, ProviderSourceError,
};
use agent_provider::sse::{AbortFlag, StreamReadOptions};
use common::{MockFrame, MockResponse, MockServer};
use conex_types::error::ProviderErrorKind;
use serde_json::json;

/// 起一个返回固定状态码 + 响应头/体的 mock，并完成一次 POST
async fn plain_response(
    status: u16,
    body: &str,
    extra_headers: Vec<(String, String)>,
) -> (u16, String, reqwest::header::HeaderMap) {
    let body = body.to_string();
    let server = MockServer::start(move |_request| MockResponse::Plain {
        status,
        headers: extra_headers.clone(),
        body: body.clone(),
    })
    .await;
    common::fetch_plain(
        server.addr,
        "/v1/chat/completions",
        json!({ "messages": [] }),
    )
    .await
}

/// HTTP 401 → Auth（第 4 行，不可重试）
#[tokio::test(flavor = "multi_thread")]
async fn status_401_maps_to_auth() {
    let (status, body, _) =
        plain_response(401, r#"{"error":{"message":"unauthorized"}}"#, vec![]).await;
    let error = classify_provider_error(Some(status), Some(&body), None, None);
    assert_eq!(error, ProviderError::Auth { status: Some(401) });
    assert!(!error.is_retryable());
    assert_eq!(error.kind(), ProviderErrorKind::Auth);
}

/// HTTP 403 → Auth（403 网关 key 无效同判）
#[tokio::test(flavor = "multi_thread")]
async fn status_403_maps_to_auth() {
    let (status, body, _) =
        plain_response(403, r#"{"error":{"message":"forbidden"}}"#, vec![]).await;
    let error = classify_provider_error(Some(status), Some(&body), None, None);
    assert_eq!(error, ProviderError::Auth { status: Some(403) });
    assert!(!error.is_retryable());
}

/// HTTP 429 + Retry-After 头 → RateLimit（第 9 行，可重试，携带等待时长）
#[tokio::test(flavor = "multi_thread")]
async fn status_429_maps_to_rate_limit_with_retry_after() {
    let (status, body, headers) = plain_response(
        429,
        r#"{"error":{"message":"rate limit exceeded"}}"#,
        vec![("retry-after".to_string(), "3".to_string())],
    )
    .await;
    let retry_after = headers
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let error = classify_provider_error(Some(status), Some(&body), None, retry_after.as_deref());
    match error {
        ProviderError::RateLimit {
            status,
            retry_after,
        } => {
            assert_eq!(status, Some(429));
            assert_eq!(retry_after, Some(Duration::from_secs(3)));
        }
        other => panic!("期望 RateLimit，得到 {other:?}"),
    }
    assert!(error.is_retryable());
}

/// HTTP 400 + context_length_exceeded → ContextLength（第 7 行，可重试）
#[tokio::test(flavor = "multi_thread")]
async fn status_400_context_length_maps_to_context_length() {
    let (status, body, _) = plain_response(
        400,
        "context_length_exceeded: maximum context length is 128000 tokens",
        vec![],
    )
    .await;
    let error = classify_provider_error(Some(status), Some(&body), None, None);
    assert_eq!(error, ProviderError::ContextLength { status: Some(400) });
    assert!(error.is_retryable(), "分类层 context_length 标记可重试");
}

/// HTTP 500 → Server（第 10 行，可重试；响应体随 body_hint 透传）
#[tokio::test(flavor = "multi_thread")]
async fn status_500_maps_to_server() {
    let (status, body, _) = plain_response(500, "internal server error", vec![]).await;
    let error = classify_provider_error(Some(status), Some(&body), None, None);
    assert_eq!(
        error,
        ProviderError::Server {
            status: Some(500),
            body_hint: Some("internal server error".into())
        }
    );
    assert!(error.is_retryable());
}

/// 连接失败（端口关闭）→ Network（第 12 行，02 §五 #11 必须可重试）
#[tokio::test(flavor = "multi_thread")]
async fn connection_refused_maps_to_network() {
    // 绑定后立即丢弃监听器：端口已关闭 → 建连失败
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定");
    let port = listener.local_addr().expect("读取地址").port();
    drop(listener);

    let error = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .body("{}")
        .send()
        .await
        .expect_err("端口已关闭应建连失败");
    let source = source_from_reqwest_error(&error);
    let classified = classify_provider_error(None, None, Some(source), None);
    assert!(
        matches!(classified, ProviderError::Network { .. }),
        "建连失败应归 Network，得到 {classified:?}"
    );
    assert!(classified.is_retryable());
}

/// 流中途断开（SSE 发一半无终止块）→ Network/StreamInterrupted（可重试）
#[tokio::test(flavor = "multi_thread")]
async fn mid_stream_disconnect_maps_to_network() {
    let server = MockServer::start(|_request| {
        MockResponse::Sse {
            // 发完 1 帧后断开（不发终止块，模拟流中途中断）
            frames: vec![MockFrame::data(
                json!({
                    "choices": [{ "index": 0, "delta": { "content": "半句话" }, "finish_reason": null }],
                })
                .to_string(),
            )],
            interrupt_after: Some(1),
        }
    })
    .await;

    let response = reqwest::Client::new()
        .post(format!("http://{}/v1/chat/completions", server.addr))
        .json(&json!({ "messages": [] }))
        .send()
        .await
        .expect("请求发送");
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        first_byte_timeout: Some(Duration::from_secs(5)),
        idle_timeout: Some(Duration::from_secs(5)),
        diagnostics: None,
    };
    let error = agent_provider::transport::read_stream(response, &options, &mut abort)
        .await
        .expect_err("截断流应报错");
    let source = source_from_sse_read_error(&error);
    assert_eq!(source, ProviderSourceError::StreamInterrupted);
    let classified = classify_provider_error(None, None, Some(source), None);
    assert!(
        matches!(
            classified,
            ProviderError::Network {
                source_kind: NetworkSourceKind::StreamInterrupted
            }
        ),
        "流中断应归 Network/StreamInterrupted，得到 {classified:?}"
    );
    assert!(classified.is_retryable());
}
