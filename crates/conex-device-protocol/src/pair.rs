//! 配对消息类型（pair.* + device.* 生命周期；D3 §4 / M6 §10.3）
//!
//! - `pair.hello / pair.challenge / pair.verify / pair.ok`：配对状态机四消息
//!   （D3 §4.8 时序），字段按 M6 §10.3 JSON Schema 映射；
//! - `device.ready / device.unlink / device.revoked / device.audit`：配对
//!   完成后的设备生命周期消息（revoked 复用 [DeviceUnlink] 载荷）；
//! - [PairCode]：CXN-XXXX-XXXX-XXXX 配对码（D3 §4.1 唯一真源：12 有效字符、
//!   60bit 熵、10min 有效期、一次性；输入标准化忽略前缀/分隔符/大小写）。
//!
//! 注：D3 §4.1 给出的有效字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（32 字符，
//! 去 0/O/1/I/L 混淆集）；M6 §10.3 的 regex 字符集与之有一字符差异（L），
//! 由 R0-05 注册表对拍统一——本实现以 D3 显式字符集为准。

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 配对码有效字符集（D3 §4.1：去 0/O/1/I/L 的 base32 子集，32 字符）
pub const PAIR_CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// 配对码有效字符数（12 × 2^5 = 60bit 熵）
pub const PAIR_CODE_LENGTH: usize = 12;
/// 人读前缀（仅展示用；输入时忽略）
pub const PAIR_CODE_PREFIX: &str = "CXN-";
/// 分组分隔符（仅展示用；输入时忽略）
pub const PAIR_CODE_SEPARATOR: char = '-';

/// 配对码标准化错误
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum PairCodeError {
    /// 长度或结构非法（标准化后必须恰为 12 位）
    #[error("配对码必须为 12 位有效字符（可带 CXN- 前缀与分组分隔符）")]
    InvalidLength,
    /// 含有效字符集之外的字符
    #[error("配对码含非法字符：{0}")]
    InvalidChar(char),
}

/// 已标准化的配对码（CXN-XXXX-XXXX-XXXX 的 `XXXX...` 12 字符形态）
///
/// 序列化为纯字符串（无前缀无分隔符）；反序列化自动走 [PairCode::normalize]
/// 标准化（传输容错：大小写/分隔符/前缀均可忽略）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairCode(String);

impl PairCode {
    /// 标准化配对码：去 `CXN-` 前缀 → 去分组分隔符与空白 → 大写 → 校验
    ///
    /// 与 `normalize_pair_code()`（D3 §4.1）语义一致；扫码与手动输入走同一
    /// 入口。失败返回 [PairCodeError]（对应跨端错误码 `pair.invalid_code`）。
    ///
    /// 前缀剥离规则：去分隔符后若剩余长度 > 12 且以 `CXN` 起头才剥离前缀
    /// （裸 12 位码以 CXN 起头属正常码，不得误剥）。
    pub fn normalize(input: &str) -> Result<Self, PairCodeError> {
        let cleaned: String = input
            .chars()
            .filter(|c| !c.is_whitespace() && *c != PAIR_CODE_SEPARATOR)
            .collect::<String>()
            .to_uppercase();
        // 前缀剥离：去分隔符后若长度 > 12 且以 CXN 起头才剥（裸 12 位码
        // 以 CXN 起头属正常码，不得误剥）
        let body: &str = if cleaned.len() > PAIR_CODE_LENGTH && cleaned.starts_with("CXN") {
            &cleaned[3..]
        } else {
            &cleaned
        };
        if body.len() != PAIR_CODE_LENGTH {
            return Err(PairCodeError::InvalidLength);
        }
        for c in body.chars() {
            if !PAIR_CODE_ALPHABET.contains(c) {
                return Err(PairCodeError::InvalidChar(c));
            }
        }
        Ok(Self(body.to_string()))
    }

    /// 原始输入直接判定（未标准化也按容错规则校验）
    pub fn is_valid(input: &str) -> bool {
        Self::normalize(input).is_ok()
    }

    /// 标准化后的 12 字符码（大写字母 + 数字）
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 人读回显形态（带前缀与分组分隔符）
    pub fn display(&self) -> String {
        let c = self.as_str();
        format!(
            "{}{}-{}-{}",
            PAIR_CODE_PREFIX,
            &c[0..4],
            &c[4..8],
            &c[8..12]
        )
    }
}

impl Serialize for PairCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PairCode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::normalize(&raw).map_err(serde::de::Error::custom)
    }
}

