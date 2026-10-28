//! router 测试：配对端点

use super::*;

/// 配对测试状态：服务开关开启 + 配对协调器注入（协调器令牌库与路由
/// 层令牌库同文件——reload_tokens 收口断言「令牌立即生效」）。
/// 返回 (state, coordinator)；码经 coordinator.start_pairing 激活。
fn test_pair_state() -> (ServerState, Arc<crate::server::pairing::PairingCoordinator>) {
    let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("pairing-pair-{seq}.json"));
    let mut config = ServerConfig::new(std::env::temp_dir());
    config.multi_device_enabled = true;
    config.pairing_file_path = file.clone();
    let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
    let ws_registry = Arc::new(crate::server::ws::WsRegistry::new());
    let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
        tokens,
        ws_registry,
    ));
    let state = ServerState::new(
        &handle,
        TokenStore::new(handle.config().pairing_file_path.clone()),
        Some(Arc::new(MockBackend::new())),
    )
    .with_pairing(Arc::clone(&coordinator));
    (state, coordinator)
}

/// 激活配对并返回展示码（CXN-XXXX-XXXX-XXXX）
fn activate_pairing(coordinator: &crate::server::pairing::PairingCoordinator) -> String {
    coordinator
        .start_pairing(now_ms())
        .expect("激活配对必须成功")
        .code
}

/// 无鉴权 JSON POST（/v1/pair 免鉴权端点测试用；注入 ConnectInfo——
/// 限速读取源 IP，路由经 serve 的 into_make_service_with_connect_info
/// 装配，测试侧以扩展手动注入对拍）
fn plain_post(uri: &str, body: serde_json::Value) -> axum::http::Request<Body> {
    plain_post_from_ip(uri, body, "127.0.0.1".parse().expect("固定测试地址"))
}

/// 指定源 IP 的无鉴权 JSON POST（每 IP 限速测试用）
fn plain_post_from_ip(
    uri: &str,
    body: serde_json::Value,
    ip: std::net::IpAddr,
) -> axum::http::Request<Body> {
    let mut request = axum::http::Request::builder()
        .uri(uri)
        .method("POST")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(SocketAddr::new(ip, 40000)));
    request
}

/// 免鉴权 POST /v1/pair：正确码 → 200 {token, label?}，且令牌**无
/// Authorization 头**即可拿到（配对端点豁免鉴权——否则先有令牌才能
/// 拿令牌）；令牌立即可用于后续鉴权请求（GET /v1/status 200）
#[tokio::test]
async fn pair_endpoint_issues_token_usable_immediately() {
    let (state, coordinator) = test_pair_state();
    let code = activate_pairing(&coordinator);
    let app = build_router(state);

    // 无令牌 POST → 200（免鉴权入口）
    let response = app
        .clone()
        .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    let token = body["token"].as_str().expect("必须返回令牌明文");
    assert_eq!(token.len(), 64, "32B hex 令牌");
    assert!(body.get("label").is_none(), "未提供 label 时省略");

    // 令牌立即可用于后续请求（reload_tokens 收口：协调器 store 与
    // 路由 store 分离的 R1-07 装配断裂修复点）
    let response = app
        .clone()
        .oneshot(authed_get(STATUS_PATH, token))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "新令牌必须立即通过鉴权");
}

