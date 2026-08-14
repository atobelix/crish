#![allow(dead_code)]

use std::sync::Arc;
use conex_types::{
    AgentMessage, AgentMessageBlock, AgentMessageRole, Message, ToolCallBlock, ToolOutput,
};

pub fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

pub fn thought_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Thought {
        text: text.to_string(),
        redacted: None,
    }
}

pub fn tool_call_block(id: &str, tool_name: &str, input: serde_json::Value) -> AgentMessageBlock {
    AgentMessageBlock::ToolCall(ToolCallBlock {
        id: id.to_string(),
        tool_name: tool_name.to_string(),
        input,
    })
}

pub fn tool_result_block(id: &str, tool_name: &str, output: &str) -> AgentMessageBlock {
    AgentMessageBlock::ToolResult {
        tool_call_id: id.to_string(),
        tool_name: tool_name.to_string(),
        output: ToolOutput::text(output),
        is_error: false,
    }
}

pub fn amsg(
    id: &str,
    role: AgentMessageRole,
    created_at: &str,
    blocks: Vec<AgentMessageBlock>,
    metadata: Option<serde_json::Value>,
) -> Arc<AgentMessage> {
    Arc::new(AgentMessage {
        id: id.to_string(),
        role,
        created_at: created_at.to_string(),
        blocks,
        metadata,
        client_message_id: None,
        content: None,
    })
}

pub fn usage_msg(id: &str, created_at: &str, input_total: u64, text: &str) -> Arc<AgentMessage> {
    amsg(
        id,
        AgentMessageRole::Assistant,
        created_at,
        vec![text_block(text)],
        Some(serde_json::json!({
            "stopReason": "stop",
            "usage": {
                "promptTokens": input_total,
                "completionTokens": 10,
                "totalTokens": input_total + 10,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
            },
            "cacheBreakdown": {
                "read": 0,
                "write": 0,
                "miss": input_total,
                "inputTotal": input_total,
            },
        })),
    )
}

pub fn msg(id: &str, role: &str, content: &str) -> Message {
    Message {
        id: id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        images: None,
    }
}

pub fn summary_doc_json(goal: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "blockId": "unused",
        "generation": 1,
        "droppedIds": [],
        "height": 1,
        "tier": "chunk",
        "goal": goal,
        "constraints": [],
        "progress": [],
        "decisions": [],
        "nextSteps": [],
        "criticalContext": "",
    })
    .to_string()
}

pub fn first_compaction_fixture() -> (conex_compaction::CompactionEngine, Vec<Arc<AgentMessage>>) {
    let engine = conex_compaction::CompactionEngine::new(0);
    let messages = vec![
        amsg(
            "s1",
            AgentMessageRole::System,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("system prompt")],
            None,
        ),
        amsg(
            "u1",
            AgentMessageRole::User,
            "2026-08-03T10:00:01.000Z",
            vec![text_block(&"long user one".repeat(50))],
            None,
        ),
        amsg(
            "a1",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block(&"long asst one".repeat(50))],
            None,
        ),
        amsg(
            "u2",
            AgentMessageRole::User,
            "2026-08-03T10:00:03.000Z",
            vec![text_block("recent user")],
            None,
        ),
        amsg(
            "a2",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:04.000Z",
            vec![text_block("recent asst")],
            None,
        ),
    ];
    (engine, messages)
}

pub fn tail_keep_policy(
    conversation: &[Arc<AgentMessage>],
    turns: u32,
) -> conex_compaction::CompactionPolicy {
    let len = conversation.len();
    let keep = conex_compaction::count_agent_message_tokens(&conversation[len - 2])
        + conex_compaction::count_agent_message_tokens(&conversation[len - 1]);
    conex_compaction::CompactionPolicy {
        keep_recent_tokens: keep,
        min_recent_turns: turns,
        ..conex_compaction::CompactionPolicy::default()
    }
}

pub fn push_long_turn(conversation: &mut Vec<Arc<AgentMessage>>, id: &str) {
    conversation.push(amsg(
        &format!("u{id}"),
        AgentMessageRole::User,
        "2026-08-03T11:00:00.000Z",
        vec![text_block(&"long appended user".repeat(50))],
        None,
    ));
    conversation.push(amsg(
        &format!("a{id}"),
        AgentMessageRole::Assistant,
        "2026-08-03T11:00:01.000Z",
        vec![text_block(&"long appended asst".repeat(50))],
        None,
    ));
}
