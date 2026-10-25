use std::time::Duration;
use tokio::sync::mpsc;

use super::{ChannelReader, ErrorReader};
use crate::sse::frame::SseParser;
use crate::sse::reader::{read_sse, AbortFlag, SseReadError, StreamReadOptions};

#[tokio::test]
async fn first_byte_timeout_raises_error() {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let _keep_open = tx; // 不关闭通道 → 读取挂起直到超时
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        first_byte_timeout: Some(Duration::from_millis(50)),
        ..StreamReadOptions::default()
    };
    let error = read_sse(&mut reader, &mut parser, &options, &mut abort)
        .await
        .unwrap_err();
    assert!(
        matches!(error, SseReadError::FirstByteTimeout(_)),
        "应上抛超时而非静默结束"
    );
}

#[tokio::test]
async fn idle_timeout_raises_error_after_first_chunk() {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
    let _keep_open = tx;
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        idle_timeout: Some(Duration::from_millis(50)),
        ..StreamReadOptions::default()
    };
    let error = read_sse(&mut reader, &mut parser, &options, &mut abort)
        .await
        .unwrap_err();
    assert!(
        matches!(error, SseReadError::IdleTimeout(_)),
        "首块之后空闲应上抛 idle 超时"
    );
}

#[tokio::test]
async fn abort_interrupts_pending_read() {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let _keep_open = tx;
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions::default();
    let handle =
        tokio::spawn(async move { read_sse(&mut reader, &mut parser, &options, &mut abort).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    flag.abort();
    let error = handle.await.unwrap().unwrap_err();
    assert!(
        matches!(error, SseReadError::Aborted),
        "abort 应中断挂起 read 并以错误上抛"
    );
}

#[tokio::test]
async fn abort_before_start_returns_aborted() {
    let (flag, mut abort) = AbortFlag::new();
    flag.abort();
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    drop(tx);
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let error = read_sse(
        &mut reader,
        &mut parser,
        &StreamReadOptions::default(),
        &mut abort,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, SseReadError::Aborted));
}

#[tokio::test]
async fn abort_wins_over_ready_data() {
    // 数据与 abort 同时就绪时，abort 优先（biased 顺序）
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
    let _keep_open = tx;
    let (flag, mut abort) = AbortFlag::new();
    flag.abort();
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let error = read_sse(
        &mut reader,
        &mut parser,
        &StreamReadOptions::default(),
        &mut abort,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, SseReadError::Aborted));
}

#[tokio::test]
async fn transport_error_propagates() {
    let mut reader = ErrorReader;
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let error = read_sse(
        &mut reader,
        &mut parser,
        &StreamReadOptions::default(),
        &mut abort,
    )
    .await
    .unwrap_err();
    assert!(matches!(error, SseReadError::Transport(_)));
}

#[tokio::test]
async fn zero_timeout_is_treated_as_no_timeout() {
    // 对齐 normalizeStreamTimeoutMs：≤0 视为无超时
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
    drop(tx);
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        first_byte_timeout: Some(Duration::ZERO),
        idle_timeout: Some(Duration::ZERO),
        ..StreamReadOptions::default()
    };
    let output = read_sse(&mut reader, &mut parser, &options, &mut abort)
        .await
        .unwrap();
    assert_eq!(output.frames.len(), 1);
}
