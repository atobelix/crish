//! 核心客户端（维度 11 §2.5 并发命令管理 + 参考实现 agent-browser cdp/client.rs）
//!
//! - reader 循环：按 WS 帧序解析 → 响应经 pending oneshot 直传、事件经 broadcast 扇出
//! - pending 表：`std::sync::Mutex<HashMap<u64, oneshot::Sender<CdpMessage>>>`（短临界区，
//!   Drop 同步清理，杜绝 #1528 孤儿泄漏且测试可确定性断言）
//! - `PendingGuard`：await 中途取消（abort 抢断/超时）时 Drop 移除 pending 项
//! - keepalive：独立任务按间隔发 WS Ping（30s 默认，可注入）；发送失败即退出
//! - 断线判定唯一可信信号：reader 循环退出（Close 帧/Err/EOF）→ 清空 pending +
//!   置 lost watch（ping 无 pong 不判定，WS 标准允许对端不答 pong）
//! - reader 永不 panic 退出（宽容解析 + 事件解析失败记 warning 丢弃），防断连死循环
//! - 帧/消息级上限（M1）：ConnectConfig.max_frame_size（默认 16MB）/max_message_size
//!   （默认 64MB）——对抗性超大载荷在传输层即拒（reader 报错断开），防整包缓冲内存尖峰
//! - Drop 收尾（M3）：abort reader/keepalive 任务，弃置客户端不留常驻任务

use crate::cdp::error::{BrowserError, CdpError};
use crate::cdp::types::{CdpCommand, CdpEvent, CdpMessage};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, oneshot, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::WebSocketStream;

/// 默认命令超时（agent-browser client.rs:271 同款）。
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// 握手超时（10s，§2.2 连接级超时）。
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// 默认心跳间隔（WS Ping，§2.2）。
pub const WS_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// 默认 WS 单帧大小上限（16MB：远超 150KB 采集护栏的合法面，防对抗性超大载荷
/// 整包缓冲导致内存尖峰，M1）。
pub const DEFAULT_MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;
/// 默认 WS 单消息累计上限（64MB：多帧合成的单条消息累计，M1）。
pub const DEFAULT_MAX_MESSAGE_SIZE: usize = 64 * 1024 * 1024;

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<CdpMessage>>>>;

/// 连接配置（心跳间隔/握手超时可注入，测试用）。
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub heartbeat: Duration,
    pub handshake_timeout: Duration,
    /// WS 单帧大小上限（超限帧读取报错 → reader 断开连接，M1；None = 不设限）
    pub max_frame_size: Option<usize>,
    /// WS 单消息累计大小上限（多帧累计超限同样报错断开，M1；None = 不设限）
    pub max_message_size: Option<usize>,
}

impl Default for ConnectConfig {
    fn default() -> Self {
        ConnectConfig {
            heartbeat: WS_KEEPALIVE_INTERVAL,
            handshake_timeout: HANDSHAKE_TIMEOUT,
            max_frame_size: Some(DEFAULT_MAX_FRAME_SIZE),
            max_message_size: Some(DEFAULT_MAX_MESSAGE_SIZE),
        }
    }
}

/// 传输句柄类型（WS 流收发分离后的发送侧）。
/// 使用 `tokio::sync::Mutex`：发送为异步操作，tokio MutexGuard 跨 await 安全
/// （std MutexGuard 非 Send，会污染上层任务）。
type WsTx = Arc<
    tokio::sync::Mutex<
        futures_util::stream::SplitSink<
            WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
            Message,
        >,
    >,
>;

