//! 中继 HTTP + WebSocket 服务。
//!
//! 公开面：
//! - `GET  /health`
//! - `GET  /v1/devices`（Bearer access token；账号内在线 host 设备发现）
//! - `POST /v1/ticket/host` + `POST /v1/ticket/client`（Bearer access token）
//! - `GET  /v1/relay?ticket=...`（WebSocket）
//!
//! 中继只转发 `relay.data.payload`，不解析业务协议、不落业务数据。

use crate::account::{AccountError, AccountVerifier};
use crate::hub::{Hub, HubError, OutboundFrame, PEER_CHANNEL_CAPACITY};
use crate::ticket::{TicketClaims, TicketError};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

const TICKET_WINDOW: Duration = Duration::from_secs(60);
const TICKET_PER_IP: usize = 120;
const TICKET_PER_TOKEN: usize = 30;
const PRESENCE_PER_IP: usize = 60;
const PRESENCE_PER_TOKEN: usize = 60;
const DEVICE_ID_MIN_LEN: usize = 8;
const DEVICE_ID_MAX_LEN: usize = 64;
const DEVICE_NAME_MAX_LEN: usize = 64;
const WS_HEARTBEAT: Duration = Duration::from_secs(30);
const WS_DEAD_AFTER: Duration = Duration::from_secs(90);

#[derive(Clone)]
pub struct RelayConfig {
    pub secret: Arc<Vec<u8>>,
    pub auth_base_url: String,
    pub public_relay_url: String,
    pub ticket_ttl_secs: u64,
    pub max_frame_bytes: usize,
    pub max_connections: usize,
    /// 全中继出站排队字节上限（慢消费者/大帧攻击的内存保险丝）。
    pub max_queued_bytes: usize,
}

pub struct AppState {
    config: Arc<RelayConfig>,
    account: Arc<dyn AccountVerifier>,
    hub: Hub,
    replay: TicketReplay,
    rate: RateLimiter,
    connections: AtomicUsize,
}

impl AppState {
    pub fn new(config: RelayConfig, account: Arc<dyn AccountVerifier>) -> Self {
        let hub = Hub::new(config.max_queued_bytes);
        Self {
            config: Arc::new(config),
            account,
            hub,
            replay: TicketReplay::default(),
            rate: RateLimiter::default(),
            connections: AtomicUsize::new(0),
        }
    }
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/devices", get(devices))
        .route("/v1/ticket/host", post(ticket_host))
        .route("/v1/ticket/client", post(ticket_client))
        .route("/v1/relay", get(ws_upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .with_state(state)
}

pub async fn serve(listener: tokio::net::TcpListener, app: Router) -> anyhow::Result<()> {
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketRequest {
    device_id: String,
    #[serde(default)]
    device_name: Option<String>,
    #[serde(default)]
    target_device_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceItem {
    id: String,
    name: String,
    platform: &'static str,
    online: bool,
    last_seen_at: u64,
}

#[derive(Debug, Serialize)]
struct DeviceListResponse {
    items: Vec<DeviceItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketResponse {
    ticket: String,
    relay_url: String,
    exp: u64,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": self.code, "message": self.message })),
        )
            .into_response()
    }
}

/// 尽力发送（fire-and-forget）：用于连接正在收尾、对端可能已断的场景。
///
/// 这些帧（relay.error / relay.ping / peer 通知）都是「送不到也无所谓」的
/// 尽力通知——连接已关闭时丢弃即正确行为，重试与上报都没有意义。用命名
/// 函数表达该意图，替代散落的 `let _ =`，避免与真正的吞错混淆。
fn send_best_effort(state: &AppState, tx: &mpsc::Sender<OutboundFrame>, frame: String) {
    if state.hub.send(tx, frame).is_err() {
        tracing::debug!(target: "relay", "尽力投递失败（连接已关闭/缓冲满/预算耗尽），丢弃该帧");
    }
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "auth.missing", "missing bearer"))?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "auth.missing", "invalid bearer"))?;
    Ok(token)
}

fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("local")
        .to_string()
}

