//! stub 摘要文本、折叠链代数推导与摘要块（compacted-summary）生成。

use std::sync::Arc;

use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use crate::plan::{stub_placeholder, truncate_summary};

/// 折叠链消息 id 前缀（B1：链永不改写/丢失/折叠）
pub(super) const FOLD_CHAIN_PREFIX: &str = "compacted-summary";

/// 是否折叠链消息（`compacted-summary` 前缀）
pub(super) fn is_fold_chain_message(message: &AgentMessage) -> bool {
    message.id.starts_with(FOLD_CHAIN_PREFIX)
}

/// cut 之前的折叠链长度（= `CompactionPlan::fold_chain_prev`）
pub(super) fn fold_chain_len(messages: &[Arc<AgentMessage>], cut: usize) -> usize {
    messages[..cut]
        .iter()
        .filter(|m| is_fold_chain_message(m))
        .count()
}

/// 压缩代数：显式注入优先；否则沿用链尾既有摘要代数（同代数内只增 fold），
/// 默认 1——保证严格单调自增。
pub(super) fn resolve_generation(
    explicit: Option<u32>,
    messages: &[Arc<AgentMessage>],
    cut: usize,
) -> u32 {
    explicit.unwrap_or_else(|| {
        messages[..cut]
            .iter()
            .filter(|m| is_fold_chain_message(m))
            .filter_map(|m| {
                let parts: Vec<&str> = m.id.split('-').collect();
                if parts.len() >= 4 {
                    parts[2].parse::<u32>().ok()
                } else {
                    None
                }
            })
            .next_back()
            .unwrap_or(1)
    })
}

/// 摘要块 id（R-B：与链内摘要消息 id 同名 `compacted-summary-{gen}-{fold}`）
pub(super) fn summary_block_id(generation: u32, fold_index: usize) -> String {
    format!("{FOLD_CHAIN_PREFIX}-{generation}-{fold_index}")
}

/// 中性 stub 文本（R-C 永不改写；state=awaiting），受 `max_summary_tokens` 钳制
pub(super) fn stub_summary(
    block_id: &str,
    dropped_count: usize,
    generation: u32,
    max_summary_tokens: usize,
) -> String {
    truncate_summary(
        &stub_placeholder(block_id, dropped_count, generation),
        max_summary_tokens,
    )
}

/// 生成摘要消息（折叠链块）：`assistant` 角色，插在 system + 链之后、保留段
/// 之前（B4）；metadata 携带机器可读快照，正文 = 摘要文本（前端 content 回退）。
pub(super) fn build_summary_message(
    block_id: &str,
    summary: &str,
    summary_is_llm: bool,
    dropped_ids: &[String],
    generation: u32,
    created_at: String,
) -> AgentMessage {
    AgentMessage {
        id: block_id.to_string(),
        role: AgentMessageRole::Assistant,
        created_at,
        blocks: vec![AgentMessageBlock::Text {
            text: summary.to_string(),
        }],
        // metadata 快照（机器可读优先；正文只放人读线索；R-C：
        // stub 永驻 awaiting——摘要就绪以块表为准，不误导模型）
        metadata: Some(serde_json::json!({
            "isCompactedSummary": true,
            "summary": {
                "blockId": block_id,
                "state": if summary_is_llm { "committed" } else { "awaiting" },
                "droppedIds": dropped_ids,
                "height": 1,
                "generation": generation,
            }
        })),
        client_message_id: None,
        // 正文兜底字段（前端 content 回退，emit 时建议填充）
        content: Some(summary.to_string()),
    }
}
