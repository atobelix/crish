//! server pair_endpoint 测试（pair_endpoint.rs 拆分）：错误映射 / 限速 / hello 纯函数。

use super::*;

use crate::server::auth::{TokenStore, TokenVerdict};
use crate::server::config::ServerConfig;
use crate::server::ws::WsRegistry;
use crate::server::ServerHandle;
use axum::body::Body;
use std::net::IpAddr;
use std::sync::Arc;

/// 测试源 IP（同 IP 限速断言锚）
fn test_ip() -> IpAddr {
    "192.168.1.10".parse().expect("固定测试 IP")
}

/// 测试 SocketAddr（ConnectInfo 注入用）
fn test_addr() -> SocketAddr {
    SocketAddr::new(test_ip(), 40000)
}

/// 配对启用状态（服务开关开 + 协调器注入；协调器令牌库与路由层令牌库
/// 同文件——reload_tokens 收口断言「令牌立即生效」）。返回 state 与
/// 协调器；码经 coordinator.start_pairing 激活。
fn test_state() -> (ServerState, Arc<PairingCoordinator>) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("pairing-endpoint-test-{seq}.json"));
    let mut config = ServerConfig::new(std::env::temp_dir());
    config.multi_device_enabled = true;
    config.pairing_file_path = file.clone();
    let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    let tokens = Arc::new(std::sync::Mutex::new(TokenStore::new(file)));
    let coordinator = Arc::new(PairingCoordinator::new(tokens, Arc::new(WsRegistry::new())));
    let state = ServerState::new(
        &handle,
        TokenStore::new(handle.config().pairing_file_path.clone()),
        None,
    )
    .with_pairing(Arc::clone(&coordinator));
    (state, coordinator)
}

/// 服务关闭状态（enabled=false；限速不消耗额度断言用）
fn disabled_state() -> ServerState {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = std::env::temp_dir().join(format!("pairing-endpoint-disabled-{seq}.json"));
    let mut config = ServerConfig::new(std::env::temp_dir());
    config.multi_device_enabled = false;
    config.pairing_file_path = file.clone();
    let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    ServerState::new(
        &handle,
        TokenStore::new(handle.config().pairing_file_path.clone()),
        None,
    )
}

/// 激活配对并返回展示码
fn activate(coordinator: &PairingCoordinator) -> String {
    coordinator
        .start_pairing(now_ms())
        .expect("激活配对必须成功")
        .code
}

/// 指定来源的配对请求（每 IP 限速测试用）
fn pair_request_from(body: serde_json::Value, addr: SocketAddr) -> axum::http::Request<Body> {
    let mut request = axum::http::Request::builder()
        .uri("/v1/pair")
        .method("POST")
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(addr));
    request
}

/// 读取响应 JSON 载荷
async fn json_body(response: Response) -> serde_json::Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("读取响应体");
    serde_json::from_slice(&bytes).expect("响应体必须为合法 JSON")
}

/// 直接驱动 handler（State + ConnectInfo 显式构造——axum extractor 可
/// 手动传参；router.rs 经 build_router 走同一 handler，两处对拍）
async fn call_handler(state: &ServerState, addr: SocketAddr, body: serde_json::Value) -> Response {
    handle_rest_pair(
        State(state.clone()),
        ConnectInfo(addr),
        pair_request_from(body, addr),
    )
    .await
}

// ── AU4 问题 #7：错误映射矩阵（503/401/409/200）+ 限速（D2 §12.4）──

