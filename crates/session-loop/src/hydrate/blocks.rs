use conex_types::history::HistoryMessage;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::ToolOutput;

use super::time_text::iso8601_from_epoch_millis;
use super::tool_calls::{
    extract_output_text, parse_arguments, parse_tool_call_results, HydratedToolCall,
    HydratedToolResult,
};

/// 完成态三分类（规则 1，D7 §3.6 扩展）：
/// - [StatusKind::Completed]：`completed` 或旧数据无 `status` 字段（放行，
///   无标记，规则 4 保持）；
/// - [StatusKind::Failed]：`error` 终态（放行，带 `{kind:"failed-turn"}` 标记
///   ——D7 裁决 #13：失败回合不再由引擎替模型过滤，保留供模型参考）；
/// - [StatusKind::Skipped]：其余（queued/processing/streaming/pending/空串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StatusKind {
    Completed,
    Failed,
    Skipped,
}

pub(crate) fn status_kind(entry: &HistoryMessage) -> StatusKind {
    match entry.status.as_deref() {
        None | Some("completed") => StatusKind::Completed,
        Some("error") => StatusKind::Failed,
        Some(_) => StatusKind::Skipped,
    }
}

/// 解析用户块（支持 blocks_json、text 及兼容挂在 user 上的老 tool_call_results_json）
pub(crate) fn resolve_user_blocks(entry: &HistoryMessage) -> Vec<AgentMessageBlock> {
    if let Some(json) = entry.blocks_json.as_deref() {
        match serde_json::from_str::<Vec<AgentMessageBlock>>(json) {
            Ok(blocks) if !blocks.is_empty() => return blocks,
            Ok(empty) => {
                // 解析成功但块序列为空：无任何可还原内容，走与解析失败相同的
                // 合成兜底；显式记录（BLK-05：不得静默丢弃空结果）
                tracing::warn!(
                    message_id = %entry.id,
                    empty_blocks = empty.len(),
                    "hydrate: blocks_json 解析结果为空块序列，回退合成兜底"
                );
            }
            Err(err) => {
                tracing::warn!(
                    message_id = %entry.id,
                    error = %err,
                    "hydrate: blocks_json 无法解析为 AgentMessageBlock，回退合成兜底"
                );
            }
        }
    }
    let mut blocks = Vec::new();
    if let Some(text) = entry.text.as_deref().filter(|t| !t.is_empty()) {
        blocks.push(AgentMessageBlock::Text {
            text: text.to_string(),
        });
    }
    for res in parse_tool_call_results(entry) {
        blocks.push(AgentMessageBlock::ToolResult {
            tool_call_id: res.id,
            tool_name: String::new(),
            output: ToolOutput::text(extract_output_text(&res.output).unwrap_or_default()),
            is_error: res.is_error.unwrap_or(false),
        });
    }
    blocks
}

/// 助手消息块解析：blocks_json 优先，或基于 text/thinking/toolCalls 全保真合成。
pub(crate) fn resolve_assistant_blocks(
    entry: &HistoryMessage,
    tool_calls: &[HydratedToolCall],
    explicit_results: &[HydratedToolResult],
) -> (Vec<AgentMessageBlock>, Vec<AgentMessage>) {
    if let Some(json) = entry.blocks_json.as_deref() {
        match serde_json::from_str::<Vec<AgentMessageBlock>>(json) {
            Ok(raw_blocks) if !raw_blocks.is_empty() => {
                let mut blocks = Vec::new();
                let mut companion_tools = Vec::new();

                for b in raw_blocks {
                    match b {
                        AgentMessageBlock::ToolResult {
                            tool_call_id,
                            tool_name,
                            output,
                            is_error,
                        } => {
                            // 独立为 AgentMessageRole::Tool 消息，与运行时对齐
                            companion_tools.push(AgentMessage {
                                id: format!("tool-result-{}", tool_call_id),
                                role: AgentMessageRole::Tool,
                                created_at: iso8601_from_epoch_millis(entry.timestamp),
                                blocks: vec![AgentMessageBlock::ToolResult {
                                    tool_call_id,
                                    tool_name,
                                    output,
                                    is_error,
                                }],
                                metadata: None,
                                client_message_id: None,
                                content: None,
                            });
                        }
                        other => blocks.push(other),
                    }
                }

                // 为 blocks_json 中的 ToolCall 匹配 output（如果 companion_tools 尚无）
                for block in &blocks {
                    if let AgentMessageBlock::ToolCall(call) = block {
                        let already_has_result = companion_tools.iter().any(|m| {
                            m.blocks.iter().any(|b| match b {
                                AgentMessageBlock::ToolResult { tool_call_id, .. } => {
                                    tool_call_id == &call.id
                                }
                                _ => false,
                            })
                        });
                        if !already_has_result {
                            let matched_call = tool_calls.iter().find(|c| c.id == call.id);
                            let matched_res = explicit_results.iter().find(|r| r.id == call.id);
                            let output_opt = matched_call
                                .and_then(|c| extract_output_text(&c.output))
                                .or_else(|| {
                                    matched_res.and_then(|r| extract_output_text(&r.output))
                                });

                            if let Some(output_text) = output_opt {
                                let is_error = matched_call
                                    .and_then(|c| c.status.as_deref())
                                    .map(|s| s == "error")
                                    .unwrap_or(false)
                                    || matched_res
                                        .and_then(|r| {
                                            r.is_error.or_else(|| {
                                                r.status.as_deref().map(|s| s == "error")
                                            })
                                        })
                                        .unwrap_or(false);

                                let mut output = ToolOutput::text(output_text);
                                if let Some(imgs) = matched_call.and_then(|c| c.images.as_ref()) {
                                    output.json = Some(serde_json::json!({ "images": imgs }));
                                }

                                companion_tools.push(AgentMessage {
                                    id: format!("tool-result-{}", call.id),
                                    role: AgentMessageRole::Tool,
                                    created_at: iso8601_from_epoch_millis(entry.timestamp),
                                    blocks: vec![AgentMessageBlock::ToolResult {
                                        tool_call_id: call.id.clone(),
                                        tool_name: call.tool_name.clone(),
                                        output,
                                        is_error,
                                    }],
                                    metadata: None,
                                    client_message_id: None,
                                    content: None,
                                });
                            }
                        }
                    }
                }

                return (blocks, companion_tools);
            }
            Ok(empty) => {
                // 同上：解析成功但为空块序列 → 记录后回落合成兜底（BLK-05）
                tracing::warn!(
                    message_id = %entry.id,
                    empty_blocks = empty.len(),
                    "hydrate: blocks_json 解析结果为空块序列，回退合成兜底"
                );
            }
            Err(err) => {
                tracing::warn!(
                    message_id = %entry.id,
                    error = %err,
                    "hydrate: blocks_json 无法解析为 AgentMessageBlock，回退合成兜底"
                );
            }
        }
    }

    synthesize_assistant_blocks(entry, tool_calls, explicit_results)
}

