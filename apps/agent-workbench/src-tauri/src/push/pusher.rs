//! 直推通道（R3-02：PushAwareEmitter 挂点 + 在线直推 / 离线标记）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md` §9.2 方案 a
//!   （Emitter 装饰器：转发原通道 + 旁路推送决策引擎）、§6.4（分发决策表：
//!   connected → 仅 WS 直推；offline → 厂商通道）、§6.6（推送队列与背压）；
//! - `docs/multi-device/plans/M8-push-release.md` §3.2.1（事件桥旁路 →
//!   push-core 决策 → 双轨分发）与裁决修正 2（在线直推并入协议面
//!   `events.push`——见 [crate::push::schema::WS_PUSH_KIND]）。
//!
//! 链路：
//!
//! ```text
//! EventBridge emit(channel, payload)
//!   ├─ 内层发射器（webview 通道，行为不变）
//!   └─ PushAwareEmitter::on_event（本模块旁路）
//!        ├─ payload → AgentEvent + 信封 runId/sequence（对齐 fanout.rs
//!        │   parse_event_meta 的扁平信封解析先例）
//!        ├─ PushDecisionEngine.decide → PushDecision 列表
//!        └─ PushDispatcher.dispatch（deliver=true 的决策）
//!             ├─ 在线设备 → PushChannel::send（WS 帧 events.push）
//!             └─ 离线设备 → pending 队列（R3-03 厂商通道消费）
//! ```
//!
//! ## 装配注记（R3-02 接线轮已落地）
//!
//! - `PushAwareEmitter` 已在 main.rs 事件桥装配处包装内层发射器
//!   （EventBridge::new 的 emitter 参数）——D7 §9.2 方案 a；周期 drain：
//!   `flush(now_ms)` 500ms 循环已接线（对齐 timer/cron drain 先例）；
//! - [DevicePresenceSource] 已以 `server::ws::WsRegistry` 适配（连接快照 →
//!   [crate::push::online::DeviceActivity]；ws.rs 增补 device_activities /
//!   attach_outbound / send_push_frame 只读数据面）；适配层因 lib/bin
//!   模块树分裂（lib.rs:1-22 注记）落在 bin 侧 `src/push_wiring.rs`；
//! - [PushChannel] 的 WS 实现（bin 侧 WsPushChannel）：按 device_key
//!   （令牌哈希）定位连接 → 复用 ws.rs outbound_frame 构造 events.push
//!   信封 → 出站通道投递（R1-05 已备的 conn 出站通道 + sender task）；
//! - `take_pending()` 由 R3-03 厂商发送器周期消费（离线兜底；
//!   [crate::push::vendor::consumer::send_pending_batch]——未送达条目经
//!   [PushDispatcher::requeue_pending] 保留回队列，凭据缺失/可重试不丢）；
//!   审批键待发表的 SQLite 持久化（push_pending_approvals，D7 §9.3）在
//!   R3-03 接线，本任务只覆盖内存 pending（在线判定面）。
//!
//! ## 临时过渡允许（对齐 R3-01 先例）
//!
//! 本模块 R3-02 交付接口与分发器；挂点 / 适配 / 直推已在 R3-02 接线轮
//! 落地（main.rs + push_wiring.rs），`take_pending` 的厂商消费与周期挂点
//! 已由 R3-03b 交付（消费函数 + 发送器），周期 drain 装配仍待装配轮，
//! 由 push/mod.rs 的 `#![allow(dead_code)]` 覆盖；装配轮落地即移除。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use conex_types::events::AgentEvent;

use conex_run::core_event_bridge::Emitter;

use super::copy::message_with_copy;
use super::engine::{PushDecision, PushDecisionEngine};
use super::intent::PushIntentCtx;
use super::online::{is_device_online, DevicePresenceSource, PRESENCE_TIMEOUT_MS};
use super::pending::{approval_id_for, PendingApprovalStore, StoredPendingApproval};
use super::schema::PushMessage;

/// 直推通道抽象（在线设备 WS 帧投递；R3 接线轮实现）
pub trait PushChannel: Send + Sync {
    /// 投递一条推送消息到指定设备（帧 kind = `events.push`，M8 裁决修正 2；
    /// 失败 = 通道不可用，分发器降级标记 pending）
    fn send(&self, device_key: &str, message: &PushMessage) -> Result<(), PushChannelError>;
}

/// 直推通道错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushChannelError {
    /// 目标设备无活动连接（在线判定与连接生命周期竞态）
    NoConnection,
    /// 通道发送失败（帧超限 / 写入失败等）
    SendFailed(String),
}

