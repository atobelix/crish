//! APNs 直连发送器骨架（R3-03 部分交付：协议级构造，不真实发送）
//!
//! 规格真源：M8 §2.2.3（APNs 直连实现要点）+ D7 §6.2（载荷映射）/
//! §6.3（正文截断与白名单）。协议要点：
//!
//! - 通道形态：HTTP/2 `POST https://api.push.apple.com/3/device/{token}`
//!   （沙箱 `api.sandbox.push.apple.com`）；
//! - 认证：Token-based（Apple 推荐）——`.p8` AuthKey（ES256/P-256）签发
//!   JWT：header `{alg: ES256, kid: <KeyID>}`，claims `{iss: <TeamID>,
//!   iat: <now>}`，有效期 1 小时（[APNS_JWT_TTL_SECS]）；
//! - 载荷：`aps.{alert, sound, badge, thread-id, interruption-level}` +
//!   `crish.*` 自定义键（跳转最小集，D7 §6.3 白名单）；
//! - 响应：200 = 成功；410 = DeviceNotRegistered；429 = 限流（退避）；
//!   5xx = 可重试；400/403 等 = 永久失败（审计不重试）。
//!
//! ## 真实发送接线注记
//!
//! - `reqwest`（workspace 已带 `http2` feature）在接线轮注入
//!   `send_async()`；本文件全部函数为纯构造/解析，可离线单测；
//! - JWT 每小时轮换 + 每 App 连接池（M8 §2.2.3-5）由接线轮管理，
//!   [JwtEs256Signer::sign] 注入时钟（秒），轮换逻辑可测；
//! - 头字段仅保留协议必需最小集（authorization / apns-topic /
//!   apns-push-type / apns-priority / apns-collapse-id）；
//!   `apns-expiration`（TTL，F2 §6 60s 审批 TTL 语义）由接线轮按需补充。

use std::path::Path;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;

use super::super::PushLevel;
use super::{
    APNsCredentials, VendorError, VendorNotification, VendorSendOutcome,
};

/// APNs 生产主机（M8 §2.2.3-1）
pub const APNS_PROD_HOST: &str = "api.push.apple.com";
/// APNs 沙箱主机（D7 §8.3 dev/prod 环境隔离）
pub const APNS_SANDBOX_HOST: &str = "api.sandbox.push.apple.com";
/// JWT 有效期（M8 §2.2.3-2：每连接一个 token，有效期 1 小时）
pub const APNS_JWT_TTL_SECS: u64 = 3600;
/// 标题截断上限（D7 §6.2：title ≤ 30 字）
pub const APNS_TITLE_MAX_CHARS: usize = 30;
/// 正文截断上限（D7 §6.3：正文 ≤ 120 字）
pub const APNS_BODY_MAX_CHARS: usize = 120;
/// 标题缺省值（digest.detail 为空时）
pub const APNS_DEFAULT_TITLE: &str = "Crish 通知";

/// 按字符数截断（UTF-8 安全；中文按字计，对齐 D7 §6.2/§6.3 上限）
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// `.p8` AuthKey → ES256 签名器（JWT 头构造 + 签名纯函数）
///
/// 内部用 ring（workspace 既有依赖，multi_device/tls.rs 同栈）的
/// `ECDSA_P256_SHA256_FIXED_SIGNING`：输出 JWT ES256 要求的裸 `r||s`
/// 64 字节签名（RFC 7518 §3.4 格式，非 DER）。
pub struct JwtEs256Signer {
    key_pair: ring::signature::EcdsaKeyPair,
    key_id: String,
    team_id: String,
}

