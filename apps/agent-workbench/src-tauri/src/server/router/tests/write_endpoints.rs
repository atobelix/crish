//! router 测试：R1-04 写面端点

use super::*;

/// 全部 8 条写端点无令牌必须 401（D2 §7.1 零信任；与只读面同组）
#[tokio::test]
async fn all_write_endpoints_require_token() {
    let app = build_router(test_state());
    for (method, path, label) in [
        ("POST", RUNS_PATH, "run task"),
        ("POST", RUN_CONTROL_PATH, "run control"),
        ("POST", RUN_CANCEL_PATH, "run cancel"),
        ("POST", APPROVAL_APPROVE_PATH, "approve"),
        ("POST", APPROVAL_DENY_PATH, "deny"),
        ("GET", APPROVALS_PENDING_PATH, "approvals pending"),
        ("GET", APPROVALS_HISTORY_PATH, "approvals history"),
        ("GET", SETTINGS_PATH, "settings get"),
        ("PUT", SETTINGS_PATH, "settings set"),
        // R2-12c 新增写面
        ("POST", SETTINGS_CONFIRM_PATH, "settings confirm"),
        ("POST", PAUSE_AUTOMATION_PATH, "pause automation"),
    ] {
        // 路径参数用具体值（{id} 段占位符不可直接请求）
        let uri = path.replace("{id}", "r-1").replace("{toolCallId}", "tc-9");
        let request = if method == "GET" {
            axum::http::Request::builder()
                .uri(&uri)
                .body(Body::empty())
                .unwrap()
        } else {
            axum::http::Request::builder()
                .uri(&uri)
                .method(method)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap()
        };
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{label}（{method} {uri}）无令牌必须 401"
        );
    }
}

// ── R1-04 写面：C24 发起 run ──

#[tokio::test]
async fn run_task_endpoint_starts_run() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            RUNS_PATH,
            &token,
            serde_json::json!({ "prompt": "帮我修登录页 bug" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["runId"], "r-remote");
    assert_eq!(body["sessionId"], "s-1");
}

