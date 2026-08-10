//! 令牌类型（M7 §4 四类令牌分治语义）
//!
//! - T1 配对令牌：配对派生的 token_key/enc_key/refresh_key 三子钥（D3 §4.4
//!   HKDF 派生形态，AU1 P1-10 已裁决为唯一形态）——消息级 HMAC 即凭据；
//! - T2 账号令牌：账号中心签发的 access（15min）/ refresh（30 天轮换），
//!   形态 `zn1.{payload}.HMAC-SHA256`（AC §4.3.1），声明字段见
//!   [AccessTokenClaims]；
//! - T3 中继凭据：中继连接握手身份（`rc_<32B>`，TTL 30 天，明文只返回一次，
//!   服务端只存 HMAC——AC §6.4）；
//! - T4 推送注册：厂商通道寻址（APNs/HMS/小米等），token_hash 幂等注册。
//!
//! 本模块只提供**格式类型与校验**，不做密码学计算（密钥材料经配对协议在
//! 网关层派生，此处以 base64 字符串承载）。

use serde::{Deserialize, Serialize};

use crate::device::pair::Platform;

/// 配对派生三子钥（T1；D3 §4.4：HKDF-SHA256 从 master 一次展开）
///
/// `master = HKDF-SHA256(ikm = ecdh ∥ psk, salt = desktopId ∥ mobilePub ∥ "v1",
/// info = "conex-pair-master", L = 32)`；三子钥经独立 info 域展开，双端持同一
/// 份派生值。桌面落盘 token_key 派生结果（非 master），撤销 = 删设备表条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingTokenSet {
    /// 消息签名密钥（消息级 HMAC；base64）
    pub token_key: String,
    /// 链路加密密钥（中继 AEAD / P2P 链路密钥；base64；局域网 TLS 承载期
    /// 预派生留位）
    pub enc_key: String,
    /// 重连令牌签名密钥（一次性 refresh 派生；base64）
    pub refresh_key: String,
}

impl PairingTokenSet {
    /// 由派生值构造（网关层 HKDF 产出后填入）
    pub fn from_derived(
        token_key: impl Into<String>,
        enc_key: impl Into<String>,
        refresh_key: impl Into<String>,
    ) -> Self {
        Self {
            token_key: token_key.into(),
            enc_key: enc_key.into(),
            refresh_key: refresh_key.into(),
        }
    }
}

/// 账号令牌对（T2；access 15min / refresh 30 天单次轮换，AC §4.3.1）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountToken {
    /// access token（形态 `zn1.{payload}.HMAC-SHA256`，状态化校验）
    pub access_token: String,
    /// refresh token（单次轮换，旧 token 立即失效）
    pub refresh_token: String,
}

impl AccountToken {
    /// access token 形态校验（`zn1.` 前缀；AC §4.3.1 冻结形态）
    pub fn is_access_format(&self) -> bool {
        let mut parts = self.access_token.split('.');
        matches!(parts.next(), Some("zn1"))
            && matches!(parts.next(), Some(p) if !p.is_empty())
            && parts.next().is_some()
    }
}

/// 账号 access token 的 payload 声明字段（`zn1.{payload}.HMAC` 的 payload 段）
///
/// 云账号侧契约（AC 域）的 Rust 投影；账号 token 云端不共享、两端各自持有
/// （M7 M-05 决策）——本类型仅供桌面/移动端解析展示与调试，鉴权校验在账号
/// 中心。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessTokenClaims {
    /// 主体（账号标识）
    pub sub: String,
    /// 账号 id（一账号多设备）
    pub account_id: String,
    /// 设备 id（一设备一会话语义）
    pub device_id: String,
    /// 签发时刻（epoch 秒）
    pub issued_at: u64,
    /// 过期时刻（epoch 秒；access 15min）
    pub expires_at: u64,
}

