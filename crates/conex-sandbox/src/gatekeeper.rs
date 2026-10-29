//! 冻结的命令门禁。静态正则与历史 `CommandGatekeeper::new` 逐条相同，文本不改写。
//! 正则构造失败时 fail-closed：记下完整错误，`patterns()` 对任意输入命中，检查直接 Blocked。
//! 不带 analysis 的入口各调用一次 `crate::assess::assess`；带 analysis 的入口不得再调用。

use regex::RegexSet;

pub use crate::verdict::GatekeeperResult;

/// 进程级共享门禁。正则集固定，无运行时配置。生产路径复用本实例，不要按次 `new`。
pub static SHARED_GATEKEEPER: std::sync::LazyLock<CommandGatekeeper> =
    std::sync::LazyLock::new(CommandGatekeeper::new);

/// 静态红线清单（第一层，对象窄化：只对准确定性毁灭目标）。
const BLOCKED_PATTERNS: &[&str] = &[
    // Unix 毁灭性命令
    r"(?i)\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(/|/\*|\*)(\s|$)",
    r"(?i)\brm\s+--no-preserve-root",
    // PS-01 T1.3（R1 ③ 盲区）：-- 变体纵深防御——语义层已归一
    // 拦截 rm -rf -- /，此处补静态层条目（新增，不改写既有 14 条），
    // host_openers 逐参场景依赖正则兜底（lib.rs:30 注释）
    r"(?i)\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)(\s+--)?\s+(/|/\*|\*|/etc)(/|\s|$)",
    r"(?i)\bdd\s+if=.*of=/dev/sd[a-z]",
    // 文件系统创建/格式化（确定性毁灭目标；S2 窄化时误删，host opener 逐参场景依赖正则兜底）
    r"(?i)\bmkfs(\.[a-z0-9]+)?\s+/dev/sd[a-z]",
    r"(?i)\bmkfs(\.[a-z0-9]+)?\s+/dev/(nvme|vd|mmcblk)[a-z0-9]+",
    // 远程执行红线：curl/wget 管道直接进 shell（语义层视 Dangerous，此处升级为红线）
    r"(?i)\b(curl|wget)\b[^\r\n]*\|\s*(ba|z|d)?sh\b",
    // Windows 毁灭性命令
    r"(?i)\bRemove-Item\b.*(-Recurse|-Force).*[A-Za-z]:(\\|\/)?(\*|\s*$)",
    r"(?i)\bformat\s+[A-Za-z]:",
    r"(?i)\b(del|erase|rd|rmdir)\b.*[A-Za-z]:(\\|\/)?(\*|\s*$)",
    r"(?i)\bFormat-Volume\b",
    r"(?i)\bClear-Disk\b",
    r"(?i)\bStop-Computer\b",
    r"(?i)\bRestart-Computer\b.*-Force",
];

/// 需确认的既有审批正则。
const APPROVAL_PATTERNS: &[&str] = &[
    // 需要确认的 Git 操作
    r"(?i)\bgit\s+push\s+.*--force",
    r"(?i)\bgit\s+push\s+-f\b",
    r"(?i)\bgit\s+reset\s+--hard",
    r"(?i)\bgit\s+clean\s+-[a-z]*f",
    // 发包
    r"(?i)\bnpm\s+publish\b",
    r"(?i)\bcargo\s+publish\b",
    // 系统级操作
    r"(?i)\bsudo\b",
    r"(?i)\brunas\b",
];

pub struct CommandGatekeeper {
    blocked_patterns: RegexSet,
    approval_patterns: RegexSet,
    /// `None` 表示两组正则都编译成功。`Some` 保留失败侧的完整错误文本。
    pattern_error: Option<String>,
}

impl CommandGatekeeper {
    pub fn new() -> Self {
        Self::from_static()
    }

    fn from_static() -> Self {
        Self::from_patterns(BLOCKED_PATTERNS, APPROVAL_PATTERNS)
    }

