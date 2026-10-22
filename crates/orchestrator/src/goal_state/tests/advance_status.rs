use super::*;

// ── 补充：advance 纯函数写回 ────────────────────────────────

#[test]
fn advance_updates_stopped_reason_and_timestamp() {
    let state = active_state();
    let input = round(AgentEndReason::Stop, "未完成", &[]);
    let assessment = assess_round(&input);
    let advanced = state.advance(&input, &assessment);
    assert_eq!(advanced.current_round, 1, "Stop 轮 current_round + 1");
    assert_eq!(advanced.stopped_reason.as_deref(), Some(STOP_REASON));
    assert!(advanced.updated_at_ms > 0, "写方刷新时间戳");
    assert!(advanced.is_active(), "未完成未阻断仍 Active");
}

#[test]
fn advance_no_goal_returns_unchanged() {
    let mut state = active_state();
    state.stopped_reason = Some(GOAL_COMPLETED_REASON.into());
    let input = RoundInput {
        current: state.clone(),
        ..round(AgentEndReason::Stop, "完成后又一轮", &[])
    };
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::NoGoal);
    assert_eq!(
        state.advance(&input, &assessment),
        state,
        "NoGoal 不评估不写"
    );
}

// ── 补充：goal_pending 判定（§3.6 第四源语义）────────────────

#[test]
fn goal_pending_only_when_active_under_limit_and_stop() {
    let state = active_state();
    assert!(
        state.goal_pending(AgentEndReason::Stop),
        "进行中未达上限 + stop → pending"
    );
    assert!(
        !state.goal_pending(AgentEndReason::Error),
        "error 不续（A4）"
    );
    assert!(
        !state.goal_pending(AgentEndReason::MaxTurns),
        "max-turns 不续"
    );
    assert!(!state.goal_pending(AgentEndReason::Stopped), "stopped 不续");

    let mut at_limit = active_state();
    at_limit.current_round = at_limit.max_rounds;
    assert!(
        !at_limit.goal_pending(AgentEndReason::Stop),
        "达上限后恒 false（A3）"
    );

    let mut terminal = active_state();
    terminal.stopped_reason = Some(GOAL_STALLED_REASON.into());
    assert!(
        !terminal.goal_pending(AgentEndReason::Stop),
        "终态后恒 false"
    );
}

// ── 补充：status 推断（§4.1：终态后 status 由 stopped_reason 推断）──

#[test]
fn status_inferred_from_stopped_reason() {
    assert_eq!(active_state().status(), GoalStatus::Active);
    let mut done = active_state();
    done.stopped_reason = Some(GOAL_COMPLETED_REASON.into());
    assert_eq!(done.status(), GoalStatus::Completed);
    for reason in [
        GOAL_MAX_ROUNDS_REASON,
        GOAL_STALLED_REASON,
        "error",
        "max-turns",
        "aborted",
        "stopped",
    ] {
        let mut state = active_state();
        state.stopped_reason = Some(reason.into());
        assert_eq!(state.status(), GoalStatus::Blocked, "{reason} 归为 Blocked");
    }
    let mut active = active_state();
    active.stopped_reason = Some(STOP_REASON.into());
    assert_eq!(active.status(), GoalStatus::Active, "stop 为中间态");
}

/// 完成优先于轮数上限：最后一轮达成完成信号 → goal-completed 而非
/// goal-max-rounds（伪代码步骤 3「且未完成」+ 前端 done 先于 max_iter）
#[test]
fn completion_wins_over_round_limit_on_last_round() {
    let mut state = active_state();
    state.current_round = 11;
    let input = RoundInput {
        current: state,
        ..round(AgentEndReason::Stop, "- [x] 全部任务完成", &[])
    };
    let assessment = assess_round(&input);
    assert_eq!(
        assessment.decision,
        GoalDecision::Completed,
        "最后一轮完成 → goal-completed（非 goal-max-rounds）"
    );
    assert_eq!(assessment.reason_detail, GOAL_COMPLETED_REASON);
}

/// 完成判定不消耗 stalled 语义：完成轮不参与 stalled 检测
#[test]
fn completed_round_bypasses_stalled() {
    let mut state = active_state();
    state.stalled_rounds = 1;
    let input = RoundInput {
        current: state,
        tool_calls: vec![stamp("read_file", &["path"])],
        ..round(AgentEndReason::Stop, "- [x] 完成\nDONE", &[])
    };
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::Completed);
    assert_eq!(assessment.stalled_delta, 0);
}
