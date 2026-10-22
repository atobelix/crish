//! S9a–S12：定时器/cron、运行时、安全拦截、缓存浪费；P3 不推护栏与去重键格式

use super::*;

#[test]
fn s9a_timer_fired_p1() {
    let event = AgentEvent::TimerFired {
        session_id: "s-7".to_string(),
        timer_id: "timer-1".to_string(),
        prompt: "请检查任务进度".to_string(),
        fired_at_ms: 1_786_214_700_000,
    };
    let intent = push_intent(&event, &ctx()).expect("S9a 必须推");
    assert_eq!(intent.scene, SceneId::TimerFired);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "timer-fired:timer-1");
    assert_eq!(intent.collapse_key, "timer:timer-1");
    assert_eq!(intent.payload.digest.as_deref(), Some("请检查任务进度"));
}

#[test]
fn s9b_cron_fired_p1() {
    let event = AgentEvent::CronFired {
        session_id: "s-7".to_string(),
        cron_id: "cron-2".to_string(),
        prompt: "日报生成".to_string(),
        expression: "0 9 * * *".to_string(),
        iteration: 3,
        fired_at_ms: 1_786_214_700_000,
    };
    let intent = push_intent(&event, &ctx()).expect("S9b 必须推");
    assert_eq!(intent.scene, SceneId::CronFired);
    assert_eq!(intent.level, PushLevel::P1Important);
    assert_eq!(intent.dedupe_key, "cron-fired:cron-2:3");
    assert_eq!(intent.collapse_key, "cron:cron-2");
}

#[test]
fn s10a_runtime_error_p0() {
    let event = AgentEvent::RuntimeError {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        error: "provider 429 限流".to_string(),
        retryable: Some(true),
    };
    let intent = push_intent(&event, &ctx_with_run("run-42")).expect("S10a 必须推");
    assert_eq!(intent.scene, SceneId::RuntimeError);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "runtime-error:run-42");

    // 信封 runId 缺失 → session 回退键（不 panic）
    let fallback = push_intent(&event, &ctx()).expect("S10a runId 缺失仍推");
    assert_eq!(fallback.dedupe_key, "runtime-error:session:s-7");
}

#[test]
fn s10b_intervention_required_p0() {
    let event = AgentEvent::RuntimeInterventionRequired {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        reason: "缺少 API 密钥".to_string(),
        choices: vec!["设置密钥".to_string(), "跳过".to_string()],
        message: "请选择".to_string(),
    };
    let intent = push_intent(&event, &ctx_with_run("run-42")).expect("S10b 必须推");
    assert_eq!(intent.scene, SceneId::InterventionRequired);
    assert_eq!(intent.level, PushLevel::P0Critical);
    assert_eq!(intent.dedupe_key, "intervention:run-42");
    assert_eq!(intent.payload.digest.as_deref(), Some("缺少 API 密钥"));
}

#[test]
fn s11_security_blocked_purged_p0() {
    let blocked = push_intent(
        &security_audit(SecurityAuditDecision::Blocked, Some("tc-9f4b")),
        &ctx(),
    )
    .expect("S11 blocked 必须推");
    assert_eq!(blocked.scene, SceneId::SecurityBlocked);
    assert_eq!(blocked.level, PushLevel::P0Critical);
    assert_eq!(blocked.dedupe_key, "security-audit:tc-9f4b");
    assert_eq!(blocked.target, PushTargetScreen::Audit);

    let purged = push_intent(
        &security_audit(SecurityAuditDecision::Purged, Some("tc-9f4c")),
        &ctx(),
    )
    .expect("S11 purged 必须推");
    assert_eq!(purged.dedupe_key, "security-audit:tc-9f4c");

    // 无 tool_call_id → sequence 回退（Z0 §4.12：security-audit:{sequence}）
    let seq_ctx = PushIntentCtx {
        envelope_run_id: None,
        sequence: Some(112),
    };
    let fallback = push_intent(
        &security_audit(SecurityAuditDecision::Blocked, None),
        &seq_ctx,
    )
    .expect("S11 sequence 回退");
    assert_eq!(fallback.dedupe_key, "security-audit:seq:112");

    // 不推子集：approved/denied/redirected/restored
    for decision in [
        SecurityAuditDecision::Approved,
        SecurityAuditDecision::Denied,
        SecurityAuditDecision::Redirected,
        SecurityAuditDecision::Restored,
    ] {
        assert_eq!(
            push_intent(&security_audit(decision, Some("tc-1")), &ctx()),
            None,
            "S11 不推子集：{decision:?}"
        );
    }
}

