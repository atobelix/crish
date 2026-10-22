//! Bearer 令牌与请求签名 axum 中间件（自 server/auth.rs 原样搬迁）

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use conex_types::device::{DeviceErrorCode, ErrorBody};
use sha2::{Digest, Sha256};

use super::hmac::{canonical_http_signing_payload, verify_hmac_sha256};
use super::nonce::NonceCheckResult;
use super::token::TokenVerdict;
use super::SERVER_TIME_HEADER;
use crate::server::{now_ms, ServerState};

/// Bearer 令牌校验中间件（D2 §7.1 零信任：除 /v1/info 与 /v1/pair 外全部
/// 接口必须携带有效令牌；校验失败 → 401 + ErrorBody 载荷；全部响应透传 X-Server-Time-Ms）
pub async fn require_bearer_token(
    State(state): State<ServerState>,
    request: Request,
    next: Next,
) -> Response {
    let now = now_ms();
    let unauthorized = |code: DeviceErrorCode, message: &str| -> Response {
        let mut resp = (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody::new(code, message)),
        )
            .into_response();
        if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
            resp.headers_mut().insert(SERVER_TIME_HEADER, val);
        }
        resp
    };
    let Some(token) = bearer_token(&request) else {
        return unauthorized(
            DeviceErrorCode::AuthBadSignature,
            "缺少 Authorization: Bearer <token>",
        );
    };
    let verdict = {
        let tokens = state.tokens();
        let mut guard = tokens.lock().unwrap_or_else(|e| e.into_inner());
        let verdict = guard.verify(token, now);
        if verdict != TokenVerdict::Valid {
            // R1-10 T-01：认证失败计数（伪造端/失窃令牌重放均计入；
            // 纯计数不联动锁定——锁定/审计归 limiter 域）
            guard.record_failed_attempt(token);
        }
        verdict
    };
    let mut response = match verdict {
        TokenVerdict::Valid => next.run(request).await,
        TokenVerdict::Revoked => unauthorized(
            DeviceErrorCode::AuthDeviceRevoked,
            "令牌已被撤销，请重新配对",
        ),
        TokenVerdict::Invalid => unauthorized(DeviceErrorCode::AuthBadSignature, "令牌校验失败"),
    };
    if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
        response.headers_mut().insert(SERVER_TIME_HEADER, val);
    }
    response
}

/// 从请求头解析 Bearer 令牌（`Authorization: Bearer <token>`）
fn bearer_token(request: &Request) -> Option<&str> {
    request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// 敏感 REST 控制端点请求签名与 Nonce 校验中间件（GW-01 / GW-03）
pub async fn require_signed_request(
    State(state): State<ServerState>,
    request: Request,
    next: Next,
) -> Response {
    let now = now_ms();
    let unauthorized = |code: DeviceErrorCode, message: &str| -> Response {
        let mut resp = (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody::new(code, message)),
        )
            .into_response();
        if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
            resp.headers_mut().insert(SERVER_TIME_HEADER, val);
        }
        resp
    };

    // 如果携带了签名头，进行防重放与 HMAC 签名验证
    let (maybe_sig, maybe_nonce, maybe_ts, maybe_device_id) = {
        let headers = request.headers();
        let sig = headers
            .get("X-Signature")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let nonce = headers
            .get("X-Nonce")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let ts = headers
            .get("X-Timestamp")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let device_id = headers
            .get("X-Device-Id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        (sig, nonce, ts, device_id)
    };

    if let (Some(sig), Some(nonce), Some(ts), Some(device_id)) =
        (maybe_sig, maybe_nonce, maybe_ts, maybe_device_id)
    {
        // 1. 时钟偏差校验
        let diff = ts.abs_diff(now);
        let max_skew = state.nonce_guard().clock_skew_ms();
        if diff > max_skew {
            return unauthorized(
                DeviceErrorCode::AuthExpired,
                &format!("签名时戳过期，偏差 {diff} ms 超过阈值 {max_skew} ms"),
            );
        }

        // 2. Nonce 幂等与重放防护
        let (parts, body) = request.into_parts();
        let bytes = match axum::body::to_bytes(body, 1024 * 1024).await {
            Ok(b) => b,
            Err(_) => {
                return unauthorized(DeviceErrorCode::CmdInvalid, "读取请求体失败");
            }
        };
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let body_sha256: [u8; 32] = hasher.finalize().into();
        let body_sha256_hex = hex::encode(body_sha256);

        let check = state
            .nonce_guard()
            .check_and_record(&device_id, &nonce, ts, now, body_sha256);
        match check {
            NonceCheckResult::Valid => {}
            NonceCheckResult::IdempotentRetry {
                status,
                body: cached_body,
            } => {
                let mut resp = (
                    StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
                    cached_body,
                )
                    .into_response();
                if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
                    resp.headers_mut().insert(SERVER_TIME_HEADER, val);
                }
                return resp;
            }
            NonceCheckResult::ReplayDetected => {
                return unauthorized(
                    DeviceErrorCode::AuthStale,
                    "检测到 Nonce 重放或参数篡改（replay_detected）",
                );
            }
            NonceCheckResult::ClockSkewTooLarge {
                diff_ms,
                max_skew_ms,
            } => {
                return unauthorized(
                    DeviceErrorCode::AuthExpired,
                    &format!("时钟偏差过大：{diff_ms} ms > {max_skew_ms} ms"),
                );
            }
        }

        // 3. 签名验证
        let canon = canonical_http_signing_payload(
            &device_id,
            parts.method.as_str(),
            parts.uri.path(),
            ts,
            &nonce,
            &body_sha256_hex,
        );

        let token_opt = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim);

        if let Some(token) = token_opt {
            if !verify_hmac_sha256(token.as_bytes(), canon.as_bytes(), &sig) {
                return unauthorized(DeviceErrorCode::AuthBadSignature, "HMAC 签名校验失败");
            }
        }

        // 重构 Request 放行
        let req = Request::from_parts(parts, axum::body::Body::from(bytes));
        let mut response = next.run(req).await;
        if let Ok(val) = axum::http::HeaderValue::from_str(&now.to_string()) {
            response.headers_mut().insert(SERVER_TIME_HEADER, val);
        }
        response
    } else {
        next.run(request).await
    }
}
