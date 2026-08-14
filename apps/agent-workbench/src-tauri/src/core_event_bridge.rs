//! 事件发射桥（B6.3：workbench-run-event 事件通道）
//!
//! 本模块刻意保持**零 crate:: 内部引用**（AA-02 注记：可经 #[path] 独立编译
//! 测试），只承担「信封序列化 + 发射到事件通道」这一层职责：
//! - [Emitter]：发射抽象（Tauri 事件通道 / 测试替身）；
//! - [TauriEmitter]：`app.emit("workbench-run-event", payload)`（03 §3.1）；
//! - [EventBridge]：信封 → 序列化 → [Emitter]，emit 载荷为完整事件 JSON
//!   顶层 `{type, runId, sequence, schemaVersion, sessionId, ...事件字段}`
//!   （03 §3.1:190-191，逐字透传不做二次包装）。
//!
//! 职责分工：按 runId 的背压缓冲与丢帧策略在 `buffer.rs`（[crate::buffer]）；
//! 缓冲 + 序列化 + 发射的组装在 `engine.rs` 的
//! [crate::engine::BufferedRunEventBridge]（P9：入队时即序列化，flush 直接
//! emit 字符串，AA-06 §1.3）。
//!
//! 载荷形状：信封 [conex_types::events::AgentEventEnvelope] 序列化为扁平
//! 顶层 JSON（runId / sequence / schemaVersion 由信封注入，03 §5.3-2/6）。

use std::sync::{Arc, Mutex};

use conex_types::events::{AgentEvent, AgentEventEnvelope};

/// 一次发射的报告（S-8 修复：背压丢帧可观测，AA-02 W-2 / PE-04 T04.2-3）
///
/// - `emitted`：实际发射到事件通道的条数；
/// - `buffered`：仍在缓冲中待发的条数；
/// - `dropped`：因背压被丢弃的条数（Delta 类目可丢，03 §5.3-6）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EmitReport {
    /// 已发射条数
    pub emitted: usize,
    /// 缓冲中待发条数
    pub buffered: usize,
    /// 被丢弃条数（Soft 水位优先丢 Delta）
    pub dropped: usize,
}

impl EmitReport {
    /// 合并另一份报告（多次发射累计用）
    pub fn add(&mut self, other: EmitReport) {
        self.emitted += other.emitted;
        self.buffered += other.buffered;
        self.dropped += other.dropped;
    }
}

/// 事件发射抽象（Tauri 事件通道 / 测试替身）
///
/// payload 为**已序列化**的完整事件 JSON 字符串；发射失败由实现方自行
/// 兜底（TauriEmitter 忽略发射错误，事件通道尽力而为）。
pub trait Emitter: Send + Sync {
    /// 发射一条已序列化的事件载荷到指定通道
    fn emit(&self, channel: &str, payload: &str);
}

/// 事件旁路监听抽象（如 TimerRegistry 早退唤醒 / 状态跟踪）
pub trait EventListener: Send + Sync {
    /// 收到事件时触发（实现方可处理同步逻辑或在需要时触发异步早退）
    fn on_event(&self, event: &AgentEvent);
}

/// 基于闭包的事件监听器
pub struct FnEventListener<F: Fn(&AgentEvent) + Send + Sync>(pub F);

impl<F: Fn(&AgentEvent) + Send + Sync> EventListener for FnEventListener<F> {
    fn on_event(&self, event: &AgentEvent) {
        (self.0)(event);
    }
}

/// Tauri 事件通道实现：`app.emit(channel, payload)`（03 §3.1）
pub struct TauriEmitter {
    app: tauri::AppHandle,
}

impl TauriEmitter {
    /// 用应用句柄构造（main.rs 接线时传入 `app.handle().clone()`）
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl Emitter for TauriEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        use tauri::Emitter as _;
        // 发射失败（webview 未就绪等）仅记录，不阻断 run 流程
        if let Err(error) = self.app.emit(channel, payload) {
            tracing::warn!(
                target: "event_bridge",
                channel,
                error = %error,
                "事件通道发射失败（尽力而为）"
            );
        }
    }
}

/// 旁路监听槽（内部可变：EventBridge 共享形态下运行期挂接 TimerRegistry 或其他监听器）
#[derive(Default)]
struct ListenerSlot {
    inner: Mutex<Vec<Arc<dyn EventListener>>>,
}

impl ListenerSlot {
    fn get_all(&self) -> Vec<Arc<dyn EventListener>> {
        match self.inner.lock() {
            Ok(slot) => slot.clone(),
            Err(_) => Vec::new(),
        }
    }

    fn add(&self, listener: Arc<dyn EventListener>) {
        if let Ok(mut slot) = self.inner.lock() {
            slot.push(listener);
        }
    }
}

