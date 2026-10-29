//! 桌面端用户账号与云端设备管理 IPC 命令面
//!
//! 供 React 前端（SettingsProfileTab / UserProfileCard）真实调用，拒绝伪实现。
//! 错误契约统一走 `CoreError`（PE-03 T03.3：命令面唯一错误类型）。

use std::sync::Arc;
use tauri::State;

use crate::auth::client::{
    AccountProfile, AuthSessionInfo, CloudAuthError, EmailCodeScene, EmailCodeTicket,
    PasswordCodeScene,
};
use crate::auth::{AuthManager, CloudDeviceItem, SessionSnapshot, UserProfile};
use crate::remote::client::{
    fetch_relay_devices, http_client, ticket_base_url, RelayTicketError,
};
use conex_run::core_error::CoreError;

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
        CloudAuthError::Rejected { message, .. } => CoreError::InvalidInput(message),
        CloudAuthError::Network(msg) => CoreError::Io(format!("auth.network: {msg}")),
        CloudAuthError::BadResponse(msg) => {
            CoreError::Encoding(format!("auth.bad_response: {msg}"))
        }
    }
}

/// `AuthManager` 的 anyhow 错误 → `CoreError`：优先还原内层 `CloudAuthError`
/// （login_password 经 `?` 包装，downcast 可还原 kind 语义），其余走 Internal 兜底
/// （detail 必填原始错误文案）。
/// 中继客户端错误 → `CoreError`（与账号中心错误同语义：401 = 登录态失效）。
fn map_relay_err(err: RelayTicketError) -> CoreError {
    match err {
        RelayTicketError::Unauthorized => map_cloud_auth_err(CloudAuthError::Unauthorized),
        RelayTicketError::Other(message) => map_cloud_auth_err(CloudAuthError::Network(message)),
    }
}

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
    let device_id = crate::remote::device::stable_device_id();
    let device_name = crate::remote::device::device_display_name();
    auth_mgr
        .login_password(&email, &password, &device_id, &device_name)
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

/// 请求邮件验证码（`scene` = login / register / reset；注册与重置需同时提交密码）
#[tauri::command]
pub async fn auth_request_email_code(
    auth_mgr: State<'_, Arc<AuthManager>>,
    scene: String,
    email: String,
    password: Option<String>,
) -> Result<EmailCodeTicket, CoreError> {
    let scene = EmailCodeScene::parse(&scene)
        .ok_or_else(|| CoreError::InvalidInput(format!("unknown email code scene: {scene}")))?;
    auth_mgr
        .request_email_code(scene, &email, password.as_deref())
        .await
        .map_err(map_auth_err)
}

/// 校验邮件验证码并建立会话（登录 / 注册 / 重置密码）
#[tauri::command]
pub async fn auth_confirm_email_code(
    auth_mgr: State<'_, Arc<AuthManager>>,
    scene: String,
    email: String,
    code: String,
) -> Result<UserProfile, CoreError> {
    let scene = EmailCodeScene::parse(&scene)
        .ok_or_else(|| CoreError::InvalidInput(format!("unknown email code scene: {scene}")))?;
    let device_id = crate::remote::device::stable_device_id();
    let device_name = crate::remote::device::device_display_name();
    let result = match scene {
        EmailCodeScene::Login => {
            auth_mgr
                .login_email_code(&email, &code, &device_id, &device_name)
                .await
        }
        EmailCodeScene::Register => {
            auth_mgr
                .register_email(&email, &code, &device_id, &device_name)
                .await
        }
        EmailCodeScene::Reset => {
            auth_mgr
                .reset_password(&email, &code, &device_id, &device_name)
                .await
        }
    };
    result.map_err(map_auth_err)
}

