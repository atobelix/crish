//! `CloudAuthClient` —— 云端账号服务 HTTP 客户端实现体。
//!
//! 由 `auth/client.rs` 拆分而来（仅移动代码，方法体零改动）：服务端契约、
//! 错误 / 场景 / DTO 定义与解析辅助仍留在父模块 `auth::client`，本模块只承载
//! 请求发送逻辑；对外公开路径保持 `auth::client::CloudAuthClient`。

use anyhow::{Context, Result};
use reqwest::Client;
use std::time::Duration;

use super::{
    auth_error_for_status, parse_profile, parse_session_body, response_error, urlencode,
    AccountProfile, AuthSessionInfo, AuthTokens, CloudAuthError, EmailCodeScene, EmailCodeTicket,
    EmailSetupToken, PasswordCodeScene, UserProfile, DEFAULT_AUTH_BASE_URL,
};

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
        device_id: &str,
        device_name: &str,
    ) -> Result<(AuthTokens, UserProfile)> {
        let url = format!("{}/api/auth/email/login/password", self.base_url);
        let resp = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "email": email,
                "password": password,
                "deviceId": device_id,
                "deviceName": device_name,
            }))
            .send()
            .await
            .context("Network request to auth center failed")?;

        if !resp.status().is_success() {
            return Err(response_error(resp).await.into());
        }

        let body: serde_json::Value = resp.json().await.context("login response is not JSON")?;
        parse_session_body(&body).map_err(anyhow::Error::from)
    }

    /// 请求邮件验证码（登录 / 注册 / 重置密码）。注册与重置需要同时提交密码。
    pub async fn request_email_code(
        &self,
        scene: EmailCodeScene,
        email: &str,
        password: Option<&str>,
    ) -> Result<EmailCodeTicket, CloudAuthError> {
        let mut body = serde_json::json!({ "email": email });
        if let Some(password) = password {
            body["password"] = serde_json::Value::String(password.to_string());
        }
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, scene.request_path()))
            .json(&body)
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        resp.json::<EmailCodeTicket>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 校验邮件验证码并创建会话（登录 / 注册 / 重置密码）。
    pub async fn confirm_email_code(
        &self,
        scene: EmailCodeScene,
        email: &str,
        code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<(AuthTokens, UserProfile), CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, scene.confirm_path()))
            .json(&serde_json::json!({
                "email": email,
                "code": code,
                "deviceId": device_id,
                "deviceName": device_name,
            }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))?;
        parse_session_body(&body)
    }

    /// 先码后密码 · 发码（注册 / 重置；只带 email，不带密码）。
    pub async fn request_password_code(
        &self,
        scene: PasswordCodeScene,
        email: &str,
    ) -> Result<EmailCodeTicket, CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}{}", self.base_url, scene.request_path()))
            .json(&serde_json::json!({ "email": email }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        resp.json::<EmailCodeTicket>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 校验验证码换取 setup token（不建立会话）。
    pub async fn verify_email_code(
        &self,
        scene: PasswordCodeScene,
        email: &str,
        code: &str,
    ) -> Result<EmailSetupToken, CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/email/code/verify", self.base_url))
            .json(&serde_json::json!({
                "email": email,
                "code": code,
                "scene": scene.verify_scene(),
            }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        resp.json::<EmailSetupToken>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 凭 setup token 设置密码并建立会话（注册 / 重置）。
    pub async fn set_password_with_setup_token(
        &self,
        setup_token: &str,
        password: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<(AuthTokens, UserProfile), CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/email/password/set", self.base_url))
            .json(&serde_json::json!({
                "setupToken": setup_token,
                "password": password,
                "deviceId": device_id,
                "deviceName": device_name,
            }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))?;
        parse_session_body(&body)
    }

    /// 已登录修改密码 · 向绑定邮箱发验证码（空请求体）。
    pub async fn request_password_change_code(
        &self,
        access_token: &str,
    ) -> Result<EmailCodeTicket, CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/password/change/request", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        resp.json::<EmailCodeTicket>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 已登录修改密码 · 凭验证码改密（撤销其他会话，保留当前会话）。
    pub async fn change_password(
        &self,
        access_token: &str,
        code: &str,
        new_password: &str,
    ) -> Result<(), CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/password/change/confirm", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "code": code,
                "newPassword": new_password,
                "revokeOtherSessions": true,
            }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        Ok(())
    }

    /// 注销账号（服务端要求确认邮箱；成功后账号匿名化、全部会话吊销）。
    pub async fn delete_account(
        &self,
        access_token: &str,
        confirm_email: &str,
    ) -> Result<(), CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/account/delete", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({ "confirmEmail": confirm_email }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        Ok(())
    }

    /// 服务端登出（吊销 refresh token；失败不阻断本地清理）。
    pub async fn logout_remote(&self, refresh_token: &str) -> Result<(), CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/logout", self.base_url))
            .json(&serde_json::json!({ "refreshToken": refresh_token }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() && resp.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Err(auth_error_for_status(resp.status()));
        }
        Ok(())
    }

    /// 账号资料（昵称 / 头像 / 简介）。
    pub async fn get_profile(&self, access_token: &str) -> Result<AccountProfile, CloudAuthError> {
        let resp = self
            .http
            .get(format!("{}/api/auth/profile", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }
        resp.json::<AccountProfile>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 更新昵称 / 简介（未提供的字段保持不变）。
    pub async fn update_profile(
        &self,
        access_token: &str,
        display_name: Option<&str>,
        bio: Option<&str>,
    ) -> Result<AccountProfile, CloudAuthError> {
        let mut body = serde_json::Map::new();
        if let Some(display_name) = display_name {
            body.insert(
                "displayName".to_string(),
                serde_json::Value::String(display_name.to_string()),
            );
        }
        if let Some(bio) = bio {
            body.insert(
                "bio".to_string(),
                serde_json::Value::String(bio.to_string()),
            );
        }
        let resp = self
            .http
            .patch(format!("{}/api/auth/profile", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::Value::Object(body))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        resp.json::<AccountProfile>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 上传头像（data URL；账号中心限制 3 MiB 的 png/jpeg/webp/gif）。
    pub async fn upload_avatar(
        &self,
        access_token: &str,
        data_url: &str,
        file_name: Option<&str>,
    ) -> Result<AccountProfile, CloudAuthError> {
        let resp = self
            .http
            .post(format!("{}/api/auth/profile/avatar", self.base_url))
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "dataUrl": data_url,
                "fileName": file_name,
            }))
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        resp.json::<AccountProfile>()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 当前账号的登录会话列表（含当前会话标记）。
    pub async fn list_sessions(
        &self,
        access_token: &str,
    ) -> Result<Vec<AuthSessionInfo>, CloudAuthError> {
        let resp = self
            .http
            .get(format!("{}/api/auth/sessions", self.base_url))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(auth_error_for_status(resp.status()));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|error| CloudAuthError::BadResponse(error.to_string()))?;
        serde_json::from_value::<Vec<AuthSessionInfo>>(
            body.get("sessions").cloned().unwrap_or_default(),
        )
        .map_err(|error| CloudAuthError::BadResponse(error.to_string()))
    }

    /// 撤销指定登录会话。
    pub async fn revoke_session(
        &self,
        access_token: &str,
        session_id: &str,
    ) -> Result<(), CloudAuthError> {
        let resp = self
            .http
            .delete(format!(
                "{}/api/auth/sessions/{}",
                self.base_url,
                urlencode(session_id)
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| CloudAuthError::Network(error.to_string()))?;
        if !resp.status().is_success() {
            return Err(response_error(resp).await);
        }
        Ok(())
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
}
