pub mod semantics;
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
                // Unix destructive commands
                r"(?i)\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(/|/\*|\*)",
                r"(?i)\brm\s+--no-preserve-root",
                r"(?i)\bdd\s+if=.*of=/dev/sd[a-z]",
                r"(?i)\bmkfs(\.[a-z0-9]+)?\s+/dev/sd[a-z]",
                // Windows destructive commands
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

            // Check blocked patterns first (highest priority)
            if self.blocked_patterns.is_match(cmd)
                || self.blocked_patterns.is_match(&full_line)
                || args.iter().any(|arg| self.blocked_patterns.is_match(arg))
            {
                return GatekeeperResult::Blocked;
            }

            // Check approval patterns
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
}
