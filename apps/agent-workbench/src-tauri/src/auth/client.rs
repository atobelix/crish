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

use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 生产云端账号服务地址（可经 `CRISH_AUTH_BASE_URL` 覆盖）
pub const DEFAULT_AUTH_BASE_URL: &str = "https://auth.flowbit.me";

/// 结构化错误：区分「凭据已失效」（触发本地清凭据）与一般网络 / 契约错误
#[derive(Debug, thiserror::Error)]
pub enum CloudAuthError {
    /// 401 —— refresh token / access token 无效或已吊销；调用方必须清除本地凭据
    #[error("unauthorized: token invalid or revoked")]
    Unauthorized,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayTicketResponse {
    pub ticket: String,
    #[serde(rename = "relayUrl")]
    pub relay_url: String,
    pub exp: u64,
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

pub struct CloudAuthClient {
    http: Client,
    base_url: String,
}

impl CloudAuthClient {
    pub fn new(base_url: Option<String>) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base_url: base_url
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_AUTH_BASE_URL.to_string()),
        }
    }

    /// 账号密码登录（T14：`refreshToken` / `user.id` 缺失一律报错，禁止回退伪造）
    pub async fn login_password(
        &self,
        email: &str,
        password: &str,
    ) -> Result<(AuthTokens, UserProfile)> {
        let url = format!("{}/api/auth/email/login/password", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "email": email,
                "password": password,
            }))
            .send()
            .await
            .context("Network request to auth center failed")?;

        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()).into());
        }

        let body: serde_json::Value = resp.json().await.context("login response is not JSON")?;
        let access_token = body["accessToken"]
            .as_str()
            .ok_or_else(|| CloudAuthError::BadResponse("accessToken missing".into()))?
            .to_string();
        let refresh_token = body["refreshToken"]
            .as_str()
            .ok_or_else(|| CloudAuthError::BadResponse("refreshToken missing".into()))?
            .to_string();
        let profile = parse_profile(&body["user"]).map_err(anyhow::Error::from)?;

        // expiresIn 缺省 15m 仅用于客户端续期调度（服务端 access token 实际
        // 有效期以签发为准），不是对用户展示的数据。
        let tokens = AuthTokens {
            access_token,
            refresh_token,
            expires_in: body["expiresIn"].as_u64().or(Some(900)),
        };
        Ok((tokens, profile))
    }

    /// 静默利用 Refresh Token 换取新 Access Token
    /// （T14：401 → `Unauthorized`，调用方须清除本地凭据；refreshToken 轮换缺失报错）
    pub async fn refresh_access_token(
        &self,
        refresh_token: &str,
    ) -> Result<AuthTokens, CloudAuthError> {
        let url = format!("{}/api/auth/refresh", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "refreshToken": refresh_token,
            }))
            .send()
            .await
            .map_err(|e| CloudAuthError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudAuthError::BadResponse(e.to_string()))?;
        let access_token = body["accessToken"]
            .as_str()
            .ok_or_else(|| CloudAuthError::BadResponse("accessToken missing".into()))?
            .to_string();
        let new_refresh_token = body["refreshToken"]
            .as_str()
            .ok_or_else(|| CloudAuthError::BadResponse("refreshToken missing".into()))?
            .to_string();

        Ok(AuthTokens {
            access_token,
            refresh_token: new_refresh_token,
            expires_in: body["expiresIn"].as_u64().or(Some(900)),
        })
    }

    /// 拉取当前登录用户的真实档案（`GET /api/auth/me`；T12 恢复会话的唯一档案来源）
    pub async fn me(&self, access_token: &str) -> Result<UserProfile, CloudAuthError> {
        let url = format!("{}/api/auth/me", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| CloudAuthError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudAuthError::BadResponse(e.to_string()))?;
        parse_profile(&body["user"])
    }

    /// 查询用户绑定的全部设备列表（`GET /api/devices` → `{ items }`，服务端已核对）
    pub async fn list_devices(
        &self,
        access_token: &str,
    ) -> Result<Vec<CloudDeviceItem>, CloudAuthError> {
        let url = format!("{}/api/devices", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| CloudAuthError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| CloudAuthError::BadResponse(e.to_string()))?;
        let items = body["items"]
            .as_array()
            .ok_or_else(|| CloudAuthError::BadResponse("items missing".into()))?;

        let mut devices = Vec::new();
        for item in items {
            if let Ok(dev) = serde_json::from_value::<CloudDeviceItem>(item.clone()) {
                devices.push(dev);
            }
        }
        Ok(devices)
    }

    /// 撤销/踢出指定设备（`DELETE /api/devices/:id`）
    pub async fn revoke_device(
        &self,
        access_token: &str,
        device_id: &str,
    ) -> Result<(), CloudAuthError> {
        let url = format!("{}/api/devices/{}", self.base_url, device_id);
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| CloudAuthError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }
        Ok(())
    }

    /// 申请 Host 驻留中继票据。
    ///
    /// **诚实边界（2026-09-06 核对）**：生产 auth 服务尚未实现该路由（404）。
    /// 保留方法以钉住契约路径；错误（含 404）如实上抛，禁止伪造 relayUrl。
    pub async fn get_host_relay_ticket(
        &self,
        access_token: &str,
        device_id: &str,
    ) -> Result<RelayTicketResponse, CloudAuthError> {
        let url = format!("{}/api/relay/ticket/host", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "deviceId": device_id,
            }))
            .send()
            .await
            .map_err(|e| CloudAuthError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }

        let res: RelayTicketResponse = resp
            .json()
            .await
            .map_err(|e| CloudAuthError::BadResponse(e.to_string()))?;
        Ok(res)
    }
}
