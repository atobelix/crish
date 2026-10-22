//! router 测试：密钥命令面 T-07 / 白名单守卫 G-5 / T-08 权限模式透传

use super::*;

/// 白名单拒绝：密钥命令面（config_secret_reveal 等）在 REST 面（=
/// 远程面）无路由 → 403 Forbidden（cmd.denied「命令被安全策略拒绝」）
/// + remote-source-attempt 审计标记发射（handle_not_found 拒绝分支）
#[tokio::test]
async fn t07_secret_command_surface_rejected_forbidden() {
    let app = build_router(test_state());
    for (name, label) in [
        ("config_secret_reveal", "密钥 reveal 命令"),
        ("config_secret_get", "密钥 get 命令"),
        ("config_secret_set", "密钥 set 命令"),
        ("config_secret_clear", "密钥 clear 命令"),
        ("config_secret_has", "密钥 has 命令"),
        ("workbench_run_shell", "shell 执行面"),
        ("workbench_git_run", "git 执行面"),
        ("host_openers", "宿主打开器面"),
    ] {
        let uri = format!("/v1/commands/{name}");
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{label}（{uri}）必须 403 Forbidden"
        );
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.denied", "{label} 错误码应为 cmd.denied");
        assert_eq!(body["retryable"], false);
    }
    // 非密钥未知路径仍 404（白名单拒绝不扩大化——未知普通命令不泄露
    // 被禁面信息）
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/v1/commands/unknown_tool_xyz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

/// 审计标记：secret_command_hit 命中/未命中纯函数 + 发射载荷形状
/// （remote-source-attempt 标记载荷与 core_backend 同源——审计断言锚）
#[test]
fn t07_secret_surface_detection_and_audit_marker() {
    for name in SECRET_COMMAND_SURFACE {
        let uri = format!("/v1/commands/{name}").parse::<Uri>().unwrap();
        assert_eq!(secret_command_hit(&uri), Some(*name), "{name} 必须命中");
    }
    let clean: Uri = "/v1/status".parse().unwrap();
    assert_eq!(secret_command_hit(&clean), None, "非密钥路径不得命中");
    let marker =
        crate::server::remote_whitelist::remote_source_attempt_marker("config_secret_reveal");
    assert!(marker.contains("operation=remote-source-attempt"));
    assert!(marker.contains("command=config_secret_reveal"));
    assert!(marker.contains("decision=blocked"));
}

// ── R1-11 G-5：远程命令白名单接线（D5 §4.5 M-REG 端到端）──

/// 审计事件桥测试替身（G-5：remote-source-attempt 事件发射端到端
/// 断言锚；对齐 core_backend 测试先例）
#[derive(Default)]
struct G5RecordingEmitter(std::sync::Mutex<Vec<String>>);

impl crate::core_event_bridge::Emitter for G5RecordingEmitter {
    fn emit(&self, _channel: &str, payload: &str) {
        self.0.lock().unwrap().push(payload.to_string());
    }
}

fn g5_recording_bridge() -> (
    crate::core_event_bridge::EventBridge,
    Arc<G5RecordingEmitter>,
) {
    let emitter = Arc::new(G5RecordingEmitter::default());
    let bridge = crate::core_event_bridge::EventBridge::new(
        "workbench-run-event",
        Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
    );
    (bridge, emitter)
}

/// 命令执行端点与白名单双源对账（防漂移）：REST 命令执行端点
/// （runTask / runControl / cancelRun）必须登记于远程白名单——未来
/// 移除白名单条目而保留端点即红（白名单是命令执行面唯一真源）
#[test]
fn g5_command_execution_endpoints_registered_in_whitelist() {
    for command in ["runTask", "runControl", "cancelRun"] {
        assert!(
            crate::server::remote_whitelist::is_remote_command_whitelisted(command),
            "命令执行端点 {command} 必须登记于远程白名单"
        );
    }
    // 审批端点不挂执行守卫，但命令面注册表仍完整声明能力位（D5
    // §4.2 审批决策是移动端核心能力）
    for command in ["approve", "deny", "listPendingApprovals", "approvalHistory"] {
        assert!(
            crate::server::remote_whitelist::is_remote_command_whitelisted(command),
            "审批命令 {command} 必须在白名单表内（能力声明）"
        );
    }
}

/// 守卫拒绝路径：非白名单命令名 → Err（403 cmd.denied 语义）+ 审计
/// 事件发射（事件桥注入形态；守卫把白名单拒绝与审计绑成一体——
/// D5 §4.5「命令名 ∉ 白名单 → 403 cmd.denied + RemoteSourceAttempt
/// 审计事件」）
#[test]
fn g5_whitelist_guard_rejects_off_whitelist_command() {
    let (bridge, emitter) = g5_recording_bridge();
    let state = test_state_with(Some(MockBackend::new())).with_audit_bridge(bridge);
    let err = ensure_command_execution_allowed(&state, "config_secret_reveal")
        .expect_err("非白名单命令名必须被守卫拒绝");
    let response = error_response(&err);
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    // 审计事件：remote-source-attempt + blocked + 命令名 targets
    let recorded = emitter.0.lock().unwrap();
    assert_eq!(recorded.len(), 1, "守卫拒绝必须发射一条审计事件");
    let envelope: conex_types::events::AgentEventEnvelope =
        serde_json::from_str(&recorded[0]).expect("信封 JSON 可解析");
    // 显式释放 guard——后续放行路径断言需再次锁同一 Mutex
    // （std Mutex 不可重入，guard 存活期间重入即死锁）
    drop(recorded);
    let conex_types::events::AgentEvent::SecurityAudit {
        operation,
        targets,
        decision,
        ..
    } = envelope.event
    else {
        panic!("守卫拒绝应发射 SecurityAudit 事件");
    };
    assert_eq!(
        operation,
        conex_types::events::SecurityAuditOperation::RemoteSourceAttempt
    );
    assert_eq!(targets, vec!["config_secret_reveal".to_string()]);
    assert_eq!(
        decision,
        conex_types::events::SecurityAuditDecision::Blocked
    );
    // 白名单内命令名放行（无 Err 无审计）
    assert!(ensure_command_execution_allowed(&state, "runTask").is_ok());
    assert_eq!(emitter.0.lock().unwrap().len(), 1, "放行路径不得发射审计");
}

