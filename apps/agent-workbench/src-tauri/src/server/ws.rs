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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    Json,
    body::Bytes,
    extract::{FromRequestParts, Request, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use conex_types::device::{
    DeviceEndpoint, DeviceEnvelope, DeviceErrorCode, ErrorBody, EventAck, EventsPush,
    MessageKind, PROTOCOL_VERSION, Resume, ResumeDone, ResumePage, SessionCursor,
    Subscribe, SubscribeAll, SubscribeOk,
};
use conex_types::device::version::{
    EVENT_WINDOW, MAX_SUBSCRIPTIONS, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX,
};
use conex_types::events::BackpressureLevel;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::server::fanout::{FanoutError, FanoutReceiver, SubscriptionFilter};
use crate::server::{ServerError, ServerState, auth, gateway, now_ms};

/// WS 事件端点路径（R1-02 占位登记；R1-05 注册路由）
pub const WS_EVENTS_PATH: &str = "/v1/events";
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

impl WsRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WsRegistryInner {
                next_id: 1,
                conns: HashMap::new(),
                by_token: HashMap::new(),
            }),
        }
    }

    /// 注册新连接：全局上限检查 → 同令牌旧连接踢旧（duplicate-connection）
    /// → 入表。返回新连接 id 或上限拒绝。
    pub fn register(
        &self,
        token_hash: &str,
        label: &str,
        kill: watch::Sender<Option<String>>,
        now: u64,
    ) -> RegisterOutcome {
        let mut inner = lock(&self.inner);
        // 同令牌已有连接 → 踢旧（每设备一主连接，D2 §10.5）
        if let Some(old_id) = inner.by_token.get(token_hash).copied() {
            if let Some(old) = inner.conns.remove(&old_id) {
                tracing::info!(
                    target: "ws",
                    conn_id = old.conn_id,
                    label = %old.label,
                    "同令牌重复连接，踢出旧连接"
                );
                let _ = old.kill.send(Some(KICK_DUPLICATE.to_string()));
            }
            inner.by_token.remove(token_hash);
        }
        // 全局上限检查（D2 §10.5：超限拒绝新连接）
        if inner.conns.len() >= MAX_WS_CONNECTIONS {
            return RegisterOutcome::LimitExceeded;
        }
        let conn_id = inner.next_id;
        inner.next_id += 1;
        inner.conns.insert(
            conn_id,
            ConnInfo {
                conn_id,
                token_hash: token_hash.to_string(),
                label: label.to_string(),
                connected_at_ms: now,
                last_frame_at_ms: now,
                sessions: HashSet::new(),
                subscribe_all: HashSet::new(),
                kill,
                replaying: HashSet::new(),
                pending: HashMap::new(),
            },
        );
        inner.by_token.insert(token_hash.to_string(), conn_id);
        RegisterOutcome::Registered(conn_id)
    }

    /// 注销连接（sender task 收尾调用；幂等）
    pub fn unregister(&self, conn_id: u64) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.remove(&conn_id) {
            if inner.by_token.get(&conn.token_hash) == Some(&conn_id) {
                inner.by_token.remove(&conn.token_hash);
            }
            tracing::info!(target: "ws", conn_id, label = %conn.label, "连接注销");
        }
    }

    /// 刷新最近活动时刻（收到任何客户端帧时调用）
    pub fn touch(&self, conn_id: u64, now: u64) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.last_frame_at_ms = now;
        }
    }

    /// 最近活动时刻（None = 连接已注销；心跳 task 用）
    pub fn last_frame_at(&self, conn_id: u64) -> Option<u64> {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .map(|conn| conn.last_frame_at_ms)
    }

    /// 更新会话订阅（events.subscribe；整体替换）
    pub fn set_subscriptions(&self, conn_id: u64, sessions: Vec<String>) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.sessions = sessions.into_iter().collect();
        }
    }

    /// 更新全局轻订阅白名单（events.subscribeAll；整体替换）
    pub fn set_subscribe_all(&self, conn_id: u64, events: Vec<String>) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.subscribe_all = events.into_iter().collect();
        }
    }

    /// 订阅过滤器双元组快照（fanout 重建 SubscriptionFilter 用；
    /// 订阅变更时由连接侧调用）
    pub fn filter_parts(&self, conn_id: u64) -> (Vec<String>, Vec<String>) {
        let inner = lock(&self.inner);
        let Some(conn) = inner.conns.get(&conn_id) else {
            return (Vec::new(), Vec::new());
        };
        let mut sessions: Vec<String> = conn.sessions.iter().cloned().collect();
        sessions.sort();
        let mut global: Vec<String> = conn.subscribe_all.iter().cloned().collect();
        global.sort();
        (sessions, global)
    }

    /// 会话是否已订阅（resume 前置校验：未订阅 → stream.not_subscribed）
    pub fn is_subscribed(&self, conn_id: u64, session_id: &str) -> bool {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .is_some_and(|conn| conn.sessions.contains(session_id))
    }

    /// 标记会话进入重放（resume 处理开始；实时事件改入 pending）
    pub fn begin_replay(&self, conn_id: u64, session_id: &str) {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.replaying.insert(session_id.to_string());
            conn.pending.entry(session_id.to_string()).or_default();
        }
    }

    /// 结束重放并取回 pending 实时事件（resume.done 后按序 flush）
    pub fn end_replay(
        &self,
        conn_id: u64,
        session_id: &str,
    ) -> VecDeque<(BackpressureLevel, String)> {
        let mut inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get_mut(&conn_id) {
            conn.replaying.remove(session_id);
            conn.pending.remove(session_id).unwrap_or_default()
        } else {
            VecDeque::new()
        }
    }

    /// 会话是否处于重放中（drain 侧判定入 pending）
    pub fn is_replaying(&self, conn_id: u64, session_id: &str) -> bool {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .is_some_and(|conn| conn.replaying.contains(session_id))
    }

    /// 重放期间实时事件入 pending（上限 [RESUME_PENDING_CAPACITY]；超限丢
    /// Delta 保 Critical——复用既有丢帧哲学，D2 §10.3）
    pub fn push_pending(&self, conn_id: u64, session_id: &str, payload: String, level: BackpressureLevel) {
        let mut inner = lock(&self.inner);
        let Some(conn) = inner.conns.get_mut(&conn_id) else {
            return;
        };
        let queue = conn.pending.entry(session_id.to_string()).or_default();
        if queue.len() >= RESUME_PENDING_CAPACITY {
            if level == BackpressureLevel::Delta {
                tracing::debug!(
                    target: "ws",
                    conn_id,
                    session_id,
                    "重放 pending 满，丢 Delta 实时帧"
                );
                return;
            }
            // Critical / Soft 必达：从队头挤掉最早帧（Delta 优先）再入队
            queue.pop_front();
        }
        queue.push_back((level, payload));
    }

    /// 踢出连接（发送踢出信号；sender task 发 kicked 帧后关闭并注销）
    pub fn kick(&self, conn_id: u64, reason: &str) -> bool {
        let inner = lock(&self.inner);
        if let Some(conn) = inner.conns.get(&conn_id) {
            let _ = conn.kill.send(Some(reason.to_string()));
            true
        } else {
            false
        }
    }

    /// 按令牌哈希踢出（R1-07 设备撤销全链：撤销即时生效，D2 §10.6）；
    /// 返回被踢连接 id 列表
    // R1-02 备注同款：R1-07 撤销接线消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn kick_by_token_hash(&self, token_hash: &str, reason: &str) -> Vec<u64> {
        let inner = lock(&self.inner);
        let Some(conn_id) = inner.by_token.get(token_hash).copied() else {
            return Vec::new();
        };
        if let Some(conn) = inner.conns.get(&conn_id) {
            let _ = conn.kill.send(Some(reason.to_string()));
            vec![conn_id]
        } else {
            Vec::new()
        }
    }

    /// 当前连接数
    // R1-02 备注同款：R1-08 管理页 / 测试消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn count(&self) -> usize {
        lock(&self.inner).conns.len()
    }

    /// 连接快照（R1-08 设备管理页 / workbench_pairing_status.connections；
    /// label + 最近活动时间，D2 §10.5）
    // R1-02 备注同款：R1-08 管理页消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn snapshot(&self) -> Vec<ConnSnapshot> {
        lock(&self.inner)
            .conns
            .values()
            .map(|conn| ConnSnapshot {
                conn_id: conn.conn_id,
                label: conn.label.clone(),
                connected_at_ms: conn.connected_at_ms,
                last_frame_at_ms: conn.last_frame_at_ms,
                subscribed_count: conn.sessions.len(),
            })
            .collect()
    }

    /// 连接建立时刻（测试 / 诊断用）
    // R1-02 备注同款：仅测试消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    fn connected_at(&self, conn_id: u64) -> Option<u64> {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .map(|conn| conn.connected_at_ms)
    }

    /// 连接标签（测试 / 诊断用）
    // R1-02 备注同款：仅测试消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    fn label_of(&self, conn_id: u64) -> Option<String> {
        lock(&self.inner)
            .conns
            .get(&conn_id)
            .map(|conn| conn.label.clone())
    }
}

impl Default for WsRegistry {
    fn default() -> Self {
        Self::new()
    }
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
enum Outbound {
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
}

/// WS upgrade handler（GET /v1/events）
///
/// 鉴权双通道（D2 §10.1）：`?token=` 查询参数（浏览器 WS 无法携带自定义
/// 头）或 `Authorization: Bearer <token>`；另做 Origin 双保险（跨站发起
/// 拒绝）。校验失败 → 401（101 前拒绝）；撤销令牌 → 401 +
/// auth.device_revoked。鉴权先于 upgrade 提取——非 WS 请求同样按鉴权
/// 语义响应（不泄露「端点存在」之外的升级信息）。
pub async fn handle_ws_upgrade(State(state): State<ServerState>, request: Request) -> Response {
    // Origin 双保险（D2 §10.1：非预期 Origin 拒绝；原生客户端无 Origin
    // 头 → 放行）
    if !origin_allowed(request.headers()) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorBody::new(DeviceErrorCode::CmdDenied, "Origin 不被允许")),
        )
            .into_response();
    }
    // 令牌提取（query 优先，Bearer 头兜底）
    let Some(token) = token_from_request(request.uri(), request.headers()) else {
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
            return (
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody::new(DeviceErrorCode::AuthBadSignature, "令牌校验失败")),
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
    ws.on_upgrade(move |socket| handle_socket(socket, state, token_hash, label))
}

