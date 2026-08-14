//! 切割点算法与 ToolBatch 闭包保护（conex-compaction）

use std::collections::HashSet;
use std::sync::Arc;

use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole};

use crate::tokens::count_agent_message_tokens;

/// 保留最近 token 预算默认（对齐 pi keepRecentTokens=20000，P4 §3.4.2）
pub const KEEP_RECENT_TOKENS_DEFAULT: usize = 20_000;
/// 保留最近完整回合数下限默认（对齐 opencode tail_turns=2，P4 §3.4.2）
pub const MIN_RECENT_TURNS_DEFAULT: u32 = 2;

/// 折叠链起始下标（T-01；B1 冻结 / B2 单调下界）
///
/// 链 = 紧邻 system 段之后的连续 `compacted-summary` 前缀消息段；
/// 返回链段之后的首个下标。无 system 时从开头直接跳过链消息；
/// 链为空时返回 system 段长度。链消息永不进保留区/丢弃区，
/// 故切割点恒须 `> fold_start`。
pub(crate) fn fold_start_of(messages: &[Arc<AgentMessage>]) -> usize {
    let mut idx = 0;
    while idx < messages.len() && messages[idx].role == AgentMessageRole::System {
        idx += 1;
    }
    while idx < messages.len() && messages[idx].id.starts_with("compacted-summary") {
        idx += 1;
    }
    idx
}

/// ToolBatch 双向完整性闭包算法（M-IMP-02 / TEST-IMP-03）
///
/// 确保保留段 `messages[cut..]` 满足：
/// 1. 向前闭包（Result -> Call）：每个 ToolResult 必须在保留段内有对应的 ToolCall；
///    若存在孤儿 Result，向前扩展 `cut` 到产生它的 Assistant 消息（索引 `j >= fold_start`）；
/// 2. 向后闭包（Call -> Results）：保留段内每个 Assistant 声明的所有 ToolCall，
///    其对应的 ToolResult 如果在 messages 中存在，必须全都在保留段内（不能部分在丢弃段）；
///    若有 Result 落在丢弃段（index < cut），必须向前调整 `cut` 覆盖该 Result，若越过下界则放弃。
pub fn enforce_tool_batch_closure(
    messages: &[Arc<AgentMessage>],
    mut cut: usize,
    fold_start: usize,
) -> Option<usize> {
    if cut > messages.len() {
        return None;
    }
    loop {
        let mut declared_call_ids: HashSet<String> = HashSet::new();
        let mut orphan_result_call_ids: HashSet<String> = HashSet::new();

        // 收集保留段内的所有 Call ID 与 Result ID
        for msg in &messages[cut..] {
            for block in &msg.blocks {
                match block {
                    AgentMessageBlock::ToolCall(call) => {
                        declared_call_ids.insert(call.id.clone());
                    }
                    AgentMessageBlock::ToolResult { tool_call_id, .. } => {
                        if !declared_call_ids.contains(tool_call_id) {
                            orphan_result_call_ids.insert(tool_call_id.clone());
                        }
                    }
                    _ => {}
                }
            }
        }

        // 1. 向前闭包：若保留段存在孤儿 ToolResult，向前倒查产生该调用的消息
        if !orphan_result_call_ids.is_empty() {
            let mut needed_idx: Option<usize> = None;
            for j in (fold_start..cut).rev() {
                if messages[j]
                    .tool_calls()
                    .any(|c| orphan_result_call_ids.contains(&c.id))
                {
                    needed_idx = Some(j);
                    break;
                }
            }
            match needed_idx {
                // 【核心加固 1】：放宽下界为 j >= fold_start，允许截断点落在链尾首节点
                Some(j) if j >= fold_start => {
                    cut = j;
                    continue; // 扩展后重新进行双向闭包检查
                }
                _ => return None, // 孤儿 call 位于链内或不存在，安全放弃压缩
            }
        }

        // 2. 向后闭包：检查保留段内所有声明的 call_id，其对应的 ToolResult 是否落在丢弃段 (index < cut)
        let mut earliest_result_idx: Option<usize> = None;
        for (idx, msg) in messages[fold_start..cut].iter().enumerate() {
            let real_idx = fold_start + idx;
            for block in &msg.blocks {
                if let AgentMessageBlock::ToolResult { tool_call_id, .. } = block {
                    if declared_call_ids.contains(tool_call_id) {
                        earliest_result_idx = Some(real_idx);
                        break;
                    }
                }
            }
            if earliest_result_idx.is_some() {
                break;
            }
        }

        if let Some(idx) = earliest_result_idx {
            if idx >= fold_start {
                cut = idx;
                continue;
            } else {
                return None;
            }
        }

        // 双向闭包校验通过
        break;
    }

    if cut <= fold_start {
        return None;
    }

    Some(cut)
}

/// 切割点核心（`tool_pair_protection` 由调用方按策略控制；
/// 公开入口 [crate::engine::CompactionEngine::find_cut_point] 恒开启保护）
///
/// 折叠链钳制（00-plan §4.2 T-01~T-05，B1/B2 不变量）：
/// 链消息（compacted-summary 前缀，紧邻 system 之后）永不进保留区，
/// 切割点下界 = `fold_start`（链段之后首个下标）；budget 扫描区间
/// 为 `[fold_start, len)`，min_recent_turns 与 tool 配对回扫同样
/// 以 fold_start 为下界——cut ≤ fold_start 一律放弃压缩。
pub(crate) fn find_cut_point_inner(
    messages: &[Arc<AgentMessage>],
    keep_recent_tokens: usize,
    min_recent_turns: u32,
    tool_pair_protection: bool,
) -> Option<usize> {
    if messages.is_empty() {
        return None;
    }
    // T-01：折叠链起始（system 段后首个非链下标）
    let fold_start = fold_start_of(messages);
    let counts: Vec<usize> = messages
        .iter()
        .map(|m| count_agent_message_tokens(m))
        .collect();

    // 1) 尾部倒推累计预算（达标处的消息纳入保留段；T-02：
    //    扫描区间 [fold_start, len)——链 token 不计入预算）
    let mut cut = messages.len();
    let mut acc = 0usize;
    for i in (fold_start..messages.len()).rev() {
        acc += counts[i];
        if acc >= keep_recent_tokens {
            cut = i;
            break;
        }
    }
    // 全部消息未达预算 → 保留全部；无可丢内容（cut 落在链上/链前）
    // → 放弃压缩（T-03：`cut == 0` 改为 `cut <= fold_start`）
    if cut == messages.len() {
        cut = 0;
    }
    if cut <= fold_start {
        return None;
    }

    // 2) min_recent_turns：保留段内完整回合（user 消息）下限
    if min_recent_turns > 0 {
        let mut user_count = messages[cut..]
            .iter()
            .filter(|m| m.role == AgentMessageRole::User)
            .count();
        while user_count < min_recent_turns as usize && cut > fold_start {
            cut -= 1;
            if messages[cut].role == AgentMessageRole::User {
                user_count += 1;
            }
        }
        if cut <= fold_start {
            return None;
        }
    }

    // 3) 合法切割点（tool 配对保护）：ToolBatch 双向完整性闭包（M-IMP-02 / TEST-IMP-03）
    if tool_pair_protection {
        cut = enforce_tool_batch_closure(messages, cut, fold_start)?;
    }

    Some(cut)
}
