//! W4-C contribute 校验：权限 / 载荷合法性 / 拒写句柄
//!
//! 守卫顺序（由注册表调用）：base → permissions → **拒写句柄**。
//! 诚实：拒写方向不回退；**≠ EL-07** 满关。

use crate::note_w6e_skeleton::{
    find_forbidden_write_handle, FORBIDDEN_WRITE_HANDLE_KEYS, MALICIOUS_EXTENSION_FORBIDDEN_WRITE,
};

use super::schema::{ContributeKind, ContributeRegisterError, ContributeRegistration};
use super::CONTRIBUTE_FORBIDDEN_WRITE;
use super::REQUIRED_CONTRIBUTE_PERMISSION;

/// 基础载荷：id / plugin_id 非空 + kind 特有必填字段
pub(super) fn validate_base(c: &ContributeRegistration) -> Result<(), ContributeRegisterError> {
    if c.id.trim().is_empty() {
        return Err(ContributeRegisterError::InvalidPayload {
            message: "contribute.id is required (non-empty)".into(),
        });
    }
    if c.plugin_id.trim().is_empty() {
        return Err(ContributeRegisterError::InvalidPayload {
            message: "contribute.plugin_id is required (non-empty)".into(),
        });
    }
    match c.kind {
        ContributeKind::SlashItem => {
            if field_empty(c, "title") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "slash_item.title is required".into(),
                });
            }
        }
        ContributeKind::BlockView => {
            if field_empty(c, "flavour") || field_empty(c, "component") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "block_view.flavour and component are required".into(),
                });
            }
        }
        ContributeKind::Widget => {
            if field_empty(c, "anchor") || field_empty(c, "component") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "widget.anchor and component are required".into(),
                });
            }
        }
        ContributeKind::Keymap => {
            if field_empty(c, "keys") || field_empty(c, "command_id") {
                return Err(ContributeRegisterError::InvalidPayload {
                    message: "keymap.keys and command_id are required".into(),
                });
            }
        }
    }
    Ok(())
}

fn field_empty(c: &ContributeRegistration, key: &str) -> bool {
    c.fields
        .get(key)
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

/// 必须含 `ui:contribute`
pub(super) fn validate_permissions(
    c: &ContributeRegistration,
) -> Result<(), ContributeRegisterError> {
    if !c
        .permissions
        .iter()
        .any(|p| p == REQUIRED_CONTRIBUTE_PERMISSION)
    {
        return Err(ContributeRegisterError::MissingPermission {
            message: format!(
                "contribute requires permission `{REQUIRED_CONTRIBUTE_PERMISSION}` (got {:?})",
                c.permissions
            ),
        });
    }
    Ok(())
}

/// 拒写句柄：顶层 fields 键 + 可选 payload JSON 扫描。
///
/// 对齐 plugin-sdk `FORBIDDEN_WRITE_KEYS` / W6-E-S [`FORBIDDEN_WRITE_HANDLE_KEYS`]。
/// **不回退**拒写方向；本闸 = A-EXT-05 局部；**≠ EL-07** 满关。
pub(super) fn reject_write_handles(
    c: &ContributeRegistration,
) -> Result<(), ContributeRegisterError> {
    for key in FORBIDDEN_WRITE_HANDLE_KEYS {
        if c.fields.contains_key(*key) {
            return Err(ContributeRegisterError::ForbiddenWriteHandle {
                key: (*key).to_string(),
                message: format!(
                    "{CONTRIBUTE_FORBIDDEN_WRITE}: contribution must not carry write handle `{key}` \
                     (View 轨投影-only；写权威仅经 RS 工具面) — ≠ EL-07 满关"
                ),
            });
        }
    }
    if let Some(payload) = &c.payload {
        if let Some(hit) = find_forbidden_write_handle(payload) {
            return Err(ContributeRegisterError::ForbiddenWriteHandle {
                key: hit.to_string(),
                message: format!(
                    "{CONTRIBUTE_FORBIDDEN_WRITE}: payload contains forbidden write handle `{hit}` \
                     (aligned {MALICIOUS_EXTENSION_FORBIDDEN_WRITE}) — zero register"
                ),
            });
        }
    }
    Ok(())
}