/// 连接生命周期（升级成功后执行）
///
/// 结构：注册（上限/踢旧）→ split（sender 独占写端）→ 三个并发任务
/// （sender / 广播 drain / 心跳）+ 主消息循环；任一任务退出 → 踢出信号
/// → 全链收尾 → 注销。
async fn handle_socket(
    socket: axum::extract::ws::WebSocket,
    state: ServerState,
    token_hash: String,
    label: String,
) {
    let registry = state.ws_registry();
    let (kill_tx, kill_rx) = watch::channel::<Option<String>>(None);
    let outcome = registry.register(&token_hash, &label, kill_tx.clone(), virtual_now_ms());
    let conn_id = match outcome {
        RegisterOutcome::Registered(id) => id,
        RegisterOutcome::LimitExceeded => {
            // 全局连接上限拒绝（D2 §10.5：conn.limit 错误帧后关闭）
            let frame = error_frame(
                0,
                DeviceErrorCode::TransportClosed,
                format!("连接数已达上限（{KICK_LIMIT}）"),
                None,
            );
            let mut socket = socket;
            if socket.send(axum::extract::ws::Message::Text(frame.into())).await.is_ok() {
                let _ = socket.close().await;
            }
            return;
        }
    };
    let (ws_sender, mut ws_receiver) = socket.split();
    let (out_tx, out_rx) = mpsc::channel::<Outbound>(CONN_BUFFER_CAPACITY);

    // sender task：独占 WS 写端；踢出信号 → 发 kicked 帧 → 关闭 → 注销
    let sender_task = tokio::spawn(sender_loop(
        ws_sender,
        out_rx,
        kill_rx.clone(),
        Arc::clone(&registry),
        conn_id,
    ));

    // 心跳 task：30s Ping + 90s 无帧踢出
    let heartbeat_task = tokio::spawn(heartbeat_loop(
        Arc::clone(&registry),
        conn_id,
        out_tx.clone(),
        kill_rx.clone(),
    ));

    // 广播 drain task：fanout 接收端 → 重放 pending / 背压入队
    // （R1-01 FanOutEmitter：连接建立即注册空过滤器，events.subscribe
    // 到达后经 refresh_fanout_filter 重建；fanout 未装配 = 无广播推送）
    let fanout_ctx: Option<(watch::Sender<FanoutReceiver>, watch::Receiver<FanoutReceiver>)> =
        if let Some(fanout) = state.fanout() {
            match fanout.subscribe(conn_id.to_string(), SubscriptionFilter::default()) {
                Ok(receiver) => {
                    let (rx_tx, rx_rx) = watch::channel(receiver);
                    Some((rx_tx, rx_rx))
                }
                Err(FanoutError::AlreadyRegistered) => {
                    // 连接 id 冲突属进程级异常：关闭广播（订阅/续传/心跳
                    // 仍可用），记错误日志
                    tracing::error!(
                        target: "ws",
                        conn_id,
                        "fanout 订阅注册冲突，本连接广播推送禁用"
                    );
                    None
                }
            }
        } else {
            None
        };
    let drain_task = if let Some((_, rx_rx)) = &fanout_ctx {
        Some(tokio::spawn(drain_loop(
            rx_rx.clone(),
            Arc::clone(&registry),
            conn_id,
            out_tx.clone(),
            kill_rx.clone(),
        )))
    } else {
        None
    };

    // 主消息循环（读端独占）
    let ctx = ConnCtx {
        conn_id,
        state,
        out_tx: out_tx.clone(),
        fanout_rx: fanout_ctx.map(|(rx_tx, _)| rx_tx),
    };
    while let Some(frame) = ws_receiver.next().await {
        match frame {
            Ok(axum::extract::ws::Message::Text(text)) => {
                registry.touch(conn_id, virtual_now_ms());
                if handle_text(text.to_string(), &ctx).await == Action::Close {
                    break;
                }
            }
            Ok(axum::extract::ws::Message::Pong(_)) => {
                // 客户端 Pong（服务端 Ping 的应答）刷新活动时刻
                registry.touch(conn_id, virtual_now_ms());
            }
            Ok(axum::extract::ws::Message::Ping(payload)) => {
                // 客户端主动 Ping → 回 Pong
                registry.touch(conn_id, virtual_now_ms());
                let _ = out_tx
                    .send(Outbound::Frame(axum::extract::ws::Message::Pong(payload.into())))
                    .await;
            }
            Ok(axum::extract::ws::Message::Binary(_)) => {
                // 协议只定义文本帧；二进制帧记录后忽略
                registry.touch(conn_id, virtual_now_ms());
                tracing::debug!(target: "ws", conn_id, "收到二进制帧，忽略");
            }
            Ok(axum::extract::ws::Message::Close(_)) | Err(_) => break,
        }
    }

    // 收尾：通知全部并发任务退出（sender 收尾注销；心跳/drain 退出）
    let _ = kill_tx.send(Some(String::new()));
    let _ = out_tx.send(Outbound::Close).await;
    let _ = sender_task.await;
    let _ = heartbeat_task.await;
    if let Some(task) = drain_task {
        let _ = task.await;
    }
    // fanout 订阅注销（R1-01 连接注册表；断线清理，D2 §10.5）
    if let Some(fanout) = ctx.state.fanout() {
        fanout.unsubscribe(&conn_id.to_string());
    }
}

/// sender task：独占 WS 写端（出站通道消费 + 踢出信号处理）
async fn sender_loop(
    mut ws_sender: futures_util::stream::SplitSink<axum::extract::ws::WebSocket, axum::extract::ws::Message>,
    mut out_rx: mpsc::Receiver<Outbound>,
    mut kill_rx: watch::Receiver<Option<String>>,
    registry: Arc<WsRegistry>,
    conn_id: u64,
) {
    // 踢出原因（None = 正常/主动关闭，不发踢出帧）
    let kicked: Option<String> = loop {
        tokio::select! {
            _ = kill_rx.changed() => {
                match kill_rx.borrow().clone() {
                    Some(reason) if !reason.is_empty() => break Some(reason),
                    // 空串 = 主动关闭：不立即退出——继续消费出站队列，
                    // 先发完已入队的帧（Close 帧已在队列中）再收尾
                    _ => continue,
                }
            }
            out = out_rx.recv() => match out {
                Some(Outbound::Frame(message)) => {
                    if ws_sender.send(message).await.is_err() {
                        break None;
                    }
                }
                Some(Outbound::Close) | None => break None,
            },
        }
    };
    if let Some(reason) = kicked {
        if let Ok(frame) = serde_json::to_string(&kicked_envelope(&reason, conn_id)) {
            let _ = ws_sender
                .send(axum::extract::ws::Message::Text(frame.into()))
                .await;
        }
    }
    let _ = ws_sender.close().await;
    registry.unregister(conn_id);
}

/// 心跳 task：周期 Ping + 半开检测（3 × 心跳间隔无客户端帧 → 踢出）
async fn heartbeat_loop(
    registry: Arc<WsRegistry>,
    conn_id: u64,
    out_tx: mpsc::Sender<Outbound>,
    mut kill_rx: watch::Receiver<Option<String>>,
) {
    let mut interval =
        tokio::time::interval(std::time::Duration::from_millis(HEARTBEAT_INTERVAL_MS));
    // 首 tick 立即完成：先消耗——首个 Ping 在 30s 后发出，避免升级瞬间
    // 的控制帧干扰客户端握手后的首帧读取
    interval.tick().await;
    loop {
        tokio::select! {
            _ = kill_rx.changed() => break,
            _ = interval.tick() => {}
        }
        // 连接已注销（主循环收尾完成）→ 退出
        let Some(last_frame) = registry.last_frame_at(conn_id) else {
            break;
        };
        // 半开检测：90s 无任何客户端帧 → 踢出（D2 §10.2；超时判定经帧网关
        // [gateway::read_timeout_exceeded] 纯函数，虚拟时钟与 touch 同源）
        if gateway::read_timeout_exceeded(last_frame, virtual_now_ms(), HEARTBEAT_TIMEOUT_MS) {
            tracing::warn!(target: "ws", conn_id, "心跳超时（90s 无客户端帧），踢出");
            registry.kick(conn_id, KICK_TIMEOUT);
            break;
        }
        // 传输层保活（客户端库自动回 Pong → 主循环 touch 刷新活动时刻）
        if out_tx
            .send(Outbound::Frame(axum::extract::ws::Message::Ping(Bytes::new())))
            .await
            .is_err()
        {
            break;
        }
    }
}

