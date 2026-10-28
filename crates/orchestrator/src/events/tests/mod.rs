use std::sync::Arc;
use std::time::{Duration, Instant};

use conex_types::events::{AgentEventEnvelope, RunTerminalStatus};
use conex_types::message::AgentMessageBlock;
use conex_types::session::AgentEndReason;
use session_loop::RunOutcome;

use super::*;
use crate::persist::{InMemoryStore, LocalDbStore, Store};
use crate::run::{
    CancelMode, CancelPath, RunEngine, RunError, RunManager, EVENT_STORE_WRITE_FAILED_REASON,
};

// ── 测试替身 ──

/// 测试引擎（记录协作停止与强制中断调用）
struct TestEngine {
    cooperative_supported: bool,
    cooperative_calls: Arc<std::sync::Mutex<Vec<String>>>,
    abort_calls: Arc<std::sync::Mutex<Vec<String>>>,
}

impl TestEngine {
    fn new(cooperative_supported: bool) -> Self {
        Self {
            cooperative_supported,
            cooperative_calls: Arc::new(std::sync::Mutex::new(Vec::new())),
            abort_calls: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    fn cooperative_calls(&self) -> Vec<String> {
        self.cooperative_calls.lock().unwrap().clone()
    }

    fn abort_calls(&self) -> Vec<String> {
        self.abort_calls.lock().unwrap().clone()
    }
}

impl RunEngine for TestEngine {
    fn request_cooperative_stop(&self, reason: &str) -> bool {
        if !self.cooperative_supported {
            return false;
        }
        self.cooperative_calls
            .lock()
            .unwrap()
            .push(reason.to_string());
        true
    }

    fn abort(&self, reason: &str) {
        self.abort_calls.lock().unwrap().push(reason.to_string());
    }
}

/// 会话环境（内存 store 具体句柄 + 共享 trait 对象）
fn setup() -> (Arc<InMemoryStore>, Arc<dyn Store>) {
    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    (mem, store)
}

fn ts() -> String {
    conex_shared::time::now_iso_utc()
}

fn agent_start() -> AgentEvent {
    AgentEvent::AgentStart {
        session_id: "s1".to_string(),
        timestamp: ts(),
    }
}

fn agent_end(reason: AgentEndReason) -> AgentEvent {
    AgentEvent::AgentEnd {
        session_id: "s1".to_string(),
        timestamp: ts(),
        reason,
        error: None,
    }
}

fn message_delta(index: u64) -> AgentEvent {
    AgentEvent::MessageDelta {
        session_id: "s1".to_string(),
        timestamp: ts(),
        message_id: "m1".to_string(),
        block: AgentMessageBlock::Text {
            text: format!("chunk-{index}"),
        },
    }
}

fn message_end() -> AgentEvent {
    AgentEvent::MessageEnd {
        session_id: "s1".to_string(),
        message: std::sync::Arc::new(conex_types::message::AgentMessage {
            id: "m1".to_string(),
            role: conex_types::message::AgentMessageRole::Assistant,
            created_at: ts(),
            blocks: vec![AgentMessageBlock::Text {
                text: "full".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        }),
        turn_index: None,
    }
}

fn outcome(reason: AgentEndReason, events: Vec<AgentEvent>) -> RunOutcome {
    RunOutcome {
        reason: reason.into(),
        error: if reason == AgentEndReason::Error {
            Some("provider 调用失败".to_string())
        } else {
            None
        },
        diagnostic: None,
        messages: Vec::new(),
        events,
        turn_index: 0,
        tool_call_count: 0,
        steering_count: 0,
        // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
        cache_stats: None,
        yield_payload: None,
        // D1：provider 错误摘要（本构造点非 fatal 收场 → None，缺省向后兼容）
        provider_error: None,
    }
}

fn terminal_count(events: &[SequencedEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::RunTerminal { .. }))
        .count()
}

mod envelope_freeze;
mod queue_sequencing;
mod run_lifecycle;
mod sequence_reserve;
mod session_compression;
