//! 事件扇出（R1-01：FanOutEmitter + WsBroadcast，多端互通跨端侧）
//!
//! 数据流（D2 §4.2 架构图 + §11-A 融合点 A）：
//!
//! ```text
//! 引擎任意发射 → EventBridge::emit_payload（core_event_bridge.rs 汇聚点）
//!   ├─ TauriEmitter（webview 通道，不变）
//!   └─ FanOutEmitter::emit（本模块，实现既有 Emitter trait）
//!        ├─ 同步发射器列表（可空；任一失败不影响其余）
//!        └─ WsBroadcast::publish（跨端广播器）
//!             ├─ 订阅过滤（会话级订阅集合 / 全局类型白名单）
//!             ├─ 丢帧分级（Critical 必达 / Soft 尽力 / Delta 高负载丢）
//!             └─ 每连接缓冲队列 → FanoutReceiver（R1-05 WS drain task 消费）
//! ```
//!
//! 设计对齐（D2 §10.4 / M6 §5 / AU2 F-6 裁决 / Z0 §9.3 R1-01）：
//! - FanOutEmitter 实现 `core_event_bridge::Emitter`，经
//!   `EventBridge::attach_fanout` 挂在 emit_payload 汇聚点——可选订阅者，
//!   服务未启动（未挂接）时零开销；桥与引擎零改动（全事件流自动双通道）；
//! - WS 侧按订阅过滤、不区分 channel（F-6 裁决：channel 恒
//!   workbench-run-event，跨端订阅语义由 [SubscriptionFilter] 决定）；
//! - 端级背压复用既有丢帧哲学（buffer.rs 先例）：队列满时丢 Delta/Soft
//!   保 Critical，Critical 无 Soft/Delta 可驱逐时超限接受（必达语义）；
//! - 广播通道发全量事件，过滤在订阅侧（每连接仅收订阅集合的帧，
//!   节省局域网带宽由订阅集合保证，D2 §10.4）。
//!
//! 本文件仅依赖 conex-types / serde_json / tokio（Notify）+ 既有 Emitter
//! trait，可在无 Tauri runtime 下编译与单测（server 模块纪律，D2 §4.3）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use conex_types::events::{event_backpressure, AgentEvent, BackpressureLevel};
use tokio::sync::Notify;

use crate::core_event_bridge::Emitter;

/// 每连接缓冲队列容量（D2 §10.4：连接级缓冲 512；满则按分级丢帧）
// R1-01 备注：R1-05 WS drain task 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub const CONN_QUEUE_CAPACITY: usize = 512;

/// 订阅过滤器（D3 §7.3 / M6 §5：会话级订阅 + 全局轻订阅）
///
/// - 会话级（events.subscribe）：订阅指定会话集合，命中会话的全部事件；
/// - 全局级（events.subscribeAll）：订阅事件类型白名单（security-audit、
///   timer/cron 数据面、session.updated 等），与会话归属无关；
/// - 两个集合均为空 = 未订阅任何事件（fail-closed：恒不命中）。
// R1-01 备注：R1-05 WS 订阅消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubscriptionFilter {
    /// 会话级订阅集合（events.subscribe）
    sessions: HashSet<String>,
    /// 全局订阅类型白名单（events.subscribeAll）
    global_types: HashSet<String>,
}

// R1-01 备注：R1-05 WS 订阅消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
impl SubscriptionFilter {
    /// 构造订阅过滤器（会话集合 + 全局类型白名单）
    pub fn new(
        sessions: impl IntoIterator<Item = String>,
        global_types: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            sessions: sessions.into_iter().collect(),
            global_types: global_types.into_iter().collect(),
        }
    }

    /// 会话级订阅（只收指定会话的事件）
    pub fn session_subscribe(sessions: impl IntoIterator<Item = String>) -> Self {
        Self::new(sessions, [])
    }

    /// 全局订阅（只收白名单类型的事件，与会话归属无关）
    pub fn global_subscribe(global_types: impl IntoIterator<Item = String>) -> Self {
        Self::new([], global_types)
    }

    /// 是否命中某条事件（事件类型 + 事件归属会话）
    ///
    /// 命中 = 类型在全局白名单，或事件归属会话在订阅集合内（会话订阅
    /// 收该会话全部事件；无会话归属的事件只能经全局白名单命中）。
    pub fn matches(&self, event_type: &str, session_id: Option<&str>) -> bool {
        self.global_types.contains(event_type)
            || session_id.is_some_and(|session| self.sessions.contains(session))
    }

    /// 是否为空（空 = 未订阅任何事件，恒不命中）
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty() && self.global_types.is_empty()
    }
}

