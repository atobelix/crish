//! 本地 mock HTTP 服务器（任务书 B2.10 公用测试件；对齐 05 §4.7 的 e2e mock server）
//!
//! 用 tokio TcpListener 自建 mock，不引入 wiremock 等新依赖：
//! - 每个连接由 handler 闭包决定响应（按请求体/请求序号分叉，对齐 05 §4.6
//!   「闭包计数分支」模式）；
//! - 支持普通响应（任意状态码 + 自定义头）与 SSE chunked 流（分帧/帧间延迟/
//!   中途断开/发完挂起/首字节后挂起）；
//! - 记录每次请求的方法/路径/头/体，供断言使用；
//! - 全部测试文件经 `mod common;` 共用本模块。
//!
//! 说明：各测试二进制只用到本模块的子集，未用到的公开件按 dead_code 告警，
//! 统一放行（共享测试模块的常规做法）。

#![allow(dead_code)]

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_provider::sse::{AbortFlag, StreamReadOptions, StreamReadOutput};
use async_trait::async_trait;
use futures_util::{Stream, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// 已记录的请求（方法/路径/头/体）
#[derive(Debug, Clone, Default)]
pub struct RecordedRequest {
    /// HTTP 方法（如 POST）
    pub method: String,
    /// 请求路径（含查询串）
    pub path: String,
    /// 请求头（保留原始大小写）
    pub headers: Vec<(String, String)>,
    /// 请求体原文（UTF-8 无损转换）
    pub body: String,
}

impl RecordedRequest {
    /// 按名称（大小写不敏感）取首个请求头值
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find_map(|(n, v)| n.eq_ignore_ascii_case(name).then_some(v.as_str()))
    }

    /// 请求体是否包含指定子串
    pub fn body_contains(&self, needle: &str) -> bool {
        self.body.contains(needle)
    }
}

/// SSE 帧规格（data 为帧数据，delay 为发送前的等待时长）
#[derive(Debug, Clone)]
pub struct MockFrame {
    /// 帧数据（不含 `data: ` 前缀与分隔空行）
    pub data: String,
    /// 发送前延迟（None = 立即发送）
    pub delay: Option<Duration>,
}

impl MockFrame {
    /// 立即发送的帧
    pub fn data(data: impl Into<String>) -> Self {
        Self {
            data: data.into(),
            delay: None,
        }
    }

    /// 延迟后发送的帧（用于制造帧间间隔/首帧延迟）
    pub fn data_delayed(data: impl Into<String>, delay: Duration) -> Self {
        Self {
            data: data.into(),
            delay: Some(delay),
        }
    }
}

/// 一次连接的响应（由 handler 闭包返回）
#[derive(Debug, Clone)]
pub enum MockResponse {
    /// 普通 HTTP 响应（content-length 定长，可带自定义头与任意状态码）
    Plain {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    },
    /// 完整 SSE chunked 流；`interrupt_after` 非 None 时发完前 n 帧即断开
    /// （不发终止块，模拟流中途中断）
    Sse {
        frames: Vec<MockFrame>,
        interrupt_after: Option<usize>,
    },
    /// 先发若干 SSE 帧，随后静默挂起（模拟流中途停顿，配合 abort/超时测试）
    SseThenHang { frames: Vec<MockFrame> },
    /// 只发响应头后挂起（模拟挂起流，配合首字节超时/abort 测试）
    Hang,
}

/// 本地 mock 服务器：每个连接调用 handler 决定响应，并记录全部请求
pub struct MockServer {
    /// 监听地址（请求 URL 用 `http://{addr}{path}`）
    pub addr: SocketAddr,
    /// 已记录请求（按到达顺序）
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl MockServer {
    /// 启动 mock：绑定 127.0.0.1 随机端口，每连接独立任务处理
    pub async fn start<F>(handler: F) -> Self
    where
        F: Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定本地随机端口");
        let addr = listener.local_addr().expect("读取监听地址");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let task_requests = Arc::clone(&requests);
        let handler = Arc::new(handler);
        // 接受循环常驻；测试结束后随 tokio runtime 一起回收
        tokio::spawn(async move {
            loop {
                let (socket, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                let handler = Arc::clone(&handler);
                let requests = Arc::clone(&task_requests);
                // 每连接独立任务：挂起/慢流不阻塞后续连接（重试测试依赖多连接）
                tokio::spawn(async move {
                    handle_connection(socket, handler, requests).await;
                });
            }
        });
        Self { addr, requests }
    }

    /// 已记录请求的快照（按到达顺序）
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().expect("请求记录锁").clone()
    }

    /// 等待至少 n 个请求到达后返回快照（重试类测试的同步栅栏）
    pub async fn wait_for_requests(&self, n: usize) -> Vec<RecordedRequest> {
        for _ in 0..200 {
            let snapshot = self.requests();
            if snapshot.len() >= n {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("等待 {n} 个请求超时，当前仅 {} 个", self.requests().len());
    }
}

/// 处理单个连接：读请求 → 记录 → handler 决策 → 写响应
async fn handle_connection(
    mut socket: TcpStream,
    handler: Arc<dyn Fn(&RecordedRequest) -> MockResponse + Send + Sync>,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
) {
    let request = match read_request(&mut socket).await {
        Some(request) => request,
        // 请求未读全（对端提前关闭）：无响应可写
        None => return,
    };
    let response = handler(&request);
    requests.lock().expect("请求记录锁").push(request);
    write_response(&mut socket, response).await;
}

/// 读取一个 HTTP 请求：请求行 + 头 + 按 Content-Length 读体
async fn read_request(stream: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(pos) = find_subsequence(&buffer, b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().unwrap_or(0);
        }
        headers.push((name, value));
    }
    // 按 Content-Length 读请求体（reqwest POST 恒携带）
    while buffer.len() - header_end < content_length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(&buffer[header_end..])
        .trim_end_matches('\r')
        .trim_end_matches('\n')
        .to_string();
    Some(RecordedRequest {
        method,
        path,
        headers,
        body,
    })
}

/// SSE 响应头（chunked 编码）
const SSE_HEADERS: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "content-type: text/event-stream\r\n",
    "transfer-encoding: chunked\r\n",
    "connection: close\r\n",
    "\r\n"
);