/// 移除 await 中途被取消的 pending 项（#1528 回归：防孤儿泄漏）。
/// 正常完成路径由 `done` 解除；Drop 内同步清理（std Mutex 短临界区）。
struct PendingGuard {
    pending: PendingMap,
    id: u64,
    done: bool,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // 锁纪律（B8）：中毒时恢复数据继续清理，不 panic
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

/// 单连接 CDP 客户端（无重连语义；重连由 transport.rs 编排）。
/// 多任务共享请包一层 `Arc<CdpClient>`（id 唯一性依赖同一 next_id 实例）。
pub struct CdpClient {
    ws_tx: WsTx,
    next_id: AtomicU64,
    pending: PendingMap,
    event_tx: broadcast::Sender<CdpEvent>,
    lost_tx: watch::Sender<bool>,
    reader_handle: tokio::task::JoinHandle<()>,
    keepalive_handle: tokio::task::JoinHandle<()>,
}

impl Drop for CdpClient {
    /// 收尾（M3）：abort reader/keepalive 任务——Drop 不可 await；任务终止即
    /// 释放 WS 流句柄（读半随 reader future drop 关闭，写半随本结构 drop 关闭），
    /// 杜绝「客户端被弃置但任务与连接残留」的任务泄漏。
    fn drop(&mut self) {
        self.reader_handle.abort();
        self.keepalive_handle.abort();
    }
}

impl CdpClient {
    /// 建立连接（默认配置）。
    pub async fn connect(url: &str) -> Result<Self, BrowserError> {
        Self::connect_with_config(url, ConnectConfig::default()).await
    }

    /// 建立连接（自定义心跳/握手超时）。
    pub async fn connect_with_config(
        url: &str,
        config: ConnectConfig,
    ) -> Result<Self, BrowserError> {
        Self::connect_inner(url, None, config).await
    }

    /// 预留：外部 CDP 代理端点（MCP 桥二期）需要自定义 header 时使用；主路径不用
    /// （agent-browser client.rs:78-96 同款；CDP 握手不支持鉴权 header，本接口仅
    /// 供代理场景，主路径走 ws_path bearer 三重校验，见 transport.rs）。
    #[allow(dead_code)]
    pub async fn connect_with_headers(
        url: &str,
        headers: Vec<(String, String)>,
    ) -> Result<Self, BrowserError> {
        Self::connect_inner(url, Some(headers), ConnectConfig::default()).await
    }

    async fn connect_inner(
        url: &str,
        headers: Option<Vec<(String, String)>>,
        config: ConnectConfig,
    ) -> Result<Self, BrowserError> {
        let mut request = url
            .into_client_request()
            .map_err(|e| BrowserError::Connect(format!("无效的 WebSocket URL：{e}")))?;

        if let Some(hdrs) = headers {
            let req_headers = request.headers_mut();
            for (key, value) in hdrs {
                if let (Ok(name), Ok(val)) = (
                    key.parse::<tokio_tungstenite::tungstenite::http::header::HeaderName>(),
                    value.parse::<tokio_tungstenite::tungstenite::http::header::HeaderValue>(),
                ) {
                    req_headers.insert(name, val);
                }
            }
        }

        // 不携带 Origin 头（Chromium 对 loopback + 无 Origin 放行）；大消息不被
        // 截断 → 帧/消息级上限折中（M1：16MB 单帧 / 64MB 消息累计，可配；远超
        // 150KB 采集护栏的合法面，对抗性超大响应在传输层即被拒，杜绝整包缓冲
        // 后的内存尖峰；超限帧读取报错 → reader 退出 → 连接按断线路径收敛）
        let ws_config = WebSocketConfig::default()
            .max_frame_size(config.max_frame_size)
            .max_message_size(config.max_message_size);

        // 握手（10s 超时）；不携带 Origin 头（Chromium 对 loopback + 无 Origin 放行）
        let (ws_stream, _) = tokio::time::timeout(config.handshake_timeout, {
            tokio_tungstenite::connect_async_with_config(request, Some(ws_config), false)
        })
        .await
        .map_err(|_| BrowserError::HandshakeTimeout)?
        .map_err(|e| BrowserError::Connect(format!("CDP WebSocket 握手失败：{e}")))?;

        // TCP keepalive（30s/10s，best-effort，系统层兜底）
        enable_tcp_keepalive(ws_stream.get_ref());

        let (ws_tx, mut ws_rx) = ws_stream.split();
        let ws_tx = Arc::new(tokio::sync::Mutex::new(ws_tx));

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, _) = broadcast::channel(4096);
        let (lost_tx, _) = watch::channel(false);

