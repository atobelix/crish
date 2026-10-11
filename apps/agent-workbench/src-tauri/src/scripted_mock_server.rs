//! C3 交付物:可脚本化 mock SSE/HTTP server(任务连续性测试基建)
//!
//! 背景:壳层测试域既有 `core_run_commands::tests::RequestCaptureServer`
//! 只回 200+SSE 头即关闭,无法脚本化瞬态错误;agent-provider 测试域
//! `tests/common/mod.rs MockServer` 为闭包 handler 形态,不承载「响应序列
//! 按请求序号消费」的声明式脚本语义。本模块补 C3 缺口
//! (`docs/continuity-repair/final/00-正式实现规范.md` §6 交付物补充 /
//! `docs/continuity-repair/02-定夺与修订指令.md` C3):可脚本化
//! 429+Retry-After / 5xx / 发数据后断流 / 正常流,供 D1/D2/D3/D5 测试共用
//! (D1 T16 端到端、D2 端到端续 run、D3 T1/T2/T5、D5 I5、E1 续写测试)。
//!
//! 能力:
//! - 响应序列 `[ScriptStep]` 按请求序号逐次消费;脚本耗尽后重复最后一项
//!   (如 `[429, 200]` = 第一次 429,之后恒 200——幂等重试场景友好);
//! - `Sse { cut_after: Some(n) }` = 发送前 n 帧后掐断连接(不发 chunked
//!   终止块),客户端读到截断 → Network 分类;`cut_after: Some(0)` = 未产出
//!   断流(仅 200+SSE 头即断开)——「已产出断流(不重试)/ 未产出断流(重试)」
//!   语义在 wire 面可区分;
//! - 每个请求记录 method / path / 头 / 体 / 响应状态 / 到达时刻,供断言;
//! - 与 RequestCaptureServer 同风格:绑定 127.0.0.1 随机端口、常驻 accept、
//!   `wait_for(n)` 同步栅栏。
//!
//! 接入用例(本文件底部):真实 HttpProviderCall + 完整 run 装配走 mock wire
//! ——① 429+Retry-After 等待;② 5xx 退避重试序列;③ 断流(已产出)→ 部分
//! 保留 + providerErrorKind 标注消费(E1 续写拉起 / S2 熔断计数);④ 断流
//! (未产出)→ 重试。装配辅助为最小自足替身(与 `core_run_commands::tests`
//! 同构),避免共享文件写冲突(core_run_commands.rs 全期单写纪律)。

#![cfg(test)]
// 测试域豁免:本地监听 / 写套接字属测试行为(对齐 core_run_commands 测试域)
#![allow(clippy::disallowed_methods)]

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ═══════════════════════════════════════════════════════════════════
// 响应脚本
// ═══════════════════════════════════════════════════════════════════

/// 响应脚本步骤:每次请求按脚本序号消费一步
#[derive(Debug, Clone)]
pub enum ScriptStep {
    /// 普通 HTTP 响应:指定状态码 + 可选 Retry-After 头 + 可选体。
    /// 429/5xx 分类由客户端错误分类器消费(status + retry-after 头)。
    Status {
        /// HTTP 状态码(429 / 500 / 502 / 503 …)
        status: u16,
        /// Retry-After 秒数(429 语义;None = 不带头)
        retry_after_secs: Option<u64>,
        /// 响应体(错误文案;None = 空体)
        body: Option<String>,
    },
    /// SSE 响应:200 + `text/event-stream` + chunked。
    /// `cut_after = None` = 正常流(全部帧 + 终止块收尾);
    /// `cut_after = Some(n)` = 发送前 n 帧后掐断连接(不发终止块),
    /// `n = 0` 即未产出断流。帧 = `data: {frame}\n\n` wire 文本
    /// (与 agent-provider 测试域 `tests/common/mod.rs` 同格式)。
    Sse {
        /// 帧载荷(不含 `data: ` 前缀与分隔空行)
        frames: Vec<String>,
        /// 断流位置(None = 正常流;Some(n) = 发 n 帧后断流)
        cut_after: Option<usize>,
    },
}

impl ScriptStep {
    /// 正常 SSE 流(全部帧 + 正常收尾)
    pub fn sse_ok(frames: Vec<String>) -> Self {
        Self::Sse {
            frames,
            cut_after: None,
        }
    }

    /// 发数据后断流:发送前 `keep` 帧后掐断连接(已产出部分帧)。
    /// `keep = 0` = 未产出断流(仅 200+SSE 头即断开,客户端可安全重发)。
    pub fn sse_cut(frames: Vec<String>, keep: usize) -> Self {
        Self::Sse {
            frames,
            cut_after: Some(keep),
        }
    }

    /// 状态码响应(5xx/4xx;空体)
    pub fn status(status: u16) -> Self {
        Self::Status {
            status,
            retry_after_secs: None,
            body: None,
        }
    }

