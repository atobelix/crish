//! WS 事件端点实现（R1-05：D2 §10 / M6 会话面 / Z0 §9.3 R1-05）
//!
//! `WS /v1/events`：axum WebSocket upgrade + 令牌鉴权（Bearer 头或
//! `?token=` 查询参数，D2 §10.1 双通道；Origin 双保险）+ 会话面消息循环。
//!
//! ## 消息处理（客户端 → 服务端，DeviceEnvelope 帧）
//!
//! - `events.subscribe`：按会话订阅（≤ [conex_types::device::MAX_SUBSCRIPTIONS]
//!   =32）；回执 `events.subscribe.ok`（逐会话 nextSequence / stale，D3 §7.3）；
//! - `events.subscribeAll`：全局轻订阅（type 白名单；无专用回执，静默成功）；
//! - `events.resume`：游标续传（开区间分页复用 [crate::server::backend::
//!   ApiBackend::read_session_events] 的 EventPage 契约，逐页发
//!   `events.resume.page`，收口 `events.resume.done`，D2 §10.3 / D3 §7.5）；
//! - `heartbeat`：心跳回执 `heartbeat.ok`（时钟校准）；
//! - `events.ack`：诊断模式确认，忽略。
//!
//! ## 服务端 → 客户端
//!
//! - `events.push`：实时事件（一帧一事件，载荷 = AgentEventEnvelope 扁平
//!   JSON 与桌面事件通道逐字节一致；按订阅过滤 + 连接级背压，D2 §10.4）；
//! - `events.push`（R3-02 直推变体）：PushMessage 载荷（schema v1，M8
//!   裁决修正 2）——不经订阅过滤，经 [WsRegistry::send_push_frame] 按令牌
//!   哈希定向投递（PushChannel 直投，适配层见 src/push_wiring.rs）；
//! - `error`：统一错误（未订阅续传 / 订阅超限 / 帧超限 / 版本不匹配 /
//!   踢出原因等）。
//!
//! ## 心跳与生命周期
//!
//! - 服务端每 30s 发 WS Ping 控制帧（客户端库自动回 Pong），90s 无任何
//!   客户端帧 → 踢出（半开检测，D2 §10.2「3 × 心跳间隔」）；
//! - 连接注册表 [WsRegistry]：全局上限 [MAX_WS_CONNECTIONS]=8（D2 §10.5，
//!   P0-3 裁决「每设备一主连接」）；同令牌重复连接踢旧（duplicate-connection）；
//!   令牌撤销经 [WsRegistry::kick_by_token_hash] 踢出（token-revoked，
//!   R1-07 撤销全链接线点）；
//! - 断线清理：连接关闭即注销（sender task 收尾），订阅随之失效。
//!
//! ## R1-01 消费接口（已 merge：server/fanout.rs）
//!
//! 本模块消费 R1-01 `server/fanout.rs` 交付的 [crate::server::fanout::
//! FanOutEmitter]：连接建立时经 [FanOutEmitter::subscribe] 领取
//! [crate::server::fanout::FanoutReceiver]，订阅过滤与端级背压（丢帧分级）
//! 在 fanout 侧完成（D2 §10.4「每连接 drain task」）；本模块负责
//! FanoutReceiver → events.push 信封 → WS 写。订阅变更（subscribe /
//! subscribeAll）经「unsubscribe + subscribe（新过滤器）」重建接收端，
//! drain task 经 watch 通道切换。

mod connection;
mod frames;
mod handlers;
mod registry;

use connection::handle_socket;
use frames::*;
use handlers::handle_text;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::{FromRequestParts, Request, State, WebSocketUpgrade},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use conex_types::device::version::{
    EVENT_WINDOW, MAX_SUBSCRIPTIONS, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX,
};
use conex_types::device::{
    DeviceEndpoint, DeviceEnvelope, DeviceErrorCode, ErrorBody, EventAck, EventsPush, MessageKind,
    Resume, ResumeDone, ResumePage, SessionCursor, Subscribe, SubscribeAll, SubscribeOk,
    PROTOCOL_VERSION,
};
use conex_types::events::BackpressureLevel;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, watch};

