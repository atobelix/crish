//! 云端账号服务 HTTP 客户端（audit-repair-202609 · T14/T12/T16 重写）
//!
//! ## 服务端契约（2026-09-06 经 Tailscale SSH 核对 flowbit-auth 生产部署
//! dist 代码后钉死，修改前必须重新核对，禁止凭记忆或猜测）
//!
//! - `POST /api/auth/email/login/password`
//!   → 200 `{ accessToken, refreshToken, user: { id, accountId, nickname, email, ... } }`
//!   （`refreshToken` 与 `user.id` 由服务端无条件返回，缺失即契约破坏 → 报错）
//! - `POST /api/auth/refresh` `{ refreshToken }`
//!   → 200 `{ accessToken, refreshToken, ... }`；无效 / 吊销 / 过期 → **401**
//! - `GET /api/auth/me`（Bearer）→ 200 `{ user: { id, accountId, nickname, email, ... } }`
//!   （会话恢复取真实档案的**唯一**来源；禁止客户端伪造默认身份）
//! - `GET /api/devices`（Bearer）→ 200 `{ items: [...] }`
//! - `POST /api/relay/ticket/host` —— **服务端尚未实现**（生产实测 404）。
//!   方法保留但错误如实上抛，调用方不得伪造 relayUrl / 兜底假数据。
//!
//! Base URL 缺省为生产地址，可用环境变量 `CRISH_AUTH_BASE_URL` 覆盖（T16）。

use anyhow::Result;
use serde::{Deserialize, Serialize};

mod cloud_auth_client;

pub use cloud_auth_client::CloudAuthClient;

/// 生产云端账号服务地址（可经 `CRISH_AUTH_BASE_URL` 覆盖）
pub const DEFAULT_AUTH_BASE_URL: &str = "https://auth.flowbit.me";

/// 结构化错误：区分「凭据已失效」（触发本地清凭据）与一般网络 / 契约错误
#[derive(Debug, thiserror::Error)]
pub enum CloudAuthError {
    /// 401 —— refresh token / access token 无效或已吊销；调用方必须清除本地凭据
    #[error("unauthorized: token invalid or revoked")]
    Unauthorized,
    /// 4xx 业务拒绝（密码错误、邮箱已注册、验证码无效等）；消息来自服务端，可直接展示
    #[error("{message}")]
    Rejected { status: u16, message: String },
    /// 网络 / HTTP 层错误（超时、5xx 等）
    #[error("network error: {0}")]
    Network(String),
    /// 响应不符合上述契约（缺字段、形状错误）
    #[error("bad response: {0}")]
    BadResponse(String),
}

/// 由 HTTP 状态码映射结构化错误
fn auth_error_for_status(status: reqwest::StatusCode) -> CloudAuthError {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        CloudAuthError::Unauthorized
    } else {
        CloudAuthError::Network(format!("HTTP {status}"))
    }
}

/// 4xx 业务错误：读取服务端 `{ message }` 供 UI 直接展示；5xx/网络仍归 Network。
async fn response_error(resp: reqwest::Response) -> CloudAuthError {
    let status = resp.status();
    if status.is_server_error() {
        return CloudAuthError::Network(format!("HTTP {status}"));
    }
    let text = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(|item| item.as_str())
                .map(str::to_string)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if status == reqwest::StatusCode::UNAUTHORIZED {
                "登录已失效，请重新登录".to_string()
            } else {
                format!("请求失败（HTTP {status}）")
            }
        });
    CloudAuthError::Rejected {
        status: status.as_u16(),
        message,
    }
}

/// 邮件验证码场景（登录 / 注册 / 重置密码）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailCodeScene {
    Login,
    Register,
    Reset,
}

impl EmailCodeScene {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "login" => Some(Self::Login),
            "register" => Some(Self::Register),
            "reset" => Some(Self::Reset),
            _ => None,
        }
    }

    fn request_path(self) -> &'static str {
        match self {
            Self::Login => "/api/auth/email/login/code/request",
            Self::Register => "/api/auth/email/register/request",
            Self::Reset => "/api/auth/email/password/reset/request",
        }
    }

    fn confirm_path(self) -> &'static str {
        match self {
            Self::Login => "/api/auth/email/login/code/confirm",
            Self::Register => "/api/auth/email/register/confirm",
            Self::Reset => "/api/auth/email/password/reset/confirm",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailCodeTicket {
    pub ok: bool,
    #[serde(rename = "expiresIn")]
    pub expires_in: u64,
    /// 发码冷却剩余秒数（新版账号中心返回；旧接口可能缺失）
    #[serde(rename = "resendAfter", default)]
    pub resend_after: Option<u64>,
    /// 开发环境账号中心可能回传验证码；生产环境不返回
    #[serde(rename = "devCode", default)]
    pub dev_code: Option<String>,
}

/// 先码后密码场景（注册 / 重置）；限定子集，避免误用 login 场景。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordCodeScene {
    Register,
    Reset,
}