fn validate_device_id(value: &str) -> Result<&str, ApiError> {
    let id = value.trim();
    let valid_len = (DEVICE_ID_MIN_LEN..=DEVICE_ID_MAX_LEN).contains(&id.len());
    let valid_chars = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'));
    if !valid_len || !valid_chars {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.device_id",
            "deviceId must be 8-64 safe characters",
        ));
    }
    Ok(id)
}

fn sanitize_device_name(value: Option<&str>) -> String {
    let name: String = value
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let name = name.trim();
    if name.is_empty() {
        return "Desktop".to_string();
    }
    name.chars().take(DEVICE_NAME_MAX_LEN).collect()
}

fn ensure_ticket_rate(state: &AppState, headers: &HeaderMap, token: &str) -> Result<(), ApiError> {
    let ip = client_ip(headers);
    if !state
        .rate
        .allow(format!("ip:{ip}"), TICKET_PER_IP, TICKET_WINDOW)
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate.ip",
            "too many ticket requests",
        ));
    }
    let token_key = hex::encode(Sha256::digest(token.as_bytes()));
    if !state.rate.allow(
        format!("token:{token_key}"),
        TICKET_PER_TOKEN,
        TICKET_WINDOW,
    ) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate.token",
            "too many ticket requests",
        ));
    }
    Ok(())
}

fn map_account_error(error: AccountError) -> ApiError {
    match error {
        AccountError::Unauthorized => ApiError::new(
            StatusCode::UNAUTHORIZED,
            "auth.invalid",
            "access token rejected",
        ),
        AccountError::Network(message) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "auth.unavailable",
            format!("account center unavailable: {message}"),
        ),
        AccountError::BadResponse(message) => ApiError::new(
            StatusCode::BAD_GATEWAY,
            "auth.bad_response",
            format!("account center response invalid: {message}"),
        ),
    }
}

fn issue_ticket(state: &AppState, claims: TicketClaims) -> Result<Json<TicketResponse>, ApiError> {
    let ticket = claims.sign(&state.config.secret).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ticket.sign",
            error.to_string(),
        )
    })?;
    Ok(Json(TicketResponse {
        ticket,
        relay_url: state.config.public_relay_url.clone(),
        exp: claims.exp,
    }))
}

async fn ticket_host(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<TicketRequest>,
) -> Result<Json<TicketResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    ensure_ticket_rate(&state, &headers, token)?;
    let device_id = validate_device_id(&request.device_id)?;
    let account_id = state
        .account
        .account_id(token)
        .await
        .map_err(map_account_error)?;
    issue_ticket(
        &state,
        TicketClaims::host(
            account_id,
            device_id,
            Some(sanitize_device_name(request.device_name.as_deref())),
            state.config.ticket_ttl_secs,
        ),
    )
}

async fn ticket_client(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<TicketRequest>,
) -> Result<Json<TicketResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    ensure_ticket_rate(&state, &headers, token)?;
    let device_id = validate_device_id(&request.device_id)?;
    let target_device_id =
        validate_device_id(request.target_device_id.as_deref().ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "request.target_device_id",
                "targetDeviceId is required",
            )
        })?)?;
    if device_id == target_device_id {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "request.self_target",
            "cannot target the calling device",
        ));
    }
    let account_id = state
        .account
        .account_id(token)
        .await
        .map_err(map_account_error)?;
    issue_ticket(
        &state,
        TicketClaims::client(
            account_id,
            device_id,
            Some(sanitize_device_name(request.device_name.as_deref())),
            target_device_id,
            state.config.ticket_ttl_secs,
        ),
    )
}

