//! host 中继桥：公网 relay WS ↔ 本机 loopback 协议 WS。
//!
//! 一个 host 连接对应一个手机 client；中继 `relay.data.payload` 是手机侧
//! `DeviceEnvelope` JSON，桥把它原样送入本机 `/v1/relay-loopback`，反向
//! 把本机响应包回 `relay.data`。桥不解析业务字段。
//!
//! 韧性口径（H2，2026-11-03）：瞬时故障（本机 loopback 暂不可达 / 本地连接
//! 写失败 / 单帧不可解析）不得终止整桥——本地连接在桥内退避重连，坏帧记
//! 日志丢弃；只有 relay 连接本身死亡（关闭 / 读错 / 出站通道断裂）或协议
//! 致命错误（二进制帧）才结束本次桥，由 service 看护按同一退避口径重取
//! 票据重连。桥每次终止都在 `spawn_host_bridge` 的日志里留下分类原文。

use crate::remote::client::RelayTicket;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = futures_util::stream::SplitSink<Ws, Message>;

const OUTBOUND_CAPACITY: usize = 128;
const PENDING_LOCAL_CAPACITY: usize = 32;

/// 瞬时故障退避基数：连续失败第 1 次的等待（桥内本地重连与 service 看护
/// 重取票据共用同一口径，常量与公式同源于此）。
pub(crate) const RELAY_BACKOFF_BASE: Duration = Duration::from_secs(1);
/// 瞬时故障退避封顶。
pub(crate) const RELAY_BACKOFF_CAP: Duration = Duration::from_secs(30);

/// 连续失败 `consecutive_failures` 次后的下一次重试等待：
/// `min(BASE × 2^(n-1), CAP)`，即 1s → 2s → 4s → 8s → 16s → 30s 封顶。
/// 公式形状与 conex-run 的瞬时重试口径一致（`base * 2^(attempt-1)` 钳制）；
/// 基数/封顶取基础设施重连档（不加抖动：presence 抖动需要可由日志定量，
/// 确定性等待便于对账）。
pub(crate) fn relay_backoff_delay(consecutive_failures: u32) -> Duration {
    let shift = consecutive_failures.saturating_sub(1).min(15);
    RELAY_BACKOFF_BASE
        .saturating_mul(1u32 << shift)
        .min(RELAY_BACKOFF_CAP)
}

/// 启动一次 host 桥连接。返回的 task 只在 relay 连接死亡、致命协议错误
/// 或 stop 时结束（本地侧瞬时故障在桥内自愈，不走到这里），由 service
/// 看护按退避口径重新申请票据并重连。终止原因在此统一记日志，错误原文
/// 自带 `transient:` / `fatal:` 分类前缀。
pub fn spawn_host_bridge(
    ticket: RelayTicket,
    local_addr: std::net::SocketAddr,
    local_secret: String,
    stop_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(error) = run_bridge(ticket, local_addr, local_secret, stop_rx).await {
            tracing::warn!(target: "remote", error = %error, "relay host bridge stopped");
        }
    })
}

/// 本机 loopback 连接的桥内状态。本地侧一切瞬时故障（连接失败 / 写失败）
/// 都收敛在这里：拆掉本地连接 → 按退避口径排下一次重连 → 帧先进
/// `pending` 缓冲，绝不向上传播成整桥终止。
struct LocalLink {
    sink: Option<WsSink>,
    task: Option<JoinHandle<()>>,
    pending: Vec<String>,
    /// 手机 client 当前在线（relay.peer 的最近状态）。离线期间不重连本地。
    peer_online: bool,
    /// 本地连续失败次数（退避输入；连接成功清零）。
    failures: u32,
    /// 下一次本地重连的时刻（None = 无待重试）。
    retry_at: Option<Instant>,
}

impl LocalLink {
    fn new() -> Self {
        Self {
            sink: None,
            task: None,
            pending: Vec::new(),
            peer_online: false,
            failures: 0,
            retry_at: None,
        }
    }

    fn is_connected(&self) -> bool {
        self.sink.is_some()
    }

    /// 拆掉本地连接（关 sink + 停读任务）。pending 缓冲保留待重连后回放。
    async fn teardown(&mut self) {
        if let Some(sink) = self.sink.as_mut() {
            let _ = sink.close().await;
        }
        self.sink = None;
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }

    /// 帧入待发缓冲（未连接或刚写失败时）；满员按既有口径丢最旧帧。
    fn buffer(&mut self, frame: String) {
        if self.pending.len() >= PENDING_LOCAL_CAPACITY {
            self.pending.remove(0);
        }
        self.pending.push(frame);
    }

