//! 多语言解释器内联脚本深度审计引擎（BC10-2）。
//!
//! 覆盖 Python (-c), Node.js (-e, --eval, -p, --print), Bash (-c),
//! Ruby (-e), Perl (-e), PHP (-r) 等内联脚本开关提取。
//! 深度分析内联脚本中的破坏性 API：
//! 1. 进程与 Shell 执行（os.system, subprocess.Popen, child_process.execSync 等）提取子命令并递归红线审查；
//! 2. 文件破坏操作（shutil.rmtree, fs.rmSync, unlinkSync, os.remove 等）识别删除目标与物理红线；
//! 3. 彻底切断 Indirect 门禁直接放行漏洞，内联脚本高危操作升级审批或阻断。

use regex::Regex;
use std::sync::LazyLock;

use crate::semantics::{CommandClass, SemanticAnalysis};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterpreterKind {
    Python,
    Node,
    Bash,
    Ruby,
    Perl,
    Php,
    PowerShell,
    Cmd,
}

pub struct PolyglotCodeInspector;

static PY_SYSTEM_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bos\.(?:system|popen)\s*\(\s*(?:r|f|b)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')\s*\)"#)
        .expect("valid regex")
});

static PY_SUBPROCESS_STR_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\(\s*(?:r|f|b)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static PY_SUBPROCESS_LIST_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\(\s*\[(?P<list>[^\]]+)\]"#)
        .expect("valid regex")
});

static PY_STRING_LITERAL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:r|f|b)?(?:"(?P<item_d>(?:\\.|[^"\\])*)"|'(?P<item_s>(?:\\.|[^'\\])*)')"#).expect("valid regex")
});

static PY_GENERAL_PROC_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:os\.system|os\.popen|subprocess\.(?:run|Popen|call|check_call|check_output))\b"#)
        .expect("valid regex")
});

static NODE_EXEC_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\bchild_process\.)?(?:exec|execSync)\s*\(\s*(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)'|`(?P<cmd_b>(?:\\.|[^`\\])*)`)"#)
        .expect("valid regex")
});

static NODE_SPAWN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\bchild_process\.)?(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)'|`(?P<cmd_b>(?:\\.|[^`\\])*)`)(?:\s*,\s*\[(?P<args>[^\]]*)\])?"#)
        .expect("valid regex")
});

static NODE_GENERAL_PROC_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:child_process\b|execSync|spawnSync)\b"#).expect("valid regex")
});

static RUBY_SYSTEM_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:system|exec)\s*(?:\(\s*)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static BACKTICK_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"`(?P<cmd>[^`]+)`"#).expect("valid regex"));

static RUBY_PERCENT_X_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"%x(?:\((?P<cmd1>[^\)]*)\)|\[(?P<cmd2>[^\]]*)\]|\{(?P<cmd3>[^\}]*)\})"#)
        .expect("valid regex")
});

static PERL_SYSTEM_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:system|exec)\s*(?:\(\s*)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static PERL_QX_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bqx(?:\((?P<cmd1>[^\)]*)\)|\[(?P<cmd2>[^\]]*)\]|\{(?P<cmd3>[^\}]*)\})"#)
        .expect("valid regex")
});

static PHP_SYSTEM_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:system|exec|passthru|shell_exec|popen|proc_open)\s*(?:\(\s*)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static PY_DESTRUCTIVE_LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir))\s*\(\s*(?:r|f|b)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static PY_PATHLIB_DESTRUCTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:pathlib\.)?Path\s*\(\s*(?:r|f|b)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')\s*\)\.(?:unlink|rmdir)"#)
        .expect("valid regex")
});

static PY_DESTRUCTIVE_GENERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir)\b"#).expect("valid regex")
});

static NODE_DESTRUCTIVE_LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\bfs\.)?(?:promises\.)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(\s*(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)'|`(?P<path_b>(?:\\.|[^`\\])*)`)"#)
        .expect("valid regex")
});

static NODE_DESTRUCTIVE_GENERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\bfs\.)?(?:promises\.)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\b"#)
        .expect("valid regex")
});

static RUBY_DESTRUCTIVE_LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\bFileUtils\.(?:rm_rf|rm_r|rm)|\bFile\.(?:delete|unlink)|\bDir\.(?:delete|rmdir))\s*(?:\(\s*)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static RUBY_DESTRUCTIVE_GENERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\bFileUtils\.(?:rm_rf|rm_r|rm)|\bFile\.(?:delete|unlink)|\bDir\.(?:delete|rmdir))\b"#)
        .expect("valid regex")
});

