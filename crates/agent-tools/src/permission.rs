//! 权限规则引擎（R4 T10：消费 dangerous 标记与 requires_approval）
//!
//! 三态判定（Allow / Deny / NeedsApproval）：
//! - 输入：工具 dangerous 标记 + 工具 requires_approval 错误 + 当前权限模式；
//! - ask 模式：dangerous / requires_approval → 需审批；其余放行；
//! - full-access 模式：全部放行（T0–T3 自动）；
//! - plan 模式：写类（dangerous）与越界命令拒绝，不弹窗。
//!
//! 语义来源：前端 permissionModes.ts（ask / deep → ask，full → full-access，
//! plan）+ TrustZone 矩阵（ask：T1/T3 确认；plan：写与风险拒绝）。

/// 权限模式（对齐引擎协议 permissionMode：ask / full-access / plan）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PermissionMode {
    /// 需确认：危险/越界操作先问（deep 在引擎侧等同 ask）
    #[default]
    Ask,
    /// 完全访问：全部放行（T0–T3 自动）
    FullAccess,
    /// 计划：只读，写与风险拒绝
    Plan,
}

impl PermissionMode {
    /// 引擎字符串 → 模式（与前端 permissionModes.ts 别名表对齐；
    /// 未知值安全默认 ask，永不静默 full-access）
    pub fn from_engine_str(mode: Option<&str>) -> Self {
        match mode {
            Some("full-access" | "full" | "full_access" | "allow" | "yolo" | "danger") => {
                PermissionMode::FullAccess
            }
            Some("plan" | "readonly" | "read-only" | "analysis" | "safe" | "cautious") => {
                PermissionMode::Plan
            }
            // ask / deep / unattended / auto / 未知 → ask（安全默认）
            _ => PermissionMode::Ask,
        }
    }

    /// 引擎协议字面量（core_run_task 下发与拒绝文案用）
    pub fn as_engine_str(&self) -> &'static str {
        match self {
            PermissionMode::Ask => "ask",
            PermissionMode::FullAccess => "full-access",
            PermissionMode::Plan => "plan",
        }
    }
}

/// 权限判定三态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionVerdict {
    /// 放行执行
    Allow,
    /// 直接拒绝（plan 模式写类 / 越界命令，不弹窗）
    Deny,
    /// 需审批（走 ctx.ask / 审批门，等待用户裁决）
    NeedsApproval,
}

/// 权限判定函数（纯函数，无副作用）
///
/// - `dangerous`：工具定义的危险标记（破坏性副作用：删除/推送/提权等）；
/// - `requires_approval`：工具返回 tool.requires_approval（命令门禁越界升级）；
/// - `mode`：当前权限模式。
///
/// 判定矩阵：
/// - 非危险且无越界 → 全部模式放行（T0 自动）；
/// - dangerous / requires_approval → ask 问询、full-access 放行、plan 拒绝。
pub fn decide(dangerous: bool, requires_approval: bool, mode: PermissionMode) -> PermissionVerdict {
    if dangerous || requires_approval {
        return match mode {
            PermissionMode::Ask => PermissionVerdict::NeedsApproval,
            PermissionMode::FullAccess => PermissionVerdict::Allow,
            PermissionMode::Plan => PermissionVerdict::Deny,
        };
    }
    PermissionVerdict::Allow
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三态矩阵：非危险工具全部模式放行
    #[test]
    fn safe_tool_allowed_in_all_modes() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            assert_eq!(
                decide(false, false, mode),
                PermissionVerdict::Allow,
                "{mode:?} 下安全工具应放行"
            );
        }
    }

    /// 三态矩阵：dangerous 工具按模式判定
    #[test]
    fn dangerous_tool_follows_mode_matrix() {
        assert_eq!(
            decide(true, false, PermissionMode::Ask),
            PermissionVerdict::NeedsApproval,
            "ask 模式危险工具需审批"
        );
        assert_eq!(
            decide(true, false, PermissionMode::FullAccess),
            PermissionVerdict::Allow,
            "full-access 模式危险工具放行"
        );
        assert_eq!(
            decide(true, false, PermissionMode::Plan),
            PermissionVerdict::Deny,
            "plan 模式写类工具拒绝"
        );
    }

    /// 三态矩阵：requires_approval 与 dangerous 同权
    #[test]
    fn requires_approval_follows_mode_matrix() {
        assert_eq!(
            decide(false, true, PermissionMode::Ask),
            PermissionVerdict::NeedsApproval
        );
        assert_eq!(
            decide(false, true, PermissionMode::FullAccess),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide(false, true, PermissionMode::Plan),
            PermissionVerdict::Deny
        );
    }

    /// dangerous 与 requires_approval 同时成立：仍按模式判定
    #[test]
    fn both_flags_follow_mode_matrix() {
        assert_eq!(
            decide(true, true, PermissionMode::Ask),
            PermissionVerdict::NeedsApproval
        );
        assert_eq!(
            decide(true, true, PermissionMode::FullAccess),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide(true, true, PermissionMode::Plan),
            PermissionVerdict::Deny
        );
    }

    /// 引擎字符串映射与前端别名表对齐
    #[test]
    fn from_engine_str_matches_frontend_alias_table() {
        // ask 族（deep / unattended / auto 均塌缩 ask，安全默认）
        assert_eq!(PermissionMode::from_engine_str(None), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_engine_str(Some("ask")), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_engine_str(Some("deep")), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_engine_str(Some("unattended")), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_engine_str(Some("auto")), PermissionMode::Ask);
        assert_eq!(PermissionMode::from_engine_str(Some("garbage")), PermissionMode::Ask);
        // full 族
        assert_eq!(
            PermissionMode::from_engine_str(Some("full-access")),
            PermissionMode::FullAccess
        );
        assert_eq!(
            PermissionMode::from_engine_str(Some("full")),
            PermissionMode::FullAccess
        );
        assert_eq!(
            PermissionMode::from_engine_str(Some("yolo")),
            PermissionMode::FullAccess
        );
        // plan 族
        assert_eq!(PermissionMode::from_engine_str(Some("plan")), PermissionMode::Plan);
        assert_eq!(
            PermissionMode::from_engine_str(Some("read-only")),
            PermissionMode::Plan
        );
    }

    /// 引擎字面量往返稳定
    #[test]
    fn engine_str_roundtrip_stable() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            assert_eq!(
                PermissionMode::from_engine_str(Some(mode.as_engine_str())),
                mode
            );
        }
        assert_eq!(PermissionMode::Ask.as_engine_str(), "ask");
        assert_eq!(PermissionMode::FullAccess.as_engine_str(), "full-access");
        assert_eq!(PermissionMode::Plan.as_engine_str(), "plan");
    }
}