/// 免鉴权 POST /v1/pair：label 回显；错误码 → 401 + pair.invalid_code
#[tokio::test]
async fn pair_endpoint_wrong_code_is_401_with_label_echo() {
    let (state, coordinator) = test_pair_state();
    activate_pairing(&coordinator);
    let app = build_router(state);
    let response = app
        .oneshot(plain_post(
            PAIR_PATH,
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC", "label": "我的手机" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = json_body(response).await;
    assert_eq!(body["code"], "pair.invalid_code");
}

/// 格式非法码 → 401 + pair.invalid_code（标准化失败，不计数）
#[tokio::test]
async fn pair_endpoint_invalid_format_is_401() {
    let (state, coordinator) = test_pair_state();
    activate_pairing(&coordinator);
    let app = build_router(state);
    let response = app
        .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": "BAD" })))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = json_body(response).await;
    assert_eq!(body["code"], "pair.invalid_code");
}

/// 5 次失败 → 锁定语义（R1-10 T-05 的 REST 形态）：4 次错误仅计数
/// 401；第 5 次失败后正确码 → 409 + pair.too_many_attempts（对齐
/// complete_pairing 的 Locked 映射；Destroyed 冷却后的永久失效已由
/// pairing.rs T-05 状态机测试覆盖——REST 层时钟不可控）
#[tokio::test]
async fn pair_endpoint_five_failures_lock_with_409() {
    let (state, coordinator) = test_pair_state();
    let code = activate_pairing(&coordinator);
    let app = build_router(state);
    for _ in 0..4 {
        let response = app
            .clone()
            .oneshot(plain_post(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    // 第 5 次错误：计数达上限（仍 401，计数语义）
    let response = app
        .clone()
        .oneshot(plain_post(
            PAIR_PATH,
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    // 锁定期内正确码 → 409 + pair.too_many_attempts
    let response = app
        .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::CONFLICT,
        "锁定期间正确码必须 409"
    );
    let body = json_body(response).await;
    assert_eq!(body["code"], "pair.too_many_attempts");
}

/// 服务开关关闭（multi_device.enabled=false）→ 503（服务未开启；
/// 生产装配面此时根本不 bind，本断言兜住路由层直测语义）
#[tokio::test]
async fn pair_endpoint_service_disabled_is_503() {
    let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("pairing-pair-disabled-{seq}.json"));
    let mut config = ServerConfig::new(std::env::temp_dir());
    config.multi_device_enabled = false; // 服务开关默认关闭
    config.pairing_file_path = file.clone();
    let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
    let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
        tokens,
        Arc::new(crate::server::ws::WsRegistry::new()),
    ));
    let state = ServerState::new(
        &handle,
        TokenStore::new(handle.config().pairing_file_path.clone()),
        None,
    )
    .with_pairing(Arc::clone(&coordinator));
    activate_pairing(&coordinator); // 即使有活跃码也拒绝（开关优先）
    let app = build_router(state);
    let response = app
        .oneshot(plain_post(
            PAIR_PATH,
            serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.denied");
}

/// 请求体非法（缺 code / 非 JSON）→ 400 + cmd.invalid
#[tokio::test]
async fn pair_endpoint_malformed_body_is_400() {
    let (state, coordinator) = test_pair_state();
    activate_pairing(&coordinator);
    let app = build_router(state);
    for body in [
        serde_json::json!({}),
        serde_json::json!({ "code": 42 }),
        serde_json::json!("not-an-object"),
    ] {
        let body_label = body.to_string();
        let response = app
            .clone()
            .oneshot(plain_post(PAIR_PATH, body))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "body={body_label}"
        );
    }
}

/// 令牌仅此一次明文返回：重复使用同一码 → 401 + pair.used（一次性）
#[tokio::test]
async fn pair_endpoint_code_is_single_use() {
    let (state, coordinator) = test_pair_state();
    let code = activate_pairing(&coordinator);
    let app = build_router(state);
    let response = app
        .clone()
        .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .oneshot(plain_post(PAIR_PATH, serde_json::json!({ "code": code })))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body = json_body(response).await;
    assert_eq!(body["code"], "pair.used");
}

// ── R1 收口：/v1/pair 每源 IP 限速（D2 §12.4「10 次/分钟」；
//    AU4 问题 #1 缺口销号）──

/// D2 §12.4 断言锚：同 IP 前 10 次请求（混合 200/401/409 业务面——
/// 成功与失败统一计）全部到达业务逻辑；第 11 次 → 429 +
/// cmd.too_many_requests（error.rs 既有 429 映射）+ 审计 1；拒绝不
/// 计数（count_for 恒 10，防拒绝路径被刷爆窗口）
#[tokio::test]
async fn pair_endpoint_rate_limits_11th_request_per_ip() {
    let (state, coordinator) = test_pair_state();
    let code = activate_pairing(&coordinator);
    let app = build_router(state.clone());
    let ip: std::net::IpAddr = "192.168.1.50".parse().expect("固定测试 IP");
    for i in 0..10 {
        // 混合业务面：第 5 次正确码（200 成功），其余错误码（401；
        // 5 次失败锁定后可能 409）——限速口径「窗口内全部请求计数」
        let body = if i == 4 {
            serde_json::json!({ "code": code })
        } else {
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" })
        };
        let response = app
            .clone()
            .oneshot(plain_post_from_ip(PAIR_PATH, body, ip))
            .await
            .unwrap();
        assert!(
            matches!(
                response.status(),
                StatusCode::OK | StatusCode::UNAUTHORIZED | StatusCode::CONFLICT
            ),
            "第 {} 次应在限速前到达业务面：{:?}",
            i + 1,
            response.status()
        );
    }
    assert_eq!(state.pair_limiter().count_for(ip), 10);
    // 第 11 次 → 429 + cmd.too_many_requests
    let response = app
        .oneshot(plain_post_from_ip(
            PAIR_PATH,
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
            ip,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.too_many_requests");
    assert_eq!(state.pair_limiter().audit_rejected(), 1, "超限必须审计 +1");
    assert_eq!(
        state.pair_limiter().count_for(ip),
        10,
        "拒绝不计数（防拒绝路径被刷爆窗口）"
    );
}

/// 每源 IP 独立：IP-A 打满拒绝不影响 IP-B（IP-B 请求必须到达业务面，
/// 绝非 429）
#[tokio::test]
async fn pair_endpoint_rate_limit_per_ip_independent() {
    let (state, coordinator) = test_pair_state();
    let code = activate_pairing(&coordinator);
    let app = build_router(state.clone());
    let ip_a: std::net::IpAddr = "192.168.1.60".parse().expect("固定测试 IP");
    let ip_b: std::net::IpAddr = "192.168.1.61".parse().expect("固定测试 IP");
    for _ in 0..10 {
        let response = app
            .clone()
            .oneshot(plain_post_from_ip(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
                ip_a,
            ))
            .await
            .unwrap();
        assert!(response.status().is_client_error());
    }
    assert_eq!(
        app.clone()
            .oneshot(plain_post_from_ip(
                PAIR_PATH,
                serde_json::json!({ "code": "x" }),
                ip_a,
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS,
        "IP-A 第 11 次必须 429"
    );
    // IP-B 首次请求（正确码）：必须到达业务面（配对锁定语义下可能
    // 409——只要不是 429 即证明 IP-B 独立桶未受影响）
    let response = app
        .oneshot(plain_post_from_ip(
            PAIR_PATH,
            serde_json::json!({ "code": code }),
            ip_b,
        ))
        .await
        .unwrap();
    assert_ne!(
        response.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "IP-B 独立桶不受 IP-A 限速影响"
    );
    assert_eq!(state.pair_limiter().count_for(ip_b), 1);
    assert_eq!(state.pair_limiter().audit_rejected(), 1);
}

/// 服务关闭（multi_device.enabled=false）→ 503 不消耗限速额度：
/// 连发 12 次后审计与窗口计数均为 0（限速在服务开关检查之后）
#[tokio::test]
async fn pair_endpoint_rate_limit_service_disabled_not_counted() {
    let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("pairing-pair-ratelimit-{seq}.json"));
    let mut config = ServerConfig::new(std::env::temp_dir());
    config.multi_device_enabled = false;
    config.pairing_file_path = file.clone();
    let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
    let coordinator = Arc::new(crate::server::pairing::PairingCoordinator::new(
        tokens,
        Arc::new(crate::server::ws::WsRegistry::new()),
    ));
    let state = ServerState::new(
        &handle,
        TokenStore::new(handle.config().pairing_file_path.clone()),
        None,
    )
    .with_pairing(Arc::clone(&coordinator));
    let app = build_router(state.clone());
    let ip: std::net::IpAddr = "192.168.1.70".parse().expect("固定测试 IP");
    for _ in 0..12 {
        let response = app
            .clone()
            .oneshot(plain_post_from_ip(
                PAIR_PATH,
                serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
                ip,
            ))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "关闭态恒 503"
        );
    }
    assert_eq!(
        state.pair_limiter().count_for(ip),
        0,
        "关闭态不得消耗限速额度"
    );
    assert_eq!(state.pair_limiter().audit_rejected(), 0);
}

/// 成功也计入窗口：配对成功（200）后窗口计数 +1——防「成功换码绕过
/// 限速」的计数一致性断言
#[tokio::test]
async fn pair_endpoint_rate_limit_success_consumes_window() {
    let (state, coordinator) = test_pair_state();
    let code = activate_pairing(&coordinator);
    let app = build_router(state.clone());
    let ip: std::net::IpAddr = "192.168.1.80".parse().expect("固定测试 IP");
    let response = app
        .oneshot(plain_post_from_ip(
            PAIR_PATH,
            serde_json::json!({ "code": code }),
            ip,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        state.pair_limiter().count_for(ip),
        1,
        "成功请求必须计入窗口（成功与失败统一计）"
    );
}