static PERL_DESTRUCTIVE_LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:\b(?:File::Path::)?(?:rmtree|remove_tree)|\b(?:unlink|rmdir))\s*(?:\(\s*)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static PERL_DESTRUCTIVE_GENERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:rmtree|remove_tree|unlink|rmdir)\b"#).expect("valid regex")
});

static PHP_DESTRUCTIVE_LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:unlink|rmdir)\s*\(\s*(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#)
        .expect("valid regex")
});

static PHP_DESTRUCTIVE_GENERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:unlink|rmdir)\b"#).expect("valid regex")
});

static PY_REFLECTION_DANGER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:ctypes\b|__import__|importlib\b|eval\s*\(|exec\s*\(|compile\s*\()"#)
        .expect("valid regex")
});

static NODE_REFLECTION_DANGER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:eval\s*\(|Function\s*\(|vm\.runIn|process\.exit\s*\()"#)
        .expect("valid regex")
});

static GENERAL_SCRIPT_REFLECTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:eval\s*[\(\{]|eval\b|passthru\b|proc_open\b)"#).expect("valid regex")
});

static PY_PURE_PRINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*print\s*\([^)]*\)\s*$"#).expect("valid regex")
});

static NODE_PURE_PRINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*console\.(?:log|info|warn|error)\s*\([^)]*\)\s*;?\s*$"#).expect("valid regex")
});

static RUBY_PURE_PRINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*(?:puts|print|p)\s+.*$"#).expect("valid regex")
});

static PHP_PURE_PRINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*(?:echo|print)\s+.*;?\s*$"#).expect("valid regex")
});

static PERL_PURE_PRINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*print\s+.*;?\s*$"#).expect("valid regex")
});

impl PolyglotCodeInspector {
    /// 识别解释器类型
    pub fn detect_interpreter(command: &str) -> Option<InterpreterKind> {
        let clean = command.trim();
        let name = clean
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(clean)
            .strip_suffix(".exe")
            .unwrap_or_else(|| {
                clean
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(clean)
                    .strip_suffix(".EXE")
                    .unwrap_or(clean.rsplit(['/', '\\']).next().unwrap_or(clean))
            })
            .to_lowercase();

        match name.as_str() {
            "python" | "python3" | "py" | "pythonw" => Some(InterpreterKind::Python),
            "node" | "nodejs" | "bun" | "deno" => Some(InterpreterKind::Node),
            "bash" | "sh" | "zsh" => Some(InterpreterKind::Bash),
            "ruby" => Some(InterpreterKind::Ruby),
            "perl" => Some(InterpreterKind::Perl),
            "php" => Some(InterpreterKind::Php),
            "pwsh" | "powershell" => Some(InterpreterKind::PowerShell),
            "cmd" => Some(InterpreterKind::Cmd),
            _ => None,
        }
    }

