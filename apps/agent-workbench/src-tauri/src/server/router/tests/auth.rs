//! router 测试：鉴权面：info/hello、Bearer 401、T-01/T-11、兜底 404、只读面鉴权

use super::*;

#[test]
fn backend_injectable_into_state() {
    let handle = ServerHandle::new(
        ServerConfig::new(std::env::temp_dir()),
        "127.0.0.1:0".parse().unwrap(),
    );
    let backend: Option<Arc<dyn crate::server::backend::ApiBackend>> =
        Some(Arc::new(MockBackend::new()));
    let state = ServerState::new(
        &handle,
        TokenStore::new(std::env::temp_dir().join("pairing-router-inject-test.json")),
        backend,
    );
    assert!(state.backend().is_some(), "backend 注入后应可读取");
}

#[tokio::test]
async fn info_endpoint_shape() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(INFO_PATH)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(info["service"].as_str(), Some("crish-agent-workbench"));
    assert!(info["version"].is_string());
    assert_eq!(info["protocolVersion"].as_u64(), Some(1));
    assert_eq!(info["minProtocolVersion"].as_u64(), Some(1));
    assert_eq!(info["bindMode"].as_str(), Some("loopback"));
    assert_eq!(info["pairingActive"].as_bool(), Some(false));
    assert!(info["port"].is_u64(), "port 必须存在");
    assert!(info["serverTimeMs"].is_u64(), "serverTimeMs 必须存在");
    let caps = info["capabilities"]
        .as_object()
        .expect("capabilities 必须为对象");
    assert_eq!(caps.len(), 17, "能力位必须 17 位全表");
}

#[tokio::test]
async fn hello_without_token_succeeds_and_returns_clock() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(HELLO_PATH)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .contains_key(crate::server::auth::SERVER_TIME_HEADER));
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["protocolVersion"].as_u64(), Some(1));
    assert!(body["serverVersion"].is_string());
    assert!(body["serverTimeMs"].is_u64());
}

#[tokio::test]
async fn status_without_token_is_401() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(STATUS_PATH)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(response
        .headers()
        .contains_key(crate::server::auth::SERVER_TIME_HEADER));
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body.code, DeviceErrorCode::AuthBadSignature);
    assert!(!body.retryable);
}

#[tokio::test]
async fn hello_with_valid_token_succeeds() {
    let state = test_state();
    let raw = issue_token(&state);
    let app = build_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(HELLO_PATH)
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {raw}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .contains_key(crate::server::auth::SERVER_TIME_HEADER));
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["protocolVersion"].as_u64(), Some(1));
    assert!(body["serverVersion"].is_string());
    assert!(body["serverTimeMs"].is_u64());
}

#[tokio::test]
async fn status_with_revoked_token_is_401() {
    let state = test_state();
    let raw = issue_token(&state);
    let hash = sha256_hex(raw.as_bytes());
    assert!(state.tokens().lock().unwrap().revoke(&hash));
    let app = build_router(state);
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(STATUS_PATH)
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {raw}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body.code, DeviceErrorCode::AuthDeviceRevoked);
}

#[tokio::test]
async fn malformed_auth_header_is_401() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(STATUS_PATH)
                // 非 Bearer 前缀 / 空令牌
                .header(axum::http::header::AUTHORIZATION, "Token abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ── R1-10 T-01：伪造端无令牌直连 ──

/// T-01 伪造端直连（无令牌）：状态只读 / 会话列表 / 审批写面代表性端点一律
/// 401 + AuthBadSignature（D2 §7.1 零信任：认证先于一切业务面），并注入 X-Server-Time-Ms
#[tokio::test]
async fn t01_no_token_direct_connection_rejected() {
    let app = build_router(test_state());
    let cases = [
        ("只读状态面", "GET", STATUS_PATH),
        ("会话列表面", "GET", SESSIONS_PATH),
        ("审批写面", "POST", "/v1/approval/tc-fake/approve"),
    ];
    for (label, method, uri) in cases {
        let request = axum::http::Request::builder()
            .uri(uri)
            .method(method)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{label} {uri} 无令牌直连必须 401"
        );
        assert!(
            response
                .headers()
                .contains_key(crate::server::auth::SERVER_TIME_HEADER),
            "{label} 401 响应头必须携带 X-Server-Time-Ms"
        );
        let body: ErrorBody = serde_json::from_value(json_body(response).await)
            .expect("401 载荷必须可反序列化为 ErrorBody");
        assert_eq!(
            body.code,
            DeviceErrorCode::AuthBadSignature,
            "{label} 无令牌错误码必须为 auth.bad_signature"
        );
        assert!(!body.retryable, "{label} 认证失败不可重试");
    }
}

