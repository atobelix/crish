//! PE-09 T09.7 首 token 延迟测量（agent-provider 传输 + 解析侧）
//!
//! 真实本地 TCP mock SSE（复用 transport tests 的 serve_sse 模式）：
//! 慢速分块——首 token 500ms 延迟、总时长 ≈ 5s。经 [stream_frames] +
//! [ChatCompletionsParser] 测量首条 TextDelta 到达时间。
//!
//! - **600ms 硬断言（F1）**：首条 TextDelta **< 600ms**（改造前 ≈ 5s
//!   整流读完才返回，本测试即增量帧流的守门锚点）；
//! - **观测式**：`--nocapture` 打印各阶段耗时（首字节 / 首帧 / 首事件），
//!   作为回归看板项记入 `docs/rust-rewrite/audits/PE-perf-baseline.md`；
//!   300ms 内部基准（流产出 → 事件桥）的 Rust 侧处理耗时在
//!   `crates/session-loop/tests/ttfb.rs` 覆盖（此处为首事件到达全链路）。
//!
//! 运行：`cargo test -p agent-provider --test ttfb_measure -- --nocapture`

use std::time::{Duration, Instant};

use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::sse::{AbortFlag, StreamReadOptions};
use agent_provider::transport::{stream_frames, StreamFrameEvent};
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

/// 本地 TCP mock SSE：慢速分块发送（首块前延时 `first_chunk_delay`，
/// 之后每块间隔 `chunk_delay`；块内容为 chat-completions 增量帧）
async fn serve_sse_chunked_delayed(
    body_chunks: Vec<Vec<u8>>,
    first_chunk_delay: Option<Duration>,
    chunk_delay: Option<Duration>,
) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let headers = concat!(
            "HTTP/1.1 200 OK\r\n",
            "content-type: text/event-stream\r\n",
            "transfer-encoding: chunked\r\n",
            "connection: close\r\n",
            "\r\n"
        );
        let _ = socket.write_all(headers.as_bytes()).await;
        if let Some(delay) = first_chunk_delay {
            tokio::time::sleep(delay).await;
        }
        for (i, chunk) in body_chunks.iter().enumerate() {
            if i > 0 {
                if let Some(delay) = chunk_delay {
                    tokio::time::sleep(delay).await;
                }
            }
            let framed = format!("{:x}\r\n{}\r\n", chunk.len(), String::from_utf8_lossy(chunk));
            let _ = socket.write_all(framed.as_bytes()).await;
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
        let _ = socket.shutdown().await;
    });
    port
}

/// 慢速流分块：首块 500ms 后到达，之后每 1.125s 一块，总时长 ≈ 5s
fn slow_chunks() -> Vec<Vec<u8>> {
    [
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"第一个 token\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，第二个\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，第三个\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，第四个\"},\"finish_reason\":null}]}\n\n",
        "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    ]
    .iter()
    .map(|s| s.as_bytes().to_vec())
    .collect()
}

/// 600ms 硬断言（F1）：本地 TCP mock SSE 慢速分块（首 token 500ms、
/// 总时长 5s）下，首条 TextDelta 到达 < 600ms；观测各阶段耗时。
#[tokio::test]
async fn first_text_delta_arrives_under_600ms_from_slow_mock_sse() {
    let port = serve_sse_chunked_delayed(
        slow_chunks(),
        Some(Duration::from_millis(500)),
        Some(Duration::from_millis(1125)),
    )
    .await;

    let started = Instant::now();
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{port}/stream"))
        .send()
        .await
        .expect("连接 mock SSE");
    assert_eq!(response.status(), 200);

    let (_flag, abort) = AbortFlag::new();
    let options = StreamReadOptions {
        first_byte_timeout: Some(Duration::from_secs(5)),
        idle_timeout: Some(Duration::from_secs(5)),
        // 开启诊断：sse-first-byte 诊断事件用于观测首字节到达时刻
        diagnostics: Some(agent_provider::sse::StreamDiagnosticContext {
            provider_id: Some("local-test".into()),
            ..agent_provider::sse::StreamDiagnosticContext::default()
        }),
    };
    let mut stream = stream_frames(response, options, abort);
    let mut parser = ChatCompletionsParser::new();

    // 逐帧推进，记录首字节 / 首帧 / 首事件到达时刻
    let mut first_byte_at: Option<Instant> = None;
    let mut first_frame_at: Option<Instant> = None;
    let mut first_event_at: Option<Instant> = None;
    let mut delta_count = 0usize;
    while let Some(item) = stream.next().await {
        let now = Instant::now();
        match item.expect("读取无错误") {
            StreamFrameEvent::Frame(frame) => {
                first_frame_at.get_or_insert(now);
                for event in parser.push_frame(&frame).expect("解析帧") {
                    if matches!(event, agent_provider::events::ProviderStreamEvent::TextDelta { .. }) {
                        first_event_at.get_or_insert(now);
                        delta_count += 1;
                    }
                }
            }
            StreamFrameEvent::Diagnostic(_) => {
                first_byte_at.get_or_insert(now);
            }
        }
    }
    for event in parser.finish().expect("收尾解析") {
        if matches!(event, agent_provider::events::ProviderStreamEvent::TextDelta { .. }) {
            first_event_at.get_or_insert(Instant::now());
            delta_count += 1;
        }
    }

    // 阶段观测（回归看板项）
    let to_first_byte = first_byte_at
        .map(|t| t.duration_since(started))
        .unwrap_or_default();
    let to_first_frame = first_frame_at
        .map(|t| t.duration_since(started))
        .unwrap_or_default();
    let to_first_event = first_event_at
        .map(|t| t.duration_since(started))
        .expect("慢速流应产出首条 TextDelta");
    println!("[T09.7 首 token 观测] mock SSE 慢速分块：请求→首字节 {to_first_byte:?}、请求→首帧 {to_first_frame:?}、请求→首事件 {to_first_event:?}");
    println!(
        "[T09.7 首 token 观测] 流收完总时长 {:?}（≈ 5s 全时长）",
        started.elapsed()
    );

    // F1 硬断言：首条 TextDelta < 600ms（首 token 500ms 延迟 + 处理开销）
    assert!(
        to_first_event < Duration::from_millis(600),
        "首条 TextDelta 应 < 600ms，实际 {to_first_event:?}（全量缓冲路径 ≈ 5s）"
    );
    // 增量性：首事件即首个 token（边收边发，非整块全文）
    assert_eq!(delta_count, 4, "四个 token 逐个解析产出");
}
