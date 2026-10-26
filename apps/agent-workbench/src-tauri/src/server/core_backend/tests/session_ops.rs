use std::sync::Arc;

use conex_types::device::{
    DeviceErrorCode, PermissionMode, RunControlLevel, RunControlParams, RunTaskParams,
};
use conex_types::events::{AgentEvent, SecurityAuditDecision, SecurityAuditOperation};

use crate::core_backend::{
    apply_remote_mode, combine_dual_decisions, emit_remote_mode_downgrade_audit,
    emit_remote_only_audit, route_remote_approval, CoreStateBackend, RemoteApprovalRoute,
    REMOTE_MODE_DOWNGRADE_AUDIT_MARKER, REMOTE_ONLY_AUDIT_MARKER,
};
use crate::server::backend::ApiBackend;
use crate::server::remote_whitelist::{
    emit_remote_source_attempt_audit, remote_source_attempt_marker,
};

use super::{
    g5_test_session_entry, g5_wait_audit_operation, r2_test_core_state, recorded_security_audit,
    recording_bridge,
};

#[tokio::test]
async fn remote_run_control_missing_run_returns_not_found() {
    let backend = CoreStateBackend::new(r2_test_core_state());
    let error = backend
        .run_control(RunControlParams {
            level: RunControlLevel::Continue,
            run_id: "r-missing".to_string(),
            session_id: "s-mobile".to_string(),
            reason: None,
            payload: None,
        })
        .await
        .expect_err("缺失 run 必须拒绝控制");

    assert_eq!(error.device_code(), DeviceErrorCode::CmdNotFound);
    assert!(error.to_string().contains("run 不存在或已终态"));
}

#[tokio::test]
async fn remote_run_control_completed_run_returns_not_found() {
    use agent_provider::config::Endpoint;
    use session_loop::provider::ProviderCall;
    use session_loop::stream::{ProviderStreamEvent, StopReason};
    use session_loop::testing::TestProvider;

    let (bridge, _emitter) = recording_bridge();
    let db = conex_db::LocalDb::open_in_memory().expect("in-memory database");
    db.upsert_session_entry(&g5_test_session_entry("s-terminal"))
        .expect("insert session");
    static TERMINAL_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = TERMINAL_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_remote_terminal_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(crate::core_run_commands::CoreRunState::new(
        Arc::new(orchestrator::persist::LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(crate::status_diagnostics::StatusDiagnostics::new()),
        None,
    ));
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("terminal run completes"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let routed: Arc<dyn ProviderCall> = provider;
    let config = crate::engine::EngineProviderConfig {
        base_url: "http://test.local/v1".to_string(),
        api_key: "test-key".to_string(),
        model: "test-model".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: std::collections::BTreeMap::new(),
        ..Default::default()
    };
    state.engine().inject_provider_for_test(routed, config);
    state.run_restore().await;

    let backend = CoreStateBackend::new(Arc::clone(&state));
    let started = backend
        .run_task(RunTaskParams {
            session_id: Some("s-terminal".to_string()),
            prompt: "complete this run".to_string(),
            prompt_ref: None,
            mode: None,
            cwd: None,
            permission_mode: Some(PermissionMode::Ask),
            history: None,
            client_message_id: None,
        })
        .await
        .expect("test run should start");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let events = match db.query_events("s-terminal", 0, Some(500)) {
            Ok(events) => events,
            Err(_) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "test run did not reach a completed terminal state"
                );
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                continue;
            }
        };
        let completed = events.iter().any(|event| {
            if event.event_type != "run-terminal" {
                return false;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
                return false;
            };
            payload["terminal"] == "completed"
        });
        let active = backend.get_status().await.expect("read backend status")["activeRuns"]
            .as_array()
            .expect("activeRuns should be an array")
            .iter()
            .any(|run| run["runId"] == started.run_id);
        if completed && !active {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "test run did not reach a completed terminal state"
        );
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }

    let error = backend
        .run_control(RunControlParams {
            level: RunControlLevel::Continue,
            run_id: started.run_id,
            session_id: "s-terminal".to_string(),
            reason: None,
            payload: None,
        })
        .await
        .expect_err("completed run must reject further controls");

    assert_eq!(error.device_code(), DeviceErrorCode::CmdNotFound);
    assert!(error.to_string().contains("run 不存在或已终态"));
}

// ── R1-10 T-08：远程权限模式上限（D5 §4.6.1 / §9.2 矩阵）──

