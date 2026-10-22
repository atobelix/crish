use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::ToolOutput;

/// 用户消息
pub(crate) fn user(text: &str) -> AgentMessage {
    AgentMessage {
        id: format!("user-{text}"),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::Text { text: text.into() }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 工具结果消息（文本输出 + 错误标志）
pub(crate) fn tool_result(text: &str, is_error: bool) -> AgentMessage {
    tool_result_output(text, is_error, ToolOutput::text(text))
}

/// 工具结果消息（json 输出 + 错误标志）
pub(crate) fn tool_result_json(is_error: bool, json: serde_json::Value) -> AgentMessage {
    tool_result_output(
        "",
        is_error,
        ToolOutput {
            text: None,
            json: Some(json),
            artifacts: None,
        },
    )
}

fn tool_result_output(text: &str, is_error: bool, output: ToolOutput) -> AgentMessage {
    AgentMessage {
        id: format!("tool-result-{text}"),
        role: AgentMessageRole::Tool,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks: vec![AgentMessageBlock::ToolResult {
            tool_call_id: format!("call-{text}"),
            tool_name: "test_tool".into(),
            output,
            is_error,
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 助手消息（携带若干工具调用块）
pub(crate) fn assistant_with_tool_calls(calls: &[(&str, serde_json::Value)]) -> AgentMessage {
    let blocks = calls
        .iter()
        .map(|(name, input)| {
            AgentMessageBlock::ToolCall(ToolCallBlock {
                id: format!("call-{name}"),
                tool_name: (*name).into(),
                input: input.clone(),
            })
        })
        .collect();
    AgentMessage {
        id: "assistant-tool".into(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".into(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    }
}
