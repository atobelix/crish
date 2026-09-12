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
//! **命令判定唯一链（P1 权限归一，D5/D8）**：命令「是否放行/拒绝/需审批」的
//! 集中评估唯一实现 = [decide_command_with_revert]（红线先行 → C3 回退护栏 →
//! 三态矩阵），执行器 `call_verdict` 命令路径与 shell 工具执行器共同消费
//! 同一条链（shell 工具侧把门禁层越界/危险形态折算为 `requires_approval`
//! 入链），不再存在第二套命令评估实现（旧独立评估器已并入删除）。
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

/// 命令面判定 + C3 回退护栏（I3-S6）
///
/// 判定顺序（C3 判定点唯一写者挂载于此，C4/S10b 经此挂载）：
/// 1. 红线先行（S10a 既有语义）：`Redline` → [PermissionVerdict::Deny]，不经矩阵；
/// 2. C3 回退护栏（[RevertPolicy]）：GitRevertShape 段 + 面积超阈值 → 需审批
///    （ask/full-access [PermissionVerdict::NeedsApproval]，full-access 不豁免；
///    plan 保持更严 [PermissionVerdict::Deny]）；面积小 → 跳过，按既有矩阵；
/// 3. 既有三态矩阵（[decide]），语义不变。
///
/// 审批人 = 用户：NeedsApproval 走既有 ApprovalGate 链路等待用户裁决，主
/// Agent 仅转呈，无任何单方面批准路径（ref-analysis 01 B3 防线配套）。
pub fn decide_command_with_revert(
    command_line: &str,
    dangerous: bool,
    requires_approval: bool,
    mode: PermissionMode,
    policy: &crate::revert::RevertPolicy,
) -> PermissionVerdict {
    use conex_sandbox::semantics::analyze;
    let analysis = analyze(command_line);
    decide_analysis_with_revert(&analysis, dangerous, requires_approval, mode, policy)
}