/// 端平台（wire lowercase；PairHello / Hello / 推送注册共用）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// iOS
    Ios,
    /// Android
    Android,
    /// 其他（鸿蒙/桌面等）
    Other,
}

/// 配对请求（pair.hello，M→D；M6 §10.3 PairHello）
///
/// 码 + 移动一次性公钥 + 移动长期公钥（设备身份）+ 设备标识。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairHello {
    /// 配对码（输入容错标准化）
    pub code: PairCode,
    /// 移动端生成的设备 id（8-64 字符）
    pub device_id: String,
    /// X25519 一次性公钥（base64，仅本次配对）
    pub mobile_pub: String,
    /// 移动长期公钥（base64，设备身份，撤销后更换）
    pub mobile_long_pub: String,
    /// 设备名（≤64 字符）
    pub device_name: String,
    /// 端平台（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<Platform>,
}

/// 配对挑战（pair.challenge，D→M；桌面公钥 + 证书指纹带外传递）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairChallenge {
    /// 32B 随机挑战（base64）
    pub challenge: String,
    /// 桌面 X25519 长期公钥（base64）
    pub desktop_pub: String,
    /// 桌面自身标识（防多桌面混淆）
    pub desktop_id: String,
    /// 桌面自签证书 SHA-256 指纹（64 hex；TLS 钉扎只信该指纹）
    pub tls_fingerprint: String,
}

/// 配对验证（pair.verify，M→D）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairVerify {
    /// `HMAC(token_key, "pair-verify" ∥ challenge)`（base64）
    pub challenge_sig: String,
    /// 用移动私钥对 `(desktopId ∥ mobileLongPub)` 的签名（base64；
    /// 绑定「本次配对公钥 = 以后设备凭据公钥」，防配对中公钥替换）
    pub device_pub_sig: String,
}

/// 配对成功（pair.ok，D→M）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairOk {
    /// 桌面自身标识
    pub desktop_id: String,
    /// 会话令牌建议轮换周期（秒，默认 86400）
    pub ttl: u64,
}

/// 设备可正常会话（device.ready，D→M；配对完成后由桌面广播）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceReady {
    /// 设备 id
    pub device_id: String,
}

/// 设备解除/撤销（device.unlink M→D / device.revoked D→M 共用载荷）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUnlink {
    /// 设备 id（本设备令牌立即失效）
    pub device_id: String,
}

/// 设备域审计事件类别（wire lowercase；不进 41 变体 agent 事件流）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairAuditEvent {
    /// 配对成功
    Paired,
    /// 解除配对
    Unlinked,
    /// 被撤销
    Revoked,
    /// 配对失败（尝试/超限/签名失败等）
    Failed,
}