/// 全保真助手块合成：无损提取 toolCalls[].output，生成与运行时完全对齐的 AgentMessageRole::Tool 消息。
pub(crate) fn synthesize_assistant_blocks(
    entry: &HistoryMessage,
    tool_calls: &[HydratedToolCall],
    explicit_results: &[HydratedToolResult],
) -> (Vec<AgentMessageBlock>, Vec<AgentMessage>) {
    let mut blocks = Vec::new();
    let mut companion_tools = Vec::new();

    if let Some(text) = entry.text.as_deref().filter(|t| !t.is_empty()) {
        blocks.push(AgentMessageBlock::Text {
            text: text.to_string(),
        });
    }
    if let Some(thinking) = entry.thinking.as_deref().filter(|t| !t.is_empty()) {
        blocks.push(AgentMessageBlock::Thought {
            text: thinking.to_string(),
            redacted: None,
        });
    }

    for call in tool_calls {
        blocks.push(AgentMessageBlock::ToolCall(ToolCallBlock {
            id: call.id.clone(),
            tool_name: call.name.clone(),
            input: parse_arguments(&call.arguments),
        }));

        let matched_res = explicit_results.iter().find(|r| r.id == call.id);
        let output_opt = extract_output_text(&call.output)
            .or_else(|| matched_res.and_then(|r| extract_output_text(&r.output)));

        if let Some(output_text) = output_opt {
            let is_error = call
                .status
                .as_deref()
                .map(|s| s == "error")
                .unwrap_or(false)
                || matched_res
                    .and_then(|r| {
                        r.is_error
                            .or_else(|| r.status.as_deref().map(|s| s == "error"))
                    })
                    .unwrap_or(false);

            let mut output = ToolOutput::text(output_text);
            if let Some(imgs) = &call.images {
                output.json = Some(serde_json::json!({ "images": imgs }));
            }

            companion_tools.push(AgentMessage {
                id: format!("tool-result-{}", call.id),
                role: AgentMessageRole::Tool,
                created_at: iso8601_from_epoch_millis(entry.timestamp),
                blocks: vec![AgentMessageBlock::ToolResult {
                    tool_call_id: call.id.clone(),
                    tool_name: call.name.clone(),
                    output,
                    is_error,
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            });
        }
    }

    // 检查是否有未在 tool_calls 中的孤立 explicit_results
    for res in explicit_results {
        if !tool_calls.iter().any(|c| c.id == res.id) {
            if let Some(output_text) = extract_output_text(&res.output) {
                let is_error = res
                    .is_error
                    .or_else(|| res.status.as_deref().map(|s| s == "error"))
                    .unwrap_or(false);

                companion_tools.push(AgentMessage {
                    id: format!("tool-result-{}", res.id),
                    role: AgentMessageRole::Tool,
                    created_at: iso8601_from_epoch_millis(entry.timestamp),
                    blocks: vec![AgentMessageBlock::ToolResult {
                        tool_call_id: res.id.clone(),
                        tool_name: String::new(),
                        output: ToolOutput::text(output_text),
                        is_error,
                    }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                });
            }
        }
    }

    (blocks, companion_tools)
}