    /// 记一次本地失败并排下一次重连（退避口径见 `relay_backoff_delay`）。
    fn schedule_retry(&mut self, reason: &str, error: &str) {
        self.failures = self.failures.saturating_add(1);
        let delay = relay_backoff_delay(self.failures);
        self.retry_at = Some(Instant::now() + delay);
        tracing::warn!(
            target: "remote",
            category = "transient",
            reason,
            error,
            failures = self.failures,
            retry_after_ms = delay.as_millis() as u64,
            "local bridge link down; reconnect scheduled"
        );
    }

    /// 尝试建立本地连接并回放缓冲帧。瞬时失败（connect 被拒等）只排重试、
    /// 返回 Ok；只有本地请求构造类错误（URL / 密钥头非法——由 service 生成
    /// 的地址与进程内密钥决定，属配置致命）才返回 Err 终止整桥。
    async fn try_connect(
        &mut self,
        local_addr: &std::net::SocketAddr,
        local_secret: &str,
        local_in_tx: &mpsc::Sender<String>,
    ) -> Result<(), String> {
        // sink 缺席时 task 至多是已结束的残留句柄，先拆干净再装新连接。
        self.teardown().await;
        let ws = match connect_local(local_addr, local_secret).await {
            Ok(ws) => ws,
            Err(error) if error.starts_with("local bridge connect failed") => {
                self.schedule_retry("connect", &error);
                return Ok(());
            }
            Err(error) => return Err(format!("fatal: {error}")),
        };
        let (sink, mut stream) = ws.split();
        self.sink = Some(sink);
        let tx = local_in_tx.clone();
        self.task = Some(tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if tx.send(text.to_string()).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        }));
        tracing::info!(
            target: "remote",
            failures_before = self.failures,
            buffered = self.pending.len(),
            "local bridge link connected"
        );
        self.failures = 0;
        self.retry_at = None;
        // 回放缓冲：逐帧发送，写失败保留未发出的帧（含当前帧）待下次重连。
        while !self.pending.is_empty() {
            let frame = self.pending[0].clone();
            let send_result = match self.sink.as_mut() {
                Some(sink) => sink.send(Message::Text(frame.into())).await,
                None => break,
            };
            match send_result {
                Ok(()) => {
                    self.pending.remove(0);
                }
                Err(error) => {
                    self.teardown().await;
                    self.schedule_retry("flush", &format!("local bridge write failed: {error}"));
                    break;
                }
            }
        }
        Ok(())
    }

    /// 向本地连接写一帧。写失败 = 本地连接已坏：帧转入缓冲、拆链、排重连，
    /// 返回 Ok（瞬时故障不终止整桥）。
    async fn forward(&mut self, frame: String) {
        let send_result = match self.sink.as_mut() {
            Some(sink) => Some(sink.send(Message::Text(frame.clone().into())).await),
            None => None,
        };
        match send_result {
            Some(Ok(())) => {}
            Some(Err(error)) => {
                self.buffer(frame);
                self.teardown().await;
                self.schedule_retry("write", &format!("local bridge write failed: {error}"));
            }
            None => self.buffer(frame),
        }
    }
}

