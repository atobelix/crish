//! 压缩事件 details 载荷与 covers_up_to_turn 计算（从 ai_summary.rs 纯搬迁）

use conex_types::AgentMessage;

// ── covers_up_to_turn（02 Top 9：摘要覆盖到哪一轮，供拼接注入）──

/// 计算被压缩（丢弃）消息覆盖到第几轮：返回丢弃段内用户回合数
/// （1 起计；回合 = 一个 user 消息）。丢弃段为对话前缀时该计数即
/// 「摘要覆盖到第 N 轮」，支持「Previous Summary + New Conversation」
/// 拼接（M11 消费）。丢弃段不含任何用户消息时返回 None。
pub fn covers_up_to_turn_for_dropped(dropped: &[AgentMessage]) -> Option<u32> {
    let turns = dropped
        .iter()
        .filter(|m| m.role == conex_types::AgentMessageRole::User)
        .count() as u32;
    if turns == 0 {
        None
    } else {
        Some(turns)
    }
}

/// 压缩事件 details 载荷（camelCase，随 `context-compression-end` 的
/// `result.details` 落库）：coversUpToTurn / degraded / summaryAttempts
/// / droppedCount。调用方（session-loop 的 apply_compaction）把本载荷
/// 填入 [conex_types::tool::ContextCompressionRecord::details]，
/// 供后续 run 与 M11 消费。
pub fn compaction_event_details(
    dropped: &[AgentMessage],
    degraded: bool,
    summary_attempts: u32,
) -> serde_json::Value {
    serde_json::json!({
        "coversUpToTurn": covers_up_to_turn_for_dropped(dropped),
        "degraded": degraded,
        "summaryAttempts": summary_attempts,
        "droppedCount": dropped.len(),
    })
}
