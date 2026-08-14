//! 传输层（任务书 B2.3；02-provider-semantics.md §六.1-2）
//!
//! reqwest Response 的 bytes_stream 适配为 [ChunkReader]，复用 sse::reader 的
//! 双段超时 / abort / 诊断逻辑。分帧与流控与 reqwest 完全解耦（02 §六.1），
//! reqwest 侧仅做适配，测试可用本地 TCP + reqwest 走完整链路。

use std::pin::Pin;

use async_trait::async_trait;
use futures_util::{Stream, StreamExt};

use crate::sse::frame::SseParser;
use crate::sse::reader::{
    read_sse, read_sse_stream, AbortHandle, ChunkReader, SseReadError, StreamReadOptions,
    StreamReadOutput,
};

pub use crate::sse::reader::StreamFrameEvent;

/// reqwest 响应体字节流适配器（bytes_stream → `Vec<u8>` 块）
struct ReqwestChunkReader {
    stream: Pin<Box<dyn Stream<Item = Result<Vec<u8>, reqwest::Error>> + Send>>,
}

impl ReqwestChunkReader {
    /// 包装 reqwest Response 的字节流
    fn new(response: reqwest::Response) -> Self {
        let stream = response
            .bytes_stream()
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()));
        Self {
            stream: Box::pin(stream),
        }
    }
}

#[async_trait]
impl ChunkReader for ReqwestChunkReader {
    type Error = reqwest::Error;

    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, reqwest::Error> {
        match self.stream.next().await {
            Some(Ok(bytes)) => Ok(Some(bytes)),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        }
    }
}

/// 读取一次 SSE 响应流：双段超时 + abort + 诊断（任务书 B2.3 验收）
///
/// 调用方需自行处理响应状态码（非 2xx 由上层分类，02 §四.1）；
/// 超时/abort 以 [SseReadError] 上抛，绝不静默结束（02 §六.2）。
pub async fn read_stream(
    response: reqwest::Response,
    options: &StreamReadOptions,
    abort: &mut AbortHandle,
) -> Result<StreamReadOutput, SseReadError<reqwest::Error>> {
    let mut reader = ReqwestChunkReader::new(response);
    let mut parser = SseParser::new();
    read_sse(&mut reader, &mut parser, options, abort).await
}

