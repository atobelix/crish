//! HMS Push 直连发送器骨架（R3-03 部分交付：协议级构造，不真实发送）
//!
//! 规格真源：D7 §5.2（HMS Push 详解：OAuth2 AT 换发 + `messages:send`）+
//! M8 §2.3.2/§2.3.4（厂商通道总览与映射表）。协议要点：
//!
//! - **凭据**：App ID + App Secret（D7 §5.2.3，服务端 AT 换发用）；
//! - **换 AT**：`POST https://oauth-login.cloud.huawei.com/oauth2/v3/token`
//!   （client credentials 模式），响应 `{access_token, expires_in}`；
//! - **发送**：`POST https://push-api.cloud.huawei.com/v1/{appId}/messages:send`
//!   携带 `Authorization: Bearer <AT>` 与 HMS 消息体（token 数组 +
//!   `android.notification{title/body/tag}` + `urgency` + 白名单 `data`）；
//! - **载荷上限**：4KiB（D7 §5.2.2），白名单只带跳转最小集（§6.3）；
//! - **响应**：HTTP 200 + `{"code": "80000000"}` = 成功；token 无效码 →
//!   DeviceNotRegistered；鉴权/参数码 → 永久失败；系统错误码 → 可重试。
//!
//! ## 真实发送接线注记
//!
//! - `reqwest`（workspace 已带 `json` feature）在接线轮注入发送函数；
//!   本文件全部函数为纯构造/解析，可离线单测；
//! - AT 按 `expires_in_secs` 缓存复用（接线轮做）；401/80100002 响应时
//!   换发 AT 重试一次（M8 §2.3.2 语义）；
//! - 错误码映射为本任务登记的保守子集（见 [parse_hms_send_response]），
//!   接线轮按华为最新文档复核增补；未登记码一律保守可重试（重推阶梯封顶）。

use super::super::PushLevel;
use super::{HMSCredentials, VendorError, VendorNotification, VendorSendOutcome};
use crate::push::vendor::apns::truncate_chars;
use crate::push::vendor::apns::{APNS_BODY_MAX_CHARS, APNS_DEFAULT_TITLE, APNS_TITLE_MAX_CHARS};

/// AGC OAuth2 token 端点（D7 §5.2.2-4）
pub const HMS_TOKEN_URL: &str = "https://oauth-login.cloud.huawei.com/oauth2/v3/token";
/// HMS Push 发送 API 基址（M8 §2.3.2 路径 `POST /push/v1/{appId}/messages:send`
/// 的官方域形态）
pub const HMS_SEND_BASE_URL: &str = "https://push-api.cloud.huawei.com";
/// 发送成功码（HMS Push Kit REST）
pub const HMS_SEND_SUCCESS_CODE: &str = "80000000";

/// AT 换发请求（构造产物；接线轮 POST `HMS_TOKEN_URL`，form-urlencoded）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HmsTokenRequest {
    /// token 端点 URL
    pub url: String,
    /// 表单内容类型
    pub content_type: &'static str,
    /// form-urlencoded 请求体（grant_type/client_id/client_secret）
    pub body: String,
}

/// AT 换发请求构造（client credentials 模式；纯函数）
pub fn build_hms_token_request(credentials: &HMSCredentials) -> HmsTokenRequest {
    build_hms_token_request_at(credentials, HMS_TOKEN_URL)
}

/// 指定 token 端点 URL 的请求构造（发送器内部路径；测试注入本地端点）
pub(crate) fn build_hms_token_request_at(
    credentials: &HMSCredentials,
    token_url: &str,
) -> HmsTokenRequest {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "client_credentials")
        .append_pair("client_id", &credentials.app_id)
        .append_pair("client_secret", &credentials.app_secret)
        .finish();
    HmsTokenRequest {
        url: token_url.to_string(),
        content_type: "application/x-www-form-urlencoded",
        body,
    }
}

/// AT 换发结果（`expires_in_secs` 供接线轮缓存复用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HmsToken {
    /// access token（`Authorization: Bearer <token>`）
    pub access_token: String,
    /// 有效期秒数（默认 3600 兜底）
    pub expires_in_secs: u64,
}

