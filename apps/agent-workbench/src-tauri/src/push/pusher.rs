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
//! - `take_pending()` 由 R3-03 厂商发送器周期消费（离线兜底）；审批键
//!   待发表的 SQLite 持久化（push_pending_approvals，D7 §9.3）在 R3-03
//!   接线，本任务只覆盖内存 pending（在线判定面）。
//!
//! ## 临时过渡允许（对齐 R3-01 先例）
//!
//! 本模块 R3-02 交付接口与分发器；挂点 / 适配 / 直推已在 R3-02 接线轮
//! 落地（main.rs + push_wiring.rs），`take_pending` / 持久化面仍待 R3-03
//! 消费，由 push/mod.rs 的 `#![allow(dead_code)]` 覆盖；R3-03 落地即移除。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use conex_types::events::AgentEvent;

use crate::core_event_bridge::Emitter;

use super::engine::{PushDecision, PushDecisionEngine};
use super::intent::PushIntentCtx;
use super::online::{is_device_online, DevicePresenceSource, PRESENCE_TIMEOUT_MS};
use super::schema::{message_from_decision, PushMessage};

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
    /// 离线 pending 队列（内存；R3-03 周期 take_pending 消费）
    pending: Mutex<VecDeque<PendingDelivery>>,
    /// 每设备单调 seq（D7 §6.2 seq 语义：WS 帧级去重与 ack 对应）
    seq_by_device: Mutex<HashMap<String, u64>>,
    /// 全局 push id 发号（`push-<递增>`，对齐事件 sequence 语义）
    next_id: AtomicU64,
    /// 在线判定超时窗口（D7 §6.4：默认 30s）
    presence_timeout_ms: u64,
}