    /// 用调用方给出的模式编译。任一组失败都 fail-closed，不 panic。
    pub(crate) fn from_patterns(blocked: &[&str], approval: &[&str]) -> Self {
        match (RegexSet::new(blocked), RegexSet::new(approval)) {
            (Ok(blocked_patterns), Ok(approval_patterns)) => Self {
                blocked_patterns,
                approval_patterns,
                pattern_error: None,
            },
            (blocked_set, approval_set) => Self {
                blocked_patterns: fail_closed_regex_set(),
                approval_patterns: fail_closed_regex_set(),
                pattern_error: Some(join_regex_errors(&blocked_set, &approval_set)),
            },
        }
    }

    pub fn pattern_error(&self) -> Option<&str> {
        self.pattern_error.as_deref()
    }

    pub(crate) fn approval_is_match(&self, text: &str) -> bool {
        self.approval_patterns.is_match(text)
    }

    /// 命中用的 blocked 集合。构造失败时该集合对任意输入 `is_match == true`。
    pub fn patterns(&self) -> &RegexSet {
        &self.blocked_patterns
    }

    pub fn check_command(&self, cmd: &str, args: &[&str]) -> GatekeeperResult {
        if self.pattern_error.is_some() {
            return GatekeeperResult::Blocked;
        }
        let full_line = join_command_line(cmd, args);
        let analysis = crate::assess::assess(&full_line);
        self.check_command_with_analysis(&analysis, cmd, args, &full_line)
    }

    /// 复用调用方已算好的 [`crate::assess::Assessment`]。不得再次调用 `assess`。
    pub fn check_command_with_analysis(
        &self,
        analysis: &crate::assess::Assessment,
        cmd: &str,
        args: &[&str],
        full_line: &str,
    ) -> GatekeeperResult {
        self.decide(analysis, cmd, args, full_line, None)
    }

    /// 带工作区上下文。界外 cwd 只把 Allowed 升为 RequiresApproval。
    pub fn check_command_with_context(
        &self,
        cmd: &str,
        args: &[&str],
        cwd: &str,
        workspace_root: &str,
    ) -> GatekeeperResult {
        if self.pattern_error.is_some() {
            return GatekeeperResult::Blocked;
        }
        let full_line = join_command_line(cmd, args);
        let analysis = crate::assess::assess(&full_line);
        self.check_command_with_context_and_analysis(
            &analysis,
            cmd,
            args,
            &full_line,
            cwd,
            workspace_root,
        )
    }

    /// 上下文感知门禁，复用已算 analysis。不得再次调用 `assess`。
    pub fn check_command_with_context_and_analysis(
        &self,
        analysis: &crate::assess::Assessment,
        cmd: &str,
        args: &[&str],
        full_line: &str,
        cwd: &str,
        workspace_root: &str,
    ) -> GatekeeperResult {
        let ctx = crate::verdict::WorkspaceCtx {
            cwd,
            workspace_root,
        };
        self.decide(analysis, cmd, args, full_line, Some(ctx))
    }

    fn decide(
        &self,
        analysis: &crate::assess::Assessment,
        cmd: &str,
        args: &[&str],
        full_line: &str,
        ctx: Option<crate::verdict::WorkspaceCtx<'_>>,
    ) -> GatekeeperResult {
        let pattern_error = self.pattern_error.as_deref();
        if pattern_error.is_some() {
            return GatekeeperResult::Blocked;
        }
        let blocked_hit = set_hits(&self.blocked_patterns, cmd, args, full_line);
        let approval_hit = set_hits(&self.approval_patterns, cmd, args, full_line);
        crate::verdict::floor_of(analysis, pattern_error, blocked_hit, approval_hit, ctx)
    }
}

impl Default for CommandGatekeeper {
    fn default() -> Self {
        Self::new()
    }
}

