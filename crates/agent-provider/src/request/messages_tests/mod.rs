//! request/messages.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 messages.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。
//!
//! 按被测功能拆分为子模块（逐字平移；共享构造 helper 留在本文件，单节专用 helper 随所在节搬迁）：
//! - [chat_wire]：角色映射 / system prompt / tool result / wire 清洗 / assistant / reasoning / tool_call 消毒
//! - [multimodal_cache_control]：多模态 contentParts / strip data url / cache_control 载体字段
//! - [responses_input]：to_responses_input_items（Responses 轨 input items）
//! - [continuation_and_compat]：角色交替续写注记 / 领域纯度 / WireCompat / developer 角色
//! - [pairing_gate]：出站成对性 Fail-Closed 守门

use super::*;
use conex_types::message::ToolCallBlock;
use conex_types::tool::{ToolArtifact, ToolOutput};

/// 便捷构造消息
fn message(role: AgentMessageRole, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    AgentMessage {
        id: format!("m-{role:?}"),
        role,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

fn user_msg(blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    message(AgentMessageRole::User, blocks)
}

fn assistant_msg(blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    message(AgentMessageRole::Assistant, blocks)
}

fn tool_call_block(id: &str, name: &str, input: Value) -> AgentMessageBlock {
    AgentMessageBlock::ToolCall(ToolCallBlock {
        id: id.to_string(),
        tool_name: name.to_string(),
        input,
    })
}

fn tool_result_block(tool_call_id: &str, output: ToolOutput) -> AgentMessageBlock {
    AgentMessageBlock::ToolResult {
        tool_call_id: tool_call_id.to_string(),
        tool_name: "read_file".to_string(),
        output,
        is_error: false,
    }
}

/// 断言消息 role 与 content（字符串形态）
fn assert_text_content(messages: &[ChatMessage], index: usize, role: &str, content: &str) {
    assert_eq!(messages[index].role, role);
    assert_eq!(
        messages[index].content,
        Some(ChatContent::Text(content.to_string()))
    );
}

mod chat_wire;
mod continuation_and_compat;
mod multimodal_cache_control;
mod pairing_gate;
mod responses_input;
