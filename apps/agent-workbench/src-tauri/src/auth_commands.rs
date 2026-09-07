//! 桌面端用户账号与云端设备管理 IPC 命令面
//!
//! 供 React 前端（SettingsProfileTab / UserProfileCard）真实调用，拒绝伪实现。

use std::sync::Arc;
use tauri::State;

use crate::auth::{AuthManager, CloudDeviceItem, RelayTicketResponse, SessionSnapshot, UserProfile};

/// 账号密码登录
#[tauri::command]
pub async fn auth_login(
    auth_mgr: State<'_, Arc<AuthManager>>,
    email: String,
    password: String,
) -> Result<UserProfile, String> {
    auth_mgr
        .login_password(&email, &password)
        .await
        .map_err(|e| e.to_string())
}

/// 退出登录并清除系统凭据
#[tauri::command]
pub async fn auth_logout(auth_mgr: State<'_, Arc<AuthManager>>) -> Result<(), String> {
    auth_mgr.logout().await.map_err(|e| e.to_string())
}

/// 获取当前登录态快照（含用户信息、有效期、是否登录）
#[tauri::command]
pub async fn auth_get_session(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<SessionSnapshot, String> {
    Ok(auth_mgr.get_session_snapshot().await)
}

/// 手动触发 Token 静默续期
#[tauri::command]
pub async fn auth_refresh_token(auth_mgr: State<'_, Arc<AuthManager>>) -> Result<bool, String> {
    // RefreshOutcome 只驱动守护循环退避；命令面仅回报登录态是否仍然有效
    let _outcome = auth_mgr.check_and_refresh_token().await;
    let s = auth_mgr.get_session_snapshot().await;
    Ok(s.is_logged_in)
}

/// 获取名下云端已绑定的全部设备列表
#[tauri::command]
pub async fn auth_list_devices(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<Vec<CloudDeviceItem>, String> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(|| "Not logged in".to_string())?;

    auth_mgr
        .client()
        .list_devices(&token)
        .await
        .map_err(|e| e.to_string())
}

/// 踢出 / 撤销指定设备
#[tauri::command]
pub async fn auth_revoke_device(
    auth_mgr: State<'_, Arc<AuthManager>>,
    device_id: String,
) -> Result<(), String> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(|| "Not logged in".to_string())?;

    auth_mgr
        .client()
        .revoke_device(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}

/// 申请 Host 驻留中继票据
#[tauri::command]
pub async fn auth_get_relay_ticket(
    auth_mgr: State<'_, Arc<AuthManager>>,
    device_id: String,
) -> Result<RelayTicketResponse, String> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(|| "Not logged in".to_string())?;

    auth_mgr
        .client()
        .get_host_relay_ticket(&token, &device_id)
        .await
        .map_err(|e| e.to_string())
}
