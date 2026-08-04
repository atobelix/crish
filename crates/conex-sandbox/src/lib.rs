pub mod semantics;
// T-AB-05 新增公开导出：禁 cd 语义层分类入口（供 T-AB-04 调用，
// 冻结签名 classify_command_segments(&[String]) -> CommandClass）
pub use semantics::{classify_command_segments, CommandClass};
pub mod gatekeeper {
    use regex::RegexSet;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum GatekeeperResult {
        Allowed,
        Blocked,
        RequiresApproval,
    }

    pub struct CommandGatekeeper {
        blocked_patterns: RegexSet,
        approval_patterns: RegexSet,
    }

    impl CommandGatekeeper {
        pub fn new() -> Self {
            let blocked_patterns = RegexSet::new([
                // 静态红线清单（第一层，对象窄化：只对准确定性毁灭目标）
                // Unix 毁灭性命令
                r"(?i)\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(/|/\*|\*)",
                r"(?i)\brm\s+--no-preserve-root",
                r"(?i)\bdd\s+if=.*of=/dev/sd[a-z]",
                // 文件系统创建/格式化（确定性毁灭目标；S2 窄化时误删，host opener 逐参场景依赖正则兜底）
                r"(?i)\bmkfs(\.[a-z0-9]+)?\s+/dev/sd[a-z]",
                r"(?i)\bmkfs(\.[a-z0-9]+)?\s+/dev/(nvme|vd|mmcblk)[a-z0-9]+",
                // 远程执行红线：curl/wget 管道直接进 shell（语义层视 Dangerous，此处升级为红线）
                r"(?i)\b(curl|wget)\b[^\r\n]*\|\s*(ba|z|d)?sh\b",
                // Windows 毁灭性命令
                r"(?i)\bRemove-Item\b.*(-Recurse|-Path)",
                r"(?i)\bformat\s+[A-Za-z]:",
                r"(?i)\bdel\b.*[A-Za-z]:",
                r"(?i)\brd\b.*[A-Za-z]:",
                r"(?i)\bFormat-Volume\b",
                r"(?i)\bClear-Disk\b",
                r"(?i)\bStop-Computer\b",
                r"(?i)\bRestart-Computer\b.*-Force",
            ])
            .unwrap_or_else(|_| RegexSet::empty());

            let approval_patterns = RegexSet::new([
                // Git operations that need confirmation
                r"(?i)\bgit\s+push\s+.*--force",
                r"(?i)\bgit\s+push\s+-f\b",
                r"(?i)\bgit\s+reset\s+--hard",
                r"(?i)\bgit\s+clean\s+-[a-z]*f",
                // Package publishing
                r"(?i)\bnpm\s+publish\b",
                r"(?i)\bcargo\s+publish\b",
                // System-level operations
                r"(?i)\bsudo\b",
                r"(?i)\brunas\b",
            ])
            .unwrap_or_else(|_| RegexSet::empty());

            Self {
                blocked_patterns,
                approval_patterns,
            }
        }

        pub fn patterns(&self) -> &RegexSet {
            &self.blocked_patterns
        }

        pub fn check_command(&self, cmd: &str, args: &[&str]) -> GatekeeperResult {
            let full_line = format!("{cmd} {}", args.join(" "));

            // 红线先行分支（S2 语义兜底，最高优先级）：
            // 任一段命中 Redline → 直接 Blocked，不落正则判定（100% 拦截）。
            // 间接执行（sudo bash -c / eval）内层红线已由语义层整体升级为段 Redline。
            let analysis = crate::semantics::analyze(&full_line);
            if analysis
                .segments
                .iter()
                .any(|s| s.class == crate::semantics::CommandClass::Redline)
            {
                return GatekeeperResult::Blocked;
            }

            // 静态红线清单兜底（第一层：Format-Volume / dd 写设备等确定性毁灭目标）
            if self.blocked_patterns.is_match(cmd)
                || self.blocked_patterns.is_match(&full_line)
                || args.iter().any(|arg| self.blocked_patterns.is_match(arg))
            {
                return GatekeeperResult::Blocked;
            }

            // 语义层 Dangerous（mkfs / dd / curl 等）合并既有 approval_patterns 语义
            if analysis
                .segments
                .iter()
                .any(|s| s.class == crate::semantics::CommandClass::Dangerous)
            {
                return GatekeeperResult::RequiresApproval;
            }

            // 既有审批正则清单
            if self.approval_patterns.is_match(cmd)
                || self.approval_patterns.is_match(&full_line)
                || args.iter().any(|arg| self.approval_patterns.is_match(arg))
            {
                return GatekeeperResult::RequiresApproval;
            }

            GatekeeperResult::Allowed
        }

