//! 笔记域 safeActions × ActionEffects × Source **表驱动**矩阵（W4-F 起点）
//!
//! # 目标
//! 相对 W4-B 的「两数组 hardcode」（`NOTE_SAFE_TOOLS` / `NOTE_WRITE_TOOLS`），
//! 本模块以 **表行** 承载 action 级 effects 与 safe 标记，判定入口
//! [`decide_from_matrix`] 按表驱动产出权限三态——可测、可扩、可审计。
//!
//! # 矩阵维度
//! - **safeActions**：`row.safe == true` 且 effects 仅 [`ActionEffect::LocalRead`]
//!   → 任意 PermissionMode **Allow**（含 plan）
//! - **ActionEffects**：LocalRead / LocalWrite / DataEgress / ExternalCost
//! - **Source**：Builtin / ExternalMcp / Plugin（外部源写默认更严）
//!
//! # 与 note_permission 关系
//! [`crate::note_permission::decide_note_tool`] 可继续作兼容入口；
//! 本模块为 A-AGT-06 **表驱动**痕迹的权威表。名单导出
//! [`safe_tool_names`] / [`write_tool_names`] 供注册一致性测。
//!
//! # 诚实边界（强制）
//! - **≠ EL-05**；**≠ A-AGT-01…08 满表关闭**
//! - **≠ W6-E Strict**：无千次批 + 恶意扩展闭环（骨架见 **W6-E-S** `note_w6e_skeleton`）
//! - **≠ A-AGT 全表关闭**（Memory 禁关生产）

use crate::permission::{PermissionMode, PermissionVerdict};

/// Action 效果维（学思源 ActionEffects 四维）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionEffect {
    /// 本地只读
    LocalRead,
    /// 本地写（树/索引）
    LocalWrite,
    /// 数据出站
    DataEgress,
    /// 外部计费/成本
    ExternalCost,
}

/// 调用源
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionSource {
    /// 内置 agent-tools 注册工具
    Builtin,
    /// 外部 MCP 适配
    ExternalMcp,
    /// 插件 contribute
    Plugin,
}

/// 表驱动行：工具名 × action 名 × safe × effects
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoteActionRow {
    /// 注册工具名（Registry 键）
    pub tool_name: &'static str,
    /// 逻辑 action（便于多 verb 聚合扩展）
    pub action: &'static str,
    /// 是否 ∈ safeActions（只读白名单）
    pub safe: bool,
    /// 效果维（静态切片）
    pub effects: &'static [ActionEffect],
}

