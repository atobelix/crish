//! 历史水合映射（P4 阶段 1-2 / §3.2.3 store 水合判定规则；任务单元 T-28）
//!
//! 职责：把 `HistoryMessage`（conex-types/history.rs，前端 store 消息载荷）
//! 映射为会话循环可水合的 `AgentMessage`（conex-types/message.rs），供壳层
//! （T-29/T-30）经 `with_initial_conversation_arc` 预置进 `state.conversation`
//! （接线点说明见本文件末尾「衔接说明」一节）。
//!
//! 水合规则（对齐 P4 §3.2.3 规则表 + D7 §3.6 扩展）：
//! 1. 完成态过滤：`status` 为 `completed`、旧数据无 `status` 字段或 `error`
//!    才进；error 终态带 metadata `{kind:"failed-turn"}` 标记（D7 §3.6 裁决
//!    #13：失败回合信息保留供模型参考，污染与否交模型判断，不再由引擎过滤）；
//!    queued/processing/streaming/pending/空串 一律跳过；
//! 2. 角色映射：`sender` ∈ {user, assistant} 一一对应，其余角色跳过
//!    （System/Tool 是 run 内瞬态角色，跨 run 不应回传，有意为之）；
//! 3. 块保真优先：`blocks_json` 可解析为 `AgentMessageBlock` 序列时直接用；
//!    否则（含前端 timeline 形状与老数据无块）用 text/thinking/
//!    tool_calls_json/tool_call_results_json 合成兜底；
//! 4. metadata 裁剪：水合消息 `metadata = None`（usage 等不进 LLM 上下文），
//!    唯一例外是规则 1 的 error 终态 failed-turn 标记（D7 §3.6 扩展）；
//! 5. 尾部约束：序列必须以 user 消息收尾，最后一条非 user 时截断到
//!    最后一个 user 消息；无 user 消息 → 空序列；
//! 6. 排序：按入参数组顺序原样保留，timestamp 乱序不重排。
//!
//! 宽容水合：单条映射失败（角色未知 / 状态未完成 / 无可映射内容 / 载荷
//! 解析失败）只跳过该条或降级对应字段，不中断整体映射。

use std::sync::Arc;

use conex_types::history::HistoryMessage;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::ToolOutput;
use serde::Deserialize;

/// 历史水合映射主入口：`HistoryMessage` 数组 → `AgentMessage` 数组。
///
/// 返回 `Vec<Arc<AgentMessage>>`，与 `AgentSessionLoop::with_initial_conversation_arc`
/// （loop/mod.rs:329）的 `Vec<Arc<AgentMessage>>` 参数零拷贝对接；
/// 输出保持入参顺序（规则 6），且已完成尾部 user 截断（规则 5）。
pub fn hydrate_history(history: Vec<HistoryMessage>) -> Vec<Arc<AgentMessage>> {
    let mut messages: Vec<Arc<AgentMessage>> = Vec::new();
    for entry in history {
        // 宽容水合：单条失败只跳过该条，不中断整体
        if let Some(message) = hydrate_one(&entry) {
            messages.push(Arc::new(message));
        }
    }
    truncate_to_last_user(&mut messages);
    messages
}