use crate::server::fanout::{FanoutError, FanoutReceiver, SubscriptionFilter};
use crate::server::{auth, gateway, now_ms, ServerError, ServerState};

/// WS 事件端点路径（R1-02 占位登记；R1-05 注册路由）
pub const WS_EVENTS_PATH: &str = "/v1/events";
/// 远程中继 host 桥的 loopback WS 入口（桥密钥 + 仅 loopback 部署）
pub const RELAY_LOOPBACK_PATH: &str = "/v1/relay-loopback";
/// 全局连接上限（D2 §10.5：超限拒绝新连接 conn.limit）
pub const MAX_WS_CONNECTIONS: usize = 8;
/// 服务端 Ping 周期（D3 §9.3：WS ping/pong 传输层保活）
const HEARTBEAT_INTERVAL_MS: u64 = 30_000;
/// 断线判定：3 × 心跳间隔无任何客户端帧 → 踢出（D2 §10.2）
const HEARTBEAT_TIMEOUT_MS: u64 = 90_000;
/// 重放期间每会话 pending 缓冲上限（D2 §10.3：超限丢 Delta 保 Critical）
const RESUME_PENDING_CAPACITY: usize = 256;
/// 出站通道容量（发送缓冲；fanout 侧另有 512 连接队列——两级缓冲，
/// 本层仅在发送 await 期间暂存）
const CONN_BUFFER_CAPACITY: usize = 512;
/// 单帧写超时：慢消费者（网络差 / 不读数据）会填满 TCP 发送缓冲，
/// 无上限等待会让 sender task 永久阻塞、连接无法回收。
///
/// 同时约束 drain 侧的「必达帧等待缓冲腾出」：两条路径都卡在同一个写端，
/// 统一以该超时判定连接不可服务并注销。
const WS_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// 踢出原因（D2 §10.1 / §10.5 / §10.6；出网 error 帧 message 携带）
const KICK_DUPLICATE: &str = "duplicate-connection";
const KICK_REVOKED: &str = "token-revoked";
const KICK_TIMEOUT: &str = "heartbeat-timeout";
const KICK_LIMIT: &str = "conn.limit";
/// 服务端 msgId 计数器（出站帧幂等键；跨连接递增）
static MSG_COUNTER: AtomicU64 = AtomicU64::new(0);
/// 虚拟时钟基准（tokio Instant，跟随测试 pause/advance——心跳超时判定用；
/// 协议 ts / serverTime 仍用真实时钟 [now_ms]）
static VIRTUAL_EPOCH: std::sync::OnceLock<tokio::time::Instant> = std::sync::OnceLock::new();

/// 连接注册表（D2 §10.5：conn_id / 令牌 / 订阅 / 最近活动 + 踢出信号）
///
/// 每连接三处并发访问（消息循环 / 广播 drain / 心跳 task），内部一把
/// Mutex 串行化；踢出经 watch 信号（[ConnInfo::kill]）非阻塞通知 sender
/// task——kick 调用方（如 auth.rs 撤销）可在同步上下文安全调用。
pub struct WsRegistry {
    inner: Mutex<WsRegistryInner>,
}

/// 注册表内部状态
struct WsRegistryInner {
    /// 连接 id 发号器（从 1 递增）
    next_id: u64,
    /// conn_id → 连接信息
    conns: HashMap<u64, ConnInfo>,
    /// token 哈希 → conn_id（每设备一主连接语义，P0-3 裁决）
    by_token: HashMap<String, u64>,
}