/// 广播 drain task：fanout 接收端（订阅过滤与端级背压已在 fanout 侧
/// 完成，D2 §10.4）→ 重放 pending / 发送缓冲入队
async fn drain_loop(
    mut rx_handle: watch::Receiver<FanoutReceiver>,
    registry: Arc<WsRegistry>,
    conn_id: u64,
    out_tx: mpsc::Sender<Outbound>,
    mut kill_rx: watch::Receiver<Option<String>>,
) {
    loop {
        // 等待：fanout 接收端更新（订阅变更重建）或新事件
        let event = {
            let current = rx_handle.borrow().clone();
            tokio::select! {
                _ = kill_rx.changed() => break,
                _ = rx_handle.changed() => continue,
                event = current.recv() => event,
            }
        };
        let Some(event) = event else { break };
        // 重放期间：实时事件入 pending（resume.done 后按序 flush，
        // 保证「先重放后实时」每会话顺序，D2 §10.3）
        if let Some(sid) = event.session_id.as_deref() {
            if registry.is_replaying(conn_id, sid) {
                registry.push_pending(conn_id, sid, event.payload.clone(), event.level);
                continue;
            }
        }
        // 常规推送（背压：缓冲满丢 Delta 保 Critical，D2 §10.4）
        let frame = match push_frame(&event.session_id.unwrap_or_default(), &event.payload) {
            Ok(body) => outbound_frame(conn_id, MessageKind::EventsPush, body),
            Err(error) => {
                tracing::error!(target: "ws", conn_id, error = %error, "推送帧构造失败（跳过）");
                continue;
            }
        };
        match out_tx.try_send(Outbound::Frame(axum::extract::ws::Message::Text(frame.into()))) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(full)) => {
                if event.level == conex_types::events::BackpressureLevel::Delta {
                    tracing::debug!(target: "ws", conn_id, "发送缓冲满，丢 Delta 帧");
                    continue;
                }
                // Critical / Soft 必达：等待缓冲腾出（慢消费者仅自限，
                // 不阻塞引擎发射路径——fanout publish 非阻塞，D2 §10.7）
                if out_tx.send(full).await.is_err() {
                    break;
                }
            }
            Err(mpsc::error::TrySendError::Closed(_)) => break,
        }
    }
}

/// 客户端文本帧处理（消息循环分发）
async fn handle_text(text: String, ctx: &ConnCtx) -> Action {
    // 帧大小上限（D3 §5.5 / D5 §7.5：超限断链防内存放大；1 MiB 上限经
    // 帧网关 [gateway::validate_frame_size] 单一事实源判定）
    if gateway::validate_frame_size(text.len()) != gateway::FrameVerdict::Ok {
        tracing::warn!(target: "ws", conn_id = ctx.conn_id, bytes = text.len(), "帧超 1 MiB 上限");
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::FrameTooLarge,
            format!("帧超 1 MiB 上限（frame_too_large）"),
            None,
        );
        return send_then_close(ctx, frame).await;
    }
    // 信封解析（损坏载荷：错误帧提示 + 保持连接——防御性宽容）
    let envelope: DeviceEnvelope = match serde_json::from_str(&text) {
        Ok(envelope) => envelope,
        Err(error) => {
            tracing::warn!(target: "ws", conn_id = ctx.conn_id, error = %error, "信封解析失败，忽略该帧");
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                "信封解析失败（cmd.invalid）".to_string(),
                None,
            );
            let _ = send_frame(ctx, frame).await;
            return Action::Continue;
        }
    };
    // 协议版本校验（不匹配 → version_mismatch + 关闭）
    if envelope.v != PROTOCOL_VERSION {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::VersionMismatch,
            format!("协议版本不匹配：期望 {PROTOCOL_VERSION}，收到 {}", envelope.v),
            Some(envelope.msg_id.as_str()),
        );
        return send_then_close(ctx, frame).await;
    }
    match &envelope.kind {
        MessageKind::EventsSubscribe => handle_subscribe(envelope.body, ctx).await,
        MessageKind::EventsSubscribeAll => handle_subscribe_all(envelope.body, ctx).await,
        MessageKind::EventsResume => handle_resume(envelope.body, ctx).await,
        MessageKind::Heartbeat => handle_heartbeat(envelope.body, ctx).await,
        MessageKind::EventsAck => {
            // 诊断模式确认（ackMode=critical）；本层无需处理，记调试日志
            let _ = serde_json::from_value::<EventAck>(envelope.body.clone());
            Action::Continue
        }
        MessageKind::Error => {
            // 对端错误帧：记录（不关闭，宽容）
            tracing::debug!(target: "ws", conn_id = ctx.conn_id, "收到对端 error 帧");
            Action::Continue
        }
        // R1-05 范围外消息（命令 / 配对 / 认证 / 流 / 设备 / 会话索引）：
        // 宽容忽略 + 记录（D3 §10.3「未知 kind 丢弃 + 记日志，不报错」）
        _ => {
            tracing::debug!(
                target: "ws",
                conn_id = ctx.conn_id,
                kind = %envelope.kind_str(),
                "R1-05 范围外 kind，忽略"
            );
            Action::Continue
        }
    }
}

/// events.subscribe：按会话订阅（≤ MAX_SUBSCRIPTIONS）+ 回执 subscribe.ok
async fn handle_subscribe(body: Value, ctx: &ConnCtx) -> Action {
    let subscribe: Subscribe = match serde_json::from_value(body.clone()) {
        Ok(subscribe) => subscribe,
        Err(error) => {
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                format!("subscribe 载荷非法：{error}"),
                None,
            );
            return send_frame(ctx, frame).await;
        }
    };
    if subscribe.sessions.len() > MAX_SUBSCRIPTIONS {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::StreamTooManySubscriptions,
            format!("订阅会话超限（{}，上限 {}）", subscribe.sessions.len(), MAX_SUBSCRIPTIONS),
            None,
        );
        return send_frame(ctx, frame).await;
    }
    ctx.state
        .ws_registry()
        .set_subscriptions(ctx.conn_id, subscribe.sessions.clone());
    refresh_fanout_filter(ctx);
    // 逐会话游标回执（nextSequence = 会话当前 max+1；stale = 落后超窗口）
    let mut cursors = Vec::with_capacity(subscribe.sessions.len());
    if let Some(backend) = ctx.state.backend() {
        for session_id in &subscribe.sessions {
            let last = subscribe.last_sequences.sequence_of(session_id);
            let params = conex_types::device::EventPageParams {
                session_id: session_id.clone(),
                after_sequence: Some(last),
                max_events: Some(1),
                direction: None,
            };
            match backend.read_session_events(params).await {
                Ok(page) => {
                    // nextSequence = 会话当前 max+1；会话不存在（latest
                    // 为 None）→ 0（无事件可续）
                    let next_sequence = match page.latest_sequence {
                        Some(latest) => latest.saturating_add(1),
                        None => 0,
                    };
                    let stale = match page.latest_sequence {
                        Some(latest) => latest.saturating_sub(last) > EVENT_WINDOW as u64,
                        None => false,
                    };
                    cursors.push(SessionCursor {
                        session_id: session_id.clone(),
                        next_sequence,
                        stale,
                    });
                }
                Err(error) => {
                    tracing::warn!(
                        target: "ws",
                        conn_id = ctx.conn_id,
                        session_id,
                        error = %error,
                        "订阅游标查询失败，按已追平回执"
                    );
                    cursors.push(SessionCursor {
                        session_id: session_id.clone(),
                        next_sequence: last,
                        stale: false,
                    });
                }
            }
        }
    }
    let body = SubscribeOk { sessions: cursors };
    send_envelope(ctx, MessageKind::EventsSubscribeOk, body).await
}

/// events.subscribeAll：全局轻订阅（type 白名单；静默成功，M6 无专用回执）
async fn handle_subscribe_all(body: Value, ctx: &ConnCtx) -> Action {
    let subscribe_all: SubscribeAll = match serde_json::from_value(body.clone()) {
        Ok(subscribe_all) => subscribe_all,
        Err(error) => {
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                format!("subscribeAll 载荷非法：{error}"),
                None,
            );
            return send_frame(ctx, frame).await;
        }
    };
    ctx.state
        .ws_registry()
        .set_subscribe_all(ctx.conn_id, subscribe_all.events);
    refresh_fanout_filter(ctx);
    Action::Continue
}

/// 按注册表当前订阅状态重建 fanout 订阅（unsubscribe + subscribe 新
/// 过滤器 → 经 watch 更新 drain 接收端；fanout 未装配时为空操作）
fn refresh_fanout_filter(ctx: &ConnCtx) {
    let (Some(fanout), Some(rx_tx)) = (ctx.state.fanout(), &ctx.fanout_rx) else {
        return;
    };
    let conn_key = ctx.conn_id.to_string();
    fanout.unsubscribe(&conn_key);
    let (sessions, global) = ctx.state.ws_registry().filter_parts(ctx.conn_id);
    match fanout.subscribe(conn_key, SubscriptionFilter::new(sessions, global)) {
        Ok(new_receiver) => {
            let _ = rx_tx.send(new_receiver);
        }
        Err(FanoutError::AlreadyRegistered) => {
            // 重建冲突（unsubscribe 后注册不应冲突）：保留旧接收端，记日志
            tracing::warn!(
                target: "ws",
                conn_id = ctx.conn_id,
                "fanout 订阅重建冲突，沿用旧过滤"
            );
        }
    }
}