/// 红线 5 / T-07 端到端（R1-11 §3「config_secret_* 远程来源 100%
/// Forbidden」）：REST 面无 config_secret_* 执行端点（白名单天然
/// 拦截）——带令牌请求未知路径 /v1/config_secret_reveal → 403
/// cmd.denied + RemoteSourceAttempt 审计事件（端到端：鉴权面 →
/// fallback 拒绝分支 → 事件桥发射）
#[tokio::test]
async fn t07_config_secret_forbidden_end_to_end_with_audit_event() {
    let (bridge, emitter) = g5_recording_bridge();
    let state = test_state_with(Some(MockBackend::new())).with_audit_bridge(bridge);
    let token = issue_token(&state);
    let app = build_router(state);
    for name in [
        "config_secret_reveal",
        "config_secret_get",
        "config_secret_set",
        "config_secret_clear",
        "config_secret_has",
    ] {
        let uri = format!("/v1/{name}");
        let response = app.clone().oneshot(authed_get(&uri, &token)).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri} 必须 403");
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.denied", "{uri} 错误码应为 cmd.denied");
        assert_eq!(body["retryable"], false);
    }
    // 审计事件：5 条触达 = 5 条 remote-source-attempt（逐条可对账）
    let recorded = emitter.0.lock().unwrap();
    assert_eq!(recorded.len(), 5, "每条被禁命令触达必须发射一条审计");
    for payload in recorded.iter() {
        let envelope: conex_types::events::AgentEventEnvelope =
            serde_json::from_str(payload).expect("信封 JSON 可解析");
        let conex_types::events::AgentEvent::SecurityAudit {
            operation,
            decision,
            ..
        } = envelope.event
        else {
            panic!("应为 SecurityAudit 事件");
        };
        assert_eq!(
            operation,
            conex_types::events::SecurityAuditOperation::RemoteSourceAttempt
        );
        assert_eq!(
            decision,
            conex_types::events::SecurityAuditDecision::Blocked
        );
    }
}

/// REST 已注册端点与 SECRET_COMMAND_SURFACE 双源对账：被禁命令面
/// 不得注册任何路由（白名单天然拦截的静态面——无路由即 403；未来
/// 给被禁命令注册路由即红）
#[test]
fn g5_rest_routes_never_register_secret_surface() {
    let registered = [
        INFO_PATH,
        HELLO_PATH,
        STATUS_PATH,
        RUN_SNAPSHOT_PATH,
        SESSION_EVENTS_PATH,
        RUN_EVENTS_PATH,
        SESSIONS_PATH,
        TASKS_PATH,
        TASK_OUTPUT_PATH,
        SESSION_FLOW_PATH,
        COMMANDS_PATH,
        SEARCH_INDEX_PATH,
        PAIR_PATH,
        RUNS_PATH,
        RUN_CONTROL_PATH,
        RUN_CANCEL_PATH,
        APPROVAL_APPROVE_PATH,
        APPROVAL_DENY_PATH,
        APPROVALS_PENDING_PATH,
        APPROVALS_HISTORY_PATH,
        SETTINGS_PATH,
        // R2-12c 新增面（C21/C22/C30/C31）
        SEARCH_FILES_PATH,
        ASSET_URL_PATH,
        SETTINGS_CONFIRM_PATH,
        PAUSE_AUTOMATION_PATH,
    ];
    for name in SECRET_COMMAND_SURFACE {
        assert!(
            !registered.iter().any(|path| path.contains(name)),
            "被禁命令面 {name} 不得注册任何 REST 路由"
        );
    }
}

// ── R1-10 T-08：远程 run 权限模式申报（装配面降级前置）──

/// 远程申报 full-access 原样抵达后端装配面（路由层不拦截申报——
/// 降级语义由装配面 apply_remote_mode 保证：D5 §9.2 operate ×
/// full-access → ask 降级 + 审计）
#[tokio::test]
async fn t08_run_task_passes_permission_mode_wire() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            RUNS_PATH,
            &token,
            serde_json::json!({
                "prompt": "远程 run（full-access 申报）",
                "permissionMode": "full-access",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *mock.last_run_permission_mode.lock().unwrap(),
        Some(conex_types::device::PermissionMode::FullAccess),
        "远程申报 full-access 必须原样透传到后端装配面"
    );
}

// ── R1-11 G-2：POST /v1/pair 移动端配对入口 ──
