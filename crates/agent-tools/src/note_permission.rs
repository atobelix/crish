//! 笔记工具审批矩阵（W4-B + W4-F：名单 + 表驱动委托）
//!
//! # 目标
//! 在既有三态权限引擎（[`crate::permission::decide`]）之上，**钉死笔记域**
//! safe / write 边界，使「读工具 plan 可走、写工具 plan Deny、ask 需审批」
//! 可测可审计。
//!
//! # 矩阵（工具名级 · 与表驱动对齐）
//!
//! | 工具 | 角色 | plan | ask | full-access |
//! | ---- | ---- | ---- | --- | ----------- |
//! | `query_blocks` / `document_outline` / `document_get_md` | **safe** | Allow | Allow | Allow |
//! | `document_apply_md` / `send_to_note` / **`block_batch`** / **`block_insert`** / **`block_update`** / **`block_delete`** / **`block_move`** / **`block_set_attr`** | **write** | **Deny** | NeedsApproval | Allow |
//!
//! 判定入口：[`decide_note_tool`]；写名单与
//! [`crate::note_action_matrix`] 表行同步（W4-F 表驱动痕迹；本模块保留
//! 具名常量便于既有测与 session-loop 消费）。
//!
//! # 与 session-loop 的关系
//! session-loop `ToolExecutor::call_verdict` 读 `ToolDefinition.dangerous` 走
//! 通用 [`crate::permission::decide`]。本模块提供：
//! 1. 文档化的笔记域边界；
//! 2. 名单与 `dangerous` 标注一致性自检（测）；
//! 3. 执行期可选二次闸。
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT-01…08 满表关闭**
//! - **≠ W6-E**：无千次批 + 恶意扩展闭环
//! - **≠ A-AGT 全表关闭**；Memory 禁关生产

use crate::permission::{PermissionMode, PermissionVerdict};

/// 笔记只读工具（safe：任意权限模式 Allow，含 plan）
pub const NOTE_SAFE_TOOLS: &[&str] = &[
    "query_blocks",
    "document_outline",
    "document_get_md",
];

/// 笔记写工具（dangerous：plan Deny / ask NeedsApproval / full Allow）
///
/// W4-F + W4-R：含 `block_batch` / `block_insert` / `block_update` /
/// `block_delete` / `block_move` / `block_set_attr`。
pub const NOTE_WRITE_TOOLS: &[&str] = &[
    "document_apply_md",
    "send_to_note",
    "block_batch",
    "block_insert",
    "block_update",
    "block_delete",
    "block_move",
    "block_set_attr",
];

/// 是否为笔记只读工具名
pub fn is_note_safe_tool(name: &str) -> bool {
    NOTE_SAFE_TOOLS.iter().any(|&n| n == name)
}

/// 是否为笔记写工具名
pub fn is_note_write_tool(name: &str) -> bool {
    NOTE_WRITE_TOOLS.iter().any(|&n| n == name)
}

/// 是否为已知笔记域工具（safe ∪ write）
pub fn is_note_tool(name: &str) -> bool {
    is_note_safe_tool(name) || is_note_write_tool(name)
}

/// 笔记工具名 → 权限三态
///
/// - safe 名单 → 任意 mode **Allow**
/// - write 名单 → 委托 [`crate::permission::decide`]`(dangerous=true, …)`
/// - 未知名 → `None`（非笔记域，调用方走通用 dangerous 标记）
///
/// W4-F：与 [`crate::note_action_matrix::decide_from_matrix`]（Builtin 源）
/// 对已知工具应一致（测锁）。
pub fn decide_note_tool(tool_name: &str, mode: PermissionMode) -> Option<PermissionVerdict> {
    if is_note_safe_tool(tool_name) {
        return Some(PermissionVerdict::Allow);
    }
    if is_note_write_tool(tool_name) {
        return Some(crate::permission::decide(true, false, mode));
    }
    None
}