impl JwtEs256Signer {
    /// 从 `.p8` 文件（PKCS#8 PEM）加载 P-256 私钥。
    ///
    /// 注：同步读文件仅为骨架期便利；接线轮可换 `tokio::fs`（行为不变）。
    pub fn load(path: &Path, key_id: &str, team_id: &str) -> Result<Self, VendorError> {
        let pem = std::fs::read(path).map_err(|source| VendorError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let mut reader = std::io::BufReader::new(&pem[..]);
        let key = rustls_pemfile::private_key(&mut reader)
            .map_err(|e| VendorError::Credential(format!("解析 .p8 失败：{e}")))?
            .ok_or_else(|| VendorError::Credential(".p8 不含 PKCS#8 私钥".to_string()))?;
        let der = match key {
            rustls::pki_types::PrivateKeyDer::Pkcs8(der) => der,
            other => {
                return Err(VendorError::Credential(format!(
                    ".p8 密钥格式需为 PKCS#8：{other:?}"
                )))
            }
        };
        let rng = ring::rand::SystemRandom::new();
        let key_pair = ring::signature::EcdsaKeyPair::from_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            der.secret_pkcs8_der(),
            &rng,
        )
        .map_err(|_| VendorError::Credential(".p8 不是有效的 P-256 密钥".to_string()))?;
        Ok(Self {
            key_pair,
            key_id: key_id.to_string(),
            team_id: team_id.to_string(),
        })
    }

    /// 签发 APNs 认证 JWT（header + claims + ES256 签名，base64url 无填充）。
    ///
    /// `now_secs` 注入时钟（UNIX 秒），`exp = now + [APNS_JWT_TTL_SECS]`。
    /// 返回形如 `<header>.<claims>.<signature>` 的完整 JWT。
    pub fn sign(&self, now_secs: u64) -> Result<String, VendorError> {
        let header = serde_json::json!({ "alg": "ES256", "kid": self.key_id });
        let claims = serde_json::json!({
            "iss": self.team_id,
            "iat": now_secs,
            "exp": now_secs + APNS_JWT_TTL_SECS,
        });
        let header_b64 = b64url(
            &serde_json::to_vec(&header)
                .map_err(|e| VendorError::Build(format!("JWT 头序列化失败：{e}")))?,
        );
        let claims_b64 = b64url(
            &serde_json::to_vec(&claims)
                .map_err(|e| VendorError::Build(format!("JWT 载荷序列化失败：{e}")))?,
        );
        let signing_input = format!("{header_b64}.{claims_b64}");
        let rng = ring::rand::SystemRandom::new();
        let signature = self
            .key_pair
            .sign(&rng, signing_input.as_bytes())
            .map_err(|_| VendorError::Crypto("ES256 签名失败".to_string()))?;
        Ok(format!("{signing_input}.{}", b64url(signature.as_ref())))
    }

    /// 公钥（未压缩点，65 字节）——测试验签与未来接入面
    pub fn public_key(&self) -> &[u8] {
        ring::signature::KeyPair::public_key(&self.key_pair).as_ref()
    }
}

/// base64url 无填充编码（JWT 段编码）
fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 通知级别 → APNs `interruption-level`（M8 §2.2.3-3：P0/P1 → active，
/// P2 → passive；time-sensitive 需 entitlement，默认不申请）
pub fn interruption_level(level: PushLevel) -> &'static str {
    match level {
        PushLevel::P0Critical | PushLevel::P1Important => "active",
        PushLevel::P2Collapsible => "passive",
    }
}

/// APNs `aps.alert`（D7 §6.2 映射：`alert.title/body` ← 载荷字段）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ApnsAlert {
    /// 标题（≤ [APNS_TITLE_MAX_CHARS] 字）
    pub title: String,
    /// 正文（≤ [APNS_BODY_MAX_CHARS] 字）
    pub body: String,
}

/// APNs `aps` 对象（D7 §3.3.13 样例 + M8 §2.2.3 载荷样例对齐）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub struct ApnsAps {
    /// alert 对象（标题/正文）
    pub alert: ApnsAlert,
    /// 声音（样例 `"default"`）
    pub sound: String,
    /// 角标（样例 `1`）
    pub badge: u32,
    /// 分组堆叠键（`thread-id` ← collapseKey，D7 §3.4.2）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// 中断级别（`interruption-level`：active/passive，M8 §2.2.3-3）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interruption_level: Option<&'static str>,
}

/// `crish.*` 自定义载荷（跳转最小集，D7 §6.3 白名单：
/// 不上送工具参数全文/对话正文；screen 等字段由接线轮经
/// [crate::push::schema::PushMessage] 的 target 注入）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ApnsCrish {
    /// 会话 id（白名单字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 主业务键（toolCallId/runId/taskId 等，白名单字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub biz_key: Option<String>,
}

/// APNs 完整载荷（`aps` + `crish`）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ApnsPayload {
    /// aps 对象（系统呈现）
    pub aps: ApnsAps,
    /// crish 自定义键（跳转最小集）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crish: Option<ApnsCrish>,
}

