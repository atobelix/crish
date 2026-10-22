//! S6–S8e：子代理终态、后台任务与 kill 来源判定矩阵

use super::*;

#[test]
fn s6_subagent_completed_p1() {
    let intent = push_intent(
        &subagent_ended("sa-3", SubagentEndStatus::Completed),
        &ctx(),
    )
    .expect("S6 必须推");
    assert_eq!(intent.scene, SceneId::SubagentCompleted);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "subagent-ended:sa-3");

    // cancelled 同族 P1（D7 §3.2 行 31），去重键独立
    let cancelled = push_intent(
        &subagent_ended("sa-4", SubagentEndStatus::Cancelled),
        &ctx(),
    )
    .expect("S6 cancelled 同族 P1");
    assert_eq!(cancelled.scene, SceneId::SubagentCompleted);
    assert_eq!(cancelled.level, PushLevel::P1Important);
    assert_eq!(cancelled.dedupe_key, "subagent-ended:sa-4:cancelled");
}

#[test]
fn s7_subagent_failed_p0() {
    let intent =
        push_intent(&subagent_ended("sa-4", SubagentEndStatus::Failed), &ctx()).expect("S7 必须推");
    assert_eq!(intent.scene, SceneId::SubagentFailed);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "subagent-ended:sa-4:failed");
}

#[test]
fn s8a_task_started_daemon_p2() {
    let daemon = AgentEvent::TaskStarted {
        session_id: "s-7".to_string(),
        task_id: "t-1".to_string(),
        command: "npm run build".to_string(),
        cwd: "C:\\workspace".to_string(),
        owner_run_id: "run-42".to_string(),
        is_daemon: true,
    };
    let intent = push_intent(&daemon, &ctx()).expect("S8a daemon 必须推");
    assert_eq!(intent.scene, SceneId::TaskStarted);
    assert_eq!(intent.level, PushLevel::P2Collapsible);
    assert_eq!(intent.dedupe_key, "task-started:t-1");

    let plain = AgentEvent::TaskStarted {
        session_id: "s-7".to_string(),
        task_id: "t-2".to_string(),
        command: "echo hi".to_string(),
        cwd: "C:\\workspace".to_string(),
        owner_run_id: "run-42".to_string(),
        is_daemon: false,
    };
    assert_eq!(push_intent(&plain, &ctx()), None, "普通任务启动不推");
}

#[test]
fn s8b_task_completed_p1() {
    let event = AgentEvent::TaskCompleted {
        session_id: "s-7".to_string(),
        task_id: "t-11".to_string(),
        exit_code: 0,
        duration_ms: 125_000,
        line_count: 42,
    };
    let intent = push_intent(&event, &ctx()).expect("S8b 必须推");
    assert_eq!(intent.scene, SceneId::TaskCompleted);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "task-completed:t-11");
    assert_eq!(intent.payload.detail.as_deref(), Some("exit code 0"));
}

#[test]
fn s8c_task_suspicious_p0() {
    let event = AgentEvent::TaskSuspicious {
        session_id: "s-7".to_string(),
        task_id: "t-12".to_string(),
        silence_ms: 120_000,
        last_output_at_ms: 1_786_214_500_000,
    };
    let intent = push_intent(&event, &ctx()).expect("S8c 必须推");
    assert_eq!(intent.scene, SceneId::TaskSuspicious);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "task-suspicious:t-12");
}

#[test]
fn s8d_task_failed_p0() {
    let event = AgentEvent::TaskFailed {
        session_id: "s-7".to_string(),
        task_id: "t-11".to_string(),
        exit_code: 1,
        tail: vec!["npm ERR! code ELIFECYCLE".to_string()],
        duration_ms: 125_000,
    };
    let intent = push_intent(&event, &ctx()).expect("S8d 必须推");
    assert_eq!(intent.scene, SceneId::TaskFailed);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "task-failed:t-11");
    assert_eq!(
        intent.payload.digest.as_deref(),
        Some("npm ERR! code ELIFECYCLE")
    );
}