/// 连接信息（注册表条目）
struct ConnInfo {
    /// 连接 id（发号器分配）
    conn_id: u64,
    /// 令牌 SHA-256 哈希（与 pairing.json 同域）
    token_hash: String,
    /// 设备名（配对签发时登记）
    label: String,
    /// 已认证标志（R1-11 G-2：false = 配对升级连接，完成 pair.hello 前
    /// 仅允许 pair.* 消息——配对期相位门控，D3 §5.2）
    authenticated: bool,
    /// 建立时刻（虚拟时钟 ms，心跳超时判定基准）
    connected_at_ms: u64,
    /// 最近收到客户端帧时刻（虚拟时钟 ms）
    last_frame_at_ms: u64,
    /// 已订阅会话集合（events.subscribe；resume 前置校验 + fanout 过滤器重建）
    sessions: HashSet<String>,
    /// 全局轻订阅 type 白名单（events.subscribeAll；fanout 过滤器重建用）
    subscribe_all: HashSet<String>,
    /// 踢出信号（None = 活跃；Some(reason) = 踢出原因；Some("") = 主动关闭）
    kill: watch::Sender<Option<String>>,
    /// 出站帧通道（R3-02 推送直投：连接建立、channel 创建后经
    /// [WsRegistry::attach_outbound] 注入；None = 尚未注入/未注册）
    out_tx: Option<mpsc::Sender<Outbound>>,
    /// 正在重放的会话（resume 处理中，实时事件改入 pending）
    replaying: HashSet<String>,
    /// 重放期间的实时事件 pending（会话 → 队列；含背压级别供超限丢弃）
    pending: HashMap<String, VecDeque<(conex_types::events::BackpressureLevel, String)>>,
}

/// 连接注册结果（上限拒绝时携带拒绝原因）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOutcome {
    /// 注册成功（返回连接 id）
    Registered(u64),
    /// 全局连接数已达上限（MAX_WS_CONNECTIONS；拒绝新连接）
    LimitExceeded,
}

/// 连接快照（对外只读形状；label + 活动时间 + 订阅数）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnSnapshot {
    /// 连接 id
    pub conn_id: u64,
    /// 设备名
    pub label: String,
    /// 建立时刻（虚拟时钟 ms）
    pub connected_at_ms: u64,
    /// 最近活动时刻（虚拟时钟 ms）
    pub last_frame_at_ms: u64,
    /// 已订阅会话数
    pub subscribed_count: usize,
}

/// 出站帧（sender task 独占 WS 写端；Close 触发正常收尾）
///
/// pub(crate)：R3-02 [WsRegistry::attach_outbound] 公开签名携带
/// `mpsc::Sender<Outbound>`——bin 测试目标按 lib 可见性检查
/// （private-in-public），保持 crate 内可见即可满足
pub enum Outbound {
    /// 文本帧（信封 JSON）或控制帧（Ping/Pong）
    Frame(axum::extract::ws::Message),
    /// 连接侧主动关闭（sender task 收尾并注销）
    Close,
}

/// 帧处理动作（消息循环返回）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    /// 继续处理下一帧
    Continue,
    /// 结束连接（已发错误帧；触发收尾）
    Close,
}

/// 消息循环上下文（避免长参数链）
struct ConnCtx {
    /// 连接 id（注册表主键）
    conn_id: u64,
    /// 路由共享状态（令牌库 / 后端 / 注册表 / 事件流）
    state: ServerState,
    /// 出站通道（sender task 独占消费）
    out_tx: mpsc::Sender<Outbound>,
    /// fanout 接收端更新通道（订阅变更时重建 FanoutReceiver；None =
    /// 未装配 fanout，广播推送不可用）
    fanout_rx: Option<watch::Sender<FanoutReceiver>>,
    /// 令牌密钥（HMAC-SHA256 验签；配对后动态填充）
    token_key: Option<Arc<Mutex<Option<String>>>>,
    /// 本连接认证令牌的 SHA-256 哈希（device.unlink 自撤销用；配对占位连接为临时哈希）
    token_hash: String,
    /// 本机中继桥连接：跳过设备 HMAC/配对相位门控（只允许 loopback + 桥密钥升级）
    trusted_relay: bool,
}

