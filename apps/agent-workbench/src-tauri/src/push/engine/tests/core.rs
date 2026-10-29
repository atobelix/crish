//! push engine 测试 · 核心管线（审批/去重/静默/节流/合并/兜底）。

use super::super::*;
use super::support::*;

use crate::push::PushSeverity;
use conex_types::events::{RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation};
use conex_types::impact::ImpactAssessment;

#[test]
fn approval_delivered_on_batch_close() {
    let mut engine = PushDecisionEngine::default();
    // 审批入桶（累积族）
    assert!(engine.decide(&approval("tc-1"), &ctx(), T0).is_empty());
    assert!(engine
        .decide(&approval("tc-2"), &ctx(), T0 + 100)
        .is_empty());
    // tool-batch-end 关闭信号 → 合并出桶
    let out = engine.decide(&batch_end(), &ctx(), T0 + 200);
    assert_eq!(out.len(), 1);
    let decision = &out[0];
    assert!(decision.deliver);
    assert_eq!(decision.scene, SceneId::ApprovalRequested);
    assert_eq!(decision.level, PushLevel::P0Critical);
    assert_eq!(decision.severity, PushSeverity::Critical);
    assert_eq!(decision.outcome, DecisionOutcome::Coalesced);
    assert!(decision
        .dedupe_key
        .starts_with("merged:approval-requested:s-7:"));
}

#[test]
fn approval_batch_close_without_bucket_noop() {
    let mut engine = PushDecisionEngine::default();
    assert!(engine.decide(&batch_end(), &ctx(), T0).is_empty());
}

#[test]
fn p0_direct_scene_delivers_immediately() {
    let mut engine = PushDecisionEngine::default();
    let out = engine.decide(&task_suspicious("t-1"), &ctx(), T0);
    assert_eq!(out.len(), 1);
    let decision = &out[0];
    assert!(decision.deliver);
    assert_eq!(decision.scene, SceneId::TaskSuspicious);
    assert_eq!(decision.outcome, DecisionOutcome::Delivered);
}

#[test]
fn dedupe_suppresses_replay() {
    let mut engine = PushDecisionEngine::default();
    engine.decide(&task_suspicious("t-1"), &ctx(), T0);
    let replay = engine.decide(&task_suspicious("t-1"), &ctx(), T0 + 1_000);
    assert_eq!(replay.len(), 1);
    assert!(!replay[0].deliver);
    assert_eq!(replay[0].outcome, DecisionOutcome::DedupeSuppressed);
}

#[test]
fn quiet_hours_folds_p1_skips_p2_delivers_p0() {
    // 静默时段：23:00（UTC 分钟 1380，基准 T0 分钟 720 + 11h）
    let quiet_ms = T0 + 11 * 3_600_000;
    let mut engine = PushDecisionEngine::default();

    // P1 run 完成 → 折叠夜间摘要
    let out = engine.decide(
        &run_terminal("run-1", RunTerminalStatus::Completed),
        &ctx(),
        quiet_ms,
    );
    assert_eq!(out[0].outcome, DecisionOutcome::FoldedToNightSummary);
    assert!(!out[0].deliver);

    // P0 审批请求（非合并族）→ 仍发（静默可选静音由移动端决定）
    let p0 = engine.decide(&task_suspicious("t-2"), &ctx(), quiet_ms);
    assert!(p0[0].deliver);
    assert_eq!(p0[0].outcome, DecisionOutcome::Delivered);

    // P2 缓存告警 → 静默不推（先构造事件）
    let cache = AgentEvent::CacheWasteAlert {
        session_id: "s-7".to_string(),
        timestamp: "t".to_string(),
        attribution: conex_types::events::MissAttribution::Cold,
        missed_tokens: 24_000,
        idle_ms: 100,
        model_changed: false,
        missed_cost_usd: Some(0.1),
    };
    let p2 = engine.decide(&cache, &ctx_run("run-9"), quiet_ms);
    assert!(!p2[0].deliver);
    assert_eq!(p2[0].outcome, DecisionOutcome::QuietSkipped);
}

#[test]
fn throttle_folds_third_push_in_minute() {
    let mut engine = PushDecisionEngine::default();
    // 直接单条场景（避开合并族）
    assert!(engine.decide(&task_suspicious("t-1"), &ctx(), T0)[0].deliver);
    assert!(engine.decide(&task_suspicious("t-2"), &ctx(), T0 + 1_000)[0].deliver);
    let third = engine.decide(&task_suspicious("t-3"), &ctx(), T0 + 2_000);
    assert!(!third[0].deliver);
    assert_eq!(third[0].outcome, DecisionOutcome::Throttled);
}

