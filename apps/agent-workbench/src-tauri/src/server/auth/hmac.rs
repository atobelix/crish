//! HMAC-SHA256 计算 / 校验与签名规范化输入（自 server/auth.rs 原样搬迁）

/// HMAC-SHA256 计算（使用 ring::hmac）
#[allow(dead_code)]
pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let s_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let tag = ring::hmac::sign(&s_key, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(tag.as_ref());
    out
}

/// HMAC-SHA256 hex 计算（小写 hex 64 字符）
#[allow(dead_code)]
pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    hex::encode(hmac_sha256(key, data))
}

/// 常量时间校验 HMAC-SHA256 签名（防时序攻击，支持 hex 与 base64）
pub fn verify_hmac_sha256(key: &[u8], data: &[u8], signature: &str) -> bool {
    let s_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, key);
    let sig_bytes = if let Ok(b) = hex::decode(signature) {
        b
    } else {
        use base64::Engine;
        if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(signature) {
            b
        } else {
            return false;
        }
    };
    ring::hmac::verify(&s_key, data, &sig_bytes).is_ok()
}

/// HTTP REST 请求签名规范化输入（ADR-01 方案 B）：
/// `canon_http = deviceId || method || path || ts || nonce || body_sha256_hex`
pub fn canonical_http_signing_payload(
    device_id: &str,
    method: &str,
    path: &str,
    ts: u64,
    nonce: &str,
    body_sha256_hex: &str,
) -> String {
    format!("{device_id}{method}{path}{ts}{nonce}{body_sha256_hex}")
}

/// WebSocket 信封签名规范化输入（ADR-01 方案 B）：
/// `canon_ws = deviceId || ts || nonce || msgId || kind || v || bodyJson`
pub fn canonical_ws_signing_payload(
    device_id: &str,
    ts: u64,
    nonce: &str,
    msg_id: &str,
    kind: &str,
    v: u32,
    body_json: &str,
) -> String {
    format!("{device_id}{ts}{nonce}{msg_id}{kind}{v}{body_json}")
}
