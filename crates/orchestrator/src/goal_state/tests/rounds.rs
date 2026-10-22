use super::*;

// ── U1：goal 未完成 stop 收场 → Continue（allows_auto_continue 生产
//    调用首例）──────────────────────────────────────────────

#[test]
fn u1_incomplete_stop_round_continues() {
    let input = round(
        AgentEndReason::Stop,
        "继续推进，正在处理文件。",
        &[stamp("read_file", &["path"])],
    );
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::Continue, "未完成应继续");
    assert!(assessment.should_continue, "stop 收场允许自动续轮（U1）");
    assert_eq!(assessment.stopped_reason.as_deref(), Some(STOP_REASON));
    assert_eq!(assessment.reason_detail, STOP_REASON);
    assert_eq!(assessment.stalled_delta, 0);
}

// ── U2：checklist 全勾 stop 收场 → Completed（L1 主门禁）─────

#[test]
fn u2_checklist_all_done_completes() {
    let input = round(
        AgentEndReason::Stop,
        "全部完成：\n- [x] 修复构建\n* [X] 补测试",
        &[],
    );
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::Completed, "L1 全勾完成");
    assert_eq!(
        assessment.stopped_reason.as_deref(),
        Some(GOAL_COMPLETED_REASON)
    );
    assert_eq!(assessment.reason_detail, GOAL_COMPLETED_REASON);
}

// ── U3：无 checklist 文案 DONE → Completed（L0 收口）────────

#[test]
fn u3_done_without_checklist_completes() {
    let input = round(AgentEndReason::Stop, "修复完成 DONE", &[]);
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::Completed, "L0 文案收口");
    assert_eq!(
        assessment.stopped_reason.as_deref(),
        Some(GOAL_COMPLETED_REASON)
    );
}

/// 「目标已完成」中文文案同样触发 L0
#[test]
fn u3_goal_done_chinese_phrase_completes() {
    let input = round(AgentEndReason::Stop, "目标已完成", &[]);
    assert_eq!(assess_round(&input).decision, GoalDecision::Completed);
}

// ── U4：文案 DONE 但 checklist 未全勾 → 不完成（prematureDoneClaim）
//    ──────────────────────────────────────────────────────────

#[test]
fn u4_done_with_open_tasks_does_not_complete() {
    let input = round(AgentEndReason::Stop, "DONE\n- [x] 任务A\n- [ ] 任务B", &[]);
    let assessment = assess_round(&input);
    assert_ne!(
        assessment.decision,
        GoalDecision::Completed,
        "反假完成：清单未全勾不因文案 DONE 收口"
    );
    // 纯文字轮落入 stalled 检测（§3.3 步骤 5：NoProgress 即 continue
    // 路径，stalled 已递增——与 U6 无工具轮语义一致）
    assert!(
        matches!(
            assessment.decision,
            GoalDecision::Continue | GoalDecision::NoProgress
        ),
        "未完成应走继续推进路径（prematureDoneClaim 对齐）"
    );
}

// ── U5：工具批指纹连续相同 → stalled；达 max_stalled → Blocked ──

#[test]
fn u5_same_fingerprint_stalls_then_blocks() {
    let calls = [stamp("read_file", &["path"])];
    let sig = tool_batch_fingerprint(&calls).expect("有工具轮必有签名");
    let mut state = active_state();
    state.progress_signature = Some(sig);
    let first = RoundInput {
        current: state.clone(),
        tool_calls: calls.to_vec(),
        ..round(AgentEndReason::Stop, "重试读取", &calls)
    };
    let a1 = assess_round(&first);
    assert_eq!(a1.stalled_delta, 1, "指纹相同计入 stalled");
    assert_eq!(a1.decision, GoalDecision::NoProgress, "未达阈值继续");
    state = state.advance(&first, &a1);
    assert_eq!(state.stalled_rounds, 1);

    let second = RoundInput {
        current: state.clone(),
        tool_calls: calls.to_vec(),
        ..round(AgentEndReason::Stop, "再次重试", &calls)
    };
    let a2 = assess_round(&second);
    assert_eq!(a2.decision, GoalDecision::Blocked, "达阈值停滞阻断");
    assert_eq!(a2.stopped_reason.as_deref(), Some(GOAL_STALLED_REASON));
    assert_eq!(a2.reason_detail, GOAL_STALLED_REASON);
    state = state.advance(&second, &a2);
    assert_eq!(state.stalled_rounds, 2);
    assert!(state.is_terminal(), "goal-stalled 后为终态");
}

// ── U6：无工具轮（纯文字总结）→ 签名沿用 → stalled_delta=1 ──

#[test]
fn u6_text_only_round_keeps_signature_and_stalls() {
    let mut state = active_state();
    state.progress_signature = Some("tools:fnv1a:7f3a123456789abc".into());
    let input = RoundInput {
        current: state,
        tool_calls: vec![],
        ..round(AgentEndReason::Stop, "总结一下进展", &[])
    };
    let assessment = assess_round(&input);
    assert_eq!(
        assessment.stalled_delta, 1,
        "纯文字轮正确计入 stalled（03 §2D）"
    );
    assert_eq!(
        assessment.next_progress_signature, None,
        "无工具轮不产出新签名，沿用上轮"
    );
}