impl PasswordCodeScene {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "register" => Some(Self::Register),
            "reset" => Some(Self::Reset),
            _ => None,
        }
    }

    /// 发码接口：两个旧接口都支持只传 email（password 可选）。
    fn request_path(self) -> &'static str {
        match self {
            Self::Register => "/api/auth/email/register/request",
            Self::Reset => "/api/auth/email/password/reset/request",
        }
    }

    /// `/email/code/verify` 的 scene 取值。
    fn verify_scene(self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::Reset => "reset_password",
        }
    }
}

/// 验证码校验通过后的一次性 setup token（10 分钟有效）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSetupToken {
    pub setup_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub account_id: String,
    #[serde(default)]
    pub email: Option<String>,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub avatar_file_id: Option<String>,
    #[serde(default)]
    pub bio: String,
    #[serde(default)]
    pub profile_updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionInfo {
    pub id: String,
    pub device_id: String,
    #[serde(default)]
    pub user_agent: String,
    #[serde(default)]
    pub ip: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub revoked: bool,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudDeviceItem {
    pub id: String,
    pub name: String,
    pub platform: String,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: u64,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// 从服务端 user 对象解析档案（audit-repair-202609 T14）：
/// `id`/`accountId` 与 `email` 为服务端无条件返回字段，缺失 = 契约破坏 → 报错；
/// `name` 容忍缺失（生产字段为 `nickname`）。
fn parse_profile(user: &serde_json::Value) -> Result<UserProfile, CloudAuthError> {
    let id = user["id"]
        .as_str()
        .or_else(|| user["accountId"].as_str())
        .ok_or_else(|| CloudAuthError::BadResponse("user.id missing".into()))?
        .to_string();
    let email = user["email"]
        .as_str()
        .ok_or_else(|| CloudAuthError::BadResponse("user.email missing".into()))?
        .to_string();
    let name = user["nickname"]
        .as_str()
        .or_else(|| user["name"].as_str())
        .map(|s| s.to_string());
    Ok(UserProfile { id, email, name })
}

/// 解析会话响应（`accessToken` / `refreshToken` 缺失即契约破坏）。
fn parse_session_body(
    body: &serde_json::Value,
) -> Result<(AuthTokens, UserProfile), CloudAuthError> {
    let access_token = body["accessToken"]
        .as_str()
        .ok_or_else(|| CloudAuthError::BadResponse("accessToken missing".into()))?
        .to_string();
    let refresh_token = body["refreshToken"]
        .as_str()
        .ok_or_else(|| CloudAuthError::BadResponse("refreshToken missing".into()))?
        .to_string();
    let profile = parse_profile(&body["user"])?;
    // expiresIn 缺省 15m 仅用于客户端续期调度；真实有效期以服务端签发为准。
    let tokens = AuthTokens {
        access_token,
        refresh_token,
        expires_in: body["expiresIn"].as_u64().or(Some(900)),
    };
    Ok((tokens, profile))
}

/// 仅用于路径段的最小百分号编码（session id / device id 均为安全字符）。
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_session_with_profile() {
        let body = json!({
            "accessToken": "a",
            "refreshToken": "r",
            "expiresIn": 900,
            "user": { "id": "acc-1", "email": "a@b.c", "nickname": "Ann" }
        });
        let (tokens, profile) = parse_session_body(&body).expect("session");
        assert_eq!(tokens.access_token, "a");
        assert_eq!(tokens.refresh_token, "r");
        assert_eq!(profile.id, "acc-1");
        assert_eq!(profile.name.as_deref(), Some("Ann"));
    }

    #[test]
    fn rejects_session_without_refresh_token() {
        let body = json!({
            "accessToken": "a",
            "user": { "id": "acc-1", "email": "a@b.c" }
        });
        assert!(matches!(
            parse_session_body(&body),
            Err(CloudAuthError::BadResponse(_))
        ));
    }

    #[test]
    fn encodes_session_ids_for_paths() {
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("uuid-1234_ok"), "uuid-1234_ok");
    }

    #[test]
    fn code_scene_paths_are_exact() {
        assert_eq!(
            EmailCodeScene::Login.request_path(),
            "/api/auth/email/login/code/request"
        );
        assert_eq!(
            EmailCodeScene::Register.confirm_path(),
            "/api/auth/email/register/confirm"
        );
        assert_eq!(
            EmailCodeScene::Reset.request_path(),
            "/api/auth/email/password/reset/request"
        );
    }
}
