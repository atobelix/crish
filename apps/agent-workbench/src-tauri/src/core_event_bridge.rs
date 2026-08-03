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

use std::sync::Arc;

use conex_types::events::AgentEventEnvelope;

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
}

impl EventBridge {
    /// 新建事件桥（通道名 + 发射器）
    pub fn new(channel: impl Into<String>, emitter: Arc<dyn Emitter>) -> Self {
        Self {
            channel: Arc::from(channel.into()),
            emitter,
        }
    }

    /// 序列化信封（缓冲层在入队时即序列化，flush 直接发射字符串，AA-06 P9）
    ///
    /// 失败返回 None（信封内容不可序列化属防御性异常，记录后跳过）。
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
    ///
    /// G11a 备注：非 test 构建无 bin 消费者（生产路径经
    /// BufferedRunEventBridge::flush → emit_payload），本方法为测试直接覆盖的
    /// 信封直发 API（payload_is_flat_top_level_envelope_json 等断言）——dead_code 静音。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn emit_envelope(&self, envelope: &AgentEventEnvelope) -> EmitReport {
        match self.serialize(envelope) {
            Some(payload) => self.emit_payload(&payload),
            None => EmitReport::default(),
        }
    }

    /// 发射已序列化载荷（[crate::engine::BufferedRunEventBridge::flush] 复用；
    /// 顶层 JSON 不做二次包装）
    pub fn emit_payload(&self, payload: &str) -> EmitReport {
        self.emitter.emit(&self.channel, payload);
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
}
