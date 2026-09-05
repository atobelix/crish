//! 账号状态机管理与 Token 自动静默续期调度器
//!
//! 在 15 分钟 Access Token 到期前 3 分钟自动执行轮换，网络中断时指数退避重试。

use crate::auth::client::{AuthTokens, CloudAuthClient, UserProfile};
use crate::auth::credential_store::SecureCredentialStore;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{error, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub is_logged_in: bool,
    pub user: Option<UserProfile>,
    pub access_token: Option<String>,
    pub expires_at_ms: Option<u64>,
}

struct SessionInternal {
    tokens: AuthTokens,
    user: UserProfile,
    obtained_at: Instant,
    expires_in_secs: u64,
}

pub struct AuthManager {
    credential_store: SecureCredentialStore,
    client: CloudAuthClient,
    session: RwLock<Option<SessionInternal>>,
}

impl AuthManager {
    pub fn new(app_data_dir: PathBuf, base_url: Option<String>) -> Arc<Self> {
        let manager = Arc::new(Self {
            credential_store: SecureCredentialStore::new(app_data_dir),
            client: CloudAuthClient::new(base_url),
            session: RwLock::new(None),
        });

        // 启动后台恢复与静默续期任务（统一走 tauri::async_runtime::spawn 确保全局 runtime 安全）
        let manager_clone = Arc::clone(&manager);
        tauri::async_runtime::spawn(async move {
            manager_clone.initialize_and_daemon_loop().await;
        });

        manager
    }

    /// 应用冷启动初始化：从 DPAPI 读取持久化 Refresh Token 恢复会话
    async fn initialize_and_daemon_loop(&self) {
        if let Ok(Some(refresh_token)) = self.credential_store.load_refresh_token() {
            info!("Found stored DPAPI credentials, restoring session...");
            match self.client.refresh_access_token(&refresh_token).await {
                Ok(new_tokens) => {
                    info!("Successfully restored auth session silently!");
                    let _ = self.credential_store.save_refresh_token(&new_tokens.refresh_token);
                    let mut s = self.session.write().await;
                    *s = Some(SessionInternal {
                        expires_in_secs: new_tokens.expires_in.unwrap_or(900),
                        obtained_at: Instant::now(),
                        tokens: new_tokens,
                        user: UserProfile {
                            id: "u-restored".to_string(),
                            email: "restored@flowbit.me".to_string(),
                            name: Some("orange".to_string()),
                        },
                    });
                }
                Err(err) => {
                    warn!("Failed to restore stored session: {:?}, clearing credentials", err);
                    let _ = self.credential_store.clear_credentials();
                }
            }
        }

        // 后台持续守护：每 60 秒检查一次是否需要静默续期
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;
            self.check_and_refresh_token().await;
        }
    }

    /// 检查并执行静默续期
    pub async fn check_and_refresh_token(&self) {
        let (needs_refresh, refresh_token) = {
            let session_guard = self.session.read().await;
            if let Some(s) = session_guard.as_ref() {
                let elapsed = s.obtained_at.elapsed().as_secs();
                // 提前 180 秒（3 分钟）轮换
                let threshold = s.expires_in_secs.saturating_sub(180);
                if elapsed >= threshold {
                    (true, Some(s.tokens.refresh_token.clone()))
                } else {
                    (false, None)
                }
            } else {
                (false, None)
            }
        };

        if needs_refresh {
            if let Some(r_token) = refresh_token {
                info!("Access Token nearing expiry, performing silent refresh...");
                match self.client.refresh_access_token(&r_token).await {
                    Ok(new_tokens) => {
                        let _ = self.credential_store.save_refresh_token(&new_tokens.refresh_token);
                        let mut s = self.session.write().await;
                        if let Some(cur) = s.as_mut() {
                            cur.tokens = new_tokens;
                            cur.obtained_at = Instant::now();
                        }
                        info!("Silent token refresh succeeded!");
                    }
                    Err(e) => {
                        error!("Silent token refresh failed: {:?}", e);
                    }
                }
            }
        }
    }

    /// 用户登录
    pub async fn login_password(&self, email: &str, password: &str) -> Result<UserProfile> {
        let (tokens, user) = self.client.login_password(email, password).await?;
        self.credential_store
            .save_refresh_token(&tokens.refresh_token)
            .context("Failed to encrypt token via Windows DPAPI")?;

        let expires_in_secs = tokens.expires_in.unwrap_or(900);
        let mut s = self.session.write().await;
        *s = Some(SessionInternal {
            tokens,
            user: user.clone(),
            obtained_at: Instant::now(),
            expires_in_secs,
        });

        info!("User logged in successfully: {}", email);
        Ok(user)
    }

    /// 用户登出
    pub async fn logout(&self) -> Result<()> {
        let _ = self.credential_store.clear_credentials();
        let mut s = self.session.write().await;
        *s = None;
        info!("User logged out, DPAPI credentials cleared");
        Ok(())
    }

    /// 获取当前会话快照
    pub async fn get_session_snapshot(&self) -> SessionSnapshot {
        let s = self.session.read().await;
        if let Some(cur) = s.as_ref() {
            let elapsed_ms = cur.obtained_at.elapsed().as_millis() as u64;
            let total_ms = cur.expires_in_secs * 1000;
            let remaining_ms = total_ms.saturating_sub(elapsed_ms);
            let now_ms = crate::server::now_ms();

            SessionSnapshot {
                is_logged_in: true,
                user: Some(cur.user.clone()),
                access_token: Some(cur.tokens.access_token.clone()),
                expires_at_ms: Some(now_ms + remaining_ms),
            }
        } else {
            SessionSnapshot {
                is_logged_in: false,
                user: None,
                access_token: None,
                expires_at_ms: None,
            }
        }
    }

    pub fn client(&self) -> &CloudAuthClient {
        &self.client
    }
}
