//! 权限规则引擎（R4 T10：消费 dangerous 标记与 requires_approval）
//!
//! 三态判定（Allow / Deny / NeedsApproval）：
//! - 输入：工具 dangerous 标记 + 工具 requires_approval 错误 + 当前权限模式；
//! - ask 模式：dangerous / requires_approval → 需审批；其余放行；
//! - full-access 模式：全部放行（T0–T3 自动）；
//! - plan 模式：写类（dangerous）与越界命令拒绝，不弹窗。
//!
//! 红线先行（S10a）：带红线语义的调用（命令经语义层判定为 Redline）在任何
//! 权限模式下（含 full-access）一律 Deny——红线优先于一切豁免，不经三态矩阵。
//! 判定入口为 [decide_with_redline]；命令面便捷入口为 [decide_command]
//! （内部先跑语义分析再判定，shell 工具执行器直接传入命令文本即可）。
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
///
/// 兼容入口：等价于 [decide_with_redline] 且红线标志为假；调用点若需红线
/// 不可豁免语义，改用 [decide_with_redline] 或 [decide_command]。
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

/// 红线先行判定（S10a：红线不可被权限模式豁免）
///
/// - `redline`：调用是否带红线语义（命令经 `semantics::analyze` 判定
///   `overall_class == Redline`，由 shell 工具/执行器先跑语义后传入）；
/// - 红线命中 → 一律 [PermissionVerdict::Deny]，**不经三态矩阵**：
///   ask 不弹窗、plan 拒绝、full-access/yolo 不豁免；
/// - 非红线 → 委托 [decide] 既有三态矩阵，语义不变。
pub fn decide_with_redline(
    redline: bool,
    dangerous: bool,
    requires_approval: bool,
    mode: PermissionMode,
) -> PermissionVerdict {
    if redline {
        return PermissionVerdict::Deny;
    }
    decide(dangerous, requires_approval, mode)
}

/// 命令面便捷判定（红线先行 + 三态矩阵）
///
/// 直接吃命令行文本：内部先经 `conex_sandbox::semantics::analyze` 判定
/// 整体分类，命中 `Redline` 即走 [decide_with_redline] 红线分支——shell 工具
/// 执行器无需自行依赖语义层，一处接线即获得「红线不可豁免」语义。
pub fn decide_command(
    command_line: &str,
    dangerous: bool,
    requires_approval: bool,
    mode: PermissionMode,
) -> PermissionVerdict {
    use conex_sandbox::semantics::{analyze, CommandClass};
    let redline = analyze(command_line).overall_class == CommandClass::Redline;
    decide_with_redline(redline, dangerous, requires_approval, mode)
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

    /// 红线先行：full-access 下红线命令仍 Deny（核心断言——红线不可豁免）
    #[test]
    fn redline_denied_in_full_access() {
        assert_eq!(
            decide_with_redline(true, false, false, PermissionMode::FullAccess),
            PermissionVerdict::Deny,
            "full-access 下红线命令必须 Deny，不得豁免"
        );
        assert_eq!(
            decide_with_redline(true, true, false, PermissionMode::FullAccess),
            PermissionVerdict::Deny,
            "红线且危险标记同时成立时红线仍优先"
        );
        assert_eq!(
            decide_with_redline(true, false, true, PermissionMode::FullAccess),
            PermissionVerdict::Deny,
            "红线且越界标记同时成立时红线仍优先"
        );
    }

    /// 红线先行：ask / plan 模式同样 Deny（红线不经三态矩阵，不弹窗）
    #[test]
    fn redline_denied_in_all_modes_without_approval() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            assert_eq!(
                decide_with_redline(true, false, false, mode),
                PermissionVerdict::Deny,
                "{mode:?} 下红线必须 Deny，ask 不得升级为 NeedsApproval"
            );
        }
    }

    /// 红线先行：dangerous 与 requires_approval 全组合下红线一律 Deny
    #[test]
    fn redline_denied_across_all_flag_combinations() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            for dangerous in [false, true] {
                for requires_approval in [false, true] {
                    assert_eq!(
                        decide_with_redline(true, dangerous, requires_approval, mode),
                        PermissionVerdict::Deny,
                        "{mode:?} 下 redline=true, dangerous={dangerous}, requires_approval={requires_approval} 必须 Deny"
                    );
                }
            }
        }
    }

    /// 非红线危险命令在 full-access 下 Allow（既有语义不破坏）
    #[test]
    fn non_redline_dangerous_allowed_in_full_access() {
        assert_eq!(
            decide_with_redline(false, true, false, PermissionMode::FullAccess),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_with_redline(false, true, true, PermissionMode::FullAccess),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_with_redline(false, false, true, PermissionMode::FullAccess),
            PermissionVerdict::Allow
        );
    }

    /// 非红线时红线先行入口与既有 decide 矩阵完全一致（兼容委托）
    #[test]
    fn decide_with_redline_false_delegates_to_decide() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            for dangerous in [false, true] {
                for requires_approval in [false, true] {
                    assert_eq!(
                        decide_with_redline(false, dangerous, requires_approval, mode),
                        decide(dangerous, requires_approval, mode),
                        "非红线时语义必须与既有 decide 完全一致"
                    );
                }
            }
        }
    }

    /// 命令面便捷入口：红线命令（含间接执行与复合链）在 full-access 下 Deny
    #[test]
    fn decide_command_redline_denied_in_full_access() {
        for cmd in [
            "rm -rf /",
            "rm -r -f /",
            "echo hi && rm -rf /",
            "sudo bash -c 'rm -rf /'",
            "rd /s /q C:\\",
        ] {
            assert_eq!(
                decide_command(cmd, true, false, PermissionMode::FullAccess),
                PermissionVerdict::Deny,
                "红线命令 {cmd:?} 在 full-access 下必须 Deny"
            );
        }
    }

    /// 命令面便捷入口：非红线危险命令在 full-access 下 Allow（既有语义不破坏）
    #[test]
    fn decide_command_non_redline_dangerous_allowed_in_full_access() {
        assert_eq!(
            decide_command("mkfs.ext4 /dev/sdb", true, false, PermissionMode::FullAccess),
            PermissionVerdict::Allow,
            "非红线危险命令在 full-access 下应放行"
        );
        assert_eq!(
            decide_command("rm -rf ./local-dir", true, false, PermissionMode::FullAccess),
            PermissionVerdict::Allow,
            "删除形态（非红线目标）在 full-access 下按既有矩阵放行"
        );
    }

    /// 命令面便捷入口：普通命令在 ask/plan 模式按既有矩阵判定
    #[test]
    fn decide_command_normal_follows_mode_matrix() {
        assert_eq!(
            decide_command("git status", false, false, PermissionMode::Plan),
            PermissionVerdict::Allow
        );
        assert_eq!(
            decide_command("git status", true, false, PermissionMode::Plan),
            PermissionVerdict::Deny,
            "plan 模式写类工具拒绝"
        );
        assert_eq!(
            decide_command("git status", true, false, PermissionMode::Ask),
            PermissionVerdict::NeedsApproval,
            "ask 模式危险工具需审批"
        );
    }
}
