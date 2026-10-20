//! 历史水合映射（P4 阶段 1-2 / §3.2.3 store 水合判定规则；任务单元 T-28）
//!
//! 职责：把 `HistoryMessage`（conex-types/history.rs，前端 store 消息载荷）
//! 映射为会话循环可水合的 `AgentMessage`（conex-types/message.rs），供壳层
//! （T-29/T-30）经 `with_initial_conversation_arc` 预置进 `state.conversation`
//! （接线点说明见本文件末尾「衔接说明」一节）。
//!
//! 水合规则（对齐 P4 §3.2.3 规则表 + D7 §3.6 扩展 + 核心能力整改详案 01A/01B）：
//! 1. 完成态过滤：`status` 为 `completed`、旧数据无 `status` 字段或 `error`
//!    才进；error 终态带 metadata `{kind:"failed-turn"}` 标记（D7 §3.6 裁决
//!    #13：失败回合信息保留供模型参考，污染与否交模型判断，不再由引擎过滤）；
//!    queued/processing/streaming/pending/空串 一律跳过；
//! 2. 角色映射：`sender` ∈ {user, assistant} 一一对应，其余角色跳过
//!    （schema CHECK 仅允许 user|assistant；**不引入第三种 sender**——
//!    契约补丁 02 §3.3：Tool 结果经 assistant 载荷保真，运行时以
//!    `AgentMessageRole::Tool` 消息表达）；
//! 3. 块保真优先：`blocks_json` 可解析为 `AgentMessageBlock` 序列时直接用（含 Image 块）；
//!    否则（含前端 timeline 形状与老数据无块）用 text/thinking/
//!    tool_calls_json/tool_call_results_json 全保真合成；
//! 4. 工具输出保真（01A/01B 重构）：解析 assistant 历史消息时，无损提取
//!    `toolCalls[].output`，生成与运行时完全对齐的 `AgentMessageRole::Tool` 消息，
//!    真实输出在正文（ToolResult 块），绝不将已成功执行的工具伪造为假报错；
//! 5. 单源历史契约（01A/01B 重构）：物理彻底删除向后截断 `truncate_to_last_user`，
//!    已入库历史以 Assistant/Tool 结尾完全合法且天然应该保留；
//!    仅保留 `sanitize_conversation_head` 剔除首条合法用户消息前的非法碎片；
//! 6. 排序：按入参数组顺序原样保留，timestamp 乱序不重排；
//! 7. 纯真孤儿差集自愈（01A/01B 重构）：扫描 assistant 上的 ToolCall，
//!    仅对真正无输出的未决/中断孤儿调用，在内存中紧跟合成 `AgentMessageRole::Tool`
//!    消息，标记中断码 `codes::TOOL_ABORTED_BEFORE_DISPATCH`；幂等自愈。
//!
//! 宽容水合：单条映射失败（角色未知 / 状态未完成 / 无可映射内容 / 载荷
//! 解析失败）只跳过该条或降级对应字段，不中断整体映射。

use std::sync::Arc;

use conex_types::error::codes;
use conex_types::history::HistoryMessage;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::ToolOutput;
use serde::Deserialize;

/// 历史水合映射主入口：`HistoryMessage` 数组 → `AgentMessage` 数组。
///
/// 返回 `Vec<Arc<AgentMessage>>`，与 `AgentSessionLoop::with_initial_conversation_arc`
/// （loop/mod.rs:329）的 `Vec<Arc<AgentMessage>>` 参数零拷贝对接；
/// 输出保持入参顺序（规则 6），通过 `sanitize_conversation_head` 清洗头部非法碎片（规则 5），
/// 尾部 Assistant/Tool 完整保留，并对真实无输出的中断孤儿调用自愈（规则 7）。
pub fn hydrate_history(history: Vec<HistoryMessage>) -> Vec<Arc<AgentMessage>> {
    let mut messages: Vec<Arc<AgentMessage>> = Vec::new();
    for entry in history {
        match entry.sender.as_str() {
            "user" => {
                if let Some(msg) = hydrate_user(&entry) {
                    messages.push(Arc::new(msg));
                }
            }
            "assistant" => {
                for msg in hydrate_assistant(&entry) {
                    messages.push(Arc::new(msg));
                }
            }
            _ => {}
        }
    }
    sanitize_conversation_head(&mut messages);
    repair_orphan_tool_calls(&mut messages);
    messages
}