#[test]
fn s12_cache_waste_alert_p2() {
    let event = AgentEvent::CacheWasteAlert {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        attribution: MissAttribution::IdleTtlExpired,
        missed_tokens: 24_000,
        idle_ms: 3_600_000,
        model_changed: false,
        missed_cost_usd: Some(0.12),
    };
    let intent = push_intent(&event, &ctx_with_run("run-42")).expect("S12 必须推");
    assert_eq!(intent.scene, SceneId::CacheWasteAlert);
    assert_eq!(intent.level, PushLevel::P2Collapsible);
    assert_eq!(intent.dedupe_key, "cache-waste-alert:run-42");

    let fallback = push_intent(&event, &ctx()).expect("S12 runId 缺失仍推");
    assert_eq!(fallback.dedupe_key, "cache-waste-alert:session:s-7");
}

/// P3 负例：过程态/增量/诊断/低价值/恢复域/goal 域一律不推
#[test]
fn p3_no_push_events() {
    let no_push: Vec<AgentEvent> = vec![
        AgentEvent::AgentStart {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
        },
        AgentEvent::AgentEnd {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            reason: AgentEndReason::Stop,
            error: None,
        },
        AgentEvent::TurnStart {
            session_id: "s-7".to_string(),
            turn_index: 1,
            timestamp: "t".to_string(),
        },
        AgentEvent::TurnEnd {
            session_id: "s-7".to_string(),
            turn_index: 1,
            timestamp: "t".to_string(),
            tool_call_count: 0,
            usage: None,
        },
        AgentEvent::SteeringEvaluated {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            phase: "empty-response".to_string(),
            hit_strategies: vec![],
            steering_count_before: 0,
            steering_count_after: 0,
            budget_remaining: None,
            reset: false,
        },
        AgentEvent::ContextCompressionStart {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            reason: "超长".to_string(),
            tokens_before: 10,
        },
        AgentEvent::CacheStatsUpdated {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            stats: RunCacheStats::default(),
        },
        AgentEvent::ColdCacheWarning {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            ttl_seconds: 60,
            idle_ms: 100,
            resend_estimate_tokens: 5,
        },
        AgentEvent::SubagentStarted {
            session_id: "s-7".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sa-1-run".to_string(),
            role: "分析".to_string(),
            capability_mode: "readonly".to_string(),
            started_at: "t".to_string(),
            description: None,
            mode: None,
            parent_tool_call_id: None,
            subagent_session_id: None,
        },
        AgentEvent::SubagentEvent {
            session_id: "s-7".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sa-1-run".to_string(),
            event: SubagentEventPayload {
                kind: SubagentEventKind::Progress,
                payload: None,
            },
        },
        AgentEvent::TaskOutput {
            session_id: "s-7".to_string(),
            task_id: "t-1".to_string(),
            line: Some("hello".to_string()),
            chunk: None,
            line_count: Some(1),
        },
        AgentEvent::TaskHeartbeat {
            session_id: "s-7".to_string(),
            task_id: "t-1".to_string(),
            resource: serde_json::json!({"cpu": 1}),
        },
        AgentEvent::TimerCancelled {
            session_id: "s-7".to_string(),
            timer_id: "timer-1".to_string(),
            reason: "early-exit".to_string(),
            cancelled_at_ms: 100,
        },
        AgentEvent::RecoveryEscalated {
            session_id: "s-7".to_string(),
            subagent_run_id: Some("sa-1-run".to_string()),
            kind: "Timeout".to_string(),
            retries: 2,
            elapsed_ms: 100,
            detail: None,
        },
        AgentEvent::RecoverySteering {
            session_id: "s-7".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sa-1-run".to_string(),
            fingerprint: "fp-1".to_string(),
            retries: 2,
            remaining_status: "pending".to_string(),
            pending: true,
            created_at_ms: 100,
        },
        AgentEvent::RecoveryFork {
            session_id: "s-7".to_string(),
            fingerprint: "fp-1".to_string(),
            subagent_id: "sa-1".to_string(),
            from_run_id: "r1".to_string(),
            from_leaf_id: "l1".to_string(),
            new_run_id: "r2".to_string(),
            new_leaf_id: "l2".to_string(),
            context_mode: "verbatim".to_string(),
        },
        AgentEvent::RecoveryReport {
            session_id: "s-7".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "sa-1-run".to_string(),
            stuck_at_ms: 100,
            suggestion: "人工检查".to_string(),
        },
        AgentEvent::RecoveryBudgetDenied {
            session_id: "s-7".to_string(),
            subagent_run_id: Some("sa-1-run".to_string()),
            fingerprint: "fp-1".to_string(),
            count: 3,
            max: 5,
        },
        AgentEvent::GoalRoundStarted {
            round: 1,
            max_rounds: 5,
            goal: "修复 bug".to_string(),
        },
        AgentEvent::GoalRoundCompleted {
            round: 1,
            tool_call_count: 2,
            tool_success_count: 1,
            message_count: 3,
            decision: "Continue".to_string(),
            reason_detail: "继续".to_string(),
            stalled_delta: 0,
            evidence: "".to_string(),
        },
        AgentEvent::GoalContinuationDecided {
            action: "continue".to_string(),
            reason: "未完成".to_string(),
            prompt: None,
            progress_signature: None,
            detail: None,
        },
    ];
    for event in no_push {
        assert_eq!(
            push_intent(&event, &ctx()),
            None,
            "P3 事件不应产生推送意图：{}",
            event.type_name()
        );
    }
}