/// full-access 申报 → 恒降级 ask（min(requested, Ask) 截断）并返回
/// 降级标记（驱动 remote-mode-downgrade 审计）；ask / plan / None 原样
#[test]
fn t08_apply_remote_mode_clamps_full_access_to_ask() {
    assert_eq!(
        apply_remote_mode(Some(PermissionMode::FullAccess)),
        (Some(PermissionMode::Ask), true),
        "full-access 必须降级 ask + 降级标记"
    );
    assert_eq!(
        apply_remote_mode(Some(PermissionMode::Ask)),
        (Some(PermissionMode::Ask), false)
    );
    assert_eq!(
        apply_remote_mode(Some(PermissionMode::Plan)),
        (Some(PermissionMode::Plan), false),
        "plan 不降级（D5 §4.6.1：Plan 不变）"
    );
    assert_eq!(apply_remote_mode(None), (None, false));
}

/// 降级审计标记常量形状（remote-mode-downgrade；§8.2 命名冻结）
#[test]
fn t08_remote_mode_downgrade_audit_marker_shape() {
    assert_eq!(REMOTE_MODE_DOWNGRADE_AUDIT_MARKER, "remote-mode-downgrade");
}

// ── R1-10 T-14：双轨确认路由纯函数（D5 §4.4）──

/// 桌面在线 → 双轨（移动端 + 桌面端弹窗）
#[test]
fn t14_dual_track_route_when_desktop_present() {
    assert_eq!(route_remote_approval(true), RemoteApprovalRoute::Dual);
}

/// 无人值守（缺省 false = 保守模式）→ RemoteOnly + remote-only 审计标记
#[test]
fn t14_unattended_routes_to_remote_only_marker() {
    assert_eq!(
        route_remote_approval(false),
        RemoteApprovalRoute::RemoteOnly
    );
    assert_eq!(REMOTE_ONLY_AUDIT_MARKER, "remote-only");
}

/// 双轨裁决合成：任一方拒绝即拒绝——仅双方均批准才放行
#[test]
fn t14_dual_decision_either_party_denies_rejects() {
    assert!(
        combine_dual_decisions(true, true),
        "移动端 + 桌面端均批准 → 放行"
    );
    assert!(
        !combine_dual_decisions(true, false),
        "桌面端拒绝 → 双轨拒绝"
    );
    assert!(
        !combine_dual_decisions(false, true),
        "移动端拒绝 → 双轨拒绝"
    );
    assert!(!combine_dual_decisions(false, false));
}

// ── R1-10 T-07：remote-source-attempt 审计标记（D5 §4.5 第三层）──

/// 标记载荷形状：operation=remote-source-attempt + 命令名 + blocked 决策
/// （发射侧结构化审计日志携带同一内容——审计断言锚）
#[test]
fn t07_remote_source_attempt_marker_shape() {
    let marker = remote_source_attempt_marker("config_secret_reveal");
    assert!(marker.contains("operation=remote-source-attempt"));
    assert!(marker.contains("command=config_secret_reveal"));
    assert!(marker.contains("decision=blocked"));
}

// ── R1-11 D-5 收口：remote-* 事件级审计发射（红线 7 端到端可验）──

/// remote-mode-downgrade 事件载荷（D5 §6.2：operation +
/// blocked 决策 + 降级前模式 + targets 承载 runId）
#[test]
fn t08_remote_mode_downgrade_emits_security_audit_event() {
    let (bridge, emitter) = recording_bridge();
    emit_remote_mode_downgrade_audit(Some(&bridge), "run-42", "s1");
    let AgentEvent::SecurityAudit {
        operation,
        targets,
        decision,
        permission_mode,
        session_id,
        ..
    } = recorded_security_audit(&emitter)
    else {
        panic!("应为 SecurityAudit 事件");
    };
    assert_eq!(operation, SecurityAuditOperation::RemoteModeDowngrade);
    assert_eq!(
        decision,
        SecurityAuditDecision::Blocked,
        "降级动作决策 = blocked（记录降级）"
    );
    assert_eq!(
        permission_mode.as_deref(),
        Some("full-access"),
        "permission_mode 记录降级前申请值"
    );
    assert_eq!(targets, vec!["run-42".to_string()], "targets 承载 runId");
    assert_eq!(session_id, "s1");
}

/// remote-mode-downgrade 事件 wire 形状（kebab-case operation 序列化）
#[test]
fn t08_remote_mode_downgrade_event_wire_shape() {
    let (bridge, emitter) = recording_bridge();
    emit_remote_mode_downgrade_audit(Some(&bridge), "", "s1");
    let recorded = emitter.0.lock().unwrap();
    let json: serde_json::Value = serde_json::from_str(&recorded[0]).expect("信封 JSON 可解析");
    // 信封 flatten 序列化：type/事件体字段在顶层（AgentEventEnvelope
    // serialize 把事件体字段并入顶层 map——对齐既有信封契约）
    assert_eq!(json["type"], "security-audit");
    assert_eq!(json["operation"], "remote-mode-downgrade");
    assert_eq!(json["decision"], "blocked");
    assert_eq!(json["permissionMode"], "full-access");
}

