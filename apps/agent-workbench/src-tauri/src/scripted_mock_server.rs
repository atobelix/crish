//! C3 交付物:可脚本化 mock SSE/HTTP server(任务连续性测试基建)
//!
//! 背景:run 域测试既有 `conex_run::run::tests::RequestCaptureServer`
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
//! (未产出)→ 重试。装配辅助为最小自足替身(与 `conex_run::run::tests`
//! 同构),避免共享文件写冲突(run/tests.rs 全期单写纪律)。

#![cfg(test)]
// 测试域豁免:本地监听 / 写套接字属测试行为(对齐引擎 run 域测试)
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

#[cfg(test)]
mod tests;