    /// 提取内联脚本
    pub fn extract_inline_script(kind: InterpreterKind, args: &[String]) -> Option<String> {
        match kind {
            InterpreterKind::Python | InterpreterKind::Bash => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    if arg == "-c" {
                        let rest: Vec<&String> = iter.by_ref().collect();
                        if !rest.is_empty() {
                            return Some(
                                rest.iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            );
                        }
                        return None;
                    }
                    if arg.starts_with("-c") && arg.len() > 2 {
                        let content = arg[2..].trim_start_matches('=').trim_matches(['"', '\'']);
                        return Some(content.to_string());
                    }
                }
                None
            }
            InterpreterKind::Node => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    if arg == "-e" || arg == "--eval" || arg == "-p" || arg == "--print" {
                        let rest: Vec<&String> = iter.by_ref().collect();
                        if !rest.is_empty() {
                            return Some(
                                rest.iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            );
                        }
                        return None;
                    }
                    if (arg.starts_with("-e") && arg.len() > 2)
                        || (arg.starts_with("-p") && arg.len() > 2)
                    {
                        let content = arg[2..].trim_start_matches('=').trim_matches(['"', '\'']);
                        return Some(content.to_string());
                    }
                    if arg.starts_with("--eval=") {
                        return Some(arg[7..].trim_matches(['"', '\'']).to_string());
                    }
                    if arg.starts_with("--print=") {
                        return Some(arg[8..].trim_matches(['"', '\'']).to_string());
                    }
                }
                None
            }
            InterpreterKind::Ruby | InterpreterKind::Perl => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    if arg == "-e" || arg == "-E" {
                        let rest: Vec<&String> = iter.by_ref().collect();
                        if !rest.is_empty() {
                            return Some(
                                rest.iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            );
                        }
                        return None;
                    }
                    if (arg.starts_with("-e") || arg.starts_with("-E")) && arg.len() > 2 {
                        let content = arg[2..].trim_start_matches('=').trim_matches(['"', '\'']);
                        return Some(content.to_string());
                    }
                }
                None
            }
            InterpreterKind::Php => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    if arg == "-r" || arg == "-R" {
                        let rest: Vec<&String> = iter.by_ref().collect();
                        if !rest.is_empty() {
                            return Some(
                                rest.iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            );
                        }
                        return None;
                    }
                    if (arg.starts_with("-r") || arg.starts_with("-R")) && arg.len() > 2 {
                        let content = arg[2..].trim_start_matches('=').trim_matches(['"', '\'']);
                        return Some(content.to_string());
                    }
                }
                None
            }
            InterpreterKind::PowerShell => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    let lower = arg.to_lowercase();
                    if lower == "-c" || lower == "-command" || lower == "/c" || lower == "/command"
                    {
                        let rest: Vec<&String> = iter.by_ref().collect();
                        if !rest.is_empty() {
                            return Some(
                                rest.iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            );
                        }
                    }
                    if lower.starts_with("-command=") || lower.starts_with("/command=") {
                        return Some(arg[9..].trim_matches(['"', '\'']).to_string());
                    }
                }
                None
            }
            InterpreterKind::Cmd => {
                let mut iter = args.iter();
                while let Some(arg) = iter.next() {
                    let lower = arg.to_lowercase();
                    if lower == "/c" || lower == "/k" {
                        let rest: Vec<&String> = iter.by_ref().collect();
                        if !rest.is_empty() {
                            return Some(
                                rest.iter()
                                    .map(|s| s.as_str())
                                    .collect::<Vec<_>>()
                                    .join(" "),
                            );
                        }
                    }
                    if lower.starts_with("/c") && lower.len() > 2 {
                        return Some(arg[2..].trim_start().to_string());
                    }
                    if lower.starts_with("/k") && lower.len() > 2 {
                        return Some(arg[2..].trim_start().to_string());
                    }
                }
                None
            }
        }
    }

    /// 深度审查多语言内联脚本
    pub fn inspect_script(kind: InterpreterKind, script: &str, depth: usize) -> SemanticAnalysis {
        // 0. Shell/PowerShell/Cmd 脚本直接走 Shell AST / 分词语义层
        if matches!(
            kind,
            InterpreterKind::Bash | InterpreterKind::PowerShell | InterpreterKind::Cmd
        ) {
            return crate::semantics::analyze_depth_pub(script, depth + 1);
        }

        let mut delete_targets = Vec::new();
        let mut git_revert_forms = Vec::new();
        let mut has_indirect_delete = false;
        let mut has_dangerous = false;

        // 1. 递归提取并审查嵌套的 Shell 子命令
        let nested_cmds = Self::extract_nested_shell_commands(kind, script);
        for nested in nested_cmds {
            let res = crate::semantics::analyze_depth_pub(&nested, depth + 1);
            if res.overall_class == CommandClass::Redline
                || res.segments.iter().any(|s| s.class == CommandClass::Redline)
            {
                return redline_only_analysis();
            }

            if res.overall_class == CommandClass::DeleteShape || res.has_indirect_delete {
                has_indirect_delete = true;
                for t in res.delete_targets {
                    if !delete_targets.contains(&t) {
                        delete_targets.push(t);
                    }
                }
            }
            if res.overall_class == CommandClass::GitRevertShape {
                for f in res.git_revert_forms {
                    if !git_revert_forms.contains(&f) {
                        git_revert_forms.push(f);
                    }
                }
            }
            // 只要调用了系统子进程执行命令，无论命令本身是否普通，在内联脚本中均提升为危险
            has_dangerous = true;
        }

        // 2. 原生文件破坏性 API 提取与物理红线审查
        let (extracted_paths, found_destructive_general) =
            Self::extract_destructive_file_ops(kind, script);
        if found_destructive_general {
            has_indirect_delete = true;
        }

        for path in extracted_paths {
            if is_critical_path_str(&path) {
                // 试图通过解释器删除根目录或系统核心关键目录 -> 物理红线立即拦截！
                return redline_only_analysis();
            }
            has_indirect_delete = true;
            if !delete_targets.contains(&path) {
                delete_targets.push(path);
            }
        }

        // 3. 动态代码执行、反射与底层 API
        if Self::has_dynamic_or_reflection_execution(kind, script) {
            has_dangerous = true;
        }

        // 4. 纯只读打印白名单豁免：无子命令、无删除、无反射、仅单纯 stdout 打印
        if !has_indirect_delete
            && !has_dangerous
            && delete_targets.is_empty()
            && Self::is_pure_read_only_print(kind, script)
        {
            return SemanticAnalysis {
                segments: Vec::new(),
                overall_class: CommandClass::Normal,
                delete_targets: Vec::new(),
                git_revert_forms: Vec::new(),
                has_indirect_delete: false,
                decoded_payload: None,
            };
        }

        // 5. 确定最终分类与保底原则：
        // 内联动态执行除明确只读纯打印外，天然具有副作用不可控性，至少提升为 Dangerous / DeleteShape
        let overall_class = if has_indirect_delete {
            CommandClass::DeleteShape
        } else if has_dangerous {
            CommandClass::Dangerous
        } else {
            // 保底兜底：任意未识别的动态内联脚本一律提升为 Dangerous 触发人工确认，杜绝以 Normal 放行
            CommandClass::Dangerous
        };

        SemanticAnalysis {
            segments: Vec::new(),
            overall_class,
            delete_targets,
            git_revert_forms,
            has_indirect_delete,
            decoded_payload: None,
        }
    }

    /// 提取内联脚本中调用的系统 Shell 子命令
    pub fn extract_nested_shell_commands(kind: InterpreterKind, script: &str) -> Vec<String> {
        let mut commands = Vec::new();
        match kind {
            InterpreterKind::Python => {
                for cap in PY_SYSTEM_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in PY_SUBPROCESS_STR_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in PY_SUBPROCESS_LIST_REGEX.captures_iter(script) {
                    if let Some(list_match) = cap.name("list") {
                        let list_content = list_match.as_str();
                        let mut items = Vec::new();
                        for item_cap in PY_STRING_LITERAL_REGEX.captures_iter(list_content) {
                            if let Some(item_s) = get_captured_str(&item_cap, &["item_d", "item_s"]) {
                                items.push(clean_escaped_string(item_s));
                            }
                        }
                        if !items.is_empty() {
                            commands.push(items.join(" "));
                        }
                    }
                }
            }
            InterpreterKind::Node => {
                for cap in NODE_EXEC_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s", "cmd_b"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in NODE_SPAWN_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s", "cmd_b"]) {
                        let cmd_str = clean_escaped_string(s);
                        if let Some(args_m) = cap.name("args") {
                            let mut items = vec![cmd_str];
                            for item_cap in PY_STRING_LITERAL_REGEX.captures_iter(args_m.as_str()) {
                                if let Some(item_val) = get_captured_str(&item_cap, &["item_d", "item_s"]) {
                                    items.push(clean_escaped_string(item_val));
                                }
                            }
                            commands.push(items.join(" "));
                        } else {
                            commands.push(cmd_str);
                        }
                    }
                }
            }
            InterpreterKind::Ruby => {
                for cap in RUBY_SYSTEM_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in BACKTICK_REGEX.captures_iter(script) {
                    if let Some(m) = cap.name("cmd") {
                        commands.push(clean_escaped_string(m.as_str()));
                    }
                }
                for cap in RUBY_PERCENT_X_REGEX.captures_iter(script) {
                    for key in ["cmd1", "cmd2", "cmd3"] {
                        if let Some(m) = cap.name(key) {
                            commands.push(clean_escaped_string(m.as_str()));
                        }
                    }
                }
            }
            InterpreterKind::Perl => {
                for cap in PERL_SYSTEM_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in BACKTICK_REGEX.captures_iter(script) {
                    if let Some(m) = cap.name("cmd") {
                        commands.push(clean_escaped_string(m.as_str()));
                    }
                }
                for cap in PERL_QX_REGEX.captures_iter(script) {
                    for key in ["cmd1", "cmd2", "cmd3"] {
                        if let Some(m) = cap.name(key) {
                            commands.push(clean_escaped_string(m.as_str()));
                        }
                    }
                }
            }
            InterpreterKind::Php => {
                for cap in PHP_SYSTEM_REGEX.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in BACKTICK_REGEX.captures_iter(script) {
                    if let Some(m) = cap.name("cmd") {
                        commands.push(clean_escaped_string(m.as_str()));
                    }
                }
            }
            _ => {}
        }

        commands
    }

    /// 提取文件系统破坏性操作目标与泛化特征
    pub fn extract_destructive_file_ops(
        kind: InterpreterKind,
        script: &str,
    ) -> (Vec<String>, bool) {
        let mut paths = Vec::new();
        let mut found_general = false;

        match kind {
            InterpreterKind::Python => {
                for cap in PY_DESTRUCTIVE_LITERAL.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                for cap in PY_PATHLIB_DESTRUCTIVE.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if PY_DESTRUCTIVE_GENERAL.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Node => {
                for cap in NODE_DESTRUCTIVE_LITERAL.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s", "path_b"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if NODE_DESTRUCTIVE_GENERAL.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Ruby => {
                for cap in RUBY_DESTRUCTIVE_LITERAL.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if RUBY_DESTRUCTIVE_GENERAL.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Perl => {
                for cap in PERL_DESTRUCTIVE_LITERAL.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if PERL_DESTRUCTIVE_GENERAL.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Php => {
                for cap in PHP_DESTRUCTIVE_LITERAL.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if PHP_DESTRUCTIVE_GENERAL.is_match(script) {
                    found_general = true;
                }
            }
            _ => {}
        }

        (paths, found_general)
    }

    /// 检测动态求值与底层反射
    pub fn has_dynamic_or_reflection_execution(kind: InterpreterKind, script: &str) -> bool {
        match kind {
            InterpreterKind::Python => {
                PY_REFLECTION_DANGER.is_match(script) || PY_GENERAL_PROC_REGEX.is_match(script)
            }
            InterpreterKind::Node => {
                NODE_REFLECTION_DANGER.is_match(script) || NODE_GENERAL_PROC_REGEX.is_match(script)
            }
            _ => GENERAL_SCRIPT_REFLECTION.is_match(script),
        }
    }

    /// 判定是否属于纯只读标准输出打印白名单
    pub fn is_pure_read_only_print(kind: InterpreterKind, script: &str) -> bool {
        match kind {
            InterpreterKind::Python => PY_PURE_PRINT.is_match(script),
            InterpreterKind::Node => NODE_PURE_PRINT.is_match(script),
            InterpreterKind::Ruby => RUBY_PURE_PRINT.is_match(script),
            InterpreterKind::Php => PHP_PURE_PRINT.is_match(script),
            InterpreterKind::Perl => PERL_PURE_PRINT.is_match(script),
            _ => false,
        }
    }
}

/// 判定路径字符串是否为盘符根或系统核心关键目录
pub fn is_critical_path_str(path: &str) -> bool {
    let clean = path.trim().replace('\\', "/");
    let upper = clean.to_ascii_uppercase();

    // 1. Unix 根目录及变体
    if clean == "/" || clean == "/*" || clean == "/." {
        return true;
    }

    // 2. Windows 驱动盘根（C:/, C:, C:/* 等）
    if upper.len() >= 2 && upper.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
        if &upper[1..2] == ":" {
            if upper.len() == 2
                || (upper.len() == 3 && &upper[2..3] == "/")
                || (upper.len() >= 4 && (&upper[2..4] == "/*" || &upper[2..4] == "/."))
            {
                return true;
            }
        }
    }

    // 3. 常见 Unix 核心关键目录
    const UNIX_CRITICAL: &[&str] = &[
        "/BIN", "/SBIN", "/USR/BIN", "/USR/SBIN", "/ETC",
        "/BOOT", "/DEV", "/PROC", "/SYS", "/LIB", "/LIB64", "/VAR/RUN",
    ];
    for crit in UNIX_CRITICAL {
        if upper == *crit || upper.starts_with(&format!("{crit}/")) {
            return true;
        }
    }

    // 4. Windows 核心关键目录
    const WIN_CRITICAL: &[&str] = &[
        "WINDOWS", "PROGRAM FILES", "PROGRAM FILES (X86)",
        "PROGRAMDATA/MICROSOFT", "SYSTEM VOLUME INFORMATION",
        "RECOVERY", "BOOT", "$RECYCLE.BIN",
    ];
    if upper.len() >= 3 && &upper[1..3] == ":/" {
        let after_drive = &upper[3..];
        for win_pat in WIN_CRITICAL {
            if after_drive == *win_pat || after_drive.starts_with(&format!("{win_pat}/")) {
                return true;
            }
        }
    }

    // 5. 敏感凭据目录
    if upper.contains("/.SSH")
        || upper.contains("/.GNUPG")
        || upper.contains("/.AWS")
        || upper.contains("/.KUBE")
        || upper.contains("/.GITCONFIG")
        || upper.starts_with("~/.SSH")
        || upper.starts_with("~/.GNUPG")
        || upper.starts_with("~/.AWS")
    {
        return true;
    }

    false
}

/// 还原字符串中的转义符（如 \\ -> \）
fn clean_escaped_string(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if next == '\\' || next == '"' || next == '\'' || next == 'n' || next == 't' {
                    chars.next();
                    match next {
                        'n' => result.push('\n'),
                        't' => result.push('\t'),
                        other => result.push(other),
                    }
                    continue;
                }
            }
        }
        result.push(c);
    }
    result
}

