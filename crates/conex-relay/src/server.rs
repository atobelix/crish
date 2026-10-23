//! Conex 盲中继 WebSocket 服务引擎
//!
//! 支持高并发非阻塞长连接、URL Ticket 校验升级、双向背压流式转发与优雅断线自愈。

use crate::protocol::{FrameType, RelayFrame};
use crate::session::{SessionRegistry, CHANNEL_BUFFER_CAPACITY};
use crate::ticket::TicketClaims;
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, error, info, warn};

pub struct RelayServer {
    addr: SocketAddr,
    secret: String,
    registry: Arc<SessionRegistry>,
}

impl RelayServer {
    /// `secret` 必填（audit-repair-202609 T15）：票据签名密钥由部署方提供
    /// （`RELAY_SECRET` 环境变量，≥32 字节），历史源码默认密钥已删除——
    /// 源码即钥匙的兜底属于硬编码漏洞。
    pub fn new(addr: SocketAddr, secret: String) -> Self {
        Self {
            addr,
            secret,
            registry: Arc::new(SessionRegistry::new()),
        }
    }

    pub async fn run(&self) -> Result<()> {
        let listener = TcpListener::bind(self.addr)
            .await
            .context("Failed to bind relay TCP port")?;
        info!("Conex E2EE Relay server listening on ws://{}", self.addr);

        // 启动后台 30 秒垃圾回收时间轮
        let registry_clone = Arc::clone(&self.registry);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                let cleaned = registry_clone.clean_stale_sessions().await;
                if cleaned > 0 {
                    info!("GC cleaned {} inactive stale relay rooms", cleaned);
                }
            }
        });

        loop {
            let (stream, peer_addr) = match listener.accept().await {
                Ok(conn) => conn,
                Err(err) => {
                    error!("TCP accept failed: {:?}", err);
                    continue;
                }
            };

            let registry = Arc::clone(&self.registry);
            let secret = self.secret.clone();

            tokio::spawn(async move {
                if let Err(err) = handle_connection(stream, peer_addr, registry, secret).await {
                    warn!("Connection from {} terminated: {:?}", peer_addr, err);
                }
            });
        }
    }
}

/// 提取 URL Query 参数
fn extract_query_param(uri: &str, param_name: &str) -> Option<String> {
    let query = uri.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut parts = pair.split('=');
        if let (Some(k), Some(v)) = (parts.next(), parts.next()) {
            if k == param_name {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[allow(clippy::result_large_err)] // Callback 签名由 tokio_tungstenite::accept_hdr_async 契约刚性约束
async fn handle_connection(
    stream: TcpStream,
    peer_addr: SocketAddr,
    registry: Arc<SessionRegistry>,
    secret: String,
) -> Result<()> {
    let mut extracted_ticket: Option<String> = None;

    let callback = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let uri = req.uri().to_string();
        if let Some(ticket) = extract_query_param(&uri, "ticket") {
            extracted_ticket = Some(ticket);
            Ok(resp)
        } else {
            warn!("Rejected WS connection: missing ?ticket= query param");
            let mut err = ErrorResponse::new(Some("Missing ticket parameter".to_string()));
            *err.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
            Err(err)
        }
    };

    let ws_stream = tokio_tungstenite::accept_hdr_async(stream, callback)
        .await
        .context("WebSocket upgrade failed")?;

    let ticket_str =
        extracted_ticket.ok_or_else(|| anyhow::anyhow!("Ticket missing after upgrade"))?;
    let claims =
        TicketClaims::verify(&ticket_str, &secret).context("Ticket verification failed")?;

    let host_id = if claims.role == "host" {
        claims.device_id.clone()
    } else {
        claims
            .target_device_id
            .clone()
            .unwrap_or_else(|| claims.device_id.clone())
    };

    let room_id = format!("room_{}_{}", claims.account_id, host_id);
    let role = claims.role.clone();
    let device_id = claims.device_id.clone();

    info!(
        "Accepted connection from {} (account={}, role={}, device={}) into {}",
        peer_addr, claims.account_id, role, device_id, room_id
    );

    let (tx_to_peer, mut rx_from_peer) = mpsc::channel::<RelayFrame>(CHANNEL_BUFFER_CAPACITY);
    let (_, session_token) = registry
        .join_room(&room_id, &role, &device_id, tx_to_peer)
        .await;

    let (mut ws_sink, mut ws_reader) = ws_stream.split();

    // 任务 A: 将其他 peer 发送给本客户端的消息写入 WebSocket sink
    let room_id_clone = room_id.clone();
    let role_clone = role.clone();
    let to_client_task = tokio::spawn(async move {
        while let Some(frame) = rx_from_peer.recv().await {
            let bytes = frame.encode();
            if let Err(e) = ws_sink.send(Message::Binary(bytes.into())).await {
                warn!("Failed to send binary frame to ws sink: {:?}", e);
                break;
            }
        }
    });

    // 任务 B: 读取当前客户端发送的 WebSocket 二进制消息，盲转发给对端
    while let Some(msg_res) = ws_reader.next().await {
        match msg_res {
            Ok(Message::Binary(bin)) => {
                match RelayFrame::decode(&bin) {
                    Ok(frame) => {
                        // 处理心跳 PING
                        if frame.frame_type == FrameType::Ping {
                            let pong = RelayFrame::new(FrameType::Pong, session_token, Vec::new());
                            if let Err(e) = registry.forward_frame(&room_id, &role, pong).await {
                                // PONG 丢弃会让对端误判心跳超时，必须留痕
                                warn!("转发 PONG 失败（对端可能判定心跳超时）: {:?}", e);
                            }
                            continue;
                        }
                        // 盲转发给房间对端
                        if let Err(e) = registry.forward_frame(&room_id, &role, frame).await {
                            debug!("Forward frame notice: {:?}", e);
                        }
                    }
                    Err(e) => {
                        warn!("Malformed frame from client: {:?}", e);
                    }
                }
            }
            Ok(Message::Ping(_)) => {
                // 协议级 ping, tungstenite 会自动应答 pong
            }
            Ok(Message::Close(_)) => {
                debug!("Client sent close frame");
                break;
            }
            Err(e) => {
                debug!("WebSocket read error: {:?}", e);
                break;
            }
            _ => {}
        }
    }

    to_client_task.abort();
    registry.leave_room(&room_id_clone, &role_clone).await;
    info!("Connection closed and cleaned for {}", room_id_clone);

    Ok(())
}