/// 读取账号资料（昵称 / 头像 / 简介）
#[tauri::command]
pub async fn auth_get_profile(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<AccountProfile, CoreError> {
    auth_mgr.get_profile().await.map_err(map_auth_err)
}

/// 更新账号资料（仅提交提供字段）
#[tauri::command]
pub async fn auth_update_profile(
    auth_mgr: State<'_, Arc<AuthManager>>,
    display_name: Option<String>,
    bio: Option<String>,
) -> Result<AccountProfile, CoreError> {
    auth_mgr
        .update_profile(display_name.as_deref(), bio.as_deref())
        .await
        .map_err(map_auth_err)
}

/// 上传头像（data URL，账号中心限制 3 MiB / png-jpeg-webp-gif）
#[tauri::command]
pub async fn auth_upload_avatar(
    auth_mgr: State<'_, Arc<AuthManager>>,
    data_url: String,
    file_name: Option<String>,
) -> Result<AccountProfile, CoreError> {
    auth_mgr
        .upload_avatar(&data_url, file_name.as_deref())
        .await
        .map_err(map_auth_err)
}

/// 登录会话列表
#[tauri::command]
pub async fn auth_list_sessions(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<Vec<AuthSessionInfo>, CoreError> {
    auth_mgr.list_sessions().await.map_err(map_auth_err)
}

/// 撤销指定登录会话
#[tauri::command]
pub async fn auth_revoke_session(
    auth_mgr: State<'_, Arc<AuthManager>>,
    session_id: String,
) -> Result<bool, CoreError> {
    auth_mgr
        .revoke_session(&session_id)
        .await
        .map(|_| true)
        .map_err(map_auth_err)
}

/// 注销账号（服务端校验确认邮箱，成功后匿名化并吊销全部会话）
#[tauri::command]
pub async fn auth_delete_account(
    auth_mgr: State<'_, Arc<AuthManager>>,
    confirm_email: String,
) -> Result<(), CoreError> {
    auth_mgr
        .delete_account(&confirm_email)
        .await
        .map_err(map_auth_err)
}

/// 先码后密码 · 发送验证码（register / reset；只带 email，不带密码）
#[tauri::command]
pub async fn auth_request_password_code(
    auth_mgr: State<'_, Arc<AuthManager>>,
    scene: String,
    email: String,
) -> Result<EmailCodeTicket, CoreError> {
    let scene = PasswordCodeScene::parse(&scene)
        .ok_or_else(|| CoreError::InvalidInput(format!("unknown password code scene: {scene}")))?;
    auth_mgr
        .request_password_code(scene, &email)
        .await
        .map_err(map_auth_err)
}

/// 先码后密码 · 凭验证码设置新密码（成功后建立会话；已登录改密保留当前会话）
#[tauri::command]
pub async fn auth_set_password_with_code(
    auth_mgr: State<'_, Arc<AuthManager>>,
    scene: String,
    email: String,
    code: String,
    password: String,
) -> Result<UserProfile, CoreError> {
    let scene = PasswordCodeScene::parse(&scene)
        .ok_or_else(|| CoreError::InvalidInput(format!("unknown password code scene: {scene}")))?;
    let device_id = crate::remote::device::stable_device_id();
    let device_name = crate::remote::device::device_display_name();
    auth_mgr
        .set_password_with_code(scene, &email, &code, &password, &device_id, &device_name)
        .await
        .map_err(map_auth_err)
}

/// 获取账号内当前在线的设备列表（中继房间状态；离线设备不返回）
#[tauri::command]
pub async fn auth_list_devices(
    auth_mgr: State<'_, Arc<AuthManager>>,
) -> Result<Vec<CloudDeviceItem>, CoreError> {
    let s = auth_mgr.get_session_snapshot().await;
    let token = s.access_token.ok_or_else(not_logged_in)?;

    let devices = fetch_relay_devices(&http_client(), &ticket_base_url(), &token)
        .await
        .map_err(map_relay_err)?;
    let self_id = crate::remote::device::stable_device_id();
    Ok(devices
        .into_iter()
        .filter(|device| device.id != self_id)
        .map(|device| CloudDeviceItem {
            id: device.id,
            name: device.name,
            platform: device.platform,
            last_seen_at: device.last_seen_at,
            trusted: true,
            metadata: None,
        })
        .collect())
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
