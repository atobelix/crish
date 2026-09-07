//! 短效票据（Relay Ticket）自校验模块（audit-repair-202609 · T15 加固）
//!
//! 基于 **HMAC-SHA256** 对称签名机制，零 DB 查询即可在高并发下自校验权限。
//! 票据格式: `<payload_base64url>.<hmac_hex>`
//! 有效期严格限制在 60 秒内，防御重放攻击。
//!
//! ## 纪律
//! - **签名密钥必须由部署方提供**（`RELAY_SECRET` 环境变量，≥32 字节），
//!   本 crate 不再提供任何默认密钥——源码即钥匙的历史默认值已删除；
//! - 算法为 HMAC-SHA256（正确性由 RFC 4231 标准向量测试钉死）。历史提交
//!   宣称的「Ed25519」与实现不符；如需签发/验签密钥分离的非对称架构，
//!   须与云端签发服务协同改造后另立战役，禁止只改一边；
//! - HMAC 实现保留手写（ipad/opad 标准结构，向量测试锁定），引入 `hmac`
//!   crate 需新增依赖获取路径，收益不抵构建脆弱性。

use anyhow::{bail, Context, Result};
use hex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

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
        let sig = compute_hmac(secret.as_bytes(), b64.as_bytes());
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
        let expected_sig = compute_hmac(secret.as_bytes(), payload_b64.as_bytes());
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

/// 简易 HMAC-SHA256 实现（零额外重型依赖；正确性由 RFC 4231 向量测试锁定）
fn compute_hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let key_bytes = key;
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

    /// 测试密钥（仅测试；生产必须经 RELAY_SECRET 提供）
    const TEST_SECRET: &str = "test-secret-0123456789abcdef01234567";

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

        let token = claims.sign(TEST_SECRET).expect("Signing must succeed");
        assert!(token.contains('.'));

        let verified = TicketClaims::verify(&token, TEST_SECRET).expect("Verification must succeed");
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

        let token = claims.sign(TEST_SECRET).unwrap();
        let err = TicketClaims::verify(&token, TEST_SECRET);
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("expired"));
    }

    /// T15：篡改 payload / 签名必须验证失败（恒定时间比较不放过时序侧信道）
    #[test]
    fn test_ticket_tamper_rejected() {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let claims = TicketClaims {
            account_id: "user-1".to_string(),
            device_id: "dev-1".to_string(),
            target_device_id: None,
            role: "client".to_string(),
            exp: now + 60,
        };
        let token = claims.sign(TEST_SECRET).unwrap();

        // 篡改签名最后一个字符
        let mut parts = token.split('.').collect::<Vec<_>>();
        let mut sig = parts[1].to_string();
        let last = sig.pop().unwrap();
        sig.push(if last == '0' { '1' } else { '0' });
        parts[1] = Box::leak(sig.into_boxed_str());
        let tampered_sig = parts.join(".");
        assert!(TicketClaims::verify(&tampered_sig, TEST_SECRET).is_err());

        // 用错误密钥签发
        let wrong_key_token = claims.sign("another-secret-0123456789abcdef0123").unwrap();
        assert!(TicketClaims::verify(&wrong_key_token, TEST_SECRET).is_err());
    }

    /// T15：RFC 4231 (HMAC-SHA256) 标准向量，锁定手写 compute_hmac 的正确性。
    /// Test Case 1 / 2 / 6 来自 RFC 4231 §4.2。
    #[test]
    fn test_hmac_rfc4231_vectors() {
        // Test Case 1: key = 0x0b 重复 20 次, data = "Hi There"
        let key = [0x0bu8; 20];
        let hmac = compute_hmac(&key, b"Hi There");
        assert_eq!(
            hex::encode(hmac),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
            "RFC 4231 Test Case 1 failed"
        );

        // Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
        let hmac = compute_hmac(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex::encode(hmac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            "RFC 4231 Test Case 2 failed"
        );

        // Test Case 6（key 超过 64 字节块：验证 hash-key 分支）
        let big_key = [0xaau8; 131];
        let hmac_big = compute_hmac(
            &big_key,
            b"Test Using Larger Than Block-Size Key - Hash Key First",
        );
        assert_eq!(
            hex::encode(hmac_big),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            "RFC 4231 Test Case 6 failed"
        );
    }
}