impl PushDispatcher {
    /// 用在线状态源 + 直推通道构造
    pub fn new(
        presence: Arc<dyn DevicePresenceSource>,
        channel: Arc<dyn PushChannel>,
    ) -> Self {
        Self {
            presence,
            channel,
            pending: Mutex::new(VecDeque::new()),
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
            let message = message_from_decision(decision, id, seq, now_ms);
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

    /// 取出全部离线 pending（R3-03 厂商通道消费；取走即移出队列）
    pub fn take_pending(&self) -> Vec<PendingDelivery> {
        match self.pending.lock() {
            Ok(mut queue) => queue.drain(..).collect(),
            // 锁损坏属进程级异常：不阻塞调用方（R3-03 周期消费照常轮询）
            Err(_) => Vec::new(),
        }
    }

    /// 待发 pending 条数（诊断 / 测试）
    pub fn pending_len(&self) -> usize {
        match self.pending.lock() {
            Ok(queue) => queue.len(),
            Err(_) => 0,
        }
    }

    fn mark_pending(&self, device_key: String, message: PushMessage, now_ms: u64) {
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
            Ok(mut engine) => engine.decide(&event, &ctx, now),
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
mod tests {
    use super::*;
    use conex_types::events::{AgentEventEnvelope, RunTerminalStatus};

    use crate::push::engine::{DecisionOutcome, PushDecision};
    use crate::push::intent::PayloadDigest;
    use crate::push::online::{device_activity, MemoryPresenceSource};
    use crate::push::scenes::SceneId;
    use crate::push::schema::WS_PUSH_KIND;

    /// 记录通道（测试替身：记录 (device_key, message) 序列；可注入失败）
    struct RecordingChannel {
        sent: Mutex<Vec<(String, PushMessage)>>,
        fail_with: Mutex<Option<PushChannelError>>,
    }

    impl RecordingChannel {
        fn new() -> Self {
            Self {
                sent: Mutex::new(Vec::new()),
                fail_with: Mutex::new(None),
            }
        }

        fn sent(&self) -> Vec<(String, PushMessage)> {
            self.sent.lock().unwrap().clone()
        }

        /// 注入通道故障（后续 send 均失败）
        fn fail(&self, error: PushChannelError) {
            *self.fail_with.lock().unwrap() = Some(error);
        }
    }

    impl PushChannel for RecordingChannel {
        fn send(
            &self,
            device_key: &str,
            message: &PushMessage,
        ) -> Result<(), PushChannelError> {
            if let Some(error) = self.fail_with.lock().unwrap().clone() {
                return Err(error);
            }
            self.sent
                .lock()
                .unwrap()
                .push((device_key.to_string(), message.clone()));
            Ok(())
        }
    }

    /// 决策 fixture（S4 run 失败 P0；deliver 可切换）
    fn decision(deliver: bool) -> PushDecision {
        PushDecision {
            deliver,
            scene: SceneId::RunFailed,
            level: SceneId::RunFailed.level(),
            severity: SceneId::RunFailed.level().severity(),
            dedupe_key: "run-terminal:run-42".to_string(),
            payload: PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: "run-42".to_string(),
                digest: Some("provider 401".to_string()),
                detail: None,
            },
            outcome: DecisionOutcome::Delivered,
        }
    }

    /// 在线判定基准：now 前 1s 活动 = 在线；前 60s = 离线（30s 窗口）
    fn dispatcher_with(
        devices: Vec<crate::push::online::DeviceActivity>,
    ) -> (PushDispatcher, Arc<RecordingChannel>) {
        let presence = Arc::new(MemoryPresenceSource::new());
        presence.set_devices(devices);
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = PushDispatcher::new(presence, Arc::clone(&channel) as Arc<dyn PushChannel>);
        (dispatcher, channel)
    }

    /// 在线设备直推：WS 帧通道收到完整 PushMessage（id 全局递增、
    /// seq 从 1 起）
    #[test]
    fn online_device_receives_direct_push() {
        let (dispatcher, channel) = dispatcher_with(vec![device_activity(
            "tok-a",
            "手机 A",
            1_784_078_400_000 - 1_000,
        )]);
        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report.delivered, 1);
        assert_eq!(report.pending_marked, 0);
        assert_eq!(report.skipped, 0);

        let sent = channel.sent();
        assert_eq!(sent.len(), 1);
        let (device_key, message) = &sent[0];
        assert_eq!(device_key, "tok-a");
        assert_eq!(message.id, "push-000001");
        assert_eq!(message.seq, 1);
        assert_eq!(message.dedupe_key, "run-terminal:run-42");
        assert_eq!(message.target.session_id.as_deref(), Some("s-7"));
    }

    /// 离线设备：不直推、标记 pending（R3-03 消费）
    #[test]
    fn offline_device_marked_pending() {
        let (dispatcher, channel) = dispatcher_with(vec![device_activity(
            "tok-b",
            "手机 B",
            1_784_078_400_000 - 60_000,
        )]);
        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report.delivered, 0);
        assert_eq!(report.pending_marked, 1);
        assert!(channel.sent().is_empty(), "离线设备不直推");

        assert_eq!(dispatcher.pending_len(), 1);
        let pending = dispatcher.take_pending();
        assert_eq!(pending.len(), 1, "取走全部 pending");
        assert_eq!(pending[0].device_key, "tok-b");
        assert_eq!(pending[0].message.id, "push-000001");
        assert_eq!(pending[0].message.seq, 1);
        assert_eq!(pending[0].marked_at_ms, 1_784_078_400_000);
        assert_eq!(dispatcher.pending_len(), 0, "取走后清空");
    }

    /// 多设备混合：在线直推 + 离线标记（同一决策逐设备分发）
    #[test]
    fn mixed_devices_split_delivery() {
        let (dispatcher, channel) = dispatcher_with(vec![
            device_activity("tok-a", "手机 A", 1_784_078_400_000 - 1_000),
            device_activity("tok-b", "手机 B", 1_784_078_400_000 - 60_000),
        ]);
        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report.delivered, 1, "在线设备直推");
        assert_eq!(report.pending_marked, 1, "离线设备标记 pending");

        let sent = channel.sent();
        assert_eq!(sent[0].0, "tok-a");
        let pending = dispatcher.take_pending();
        assert_eq!(pending[0].device_key, "tok-b");
    }