async fn devices(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<DeviceListResponse>, ApiError> {
    let token = bearer_token(&headers)?;
    let ip = client_ip(&headers);
    if !state
        .rate
        .allow(format!("devices:ip:{ip}"), PRESENCE_PER_IP, TICKET_WINDOW)
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate.ip",
            "too many device discovery requests",
        ));
    }
    let token_key = hex::encode(Sha256::digest(token.as_bytes()));
    if !state.rate.allow(
        format!("devices:token:{token_key}"),
        PRESENCE_PER_TOKEN,
        TICKET_WINDOW,
    ) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate.token",
            "too many device discovery requests",
        ));
    }
    let account_id = state
        .account
        .account_id(token)
        .await
        .map_err(map_account_error)?;
    let items = state
        .hub
        .online_devices(&account_id)
        .into_iter()
        .map(|device| DeviceItem {
            id: device.device_id,
            name: device.name,
            platform: match device.role {
                crate::ticket::TicketRole::Host => "desktop",
                crate::ticket::TicketRole::Client => "mobile",
            },
            online: true,
            // 中继只知连接建立时刻；UI 以“已在线多久”呈现。
            last_seen_at: device.connected_at_ms,
        })
        .collect();
    Ok(Json(DeviceListResponse { items }))
}

#[derive(Debug, Deserialize)]
struct TicketQuery {
    ticket: String,
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<TicketQuery>,
) -> Result<Response, ApiError> {
    let claims = TicketClaims::verify(&query.ticket, &state.config.secret).map_err(|error| {
        let (status, code) = match error {
            TicketError::Expired => (StatusCode::UNAUTHORIZED, "ticket.expired"),
            TicketError::Signature => (StatusCode::UNAUTHORIZED, "ticket.signature"),
            _ => (StatusCode::UNAUTHORIZED, "ticket.invalid"),
        };
        ApiError::new(status, code, error.to_string())
    })?;
    if !state.replay.mark(&claims.jti, claims.exp) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ticket.replayed",
            "ticket already used",
        ));
    }
    if state.connections.load(Ordering::Acquire) >= state.config.max_connections {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "conn.limit",
            "relay connection limit reached",
        ));
    }
    state.connections.fetch_add(1, Ordering::AcqRel);
    let ws = ws.max_message_size(state.config.max_frame_bytes);
    Ok(ws.on_upgrade(move |socket| async move {
        handle_socket(socket, state, claims).await;
    }))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, claims: TicketClaims) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<OutboundFrame>(PEER_CHANNEL_CAPACITY);
    let joined = match state.hub.join(&claims, tx.clone()) {
        Ok(joined) => joined,
        Err(error) => {
            tracing::warn!(error = %error, "relay join rejected");
            state.connections.fetch_sub(1, Ordering::AcqRel);
            return;
        }
    };
    tracing::info!(
        target: "relay",
        role = claims.role.as_str(),
        device = %claims.device_id,
        room = %joined.room_key,
        conn = joined.conn_id,
        "peer joined"
    );

    if let Some(replaced) = joined.replaced {
        let error = json!({
            "type": "relay.error",
            "code": "replaced",
            "message": "connection replaced by a newer session",
        })
        .to_string();
        if let Err(err) = state.hub.send_to(&replaced, error) {
            tracing::debug!(target: "relay", error = %err, "被替换连接的通知投递失败（对端已断开）");
        }
    }

    let ready = json!({
        "type": "relay.ready",
        "role": claims.role.as_str(),
        "roomId": joined.room_key,
        "deviceId": claims.device_id,
    })
    .to_string();
    send_best_effort(&state, &tx, ready);

    if let Some(peer) = joined.peer.clone() {
        let notice = json!({
            "type": "relay.peer",
            "state": "online",
            "role": peer.role.as_str(),
            "deviceId": peer.device_id,
        })
        .to_string();
        send_best_effort(&state, &tx, notice.clone());
        if let Err(err) = state.hub.send_to(&peer, notice) {
            tracing::debug!(target: "relay", error = %err, "peer 上线通知投递失败（对端已断开）");
        }
    }

    let sink_state = Arc::clone(&state);
    let sink_task = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let bytes = frame.bytes;
            let sent = sink.send(Message::Text(frame.text.into())).await.is_ok();
            sink_state.hub.release(bytes);
            if !sent {
                break;
            }
        }
        // 关闭握手：对端可能已先断开，失败无补救动作（连接即弃）
        if let Err(err) = sink.close().await {
            tracing::debug!(target: "relay", error = %err, "sink 关闭失败（对端已断开）");
        }
    });

    let mut heartbeat = tokio::time::interval(WS_HEARTBEAT);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_rx = Instant::now();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_rx.elapsed() > WS_DEAD_AFTER {
                    break;
                }
                let ping = json!({ "type": "relay.ping", "ts": now_ms() }).to_string();
                if state.hub.send(&tx, ping).is_err() {
                    break;
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        last_rx = Instant::now();
                        if text.len() > state.config.max_frame_bytes {
                            send_best_effort(
                                &state,
                                &tx,
                                json!({
                                    "type": "relay.error",
                                    "code": "frame.too_large",
                                    "message": "frame exceeds relay limit",
                                })
                                .to_string(),
                            );
                            break;
                        }
                        if !handle_client_text(&state, &claims, &joined.room_key, joined.conn_id, &text, &tx) {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => last_rx = Instant::now(),
                    Some(Ok(Message::Binary(_))) => {
                        send_best_effort(
                            &state,
                            &tx,
                            json!({
                                "type": "relay.error",
                                "code": "frame.binary",
                                "message": "binary frames are not supported",
                            })
                            .to_string(),
                        );
                        break;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(_))) => {}
                }
            }
        }
    }

    if let Some(peer) = state.hub.leave(&joined.room_key, joined.conn_id) {
        let notice = json!({
            "type": "relay.peer",
            "state": "offline",
            "role": peer.role.as_str(),
            "deviceId": peer.device_id,
        })
        .to_string();
        if let Err(err) = state.hub.send_to(&peer, notice) {
            tracing::debug!(target: "relay", error = %err, "peer 下线通知投递失败（对端已断开）");
        }
    }
    drop(tx);
    // sink task 退出即有结果（Ok = 正常收尾，Err = panic）；panic 需要留痕，
    // 否则连接清理异常会被完全掩盖。
    if let Err(err) = sink_task.await {
        tracing::warn!(target: "relay", error = %err, "sink task 异常退出（panic）");
    }
    state.connections.fetch_sub(1, Ordering::AcqRel);
    tracing::info!(
        target: "relay",
        role = claims.role.as_str(),
        device = %claims.device_id,
        room = %joined.room_key,
        conn = joined.conn_id,
        "peer left"
    );
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientRelayMessage {
    #[serde(rename = "relay.data")]
    Data { payload: Value },
    #[serde(rename = "relay.ping")]
    Ping { ts: Option<u64> },
    #[serde(rename = "relay.pong")]
    #[allow(dead_code)]
    Pong { ts: Option<u64> },
}

