//! fanout 测试共享基建（fanout.rs 拆分）：发射器替身与事件构造。

use std::sync::Mutex as StdMutex;

use conex_types::events::AgentEventEnvelope;

use super::super::*;

/// 测试发射器：记录 (channel, payload) 序列（不依赖 Tauri runtime）
#[derive(Default)]
pub(super) struct RecordingEmitter {
    calls: StdMutex<Vec<(String, String)>>,
}

impl RecordingEmitter {
    pub(super) fn calls(&self) -> Vec<(String, String)> {
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
pub(super) struct PanickingEmitter;

impl Emitter for PanickingEmitter {
    fn emit(&self, _channel: &str, _payload: &str) {
        panic!("测试用发射器故障");
    }
}

/// 构造信封 JSON payload（信封注入 runId/sequence；sessionId 来自事件体）
pub(super) fn payload_of(event: AgentEvent, sequence: Option<u64>) -> String {
    let envelope = AgentEventEnvelope::new(event, Some("r1".to_string()), sequence);
    serde_json::to_string(&envelope).expect("信封必须可序列化")
}

/// Critical 事件（agent-start，最简构造）
pub(super) fn agent_start(session_id: &str) -> AgentEvent {
    AgentEvent::AgentStart {
        session_id: session_id.to_string(),
        timestamp: "2026-01-01T00:00:00.000Z".to_string(),
    }
}

/// Critical 事件（task-completed，任务域终态）
pub(super) fn task_completed(session_id: &str) -> AgentEvent {
    AgentEvent::TaskCompleted {
        session_id: session_id.to_string(),
        task_id: "t1".to_string(),
        exit_code: 0,
        duration_ms: 1_000,
        line_count: 3,
    }
}

/// Delta 事件（task-output，任务输出增量可丢）
pub(super) fn task_output(session_id: &str) -> AgentEvent {
    AgentEvent::TaskOutput {
        session_id: session_id.to_string(),
        task_id: "t1".to_string(),
        line: Some("输出行".to_string()),
        chunk: None,
        line_count: None,
    }
}

/// Soft 事件（task-suspicious，尽力投递）
pub(super) fn task_suspicious(session_id: &str) -> AgentEvent {
    AgentEvent::TaskSuspicious {
        session_id: session_id.to_string(),
        task_id: "t1".to_string(),
        silence_ms: 5_000,
        last_output_at_ms: 1_000,
    }
}

/// 取空队列（测试断言用）
pub(super) fn drain(rx: &FanoutReceiver) -> Vec<QueuedEvent> {
    let mut events = Vec::new();
    while let Some(event) = rx.try_recv() {
        events.push(event);
    }
    events
}

pub(super) fn session_sub(sessions: &[&str]) -> SubscriptionFilter {
    SubscriptionFilter::session_subscribe(sessions.iter().map(|s| s.to_string()))
}