/// 订阅注册错误
// R1-01 备注：R1-05 WS 订阅消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FanoutError {
    /// 连接 id 已注册（连接注册表键冲突：同 id 重复订阅）
    AlreadyRegistered,
}

/// 一条排队事件（过滤 + 分级后的投递单元；R1-05 WS drain task 消费）
// R1-01 备注：R1-05 WS drain task 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct QueuedEvent {
    /// 已序列化的完整事件信封 JSON（引擎层已序列化，此处零二次序列化）
    pub payload: String,
    /// 事件类型（wire 名，如 message-delta）
    pub event_type: String,
    /// 事件归属会话（无会话归属 = None，如定时器域事件）
    pub session_id: Option<String>,
    /// 事件序列号（信封注入；实时预览帧 None）
    pub sequence: Option<u64>,
    /// 背压级别（Delta 可丢 / Soft 尽力 / Critical 必达）
    pub level: BackpressureLevel,
}

/// 跨端广播器（D2 §10.4：订阅注册表 + 每连接缓冲队列）
///
/// 职责：持有连接注册表（连接 id → 订阅条目），接收 FanOutEmitter 的
/// 全量事件流，按订阅过滤 + 丢帧分级后入各连接缓冲队列，消费端经
/// [FanoutReceiver] 取走（R1-05 的 WS drain task）。本文件实现广播
/// 接口与缓冲队列；WS 具体推送（axum 升级 / 文本帧发送）留 R1-05。
// R1-01 备注：经 FanOutEmitter 装配后由 R1-05 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub struct WsBroadcast {
    /// 连接注册表（conn_id → 订阅条目）
    subscribers: Mutex<HashMap<String, Arc<SubscriberEntry>>>,
    /// 每连接缓冲容量（满则按分级丢帧）
    capacity: usize,
    /// 全局累计丢帧数（S-8 丢帧可观测）
    dropped_total: AtomicU64,
}

/// 单个订阅条目（连接级缓冲队列 + 消费唤醒）
// R1-01 备注：R1-05 WS drain task 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
struct SubscriberEntry {
    /// 连接 id（注册表键）
    conn_id: String,
    /// 订阅过滤器（会话级 / 全局）
    filter: SubscriptionFilter,
    /// 缓冲容量（构造时从广播器拷贝）
    capacity: usize,
    /// 缓冲队列（满则丢 Delta/Soft 保 Critical）
    queue: Mutex<VecDeque<QueuedEvent>>,
    /// 消费唤醒（R1-05 drain task 等待新事件）
    notify: Notify,
    /// 本连接累计丢帧数（端级背压可观测）
    dropped: AtomicU64,
}

// R1-01 备注：经 FanOutEmitter 装配后由 R1-05 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
impl WsBroadcast {
    /// 新建广播器（默认连接缓冲容量 [CONN_QUEUE_CAPACITY]）
    pub fn new() -> Self {
        Self::with_capacity(CONN_QUEUE_CAPACITY)
    }