/// 中继凭据（T3；`rc_<32B>`，TTL 30 天可刷新，明文只返回一次）
///
/// 中继服务只转发不解密（M2 §2.1）；凭据仅用于中继连接握手（verify 一次性
/// nonce），端间消息鉴权仍走设备级 HMAC——两层不混（AC §7.4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayCredential {
    /// 凭据明文（`rc_` 前缀 + 32B 随机，base64/hex 承载）
    pub credential: String,
}

impl RelayCredential {
    /// 中继凭据前缀（`rc_`）
    pub const PREFIX: &'static str = "rc_";

    /// 格式校验：`rc_` 前缀 + 32B 材料（base64 44 字符 / hex 64 字符）
    pub fn is_valid_format(&self) -> bool {
        let material = self.credential.strip_prefix(Self::PREFIX);
        matches!(material, Some(m) if (32..=64).contains(&m.len()))
    }
}

/// 推送注册（T4；厂商通道寻址，账号中心 push_tokens 表）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRegistration {
    /// 设备 id（注册表主键）
    pub device_id: String,
    /// 端平台
    pub platform: Platform,
    /// 厂商通道 token（APNs/HMS/小米/...；服务端加密存储）
    pub vendor_token: String,
    /// 应用 bundle id（iOS）/ package id（Android）
    pub bundle_id: String,
    /// vendor_token 哈希（注册幂等键；服务端按 token_hash 去重）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_token_set_roundtrip_camel_case() {
        let set = PairingTokenSet::from_derived("tk-base64", "ek-base64", "rk-base64");
        let json = serde_json::to_value(&set).unwrap();
        assert_eq!(json["tokenKey"], "tk-base64");
        assert_eq!(json["encKey"], "ek-base64");
        assert_eq!(json["refreshKey"], "rk-base64");
        let back: PairingTokenSet = serde_json::from_str(&serde_json::to_string(&set).unwrap()).unwrap();
        assert_eq!(set, back);
    }

    #[test]
    fn account_token_format_and_claims() {
        let token = AccountToken {
            access_token: "zn1.eyJwYXlsb2FkIn0.hmac".into(),
            refresh_token: "rt-001".into(),
        };
        assert!(token.is_access_format());
        let bad = AccountToken { access_token: "bearer-xyz".into(), refresh_token: "".into() };
        assert!(!bad.is_access_format());

        let claims = AccessTokenClaims {
            sub: "user-1".into(),
            account_id: "acct-1".into(),
            device_id: "dev-1".into(),
            issued_at: 1754650000,
            expires_at: 1754650900,
        };
        let json = serde_json::to_value(&claims).unwrap();
        assert_eq!(json["accountId"], "acct-1");
        assert_eq!(json["deviceId"], "dev-1");
        assert_eq!(json["issuedAt"], 1754650000);
        let back: AccessTokenClaims =
            serde_json::from_str(&serde_json::to_string(&claims).unwrap()).unwrap();
        assert_eq!(claims, back);
    }

    #[test]
    fn relay_credential_format() {
        assert!(RelayCredential { credential: "rc_abcdefghijklmnopqrstuvwxyz0123456789AB".into() }
            .is_valid_format());
        // 缺前缀
        assert!(!RelayCredential { credential: "abcdefghijklmnop".into() }.is_valid_format());
        // 材料过短
        assert!(!RelayCredential { credential: "rc_x".into() }.is_valid_format());
    }

    #[test]
    fn push_registration_roundtrip() {
        let reg = PushRegistration {
            device_id: "dev-1".into(),
            platform: Platform::Android,
            vendor_token: "hms-token".into(),
            bundle_id: "com.conex.crish".into(),
            token_hash: Some("sha256-token".into()),
        };
        let json = serde_json::to_value(&reg).unwrap();
        assert_eq!(json["deviceId"], "dev-1");
        assert_eq!(json["platform"], "android");
        assert_eq!(json["vendorToken"], "hms-token");
        assert_eq!(json["bundleId"], "com.conex.crish");
        assert_eq!(json["tokenHash"], "sha256-token");
        let back: PushRegistration =
            serde_json::from_str(&serde_json::to_string(&reg).unwrap()).unwrap();
        assert_eq!(reg, back);
    }
}