/// 单条用户 `HistoryMessage` → `AgentMessage` 映射（返回 None = 该条跳过）。
fn hydrate_user(entry: &HistoryMessage) -> Option<AgentMessage> {
    let status = status_kind(entry);
    if status == StatusKind::Skipped {
        return None;
    }
    let blocks = resolve_user_blocks(entry);
    if blocks.is_empty() {
        return None;
    }
    let text = joined_text(&blocks);
    let metadata = match status {
        StatusKind::Failed => Some(serde_json::json!({ "kind": "failed-turn" })),
        StatusKind::Completed | StatusKind::Skipped => None,
    };
    Some(AgentMessage {
        id: entry.id.clone(),
        role: AgentMessageRole::User,
        created_at: iso8601_from_epoch_millis(entry.timestamp),
        blocks,
        metadata,
        client_message_id: Some(entry.id.clone()),
        content: if text.is_empty() { None } else { Some(text) },
    })
}

/// 单条助手 `HistoryMessage` → 助手消息与 companion `AgentMessageRole::Tool` 消息序列。
fn hydrate_assistant(entry: &HistoryMessage) -> Vec<AgentMessage> {
    let status = status_kind(entry);
    if status == StatusKind::Skipped {
        return Vec::new();
    }
    let metadata = match status {
        StatusKind::Failed => Some(serde_json::json!({ "kind": "failed-turn" })),
        StatusKind::Completed | StatusKind::Skipped => None,
    };

    let tool_calls = parse_hydrated_tool_calls(entry);
    let explicit_results = parse_tool_call_results(entry);

    let (blocks, mut companion_tools) =
        resolve_assistant_blocks(entry, &tool_calls, &explicit_results);

    if blocks.is_empty() && companion_tools.is_empty() {
        return Vec::new();
    }

    let text = joined_text(&blocks);
    let asst_msg = AgentMessage {
        id: entry.id.clone(),
        role: AgentMessageRole::Assistant,
        created_at: iso8601_from_epoch_millis(entry.timestamp),
        blocks,
        metadata,
        client_message_id: Some(entry.id.clone()),
        content: if text.is_empty() { None } else { Some(text) },
    };

    let mut result = Vec::with_capacity(1 + companion_tools.len());
    result.push(asst_msg);
    result.append(&mut companion_tools);
    result
}

/// 完成态三分类（规则 1，D7 §3.6 扩展）：
/// - [StatusKind::Completed]：`completed` 或旧数据无 `status` 字段（放行，
///   无标记，规则 4 保持）；
/// - [StatusKind::Failed]：`error` 终态（放行，带 `{kind:"failed-turn"}` 标记
///   ——D7 裁决 #13：失败回合不再由引擎替模型过滤，保留供模型参考）；
/// - [StatusKind::Skipped]：其余（queued/processing/streaming/pending/空串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusKind {
    Completed,
    Failed,
    Skipped,
}

fn status_kind(entry: &HistoryMessage) -> StatusKind {
    match entry.status.as_deref() {
        None | Some("completed") => StatusKind::Completed,
        Some("error") => StatusKind::Failed,
        Some(_) => StatusKind::Skipped,
    }
}