    /// 指定连接缓冲容量（测试用小容量验证丢帧分级）
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            subscribers: Mutex::new(HashMap::new()),
            capacity: capacity.max(1),
            dropped_total: AtomicU64::new(0),
        }
    }

    /// 注册订阅者（连接 id 唯一；重复注册返回
    /// [FanoutError::AlreadyRegistered]）
    pub fn register(
        &self,
        conn_id: impl Into<String>,
        filter: SubscriptionFilter,
    ) -> Result<FanoutReceiver, FanoutError> {
        let conn_id = conn_id.into();
        let entry = Arc::new(SubscriberEntry {
            conn_id: conn_id.clone(),
            filter,
            capacity: self.capacity,
            queue: Mutex::new(VecDeque::with_capacity(self.capacity)),
            notify: Notify::new(),
            dropped: AtomicU64::new(0),
        });
        let mut subscribers = match self.subscribers.lock() {
            Ok(map) => map,
            // 注册表锁损坏属进程级异常，按键冲突拒绝（防并发重复注册）
            Err(_) => return Err(FanoutError::AlreadyRegistered),
        };
        if subscribers.contains_key(&conn_id) {
            return Err(FanoutError::AlreadyRegistered);
        }
        subscribers.insert(conn_id, Arc::clone(&entry));
        Ok(FanoutReceiver { entry })
    }

    /// 注销订阅者（连接关闭即移除；残留队列可继续读尽，不再收新事件）
    pub fn unregister(&self, conn_id: &str) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.remove(conn_id);
        }
    }

    /// 当前订阅者数量
    pub fn subscriber_count(&self) -> usize {
        self.subscribers
            .lock()
            .map(|map| map.len())
            .unwrap_or(0)
    }

    /// 全局累计丢帧数（丢帧可观测，S-8 哲学）
    pub fn dropped_total(&self) -> u64 {
        self.dropped_total.load(Ordering::Relaxed)
    }

    /// 分发一条事件（FanOutEmitter::emit 调用；无订阅者时零开销）
    ///
    /// 流程：解析事件元信息（类型 / 会话 / 背压级别；解析失败按
    /// fail-closed 跳过）→ 逐订阅者过滤 → 分级入队（满则丢帧）。
    pub(crate) fn publish(&self, payload: &str) {
        let subscribers = match self.subscribers.lock() {
            Ok(map) => map,
            Err(_) => return,
        };
        // 无订阅者直接返回：广播空转零开销（D2 §10.7）
        if subscribers.is_empty() {
            return;
        }
        let meta = match parse_event_meta(payload) {
            Ok(meta) => meta,
            Err(error) => {
                // fail-closed：无法解析的事件不下发（宁可少数据，不越界）
                tracing::warn!(
                    target: "fanout",
                    error = %error,
                    "事件元信息解析失败，跳过扇出（fail-closed）"
                );
                return;
            }
        };
        let mut dropped = 0u64;
        for entry in subscribers.values() {
            if !entry.filter.matches(&meta.event_type, meta.session_id.as_deref()) {
                continue;
            }
            dropped += enqueue(entry, &meta, payload);
        }
        if dropped > 0 {
            self.dropped_total.fetch_add(dropped, Ordering::Relaxed);
        }
    }
}

/// 事件元信息（publish 时从 payload 解析一次，全订阅者复用）
// R1-01 备注：R1-05 装配消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
struct EventMeta {
    /// 事件类型（wire 名）
    event_type: String,
    /// 事件归属会话（无会话归属 = None）
    session_id: Option<String>,
    /// 事件序列号（信封注入；预览帧 None）
    sequence: Option<u64>,
    /// 背压级别（Delta/Soft/Critical）
    level: BackpressureLevel,
}

/// 解析事件元信息（信封扁平 JSON → 类型 / 会话 / 序列号 / 背压级别）
///
/// 复用 [AgentEventEnvelope::deserialize] 同款先例（events.rs:976）：
/// 从含 runId/sequence/schemaVersion 的顶层 JSON 直接反序列化事件体，
/// 未知顶层键被 serde 忽略。
// R1-01 备注：R1-05 装配消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
fn parse_event_meta(payload: &str) -> Result<EventMeta, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(payload)?;
    let event: AgentEvent = serde_json::from_value(value.clone())?;
    Ok(EventMeta {
        event_type: event.type_name().to_string(),
        session_id: value
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        sequence: value.get("sequence").and_then(serde_json::Value::as_u64),
        level: event_backpressure(&event),
    })
}

/// 入队 + 端级背压（对齐 buffer.rs 丢帧哲学：Critical 必达、Soft 可丢、
/// Delta 高负载丢）。返回本次造成的丢弃数（0 或 1）。
///
/// 队列满时的处置：
/// - 新 Critical：驱逐最旧可丢帧（优先 Soft 旧帧、其次 Delta 旧帧）
///   腾位，被驱逐的旧帧计入丢帧；无可腾位帧时超限接受（必达语义，
///   防御性，buffer.rs 同款，不丢帧）；
/// - 新 Soft / 新 Delta：驱逐最旧可丢帧腾位（旧帧计丢）；无可腾位帧时
///   本帧丢弃（本帧计丢）——丢旧保新，与拒收新帧同等计入丢帧数。
// R1-01 备注：R1-05 装配消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
fn enqueue(entry: &SubscriberEntry, meta: &EventMeta, payload: &str) -> u64 {
    let mut queue = match entry.queue.lock() {
        Ok(queue) => queue,
        Err(_) => return 0,
    };
    let mut dropped = 0u64;
    if queue.len() >= entry.capacity {
        let evicted = evict_oldest_droppable(&mut queue);
        match meta.level {
            // 必达：无可腾位帧时超限接受（Critical 永不丢）
            BackpressureLevel::Critical => {
                if evicted {
                    // 被驱逐的旧可丢帧计入丢帧
                    dropped = 1;
                }
            }
            // 可丢：驱逐旧帧腾位（旧帧计丢）；无可腾位帧时本帧丢弃
            BackpressureLevel::Delta | BackpressureLevel::Soft => {
                dropped = 1;
                if !evicted {
                    entry.dropped.fetch_add(dropped, Ordering::Relaxed);
                    return dropped;
                }
            }
        }
    }
    queue.push_back(QueuedEvent {
        payload: payload.to_string(),
        event_type: meta.event_type.clone(),
        session_id: meta.session_id.clone(),
        sequence: meta.sequence,
        level: meta.level,
    });
    if dropped > 0 {
        entry.dropped.fetch_add(dropped, Ordering::Relaxed);
    }
    drop(queue);
    // 唤醒消费端（R1-05 drain task；notify permit 粘滞，无丢失唤醒）
    entry.notify.notify_one();
    dropped
}

