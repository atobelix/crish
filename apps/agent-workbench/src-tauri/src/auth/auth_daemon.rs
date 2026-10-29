//! 账号状态机管理与 Token 自动静默续期调度器（audit-repair-202609 · T12/T14 重写）
//!
//! 纪律（对照历史伪实现逐条钉死）：
//! 1. **恢复会话取真实档案**：refresh 成功后经 `GET /api/auth/me` 拉取服务端
//!    档案；档案缺失（网络失败）时 `user=None` 由守护循环每轮重试——**禁止**
//!    伪造 `u-restored / restored@flowbit.me / orange` 之类默认身份。
//! 2. **真指数退避**：refresh 失败按 60s → ×2 → 封顶 900s 退避；成功复位 60s。
//! 3. **401 即清凭据**：refresh 返回 Unauthorized（token 吊销 / 过期）时立刻
//!    清除本地凭据并置空会话，禁止无限重试死 token。
//!
//! 档案唯一真源 = 云端服务；本地只持久化 refresh token（DPAPI）。

use crate::auth::client::{
    AccountProfile, AuthSessionInfo, AuthTokens, CloudAuthClient, CloudAuthError, EmailCodeScene,
    EmailCodeTicket, PasswordCodeScene, UserProfile,
};
use crate::auth::credential_store::SecureCredentialStore;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{watch, RwLock};
use tracing::{error, info, warn};

/// 静默续期的基础间隔（成功 / 空闲检查周期）
const REFRESH_CHECK_BASE_SECS: u64 = 60;
/// 退避封顶（15 分钟）
const REFRESH_BACKOFF_CAP_SECS: u64 = 900;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub is_logged_in: bool,
    pub user: Option<UserProfile>,
    pub access_token: Option<String>,
    pub expires_at_ms: Option<u64>,
}

struct SessionInternal {
    tokens: AuthTokens,
    /// 真实档案（来自 /api/auth/me）；恢复期网络失败时为 None，由循环重试补齐
    user: Option<UserProfile>,
    obtained_at: Instant,
    expires_in_secs: u64,
}

pub struct AuthManager {
    credential_store: SecureCredentialStore,
    client: CloudAuthClient,
    session: RwLock<Option<SessionInternal>>,
    /// 冷启动凭据恢复完成信号：命令面等待首次恢复结束再返回会话快照，
    /// 避免前端在恢复前读到 is_logged_in=false 后不再刷新。
    restored: watch::Sender<bool>,
}

impl AuthManager {
    pub fn new(app_data_dir: PathBuf, base_url: Option<String>) -> Arc<Self> {
        let (restored, _) = watch::channel(false);
        let manager = Arc::new(Self {
            credential_store: SecureCredentialStore::new(app_data_dir),
            client: CloudAuthClient::new(base_url),
            session: RwLock::new(None),
            restored,
        });

        // 启动后台恢复与静默续期任务（统一走 tauri::async_runtime::spawn 确保全局 runtime 安全）
        let manager_clone = Arc::clone(&manager);
        tauri::async_runtime::spawn(async move {
            manager_clone.restore_then_daemon_loop().await;
        });

        manager
    }

    /// 应用冷启动：DPAPI 恢复 refresh token → 静默续期 → 拉真实档案 → 进入守护循环
    async fn restore_then_daemon_loop(&self) {
        self.restore_persisted_session().await;
        let _ = self.restored.send(true);
        self.daemon_loop().await;
    }