/// T-01 伪造令牌（错误令牌）直连：认证失败 + 失败计数（R1-10 T-01
/// 计数锚——伪造端每次失败按尝试令牌哈希累计）；合法令牌不受影响
#[tokio::test]
async fn t01_forged_token_rejected_and_counts_failure() {
    let state = test_state_with(Some(MockBackend::new()));
    let app = build_router(state.clone());
    let forged = "f".repeat(64);
    let forged_hash = sha256_hex(forged.as_bytes());
    for expected in 1..=3 {
        let response = app
            .clone()
            .oneshot(authed_get(STATUS_PATH, &forged))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body: ErrorBody = serde_json::from_value(json_body(response).await)
            .expect("401 载荷必须可反序列化为 ErrorBody");
        assert_eq!(body.code, DeviceErrorCode::AuthBadSignature);
        let count = state
            .tokens()
            .lock()
            .unwrap()
            .auth_failure_count(&forged_hash);
        assert_eq!(
            count, expected,
            "第 {expected} 次伪造直连后失败计数应为 {expected}"
        );
    }
    // 合法令牌随后可正常通过（伪造尝试不影响合法路径）
    let raw = issue_token(&state);
    let response = app
        .clone()
        .oneshot(authed_get(STATUS_PATH, &raw))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

// ── R1-10 T-11：撤销即时性（重连被拒） ──

/// T-11 撤销即时性：撤销前旧令牌可连（200）→ 撤销后同一令牌重连请求
/// 立即被拒（401 + AuthDeviceRevoked）；Revoked 失败计入认证失败计数
#[tokio::test]
async fn t11_reconnect_with_revoked_token_rejected() {
    let state = test_state_with(Some(MockBackend::new()));
    let raw = issue_token(&state);
    let hash = sha256_hex(raw.as_bytes());
    let app = build_router(state.clone());

    // 撤销前：旧令牌连接成功
    let before = app
        .clone()
        .oneshot(authed_get(STATUS_PATH, &raw))
        .await
        .unwrap();
    assert_eq!(before.status(), StatusCode::OK, "撤销前旧令牌应可连");

    // 撤销（注册表删除）→ 旧令牌重连请求被拒
    assert!(state.tokens().lock().unwrap().revoke(&hash));
    let after = app
        .clone()
        .oneshot(authed_get(STATUS_PATH, &raw))
        .await
        .unwrap();
    assert_eq!(
        after.status(),
        StatusCode::UNAUTHORIZED,
        "撤销后旧令牌重连必须被拒"
    );
    let body: ErrorBody =
        serde_json::from_value(json_body(after).await).expect("401 载荷必须可反序列化为 ErrorBody");
    assert_eq!(
        body.code,
        DeviceErrorCode::AuthDeviceRevoked,
        "撤销后重连错误码必须为 auth.device_revoked"
    );
    // Revoked 计入认证失败计数（T-01 计数锚与 T-11 联动）
    let count = state.tokens().lock().unwrap().auth_failure_count(&hash);
    assert_eq!(count, 1, "撤销后重放一次 = 一次认证失败");
}

#[tokio::test]
async fn unknown_path_returns_404_error_body() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/v1/does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body.code, DeviceErrorCode::CmdNotFound);
}

#[tokio::test]
async fn error_response_maps_status_and_body() {
    let response = error_response(&ServerError::protocol(
        DeviceErrorCode::PairExpired,
        "配对码已过期",
    ));
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body.code, DeviceErrorCode::PairExpired);
}

// ── R1-03 只读面：鉴权 ──

/// 全部 10 条只读端点无令牌必须 401（D2 §7.1 零信任）
#[tokio::test]
async fn all_read_endpoints_require_token() {
    let app = build_router(test_state());
    for (path, label) in [
        (STATUS_PATH, "status"),
        (RUN_SNAPSHOT_PATH, "run snapshot"),
        (RUN_EVENTS_PATH, "run events"),
        (SESSIONS_PATH, "sessions"),
        (SESSION_EVENTS_PATH, "session events"),
        (SESSION_FLOW_PATH, "session flow"),
        (TASKS_PATH, "tasks"),
        (TASK_OUTPUT_PATH, "task output"),
        (COMMANDS_PATH, "commands"),
        (SEARCH_INDEX_PATH, "search index"),
    ] {
        // 路径参数用具体值（{id} 段占位符不可直接请求）
        let uri = path
            .replace("{id}", "x-1")
            .replace("{sessionId}", "s-1")
            .replace("{runId}", "r-1")
            .replace("{taskId}", "t-1");
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
            StatusCode::UNAUTHORIZED,
            "{label}（{uri}）无令牌必须 401"
        );
    }
}

// ── R1-03 只读面：C01 状态 ──