/// 驱逐队列中最旧的可丢帧（优先 Soft 旧帧、其次 Delta 旧帧）——
/// 返回是否驱逐
// R1-01 备注：R1-05 装配消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
fn evict_oldest_droppable(queue: &mut VecDeque<QueuedEvent>) -> bool {
    if let Some(index) = queue
        .iter()
        .position(|event| event.level == BackpressureLevel::Soft)
    {
        queue.remove(index);
        return true;
    }
    if let Some(index) = queue
        .iter()
        .position(|event| event.level == BackpressureLevel::Delta)
    {
        queue.remove(index);
        return true;
    }
    false
}

/// 事件扇出发射器（R1-01：实现既有 [Emitter] trait，挂 EventBridge 汇聚点）
///
/// emit 流程（同步，对齐 Emitter 契约，D2 §11-A）：
/// 1. 遍历同步发射器列表（TauriEmitter 等 webview 通道）——任一发射器
///    失败不影响其余（catch_unwind 隔离 panic）；
/// 2. WsBroadcast::publish 跨端广播（订阅过滤 + 分级 + 缓冲）。
// R1-01 备注：装配点（main.rs）构造挂接——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub struct FanOutEmitter {
    /// 同步发射器列表（webview 通道等；可空 = 纯跨端扇出）
    emitters: Vec<Arc<dyn Emitter>>,
    /// 跨端广播器（订阅注册表 + 缓冲队列）
    broadcast: Arc<WsBroadcast>,
}

// R1-01 备注：装配点（main.rs）构造挂接——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
impl FanOutEmitter {
    /// 新建扇出发射器（默认连接缓冲容量 [CONN_QUEUE_CAPACITY]）
    pub fn new(emitters: Vec<Arc<dyn Emitter>>) -> Self {
        Self::with_capacity(emitters, CONN_QUEUE_CAPACITY)
    }

    /// 指定连接缓冲容量（测试用小容量验证丢帧分级）
    pub fn with_capacity(emitters: Vec<Arc<dyn Emitter>>, capacity: usize) -> Self {
        Self {
            emitters,
            broadcast: Arc::new(WsBroadcast::with_capacity(capacity)),
        }
    }

    /// 注册订阅者（R1-05 WS 连接建立时调用；连接 id 唯一）
    pub fn subscribe(
        &self,
        conn_id: impl Into<String>,
        filter: SubscriptionFilter,
    ) -> Result<FanoutReceiver, FanoutError> {
        self.broadcast.register(conn_id, filter)
    }

    /// 注销订阅者（连接关闭时调用；不再接收新事件）
    pub fn unsubscribe(&self, conn_id: &str) {
        self.broadcast.unregister(conn_id);
    }

    /// 当前订阅者数量
    pub fn subscriber_count(&self) -> usize {
        self.broadcast.subscriber_count()
    }

    /// 跨端广播累计丢帧数（丢帧可观测）
    pub fn dropped_total(&self) -> u64 {
        self.broadcast.dropped_total()
    }
}

impl Emitter for FanOutEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        for emitter in &self.emitters {
            emit_safe(emitter, channel, payload);
        }
        self.broadcast.publish(payload);
    }
}

/// 同步发射器调用隔离：panic 不扩散（单发射器失败不影响其余，D2 §11-A）
// R1-01 备注：R1-05 装配消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
fn emit_safe(emitter: &Arc<dyn Emitter>, channel: &str, payload: &str) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        emitter.emit(channel, payload);
    }));
    if result.is_err() {
        tracing::warn!(
            target: "fanout",
            "内部发射器 panic，已隔离（不影响其余发射器与跨端广播）"
        );
    }
}