#[test]
fn dedupe_key_format() {
    assert_eq!(
        dedupe_key("approval-requested", "tc-1"),
        "approval-requested:tc-1"
    );
    assert_eq!(
        dedupe_key("run-terminal", "run-42:failed"),
        "run-terminal:run-42:failed"
    );
}

#[test]
fn s9_timer_cron_full_fields() {
    let timer = AgentEvent::TimerFired {
        session_id: "s-7".to_string(),
        timer_id: "timer-1".to_string(),
        prompt: "请检查任务进度".to_string(),
        fired_at_ms: 1_786_214_700_000,
    };
    assert_eq!(
        push_intent(&timer, &ctx_with_run("run-42")),
        Some(expected_intent(
            SceneId::TimerFired,
            PushLevel::P1Important,
            PushTargetScreen::Timer,
            "timer-fired:timer-1",
            "timer:timer-1",
            payload_digest("timer-1", Some("请检查任务进度"), None),
        ))
    );
    let cron = AgentEvent::CronFired {
        session_id: "s-7".to_string(),
        cron_id: "cron-2".to_string(),
        prompt: "日报生成".to_string(),
        expression: "0 9 * * *".to_string(),
        iteration: 3,
        fired_at_ms: 1_786_214_700_000,
    };
    assert_eq!(
        push_intent(&cron, &ctx_with_run("run-42")),
        Some(expected_intent(
            SceneId::CronFired,
            PushLevel::P1Important,
            PushTargetScreen::Timer,
            "cron-fired:cron-2:3",
            "cron:cron-2",
            payload_digest("cron-2", Some("日报生成"), Some("iteration 3")),
        ))
    );
}