/// 复用调用方已算 `SemanticAnalysis`（U-GATE：prepare 路径 analyze 恰 1 次）。
pub fn decide_analysis_with_revert(
    analysis: &conex_sandbox::semantics::SemanticAnalysis,
    dangerous: bool,
    requires_approval: bool,
    mode: PermissionMode,
    policy: &crate::revert::RevertPolicy,
) -> PermissionVerdict {
    use conex_sandbox::semantics::CommandClass;
    if analysis.overall_class == CommandClass::Redline {
        return PermissionVerdict::Deny;
    }
    if let Some(verdict) = policy.gate_verdict(analysis, mode) {
        return verdict;
    }
    decide(dangerous, requires_approval, mode)
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
        assert_eq!(
            PermissionMode::from_engine_str(Some("ask")),
            PermissionMode::Ask
        );
        assert_eq!(
            PermissionMode::from_engine_str(Some("deep")),
            PermissionMode::Ask
        );
        assert_eq!(
            PermissionMode::from_engine_str(Some("unattended")),
            PermissionMode::Ask
        );
        assert_eq!(
            PermissionMode::from_engine_str(Some("auto")),
            PermissionMode::Ask
        );
        assert_eq!(
            PermissionMode::from_engine_str(Some("garbage")),
            PermissionMode::Ask
        );
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
        assert_eq!(
            PermissionMode::from_engine_str(Some("plan")),
            PermissionMode::Plan
        );
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

    /// 命令面便捷入口：非红线危险命令在 full-access 下 Allow（既有语义不破坏）；
    /// mkfs/设备写入属红线清单（S2），full-access 下也必须 Deny
    #[test]
    fn decide_command_non_redline_dangerous_allowed_in_full_access() {
        assert_eq!(
            decide_command(
                "mkfs.ext4 /dev/sdb",
                true,
                false,
                PermissionMode::FullAccess
            ),
            PermissionVerdict::Deny,
            "mkfs 写设备属红线（确定性毁灭目标），full-access 下也必须 Deny"
        );
        assert_eq!(
            decide_command(
                "rm -rf ./local-dir",
                true,
                false,
                PermissionMode::FullAccess
            ),
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

    // ===== G-9：红线 3 远程来源变体（D5 §10.3-3，复用既有红线矩阵）=====

    /// 远程通道语义标注（D5 §10.3 红线 3 / §4.6.1 步骤 3）
    ///
    /// 「远程」= 入站网络通道（远程网关承载，D5 §8.6 远程网关模块）：移动端
    /// 经配对令牌连接桌面端后发起的 run/命令调用。permission.rs 生产代码暂无
    /// remote_source 类型（远程网关 G-5 未落地）——按 D5 契约，远程 run 与
    /// 本地 run 共用同一判定链（decide_with_redline / decide_command_with_revert），
    /// 远程不产生例外分支；本标注仅承载语义命名，调用即走既有判定函数，
    /// 锁定「红线命令经远程通道一律 Deny 且无审批路径」的契约。
    struct RemoteChannel;

    impl RemoteChannel {
        /// 语义判定：远程调用（远程 = 入站网络通道），走既有红线判定链
        fn decide(
            &self,
            redline: bool,
            dangerous: bool,
            requires_approval: bool,
            mode: PermissionMode,
        ) -> PermissionVerdict {
            // 远程与本地共用同一判定链：红线不可豁免（D5 §4.6.1 步骤 3）
            decide_with_redline(redline, dangerous, requires_approval, mode)
        }

        /// 命令面判定：远程 run 内触发命令行文本（语义分析在既有链内完成）
        fn decide_command(
            &self,
            command_line: &str,
            dangerous: bool,
            requires_approval: bool,
            mode: PermissionMode,
        ) -> PermissionVerdict {
            // 同一代码路径，远程不产生例外分支（D5 §4.6.1 步骤 3）
            decide_command(command_line, dangerous, requires_approval, mode)
        }

        /// 回退护栏判定：远程 run 经 C3 链判定（D5 §4.6.1 判定链复用）
        fn decide_command_with_revert(
            &self,
            command_line: &str,
            dangerous: bool,
            requires_approval: bool,
            mode: PermissionMode,
            policy: &crate::revert::RevertPolicy,
        ) -> PermissionVerdict {
            decide_command_with_revert(command_line, dangerous, requires_approval, mode, policy)
        }
    }

    /// 红线 3 远程变体矩阵：远程通道调红线命令 → 全部权限模式 × 全标记组合
    /// 一律 Deny 且无审批路径（复用既有红线矩阵跑远程变体）
    #[test]
    fn redline_remote_source_denied_in_all_modes_without_approval() {
        let remote = RemoteChannel;
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            for dangerous in [false, true] {
                for requires_approval in [false, true] {
                    let verdict = remote.decide(true, dangerous, requires_approval, mode);
                    assert_eq!(
                        verdict,
                        PermissionVerdict::Deny,
                        "远程通道 {mode:?} 下 redline=true, dangerous={dangerous}, requires_approval={requires_approval} 必须 Deny"
                    );
                    assert_ne!(
                        verdict,
                        PermissionVerdict::NeedsApproval,
                        "远程通道红线命令无审批路径：{mode:?} 下不得升级为 NeedsApproval"
                    );
                }
            }
        }
    }

    /// 命令面远程变体：远程 run 内触发红线命令形态（rm 类 / 危险 shell 复合链）
    /// → 全部权限模式 Deny 且无审批路径（对偶 decide_command_redline_denied_in_full_access）
    #[test]
    fn decide_command_remote_source_redline_denied_in_all_modes() {
        let remote = RemoteChannel;
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            for cmd in [
                "rm -rf /",
                "rm -r -f /",
                "echo hi && rm -rf /",
                "sudo bash -c 'rm -rf /'",
                "rd /s /q C:\\",
            ] {
                let verdict = remote.decide_command(cmd, true, false, mode);
                assert_eq!(
                    verdict,
                    PermissionVerdict::Deny,
                    "远程通道红线命令 {cmd:?} 在 {mode:?} 下必须 Deny"
                );
                assert_ne!(
                    verdict,
                    PermissionVerdict::NeedsApproval,
                    "远程通道红线命令 {cmd:?} 在 {mode:?} 下无审批路径"
                );
            }
        }
    }

    /// 远程通道非红线命令按既有三态矩阵判定：远程不引入例外分支、也不额外
    /// 放行——dangerous 在 ask 下仍需审批（与本地一致），plan 下拒绝（observe
    /// 能力上限，D5 §4.2 能力矩阵）
    #[test]
    fn remote_source_non_redline_follows_mode_matrix() {
        let remote = RemoteChannel;
        assert_eq!(
            remote.decide(false, false, false, PermissionMode::FullAccess),
            PermissionVerdict::Allow,
            "远程通道非危险工具 full-access 放行（与本地同语义）"
        );
        assert_eq!(
            remote.decide(false, true, false, PermissionMode::Ask),
            PermissionVerdict::NeedsApproval,
            "远程通道危险工具 ask 下仍需审批（双轨裁决前置，D5 §4.4）"
        );
        assert_eq!(
            remote.decide(false, true, false, PermissionMode::Plan),
            PermissionVerdict::Deny,
            "远程通道危险工具 plan 下拒绝（不弹窗）"
        );
    }

    // ===== I3-S6：C3 大面积回退审批（decide_command_with_revert 链）=====

    use crate::revert::{RevertArea, RevertAssessor, RevertPolicy, RevertTarget};
    use std::sync::Arc;

    /// 固定面积评估器（测试注入）
    #[derive(Debug)]
    struct FixedAreaAssessor(RevertArea);

    impl RevertAssessor for FixedAreaAssessor {
        fn assess(&self, _target: &RevertTarget) -> RevertArea {
            self.0.clone()
        }
    }

    fn policy(area: RevertArea) -> RevertPolicy {
        RevertPolicy::default().with_assessor(Arc::new(FixedAreaAssessor(area)))
    }

    fn large_area() -> RevertArea {
        RevertArea {
            file_count: Some(25),
            line_count: Some(1200),
            cross_directory: true,
            ref_age_seconds: Some(36 * 3600),
        }
    }

    fn small_area() -> RevertArea {
        RevertArea {
            file_count: Some(3),
            line_count: Some(50),
            cross_directory: false,
            ref_age_seconds: Some(3600),
        }
    }

    /// 核心断言：full-access 下大面积回退仍 NeedsApproval（full-access 不
    /// 豁免回退护栏——红线类豁免不可覆盖大面积回退）
    #[test]
    fn full_access_large_revert_needs_approval() {
        assert_eq!(
            decide_command_with_revert(
                "git checkout abc1234",
                true,
                false,
                PermissionMode::FullAccess,
                &policy(large_area()),
            ),
            PermissionVerdict::NeedsApproval,
            "full-access 下大面积回退必须 NeedsApproval"
        );
        // 面积已知超阈值但工具标记非危险：同样触发（C3 与 dangerous 独立）
        assert_eq!(
            decide_command_with_revert(
                "git checkout abc1234",
                false,
                false,
                PermissionMode::FullAccess,
                &policy(large_area()),
            ),
            PermissionVerdict::NeedsApproval
        );
    }

    /// ask 模式下大面积回退 NeedsApproval（审批人 = 用户，走既有审批链路）
    #[test]
    fn ask_large_revert_needs_approval() {
        assert_eq!(
            decide_command_with_revert(
                "git reset --hard HEAD~30",
                true,
                false,
                PermissionMode::Ask,
                &policy(large_area()),
            ),
            PermissionVerdict::NeedsApproval
        );
    }

    /// plan 模式下大面积回退保持更严拒绝（plan 只读：拒绝强度高于审批、
    /// 不弹窗——回退门禁不放宽权限矩阵）
    #[test]
    fn plan_large_revert_denied() {
        assert_eq!(
            decide_command_with_revert(
                "git checkout abc1234",
                true,
                false,
                PermissionMode::Plan,
                &policy(large_area()),
            ),
            PermissionVerdict::Deny,
            "plan 模式大面积回退保持拒绝（既有更严语义优先）"
        );
    }

    /// 面积小（低于全部阈值）→ 按既有矩阵（零打扰，04 C3 验收 3）
    #[test]
    fn small_revert_follows_mode_matrix() {
        // full-access：非危险小回退放行
        assert_eq!(
            decide_command_with_revert(
                "git checkout abc1234",
                false,
                false,
                PermissionMode::FullAccess,
                &policy(small_area()),
            ),
            PermissionVerdict::Allow
        );
        // full-access + dangerous：按既有矩阵放行
        assert_eq!(
            decide_command_with_revert(
                "git reset --hard HEAD~1",
                true,
                false,
                PermissionMode::FullAccess,
                &policy(small_area()),
            ),
            PermissionVerdict::Allow
        );
        // ask + dangerous：按既有矩阵 NeedsApproval
        assert_eq!(
            decide_command_with_revert(
                "git reset --hard HEAD~1",
                true,
                false,
                PermissionMode::Ask,
                &policy(small_area()),
            ),
            PermissionVerdict::NeedsApproval
        );
    }

    /// checkout 分支名（非回退形态）不被 C3 门禁误拦——语义层区分分支名与
    /// 旧 ref，git checkout <旧ref> 的覆盖点在语义分类
    #[test]
    fn checkout_branch_name_not_gated() {
        assert_eq!(
            decide_command_with_revert(
                "git checkout main",
                false,
                false,
                PermissionMode::FullAccess,
                &policy(large_area()),
            ),
            PermissionVerdict::Allow,
            "分支切换不是回退，C3 不拦截"
        );
    }

    /// 非回退命令行为与既有 decide_command 完全一致（兼容委托）
    #[test]
    fn non_revert_commands_unchanged() {
        for cmd in ["git status", "npm test", "ls -la"] {
            for mode in [
                PermissionMode::Ask,
                PermissionMode::FullAccess,
                PermissionMode::Plan,
            ] {
                assert_eq!(
                    decide_command_with_revert(cmd, true, false, mode, &policy(large_area())),
                    decide_command(cmd, true, false, mode),
                    "非回退命令 {cmd:?} 在 {mode:?} 下与既有判定一致"
                );
            }
        }
    }

    /// 红线优先于回退护栏：复合链中红线段（rm -rf /）在任意面积评估下仍 Deny
    #[test]
    fn redline_precedes_revert_gate() {
        assert_eq!(
            decide_command_with_revert(
                "echo hi && rm -rf /",
                true,
                false,
                PermissionMode::FullAccess,
                &policy(large_area()),
            ),
            PermissionVerdict::Deny,
            "红线在任何模式下不可被回退护栏/审批豁免"
        );
    }

    /// 远程通道红线优先于回退护栏：远程 run 内复合链红线段在任意面积评估下
    /// 仍 Deny 且无审批路径（对偶 redline_precedes_revert_gate，D5 §4.6.1
    /// 判定链复用——远程不产生例外分支）
    #[test]
    fn redline_remote_source_precedes_revert_gate() {
        let remote = RemoteChannel;
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            let verdict = remote.decide_command_with_revert(
                "echo hi && rm -rf /",
                true,
                false,
                mode,
                &policy(large_area()),
            );
            assert_eq!(
                verdict,
                PermissionVerdict::Deny,
                "远程通道 {mode:?} 下红线复合链必须 Deny，回退护栏/审批不得豁免"
            );
            assert_ne!(
                verdict,
                PermissionVerdict::NeedsApproval,
                "远程通道红线复合链在 {mode:?} 下无审批路径"
            );
        }
    }
}
