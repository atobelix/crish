//! mock WS 服务端（仅测试用，agent-browser browser.rs:2627 先例）
//!
//! 绑定 `127.0.0.1:0`，accept 循环可接受多次连接（重连测试依赖），
//! 测试侧能力：
//! - `expect_command`：等待指定 method 的命令（断言发送序）
//! - `set_auto_reply`：按 method 自动应答（探测/恢复流程批量应答）
//! - `send_event` / `reply`：主动注入事件/响应
//! - `close_connection`：断开当前连接（触发客户端断线路径）
//! - `ping_count` / `connection_count`：心跳与重连断言

#![allow(dead_code)]

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

/// 自动应答策略。
#[derive(Clone)]
pub(crate) enum MockReply {
    /// 回 {"id":..,"result":<value>}
    Ok(Value),
    /// 回 {"id":..,"error":{"code":..,"message":..}}
    Error { code: i64, message: String },
    /// 不回包（超时/取消测试用）
    Silent,
}

pub(crate) struct MockServer {
    pub addr: SocketAddr,
    incoming: mpsc::Receiver<Value>,
    outgoing: broadcast::Sender<Message>,
    auto_reply: Arc<Mutex<HashMap<String, MockReply>>>,
    received_log: Arc<Mutex<Vec<Value>>>,
    ping_count: Arc<AtomicUsize>,
    conn_count: Arc<AtomicUsize>,
}

impl MockServer {
    pub async fn spawn() -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock 服务端绑定失败");
        let addr = listener.local_addr().expect("mock 地址获取失败");
        let (incoming_tx, incoming_rx) = mpsc::channel(512);
        let (outgoing_tx, _) = broadcast::channel(128);
        let auto_reply: Arc<Mutex<HashMap<String, MockReply>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let received_log: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let ping_count = Arc::new(AtomicUsize::new(0));
        let conn_count = Arc::new(AtomicUsize::new(0));

        // 任务侧克隆（原句柄留在 MockServer 供测试侧使用）
        let outgoing_tx_task = outgoing_tx.clone();
        let incoming_tx_task = incoming_tx.clone();
        let auto_reply_task = auto_reply.clone();
        let received_log_task = received_log.clone();
        let ping_count_task = ping_count.clone();
        let conn_count_task = conn_count.clone();

        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(w) => w,
                    Err(_) => continue,
                };
                conn_count_task.fetch_add(1, Ordering::SeqCst);
                let (mut sink, mut reader) = ws.split();
                let mut outgoing_rx = outgoing_tx_task.subscribe();
                let outgoing_tx_conn = outgoing_tx_task.clone();
                let incoming_tx = incoming_tx_task.clone();
                let auto_reply = auto_reply_task.clone();
                let received_log = received_log_task.clone();
                let ping_count = ping_count_task.clone();
                tokio::spawn(async move {
                    // 出站转发：事件/响应/Close 帧 → 当前连接 sink
                    let fwd = tokio::spawn(async move {
                        loop {
                            match outgoing_rx.recv().await {
                                Ok(msg) => {
                                    if sink.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(_) => break,
                            }
                        }
                    });
                    // 入站解析：记录 + 自动应答
                    while let Some(Ok(msg)) = reader.next().await {
                        match msg {
                            Message::Text(text) => {
                                let v: Value = match serde_json::from_str(&text) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                                received_log
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .push(v.clone());
                                let method = v["method"].as_str().unwrap_or_default().to_string();
                                let reply = {
                                    auto_reply
                                        .lock()
                                        .unwrap_or_else(|p| p.into_inner())
                                        .get(&method)
                                        .cloned()
                                };
                                if let Some(reply) = reply {
                                    let id = v["id"].as_u64();
                                    match reply {
                                        MockReply::Ok(result) => {
                                            if let Some(id) = id {
                                                let mut msg = json!({ "id": id, "result": result });
                                                if let Some(s) = v["sessionId"].as_str() {
                                                    msg["sessionId"] = Value::String(s.to_string());
                                                }
                                                let _ = outgoing_tx_conn
                                                    .send(Message::Text(msg.to_string().into()));
                                            }
                                        }
                                        MockReply::Error { code, message } => {
                                            if let Some(id) = id {
                                                let mut msg = json!({
                                                    "id": id,
                                                    "error": { "code": code, "message": message }
                                                });
                                                if let Some(s) = v["sessionId"].as_str() {
                                                    msg["sessionId"] = Value::String(s.to_string());
                                                }
                                                let _ = outgoing_tx_conn
                                                    .send(Message::Text(msg.to_string().into()));
                                            }
                                        }
                                        MockReply::Silent => {}
                                    }
                                }
                                if incoming_tx.send(v).await.is_err() {
                                    break;
                                }
                            }
                            Message::Ping(_) => {
                                ping_count.fetch_add(1, Ordering::SeqCst);
                            }
                            Message::Close(_) => break,
                            Message::Pong(_) => {}
                            Message::Binary(_) | Message::Frame(_) => {}
                        }
                    }
                    fwd.abort();
                });
            }
        });

        MockServer {
            addr,
            incoming: incoming_rx,
            outgoing: outgoing_tx,
            auto_reply,
            received_log,
            ping_count,
            conn_count,
        }
    }

    /// 客户端连接 URL（ws_path 自定义，模拟 DevToolsActivePort 的 per-session UUID 路径）。
    pub fn url(&self, ws_path: &str) -> String {
        format!(
            "ws://127.0.0.1:{}/{}",
            self.addr.port(),
            ws_path.trim_start_matches('/')
        )
    }

    /// 按 method 注册自动应答（探测/恢复流程批量应答用）。
    pub fn set_auto_reply(&self, method: &str, reply: MockReply) {
        self.auto_reply
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(method.to_string(), reply);
    }

    /// 收到的 Ping 帧计数（心跳断言）。
    pub fn ping_count(&self) -> usize {
        self.ping_count.load(Ordering::SeqCst)
    }

    /// 已建立的连接数（重连断言）。
    pub fn connection_count(&self) -> usize {
        self.conn_count.load(Ordering::SeqCst)
    }

    /// 已收到的命令总数（幂等合并「仅一次发送」断言）。
    pub fn commands_seen(&self) -> usize {
        self.received_log
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }

    /// 等待下一条命令（返回命令 JSON）。
    pub async fn next_command(&mut self) -> Value {
        self.incoming.recv().await.expect("mock 入站通道关闭")
    }

    /// 等待指定 method 的命令（跳过其他方法）。
    pub async fn expect_command(&mut self, method: &str) -> Value {
        loop {
            let cmd = self.next_command().await;
            if cmd["method"].as_str() == Some(method) {
                return cmd;
            }
        }
    }

    /// 向当前连接发送事件帧。
    pub fn send_event(&self, method: &str, params: Value, session: Option<&str>) {
        let mut msg = json!({ "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = Value::String(s.to_string());
        }
        let _ = self.outgoing.send(Message::Text(msg.to_string().into()));
    }

    /// 向当前连接回响应（result）。
    pub fn reply(&self, id: u64, result: Value) {
        let msg = json!({ "id": id, "result": result });
        let _ = self.outgoing.send(Message::Text(msg.to_string().into()));
    }

    /// 向当前连接回错误响应。
    pub fn reply_error(&self, id: u64, code: i64, message: &str) {
        let msg = json!({ "id": id, "error": { "code": code, "message": message } });
        let _ = self.outgoing.send(Message::Text(msg.to_string().into()));
    }

    /// 关闭当前连接（触发客户端断线路径）。
    pub fn close_connection(&self) {
        let _ = self.outgoing.send(Message::Close(None));
    }
}
