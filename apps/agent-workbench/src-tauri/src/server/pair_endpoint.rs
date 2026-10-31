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
///
/// `tls_fingerprint`（实现波总方案 H1）：TLS 启用时必发 CA 指纹
/// （SHA-256(SPKI) 小写 hex 64 位），移动端落 pinning 锚；None = TLS 未启用 /
/// 材料缺失，移动端 fail-closed 拒绝完成配对。
pub fn pair_ok_body(
    desktop_id: &str,
    token: &str,
    tls_fingerprint: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "desktopId": desktop_id,
        "ttl": PAIR_TTL_SECONDS,
        "token": token,
        "tlsFingerprint": tls_fingerprint,
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
mod tests;