#[tokio::test]
async fn run_task_idempotent_by_client_message_id() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // 同 clientMessageId 重发 → 回显首次 runId（M6 C24 幂等键）
    let first = app
        .clone()
        .oneshot(authed_body(
            "POST",
            RUNS_PATH,
            &token,
            serde_json::json!({
                "prompt": "帮我修 bug",
                "clientMessageId": "msg-01HZ...",
            }),
        ))
        .await
        .unwrap();
    let second = app
        .oneshot(authed_body(
            "POST",
            RUNS_PATH,
            &token,
            serde_json::json!({
                "prompt": "帮我修 bug",
                "clientMessageId": "msg-01HZ...",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    let first_body = json_body(first).await;
    let second_body = json_body(second).await;
    assert_eq!(
        first_body["runId"], second_body["runId"],
        "同 clientMessageId 必须返回同一 runId"
    );
}

#[tokio::test]
async fn run_task_empty_prompt_is_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            RUNS_PATH,
            &token,
            serde_json::json!({ "prompt": "  " }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.invalid");
}

#[tokio::test]
async fn run_task_malformed_body_is_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // 非 JSON / 缺 prompt 字段 → cmd.invalid 400（JsonBody extractor）
    for payload in ["not-json", "{}", r#"{"prompt": 42}"#] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(RUNS_PATH)
                    .method("POST")
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "载荷 {payload:?} 必须 400"
        );
        let body = json_body(response).await;
        assert_eq!(body["code"], "cmd.invalid");
    }
}

// ── R1-04 写面：C25 run 控制 ──

#[tokio::test]
async fn run_control_endpoint_uses_path_run_id() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    // 路径 runId = r-1，body 携带 r-wrong → 路径优先（REST 资源地址即真键）
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/runs/r-1/control",
            &token,
            serde_json::json!({
                "level": "cooperative_stop",
                "runId": "r-wrong",
                "sessionId": "s-1",
                "reason": "用户远程暂停",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["ok"], true);
    let received = mock.last_run_control.lock().unwrap().clone().unwrap();
    assert_eq!(received.run_id, "r-1", "路径 runId 必须覆盖 body 值");
    assert_eq!(received.session_id, "s-1");
    assert_eq!(received.reason.as_deref(), Some("用户远程暂停"));
}

#[tokio::test]
async fn run_control_invalid_level_is_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/runs/r-1/control",
            &token,
            serde_json::json!({
                "level": "sideways",
                "runId": "r-1",
                "sessionId": "s-1",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.invalid");
}

// ── R1-04 写面：C26 取消 run ──

#[tokio::test]
async fn cancel_run_endpoint_ok() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/runs/r-1/cancel",
            &token,
            serde_json::json!({ "reason": "用户远程取消" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["runId"], "r-1");
}

#[tokio::test]
async fn cancel_run_unknown_run_is_404() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/runs/r-missing/cancel",
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

// ── R1-04 写面：C11 审批批准 / C12 审批拒绝（I-02 语义核心）──

#[tokio::test]
async fn approve_endpoint_ok() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/approval/tc-9/approve",
            &token,
            serde_json::json!({ "runId": "r-1" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["toolCallId"], "tc-9");
    assert_eq!(body["decision"], "approved");
}

#[tokio::test]
async fn approve_duplicate_decision_conflicts_409() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    // 首次决策 → 200；重复决策（幂等键冲突信号）→ 409 approval_mismatch
    let first = app
        .clone()
        .oneshot(authed_body(
            "POST",
            "/v1/approval/tc-9/approve",
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let second = app
        .oneshot(authed_body(
            "POST",
            "/v1/approval/tc-9/approve",
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT, "重复决策必须 409");
    let body = json_body(second).await;
    assert_eq!(body["code"], "cmd.approval_mismatch");
    assert_eq!(body["retryable"], false);
}

#[tokio::test]
async fn approve_unknown_tool_call_is_404() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/approval/tc-missing/approve",
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.not_found");
}

#[tokio::test]
async fn deny_endpoint_ok_with_reason() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            "/v1/approval/tc-7/deny",
            &token,
            serde_json::json!({ "reason": "风险过高" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["toolCallId"], "tc-7");
    assert_eq!(body["decision"], "denied");
    assert_eq!(
        mock.last_deny_reason.lock().unwrap().as_deref(),
        Some("风险过高"),
        "deny 的 reason 必须透传到后端"
    );
}

// ── R1-04 写面：C13 待审批对账 / C14 审批历史 ──

#[tokio::test]
async fn approvals_pending_endpoint_returns_list() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/approvals/pending", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    let approvals = body["approvals"].as_array().unwrap();
    assert_eq!(approvals.len(), 2);
    assert_eq!(approvals[0]["toolCallId"], "tc-9");
    assert_eq!(approvals[0]["toolName"], "shell:write");
    assert_eq!(approvals[0]["dangerLevel"], 2);
    assert_eq!(approvals[0]["requestId"], "approval-tc-9");
    assert_eq!(approvals[1]["dangerLevel"], 1);
}

#[tokio::test]
async fn approvals_history_endpoint_returns_items() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get(
            "/v1/approvals/history?sessionId=s-1&afterSequence=10&limit=5",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    let items = body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["sequence"], 12);
    assert_eq!(items[0]["decision"], "approved");
    assert_eq!(items[1]["decision"], "denied");
    assert_eq!(items[1]["reason"], "风险过高");
    assert_eq!(body["nextAfterSequence"], 14);
    assert_eq!(body["hasMore"], false);
}

// ── R1-04 写面：C28 设置快照 / C29 非敏感配置更新 ──

#[tokio::test]
async fn settings_get_endpoint_returns_snapshot_and_forwards_keys() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get("/v1/settings?keys=model,baseUrl", &token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["settings"]["model"], "deepseek-v4");
    // 快照脱敏：apiKey 恒空串（K-02 由 config 层保证，mock 同形状）
    assert_eq!(body["settings"]["apiKey"], "");
    assert_eq!(
        mock.last_settings_keys.lock().unwrap().as_deref(),
        Some(vec!["model".to_string(), "baseUrl".to_string()]).as_deref(),
        "keys 必须解析为列表透传到后端"
    );
}

#[tokio::test]
async fn settings_set_endpoint_updates() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "PUT",
            SETTINGS_PATH,
            &token,
            serde_json::json!({ "model": "deepseek-v5" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["settings"]["model"], "deepseek-v5");
}

#[tokio::test]
async fn settings_set_restricted_fields_are_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    for (payload, label) in [
        (
            serde_json::json!({ "credentialMode": "direct" }),
            "credentialMode 拒绝字段",
        ),
        (
            serde_json::json!({ "endpoint": "auto" }),
            "endpoint 拒绝字段",
        ),
        (serde_json::json!({ "stream": false }), "stream 拒绝字段"),
    ] {
        let response = app
            .clone()
            .oneshot(authed_body("PUT", SETTINGS_PATH, &token, payload))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{label} 必须 400"
        );
        let body = json_body(response).await;
        assert_eq!(
            body["code"], "cmd.invalid",
            "{label} 错误码应为 cmd.invalid"
        );
    }
}

// ── R2-12c 新增面：C21 文件搜索 / C22 资源 URL / C30 设置确认 / C31 暂停 ──
