use std::collections::HashSet;
use std::sync::Arc;

use conex_types::error::codes;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::ToolOutput;

/// 头部协议清洗：剔除序列最开头的孤儿 Tool 结果或非法 Assistant 碎片，
/// 确保对话序列第一条非 System 消息必须为合法的 User 消息（满足 LLM 协议首条必须为 User 的硬约束）。
pub(crate) fn sanitize_conversation_head(messages: &mut Vec<Arc<AgentMessage>>) {
    let first_user_idx = messages
        .iter()
        .position(|m| m.role == AgentMessageRole::User);
    match first_user_idx {
        Some(idx) => {
            if idx > 0 {
                let mut kept = Vec::with_capacity(messages.len());
                let mut found_user = false;
                for m in messages.drain(..) {
                    if m.role == AgentMessageRole::User {
                        found_user = true;
                    }
                    if found_user || m.role == AgentMessageRole::System {
                        kept.push(m);
                    } else {
                        tracing::warn!(
                            role = ?m.role,
                            id = %m.id,
                            "hydrate: 剔除头部非法非用户/系统消息碎片"
                        );
                    }
                }
                *messages = kept;
            }
        }
        None => {
            // 整个序列无任何 User 消息，清空回退
            messages.clear();
        }
    }
}

/// 出口成对差集自愈（规则 7 / 01A / 01B 重构）：扫描 assistant 上的 ToolCall，
/// 若导线所需 ToolResult 缺失（无 output 的真实中断孤儿），则在内存中紧跟该 assistant
/// 合成 `AgentMessageRole::Tool` 消息。
///
/// 契约约束：
/// - 只有真实无输出的中断调用才标记中断码（`codes::TOOL_ABORTED_BEFORE_DISPATCH`）；
/// - 绝不将成功的工具调用误判为孤儿并伪造成 `TOOL_OUTCOME_UNKNOWN` 假报错；
/// - 幂等自愈：已含 ToolResult 的 call_id 不再合成。
pub(crate) fn repair_orphan_tool_calls(messages: &mut Vec<Arc<AgentMessage>>) {
    let mut answered: HashSet<String> = HashSet::new();
    for msg in messages.iter() {
        for block in &msg.blocks {
            if let AgentMessageBlock::ToolResult { tool_call_id, .. } = block {
                answered.insert(tool_call_id.clone());
            }
        }
    }

    let mut repairs: Vec<(usize, AgentMessage)> = Vec::new();
    for (idx, msg) in messages.iter().enumerate() {
        if msg.role != AgentMessageRole::Assistant {
            continue;
        }
        for call in msg.tool_calls() {
            if answered.contains(&call.id) {
                continue;
            }
            answered.insert(call.id.clone());
            let synthesized = AgentMessage {
                id: format!("hydrate-tool-result-{}", call.id),
                role: AgentMessageRole::Tool,
                created_at: msg.created_at.clone(),
                blocks: vec![AgentMessageBlock::ToolResult {
                    tool_call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    output: ToolOutput::text(format!(
                        "tool execution interrupted before completion: {}",
                        codes::TOOL_ABORTED_BEFORE_DISPATCH
                    )),
                    is_error: true,
                }],
                metadata: Some(serde_json::json!({
                    "synthesized": true,
                    "errorCode": codes::TOOL_ABORTED_BEFORE_DISPATCH,
                    "hydrateSelfHeal": true,
                })),
                client_message_id: None,
                content: None,
            };
            repairs.push((idx, synthesized));
        }
    }

    if repairs.is_empty() {
        return;
    }
    tracing::info!(
        repaired = repairs.len(),
        "hydrate 出口成对差集自愈：为中断孤儿 ToolCall 合成内存 Tool 消息"
    );
    for (idx, message) in repairs.into_iter().rev() {
        messages.insert(idx + 1, Arc::new(message));
    }
}