/// remote-source-attempt 事件载荷（D5 §6.2：operation + 命令名 +
/// blocked 决策；命令含令牌形态时事件载荷打码——红线 7 断言锚）
#[test]
fn t07_remote_source_attempt_emits_redacted_audit_event() {
    let (bridge, emitter) = recording_bridge();
    emit_remote_source_attempt_audit(Some(&bridge), "config_secret_reveal");
    let AgentEvent::SecurityAudit {
        operation,
        targets,
        decision,
        ..
    } = recorded_security_audit(&emitter)
    else {
        panic!("应为 SecurityAudit 事件");
    };
    assert_eq!(operation, SecurityAuditOperation::RemoteSourceAttempt);
    assert_eq!(decision, SecurityAuditDecision::Blocked);
    assert_eq!(targets, vec!["config_secret_reveal".to_string()]);
}

/// 打码断言：命令串携带 43 字符 base64url 令牌形态时，事件载荷与
/// 标记载荷均无明文形态（redact_text 打码——红线 7 / T-06 零明文
/// 口径同源；scan_sensitive 扫描事件载荷零命中）
#[test]
fn t07_remote_source_attempt_redacts_token_in_payload() {
    let token = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
    assert_eq!(
        token.chars().count(),
        43,
        "测试令牌须为 43 字符 base64url 形态"
    );
    let command = format!("config_secret_get token={token}");
    let (bridge, emitter) = recording_bridge();
    emit_remote_source_attempt_audit(Some(&bridge), &command);
    // 事件载荷（信封 + 事件体全量文本）零敏感形态
    let recorded = emitter.0.lock().unwrap();
    assert!(
        conex_telemetry::redact::scan_sensitive(&recorded[0]).is_empty(),
        "事件载荷不得含令牌/配对码明文形态：{}",
        recorded[0]
    );
    assert!(!recorded[0].contains(token), "事件载荷不得含令牌原文");
    // 标记载荷同源打码（发射侧与标记共用同一 redact 输入）
    let marker = remote_source_attempt_marker(&conex_telemetry::redact::redact_text(&command));
    assert!(!marker.contains(token), "标记载荷不得含令牌原文");
}

/// remote-only 事件载荷（D5 §4.4：无人值守移动端单方批准标记）
#[test]
fn t14_remote_only_emits_security_audit_event() {
    let (bridge, emitter) = recording_bridge();
    emit_remote_only_audit(Some(&bridge), "s1");
    let AgentEvent::SecurityAudit {
        operation,
        decision,
        session_id,
        ..
    } = recorded_security_audit(&emitter)
    else {
        panic!("应为 SecurityAudit 事件");
    };
    assert_eq!(operation, SecurityAuditOperation::RemoteOnly);
    assert_eq!(
        decision,
        SecurityAuditDecision::Approved,
        "单方批准已放行 → approved"
    );
    assert_eq!(session_id, "s1");
}

/// 事件总线未接线（None）时降级纯结构化日志：不发事件不 panic
/// （与 R1-10 行为一致，router 未装配桥的场景）
#[test]
fn t07_remote_audit_none_bridge_degrades_to_log_only() {
    emit_remote_source_attempt_audit(None, "config_secret_reveal");
    emit_remote_mode_downgrade_audit(None, "", "s1");
    emit_remote_only_audit(None, "s1");
}

// ── R1-11 G-5 红线 2 装配断言：远程 run 申报 full-access（真实装配链）──