    /// deliver=false 的决策不投递（各环节抑制/折叠产物直接跳过）
    #[test]
    fn suppressed_decision_skipped() {
        let (dispatcher, channel) = dispatcher_with(vec![device_activity(
            "tok-a",
            "手机 A",
            1_784_078_400_000 - 1_000,
        )]);
        let report = dispatcher.dispatch(&decision(false), 1_784_078_400_000);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.delivered, 0);
        assert_eq!(report.pending_marked, 0);
        assert!(channel.sent().is_empty());
        assert_eq!(dispatcher.pending_len(), 0);
    }

    /// 在线直推失败 → 降级标记 pending（宁可待发不丢）
    #[test]
    fn send_failure_degrades_to_pending() {
        let (dispatcher, channel) = dispatcher_with(vec![device_activity(
            "tok-a",
            "手机 A",
            1_784_078_400_000 - 1_000,
        )]);
        channel.fail(PushChannelError::SendFailed("写入失败".to_string()));
        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report.delivered, 0, "发送失败不计直推");
        assert_eq!(report.pending_marked, 1, "降级标记 pending");
        let pending = dispatcher.take_pending();
        assert_eq!(pending[0].device_key, "tok-a");
    }

    /// seq 每设备单调：同设备两次推送 seq=1,2；不同设备独立从 1 起
    #[test]
    fn seq_is_monotonic_per_device() {
        let (dispatcher, channel) = dispatcher_with(vec![
            device_activity("tok-a", "手机 A", 1_784_078_400_000 - 1_000),
            device_activity("tok-c", "手机 C", 1_784_078_400_000 - 1_000),
        ]);
        dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        dispatcher.dispatch(&decision(true), 1_784_078_400_000 + 1_000);
        let sent = channel.sent();
        let seqs_of = |key: &str| -> Vec<u64> {
            sent.iter()
                .filter(|(k, _)| k == key)
                .map(|(_, m)| m.seq)
                .collect()
        };
        assert_eq!(seqs_of("tok-a"), vec![1, 2], "A 设备单调递增");
        assert_eq!(seqs_of("tok-c"), vec![1, 2], "C 设备独立单调递增");
        // id 全局递增（跨设备）
        let ids: Vec<&str> = sent.iter().map(|(_, m)| m.id.as_str()).collect();
        assert_eq!(ids, ["push-000001", "push-000002", "push-000003", "push-000004"]);
    }

    /// 无已连接设备（未配对）：不推不标记（D7 §6.4「未配对 不推」）
    #[test]
    fn no_devices_means_no_target() {
        let (dispatcher, channel) = dispatcher_with(vec![]);
        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report, DispatchReport::default());
        assert!(channel.sent().is_empty());
        assert_eq!(dispatcher.pending_len(), 0);
    }

    /// 在线判定边界：恰好超时窗口 = 离线（分发侧与纯函数口径一致；
    /// 定制窗口注入验证）
    #[test]
    fn presence_timeout_boundary_respected() {
        let presence = Arc::new(MemoryPresenceSource::new());
        presence.set_devices(vec![device_activity(
            "tok-d",
            "边界设备",
            1_784_078_400_000 - 10_000,
        )]);
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = PushDispatcher::new(
            Arc::clone(&presence) as Arc<dyn DevicePresenceSource>,
            Arc::clone(&channel) as Arc<dyn PushChannel>,
        )
        .with_presence_timeout(10_000);

        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report.pending_marked, 1, "恰 10s 无帧 = 离线");

        // 触摸刷新（对齐 ws.rs touch 语义）→ 在线直推
        presence.touch("tok-d", 1_784_078_400_000 - 1_000);
        let report = dispatcher.dispatch(&decision(true), 1_784_078_400_000);
        assert_eq!(report.delivered, 1, "刷新后在线直推");
    }

    // ── PushAwareEmitter（Emitter 装饰器）──

    /// 内层记录发射器（验证转发行为不变）
    #[derive(Default)]
    struct RecordingEmitter {
        calls: std::sync::Mutex<Vec<(String, String)>>,
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

    /// 信封 JSON payload（runId/sequence 注入；sessionId 来自事件体）
    fn envelope_payload(event: AgentEvent, run_id: Option<&str>, sequence: Option<u64>) -> String {
        let envelope = AgentEventEnvelope::new(event, run_id.map(str::to_string), sequence);
        serde_json::to_string(&envelope).expect("信封必须可序列化")
    }

    /// 推送事件（run 失败：S4 P0，直发）
    fn run_failed_event() -> AgentEvent {
        AgentEvent::RunTerminal {
            session_id: "s-7".to_string(),
            run_id: "run-42".to_string(),
            timestamp: "2026-08-14T12:00:00Z".to_string(),
            terminal: RunTerminalStatus::Failed,
            error: Some("provider 401".to_string()),
        }
    }

    /// P3 噪音事件（task-output：不进决策）
    fn noise_event() -> AgentEvent {
        AgentEvent::TaskOutput {
            session_id: "s-7".to_string(),
            task_id: "t-1".to_string(),
            line: Some("x".to_string()),
            chunk: None,
            line_count: Some(1),
        }
    }

    /// 基准时刻：2026-08-09 12:00:00 UTC（正午，非静默时段——避免
    /// 真实墙钟跑进 22:30-07:30 静默区间导致 P1 折叠的**时刻敏感**；
    /// 与 engine.rs 测试基准同值）
    const T0: u64 = 1_786_276_800_000;

    /// PushAwareEmitter 集成：emit = 转发原通道（行为不变）+ 旁路分发
    /// （在线设备收到直推，载荷为 events.push 帧 body 形状）
    #[test]
    fn emitter_forwards_and_delivers_online() {
        let inner = Arc::new(RecordingEmitter::default());
        let presence = Arc::new(MemoryPresenceSource::new());
        presence.set_devices(vec![device_activity("tok-a", "手机 A", T0 - 1_000)]);
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = Arc::new(PushDispatcher::new(
            presence,
            Arc::clone(&channel) as Arc<dyn PushChannel>,
        ));
        let emitter = PushAwareEmitter::with_clock(
            Arc::clone(&inner) as Arc<dyn Emitter>,
            dispatcher,
            Box::new(|| T0),
        );

        let payload = envelope_payload(run_failed_event(), Some("run-42"), Some(7));
        emitter.emit("workbench-run-event", &payload);

        // 1. 转发原通道：同一 channel + 载荷
        let calls = inner.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "workbench-run-event");
        assert_eq!(calls[0].1, payload);

        // 2. 旁路分发：在线设备收到直推（events.push 载荷形状）
        let sent = channel.sent();
        assert_eq!(sent.len(), 1, "在线设备收到直推");
        assert_eq!(sent[0].0, "tok-a");
        assert_eq!(sent[0].1.event_type, "run-terminal");
        assert_eq!(
            sent[0].1.dedupe_key, "run-terminal:run-42:failed",
            "S4 去重键含 :failed 后缀（M8 §3.4.1 表）"
        );
        assert_eq!(sent[0].1.target.params["runId"], "run-42");
        assert_eq!(WS_PUSH_KIND, "events.push");
    }

    /// P3 事件（task-output）：决策不产出 → 无直推无 pending（噪音不进
    /// 推送管线）
    #[test]
    fn emitter_ignores_noise_events() {
        let inner = Arc::new(RecordingEmitter::default());
        let presence = Arc::new(MemoryPresenceSource::new());
        presence.set_devices(vec![device_activity("tok-a", "手机 A", T0 - 1_000)]);
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = Arc::new(PushDispatcher::new(
            presence,
            Arc::clone(&channel) as Arc<dyn PushChannel>,
        ));
        let emitter = PushAwareEmitter::with_clock(
            Arc::clone(&inner) as Arc<dyn Emitter>,
            dispatcher,
            Box::new(|| T0),
        );

        emitter.emit("workbench-run-event", &envelope_payload(noise_event(), Some("run-42"), Some(8)));
        assert_eq!(inner.calls().len(), 1, "转发照常");
        assert!(channel.sent().is_empty(), "P3 噪音不推");
        assert_eq!(emitter.dispatcher.pending_len(), 0);
    }

    /// 离线设备经 emitter 全链：事件 → 决策 → 离线标记 pending
    #[test]
    fn emitter_marks_offline_pending() {
        let inner = Arc::new(RecordingEmitter::default());
        let presence = Arc::new(MemoryPresenceSource::new());
        presence.set_devices(vec![device_activity("tok-b", "手机 B", T0 - 120_000)]);
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = Arc::new(PushDispatcher::new(
            presence,
            Arc::clone(&channel) as Arc<dyn PushChannel>,
        ));
        let emitter = PushAwareEmitter::with_clock(
            Arc::clone(&inner) as Arc<dyn Emitter>,
            dispatcher,
            Box::new(|| T0),
        );

        emitter.emit("workbench-run-event", &envelope_payload(run_failed_event(), Some("run-42"), Some(9)));
        assert!(channel.sent().is_empty(), "离线设备不直推");
        let pending = emitter.dispatcher.take_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].device_key, "tok-b");
        assert_eq!(pending[0].message.dedupe_key, "run-terminal:run-42:failed");
    }

    /// 非法载荷（非事件 JSON）：fail-closed 跳过，不 panic、不转发异常
    #[test]
    fn emitter_skips_invalid_payload() {
        let inner = Arc::new(RecordingEmitter::default());
        let presence = Arc::new(MemoryPresenceSource::new());
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = Arc::new(PushDispatcher::new(
            presence,
            Arc::clone(&channel) as Arc<dyn PushChannel>,
        ));
        let emitter = PushAwareEmitter::with_clock(
            Arc::clone(&inner) as Arc<dyn Emitter>,
            dispatcher,
            Box::new(|| T0),
        );

        emitter.emit("workbench-run-event", "{ 不是 JSON");
        assert_eq!(inner.calls().len(), 1, "转发照常（发射不因旁路失败受影响）");
        assert!(channel.sent().is_empty());
        assert_eq!(emitter.dispatcher.pending_len(), 0);
    }

    /// flush：周期 drain 产出合并桶并分发（cron 累积 → 到点合并直推）
    #[test]
    fn flush_drains_coalesced_buckets() {
        let inner = Arc::new(RecordingEmitter::default());
        let presence = Arc::new(MemoryPresenceSource::new());
        // 设备在 flush 时刻（T0 + 601s）仍在线（1s 前活动）；emit 阶段
        // 该时刻在未来 → saturating_sub 收敛在线，两阶段判定一致
        presence.set_devices(vec![device_activity("tok-a", "手机 A", T0 + 600_000)]);
        let channel = Arc::new(RecordingChannel::new());
        let dispatcher = Arc::new(PushDispatcher::new(
            presence,
            Arc::clone(&channel) as Arc<dyn PushChannel>,
        ));
        let emitter = PushAwareEmitter::with_clock(
            Arc::clone(&inner) as Arc<dyn Emitter>,
            dispatcher,
            Box::new(|| T0),
        );

        // 入桶（cron 累积族）：事件不立即产出决策
        let cron = |iteration: u64| {
            AgentEvent::CronFired {
                session_id: "s-7".to_string(),
                cron_id: "cron-2".to_string(),
                prompt: "日报".to_string(),
                expression: "0 9 * * *".to_string(),
                iteration,
                fired_at_ms: T0,
            }
        };
        emitter.emit("workbench-run-event", &envelope_payload(cron(1), None, Some(1)));
        emitter.emit("workbench-run-event", &envelope_payload(cron(2), None, Some(2)));
        assert!(channel.sent().is_empty(), "窗口内不出桶");

        // drain 到点 → 合并产出 + 在线直推
        emitter.flush(T0 + 601_000);
        let sent = channel.sent();
        assert_eq!(sent.len(), 1, "合并桶 flush 产出直推");
        // 合并键时间戳 = **入桶时刻**（引擎 decide 时的墙钟），不是事件体
        // fired_at_ms（引擎按 arrived_at_ms = now_ms 入桶，见 engine.rs
        // pending_from）——此处只断言前缀（键形状），不绑定具体时刻
        assert!(
            sent[0].1.dedupe_key.starts_with("merged:cron-fired:cron-2:"),
            "合并键 = merged:cron-fired:cron-2:<入桶时刻>（实际：{}）",
            sent[0].1.dedupe_key
        );
    }

    /// parse_event_payload：信封 runId/sequence 提取
    #[test]
    fn parse_payload_extracts_envelope_fields() {
        let payload = envelope_payload(run_failed_event(), Some("run-9"), Some(42));
        let (event, run_id, sequence) = parse_event_payload(&payload).expect("可解析");
        assert_eq!(event.type_name(), "run-terminal");
        assert_eq!(run_id.as_deref(), Some("run-9"));
        assert_eq!(sequence, Some(42));

        // runId 缺省（timer/cron 域事件）→ None
        let cron = envelope_payload(
            AgentEvent::TimerFired {
                session_id: "s-7".to_string(),
                timer_id: "timer-1".to_string(),
                prompt: "检查".to_string(),
                fired_at_ms: now_ms(),
            },
            None,
            Some(5),
        );
        let (_, run_id, sequence) = parse_event_payload(&cron).expect("可解析");
        assert_eq!(run_id, None);
        assert_eq!(sequence, Some(5));
    }
}
