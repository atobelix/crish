//! push engine 测试 · S8e 事件流 / 夜间摘要 / 去重后端 / 防洪背压 / 有界淘汰。

use super::super::*;
use super::support::*;

use crate::push::throttle::ThrottleLimits;
use conex_types::events::{
    ApprovalDecision, RunTerminalStatus, SecurityAuditDecision, SecurityAuditOperation,
    SubagentEndStatus,
};
use conex_types::impact::ImpactAssessment;

// ── R3-01a 补强：S8e 事件流观察（task-started / run-terminal 联动）──

/// S8e 联动矩阵：run 终止来源经事件流观察注入 task-killed 判定
/// （各用例独立引擎，避免节流护栏（每分钟 ≤2）干扰矩阵断言）
#[test]
fn s8e_task_killed_uses_run_terminal_source() {
    // 用户取消 run（Cancelled → UserKilled）：连坐任务 kill 不推
    // （即使 Windows 两阶段升级 via_force=true——精确来源覆盖近似）
    let mut engine = PushDecisionEngine::default();
    engine.decide(&task_started("t-3", "run-42"), &ctx(), T0);
    engine.decide(
        &run_terminal("run-42", RunTerminalStatus::Cancelled),
        &ctx(),
        T0 + 1_000,
    );
    assert!(
        engine
            .decide(&task_killed("t-3", true), &ctx(), T0 + 2_000)
            .is_empty(),
        "用户取消 run 后的任务 kill 不推（来源精确判定覆盖 via_force）"
    );

    // 引擎终止（Failed → EngineTerminated）：watchdog 语义 → 推
    // （即使优雅形态 via_force=false——来源判定优先）
    let mut engine = PushDecisionEngine::default();
    engine.decide(&task_started("t-4", "run-43"), &ctx(), T0);
    engine.decide(
        &run_terminal("run-43", RunTerminalStatus::Failed),
        &ctx(),
        T0 + 1_000,
    );
    let out = engine.decide(&task_killed("t-4", false), &ctx(), T0 + 2_000);
    assert_eq!(out.len(), 1);
    assert!(out[0].deliver);
    assert_eq!(out[0].scene, SceneId::TaskKilled);
    assert_eq!(out[0].outcome, DecisionOutcome::Delivered);

    // 无 run-terminal 记录（来源未知）→ 回退 via_force 近似
    let mut fallback = PushDecisionEngine::default();
    fallback.decide(&task_started("t-5", "run-44"), &ctx(), T0);
    assert!(
        fallback
            .decide(&task_killed("t-5", false), &ctx(), T0 + 2_000)
            .is_empty(),
        "来源未知 + 优雅 → 不推（回退近似）"
    );
    let forced = fallback.decide(&task_killed("t-5", true), &ctx(), T0 + 3_000);
    assert!(forced[0].deliver, "来源未知 + 强制 → 推（回退近似）");
}

/// run 完成（EngineTerminated）→ 任务连坐 kill 推
#[test]
fn s8e_run_completed_then_task_killed_pushes() {
    let mut engine = PushDecisionEngine::default();
    engine.decide(&task_started("t-6", "run-50"), &ctx(), T0);
    engine.decide(
        &run_terminal("run-50", RunTerminalStatus::Completed),
        &ctx(),
        T0 + 1_000,
    );
    let out = engine.decide(&task_killed("t-6", true), &ctx(), T0 + 2_000);
    assert_eq!(out.len(), 1);
    assert!(out[0].deliver);
    assert_eq!(out[0].dedupe_key, "task-killed:t-6");
}

// ── R3-01a 补强：夜间摘要折叠与合成 ──

/// 静默时段 P1 折叠 → 静默结束出桶合成（跨午夜同夜归一）
#[test]
fn night_summary_folds_p1_and_composes_at_quiet_end() {
    let mut engine = PushDecisionEngine::default();
    let evening = T0 + 11 * 3_600_000 + 59 * 60_000; // 08-09 23:59（静默内）
    let midnight = T0 + 12 * 3_600_000 + 30 * 60_000; // 08-10 00:30（跨午夜静默内）

    // P1 run 完成 ×2（一个跨午夜）→ 折叠
    let out1 = engine.decide(
        &run_terminal("run-1", RunTerminalStatus::Completed),
        &ctx(),
        evening,
    );
    assert_eq!(out1[0].outcome, DecisionOutcome::FoldedToNightSummary);
    let out2 = engine.decide(
        &run_terminal("run-2", RunTerminalStatus::Completed),
        &ctx(),
        midnight,
    );
    assert_eq!(out2[0].outcome, DecisionOutcome::FoldedToNightSummary);
    assert_eq!(engine.folded_len(), 2);

    // 07:30 静默结束出桶：跨午夜两条目同属一夜（窗口起始日键）
    let take_at = T0 + 19 * 3_600_000 + 30 * 60_000; // 08-10 07:30
    let summary = engine
        .take_night_summary(take_at)
        .expect("有折叠条目应合成");
    assert_eq!(summary.date, "2026-08-09");
    assert_eq!(summary.total, 2);
    assert_eq!(summary.body, "夜间完成 2 项：任务完成 ×2");
    assert_eq!(engine.folded_len(), 0);

    // 同日重复取 → 无折叠条目 → None（每夜一条幂等）
    assert!(engine.take_night_summary(take_at + 60_000).is_none());
}