/// 解析用户块（支持 blocks_json、text 及兼容挂在 user 上的老 tool_call_results_json）
fn resolve_user_blocks(entry: &HistoryMessage) -> Vec<AgentMessageBlock> {
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
fn resolve_assistant_blocks(
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
fn synthesize_assistant_blocks(
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
                        r.is_error.or_else(|| {
                            r.status.as_deref().map(|s| s == "error")
                        })
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

/// 全保真工具调用数据结构（支持直接反序列化 MessageToolCall 真实输出，包含 output, status, images 等）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct HydratedToolCall {
    id: String,
    #[serde(alias = "toolName", alias = "tool_name")]
    name: String,
    #[serde(default)]
    arguments: Option<serde_json::Value>,
    /// 真实工具执行输出文本或结构化数据
    #[serde(default)]
    output: Option<serde_json::Value>,
    /// 状态（success / error / running / pending_approval 等）
    #[serde(default)]
    status: Option<String>,
    /// 多模态图片引用（可选）
    #[serde(default)]
    images: Option<Vec<serde_json::Value>>,
}

/// 兼容老数据 / 独立 tool_call_results_json 条目
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct HydratedToolResult {
    id: String,
    #[serde(default)]
    output: Option<serde_json::Value>,
    #[serde(default, alias = "is_error")]
    is_error: Option<bool>,
    #[serde(default)]
    status: Option<String>,
}

/// tool_calls_json → HydratedToolCall 列表
fn parse_hydrated_tool_calls(entry: &HistoryMessage) -> Vec<HydratedToolCall> {
    let Some(json) = entry.tool_calls_json.as_deref() else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        tracing::warn!(message_id = %entry.id, "hydrate: tool_calls_json 整体不可解析，工具部分跳过");
        return Vec::new();
    };
    let parsed: Vec<HydratedToolCall> = items
        .iter()
        .filter_map(|item| serde_json::from_value::<HydratedToolCall>(item.clone()).ok())
        .collect();
    if parsed.len() != items.len() {
        tracing::warn!(
            message_id = %entry.id,
            kept = parsed.len(),
            total = items.len(),
            "hydrate: tool_calls_json 部分条目缺 id/name，跳过不可映射条目"
        );
    }
    parsed
}

/// tool_call_results_json → HydratedToolResult 列表
fn parse_tool_call_results(entry: &HistoryMessage) -> Vec<HydratedToolResult> {
    let Some(json) = entry.tool_call_results_json.as_deref() else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        tracing::warn!(message_id = %entry.id, "hydrate: tool_call_results_json 整体不可解析，结果部分跳过");
        return Vec::new();
    };
    let parsed: Vec<HydratedToolResult> = items
        .iter()
        .filter_map(|item| serde_json::from_value::<HydratedToolResult>(item.clone()).ok())
        .collect();
    if parsed.len() != items.len() {
        tracing::warn!(
            message_id = %entry.id,
            kept = parsed.len(),
            total = items.len(),
            "hydrate: tool_call_results_json 部分条目缺 id，跳过不可映射条目"
        );
    }
    parsed
}

/// 提取真实输出文本（字符串直接返回，对象提取 text 或格式化为 JSON 串）
fn extract_output_text(output_val: &Option<serde_json::Value>) -> Option<String> {
    match output_val {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Object(map)) => {
            if let Some(serde_json::Value::String(text)) = map.get("text") {
                Some(text.clone())
            } else {
                Some(serde_json::to_string(map).unwrap_or_default())
            }
        }
        Some(other) => Some(other.to_string()),
    }
}

/// arguments（JSON 串、对象或原始参数串）→ ToolCallBlock.input（结构化 Value）
fn parse_arguments(arguments: &Option<serde_json::Value>) -> serde_json::Value {
    match arguments {
        None | Some(serde_json::Value::Null) => serde_json::Value::Null,
        Some(serde_json::Value::String(raw)) => {
            serde_json::from_str::<serde_json::Value>(raw)
                .unwrap_or_else(|_| serde_json::Value::String(raw.clone()))
        }
        Some(val) => val.clone(),
    }
}

