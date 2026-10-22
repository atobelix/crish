//! S1–S5：审批请求/过期与 run 终态

use super::*;

// ── 13 场景矩阵（登记表 18 行逐行断言）──

#[test]
fn s1_approval_requested_p0() {
    let intent = push_intent(
        &approval_requested("tc-9f3a", "bash", "执行部署脚本"),
        &ctx(),
    )
    .expect("S1 必须推");
    assert_eq!(intent.scene, SceneId::ApprovalRequested);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "approval-requested:tc-9f3a");
    assert_eq!(intent.target, PushTargetScreen::Approval);
    assert_eq!(intent.payload.biz_key, "tc-9f3a");
    assert_eq!(intent.payload.detail.as_deref(), Some("bash"));
    let approval = intent.approval.expect("S1 必须带审批引用");
    assert_eq!(approval.tool_call_id, "tc-9f3a");
    assert_eq!(approval.dedupe_key, "approval-requested:tc-9f3a");
}

#[test]
fn s2_approval_expired_p0_others_skipped() {
    let expired = AgentEvent::ApprovalResolved {
        session_id: "s-7".to_string(),
        tool_call_id: "tc-9f3a".to_string(),
        request_id: None,
        decision: ApprovalDecision::Expired,
        timestamp: "2026-08-13T10:00:00Z".to_string(),
    };
    let intent = push_intent(&expired, &ctx()).expect("S2 expired 必须推");
    assert_eq!(intent.scene, SceneId::ApprovalExpired);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "approval-resolved:tc-9f3a:expired");
    assert!(intent.approval.is_some());

    for decision in [ApprovalDecision::Approved, ApprovalDecision::Denied] {
        let resolved = AgentEvent::ApprovalResolved {
            session_id: "s-7".to_string(),
            tool_call_id: "tc-9f3a".to_string(),
            request_id: None,
            decision,
            timestamp: "2026-08-13T10:00:00Z".to_string(),
        };
        assert_eq!(
            push_intent(&resolved, &ctx()),
            None,
            "approved/denied 是决策回执，不推（D7 §3.3 S2）"
        );
    }
}

#[test]
fn s3_run_completed_p1() {
    let intent = push_intent(
        &run_terminal("run-42", RunTerminalStatus::Completed, None),
        &ctx(),
    )
    .expect("S3 必须推");
    assert_eq!(intent.scene, SceneId::RunCompleted);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "run-terminal:run-42");
    assert_eq!(intent.target, PushTargetScreen::Session);
}

#[test]
fn s4_run_failed_p0() {
    let intent = push_intent(
        &run_terminal("run-42", RunTerminalStatus::Failed, Some("provider 401")),
        &ctx(),
    )
    .expect("S4 必须推");
    assert_eq!(intent.scene, SceneId::RunFailed);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "run-terminal:run-42:failed");
    assert_eq!(intent.payload.digest.as_deref(), Some("provider 401"));
}

#[test]
fn s5_run_cancelled_p1() {
    let intent = push_intent(
        &run_terminal("run-42", RunTerminalStatus::Cancelled, None),
        &ctx(),
    )
    .expect("S5 必须推");
    assert_eq!(intent.scene, SceneId::RunCancelled);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "run-terminal:run-42:cancelled");
}

#[test]
fn s1_s2_approval_full_fields() {
    let mut s1 = expected_intent(
        SceneId::ApprovalRequested,
        PushLevel::P0Critical,
        PushTargetScreen::Approval,
        "approval-requested:tc-9f3a",
        "session:s-7",
        payload_digest("tc-9f3a", Some("执行部署脚本"), Some("bash")),
    );
    s1.approval = Some(ApprovalPushRef {
        tool_call_id: "tc-9f3a".to_string(),
        session_id: "s-7".to_string(),
        dedupe_key: "approval-requested:tc-9f3a".to_string(),
    });
    assert_eq!(
        push_intent(
            &approval_requested("tc-9f3a", "bash", "执行部署脚本"),
            &ctx()
        ),
        Some(s1)
    );

    let mut s2 = expected_intent(
        SceneId::ApprovalExpired,
        PushLevel::P0Critical,
        PushTargetScreen::Approval,
        "approval-resolved:tc-9f3a:expired",
        "session:s-7",
        payload_digest("tc-9f3a", None, None),
    );
    s2.approval = Some(ApprovalPushRef {
        tool_call_id: "tc-9f3a".to_string(),
        session_id: "s-7".to_string(),
        dedupe_key: "approval-resolved:tc-9f3a:expired".to_string(),
    });
    let expired = AgentEvent::ApprovalResolved {
        session_id: "s-7".to_string(),
        tool_call_id: "tc-9f3a".to_string(),
        request_id: Some("req-1".to_string()),
        decision: ApprovalDecision::Expired,
        timestamp: "2026-08-13T10:00:00Z".to_string(),
    };
    assert_eq!(push_intent(&expired, &ctx()), Some(s2));
}

#[test]
fn s3_s5_run_terminal_full_fields() {
    // completed / cancelled 忽略 error 字段；failed 透传 error（含 None）
    assert_eq!(
        push_intent(
            &run_terminal("run-42", RunTerminalStatus::Completed, Some("ignored")),
            &ctx()
        ),
        Some(expected_intent(
            SceneId::RunCompleted,
            PushLevel::P1Important,
            PushTargetScreen::Session,
            "run-terminal:run-42",
            "session:s-7",
            payload_digest("run-42", None, None),
        ))
    );
    assert_eq!(
        push_intent(
            &run_terminal("run-42", RunTerminalStatus::Failed, Some("provider 401")),
            &ctx()
        ),
        Some(expected_intent(
            SceneId::RunFailed,
            PushLevel::P0Critical,
            PushTargetScreen::Session,
            "run-terminal:run-42:failed",
            "session:s-7",
            payload_digest("run-42", Some("provider 401"), None),
        ))
    );
    assert_eq!(
        push_intent(
            &run_terminal("run-42", RunTerminalStatus::Failed, None),
            &ctx()
        )
        .expect("S4 error 缺失仍推")
        .payload
        .digest,
        None
    );
    assert_eq!(
        push_intent(
            &run_terminal("run-42", RunTerminalStatus::Cancelled, Some("ignored")),
            &ctx()
        ),
        Some(expected_intent(
            SceneId::RunCancelled,
            PushLevel::P1Important,
            PushTargetScreen::Session,
            "run-terminal:run-42:cancelled",
            "session:s-7",
            payload_digest("run-42", None, None),
        ))
    );
}
