//! 云端账号服务 HTTP 客户端
//!
//! 真实对接用户阿里云首尔服务器 Fastify + SQLite 账号中心 (auth.flowbit.me)。

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_AUTH_BASE_URL: &str = "https://auth.flowbit.me";

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
            base_url: base_url.unwrap_or_else(|| DEFAULT_AUTH_BASE_URL.to_string()),
        }
    }

    /// 账号密码登录
    pub async fn login_password(&self, email: &str, password: &str) -> Result<(AuthTokens, UserProfile)> {
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
            let err_body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Login failed: {}", err_body));
        }

        let body: serde_json::Value = resp.json().await?;
        let access_token = body["accessToken"]
            .as_str()
            .or_else(|| body["token"].as_str())
            .ok_or_else(|| anyhow!("Missing accessToken in response"))?
            .to_string();

        let refresh_token = body["refreshToken"]
            .as_str()
            .unwrap_or(&access_token)
            .to_string();

        let user_id = body["user"]["id"]
            .as_str()
            .or_else(|| body["accountId"].as_str())
            .unwrap_or("u-default")
            .to_string();

        let user_email = body["user"]["email"]
            .as_str()
            .unwrap_or(email)
            .to_string();

        let user_name = body["user"]["name"]
            .as_str()
            .map(|s| s.to_string());

        let tokens = AuthTokens {
            access_token,
            refresh_token,
            expires_in: body["expiresIn"].as_u64().or(Some(900)), // 默认 15m
        };

        let profile = UserProfile {
            id: user_id,
            email: user_email,
            name: user_name,
        };

        Ok((tokens, profile))
    }

    /// 静默利用 Refresh Token 换取新 Access Token
    pub async fn refresh_access_token(&self, refresh_token: &str) -> Result<AuthTokens> {
        let url = format!("{}/api/auth/refresh", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "refreshToken": refresh_token,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("Refresh token expired or revoked"));
        }

        let body: serde_json::Value = resp.json().await?;
        let access_token = body["accessToken"]
            .as_str()
            .or_else(|| body["token"].as_str())
            .ok_or_else(|| anyhow!("Missing new accessToken"))?
            .to_string();

        let new_refresh_token = body["refreshToken"]
            .as_str()
            .unwrap_or(refresh_token)
            .to_string();

        Ok(AuthTokens {
            access_token,
            refresh_token: new_refresh_token,
            expires_in: body["expiresIn"].as_u64().or(Some(900)),
        })
    }

    /// 查询用户绑定的全部设备列表
    pub async fn list_devices(&self, access_token: &str) -> Result<Vec<CloudDeviceItem>> {
        let url = format!("{}/api/devices", self.base_url);
        let resp = self
            .http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("Failed to list devices"));
        }

        let body: serde_json::Value = resp.json().await?;
        let items = body["items"].as_array().ok_or_else(|| anyhow!("Invalid devices response"))?;

        let mut devices = Vec::new();
        for item in items {
            if let Ok(dev) = serde_json::from_value::<CloudDeviceItem>(item.clone()) {
                devices.push(dev);
            }
        }
        Ok(devices)
    }

    /// 撤销/踢出指定设备
    pub async fn revoke_device(&self, access_token: &str, device_id: &str) -> Result<()> {
        let url = format!("{}/api/devices/{}", self.base_url, device_id);
        let resp = self
            .http
            .delete(&url)
            .bearer_auth(access_token)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("Failed to revoke device {}", device_id));
        }
        Ok(())
    }

    /// 申请 Host 驻留中继票据
    pub async fn get_host_relay_ticket(&self, access_token: &str, device_id: &str) -> Result<RelayTicketResponse> {
        let url = format!("{}/api/relay/ticket/host", self.base_url);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "deviceId": device_id,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow!("Failed to acquire host relay ticket"));
        }

        let res: RelayTicketResponse = resp.json().await?;
        Ok(res)
    }
}