        let pending_clone = pending.clone();
        let event_tx_clone = event_tx.clone();
        let lost_tx_clone = lost_tx.clone();

        // 心跳任务取消通道：reader 退出即停止 ping
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);

        // —— reader 循环（唯一断线判定源）——
        let reader_handle = tokio::spawn(async move {
            while let Some(msg) = ws_rx.next().await {
                // Text 与 Binary 帧均接受（代理端点可能发 Binary，UTF-8 兜底解析）
                let text = match msg {
                    Ok(Message::Text(text)) => text.to_string(),
                    Ok(Message::Binary(data)) => match String::from_utf8(data.to_vec()) {
                        Ok(text) => text,
                        Err(_) => continue,
                    },
                    Ok(Message::Ping(_)) => {
                        // tungstenite 协议层自动回 Pong，这里仅继续
                        continue;
                    }
                    Ok(_) => continue, // Close/Pong/Frame 等
                    Err(e) => {
                        tracing::debug!("CDP 连接读取错误：{e}");
                        break;
                    }
                };
                // 宽容解析：信封全字段 Option；解析失败记 warning 丢弃，不炸 reader
                let parsed: CdpMessage = match serde_json::from_str(&text) {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("CDP 消息解析失败（丢弃）：{e}");
                        continue;
                    }
                };
                if let Some(id) = parsed.id {
                    // 命令响应：pending 路由（未知 id 忽略，防负 id 调试代理流量）
                    let mut pending = pending_clone.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(parsed);
                    }
                } else if let Some(ref method) = parsed.method {
                    // 事件：broadcast 扇出
                    let event = CdpEvent {
                        method: method.clone(),
                        params: parsed.params.clone().unwrap_or(Value::Null),
                        session_id: parsed.session_id.clone(),
                    };
                    let _ = event_tx_clone.send(event);
                }
            }
            // reader 退出 = 连接丢失：清空全部 pending（await 方立即 channel-closed，
            // 不等 30s 超时），并通知 keepalive 停止
            pending_clone
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
            let _ = cancel_tx.send(true);
            let _ = lost_tx_clone.send(true);
        });

        // —— keepalive 任务（WS Ping；发送失败即退出）——
        let keepalive_tx = ws_tx.clone();
        let keepalive_handle = tokio::spawn(async move {
            let interval = config.heartbeat;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {}
                    _ = cancel_rx.changed() => break,
                }
                let mut tx = keepalive_tx.lock().await;
                if tx.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
        });

        Ok(Self {
            ws_tx,
            next_id: AtomicU64::new(1),
            pending,
            event_tx,
            lost_tx,
            reader_handle,
            keepalive_handle,
        })
    }

    /// 发送命令并等待响应（默认 30s 超时，§2.3 常规命令）。
    pub async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<Value, CdpError> {
        self.send_command_with_timeout(method, params, session_id, DEFAULT_COMMAND_TIMEOUT)
            .await
    }

    /// 发送命令并等待响应（自定义超时）。
    pub async fn send_command_with_timeout(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cmd = CdpCommand {
            id,
            method: method.to_string(),
            params,
            session_id: session_id.filter(|s| !s.is_empty()).map(|s| s.to_string()),
        };
        let json = serde_json::to_string(&cmd).map_err(|e| CdpError::Serialize {
            method: method.to_string(),
            message: e.to_string(),
        })?;

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.insert(id, tx);
        }

        // 取消中间态清理：本 future 被 abort 时 Drop 移除 pending（#1528）
        let mut guard = PendingGuard {
            pending: self.pending.clone(),
            id,
            done: false,
        };

        {
            let mut ws_tx = self.ws_tx.lock().await;
            ws_tx
                .send(Message::Text(json.into()))
                .await
                .map_err(|_| CdpError::ConnectionLost)?;
        }

        let send_started = tokio::time::Instant::now();
        let response = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => {
                guard.done = true;
                resp
            }
            // 通道关闭 = 连接已断（reader 清空了 pending）
            Ok(Err(_)) => {
                guard.done = true;
                return Err(CdpError::ConnectionLost);
            }
            Err(_) => {
                // 超时：同步移除 pending（确定性断言依赖），guard 置完成
                guard.done = true;
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                return Err(CdpError::Timeout {
                    method: method.to_string(),
                    elapsed: send_started.elapsed(),
                });
            }
        };

        if let Some(error) = response.error {
            return Err(CdpError::from_wire(method, &error));
        }

        Ok(response.result.unwrap_or(Value::Null))
    }

    /// 发送命令但不等待响应（best-effort，enable 序列等）。
    pub async fn send_command_no_wait(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<(), CdpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let cmd = CdpCommand {
            id,
            method: method.to_string(),
            params,
            session_id: session_id.filter(|s| !s.is_empty()).map(|s| s.to_string()),
        };
        let json = serde_json::to_string(&cmd).map_err(|e| CdpError::Serialize {
            method: method.to_string(),
            message: e.to_string(),
        })?;
        let mut ws_tx = self.ws_tx.lock().await;
        ws_tx
            .send(Message::Text(json.into()))
            .await
            .map_err(|_| CdpError::ConnectionLost)
    }

    /// 订阅原始事件（CdpEvent 面，供事件总线泵转译）。
    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.event_tx.subscribe()
    }

    /// 断线信号（reader 退出置 true）。
    pub fn lost(&self) -> watch::Receiver<bool> {
        self.lost_tx.subscribe()
    }

    /// 发送 Close 帧（优雅关闭，best-effort）。
    pub async fn close(&self) {
        let mut ws_tx = self.ws_tx.lock().await;
        let _ = ws_tx.send(Message::Close(None)).await;
    }

    /// 测试专用：在途命令数（取消/超时清理断言，#1528 回归）。
    #[cfg(test)]
    pub(crate) async fn pending_len(&self) -> usize {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
}

