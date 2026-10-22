//! attach 型 MCP 会话面（R-12，39-E3）：loopback WS 服务端，命令逐条经统一发送层，
//! 事件按只读能力集白名单透传。

use super::{CancellationToken, Command, CommandSender};
use crate::cdp::error::{BrowserError, CdpError};
use crate::cdp::session_caps::ReadonlyCaps;
use crate::cdp::types::CdpEvent;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::fmt;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::WebSocketStream;

/// attach 会话面 WS 发送侧（命令回包与事件泵共享；tokio Mutex 跨 await 安全）。
type AttachSink = Arc<
    tokio::sync::Mutex<
        futures_util::stream::SplitSink<WebSocketStream<tokio::net::TcpStream>, Message>,
    >,
>;

/// attach 型 MCP 会话面（R-12，39-E3 接线：sender/transport 挂载点）。
///
/// 引擎侧 CDP 会话面：loopback WS 服务端（随机端口），供外部浏览器类 MCP
/// （chrome-devtools-mcp 族）attach。**命令逐条经 [CommandSender::execute] 五段
/// 管线执行**——⓪ 能力集拦截（attach_caps）在真实连接路径生效，非白名单命令
/// 返回 CDP 线格式错误（code -32000 + `capability_disabled` 前缀，语义对齐
/// `tool.browser.capability_disabled`）；**事件经 [ReadonlyCaps::filter_events]
/// 只透传白名单事件**（非白名单事件静默丢弃，fail-closed 透传面）。
///
/// 装配约束（安全红线）：
/// - 仅绑定 `127.0.0.1`（loopback），端口即令牌（DevToolsActivePort 双层
///   不透明 token 同语义，10 §7.3）；
/// - bind 前置自检 [CommandSender::has_attach_caps]——hooks 未注入只读能力集
///   视为接线不完整，拒绝启动（防静默无拦截）；
/// - 会话建立命令（`Target.getTargets/attachToTarget/setAutoAttach/
///   detachFromTarget`）在白名单内（39-E3 实测补充：只读面可达性必需），
///   页面操作面仍逐命令 fail-closed。
///
/// 遗留（引擎装配 seam，域外）：E-1 注入 `--browserUrl` 指向本会话面的
/// `browser_url()`；HTTP `/json/version`/`/json/list` 发现面与 URL 改写、
/// AllowAllPolicy 注入 attach_caps 属引擎侧接线，见 39-E3 报告 §遗留。
pub struct AttachCdpProxy {
    addr: SocketAddr,
    shutdown: CancellationToken,
    accept_task: tokio::task::JoinHandle<()>,
    conn_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl fmt::Debug for AttachCdpProxy {
    /// Debug 输出脱敏（10 §7.3 硬要求：端口不进日志）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AttachCdpProxy { <redacted> }")
    }
}

impl AttachCdpProxy {
    /// 挂载 attach 会话面（loopback 随机端口，端口即令牌）。
    ///
    /// - `sender`：统一发送层（**前置自检 has_attach_caps 必须为 true**，否则
    ///   拒绝启动——接线不完整不产生静默无拦截面）；
    /// - `caps`：只读能力集（事件面过滤用；命令面由 sender 的 attach_caps 拦截）；
    /// - `events`：引擎连接的事件流（`CdpClient::subscribe` / `Transport::
    ///   subscribe_events`），经 caps 过滤后转发给外部连接。
    pub async fn bind(
        sender: Arc<CommandSender>,
        caps: Arc<ReadonlyCaps>,
        events: broadcast::Receiver<CdpEvent>,
    ) -> Result<Self, BrowserError> {
        if !sender.has_attach_caps() {
            return Err(BrowserError::Internal(
                "attach 会话面装配失败：hooks 未注入只读能力集（attach_caps=None），拒绝启动——接线不完整（R-12 红线）".to_string(),
            ));
        }
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| BrowserError::Io(format!("attach 会话面绑定失败：{e}")))?;
        let addr = listener
            .local_addr()
            .map_err(|e| BrowserError::Io(format!("attach 会话面地址获取失败：{e}")))?;
        let shutdown = CancellationToken::new();
        let conn_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> =
            Arc::new(Mutex::new(Vec::new()));
        let shutdown_task = shutdown.clone();
        let conn_tasks_task = conn_tasks.clone();
        let sender_task = sender.clone();
        let caps_task = caps.clone();
        let accept_task = tokio::spawn(async move {
            loop {
                let (stream, _) = match tokio::select! {
                    r = listener.accept() => r,
                    _ = shutdown_task.cancelled() => break,
                } {
                    Ok(v) => v,
                    Err(_) => break,
                };
                // WS 握手失败（非 CDP 客户端）不中断 accept 循环
                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(_) => continue,
                };
                let sender_conn = sender_task.clone();
                let caps_conn = caps_task.clone();
                let events_conn = events.resubscribe();
                let shutdown_conn = shutdown_task.clone();
                let handle = tokio::spawn(async move {
                    handle_attach_connection(
                        ws,
                        sender_conn,
                        caps_conn,
                        events_conn,
                        shutdown_conn,
                    )
                    .await;
                });
                conn_tasks_task
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(handle);
            }
        });
        Ok(AttachCdpProxy {
            addr,
            shutdown,
            accept_task,
            conn_tasks,
        })
    }

    /// 暴露端口（attach 端点 token，`--browserUrl` 注入形态）。
    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// E-1 注入形态：`http://127.0.0.1:<port>`（外部 MCP `--browserUrl` 指向）。
    pub fn browser_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }

    /// 本会话面 WS 端点（发现面 /json/version 改写的目标形态；引擎装配遗留）。
    pub fn ws_url(&self) -> String {
        format!(
            "ws://127.0.0.1:{}/devtools/browser/attach",
            self.addr.port()
        )
    }

    /// 收尾：取消接受循环并断开全部外部连接（会话结束/开关关闭路径）。
    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        self.accept_task.abort();
        let tasks = std::mem::take(&mut *self.conn_tasks.lock().unwrap_or_else(|p| p.into_inner()));
        for t in tasks {
            t.abort();
        }
    }
}

