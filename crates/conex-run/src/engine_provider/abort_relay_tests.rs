//! HttpProviderCall 中止中继回归（PL-P2 审计 M2）：流级 abort 中继任务以流的
//! 观察柄为界，不随请求累积常驻；流中途中止正确收场且任务回收。
//!
//! 确定性：本地回环 mock SSE 服务端（单一 accept 任务，基线前已就绪）；
//! 每条流读到预期事件后才推进（中途中止在收到首个 TextDelta 之后触发）；
//! 存活任务数以「等到回落至基线」判定（事件驱动，yield 让出调度），
//! 截止时限只作回归时防挂死的兜底，不参与通过判定。

use super::*;
use std::sync::Arc;
use std::time::Duration;

use agent_provider::config::Endpoint;
use conex_types::error::ProviderErrorKind;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use futures_util::StreamExt;
use session_loop::provider::ProviderRequest;
use session_loop::stream::ProviderStreamEvent;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const CHAT_DELTA_FRAME: &str =
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n";
const CHAT_STOP_FRAME: &str =
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

/// mock 服务端应答模式
#[derive(Clone, Copy)]
enum Mode {
    /// 完整 SSE 应答（content-length + connection: close）
    Complete,
    /// 只发首个增量帧后保持连接，直到客户端关闭
    Hold,
}

/// 读完一个请求（请求头 + content-length 请求体）；对端提前关闭返回 false
async fn read_request(sock: &mut TcpStream) -> bool {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        match sock.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_ascii_lowercase();
    let body_len = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while buf.len() < header_end + body_len {
        match sock.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    true
}

/// 读到对端关闭（EOF / 错误）
async fn drain_until_closed(sock: &mut TcpStream) {
    let mut chunk = [0u8; 1024];
    while matches!(sock.read(&mut chunk).await, Ok(n) if n > 0) {}
}

async fn serve_connection(mut sock: TcpStream, mode: Mode) {
    if !read_request(&mut sock).await {
        return;
    }
    match mode {
        Mode::Complete => {
            let body = format!("{CHAT_DELTA_FRAME}{CHAT_STOP_FRAME}");
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            if sock.write_all(response.as_bytes()).await.is_err() {
                return;
            }
            let _ = sock.shutdown().await;
        }
        Mode::Hold => {
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{CHAT_DELTA_FRAME}\r\n",
                CHAT_DELTA_FRAME.len()
            );
            if sock.write_all(response.as_bytes()).await.is_err() {
                return;
            }
            let _ = sock.flush().await;
        }
    }
    drain_until_closed(&mut sock).await;
}

/// 启动 mock 服务端：单一 accept 任务、连接串行处理（不再派生任务）
async fn spawn_server(mode: Mode) -> String {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定回环端口");
    let addr = listener.local_addr().expect("本地地址");
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            serve_connection(sock, mode).await;
        }
    });
    format!("http://{addr}")
}

fn provider_call(base_url: &str, signal: session_loop::AbortSignal) -> HttpProviderCall {
    let client = reqwest::Client::builder()
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .expect("构建 reqwest 客户端");
    let config = EngineProviderConfig {
        base_url: base_url.to_string(),
        api_key: "k-test".to_string(),
        model: "mock-model".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        // provider_id 为空 → fail-closed chat 剖面，不触碰进程级 live 目录
        ..Default::default()
    };
    HttpProviderCall::new(client, config).with_abort_signal(signal)
}

fn user_messages() -> Vec<Arc<AgentMessage>> {
    vec![Arc::new(AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-10-29T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "你好".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    })]
}

fn request(messages: &Vec<Arc<AgentMessage>>) -> ProviderRequest<'_> {
    ProviderRequest {
        messages,
        tools: Vec::new(),
        max_tokens: Some(64),
        system_prompt: None,
        session_id: None,
        reasoning_effort: None,
    }
}

