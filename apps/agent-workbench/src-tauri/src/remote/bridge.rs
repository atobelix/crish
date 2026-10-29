//! host 中继桥：公网 relay WS ↔ 本机 loopback 协议 WS。
//!
//! 一个 host 连接对应一个手机 client；中继 `relay.data.payload` 是手机侧
//! `DeviceEnvelope` JSON，桥把它原样送入本机 `/v1/relay-loopback`，反向
//! 把本机响应包回 `relay.data`。桥不解析业务字段。

use crate::remote::client::RelayTicket;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = futures_util::stream::SplitSink<Ws, Message>;

const OUTBOUND_CAPACITY: usize = 128;
const PENDING_LOCAL_CAPACITY: usize = 32;

/// 启动一次 host 桥连接。返回的 task 在 relay 断开 / 本地桥失败时结束，
/// 由 service 循环重新申请票据并重连。
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
        .map_err(|error| format!("relay connect failed: {error}"))?;
    let (mut relay_sink, mut relay_events) = relay_ws.split();
    let (relay_out_tx, mut relay_out_rx) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let relay_sender = tokio::spawn(async move {
        while let Some(message) = relay_out_rx.recv().await {
            if relay_sink.send(Message::Text(message.into())).await.is_err() {
                break;
            }
        }
    });

    let (local_in_tx, mut local_in_rx) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let mut local_sink: Option<WsSink> = None;
    let mut local_task: Option<JoinHandle<()>> = None;
    let mut pending_local: Vec<String> = Vec::new();

    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                break;
            }
            Some(message) = local_in_rx.recv() => {
                let payload: Value = serde_json::from_str(&message)
                    .map_err(|error| format!("local frame is not JSON: {error}"))?;
                let frame = json!({ "type": "relay.data", "payload": payload }).to_string();
                relay_out_tx
                    .send(frame)
                    .await
                    .map_err(|_| "relay outbound channel closed".to_string())?;
            }
            message = relay_events.next() => {
                let Some(message) = message else {
                    return Err("relay connection closed".to_string());
                };
                let message = message.map_err(|error| format!("relay read failed: {error}"))?;
                match message {
                    Message::Text(text) => {
                        handle_relay_text(
                            &text,
                            &local_addr,
                            &local_secret,
                            &local_in_tx,
                            &relay_out_tx,
                            &mut local_sink,
                            &mut local_task,
                            &mut pending_local,
                        )
                        .await?;
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(_) => return Err("relay requested close".to_string()),
                    Message::Binary(_) => return Err("relay sent binary frame".to_string()),
                    Message::Frame(_) => {}
                }
            }
        }
    }

    if let Some(sink) = local_sink.as_mut() {
        let _ = sink.close().await;
    }
    if let Some(task) = local_task.take() {
        task.abort();
    }
    drop(relay_out_tx);
    relay_sender.abort();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_relay_text(
    text: &str,
    local_addr: &std::net::SocketAddr,
    local_secret: &str,
    local_in_tx: &mpsc::Sender<String>,
    relay_out_tx: &mpsc::Sender<String>,
    local_sink: &mut Option<WsSink>,
    local_task: &mut Option<JoinHandle<()>>,
    pending_local: &mut Vec<String>,
) -> Result<(), String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("relay frame invalid: {error}"))?;
    let kind = value
        .get("type")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    match kind {
        "relay.ready" => Ok(()),
        "relay.peer" => {
            let online = value
                .get("state")
                .and_then(|value| value.as_str())
                == Some("online");
            if online {
                if local_sink.is_none() {
                    let ws = connect_local(local_addr, local_secret).await?;
                    let (sink, mut stream) = ws.split();
                    *local_sink = Some(sink);
                    let tx = local_in_tx.clone();
                    *local_task = Some(tokio::spawn(async move {
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
                    for frame in pending_local.drain(..) {
                        if let Some(sink) = local_sink.as_mut() {
                            if sink.send(Message::Text(frame.into())).await.is_err() {
                                return Err("local bridge write failed".to_string());
                            }
                        }
                    }
                }
            } else {
                if let Some(sink) = local_sink.as_mut() {
                    let _ = sink.close().await;
                }
                *local_sink = None;
                if let Some(task) = local_task.take() {
                    task.abort();
                }
            }
            Ok(())
        }
        "relay.data" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let frame = serde_json::to_string(&payload)
                .map_err(|error| format!("local frame encode failed: {error}"))?;
            if let Some(sink) = local_sink.as_mut() {
                sink.send(Message::Text(frame.into()))
                    .await
                    .map_err(|error| format!("local bridge write failed: {error}"))
            } else {
                if pending_local.len() >= PENDING_LOCAL_CAPACITY {
                    pending_local.remove(0);
                }
                pending_local.push(frame);
                Ok(())
            }
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
    request
        .headers_mut()
        .insert(tokio_tungstenite::tungstenite::http::header::AUTHORIZATION, header);
    let (ws, _) = connect_async(request)
        .await
        .map_err(|error| format!("local bridge connect failed: {error}"))?;
    Ok(ws)
}