#[test]
fn s8e_task_killed_force_p1() {
    let force = AgentEvent::TaskKilled {
        session_id: "s-7".to_string(),
        task_id: "t-3".to_string(),
        via_force: true,
        diagnostics: Some("watchdog 强制终止".to_string()),
    };
    let intent = push_intent(&force, &ctx()).expect("S8e 强制终止必须推");
    assert_eq!(intent.scene, SceneId::TaskKilled);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "task-killed:t-3");

    let graceful = AgentEvent::TaskKilled {
        session_id: "s-7".to_string(),
        task_id: "t-3".to_string(),
        via_force: false,
        diagnostics: None,
    };
    assert_eq!(
        push_intent(&graceful, &ctx()),
        None,
        "用户主动（非强制）kill 不推（D7 §3.3 S8e）"
    );
}

/// S8e 来源判定矩阵（R3-01a 补强）：来源精确优先，未知回退 via_force
#[test]
fn s8e_kill_source_matrix() {
    // 来源精确判定优先于 via_force：用户 kill 即使两阶段升级强制也不推
    assert!(!task_killed_should_push(
        Some(RunTerminationSource::UserKilled),
        true
    ));
    assert!(!task_killed_should_push(
        Some(RunTerminationSource::UserKilled),
        false
    ));
    // 系统/watchdog：来源=引擎终止恒推
    assert!(task_killed_should_push(
        Some(RunTerminationSource::EngineTerminated),
        true
    ));
    assert!(task_killed_should_push(
        Some(RunTerminationSource::EngineTerminated),
        false
    ));
    // 来源未知：回退 R3-01a via_force 近似
    assert!(!task_killed_should_push(None, false));
    assert!(task_killed_should_push(None, true));
}

/// AgentEndReason → 来源（精确路径：agent-end 事件 reason 字段）
#[test]
fn s8e_agent_end_reason_mapping() {
    // 用户中止 / 用户协作停止 → 用户主动 kill
    assert_eq!(
        run_termination_source(AgentEndReason::Aborted),
        RunTerminationSource::UserKilled
    );
    assert_eq!(
        run_termination_source(AgentEndReason::Stopped),
        RunTerminationSource::UserKilled
    );
    // 正常收场 / 预算用尽 / 错误收场 → 引擎终止
    assert_eq!(
        run_termination_source(AgentEndReason::Stop),
        RunTerminationSource::EngineTerminated
    );
    assert_eq!(
        run_termination_source(AgentEndReason::MaxTurns),
        RunTerminationSource::EngineTerminated
    );
    assert_eq!(
        run_termination_source(AgentEndReason::Error),
        RunTerminationSource::EngineTerminated
    );
}

/// RunTerminalStatus → 来源（等价路径：无 agent-end 时的回退判定）
#[test]
fn s8e_run_terminal_status_mapping() {
    assert_eq!(
        run_terminal_source(RunTerminalStatus::Cancelled),
        RunTerminationSource::UserKilled,
        "取消保守归用户主动（S8e 宁可少推）"
    );
    assert_eq!(
        run_terminal_source(RunTerminalStatus::Completed),
        RunTerminationSource::EngineTerminated
    );
    assert_eq!(
        run_terminal_source(RunTerminalStatus::Failed),
        RunTerminationSource::EngineTerminated
    );
}

