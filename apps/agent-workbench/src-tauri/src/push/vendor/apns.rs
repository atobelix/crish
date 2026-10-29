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
use super::{APNsCredentials, VendorError, VendorNotification, VendorSendOutcome};

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
///
/// wire 键 camelCase（对齐 D7 §3.3.13 样例的 `crish.*` 形状：
/// `schemaVersion/eventType/dedupeKey/target` 同为 camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
/// 主机由 `credentials.sandbox` 决定（[APNS_PROD_HOST] / [APNS_SANDBOX_HOST]）；
/// 发送器（[crate::push::vendor::apns_sender::ApnsSender]）走
/// [build_apns_send_request_at] 以便测试注入本地端点。
pub fn build_apns_send_request(
    credentials: &APNsCredentials,
    notification: &VendorNotification,
    jwt: &str,
) -> Result<ApnsSendRequest, VendorError> {
    let host = if credentials.sandbox {
        APNS_SANDBOX_HOST
    } else {
        APNS_PROD_HOST
    };
    build_apns_send_request_at(credentials, notification, jwt, &format!("https://{host}"))
}

/// 指定基址的请求构造（发送器内部路径；测试注入 `http://127.0.0.1:<port>`）
pub(crate) fn build_apns_send_request_at(
    credentials: &APNsCredentials,
    notification: &VendorNotification,
    jwt: &str,
    base_url: &str,
) -> Result<ApnsSendRequest, VendorError> {
    if notification.device.push_token.is_empty() {
        return Err(VendorError::Build("APNs 设备 token 为空".to_string()));
    }
    let payload = apns_payload(notification);
    let body = serde_json::to_vec(&payload)
        .map_err(|e| VendorError::Build(format!("APNs 载荷序列化失败：{e}")))?;
    Ok(ApnsSendRequest {
        url: format!("{base_url}/3/device/{}", notification.device.push_token),
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
    header?
        .trim()
        .parse::<u64>()
        .ok()
        .map(std::time::Duration::from_secs)
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
        .and_then(|value| {
            value
                .get("reason")
                .and_then(|r| r.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("APNs 状态码 {status}"))
}

#[cfg(test)]
mod tests;