/// request id：`AtomicU64::new(1)` + `fetch_add`（SeqCst）单调递增，u64 溢出无需处理。
///
/// 启用 TCP SO_KEEPALIVE（30s/10s，best-effort；agent-browser client.rs:415-435 同款）。
/// 本 crate 无 TLS feature，loopback 场景恒为 Plain；未来加 TLS 分支时补 Rustls 匹配。
fn enable_tcp_keepalive(stream: &tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>) {
    let tcp_stream = match stream {
        tokio_tungstenite::MaybeTlsStream::Plain(s) => s,
        _ => return,
    };
    let sock = socket2::SockRef::from(tcp_stream);
    let keepalive = socket2::TcpKeepalive::new().with_time(Duration::from_secs(30));
    #[cfg(not(any(target_os = "openbsd", target_os = "haiku")))]
    let keepalive = keepalive.with_interval(Duration::from_secs(10));
    let _ = sock.set_tcp_keepalive(&keepalive);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use serde_json::json;

    /// 建连帮助：mock 服务端 + 直连客户端（默认 ws_path；Arc 供多任务共享）。
    async fn connect_pair() -> (MockServer, Arc<CdpClient>) {
        let mock = MockServer::spawn().await;
        let client = Arc::new(
            CdpClient::connect(&mock.url("/devtools/browser/mock-test"))
                .await
                .expect("客户端建连失败"),
        );
        (mock, client)
    }

    /// 验收 9.1-4：并发 100 命令 id 严格递增无重复
    #[tokio::test]
    async fn client_id_monotonic() {
        let (mut mock, client) = connect_pair().await;
        // 自动应答全部命令
        mock.set_auto_reply("Runtime.evaluate", MockReply::Ok(json!({ "result": {} })));

        let mut handles = Vec::new();
        for _ in 0..100 {
            let client = client.clone();
            handles.push(tokio::spawn(async move {
                client
                    .send_command("Runtime.evaluate", Some(json!({ "expression": "1" })), None)
                    .await
            }));
        }
        for h in handles {
            h.await.expect("任务失败").expect("命令失败");
        }
        // 100 条命令全部到达 mock，且 id 严格递增无重复
        let mut ids = Vec::new();
        for _ in 0..100 {
            let cmd = mock.next_command().await;
            ids.push(cmd["id"].as_u64().expect("id 缺失"));
        }
        assert_eq!(ids.len(), 100);
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        assert_eq!(ids, sorted, "id 应单调递增");
        sorted.dedup();
        assert_eq!(sorted.len(), 100, "id 不应重复");
    }

    /// 验收 9.1-5：await 中途 abort → pending_len()==0（#1528 回归断言）
    #[tokio::test]
    async fn client_cancel_cleans_pending() {
        let (mock, client) = connect_pair().await;
        let _ = mock; // 不回包（Silent 默认）

        // select 抢断：sleep 分支先完成 → send_command future 被同步 drop
        let mut send =
            Box::pin(client.send_command("Page.navigate", Some(json!({ "url": "x" })), None));
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            _ = &mut send => panic!("不应收到响应"),
        }
        // 显式 drop 被抢断的 future → PendingGuard Drop 同步移除 pending 项
        drop(send);
        assert_eq!(client.pending_len().await, 0, "取消后不得遗留孤儿 pending");
    }

    /// 验收 9.1-6：mock 不回包 + 短超时 → Timeout 且 pending 清空
    #[tokio::test]
    async fn client_timeout_cleans_pending() {
        let (mock, client) = connect_pair().await;
        let _ = mock; // 不回包

        let err = client
            .send_command_with_timeout("Page.navigate", None, None, Duration::from_millis(80))
            .await
            .expect_err("应超时");
        assert!(matches!(
            err,
            CdpError::Timeout { ref method, .. } if method == "Page.navigate"
        ));
        assert_eq!(client.pending_len().await, 0, "超时后 pending 必须清空");
    }

    /// 验收 9.1-7：同 id 不同 session 响应路由正确（双层路由语义）
    #[tokio::test]
    async fn client_response_routed_by_session() {
        let (mut mock, client) = connect_pair().await;

        // 命令经独立任务发送（主任务等待命令到达 mock 后再回包，避免 join 死锁）
        let c = client.clone();
        let t1 = tokio::spawn(async move {
            c.send_command(
                "Runtime.evaluate",
                Some(json!({ "expression": "1" })),
                Some("session-a"),
            )
            .await
        });
        let c = client.clone();
        let t2 = tokio::spawn(async move {
            c.send_command(
                "Runtime.evaluate",
                Some(json!({ "expression": "2" })),
                Some("session-b"),
            )
            .await
        });

        // 收到两条命令（id 各自分配），按 id 回包
        let c1 = mock.next_command().await;
        let c2 = mock.next_command().await;
        let id1 = c1["id"].as_u64().unwrap();
        let id2 = c2["id"].as_u64().unwrap();
        assert_ne!(id1, id2);
        assert_eq!(c1["sessionId"], "session-a");
        assert_eq!(c2["sessionId"], "session-b");

        // 乱序回包（先回 id2 再回 id1），各自仍应路由到对应调用方
        mock.reply(id2, json!({ "v": "b" }));
        mock.reply(id1, json!({ "v": "a" }));

        let r1 = t1.await.expect("任务 a 失败").expect("命令 a 失败");
        let r2 = t2.await.expect("任务 b 失败").expect("命令 b 失败");
        assert_eq!(r1["v"], "a");
        assert_eq!(r2["v"], "b");
    }

    /// 验收 9.1-8：服务端关闭 → 全部 pending 立即 channel-closed（不等 30s）
    #[tokio::test]
    async fn client_connection_close_flushes_pending() {
        let (mut mock, client) = connect_pair().await;

        // 并发 5 条命令（不回包）
        let mut handles = Vec::new();
        for i in 0..5 {
            let client = client.clone();
            handles.push(tokio::spawn(async move {
                client
                    .send_command("Runtime.evaluate", Some(json!({ "expression": i })), None)
                    .await
            }));
        }
        // 等命令确实进入 pending（mock 侧收到）
        for _ in 0..5 {
            mock.next_command().await;
        }
        assert_eq!(client.pending_len().await, 5);

        // 关闭连接 → 全部 pending 立即失败（不得等 30s 超时）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        mock.close_connection();
        for h in handles {
            let err = h
                .await
                .expect("任务失败")
                .expect_err("连接关闭后应报 ConnectionLost");
            assert!(matches!(err, CdpError::ConnectionLost), "实际错误：{err}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "断线必须即刻返回，不等超时"
        );
        assert_eq!(client.pending_len().await, 0);
    }

    /// 超限帧拒绝（M1）：超过 max_frame_size 的对抗性超大帧 → reader 报错断开
    /// → lost 信号置位（传输层即拒，不做整包缓冲）。
    #[tokio::test]
    async fn client_rejects_oversized_frame() {
        let mock = MockServer::spawn().await;
        let client = CdpClient::connect_with_config(
            &mock.url("/devtools/browser/oversize-frame"),
            ConnectConfig {
                max_frame_size: Some(1024),
                max_message_size: Some(16 * 1024 * 1024),
                ..Default::default()
            },
        )
        .await
        .expect("建连失败");
        let mut lost = client.lost();
        // 对抗性超大载荷：4096B 单帧超出 1024B 帧上限
        mock.send_event(
            "Page.oversized",
            json!({ "payload": "x".repeat(4096) }),
            None,
        );
        wait_lost(&mut lost, "超大帧应触发连接断开（超限报错）").await;
    }

    /// 超限消息拒绝（M1）：帧不设限、消息累计超 max_message_size（多帧合成大
    /// 消息场景）→ reader 报错断开。
    #[tokio::test]
    async fn client_rejects_oversized_message() {
        let mock = MockServer::spawn().await;
        let client = CdpClient::connect_with_config(
            &mock.url("/devtools/browser/oversize-msg"),
            ConnectConfig {
                max_frame_size: None,
                max_message_size: Some(1024),
                ..Default::default()
            },
        )
        .await
        .expect("建连失败");
        let mut lost = client.lost();
        mock.send_event(
            "Page.oversized",
            json!({ "payload": "x".repeat(4096) }),
            None,
        );
        wait_lost(&mut lost, "累计消息超限应触发连接断开").await;
    }

    /// 正常消息不受影响（M1 否定面）：限内大消息仍正常解析路由。
    #[tokio::test]
    async fn client_accepts_message_within_limits() {
        let (mut mock, client) = connect_pair().await;
        mock.set_auto_reply("Runtime.evaluate", MockReply::Ok(json!({ "result": {} })));
        // 限内消息（8KB）正常处理：命令仍可成功往返
        let c = client.clone();
        let t = tokio::spawn(async move {
            c.send_command(
                "Runtime.evaluate",
                Some(json!({ "expression": "x".repeat(4096) })),
                None,
            )
            .await
        });
        let cmd = mock.next_command().await;
        let id = cmd["id"].as_u64().unwrap();
        mock.reply(id, json!({ "result": { "value": 1 } }));
        assert!(t.await.expect("任务失败").is_ok(), "限内消息不得被误拒");
    }

    /// 等待 lost 信号置位（超限断开断言）。
    async fn wait_lost(lost: &mut watch::Receiver<bool>, why: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if *lost.borrow() {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{why}（lost 信号未置位）"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// M3：Drop 后 reader/keepalive 任务终止（任务不再泄漏到连接关闭）。
    #[tokio::test]
    async fn client_drop_aborts_background_tasks() {
        let (mock, client) = connect_pair().await;
        let _ = mock;
        let reader = client.reader_handle.abort_handle();
        let keepalive = client.keepalive_handle.abort_handle();
        drop(client);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            if reader.is_finished() && keepalive.is_finished() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Drop 后 reader/keepalive 任务必须终止"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}