/// 单条 `HistoryMessage` → `AgentMessage` 映射（返回 None = 该条跳过）。
///
/// 跳过情形（宽容水合）：
/// 1. 完成态过滤未通过（规则 1：queued/processing/streaming/pending/空串）；
/// 2. `sender` 非 user/assistant（规则 2）；
/// 3. 块解析与合成后仍无任何内容（无可映射正文，进上下文无意义）。
fn hydrate_one(entry: &HistoryMessage) -> Option<AgentMessage> {
    let status = status_kind(entry);
    if status == StatusKind::Skipped {
        return None;
    }
    let role = match entry.sender.as_str() {
        "user" => AgentMessageRole::User,
        "assistant" => AgentMessageRole::Assistant,
        _ => return None,
    };
    let blocks = resolve_blocks(entry);
    if blocks.is_empty() {
        return None;
    }
    let text = joined_text(&blocks);
    // 规则 4：metadata 裁剪（usage 等运行期数据不进 LLM 上下文；
    // wire 层 to_chat_messages 也不读 metadata，双保险）；D7 §3.6 例外：
    // error 终态带 failed-turn 标记（失败回合保留供模型参考，不污染正文）
    let metadata = match status {
        StatusKind::Failed => Some(serde_json::json!({ "kind": "failed-turn" })),
        StatusKind::Completed | StatusKind::Skipped => None,
    };
    Some(AgentMessage {
        id: entry.id.clone(),
        role,
        created_at: iso8601_from_epoch_millis(entry.timestamp),
        blocks,
        metadata,
        // client_message_id 对齐前端水合 rekey 的稳定幂等键：若水合消息
        // 经 RunOutcome 回传壳层/前端，前端 upsert 按 id 幂等，不产生重复
        client_message_id: Some(entry.id.clone()),
        content: if text.is_empty() { None } else { Some(text) },
    })
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

/// 块解析（规则 3）：块保真优先，失败回退合成兜底。
///
/// 实测（sessionRustDb.ts messageBlocksToJson 写入面）前端 `blocks_json`
/// 可能携带 timeline 形状（`{type:'text'|'tool_call'|'image', content, id, images}`），
/// 与 `AgentMessageBlock` 的 tagged enum（text/thought/tool-call/tool-result）
/// 不兼容——反序列化失败属预期场景，宽容回退 text/thinking/tool_calls_json/
/// tool_call_results_json 合成路径，信息损失以 text 主字段为限。
fn resolve_blocks(entry: &HistoryMessage) -> Vec<AgentMessageBlock> {
    if let Some(json) = entry.blocks_json.as_deref() {
        match serde_json::from_str::<Vec<AgentMessageBlock>>(json) {
            // 空数组视为无块，继续走合成（避免 "[]" 与缺块混淆）
            Ok(blocks) if !blocks.is_empty() => return blocks,
            Ok(_) => {}
            Err(_) => {
                tracing::warn!(
                    message_id = %entry.id,
                    "hydrate: blocks_json 无法解析为 AgentMessageBlock，回退合成兜底"
                );
            }
        }
    }
    synthesize_blocks(entry)
}

/// 老数据合成兜底：text/thinking → Text/Thought 块；
/// tool_calls_json → ToolCall 块（AgentMessage 原生支持，直接映射）；
/// tool_call_results_json → ToolResult 块。
///
/// ToolResult 的 tool_name 优先取同消息内按 id 匹配到的 ToolCall 名；
/// 匹配不到时用空串占位——wire 层 to_chat_messages 的 Tool 分支只消费
/// tool_call_id 与 output，不读 tool_name，空占位不产生线缆差异。
fn synthesize_blocks(entry: &HistoryMessage) -> Vec<AgentMessageBlock> {
    let mut blocks: Vec<AgentMessageBlock> = Vec::new();
    if let Some(text) = entry.text.as_deref() {
        if !text.is_empty() {
            blocks.push(AgentMessageBlock::Text { text: text.to_string() });
        }
    }
    if let Some(thinking) = entry.thinking.as_deref() {
        if !thinking.is_empty() {
            blocks.push(AgentMessageBlock::Thought {
                text: thinking.to_string(),
                redacted: None,
            });
        }
    }
    let tool_calls = parse_tool_calls(entry);
    for call in &tool_calls {
        blocks.push(AgentMessageBlock::ToolCall(ToolCallBlock {
            id: call.id.clone(),
            tool_name: call.name.clone(),
            input: parse_arguments(&call.arguments),
        }));
    }
    for result in parse_tool_call_results(entry) {
        let tool_name = tool_calls
            .iter()
            .find(|call| call.id == result.id)
            .map(|call| call.name.clone())
            .unwrap_or_default();
        blocks.push(AgentMessageBlock::ToolResult {
            tool_call_id: result.id,
            tool_name,
            output: ToolOutput::text(result.output.unwrap_or_default()),
            is_error: result.is_error.unwrap_or(false),
        });
    }
    blocks
}

/// 老数据 tool_calls_json 条目（对齐前端 MessageToolCall 的 id/name/arguments
/// 子集；status/output/explanation 等展示字段不参与 LLM 上下文）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyToolCall {
    id: String,
    name: String,
    #[serde(default)]
    arguments: Option<String>,
}

/// 老数据 tool_call_results_json 条目（对齐前端 SessionMessageToolCallResult：
/// id 对应 toolCall.id，output/isError 可缺省）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyToolCallResult {
    id: String,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    is_error: Option<bool>,
}

/// tool_calls_json → LegacyToolCall 列表（宽容：整体不可解析只丢工具部分，
/// 保留 text/thinking；条目级坏数据逐条跳过）
fn parse_tool_calls(entry: &HistoryMessage) -> Vec<LegacyToolCall> {
    let Some(json) = entry.tool_calls_json.as_deref() else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        tracing::warn!(message_id = %entry.id, "hydrate: tool_calls_json 整体不可解析，工具部分跳过");
        return Vec::new();
    };
    let parsed: Vec<LegacyToolCall> = items
        .iter()
        .filter_map(|item| serde_json::from_value::<LegacyToolCall>(item.clone()).ok())
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