/// S8e 注入面：用户 kill（含 Windows 升级强制形态）→ 不推；
/// 系统/watchdog kill → 推（优雅形态也推——来源判定优先）
#[test]
fn s8e_injected_source_overrides_via_force() {
    let killed_force = AgentEvent::TaskKilled {
        session_id: "s-7".to_string(),
        task_id: "t-3".to_string(),
        via_force: true,
        diagnostics: Some("升级强制终止".to_string()),
    };
    // 用户 kill（Windows 两阶段升级 via_force=true 仍属用户行为）→ 不推
    assert_eq!(
        push_intent_with_kill_source(
            &killed_force,
            &ctx(),
            Some(RunTerminationSource::UserKilled)
        ),
        None,
        "用户 kill 即使升级为强制也不推（精确来源覆盖 via_force 近似）"
    );

    // 系统/watchdog 强制 kill → 推（P1）
    let intent = push_intent_with_kill_source(
        &killed_force,
        &ctx(),
        Some(RunTerminationSource::EngineTerminated),
    )
    .expect("系统强制 kill 必须推");
    assert_eq!(intent.scene, SceneId::TaskKilled);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "task-killed:t-3");

    // 系统优雅形态（via_force=false 但来源=引擎终止）→ 推
    let killed_graceful = AgentEvent::TaskKilled {
        session_id: "s-7".to_string(),
        task_id: "t-3".to_string(),
        via_force: false,
        diagnostics: None,
    };
    let intent = push_intent_with_kill_source(
        &killed_graceful,
        &ctx(),
        Some(RunTerminationSource::EngineTerminated),
    )
    .expect("系统终止任务必须推");
    assert_eq!(intent.dedupe_key, "task-killed:t-3");

    // 注入 None = push_intent 等价（来源未知回退 via_force 近似）
    assert_eq!(
        push_intent_with_kill_source(&killed_graceful, &ctx(), None),
        push_intent(&killed_graceful, &ctx()),
        "注入 None 与默认函数行为一致"
    );
}

#[test]
fn s6_s7_subagent_full_fields() {
    let summary = Some("已产出缺口分析 5 页");
    let cases = [
        (
            SubagentEndStatus::Failed,
            SceneId::SubagentFailed,
            PushLevel::P0Critical,
            "subagent-ended:sa-3:failed",
        ),
        (
            SubagentEndStatus::Completed,
            SceneId::SubagentCompleted,
            PushLevel::P1Important,
            "subagent-ended:sa-3",
        ),
        (
            SubagentEndStatus::Cancelled,
            SceneId::SubagentCompleted,
            PushLevel::P1Important,
            "subagent-ended:sa-3:cancelled",
        ),
    ];
    for (status, scene, level, dedupe) in cases {
        assert_eq!(
            push_intent(&subagent_ended("sa-3", status), &ctx()),
            Some(expected_intent(
                scene,
                level,
                PushTargetScreen::Subagent,
                dedupe,
                "session:s-7",
                payload_digest("sa-3", summary, None),
            ))
        );
    }
}

