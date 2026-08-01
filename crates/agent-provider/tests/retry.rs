//! B2.10 重试端到端测试（05 §5.2 retry::backoff）
//!
//! mock 按脚本分叉状态码：429+Retry-After → 退避重试成功；5xx 连续 →
//! 重试耗尽/预算耗尽报错。断言请求次数（05 §4.6 闭包计数分支模式）。
//! 用短延迟策略（base 5-10ms）加速，避免真实退避拖慢测试。

mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_provider::error::{
    classify_provider_error, source_from_reqwest_error, source_from_sse_read_error,
    ProviderError,
};
use agent_provider::retry::{provider_stream, RetryPolicy, RetryState, StreamAttempt, TokioSleeper};
use agent_provider::sse::{AbortFlag, ChunkReader};
use common::{MockFrame, MockResponse, MockServer};
use serde_json::json;

/// 单次真实 HTTP 流尝试（请求 → 分类错误 → StreamAttempt），模拟 provider_stream 调用方
async fn attempt_chat_stream(addr: SocketAddr) -> StreamAttempt {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{addr}/v1/chat/completions"))
        .json(&json!({ "messages": [{ "role": "user", "content": "你好" }] }))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return StreamAttempt {
                frames: Vec::new(),
                error: Some(classify_provider_error(
                    None,
                    None,
                    Some(source_from_reqwest_error(&error)),
                    None,
                )),
                produced_content: false,
            };
        }
    };
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.text().await.unwrap_or_default();
        return StreamAttempt {
            frames: Vec::new(),
            error: Some(classify_provider_error(
                Some(status),
                Some(&body),
                None,
                retry_after.as_deref(),
            )),
            produced_content: false,
        };
    }
    let (_flag, mut abort) = AbortFlag::new();
    let options = agent_provider::sse::StreamReadOptions {
        first_byte_timeout: Some(Duration::from_secs(5)),
        idle_timeout: Some(Duration::from_secs(5)),
        diagnostics: None,
    };
    match agent_provider::transport::read_stream(response, &options, &mut abort).await {
        Ok(output) => StreamAttempt {
            frames: output.frames,
            error: None,
            produced_content: false,
        },
        Err(error) => StreamAttempt {
            frames: Vec::new(),
            error: Some(classify_provider_error(
                None,
                None,
                Some(source_from_sse_read_error(&error)),
                None,
            )),
            produced_content: false,
        },
    }
}

/// 手动驱动读取循环（对齐 transport 语义但保留截断前的帧）：
/// 流正常结束 → 成功；流被截断 → 返回已分帧帧 + Network 错误
async fn read_stream_incremental(
    response: reqwest::Response,
) -> (Vec<agent_provider::sse::SseFrame>, Option<ProviderError>) {
    let mut reader = common::ReqwestChunkReader::new(response);
    let mut parser = agent_provider::sse::SseParser::new();
    let mut frames = Vec::new();
    let result = loop {
        match reader.next_chunk().await {
            Ok(Some(bytes)) => frames.extend(parser.push(&bytes).expect("分帧")),
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        }
    };
    match result {
        Ok(()) => (frames, None),
        Err(error) => (
            frames,
            Some(classify_provider_error(
                None,
                None,
                Some(source_from_reqwest_error(&error)),
                None,
            )),
        ),
    }
}

/// 单次尝试：增量读取，截断前已产出正文时 produced_content=true
/// （02 §六.7：流已产出内容时中途错误不重试）
async fn attempt_stream_with_partial_detection(addr: SocketAddr) -> StreamAttempt {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{addr}/v1/chat/completions"))
        .json(&json!({ "messages": [{ "role": "user", "content": "你好" }] }))
        .send()
        .await
        .expect("请求发送");
    let (frames, error) = read_stream_incremental(response).await;
    let produced_content = error.is_some()
        && frames
            .iter()
            .any(|frame| frame.data.as_deref().unwrap_or("").contains("content"));
    StreamAttempt {
        frames,
        error,
        produced_content,
    }
}

/// 短延迟重试策略（加速测试：基数 5ms、封顶 50ms、预算 60s）
fn fast_policy(max_retries: u32) -> RetryPolicy {
    RetryPolicy {
        max_retries,
        base_delay_ms: 5,
        max_delay_ms: 50,
        total_budget_ms: 60_000,
    }
}