async fn run_bridge(
    ticket: RelayTicket,
    local_addr: std::net::SocketAddr,
    local_secret: String,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let relay_url = if ticket.relay_url.contains('?') {
        format!("{}&ticket={}", ticket.relay_url, ticket.ticket)
    } else {
        format!("{}?ticket={}", ticket.relay_url, ticket.ticket)
    };
    let (relay_ws, _) = connect_async(relay_url)
        .await
        .map_err(|error| format!("transient: relay connect failed: {error}"))?;
    let (mut relay_sink, mut relay_events) = relay_ws.split();
    let (relay_out_tx, mut relay_out_rx) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let relay_sender = tokio::spawn(async move {
        while let Some(message) = relay_out_rx.recv().await {
            if relay_sink
                .send(Message::Text(message.into()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let (local_in_tx, mut local_in_rx) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let mut local = LocalLink::new();

    loop {
        // 本地重连定时：有待重试且 peer 在线时才起表；无则永久挂起不参与 select。
        let retry_deadline = if local.peer_online && !local.is_connected() {
            local.retry_at
        } else {
            None
        };
        let retry_sleep = async move {
            match retry_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = stop_rx.changed() => {
                break;
            }
            _ = retry_sleep => {
                local.try_connect(&local_addr, &local_secret, &local_in_tx).await?;
            }
            Some(message) = local_in_rx.recv() => {
                let payload: Value = match serde_json::from_str(&message) {
                    Ok(payload) => payload,
                    Err(error) => {
                        // 本地网关发来不可解析帧：记日志丢弃这一帧，不牵连整桥。
                        tracing::warn!(
                            target: "remote",
                            category = "transient",
                            error = %error,
                            "local frame is not JSON; dropped"
                        );
                        continue;
                    }
                };
                let frame = json!({ "type": "relay.data", "payload": payload }).to_string();
                relay_out_tx
                    .send(frame)
                    .await
                    .map_err(|_| "transient: relay outbound channel closed".to_string())?;
            }
            message = relay_events.next() => {
                let Some(message) = message else {
                    return Err("transient: relay connection closed".to_string());
                };
                let message = message
                    .map_err(|error| format!("transient: relay read failed: {error}"))?;
                match message {
                    Message::Text(text) => {
                        handle_relay_text(
                            &text,
                            &local_addr,
                            &local_secret,
                            &local_in_tx,
                            &relay_out_tx,
                            &mut local,
                        )
                        .await?;
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(_) => {
                        return Err("transient: relay requested close".to_string());
                    }
                    Message::Binary(_) => {
                        return Err("fatal: relay sent binary frame".to_string());
                    }
                    Message::Frame(_) => {}
                }
            }
        }
    }

    local.teardown().await;
    drop(relay_out_tx);
    relay_sender.abort();
    Ok(())
}

async fn handle_relay_text(
    text: &str,
    local_addr: &std::net::SocketAddr,
    local_secret: &str,
    local_in_tx: &mpsc::Sender<String>,
    relay_out_tx: &mpsc::Sender<String>,
    local: &mut LocalLink,
) -> Result<(), String> {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(error) => {
            // relay 帧不可解析：记日志丢弃这一帧，不牵连整桥（流本身若已
            // 损坏，后续读错误会按 transient 口径结束本次桥）。
            tracing::warn!(
                target: "remote",
                category = "transient",
                error = %error,
                "relay frame invalid; dropped"
            );
            return Ok(());
        }
    };
    let kind = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    match kind {
        "relay.ready" => Ok(()),
        "relay.peer" => {
            let online = value.get("state").and_then(|value| value.as_str()) == Some("online");
            if online {
                local.peer_online = true;
                if !local.is_connected() {
                    // loopback 此刻不可达只排桥内重试（try_connect 内部收敛
                    // 瞬时失败）；连接成功后缓冲帧自动回放。
                    local
                        .try_connect(local_addr, local_secret, local_in_tx)
                        .await?;
                }
            } else {
                local.peer_online = false;
                local.retry_at = None;
                local.failures = 0;
                local.teardown().await;
            }
            Ok(())
        }
        "relay.data" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let frame = match &payload {
                Value::String(s) => s.clone(),
                other => serde_json::to_string(other)
                    .map_err(|error| format!("fatal: local frame encode failed: {error}"))?,
            };
            // 未连接时入缓冲；写失败时 forward 内部转缓冲 + 拆链 + 排重连。
            local.forward(frame).await;
            Ok(())
        }
        "relay.ping" => {
            let ts = value.get("ts").and_then(Value::as_u64).unwrap_or_default();
            let _ = relay_out_tx
                .send(json!({ "type": "relay.pong", "ts": ts }).to_string())
                .await;
            Ok(())
        }
        "relay.error" => {
            tracing::warn!(
                target: "remote",
                code = value
                    .get("code")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default(),
                "relay reported error"
            );
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn connect_local(
    local_addr: &std::net::SocketAddr,
    local_secret: &str,
) -> Result<Ws, String> {
    let url = format!("ws://{local_addr}/v1/relay-loopback");
    let mut request = url
        .into_client_request()
        .map_err(|error| format!("local bridge request invalid: {error}"))?;
    let header = HeaderValue::from_str(&format!("Bearer {local_secret}"))
        .map_err(|error| format!("local bridge secret invalid: {error}"))?;
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::AUTHORIZATION,
        header,
    );
    let (ws, _) = connect_async(request)
        .await
        .map_err(|error| format!("local bridge connect failed: {error}"))?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::relay_backoff_delay;
    use std::time::Duration;

    #[test]
    fn backoff_delay_doubles_from_one_second_and_caps_at_thirty() {
        let expected_secs = [1, 2, 4, 8, 16, 30, 30, 30];
        for (index, secs) in expected_secs.iter().enumerate() {
            let failures = index as u32 + 1;
            assert_eq!(
                relay_backoff_delay(failures),
                Duration::from_secs(*secs),
                "failures={failures}"
            );
        }
    }

    #[test]
    fn backoff_delay_zero_failures_is_base_and_huge_counts_stay_capped() {
        assert_eq!(relay_backoff_delay(0), Duration::from_secs(1));
        assert_eq!(relay_backoff_delay(u32::MAX), Duration::from_secs(30));
    }
}