/// 增量帧流（T09.1 真增量：逐帧/逐诊断异步产出，边收边发）
///
/// 与 [read_stream] 的语义差异：读取不再收完才返回——每块字节到达即分帧，
/// 完整帧立即成为流条目（首帧到达即产出首帧，不等流结束）；sse-first-byte /
/// stream-end 诊断按发生顺序逐条流出；读取错误（超时 / abort / 传输 / 分帧）
/// 以 `Err` 条目终止流（之后流立即结束，02 §六.2）。
///
/// 参数为 owned 形态（[StreamReadOptions] 可 Clone，[AbortHandle] 可 Clone）：
/// 返回流 `'static`，可跨调用方持有；调用方取消 = drop 流（读取随流丢弃）。
pub fn stream_frames(
    response: reqwest::Response,
    options: StreamReadOptions,
    abort: AbortHandle,
) -> Pin<Box<dyn Stream<Item = Result<StreamFrameEvent, SseReadError<reqwest::Error>>> + Send>> {
    read_sse_stream(ReqwestChunkReader::new(response), options, abort)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use conex_types::tool::ProviderDiagnosticPhase;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::*;
    use crate::sse::reader::{AbortFlag, StreamDiagnosticContext};

    /// 本地 TCP 服务模拟 SSE 响应（chunked 编码；可选首字节延迟）
    async fn serve_sse(body_chunks: Vec<Vec<u8>>, header_delay: Option<Duration>) -> u16 {
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
            if let Some(delay) = header_delay {
                tokio::time::sleep(delay).await;
            }
            for chunk in body_chunks {
                let framed = format!(
                    "{:x}\r\n{}\r\n",
                    chunk.len(),
                    String::from_utf8_lossy(&chunk)
                );
                let _ = socket.write_all(framed.as_bytes()).await;
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
            let _ = socket.shutdown().await;
        });
        port
    }

    /// 本地 TCP 服务只发响应头、不发正文（模拟挂起的流）
    async fn serve_sse_headers_only() -> u16 {
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
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        port
    }

    /// 本地 TCP 服务：分块慢速发送（每块间隔 `chunk_delay`，模拟慢流）
    async fn serve_sse_chunked_delayed(
        body_chunks: Vec<Vec<u8>>,
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
            for chunk in body_chunks {
                if let Some(delay) = chunk_delay {
                    tokio::time::sleep(delay).await;
                }
                let framed = format!(
                    "{:x}\r\n{}\r\n",
                    chunk.len(),
                    String::from_utf8_lossy(&chunk)
                );
                let _ = socket.write_all(framed.as_bytes()).await;
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
            let _ = socket.shutdown().await;
        });
        port
    }

    async fn get(port: u16) -> reqwest::Response {
        let client = reqwest::Client::new();
        client
            .get(format!("http://127.0.0.1:{port}/stream"))
            .send()
            .await
            .unwrap()
    }

    fn data_of(frames: &[crate::sse::SseFrame], index: usize) -> &str {
        frames[index].data.as_deref().unwrap_or("<无 data>")
    }

    #[tokio::test]
    async fn streams_over_reqwest_with_diagnostics() {
        let body =
            "data: {\"role\":\"assistant\",\"content\":\"你好\"}\n\ndata: {\"content\":\"世界\"}\n\n";
        let port = serve_sse(
            vec![body.as_bytes().to_vec()],
            Some(Duration::from_millis(20)),
        )
        .await;
        let response = get(port).await;
        assert_eq!(response.status(), 200);

        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_secs(5)),
            idle_timeout: Some(Duration::from_secs(5)),
            diagnostics: Some(StreamDiagnosticContext {
                provider_id: Some("local-test".into()),
                url: Some("http://127.0.0.1/stream".into()),
                ..StreamDiagnosticContext::default()
            }),
        };
        let output = read_stream(response, &options, &mut abort).await.unwrap();

        assert_eq!(output.frames.len(), 2);
        assert_eq!(
            data_of(&output.frames, 0),
            "{\"role\":\"assistant\",\"content\":\"你好\"}"
        );
        assert_eq!(data_of(&output.frames, 1), "{\"content\":\"世界\"}");
        assert_eq!(output.diagnostics.len(), 2);
        assert_eq!(
            output.diagnostics[0].phase,
            ProviderDiagnosticPhase::SseFirstByte
        );
        assert_eq!(
            output.diagnostics[0].provider_id.as_deref(),
            Some("local-test")
        );
        assert_eq!(
            output.diagnostics[1].phase,
            ProviderDiagnosticPhase::StreamEnd
        );
        assert!(output.chunks >= 1);
        assert!(output.bytes > 0);
    }

    #[tokio::test]
    async fn first_byte_timeout_propagates_as_error() {
        let port = serve_sse_headers_only().await;
        let response = get(port).await;

        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_millis(150)),
            idle_timeout: None,
            diagnostics: None,
        };
        let error = read_stream(response, &options, &mut abort)
            .await
            .unwrap_err();
        assert!(
            matches!(error, SseReadError::FirstByteTimeout(_)),
            "首字节超时必须以错误上抛而非静默结束"
        );
    }

    #[tokio::test]
    async fn abort_interrupts_pending_read() {
        let port = serve_sse_headers_only().await;
        let response = get(port).await;

        let (flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions::default();
        let handle = tokio::spawn(async move { read_stream(response, &options, &mut abort).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        flag.abort();
        let error = handle.await.unwrap().unwrap_err();
        assert!(
            matches!(error, SseReadError::Aborted),
            "abort 应中断挂起 read 并 cancel"
        );
    }

    #[tokio::test]
    async fn done_sentinel_ends_reqwest_stream() {
        let body = "data: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\":2}\n\n";
        // 小延迟：等服务端先写完请求交互，避免连接在请求头未发完前被关闭
        let port = serve_sse(
            vec![body.as_bytes().to_vec()],
            Some(Duration::from_millis(30)),
        )
        .await;
        let response = get(port).await;

        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_secs(5)),
            idle_timeout: Some(Duration::from_secs(5)),
            diagnostics: Some(StreamDiagnosticContext::default()),
        };
        let output = read_stream(response, &options, &mut abort).await.unwrap();
        assert_eq!(output.frames.len(), 1, "[DONE] 后内容被丢弃");
        assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
        assert_eq!(
            output.diagnostics.len(),
            2,
            "[DONE] 路径产出 stream-end 诊断"
        );
    }

    /// T09.1：stream_frames 真增量——首帧到达即产出（不等流结束），
    /// 诊断按发生顺序逐条流出（first-byte 先行、stream-end 收尾）
    #[tokio::test]
    async fn stream_frames_yields_frames_incrementally() {
        // 3 个分块：首帧后延迟再发后续帧（总时长 ≈ 200ms），首帧应立即可用
        let body_chunks = vec![
            "data: {\"role\":\"assistant\",\"content\":\"你好\"}\n\n"
                .as_bytes()
                .to_vec(),
            "data: {\"content\":\"，世界\"}\n\n".as_bytes().to_vec(),
            "data: [DONE]\n\n".as_bytes().to_vec(),
        ];
        let port = serve_sse_chunked_delayed(body_chunks, Some(Duration::from_millis(100))).await;
        let response = get(port).await;

        let (_flag, abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_secs(5)),
            idle_timeout: Some(Duration::from_secs(5)),
            diagnostics: Some(StreamDiagnosticContext {
                provider_id: Some("local-test".into()),
                ..StreamDiagnosticContext::default()
            }),
        };
        let mut stream = stream_frames(response, options, abort);

        // 首个条目应为 sse-first-byte 诊断（首块到达即产出）
        let first = stream.next().await.expect("首条目").expect("首条目无错误");
        assert!(matches!(
            first,
            StreamFrameEvent::Diagnostic(d) if d.phase == ProviderDiagnosticPhase::SseFirstByte
        ));
        // 第二条目为首帧（紧随其后，未等整个流读完）
        let second = stream.next().await.expect("首帧").expect("首帧无错误");
        let StreamFrameEvent::Frame(frame) = second else {
            panic!("期望帧，得到诊断");
        };
        assert_eq!(
            frame.data.as_deref(),
            Some("{\"role\":\"assistant\",\"content\":\"你好\"}")
        );
        // 其余条目：第二帧 → stream-end 诊断
        let mut remaining = Vec::new();
        while let Some(item) = stream.next().await {
            remaining.push(item.expect("后续条目无错误"));
        }
        assert_eq!(remaining.len(), 2, "第二帧 + stream-end 诊断");
        assert!(matches!(
            &remaining[0],
            StreamFrameEvent::Frame(f) if f.data.as_deref() == Some("{\"content\":\"，世界\"}")
        ));
        assert!(matches!(
            &remaining[1],
            StreamFrameEvent::Diagnostic(d) if d.phase == ProviderDiagnosticPhase::StreamEnd
        ));
    }

    /// T09.1：stream_frames 读取错误以 Err 条目终止流（之后立即结束，
    /// 对齐 02 §六.2 绝不静默结束）
    #[tokio::test]
    async fn stream_frames_read_error_terminates_stream() {
        // 只发响应头后挂起（idle 超时触发读取错误）
        let port = serve_sse_headers_only().await;
        let response = get(port).await;

        let (_flag, abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_millis(150)),
            idle_timeout: None,
            diagnostics: None,
        };
        let mut stream = stream_frames(response, options, abort);
        let error = stream
            .next()
            .await
            .expect("错误应作为 Err 条目产出")
            .expect_err("首字节超时应为 Err 条目");
        assert!(matches!(error, SseReadError::FirstByteTimeout(_)));
        // Err 条目之后流立即结束
        assert!(stream.next().await.is_none(), "Err 后流应立即结束");
    }

    /// T09.1：stream_frames 收集等价于 read_stream（收集模式的回归锚点）
    #[tokio::test]
    async fn stream_frames_collect_matches_read_stream() {
        let body =
            "data: {\"role\":\"assistant\",\"content\":\"你好\"}\n\ndata: {\"content\":\"世界\"}\n\n";
        let port = serve_sse(
            vec![body.as_bytes().to_vec()],
            Some(Duration::from_millis(20)),
        )
        .await;
        let response = get(port).await;

        let (_flag, abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_secs(5)),
            idle_timeout: Some(Duration::from_secs(5)),
            diagnostics: None,
        };
        let mut stream = stream_frames(response, options, abort);
        let mut frames = Vec::new();
        while let Some(item) = stream.next().await {
            if let StreamFrameEvent::Frame(frame) = item.expect("无错误") {
                frames.push(frame);
            }
        }
        assert_eq!(frames.len(), 2);
        assert_eq!(
            data_of(&frames, 0),
            "{\"role\":\"assistant\",\"content\":\"你好\"}"
        );
        assert_eq!(data_of(&frames, 1), "{\"content\":\"世界\"}");
    }
}
