//! B2.10 传输 abort 端到端测试（05 §5.2 transport::abort）
//!
//! mock 模拟挂起流/中途停顿流：abort 中断挂起 read；abort 前已到达的内容
//! 部分保留（对齐 provider-response-consumer.test.ts:16 `abort mid-stream with
//! text keeps partial message` 语义）。abort 不重试（02 §4.2 第 1 行）。

mod common;

use std::time::Duration;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::sse::{ChunkReader, SseParser, SseReadError};
use common::{MockFrame, MockResponse, MockServer};
use conex_types::error::ProviderErrorKind;
use conex_types::response::ProviderOutput;
use serde_json::json;

/// 流中途 abort → 中断挂起 read 并上抛 Aborted（绝不静默结束）
#[tokio::test(flavor = "multi_thread")]
async fn abort_interrupts_pending_stream_read() {
    let server = MockServer::start(|_request| MockResponse::Hang).await;
    let response = reqwest::Client::new()
        .get(format!("http://{}/v1/stream", server.addr))
        .send()
        .await
        .expect("请求发送");

    let (flag, mut abort) = agent_provider::sse::AbortFlag::new();
    let options = agent_provider::sse::StreamReadOptions::default();
    let handle = tokio::spawn(async move {
        agent_provider::transport::read_stream(response, &options, &mut abort).await
    });
    // 等服务端把响应头发完、读取挂起后再 abort
    tokio::time::sleep(Duration::from_millis(150)).await;
    flag.abort();
    let error = handle
        .await
        .expect("任务应结束")
        .expect_err("挂起 read 应被 abort 打断");
    assert!(
        matches!(error, SseReadError::Aborted),
        "abort 应上抛 Aborted，得到 {error:?}"
    );
}

/// abort 前已到达的内容部分保留：已分帧的帧 + 消费层 partial salvage
#[tokio::test(flavor = "multi_thread")]
async fn abort_after_content_keeps_partial_frames() {
    let server = MockServer::start(|_request| {
        MockResponse::SseThenHang {
            frames: vec![MockFrame::data_delayed(
                json!({
                    "choices": [{ "index": 0, "delta": { "content": "已流出的部分" }, "finish_reason": null }],
                })
                .to_string(),
                Duration::from_millis(50),
            )],
        }
    })
    .await;
    let response = reqwest::Client::new()
        .get(format!("http://{}/v1/stream", server.addr))
        .send()
        .await
        .expect("请求发送");

    // 自行驱动读取循环：边收块边分帧，abort 后保留已分帧内容
    let (flag, abort) = agent_provider::sse::AbortFlag::new();
    let mut reader = common::ReqwestChunkReader::new(response);
    let read_task = tokio::spawn(async move {
        let mut parser = SseParser::new();
        let mut frames = Vec::new();
        let mut aborted = false;
        loop {
            let mut abort_rx = abort.clone();
            tokio::select! {
                biased;
                _ = abort_rx.wait_abort() => {
                    aborted = true;
                    break;
                }
                chunk = reader.next_chunk() => match chunk {
                    Ok(Some(bytes)) => {
                        frames.extend(parser.push(&bytes).expect("分帧"));
                    }
                    Ok(None) | Err(_) => break,
                },
            }
        }
        (frames, aborted)
    });
    // 服务端 50ms 后发出首帧，150ms 时 abort（此时应已收到首帧并挂起等待下一块）
    tokio::time::sleep(Duration::from_millis(150)).await;
    flag.abort();
    let (frames, aborted) = read_task.await.expect("读取任务应结束");

    assert!(aborted, "abort 应中断挂起 read");
    assert_eq!(frames.len(), 1, "abort 前已到达的帧应被保留");
    assert!(frames[0]
        .data
        .as_deref()
        .unwrap_or("")
        .contains("已流出的部分"));

    // 部分保留的帧走解析 + 消费：有内容时 abort 保留部分并标 stopReason=aborted
    let mut chat = ChatCompletionsParser::new();
    let mut events = Vec::new();
    for frame in &frames {
        events.extend(chat.push_frame(frame).expect("帧处理"));
    }
    // 流被截断不调 finish（无完整终止），仅聚合已产出事件
    let result = consume(events, true);
    assert!(
        result.response.is_message(),
        "有内容时 abort 应保留部分消息，得到 {:?}",
        result.response
    );
    assert_eq!(result.response.text(), "已流出的部分");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Aborted));
    assert_eq!(result.metadata["aborted"], true);
}

/// abort 后无内容 → StreamError（Aborted 类，不可重试）
#[tokio::test(flavor = "multi_thread")]
async fn abort_without_content_yields_stream_error() {
    let server = MockServer::start(|_request| MockResponse::Hang).await;
    let response = reqwest::Client::new()
        .get(format!("http://{}/v1/stream", server.addr))
        .send()
        .await
        .expect("请求发送");

    let (flag, abort) = agent_provider::sse::AbortFlag::new();
    let mut reader = common::ReqwestChunkReader::new(response);
    let read_task = tokio::spawn(async move {
        let mut parser = SseParser::new();
        let mut frames = Vec::new();
        loop {
            let mut abort_rx = abort.clone();
            tokio::select! {
                biased;
                _ = abort_rx.wait_abort() => break,
                chunk = reader.next_chunk() => match chunk {
                    Ok(Some(bytes)) => {
                        frames.extend(parser.push(&bytes).expect("分帧"));
                    }
                    Ok(None) | Err(_) => break,
                },
            }
        }
        frames
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    flag.abort();
    let frames = read_task.await.expect("读取任务应结束");

    assert!(frames.is_empty(), "abort 前不应有内容");
    let events = {
        let mut chat = ChatCompletionsParser::new();
        let mut events = Vec::new();
        for frame in &frames {
            events.extend(chat.push_frame(frame).expect("帧处理"));
        }
        events
    };
    let result = consume(events, true);
    let ProviderOutput::StreamError { classified } = &result.response else {
        panic!("无内容 abort 应产出 StreamError，得到 {:?}", result.response);
    };
    assert_eq!(classified.kind, ProviderErrorKind::Aborted);
    assert!(!classified.retryable);
}