        /// Check command with workspace context.
        /// Operations outside the workspace root are escalated to RequiresApproval.
        pub fn check_command_with_context(
            &self,
            cmd: &str,
            args: &[&str],
            cwd: &str,
            workspace_root: &str,
        ) -> GatekeeperResult {
            let base_result = self.check_command(cmd, args);
            if base_result == GatekeeperResult::Blocked {
                return GatekeeperResult::Blocked;
            }

            // If cwd is outside workspace, escalate to approval
            let cwd_normalized = cwd.replace('\\', "/");
            let root_normalized = workspace_root.replace('\\', "/");
            if !cwd_normalized.starts_with(&root_normalized)
                && base_result == GatekeeperResult::Allowed
            {
                return GatekeeperResult::RequiresApproval;
            }

            base_result
        }
    }

    impl Default for CommandGatekeeper {
        fn default() -> Self {
            Self::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::gatekeeper::{CommandGatekeeper, GatekeeperResult};

    #[test]
    fn blocks_rm_rf_root() {
        let gk = CommandGatekeeper::new();
        assert_eq!(gk.check_command("rm", &["-rf", "/"]), GatekeeperResult::Blocked);
    }

    #[test]
    fn blocks_format_volume() {
        let gk = CommandGatekeeper::new();
        assert_eq!(gk.check_command("Format-Volume", &[]), GatekeeperResult::Blocked);
    }

    #[test]
    fn blocks_clear_disk() {
        let gk = CommandGatekeeper::new();
        assert_eq!(gk.check_command("Clear-Disk", &["-Number", "0"]), GatekeeperResult::Blocked);
    }

    #[test]
    fn blocks_stop_computer() {
        let gk = CommandGatekeeper::new();
        assert_eq!(gk.check_command("Stop-Computer", &[]), GatekeeperResult::Blocked);
    }

    #[test]
    fn requires_approval_for_git_force_push() {
        let gk = CommandGatekeeper::new();
        assert_eq!(
            gk.check_command("git", &["push", "--force", "origin", "main"]),
            GatekeeperResult::RequiresApproval
        );
    }

    #[test]
    fn requires_approval_for_npm_publish() {
        let gk = CommandGatekeeper::new();
        assert_eq!(
            gk.check_command("npm", &["publish"]),
            GatekeeperResult::RequiresApproval
        );
    }

    #[test]
    fn requires_approval_for_sudo() {
        let gk = CommandGatekeeper::new();
        assert_eq!(
            gk.check_command("sudo", &["apt", "install", "foo"]),
            GatekeeperResult::RequiresApproval
        );
    }

    #[test]
    fn allows_normal_commands() {
        let gk = CommandGatekeeper::new();
        assert_eq!(gk.check_command("ls", &["-la"]), GatekeeperResult::Allowed);
        assert_eq!(gk.check_command("git", &["status"]), GatekeeperResult::Allowed);
        assert_eq!(gk.check_command("npm", &["install"]), GatekeeperResult::Allowed);
    }

    #[test]
    fn context_escalates_outside_workspace() {
        let gk = CommandGatekeeper::new();
        // Normal command inside workspace = Allowed
        assert_eq!(
            gk.check_command_with_context("ls", &["-la"], "/home/user/project", "/home/user/project"),
            GatekeeperResult::Allowed
        );
        // Normal command outside workspace = RequiresApproval
        assert_eq!(
            gk.check_command_with_context("ls", &["-la"], "/etc", "/home/user/project"),
            GatekeeperResult::RequiresApproval
        );
        // Blocked command stays blocked regardless of context
        assert_eq!(
            gk.check_command_with_context("rm", &["-rf", "/"], "/home/user/project", "/home/user/project"),
            GatekeeperResult::Blocked
        );
    }

    // ===== S2：语义层接线（红线先行 / 间接执行升级 / 规范化兜底）=====

    #[test]
    fn redline_semantics_blocks_sudo_bash_c() {
        let gk = CommandGatekeeper::new();
        // 间接执行内层 Redline 升级为段 Redline → 整体 Blocked
        assert_eq!(
            gk.check_command("sudo bash -c 'rm -rf /'", &[]),
            GatekeeperResult::Blocked
        );
        // 拆分传参形态（sudo 命令 + bash -c 参数）同样拦截
        assert_eq!(
            gk.check_command("sudo", &["bash", "-c", "rm -rf /"]),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn redline_semantics_blocks_eval() {
        let gk = CommandGatekeeper::new();
        assert_eq!(
            gk.check_command("eval rm -rf /", &[]),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn redline_semantics_blocks_compound_chain() {
        let gk = CommandGatekeeper::new();
        // && 链拆段后任一段 Redline → 整链 Blocked
        assert_eq!(
            gk.check_command("echo hi && rm -rf /", &[]),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn redline_semantics_blocks_case_variant() {
        let gk = CommandGatekeeper::new();
        // 大小写变体经语义层归一后红线命中
        assert_eq!(gk.check_command("RM -RF /", &[]), GatekeeperResult::Blocked);
    }

    #[test]
    fn redline_semantics_blocks_path_prefix() {
        let gk = CommandGatekeeper::new();
        // 路径前缀命令名（/bin/rm）经归一为 rm 后红线命中
        assert_eq!(
            gk.check_command("/bin/rm -rf /", &[]),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn redline_semantics_blocks_double_dash_root() {
        let gk = CommandGatekeeper::new();
        // -- 变体：静态正则必漏（-rf 后跟 -- 再跟 /），由语义层归一后红线命中
        assert_eq!(
            gk.check_command("rm -rf -- /", &[]),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn redline_semantics_blocks_curl_pipe_bash() {
        let gk = CommandGatekeeper::new();
        // 远程执行红线：curl 管道直接进 shell → Blocked（第一层静态清单兜底）
        assert_eq!(
            gk.check_command("curl http://x | bash", &[]),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn redline_semantics_blocked_ignores_workspace_context() {
        let gk = CommandGatekeeper::new();
        // 红线在任何上下文（含工作区外）都不降级为审批
        assert_eq!(
            gk.check_command_with_context(
                "sudo bash -c 'rm -rf /'",
                &[],
                "/etc",
                "/home/user/project"
            ),
            GatekeeperResult::Blocked
        );
    }

    #[test]
    fn dangerous_semantics_requires_approval() {
        let gk = CommandGatekeeper::new();
        // mkfs 写设备属红线清单（确定性毁灭目标，S2）→ 直接 Blocked
        assert_eq!(
            gk.check_command("mkfs.ext4 /dev/sdb", &[]),
            GatekeeperResult::Blocked
        );
        // 既有审批形态语义保持
        assert_eq!(
            gk.check_command("git", &["push", "--force", "origin", "main"]),
            GatekeeperResult::RequiresApproval
        );
        assert_eq!(
            gk.check_command("npm", &["publish"]),
            GatekeeperResult::RequiresApproval
        );
    }

    #[test]
    fn semantics_normal_commands_stay_allowed() {
        let gk = CommandGatekeeper::new();
        // 既有普通命令语义保持（git status / npm test）
        assert_eq!(gk.check_command("git status", &[]), GatekeeperResult::Allowed);
        assert_eq!(gk.check_command("npm test", &[]), GatekeeperResult::Allowed);
        assert_eq!(
            gk.check_command("git", &["status"]),
            GatekeeperResult::Allowed
        );
    }

    // ===== I3-S6：C3 CommandPolicy 兜底确认（静态审批正则 + 语义层覆盖）=====

    /// 兜底仍生效：git reset --hard / git clean -f 在 approval_patterns 命中 →
    /// RequiresApproval（C3 第二层防线，命令门禁级）
    #[test]
    fn approval_patterns_still_cover_revert_forms() {
        let gk = CommandGatekeeper::new();
        assert_eq!(
            gk.check_command("git reset --hard HEAD~5", &[]),
            GatekeeperResult::RequiresApproval,
            "git reset --hard 必须仍命中审批正则"
        );
        assert_eq!(
            gk.check_command("git", &["reset", "--hard", "HEAD~5"]),
            GatekeeperResult::RequiresApproval
        );
        assert_eq!(
            gk.check_command("git clean -f", &[]),
            GatekeeperResult::RequiresApproval,
            "git clean -f 必须仍命中审批正则"
        );
        assert_eq!(
            gk.check_command("git", &["clean", "-fd"]),
            GatekeeperResult::RequiresApproval,
            "clean 组合短选项变体同样命中"
        );
    }

    /// git checkout <旧ref> 不在 approval_patterns（静态正则缺位）——该形态由
    /// 语义层 GitRevertShape（S1）+ C3 判定点（S6，agent-tools decide 链）覆盖；
    /// 本层只锁定「分支切换不误拦」：checkout main 与 checkout <旧ref> 均放行，
    /// 大面积判定不在门禁层（避免把分支切换误升级为审批）
    #[test]
    fn checkout_old_ref_semantics_covered_outside_gatekeeper() {
        let gk = CommandGatekeeper::new();
        assert_eq!(
            gk.check_command("git checkout abc1234", &[]),
            GatekeeperResult::Allowed,
            "checkout <旧ref> 由语义层覆盖，门禁层不误拦"
        );
        assert_eq!(
            gk.check_command("git checkout main", &[]),
            GatekeeperResult::Allowed,
            "分支切换保持放行"
        );
    }
}