/// 静默时段 P0 仍发（不折叠）；P2 跳过（不折叠）
#[test]
fn night_summary_only_folds_p1() {
    let mut engine = PushDecisionEngine::default();
    let quiet_ms = T0 + 11 * 3_600_000; // 23:00（静默内）

    // P0 任务卡死 → 仍发，不进折叠桶
    let p0 = engine.decide(&task_suspicious("t-1"), &ctx(), quiet_ms);
    assert!(p0[0].deliver);
    assert_eq!(engine.folded_len(), 0);

    // P1 run 完成 → 折叠
    engine.decide(
        &run_terminal("run-1", RunTerminalStatus::Completed),
        &ctx(),
        quiet_ms,
    );
    assert_eq!(engine.folded_len(), 1);

    // P2 缓存告警 → 静默跳过，不进折叠桶
    let cache = AgentEvent::CacheWasteAlert {
        session_id: "s-7".to_string(),
        timestamp: "t".to_string(),
        attribution: conex_types::events::MissAttribution::Cold,
        missed_tokens: 24_000,
        idle_ms: 100,
        model_changed: false,
        missed_cost_usd: Some(0.1),
    };
    engine.decide(&cache, &ctx_run("run-9"), quiet_ms);
    assert_eq!(engine.folded_len(), 1, "仅 P1 折叠");

    let summary = engine
        .take_night_summary(T0 + 19 * 3_600_000 + 30 * 60_000)
        .expect("有折叠条目");
    assert_eq!(summary.total, 1);
    assert_eq!(summary.body, "夜间完成 1 项：任务 run-1 已完成");
}

/// 静默内折叠 + 次夜新折叠：按窗口起始日分桶出桶
#[test]
fn night_summary_buckets_by_window_start_day() {
    let mut engine = PushDecisionEngine::default();
    // 第一夜 23:00（08-09）
    engine.decide(
        &run_terminal("run-1", RunTerminalStatus::Completed),
        &ctx(),
        T0 + 11 * 3_600_000,
    );
    let first = engine
        .take_night_summary(T0 + 19 * 3_600_000 + 30 * 60_000)
        .expect("第一夜摘要");
    assert_eq!(first.date, "2026-08-09");
    assert_eq!(first.total, 1);

    // 第二夜 23:00（08-10）
    let next_evening = T0 + 35 * 3_600_000; // 08-10 23:00
    engine.decide(
        &run_terminal("run-2", RunTerminalStatus::Completed),
        &ctx(),
        next_evening,
    );
    let second = engine
        .take_night_summary(next_evening + 8 * 3_600_000 + 30 * 60_000)
        .expect("第二夜摘要");
    assert_eq!(second.date, "2026-08-10");
    assert_eq!(second.total, 1);
    assert_eq!(second.body, "夜间完成 1 项：任务 run-2 已完成");
}

/// 空折叠出桶 → None
#[test]
fn night_summary_empty_take_returns_none() {
    let mut engine = PushDecisionEngine::default();
    assert!(engine
        .take_night_summary(T0 + 19 * 3_600_000 + 30 * 60_000)
        .is_none());
    assert_eq!(engine.folded_len(), 0);
}

// ── R3-01a 补强：去重后端注入（SQLite 与内存同 trait 等价）──

#[test]
fn engine_with_sqlite_dedupe_backend() {
    let backend =
        crate::push::dedupe::SqliteDedupeBackend::open_in_memory(24 * 3_600_000).expect("内存库");
    let mut engine =
        PushDecisionEngine::with_dedupe_backend(EngineConfig::default(), Box::new(backend));
    let out = engine.decide(&task_suspicious("t-1"), &ctx(), T0);
    assert!(out[0].deliver);
    let replay = engine.decide(&task_suspicious("t-1"), &ctx(), T0 + 1_000);
    assert_eq!(replay[0].outcome, DecisionOutcome::DedupeSuppressed);
    assert!(!replay[0].deliver);
}

