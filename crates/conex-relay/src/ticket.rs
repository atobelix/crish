//! 短时票据：HMAC-SHA256 自校验，不依赖账号中心在线校验。
//!
//! 票据格式 `<base64url(payload-json)>.<hex(hmac)>`；payload 只包含
//! account/device/target/role/exp/jti，不含任何秘密。密钥只来自部署环境
//! `RELAY_SECRET`，仓库内不得存在默认密钥。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

/// 票据角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TicketRole {
    Host,
    Client,
}

impl TicketRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Client => "client",
        }
    }
}

/// 票据声明（服务端自包含校验；不包含任何用户秘密）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketClaims {
    pub account_id: String,
    pub device_id: String,
    /// host 设备展示名（在线发现用；client 票据为空）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(default)]
    pub target_device_id: Option<String>,
    pub role: TicketRole,
    pub exp: u64,
    pub iat: u64,
    /// 一次性票据 id（防重放）
    pub jti: String,
}

#[derive(Debug, Error)]
pub enum TicketError {
    #[error("ticket format invalid")]
    Format,
    #[error("ticket signature invalid")]
    Signature,
    #[error("ticket payload invalid: {0}")]
    Payload(String),
    #[error("ticket expired")]
    Expired,
    #[error("ticket not valid yet")]
    NotYetValid,
}

fn hmac(secret: &[u8], data: &[u8]) -> Vec<u8> {
    // HmacSha256 接受任意长度密钥；`new_from_slice` 的唯一错误路径是长度非法，
    // 对 HMAC 不存在该情况。用 Err 分支返回空签名会悄悄削弱校验，故仍以
    // `new_from_slice` 的 Result 显式展开为不可达分支——比 expect 更明确。
    let Ok(mut mac) = HmacSha256::new_from_slice(secret) else {
        debug_assert!(false, "HMAC 密钥长度非法（HmacSha256 不应出现此分支）");
        return Vec::new();
    };
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl TicketClaims {
    /// 签发票据（`exp` = 绝对 Unix 秒）。
    pub fn sign(&self, secret: &[u8]) -> Result<String, TicketError> {
        let payload = serde_json::to_vec(self).map_err(|e| TicketError::Payload(e.to_string()))?;
        let encoded = URL_SAFE_NO_PAD.encode(payload);
        let signature = hmac(secret, encoded.as_bytes());
        Ok(format!("{encoded}.{}", hex::encode(signature)))
    }

    /// 校验签名 / 格式 / 有效期（允许 5 秒时钟倾斜）。
    pub fn verify(ticket: &str, secret: &[u8]) -> Result<Self, TicketError> {
        let (encoded, signature_hex) = ticket.split_once('.').ok_or(TicketError::Format)?;
        let actual = hex::decode(signature_hex).map_err(|_| TicketError::Signature)?;
        let expected = hmac(secret, encoded.as_bytes());
        if actual.len() != expected.len() {
            return Err(TicketError::Signature);
        }
        let mut diff = 0u8;
        for (a, b) in actual.iter().zip(expected.iter()) {
            diff |= a ^ b;
        }
        if diff != 0 {
            return Err(TicketError::Signature);
        }
        let payload = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| TicketError::Format)?;
        let claims: Self =
            serde_json::from_slice(&payload).map_err(|e| TicketError::Payload(e.to_string()))?;
        let now = now_secs();
        if claims.exp + 5 < now {
            return Err(TicketError::Expired);
        }
        if claims.iat > now + 300 {
            return Err(TicketError::NotYetValid);
        }
        Ok(claims)
    }

    /// 构造 host 票据声明。
    pub fn host(
        account_id: impl Into<String>,
        device_id: impl Into<String>,
        device_name: Option<String>,
        ttl_secs: u64,
    ) -> Self {
        let now = now_secs();
        Self {
            account_id: account_id.into(),
            device_id: device_id.into(),
            device_name,
            target_device_id: None,
            role: TicketRole::Host,
            iat: now,
            exp: now + ttl_secs,
            jti: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// 构造 client 票据声明。
    pub fn client(
        account_id: impl Into<String>,
        device_id: impl Into<String>,
        device_name: Option<String>,
        target_device_id: impl Into<String>,
        ttl_secs: u64,
    ) -> Self {
        let now = now_secs();
        Self {
            account_id: account_id.into(),
            device_id: device_id.into(),
            device_name,
            target_device_id: Some(target_device_id.into()),
            role: TicketRole::Client,
            iat: now,
            exp: now + ttl_secs,
            jti: uuid::Uuid::new_v4().to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    #[test]
    fn roundtrip_and_expiry() {
        let claims = TicketClaims::host("acc-1", "desk-1", None, 60);
        let ticket = claims.sign(SECRET).expect("sign");
        let parsed = TicketClaims::verify(&ticket, SECRET).expect("verify");
        assert_eq!(parsed, claims);
    }

    #[test]
    fn rejects_tampered_signature() {
        let claims = TicketClaims::host("acc-1", "desk-1", None, 60);
        let mut ticket = claims.sign(SECRET).expect("sign");
        ticket.push('0');
        assert!(matches!(
            TicketClaims::verify(&ticket, SECRET),
            Err(TicketError::Signature)
        ));
    }

    #[test]
    fn rejects_expired() {
        let mut claims = TicketClaims::host("acc-1", "desk-1", None, 0);
        claims.exp = now_secs().saturating_sub(10);
        let ticket = claims.sign(SECRET).expect("sign");
        assert!(matches!(
            TicketClaims::verify(&ticket, SECRET),
            Err(TicketError::Expired)
        ));
    }

    #[test]
    fn rejects_wrong_secret() {
        let ticket = TicketClaims::host("acc-1", "desk-1", None, 60)
            .sign(SECRET)
            .expect("sign");
        assert!(matches!(
            TicketClaims::verify(&ticket, b"another-secret-0123456789abcdef"),
            Err(TicketError::Signature)
        ));
    }
}