/// 权威表（W4-F；新增写工具必须挂行 + 注册，否则未交付）
pub static NOTE_ACTION_MATRIX: &[NoteActionRow] = &[
    // ── safe / LocalRead ──────────────────────────────────────────
    NoteActionRow {
        tool_name: "query_blocks",
        action: "query",
        safe: true,
        effects: &[ActionEffect::LocalRead],
    },
    NoteActionRow {
        tool_name: "document_outline",
        action: "outline",
        safe: true,
        effects: &[ActionEffect::LocalRead],
    },
    NoteActionRow {
        tool_name: "document_get_md",
        action: "get_md",
        safe: true,
        effects: &[ActionEffect::LocalRead],
    },
    // ── write / LocalWrite（W4-A/B 既有）──────────────────────────
    NoteActionRow {
        tool_name: "document_apply_md",
        action: "apply_md",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
    NoteActionRow {
        tool_name: "send_to_note",
        action: "send",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
    // ── W4-F 写工具 ───────────────────────────────────────────────
    NoteActionRow {
        tool_name: "block_batch",
        action: "apply_ops",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
    NoteActionRow {
        tool_name: "block_insert",
        action: "insert",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
    NoteActionRow {
        tool_name: "block_update",
        action: "update",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
    NoteActionRow {
        tool_name: "block_delete",
        action: "delete",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
    NoteActionRow {
        tool_name: "block_move",
        action: "move",
        safe: false,
        effects: &[ActionEffect::LocalWrite],
    },
];

/// 按工具名查表行
pub fn lookup_action(tool_name: &str) -> Option<&'static NoteActionRow> {
    NOTE_ACTION_MATRIX.iter().find(|r| r.tool_name == tool_name)
}

/// 是否表内 safe 工具
pub fn is_matrix_safe(tool_name: &str) -> bool {
    lookup_action(tool_name).map(|r| r.safe).unwrap_or(false)
}

/// 是否表内含 LocalWrite
pub fn has_local_write(tool_name: &str) -> bool {
    lookup_action(tool_name)
        .map(|r| r.effects.contains(&ActionEffect::LocalWrite))
        .unwrap_or(false)
}

/// 表内全部 safe 工具名（保序）
pub fn safe_tool_names() -> Vec<&'static str> {
    NOTE_ACTION_MATRIX
        .iter()
        .filter(|r| r.safe)
        .map(|r| r.tool_name)
        .collect()
}

/// 表内全部写工具名（非 safe，保序）
pub fn write_tool_names() -> Vec<&'static str> {
    NOTE_ACTION_MATRIX
        .iter()
        .filter(|r| !r.safe)
        .map(|r| r.tool_name)
        .collect()
}

/// 效果是否「纯本地只读」（可 plan Allow）
fn effects_are_local_read_only(effects: &[ActionEffect]) -> bool {
    !effects.is_empty()
        && effects
            .iter()
            .all(|e| matches!(e, ActionEffect::LocalRead))
}

/// 是否含出站 / 计费维
fn effects_need_extra_confirm(effects: &[ActionEffect]) -> bool {
    effects.iter().any(|e| {
        matches!(
            e,
            ActionEffect::DataEgress | ActionEffect::ExternalCost
        )
    })
}

/// **表驱动**判定：safeActions × Effects × Source × PermissionMode
///
/// | 条件 | 结果 |
/// | ---- | ---- |
/// | 未知工具 | `None`（非笔记域） |
/// | safe ∧ 仅 LocalRead | 任意 mode **Allow** |
/// | LocalWrite + Builtin | plan Deny / ask NeedsApproval / full Allow |
/// | LocalWrite + ExternalMcp/Plugin | plan Deny；ask/**full** 均 NeedsApproval（外部源默认确认） |
/// | DataEgress/ExternalCost | 默认 NeedsApproval（plan Deny） |
///
/// **≠ EL-05**；仅 A-AGT-06 表驱动起点。
pub fn decide_from_matrix(
    tool_name: &str,
    source: ActionSource,
    mode: PermissionMode,
) -> Option<PermissionVerdict> {
    let row = lookup_action(tool_name)?;

    // safeActions × LocalRead → 全模式 Allow
    if row.safe && effects_are_local_read_only(row.effects) {
        return Some(PermissionVerdict::Allow);
    }

    // 出站/计费：plan Deny；其余 NeedsApproval（含 full，强制可见）
    if effects_need_extra_confirm(row.effects) {
        return Some(match mode {
            PermissionMode::Plan => PermissionVerdict::Deny,
            PermissionMode::Ask | PermissionMode::FullAccess => {
                PermissionVerdict::NeedsApproval
            }
        });
    }

    // LocalWrite（或非 safe）
    if row.effects.contains(&ActionEffect::LocalWrite) || !row.safe {
        return Some(match (source, mode) {
            (_, PermissionMode::Plan) => PermissionVerdict::Deny,
            // 外部源：full 仍需确认（相对内置更严）
            (ActionSource::ExternalMcp | ActionSource::Plugin, PermissionMode::FullAccess) => {
                PermissionVerdict::NeedsApproval
            }
            (ActionSource::ExternalMcp | ActionSource::Plugin, PermissionMode::Ask) => {
                PermissionVerdict::NeedsApproval
            }
            (ActionSource::Builtin, PermissionMode::Ask) => PermissionVerdict::NeedsApproval,
            (ActionSource::Builtin, PermissionMode::FullAccess) => PermissionVerdict::Allow,
        });
    }

    // 兜底：非 safe 且无明确 effects → 当写
    Some(crate::permission::decide(true, false, mode))
}

/// plan 是否 Deny 该表内工具（写路径）
pub fn plan_denies_matrix_tool(tool_name: &str) -> bool {
    matches!(
        decide_from_matrix(tool_name, ActionSource::Builtin, PermissionMode::Plan),
        Some(PermissionVerdict::Deny)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A-AGT-06：表存在且含 W4-F 写工具行（含 update/delete/move）
    #[test]
    fn w4f_matrix_contains_block_batch_and_insert() {
        assert!(lookup_action("block_batch").is_some());
        assert!(lookup_action("block_insert").is_some());
        assert!(lookup_action("block_update").is_some());
        assert!(lookup_action("block_delete").is_some());
        assert!(lookup_action("block_move").is_some());
        assert!(!lookup_action("block_batch").unwrap().safe);
        assert!(has_local_write("block_batch"));
        assert!(has_local_write("block_insert"));
        assert!(has_local_write("block_update"));
        assert!(has_local_write("block_delete"));
        assert!(has_local_write("block_move"));
    }

    /// safe × LocalRead × 任意 mode → Allow
    #[test]
    fn w4f_matrix_safe_local_read_allow_all_modes() {
        for name in safe_tool_names() {
            for mode in [
                PermissionMode::Plan,
                PermissionMode::Ask,
                PermissionMode::FullAccess,
            ] {
                assert_eq!(
                    decide_from_matrix(name, ActionSource::Builtin, mode),
                    Some(PermissionVerdict::Allow),
                    "{name} / {mode:?}"
                );
            }
        }
    }

    /// LocalWrite × Builtin：plan Deny / ask NeedsApproval / full Allow
    #[test]
    fn w4f_matrix_local_write_builtin_mode_matrix() {
        for name in write_tool_names() {
            assert_eq!(
                decide_from_matrix(name, ActionSource::Builtin, PermissionMode::Plan),
                Some(PermissionVerdict::Deny),
                "plan must Deny {name}"
            );
            assert!(plan_denies_matrix_tool(name));
            assert_eq!(
                decide_from_matrix(name, ActionSource::Builtin, PermissionMode::Ask),
                Some(PermissionVerdict::NeedsApproval)
            );
            assert_eq!(
                decide_from_matrix(name, ActionSource::Builtin, PermissionMode::FullAccess),
                Some(PermissionVerdict::Allow)
            );
        }
    }

    /// Source=ExternalMcp × LocalWrite：full 仍 NeedsApproval（表驱动 Source 维）
    #[test]
    fn w4f_matrix_external_source_stricter_on_write() {
        assert_eq!(
            decide_from_matrix(
                "block_batch",
                ActionSource::ExternalMcp,
                PermissionMode::FullAccess
            ),
            Some(PermissionVerdict::NeedsApproval)
        );
        assert_eq!(
            decide_from_matrix(
                "block_insert",
                ActionSource::Plugin,
                PermissionMode::Plan
            ),
            Some(PermissionVerdict::Deny)
        );
    }

    /// 未知工具 → None
    #[test]
    fn w4f_matrix_unknown_tool_none() {
        assert_eq!(
            decide_from_matrix("write_file", ActionSource::Builtin, PermissionMode::Plan),
            None
        );
    }

    /// 诚实钉：≠ EL-05 / ≠ A-AGT 全表（注册满表 ≠ 生产关项）
    #[test]
    fn w4f_matrix_honest_not_el05_or_full_block_star() {
        let writes = write_tool_names();
        assert!(writes.contains(&"block_batch"));
        assert!(writes.contains(&"block_insert"));
        assert!(writes.contains(&"block_update"));
        assert!(writes.contains(&"block_delete"));
        assert!(writes.contains(&"block_move"));
        // 表驱动痕迹：行数 ≥ 10（3 读 + 2 旧写 + 5 block_*）
        assert!(NOTE_ACTION_MATRIX.len() >= 10);
        let _ = "≠ EL-05 / ≠ W6-E / ≠ A-AGT 全表关闭";
    }
}