/// 让出调度直至存活任务数回落至 `baseline`，返回最终计数。
/// 截止时限仅为回归（任务常驻）时的防挂死兜底。
async fn settle_alive_tasks(baseline: usize) -> usize {
    let metrics = tokio::runtime::Handle::current().metrics();
    let _ = tokio::time::timeout(Duration::from_secs(10), async {
        while metrics.num_alive_tasks() > baseline {
            tokio::task::yield_now().await;
        }
    })
    .await;
    metrics.num_alive_tasks()
}

/// M2：同一永不触发的信号下连续 50 次流式请求，每条流完整收尾后，
/// 存活任务数回到基线（旧中继 `spawn(wait_aborted → abort)` 每次请求常驻 1 个任务）
#[tokio::test]
async fn sequential_streams_under_idle_signal_leave_no_relay_tasks() {
    const REQUESTS: usize = 50;
    let base_url = spawn_server(Mode::Complete).await;
    let signal = session_loop::AbortSignal::new();
    let call = provider_call(&base_url, signal.clone());
    let messages = user_messages();
    let baseline = tokio::runtime::Handle::current()
        .metrics()
        .num_alive_tasks();

    for i in 0..REQUESTS {
        let mut stream = call
            .stream(&request(&messages))
            .await
            .unwrap_or_else(|err| panic!("第 {i} 次请求应成功：{err:?}"));
        let mut saw_text = false;
        let mut saw_stop = false;
        while let Some(item) = stream.next().await {
            match item.unwrap_or_else(|err| panic!("第 {i} 次流不应出错：{err:?}")) {
                ProviderStreamEvent::TextDelta { text } => {
                    assert_eq!(text, "hi");
                    saw_text = true;
                }
                ProviderStreamEvent::Stop { .. } => saw_stop = true,
                _ => {}
            }
        }
        assert!(saw_text && saw_stop, "第 {i} 次流应含正文与 stop");
    }

    assert!(!signal.is_aborted());
    assert_eq!(
        settle_alive_tasks(baseline).await,
        baseline,
        "{REQUESTS} 次请求后中止中继不得常驻"
    );
}

/// M2：流中途中止——收到首个增量后触发信号，流以 Aborted 错误条目终止、
/// 随后结束；丢弃流后中继与连接任务全部回收
#[tokio::test]
async fn mid_stream_abort_ends_stream_and_reclaims_tasks() {
    let base_url = spawn_server(Mode::Hold).await;
    let signal = session_loop::AbortSignal::new();
    let call = provider_call(&base_url, signal.clone());
    let messages = user_messages();
    let baseline = tokio::runtime::Handle::current()
        .metrics()
        .num_alive_tasks();

    let mut stream = call.stream(&request(&messages)).await.expect("请求应成功");
    loop {
        match stream.next().await {
            Some(Ok(ProviderStreamEvent::TextDelta { text })) => {
                assert_eq!(text, "hi");
                break;
            }
            Some(Ok(_)) => {}
            Some(Err(err)) => panic!("中止前不应出错：{err:?}"),
            None => panic!("服务端保持连接，中止前流不应结束"),
        }
    }

    signal.abort();
    // 服务端永不发完：流只能经中止收场（时限仅防回归挂死）
    let mut tail = tokio::time::timeout(Duration::from_secs(30), async {
        let mut tail = Vec::new();
        while let Some(item) = stream.next().await {
            tail.push(item);
        }
        tail
    })
    .await
    .expect("中止后流应收场");
    let last = tail.pop().expect("中止后应产出终止条目");
    let err = last.expect_err("中止后流应以错误条目终止");
    assert_eq!(
        err.kind,
        ProviderErrorKind::Aborted,
        "错误应分类为 Aborted：{err:?}"
    );
    assert!(
        tail.iter().all(|item| item.is_ok()),
        "Aborted 之前不应有其它错误条目：{tail:?}"
    );
    // 收集循环已读到 None（流结束）；Stream 契约不允许结束后再 poll，直接丢弃
    drop(stream);

    assert_eq!(
        settle_alive_tasks(baseline).await,
        baseline,
        "中途中止后中继与连接任务应回收"
    );
}