/// 防洪背压基线：普通（非 P0）意图洪峰超水位降级、窗口过后恢复
/// （P1 直发场景 timer-fired 作填充素材；P0 旁路行为见
/// [flood_backpressure_bypasses_p0_intents]）
#[test]
fn flood_backpressure_throttles_burst_and_recovers_after_window() {
    let cfg = EngineConfig {
        limits: ThrottleLimits {
            per_device_per_minute: 1000,
            per_session_per_10min: 1000,
            per_device_per_day: 1000,
        },
        ..Default::default()
    };
    let mut engine = PushDecisionEngine::new(cfg);

    for i in 0..FLOOD_MAX_INTENTS_PER_WINDOW {
        let out = engine.decide(&timer_fired(&format!("timer-{i}")), &ctx(), T0 + i as u64);
        assert_eq!(out[0].outcome, DecisionOutcome::Delivered);
        assert!(out[0].deliver);
    }

    // 第 65 条（同 1s 窗口内）触发防洪背压降级
    let overflow = engine.decide(&timer_fired("timer-overflow"), &ctx(), T0 + 500);
    assert!(!overflow[0].deliver);
    assert_eq!(overflow[0].outcome, DecisionOutcome::Throttled);
    // 可观测性：低优丢弃计数 +1（tracing warn 同步输出）
    assert_eq!(engine.flood_drop_total(), 1);

    // 1s 滑动窗口过后自动恢复放行
    let recovered = engine.decide(
        &timer_fired("timer-recovered"),
        &ctx(),
        T0 + FLOOD_WINDOW_MS + 100,
    );
    assert!(recovered[0].deliver);
    assert_eq!(recovered[0].outcome, DecisionOutcome::Delivered);
}

/// P0 关键意图旁路防洪（推送丢失不可接受裁决）：1s 洪峰超过水位后，
/// 普通意图照常背压降级，而全部 9 个 P0 场景（审批请求/审批过期/run 失败/
/// 子代理失败/任务卡死/任务失败/运行异常/需介入/安全拦截）永不因防洪被丢弃——
/// 直发族当场送达；审批/任务失败合并族照常入桶（批次关闭 / flush 兜底出桶，
/// 绝不延迟到夜间摘要）。
#[test]
fn flood_backpressure_bypasses_p0_intents() {
    let cfg = EngineConfig {
        limits: ThrottleLimits {
            per_device_per_minute: 1000,
            per_session_per_10min: 1000,
            per_device_per_day: 1000,
        },
        ..Default::default()
    };
    let mut engine = PushDecisionEngine::new(cfg);

    // P1 直发场景（timer-fired）灌满 1s 防洪水位
    for i in 0..FLOOD_MAX_INTENTS_PER_WINDOW {
        engine.decide(&timer_fired(&format!("timer-{i}")), &ctx(), T0 + i as u64);
    }
    // 第 65 条普通意图（同 1s 窗口）→ 防洪背压降级
    let overflow = engine.decide(&timer_fired("timer-overflow"), &ctx(), T0 + 500);
    assert!(!overflow[0].deliver);
    assert_eq!(overflow[0].outcome, DecisionOutcome::Throttled);

    // ── 同一洪峰窗口内，P0 意图逐一旁路防洪 ──

    // S4 run 失败（P0 直发）
    let failed = engine.decide(
        &run_terminal("run-77", RunTerminalStatus::Failed),
        &ctx(),
        T0 + 510,
    );
    assert!(failed[0].deliver, "run-failed 永不因防洪丢弃");
    assert_eq!(failed[0].outcome, DecisionOutcome::Delivered);

    // S8c 任务卡死（P0 直发）
    let suspicious = engine.decide(&task_suspicious("t-p0-1"), &ctx(), T0 + 520);
    assert!(suspicious[0].deliver, "task-suspicious 永不因防洪丢弃");
    assert_eq!(suspicious[0].outcome, DecisionOutcome::Delivered);

    // S10a 运行异常（P0 直发；独立 runId 防与 run-77 的 S10a 双推抑制互相干扰）
    let err = engine.decide(&runtime_error(), &ctx_run("run-88"), T0 + 530);
    assert!(err[0].deliver, "runtime-error 永不因防洪丢弃");
    assert_eq!(err[0].outcome, DecisionOutcome::Delivered);

    // S10b 需人工介入（P0 直发）
    let intervene = engine.decide(
        &AgentEvent::RuntimeInterventionRequired {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            reason: "缺少 API 密钥".to_string(),
            choices: vec![],
            message: "请选择".to_string(),
        },
        &ctx_run("run-89"),
        T0 + 540,
    );
    assert!(intervene[0].deliver, "intervention-required 永不因防洪丢弃");
    assert_eq!(intervene[0].outcome, DecisionOutcome::Delivered);

    // S11 安全拦截（P0 直发）
    let audit = engine.decide(
        &AgentEvent::SecurityAudit {
            session_id: "s-7".to_string(),
            timestamp: "t".to_string(),
            operation: SecurityAuditOperation::Delete,
            targets: vec!["C:\\a".to_string()],
            impact: ImpactAssessment::default(),
            decision: SecurityAuditDecision::Blocked,
            permission_mode: None,
            tool_call_id: Some("tc-p0".to_string()),
        },
        &ctx(),
        T0 + 550,
    );
    assert!(audit[0].deliver, "security-blocked 永不因防洪丢弃");
    assert_eq!(audit[0].outcome, DecisionOutcome::Delivered);

    // S2 审批过期（P0 直发）
    let expired = engine.decide(
        &AgentEvent::ApprovalResolved {
            session_id: "s-7".to_string(),
            tool_call_id: "tc-p0-exp".to_string(),
            request_id: None,
            decision: ApprovalDecision::Expired,
            timestamp: "t".to_string(),
        },
        &ctx(),
        T0 + 560,
    );
    assert!(expired[0].deliver, "approval-expired 永不因防洪丢弃");
    assert_eq!(expired[0].outcome, DecisionOutcome::Delivered);

    // S7 子代理失败（P0 直发）
    let sub_failed = engine.decide(
        &AgentEvent::SubagentEnded {
            session_id: "s-7".to_string(),
            subagent_id: "sa-p0".to_string(),
            subagent_run_id: "sa-p0-run".to_string(),
            status: SubagentEndStatus::Failed,
            summary: None,
            ended_at: "t".to_string(),
            subagent_session_id: None,
        },
        &ctx(),
        T0 + 570,
    );
    assert!(sub_failed[0].deliver, "subagent-failed 永不因防洪丢弃");
    assert_eq!(sub_failed[0].outcome, DecisionOutcome::Delivered);

    // S1 审批请求（P0，审批合并族）：不被防洪丢弃 → 入桶，批次关闭即出
    assert!(
        engine
            .decide(&approval("tc-p0-req"), &ctx(), T0 + 580)
            .is_empty(),
        "审批请求不被防洪丢弃（入审批桶等待批次关闭）"
    );
    let closed = engine.decide(&batch_end(), &ctx(), T0 + 590);
    assert_eq!(closed.len(), 1);
    assert!(closed[0].deliver, "审批经批次关闭立即送达（不入夜间摘要）");
    assert_eq!(closed[0].scene, SceneId::ApprovalRequested);
    assert_eq!(closed[0].outcome, DecisionOutcome::Coalesced);

    // S8d 任务失败（P0，合并族）：不被防洪丢弃 → 入桶，flush 兜底出桶
    assert!(
        engine
            .decide(&task_failed("t-p0-2"), &ctx(), T0 + 600)
            .is_empty(),
        "task-failed 不被防洪丢弃（入合并桶）"
    );
    let drained = engine.flush_all(T0 + 601);
    assert!(
        drained
            .iter()
            .any(|d| d.scene == SceneId::TaskFailed && d.deliver),
        "task-failed 经 flush 兜底出桶"
    );
    // 可观测性：全程唯一被防洪丢弃的是第 65 条普通意图；9 个 P0 旁路不计数
    assert_eq!(engine.flood_drop_total(), 1);
}