/// 载荷映射：[PayloadDigest] → APNs payload（alert/badge/sound 对齐
/// D7 §3.3.13 样例与 §6.3 截断上限）
///
/// 映射规则（接线轮注记）：`alert.title` ← `digest.detail`（次级文本：
/// 工具名/退出码等），`alert.body` ← `digest.digest`（正文主体）；copy.rs
/// 渲染的完整文案（R3-02 [crate::push::schema::PushMessage] title/body）
/// 由接线轮先填充进 digest 再调用本函数。
pub fn apns_payload(notification: &VendorNotification) -> ApnsPayload {
    let title = truncate_chars(
        notification
            .digest
            .detail
            .as_deref()
            .unwrap_or(APNS_DEFAULT_TITLE),
        APNS_TITLE_MAX_CHARS,
    );
    let body = truncate_chars(
        notification.digest.digest.as_deref().unwrap_or_default(),
        APNS_BODY_MAX_CHARS,
    );
    let thread_id = notification.collapse_key.clone();
    let interruption_level = Some(interruption_level(notification.level));
    let crish = Some(ApnsCrish {
        session_id: (!notification.digest.session_id.is_empty())
            .then(|| notification.digest.session_id.clone()),
        biz_key: (!notification.digest.biz_key.is_empty())
            .then(|| notification.digest.biz_key.clone()),
    });
    ApnsPayload {
        aps: ApnsAps {
            alert: ApnsAlert { title, body },
            sound: "default".to_string(),
            badge: 1,
            thread_id,
            interruption_level,
        },
        crish,
    }
}

/// APNs 发送请求（协议级构造产物；接线轮经 `reqwest` 发送）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsSendRequest {
    /// 完整 URL：`https://{host}/3/device/{device_token}`
    pub url: String,
    /// `authorization` 头（`bearer <jwt>`）
    pub authorization: String,
    /// `apns-push-type` 头（显示型通知）
    pub apns_push_type: &'static str,
    /// `apns-priority` 头（10 = 立即投递）
    pub apns_priority: u8,
    /// `apns-topic` 头（bundle id）
    pub apns_topic: String,
    /// `apns-collapse-id` 头（折叠键，可空）
    pub apns_collapse_id: Option<String>,
    /// 请求体（`apns_payload` 序列化 JSON 字节）
    pub body: Vec<u8>,
}

/// 请求构造：`POST /3/device/{token}`（HTTP/2）+ JWT 认证头 + 载荷体。
///
/// 纯函数（不发送）；设备 token 为空返回 [VendorError::Build]。
pub fn build_apns_send_request(
    credentials: &APNsCredentials,
    notification: &VendorNotification,
    jwt: &str,
) -> Result<ApnsSendRequest, VendorError> {
    if notification.device.push_token.is_empty() {
        return Err(VendorError::Build("APNs 设备 token 为空".to_string()));
    }
    let host = if credentials.sandbox {
        APNS_SANDBOX_HOST
    } else {
        APNS_PROD_HOST
    };
    let payload = apns_payload(notification);
    let body = serde_json::to_vec(&payload)
        .map_err(|e| VendorError::Build(format!("APNs 载荷序列化失败：{e}")))?;
    Ok(ApnsSendRequest {
        url: format!("https://{host}/3/device/{}", notification.device.push_token),
        authorization: format!("bearer {jwt}"),
        apns_push_type: "alert",
        apns_priority: 10,
        apns_topic: credentials.bundle_id.clone(),
        apns_collapse_id: notification.collapse_key.clone(),
        body,
    })
}

/// 解析 `Retry-After` 头（秒值；HTTP-date 形态由接线轮按需扩展）
pub fn parse_retry_after(header: Option<&str>) -> Option<std::time::Duration> {
    header?.trim().parse::<u64>().ok().map(std::time::Duration::from_secs)
}