fn handle_client_text(
    state: &AppState,
    claims: &TicketClaims,
    room_key: &str,
    conn_id: u64,
    text: &str,
    tx: &mpsc::Sender<OutboundFrame>,
) -> bool {
    let message: ClientRelayMessage = match serde_json::from_str(text) {
        Ok(message) => message,
        Err(_) => {
            send_best_effort(
                state,
                tx,
                json!({
                    "type": "relay.error",
                    "code": "frame.invalid",
                    "message": "invalid relay message",
                })
                .to_string(),
            );
            return false;
        }
    };
    match message {
        ClientRelayMessage::Data { payload } => {
            let forwarded = json!({
                "type": "relay.data",
                "from": claims.role.as_str(),
                "deviceId": claims.device_id,
                "payload": payload,
            })
            .to_string();
            match state.hub.forward(room_key, conn_id, forwarded) {
                Ok(()) => true,
                Err(HubError::NoPeer) => {
                    send_best_effort(
                        state,
                        tx,
                        json!({
                            "type": "relay.error",
                            "code": "peer.offline",
                            "message": "peer is not online",
                        })
                        .to_string(),
                    );
                    true
                }
                Err(HubError::Backpressure) => {
                    send_best_effort(
                        state,
                        tx,
                        json!({
                            "type": "relay.error",
                            "code": "peer.backpressure",
                            "message": "peer is too slow",
                        })
                        .to_string(),
                    );
                    false
                }
                Err(HubError::Closed) | Err(HubError::MissingTarget) => false,
            }
        }
        ClientRelayMessage::Ping { ts } => {
            send_best_effort(
                state,
                tx,
                json!({ "type": "relay.pong", "ts": ts.unwrap_or_else(now_ms) }).to_string(),
            );
            true
        }
        ClientRelayMessage::Pong { .. } => true,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
struct TicketReplay {
    used: Mutex<HashMap<String, u64>>,
}

impl TicketReplay {
    fn mark(&self, jti: &str, exp: u64) -> bool {
        let now = now_ms() / 1000;
        let mut used = self.used.lock().unwrap_or_else(|error| error.into_inner());
        if used.len() > 4096 {
            used.retain(|_, expiry| *expiry + 5 >= now);
        }
        if used.contains_key(jti) {
            return false;
        }
        used.insert(jti.to_string(), exp);
        true
    }
}

#[derive(Default)]
struct RateLimiter {
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    fn allow(&self, key: String, limit: usize, window: Duration) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|error| error.into_inner());
        if hits.len() > 4096 {
            hits.retain(|_, queue| {
                queue
                    .back()
                    .is_some_and(|last| now.duration_since(*last) <= window)
            });
        }
        let queue = hits.entry(key).or_default();
        while queue
            .front()
            .is_some_and(|first| now.duration_since(*first) > window)
        {
            queue.pop_front();
        }
        if queue.len() >= limit {
            return false;
        }
        queue.push_back(now);
        true
    }
}