/// 红线 2 装配断言（R1-11 §3 / D5 §10.3-2 / T-08 端到端）：远程 run
/// 申报 full-access → 经真实装配链（CoreStateBackend::run_task →
/// run_task_impl 完整 run loop，TestProvider 引擎注入）降级 ask +
/// RemoteModeDowngrade 审计事件发射。审计断言 = SecurityAudit
/// (remote-mode-downgrade) 事件载荷（blocked + permission_mode 记录
/// 降级前申请值 full-access）；装配断言 = 降级后的 run 正常发起并
/// 收口（agent-end 落库——生效 ask 进入 run 装配，D5 §4.6.1
/// min(requested, Ask) 截断不破坏 run 执行链）
#[tokio::test]
async fn t08_redline2_full_access_run_emits_downgrade_audit_end_to_end() {
    use agent_provider::config::Endpoint;
    use session_loop::provider::ProviderCall;
    use session_loop::stream::{ProviderStreamEvent, StopReason};
    use session_loop::testing::TestProvider;

    let (bridge, emitter) = recording_bridge();
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&g5_test_session_entry("s1"))
        .expect("会话条目");
    static G5_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = G5_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_redline2_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(crate::core_run_commands::CoreRunState::new(
        Arc::new(orchestrator::persist::LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(crate::status_diagnostics::StatusDiagnostics::new()),
        None,
    ));
    // TestProvider 引擎注入（完整 run loop 装配；脚本 = 单轮文本收口）
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("远程 run 收口。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let routed: Arc<dyn ProviderCall> = provider;
    let config = crate::engine::EngineProviderConfig {
        base_url: "http://test.local/v1".to_string(),
        api_key: "test-key".to_string(),
        model: "deepseek-v4-flash".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: std::collections::BTreeMap::new(),
        ..Default::default()
    };
    state.engine().inject_provider_for_test(routed, config);
    state.run_restore().await;

    // 远程 run 申报 full-access → 经装配面（REST 直调同构）
    let backend = CoreStateBackend::new(Arc::clone(&state));
    let result = backend
        .run_task(RunTaskParams {
            session_id: Some("s1".to_string()),
            prompt: "远程 run（full-access 申报）".to_string(),
            prompt_ref: None,
            mode: None,
            cwd: None,
            permission_mode: Some(PermissionMode::FullAccess),
            history: None,
            client_message_id: None,
        })
        .await;
    assert!(result.is_ok(), "降级后的 run 必须正常发起：{result:?}");

    // 审计断言：RemoteModeDowngrade 事件发射（blocked + 降级前值）
    g5_wait_audit_operation(
        &emitter,
        "remote-mode-downgrade",
        std::time::Duration::from_secs(5),
    )
    .await;
    let payloads = emitter.0.lock().unwrap().clone();
    let downgrades = payloads
        .iter()
        .filter(|p| p.contains("remote-mode-downgrade"))
        .collect::<Vec<_>>();
    assert_eq!(downgrades.len(), 1, "降级审计必须恰发射一次");
    let envelope: conex_types::events::AgentEventEnvelope =
        serde_json::from_str(downgrades[0]).expect("信封 JSON 可解析");
    let conex_types::events::AgentEvent::SecurityAudit {
        operation,
        decision,
        permission_mode,
        ..
    } = envelope.event
    else {
        panic!("应为 SecurityAudit 事件");
    };
    assert_eq!(
        operation,
        conex_types::events::SecurityAuditOperation::RemoteModeDowngrade
    );
    assert_eq!(
        decision,
        conex_types::events::SecurityAuditDecision::Blocked
    );
    assert_eq!(
        permission_mode.as_deref(),
        Some("full-access"),
        "permission_mode 记录降级前申请值"
    );

    // 装配断言：生效 ask 下 run 正常收口（agent-end 事件落库——降级
    // 不破坏 run 执行链，D5 §4.6.1）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        if events.iter().any(|event| event.event_type == "agent-end") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "agent-end 未在窗口内落库——run 未正常收口"
        );
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
}

#[tokio::test]
async fn p7_status_empty_state_includes_active_runs_and_pending_approvals() {
    let backend = CoreStateBackend::new(r2_test_core_state());
    let status = backend.get_status().await.expect("get_status");
    assert_eq!(
        status["activeRuns"],
        serde_json::json!([]),
        "空态 activeRuns = 空数组"
    );
    assert_eq!(
        status["pendingApprovals"],
        serde_json::json!([]),
        "空态 pendingApprovals = 空数组"
    );
}

#[test]
fn remote_approval_helpers_and_bridge_smoke() {
    let (bridge, _emitter) = recording_bridge();
    assert_eq!(route_remote_approval(true), RemoteApprovalRoute::Dual);
    assert_eq!(
        route_remote_approval(false),
        RemoteApprovalRoute::RemoteOnly
    );
    assert!(combine_dual_decisions(true, true));
    assert!(!combine_dual_decisions(true, false));
    assert!(!combine_dual_decisions(false, true));
    assert_eq!(REMOTE_MODE_DOWNGRADE_AUDIT_MARKER, "remote-mode-downgrade");
    assert_eq!(REMOTE_ONLY_AUDIT_MARKER, "remote-only");
    emit_remote_only_audit(Some(&bridge), "sess-test");

    let backend = CoreStateBackend::new(r2_test_core_state());
    let _eb = backend.event_bridge();
}