#[test]
fn run_failed_suppresses_runtime_error_30min() {
    let mut engine = PushDecisionEngine::default();
    // run 失败（P0 直发）
    let failed = engine.decide(
        &run_terminal("run-42", RunTerminalStatus::Failed),
        &ctx(),
        T0,
    );
    assert!(failed[0].deliver);
    // 30min 内的 runtime-error → 抑制（避免与 S4 双推）
    let err = engine.decide(&runtime_error(), &ctx_run("run-42"), T0 + 10 * 60_000);
    assert!(!err[0].deliver);
    assert_eq!(err[0].outcome, DecisionOutcome::DedupeSuppressed);
    // 超过 30min → 恢复推送
    let late = engine.decide(&runtime_error(), &ctx_run("run-42"), T0 + 31 * 60_000);
    assert!(late[0].deliver);
}

#[test]
fn run_completed_merges_subagents() {
    let mut engine = PushDecisionEngine::default();
    engine.decide(&subagent_completed("sa-1"), &ctx_run("run-42"), T0);
    engine.decide(&subagent_completed("sa-2"), &ctx_run("run-42"), T0 + 100);
    let out = engine.decide(
        &run_terminal("run-42", RunTerminalStatus::Completed),
        &ctx(),
        T0 + 30_000,
    );
    assert_eq!(out.len(), 1);
    let decision = &out[0];
    assert!(decision.deliver);
    assert_eq!(decision.scene, SceneId::RunCompleted);
    assert_eq!(decision.outcome, DecisionOutcome::Coalesced);
    assert!(decision
        .dedupe_key
        .starts_with("merged:run-completed:run-42:"));
}

#[test]
fn run_completed_replay_suppressed() {
    let mut engine = PushDecisionEngine::default();
    engine.decide(
        &run_terminal("run-1", RunTerminalStatus::Completed),
        &ctx(),
        T0,
    );
    // 重放同一事件 → 去重抑制（单条形态键 = 原事件键）
    let replay = engine.decide(
        &run_terminal("run-1", RunTerminalStatus::Completed),
        &ctx(),
        T0 + 1_000,
    );
    assert_eq!(replay[0].outcome, DecisionOutcome::DedupeSuppressed);
}

#[test]
fn suspicious_then_failed_merges() {
    let mut engine = PushDecisionEngine::default();
    engine.decide(&task_suspicious("t-12"), &ctx(), T0);
    // 5min 后 task-failed → 合并产出「卡死已失败」
    let out = engine.decide(&task_failed("t-12"), &ctx(), T0 + 300_000);
    assert_eq!(out.len(), 1);
    assert!(out[0].deliver);
    assert_eq!(out[0].scene, SceneId::TaskFailed);
    assert_eq!(out[0].outcome, DecisionOutcome::Coalesced);
}

#[test]
fn cron_accumulates_then_flush() {
    let mut engine = PushDecisionEngine::default();
    let cron = |iteration: u64| AgentEvent::CronFired {
        session_id: "s-7".to_string(),
        cron_id: "cron-2".to_string(),
        prompt: "日报".to_string(),
        expression: "0 9 * * *".to_string(),
        iteration,
        fired_at_ms: T0,
    };
    assert!(engine.decide(&cron(1), &ctx(), T0).is_empty());
    assert!(engine.decide(&cron(2), &ctx(), T0 + 5 * 60_000).is_empty());
    // 10min 窗口到期 → flush 产出合并
    let out = engine.flush(T0 + 601_000);
    assert_eq!(out.len(), 1);
    assert!(out[0].deliver);
    assert_eq!(out[0].outcome, DecisionOutcome::Coalesced);
    assert!(out[0].dedupe_key.starts_with("merged:cron-fired:cron-2:"));
}

#[test]
fn security_blocked_delivers() {
    let mut engine = PushDecisionEngine::default();
    let audit = AgentEvent::SecurityAudit {
        session_id: "s-7".to_string(),
        timestamp: "t".to_string(),
        operation: SecurityAuditOperation::Delete,
        targets: vec!["C:\\a".to_string()],
        impact: ImpactAssessment::default(),
        decision: SecurityAuditDecision::Blocked,
        permission_mode: None,
        tool_call_id: Some("tc-9".to_string()),
    };
    let out = engine.decide(&audit, &ctx(), T0);
    assert!(out[0].deliver);
    assert_eq!(out[0].scene, SceneId::SecurityBlocked);
}

#[test]
fn p3_events_produce_no_decisions() {
    let mut engine = PushDecisionEngine::default();
    let noise = AgentEvent::TaskOutput {
        session_id: "s-7".to_string(),
        task_id: "t-1".to_string(),
        line: Some("x".to_string()),
        chunk: None,
        line_count: Some(1),
    };
    assert!(engine.decide(&noise, &ctx(), T0).is_empty());
}

#[test]
fn flush_all_drains_pending_buckets() {
    let mut engine = PushDecisionEngine::default();
    engine.decide(&subagent_completed("sa-1"), &ctx_run("run-7"), T0);
    let out = engine.flush_all(T0 + 1_000);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].scene, SceneId::SubagentCompleted);
    assert!(out[0].deliver);
}