/// 订阅接收端（每连接一个；R1-05 WS drain task 消费缓冲队列推送）
// R1-01 备注：R1-05 WS drain task 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone)]
pub struct FanoutReceiver {
    /// 订阅条目（与注册表共享；unregister 后仍可读残留队列）
    entry: Arc<SubscriberEntry>,
}

// R1-01 备注：R1-05 WS drain task 消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
impl FanoutReceiver {
    /// 非阻塞取一条排队事件（队列空返回 None）
    pub fn try_recv(&self) -> Option<QueuedEvent> {
        self.entry.queue.lock().ok()?.pop_front()
    }

    /// 等待并取一条排队事件（drain task 挂起语义；unregister 后残留
    /// 队列读尽则持续等待——R1-05 连接关闭由 drain task 终止信号收口）
    pub async fn recv(&self) -> Option<QueuedEvent> {
        loop {
            if let Some(event) = self.try_recv() {
                return Some(event);
            }
            self.entry.notify.notified().await;
        }
    }

    /// 缓冲中待发条数
    pub fn pending(&self) -> usize {
        self.entry
            .queue
            .lock()
            .map(|queue| queue.len())
            .unwrap_or(0)
    }

    /// 本连接累计丢帧数（端级背压可观测）
    pub fn dropped(&self) -> u64 {
        self.entry.dropped.load(Ordering::Relaxed)
    }

    /// 订阅的连接 id
    pub fn conn_id(&self) -> &str {
        &self.entry.conn_id
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use conex_types::events::AgentEventEnvelope;

    use super::*;

    /// 测试发射器：记录 (channel, payload) 序列（不依赖 Tauri runtime）
    #[derive(Default)]
    struct RecordingEmitter {
        calls: StdMutex<Vec<(String, String)>>,
    }

    impl RecordingEmitter {
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap()
                .push((channel.to_string(), payload.to_string()));
        }
    }

    /// 恒 panic 的发射器（验证单发射器失败隔离）
    struct PanickingEmitter;

    impl Emitter for PanickingEmitter {
        fn emit(&self, _channel: &str, _payload: &str) {
            panic!("测试用发射器故障");
        }
    }

    /// 构造信封 JSON payload（信封注入 runId/sequence；sessionId 来自事件体）
    fn payload_of(event: AgentEvent, sequence: Option<u64>) -> String {
        let envelope = AgentEventEnvelope::new(event, Some("r1".to_string()), sequence);
        serde_json::to_string(&envelope).expect("信封必须可序列化")
    }