/// 单条外部连接处理：命令循环（经统一发送层）+ 事件泵（白名单透传）双并发。
async fn handle_attach_connection(
    ws: WebSocketStream<tokio::net::TcpStream>,
    sender: Arc<CommandSender>,
    caps: Arc<ReadonlyCaps>,
    events: broadcast::Receiver<CdpEvent>,
    shutdown: CancellationToken,
) {
    let (sink, mut stream) = ws.split();
    let sink: AttachSink = Arc::new(tokio::sync::Mutex::new(sink));

    // —— 事件泵：只透传白名单事件（fail-closed 透传面）——
    let mut filter = caps.filter_events(events);
    let pump_sink = sink.clone();
    let pump_shutdown = shutdown.clone();
    let event_pump = tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                e = filter.next_allowed() => e,
                _ = pump_shutdown.cancelled() => None,
            };
            let Some(event) = next else { break };
            let mut msg = json!({ "method": event.method, "params": event.params });
            if let Some(s) = &event.session_id {
                msg["sessionId"] = Value::String(s.clone());
            }
            let mut s = pump_sink.lock().await;
            if s.send(Message::Text(msg.to_string().into())).await.is_err() {
                break;
            }
        }
    });

    // —— 命令循环：逐条经统一发送层（⓪ 能力集拦截在真实路径生效）——
    loop {
        let msg = tokio::select! {
            m = stream.next() => m,
            _ = shutdown.cancelled() => None,
        };
        let Some(Ok(msg)) = msg else { break };
        match msg {
            Message::Text(text) => {
                if let Some(reply) = handle_attach_command(text.as_str(), &sender).await {
                    let mut s = sink.lock().await;
                    if s.send(Message::Text(reply.into())).await.is_err() {
                        break;
                    }
                }
            }
            Message::Ping(payload) => {
                let mut s = sink.lock().await;
                if s.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Pong(_) => {}
            Message::Binary(_) | Message::Frame(_) => {}
        }
    }
    event_pump.abort();
}

/// 处理一条外部命令帧：经统一发送层执行并回包；非命令帧（响应/畸形）忽略。
async fn handle_attach_command(text: &str, sender: &CommandSender) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let method = v.get("method").and_then(|m| m.as_str())?;
    let id = v.get("id").cloned().unwrap_or(Value::Null);
    let session_id = v
        .get("sessionId")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    let mut cmd = Command::new(method.to_string())
        .params(params)
        // 审计目标摘要：attach 会话面无页面摘要面，以会话面标识标记
        .with_summary("mcp-attach");
    if let Some(sid) = &session_id {
        cmd = cmd.with_session(sid.clone());
    }
    let result = sender.execute(cmd).await;
    let mut reply = match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(err) => {
            let (code, message) = cdp_error_to_wire(&err);
            json!({ "id": id, "error": { "code": code, "message": message } })
        }
    };
    if let Some(s) = &session_id {
        reply["sessionId"] = Value::String(s.clone());
    }
    Some(reply.to_string())
}

/// 引擎错误 → CDP 线格式错误（attach 会话面回包面；能力集拒绝带
/// `capability_disabled` 前缀，语义对齐 `tool.browser.capability_disabled`）。
fn cdp_error_to_wire(err: &CdpError) -> (i64, String) {
    match err {
        CdpError::CapabilityDenied { method } => (
            -32000,
            format!(
                "capability_disabled: 会话只读能力集拒绝[{method}]（attach 会话仅授予只读命令域）"
            ),
        ),
        CdpError::Protocol { message, .. }
        | CdpError::Internal { message, .. }
        | CdpError::Serialize { message, .. } => (-32603, message.clone()),
        CdpError::DomainUnavailable { method } => (-32601, format!("域/方法不支持[{method}]")),
        CdpError::BadParams { message, .. } => (-32602, message.clone()),
        CdpError::Server { code, message } => (*code, message.clone()),
        CdpError::ContextGone { message, .. } => (-32000, message.clone()),
        CdpError::Timeout { method, elapsed } => (
            -32000,
            format!("命令超时[{method}]：{}ms", elapsed.as_millis()),
        ),
        CdpError::ConnectionLost => (-32000, "CDP 连接已丢失".to_string()),
        CdpError::Cancelled { .. } => (-32000, "命令已取消".to_string()),
        CdpError::ApprovalDenied { reason } => (-32000, reason.clone()),
        CdpError::NotReady(detail) => (-32000, format!("浏览器恢复中：{detail}")),
        CdpError::NoActiveTab => (-32000, "无活动标签会话".to_string()),
        CdpError::NoSuchTab { tab_id } => (-32000, format!("标签 {tab_id} 不存在或已关闭")),
    }
}