/// 服务开关关闭 → 503 + cmd.denied（服务未开启；D5 D-01 红线 1 路由层
/// 镜像）
#[tokio::test]
async fn service_disabled_returns_503_cmd_denied() {
    let state = disabled_state();
    let response = call_handler(
        &state,
        test_addr(),
        serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.denied");
    // 关闭态不消耗限速额度（D2 §12.4 限速在服务开关检查之后）
    assert_eq!(state.pair_limiter().count_for(test_ip()), 0);
    assert_eq!(state.pair_limiter().audit_rejected(), 0);
}

/// 协调器未装配 → 503 + internal（诚实降级；也不消耗限速额度）
#[tokio::test]
async fn coordinator_unwired_returns_503_internal() {
    let state = ServerState::new(
        &ServerHandle::new(
            {
                let mut config = ServerConfig::new(std::env::temp_dir());
                config.multi_device_enabled = true;
                config
            },
            "127.0.0.1:0".parse().expect("固定测试地址"),
        ),
        TokenStore::new(std::env::temp_dir().join("pairing-endpoint-none.json")),
        None,
    );
    let response = call_handler(
        &state,
        test_addr(),
        serde_json::json!({ "code": "CXN-7K4P-Q2MB-9XRT" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json_body(response).await;
    assert_eq!(body["code"], "internal");
    assert_eq!(state.pair_limiter().count_for(test_ip()), 0);
}

/// 错误码 → 401 + pair.invalid_code；正确码 → 200 + token 明文 + label
/// 回显（AU4 #7「错误映射 + label 回显」）
#[tokio::test]
async fn wrong_code_401_and_correct_code_200_with_label_echo() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    let wrong = call_handler(
        &state,
        test_addr(),
        serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC", "label": "我的手机" }),
    )
    .await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let body = json_body(wrong).await;
    assert_eq!(body["code"], "pair.invalid_code");
    assert_eq!(body["retryable"], false);
    // 正确码 → 200 + 令牌明文 + label 回显
    let ok = call_handler(
        &state,
        test_addr(),
        serde_json::json!({ "code": code, "label": "我的手机" }),
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);
    let body = json_body(ok).await;
    let token = body["token"].as_str().expect("必须返回令牌明文");
    assert_eq!(token.len(), 64, "32B hex 令牌");
    assert_eq!(body["label"], "我的手机");
    // 令牌立即可用于后续鉴权（reload_tokens 收口：协调器 store 与路由
    // store 分离的 R1-07 装配断裂修复点）
    let tokens = state.tokens();
    let mut guard = tokens.lock().unwrap();
    assert!(
        matches!(guard.verify(token, now_ms()), TokenVerdict::Valid),
        "新令牌必须立即通过路由层令牌库校验"
    );
}

/// 5 次失败锁定 → 409 + pair.too_many_attempts（R1-10 T-05 的 REST 形态）
#[tokio::test]
async fn five_failures_lock_returns_409() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    for _ in 0..5 {
        let response = call_handler(
            &state,
            test_addr(),
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    // 锁定期内正确码 → 409 + pair.too_many_attempts
    let response = call_handler(&state, test_addr(), serde_json::json!({ "code": code })).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = json_body(response).await;
    assert_eq!(body["code"], "pair.too_many_attempts");
    assert!(!body["retryable"].as_bool().unwrap_or(true), "锁定不可重试");
}

/// D2 §12.4 断言锚：同 IP 前 10 次请求（混合 401/200 业务面）全部到达
/// 业务逻辑；第 11 次 → 429 + cmd.too_many_requests + 审计 1；拒绝不
/// 计数（count_for 恒 10）——AU4 问题 #1 收口
#[tokio::test]
async fn eleventh_request_same_ip_rejected_429_with_audit() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    let addr = test_addr();
    for i in 0..10 {
        // 混合业务面：第 5 次用正确码（成功 200），其余错误码（401）——
        // 限速口径「窗口内全部请求计数（成功与失败统一计）」
        let body = if i == 4 {
            serde_json::json!({ "code": code })
        } else {
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" })
        };
        let response = call_handler(&state, addr, body).await;
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
    assert_eq!(state.pair_limiter().count_for(addr.ip()), 10);
    // 第 11 次 → 429 + cmd.too_many_requests（error.rs 既有 429 映射）
    let response = call_handler(
        &state,
        addr,
        serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = json_body(response).await;
    assert_eq!(body["code"], "cmd.too_many_requests");
    assert_eq!(state.pair_limiter().audit_rejected(), 1, "超限必须审计 +1");
    assert_eq!(
        state.pair_limiter().count_for(addr.ip()),
        10,
        "拒绝不计数（防拒绝路径被刷爆窗口）"
    );
    // 继续拒绝 → 审计逐次递增、计数不变
    let response = call_handler(
        &state,
        addr,
        serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(state.pair_limiter().audit_rejected(), 2);
    assert_eq!(state.pair_limiter().count_for(addr.ip()), 10);
}

/// 每源 IP 独立桶：IP-A 打满拒绝后，IP-B 首次请求正常到达业务面
/// （IP-A 的错误码触发 5 次失败锁定后正确码为 409——只要不是 429
/// 即证明 IP-B 独立桶未受影响，锁定属码域语义与限速无关）
#[tokio::test]
async fn rate_limit_buckets_independent_per_ip() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    let addr_a = test_addr();
    let addr_b = SocketAddr::new("192.168.1.11".parse().expect("固定测试 IP"), 40001);
    for _ in 0..10 {
        let response = call_handler(
            &state,
            addr_a,
            serde_json::json!({ "code": "CXN-AAAA-BBBB-CCCC" }),
        )
        .await;
        assert!(response.status().is_client_error());
    }
    assert_eq!(
        call_handler(&state, addr_a, serde_json::json!({ "code": "x" }))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS,
        "IP-A 第 11 次必须 429"
    );
    // IP-B 首次请求：必须到达业务面（200/401/409 均可，绝不 429）
    let response = call_handler(&state, addr_b, serde_json::json!({ "code": code })).await;
    assert_ne!(
        response.status(),
        StatusCode::TOO_MANY_REQUESTS,
        "IP-B 独立桶不受 IP-A 限速影响"
    );
    assert_eq!(state.pair_limiter().count_for(addr_b.ip()), 1);
    assert_eq!(
        state.pair_limiter().audit_rejected(),
        1,
        "IP-B 放行不产生审计"
    );
}

/// 成功也计入窗口：1 次成功（200）后窗口计数 = 1——防「配对成功换新
/// 码绕过限速」的计数一致性断言
#[tokio::test]
async fn successful_pairing_consumes_window_quota() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    let response = call_handler(&state, test_addr(), serde_json::json!({ "code": code })).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        state.pair_limiter().count_for(test_ip()),
        1,
        "成功请求必须计入窗口（成功与失败统一计）"
    );
}

// ── WS 配对消息链纯函数（AU4 问题 #7 模块内覆盖）──

/// pair.hello 合法载荷 → Ok((token, label, device_id))（简化链）
#[test]
fn pair_hello_success_returns_token_and_label() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    let body = serde_json::json!({
        "code": code,
        "deviceId": "dev-1",
        "deviceName": "我的手机",
        "mobilePub": "pub-1",
        "mobileLongPub": "long-pub-1",
        "platform": "android",
    });
    let (token, label, device_id) = handle_pair_hello(&body, state.pairing().as_deref(), now_ms())
        .expect("合法 hello 必须成功");
    assert_eq!(token.len(), 64);
    assert_eq!(label, "我的手机");
    assert_eq!(device_id, "dev-1");
}

/// pair.hello 设备名防御截断（≤64 字符，对齐注册表）；空白名回落
/// remote-device
#[test]
fn pair_hello_truncates_label_and_defaults_blank() {
    let (state, coordinator) = test_state();
    let code = activate(&coordinator);
    let long_name = "长".repeat(100);
    let body = serde_json::json!({
        "code": code,
        "deviceId": "dev-2",
        "deviceName": long_name,
        "mobilePub": "pub-2",
        "mobileLongPub": "long-pub-2",
    });
    let (_, label, _) = handle_pair_hello(&body, state.pairing().as_deref(), now_ms())
        .expect("合法 hello 必须成功");
    assert_eq!(label.chars().count(), 64, "设备名必须截断到 64 字符");
    // 空白名 → remote-device（码一次性：重新激活拿新码）
    let code = activate(&coordinator);
    let body = serde_json::json!({
        "code": code,
        "deviceId": "dev-2",
        "deviceName": "   ",
        "mobilePub": "pub-2",
        "mobileLongPub": "long-pub-2",
    });
    let (_, label, _) = handle_pair_hello(&body, state.pairing().as_deref(), now_ms())
        .expect("合法 hello 必须成功");
    assert_eq!(label, "remote-device");
}

/// pair.hello 载荷非法 → Err(CmdInvalid)；协调器未装配 → Err(Internal)
#[test]
fn pair_hello_invalid_payload_and_unwired_coordinator() {
    let err = handle_pair_hello(&serde_json::json!({ "deviceName": "x" }), None, now_ms())
        .expect_err("协调器未装配必须 Err(Internal)");
    assert_eq!(err.0, DeviceErrorCode::Internal);
    // 载荷缺 code → CmdInvalid
    let (state, coordinator) = test_state();
    activate(&coordinator);
    let err = handle_pair_hello(
        &serde_json::json!({ "deviceId": "dev-3", "deviceName": "x" }),
        state.pairing().as_deref(),
        now_ms(),
    )
    .expect_err("缺 code 载荷必须 Err(CmdInvalid)");
    assert_eq!(err.0, DeviceErrorCode::CmdInvalid);
}

/// pair.ok / device.ready 载荷形状（D3 §4.8：desktopId/ttl + token 扩展；
/// deviceId）
#[test]
fn pair_ok_and_device_ready_body_shapes() {
    let ok = pair_ok_body(DESKTOP_ID, "t".repeat(64).as_str());
    assert_eq!(ok["desktopId"], DESKTOP_ID);
    assert_eq!(ok["ttl"], PAIR_TTL_SECONDS);
    assert_eq!(ok["token"], "t".repeat(64));
    let ready = device_ready_body("dev-9");
    assert_eq!(ready["deviceId"], "dev-9");
}

/// WS 升级放行判定：协调器未装配 / 无活跃码 → false；有活跃码 → true
#[test]
fn pair_upgrade_allowed_reflects_active_code() {
    let (state, coordinator) = test_state();
    // 未激活 → false（保持 401 拒绝语义）
    assert!(!pair_upgrade_allowed(&state));
    // 激活 → true（配对期例外，D3 §5.2）
    activate(&coordinator);
    assert!(pair_upgrade_allowed(&state));
    // 协调器未装配 → false
    let state = ServerState::new(
        &ServerHandle::new(
            {
                let mut config = ServerConfig::new(std::env::temp_dir());
                config.multi_device_enabled = true;
                config
            },
            "127.0.0.1:0".parse().expect("固定测试地址"),
        ),
        TokenStore::new(std::env::temp_dir().join("pairing-endpoint-upgrade.json")),
        None,
    );
    assert!(!pair_upgrade_allowed(&state));
}
