//! 紧急二次预检（Emergency Preflight）与压缩预览（conex-compaction）。

use std::sync::Arc;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use crate::cut_point::find_cut_point_inner;
use crate::plan::{CompactionPlan, CompactionPolicy, StubPolicy, Summarizer};
use crate::tokens::count_agent_message_tokens;
use crate::tool_output::{truncate_tool_output, ToolOutputTruncationLimits};

use super::{
    collect_dropped_messages, first_retained_message_id, stub, total_message_tokens,
    CompactionEngine, CompactionPreview,
};

impl CompactionEngine {
    /// 紧急二次预检（Emergency Preflight）：
    /// 在追加消息或会话后，若当前对话总估算仍超预算，强制执行兜底压缩。
    ///
    /// 兼容 wrapper：内部同步 preview + summarize（仅本方法 / 测试路径；
    /// run loop 主路径不经此——经 preview + summarize_via_blocking 预计算）。
    pub fn emergency_preflight(
        &self,
        messages: &[Arc<AgentMessage>],
        budget_tokens: usize,
        policy: &CompactionPolicy,
        summarizer: Option<&dyn Summarizer>,
    ) -> CompactionPlan {
        let summarize_precomputed = summarizer.and_then(|s| {
            preview_compaction(messages, policy)
                .map(|preview| s.summarize(&preview.dropped, preview.existing.as_deref()))
        });
        let mut plan = self.compact_agent_messages_with_stub_policy(
            messages,
            budget_tokens,
            policy,
            StubPolicy::StubAllowed,
            summarize_precomputed,
        );
        if plan.tokens_after > budget_tokens as u64 && !plan.messages.is_empty() {
            let block_id = stub::summary_block_id(plan.generation, plan.fold_index.max(1));
            let new_tokens = apply_emergency_preflight(
                &mut plan.messages,
                &mut plan.dropped_ids,
                messages,
                0,
                budget_tokens,
                policy,
                &block_id,
            );
            plan.tokens_after = new_tokens;
            plan.kept_ids = plan.messages.iter().map(|m| m.id.clone()).collect();
            plan.first_kept_message_id = first_retained_message_id(&plan.messages);
        }
        plan
    }
}

/// 紧急二次预检与兜底压缩逻辑（Emergency Preflight）
///
/// 当追加新摘要或历史保留段后，总 Token 仍超过预算上限时触发：
/// 1. 尝试更紧凑的截断点（放宽 min_recent_turns 下限至 1 或 0），丢弃更多历史；
/// 2. 若依然超预算（如单条巨型工具输出），对保留段中的超大 ToolResult 实施紧急截断，
///    保证最终输出严格收敛于预算之内。
pub(super) fn apply_emergency_preflight(
    result: &mut Vec<Arc<AgentMessage>>,
    dropped_ids: &mut Vec<String>,
    original_messages: &[Arc<AgentMessage>],
    initial_cut: usize,
    budget_tokens: usize,
    policy: &CompactionPolicy,
    block_id: &str,
) -> u64 {
    let summary_pos = result.iter().position(|m| m.id == *block_id).unwrap_or(0);

    // 前缀（System + 历史链 + 新摘要）Token 占用
    let header_tokens: usize = result[..=summary_pos]
        .iter()
        .map(|m| count_agent_message_tokens(m))
        .sum();

    // 阶段 1：尝试更紧凑的切割点
    let tail_budget = budget_tokens.saturating_sub(header_tokens);
    apply_tighter_cut(
        result,
        dropped_ids,
        original_messages,
        initial_cut,
        tail_budget,
        summary_pos,
        policy,
    );

    let current_tokens = total_message_tokens(result);
    if current_tokens <= budget_tokens as u64 {
        return current_tokens;
    }

    // 阶段 2：若仍超预算，对保留段中的超大工具输出执行紧急截断
    truncate_oversized_tool_results(result, summary_pos + 1, tail_budget);
    total_message_tokens(result)
}