fn get_captured_str<'a>(cap: &'a regex::Captures<'a>, names: &[&str]) -> Option<&'a str> {
    for name in names {
        if let Some(m) = cap.name(name) {
            return Some(m.as_str());
        }
    }
    None
}

fn redline_only_analysis() -> SemanticAnalysis {
    SemanticAnalysis {
        segments: Vec::new(),
        overall_class: CommandClass::Redline,
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gatekeeper::{GatekeeperResult, SHARED_GATEKEEPER};
    use crate::semantics::analyze;

    #[test]
    fn test_python_inline_redline_subprocesses() {
        let cases = [
            r#"python -c "import os; os.system('rm -rf /')""#,
            r#"python3 -c "import os; os.popen('rm -rf /')""#,
            r#"py -c "import subprocess; subprocess.Popen(['rm', '-rf', '/'])""#,
            r#"python -c "import subprocess; subprocess.run('rm -rf /', shell=True)""#,
            r#"python -c "import subprocess; subprocess.call(['rm', '-rf', '/'])""#,
        ];
        for cmd in cases {
            let a = analyze(cmd);
            assert_eq!(a.overall_class, CommandClass::Redline, "cmd failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::Blocked, "gk failed: {cmd}");
        }
    }

    #[test]
    fn test_python_inline_destructive_files() {
        let redline_cases = [
            r#"python -c "import shutil; shutil.rmtree('/')""#,
            r#"python -c "import shutil; shutil.rmtree('/etc')""#,
            r#"python -c "import shutil; shutil.rmtree('C:\\')""#,
            r#"python -c "import shutil; shutil.rmtree('C:\\Windows')""#,
            r#"python -c "import os; os.remove('/etc/hosts')""#,
            r#"python -c "import os; os.unlink('/bin/sh')""#,
            r#"python -c "import pathlib; pathlib.Path('/etc/passwd').unlink()""#,
        ];
        for cmd in redline_cases {
            let a = analyze(cmd);
            assert_eq!(a.overall_class, CommandClass::Redline, "cmd failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::Blocked, "gk failed: {cmd}");
        }

        let delete_cases = [
            (
                r#"python -c "import shutil; shutil.rmtree('temp_dir')""#,
                "temp_dir",
            ),
            (
                r#"python -c "import os; os.remove('sample.txt')""#,
                "sample.txt",
            ),
            (
                r#"python -c "import os; os.unlink('./sub/target.bin')""#,
                "./sub/target.bin",
            ),
        ];
        for (cmd, target) in delete_cases {
            let a = analyze(cmd);
            assert!(
                a.overall_class == CommandClass::Indirect || a.overall_class == CommandClass::DeleteShape,
                "cmd failed: {cmd}, actual: {:?}",
                a.overall_class
            );
            assert!(a.has_indirect_delete, "has_indirect_delete failed: {cmd}");
            assert!(a.delete_targets.contains(&target.to_string()), "target failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::RequiresApproval, "gk failed: {cmd}");
        }
    }

    #[test]
    fn test_node_inline_scripts() {
        let redlines = [
            r#"node -e "require('child_process').execSync('rm -rf /')""#,
            r#"node --eval "require('child_process').spawnSync('rm', ['-rf', '/'])""#,
            r#"nodejs -e "const fs = require('fs'); fs.rmSync('/', {recursive: true})""#,
            r#"bun -e "const fs = require('fs'); fs.rmdirSync('C:\\')""#,
            r#"deno -e "const fs = require('fs'); fs.unlinkSync('/etc/shadow')""#,
        ];
        for cmd in redlines {
            let a = analyze(cmd);
            assert_eq!(a.overall_class, CommandClass::Redline, "cmd failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::Blocked, "gk failed: {cmd}");
        }

        let deletes = [
            (
                r#"node -e "const fs = require('fs'); fs.rmSync('./dist', {recursive: true})""#,
                "./dist",
            ),
            (
                r#"node --eval "const fs = require('fs'); fs.unlinkSync('out.txt')""#,
                "out.txt",
            ),
        ];
        for (cmd, target) in deletes {
            let a = analyze(cmd);
            assert!(
                a.overall_class == CommandClass::Indirect || a.overall_class == CommandClass::DeleteShape,
                "cmd failed: {cmd}, actual: {:?}",
                a.overall_class
            );
            assert!(a.has_indirect_delete);
            assert!(a.delete_targets.contains(&target.to_string()));
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::RequiresApproval);
        }
    }

    #[test]
    fn test_ruby_perl_php_inline_scripts() {
        let redlines = [
            r#"ruby -e "system('rm -rf /')""#,
            r#"ruby -e "FileUtils.rm_rf('/')""#,
            r#"ruby -e "File.delete('/etc/passwd')""#,
            r#"perl -e "system('rm -rf /')""#,
            r#"perl -e "unlink '/etc/passwd'""#,
            r#"php -r "system('rm -rf /');""#,
            r#"php -r "unlink('/etc/passwd');""#,
        ];
        for cmd in redlines {
            let a = analyze(cmd);
            assert_eq!(a.overall_class, CommandClass::Redline, "cmd failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::Blocked, "gk failed: {cmd}");
        }

        let deletes = [
            (r#"ruby -e "File.delete('tmp.log')""#, "tmp.log"),
            (r#"perl -e "unlink 'tmp.log'""#, "tmp.log"),
            (r#"php -r "unlink('tmp.log');""#, "tmp.log"),
        ];
        for (cmd, target) in deletes {
            let a = analyze(cmd);
            assert!(
                a.overall_class == CommandClass::Indirect || a.overall_class == CommandClass::DeleteShape,
                "cmd failed: {cmd}, actual: {:?}",
                a.overall_class
            );
            assert!(a.has_indirect_delete);
            assert!(a.delete_targets.contains(&target.to_string()));
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::RequiresApproval);
        }
    }

    #[test]
    fn test_pure_print_stdout_allowed() {
        let allowed_cases = [
            r#"python -c "print('hello world')""#,
            r#"python3 -c "print(12345)""#,
            r#"node -e "console.log('hello world')""#,
            r#"node --eval "console.log(42);""#,
            r#"ruby -e "puts 'hello'""#,
            r#"perl -e "print 'hello\n'""#,
            r#"php -r "echo 'hello';""#,
        ];
        for cmd in allowed_cases {
            let a = analyze(cmd);
            assert_eq!(a.overall_class, CommandClass::Normal, "cmd failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::Allowed, "gk failed: {cmd}");
        }
    }

    #[test]
    fn test_high_risk_dynamic_operations_escalate() {
        let dangerous_cases = [
            r#"python -c "import os; os.system('whoami')""#,
            r#"python -c "eval('2+2')""#,
            r#"python -c "import socket; s = socket.socket()""#,
            r#"node -e "process.exit(1)""#,
            r#"node -e "eval('foo()')""#,
            r#"ruby -e "eval('puts 1')""#,
            r#"php -r "passthru('whoami');""#,
        ];
        for cmd in dangerous_cases {
            let a = analyze(cmd);
            assert_eq!(a.overall_class, CommandClass::Dangerous, "cmd failed: {cmd}");
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::RequiresApproval, "gk failed: {cmd}");
        }
    }
}