/// plan 模式是否应直接拒绝该笔记工具写路径
///
/// 写工具 → true；读工具 / 未知 → false。
pub fn plan_denies_note_tool(tool_name: &str) -> bool {
    matches!(
        decide_note_tool(tool_name, PermissionMode::Plan),
        Some(PermissionVerdict::Deny)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permission::PermissionMode;

    /// safe 工具在 ask / full / plan 一律 Allow
    #[test]
    fn w4b_note_safe_tools_allowed_in_all_modes() {
        for name in NOTE_SAFE_TOOLS {
            for mode in [
                PermissionMode::Ask,
                PermissionMode::FullAccess,
                PermissionMode::Plan,
            ] {
                assert_eq!(
                    decide_note_tool(name, mode),
                    Some(PermissionVerdict::Allow),
                    "safe 工具 {name} 在 {mode:?} 必须 Allow"
                );
            }
            assert!(!plan_denies_note_tool(name));
        }
    }

    /// 写工具（含 W4-F）plan Deny / ask NeedsApproval / full Allow
    #[test]
    fn w4b_note_write_tools_follow_mode_matrix() {
        for name in NOTE_WRITE_TOOLS {
            assert_eq!(
                decide_note_tool(name, PermissionMode::Plan),
                Some(PermissionVerdict::Deny),
                "plan 必须 Deny 写工具 {name}"
            );
            assert!(plan_denies_note_tool(name));
            assert_eq!(
                decide_note_tool(name, PermissionMode::Ask),
                Some(PermissionVerdict::NeedsApproval),
                "ask 写工具 {name} 需审批"
            );
            assert_eq!(
                decide_note_tool(name, PermissionMode::FullAccess),
                Some(PermissionVerdict::Allow),
                "full-access 写工具 {name} 放行"
            );
        }
    }

    /// 非笔记工具名返回 None
    #[test]
    fn w4b_unknown_tool_returns_none() {
        assert_eq!(decide_note_tool("write_file", PermissionMode::Plan), None);
        assert_eq!(decide_note_tool("shell_command", PermissionMode::Ask), None);
        assert!(!is_note_tool("read_file"));
    }

    /// 名单与注册面 dangerous 标注一致
    #[test]
    fn w4b_note_tool_dangerous_flags_match_matrix() {
        use crate::registry::ToolRegistry;
        use crate::tools::register_builtin_tools;

        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).expect("register builtins");

        for name in NOTE_SAFE_TOOLS {
            let t = reg.get(name).unwrap_or_else(|| panic!("missing safe tool {name}"));
            assert!(
                !t.definition().dangerous,
                "safe 工具 {name} 不得 dangerous=true"
            );
        }
        for name in NOTE_WRITE_TOOLS {
            let t = reg.get(name).unwrap_or_else(|| panic!("missing write tool {name}"));
            assert!(
                t.definition().dangerous,
                "写工具 {name} 必须 dangerous=true（plan Deny / ask 审批）"
            );
        }
    }

    /// W4-F：新写工具在名单内且 plan Deny（含 block_move）
    #[test]
    fn w4f_block_batch_and_insert_in_write_list_plan_deny() {
        assert!(NOTE_WRITE_TOOLS.contains(&"block_batch"));
        assert!(NOTE_WRITE_TOOLS.contains(&"block_insert"));
        assert!(NOTE_WRITE_TOOLS.contains(&"block_update"));
        assert!(NOTE_WRITE_TOOLS.contains(&"block_delete"));
        assert!(NOTE_WRITE_TOOLS.contains(&"block_move"));
        assert!(NOTE_WRITE_TOOLS.contains(&"block_set_attr"));
        assert!(plan_denies_note_tool("block_batch"));
        assert!(plan_denies_note_tool("block_insert"));
        assert!(plan_denies_note_tool("block_update"));
        assert!(plan_denies_note_tool("block_delete"));
        assert!(plan_denies_note_tool("block_move"));
        assert!(plan_denies_note_tool("block_set_attr"));
        assert!(is_note_tool("block_move"));
        assert!(is_note_tool("block_set_attr"));
    }

    /// W4-R：`block_set_attr` 在写名单且 plan Deny（≠ EL-05 / ≠ W6-E）
    #[test]
    fn w4r_block_set_attr_plan_deny() {
        assert!(NOTE_WRITE_TOOLS.contains(&"block_set_attr"));
        assert!(plan_denies_note_tool("block_set_attr"));
        assert_eq!(
            decide_note_tool("block_set_attr", PermissionMode::Plan),
            Some(PermissionVerdict::Deny)
        );
        assert_eq!(
            decide_note_tool("block_set_attr", PermissionMode::Ask),
            Some(PermissionVerdict::NeedsApproval)
        );
        assert_eq!(
            decide_note_tool("block_set_attr", PermissionMode::FullAccess),
            Some(PermissionVerdict::Allow)
        );
    }

    /// 名单与表驱动矩阵（Builtin）一致
    #[test]
    fn w4f_note_permission_aligns_with_action_matrix() {
        use crate::note_action_matrix::{
            decide_from_matrix, safe_tool_names, write_tool_names, ActionSource,
        };

        let matrix_safe = safe_tool_names();
        let matrix_write = write_tool_names();
        assert_eq!(matrix_safe, NOTE_SAFE_TOOLS);
        assert_eq!(matrix_write, NOTE_WRITE_TOOLS);

        for name in NOTE_WRITE_TOOLS {
            for mode in [
                PermissionMode::Plan,
                PermissionMode::Ask,
                PermissionMode::FullAccess,
            ] {
                assert_eq!(
                    decide_note_tool(name, mode),
                    decide_from_matrix(name, ActionSource::Builtin, mode),
                    "decide_note_tool vs matrix Builtin for {name} {mode:?}"
                );
            }
        }
    }

    /// 诚实钉：≠ EL-05 / ≠ W6-E / ≠ A-AGT 全表（满工具注册 ≠ 生产关项）
    #[test]
    fn w4f_note_permission_honest_not_el05() {
        assert_eq!(NOTE_SAFE_TOOLS.len(), 3);
        assert_eq!(NOTE_WRITE_TOOLS.len(), 8); // + batch/insert/update/delete/move/set_attr
        let _ = "≠ EL-05 / ≠ W6-E / ≠ A-AGT 全表关闭";
    }
}