/// 写入一条 SSE 帧（HTTP chunked 块）
async fn write_sse_chunk(stream: &mut TcpStream, data: &str) {
    let sse_text = format!("data: {data}\n\n");
    let chunk = format!("{:x}\r\n{}\r\n", sse_text.len(), sse_text);
    let _ = stream.write_all(chunk.as_bytes()).await;
}

/// 按响应规格写出完整 HTTP 响应
async fn write_response(stream: &mut TcpStream, response: MockResponse) {
    match response {
        MockResponse::Plain {
            status,
            headers,
            body,
        } => {
            let mut header_lines = vec![
                format!("HTTP/1.1 {status} {}", reason_phrase(status)),
                format!("content-length: {}", body.len()),
                "connection: close".to_string(),
            ];
            header_lines.extend(
                headers
                    .iter()
                    .map(|(name, value)| format!("{name}: {value}")),
            );
            let text = header_lines.join("\r\n") + "\r\n\r\n" + &body;
            let _ = stream.write_all(text.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
        MockResponse::Sse {
            frames,
            interrupt_after,
        } => {
            let _ = stream.write_all(SSE_HEADERS.as_bytes()).await;
            let stop_at = interrupt_after.unwrap_or(frames.len());
            for frame in frames.iter().take(stop_at) {
                if let Some(delay) = frame.delay {
                    tokio::time::sleep(delay).await;
                }
                write_sse_chunk(stream, &frame.data).await;
            }
            if interrupt_after.is_some() {
                // 中途断开：不发终止块，稍候让对端感知截断
                tokio::time::sleep(Duration::from_millis(20)).await;
                let _ = stream.shutdown().await;
            } else {
                let _ = stream.write_all(b"0\r\n\r\n").await;
                let _ = stream.shutdown().await;
            }
        }
        MockResponse::SseThenHang { frames } => {
            let _ = stream.write_all(SSE_HEADERS.as_bytes()).await;
            for frame in &frames {
                if let Some(delay) = frame.delay {
                    tokio::time::sleep(delay).await;
                }
                write_sse_chunk(stream, &frame.data).await;
            }
            // 静默挂起：保持连接打开直到对端关闭；随 runtime 回收
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
        MockResponse::Hang => {
            let _ = stream.write_all(SSE_HEADERS.as_bytes()).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    }
}

/// 状态码 → 原因短语（未知码给通用文案）
fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Mock Response",
    }
}

/// 子序列定位（请求头结束符 `\r\n\r\n` 用）
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ── 客户端侧公共辅助 ──

/// POST JSON 请求并读取普通响应（返回状态码、正文、响应头）
pub async fn fetch_plain(
    addr: SocketAddr,
    path: &str,
    body: serde_json::Value,
) -> (u16, String, reqwest::header::HeaderMap) {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{addr}{path}"))
        .json(&body)
        .send()
        .await
        .expect("请求发送");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.text().await.expect("读取响应体");
    (status, body, headers)
}

/// POST JSON 请求并读取完整 SSE 流（断言 2xx；双段超时给足余量）
pub async fn fetch_sse(addr: SocketAddr, path: &str, body: serde_json::Value) -> StreamReadOutput {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{addr}{path}"))
        .json(&body)
        .send()
        .await
        .expect("请求发送");
    assert_eq!(response.status(), 200, "mock 应返回 200");
    read_stream_options(response).await
}

/// 用宽松超时读取 SSE 响应流（first-byte / idle 各 5s）
pub async fn read_stream_options(response: reqwest::Response) -> StreamReadOutput {
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        first_byte_timeout: Some(Duration::from_secs(5)),
        idle_timeout: Some(Duration::from_secs(5)),
        diagnostics: None,
    };
    agent_provider::transport::read_stream(response, &options, &mut abort)
        .await
        .expect("SSE 流读取")
}

/// 一条成功 chat-completions SSE 流（正文 + stop 帧 + [DONE]），供各测试复用
pub fn chat_ok_frames(text: &str) -> Vec<MockFrame> {
    vec![
        MockFrame::data(
            serde_json::json!({
                "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }],
            })
            .to_string(),
        ),
        MockFrame::data(
            serde_json::json!({
                "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
            })
            .to_string(),
        ),
        MockFrame::data("[DONE]"),
    ]
}

/// reqwest 字节流适配（与 transport 内部实现同构；供测试自行驱动读取循环，
/// 例如 abort 测试中边读边收帧）
pub struct ReqwestChunkReader {
    stream: Pin<Box<dyn Stream<Item = Result<Vec<u8>, reqwest::Error>> + Send>>,
}

impl ReqwestChunkReader {
    /// 包装 reqwest Response 的字节流
    pub fn new(response: reqwest::Response) -> Self {
        let stream = response
            .bytes_stream()
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()));
        Self {
            stream: Box::pin(stream),
        }
    }
}

#[async_trait]
impl agent_provider::sse::ChunkReader for ReqwestChunkReader {
    type Error = reqwest::Error;

    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, reqwest::Error> {
        match self.stream.next().await {
            Some(Ok(bytes)) => Ok(Some(bytes)),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        }
    }
}
