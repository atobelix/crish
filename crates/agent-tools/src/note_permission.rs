//! 笔记工具审批矩阵（W4-B Strict 子集 · 批安全方向）
//!
//! # 目标
//! 在既有三态权限引擎（[`crate::permission::decide`]）之上，**钉死笔记域**
//! safe / write 边界，使「读工具 plan 可走、写工具 plan Deny、ask 需审批」
//! 可测可审计，而不冒充 A-AGT-06 满表。
//!
//! # 矩阵（W4-B 方向 · 工具名级）
//!
//! | 工具 | 角色 | plan | ask | full-access |
//! | ---- | ---- | ---- | --- | ----------- |
//! | `query_blocks` / `document_outline` / `document_get_md` | **safe**（只读） | Allow | Allow | Allow |
//! | `document_apply_md` / `send_to_note` | **write**（dangerous） | **Deny** | NeedsApproval | Allow |
//!
//! 判定入口：[`decide_note_tool`]；等价于 `decide(is_note_write_tool(name), false, mode)`，
//! 但以**具名名单**锁定契约，防止写工具漏标 dangerous 时静默放行 plan。
//!
//! # 与 session-loop 的关系
//! session-loop `ToolExecutor::call_verdict` 读 `ToolDefinition.dangerous` 走
//! 通用 [`crate::permission::decide`]。本模块提供：
//! 1. 文档化的笔记域边界；
//! 2. 名单与 `dangerous` 标注一致性自检（测）；
//! 3. 执行期可选二次闸（工具内 / 未来 batch 签发侧）。
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT-01…08 满表**
//! - **≠ W4-F**：无 `block_batch`、无 safeActions×Effects×Source **表驱动**、
//!   无 `execution_unknown`、无 plan Deny 满表产品句
//! - **≠ W6-E**：无千次批 + 恶意扩展闭环
//! - Memory 测绿 **禁止**关生产 A-AGT / EL-05

use crate::permission::{PermissionMode, PermissionVerdict};

/// 笔记只读工具（safe：任意权限模式 Allow，含 plan）
pub const NOTE_SAFE_TOOLS: &[&str] = &[
    "query_blocks",
    "document_outline",
    "document_get_md",
];

/// 笔记写工具（dangerous：plan Deny / ask NeedsApproval / full Allow）
pub const NOTE_WRITE_TOOLS: &[&str] = &["document_apply_md", "send_to_note"];

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

/// 笔记工具名 → 权限三态（W4-B 矩阵方向）
///
/// - safe 名单 → 任意 mode **Allow**
/// - write 名单 → 委托 [`crate::permission::decide`]`(dangerous=true, …)`
/// - 未知名 → `None`（非笔记域，调用方走通用 dangerous 标记）
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

    /// W4-B：safe 工具在 ask / full / plan 一律 Allow（plan 可读笔记）
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

    /// W4-B：写工具 plan Deny / ask NeedsApproval / full Allow
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

    /// W4-B：非笔记工具名返回 None（不越权判定）
    #[test]
    fn w4b_unknown_tool_returns_none() {
        assert_eq!(decide_note_tool("write_file", PermissionMode::Plan), None);
        assert_eq!(decide_note_tool("shell_command", PermissionMode::Ask), None);
        assert!(!is_note_tool("read_file"));
    }

    /// W4-B：名单与注册面 dangerous 标注一致（防写工具漏进 safe / 读工具标 dangerous）
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

    /// 诚实钉：本模块 ≠ EL-05 / ≠ W4-F 表驱动满表
    #[test]
    fn w4b_note_permission_is_not_el05_or_w4f_full_table() {
        // 仅 3 读 + 2 写；无 block_batch / block_insert 等 W4-F 满表项
        assert_eq!(NOTE_SAFE_TOOLS.len(), 3);
        assert_eq!(NOTE_WRITE_TOOLS.len(), 2);
        assert!(!NOTE_WRITE_TOOLS.contains(&"block_batch"));
        assert!(!is_note_tool("block_batch"));
        // 注释契约：满表 / EL-05 关闭须 W4-F + W6-E
        let _ = "≠ EL-05 / ≠ W4-F / ≠ W6-E";
    }
}