/// 离线待发表（R3-03 厂商通道消费；device_key + 完整消息）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingDelivery {
    /// 目标设备（设备令牌哈希）
    pub device_key: String,
    /// 完整 PushMessage（厂商通道取 title/body/target/data 最小子集，
    /// D7 §6.3 摘要级）
    pub message: PushMessage,
    /// 标记时刻（epoch ms）
    pub marked_at_ms: u64,
}

/// 一次分发的结果报告（测试断言 / 审计用）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DispatchReport {
    /// 在线直推成功条数
    pub delivered: usize,
    /// 标记离线 pending 条数（含在线但发送失败降级）
    pub pending_marked: usize,
    /// 未投递决策条数（deliver=false，各环节抑制/折叠）
    pub skipped: usize,
}

/// 推送分发器（PushDecision → 在线直推 / 离线 pending）
///
/// 分发决策（D7 §6.4 简化面：本任务只做在线判定 + 直推接口 + 离线标记）：
/// - 设备在线（最近活动 < 超时窗口）→ [PushChannel] 直推；
/// - 设备离线 → pending 队列（内存；R3-03 消费）；
/// - 在线直推失败 → 降级 pending（宁可待发不丢，D7 §6.6 最小姿态）；
/// - 连接注册表无设备（未配对 / 从未连接）→ 不推（D7 §6.4「未配对 不推」；
///   从未连接的注册设备属 R3-03 厂商注册表面，不在本任务范围）。
pub struct PushDispatcher {
    presence: Arc<dyn DevicePresenceSource>,
    channel: Arc<dyn PushChannel>,
    /// 离线 pending 队列（内存；R3-03 周期 take_pending 消费；注入
    /// [PendingApprovalStore] 后，新入队条目落库、重启从库恢复）
    pending: Mutex<VecDeque<PendingDelivery>>,
    /// 审批待发表持久化（SQLite；R3-01 部分 3 注入面——缺省 None =
    /// 纯内存队列，行为与 R3-02 一致）
    pending_store: Option<Arc<PendingApprovalStore>>,
    /// 每设备单调 seq（D7 §6.2 seq 语义：WS 帧级去重与 ack 对应）
    seq_by_device: Mutex<HashMap<String, u64>>,
    /// 全局 push id 发号（`push-<递增>`，对齐事件 sequence 语义）
    next_id: AtomicU64,
    /// 在线判定超时窗口（D7 §6.4：默认 30s）
    presence_timeout_ms: u64,
}

impl PushDispatcher {
    /// 用在线状态源 + 直推通道构造
    pub fn new(presence: Arc<dyn DevicePresenceSource>, channel: Arc<dyn PushChannel>) -> Self {
        Self {
            presence,
            channel,
            pending: Mutex::new(VecDeque::new()),
            pending_store: None,
            seq_by_device: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            presence_timeout_ms: PRESENCE_TIMEOUT_MS,
        }
    }

    /// 指定在线判定超时窗口（测试注入；生产用默认 30s）
    pub fn with_presence_timeout(mut self, timeout_ms: u64) -> Self {
        self.presence_timeout_ms = timeout_ms;
        self
    }

    /// 注入 SQLite 审批待发表（R3-01 部分 3：pending 队列持久化——入队
    /// 落库 / take 从库读 / 重推阶梯 / 送达清库；重启后到期待发自动恢复，
    /// D7 §9.3「桌面端崩溃/重启不丢审批推送」）
    pub fn with_pending_store(mut self, store: Arc<PendingApprovalStore>) -> Self {
        self.pending_store = Some(store);
        self
    }

    /// 分发一条决策（deliver=false 跳过；在线直推 / 离线标记 pending）
    pub fn dispatch(&self, decision: &PushDecision, now_ms: u64) -> DispatchReport {
        if !decision.deliver {
            return DispatchReport {
                skipped: 1,
                ..DispatchReport::default()
            };
        }
        let devices = self.presence.connected_devices();
        if devices.is_empty() {
            // 无已连接设备 = 无目标（未配对）：不推（D7 §6.4）
            return DispatchReport::default();
        }
        let mut report = DispatchReport::default();
        for device in devices {
            let id = format!("push-{:06}", self.next_id.fetch_add(1, Ordering::Relaxed));
            let seq = self.next_seq(&device.device_key);
            // copy.rs 渲染 title/body（D7 §6.5：WS 直推与离线 pending 一并
            // 携带完整文案；厂商通道消费经 digest 桥接还原）
            let message = message_with_copy(decision, id, seq, now_ms);
            if is_device_online(device.last_frame_at_ms, now_ms, self.presence_timeout_ms) {
                match self.channel.send(&device.device_key, &message) {
                    Ok(()) => report.delivered += 1,
                    Err(error) => {
                        // 在线直推失败：降级 pending（宁可待发不丢；
                        // 对齐 D7 §6.6「发送失败只记录 + 审批类重推」）
                        tracing::warn!(
                            target: "push",
                            device_key = %device.device_key,
                            error = ?error,
                            "在线直推失败，降级标记 pending"
                        );
                        self.mark_pending(device.device_key, message, now_ms);
                        report.pending_marked += 1;
                    }
                }
            } else {
                self.mark_pending(device.device_key, message, now_ms);
                report.pending_marked += 1;
            }
        }
        report
    }