/// WS upgrade handler（GET /v1/events）
///
/// 鉴权双通道（D2 §10.1）：`?token=` 查询参数（浏览器 WS 无法携带自定义
/// 头）或 `Authorization: Bearer <token>`；另做 Origin 双保险（跨站发起
/// 拒绝）。校验失败 → 401（101 前拒绝）；撤销令牌 → 401 +
/// auth.device_revoked。鉴权先于 upgrade 提取——非 WS 请求同样按鉴权
/// 语义响应（不泄露「端点存在」之外的升级信息）。
///
/// 配对升级例外（R1-11 G-2）：存在活跃配对码（协调器 WaitingInput）时，
/// 无令牌/无效令牌连接允许升级进入**配对态**（D3 §5.2「配对期帧无 auth」）
/// ——连接注册为未认证，仅 pair.hello 可入，配对完成（签发令牌）后转入
/// 会话态；无配对活动时保持零信任 401（D2 §7.1 不因本例外放宽）。
pub async fn handle_ws_upgrade(State(state): State<ServerState>, request: Request) -> Response {
    // Origin 双保险（D2 §10.1：非预期 Origin 拒绝；原生客户端无 Origin
    // 头 → 放行）
    if !origin_allowed(request.headers()) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorBody::new(
                DeviceErrorCode::CmdDenied,
                "Origin 不被允许",
            )),
        )
            .into_response();
    }
    // 配对升级例外判定（无令牌/无效令牌时是否放行配对态连接）
    let pair_pending = crate::server::pair_endpoint::pair_upgrade_allowed(&state);
    // 令牌提取（query 优先，Bearer 头兜底）
    let Some(token) = token_from_request(request.uri(), request.headers()) else {
        if pair_pending {
            return upgrade_pairing(request, state).await;
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody::new(
                DeviceErrorCode::AuthBadSignature,
                "缺少令牌（?token= 或 Authorization: Bearer <token>）",
            )),
        )
            .into_response();
    };
    let verdict = lock(&state.tokens()).verify(&token, now_ms());
    match verdict {
        auth::TokenVerdict::Valid => {}
        auth::TokenVerdict::Revoked => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody::new(
                    DeviceErrorCode::AuthDeviceRevoked,
                    "令牌已被撤销，请重新配对",
                )),
            )
                .into_response();
        }
        auth::TokenVerdict::Invalid => {
            if pair_pending {
                return upgrade_pairing(request, state).await;
            }
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody::new(
                    DeviceErrorCode::AuthBadSignature,
                    "令牌校验失败",
                )),
            )
                .into_response();
        }
    }
    // 非 upgrade 请求（普通 GET）：提取失败 → 400/426（无令牌已在上方 401）
    let (mut parts, _body) = request.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    let token_hash = auth::sha256_hex(token.as_bytes());
    let label = lock(&state.tokens())
        .records()
        .iter()
        .find(|record| record.hash == token_hash)
        .map(|record| record.label.clone())
        // M-REDACT（D5 §6.3）：兜底标签只允许 sha256 前缀 12 hex——
        // 旧实现 8 hex 截断，对齐铁律 12 hex 口径（脱敏单一真源在
        // conex-telemetry::redact，避免各处自造截断口径漂移）
        .unwrap_or_else(|| conex_telemetry::redact::redact_token(&token));
    let token_clone = token.clone();
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            state,
            token_hash,
            label,
            false,
            Some(token_clone),
            false,
        )
    })
}

/// 远程中继 host 桥的 loopback 升级：只在本机由账户远程服务使用。
/// 鉴权 = 随机桥密钥（Authorization: Bearer），连接标记 trusted_relay，
/// 跳过设备配对/HMAC；调用方仍必须只 bind 127.0.0.1。
pub async fn handle_relay_loopback_upgrade(
    State(state): State<ServerState>,
    headers: HeaderMap,
    request: Request,
) -> Response {
    let Some(expected) = state.relay_loopback_secret() else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorBody::new(
                DeviceErrorCode::CmdDenied,
                "relay loopback route disabled",
            )),
        )
            .into_response();
    };
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or_default();
    if provided.is_empty() || !auth::constant_time_eq(provided, expected) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody::new(
                DeviceErrorCode::AuthBadSignature,
                "relay loopback bridge key rejected",
            )),
        )
            .into_response();
    }
    let (mut parts, _body) = request.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    let id = MSG_COUNTER.fetch_add(1, Ordering::Relaxed);
    let token_hash = auth::sha256_hex(format!("relay-loopback:{id}").as_bytes());
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            state,
            token_hash,
            "relay-loopback".to_string(),
            false,
            None,
            true,
        )
    })
}

