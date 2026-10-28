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

mod blocks;
pub mod cache;
pub(crate) mod repair;
pub(crate) mod time_text;
pub(crate) mod tool_calls;

pub use cache::{SessionHistoryLruCache, MAX_CACHED_SESSIONS_DEFAULT};

#[cfg(test)]
mod tests;

use std::sync::Arc;

use conex_types::history::HistoryMessage;
use conex_types::message::{AgentMessage, AgentMessageRole};

use self::blocks::{resolve_assistant_blocks, resolve_user_blocks, status_kind, StatusKind};
use self::repair::{repair_orphan_tool_calls, sanitize_conversation_head};
use self::time_text::{iso8601_from_epoch_millis, joined_text};
use self::tool_calls::{parse_hydrated_tool_calls, parse_tool_call_results};

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
