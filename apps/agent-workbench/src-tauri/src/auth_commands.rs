//! 桌面端用户账号与云端设备管理 IPC 命令面
//!
//! 供 React 前端（SettingsProfileTab / UserProfileCard）真实调用，拒绝伪实现。
//! 错误契约统一走 `CoreError`（PE-03 T03.3：命令面唯一错误类型）。

use std::sync::Arc;
use tauri::State;

use crate::auth::client::CloudAuthError;
use crate::auth::{
    AuthManager, CloudDeviceItem, RelayTicketResponse, SessionSnapshot, UserProfile,
};
use crate::core_error::CoreError;

/// `CloudAuthError` → `CoreError`（kind 语义对齐 PE-03 §2.4.2 映射表）：
/// - Unauthorized → InvalidInput（登录态失效属调用时机问题，前端可按 kind 分类，
///   不复试也无需重启；detail 文案与旧 String 契约逐字一致）；
/// - Network → Io（detail 携带 `auth.network:` 操作名，对齐 map_store_err 风格）；
/// - BadResponse → Encoding（响应不符合契约 = 编解码失败）。
fn map_cloud_auth_err(err: CloudAuthError) -> CoreError {
    match err {
        CloudAuthError::Unauthorized => {
            CoreError::InvalidInput("unauthorized: token invalid or revoked".to_string())
        }
        CloudAuthError::Network(msg) => CoreError::Io(format!("auth.network: {msg}")),
        CloudAuthError::BadResponse(msg) => {
            CoreError::Encoding(format!("auth.bad_response: {msg}"))
        }
    }
}

/// `AuthManager` 的 anyhow 错误 → `CoreError`：优先还原内层 `CloudAuthError`
/// （login_password 经 `?` 包装，downcast 可还原 kind 语义），其余走 Internal 兜底
/// （detail 必填原始错误文案）。
fn map_auth_err(err: anyhow::Error) -> CoreError {
    match err.downcast::<CloudAuthError>() {
        Ok(cloud_err) => map_cloud_auth_err(cloud_err),
        Err(other) => CoreError::Internal(other.to_string()),
    }
}

/// 未登录前置校验失败 → InvalidInput（detail 文案与旧 String 契约逐字一致）。
fn not_logged_in() -> CoreError {
    CoreError::InvalidInput("Not logged in".to_string())
}

/// 账号密码登录
#[tauri::command]
pub async fn auth_login(
    auth_mgr: State<'_, Arc<AuthManager>>,
    email: String,
    password: String,
) -> Result<UserProfile, CoreError> {
    auth_mgr
        .login_password(&email, &password)
        .await
        .map_err(map_auth_err)
}

/// 退出登录并清除系统凭据
#[tauri::command]
pub async fn auth_logout(auth_mgr: State<'_, Arc<AuthManager>>) -> Result<(), CoreError> {
    auth_mgr.logout().await.map_err(map_auth_err)
}

/// 获取当前登录态快照（含用户信息、有效期、是否登录）
#[tauri::command]
pub async fn auth_get_session(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<SessionSnapshot, CoreError> {
    Ok(auth_mgr.get_session_snapshot().await)
}

/// 手动触发 Token 静默续期
#[tauri::command]
pub async fn auth_refresh_token(auth_mgr: State<'_, Arc<AuthManager>>) -> Result<bool, CoreError> {
    // RefreshOutcome 只驱动守护循环退避；命令面仅回报登录态是否仍然有效
    let _outcome = auth_mgr.check_and_refresh_token().await;
    let s = auth_mgr.get_session_snapshot().await;
    Ok(s.is_logged_in)
}

/// 获取名下云端已绑定的全部设备列表
#[tauri::command]
pub async fn auth_list_devices(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<Vec<CloudDeviceItem>, CoreError> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(not_logged_in)?;

    auth_mgr
        .client()
        .list_devices(&token)
        .await
        .map_err(map_cloud_auth_err)
}

/// 踢出 / 撤销指定设备
#[tauri::command]
pub async fn auth_revoke_device(
    auth_mgr: State<'_, Arc<AuthManager>>,
    device_id: String,
) -> Result<(), CoreError> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(not_logged_in)?;

    auth_mgr
        .client()
        .revoke_device(&token, &device_id)
        .await
        .map_err(map_cloud_auth_err)
}

/// 申请 Host 驻留中继票据
#[tauri::command]
pub async fn auth_get_relay_ticket(
    auth_mgr: State<'_, Arc<AuthManager>>,
    device_id: String,
) -> Result<RelayTicketResponse, CoreError> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(not_logged_in)?;

    auth_mgr
        .client()
        .get_host_relay_ticket(&token, &device_id)
        .await
        .map_err(map_cloud_auth_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_auth_err_maps_unauthorized_to_invalid_input() {
        let mapped = map_cloud_auth_err(CloudAuthError::Unauthorized);
        assert!(matches!(mapped, CoreError::InvalidInput(_)));
    }

    #[test]
    fn cloud_auth_err_maps_network_to_io_with_operation_tag() {
        let mapped = map_cloud_auth_err(CloudAuthError::Network("timeout".to_string()));
        match mapped {
            CoreError::Io(detail) => {
                assert!(detail.contains("auth.network"), "detail: {detail}");
                assert!(detail.contains("timeout"), "detail: {detail}");
            }
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn cloud_auth_err_maps_bad_response_to_encoding() {
        let mapped = map_cloud_auth_err(CloudAuthError::BadResponse("missing field".to_string()));
        assert!(matches!(mapped, CoreError::Encoding(_)));
    }

    #[test]
    fn auth_anyhow_downcasts_cloud_auth_error_kind() {
        // login_password 经 `?` 把 CloudAuthError 装入 anyhow；downcast 应还原 kind
        let wrapped: anyhow::Error = CloudAuthError::Unauthorized.into();
        assert!(matches!(map_auth_err(wrapped), CoreError::InvalidInput(_)));
    }

    #[test]
    fn auth_anyhow_non_cloud_error_falls_back_to_internal() {
        let wrapped = anyhow::Error::msg("DPAPI encrypt failed");
        match map_auth_err(wrapped) {
            CoreError::Internal(detail) => assert!(detail.contains("DPAPI")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    #[test]
    fn not_logged_in_keeps_legacy_text() {
        // 旧 String 契约文案逐字保留，前端展示不漂移
        match not_logged_in() {
            CoreError::InvalidInput(detail) => assert_eq!(detail, "Not logged in"),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }
}