/// 设备域审计（device.audit，D→M；配对/撤销/失败留痕）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairAudit {
    /// 审计事件类别
    pub event: PairAuditEvent,
    /// 事件时刻（epoch ms）
    pub ts: u64,
    /// 关联设备 id（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// 原因（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_code_normalize_variants() {
        // 大小写 / 前缀 / 分隔符 / 空白全部容错
        let cases = [
            "CXN-7K4P-Q2MB-9XRT",
            "cxn-7k4p-q2mb-9xrt",
            "7K4P-Q2MB-9XRT",
            "7K4PQ2MB9XRT",
            " cxn-7k4p-q2mb-9xrt ",
        ];
        for raw in cases {
            let code = PairCode::normalize(raw).unwrap();
            assert_eq!(code.as_str(), "7K4PQ2MB9XRT");
            assert_eq!(code.display(), "CXN-7K4P-Q2MB-9XRT");
        }
    }

    #[test]
    fn pair_code_rejects_invalid() {
        // 长度错误（13 位）
        assert!(matches!(
            PairCode::normalize("7K4PQ2MB9XRTE"),
            Err(PairCodeError::InvalidLength)
        ));
        // 含 1/0/I/L/O 混淆字符
        assert!(matches!(
            PairCode::normalize("7K4PQ2MB9XR0"),
            Err(PairCodeError::InvalidChar(_))
        ));
        assert!(matches!(
            PairCode::normalize("CXN-7K4P-Q2MB-9XLO"),
            Err(PairCodeError::InvalidChar(_))
        ));
        // 短码
        assert!(PairCode::normalize("SHORT12").is_err());
        assert!(!PairCode::is_valid("not-a-code"));
        assert!(PairCode::is_valid("CXN-7K4P-Q2MB-9XRT"));
    }

    #[test]
    fn pair_code_serde_roundtrip_normalizes() {
        // 反序列化容错：格式化输入 → 标准化
        let code: PairCode = serde_json::from_str("\"cxn-7k4p-q2mb-9xrt\"").unwrap();
        assert_eq!(code.as_str(), "7K4PQ2MB9XRT");
        // 序列化为纯 12 字符
        let json = serde_json::to_string(&code).unwrap();
        assert_eq!(json, "\"7K4PQ2MB9XRT\"");
        // 非法输入反序列化报错
        assert!(serde_json::from_str::<PairCode>("\"bad!\"").is_err());
    }

    #[test]
    fn pair_hello_roundtrip_camel_case() {
        let hello = PairHello {
            code: PairCode::normalize("CXN-7K4P-Q2MB-9XRT").unwrap(),
            device_id: "dev-mobile-0f3a".into(),
            mobile_pub: "mPB64Base64==".into(),
            mobile_long_pub: "mLPB64Base64==".into(),
            device_name: "我的 iPhone".into(),
            platform: Some(Platform::Ios),
        };
        let json = serde_json::to_value(&hello).unwrap();
        assert_eq!(json["code"], "7K4PQ2MB9XRT");
        assert_eq!(json["deviceId"], "dev-mobile-0f3a");
        assert_eq!(json["mobilePub"], "mPB64Base64==");
        assert_eq!(json["mobileLongPub"], "mLPB64Base64==");
        assert_eq!(json["deviceName"], "我的 iPhone");
        assert_eq!(json["platform"], "ios");

        let back: PairHello =
            serde_json::from_str(&serde_json::to_string(&hello).unwrap()).unwrap();
        assert_eq!(hello, back);

        // 无 platform → 反序列化为 None
        let minimal = r#"{"code":"CXN-7K4P-Q2MB-9XRT","deviceId":"d1","mobilePub":"m","mobileLongPub":"l","deviceName":"n"}"#;
        let parsed: PairHello = serde_json::from_str(minimal).unwrap();
        assert_eq!(parsed.platform, None);
    }

    #[test]
    fn pair_messages_roundtrip() {
        let challenge = PairChallenge {
            challenge: "c1".into(),
            desktop_pub: "dPB64".into(),
            desktop_id: "d-01HZ".into(),
            tls_fingerprint: "a1b2c3".into(),
        };
        let json = serde_json::to_value(&challenge).unwrap();
        assert_eq!(json["tlsFingerprint"], "a1b2c3");
        let back: PairChallenge =
            serde_json::from_str(&serde_json::to_string(&challenge).unwrap()).unwrap();
        assert_eq!(challenge, back);

        let verify = PairVerify {
            challenge_sig: "s1".into(),
            device_pub_sig: "s2".into(),
        };
        let json = serde_json::to_value(&verify).unwrap();
        assert_eq!(json["challengeSig"], "s1");
        assert_eq!(json["devicePubSig"], "s2");
        let back: PairVerify =
            serde_json::from_str(&serde_json::to_string(&verify).unwrap()).unwrap();
        assert_eq!(verify, back);

        let ok = PairOk {
            desktop_id: "d-01HZ".into(),
            ttl: 86400,
        };
        let back: PairOk = serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
        assert_eq!(ok, back);

        let ready = DeviceReady {
            device_id: "dev-1".into(),
        };
        let back: DeviceReady =
            serde_json::from_str(&serde_json::to_string(&ready).unwrap()).unwrap();
        assert_eq!(ready, back);

        // revoked 复用 DeviceUnlink 载荷
        let unlink = DeviceUnlink {
            device_id: "dev-1".into(),
        };
        let back: DeviceUnlink =
            serde_json::from_str(&serde_json::to_string(&unlink).unwrap()).unwrap();
        assert_eq!(unlink, back);
    }

    #[test]
    fn pair_audit_wire_values() {
        assert_eq!(
            serde_json::to_string(&PairAuditEvent::Paired).unwrap(),
            "\"paired\""
        );
        assert_eq!(
            serde_json::to_string(&PairAuditEvent::Revoked).unwrap(),
            "\"revoked\""
        );
        let audit = PairAudit {
            event: PairAuditEvent::Failed,
            ts: 1754651200000,
            device_id: Some("dev-1".into()),
            reason: Some("签名校验失败".into()),
        };
        let json = serde_json::to_value(&audit).unwrap();
        assert_eq!(json["event"], "failed");
        assert_eq!(json["ts"], 1754651200000_i64);
        let back: PairAudit =
            serde_json::from_str(&serde_json::to_string(&audit).unwrap()).unwrap();
        assert_eq!(audit, back);
    }
}