/// events.resume：游标续传（未订阅拒绝 → 逐页 resume.page → resume.done
/// → flush 重放期间 pending）
async fn handle_resume(body: Value, ctx: &ConnCtx) -> Action {
    let resume: Resume = match serde_json::from_value(body.clone()) {
        Ok(resume) => resume,
        Err(error) => {
            let frame = error_frame(
                ctx.conn_id,
                DeviceErrorCode::CmdInvalid,
                format!("resume 载荷非法：{error}"),
                None,
            );
            return send_frame(ctx, frame).await;
        }
    };
    let registry = ctx.state.ws_registry();
    // 前置校验：未订阅会话即请求续传（M6 §6.2.2 stream.not_subscribed）
    if !registry.is_subscribed(ctx.conn_id, &resume.session_id) {
        let frame = error_frame(
            ctx.conn_id,
            DeviceErrorCode::StreamNotSubscribed,
            format!("未订阅会话 {} 即请求续传（stream.not_subscribed）", resume.session_id),
            None,
        );
        return send_frame(ctx, frame).await;
    }
    let page_size = resume
        .max_events
        .unwrap_or(PAGE_SIZE_DEFAULT)
        .clamp(1, PAGE_SIZE_MAX);
    // 重放期间实时事件入 pending（保证「先重放后实时」每会话顺序）
    registry.begin_replay(ctx.conn_id, &resume.session_id);
    let mut cursor = resume.after_sequence;
    if let Some(backend) = ctx.state.backend() {
        loop {
            let params = conex_types::device::EventPageParams {
                session_id: resume.session_id.clone(),
                after_sequence: Some(cursor),
                max_events: Some(page_size),
                direction: None,
            };
            match backend.read_session_events(params).await {
                Ok(page) => {
                    if !page.events.is_empty() {
                        let page_body = ResumePage {
                            session_id: resume.session_id.clone(),
                            events: page.events,
                            next_after_sequence: page.next_after_sequence,
                            has_more: page.has_more,
                        };
                        if send_envelope(ctx, MessageKind::EventsResumePage, page_body).await
                            == Action::Close
                        {
                            let _ = registry.end_replay(ctx.conn_id, &resume.session_id);
                            return Action::Close;
                        }
                    }
                    cursor = page.next_after_sequence;
                    if !page.has_more {
                        break;
                    }
                }
                Err(error) => {
                    tracing::error!(
                        target: "ws",
                        conn_id = ctx.conn_id,
                        session_id = %resume.session_id,
                        error = %error,
                        "续传分页查询失败，中断重放"
                    );
                    break;
                }
            }
        }
    }
    // 重放收口：resume.done（resumedTo = 已追平到的序列）
    let pending = registry.end_replay(ctx.conn_id, &resume.session_id);
    let done = ResumeDone {
        session_id: resume.session_id.clone(),
        resumed_to: cursor,
    };
    if send_envelope(ctx, MessageKind::EventsResumeDone, done).await == Action::Close {
        return Action::Close;
    }
    // flush 重放期间到达的实时事件（按到达序；此时已脱离重放态）
    for (_, payload) in pending {
        let frame = match push_frame(&resume.session_id, &payload) {
            Ok(body) => outbound_frame(ctx.conn_id, MessageKind::EventsPush, body),
            Err(error) => {
                tracing::error!(target: "ws", conn_id = ctx.conn_id, error = %error, "pending 帧构造失败（跳过）");
                continue;
            }
        };
        if ctx
            .out_tx
            .send(Outbound::Frame(axum::extract::ws::Message::Text(frame.into())))
            .await
            .is_err()
        {
            return Action::Close;
        }
    }
    Action::Continue
}

/// heartbeat：回执 heartbeat.ok（时钟校准，D3 §9.3）
async fn handle_heartbeat(body: Value, ctx: &ConnCtx) -> Action {
    // 载荷宽松解析（心跳格式非法仍回执——保活优先）
    let heartbeat = serde_json::from_value::<conex_types::device::Heartbeat>(body.clone())
        .unwrap_or(conex_types::device::Heartbeat {
            ts: now_ms(),
            device_time_ms: 0,
        });
    let ok = conex_types::device::HeartbeatOk {
        ts: heartbeat.ts,
        server_time: now_ms(),
    };
    send_envelope(ctx, MessageKind::HeartbeatOk, ok).await
}

/// 发送出站信封（序列化 body → 信封 → 文本帧 → out_tx；回执/错误必达）
async fn send_envelope(ctx: &ConnCtx, kind: MessageKind, body: impl Serialize) -> Action {
    let value = match serde_json::to_value(&body) {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(target: "ws", conn_id = ctx.conn_id, error = %error, "出站消息序列化失败");
            return Action::Continue;
        }
    };
    let frame = outbound_frame(ctx.conn_id, kind, value);
    send_frame(ctx, frame).await
}

/// 发送文本帧（必达语义：缓冲满时等待腾出）
async fn send_frame(ctx: &ConnCtx, frame: String) -> Action {
    match ctx.out_tx.try_send(Outbound::Frame(axum::extract::ws::Message::Text(frame.clone().into()))) {
        Ok(()) => Action::Continue,
        Err(mpsc::error::TrySendError::Full(_)) => {
            if ctx
                .out_tx
                .send(Outbound::Frame(axum::extract::ws::Message::Text(frame.into())))
                .await
                .is_err()
            {
                Action::Close
            } else {
                Action::Continue
            }
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Action::Close,
    }
}

/// 发送错误帧后关闭连接（frame_too_large / version_mismatch 等断链场景）
async fn send_then_close(ctx: &ConnCtx, frame: String) -> Action {
    let _ = send_frame(ctx, frame).await;
    Action::Close
}

/// 构造出站信封文本帧（from=desktop → to=mobile；msgId 计数器分配）
fn outbound_frame(conn_id: u64, kind: MessageKind, body: Value) -> String {
    let envelope = DeviceEnvelope::unsigned(
        kind,
        next_msg_id(conn_id),
        now_ms(),
        DeviceEndpoint::Desktop,
        DeviceEndpoint::Mobile,
        body,
    );
    serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string())
}

/// 构造踢出帧（reason → 错误码映射，D2 §10.6）
fn kicked_envelope(reason: &str, conn_id: u64) -> DeviceEnvelope {
    // token-revoked：设备已撤销（移动端进入 unauthorized 终止态，不自动
    // 重试）；其余：transport.closed（可重连）
    let (code, message) = if reason == KICK_REVOKED {
        (
            DeviceErrorCode::AuthDeviceRevoked,
            format!("设备已被撤销（{reason}）"),
        )
    } else {
        (
            DeviceErrorCode::TransportClosed,
            format!("连接被服务端关闭（{reason}）"),
        )
    };
    let body = ErrorBody::new(code, message);
    DeviceEnvelope::unsigned(
        MessageKind::Error,
        next_msg_id(conn_id),
        now_ms(),
        DeviceEndpoint::Desktop,
        DeviceEndpoint::Mobile,
        serde_json::to_value(body).unwrap_or_default(),
    )
}

/// 构造 error 帧文本（统一出网错误；reqMsgId 关联请求）
fn error_frame(conn_id: u64, code: DeviceErrorCode, message: String, req_msg_id: Option<&str>) -> String {
    let mut body = ErrorBody::new(code, message);
    if let Some(msg_id) = req_msg_id {
        body = body.with_req_msg_id(msg_id);
    }
    outbound_frame(
        conn_id,
        MessageKind::Error,
        serde_json::to_value(body).unwrap_or_default(),
    )
}

/// 构造 events.push 消息体（preview = 事件 sequence 未落库，D3 §7.4；
/// 外层 DeviceEnvelope 由调用方 [outbound_frame] 包装）
fn push_frame(session_id: &str, payload: &str) -> Result<Value, ServerError> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|e| ServerError::internal(format!("事件载荷解析失败：{e}")))?;
    let preview = value.get("sequence").is_none();
    let body = EventsPush {
        session_id: session_id.to_string(),
        preview,
        event: value,
    };
    serde_json::to_value(&body)
        .map_err(|e| ServerError::internal(format!("events.push 序列化失败：{e}")))
}