/// 从未有工具轮的第一轮纯文字：None 签名视为相同，同样计入 stalled
#[test]
fn u6_first_text_only_round_stalls() {
    let input = round(AgentEndReason::Stop, "先想一下方案", &[]);
    let assessment = assess_round(&input);
    assert_eq!(
        assessment.stalled_delta, 1,
        "无历史签名时纯文字轮计入 stalled"
    );
    assert_eq!(assessment.decision, GoalDecision::NoProgress);
}

// ── U7：成功工具结果重置 stalled、签名更新 ──────────────────

#[test]
fn u7_successful_tool_resets_stalled_and_updates_signature() {
    let mut state = active_state();
    state.stalled_rounds = 1;
    state.progress_signature = Some("tools:fnv1a:old000000000000".into());
    let calls = [stamp("write_file", &["path", "content"])];
    let input = RoundInput {
        current: state,
        tool_calls: calls.to_vec(),
        tool_success_count: 2,
        ..round(AgentEndReason::Stop, "写入成功", &calls)
    };
    let assessment = assess_round(&input);
    assert_eq!(
        assessment.stalled_delta, 0,
        "成功工具结果重置 stalled（U7）"
    );
    let next_sig = assessment.next_progress_signature.clone().unwrap();
    assert!(next_sig.starts_with("tools:fnv1a:"), "签名更新为工具批指纹");
    assert_ne!(next_sig, "tools:fnv1a:old000000000000");
    assert_eq!(assessment.decision, GoalDecision::Continue);
}

// ── U8：max_rounds 耗尽 → Blocked(goal-max-rounds)；后续 NoGoal ──

#[test]
fn u8_max_rounds_exhausted_blocks_and_no_goal_after() {
    let mut state = active_state();
    state.current_round = 11;
    let input = RoundInput {
        current: state.clone(),
        ..round(AgentEndReason::Stop, "还没完成", &[])
    };
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::Blocked, "轮数耗尽阻断");
    assert_eq!(
        assessment.stopped_reason.as_deref(),
        Some(GOAL_MAX_ROUNDS_REASON)
    );

    let advanced = state.advance(&input, &assessment);
    assert_eq!(advanced.current_round, 12);
    assert!(advanced.is_terminal(), "goal-max-rounds 后为终态");
    assert!(
        !advanced.goal_pending(AgentEndReason::Stop),
        "此后 goal_pending 恒 false（A3）"
    );

    // 后续评估：已终态 → NoGoal，不评估不写、不续
    let after = RoundInput {
        current: advanced,
        ..round(AgentEndReason::Stop, "继续", &[])
    };
    let a2 = assess_round(&after);
    assert_eq!(a2.decision, GoalDecision::NoGoal);
    assert!(!a2.should_continue, "终态后不应继续（U8 后续评估）");
}

// ── U9：error 收场 → Blocked；stalled_delta=0、current_round 不递增 ──

#[test]
fn u9_error_round_blocks_without_consuming_rounds() {
    let mut state = active_state();
    state.stalled_rounds = 1;
    state.current_round = 2;
    let input = RoundInput {
        current: state.clone(),
        runtime_error: Some("provider 中断".into()),
        ..round(AgentEndReason::Error, "", &[])
    };
    let assessment = assess_round(&input);
    assert_eq!(assessment.decision, GoalDecision::Blocked);
    assert_eq!(assessment.reason_detail, "error");
    assert_eq!(assessment.stalled_delta, 0, "error 轮不计 stalled（U9）");
    assert!(
        !assessment.should_continue,
        "error 不触发 goal_pending（A4）"
    );

    let advanced = state.advance(&input, &assessment);
    assert_eq!(
        advanced.current_round, 2,
        "error 轮不递增 current_round（01 §3 第3条）"
    );
    assert_eq!(advanced.stalled_rounds, 1, "error 轮 stalled 保持");
}

// ── U10：max-turns / aborted / stopped 收场 → 不触发 goal_pending ──

#[test]
fn u10_non_stop_reasons_never_continue() {
    for reason in [
        AgentEndReason::MaxTurns,
        AgentEndReason::Aborted,
        AgentEndReason::Stopped,
    ] {
        let input = round(reason, "收场", &[]);
        let assessment = assess_round(&input);
        assert_eq!(
            assessment.decision,
            GoalDecision::Blocked,
            "{reason:?} 阻断"
        );
        assert!(
            !assessment.should_continue,
            "{reason:?} 不触发 goal_pending（U10）"
        );
        assert_eq!(assessment.stalled_delta, 0);
        let expected = match reason {
            AgentEndReason::MaxTurns => "max-turns",
            AgentEndReason::Aborted => "aborted",
            AgentEndReason::Stopped => "stopped",
            AgentEndReason::Stop | AgentEndReason::Error => unreachable!(),
        };
        assert_eq!(assessment.reason_detail, expected);
    }
}