/// AT 换发响应解析（缺 `access_token` → [VendorError::Parse]）
pub fn parse_hms_token_response(body: &str) -> Result<HmsToken, VendorError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| VendorError::Parse(format!("HMS token 响应解析失败：{e}")))?;
    let access_token = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| VendorError::Parse("HMS token 响应缺 access_token".to_string()))?;
    let expires_in_secs = value
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);
    Ok(HmsToken {
        access_token: access_token.to_string(),
        expires_in_secs,
    })
}

/// 通知级别 → HMS `urgency`（M8 §2.3.4：审批/终态走高优，P2 折叠降级）
pub fn hms_urgency(level: PushLevel) -> &'static str {
    match level {
        PushLevel::P0Critical | PushLevel::P1Important => "HIGH",
        PushLevel::P2Collapsible => "NORMAL",
    }
}

/// HMS 消息发送请求（构造产物；接线轮 POST，`Authorization: Bearer <AT>`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HmsSendRequest {
    /// `POST /v1/{appId}/messages:send` 完整 URL
    pub url: String,
    /// `Authorization` 头（`Bearer <access_token>`）
    pub authorization: String,
    /// HMS 消息体（serde JSON；`validate_only=false`）
    pub body: serde_json::Value,
}

/// 消息体构造：token 数组 + `android.notification{title/body/tag}` +
/// urgency + 白名单 `data`（D7 §6.3：仅 sessionId 最小集，4KiB 内）。
///
/// 映射对齐 M8 §2.3.4 表：`title/body` ← 载荷字段（同 [crate::push::vendor::apns]）、
/// `dedupeKey` → `notification.tag`（替换式通知防刷屏）。
pub fn build_hms_send_request(
    credentials: &HMSCredentials,
    access_token: &str,
    notification: &VendorNotification,
) -> Result<HmsSendRequest, VendorError> {
    build_hms_send_request_at(credentials, access_token, notification, HMS_SEND_BASE_URL)
}

/// 指定发送基址的请求构造（发送器内部路径；测试注入本地端点）
pub(crate) fn build_hms_send_request_at(
    credentials: &HMSCredentials,
    access_token: &str,
    notification: &VendorNotification,
    send_base_url: &str,
) -> Result<HmsSendRequest, VendorError> {
    if notification.device.push_token.is_empty() {
        return Err(VendorError::Build("HMS 设备 token 为空".to_string()));
    }
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
    let mut android = serde_json::json!({
        "urgency": hms_urgency(notification.level),
        "notification": {
            "title": title,
            "body": body,
            "tag": notification.dedupe_key,
        },
    });
    // data 白名单（D7 §6.3）：不上送工具参数/对话全文；sessionId 为最小集
    if !notification.digest.session_id.is_empty() {
        android["data"] = serde_json::json!({
            "sessionId": notification.digest.session_id,
        });
    }
    let message = serde_json::json!({
        "validate_only": false,
        "message": {
            "token": [notification.device.push_token],
            "android": android,
        },
    });
    Ok(HmsSendRequest {
        url: format!("{send_base_url}/v1/{}/messages:send", credentials.app_id),
        authorization: format!("Bearer {access_token}"),
        body: message,
    })
}