    /// Critical 事件（agent-start，最简构造）
    fn agent_start(session_id: &str) -> AgentEvent {
        AgentEvent::AgentStart {
            session_id: session_id.to_string(),
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    /// Critical 事件（task-completed，任务域终态）
    fn task_completed(session_id: &str) -> AgentEvent {
        AgentEvent::TaskCompleted {
            session_id: session_id.to_string(),
            task_id: "t1".to_string(),
            exit_code: 0,
            duration_ms: 1_000,
            line_count: 3,
        }
    }

    /// Delta 事件（task-output，任务输出增量可丢）
    fn task_output(session_id: &str) -> AgentEvent {
        AgentEvent::TaskOutput {
            session_id: session_id.to_string(),
            task_id: "t1".to_string(),
            line: Some("输出行".to_string()),
            chunk: None,
            line_count: None,
        }
    }

    /// Soft 事件（task-suspicious，尽力投递）
    fn task_suspicious(session_id: &str) -> AgentEvent {
        AgentEvent::TaskSuspicious {
            session_id: session_id.to_string(),
            task_id: "t1".to_string(),
            silence_ms: 5_000,
            last_output_at_ms: 1_000,
        }
    }

    /// 取空队列（测试断言用）
    fn drain(rx: &FanoutReceiver) -> Vec<QueuedEvent> {
        let mut events = Vec::new();
        while let Some(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    fn session_sub(sessions: &[&str]) -> SubscriptionFilter {
        SubscriptionFilter::session_subscribe(sessions.iter().map(|s| s.to_string()))
    }

    // ── 订阅过滤（会话级 / 全局）──

    /// 过滤器纯语义：会话命中 + 全局白名单命中 + 无会话事件仅全局可收
    #[test]
    fn filter_matches_semantics() {
        let filter = SubscriptionFilter::new(
            ["s1".to_string()],
            ["security-audit".to_string()],
        );
        assert!(filter.matches("agent-start", Some("s1")), "订阅会话应命中");
        assert!(!filter.matches("agent-start", Some("s2")), "非订阅会话不命中");
        assert!(!filter.matches("agent-start", None), "无会话事件不命中会话订阅");
        assert!(filter.matches("security-audit", Some("s3")), "白名单类型命中");
        assert!(filter.matches("security-audit", None), "白名单类型无会话也命中");
        assert!(!filter.matches("message-delta", None), "白名单外类型不命中");
        assert!(!filter.is_empty(), "非空过滤器");
        assert!(SubscriptionFilter::default().is_empty(), "缺省为空过滤器");
    }

    /// 会话级订阅：只收订阅会话的事件，其他会话事件不收
    #[test]
    fn session_subscriber_receives_only_own_session() {
        let fanout = FanOutEmitter::new(vec![]);
        let rx = fanout
            .subscribe("conn-a", session_sub(&["s1"]))
            .expect("注册成功");

        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        let event = rx.try_recv().expect("订阅会话事件应送达");
        assert_eq!(event.event_type, "agent-start");
        assert_eq!(event.session_id.as_deref(), Some("s1"));
        assert_eq!(event.sequence, Some(1));

        fanout.emit("workbench-run-event", &payload_of(agent_start("s2"), Some(2)));
        assert!(rx.try_recv().is_none(), "非订阅会话事件不应送达");
    }

    /// 全局订阅：只收白名单类型事件（与会话归属无关），其余类型不收
    #[test]
    fn global_subscriber_receives_whitelisted_types() {
        let fanout = FanOutEmitter::new(vec![]);
        let rx = fanout
            .subscribe(
                "conn-b",
                SubscriptionFilter::global_subscribe(["task-completed".to_string()]),
            )
            .expect("注册成功");

        // 白名单类型 → 送达（会话归属无关）
        fanout.emit("workbench-run-event", &payload_of(task_completed("s9"), Some(1)));
        let event = rx.try_recv().expect("白名单类型事件应送达");
        assert_eq!(event.event_type, "task-completed");
        assert_eq!(event.session_id.as_deref(), Some("s9"));

        // 白名单外类型 → 不收（即便会话归属在订阅范围之外也不相关）
        fanout.emit("workbench-run-event", &payload_of(agent_start("s9"), Some(2)));
        assert!(rx.try_recv().is_none(), "白名单外类型不应送达");
    }

    /// 空过滤器：未订阅任何事件（fail-closed：恒不命中）
    #[test]
    fn empty_filter_receives_nothing() {
        let fanout = FanOutEmitter::new(vec![]);
        let rx = fanout
            .subscribe("conn-c", SubscriptionFilter::default())
            .expect("注册成功");
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        assert!(rx.try_recv().is_none(), "空过滤器不应收到任何事件");
    }

    // ── 丢帧分级（Critical 必达 / Soft 可丢 / Delta 高负载丢）──

    /// 洪峰下 Critical 必达：队列满后 Delta 洪峰全丢（Critical 原封不动），
    /// 洪峰后再入 Critical 无 Soft/Delta 可驱逐时超限接受（必达不丢）
    #[test]
    fn critical_survives_delta_flood() {
        let fanout = FanOutEmitter::with_capacity(vec![], 4);
        let rx = fanout
            .subscribe("conn-d", session_sub(&["s1"]))
            .expect("注册成功");

        // 先入 4 条 Critical（队列满）
        for sequence in 1..=4 {
            fanout.emit(
                "workbench-run-event",
                &payload_of(agent_start("s1"), Some(sequence)),
            );
        }
        // Delta 洪峰 100 条：队列全 Critical 无可驱逐 → 每条都被拒
        for sequence in 5..=104 {
            fanout.emit(
                "workbench-run-event",
                &payload_of(task_output("s1"), Some(sequence)),
            );
        }
        assert_eq!(rx.dropped(), 100, "洪峰 Delta 应全部计入丢帧");
        assert_eq!(rx.pending(), 4, "Critical 队列长度不变");
        assert_eq!(fanout.dropped_total(), 100, "全局丢帧计数同步");

        // 洪峰后再入 Critical：无 Soft/Delta 可驱逐 → 超限接受（必达）
        fanout.emit(
            "workbench-run-event",
            &payload_of(task_completed("s1"), Some(105)),
        );
        assert_eq!(rx.pending(), 5, "Critical 超限接受");
        let events = drain(&rx);
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(types[..4], ["agent-start"; 4], "4 条 Critical 全在");
        assert_eq!(types[4], "task-completed", "洪峰后的 Critical 必达");
        assert_eq!(events[4].sequence, Some(105));
    }

    /// 满队列时新 Soft 事件驱逐最旧 Delta 旧帧腾位（丢旧保新）
    #[test]
    fn soft_event_evicts_oldest_delta_when_full() {
        let fanout = FanOutEmitter::with_capacity(vec![], 3);
        let rx = fanout
            .subscribe("conn-e", session_sub(&["s1"]))
            .expect("注册成功");

        // 队列 [delta, delta, critical]（满）
        fanout.emit("workbench-run-event", &payload_of(task_output("s1"), Some(1)));
        fanout.emit("workbench-run-event", &payload_of(task_output("s1"), Some(2)));
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(3)));

        // 新 Soft：驱逐最旧 Delta 腾位
        fanout.emit("workbench-run-event", &payload_of(task_suspicious("s1"), Some(4)));
        assert_eq!(rx.dropped(), 1, "被驱逐的旧 Delta 计入丢帧");
        assert_eq!(rx.pending(), 3);
        let events = drain(&rx);
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(types, ["task-output", "agent-start", "task-suspicious"]);
    }

    /// 满队列时新 Critical 驱逐最旧 Soft 旧帧腾位（Soft 可丢、Critical 必达）
    #[test]
    fn critical_evicts_soft_when_full() {
        let fanout = FanOutEmitter::with_capacity(vec![], 2);
        let rx = fanout
            .subscribe("conn-f", session_sub(&["s1"]))
            .expect("注册成功");

        // 队列 [soft, delta]（满）
        fanout.emit("workbench-run-event", &payload_of(task_suspicious("s1"), Some(1)));
        fanout.emit("workbench-run-event", &payload_of(task_output("s1"), Some(2)));

        // 新 Critical：驱逐最旧 Soft 腾位
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(3)));
        assert_eq!(rx.dropped(), 1, "被驱逐的 Soft 计入丢帧");
        assert_eq!(rx.pending(), 2);
        let events = drain(&rx);
        let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
        assert_eq!(types, ["task-output", "agent-start"], "Soft 被驱逐、Critical 必达");
    }