/// 审计原因文本。模式构造失败时把完整错误接在原因后面。
pub fn audit_reason(reason: &str) -> String {
    match SHARED_GATEKEEPER.pattern_error() {
        Some(detail) => format!("{reason}：{detail}"),
        None => reason.to_string(),
    }
}

/// 与历史实现一致：无参数时整行就是 `cmd`，否则 `cmd` 加空格再拼参数。
fn join_command_line(cmd: &str, args: &[&str]) -> String {
    if args.is_empty() {
        cmd.to_string()
    } else {
        format!("{cmd} {}", args.join(" "))
    }
}

fn set_hits(set: &RegexSet, cmd: &str, args: &[&str], full_line: &str) -> bool {
    set.is_match(cmd) || set.is_match(full_line) || args.iter().any(|arg| set.is_match(arg))
}

/// 单侧失败时原样保留该错误的 Display。两侧都失败时两段全文都保留。
fn join_regex_errors(
    blocked: &Result<RegexSet, regex::Error>,
    approval: &Result<RegexSet, regex::Error>,
) -> String {
    match (blocked.as_ref(), approval.as_ref()) {
        (Err(blocked_err), Err(approval_err)) => format!("{blocked_err}\n{approval_err}"),
        (Err(err), _) | (_, Err(err)) => err.to_string(),
        (Ok(_), Ok(_)) => String::new(),
    }
}

/// 全匹配集合。空集合会把红线放行，因此这里永不返回空集合。
///
/// `""` 在 regex 库中恒可编译（空模式匹配任意输入），因此不写循环重试。
/// 若该前提被打破，显式终止进程——绝不返回空集、绝不用 panic 文案掩盖。
fn fail_closed_regex_set() -> RegexSet {
    match RegexSet::new([""]) {
        Ok(set) => set,
        Err(_error) => std::process::abort(),
    }
}

#[cfg(test)]
mod tests {
    use super::{CommandGatekeeper, GatekeeperResult};

    #[test]
    fn static_patterns_compile() {
        let gate = CommandGatekeeper::new();
        assert!(gate.pattern_error().is_none());
        assert!(!gate.patterns().is_match("git status"));
    }

    #[test]
    fn broken_patterns_fail_closed_for_checks_and_set() {
        let gate = CommandGatekeeper::from_patterns(&["("], &["git"]);
        let err = gate.pattern_error();
        assert!(err.is_some_and(|text| !text.is_empty()));
        assert_eq!(
            gate.check_command("git status", &[]),
            GatekeeperResult::Blocked
        );
        assert_eq!(
            gate.check_command_with_context("ls", &[], "C:/work", "C:/work"),
            GatekeeperResult::Blocked
        );
        assert!(gate.patterns().is_match(""));
        assert!(gate.patterns().is_match("x"));
        assert!(gate.patterns().is_match("git status"));
    }

    #[test]
    fn approval_pattern_failure_also_closes() {
        let gate = CommandGatekeeper::from_patterns(&["git"], &["("]);
        assert!(gate.pattern_error().is_some());
        assert_eq!(
            gate.check_command("echo hi", &[]),
            GatekeeperResult::Blocked
        );
        assert!(gate.patterns().is_match(""));
    }

    /// R3 ②：注入非法模式后，任意命令的门禁地板都必须是 Blocked。
    #[test]
    fn r3_injected_invalid_pattern_fails_closed() {
        let gate = CommandGatekeeper::from_patterns(&["("], &[]);
        for command in ["echo rm -rf /", "git status", "ls", "rm -rf /"] {
            assert_eq!(
                gate.check_command(command, &[]),
                GatekeeperResult::Blocked,
                "{command} 必须 Blocked"
            );
            assert!(gate.patterns().is_match(command));
        }
        assert_eq!(
            gate.check_command("rm", &["-rf", "/"]),
            GatekeeperResult::Blocked
        );
    }
}