#[test]
fn s10_runtime_full_fields() {
    let error = AgentEvent::RuntimeError {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        error: "provider 429 限流".to_string(),
        retryable: None,
    };
    assert_eq!(
        push_intent(&error, &ctx_with_run("run-42")),
        Some(expected_intent(
            SceneId::RuntimeError,
            PushLevel::P0Critical,
            PushTargetScreen::Session,
            "runtime-error:run-42",
            "session:s-7",
            payload_digest("run-42", Some("provider 429 限流"), None),
        ))
    );
    assert_eq!(
        push_intent(&error, &ctx()),
        Some(expected_intent(
            SceneId::RuntimeError,
            PushLevel::P0Critical,
            PushTargetScreen::Session,
            "runtime-error:session:s-7",
            "session:s-7",
            payload_digest("", Some("provider 429 限流"), None),
        ))
    );

    let intervention = AgentEvent::RuntimeInterventionRequired {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        reason: "缺少 API 密钥".to_string(),
        choices: vec![],
        message: "请选择".to_string(),
    };
    assert_eq!(
        push_intent(&intervention, &ctx_with_run("run-42")),
        Some(expected_intent(
            SceneId::InterventionRequired,
            PushLevel::P0Critical,
            PushTargetScreen::Session,
            "intervention:run-42",
            "session:s-7",
            payload_digest("run-42", Some("缺少 API 密钥"), None),
        ))
    );
    assert_eq!(
        push_intent(&intervention, &ctx()),
        Some(expected_intent(
            SceneId::InterventionRequired,
            PushLevel::P0Critical,
            PushTargetScreen::Session,
            "intervention:session:s-7",
            "session:s-7",
            payload_digest("", Some("缺少 API 密钥"), None),
        ))
    );
}

#[test]
fn s11_security_full_fields_and_key_priority() {
    let seq_ctx = PushIntentCtx {
        envelope_run_id: Some("run-42".to_string()),
        sequence: Some(112),
    };
    // tool_call_id 优先于 sequence
    assert_eq!(
        push_intent(
            &security_audit(SecurityAuditDecision::Purged, Some("tc-9f4b")),
            &seq_ctx
        ),
        Some(expected_intent(
            SceneId::SecurityBlocked,
            PushLevel::P0Critical,
            PushTargetScreen::Audit,
            "security-audit:tc-9f4b",
            "session:s-7",
            payload_digest("tc-9f4b", Some("Delete"), None),
        ))
    );
    // 无 tool_call_id 且无 sequence → session 回退（biz_key 同值）
    assert_eq!(
        push_intent(
            &security_audit(SecurityAuditDecision::Blocked, None),
            &ctx_with_run("run-42")
        ),
        Some(expected_intent(
            SceneId::SecurityBlocked,
            PushLevel::P0Critical,
            PushTargetScreen::Audit,
            "security-audit:session:s-7",
            "session:s-7",
            payload_digest("session:s-7", Some("Delete"), None),
        ))
    );
    // 不推子集在 sequence 存在时同样不推
    for decision in [
        SecurityAuditDecision::Approved,
        SecurityAuditDecision::Denied,
        SecurityAuditDecision::Redirected,
        SecurityAuditDecision::Restored,
    ] {
        assert_eq!(
            push_intent(&security_audit(decision, None), &seq_ctx),
            None,
            "{decision:?}"
        );
    }
}

#[test]
fn s12_cache_waste_full_fields() {
    let with_cost = AgentEvent::CacheWasteAlert {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        attribution: MissAttribution::IdleTtlExpired,
        missed_tokens: 24_000,
        idle_ms: 3_600_000,
        model_changed: false,
        missed_cost_usd: Some(0.125),
    };
    assert_eq!(
        push_intent(&with_cost, &ctx_with_run("run-42")),
        Some(expected_intent(
            SceneId::CacheWasteAlert,
            PushLevel::P2Collapsible,
            PushTargetScreen::Session,
            "cache-waste-alert:run-42",
            "session:s-7",
            payload_digest("run-42", Some("24000"), Some(&format!("{:.2}", 0.125_f64))),
        ))
    );
    let no_cost = AgentEvent::CacheWasteAlert {
        session_id: "s-7".to_string(),
        timestamp: "2026-08-13T10:00:00Z".to_string(),
        attribution: MissAttribution::IdleTtlExpired,
        missed_tokens: 5,
        idle_ms: 1,
        model_changed: true,
        missed_cost_usd: None,
    };
    assert_eq!(
        push_intent(&no_cost, &ctx()),
        Some(expected_intent(
            SceneId::CacheWasteAlert,
            PushLevel::P2Collapsible,
            PushTargetScreen::Session,
            "cache-waste-alert:session:s-7",
            "session:s-7",
            payload_digest("", Some("5"), None),
        ))
    );
}
