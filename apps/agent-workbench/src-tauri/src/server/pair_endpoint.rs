//! 配对入口（R1-11 验收缺口 G-2）：REST POST /v1/pair + WS pair.hello 消息链
//!
//! - **REST `POST /v1/pair`**（D2 §8.2 路由表：`{code}→{token}`）：接收
//!   `{ code, label? }` → 走 [PairingCoordinator::complete_pairing]（与命令面
//!   同一 verify 逻辑，R1-07）→ 成功返回 `{ token, label? }`（令牌仅此一次
//!   明文返回）；失败按设备错误码映射 401（码无效/过期/已用/销毁）/
//!   409（pair.too_many_attempts 锁定，对齐 R1-10 T-05 Destroyed/锁定语义）；
//!   多端服务开关关闭 → 503（服务未开启，D5 D-01 红线 1 路由层镜像）。
//!   端点挂在免鉴权面（router.rs）：配对端点无令牌可入——否则「先有令牌
//!   才能拿令牌」，与 WS 配对升级同理。
//! - **每源 IP 限速**（R1 收口 / AU4 问题 #1：D2 §12.4「/v1/pair 按连接源
//!   IP 限速（10 次/分钟）」）：handler 经 `ConnectInfo<SocketAddr>` 提取
//!   源 IP（serve 侧 `into_make_service_with_connect_info` 注入，见
//!   [crate::server::ServerInstance::serve]），在服务开关检查之后、body
//!   解析之前查 [crate::server::limiter::PairRateLimiter]——窗口内全部
//!   请求计数（成功与失败统一计，防爆破），超限 429 + cmd.too_many_requests
//!   （error.rs 既有 429 映射）+ 审计计数；关闭态 503 不消耗额度。
//! - **WS `pair.hello`**（D3 §4.8 消息名/字段对齐；简化链）：本实现按任务书
//!   「或直接 verify/ok」授权采用 hello → ok 直接完成——D3 的
//!   challenge/verify 密钥交换链依赖 X25519+HKDF（R1-07 未实现，mock-daemon
//!   亦不验签仅要求非空），PairingCoordinator 只读约束下无法做「只验不消耗」
//!   的中间态；成功回 `pair.ok`（D3 PairOk 字段 desktopId/ttl + token 扩展，
//!   见 [pair_ok_body]）+ `device.ready`（D3 §4.8 step 6）；失败回 error 帧
//!   （D3 §6.2 设备错误码）。帧编解码复用 conex-types DeviceEnvelope。
//!
//! 注：`desktopId` 本实现用固定字面量（真实桌面设备标识属 R2 设备注册表
//! 范畴，mock 同样用占位 `desktop-mock-0001`）；`pair.ok` 的 `token` 字段为
//! 协议注册表（device-protocol.json PairOk）之外的扩展——TS 生成解析器与
//! Rust serde 对未知字段均宽松，不破坏 R0-05 对拍。

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use conex_types::device::{DeviceErrorCode, ErrorBody, PairHello};

use super::{limiter::PairRateOutcome, now_ms, pairing::PairingCoordinator, ServerState};

/// 固定桌面标识占位（R2 设备注册表接入前；mock 同款占位哲学）
pub const DESKTOP_ID: &str = "crish-desktop";
/// 会话令牌建议轮换周期（秒；D3 §4.8 pair.ok ttl，默认 86400）
pub const PAIR_TTL_SECONDS: u64 = 86400;

/// REST POST /v1/pair 成功响应（令牌仅此一次明文返回）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairTokenResponse {
    /// 64 hex 设备令牌（仅本响应返回一次；此后只存 SHA-256 哈希）
    pub token: String,
    /// 设备名回显（未提供 → 省略）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// REST POST /v1/pair handler（router.rs 免鉴权面挂载）