/// tool_call_results_json → LegacyToolCallResult 列表（宽容语义同 parse_tool_calls）
fn parse_tool_call_results(entry: &HistoryMessage) -> Vec<LegacyToolCallResult> {
    let Some(json) = entry.tool_call_results_json.as_deref() else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        tracing::warn!(message_id = %entry.id, "hydrate: tool_call_results_json 整体不可解析，结果部分跳过");
        return Vec::new();
    };
    let parsed: Vec<LegacyToolCallResult> = items
        .iter()
        .filter_map(|item| serde_json::from_value::<LegacyToolCallResult>(item.clone()).ok())
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

/// arguments（JSON 串或原始参数串）→ ToolCallBlock.input（结构化 Value）
///
/// 能解析为 JSON 时用解析结果（对齐 wire 的 arguments 序列化形态）；
/// 否则原样包为字符串 Value（信息不丢）；缺省 → Null。
fn parse_arguments(arguments: &Option<String>) -> serde_json::Value {
    match arguments {
        None => serde_json::Value::Null,
        Some(raw) => serde_json::from_str::<serde_json::Value>(raw)
            .unwrap_or_else(|_| serde_json::Value::String(raw.clone())),
    }
}

/// epoch ms → ISO8601（毫秒精度 UTC；与 engine.rs / steering 同源的
/// Howard Hinnant civil-from-days 手工换算，不引入 chrono 依赖）
fn iso8601_from_epoch_millis(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let (hours, minutes, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{sec:02}.{millis:03}Z")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 steering/mod.rs:355 同源）
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

/// 拼接 text 块正文（对齐 AgentMessage::text 语义，供 content 兜底字段）
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

/// 尾部 user 约束（规则 5）：水合序列必须以 user 消息收尾（OpenAI 系协议
/// 合法性，避免以 assistant 收尾被拒）。最后一条非 user 时向前截断到
/// 最后一个 user 消息；无 user 消息 → 空序列（宁缺毋滥，交还壳层现状
/// 单消息路径）。
///
/// DEEPCHECK-01 P0 对齐（锚点保留）：截断只发生在尾部（`truncate`），
/// 序列首条永不因本约束被移除——若首条是 user（前端 buildHistoryMessages
/// 的稳定锚点恒为会话首条 user 消息），锚点永不因截断消失，跨 run 请求
/// 前缀保持字节稳定。
fn truncate_to_last_user(messages: &mut Vec<Arc<AgentMessage>>) {
    match messages.iter().rposition(|message| message.role == AgentMessageRole::User) {
        Some(last_user) => messages.truncate(last_user + 1),
        None => messages.clear(),
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
// 与 run 新用户消息的关系：水合序列之后，引擎 produce 仍会 run(user_message)
// 追加新用户消息收尾，故截断尾部非 user 只约束「纯历史形态」的协议合法性，
// 不改变 run 内对话形态（水合序列 + 新用户消息的 wire 前缀仍以 user 收尾）。
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
        // 末尾补 user 消息收尾（规则 5），避免尾部截断干扰本条映射断言
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
            vec![AgentMessageBlock::Text { text: "你好".into() }]
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

    /// D7 §3.6（改写，02-定夺 C7）：error 终态不再跳过（裁决 #13 放行），
    /// 过滤语义其余不变——queued/processing/streaming/空串 仍跳过
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

    /// D7 §3.6 新用例（A3/T5）：error 终态放行 + metadata {kind:"failed-turn"}；
    /// completed/无 status 放行且 metadata 仍为 None（规则 4 保持）
    #[test]
    fn error_status_hydrates_with_failed_turn_marker() {
        let history = vec![
            msg("u1", "user", Some("开始"), None),
            msg("f1", "assistant", Some("失败轮的部分产出"), Some("error")),
            msg("u2", "user", Some("继续"), Some("completed")),
        ];
        let hydrated = hydrate_history(history);
        assert_eq!(ids(&hydrated), ["u1", "f1", "u2"]);
        // failed-turn 标记：metadata == {"kind":"failed-turn"}
        assert_eq!(
            hydrated[1].metadata.as_ref(),
            Some(&serde_json::json!({ "kind": "failed-turn" }))
        );
        // completed/无 status 仍无标记（规则 4 保持）
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
    fn timestamp_out_of_order_keeps_array_order() {
        // 混合顺序：timestamp 乱序，水合序列仍按原数组顺序保留（规则 6）
        let mut m1 = msg("m1", "user", Some("q1"), None);
        m1.timestamp = 300;
        let mut m2 = msg("m2", "assistant", Some("r1"), None);
        m2.timestamp = 100;
        let mut m3 = msg("m3", "user", Some("q2"), None);
        m3.timestamp = 200;
        let hydrated = hydrate_history(vec![m1, m2, m3]);
        assert_eq!(ids(&hydrated), ["m1", "m2", "m3"]);
        // 乱序 timestamp 不应触发任何重排或丢弃
        assert_eq!(hydrated[1].created_at, iso8601_from_epoch_millis(100));
    }

    #[test]
    fn empty_history_yields_empty() {
        assert!(hydrate_history(Vec::new()).is_empty());
    }

    #[test]
    fn blocks_json_parsed_as_agent_blocks_preferred() {
        let mut h = msg("m1", "assistant", Some("合成文本不应出现"), Some("completed"));
        h.blocks_json = Some(
            r#"[{"type":"text","text":"块保真"},{"type":"thought","text":"思考","redacted":true}]"#
                .into(),
        );
        let history = vec![h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert_eq!(hydrated[0].blocks.len(), 2);
        // 块保真优先：内容来自 blocks_json 而非 text 合成
        assert_eq!(hydrated[0].text(), "块保真");
        assert_eq!(hydrated[0].thought(), "思考");
        assert_eq!(hydrated[0].content.as_deref(), Some("块保真"));
    }

    #[test]
    fn unparseable_timeline_blocks_json_falls_back_to_text() {
        // 前端 sessionRustDb 实际写入的是 timeline 形状（{type:'text',content}），
        // 与 AgentMessageBlock tagged enum 不兼容 → 宽容回退 text 合成
        let mut h = msg("m1", "user", Some("正文"), Some("completed"));
        h.blocks_json = Some(r#"[{"type":"text","content":"正文"}]"#.into());
        let hydrated = hydrate_history(vec![h]);
        assert_eq!(
            hydrated[0].blocks,
            vec![AgentMessageBlock::Text { text: "正文".into() }]
        );
    }

    #[test]
    fn thinking_synthesized_to_thought_block() {
        let mut h = msg("m1", "assistant", Some("正文"), None);
        h.thinking = Some("思考过程".into());
        let history = vec![h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert!(matches!(
            &hydrated[0].blocks[1],
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
        h.tool_call_results_json = Some(r#"[{"id":"c1","output":"file content","isError":false}]"#.into());
        let history = vec![h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        let blocks = &hydrated[0].blocks;
        assert_eq!(blocks.len(), 3); // text + tool-call + tool-result
        assert!(matches!(
            &blocks[1],
            AgentMessageBlock::ToolCall(call)
                if call.id == "c1" && call.tool_name == "read_file" && call.input["path"] == "a.txt"
        ));
        assert!(matches!(
            &blocks[2],
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
        // arguments 不是合法 JSON（原始参数串）→ 原样包为字符串 Value（信息不丢）
        let mut h = msg("m1", "assistant", None, None);
        h.tool_calls_json = Some(
            r#"[{"id":"c1","name":"shell","arguments":"npm run dev"}]"#.into(),
        );
        let history = vec![h, msg("tail", "user", Some("确认"), None)];
        let hydrated = hydrate_history(history);
        assert!(matches!(
            &hydrated[0].blocks[0],
            AgentMessageBlock::ToolCall(call)
                if call.input == serde_json::Value::String("npm run dev".into())
        ));
    }

    #[test]
    fn unmatched_tool_result_gets_empty_tool_name() {
        // 结果回执挂在后续消息（无同消息 ToolCall 可匹配）→ tool_name 空串占位
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
    fn trailing_non_user_truncated_to_last_user() {
        let history = vec![
            msg("u1", "user", Some("q1"), None),
            msg("a1", "assistant", Some("r1"), None),
            msg("a2", "assistant", Some("r2"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["u1"]);
    }

    /// DEEPCHECK-01 P0：稳定锚点与尾部 user 截断对齐——首条 user 锚点
    /// 永不因尾部截断消失（前端 buildHistoryMessages 锚点恒在语义在水合
    /// 层的守卫：尾部截断只动尾部，不动头部）
    #[test]
    fn first_user_anchor_survives_tail_truncation() {
        // 形态一：首条 user 锚点 + 大量尾部 assistant → 截断后锚点仍在
        let mut long_tail = vec![msg("u1", "user", Some("锚点"), None)];
        for i in 0..50 {
            long_tail.push(msg(&format!("a{i}"), "assistant", Some("尾部"), None));
        }
        assert_eq!(ids(&hydrate_history(long_tail)), ["u1"]);
        // 形态二：锚点 + 中间 user + 尾部 assistant——截断到最后一个 user，
        // 首条锚点仍保留
        let mixed = vec![
            msg("u1", "user", Some("锚点"), None),
            msg("a1", "assistant", Some("r1"), None),
            msg("u2", "user", Some("q2"), None),
            msg("a2", "assistant", Some("r2"), None),
            msg("a3", "assistant", Some("r3"), None),
        ];
        assert_eq!(ids(&hydrate_history(mixed)), ["u1", "a1", "u2"]);
        // 形态三：前端锚点截断载荷（锚点 + 预算尾部窗口，尾随 assistant）
        // 水合后锚点与窗口内 user 全部保留
        let anchored = vec![
            msg("u1", "user", Some("锚点"), None),
            msg("a40", "assistant", Some("r40"), None),
            msg("u41", "user", Some("q41"), None),
            msg("a42", "assistant", Some("r42"), None),
        ];
        assert_eq!(ids(&hydrate_history(anchored)), ["u1", "a40", "u41"]);
    }

    #[test]
    fn mixed_order_truncates_to_last_user() {
        let history = vec![
            msg("u1", "user", Some("q1"), None),
            msg("a1", "assistant", Some("r1"), None),
            msg("u2", "user", Some("q2"), None),
            msg("a2", "assistant", Some("r2"), None),
        ];
        assert_eq!(ids(&hydrate_history(history)), ["u1", "a1", "u2"]);
    }

    /// F1 盲区 10 / F2-06：连续同角色形态的水合行为锚定——当前实现为
    /// 「宽容水合」：连续 user 原样保留、assistant 开头（尾部 user 前）
    /// 合法保留，不做交替归并（ProviderCall 实现方当前未拒绝连续同角色；
    /// 若未来 Anthropic 系协议收紧，此为演进点——测试钉住现状契约）
    #[test]
    fn consecutive_user_and_assistant_first_shapes_pass_through() {
        // 形态一：[assistant, user, user] 连续 user——尾部 user 满足截断
        // 约束，中间连续 user 原样保留（不合并）
        let consecutive_user = vec![
            msg("a1", "assistant", Some("r1"), None),
            msg("u2", "user", Some("q2"), None),
            msg("u3", "user", Some("q3"), None),
        ];
        assert_eq!(ids(&hydrate_history(consecutive_user)), ["a1", "u2", "u3"]);

        // 形态二：assistant 开头 + 尾部 user——头部 assistant 合法保留
        // （assistant 开头的历史在尾部 user 前合法）
        let assistant_first = vec![
            msg("a1", "assistant", Some("r1"), None),
            msg("u2", "user", Some("q2"), None),
        ];
        assert_eq!(ids(&hydrate_history(assistant_first)), ["a1", "u2"]);

        // 形态三：纯连续 user 无 assistant——原样保留
        let all_user = vec![
            msg("u1", "user", Some("q1"), None),
            msg("u2", "user", Some("q2"), None),
        ];
        assert_eq!(ids(&hydrate_history(all_user)), ["u1", "u2"]);
    }

    #[test]
    fn all_assistant_history_truncates_to_empty() {
        let history = vec![
            msg("a1", "assistant", Some("r1"), None),
            msg("a2", "assistant", Some("r2"), None),
        ];
        assert!(hydrate_history(history).is_empty());
    }

    #[test]
    fn malformed_entries_skipped_without_aborting() {
        // 宽容水合：单条载荷乱写只降级/跳过，不中断后续条目
        let mut bad = msg("bad", "user", Some("正文仍保留"), None);
        bad.blocks_json = Some("不是 JSON".into());
        let mut bad2 = msg("bad2", "user", Some("工具部分跳过"), None);
        bad2.tool_calls_json = Some("[{\"id\":}]".into());
        let history = vec![bad, bad2.clone(), msg("ok", "user", Some("正常"), None)];
        assert_eq!(ids(&hydrate_history(history)), ["bad", "bad2", "ok"]);
        assert_eq!(
            hydrate_history(vec![bad2])[0].blocks,
            vec![AgentMessageBlock::Text { text: "工具部分跳过".into() }]
        );
    }

    #[test]
    fn created_at_derived_from_epoch_millis() {
        // 锚点：civil_from_days(20665) = 2026-07-31（steering 测试同源锚点）
        assert_eq!(iso8601_from_epoch_millis(1_785_456_000_000), "2026-07-31T00:00:00.000Z");
        assert_eq!(iso8601_from_epoch_millis(1_785_456_000_123), "2026-07-31T00:00:00.123Z");
    }
}