    /// 429 + Retry-After(秒)——mock 速率限制瞬态错误
    pub fn rate_limit(retry_after_secs: u64) -> Self {
        Self::Status {
            status: 429,
            retry_after_secs: Some(retry_after_secs),
            body: Some(
                r#"{"error":{"message":"rate limit exceeded","type":"rate_limit"}}"#.to_string(),
            ),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// 请求记录
// ═══════════════════════════════════════════════════════════════════

/// 已记录的请求(method / path / 头 / 体 / 响应状态 / 到达时刻)
#[derive(Debug, Clone)]
pub struct CapturedRequest {
    /// HTTP 方法(如 POST)
    pub method: String,
    /// 请求路径(含查询串)
    pub path: String,
    /// 请求头(保留原始大小写)
    pub headers: Vec<(String, String)>,
    /// 请求体原文(UTF-8 无损转换)
    pub body: String,
    /// 本次响应状态码(写响应后记录;断言脚本按序消费用)
    pub response_status: u16,
    /// 请求到达时刻(tokio 时钟;退避/Retry-After 间隔断言用)
    pub arrived_at: tokio::time::Instant,
}

impl CapturedRequest {
    /// 按名称(大小写不敏感)取首个请求头值
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

// ═══════════════════════════════════════════════════════════════════
// 服务器
// ═══════════════════════════════════════════════════════════════════

/// 可脚本化 mock server:每连接读请求 → 记录 → 按脚本序号消费 → 写响应
pub struct ScriptedMockServer {
    /// 监听地址(请求 URL 用 `http://{addr}{path}` 或 [Self::base_url])
    addr: SocketAddr,
    /// 响应脚本(不可变;消费序号见 `next`)
    script: Arc<Vec<ScriptStep>>,
    /// 下次消费的脚本序号(Atomic 计数,跨连接线程安全)
    next: Arc<AtomicUsize>,
    /// 已捕获请求(按到达顺序)
    captured: Arc<Mutex<Vec<CapturedRequest>>>,
}

impl ScriptedMockServer {
    /// 启动 mock:绑定 127.0.0.1 随机端口,常驻 accept,每连接独立任务
    /// (挂起/慢流不阻塞后续连接——重试测试依赖多连接)
    pub async fn start(script: Vec<ScriptStep>) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定本地随机端口");
        let addr = listener.local_addr().expect("读取监听地址");
        let server = Arc::new(Self {
            addr,
            script: Arc::new(script),
            next: Arc::new(AtomicUsize::new(0)),
            captured: Arc::new(Mutex::new(Vec::new())),
        });
        let accept_server = Arc::clone(&server);
        // 接受循环常驻;测试结束随 tokio runtime 一起回收
        tokio::spawn(async move {
            loop {
                let (socket, _) = match listener.accept().await {
                    Ok(pair) => pair,
                    // listener 关闭(runtime 回收)即退出
                    Err(_) => break,
                };
                let server = Arc::clone(&accept_server);
                tokio::spawn(async move {
                    handle_connection(socket, &server).await;
                });
            }
        });
        server
    }

    /// 便捷 URL:`{path}` 拼在地址后(如 `/v1/chat/completions`)
    pub fn base_url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    /// 已捕获请求快照(按到达顺序)
    pub fn requests(&self) -> Vec<CapturedRequest> {
        self.captured
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 已消费的脚本步数(断言「按请求序号消费」;含耗尽后的重复消费)
    pub fn consumed(&self) -> usize {
        self.next.load(Ordering::Relaxed)
    }

    /// 等待至少 n 个请求到达后返回快照(5s 超时兜底,防测试悬挂)
    pub async fn wait_for(&self, n: usize) -> Vec<CapturedRequest> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let current = self.requests();
            if current.len() >= n {
                return current;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "等待 {n} 个请求超时,当前仅 {} 个",
                current.len()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// 连接处理内部实现
// ═══════════════════════════════════════════════════════════════════

/// 解析出的请求(写响应前暂存,记录时移入 [CapturedRequest])
struct ParsedRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

/// 处理单个连接:读请求 → 记录到达时刻 → 消费脚本一步 → 写响应 → 落记录
async fn handle_connection(mut socket: TcpStream, server: &ScriptedMockServer) {
    let Some(request) = read_request(&mut socket).await else {
        // 请求未读全(对端提前关闭):无响应可写
        return;
    };
    let arrived_at = tokio::time::Instant::now();
    let step = next_step(&server.script, &server.next);
    let response_status = write_response(&mut socket, &step).await;
    server
        .captured
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(CapturedRequest {
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: request.body,
            response_status,
            arrived_at,
        });
}

/// 脚本消费:返回下一步;脚本耗尽后重复最后一项(空脚本防御性 panic——
/// 脚本为空属调用方错误,显式失败不静默降级)
fn next_step(script: &[ScriptStep], next: &AtomicUsize) -> ScriptStep {
    let index = next.fetch_add(1, Ordering::Relaxed);
    let step = script
        .get(index)
        .unwrap_or_else(|| script.last().expect("脚本不得为空"));
    step.clone()
}

/// SSE 响应头(chunked 编码;与 agent-provider 测试域同格式)
const SSE_HEADERS: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "content-type: text/event-stream\r\n",
    "transfer-encoding: chunked\r\n",
    "connection: close\r\n",
    "\r\n"
);

/// 写入一条 SSE 帧(HTTP chunked 块)
async fn write_sse_chunk(stream: &mut TcpStream, data: &str) {
    let sse_text = format!("data: {data}\n\n");
    let chunk = format!("{:x}\r\n{}\r\n", sse_text.len(), sse_text);
    let _ = stream.write_all(chunk.as_bytes()).await;
}

/// 按脚本步骤写出完整 HTTP 响应,返回实际状态码(记录用)
async fn write_response(socket: &mut TcpStream, step: &ScriptStep) -> u16 {
    match step {
        ScriptStep::Status {
            status,
            retry_after_secs,
            body,
        } => {
            let body = body.clone().unwrap_or_default();
            let mut head = format!("HTTP/1.1 {status} {}\r\n", reason_phrase(*status));
            if let Some(secs) = retry_after_secs {
                head.push_str(&format!("retry-after: {secs}\r\n"));
            }
            head.push_str(&format!("content-length: {}\r\n", body.len()));
            head.push_str("connection: close\r\n\r\n");
            let _ = socket.write_all(head.as_bytes()).await;
            if !body.is_empty() {
                let _ = socket.write_all(body.as_bytes()).await;
            }
            let _ = socket.shutdown().await;
            *status
        }
        ScriptStep::Sse { frames, cut_after } => {
            let _ = socket.write_all(SSE_HEADERS.as_bytes()).await;
            let send = cut_after.unwrap_or(frames.len());
            for frame in frames.iter().take(send) {
                write_sse_chunk(socket, frame).await;
            }
            match cut_after {
                // 正常流:终止块 + 关闭
                None => {
                    let _ = socket.write_all(b"0\r\n\r\n").await;
                    let _ = socket.shutdown().await;
                }
                // 断流:稍候让对端感知截断,然后掐断连接(不发终止块)
                Some(_) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    let _ = socket.shutdown().await;
                }
            }
            200
        }
    }
}

/// 读取一个 HTTP 请求:请求行 + 头 + 按 Content-Length 读体(3s 超时防挂起)
async fn read_request(stream: &mut TcpStream) -> Option<ParsedRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = read_with_timeout(stream, &mut chunk).await?;
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
    // 按 Content-Length 读请求体(reqwest POST 恒携带)
    while buffer.len() - header_end < content_length {
        let read = read_with_timeout(stream, &mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(&buffer[header_end..])
        .trim_end_matches('\r')
        .trim_end_matches('\n')
        .to_string();
    Some(ParsedRequest {
        method,
        path,
        headers,
        body,
    })
}

/// 带 3s 超时的读(防对端挂起导致连接任务泄漏)
async fn read_with_timeout(stream: &mut TcpStream, buf: &mut [u8]) -> Option<usize> {
    tokio::time::timeout(Duration::from_secs(3), stream.read(buf))
        .await
        .ok()?
        .ok()
}

/// 子序列定位(请求头结束符 `\r\n\r\n` 用)
fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 状态码 → 原因短语(未知码给通用文案)
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

// ═══════════════════════════════════════════════════════════════════
// 服务器自身单测(脚本消费 / 请求记录 / wire 正确性)
// ═══════════════════════════════════════════════════════════════════

#[cfg(test)]
mod server_tests {
    use super::*;
    use futures_util::StreamExt;
    use serde_json::json;

    /// 便捷构造一条 chat-completions content delta 帧(与 agent-provider
    /// 测试域 `chat_ok_frames` 同 wire 格式)
    fn content_frame(text: &str) -> String {
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}).to_string()
    }

    /// POST JSON 请求(返回原始响应供断言)
    async fn post(server: &ScriptedMockServer, path: &str) -> reqwest::Response {
        let client = reqwest::Client::new();
        client
            .post(server.base_url(path))
            .json(&json!({"messages": [{"role": "user", "content": "你好"}]}))
            .send()
            .await
            .expect("请求发送")
    }

    /// 增量收集响应体直至流结束或出错(断流断言用)
    async fn drain_stream(response: reqwest::Response) -> (String, &'static str) {
        let mut received = String::new();
        let mut stream = response.bytes_stream();
        loop {
            match stream.next().await {
                Some(Ok(bytes)) => received.push_str(&String::from_utf8_lossy(&bytes)),
                Some(Err(_)) => return (received, "err"),
                None => return (received, "eof"),
            }
        }
    }

    /// 脚本按请求序号逐次消费 + 请求记录完整(method/path/头/体/响应状态)
    #[tokio::test]
    async fn script_consumes_steps_in_order_and_records_requests() {
        let server = ScriptedMockServer::start(vec![
            ScriptStep::status(500),
            ScriptStep::status(502),
            ScriptStep::sse_ok(vec!["a".to_string()]),
        ])
        .await;
        let r1 = post(&server, "/v1/chat/completions").await;
        assert_eq!(r1.status().as_u16(), 500, "第 1 次请求 → 脚本第 1 步(500)");
        let r2 = post(&server, "/v1/chat/completions").await;
        assert_eq!(r2.status().as_u16(), 502, "第 2 次请求 → 脚本第 2 步(502)");
        let r3 = post(&server, "/v1/chat/completions").await;
        assert_eq!(r3.status().as_u16(), 200, "第 3 次请求 → 脚本第 3 步(200)");

        let captured = server.wait_for(3).await;
        assert_eq!(captured.len(), 3, "三请求全部记录");
        assert_eq!(server.consumed(), 3, "脚本按请求序号消费 3 步");
        let statuses: Vec<u16> = captured.iter().map(|c| c.response_status).collect();
        assert_eq!(statuses, vec![500, 502, 200], "响应状态按脚本顺序记录");
        assert!(
            captured[0].path.starts_with("/v1/chat/completions"),
            "URL 路径记录"
        );
        assert_eq!(captured[0].method, "POST", "HTTP 方法记录");
        assert!(captured[0].body_contains("你好"), "请求体记录");
        assert_eq!(
            captured[0]
                .header("content-type")
                .map(str::to_lowercase)
                .as_deref(),
            Some("application/json"),
            "请求头记录(大小写不敏感查找)"
        );
    }

    /// 脚本耗尽后重复最后一项(幂等重试场景:[429, 200] = 第一次 429 后恒 200)
    #[tokio::test]
    async fn script_exhausted_repeats_last_step() {
        let server = ScriptedMockServer::start(vec![
            ScriptStep::rate_limit(1),
            ScriptStep::sse_ok(vec!["a".to_string()]),
        ])
        .await;
        let r1 = post(&server, "/s").await;
        assert_eq!(r1.status().as_u16(), 429, "第 1 次 → 429");
        let r2 = post(&server, "/s").await;
        assert_eq!(r2.status().as_u16(), 200, "第 2 次 → 200");
        let r3 = post(&server, "/s").await;
        assert_eq!(r3.status().as_u16(), 200, "耗尽后重复最后一项(200)");
        let r4 = post(&server, "/s").await;
        assert_eq!(r4.status().as_u16(), 200, "继续重复最后一项");
        assert_eq!(server.consumed(), 4, "含耗尽后的重复消费");
    }

    /// 429 步必须带 retry-after 头(客户端分类器读取面)
    #[tokio::test]
    async fn rate_limit_step_emits_retry_after_header() {
        let server = ScriptedMockServer::start(vec![ScriptStep::rate_limit(30)]).await;
        let response = post(&server, "/s").await;
        assert_eq!(response.status().as_u16(), 429);
        let retry_after = response
            .headers()
            .get("retry-after")
            .map(|v| v.to_str().expect("ASCII 头值").to_string());
        assert_eq!(
            retry_after.as_deref(),
            Some("30"),
            "429 必须带 retry-after 头"
        );
    }

    /// 正常流:全部帧按 SSE wire 格式(data: 前缀)发送 + 正常收尾
    #[tokio::test]
    async fn sse_ok_streams_all_frames_then_finishes() {
        let server = ScriptedMockServer::start(vec![ScriptStep::sse_ok(vec![
            content_frame("你好"),
            "[DONE]".to_string(),
        ])])
        .await;
        let response = post(&server, "/s").await;
        assert_eq!(response.status().as_u16(), 200);
        let (body, outcome) = drain_stream(response).await;
        assert_eq!(outcome, "eof", "正常流以 EOF 收尾(非截断错误)");
        assert!(body.contains("data: "), "帧按 SSE wire 格式 data: 前缀");
        assert!(body.contains("你好"), "正常流应含全部帧: {body}");
        assert!(body.contains("[DONE]"));
    }

    /// 发数据后断流:已产出帧内容保留,流以错误终止(chunked 截断 →
    /// 客户端分类为 Network 的面)
    #[tokio::test]
    async fn sse_cut_keeps_partial_frames_then_truncates() {
        let server = ScriptedMockServer::start(vec![ScriptStep::sse_cut(
            vec![content_frame("半截"), "[DONE]".to_string()],
            1,
        )])
        .await;
        let response = post(&server, "/s").await;
        assert_eq!(response.status().as_u16(), 200, "断流前仍是 200+SSE 头");
        let (received, outcome) = drain_stream(response).await;
        assert!(received.contains("半截"), "已产出的帧内容保留: {received}");
        assert!(!received.contains("[DONE]"), "断流后的帧不出现");
        assert_eq!(
            outcome, "err",
            "chunked 未收尾 → 流以错误终止(Network 分类面)"
        );
    }

    /// 未产出断流:零帧数据即截断(客户端「未产出可重发」语义的 wire 面)
    #[tokio::test]
    async fn sse_cut_zero_keep_yields_no_data_before_truncation() {
        let server = ScriptedMockServer::start(vec![ScriptStep::sse_cut(
            vec![content_frame("不应出现")],
            0,
        )])
        .await;
        let response = post(&server, "/s").await;
        assert_eq!(response.status().as_u16(), 200);
        let (received, outcome) = drain_stream(response).await;
        assert!(!received.contains("不应出现"), "未产出断流:零帧数据");
        assert_eq!(outcome, "err", "仅 200+SSE 头后截断");
    }
}

// ═══════════════════════════════════════════════════════════════════
// 接入用例:真实 HttpProviderCall + 完整 run 装配走 mock wire
// ═══════════════════════════════════════════════════════════════════

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::core_event_bridge::EventBridge;
    use crate::core_run_commands::{run_task_impl, BackoffDelayFn, CoreRunState, RunTaskOptions};
    use crate::engine::{EngineProviderConfig, HttpProviderCall};
    use crate::status_diagnostics::StatusDiagnostics;
    use agent_provider::config::Endpoint;
    use conex_db::LocalDb;
    use conex_types::message::AgentMessage;
    use conex_types::SessionIndexEntry;
    use orchestrator::persist::LocalDbStore;
    use orchestrator::restore::{SnapshotFileStore, SnapshotStore};
    use serde_json::json;
    use std::future::Future;

    // 与 core_run_commands 键名镜像(键为契约,常量不可见处直接字面量)
    const RETRY_BACKOFF_KEY: &str = "provider_retry_backoff_ms";
    const FAIL_STREAK_KEY: &str = "provider_fail_streak";

    /// 拉起器类型(与 core_run_commands::idle_resume::ResumeLauncher 同构;
    /// 该处经私有 use 重导入遮蔽 pub(crate) 定义,无法跨模块引用——本地
    /// 等价类型别名,闭包底层类型一致即可传给 set_resume_launcher)
    type ResumeLauncher = Arc<
        dyn Fn(
                &Arc<CoreRunState>,
                &str,
                &str,
                Vec<AgentMessage>,
            ) -> Pin<Box<dyn Future<Output = ()> + Send>>
            + Send
            + Sync,
    >;

    /// 忽略式事件发射器(装配 EventBridge 用;接入用例不消费事件面)
    struct IgnoreEmitter;

    impl crate::core_event_bridge::Emitter for IgnoreEmitter {
        fn emit(&self, _channel: &str, _payload: &str) {}
    }

    /// 测试临时快照文件序号(防并行冲突)
    static SNAPSHOT_SEQ: AtomicU32 = AtomicU32::new(0);

    /// 会话条目(对齐 core_run_commands::tests::subagent_test_session_entry)
    fn session_entry(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            id: id.to_string(),
            title: format!("会话 {id}"),
            folder: String::new(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
            updated_at: 1,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: Some(0),
            engine_last_run_id: None,
            hydrated_from_engine: Some(true),
        }
    }

    /// 构造真实 HttpProviderCall 注入的测试状态(mock server 走真实 wire;
    /// 与 core_run_commands::tests::run_control_test_state 同构,自足独立)
    fn run_state_with_http_provider(
        provider: Arc<HttpProviderCall>,
        base_url: &str,
    ) -> (Arc<CoreRunState>, LocalDb) {
        let db = LocalDb::open_in_memory().expect("内存库");
        db.upsert_session_entry(&session_entry("s1"))
            .expect("会话条目");
        let seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed);
        let snapshots: Arc<dyn SnapshotStore> =
            Arc::new(SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "conex_c3_mock_{}_{seq}_snapshot.json",
                std::process::id()
            ))));
        let bridge = EventBridge::new("workbench-run-event", Arc::new(IgnoreEmitter));
        let state = Arc::new(CoreRunState::new(
            Arc::new(LocalDbStore::new(db.clone())),
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ));
        // 用户裁决：重试预算/上限可配置——本文件用例数请求次数不断言墙钟
        // 时长，统一注入 baseMs=1 快速策略，防缺省 750ms 指数退避把多次
        // 重试用例拖穿断言窗口。
        state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
            retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
                base_ms: Some(1),
                max_ms: Some(8),
                total_budget_ms: Some(60_000),
            }),
            transient_retry_limit: Some(10),
        }));
        let config = EngineProviderConfig {
            base_url: base_url.to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
            ..Default::default()
        };
        // 参数位置 unsized coercion:Arc<HttpProviderCall> → Arc<dyn ProviderCall>
        state.engine().inject_provider_for_test(provider, config);
        (state, db)
    }

    /// 测试选项(对齐 core_run_commands::tests::test_options)
    fn test_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
        RunTaskOptions {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            prompt: Some(prompt.to_string()),
            mode: Some("task".to_string()),
            cwd: None,
            permission_mode: Some("full-access".to_string()),
            client_message_id: None,
            assistant_client_message_id: None,
            system_prompt: None,
            history: None,
            context_window: None,
            parent_run_id: None,
            subagent_config: None,
            visible_goal: None,
            max_rounds: None,
            max_stalled_rounds: None,
            reasoning_effort: None,
            context_state: None,
            content: None,
            has_images: None,
        }
    }

    /// 轮询会话事件库中的 agent-end 事件(真实 loop 收口落库;返回 reason)
    async fn wait_run_terminal(db: &LocalDb, session_id: &str, window: Duration) -> String {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            // 收口落库经 spawn_blocking 异步写 events 表——测试轮询可能撞上
            // 写侧表锁（query_events_collect: database table is locked）；
            // 锁竞速按「未就绪」重试，写侧完成后本查询自然成功。
            let events = match db.query_events(session_id, 0, Some(500)) {
                Ok(events) => events,
                Err(_) => {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "run-terminal 事件未在窗口内落库"
                    );
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    continue;
                }
            };
            for event in &events {
                // G-29 事件权威：run-terminal 是唯一终态事件（03 §5.2-2，
                // 旧 agent-end/run-completed/run-failed 已删），断言只认权威形态。
                if event.event_type != "run-terminal" {
                    continue;
                }
                let payload: serde_json::Value =
                    serde_json::from_str(&event.payload).expect("run-terminal 载荷为合法 JSON");
                if let Some(terminal) = payload["terminal"].as_str() {
                    return terminal.to_string();
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "run-terminal 事件未在窗口内落库"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 轮询熔断键 count(收口 spawn_blocking 异步落键;窗口内未达则 panic)
    async fn wait_for_fail_streak_count(db: &LocalDb, expected: u32, window: Duration) -> u32 {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let raw = db.get_session_meta(FAIL_STREAK_KEY).expect("熔断键读取");
            let count = raw
                .as_deref()
                .and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok())
                .and_then(|v| v["count"].as_u64())
                .map(|c| c as u32)
                .unwrap_or(0);
            if count == expected {
                return count;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "熔断键 count 未达期望 {expected}(当前 {count})"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    /// 记录型拉起器替身(仅计数,不拉起新 run——避免续写 run 再次请求 mock
    /// 使脚本消费与请求记录面复杂化)
    fn counting_launcher(counter: Arc<AtomicU64>) -> ResumeLauncher {
        let launcher: ResumeLauncher = Arc::new(move |_state, _session_id, _mode, _messages| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
            })
        });
        launcher
    }

    /// 正常 chat-completions SSE 帧序列(内容 + stop + [DONE])
    fn ok_frames(text: &str) -> Vec<String> {
        vec![
            json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})
                .to_string(),
            json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}).to_string(),
            "[DONE]".to_string(),
        ]
    }

    /// 清空代理环境变量(对齐 config_profile_apply 先例:保证请求真实
    /// 直连本地 mock,不依赖机器代理配置)
    fn clear_proxy_env() {
        for var in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            std::env::remove_var(var);
        }
    }

    /// 进程级 LIVE_CATALOG 是共享静态（protocol.rs:46），必须与
    /// protocol / engine_provider 测试**共用同一把锁**串行安装夹具——
    /// 否则并行时本模块会读到别的测试装的 catalog，chat 轨被误判为
    /// responses 轨（实证 2026-09-15：本模块 4 个用例并行全红、单跑全绿，
    /// 报错 `[invalid-stream] Responses stream ended without a terminal
    /// response event`）。protocol.rs:486-489 的注释已声明该锁的共享契约，
    /// 此前只覆盖了 protocol / engine_provider 两处，本模块漏接。
    fn lock_live_catalog() -> std::sync::MutexGuard<'static, ()> {
        crate::engine_provider::protocol::LIVE_CATALOG_TEST_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// 安装空树夹具 → `slots_for_model` 不命中 → `CatalogRequestProfile::fail_closed()`
    /// （protocol = Chat、max_tokens_field = MaxTokens）。本模块全部用例都走
    /// chat 轨，空树给出**确定性**剖面，不再依赖机器上真实 models.yaml 的内容。
    fn install_chat_catalog() {
        crate::engine_provider::protocol::reload_live_catalog_from_yaml_str(
            "version: 2\nproviders: {}\n",
        )
        .expect("空树夹具");
    }

    // ── 用例①:429+Retry-After → 客户端等待 ≥Retry-After 后重试 ──

    /// C3 用例①(429+Retry-After=2s):真实 wire 下内核退避等待
    /// `max(750ms, retry-after)` 后重试成功——两次请求间隔 ≥2s 且
    /// 第二次响应 200。30s 精确断言由既有虚拟时钟单测
    /// (`stream_error.rs rate_limit_retry_after_waits_at_least_30s`)
    /// 承担,本用例用短 Retry-After 验证同一机制在真实 HTTP 链路生效。
    #[tokio::test]
    async fn mock_429_retry_after_gates_client_retry() {
        clear_proxy_env();
        let server = ScriptedMockServer::start(vec![
            ScriptStep::rate_limit(2),
            ScriptStep::sse_ok(ok_frames("重试后成功")),
        ])
        .await;
        let provider = HttpProviderCall::new(
            reqwest::Client::new(),
            EngineProviderConfig {
                base_url: server.base_url("/v1"),
                api_key: "test-key".to_string(),
                model: "deepseek-v4-flash".to_string(),
                endpoint: Endpoint::ChatCompletions,
                stream: true,
                extra: std::collections::BTreeMap::new(),
                ..Default::default()
            },
        );
        let _live = lock_live_catalog();
        install_chat_catalog();
        let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
        state.run_restore().await;
        // 退避键装配:内核 750ms×2^(n-1)/8s 封顶/60s 预算(生产装配同键)
        db.set_session_meta(RETRY_BACKOFF_KEY, "[750,8000,60000]")
            .expect("退避键写入");
        run_task_impl(Arc::clone(&state), test_options("c3-429", "s1", "任务"))
            .await
            .expect("run 发起成功");
        let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
        assert_eq!(terminal, "completed", "429 重试后正常完成收场");
        let captured = server.wait_for(2).await;
        assert_eq!(captured.len(), 2, "429 后恰好重试 1 次");
        assert_eq!(captured[0].response_status, 429, "首请求 → 429");
        assert_eq!(captured[1].response_status, 200, "重试请求 → 200");
        let wait_ms = captured[1]
            .arrived_at
            .duration_since(captured[0].arrived_at)
            .as_millis();
        assert!(
            wait_ms >= 1900,
            "重试等待 ≥Retry-After(2s):实际 {wait_ms}ms(max(750,2000)=2000ms)"
        );
        assert!(
            captured[1].path.starts_with("/v1/chat/completions"),
            "重试请求同一端点:{}",
            captured[1].path
        );
    }

    // ── 用例②:5xx 序列 → 退避重试序列 ──

    /// C3 用例②(5xx 序列):脚本 [500, 502, 503, 200] 按序号消费,
    /// 每次 5xx 后内核退避 750ms 重试,第 4 次成功——断言请求数、
    /// 响应状态序列与退避总时长(≥3×750ms)。
    #[tokio::test]
    async fn mock_5xx_sequence_backoffs_and_retries() {
        clear_proxy_env();
        let server = ScriptedMockServer::start(vec![
            ScriptStep::status(500),
            ScriptStep::status(502),
            ScriptStep::status(503),
            ScriptStep::sse_ok(ok_frames("5xx 退避后成功")),
        ])
        .await;
        let provider = HttpProviderCall::new(
            reqwest::Client::new(),
            EngineProviderConfig {
                base_url: server.base_url("/v1"),
                api_key: "test-key".to_string(),
                model: "deepseek-v4-flash".to_string(),
                endpoint: Endpoint::ChatCompletions,
                stream: true,
                extra: std::collections::BTreeMap::new(),
                ..Default::default()
            },
        );
        let _live = lock_live_catalog();
        install_chat_catalog();
        let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
        state.run_restore().await;
        db.set_session_meta(RETRY_BACKOFF_KEY, "[750,8000,60000]")
            .expect("退避键写入");
        let started = tokio::time::Instant::now();
        run_task_impl(Arc::clone(&state), test_options("c3-5xx", "s1", "任务"))
            .await
            .expect("run 发起成功");
        let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
        assert_eq!(terminal, "completed", "5xx 重试耗尽前成功收场");
        let captured = server.wait_for(4).await;
        assert_eq!(captured.len(), 4, "3 次 5xx + 1 次成功 = 4 个请求");
        let statuses: Vec<u16> = captured.iter().map(|c| c.response_status).collect();
        assert_eq!(statuses, vec![500, 502, 503, 200], "5xx 序列按脚本序号消费");
        let elapsed_ms = started.elapsed().as_millis();
        assert!(
            elapsed_ms >= 2000,
            "3 次 750ms 退避(≥2.25s):实际 {elapsed_ms}ms"
        );
        assert_eq!(server.consumed(), 4, "脚本消费 4 步");
    }

    // ── 用例③:断流(已产出)→ 部分保留 + providerErrorKind 标注 ──

    /// C3 用例③(发数据后断流):真实 wire 断流(1 帧后掐断)→ 内核
    /// 「已产出不重试」(仅 1 个请求)→ 部分保留收场 Stop → D7 结构化
    /// 标注 providerErrorKind 被双消费端识别:① E1 续写判定拉起
    /// (counting 替身 +1);② 熔断 S2 计数 +1(瞬态类计入)。
    #[tokio::test]
    async fn mock_stream_cut_after_data_partial_preserved_with_kind() {
        clear_proxy_env();
        let server =
            ScriptedMockServer::start(vec![ScriptStep::sse_cut(ok_frames("半截输出"), 1)]).await;
        let provider = HttpProviderCall::new(
            reqwest::Client::new(),
            EngineProviderConfig {
                base_url: server.base_url("/v1"),
                api_key: "test-key".to_string(),
                model: "deepseek-v4-flash".to_string(),
                endpoint: Endpoint::ChatCompletions,
                stream: true,
                extra: std::collections::BTreeMap::new(),
                ..Default::default()
            },
        );
        let _live = lock_live_catalog();
        install_chat_catalog();
        let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
        state.run_restore().await;
        // E1 续写退避置零(测试直接驱动,跳过跨 run 退避睡眠)
        let zero_backoff: BackoffDelayFn = Arc::new(|_attempt| Duration::ZERO);
        state.set_resume_backoff(Some(zero_backoff));
        let counter = Arc::new(AtomicU64::new(0));
        state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
        run_task_impl(Arc::clone(&state), test_options("c3-cut", "s1", "任务"))
            .await
            .expect("run 发起成功");
        // 部分保留断流:正常 Stop 收场(非 Error fatal)
        let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
        assert_eq!(terminal, "completed", "部分保留断流以正常完成收场");
        // 已产出不重试(内核三层纪律):仅 1 个请求
        let captured = server.wait_for(1).await;
        assert_eq!(captured.len(), 1, "已产出断流不重试(仅 1 次请求)");
        assert_eq!(captured[0].response_status, 200, "断流前已回 200+SSE 头");
        // D7 标注消费端①:E1 续写判定命中(providerErrorKind=network 被识别)
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if counter.load(Ordering::SeqCst) >= 1 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "E1 续写拉起未在窗口内发生(providerErrorKind 标注未被识别?)"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        // D7 标注消费端②:熔断 S2 计数 +1(部分保留断流计入连续失败)
        let count = wait_for_fail_streak_count(&db, 1, Duration::from_secs(10)).await;
        assert_eq!(count, 1, "部分保留断流(瞬态类)计入熔断计数(S2)");
    }

    // ── 用例④:断流(未产出)→ 重试 ──

    /// C3 用例④(未产出断流):脚本 [断流(0 帧), 正常流]——第一次仅
    /// 200+SSE 头即截断,未产出 → 客户端安全重试(750ms 退避后),第二次
    /// 正常流成功收场。
    #[tokio::test]
    async fn mock_stream_cut_before_data_retries() {
        clear_proxy_env();
        let server = ScriptedMockServer::start(vec![
            ScriptStep::sse_cut(ok_frames("不应输出"), 0),
            ScriptStep::sse_ok(ok_frames("重试后成功")),
        ])
        .await;
        let provider = HttpProviderCall::new(
            reqwest::Client::new(),
            EngineProviderConfig {
                base_url: server.base_url("/v1"),
                api_key: "test-key".to_string(),
                model: "deepseek-v4-flash".to_string(),
                endpoint: Endpoint::ChatCompletions,
                stream: true,
                extra: std::collections::BTreeMap::new(),
                ..Default::default()
            },
        );
        let _live = lock_live_catalog();
        install_chat_catalog();
        let (state, db) = run_state_with_http_provider(Arc::new(provider), &server.base_url("/v1"));
        state.run_restore().await;
        db.set_session_meta(RETRY_BACKOFF_KEY, "[750,8000,60000]")
            .expect("退避键写入");
        run_task_impl(Arc::clone(&state), test_options("c3-cut0", "s1", "任务"))
            .await
            .expect("run 发起成功");
        let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
        // G-29 事件权威：终态取值经权威映射收敛（旧 stop → completed），
        // 与同组其余 scripted 用例同源；语义仍为「重试后正常完成收场」。
        assert_eq!(terminal, "completed", "未产出断流重试后正常完成收场");
        let captured = server.wait_for(2).await;
        assert_eq!(captured.len(), 2, "未产出断流 → 重试 1 次(共 2 请求)");
        assert_eq!(captured[0].response_status, 200, "断流请求仍先回 200 头");
        assert_eq!(captured[1].response_status, 200, "重试请求 → 200 正常流");
        let wait_ms = captured[1]
            .arrived_at
            .duration_since(captured[0].arrived_at)
            .as_millis();
        assert!(
            wait_ms >= 650,
            "未产出断流重试等待退避 750ms:实际 {wait_ms}ms"
        );
        assert_eq!(server.consumed(), 2, "脚本两步按序消费");
    }
}