    /// 等待冷启动凭据恢复完成（首次完成后立即返回）。
    pub async fn wait_restored(&self) {
        let mut rx = self.restored.subscribe();
        if *rx.borrow_and_update() {
            return;
        }
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// 冷启动恢复：成功后档案经 /me 真实拉取；失败区分 401（清凭据）与网络错误
    async fn restore_persisted_session(&self) {
        let refresh_token = match self.credential_store.load_refresh_token() {
            Ok(Some(token)) => token,
            Ok(None) => return,
            Err(err) => {
                warn!("Failed to load DPAPI credentials: {err:#}");
                return;
            }
        };

        info!("Found stored credentials, restoring session silently...");
        match self.client.refresh_access_token(&refresh_token).await {
            Ok(new_tokens) => {
                if let Err(err) = self
                    .credential_store
                    .save_refresh_token(&new_tokens.refresh_token)
                {
                    warn!("Failed to persist rotated refresh token: {err:#}");
                }
                // 真实档案：/api/auth/me（唯一来源；失败置 None 由循环重试）
                let user = match self.client.me(&new_tokens.access_token).await {
                    Ok(profile) => {
                        info!("Restored auth session for {}", profile.email);
                        Some(profile)
                    }
                    Err(err) => {
                        warn!("Session restored but profile fetch failed (will retry): {err}");
                        None
                    }
                };
                let mut s = self.session.write().await;
                *s = Some(SessionInternal {
                    expires_in_secs: new_tokens.expires_in.unwrap_or(900),
                    obtained_at: Instant::now(),
                    tokens: new_tokens,
                    user,
                });
            }
            Err(CloudAuthError::Unauthorized) => {
                // token 已吊销 / 过期：清凭据，不得保留死会话
                warn!("Stored refresh token rejected (revoked or expired); clearing credentials");
                let _ = self.credential_store.clear_credentials();
            }
            Err(err) => {
                // 网络失败：保留凭据，下次循环重试
                warn!("Failed to restore stored session (will retry): {err}");
            }
        }
    }

    /// 后台守护：按指数退避节奏检查续期 + 补齐缺失档案
    async fn daemon_loop(&self) {
        let mut backoff_secs = REFRESH_CHECK_BASE_SECS;
        loop {
            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;

            match self.check_and_refresh_token().await {
                RefreshOutcome::Idle | RefreshOutcome::Refreshed => {
                    backoff_secs = REFRESH_CHECK_BASE_SECS;
                }
                RefreshOutcome::TokenRejected => {
                    // 401 已在 check 内清凭据；回到基础周期（空转检查）
                    backoff_secs = REFRESH_CHECK_BASE_SECS;
                }
                RefreshOutcome::TransientFailure => {
                    backoff_secs = (backoff_secs * 2).min(REFRESH_BACKOFF_CAP_SECS);
                    info!(backoff_secs, "refresh failed; backing off");
                }
            }
        }
    }

    /// 检查并执行静默续期 + 档案补齐
    pub async fn check_and_refresh_token(&self) -> RefreshOutcome {
        let (needs_refresh, refresh_token) = {
            let session_guard = self.session.read().await;
            match session_guard.as_ref() {
                Some(s) => {
                    let elapsed = s.obtained_at.elapsed().as_secs();
                    // 提前 180 秒（3 分钟）轮换
                    let threshold = s.expires_in_secs.saturating_sub(180);
                    if elapsed >= threshold {
                        (true, Some(s.tokens.refresh_token.clone()))
                    } else {
                        (false, None)
                    }
                }
                None => (false, None),
            }
        };

        if needs_refresh {
            if let Some(r_token) = refresh_token {
                info!("Access Token nearing expiry, performing silent refresh...");
                return match self.client.refresh_access_token(&r_token).await {
                    Ok(new_tokens) => {
                        if let Err(err) = self
                            .credential_store
                            .save_refresh_token(&new_tokens.refresh_token)
                        {
                            warn!("Failed to persist rotated refresh token: {err:#}");
                        }
                        let mut s = self.session.write().await;
                        if let Some(cur) = s.as_mut() {
                            cur.tokens = new_tokens;
                            cur.obtained_at = Instant::now();
                        }
                        drop(s);
                        info!("Silent token refresh succeeded");
                        // 顺手补齐缺失档案（恢复期网络失败的场景）
                        self.ensure_user_profile().await;
                        RefreshOutcome::Refreshed
                    }
                    Err(CloudAuthError::Unauthorized) => {
                        error!("Refresh token rejected (revoked or expired); clearing credentials");
                        let _ = self.credential_store.clear_credentials();
                        let mut s = self.session.write().await;
                        *s = None;
                        RefreshOutcome::TokenRejected
                    }
                    Err(err) => {
                        error!("Silent token refresh failed: {err}");
                        RefreshOutcome::TransientFailure
                    }
                };
            }
        }

        // 未到续期窗口：档案缺失时尝试补齐（不驱动退避）
        self.ensure_user_profile().await;
        RefreshOutcome::Idle
    }

    /// 档案补齐：已登录但 user=None 时经 /api/auth/me 拉取真实档案
    async fn ensure_user_profile(&self) {
        let needs_profile = {
            let s = self.session.read().await;
            matches!(s.as_ref(), Some(cur) if cur.user.is_none())
        };
        if !needs_profile {
            return;
        }
        let access_token = {
            let s = self.session.read().await;
            s.as_ref().map(|cur| cur.tokens.access_token.clone())
        };
        if let Some(token) = access_token {
            match self.client.me(&token).await {
                Ok(profile) => {
                    info!("User profile fetched: {}", profile.email);
                    let mut s = self.session.write().await;
                    if let Some(cur) = s.as_mut() {
                        cur.user = Some(profile);
                    }
                }
                Err(err) => {
                    warn!("Profile fetch still failing (will retry): {err}");
                }
            }
        }
    }

    /// 用户登录（密码）
    pub async fn login_password(
        &self,
        email: &str,
        password: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<UserProfile> {
        // 冷启动恢复与手动登录串行化，避免旧会话覆盖新登录
        self.wait_restored().await;
        let (tokens, user) = self
            .client
            .login_password(email, password, device_id, device_name)
            .await?;
        self.apply_session(tokens, user.clone(), email).await?;
        Ok(user)
    }

    /// 用户登录（邮件验证码）
    pub async fn login_email_code(
        &self,
        email: &str,
        code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<UserProfile> {
        self.wait_restored().await;
        let (tokens, user) = self
            .client
            .confirm_email_code(EmailCodeScene::Login, email, code, device_id, device_name)
            .await?;
        self.apply_session(tokens, user.clone(), email).await?;
        Ok(user)
    }

    /// 注册并直接建立会话
    pub async fn register_email(
        &self,
        email: &str,
        code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<UserProfile> {
        self.wait_restored().await;
        let (tokens, user) = self
            .client
            .confirm_email_code(EmailCodeScene::Register, email, code, device_id, device_name)
            .await?;
        self.apply_session(tokens, user.clone(), email).await?;
        Ok(user)
    }

    /// 重置密码并直接建立会话
    pub async fn reset_password(
        &self,
        email: &str,
        code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<UserProfile> {
        self.wait_restored().await;
        let (tokens, user) = self
            .client
            .confirm_email_code(EmailCodeScene::Reset, email, code, device_id, device_name)
            .await?;
        self.apply_session(tokens, user.clone(), email).await?;
        Ok(user)
    }

    /// 请求邮件验证码（无会话副作用）
    pub async fn request_email_code(
        &self,
        scene: EmailCodeScene,
        email: &str,
        password: Option<&str>,
    ) -> Result<EmailCodeTicket> {
        self.client
            .request_email_code(scene, email, password)
            .await
            .map_err(Into::into)
    }

    /// 先码后密码 · 发送验证码（已登录的重置改走改密接口，不建立会话）。
    pub async fn request_password_code(
        &self,
        scene: PasswordCodeScene,
        email: &str,
    ) -> Result<EmailCodeTicket> {
        self.wait_restored().await;
        if scene == PasswordCodeScene::Reset {
            if let Some(token) = self.access_token().await {
                return self
                    .client
                    .request_password_change_code(&token)
                    .await
                    .map_err(Into::into);
            }
        }
        self.client
            .request_password_code(scene, email)
            .await
            .map_err(Into::into)
    }

    /// 先码后密码 · 凭码设置新密码（注册 / 重置）。
    /// 已登录的重置走改密接口（保留当前会话）；其余场景校验验证码后设密并建立会话。
    pub async fn set_password_with_code(
        &self,
        scene: PasswordCodeScene,
        email: &str,
        code: &str,
        password: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<UserProfile> {
        self.wait_restored().await;
        if scene == PasswordCodeScene::Reset {
            if let Some(token) = self.access_token().await {
                let current_user = {
                    let session = self.session.read().await;
                    session.as_ref().and_then(|current| current.user.clone())
                };
                self.client.change_password(&token, code, password).await?;
                return match current_user {
                    Some(user) => Ok(user),
                    None => self.client.me(&token).await.map_err(Into::into),
                };
            }
        }
        let setup = self.client.verify_email_code(scene, email, code).await?;
        let (tokens, user) = self
            .client
            .set_password_with_setup_token(&setup.setup_token, password, device_id, device_name)
            .await?;
        self.apply_session(tokens, user.clone(), email).await?;
        Ok(user)
    }

    /// 注销账号：服务端校验确认邮箱后匿名化并吊销全部会话，随后清本地凭据。
    pub async fn delete_account(&self, confirm_email: &str) -> Result<()> {
        self.wait_restored().await;
        let token = self
            .access_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
        self.client.delete_account(&token, confirm_email).await?;
        let _ = self.credential_store.clear_credentials();
        *self.session.write().await = None;
        info!("Account deleted, local credentials cleared");
        Ok(())
    }

    async fn apply_session(
        &self,
        tokens: AuthTokens,
        user: UserProfile,
        email: &str,
    ) -> Result<()> {
        self.credential_store
            .save_refresh_token(&tokens.refresh_token)
            .context("Failed to encrypt token via Windows DPAPI")?;
        let expires_in_secs = tokens.expires_in.unwrap_or(900);
        let mut session = self.session.write().await;
        *session = Some(SessionInternal {
            tokens,
            user: Some(user),
            obtained_at: Instant::now(),
            expires_in_secs,
        });
        info!("User logged in successfully: {}", email);
        Ok(())
    }

    /// 用户登出（先尽力吊销服务端会话，再清理本地凭据）
    pub async fn logout(&self) -> Result<()> {
        self.wait_restored().await;
        let refresh_token = {
            let session = self.session.read().await;
            session
                .as_ref()
                .map(|current| current.tokens.refresh_token.clone())
        };
        if let Some(refresh_token) = refresh_token {
            if let Err(error) = self.client.logout_remote(&refresh_token).await {
                warn!("Remote logout failed (local credentials still cleared): {error}");
            }
        }
        let _ = self.credential_store.clear_credentials();
        let mut session = self.session.write().await;
        *session = None;
        info!("User logged out, DPAPI credentials cleared");
        Ok(())
    }

    /// 当前 access token（未登录返回 None）。
    async fn access_token(&self) -> Option<String> {
        let session = self.session.read().await;
        session
            .as_ref()
            .map(|current| current.tokens.access_token.clone())
    }

    pub async fn get_profile(&self) -> Result<AccountProfile> {
        let token = self
            .access_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
        self.client
            .get_profile(&token)
            .await
            .map_err(Into::into)
    }

    pub async fn update_profile(
        &self,
        display_name: Option<&str>,
        bio: Option<&str>,
    ) -> Result<AccountProfile> {
        let token = self
            .access_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
        let profile = self
            .client
            .update_profile(&token, display_name, bio)
            .await?;
        self.sync_profile_name(&profile.display_name).await;
        Ok(profile)
    }

    pub async fn upload_avatar(
        &self,
        data_url: &str,
        file_name: Option<&str>,
    ) -> Result<AccountProfile> {
        let token = self
            .access_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
        self.client
            .upload_avatar(&token, data_url, file_name)
            .await
            .map_err(Into::into)
    }

    pub async fn list_sessions(&self) -> Result<Vec<AuthSessionInfo>> {
        let token = self
            .access_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
        self.client
            .list_sessions(&token)
            .await
            .map_err(Into::into)
    }

    pub async fn revoke_session(&self, session_id: &str) -> Result<()> {
        let token = self
            .access_token()
            .await
            .ok_or_else(|| anyhow::anyhow!("Not logged in"))?;
        self.client
            .revoke_session(&token, session_id)
            .await
            .map_err(Into::into)
    }

    /// 资料改名后同步会话快照中的展示名（避免 UI 仍显示旧昵称）。
    async fn sync_profile_name(&self, display_name: &str) {
        let mut session = self.session.write().await;
        if let Some(current) = session.as_mut() {
            if let Some(user) = current.user.as_mut() {
                user.name = Some(display_name.to_string());
            }
        }
    }

    /// 获取当前会话快照（user 可能暂时为 None：恢复期档案尚未拉到，UI 须如实显示）
    pub async fn get_session_snapshot(&self) -> SessionSnapshot {
        self.wait_restored().await;
        let s = self.session.read().await;
        if let Some(cur) = s.as_ref() {
            let elapsed_ms = cur.obtained_at.elapsed().as_millis() as u64;
            let total_ms = cur.expires_in_secs * 1000;
            let remaining_ms = total_ms.saturating_sub(elapsed_ms);
            let now_ms = crate::server::now_ms();

            SessionSnapshot {
                is_logged_in: true,
                user: cur.user.clone(),
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

    }

/// 单次续期检查的结果（驱动守护循环退避节奏）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    /// 未到续期窗口 / 未登录
    Idle,
    /// 续期成功
    Refreshed,
    /// 401：token 已吊销，本地凭据已清除
    TokenRejected,
    /// 网络等临时失败（触发指数退避）
    TransientFailure,
}