#[test]
fn s8a_s8d_task_full_fields() {
    let started = AgentEvent::TaskStarted {
        session_id: "s-7".to_string(),
        task_id: "t-1".to_string(),
        command: "npm run build".to_string(),
        cwd: "C:\\workspace".to_string(),
        owner_run_id: "run-42".to_string(),
        is_daemon: true,
    };
    assert_eq!(
        push_intent(&started, &ctx()),
        Some(expected_intent(
            SceneId::TaskStarted,
            PushLevel::P2Collapsible,
            PushTargetScreen::Task,
            "task-started:t-1",
            "session:s-7",
            payload_digest("t-1", Some("npm run build"), None),
        ))
    );

    let completed = AgentEvent::TaskCompleted {
        session_id: "s-7".to_string(),
        task_id: "t-11".to_string(),
        exit_code: 0,
        duration_ms: 125_000,
        line_count: 42,
    };
    assert_eq!(
        push_intent(&completed, &ctx()),
        Some(expected_intent(
            SceneId::TaskCompleted,
            PushLevel::P1Important,
            PushTargetScreen::Task,
            "task-completed:t-11",
            "session:s-7",
            payload_digest("t-11", None, Some("exit code 0")),
        ))
    );

    let suspicious = AgentEvent::TaskSuspicious {
        session_id: "s-7".to_string(),
        task_id: "t-12".to_string(),
        silence_ms: 120_000,
        last_output_at_ms: 1_786_214_500_000,
    };
    assert_eq!(
        push_intent(&suspicious, &ctx()),
        Some(expected_intent(
            SceneId::TaskSuspicious,
            PushLevel::P0Critical,
            PushTargetScreen::Task,
            "task-suspicious:t-12",
            "session:s-7",
            payload_digest("t-12", Some("120000"), None),
        ))
    );

    // tail 取末行；空 tail → digest None
    let failed = AgentEvent::TaskFailed {
        session_id: "s-7".to_string(),
        task_id: "t-11".to_string(),
        exit_code: 1,
        tail: vec!["line-1".to_string(), "npm ERR! code ELIFECYCLE".to_string()],
        duration_ms: 125_000,
    };
    assert_eq!(
        push_intent(&failed, &ctx()),
        Some(expected_intent(
            SceneId::TaskFailed,
            PushLevel::P0Critical,
            PushTargetScreen::Task,
            "task-failed:t-11",
            "session:s-7",
            payload_digest(
                "t-11",
                Some("npm ERR! code ELIFECYCLE"),
                Some("exit code 1")
            ),
        ))
    );
    let failed_empty = AgentEvent::TaskFailed {
        session_id: "s-7".to_string(),
        task_id: "t-11".to_string(),
        exit_code: 2,
        tail: vec![],
        duration_ms: 1,
    };
    assert_eq!(
        push_intent(&failed_empty, &ctx())
            .expect("S8d 空 tail 仍推")
            .payload,
        payload_digest("t-11", None, Some("exit code 2"))
    );
}

/// S8e 全组合：(来源 × via_force) 六格，推送与否严格等于
/// [task_killed_should_push]，推送时全字段一致
#[test]
fn s8e_task_killed_full_matrix() {
    for source in ALL_KILL_SOURCES {
        for via_force in [false, true] {
            let event = AgentEvent::TaskKilled {
                session_id: "s-7".to_string(),
                task_id: "t-3".to_string(),
                via_force,
                diagnostics: Some("diag".to_string()),
            };
            let expected = task_killed_should_push(source, via_force).then(|| {
                expected_intent(
                    SceneId::TaskKilled,
                    PushLevel::P1Important,
                    PushTargetScreen::Task,
                    "task-killed:t-3",
                    "session:s-7",
                    payload_digest("t-3", Some("diag"), None),
                )
            });
            assert_eq!(
                push_intent_with_kill_source(&event, &ctx(), source),
                expected,
                "source={source:?} via_force={via_force}"
            );
        }
    }
}

/// kill 来源注入只影响 S8e：其余每个分支在三种来源下结果与 push_intent 一致
#[test]
fn kill_source_only_affects_task_killed() {
    let events = vec![
        approval_requested("tc-1", "bash", "s"),
        run_terminal("run-42", RunTerminalStatus::Cancelled, None),
        run_terminal("run-42", RunTerminalStatus::Failed, Some("e")),
        subagent_ended("sa-1", SubagentEndStatus::Cancelled),
        AgentEvent::TaskFailed {
            session_id: "s-7".to_string(),
            task_id: "t-1".to_string(),
            exit_code: 1,
            tail: vec![],
            duration_ms: 1,
        },
        security_audit(SecurityAuditDecision::Blocked, Some("tc-2")),
        AgentEvent::AgentEnd {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            reason: AgentEndReason::Aborted,
            error: None,
        },
    ];
    for event in &events {
        let baseline = push_intent(event, &ctx_with_run("run-42"));
        for source in ALL_KILL_SOURCES {
            assert_eq!(
                push_intent_with_kill_source(event, &ctx_with_run("run-42"), source),
                baseline,
                "{} source={source:?}",
                event.type_name()
            );
        }
    }
}
