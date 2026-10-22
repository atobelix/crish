//! router 测试：R2-12c 新增面（C21/C22/C30/C31）

use super::*;

/// 鉴权：4 条新端点无令牌一律 401（与只读/写面同组零信任）
#[tokio::test]
async fn r2_12_new_endpoints_require_token() {
    let app = build_router(test_state());
    for (method, path, label) in [
        ("GET", SEARCH_FILES_PATH, "search files"),
        ("GET", ASSET_URL_PATH, "asset url"),
        ("POST", SETTINGS_CONFIRM_PATH, "settings confirm"),
        ("POST", PAUSE_AUTOMATION_PATH, "pause automation"),
    ] {
        let request = axum::http::Request::builder()
            .uri(path)
            .method(method)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{label}（{method} {path}）无令牌必须 401"
        );
    }
}

/// C21：搜索端点返回命中 + 查询参数透传后端（query / root / maxResults
/// 原样抵达）
#[tokio::test]
async fn r2_12_search_files_endpoint_returns_hits_and_forwards_params() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get(
            "/v1/search/files?query=login&root=src&maxResults=50",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["results"][0]["relPath"], "src/main.rs");
    assert_eq!(body["results"][1]["relPath"], "README.md");
    let received = mock.last_search_files.lock().unwrap().clone().unwrap();
    assert_eq!(received.query, "login");
    assert_eq!(received.root.as_deref(), Some("src"));
    assert_eq!(received.max_results, Some(50));
}

/// C21：query 缺失/空串 → 400 cmd.invalid（注册表必填 1-256）；
/// maxResults 非数字 → 400
#[tokio::test]
async fn r2_12_search_files_invalid_params_are_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    for (uri, label) in [
        ("/v1/search/files", "query 缺失"),
        ("/v1/search/files?query=%20%20", "query 空白"),
        (
            "/v1/search/files?query=main&maxResults=abc",
            "maxResults 非数字",
        ),
    ] {
        let response = app.clone().oneshot(authed_get(uri, &token)).await.unwrap();
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

/// C22：资源 URL 占位 → 501 + cmd.unknown（F4 §5.4 资源代理未实现，
/// 诚实降级不捏造 URL；错误码经 http_status 映射 501）
#[tokio::test]
async fn r2_12_asset_url_placeholder_returns_501() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_get(
            "/v1/assets/url?path=docs%2Fx.png&kind=image",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.unknown");
    assert_eq!(body["retryable"], false);
}

/// C22：kind 缺失 → 400 cmd.invalid（注册表 AssetUrlParams.kind 必填）
#[tokio::test]
async fn r2_12_asset_url_missing_kind_is_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    for (uri, label) in [
        ("/v1/assets/url?path=docs%2Fx.png", "kind 缺失"),
        (
            "/v1/assets/url?path=docs%2Fx.png&kind=sideways",
            "kind 非法",
        ),
    ] {
        let response = app.clone().oneshot(authed_get(uri, &token)).await.unwrap();
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

/// C30：确认回执端点返回状态 + 参数透传（confirmRequestId / action）
#[tokio::test]
async fn r2_12_settings_confirm_endpoint_returns_status_and_forwards() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(authed_body(
            "POST",
            SETTINGS_CONFIRM_PATH,
            &token,
            serde_json::json!({ "confirmRequestId": "req-1", "action": "withdraw" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["status"], "withdrawn");
    assert_eq!(body["reason"], "mock 回执");
    let received = mock.last_settings_confirm.lock().unwrap().clone().unwrap();
    assert_eq!(received.confirm_request_id, "req-1");
    assert_eq!(received.action, SettingsConfirmAction::Withdraw);
}

/// C30：body 非法（缺 confirmRequestId / action 枚举非法）→ 400 cmd.invalid
#[tokio::test]
async fn r2_12_settings_confirm_invalid_body_is_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    for (payload, label) in [
        (
            serde_json::json!({ "action": "query" }),
            "缺 confirmRequestId",
        ),
        (
            serde_json::json!({ "confirmRequestId": "req-1", "action": "sideways" }),
            "action 非法",
        ),
        (serde_json::json!("not-an-object"), "非对象 body"),
    ] {
        let response = app
            .clone()
            .oneshot(authed_body("POST", SETTINGS_CONFIRM_PATH, &token, payload))
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

/// C31：暂停端点返回 {ok, pausedUntil} + durationSec 透传后端
#[tokio::test]
async fn r2_12_pause_automation_endpoint_ok_and_forwards_duration() {
    let mock = Arc::new(MockBackend::new());
    let state = test_state_from_backend(Some(Arc::clone(&mock) as Arc<dyn ApiBackend>));
    let token = issue_token(&state);
    let app = build_router(state);
    let response = app
        .clone()
        .oneshot(authed_body(
            "POST",
            PAUSE_AUTOMATION_PATH,
            &token,
            serde_json::json!({ "durationSec": 120 }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["pausedUntil"], 1_754_700_060_000_u64);
    assert_eq!(
        *mock.last_pause_duration.lock().unwrap(),
        Some(120),
        "durationSec 必须透传到后端（钳制在装配面执行）"
    );
    // 缺省 durationSec → 透传 None（后端按缺省 3600 处理）
    let response = app
        .oneshot(authed_body(
            "POST",
            PAUSE_AUTOMATION_PATH,
            &token,
            serde_json::json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(*mock.last_pause_duration.lock().unwrap(), None);
}

/// C31：body 非法（durationSec 非数字 / 非对象）→ 400 cmd.invalid
#[tokio::test]
async fn r2_12_pause_automation_invalid_body_is_400() {
    let state = test_state_with(Some(MockBackend::new()));
    let token = issue_token(&state);
    let app = build_router(state);
    for (payload, label) in [
        (
            serde_json::json!({ "durationSec": "abc" }),
            "durationSec 非数字",
        ),
        (serde_json::json!("not-an-object"), "非对象 body"),
    ] {
        let response = app
            .clone()
            .oneshot(authed_body("POST", PAUSE_AUTOMATION_PATH, &token, payload))
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

/// 白名单对账（G-5 双源）：4 条新端点对应命令必须登记于远程白名单
/// （白名单是命令执行面唯一真源——端点与白名单漂移即红）
#[test]
fn r2_12_endpoints_registered_in_whitelist() {
    for command in [
        "searchFiles",
        "assetUrl",
        "settingsConfirm",
        "pauseAutomation",
    ] {
        assert!(
            crate::server::remote_whitelist::is_remote_command_whitelisted(command),
            "命令 {command} 必须登记于远程白名单（R2-12c 新端点）"
        );
    }
}

// ── R1-10 T-07：远程面白名单拒绝（密钥命令面触达；D5 §9.1）──