    /// 取出待发 pending（R3-03 厂商通道消费；取走即移出队列）
    ///
    /// 持久化注入后 = 内存（重入队在飞条目）drain + 待发表到期行
    /// [PendingApprovalStore::take_due]（阶梯推进；重启后内存为空 →
    /// 到期待发自动恢复，D7 §9.3）。
    pub fn take_pending(&self) -> Vec<PendingDelivery> {
        let mut deliveries = match self.pending.lock() {
            Ok(mut queue) => queue.drain(..).collect(),
            // 锁损坏属进程级异常：不阻塞调用方（R3-03 周期消费照常轮询）
            Err(_) => Vec::new(),
        };
        if let Some(store) = &self.pending_store {
            deliveries.extend(
                store
                    .take_due(now_ms())
                    .into_iter()
                    .map(StoredPendingApproval::into_delivery),
            );
        }
        deliveries
    }

    /// 重新入队（R3-03b 厂商消费分拣：未送达条目——凭据缺失 / 限流 /
    /// 可重试失败——保留回 pending 队列，下一轮周期再试；「宁可待发不丢」
    /// D7 §6.6 最小姿态）
    pub fn requeue_pending(&self, deliveries: Vec<PendingDelivery>) {
        if let Ok(mut queue) = self.pending.lock() {
            queue.extend(deliveries);
        }
    }

    /// 待发 pending 条数（诊断 / 测试；持久化注入后 = 内存 + 待发表合计，
    /// 含阶梯推进后仍在库的审批行）
    pub fn pending_len(&self) -> usize {
        let memory = match self.pending.lock() {
            Ok(queue) => queue.len(),
            Err(_) => 0,
        };
        let persisted = self
            .pending_store
            .as_ref()
            .map(|store| store.len())
            .unwrap_or(0);
        memory + persisted
    }

    /// 送达清库（R3-03 消费装配接线：厂商受理 / 设备失效 / 永久失败 /
    /// 审批已解决后调用，从待发表移除该行——D7 §8.2 resolved 停止语义；
    /// 无持久化注入 = 空操作返回 false）
    pub fn mark_delivered(&self, delivery: &PendingDelivery) -> bool {
        match &self.pending_store {
            Some(store) => store.remove(&delivery.device_key, &approval_id_for(&delivery.message)),
            None => false,
        }
    }

    fn mark_pending(&self, device_key: String, message: PushMessage, now_ms: u64) {
        // 持久化注入：落库优先（幂等——同 (device_key, approval_id) 已
        // 在库则不重复入队，D7 §8.4-5）；落库失败降级内存队列（宁可待发
        // 不丢，D7 §6.6 最小姿态）
        if let Some(store) = &self.pending_store {
            if store.enqueue(&device_key, &message, now_ms) {
                return;
            }
            tracing::warn!(
                target: "push",
                device_key = %device_key,
                "审批待发表落库失败，降级内存 pending"
            );
        }
        if let Ok(mut queue) = self.pending.lock() {
            queue.push_back(PendingDelivery {
                device_key,
                message,
                marked_at_ms: now_ms,
            });
        }
    }

    /// 每设备单调 seq 发号（从 1 递增；断开重连后继续递增——帧级去重
    /// 以「跨连接单调」为语义，对齐 D7 §6.2 seq 字段说明）
    fn next_seq(&self, device_key: &str) -> u64 {
        match self.seq_by_device.lock() {
            Ok(mut map) => {
                let counter = map.entry(device_key.to_string()).or_insert(0);
                *counter += 1;
                *counter
            }
            // 锁损坏：退化为全局递增（同一时刻并发写时 seq 可能重复，
            // 但锁损坏本属进程级异常，防御返回）
            Err(_) => self.next_id.load(Ordering::Relaxed),
        }
    }
}