/// 阶段 1：尝试更紧凑的切割点（`min_recent_turns` 放宽至 1 / 0），丢弃更多历史
fn apply_tighter_cut(
    result: &mut Vec<Arc<AgentMessage>>,
    dropped_ids: &mut Vec<String>,
    original_messages: &[Arc<AgentMessage>],
    initial_cut: usize,
    tail_budget: usize,
    summary_pos: usize,
    policy: &CompactionPolicy,
) {
    let tighter_cut = find_cut_point_inner(
        original_messages,
        tail_budget,
        1,
        policy.tool_pair_protection,
    )
    .or_else(|| {
        find_cut_point_inner(
            original_messages,
            tail_budget,
            0,
            policy.tool_pair_protection,
        )
    });
    let Some(ecut) = tighter_cut else {
        return;
    };
    if ecut <= initial_cut {
        return;
    }
    // 纳入新丢弃的消息 id
    for msg in &original_messages[initial_cut..ecut] {
        if msg.role != AgentMessageRole::System
            && !stub::is_fold_chain_message(msg)
            && !dropped_ids.contains(&msg.id)
        {
            dropped_ids.push(msg.id.clone());
        }
    }
    // 重建保留段
    result.truncate(summary_pos + 1);
    result.extend_from_slice(&original_messages[ecut..]);
}

/// 阶段 2：对保留段中的超大工具输出执行紧急截断（共享剩余预算按条均分）
fn truncate_oversized_tool_results(
    result: &mut [Arc<AgentMessage>],
    non_header_start: usize,
    retained_budget_tokens: usize,
) {
    if non_header_start >= result.len() {
        return;
    }
    let retained_count = result.len() - non_header_start;
    let per_msg_budget_bytes = (retained_budget_tokens * 4) / retained_count.max(1);
    let emergency_limits = ToolOutputTruncationLimits {
        max_lines: 50,
        max_bytes: per_msg_budget_bytes.clamp(256, 4096),
    };
    for msg in &mut result[non_header_start..] {
        if let Some(updated) = truncate_tool_results(msg, &emergency_limits) {
            *msg = Arc::new(updated);
        }
    }
}

/// 单条消息的 ToolResult 截断：返回 Some 表示确有块被改写
fn truncate_tool_results(
    msg: &AgentMessage,
    limits: &ToolOutputTruncationLimits,
) -> Option<AgentMessage> {
    let mut modified_blocks = Vec::new();
    let mut changed = false;
    for block in &msg.blocks {
        match block {
            AgentMessageBlock::ToolResult {
                tool_call_id,
                tool_name,
                output,
                is_error,
            } => {
                let mut new_output = output.clone();
                if let Some(ref text) = output.text {
                    let trunc_res = truncate_tool_output(text, limits);
                    if trunc_res.truncated {
                        new_output.text = Some(trunc_res.text);
                        changed = true;
                    }
                }
                modified_blocks.push(AgentMessageBlock::ToolResult {
                    tool_call_id: tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                    output: new_output,
                    is_error: *is_error,
                });
            }
            other => modified_blocks.push(other.clone()),
        }
    }
    changed.then(|| AgentMessage {
        id: msg.id.clone(),
        role: msg.role,
        created_at: msg.created_at.clone(),
        blocks: modified_blocks,
        metadata: msg.metadata.clone(),
        client_message_id: msg.client_message_id.clone(),
        content: msg.content.clone(),
    })
}

/// 压缩预览（D10-A）：返回「本可压缩的应丢消息 + 既有摘要文本」，
/// 供调用方在调用 [CompactionEngine::compact_agent_messages_with_stub_policy]
/// **之前**经 spawn_blocking 异步预计算摘要（summarize_via_blocking）。
///
/// cut 计算与主方法同源（同一纯逻辑），返回 Some 当且仅当主方法
/// 会进入摘要分支（有合法切割点且有可丢消息）；None = 无压缩动作
/// （主方法将 noop）。`dropped` 为值克隆（Summarizer trait 借
/// `&[AgentMessage]`）；克隆成本远低于摘要网络往返，可接受。
pub fn preview_compaction(
    messages: &[Arc<AgentMessage>],
    policy: &CompactionPolicy,
) -> Option<CompactionPreview> {
    if messages.is_empty() {
        return None;
    }
    let cut = find_cut_point_inner(
        messages,
        policy.keep_recent_tokens,
        policy.min_recent_turns,
        policy.tool_pair_protection,
    )?;
    let dropped_arcs = collect_dropped_messages(messages, cut);
    if dropped_arcs.is_empty() {
        return None;
    }
    let existing = messages[..cut]
        .iter()
        .filter(|m| stub::is_fold_chain_message(m))
        .filter_map(|m| {
            let text = m.text();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        })
        .next_back();
    let dropped: Vec<AgentMessage> = dropped_arcs.iter().map(|m| (**m).clone()).collect();
    Some(CompactionPreview { dropped, existing })
}
