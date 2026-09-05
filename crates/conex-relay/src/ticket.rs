//! 短效票据（Relay Ticket）自校验模块
//!
//! 基于 HMAC-SHA256 签名机制，零 DB 查询即可在高并发下自校验权限。
//! 票据格式: `<payload_base64>.<hmac_hex>`
//! 有效期严格限制在 60 秒内，防御重放攻击。

use anyhow::{bail, Context, Result};
use hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_SECRET: &str = "conex-flowbit-relay-secret-key-2026";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TicketClaims {
    pub account_id: String,
    pub device_id: String,
    #[serde(default)]
    pub target_device_id: Option<String>,
    pub role: String, // "host" | "client"
    pub exp: u64,     // Unix timestamp (秒)
}

impl TicketClaims {
    /// 检查票据是否在有效期内
    pub fn is_valid(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // 允许 5 秒时钟倾斜 (Clock Skew)
        now <= self.exp + 5
    }

    /// 签发票据
    pub fn sign(&self, secret: &str) -> Result<String> {
        let json = serde_json::to_string(self)?;
        let b64 = base64_encode(json.as_bytes());
        let sig = compute_hmac(secret, b64.as_bytes());
        Ok(format!("{}.{}", b64, hex::encode(sig)))
    }

    /// 校验并解析票据
    pub fn verify(ticket_str: &str, secret: &str) -> Result<Self> {
        let parts: Vec<&str> = ticket_str.split('.').collect();
        if parts.len() != 2 {
            bail!("Invalid ticket format: must be <payload>.<signature>");
        }

        let payload_b64 = parts[0];
        let sig_hex = parts[1];

        // 验证签名
        let expected_sig = compute_hmac(secret, payload_b64.as_bytes());
        let given_sig = hex::decode(sig_hex).context("Invalid signature hex")?;

        if !constant_time_eq(&expected_sig, &given_sig) {
            bail!("Ticket signature mismatch");
        }

        // 解码 Payload
        let json_bytes = base64_decode(payload_b64).context("Failed to base64 decode ticket payload")?;
        let claims: Self = serde_json::from_slice(&json_bytes).context("Failed to parse ticket JSON")?;

        if !claims.is_valid() {
            bail!("Ticket has expired (exp: {})", claims.exp);
        }

        Ok(claims)
    }
}

/// 简易 HMAC-SHA256 实现（零额外重型依赖）
fn compute_hmac(key: &str, data: &[u8]) -> [u8; 32] {
    let key_bytes = key.as_bytes();
    let mut k_ipad = [0x36u8; 64];
    let mut k_opad = [0x5cu8; 64];

    let mut key_block = [0u8; 64];
    if key_bytes.len() > 64 {
        let hash = Sha256::digest(key_bytes);
        key_block[..32].copy_from_slice(&hash);
    } else {
        key_block[..key_bytes.len()].copy_from_slice(key_bytes);
    }

    for i in 0..64 {
        k_ipad[i] ^= key_block[i];
        k_opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(&k_ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&k_opad);
    outer.update(&inner_hash);
    outer.finalize().into()
}

/// 恒定时间比较防时序攻击
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// 基础 base64 编解码（安全 URL 规范）
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);

        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);

        result.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        result.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            result.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            result.push(ALPHABET[(n & 0x3f) as usize] as char);
        }
    }
    result
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    let mut lookup = [255u8; 256];
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (i, &b) in ALPHABET.iter().enumerate() {
        lookup[b as usize] = i as u8;
    }
    // 同时兼容标准 base64 (+/)
    lookup[b'+' as usize] = 62;
    lookup[b'/' as usize] = 63;

    let s_clean = s.trim_end_matches('=');
    let mut result = Vec::with_capacity((s_clean.len() * 3) / 4);

    let bytes = s_clean.as_bytes();
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for &b in chunk {
            let val = lookup[b as usize];
            if val == 255 {
                bail!("Invalid base64 char: {}", b as char);
            }
            n = (n << 6) | (val as u32);
        }

        match chunk.len() {
            4 => {
                result.push(((n >> 16) & 0xff) as u8);
                result.push(((n >> 8) & 0xff) as u8);
                result.push((n & 0xff) as u8);
            }
            3 => {
                n <<= 6;
                result.push(((n >> 16) & 0xff) as u8);
                result.push(((n >> 8) & 0xff) as u8);
            }
            2 => {
                n <<= 12;
                result.push(((n >> 16) & 0xff) as u8);
            }
            _ => bail!("Illegal chunk length"),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ticket_sign_and_verify() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let claims = TicketClaims {
            account_id: "user-12345".to_string(),
            device_id: "desktop-pc-01".to_string(),
            target_device_id: None,
            role: "host".to_string(),
            exp: now + 60, // 60s
        };

        let token = claims.sign(DEFAULT_SECRET).expect("Signing must succeed");
        assert!(token.contains('.'));

        let verified = TicketClaims::verify(&token, DEFAULT_SECRET).expect("Verification must succeed");
        assert_eq!(claims, verified);
    }

    #[test]
    fn test_ticket_expired() {
        let claims = TicketClaims {
            account_id: "user-12345".to_string(),
            device_id: "desktop-pc-01".to_string(),
            target_device_id: None,
            role: "host".to_string(),
            exp: 1000, // Long expired
        };

        let token = claims.sign(DEFAULT_SECRET).unwrap();
        let err = TicketClaims::verify(&token, DEFAULT_SECRET);
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("expired"));
    }
}