/// 429 + Retry-After → 退避重试后成功（请求次数 = 2）
#[tokio::test(flavor = "multi_thread")]
async fn rate_limit_with_retry_after_backs_off_then_succeeds() {
    let counter = Arc::new(AtomicU32::new(0));
    let attempts = Arc::clone(&counter);
    let server = MockServer::start(move |_request| {
        let n = attempts.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            // 首次：429 + Retry-After
            MockResponse::Plain {
                status: 429,
                headers: vec![("retry-after".to_string(), "1".to_string())],
                body: r#"{"error":{"message":"rate limit exceeded"}}"#.to_string(),
            }
        } else {
            // 重试：成功 SSE 流
            MockResponse::Sse {
                frames: common::chat_ok_frames("重试成功"),
                interrupt_after: None,
            }
        }
    })
    .await;

    let policy = fast_policy(3);
    let (_flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let mut state = RetryState::new();
    let started = tokio::time::Instant::now();
    let frames = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let addr = server.addr;
        async move { attempt_chat_stream(addr).await }
    })
    .await
    .expect("退避重试后应成功");
    let elapsed = started.elapsed();

    assert_eq!(counter.load(Ordering::SeqCst), 2, "应恰好请求 2 次");
    assert_eq!(state.retries, 1);
    assert!(!frames.is_empty(), "成功流应携带帧");
    // Retry-After:1s 与退避取大后被 max_delay=50ms 钳制：
    // 实际等待应明显大于无 Retry-After 时的 5ms 基数
    assert!(
        elapsed >= Duration::from_millis(40),
        "应等待钳制后的 50ms，实际 {elapsed:?}"
    );
}

/// 5xx 连续 → 达到 max_retries 后报错（初始 1 次 + 2 次重试）
#[tokio::test(flavor = "multi_thread")]
async fn server_errors_stop_after_max_retries() {
    let counter = Arc::new(AtomicU32::new(0));
    let attempts = Arc::clone(&counter);
    let server = MockServer::start(move |_request| {
        attempts.fetch_add(1, Ordering::SeqCst);
        MockResponse::Plain {
            status: 503,
            headers: Vec::new(),
            body: r#"{"error":{"message":"server error"}}"#.to_string(),
        }
    })
    .await;

    let policy = fast_policy(2);
    let (_flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let addr = server.addr;
        async move { attempt_chat_stream(addr).await }
    })
    .await
    .expect_err("5xx 连续应最终报错");

    assert!(matches!(
        error,
        ProviderError::Server { status: Some(503) }
    ));
    assert_eq!(counter.load(Ordering::SeqCst), 3, "初始 1 次 + 2 次重试");
    assert_eq!(state.retries, 2);
}

/// 5xx 连续 → 总预算耗尽提前终止（远小于 max_retries=10 次）
#[tokio::test(flavor = "multi_thread")]
async fn retry_budget_exhaustion_stops_retrying() {
    let counter = Arc::new(AtomicU32::new(0));
    let attempts = Arc::clone(&counter);
    let server = MockServer::start(move |_request| {
        attempts.fetch_add(1, Ordering::SeqCst);
        MockResponse::Plain {
            status: 500,
            headers: Vec::new(),
            body: "boom".to_string(),
        }
    })
    .await;

    // 总预算 15ms、基数 10ms：两次退避即超出预算
    let policy = RetryPolicy {
        max_retries: 10,
        base_delay_ms: 10,
        max_delay_ms: 20,
        total_budget_ms: 15,
    };
    let (_flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let addr = server.addr;
        async move { attempt_chat_stream(addr).await }
    })
    .await
    .expect_err("预算耗尽应报错");

    assert!(matches!(error, ProviderError::Server { .. }));
    let count = counter.load(Ordering::SeqCst);
    assert!(
        (2..=4).contains(&count),
        "预算应在两三次尝试内终止，实际 {count}"
    );
    assert_eq!(state.retries, count - 1);
}

/// 不可重试错误（401）不进入重试循环，仅请求一次
#[tokio::test(flavor = "multi_thread")]
async fn auth_error_is_not_retried() {
    let counter = Arc::new(AtomicU32::new(0));
    let attempts = Arc::clone(&counter);
    let server = MockServer::start(move |_request| {
        attempts.fetch_add(1, Ordering::SeqCst);
        MockResponse::Plain {
            status: 401,
            headers: Vec::new(),
            body: r#"{"error":{"message":"unauthorized"}}"#.to_string(),
        }
    })
    .await;

    let policy = fast_policy(3);
    let (_flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let addr = server.addr;
        async move { attempt_chat_stream(addr).await }
    })
    .await
    .expect_err("401 不可重试应直接上抛");

    assert!(matches!(error, ProviderError::Auth { status: Some(401) }));
    assert_eq!(counter.load(Ordering::SeqCst), 1, "auth 错误不得重试");
    assert_eq!(state.retries, 0);
}

/// 流已产出内容时中途错误不重试（02 §六.7 语义），请求仅一次
#[tokio::test(flavor = "multi_thread")]
async fn mid_stream_disconnect_after_content_is_not_retried() {
    let counter = Arc::new(AtomicU32::new(0));
    let attempts = Arc::clone(&counter);
    let server = MockServer::start(move |_request| {
        attempts.fetch_add(1, Ordering::SeqCst);
        MockResponse::Sse {
            // 发完 1 帧正文后断开：内容已产出，不得重试
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

    let policy = fast_policy(3);
    let (_flag, abort) = AbortFlag::new();
    let mut sleeper = TokioSleeper::new(abort);
    let mut state = RetryState::new();
    let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
        let addr = server.addr;
        async move { attempt_stream_with_partial_detection(addr).await }
    })
    .await
    .expect_err("内容已产出后的中断应上抛而非重试");

    assert!(matches!(error, ProviderError::Network { .. }));
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "已产出内容不得再重试"
    );
    assert_eq!(state.retries, 0);
}
