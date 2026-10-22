use conex_types::session::AgentEndReason;

use super::checklist::{parse_checklist, reply_looks_goal_done};
use super::{
    GoalDecision, RoundAssessment, RoundInput, ToolCallStamp, GOAL_COMPLETED_REASON,
    GOAL_MAX_ROUNDS_REASON, GOAL_STALLED_REASON, STOP_REASON,
};
use crate::normalize;

/// 收口评估纯函数（§3.3 判定伪代码；无 IO、无副作用，可单测）。
///
/// 判定优先级：NoGoal → reason 门禁 → L0+L1 完成 → 轮数上限 → stalled →
/// 默认 Continue。完成判定先于轮数上限（伪代码步骤 3「且未完成」修饰 +
/// 前端 decideGoalContinuation 先 done 后 max_iter 顺序，
/// goalModeController.ts:235-257）。
pub fn assess_round(input: &RoundInput) -> RoundAssessment {
    let current = &input.current;
    // 1. 无 goal / 已终态：不评估不写（§3.3 步骤 1；goal_pending 恒 false
    //    由壳层 status 拦截）
    if !current.is_active() {
        return RoundAssessment {
            decision: GoalDecision::NoGoal,
            stopped_reason: None,
            reason_detail: String::new(),
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: false,
        };
    }
    let continue_allowed = normalize::allows_auto_continue(input.end_reason);
    // 2. reason 门禁：非 Stop（Error/MaxTurns/Aborted/Stopped）→ Blocked；
    //    error 轮不计轮数、不计 stalled（01 敲定 §3 第3条；error 收场转
    //    D2 error 分支，不触发 goal_pending）
    if input.end_reason != AgentEndReason::Stop {
        let detail = end_reason_detail(input.end_reason);
        return RoundAssessment {
            decision: GoalDecision::Blocked,
            stopped_reason: Some(detail.clone()),
            reason_detail: detail,
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: continue_allowed,
        };
    }
    // 3. 完成判定 L0+L1（§3.5 / 裁决 #10）：
    //    - L1：checklist 非空且全勾 → Completed（主门禁）；
    //    - L0：无 checklist 且文案 DONE → Completed（候选收口）；
    //    - 文案 DONE 但 checklist 非空未全勾 → 不完成（prematureDoneClaim
    //      对齐 goalModeController.ts:232，继续推进路径）
    let checklist = parse_checklist(&input.assistant_text);
    let has_tasks = !checklist.is_empty();
    let all_done = has_tasks && checklist.iter().all(|item| item.done);
    let looks_done = reply_looks_goal_done(&input.assistant_text);
    if all_done || (looks_done && !has_tasks) {
        return RoundAssessment {
            decision: GoalDecision::Completed,
            stopped_reason: Some(GOAL_COMPLETED_REASON.into()),
            reason_detail: GOAL_COMPLETED_REASON.into(),
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: continue_allowed,
        };
    }
    // 4. 轮数上限：current_round + 1 >= max_rounds 且未完成 → Blocked
    //    （goal-max-rounds；A3，前端语义对齐 goalModeController.ts:244-257）
    if current.current_round + 1 >= current.max_rounds {
        return RoundAssessment {
            decision: GoalDecision::Blocked,
            stopped_reason: Some(GOAL_MAX_ROUNDS_REASON.into()),
            reason_detail: GOAL_MAX_ROUNDS_REASON.into(),
            next_progress_signature: None,
            stalled_delta: 0,
            should_continue: continue_allowed,
        };
    }
    // 5. stalled 检测（§3.4 / 裁决 #11）：
    //    - 无工具轮 → 签名不变（沿用上轮），自动落入「签名相同」轨道，
    //      正确计入 stalled（03 §2D 论证：消息 id 链误判率高已弃用）；
    //    - 本轮有成功工具结果（tool_success_count > 0）→ 重置 stalled；
    //    - 签名变化 → 重置 stalled。
    let next_sig = tool_batch_fingerprint(&input.tool_calls);
    let effective_sig = next_sig
        .clone()
        .or_else(|| current.progress_signature.clone());
    let stalled_delta = if input.tool_success_count > 0 {
        0
    } else if effective_sig == current.progress_signature {
        1
    } else {
        0
    };
    if stalled_delta == 1 && current.stalled_rounds + 1 >= current.max_stalled_rounds {
        return RoundAssessment {
            decision: GoalDecision::Blocked,
            stopped_reason: Some(GOAL_STALLED_REASON.into()),
            reason_detail: GOAL_STALLED_REASON.into(),
            next_progress_signature: next_sig,
            stalled_delta: 1,
            should_continue: continue_allowed,
        };
    }
    if stalled_delta == 1 {
        return RoundAssessment {
            decision: GoalDecision::NoProgress,
            stopped_reason: Some(STOP_REASON.into()),
            reason_detail: STOP_REASON.into(),
            next_progress_signature: next_sig,
            stalled_delta: 1,
            should_continue: continue_allowed,
        };
    }
    // 6. 默认 → Continue（needs-continuation）
    RoundAssessment {
        decision: GoalDecision::Continue,
        stopped_reason: Some(STOP_REASON.into()),
        reason_detail: STOP_REASON.into(),
        next_progress_signature: next_sig,
        stalled_delta: 0,
        should_continue: continue_allowed,
    }
}

/// 工具批指纹（§3.4 / 裁决 #11）：对每笔工具调用取
/// `tool_name + 参数 JSON 顶层 key 集合`（排序后拼串），序列整体 FNV-1a
/// 哈希（复用 recovery.rs:251-262 fingerprint 的 FNV-1a 参数）；参数值
/// 噪声（时间戳/随机值）被 key 集降级容忍；调用顺序敏感。
///
/// 无工具轮 → None（签名不变，沿用上轮 progress_signature）。
pub fn tool_batch_fingerprint(calls: &[ToolCallStamp]) -> Option<String> {
    if calls.is_empty() {
        return None;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for call in calls {
        feed_fnv1a(&mut hash, call.tool_name.as_bytes());
        feed_fnv1a(&mut hash, &[0]);
        let mut keys = call.param_keys.clone();
        keys.sort();
        for key in &keys {
            feed_fnv1a(&mut hash, key.as_bytes());
            feed_fnv1a(&mut hash, &[0]);
        }
    }
    Some(format!("tools:fnv1a:{hash:016x}"))
}

/// FNV-1a 64 位单步喂入（offset basis 0xcbf29ce484222325、prime
/// 0x100000001b3，与 recovery.rs fingerprint 同参数）
fn feed_fnv1a(hash: &mut u64, bytes: &[u8]) {
    for &byte in bytes {
        *hash ^= u64::from(byte);
        *hash = hash.wrapping_mul(0x0000_0001_0000_01b3);
    }
}

/// reason 落库文案（对齐 run.rs:641-646 map_outcome_to_terminal 的
/// end_reason 字面量，保证 goal_state.stopped_reason 与 runs 表口径一致）
fn end_reason_detail(reason: AgentEndReason) -> String {
    match reason {
        AgentEndReason::Stop => "stop",
        AgentEndReason::MaxTurns => "max-turns",
        AgentEndReason::Aborted => "aborted",
        AgentEndReason::Error => "error",
        AgentEndReason::Stopped => "stopped",
    }
    .to_string()
}