#[test]
fn task_owner_and_run_source_eviction_remains_strictly_bounded() {
    let mut engine = PushDecisionEngine::default();
    // 先启动并完成 1500 个任务，验证完成态清理不会在 task_owner_order 中残留僵尸键
    for i in 0..1500 {
        let tid = format!("done-{i}");
        engine.decide(&task_started(&tid, "run-0"), &ctx(), T0);
        engine.decide(&task_failed(&tid), &ctx(), T0 + 1);
    }
    assert_eq!(engine.task_owner_run.len(), 0);
    assert_eq!(engine.task_owner_order.len(), 0);

    // 连续启动 1200 个未完成任务，验证严格受限于 MAX_TRACKED_TASK_OWNERS
    for i in 0..1200 {
        engine.decide(
            &task_started(&format!("active-{i}"), &format!("run-{i}")),
            &ctx(),
            T0 + 10,
        );
    }
    assert_eq!(engine.task_owner_run.len(), MAX_TRACKED_TASK_OWNERS);
    assert!(engine.task_owner_order.len() <= MAX_TRACKED_TASK_OWNERS * 2);

    // 连续记录 1200 个 run 终止来源，验证容量上限与 flush 过期淘汰
    for i in 0..1200 {
        engine.record_run_term_source(
            format!("run-term-{i}"),
            RunTerminationSource::EngineTerminated,
            T0 + 20,
        );
    }
    assert_eq!(engine.run_term_source.len(), MAX_TRACKED_RUN_SOURCES);
    engine.flush(T0 + 20 + RUN_TERM_SOURCE_TTL_MS + 1);
    assert_eq!(engine.run_term_source.len(), 0);
    assert_eq!(engine.run_term_order.len(), 0);
}
