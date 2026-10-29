//! push pusher 测试（pusher.rs 拆分）：分发器直推/待发与 Emitter 装饰器。

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
    fn send(&self, device_key: &str, message: &PushMessage) -> Result<(), PushChannelError> {
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

/// requeue_pending：厂商消费分拣后的保留条目重新入队（顺序保持）
#[test]
fn requeue_pending_restores_queue() {
    let (dispatcher, _) = dispatcher_with(vec![device_activity(
        "tok-b",
        "手机 B",
        1_784_078_400_000 - 60_000,
    )]);
    dispatcher.dispatch(&decision(true), 1_784_078_400_000);
    let pending = dispatcher.take_pending();
    assert_eq!(pending.len(), 1);
    assert_eq!(dispatcher.pending_len(), 0, "取走后清空");

    dispatcher.requeue_pending(pending);
    assert_eq!(dispatcher.pending_len(), 1, "保留条目重新入队");
    let restored = dispatcher.take_pending();
    assert_eq!(restored[0].device_key, "tok-b");
    assert_eq!(restored[0].message.id, "push-000001", "条目原样保留");
    assert_eq!(restored[0].marked_at_ms, 1_784_078_400_000);
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
    assert_eq!(
        ids,
        ["push-000001", "push-000002", "push-000003", "push-000004"]
    );
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

    emitter.emit(
        "workbench-run-event",
        &envelope_payload(noise_event(), Some("run-42"), Some(8)),
    );
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

    emitter.emit(
        "workbench-run-event",
        &envelope_payload(run_failed_event(), Some("run-42"), Some(9)),
    );
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
    let cron = |iteration: u64| AgentEvent::CronFired {
        session_id: "s-7".to_string(),
        cron_id: "cron-2".to_string(),
        prompt: "日报".to_string(),
        expression: "0 9 * * *".to_string(),
        iteration,
        fired_at_ms: T0,
    };
    emitter.emit(
        "workbench-run-event",
        &envelope_payload(cron(1), None, Some(1)),
    );
    emitter.emit(
        "workbench-run-event",
        &envelope_payload(cron(2), None, Some(2)),
    );
    assert!(channel.sent().is_empty(), "窗口内不出桶");

    // drain 到点 → 合并产出 + 在线直推
    emitter.flush(T0 + 601_000);
    let sent = channel.sent();
    assert_eq!(sent.len(), 1, "合并桶 flush 产出直推");
    // 合并键时间戳 = **入桶时刻**（引擎 decide 时的墙钟），不是事件体
    // fired_at_ms（引擎按 arrived_at_ms = now_ms 入桶，见 engine.rs
    // pending_from）——此处只断言前缀（键形状），不绑定具体时刻
    assert!(
        sent[0]
            .1
            .dedupe_key
            .starts_with("merged:cron-fired:cron-2:"),
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