/// 推送感知发射器（D7 §9.2 方案 a：Emitter 装饰器）
///
/// `emit(channel, payload)` = 转发原通道（行为不变）+ 旁路推送决策与分发：
/// 反序列化事件信封 → [PushDecisionEngine::decide] → 分发器按设备在线态
/// 直推 / 标记 pending。事件解析失败按 fail-closed 跳过（对齐 fanout.rs
/// parse_event_meta 的防御语义）。
pub struct PushAwareEmitter {
    /// 内层发射器（webview 通道；转发保持既有行为）
    inner: Arc<dyn Emitter>,
    /// 决策引擎（管线状态机；装配轮可用 EngineConfig 定制）
    engine: Mutex<PushDecisionEngine>,
    /// 分发器（在线直推 / 离线 pending）
    dispatcher: Arc<PushDispatcher>,
    /// 时钟源（epoch 毫秒；测试注入固定时钟防时刻敏感——静默时段/
    /// 窗口边界随真实墙钟漂移，生产用 [now_ms]）
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    /// 合并桶入队/变更唤醒（drain loop 事件驱动，取代固定 500ms sleep）
    wake: Arc<tokio::sync::Notify>,
}

impl PushAwareEmitter {
    /// 用内层发射器 + 分发器构造（决策引擎缺省配置；墙钟）
    pub fn new(inner: Arc<dyn Emitter>, dispatcher: Arc<PushDispatcher>) -> Self {
        Self::with_clock(inner, dispatcher, Box::new(now_ms))
    }

    /// 注入时钟构造（测试用：固定时钟使决策时刻/静默时段判定可复现）
    pub fn with_clock(
        inner: Arc<dyn Emitter>,
        dispatcher: Arc<PushDispatcher>,
        now: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            inner,
            engine: Mutex::new(PushDecisionEngine::default()),
            dispatcher,
            now,
            wake: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// drain loop 用：等待合并桶入队或到期唤醒
    pub fn wake_notify(&self) -> Arc<tokio::sync::Notify> {
        Arc::clone(&self.wake)
    }

    /// 最近合并桶到期时刻；无桶返回 None
    pub fn next_expiry_ms(&self, now_ms: u64) -> Option<u64> {
        match self.engine.lock() {
            Ok(engine) => engine.next_expiry_ms(now_ms),
            Err(_) => None,
        }
    }

    /// 周期 drain（合并桶到点产出；装配接线轮在 drain loop 调用，
    /// 对齐 main.rs:430-441 的 500ms 先例）
    pub fn flush(&self, now_ms: u64) {
        let decisions = match self.engine.lock() {
            Ok(mut engine) => engine.flush(now_ms),
            Err(_) => {
                tracing::error!(target: "push", "决策引擎锁损坏（poisoned），跳过 drain");
                return;
            }
        };
        self.dispatch_all(&decisions, now_ms);
    }

    /// 事件旁路：payload（信封扁平 JSON）→ 决策 → 分发
    fn on_event(&self, payload: &str) {
        let Some((event, run_id, sequence)) = parse_event_payload(payload) else {
            return;
        };
        let ctx = PushIntentCtx {
            envelope_run_id: run_id,
            sequence,
        };
        let now = (self.now)();
        let decisions = match self.engine.lock() {
            Ok(mut engine) => {
                let decisions = engine.decide(&event, &ctx, now);
                if engine.next_expiry_ms(now).is_some() {
                    self.wake.notify_one();
                }
                decisions
            }
            Err(_) => {
                tracing::error!(target: "push", "决策引擎锁损坏（poisoned），跳过事件");
                return;
            }
        };
        self.dispatch_all(&decisions, now);
    }

    fn dispatch_all(&self, decisions: &[PushDecision], now_ms: u64) {
        for decision in decisions {
            let _ = self.dispatcher.dispatch(decision, now_ms);
        }
    }
}

impl Emitter for PushAwareEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        // 1. 转发原通道（行为不变——D7 §9.2 方案 a 第一职责）
        self.inner.emit(channel, payload);
        // 2. 旁路推送决策与分发（事件流 → push-core → 双轨分发）
        self.on_event(payload);
    }
}

/// 解析事件信封扁平 JSON → (事件, 信封 runId, 信封 sequence)
///
/// 对齐 fanout.rs parse_event_meta 先例：从含 runId/sequence/schemaVersion
/// 的顶层 JSON 直接反序列化事件体，未知顶层键被 serde 忽略；解析失败
/// 返回 None（fail-closed：无法解析的事件不进推送决策）。
fn parse_event_payload(payload: &str) -> Option<(AgentEvent, Option<String>, Option<u64>)> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let event: AgentEvent = serde_json::from_value(value.clone()).ok()?;
    let run_id = value
        .get("runId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let sequence = value.get("sequence").and_then(serde_json::Value::as_u64);
    Some((event, run_id, sequence))
}

/// 墙钟（epoch 毫秒；推送生成时刻 tsMs 与决策时钟）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests;
