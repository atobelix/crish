//! 权限规则引擎（纯函数三态矩阵）
//!
//! 统一收敛为三态：
//! - `Ask`（每次询问）：危险 / 非智能安全操作需审批；严格只读放行；
//! - `Smart`（智能命令放行）：安全与只读命令自动放行；敏感写删强推弹窗审批；
//! - `Full`（完全允许模式）：不因危险标记拦截。
//!
//! 边界（2026-10-27 收敛）：本模块只提供**工具级**三态矩阵；命令语义
//! （Redline / 重定向 / git 写操作 / C3 回退）的唯一判定入口是
//! `session-loop::exec_verdict::call_verdict`（消费 `conex-sandbox::SmartClassifier`）。
//! 禁止在本模块新增命令级判定函数，避免第二套放行链。

use serde::{Deserialize, Serialize};

// 单一权威枚举重导出
pub use conex_types::PermissionMode;

/// 权限裁决三态结果
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionVerdict {
    /// 放行执行
    Allow,
    /// 需审批（等待用户裁决）
    NeedsApproval,
    /// 刚性拒绝（工具未启用 / 上层红线判定）
    Deny,
}

/// 纯函数三态决策核心
#[inline]
pub fn decide_verdict(
    mode: PermissionMode,
    is_dangerous: bool,
    is_smart_safe: bool,
) -> PermissionVerdict {
    match mode {
        PermissionMode::Full => PermissionVerdict::Allow,
        PermissionMode::Ask => {
            if is_dangerous || !is_smart_safe {
                PermissionVerdict::NeedsApproval
            } else {
                PermissionVerdict::Allow
            }
        }
        PermissionMode::Smart => {
            if is_smart_safe {
                PermissionVerdict::Allow
            } else {
                PermissionVerdict::NeedsApproval
            }
        }
    }
}

/// 常规工具判定（兼容入口）
#[inline]
pub fn decide(dangerous: bool, requires_approval: bool, mode: PermissionMode) -> PermissionVerdict {
    let is_dangerous = dangerous || requires_approval;
    let is_smart_safe = !is_dangerous;
    decide_verdict(mode, is_dangerous, is_smart_safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_mode_always_allows_in_decide_verdict() {
        assert_eq!(
            decide_verdict(PermissionMode::Full, false, true),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_verdict(PermissionMode::Full, true, false),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_verdict(PermissionMode::Full, true, true),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_verdict(PermissionMode::Full, false, false),
            PermissionVerdict::Allow
        );
    }

    #[test]
    fn ask_mode_decide_verdict() {
        // 安全纯只读放行
        assert_eq!(
            decide_verdict(PermissionMode::Ask, false, true),
            PermissionVerdict::Allow
        );
        // 危险操作需审批
        assert_eq!(
            decide_verdict(PermissionMode::Ask, true, true),
            PermissionVerdict::NeedsApproval
        );
        // 非智能安全需审批
        assert_eq!(
            decide_verdict(PermissionMode::Ask, false, false),
            PermissionVerdict::NeedsApproval
        );
        // 危险且非智能安全需审批
        assert_eq!(
            decide_verdict(PermissionMode::Ask, true, false),
            PermissionVerdict::NeedsApproval
        );
    }

    #[test]
    fn smart_mode_decide_verdict() {
        // 智能安全直接放行
        assert_eq!(
            decide_verdict(PermissionMode::Smart, false, true),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_verdict(PermissionMode::Smart, true, true),
            PermissionVerdict::Allow
        );
        // 非智能安全需审批
        assert_eq!(
            decide_verdict(PermissionMode::Smart, false, false),
            PermissionVerdict::NeedsApproval
        );
        assert_eq!(
            decide_verdict(PermissionMode::Smart, true, false),
            PermissionVerdict::NeedsApproval
        );
    }

    #[test]
    fn full_mode_allows_dangerous_tools() {
        // 工具级矩阵：Full 不因 dangerous 标记拦截（命令红线由执行器先行一刀切）
        assert_eq!(
            decide_verdict(PermissionMode::Full, true, false),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_verdict(PermissionMode::Full, true, true),
            PermissionVerdict::Allow
        );
    }
}
