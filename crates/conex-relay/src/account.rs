//! 账号中心只读验证：兑换中继票据前，用用户 access token 校验账号身份。
//!
//! 只调用既有 REST 面 `GET /api/auth/me`（生产账号中心未提供设备注册表）。
//! 中继的房间隔离边界是 `(account_id, host_device_id)`，票据只会签发给同一
//! 账号；device id 只是账号内部的路由标识，不属于跨账号安全边界。
//!
//! 不把 access token 写入日志；缓存键是 token 的 SHA-256，缓存 TTL 60s，
//! 避免同一连接短时间反复打账号中心。

use async_trait::async_trait;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AccountError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("network: {0}")]
    Network(String),
    #[error("bad response: {0}")]
    BadResponse(String),
}

#[async_trait]
pub trait AccountVerifier: Send + Sync {
    /// 校验 access token 并返回账号 id（失败一律 fail-closed）。
    async fn account_id(&self, access_token: &str) -> Result<String, AccountError>;
}

#[derive(Clone)]
struct CachedAccount {
    account_id: String,
    fetched_at: Instant,
}

/// 真实账号中心验证器（带短 TTL 缓存）。
pub struct HttpAccountVerifier {
    http: reqwest::Client,
    base_url: String,
    cache_ttl: Duration,
    cache: Mutex<HashMap<String, CachedAccount>>,
}

impl HttpAccountVerifier {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default();
        Self {
            http,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            cache_ttl: Duration::from_secs(60),
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn cache_key(token: &str) -> String {
        hex::encode(Sha256::digest(token.as_bytes()))
    }

    fn cached(&self, key: &str) -> Option<String> {
        let guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = guard.get(key)?;
        if entry.fetched_at.elapsed() <= self.cache_ttl {
            Some(entry.account_id.clone())
        } else {
            None
        }
    }

    fn store(&self, key: String, account_id: String) {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() > 512 {
            guard.retain(|_, entry| entry.fetched_at.elapsed() <= self.cache_ttl);
        }
        guard.insert(
            key,
            CachedAccount {
                account_id,
                fetched_at: Instant::now(),
            },
        );
    }

    async fn fetch_me(&self, token: &str) -> Result<Value, AccountError> {
        let response = self
            .http
            .get(format!("{}/api/auth/me", self.base_url))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AccountError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(AccountError::Network(format!(
                "auth center HTTP {}",
                response.status()
            )));
        }
        response
            .json::<Value>()
            .await
            .map_err(|e| AccountError::BadResponse(e.to_string()))
    }
}

#[async_trait]
impl AccountVerifier for HttpAccountVerifier {
    async fn account_id(&self, access_token: &str) -> Result<String, AccountError> {
        let key = Self::cache_key(access_token);
        if let Some(account_id) = self.cached(&key) {
            return Ok(account_id);
        }
        let me = self.fetch_me(access_token).await?;
        let account_id = parse_account_id(&me)?;
        self.store(key, account_id.clone());
        Ok(account_id)
    }
}

fn parse_account_id(me: &Value) -> Result<String, AccountError> {
    let user = me.get("user").unwrap_or(me);
    user.get("id")
        .and_then(Value::as_str)
        .or_else(|| user.get("accountId").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AccountError::BadResponse("user id missing".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_nested_and_flat_user() {
        assert_eq!(
            parse_account_id(&json!({ "user": { "id": "acc-1" } })).expect("nested"),
            "acc-1"
        );
        assert_eq!(
            parse_account_id(&json!({ "accountId": "acc-2" })).expect("flat"),
            "acc-2"
        );
    }

    #[test]
    fn rejects_missing_user_id() {
        assert!(matches!(
            parse_account_id(&json!({ "user": {} })),
            Err(AccountError::BadResponse(_))
        ));
    }
}
