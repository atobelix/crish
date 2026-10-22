use std::sync::Arc;

use conex_telemetry::cache::{CacheAccountingKind, CacheUsageScalars};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use super::tracker::CacheStatsTracker;
use crate::provider::ToolSchema;

pub(super) fn msg(
    id: &str,
    role: AgentMessageRole,
    text: &str,
    created_at: &str,
) -> Arc<AgentMessage> {
    Arc::new(AgentMessage {
        id: id.to_string(),
        role,
        created_at: created_at.to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: Some(serde_json::json!({ "usage": { "promptTokens": 100 } })),
        client_message_id: Some("cm".to_string()),
        content: Some(text.to_string()),
    })
}

pub(super) fn tools() -> Vec<ToolSchema> {
    vec![ToolSchema {
        name: "t1".to_string(),
        description: "测试工具".to_string(),
        input_schema: serde_json::json!({ "type": "object" }),
    }]
}

pub(super) fn scalars(prompt: u64, read: u64, write: u64, miss: Option<u64>) -> CacheUsageScalars {
    CacheUsageScalars {
        prompt,
        read,
        write,
        miss,
        accounting: CacheAccountingKind::Included,
    }
}

pub(super) fn tracker(ttl: u64) -> CacheStatsTracker {
    CacheStatsTracker::new("deepseek", "deepseek-v4-flash").with_ttl(ttl)
}

mod attribution;
mod cold_cache;
mod compaction;
mod run_stats;
mod signature;