/// 配对升级路径（R1-11 G-2）：配对激活期无令牌/无效令牌连接放行进入
/// 配对态（pair_pending=true——完成 pair.hello 前仅允许 pair.* 消息）。
/// 占位令牌哈希唯一化（register 的「每令牌一主连接」语义防同占位互踢）；
/// 配对完成时经 [WsRegistry::mark_authenticated] 迁移为真实令牌哈希
/// （撤销全链从此可命中）。
async fn upgrade_pairing(request: Request, state: ServerState) -> Response {
    let (mut parts, _body) = request.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    let pairing_id = MSG_COUNTER.fetch_add(1, Ordering::Relaxed);
    let token_hash = auth::sha256_hex(format!("pairing-pending:{pairing_id}").as_bytes());
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            state,
            token_hash,
            "pairing".to_string(),
            true,
            None,
            false,
        )
    })
}

/// 客户端文本帧处理（消息循环分发）
/// 广播载荷分类（R1-01 fanout 侧已解析元信息；本函数保留给测试与
/// 诊断复用：sessionId / type / 背压级别，解析失败按 Critical 保守）
#[cfg(test)]
fn classify_payload(
    payload: &str,
) -> (
    Option<String>,
    Option<String>,
    conex_types::events::BackpressureLevel,
) {
    let value: Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => return (None, None, conex_types::events::BackpressureLevel::Critical),
    };
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    // 背压级别复用既有 event_backpressure（需 AgentEvent 结构解析；信封
    // 解析失败保守按 Critical）
    let level = serde_json::from_str::<conex_types::events::AgentEventEnvelope>(payload)
        .map(|envelope| conex_types::events::event_backpressure(&envelope.event))
        .unwrap_or(conex_types::events::BackpressureLevel::Critical);
    (session_id, event_type, level)
}

/// 出站 msgId（`d-<conn>-<counter>`；8-64 字符规范，M6 §3.3）
fn next_msg_id(conn_id: u64) -> String {
    let n = MSG_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("d-{conn_id:04}-{n:08}")
}

/// 虚拟时钟毫秒（tokio Instant 基准；跟随测试 pause/advance。仅用于
/// 心跳超时判定，协议 ts / serverTime 仍走真实时钟 [now_ms]）
fn virtual_now_ms() -> u64 {
    let epoch = VIRTUAL_EPOCH.get_or_init(tokio::time::Instant::now);
    epoch.elapsed().as_millis() as u64
}

/// Origin 双保险（D2 §10.1）：无 Origin 头（原生客户端）放行；仅放行
/// 本机 host（localhost / 127.0.0.1 / ::1）——浏览器跨站 WS 拒绝
fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let Ok(parsed) = url::Url::parse(origin) else {
        return false;
    };
    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

/// 令牌提取：`?token=` 查询参数优先，`Authorization: Bearer` 兜底
fn token_from_request(uri: &Uri, headers: &HeaderMap) -> Option<String> {
    // query token（浏览器 WS 无法携带自定义头；D2 §10.1）
    if let Ok(parsed) = url::Url::parse(&format!("http://localhost{uri}")) {
        for (key, value) in parsed.query_pairs() {
            if key == "token" && !value.is_empty() {
                return Some(value.into_owned());
            }
        }
    }
    // Bearer 头（REST 同源鉴权通道）
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

/// Mutex 锁（中毒自愈，跟随 auth.rs 先例）
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// listPendingApprovals 空参契约：JSON `null` 视为 `{}`，避免 serde 对 struct
/// 反序列化恒失败 → CmdInvalid（F3 防回潮）。
#[cfg(test)]
fn normalize_list_pending_approvals_params(params_val: Value) -> Value {
    if params_val.is_null() {
        serde_json::json!({})
    } else {
        params_val
    }
}

#[cfg(test)]
mod tests;