/// 事件桥：信封序列化 + 发射（B6.3）
///
/// 共享形态（[Clone] 为 Arc 引用）：跨 run 复用同一桥（每 run 经
/// [crate::engine::BufferedRunEventBridge] 组装背压缓冲）。
#[derive(Clone)]
pub struct EventBridge {
    /// 事件通道名（恒 workbench-run-event，03 §3.1）
    channel: Arc<str>,
    /// 发射器（Tauri 通道 / 测试替身）
    emitter: Arc<dyn Emitter>,
    /// 跨端扇出槽（R1-01：可选订阅者；未装配时零开销）
    fanout: Arc<FanoutSlot>,
    /// 旁路监听器槽（TimerRegistry 早退 / 状态观测；未装配时零开销）
    listeners: Arc<ListenerSlot>,
}

/// 跨端扇出槽（内部可变：EventBridge 共享形态下运行期挂接 FanOutEmitter）
///
/// 保持本模块「零 crate:: 内部引用」纪律（AA-02：可经 #[path] 独立编译
/// 测试）：槽位类型为既有 [Emitter] trait 对象，FanOutEmitter
/// （[crate::server::fanout]）实现该 trait 后在装配点挂入；未挂接（None）
/// 时 emit_payload 仅多一次判空，服务未启动零开销。
#[derive(Default)]
struct FanoutSlot {
    inner: Mutex<Option<Arc<dyn Emitter>>>,
}

impl FanoutSlot {
    /// 读取当前扇出器（无则 None）
    fn get(&self) -> Option<Arc<dyn Emitter>> {
        match self.inner.lock() {
            Ok(slot) => slot.clone(),
            Err(_) => None,
        }
    }

    /// 挂接扇出器（幂等：重复挂接覆盖旧值）
    #[cfg_attr(not(test), allow(dead_code))]
    fn set(&self, fanout: Arc<dyn Emitter>) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = Some(fanout);
        }
    }
}

impl EventBridge {
    /// 新建事件桥（通道名 + 发射器；跨端扇出与旁路监听默认未挂接）
    pub fn new(channel: impl Into<String>, emitter: Arc<dyn Emitter>) -> Self {
        Self {
            channel: Arc::from(channel.into()),
            emitter,
            fanout: Arc::new(FanoutSlot::default()),
            listeners: Arc::new(ListenerSlot::default()),
        }
    }