/// 发送响应解析：HTTP 状态 + HMS `code` → 结果语义。
///
/// 登记子集（接线轮复核华为最新文档）：
/// - `80000000` → [VendorSendOutcome::Delivered]；
/// - `80300010`/`80300014`（token 无效/设备不在应用下）→
///   [VendorSendOutcome::DeviceNotRegistered]；
/// - `80000001`/`80100004`/`80200001`/`80300013`（系统内部/时间戳/发送失败/
///   设备不在线）→ 可重试；
/// - 其余 `80xxxxxx` 参数/鉴权/凭据码 → [VendorSendOutcome::FailedPermanent]；
/// - 未登记码/无 code 字段 → 保守可重试（重推阶梯封顶，防丢审批）。
pub fn parse_hms_send_response(status: u16, body: &str) -> VendorSendOutcome {
    if status >= 500 {
        return VendorSendOutcome::FailedRetryable { retry_after: None };
    }
    match status {
        401 => {
            return VendorSendOutcome::FailedPermanent {
                reason: "HMS 鉴权失败（access token 无效，接线轮换发重试）".to_string(),
            }
        }
        429 => return VendorSendOutcome::RateLimited { retry_after: None },
        _ => {}
    }
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("code")
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    match code.as_str() {
        HMS_SEND_SUCCESS_CODE => VendorSendOutcome::Delivered,
        // token 无效 / 设备不在应用下 → 注册表清理
        "80300010" | "80300014" => VendorSendOutcome::DeviceNotRegistered,
        // 瞬时/系统错误 → 可重试
        "80000001" | "80100004" | "80200001" | "80300013" => {
            VendorSendOutcome::FailedRetryable { retry_after: None }
        }
        // 鉴权/凭据错误（AT 无效、appId 不存在等）→ 永久（接线轮换发后重试一次）
        "80100002" | "80100003" | "80100013" => VendorSendOutcome::FailedPermanent {
            reason: format!("HMS 鉴权/凭据错误：{code}"),
        },
        // 参数/消息体错误 → 永久（审计不重试）
        "80100000" | "80100001" | "80200003" | "80300002" | "80300007" | "80300008" => {
            VendorSendOutcome::FailedPermanent {
                reason: format!("HMS 请求参数错误：{code}"),
            }
        }
        // 未登记码 / 无 code 字段 → 保守可重试
        _ => VendorSendOutcome::FailedRetryable { retry_after: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::intent::PayloadDigest;
    use crate::push::vendor::{VendorDevice, VendorPlatform};

    fn credentials() -> HMSCredentials {
        HMSCredentials {
            app_id: "100123456".to_string(),
            app_secret: "secret-abc".to_string(),
            package_name: "com.crish.mobile".to_string(),
        }
    }

    fn notification(level: PushLevel, token: &str) -> VendorNotification {
        VendorNotification::new(
            VendorDevice {
                device_id: "dev-9".to_string(),
                push_token: token.to_string(),
                platform: VendorPlatform::Android,
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

    /// AT 换发请求构造：URL/内容类型/form 字段（grant_type/client_id/client_secret）
    #[test]
    fn token_request_form_fields() {
        let req = build_hms_token_request(&credentials());
        assert_eq!(req.url, HMS_TOKEN_URL);
        assert_eq!(req.content_type, "application/x-www-form-urlencoded");
        assert!(req.body.contains("grant_type=client_credentials"));
        assert!(req.body.contains("client_id=100123456"));
        assert!(req.body.contains("client_secret=secret-abc"));
    }

    /// AT 响应解析：正常 + 缺 access_token
    #[test]
    fn token_response_parse() {
        let ok = parse_hms_token_response(
            r#"{"access_token":"at-1","expires_in":3600,"token_type":"Bearer"}"#,
        )
        .expect("正常响应");
        assert_eq!(ok.access_token, "at-1");
        assert_eq!(ok.expires_in_secs, 3600);

        // 缺 expires_in → 默认 3600
        let minimal = parse_hms_token_response(r#"{"access_token":"at-2"}"#).expect("最小响应");
        assert_eq!(minimal.expires_in_secs, 3600);

        // 缺 access_token → Parse 错误
        assert!(matches!(
            parse_hms_token_response(r#"{"error":"invalid_client"}"#),
            Err(VendorError::Parse(_))
        ));
        assert!(matches!(
            parse_hms_token_response("not json"),
            Err(VendorError::Parse(_))
        ));
    }

    /// 消息体构造：URL 路径 /v1/{appId}/messages:send、Bearer 头、
    /// token 数组、title/body/tag 映射、urgency 按级别
    #[test]
    fn send_request_maps_fields() {
        let creds = credentials();
        let n = notification(PushLevel::P0Critical, "hms-tok-1");
        let req = build_hms_send_request(&creds, "at-1", &n).expect("构造消息");
        assert_eq!(
            req.url,
            "https://push-api.cloud.huawei.com/v1/100123456/messages:send"
        );
        assert_eq!(req.authorization, "Bearer at-1");
        assert_eq!(req.body["validate_only"], false);
        assert_eq!(req.body["message"]["token"][0], "hms-tok-1");
        assert_eq!(req.body["message"]["android"]["urgency"], "HIGH");
        assert_eq!(
            req.body["message"]["android"]["notification"]["title"],
            "bash"
        );
        assert_eq!(
            req.body["message"]["android"]["notification"]["body"],
            "执行部署脚本"
        );
        assert_eq!(
            req.body["message"]["android"]["notification"]["tag"],
            "approval-requested:tc-9f3a"
        );
        // data 白名单：仅 sessionId
        assert_eq!(req.body["message"]["android"]["data"]["sessionId"], "s-7");
    }

    /// urgency 映射：P2 → NORMAL，P0/P1 → HIGH
    #[test]
    fn urgency_by_level() {
        assert_eq!(hms_urgency(PushLevel::P0Critical), "HIGH");
        assert_eq!(hms_urgency(PushLevel::P1Important), "HIGH");
        assert_eq!(hms_urgency(PushLevel::P2Collapsible), "NORMAL");
    }

    /// 空 token → Build 错误；空 sessionId → 不产出 data 字段
    #[test]
    fn send_request_guards_and_optional_data() {
        let creds = credentials();
        let empty = VendorNotification::new(
            VendorDevice {
                device_id: "d".to_string(),
                push_token: String::new(),
                platform: VendorPlatform::Android,
            },
            PushLevel::P0Critical,
            "k",
            None,
            "run",
            PayloadDigest::default(),
        );
        assert!(matches!(
            build_hms_send_request(&creds, "at", &empty),
            Err(VendorError::Build(_))
        ));

        let no_session = VendorNotification::new(
            VendorDevice {
                device_id: "d".to_string(),
                push_token: "tok".to_string(),
                platform: VendorPlatform::Android,
            },
            PushLevel::P1Important,
            "k",
            None,
            "run",
            PayloadDigest {
                session_id: String::new(),
                biz_key: "run-1".to_string(),
                digest: None,
                detail: None,
            },
        );
        let req = build_hms_send_request(&creds, "at", &no_session).expect("构造");
        assert!(req.body["message"]["android"].get("data").is_none());
        assert_eq!(
            req.body["message"]["android"]["notification"]["title"],
            APNS_DEFAULT_TITLE
        );
    }

    /// 发送响应解析矩阵（成功/token 无效/鉴权/参数/系统错误/未知码/HTTP 层）
    #[test]
    fn send_response_matrix() {
        let ok = r#"{"code":"80000000","msg":"Success","requestId":"r1"}"#;
        assert_eq!(
            parse_hms_send_response(200, ok),
            VendorSendOutcome::Delivered
        );

        let bad_token = r#"{"code":"80300010","msg":"Invalid token","requestId":"r2"}"#;
        assert_eq!(
            parse_hms_send_response(200, bad_token),
            VendorSendOutcome::DeviceNotRegistered
        );

        let auth = r#"{"code":"80100002","msg":"Auth failed","requestId":"r3"}"#;
        match parse_hms_send_response(200, auth) {
            VendorSendOutcome::FailedPermanent { reason } => {
                assert!(reason.contains("80100002"))
            }
            other => panic!("鉴权失败应永久：{other:?}"),
        }

        let params = r#"{"code":"80100000","msg":"Bad param","requestId":"r4"}"#;
        assert!(matches!(
            parse_hms_send_response(200, params),
            VendorSendOutcome::FailedPermanent { .. }
        ));

        let internal = r#"{"code":"80000001","msg":"System error","requestId":"r5"}"#;
        assert_eq!(
            parse_hms_send_response(200, internal),
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );

        // 未知码 → 保守可重试
        let unknown = r#"{"code":"89999999","msg":"??","requestId":"r6"}"#;
        assert_eq!(
            parse_hms_send_response(200, unknown),
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );

        // 无 code 字段 → 保守可重试
        assert_eq!(
            parse_hms_send_response(200, r#"{"msg":"odd"}"#),
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );

        // HTTP 层：401 → 永久（换发重试由接线轮做）；429 → 限流；5xx → 可重试
        assert!(matches!(
            parse_hms_send_response(401, ""),
            VendorSendOutcome::FailedPermanent { .. }
        ));
        assert_eq!(
            parse_hms_send_response(429, ""),
            VendorSendOutcome::RateLimited { retry_after: None }
        );
        assert_eq!(
            parse_hms_send_response(503, ""),
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );
    }
}
