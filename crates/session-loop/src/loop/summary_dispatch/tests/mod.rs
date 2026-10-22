use super::run::{jittered_ms, run_summary_task_with_abort};
use super::*;
use crate::safe_point::AbortSignal;
use conex_compaction::summary_document::validate_summary_document;
use conex_compaction::{recovery::SummaryState, Summarizer};
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use std::sync::Arc;
use std::time::Duration;

mod background_blocking;
mod config_gate;
mod dispatch_retry;

fn dropped_messages() -> Vec<AgentMessage> {
    vec![AgentMessage {
        id: "m0".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T10:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "被丢弃内容".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }]
}

/// 合法 Schema V1 JSON 文档（R-G 新契约示例）
fn valid_json(block_id: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "blockId": block_id,
        "generation": 1,
        "droppedIds": [],
        "height": 1,
        "tier": "chunk",
        "goal": "修复构建",
        "constraints": [],
        "progress": ["编译通过"],
        "decisions": [],
        "nextSteps": ["运行测试"],
        "criticalContext": ["cargo build"],
    })
    .to_string()
}

fn task_with(summarizer: Arc<dyn Summarizer>, block_id: &str) -> SummaryDispatchTask {
    SummaryDispatchTask {
        session_id: "s1".to_string(),
        block_id: block_id.to_string(),
        generation: 1,
        dropped: dropped_messages(),
        existing: None,
        max_bytes: 4096,
        summarizer,
    }
}

fn fast_config() -> SummaryDispatchConfig {
    SummaryDispatchConfig {
        backoff_ms: vec![1, 1, 1],
        jitter: 0.0,
        max_wall_ms: 5_000,
        max_attempts: 4,
    }
}

/// 记录调用（次数 + 每次入参）+ 可配置返回
struct RecordingSummarizer {
    calls: std::sync::Mutex<Vec<(Vec<String>, Option<String>)>>,
    result: std::sync::Mutex<Result<String, String>>,
}
impl Summarizer for RecordingSummarizer {
    fn summarize(
        &self,
        dropped: &[AgentMessage],
        existing: Option<&str>,
    ) -> Result<String, String> {
        self.calls.lock().unwrap().push((
            dropped.iter().map(|m| m.id.clone()).collect(),
            existing.map(str::to_string),
        ));
        self.result.lock().unwrap().clone()
    }
}

fn meta_map<'a>(entries: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |key: &str| {
        entries
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.to_string())
    }
}

/// 记录型 summary-background sink（测试断言面）
struct RecordingSummarySink {
    events: std::sync::Mutex<Vec<AgentEvent>>,
}
impl RecordingSummarySink {
    fn new() -> Self {
        Self {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }
    fn events(&self) -> Vec<AgentEvent> {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
impl SummaryBackgroundSink for RecordingSummarySink {
    fn emit(&self, event: &AgentEvent) {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event.clone());
    }
}

/// 提取 summary-background 事件序列（phase, attempt, reason）
fn summary_phases(events: &[AgentEvent]) -> Vec<(String, u32, Option<String>)> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::SummaryBackground {
                phase,
                attempt,
                reason,
                ..
            } => Some((phase.clone(), *attempt, reason.clone())),
            _ => None,
        })
        .collect()
}