    /// 挂接跨端扇出器（R1-01：FanOutEmitter，见 server/fanout.rs）。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn attach_fanout(&self, fanout: Arc<dyn Emitter>) {
        self.fanout.set(fanout);
    }

    /// 挂接旁路事件监听器（如 TimerRegistry::on_event 早退唤醒）
    #[allow(dead_code)]
    pub fn attach_listener(&self, listener: Arc<dyn EventListener>) {
        self.listeners.add(listener);
    }

    /// 挂接基于闭包的旁路事件监听器
    #[allow(dead_code)]
    pub fn attach_fn_listener<F: Fn(&AgentEvent) + Send + Sync + 'static>(&self, f: F) {
        self.listeners.add(Arc::new(FnEventListener(f)));
    }

    /// 通知所有旁路监听器
    pub fn notify_event(&self, event: &AgentEvent) {
        for listener in self.listeners.get_all() {
            listener.on_event(event);
        }
    }

    /// 序列化信封（缓冲层在入队时即序列化，flush 直接发射字符串，AA-06 P9）
    pub fn serialize(&self, envelope: &AgentEventEnvelope) -> Option<String> {
        match serde_json::to_string(envelope) {
            Ok(payload) => Some(payload),
            Err(error) => {
                tracing::error!(
                    target: "event_bridge",
                    error = %error,
                    event_type = %envelope.type_name(),
                    "事件信封序列化失败（跳过发射）"
                );
                None
            }
        }
    }

    /// 序列化信封并发射（完整事件 JSON 载荷，03 §3.1）。
    /// 同时旁路广播至所有注册的 EventListener（如 TimerRegistry::on_event）
    pub fn emit_envelope(&self, envelope: &AgentEventEnvelope) -> EmitReport {
        self.notify_event(&envelope.event);
        match self.serialize(envelope) {
            Some(payload) => self.emit_payload(&payload),
            None => EmitReport::default(),
        }
    }

    /// 发射已序列化载荷（[crate::engine::BufferedRunEventBridge::flush] 复用；
    /// 顶层 JSON 不做二次包装）
    pub fn emit_payload(&self, payload: &str) -> EmitReport {
        self.emitter.emit(&self.channel, payload);
        // 跨端扇出（R1-01）：可选订阅者——未挂接（服务未启动）时零开销；
        if let Some(fanout) = self.fanout.get() {
            fanout.emit(&self.channel, payload);
        }
        EmitReport {
            emitted: 1,
            buffered: 0,
            dropped: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use conex_types::events::{AgentEvent, AgentEventEnvelope};

    use super::*;

    /// 测试发射器：记录 (channel, payload) 序列
    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<(String, String)>>,
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

    /// 构造测试桥（记录发射器 + 通道名）
    fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new("workbench-run-event", Arc::clone(&emitter) as Arc<dyn Emitter>);
        (bridge, emitter)
    }

    fn envelope() -> AgentEventEnvelope {
        AgentEventEnvelope::new(
            AgentEvent::AgentStart {
                session_id: "s1".to_string(),
                timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            },
            Some("r1".to_string()),
            Some(3),
        )
    }

    /// 载荷为完整事件 JSON：顶层 {type, runId, sequence, schemaVersion, ...事件字段}，
    /// 不做二次包装（03 §3.1 验收）
    #[test]
    fn payload_is_flat_top_level_envelope_json() {
        let (bridge, emitter) = recording_bridge();
        let report = bridge.emit_envelope(&envelope());
        assert_eq!(
            report,
            EmitReport {
                emitted: 1,
                buffered: 0,
                dropped: 0,
            }
        );
        let calls = emitter.calls();
        assert_eq!(calls.len(), 1);
        let (channel, payload) = &calls[0];
        assert_eq!(channel, "workbench-run-event");
        let value: serde_json::Value = serde_json::from_str(payload).expect("载荷为合法 JSON");
        let map = value.as_object().expect("顶层为 JSON 对象");
        assert_eq!(map["type"], "agent-start");
        assert_eq!(map["runId"], "r1");
        assert_eq!(map["sequence"], 3);
        assert_eq!(map["schemaVersion"], 1);
        assert_eq!(map["sessionId"], "s1");
        assert_eq!(map["timestamp"], "2026-01-01T00:00:00.000Z");
    }

    /// 序列化可复用（P9）：serialize 与 emit_envelope 载荷逐字节一致
    #[test]
    fn serialize_matches_emit_envelope_payload() {
        let (bridge, emitter) = recording_bridge();
        let serialized = bridge.serialize(&envelope()).expect("序列化成功");
        let report = bridge.emit_envelope(&envelope());
        assert_eq!(report.emitted, 1);
        assert_eq!(emitter.calls()[0].1, serialized);
    }

    /// 报告合并（多次发射累计）
    #[test]
    fn emit_report_adds() {
        let mut report = EmitReport::default();
        report.add(EmitReport {
            emitted: 2,
            buffered: 1,
            dropped: 1,
        });
        report.add(EmitReport {
            emitted: 1,
            buffered: 0,
            dropped: 0,
        });
        assert_eq!(
            report,
            EmitReport {
                emitted: 3,
                buffered: 1,
                dropped: 1,
            }
        );
    }

    /// 挂接扇出后双通道发射
    #[test]
    fn attach_fanout_routes_same_payload() {
        let (bridge, emitter) = recording_bridge();
        let fanout = Arc::new(RecordingEmitter::default());
        bridge.attach_fanout(Arc::clone(&fanout) as Arc<dyn Emitter>);

        let report = bridge.emit_envelope(&envelope());
        assert_eq!(report.emitted, 1);
        assert_eq!(emitter.calls().len(), 1, "原通道照常发射");
        assert_eq!(fanout.calls().len(), 1, "扇出通道应收到同一条事件");
        assert_eq!(emitter.calls()[0], fanout.calls()[0], "双通道载荷逐字节一致");
    }

    /// §6.1 旁路事件监听器接线测试（如 TimerRegistry::on_event 早退唤醒）
    #[test]
    fn attach_listener_receives_bypass_events() {
        let (bridge, _emitter) = recording_bridge();
        let received_events = Arc::new(Mutex::new(Vec::new()));
        let recv_clone = Arc::clone(&received_events);

        bridge.attach_fn_listener(move |event| {
            recv_clone.lock().unwrap().push(event.clone());
        });

        let env = envelope();
        bridge.emit_envelope(&env);

        let events = received_events.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], AgentEvent::AgentStart { .. }));
    }

    /// 多个监听器同时接收旁路广播
    #[test]
    fn multiple_listeners_receive_broadcast() {
        let (bridge, _emitter) = recording_bridge();
        let counter1 = Arc::new(Mutex::new(0usize));
        let counter2 = Arc::new(Mutex::new(0usize));

        let c1 = Arc::clone(&counter1);
        bridge.attach_fn_listener(move |_| {
            *c1.lock().unwrap() += 1;
        });

        let c2 = Arc::clone(&counter2);
        bridge.attach_fn_listener(move |_| {
            *c2.lock().unwrap() += 1;
        });

        bridge.emit_envelope(&envelope());
        bridge.emit_envelope(&envelope());

        assert_eq!(*counter1.lock().unwrap(), 2);
        assert_eq!(*counter2.lock().unwrap(), 2);
    }
}