/// epoch ms → ISO8601（毫秒精度 UTC；与 engine.rs / steering 同源）
fn iso8601_from_epoch_millis(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let (hours, minutes, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{sec:02}.{millis:03}Z")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 拼接 text 块正文
fn joined_text(blocks: &[AgentMessageBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            AgentMessageBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// 头部协议清洗：剔除序列最开头的孤儿 Tool 结果或非法 Assistant 碎片，
/// 确保对话序列第一条非 System 消息必须为合法的 User 消息（满足 LLM 协议首条必须为 User 的硬约束）。
fn sanitize_conversation_head(messages: &mut Vec<Arc<AgentMessage>>) {
    let first_user_idx = messages.iter().position(|m| m.role == AgentMessageRole::User);
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
fn repair_orphan_tool_calls(messages: &mut Vec<Arc<AgentMessage>>) {
    use std::collections::HashSet;

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

// ═══════════════════════════════════════════════════════════════════════════
// 衔接说明（T-28 ↔ T-30 接线点，只注释不接线：with_initial_conversation_arc
// 属 T-33 文件域 loop/mod.rs，本模块不触碰）
// ═══════════════════════════════════════════════════════════════════════════
//
// 消费方（T-29/T-30，壳层 agent-workbench）：
//   core_run_task(…, history: Option<Vec<HistoryMessage>>) → 映射 →
//   AgentSessionLoop::with_initial_conversation_arc（loop/mod.rs:329，零拷贝
//   预置 state.conversation）在 produce 处水合。混合路线（P4 §3.2.3）：
//   SessionHistoryCache[session_id] 非空 → 直接以缓存水合（RunOutcome::messages
//   原子替换，Arc 共享零拷贝）；缓存为空（冷启动/重启）→ 用本模块映射结果；
//   两者皆空 → 现状单消息 run（向后兼容）。
//
// 顺序纪律（P4 §3.6 I3 水合不改写）：本函数输出只作为初始对话填充一次，
// 之后 loop 只追加（append-only，P1 不变量），改写既有消息破坏请求前缀
// 字节稳定性；压缩是唯一前缀重写点（P4 闸门）。
//
// 与 run 新用户消息的关系：已入库历史天然以 Assistant 或 Tool 结尾；
// 引擎 produce 在历史之后 run(user_message) 追加当前新用户提问，
// 使得最终进入 LLM 的上下文自然合法以最新 User 消息收尾。
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    /// 便捷构造（缺省无 thinking/无 JSON 载荷字段）
    fn msg(id: &str, sender: &str, text: Option<&str>, status: Option<&str>) -> HistoryMessage {
        HistoryMessage {
            id: id.into(),
            sender: sender.into(),
            text: text.map(String::from),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: status.map(String::from),
            timestamp: 1_700_000_000_000,
        }
    }

    fn ids(hydrated: &[Arc<AgentMessage>]) -> Vec<&str> {
        hydrated.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn user_and_assistant_map_to_correct_roles() {
        let history = vec![
            msg("u1", "user", Some("你好"), None),
            msg("a1", "assistant", Some("回复"), Some("completed")),
            msg("u3", "user", Some("确认"), None),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated.len(), 3);
        assert_eq!(hydrated[0].role, AgentMessageRole::User);
        assert_eq!(hydrated[1].role, AgentMessageRole::Assistant);
        assert_eq!(hydrated[2].role, AgentMessageRole::User);
        // 正文块 + content 兜底
        assert_eq!(
            hydrated[0].blocks,
            vec![AgentMessageBlock::Text {
                text: "你好".into()
            }]
        );
        assert_eq!(hydrated[0].content.as_deref(), Some("你好"));
        assert_eq!(hydrated[1].content.as_deref(), Some("回复"));
        // metadata 裁剪 + 幂等键对齐
        assert!(hydrated[0].metadata.is_none());
        assert!(hydrated[1].metadata.is_none());
        assert_eq!(hydrated[0].client_message_id.as_deref(), Some("u1"));
        assert_eq!(hydrated[1].client_message_id.as_deref(), Some("a1"));
        // 时间戳 → created_at（ISO8601 毫秒精度）
        assert_eq!(hydrated[0].created_at, "2023-11-14T22:13:20.000Z");
    }

    #[test]
    fn incomplete_status_entries_skipped() {
        let history = vec![
            msg("a", "user", Some("进"), Some("completed")),
            msg("b", "user", Some("跳过"), Some("processing")),
            msg("c", "user", Some("跳过"), Some("streaming")),
            msg("d", "user", Some("跳过"), Some("queued")),
            msg("e", "user", Some("进"), Some("error")),
            msg("f", "user", Some("跳过"), Some("")),
            msg("g", "user", Some("旧数据兼容"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["a", "e", "g"]);
    }

    #[test]
    fn error_status_hydrates_with_failed_turn_marker() {
        let history = vec![
            msg("u1", "user", Some("开始"), None),
            msg("f1", "assistant", Some("失败轮的部分产出"), Some("error")),
            msg("u2", "user", Some("继续"), Some("completed")),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(ids(&hydrated), ["u1", "f1", "u2"]);
        assert_eq!(
            hydrated[1].metadata.as_ref(),
            Some(&serde_json::json!({ "kind": "failed-turn" }))
        );
        assert!(hydrated[0].metadata.is_none());
        assert!(hydrated[2].metadata.is_none());
    }

    #[test]
    fn unknown_sender_and_empty_content_skipped() {
        let history = vec![
            msg("s1", "system", Some("瞬态角色不进"), None),
            msg("t1", "tool", Some("工具角色不进"), None),
            msg("e1", "user", None, None),
            msg("e2", "assistant", None, None),
            msg("ok", "user", Some("正常"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["ok"]);
    }

    #[test]
    fn orphan_tool_call_synthesized_as_memory_tool_message() {
        let mut a1 = msg("a1", "assistant", Some("调用工具"), Some("completed"));
        a1.tool_calls_json = Some(
            r#"[{"id":"c1","name":"shell_command","arguments":"{\"command\":\"ls\"}"}]"#.into(),
        );
        let history = vec![
            msg("u1", "user", Some("跑一下"), None),
            a1,
            msg("u2", "user", Some("继续"), None),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(ids(&hydrated), ["u1", "a1", "hydrate-tool-result-c1", "u2"]);
        let tool_msg = &hydrated[2];
        assert_eq!(tool_msg.role, AgentMessageRole::Tool);
        assert!(matches!(
            &tool_msg.blocks[0],
            AgentMessageBlock::ToolResult {
                tool_call_id,
                is_error: true,
                ..
            } if tool_call_id == "c1"
        ));
        let meta = tool_msg.metadata.as_ref().expect("合成消息带标记");
        assert_eq!(
            meta.get("errorCode"),
            Some(&serde_json::json!(codes::TOOL_ABORTED_BEFORE_DISPATCH))
        );
        assert_eq!(meta.get("synthesized"), Some(&serde_json::json!(true)));
    }

    #[test]
    fn paired_tool_call_not_repaired() {
        let mut a1 = msg("a1", "assistant", Some("调用工具"), Some("completed"));
        a1.tool_calls_json =
            Some(r#"[{"id":"c1","name":"shell_command","arguments":"{}"}]"#.into());
        a1.tool_call_results_json = Some(r#"[{"id":"c1","output":"ok","isError":false}]"#.into());
        let history = vec![
            msg("u1", "user", Some("跑一下"), None),
            a1,
            msg("u2", "user", Some("继续"), None),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(
            ids(&hydrated),
            ["u1", "a1", "tool-result-c1", "u2"],
            "已配对结果生成为 Tool 角色消息，且不得二次合成孤儿自愈"
        );
        assert_eq!(hydrated[2].role, AgentMessageRole::Tool);
        match &hydrated[2].blocks[0] {
            AgentMessageBlock::ToolResult { output, is_error, .. } => {
                assert_eq!(output.text.as_deref(), Some("ok"));
                assert!(!is_error);
            }
            _ => panic!("Expected ToolResult"),
        }
    }

    #[test]
    fn orphan_from_blocks_json_repaired() {
        let mut a1 = msg("a1", "assistant", None, Some("completed"));
        a1.blocks_json = Some(
            r#"[{"type":"tool-call","id":"c9","toolName":"shell_command","input":{"command":"ls"}}]"#
                .into(),
        );
        let history = vec![
            msg("u1", "user", Some("q"), None),
            a1,
            msg("u2", "user", Some("继续"), None),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(ids(&hydrated), ["u1", "a1", "hydrate-tool-result-c9", "u2"]);
        assert_eq!(hydrated[2].role, AgentMessageRole::Tool);
    }

    #[test]
    fn timestamp_out_of_order_keeps_array_order() {
        let mut m1 = msg("m1", "user", Some("q1"), None);
        m1.timestamp = 300;
        let mut m2 = msg("m2", "assistant", Some("r1"), None);
        m2.timestamp = 100;
        let mut m3 = msg("m3", "user", Some("q2"), None);
        m3.timestamp = 200;
        let hydrated = hydrate_history(vec![m1, m2, m3]);
        assert_eq!(ids(&hydrated), ["m1", "m2", "m3"]);
        assert_eq!(hydrated[1].created_at, iso8601_from_epoch_millis(100));
    }

    #[test]
    fn empty_history_yields_empty() {
        assert!(hydrate_history(Vec::new()).is_empty());
    }

    #[test]
    fn blocks_json_parsed_as_agent_blocks_preferred() {
        let mut h = msg(
            "m1",
            "assistant",
            Some("合成文本不应出现"),
            Some("completed"),
        );
        h.blocks_json = Some(
            r#"[{"type":"text","text":"块保真"},{"type":"thought","text":"思考","redacted":true}]"#
                .into(),
        );
        let history = vec![msg("u0", "user", Some("首"), None), h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated[1].blocks.len(), 2);
        assert_eq!(hydrated[1].text(), "块保真");
        assert_eq!(hydrated[1].thought(), "思考");
        assert_eq!(hydrated[1].content.as_deref(), Some("块保真"));
    }

    #[test]
    fn unparseable_timeline_blocks_json_falls_back_to_text() {
        let mut h = msg("m1", "user", Some("正文"), Some("completed"));
        h.blocks_json = Some(r#"[{"type":"text","content":"正文"}]"#.into());
        let hydrated = hydrate_history(vec![h]);
        assert_eq!(
            hydrated[0].blocks,
            vec![AgentMessageBlock::Text {
                text: "正文".into()
            }]
        );
    }

    #[test]
    fn thinking_synthesized_to_thought_block() {
        let mut h = msg("m1", "assistant", Some("正文"), None);
        h.thinking = Some("思考过程".into());
        let history = vec![msg("u0", "user", Some("首"), None), h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert!(matches!(
            &hydrated[1].blocks[1],
            AgentMessageBlock::Thought { text, redacted: None } if text == "思考过程"
        ));
    }

    #[test]
    fn legacy_tool_calls_and_results_map_to_blocks() {
        let mut h = msg("m1", "assistant", Some("调用工具"), None);
        h.tool_calls_json = Some(
            r#"[{"id":"c1","name":"read_file","arguments":"{\"path\":\"a.txt\"}","status":"success"}]"#
                .into(),
        );
        h.tool_call_results_json =
            Some(r#"[{"id":"c1","output":"file content","isError":false}]"#.into());
        let history = vec![msg("u0", "user", Some("提问"), None), h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated.len(), 4);
        assert_eq!(ids(&hydrated), ["u0", "m1", "tool-result-c1", "tail"]);

        let asst = &hydrated[1];
        assert_eq!(asst.role, AgentMessageRole::Assistant);
        assert_eq!(asst.blocks.len(), 2); // text + tool-call
        assert!(matches!(
            &asst.blocks[1],
            AgentMessageBlock::ToolCall(call)
                if call.id == "c1" && call.tool_name == "read_file" && call.input["path"] == "a.txt"
        ));

        let tool = &hydrated[2];
        assert_eq!(tool.role, AgentMessageRole::Tool);
        assert!(matches!(
            &tool.blocks[0],
            AgentMessageBlock::ToolResult {
                tool_call_id,
                tool_name,
                output,
                is_error: false,
            } if tool_call_id == "c1" && tool_name == "read_file" && output.text.as_deref() == Some("file content")
        ));
    }

    #[test]
    fn raw_arguments_wrapped_as_string_value() {
        let mut h = msg("m1", "assistant", None, None);
        h.tool_calls_json =
            Some(r#"[{"id":"c1","name":"shell","arguments":"npm run dev"}]"#.into());
        let history = vec![msg("u0", "user", Some("首"), None), h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert!(matches!(
            &hydrated[1].blocks[0],
            AgentMessageBlock::ToolCall(call)
                if call.input == serde_json::Value::String("npm run dev".into())
        ));
    }

    #[test]
    fn unmatched_tool_result_gets_empty_tool_name() {
        let mut h = msg("m1", "user", Some("结果回执"), None);
        h.tool_call_results_json = Some(r#"[{"id":"c1","output":"ok","isError":true}]"#.into());
        let hydrated = hydrate_history(vec![h]);
        assert!(matches!(
            &hydrated[0].blocks[1],
            AgentMessageBlock::ToolResult {
                tool_call_id,
                tool_name,
                is_error: true,
                ..
            } if tool_call_id == "c1" && tool_name.is_empty()
        ));
    }

    #[test]
    fn trailing_assistant_preserved_without_truncation() {
        let history = vec![
            msg("u1", "user", Some("q1"), None),
            msg("a1", "assistant", Some("r1"), None),
            msg("a2", "assistant", Some("r2"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["u1", "a1", "a2"]);
    }

    #[test]
    fn mixed_order_preserves_trailing_assistant() {
        let history = vec![
            msg("u1", "user", Some("q1"), None),
            msg("a1", "assistant", Some("r1"), None),
            msg("u2", "user", Some("q2"), None),
            msg("a2", "assistant", Some("r2"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["u1", "a1", "u2", "a2"]);
    }

    #[test]
    fn all_assistant_history_cleared_by_head_sanitizer() {
        let history = vec![
            msg("a1", "assistant", Some("r1"), None),
            msg("a2", "assistant", Some("r2"), None),
        ];
        assert!(hydrate_history(history).is_empty());
    }

    #[test]
    fn leading_illegal_assistant_cleared_by_head_sanitizer() {
        let history = vec![
            msg("a0", "assistant", Some("非法开头"), None),
            msg("u1", "user", Some("合法首个用户提问"), None),
            msg("a1", "assistant", Some("合法助手回复"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["u1", "a1"]);
    }

    #[test]
    fn malformed_entries_skipped_without_aborting() {
        let mut bad = msg("bad", "user", Some("正文仍保留"), None);
        bad.blocks_json = Some("不是 JSON".into());
        let mut bad2 = msg("bad2", "user", Some("工具部分跳过"), None);
        bad2.tool_calls_json = Some("[{\"id\":}]".into());
        let history = vec![bad, bad2.clone(), msg("ok", "user", Some("正常"), None)];
        assert_eq!(ids(&hydrate_history(history)), ["bad", "bad2", "ok"]);
        assert_eq!(
            hydrate_history(vec![bad2])[0].blocks,
            vec![AgentMessageBlock::Text {
                text: "工具部分跳过".into()
            }]
        );
    }

    #[test]
    fn created_at_derived_from_epoch_millis() {
        assert_eq!(
            iso8601_from_epoch_millis(1_785_456_000_000),
            "2026-07-31T00:00:00.000Z"
        );
        assert_eq!(
            iso8601_from_epoch_millis(1_785_456_000_123),
            "2026-07-31T00:00:00.123Z"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 核心能力系统性整改战役（01A / 01B 重构用例）
    // ─────────────────────────────────────────────────────────────────────────

    /// 用例 U-01：多轮已完成历史 Assistant 保留验证（对抗 BC01-4）
    #[test]
    fn test_hydrate_preserves_trailing_assistant() {
        let history = vec![
            msg("u1", "user", Some("你好"), None),
            msg("a1", "assistant", Some("我是助手，请问有什么可以帮您？"), Some("completed")),
            msg("u2", "user", Some("请基于你上一句回答总结"), None),
            msg("a2", "assistant", Some("上一句我是问您有什么需要帮助。"), Some("completed")),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated.len(), 4, "尾部助手回复不得被截断丢失");
        assert_eq!(hydrated[0].role, AgentMessageRole::User);
        assert_eq!(hydrated[1].role, AgentMessageRole::Assistant);
        assert_eq!(hydrated[2].role, AgentMessageRole::User);
        assert_eq!(hydrated[3].role, AgentMessageRole::Assistant);
        assert_eq!(hydrated[3].text(), "上一句我是问您有什么需要帮助。");
    }

    /// 用例 U-02：真实工具输出提取与拒绝假报错（对抗 BC01-5）
    #[test]
    fn test_hydrate_restores_real_tool_output() {
        let mut a1 = msg("a1", "assistant", None, Some("completed"));
        a1.tool_calls_json = Some(
            r#"[
            {
                "id": "c1",
                "name": "read_file",
                "arguments": "{\"path\":\"a.txt\"}",
                "status": "success",
                "output": "文件真实内容ABC"
            }
        ]"#
            .into(),
        );

        let history = vec![msg("u1", "user", Some("查看文件"), None), a1];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated.len(), 3, "必须包含 User, Assistant 以及伴随的 Tool 角色消息");

        assert_eq!(hydrated[0].role, AgentMessageRole::User);
        assert_eq!(hydrated[1].role, AgentMessageRole::Assistant);
        assert_eq!(hydrated[2].role, AgentMessageRole::Tool);

        let tool_msg = &hydrated[2];
        assert_eq!(tool_msg.blocks.len(), 1);
        match &tool_msg.blocks[0] {
            AgentMessageBlock::ToolResult {
                tool_call_id,
                output,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "c1");
                assert_eq!(output.text.as_deref(), Some("文件真实内容ABC"));
                assert!(!is_error, "正常成功的工具调用绝不能被标记为 error");
            }
            _ => panic!("必须为 ToolResult 块"),
        }
        assert!(tool_msg.metadata.is_none(), "正常成功执行的工具绝对不带假错误元数据");
    }

    /// 用例 U-03：真孤儿调用的降级自愈幂等性
    #[test]
    fn test_true_orphan_tool_call_self_healing_and_idempotency() {
        let mut a1 = msg("a1", "assistant", None, Some("completed"));
        a1.tool_calls_json = Some(
            r#"[
            {
                "id": "c2",
                "name": "interrupted_tool",
                "arguments": "{}"
            }
        ]"#
            .into(),
        );

        let history = vec![msg("u1", "user", Some("执行"), None), a1];
        let mut hydrated = hydrate_history(history);
        assert_eq!(hydrated.len(), 3);
        assert_eq!(hydrated[2].role, AgentMessageRole::Tool);

        let tool_msg = &hydrated[2];
        match &tool_msg.blocks[0] {
            AgentMessageBlock::ToolResult {
                tool_call_id,
                is_error,
                ..
            } => {
                assert_eq!(tool_call_id, "c2");
                assert!(is_error, "中断孤儿调用必须标记为 is_error=true");
            }
            _ => panic!("必须为 ToolResult 块"),
        }
        let meta = tool_msg.metadata.as_ref().expect("真孤儿必须携带错误标记");
        assert_eq!(
            meta.get("errorCode"),
            Some(&serde_json::json!(codes::TOOL_ABORTED_BEFORE_DISPATCH))
        );

        // 幂等性断言：再次执行自愈，不会重复合成
        let len_before = hydrated.len();
        repair_orphan_tool_calls(&mut hydrated);
        assert_eq!(hydrated.len(), len_before, "自愈操作必须严格满足幂等性");
    }

    /// 多模态图片块全保真水合验证
    #[test]
    fn test_multimodal_image_blocks_hydrated() {
        let mut u1 = msg("u1", "user", None, Some("completed"));
        u1.blocks_json = Some(
            r#"[
            {"type":"text","text":"看这张图"},
            {"type":"image","mimeType":"image/png","url":"https://example.com/pic.png","alt":"示例图"}
        ]"#
            .into(),
        );

        let history = vec![
            u1,
            msg("a1", "assistant", Some("我看到了示例图"), Some("completed")),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated.len(), 2);
        assert_eq!(hydrated[0].blocks.len(), 2);
        match &hydrated[0].blocks[1] {
            AgentMessageBlock::Image(img) => {
                assert_eq!(img.mime_type, "image/png");
                assert_eq!(img.url.as_deref(), Some("https://example.com/pic.png"));
                assert_eq!(img.alt.as_deref(), Some("示例图"));
            }
            other => panic!("预期 Image 块，得到 {other:?}"),
        }
        assert_eq!(hydrated[1].text(), "我看到了示例图");
    }
}