pub fn config_from_env() -> anyhow::Result<(SocketAddr, RelayConfig)> {
    let bind: SocketAddr = std::env::var("RELAY_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8766".to_string())
        .parse()
        .map_err(|error| anyhow::anyhow!("invalid RELAY_BIND: {error}"))?;
    let secret = std::env::var("RELAY_SECRET").unwrap_or_default();
    if secret.len() < 32 {
        return Err(anyhow::anyhow!(
            "RELAY_SECRET must be at least 32 bytes (got {})",
            secret.len()
        ));
    }
    let auth_base_url =
        std::env::var("AUTH_BASE_URL").unwrap_or_else(|_| "https://auth.flowbit.me".to_string());
    let public_relay_url = std::env::var("RELAY_PUBLIC_URL")
        .unwrap_or_else(|_| "wss://proxy.flowbit.me:8443/v1/relay".to_string());
    let ticket_ttl_secs = std::env::var("RELAY_TICKET_TTL_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(60);
    // 与桌面/移动端业务帧上限（1 MiB）对齐；内存由全局排队字节预算兜底。
    let max_frame_bytes = std::env::var("RELAY_MAX_FRAME_BYTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1024 * 1024);
    let max_connections = std::env::var("RELAY_MAX_CONNECTIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1024);
    let max_queued_bytes = std::env::var("RELAY_MAX_QUEUED_BYTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(64 * 1024 * 1024);
    Ok((
        bind,
        RelayConfig {
            secret: Arc::new(secret.into_bytes()),
            auth_base_url,
            public_relay_url,
            ticket_ttl_secs,
            max_frame_bytes,
            max_connections,
            max_queued_bytes,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket::TicketRole;
    use async_trait::async_trait;

    struct MockVerifier;

    #[async_trait]
    impl AccountVerifier for MockVerifier {
        async fn account_id(&self, token: &str) -> Result<String, AccountError> {
            if token != "good" {
                return Err(AccountError::Unauthorized);
            }
            Ok("acc-1".to_string())
        }
    }

    fn bearer_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer good".parse().expect("header"),
        );
        headers
    }

    fn state() -> Arc<AppState> {
        Arc::new(AppState::new(
            RelayConfig {
                secret: Arc::new(b"0123456789abcdef0123456789abcdef".to_vec()),
                auth_base_url: "http://127.0.0.1".to_string(),
                public_relay_url: "wss://relay.example/v1/relay".to_string(),
                ticket_ttl_secs: 60,
                max_frame_bytes: 1024,
                max_connections: 8,
                max_queued_bytes: 1024 * 1024,
            },
            Arc::new(MockVerifier),
        ))
    }

    #[test]
    fn ticket_replay_guard_blocks_second_use() {
        let replay = TicketReplay::default();
        assert!(replay.mark("jti-1", now_ms() / 1000 + 60));
        assert!(!replay.mark("jti-1", now_ms() / 1000 + 60));
    }

    #[test]
    fn rate_limiter_blocks_over_limit() {
        let limiter = RateLimiter::default();
        assert!(limiter.allow("k".to_string(), 2, Duration::from_secs(60)));
        assert!(limiter.allow("k".to_string(), 2, Duration::from_secs(60)));
        assert!(!limiter.allow("k".to_string(), 2, Duration::from_secs(60)));
    }

    #[test]
    fn ticket_requests_require_bearer() {
        let headers = HeaderMap::new();
        assert!(bearer_token(&headers).is_err());
    }

    #[tokio::test]
    async fn host_ticket_carries_device_name() {
        let state = state();
        let response = ticket_host(
            State(state.clone()),
            bearer_headers(),
            Json(TicketRequest {
                device_id: "desk-0001".to_string(),
                device_name: Some("  Office PC  ".to_string()),
                target_device_id: None,
            }),
        )
        .await
        .expect("host ticket");
        let claims =
            TicketClaims::verify(&response.0.ticket, &state.config.secret).expect("claims");
        assert_eq!(claims.role, TicketRole::Host);
        assert_eq!(claims.device_name.as_deref(), Some("Office PC"));
    }

    #[tokio::test]
    async fn client_ticket_carries_device_name() {
        let state = state();
        let response = ticket_client(
            State(state.clone()),
            bearer_headers(),
            Json(TicketRequest {
                device_id: "mob-0001".to_string(),
                device_name: Some("My Phone".to_string()),
                target_device_id: Some("desk-0001".to_string()),
            }),
        )
        .await
        .expect("client ticket");
        let claims =
            TicketClaims::verify(&response.0.ticket, &state.config.secret).expect("claims");
        assert_eq!(claims.role, TicketRole::Client);
        assert_eq!(claims.device_name.as_deref(), Some("My Phone"));
        assert_eq!(claims.target_device_id.as_deref(), Some("desk-0001"));
    }

    #[tokio::test]
    async fn ticket_rejects_invalid_device_id() {
        let response = ticket_host(
            State(state()),
            bearer_headers(),
            Json(TicketRequest {
                device_id: "bad id".to_string(),
                device_name: None,
                target_device_id: None,
            }),
        )
        .await
        .expect_err("invalid id");
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn client_ticket_rejects_self_target() {
        let response = ticket_client(
            State(state()),
            bearer_headers(),
            Json(TicketRequest {
                device_id: "mob-1234".to_string(),
                device_name: None,
                target_device_id: Some("mob-1234".to_string()),
            }),
        )
        .await
        .expect_err("self target");
        assert_eq!(response.status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn devices_lists_online_devices_only() {
        let state = state();
        let (tx, _rx) = mpsc::channel(8);
        let claims = TicketClaims::host("acc-1", "desk-0001", Some("Office PC".to_string()), 60);
        let _joined = state.hub.join(&claims, tx).expect("join host");
        let (client_tx, _client_rx) = mpsc::channel(8);
        let client_claims = TicketClaims::client(
            "acc-1",
            "mob-0001",
            Some("My Phone".to_string()),
            "desk-0001",
            60,
        );
        state
            .hub
            .join(&client_claims, client_tx)
            .expect("join client");
        let response = devices(State(state), bearer_headers())
            .await
            .expect("devices")
            .0;
        assert_eq!(response.items.len(), 2);
        assert!(response.items.iter().any(|item| item.id == "desk-0001"
            && item.name == "Office PC"
            && item.platform == "desktop"
            && item.online));
        assert!(response.items.iter().any(|item| item.id == "mob-0001"
            && item.name == "My Phone"
            && item.platform == "mobile"));
    }
}