/// 广播载荷分类（R1-01 fanout 侧已解析元信息；本函数保留给测试与
/// 诊断复用：sessionId / type / 背压级别，解析失败按 Critical 保守）
#[cfg(test)]
fn classify_payload(payload: &str) -> (Option<String>, Option<String>, conex_types::events::BackpressureLevel) {
    let value: Value = match serde_json::from_str(payload) {
        Ok(value) => value,
        Err(_) => return (None, None, conex_types::events::BackpressureLevel::Critical),
    };
    let session_id = value.get("sessionId").and_then(Value::as_str).map(str::to_string);
    let event_type = value.get("type").and_then(Value::as_str).map(str::to_string);
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
    let epoch = VIRTUAL_EPOCH.get_or_init(|| tokio::time::Instant::now());
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

#[cfg(test)]
mod tests {
    // 测试临时目录清理豁免（clippy.toml 豁免面同 auth.rs 测试）
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::core_event_bridge::Emitter;
    use crate::server::backend::ApiBackend;
    use crate::server::fanout::FanOutEmitter;
    use crate::server::{ServerConfig, ServerHandle, ServerInstance, ServerState, router};
    use crate::server::auth::{TokenStore, sha256_hex};
    use conex_types::device::version::MAX_FRAME_BYTES;
    use conex_types::device::{
        ApproveParams, ApproveResult, CancelRunParams, CancelRunResult, DenyParams, EventPageParams,
        EventPageResult, ListCommandsResult, ListSessionsParams, ListSessionsResult,
        RunControlParams, RunControlResult, RunSnapshotParams, RunSnapshotResult,
        RunTaskParams, RunTaskResult,
    };
    use std::net::SocketAddr;
    use std::time::Duration;

    // ── 测试基建 ──────────────────────────────────────────────

    /// 内存事件后端：read_session_events 从内存表分页（游标语义与
    /// conex-db query_events 同构：`sequence > after` 升序 + limit）
    struct MemoryBackend {
        /// 会话 → (sequence, 扁平事件 JSON)
        events: Mutex<HashMap<String, Vec<(u64, Value)>>>,
    }

    impl MemoryBackend {
        fn new() -> Self {
            Self {
                events: Mutex::new(HashMap::new()),
            }
        }

        /// 追加事件（sequence 递增）
        fn push(&self, session_id: &str, event_type: &str, sequence: u64) {
            let mut map = self.events.lock().unwrap();
            map.entry(session_id.to_string()).or_default().push((
                sequence,
                serde_json::json!({
                    "type": event_type,
                    "sessionId": session_id,
                    "sequence": sequence,
                    "schemaVersion": 1,
                    "runId": "r-test",
                }),
            ));
        }

        /// 批量追加（连续 sequence）
        fn push_range(&self, session_id: &str, event_type: &str, from: u64, count: u64) {
            for seq in from..from + count {
                self.push(session_id, event_type, seq);
            }
        }
    }

    #[async_trait::async_trait]
    impl ApiBackend for MemoryBackend {
        async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
            Ok(serde_json::json!({ "initialized": true }))
        }
        async fn run_task(&self, _p: RunTaskParams) -> Result<RunTaskResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn run_control(&self, _p: RunControlParams) -> Result<RunControlResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn cancel_run(&self, _p: CancelRunParams) -> Result<CancelRunResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn approve(&self, _p: ApproveParams) -> Result<ApproveResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn deny(&self, _p: DenyParams) -> Result<ApproveResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn list_sessions(
            &self,
            _p: ListSessionsParams,
        ) -> Result<ListSessionsResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn read_session_events(
            &self,
            params: EventPageParams,
        ) -> Result<EventPageResult, ServerError> {
            let rows = self.events.lock().unwrap();
            let session_rows = rows.get(&params.session_id).cloned().unwrap_or_default();
            let after = params.after_sequence.unwrap_or(0);
            let limit = params.max_events.unwrap_or(200) as usize;
            // 空会话 → None（与 core_read_session_events 语义对齐）
            let latest = session_rows.last().map(|(seq, _)| *seq);
            let filtered: Vec<(u64, Value)> = session_rows
                .into_iter()
                .filter(|(seq, _)| *seq > after)
                .collect();
            let has_more = filtered.len() > limit;
            let page: Vec<Value> = filtered
                .iter()
                .take(limit)
                .map(|(_, event)| event.clone())
                .collect();
            let next = page
                .last()
                .and_then(|event| event["sequence"].as_u64())
                .unwrap_or(after);
            Ok(EventPageResult {
                events: page,
                next_after_sequence: next,
                has_more,
                latest_sequence: latest,
            })
        }
        async fn get_run_snapshot(
            &self,
            _p: RunSnapshotParams,
        ) -> Result<RunSnapshotResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
        async fn list_commands(&self) -> Result<ListCommandsResult, ServerError> {
            Err(ServerError::internal("测试后端不支持"))
        }
    }

    /// 测试事件流注入：直接构造 R1-01 的 FanOutEmitter（发布经
    /// FanOutEmitter::emit 驱动，与生产装配同源）
    fn test_fanout() -> Arc<FanOutEmitter> {
        Arc::new(FanOutEmitter::new(vec![]))
    }

    /// 测试服务（临时端口 + 多令牌 + 后端 + 事件流注入）；返回
    /// (地址, 句柄, 明文令牌表, 连接注册表)
    async fn spawn_server_with_tokens(
        backend: Option<Arc<dyn ApiBackend>>,
        fanout: Option<Arc<FanOutEmitter>>,
        labels: &[&str],
    ) -> (SocketAddr, ServerHandle, Vec<String>, Arc<WsRegistry>) {
        let dir = tempfile::tempdir().expect("临时目录必须可创建");
        // port=0：系统分配临时端口（并行测试互不抢占）
        let mut config = ServerConfig::new(dir.path());
        config.port = 0;
        // 预签发令牌（pairing.json 由 TokenStore 落盘）
        let tokens = {
            let mut store = TokenStore::new(config.pairing_file_path.clone());
            let mut issued = Vec::new();
            for label in labels {
                issued.push(store.issue(label, now_ms()).expect("签发必须成功"));
            }
            issued
        };
        let instance = ServerInstance::bind(config).await.expect("测试绑定失败");
        let addr = instance.addr();
        let handle = instance.handle().clone();
        let registry = {
            let tokens_store = TokenStore::load(&instance.handle().config().pairing_file_path);
            let mut state = ServerState::new(instance.handle(), tokens_store, backend);
            state.set_event_stream(fanout);
            let registry = state.ws_registry();
            let router = router::build_router(state);
            tokio::spawn(async move {
                let _ = instance.serve(router).await;
            });
            registry
        };
        // 轮询等待服务就绪
        let url = format!("http://{addr}/v1/info");
        for _ in 0..100 {
            if reqwest::get(&url).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        (addr, handle, tokens, registry)
    }

    /// 测试服务（单令牌便捷版）
    async fn test_server(
        backend: Option<Arc<dyn ApiBackend>>,
        fanout: Option<Arc<FanOutEmitter>>,
    ) -> (SocketAddr, ServerHandle, String, Arc<WsRegistry>) {
        let (addr, handle, mut tokens, registry) =
            spawn_server_with_tokens(backend, fanout, &["test-device"]).await;
        (addr, handle, tokens.remove(0), registry)
    }

    /// WS 客户端连接（query token）
    async fn ws_connect(
        addr: SocketAddr,
        token: &str,
    ) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>
    {
        let url = format!("ws://{addr}/v1/events?token={token}");
        let (ws, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("WS 连接必须成功");
        ws
    }

    /// 读下一帧文本（超时护栏；Close/错误折叠为标记串；控制帧跳过——
    /// tungstenite 0.29 会把 Ping/Pong 控制帧传给应用层，服务端心跳
    /// Ping 到达时库已自动回 Pong，此处忽略不干扰业务帧读取）
    async fn next_text(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Option<String> {
        loop {
            match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
                Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                    return Some(text.to_string());
                }
                Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))) => {
                    return Some(String::from("<closed>"));
                }
                Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_))))
                | Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_)))) => continue,
                Ok(Some(Ok(_))) => continue,
                Ok(Some(Err(_))) => return Some(String::from("<error>")),
                Ok(None) => return Some(String::from("<closed>")),
                Err(_) => panic!("等待帧超时"),
            }
        }
    }

    /// 发送信封帧（kind + body；msgId 计数器生成）
    async fn send_envelope_text(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        kind: &str,
        body: Value,
    ) {
        let kind: MessageKind = serde_json::from_str(&format!("\"{kind}\"")).unwrap();
        let envelope = DeviceEnvelope::unsigned(
            kind,
            format!("m-test-{:08}", MSG_COUNTER.fetch_add(1, Ordering::Relaxed)),
            now_ms(),
            DeviceEndpoint::Mobile,
            DeviceEndpoint::Desktop,
            body,
        );
        let text = serde_json::to_string(&envelope).unwrap();
        let _ = ws
            .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
            .await;
    }

    /// 解析信封帧（kind wire 名 + body）
    fn parse_frame(text: &str) -> (String, Value) {
        if text == "<closed>" || text == "<error>" {
            return (text.to_string(), Value::Null);
        }
        let envelope: DeviceEnvelope = serde_json::from_str(text).expect("帧必须为合法信封");
        (envelope.kind.as_str(), envelope.body)
    }

    /// 广播事件（模拟引擎 emit → FanOutEmitter 扇出；载荷为信封扁平
    /// JSON，与桌面事件通道同构——事件字段需可被 AgentEvent 完整解析，
    /// 否则 fanout 侧 fail-closed 跳过）
    fn publish(fanout: &FanOutEmitter, session_id: &str, event_type: &str, sequence: Option<u64>) {
        let mut payload = serde_json::json!({
            "type": event_type,
            "sessionId": session_id,
            "schemaVersion": 1,
            "runId": "r-test",
            "timestamp": "2026-01-01T00:00:00Z",
        });
        // run-terminal 的必填事件字段（RunTerminalStatus）
        if event_type == "run-terminal" {
            payload["terminal"] = serde_json::json!("completed");
        }
        if let Some(seq) = sequence {
            payload["sequence"] = serde_json::json!(seq);
        }
        fanout.emit("workbench-run-event", &payload.to_string());
    }

    /// 心跳往返：确认服务端已注册本连接（并让 drain 完成订阅）
    async fn confirm_registered(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) {
        send_envelope_text(
            ws,
            "heartbeat",
            serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
        ).await;
        let (kind, _) = parse_frame(&next_text(ws).await.expect("必须收到 heartbeat.ok"));
        assert_eq!(kind, "heartbeat.ok");
    }

    // ── 鉴权与升级 ────────────────────────────────────────────

    #[tokio::test]
    async fn upgrade_rejects_missing_and_invalid_token() {
        let (addr, _handle, _token, _registry) = test_server(None, None).await;
        // 无令牌 → 401
        let response = reqwest::get(format!("http://{addr}/v1/events"))
            .await
            .expect("请求必须可达");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        // 错误令牌 → 401
        let response = reqwest::get(format!("http://{addr}/v1/events?token=deadbeef"))
            .await
            .expect("请求必须可达");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn upgrade_rejects_revoked_token() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        // 撤销令牌（写回 pairing.json；TokenStore 已加载，撤销经同一文件
        // 语义由 R1-07 全链保证——此处验证 401 拒绝路径）
        let path = std::env::temp_dir().join(format!("pairing-revoke-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut store = TokenStore::new(path.clone());
        let raw = store.issue("revoke-me", now_ms()).unwrap();
        let hash = sha256_hex(raw.as_bytes());
        assert!(store.revoke(&hash), "撤销必须命中");
        // 撤销令牌连接 → 拒绝（101 前 401）
        let response = reqwest::get(format!("http://{addr}/v1/events?token={raw}"))
            .await
            .expect("请求必须可达");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_file(path);
        let _ = token;
    }

    #[tokio::test]
    async fn upgrade_accepts_query_token_and_upgrades() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let url = format!("ws://{addr}/v1/events?token={token}");
        let (mut ws, response) = tokio_tungstenite::connect_async(&url).await.expect("升级必须成功");
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let _ = ws.close(None).await;
    }

    #[tokio::test]
    async fn upgrade_accepts_bearer_header() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let url = format!("ws://{addr}/v1/events");
        let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            url,
        )
        .unwrap();
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {token}").parse().unwrap(),
        );
        let (mut ws, response) = tokio_tungstenite::connect_async(request).await.expect("升级必须成功");
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let _ = ws.close(None).await;
    }

    #[tokio::test]
    async fn upgrade_rejects_cross_origin() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let url = format!("ws://{addr}/v1/events?token={token}");
        let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            url,
        )
        .unwrap();
        // 跨站 Origin（非本机 host）→ 403 拒绝
        request.headers_mut().insert(
            "Origin",
            "https://evil.example.com".parse().unwrap(),
        );
        let response = tokio_tungstenite::connect_async(request)
            .await
            .expect_err("跨站 Origin 必须被拒绝");
        assert!(
            response.to_string().contains("403") || response.to_string().contains("Forbidden"),
            "拒绝原因应含 403：{response}"
        );
    }

    // ── 订阅 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn subscribe_ok_returns_cursors() {
        let backend = Arc::new(MemoryBackend::new());
        backend.push("s-1", "agent-start", 1);
        backend.push("s-1", "run-terminal", 2);
        let (addr, _handle, token, _registry) =
            test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({
                "sessions": ["s-1", "s-2"],
                "lastSequences": { "s-1": 1 }
            }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.subscribe.ok");
        let ok: SubscribeOk = serde_json::from_value(body).unwrap();
        assert_eq!(ok.sessions.len(), 2);
        // s-1：latest=2 → nextSequence=3；落后 1 条不 stale
        let s1 = ok.sessions.iter().find(|c| c.session_id == "s-1").unwrap();
        assert_eq!(s1.next_sequence, 3);
        assert!(!s1.stale);
        // s-2：空会话 → nextSequence=0（无事件可续）
        let s2 = ok.sessions.iter().find(|c| c.session_id == "s-2").unwrap();
        assert_eq!(s2.next_sequence, 0);
        assert!(!s2.stale);
    }

    #[tokio::test]
    async fn subscribe_marks_stale_when_cursor_lags_beyond_window() {
        let backend = Arc::new(MemoryBackend::new());
        // 落后超过 EVENT_WINDOW(4096) → stale（D3 §7.5 全量回放信号）
        backend.push_range("s-1", "agent-start", 1, 4200);
        let (addr, _handle, token, _registry) =
            test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({
                "sessions": ["s-1"],
                "lastSequences": { "s-1": 0 }
            }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.subscribe.ok");
        let ok: SubscribeOk = serde_json::from_value(body).unwrap();
        let s1 = &ok.sessions[0];
        assert_eq!(s1.next_sequence, 4201);
        assert!(s1.stale, "落后超窗口必须标记 stale");
    }

    #[tokio::test]
    async fn subscribe_too_many_sessions_rejected() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        let sessions: Vec<String> = (0..33).map(|i| format!("s-{i}")).collect();
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": sessions, "lastSequences": {} }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::StreamTooManySubscriptions);
    }

    // ── 实时推送过滤 ──────────────────────────────────────────

    #[tokio::test]
    async fn push_filtered_by_subscription() {
        let fanout = test_fanout();
        let (addr, _handle, token, _registry) =
            test_server(None, Some(fanout.clone())).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
        ).await;
        let (kind, _) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.subscribe.ok");
        // 广播：s-1 命中订阅，s-2 未订阅（无全局白名单）→ 只推 s-1
        publish(&fanout, "s-1", "agent-start", Some(10));
        publish(&fanout, "s-2", "agent-start", Some(10));
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.push");
        let push: EventsPush = serde_json::from_value(body).unwrap();
        assert_eq!(push.session_id, "s-1");
        assert_eq!(push.event["type"], "agent-start");
        assert!(!push.preview);
    }

    #[tokio::test]
    async fn push_marks_preview_when_sequence_missing() {
        let fanout = test_fanout();
        let (addr, _handle, token, _registry) =
            test_server(None, Some(fanout.clone())).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
        ).await;
        let _ = next_text(&mut ws).await;
        // 实时预览帧（sequence=None，D3 §7.4：移动端不推进游标）
        publish(&fanout, "s-1", "agent-start", None);
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.push");
        let push: EventsPush = serde_json::from_value(body).unwrap();
        assert!(push.preview, "无 sequence 的实时帧必须标记 preview");
    }

    #[tokio::test]
    async fn push_filtered_by_subscribe_all_whitelist() {
        let fanout = test_fanout();
        let (addr, _handle, token, _registry) =
            test_server(None, Some(fanout.clone())).await;
        let mut ws = ws_connect(addr, &token).await;
        // 先心跳往返确认服务端已 spawn drain（fanout 订阅就绪）
        confirm_registered(&mut ws).await;
        send_envelope_text(
            &mut ws,
            "events.subscribeAll",
            serde_json::json!({ "events": ["run-terminal"] }),
        ).await;
        // subscribeAll 无专用回执：以后续 heartbeat.ok 确认服务端已处理
        //（同连接帧序保证：heartbeat 在 subscribeAll 之后到达 = 订阅已生效）
        confirm_registered(&mut ws).await;
        // 广播：run-terminal 命中白名单；agent-start 未命中（会话未订阅）
        publish(&fanout, "s-a", "run-terminal", Some(1));
        publish(&fanout, "s-a", "agent-start", Some(2));
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.push");
        let push: EventsPush = serde_json::from_value(body).unwrap();
        assert_eq!(push.event["type"], "run-terminal");
    }

    // ── 续传 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn resume_replays_pages_then_done() {
        let backend = Arc::new(MemoryBackend::new());
        backend.push_range("s-1", "message-end", 1, 250);
        let (addr, _handle, token, _registry) =
            test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
        ).await;
        let _ = next_text(&mut ws).await;
        send_envelope_text(
            &mut ws,
            "events.resume",
            serde_json::json!({ "sessionId": "s-1", "afterSequence": 0, "maxEvents": 200 }),
        ).await;
        // 第 1 页：1..=200
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.page");
        let page: ResumePage = serde_json::from_value(body).unwrap();
        assert_eq!(page.events.len(), 200);
        assert_eq!(page.events[0]["sequence"], 1);
        assert_eq!(page.next_after_sequence, 200);
        assert!(page.has_more);
        // 第 2 页：201..=250
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.page");
        let page: ResumePage = serde_json::from_value(body).unwrap();
        assert_eq!(page.events.len(), 50);
        assert_eq!(page.next_after_sequence, 250);
        assert!(!page.has_more);
        // 收口：resume.done（resumedTo = 已追平到的序列）
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.done");
        let done: ResumeDone = serde_json::from_value(body).unwrap();
        assert_eq!(done.resumed_to, 250);
    }

    #[tokio::test]
    async fn resume_continues_from_last_sequence() {
        // R1-05 验收锚点：断线续传从 lastSeq+1（D6 §4.6 开区间语义）
        let backend = Arc::new(MemoryBackend::new());
        backend.push_range("s-1", "message-end", 1, 300);
        let (addr, _handle, token, _registry) =
            test_server(Some(backend as Arc<dyn ApiBackend>), None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": { "s-1": 280 } }),
        ).await;
        let _ = next_text(&mut ws).await;
        send_envelope_text(
            &mut ws,
            "events.resume",
            serde_json::json!({ "sessionId": "s-1", "afterSequence": 280 }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.page");
        let page: ResumePage = serde_json::from_value(body).unwrap();
        assert_eq!(page.events.len(), 20);
        assert_eq!(page.events[0]["sequence"], 281, "续传必须从 lastSeq+1 开始");
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.done");
        let done: ResumeDone = serde_json::from_value(body).unwrap();
        assert_eq!(done.resumed_to, 300);
    }

    #[tokio::test]
    async fn resume_requires_subscription() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.resume",
            serde_json::json!({ "sessionId": "s-1", "afterSequence": 0 }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::StreamNotSubscribed);
    }

    #[tokio::test]
    async fn resume_invalid_payload_reports_error() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.resume",
            serde_json::json!({ "sessionId": 42, "afterSequence": "x" }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::CmdInvalid);
    }

    #[tokio::test]
    async fn realtime_during_resume_queued_after_done() {
        // R1-05 验收锚点：先重放后实时（D2 §10.3「期间实时事件先入队」）
        let backend = Arc::new(MemoryBackend::new());
        backend.push_range("s-1", "message-end", 1, 500);
        let fanout = test_fanout();
        let (addr, _handle, token, _registry) = test_server(
            Some(backend as Arc<dyn ApiBackend>),
            Some(fanout.clone()),
        )
        .await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
        ).await;
        let _ = next_text(&mut ws).await;
        // 发起 resume（25 页分页，窗口足够大）
        send_envelope_text(
            &mut ws,
            "events.resume",
            serde_json::json!({ "sessionId": "s-1", "afterSequence": 0, "maxEvents": 20 }),
        ).await;
        // 收到第 1 页 = 服务端已进入重放态 → 广播实时帧必入 pending
        let (kind, _) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.page");
        publish(&fanout, "s-1", "agent-start", None);
        // 读完剩余 24 页
        for _ in 1..25 {
            let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
            assert_eq!(kind, "events.resume.page");
            let page: ResumePage = serde_json::from_value(body).unwrap();
            assert_eq!(page.events.len(), 20);
        }
        // resume.done 之后才收到 pending 的实时帧（先重放后实时）
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.resume.done");
        let done: ResumeDone = serde_json::from_value(body).unwrap();
        assert_eq!(done.resumed_to, 500);
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "events.push", "pending 实时帧必须在 done 之后按序 flush");
        let push: EventsPush = serde_json::from_value(body).unwrap();
        assert_eq!(push.event["type"], "agent-start");
    }

    // ── 心跳 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn heartbeat_gets_ok() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "heartbeat",
            serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
        ).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.unwrap());
        assert_eq!(kind, "heartbeat.ok");
        let ok: conex_types::device::HeartbeatOk = serde_json::from_value(body).unwrap();
        assert!(ok.server_time > 0, "heartbeat.ok 必须携带桌面时钟");
    }

    #[tokio::test]
    async fn heartbeat_timeout_kicks_connection() {
        // 半开检测：90s 无客户端帧 → 踢出（D2 §10.2「3 × 心跳间隔」）
        tokio::time::pause();
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        // 模拟半开连接：建立后既不发送应用帧也不读取（客户端库只有在
        // 读循环驱动时才处理 Ping/回 Pong）→ 服务端 90s 收不到任何帧
        let url = format!("ws://{addr}/v1/events?token={token}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("升级必须成功");
        // 推进 91s（3 个心跳周期）→ 第 3 个 tick 时超时判定触发
        tokio::time::advance(Duration::from_secs(91)).await;
        tokio::task::yield_now().await;
        let frame = next_text(&mut ws).await.expect("应收到踢出帧");
        let (kind, body) = parse_frame(&frame);
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert!(
            error.message.contains(KICK_TIMEOUT),
            "踢出原因必须携带 heartbeat-timeout：{}",
            error.message
        );
    }

    #[tokio::test]
    async fn ping_pong_keeps_alive_during_silence() {
        // 客户端自动回 Pong → 90s 静默（仅 Ping/Pong）不被踢。
        // 读循环必须在虚拟时间推进期间持续驱动：Ping 到达时库自动回
        // Pong（写入内部缓冲），需周期 flush 才真正发出
        tokio::time::pause();
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
        )
        .await;
        let _ = next_text(&mut ws).await;
        // 单一任务独占 socket：读（转发 Text 帧）+ 心跳发送命令 + 周期
        // flush（驱动自动 Pong 写出）
        let (frame_tx, mut frame_rx) = mpsc::channel::<String>(16);
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<()>(4);
        let reader_task = tokio::spawn(async move {
            let mut flush_timer = tokio::time::interval(Duration::from_millis(5));
            loop {
                tokio::select! {
                    frame = ws.next() => match frame {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                            if frame_tx.send(text.to_string()).await.is_err() {
                                break;
                            }
                        }
                        // 控制帧（Ping/Pong）：库已自动处理（Ping 自动回
                        // Pong），应用层忽略继续读
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_)))
                        | Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_))) => {}
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
                        | Some(Err(_))
                        | None => break,
                        Some(Ok(_)) => {}
                    },
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            // 心跳命令
                            Some(()) => {
                                let envelope = DeviceEnvelope::unsigned(
                                    MessageKind::Heartbeat,
                                    format!("m-test-{:08}", MSG_COUNTER.fetch_add(1, Ordering::Relaxed)),
                                    now_ms(),
                                    DeviceEndpoint::Mobile,
                                    DeviceEndpoint::Desktop,
                                    serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
                                );
                                if ws
                                    .send(tokio_tungstenite::tungstenite::Message::Text(
                                        serde_json::to_string(&envelope).unwrap().into(),
                                    ))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            // 发送端 drop → 主动关闭并退出
                            None => {
                                let _ = ws.close(None).await;
                                break;
                            }
                        }
                    }
                    _ = flush_timer.tick() => {
                        let _ = ws.flush().await;
                    }
                }
            }
        });
        // 分步推进 100s（每步让 Ping/Pong 往返与 touch 完成；链路涉及
        // 服务端心跳 task → 客户端读循环 → 自动 Pong flush → 服务端
        // 主循环 touch 多任务协作，单次 yield 不足，多轮让行）
        for step in 0..5 {
            tokio::time::advance(Duration::from_secs(20)).await;
            for _ in 0..40 {
                tokio::task::yield_now().await;
            }
            let _ = step;
        }
        // 连接仍存活：发 heartbeat → 应收到 heartbeat.ok
        let _ = cmd_tx.send(()).await;
        let frame = loop {
            match frame_rx.try_recv() {
                Ok(frame) => break frame,
                Err(_) => {
                    // 虚拟时间推进轮询（paused 下 timeout 不适用）
                    tokio::time::advance(Duration::from_millis(50)).await;
                    for _ in 0..40 {
                        tokio::task::yield_now().await;
                    }
                }
            }
        };
        let (kind, body) = parse_frame(&frame);
        assert_eq!(kind, "heartbeat.ok", "Ping/Pong 保活下 100s 后连接必须存活");
        let ok: conex_types::device::HeartbeatOk = serde_json::from_value(body).unwrap();
        assert!(ok.server_time > 0);
        drop(cmd_tx);
        let _ = reader_task.await;
    }

    // ── 连接管理 ──────────────────────────────────────────────

    #[tokio::test]
    async fn duplicate_connection_kicks_old() {
        // P0-3 裁决：每设备一主连接，同令牌重复连接踢旧
        // （D2 §10.5：kicked duplicate-connection）
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut old = ws_connect(addr, &token).await;
        // 确认旧连接已注册（避免升级回调未完成即建新连接的竞态）
        confirm_registered(&mut old).await;
        let mut new = ws_connect(addr, &token).await;
        // 旧连接收到 kicked（duplicate-connection）并关闭
        let (kind, body) = parse_frame(&next_text(&mut old).await.expect("旧连接必须被踢"));
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert!(
            error.message.contains(KICK_DUPLICATE),
            "踢出原因必须携带 duplicate-connection：{}",
            error.message
        );
        // 新连接正常可用（心跳往返）
        confirm_registered(&mut new).await;
    }

    #[tokio::test]
    async fn connection_limit_rejects_ninth() {
        // D2 §10.5：全局上限 MAX_WS_CONNECTIONS=8，超限拒绝新连接
        // （conn.limit 错误帧 + 关闭）
        let labels: Vec<String> = (0..9).map(|i| format!("dev-{i}")).collect();
        let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let (addr, _handle, tokens, _registry) =
            spawn_server_with_tokens(None, None, &label_refs).await;
        // 占满 8 个连接（逐个确认注册完成）
        let mut sockets = Vec::new();
        for token in &tokens[..8] {
            let mut ws = ws_connect(addr, token).await;
            confirm_registered(&mut ws).await;
            sockets.push(ws);
        }
        // 第 9 个连接 → 拒绝（error conn.limit + 关闭）
        let mut ninth = ws_connect(addr, &tokens[8]).await;
        let (kind, body) = parse_frame(&next_text(&mut ninth).await.expect("应收到 conn.limit 拒绝帧"));
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert!(
            error.message.contains(KICK_LIMIT),
            "拒绝原因必须携带 conn.limit：{}",
            error.message
        );
        // 旧连接不受影响
        confirm_registered(&mut sockets[0]).await;
    }

    #[tokio::test]
    async fn kick_by_token_hash_revokes_connection() {
        // D2 §10.6：令牌撤销 → kicked token-revoked（R1-07 撤销全链接线点）
        let (addr, _handle, token, registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        confirm_registered(&mut ws).await;
        let hash = sha256_hex(token.as_bytes());
        let kicked = registry.kick_by_token_hash(&hash, KICK_REVOKED);
        assert_eq!(kicked.len(), 1, "撤销必须命中在线连接");
        let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到 token-revoked 踢出帧"));
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::AuthDeviceRevoked);
        assert!(
            error.message.contains(KICK_REVOKED),
            "踢出原因必须携带 token-revoked：{}",
            error.message
        );
    }

    #[tokio::test]
    async fn disconnect_unregisters_subscription() {
        // 断线清理：连接关闭 → 注册表注销 + fanout 订阅注销
        let fanout = test_fanout();
        let (addr, _handle, token, registry) =
            test_server(None, Some(fanout.clone())).await;
        let mut ws = ws_connect(addr, &token).await;
        confirm_registered(&mut ws).await;
        send_envelope_text(
            &mut ws,
            "events.subscribe",
            serde_json::json!({ "sessions": ["s-1"], "lastSequences": {} }),
        ).await;
        let _ = next_text(&mut ws).await;
        assert_eq!(registry.count(), 1, "连接必须已注册");
        assert_eq!(fanout.subscriber_count(), 1, "fanout 订阅必须已注册");
        // 客户端主动关闭
        let _ = ws.close(None).await;
        // 等服务端注销（sender task 收尾）
        for _ in 0..50 {
            if registry.count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(registry.count(), 0, "关闭后连接必须注销");
        assert_eq!(fanout.subscriber_count(), 0, "关闭后 fanout 订阅必须注销");
    }

    // ── 帧协议 ────────────────────────────────────────────────

    #[tokio::test]
    async fn frame_too_large_closes_connection() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        // 超 1 MiB 帧（M6 §8.1：MAX_FRAME_BYTES 超限断链防内存放大）
        let big = "x".repeat(MAX_FRAME_BYTES + 1);
        let _ = ws.send(tokio_tungstenite::tungstenite::Message::Text(big.into())).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到 frame_too_large 帧"));
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::FrameTooLarge);
    }

    #[tokio::test]
    async fn unknown_kind_is_tolerated() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        // 未知 kind（D3 §10.3：丢弃 + 记日志，不报错）→ 连接保持
        send_envelope_text(&mut ws, "future.kind", serde_json::json!({})).await;
        confirm_registered(&mut ws).await;
    }

    #[tokio::test]
    async fn version_mismatch_closes_connection() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        let envelope = DeviceEnvelope::unsigned(
            MessageKind::Heartbeat,
            format!("m-test-{:08}", 99),
            now_ms(),
            DeviceEndpoint::Mobile,
            DeviceEndpoint::Desktop,
            serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
        );
        // 手工改版本号
        let mut value = serde_json::to_value(&envelope).unwrap();
        value["v"] = serde_json::json!(99);
        let _ = ws.send(tokio_tungstenite::tungstenite::Message::Text(
            value.to_string().into(),
        )).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到 version_mismatch"));
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::VersionMismatch);
    }

    #[tokio::test]
    async fn malformed_frame_reports_error_and_keeps_connection() {
        let (addr, _handle, token, _registry) = test_server(None, None).await;
        let mut ws = ws_connect(addr, &token).await;
        // 非 JSON 帧 → 错误帧提示 + 保持连接（防御性宽容）
        let _ = ws.send(tokio_tungstenite::tungstenite::Message::Text("not-json".into())).await;
        let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("应收到解析错误帧"));
        assert_eq!(kind, "error");
        let error: ErrorBody = serde_json::from_value(body).unwrap();
        assert_eq!(error.code, DeviceErrorCode::CmdInvalid);
        // 连接仍可用
        confirm_registered(&mut ws).await;
    }

    // ── 注册表单元语义 ────────────────────────────────────────

    #[test]
    fn registry_registers_unregisters_and_counts() {
        let registry = WsRegistry::new();
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let conn_id = match registry.register("hash-a", "device-a", kill_tx, 1000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        assert_eq!(registry.count(), 1);
        assert_eq!(registry.label_of(conn_id).as_deref(), Some("device-a"));
        assert_eq!(registry.connected_at(conn_id), Some(1000));
        registry.unregister(conn_id);
        assert_eq!(registry.count(), 0);
        registry.unregister(conn_id); // 幂等
        assert_eq!(registry.count(), 0);
    }

    #[tokio::test]
    async fn registry_duplicate_token_kicks_old() {
        let registry = WsRegistry::new();
        let (kill_tx, mut kill_rx) = watch::channel::<Option<String>>(None);
        let old_id = match registry.register("hash-x", "old", kill_tx, 1000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        let (kill_tx2, _) = watch::channel::<Option<String>>(None);
        let new_id = match registry.register("hash-x", "new", kill_tx2, 2000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        assert_ne!(old_id, new_id);
        assert_eq!(registry.count(), 1, "同令牌只保留最新连接");
        // 旧连接收到踢出信号
        let _ = tokio::time::timeout(Duration::from_secs(1), kill_rx.changed())
            .await
            .expect("旧连接必须收到踢出信号");
        assert_eq!(kill_rx.borrow().as_deref(), Some(KICK_DUPLICATE));
    }

    // ── R1-10 T-02：同令牌多端并发（窃听重放）──

    /// T-02 窃听重放令牌 → 同令牌多端并发。按现有实现语义（P0-3 裁决
    /// 「每设备一主连接」）断言：第二连接被接受、旧连接被踢出（携带
    /// duplicate-connection 告警信号）、注册表恒 1 条、令牌槽迁移到新
    /// 连接（撤销全链命中新连接）；新连接注销后令牌槽释放可再注册。
    #[tokio::test]
    async fn t02_same_token_concurrent_second_connection_evicts_first() {
        let registry = WsRegistry::new();
        // 第一连接（合法设备）
        let (kill_tx_old, mut kill_rx_old) = watch::channel::<Option<String>>(None);
        let old_id = match registry.register("hash-t02", "dev-a", kill_tx_old, 1000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("第一连接注册必须成功"),
        };
        // 第二连接（同一令牌——窃听重放 / 双端并发）
        let (kill_tx_new, _) = watch::channel::<Option<String>>(None);
        let new_id = match registry.register("hash-t02", "dev-b", kill_tx_new, 2000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("第二连接注册必须成功"),
        };
        assert_ne!(old_id, new_id, "第二连接分配新 id");
        // 每令牌并发语义：注册表恒 1 条（旧连接被踢出）
        assert_eq!(registry.count(), 1, "同令牌只保留最新连接");
        // 告警信号：旧连接收到 duplicate-connection 踢出原因
        let _ = tokio::time::timeout(Duration::from_secs(1), kill_rx_old.changed())
            .await
            .expect("旧连接必须收到踢出信号");
        assert_eq!(
            kill_rx_old.borrow().as_deref(),
            Some(KICK_DUPLICATE),
            "踢出原因必须携带 duplicate-connection（告警信号）"
        );
        // 令牌槽已迁移：撤销全链（kick_by_token_hash）命中新连接而非旧连接
        let kicked = registry.kick_by_token_hash("hash-t02", "token-revoked");
        assert_eq!(kicked, vec![new_id], "撤销必须命中当前活跃连接（新连接）");
        // 新连接注销后令牌槽释放：第三次注册可成功
        registry.unregister(new_id);
        let (kill_tx3, _) = watch::channel::<Option<String>>(None);
        match registry.register("hash-t02", "dev-c", kill_tx3, 3000) {
            RegisterOutcome::Registered(id) => assert_ne!(id, old_id, "第三次注册分配新 id"),
            _ => panic!("注销后同令牌应可重新注册"),
        }
        assert_eq!(registry.count(), 1, "并发连接数恒为 1");
    }

    #[test]
    fn registry_limit_exceeded_rejects() {
        let registry = WsRegistry::new();
        for i in 0..MAX_WS_CONNECTIONS {
            let (kill_tx, _) = watch::channel::<Option<String>>(None);
            let outcome = registry.register(&format!("hash-{i}"), &format!("dev-{i}"), kill_tx, i as u64);
            assert!(matches!(outcome, RegisterOutcome::Registered(_)));
        }
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let outcome = registry.register("hash-over", "dev-over", kill_tx, 999);
        assert_eq!(outcome, RegisterOutcome::LimitExceeded);
    }

    #[test]
    fn registry_replay_pending_respects_capacity() {
        let registry = WsRegistry::new();
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let conn_id = match registry.register("hash-r", "dev-r", kill_tx, 1000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        registry.set_subscriptions(conn_id, vec!["s-1".to_string()]);
        registry.begin_replay(conn_id, "s-1");
        // 填满 pending（Delta 帧）
        for i in 0..RESUME_PENDING_CAPACITY {
            registry.push_pending(
                conn_id,
                "s-1",
                format!("payload-{i}"),
                BackpressureLevel::Delta,
            );
        }
        // 再入 Delta → 超限被丢
        registry.push_pending(conn_id, "s-1", "delta-overflow".to_string(), BackpressureLevel::Delta);
        // 再入 Critical → 挤掉队头，必达
        registry.push_pending(conn_id, "s-1", "critical-arrived".to_string(), BackpressureLevel::Critical);
        let pending = registry.end_replay(conn_id, "s-1");
        assert_eq!(pending.len(), RESUME_PENDING_CAPACITY);
        assert!(
            !pending.iter().any(|(_, payload)| payload == "delta-overflow"),
            "Delta 超限必须被丢"
        );
        assert!(
            pending.iter().any(|(_, payload)| payload == "critical-arrived"),
            "Critical 必须保留"
        );
        assert!(!registry.is_replaying(conn_id, "s-1"), "end_replay 后退出重放态");
    }

    #[test]
    fn registry_filter_parts_reflects_subscriptions() {
        let registry = WsRegistry::new();
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let conn_id = match registry.register("hash-m", "dev-m", kill_tx, 1000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        // 空订阅 → 空过滤器
        let (sessions, global) = registry.filter_parts(conn_id);
        assert!(sessions.is_empty() && global.is_empty());
        // 会话订阅 + 全局白名单 → 双元组反映
        registry.set_subscriptions(conn_id, vec!["s-2".to_string(), "s-1".to_string()]);
        registry.set_subscribe_all(conn_id, vec!["security-audit".to_string()]);
        let (sessions, global) = registry.filter_parts(conn_id);
        assert_eq!(sessions, vec!["s-1".to_string(), "s-2".to_string()], "会话应排序稳定");
        assert_eq!(global, vec!["security-audit".to_string()]);
        // 注销后 → 空
        registry.unregister(conn_id);
        let (sessions, global) = registry.filter_parts(conn_id);
        assert!(sessions.is_empty() && global.is_empty());
    }

    #[test]
    fn registry_snapshot_shape_and_content() {
        let registry = WsRegistry::new();
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let conn_id = match registry.register("hash-s", "device-s", kill_tx, 1000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        registry.set_subscriptions(conn_id, vec!["s-1".to_string(), "s-2".to_string()]);
        let snapshot = registry.snapshot();
        assert_eq!(snapshot.len(), 1);
        let entry = &snapshot[0];
        assert_eq!(entry.conn_id, conn_id);
        assert_eq!(entry.label, "device-s");
        assert_eq!(entry.connected_at_ms, 1000);
        assert_eq!(entry.subscribed_count, 2);
        registry.unregister(conn_id);
        assert!(registry.snapshot().is_empty(), "注销后快照应清空");
    }

    #[test]
    fn classify_payload_levels_and_fields() {
        // Delta：message-delta（完整信封：sessionId/timestamp/messageId/block）
        let delta = r#"{"type":"message-delta","sessionId":"s-1","timestamp":"t","messageId":"m1","block":{"type":"text","text":"hi"},"schemaVersion":1}"#;
        let (sid, ty, level) = classify_payload(delta);
        assert_eq!(sid.as_deref(), Some("s-1"));
        assert_eq!(ty.as_deref(), Some("message-delta"));
        assert_eq!(level, BackpressureLevel::Delta);
        // Critical：run-terminal
        let terminal = r#"{"type":"run-terminal","sessionId":"s-1","sequence":9,"schemaVersion":1,"runId":"r-1","terminal":"completed","timestamp":"t"}"#;
        let (sid, ty, level) = classify_payload(terminal);
        assert_eq!(sid.as_deref(), Some("s-1"));
        assert_eq!(ty.as_deref(), Some("run-terminal"));
        assert_eq!(level, BackpressureLevel::Critical);
        // 解析失败 → 保守 Critical
        let (sid, ty, level) = classify_payload("not-json");
        assert_eq!(sid, None);
        assert_eq!(ty, None);
        assert_eq!(level, BackpressureLevel::Critical);
    }

    #[test]
    fn origin_allowed_rules() {
        use axum::http::HeaderValue;
        let mut headers = HeaderMap::new();
        // 无 Origin（原生客户端）→ 放行
        assert!(origin_allowed(&headers));
        // 本机 host → 放行
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://localhost:1420"));
        assert!(origin_allowed(&headers));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://127.0.0.1:8765"));
        assert!(origin_allowed(&headers));
        // 跨站 → 拒绝
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://evil.example.com"));
        assert!(!origin_allowed(&headers));
    }
}