/// 响应解析：APNs 状态码 → 发送结果语义（M8 §2.2.3-4）
///
/// - 200 → [VendorSendOutcome::Delivered]；
/// - 410 → [VendorSendOutcome::DeviceNotRegistered]（注册表清理）；
/// - 429 → [VendorSendOutcome::RateLimited]（`retry_after` 带 Retry-After 头）；
/// - 400/403/404/405/413 → 永久失败（参数/凭据问题，审计不重试）；
/// - 5xx → [VendorSendOutcome::FailedRetryable]（退避重试）。
///
/// `body`（JSON `{"reason": "..."}`）用于填充永久失败原因；非 JSON 忽略。
pub fn parse_apns_response(
    status: u16,
    body: Option<&str>,
    retry_after: Option<&str>,
) -> VendorSendOutcome {
    match status {
        200 => VendorSendOutcome::Delivered,
        410 => VendorSendOutcome::DeviceNotRegistered,
        429 => VendorSendOutcome::RateLimited {
            retry_after: parse_retry_after(retry_after),
        },
        400 | 403 | 404 | 405 | 413 => VendorSendOutcome::FailedPermanent {
            reason: apns_failure_reason(status, body),
        },
        500..=599 => VendorSendOutcome::FailedRetryable {
            retry_after: parse_retry_after(retry_after),
        },
        other => VendorSendOutcome::FailedPermanent {
            reason: format!("APNs 未预期状态码 {other}"),
        },
    }
}