    /// 队列全 Critical 时新 Critical 超限接受（必达语义：绝不丢）
    #[test]
    fn critical_overflows_when_queue_has_no_droppable() {
        let fanout = FanOutEmitter::with_capacity(vec![], 2);
        let rx = fanout
            .subscribe("conn-g", session_sub(&["s1"]))
            .expect("注册成功");

        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(2)));
        fanout.emit("workbench-run-event", &payload_of(task_completed("s1"), Some(3)));

        assert_eq!(rx.dropped(), 0, "Critical 不丢帧");
        assert_eq!(rx.pending(), 3, "Critical 超限接受");
    }

    // ── 连接注册表 ──

    /// 连接 id 重复注册被拒（注册表键冲突）
    #[test]
    fn duplicate_conn_id_rejected() {
        let fanout = FanOutEmitter::new(vec![]);
        fanout
            .subscribe("conn-x", session_sub(&["s1"]))
            .expect("首次注册成功");
        // 断言错误码（FanoutReceiver 是运行时句柄，不实现 PartialEq/Debug）
        let result = fanout.subscribe("conn-x", session_sub(&["s2"]));
        assert_eq!(
            result.err(),
            Some(FanoutError::AlreadyRegistered),
            "重复连接 id 应拒绝注册"
        );
        assert_eq!(fanout.subscriber_count(), 1);
    }

    /// 注销后不再接收新事件（残留队列仍可读尽）
    #[test]
    fn unsubscribe_stops_delivery() {
        let fanout = FanOutEmitter::new(vec![]);
        let rx = fanout
            .subscribe("conn-y", session_sub(&["s1"]))
            .expect("注册成功");

        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        assert!(rx.try_recv().is_some(), "注销前应送达");

        fanout.unsubscribe("conn-y");
        assert_eq!(fanout.subscriber_count(), 0, "注册表应移除该连接");
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(2)));
        assert!(rx.try_recv().is_none(), "注销后不应再送达");
    }

    /// 零订阅者发布零开销（不 panic、计数为 0）
    #[test]
    fn publish_without_subscribers_is_noop() {
        let fanout = FanOutEmitter::new(vec![]);
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        assert_eq!(fanout.subscriber_count(), 0);
        assert_eq!(fanout.dropped_total(), 0);
    }

    // ── emit 接线（R1-01 验收锚点：双发射器收同一 payload）──

    /// 双发射器收同一 payload：同步发射器与跨端订阅者逐字节一致
    #[test]
    fn emit_forwards_same_payload_to_inner_and_subscriber() {
        let inner = Arc::new(RecordingEmitter::default());
        let fanout = FanOutEmitter::new(vec![Arc::clone(&inner) as Arc<dyn Emitter>]);
        let rx = fanout
            .subscribe("conn-z", session_sub(&["s1"]))
            .expect("注册成功");

        let payload = payload_of(agent_start("s1"), Some(1));
        fanout.emit("workbench-run-event", &payload);

        // 同步发射器收到同一通道与载荷
        let calls = inner.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "workbench-run-event");
        assert_eq!(calls[0].1, payload);
        // 跨端订阅者收到同一载荷（逐字节一致）
        let event = rx.try_recv().expect("订阅者应收到事件");
        assert_eq!(event.payload, payload);
        assert_eq!(event.level, BackpressureLevel::Critical);
    }

    /// 单发射器 panic 不影响其余（catch_unwind 隔离）
    #[test]
    fn panicking_emitter_does_not_block_others() {
        let recording = Arc::new(RecordingEmitter::default());
        let fanout = FanOutEmitter::new(vec![
            Arc::new(PanickingEmitter),
            Arc::clone(&recording) as Arc<dyn Emitter>,
        ]);
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        assert_eq!(recording.calls().len(), 1, "panic 发射器之后仍应继续分发");
    }

    /// EventBridge 接线：attach FanOutEmitter 后 emit_envelope → 订阅者
    /// 收到与 webview 通道逐字节一致的载荷（mock bridge 事件 → fanout 收到）
    #[test]
    fn bridge_emit_reaches_fanout_subscriber() {
        use crate::core_event_bridge::EventBridge;

        // 桌面侧发射器（测试替身）
        let webview = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&webview) as Arc<dyn Emitter>,
        );
        // 挂跨端扇出（生产装配形态：attach_fanout，main.rs 接线）
        let fanout = Arc::new(FanOutEmitter::new(vec![]));
        bridge.attach_fanout(Arc::clone(&fanout) as Arc<dyn Emitter>);
        let rx = fanout
            .subscribe("conn-bridge", session_sub(&["s1"]))
            .expect("注册成功");

        let envelope = AgentEventEnvelope::new(agent_start("s1"), Some("r1".to_string()), Some(7));
        let report = bridge.emit_envelope(&envelope);

        assert_eq!(report.emitted, 1);
        assert_eq!(webview.calls().len(), 1, "webview 通道照常");
        let event = rx.try_recv().expect("fanout 订阅者应收到事件");
        assert_eq!(event.event_type, "agent-start");
        assert_eq!(event.session_id.as_deref(), Some("s1"));
        assert_eq!(event.sequence, Some(7));
        // 双通道同载荷（跨端与 webview 逐字节一致，D1 §1.3 原则 1）
        assert_eq!(event.payload, webview.calls()[0].1);
    }

    // ── 元信息与消费 ──

    /// 排队事件元信息完整（类型 / 会话 / 序列号 / 背压级别）
    #[test]
    fn queued_event_metadata_filled() {
        let fanout = FanOutEmitter::new(vec![]);
        let rx = fanout
            .subscribe("conn-m", session_sub(&["s1"]))
            .expect("注册成功");

        fanout.emit("workbench-run-event", &payload_of(task_output("s1"), Some(3)));
        let event = rx.try_recv().expect("应收到事件");
        assert_eq!(event.event_type, "task-output");
        assert_eq!(event.session_id.as_deref(), Some("s1"));
        assert_eq!(event.sequence, Some(3));
        assert_eq!(event.level, BackpressureLevel::Delta);
    }

    /// recv（async）唤醒语义：publish 后 drain 侧被唤醒取到事件
    #[tokio::test]
    async fn receiver_recv_wakes_on_publish() {
        let fanout = FanOutEmitter::new(vec![]);
        let rx = fanout
            .subscribe("conn-r", session_sub(&["s1"]))
            .expect("注册成功");
        let rx2 = rx.clone();
        let task = tokio::spawn(async move {
            // 队列空时应挂起等待，publish 后收到（Notify permit 粘滞）
            let event = rx2.recv().await.expect("等待到事件");
            event.event_type
        });
        // 让 drain 任务先进入等待
        tokio::task::yield_now().await;
        fanout.emit("workbench-run-event", &payload_of(agent_start("s1"), Some(1)));
        let event_type = task.await.expect("drain 任务不应 panic");
        assert_eq!(event_type, "agent-start");
    }
}