///
/// body = `{ code, label? }`；服务开关关闭 / 协调器未装配 → 503（不消耗
/// 限速额度）；每源 IP 超限 → 429（cmd.too_many_requests，error.rs 既有
/// 429 映射；拒绝不计数，防拒绝路径被刷爆窗口）；配对码校验失败 → 401
/// （锁定 → 409）；成功 → 200 { token, label? }。
pub async fn handle_rest_pair(
    State(state): State<ServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response {
    // 服务开关（D5 D-01 红线 1 路由层镜像：enabled=false → 服务未开启，
    // 生产装配面此时根本不 bind；本检查兜住路由层直测与异常装配）——
    // 关闭态不消耗限速额度
    if !state.multi_device_enabled() {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::CmdDenied,
            "多端服务未开启（multi_device.enabled=false）",
        );
    }
    let Some(pairing) = state.pairing() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            DeviceErrorCode::Internal,
            "配对协调器未装配",
        );
    };
    // 每源 IP 限速（R1 收口 / AU4 问题 #1：D2 §12.4「10 次/分钟」）：
    // 位置在服务开关检查之后（关闭态不消耗额度）、body 解析之前（防
    // 解析/配对逻辑被爆破刷量）——窗口内全部请求计数（成功与失败统一
    // 计）；超限 → 429 + 审计计数（PairRateLimiter 内部），拒绝不计数。
    // 错误码走 error.rs 既有 `CmdTooManyRequests => 429` 映射
    // （error.rs:131），与其余 REST 错误同 ErrorBody 出网。
    if let PairRateOutcome::Rejected { limit, current } =
        state.pair_limiter().check_and_count(addr.ip(), now_ms())
    {
        return error_response(
            StatusCode::TOO_MANY_REQUESTS,
            DeviceErrorCode::CmdTooManyRequests,
            format!("配对请求过于频繁：每源 IP 每分钟最多 {limit} 次（当前窗口已 {current} 次）"),
        );
    }
    // body 解析（对齐 router.rs 手写解析风格：非法 JSON → cmd.invalid 400）
    let bytes = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                DeviceErrorCode::CmdInvalid,
                format!("读取请求体失败：{e}"),
            );
        }
    };
    let payload: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(e) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                DeviceErrorCode::CmdInvalid,
                format!("请求体 JSON 非法：{e}"),
            )
        }
    };
    let Some(code) = payload.get("code").and_then(serde_json::Value::as_str) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            DeviceErrorCode::CmdInvalid,
            "缺少 code 字段（配对码）",
        );
    };
    let label = payload
        .get("label")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or("remote-device");
    match pairing.complete_pairing(code, label, now_ms()) {
        Ok(token) => {
            // 新令牌落盘后重载路由层令牌库（协调器 store 与本路由 store
            // 各自独立——R1-07 装配断裂收口：令牌立即可用于后续请求）
            state.reload_tokens();
            Json(PairTokenResponse {
                token,
                label: payload
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string),
            })
            .into_response()
        }
        Err(err) => {
            // 失败状态映射（任务书：401/409）：锁定 → 409（R1-10 T-05
            // too_many_attempts 语义）；其余配对失败 → 401（码即凭据）
            let (status, code) = match err.device_code() {
                DeviceErrorCode::PairTooManyAttempts => {
                    (StatusCode::CONFLICT, DeviceErrorCode::PairTooManyAttempts)
                }
                DeviceErrorCode::PairInvalidCode
                | DeviceErrorCode::PairExpired
                | DeviceErrorCode::PairUsed
                | DeviceErrorCode::PairChallengeMismatch
                | DeviceErrorCode::PairNoChallenge
                | DeviceErrorCode::PairRegistryFull => {
                    (StatusCode::UNAUTHORIZED, err.device_code())
                }
                other => (StatusCode::INTERNAL_SERVER_ERROR, other),
            };
            error_response(status, code, err.error_body().message)
        }
    }
}

/// WS pair.hello 处理（简化链：hello 直接完成配对——任务书「或直接
/// verify/ok」授权；消息名/字段按 D3 §4.8 PairHello）
///
/// 返回 `Ok((token, label, device_id))` = 配对成功（调用方发 pair.ok +
/// device.ready 并将连接转入已认证）；`Err((code, message))` = 失败
/// （调用方发 error 帧，D3 §6.2 设备错误码）。
pub fn handle_pair_hello(
    body: &serde_json::Value,
    pairing: Option<&PairingCoordinator>,
    now: u64,
) -> Result<(String, String, String), (DeviceErrorCode, String)> {
    let Some(coordinator) = pairing else {
        return Err((DeviceErrorCode::Internal, "配对协调器未装配".to_string()));
    };
    let hello: PairHello = serde_json::from_value(body.clone()).map_err(|e| {
        (
            DeviceErrorCode::CmdInvalid,
            format!("pair.hello 载荷非法：{e}"),
        )
    })?;
    // 设备名防御截断（PairHello 类型 serde 层不约束长度；≤64 对齐注册表）
    let label: String = hello.device_name.chars().take(64).collect();
    let label = if label.trim().is_empty() {
        "remote-device".to_string()
    } else {
        label
    };
    let device_id = hello.device_id.clone();
    coordinator
        .complete_pairing(hello.code.as_str(), &label, now)
        .map(|token| (token, label, device_id))
        .map_err(|e| (e.device_code(), e.error_body().message))
}

/// pair.ok 载荷（D3 PairOk {desktopId, ttl} + token 明文扩展——本实现令牌 =
/// TokenStore 明文 64-hex（R1-07 既定），任务书要求 ok 含 token 明文；
/// 注册表 schema 未改（两端解析器对未知字段宽松，对拍不受影响））
pub fn pair_ok_body(desktop_id: &str, token: &str) -> serde_json::Value {
    serde_json::json!({
        "desktopId": desktop_id,
        "ttl": PAIR_TTL_SECONDS,
        "token": token,
    })
}

/// device.ready 载荷（D3 §4.8 step 6）
pub fn device_ready_body(device_id: &str) -> serde_json::Value {
    serde_json::json!({ "deviceId": device_id })
}

/// WS 配对升级放行判定：协调器已装配且存在活跃配对码（等待输入）时才允许
/// 无令牌连接升级进入配对态（D5 零信任的配对期例外，D3 §5.2「配对期帧
/// 无 auth」）——无配对活动时保持既有 401 拒绝语义。
pub fn pair_upgrade_allowed(state: &ServerState) -> bool {
    state
        .pairing()
        .as_deref()
        .is_some_and(|coordinator| coordinator.status(now_ms()).code_remaining_ms.is_some())
}

/// 统一错误响应（HTTP 状态 + ErrorBody JSON；配对入口专用——REST 侧
/// pair.* 映射 401/409 与 server/error.rs 既有 403 语义不同，任务书为准）
fn error_response(
    status: StatusCode,
    code: DeviceErrorCode,
    message: impl Into<String>,
) -> Response {
    (status, Json(ErrorBody::new(code, message))).into_response()
}

#[cfg(test)]
mod tests {
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
    async fn call_handler(
        state: &ServerState,
        addr: SocketAddr,
        body: serde_json::Value,
    ) -> Response {
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
        let (token, label, device_id) =
            handle_pair_hello(&body, state.pairing().as_deref(), now_ms())
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
}