/// 从 APNs 错误体提取 `reason`（无 body/非 JSON 时回退状态码文本）
fn apns_failure_reason(status: u16, body: Option<&str>) -> String {
    body.and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("reason").and_then(|r| r.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("APNs 状态码 {status}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::intent::PayloadDigest;
    use crate::push::PushLevel;
    use crate::push::vendor::{VendorDevice, VendorNotification, VendorPlatform};

    const KEY_ID: &str = "ABC123DEFG";
    const TEAM_ID: &str = "TEAMID42";

    fn signer() -> (JwtEs256Signer, tempfile::TempDir) {
        // 生成 P-256 密钥 → 写入 PKCS#8 PEM（临时目录）
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &rng,
        )
        .expect("生成测试密钥");
        // PEM 段内用标准 base64（与 Apple 签发的 .p8 一致）
        use base64::engine::general_purpose::STANDARD;
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("AuthKey.p8");
        std::fs::write(&path, pem).expect("写 .p8");
        let signer = JwtEs256Signer::load(&path, KEY_ID, TEAM_ID).expect("加载签名器");
        (signer, dir)
    }

    fn notification(level: PushLevel, token: &str) -> VendorNotification {
        VendorNotification::new(
            VendorDevice {
                device_id: "dev-1".to_string(),
                push_token: token.to_string(),
                platform: VendorPlatform::Ios,
            },
            level,
            "approval-requested:tc-9f3a",
            Some("session:s-7".to_string()),
            "approval",
            PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: "tc-9f3a".to_string(),
                digest: Some("执行部署脚本".to_string()),
                detail: Some("bash".to_string()),
            },
        )
    }

    /// JWT 结构断言：三段 base64url、header/claims 字段、签名 64 字节可验签
    #[test]
    fn jwt_structure_es256_signature() {
        let (signer, _dir) = signer();
        let now = 1_786_214_400;
        let jwt = signer.sign(now).expect("签发 JWT");

        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT 必为三段");

        // header：alg=ES256、kid=KeyID
        let header: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD.decode(parts[0]).expect("header base64url"),
        )
        .expect("header JSON");
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], KEY_ID);

        // claims：iss=TeamID、iat=now、exp=now+1h
        let claims: serde_json::Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD.decode(parts[1]).expect("claims base64url"),
        )
        .expect("claims JSON");
        assert_eq!(claims["iss"], TEAM_ID);
        assert_eq!(claims["iat"], now);
        assert_eq!(claims["exp"], now + APNS_JWT_TTL_SECS);

        // 签名：64 字节裸 r||s，且用公钥验签通过
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).expect("签名 base64url");
        assert_eq!(signature.len(), 64, "ES256 签名为裸 r||s 64 字节");
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            signer.public_key(),
        )
        .verify(signing_input.as_bytes(), &signature)
        .expect("签名可用公钥验证");
    }

    /// 签名确定性不做断言（ECDSA 随机化），但结构稳定：同输入两次签发
    /// 都满足三段 + 验签
    #[test]
    fn jwt_sign_twice_both_valid() {
        let (signer, _dir) = signer();
        let now = 1_786_214_400;
        for _ in 0..2 {
            let jwt = signer.sign(now).expect("签发 JWT");
            let parts: Vec<&str> = jwt.split('.').collect();
            assert_eq!(parts.len(), 3);
            let signature = URL_SAFE_NO_PAD.decode(parts[2]).expect("签名 base64url");
            assert_eq!(signature.len(), 64);
            let signing_input = format!("{}.{}", parts[0], parts[1]);
            ring::signature::UnparsedPublicKey::new(
                &ring::signature::ECDSA_P256_SHA256_FIXED,
                signer.public_key(),
            )
            .verify(signing_input.as_bytes(), &signature)
            .expect("验签通过");
        }
    }

    /// 坏 .p8 → Credential 错误（格式错 / 缺文件）
    #[test]
    fn jwt_load_rejects_bad_key() {
        let dir = tempfile::tempdir().expect("临时目录");
        let bad = dir.path().join("bad.p8");
        std::fs::write(&bad, "not a pem").expect("写坏文件");
        assert!(matches!(
            JwtEs256Signer::load(&bad, KEY_ID, TEAM_ID),
            Err(VendorError::Credential(_))
        ));

        let missing = dir.path().join("missing.p8");
        assert!(matches!(
            JwtEs256Signer::load(&missing, KEY_ID, TEAM_ID),
            Err(VendorError::Io { .. })
        ));
    }

    /// 载荷映射（D7 §3.3.13 S1 样例对齐）：alert/badge/sound/thread-id/
    /// interruption-level/crish 白名单
    #[test]
    fn payload_maps_s1_approval_sample() {
        let n = notification(PushLevel::P0Critical, "tok-1");
        let payload = apns_payload(&n);
        assert_eq!(payload.aps.alert.title, "bash");
        assert_eq!(payload.aps.alert.body, "执行部署脚本");
        assert_eq!(payload.aps.sound, "default");
        assert_eq!(payload.aps.badge, 1);
        assert_eq!(payload.aps.thread_id.as_deref(), Some("session:s-7"));
        assert_eq!(payload.aps.interruption_level, Some("active"));

        let crish = payload.crish.expect("crish 白名单");
        assert_eq!(crish.session_id.as_deref(), Some("s-7"));
        assert_eq!(crish.biz_key.as_deref(), Some("tc-9f3a"));
    }

    /// 级别 → interruption-level 映射（M8 §2.2.3-3）
    #[test]
    fn payload_interruption_level_by_severity() {
        assert_eq!(interruption_level(PushLevel::P0Critical), "active");
        assert_eq!(interruption_level(PushLevel::P1Important), "active");
        assert_eq!(interruption_level(PushLevel::P2Collapsible), "passive");
    }

    /// 截断上限（§6.2 title ≤ 30 字 / §6.3 body ≤ 120 字，中文按字计）
    #[test]
    fn payload_truncates_long_text() {
        let long = "超长正文".repeat(50); // 200 字
        let n = VendorNotification::new(
            VendorDevice {
                device_id: "d".to_string(),
                push_token: "tok".to_string(),
                platform: VendorPlatform::Ios,
            },
            PushLevel::P1Important,
            "run-terminal:run-1",
            None,
            "run",
            PayloadDigest {
                session_id: "s".to_string(),
                biz_key: "run-1".to_string(),
                digest: Some(long),
                detail: Some("很长的标题".repeat(20)),
            },
        );
        let payload = apns_payload(&n);
        assert_eq!(payload.aps.alert.title.chars().count(), APNS_TITLE_MAX_CHARS);
        assert_eq!(payload.aps.alert.body.chars().count(), APNS_BODY_MAX_CHARS);
    }

    /// 缺省标题：detail 为空 → "Crish 通知"；digest 为空 → 空正文不 panic
    #[test]
    fn payload_falls_back_when_text_missing() {
        let n = VendorNotification::new(
            VendorDevice {
                device_id: "d".to_string(),
                push_token: "tok".to_string(),
                platform: VendorPlatform::Ios,
            },
            PushLevel::P2Collapsible,
            "cache-waste-alert:run-9",
            None,
            "summary",
            PayloadDigest::default(),
        );
        let payload = apns_payload(&n);
        assert_eq!(payload.aps.alert.title, APNS_DEFAULT_TITLE);
        assert_eq!(payload.aps.alert.body, "");
        assert_eq!(payload.aps.interruption_level, Some("passive"));
    }

    /// 请求构造：URL /3/device/{token}、bearer 头、apns-topic=bundle id、
    /// collapse-id、body = 载荷 JSON
    #[test]
    fn build_request_prod_and_sandbox() {
        let creds = APNsCredentials {
            auth_key_path: "AuthKey.p8".into(),
            key_id: KEY_ID.to_string(),
            team_id: TEAM_ID.to_string(),
            bundle_id: "com.crish.mobile".to_string(),
            sandbox: false,
        };
        let n = notification(PushLevel::P0Critical, "tok-1");
        let req = build_apns_send_request(&creds, &n, "jwt-abc").expect("构造请求");
        assert_eq!(req.url, "https://api.push.apple.com/3/device/tok-1");
        assert_eq!(req.authorization, "bearer jwt-abc");
        assert_eq!(req.apns_push_type, "alert");
        assert_eq!(req.apns_priority, 10);
        assert_eq!(req.apns_topic, "com.crish.mobile");
        assert_eq!(req.apns_collapse_id.as_deref(), Some("session:s-7"));
        let body: serde_json::Value =
            serde_json::from_slice(&req.body).expect("body 是 JSON");
        assert_eq!(body["aps"]["alert"]["title"], "bash");

        let sandbox_creds = APNsCredentials { sandbox: true, ..creds.clone() };
        let req_sandbox = build_apns_send_request(&sandbox_creds, &n, "jwt").expect("沙箱请求");
        assert_eq!(
            req_sandbox.url,
            "https://api.sandbox.push.apple.com/3/device/tok-1"
        );

        // 空 token → Build 错误
        let empty = VendorNotification::new(
            VendorDevice {
                device_id: "d".to_string(),
                push_token: String::new(),
                platform: VendorPlatform::Ios,
            },
            PushLevel::P0Critical,
            "k",
            None,
            "run",
            PayloadDigest::default(),
        );
        assert!(matches!(
            build_apns_send_request(&creds, &empty, "jwt"),
            Err(VendorError::Build(_))
        ));
    }

    /// 响应解析矩阵（M8 §2.2.3-4）
    #[test]
    fn response_status_to_outcome() {
        assert_eq!(
            parse_apns_response(200, None, None),
            VendorSendOutcome::Delivered
        );
        assert_eq!(
            parse_apns_response(410, Some(r#"{"reason":"Unregistered"}"#), None),
            VendorSendOutcome::DeviceNotRegistered
        );
        // 429 → RateLimited + Retry-After 秒值
        assert_eq!(
            parse_apns_response(429, None, Some("30")),
            VendorSendOutcome::RateLimited {
                retry_after: Some(std::time::Duration::from_secs(30))
            }
        );
        // 400/403 → 永久失败（reason 从 body 提取）
        match parse_apns_response(400, Some(r#"{"reason":"BadDeviceToken"}"#), None) {
            VendorSendOutcome::FailedPermanent { reason } => {
                assert_eq!(reason, "BadDeviceToken")
            }
            other => panic!("400 应永久失败：{other:?}"),
        }
        match parse_apns_response(403, None, None) {
            VendorSendOutcome::FailedPermanent { .. } => {}
            other => panic!("403 应永久失败：{other:?}"),
        }
        // 5xx → 可重试
        assert_eq!(
            parse_apns_response(503, None, None),
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );
        // 未预期状态码 → 永久失败
        match parse_apns_response(418, None, None) {
            VendorSendOutcome::FailedPermanent { reason } => {
                assert!(reason.contains("418"))
            }
            other => panic!("418 应永久失败：{other:?}"),
        }
    }

    /// Retry-After 解析：非法值 → None
    #[test]
    fn retry_after_parse_handles_bad_values() {
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("abc")), None);
        assert_eq!(
            parse_retry_after(Some(" 15 ")),
            Some(std::time::Duration::from_secs(15))
        );
    }

    /// 截断辅助：UTF-8 安全（多字节字符不撕裂）
    #[test]
    fn truncate_chars_utf8_safe() {
        assert_eq!(truncate_chars("审批请求", 2), "审批");
        assert_eq!(truncate_chars("abcd", 3), "abc");
        assert_eq!(truncate_chars("短", 100), "短");
    }
}
