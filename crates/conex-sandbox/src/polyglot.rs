//! 多语言解释器内联脚本深度审计引擎（BC10-2）。
//!
//! 覆盖 Python (-c), Node.js (-e, --eval, -p, --print), Bash (-c),
//! Ruby (-e), Perl (-e), PHP (-r) 等内联脚本开关提取。
//! 深度分析内联脚本中的破坏性 API：
//! 1. 进程与 Shell 执行（os.system, subprocess.Popen, child_process.execSync 等）提取子命令并递归红线审查；
//! 2. 文件破坏操作（shutil.rmtree, fs.rmSync, unlinkSync, os.remove 等）识别删除目标与物理红线；
//! 3. 彻底切断 Indirect 门禁直接放行漏洞，内联脚本高危操作升级审批或阻断。

use regex::Regex;
use std::fmt;
use std::sync::OnceLock;

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

/// 内联脚本审查规则编译失败。
///
/// 全部模式都是本文件内的字面量，正常构建产物不会走到这个分支；一旦出现说明
/// 构建产物被篡改或依赖的 regex crate 语义发生破坏。此时**绝不放行**：调用方
/// 必须按 fail-closed 阻断（见 `semantics::analyze_indirect_depth`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolyglotRulesError {
    /// 失败的规则名（稳定标识，便于定位）
    pub rule: &'static str,
    /// 底层正则编译错误信息
    pub message: String,
}

impl fmt::Display for PolyglotRulesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "内联脚本审查规则 `{}` 编译失败：{}",
            self.rule, self.message
        )
    }
}

impl std::error::Error for PolyglotRulesError {}

/// 唯一编译入口：失败即 `Err`，绝不 panic。
fn compile_rule(rule: &'static str, pattern: &str) -> Result<Regex, PolyglotRulesError> {
    Regex::new(pattern).map_err(|e| PolyglotRulesError {
        rule,
        message: e.to_string(),
    })
}

/// 多语言内联脚本审查所需的全部正则（进程级单例，见 [`rules`]）。
struct PolyglotRules {
    py_system: Regex,
    py_subprocess_str: Regex,
    py_subprocess_list: Regex,
    py_string_literal: Regex,
    py_general_proc: Regex,
    node_exec: Regex,
    node_spawn: Regex,
    node_general_proc: Regex,
    ruby_system: Regex,
    backtick: Regex,
    ruby_percent_x: Regex,
    perl_system: Regex,
    perl_qx: Regex,
    php_system: Regex,
    py_destructive_literal: Regex,
    py_pathlib_destructive: Regex,
    py_destructive_general: Regex,
    node_destructive_literal: Regex,
    node_destructive_general: Regex,
    ruby_destructive_literal: Regex,
    ruby_destructive_general: Regex,
    perl_destructive_literal: Regex,
    perl_destructive_general: Regex,
    php_destructive_literal: Regex,
    php_destructive_general: Regex,
    py_reflection_danger: Regex,
    node_reflection_danger: Regex,
    general_script_reflection: Regex,
    py_pure_print: Regex,
    node_pure_print: Regex,
    ruby_pure_print: Regex,
    php_pure_print: Regex,
    perl_pure_print: Regex,
}

impl PolyglotRules {
    fn compile() -> Result<Self, PolyglotRulesError> {
        Ok(Self {
            py_system: compile_rule(
                "py_system",
                r#"(?i)\bos\.(?:system|popen)\s*\(\s*(?:r|f|b)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')\s*\)"#,
            )?,
            py_subprocess_str: compile_rule(
                "py_subprocess_str",
                r#"(?i)\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\(\s*(?:r|f|b)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#,
            )?,
            py_subprocess_list: compile_rule(
                "py_subprocess_list",
                r#"(?i)\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\(\s*\[(?P<list>[^\]]+)\]"#,
            )?,
            py_string_literal: compile_rule(
                "py_string_literal",
                r#"(?:r|f|b)?(?:"(?P<item_d>(?:\\.|[^"\\])*)"|'(?P<item_s>(?:\\.|[^'\\])*)')"#,
            )?,
            py_general_proc: compile_rule(
                "py_general_proc",
                r#"(?i)\b(?:os\.system|os\.popen|subprocess\.(?:run|Popen|call|check_call|check_output))\b"#,
            )?,
            node_exec: compile_rule(
                "node_exec",
                r#"(?i)(?:\bchild_process\.)?(?:exec|execSync)\s*\(\s*(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)'|`(?P<cmd_b>(?:\\.|[^`\\])*)`)"#,
            )?,
            node_spawn: compile_rule(
                "node_spawn",
                r#"(?i)(?:\bchild_process\.)?(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)'|`(?P<cmd_b>(?:\\.|[^`\\])*)`)(?:\s*,\s*\[(?P<args>[^\]]*)\])?"#,
            )?,
            node_general_proc: compile_rule(
                "node_general_proc",
                r#"(?i)\b(?:child_process\b|execSync|spawnSync)\b"#,
            )?,
            ruby_system: compile_rule(
                "ruby_system",
                r#"(?i)\b(?:system|exec)\s*(?:\(\s*)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#,
            )?,
            backtick: compile_rule("backtick", r#"`(?P<cmd>[^`]+)`"#)?,
            ruby_percent_x: compile_rule(
                "ruby_percent_x",
                r#"%x(?:\((?P<cmd1>[^\)]*)\)|\[(?P<cmd2>[^\]]*)\]|\{(?P<cmd3>[^\}]*)\})"#,
            )?,
            perl_system: compile_rule(
                "perl_system",
                r#"(?i)\b(?:system|exec)\s*(?:\(\s*)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#,
            )?,
            perl_qx: compile_rule(
                "perl_qx",
                r#"(?i)\bqx(?:\((?P<cmd1>[^\)]*)\)|\[(?P<cmd2>[^\]]*)\]|\{(?P<cmd3>[^\}]*)\})"#,
            )?,
            php_system: compile_rule(
                "php_system",
                r#"(?i)\b(?:system|exec|passthru|shell_exec|popen|proc_open)\s*(?:\(\s*)?(?:"(?P<cmd_d>(?:\\.|[^"\\])*)"|'(?P<cmd_s>(?:\\.|[^'\\])*)')"#,
            )?,
            py_destructive_literal: compile_rule(
                "py_destructive_literal",
                r#"(?i)\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir))\s*\(\s*(?:r|f|b)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#,
            )?,
            py_pathlib_destructive: compile_rule(
                "py_pathlib_destructive",
                r#"(?i)\b(?:pathlib\.)?Path\s*\(\s*(?:r|f|b)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')\s*\)\.(?:unlink|rmdir)"#,
            )?,
            py_destructive_general: compile_rule(
                "py_destructive_general",
                r#"(?i)\b(?:shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir)\b"#,
            )?,
            node_destructive_literal: compile_rule(
                "node_destructive_literal",
                r#"(?i)(?:\bfs\.)?(?:promises\.)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(\s*(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)'|`(?P<path_b>(?:\\.|[^`\\])*)`)"#,
            )?,
            node_destructive_general: compile_rule(
                "node_destructive_general",
                r#"(?i)(?:\bfs\.)?(?:promises\.)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\b"#,
            )?,
            ruby_destructive_literal: compile_rule(
                "ruby_destructive_literal",
                r#"(?i)(?:\bFileUtils\.(?:rm_rf|rm_r|rm)|\bFile\.(?:delete|unlink)|\bDir\.(?:delete|rmdir))\s*(?:\(\s*)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#,
            )?,
            ruby_destructive_general: compile_rule(
                "ruby_destructive_general",
                r#"(?i)(?:\bFileUtils\.(?:rm_rf|rm_r|rm)|\bFile\.(?:delete|unlink)|\bDir\.(?:delete|rmdir))\b"#,
            )?,
            perl_destructive_literal: compile_rule(
                "perl_destructive_literal",
                r#"(?i)(?:\b(?:File::Path::)?(?:rmtree|remove_tree)|\b(?:unlink|rmdir))\s*(?:\(\s*)?(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#,
            )?,
            perl_destructive_general: compile_rule(
                "perl_destructive_general",
                r#"(?i)\b(?:rmtree|remove_tree|unlink|rmdir)\b"#,
            )?,
            php_destructive_literal: compile_rule(
                "php_destructive_literal",
                r#"(?i)\b(?:unlink|rmdir)\s*\(\s*(?:"(?P<path_d>(?:\\.|[^"\\])*)"|'(?P<path_s>(?:\\.|[^'\\])*)')"#,
            )?,
            php_destructive_general: compile_rule(
                "php_destructive_general",
                r#"(?i)\b(?:unlink|rmdir)\b"#,
            )?,
            py_reflection_danger: compile_rule(
                "py_reflection_danger",
                r#"(?i)\b(?:ctypes\b|__import__|importlib\b|eval\s*\(|exec\s*\(|compile\s*\()"#,
            )?,
            node_reflection_danger: compile_rule(
                "node_reflection_danger",
                r#"(?i)\b(?:eval\s*\(|Function\s*\(|vm\.runIn|process\.exit\s*\()"#,
            )?,
            general_script_reflection: compile_rule(
                "general_script_reflection",
                r#"(?i)\b(?:eval\s*[\(\{]|eval\b|passthru\b|proc_open\b)"#,
            )?,
            py_pure_print: compile_rule("py_pure_print", r#"^\s*print\s*\([^)]*\)\s*$"#)?,
            node_pure_print: compile_rule(
                "node_pure_print",
                r#"^\s*console\.(?:log|info|warn|error)\s*\([^)]*\)\s*;?\s*$"#,
            )?,
            ruby_pure_print: compile_rule("ruby_pure_print", r#"^\s*(?:puts|print|p)\s+.*$"#)?,
            php_pure_print: compile_rule("php_pure_print", r#"^\s*(?:echo|print)\s+.*;?\s*$"#)?,
            perl_pure_print: compile_rule("perl_pure_print", r#"^\s*print\s+.*;?\s*$"#)?,
        })
    }
}

/// 进程级规则单例：只编译一次（失败结果同样缓存，不重试、不放行）。
static RULES: OnceLock<Result<PolyglotRules, PolyglotRulesError>> = OnceLock::new();

/// 取规则单例：编译失败 → `Err`，调用方必须按 fail-closed 阻断。
fn rules() -> Result<&'static PolyglotRules, PolyglotRulesError> {
    RULES
        .get_or_init(PolyglotRules::compile)
        .as_ref()
        .map_err(Clone::clone)
}

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

    /// 深度审查多语言内联脚本。
    ///
    /// 返回 `Err` 表示审查规则不可用（模式均为字面量，正常构建不会发生）；
    /// 调用方**必须**按 fail-closed 阻断，不得把 `Err` 当作「无风险」放行。
    pub fn inspect_script(
        kind: InterpreterKind,
        script: &str,
        depth: usize,
    ) -> Result<SemanticAnalysis, PolyglotRulesError> {
        // 0. Shell/PowerShell/Cmd 脚本直接走 Shell AST / 分词语义层
        if matches!(
            kind,
            InterpreterKind::Bash | InterpreterKind::PowerShell | InterpreterKind::Cmd
        ) {
            return Ok(crate::semantics::analyze_depth_pub(script, depth + 1));
        }

        let mut delete_targets = Vec::new();
        let mut git_revert_forms = Vec::new();
        let mut has_indirect_delete = false;
        let mut has_dangerous = false;

        // 1. 递归提取并审查嵌套的 Shell 子命令
        let nested_cmds = Self::extract_nested_shell_commands(kind, script)?;
        for nested in nested_cmds {
            let res = crate::semantics::analyze_depth_pub(&nested, depth + 1);
            if res.overall_class == CommandClass::Redline
                || res
                    .segments
                    .iter()
                    .any(|s| s.class == CommandClass::Redline)
            {
                return Ok(redline_only_analysis());
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
            Self::extract_destructive_file_ops(kind, script)?;
        if found_destructive_general {
            has_indirect_delete = true;
        }

        for path in extracted_paths {
            if is_critical_path_str(&path) {
                // 试图通过解释器删除根目录或系统核心关键目录 -> 物理红线立即拦截！
                return Ok(redline_only_analysis());
            }
            has_indirect_delete = true;
            if !delete_targets.contains(&path) {
                delete_targets.push(path);
            }
        }

        // 3. 动态代码执行、反射与底层 API
        if Self::has_dynamic_or_reflection_execution(kind, script)? {
            has_dangerous = true;
        }

        // 4. 纯只读打印白名单豁免：无子命令、无删除、无反射、仅单纯 stdout 打印
        if !has_indirect_delete
            && !has_dangerous
            && delete_targets.is_empty()
            && Self::is_pure_read_only_print(kind, script)?
        {
            return Ok(SemanticAnalysis {
                segments: Vec::new(),
                overall_class: CommandClass::Normal,
                delete_targets: Vec::new(),
                git_revert_forms: Vec::new(),
                has_indirect_delete: false,
                decoded_payload: None,
            });
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

        Ok(SemanticAnalysis {
            segments: Vec::new(),
            overall_class,
            delete_targets,
            git_revert_forms,
            has_indirect_delete,
            decoded_payload: None,
        })
    }

    /// 提取内联脚本中调用的系统 Shell 子命令
    pub fn extract_nested_shell_commands(
        kind: InterpreterKind,
        script: &str,
    ) -> Result<Vec<String>, PolyglotRulesError> {
        let rules = rules()?;
        let mut commands = Vec::new();
        match kind {
            InterpreterKind::Python => {
                for cap in rules.py_system.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.py_subprocess_str.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.py_subprocess_list.captures_iter(script) {
                    if let Some(list_match) = cap.name("list") {
                        let list_content = list_match.as_str();
                        let mut items = Vec::new();
                        for item_cap in rules.py_string_literal.captures_iter(list_content) {
                            if let Some(item_s) = get_captured_str(&item_cap, &["item_d", "item_s"])
                            {
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
                for cap in rules.node_exec.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s", "cmd_b"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.node_spawn.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s", "cmd_b"]) {
                        let cmd_str = clean_escaped_string(s);
                        if let Some(args_m) = cap.name("args") {
                            let mut items = vec![cmd_str];
                            for item_cap in rules.py_string_literal.captures_iter(args_m.as_str()) {
                                if let Some(item_val) =
                                    get_captured_str(&item_cap, &["item_d", "item_s"])
                                {
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
                for cap in rules.ruby_system.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.backtick.captures_iter(script) {
                    if let Some(m) = cap.name("cmd") {
                        commands.push(clean_escaped_string(m.as_str()));
                    }
                }
                for cap in rules.ruby_percent_x.captures_iter(script) {
                    for key in ["cmd1", "cmd2", "cmd3"] {
                        if let Some(m) = cap.name(key) {
                            commands.push(clean_escaped_string(m.as_str()));
                        }
                    }
                }
            }
            InterpreterKind::Perl => {
                for cap in rules.perl_system.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.backtick.captures_iter(script) {
                    if let Some(m) = cap.name("cmd") {
                        commands.push(clean_escaped_string(m.as_str()));
                    }
                }
                for cap in rules.perl_qx.captures_iter(script) {
                    for key in ["cmd1", "cmd2", "cmd3"] {
                        if let Some(m) = cap.name(key) {
                            commands.push(clean_escaped_string(m.as_str()));
                        }
                    }
                }
            }
            InterpreterKind::Php => {
                for cap in rules.php_system.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["cmd_d", "cmd_s"]) {
                        commands.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.backtick.captures_iter(script) {
                    if let Some(m) = cap.name("cmd") {
                        commands.push(clean_escaped_string(m.as_str()));
                    }
                }
            }
            _ => {}
        }

        Ok(commands)
    }

    /// 提取文件系统破坏性操作目标与泛化特征
    pub fn extract_destructive_file_ops(
        kind: InterpreterKind,
        script: &str,
    ) -> Result<(Vec<String>, bool), PolyglotRulesError> {
        let rules = rules()?;
        let mut paths = Vec::new();
        let mut found_general = false;

        match kind {
            InterpreterKind::Python => {
                for cap in rules.py_destructive_literal.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                for cap in rules.py_pathlib_destructive.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if rules.py_destructive_general.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Node => {
                for cap in rules.node_destructive_literal.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s", "path_b"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if rules.node_destructive_general.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Ruby => {
                for cap in rules.ruby_destructive_literal.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if rules.ruby_destructive_general.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Perl => {
                for cap in rules.perl_destructive_literal.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if rules.perl_destructive_general.is_match(script) {
                    found_general = true;
                }
            }
            InterpreterKind::Php => {
                for cap in rules.php_destructive_literal.captures_iter(script) {
                    if let Some(s) = get_captured_str(&cap, &["path_d", "path_s"]) {
                        paths.push(clean_escaped_string(s));
                    }
                }
                if rules.php_destructive_general.is_match(script) {
                    found_general = true;
                }
            }
            _ => {}
        }

        Ok((paths, found_general))
    }

    /// 检测动态求值与底层反射
    pub fn has_dynamic_or_reflection_execution(
        kind: InterpreterKind,
        script: &str,
    ) -> Result<bool, PolyglotRulesError> {
        let rules = rules()?;
        Ok(match kind {
            InterpreterKind::Python => {
                rules.py_reflection_danger.is_match(script)
                    || rules.py_general_proc.is_match(script)
            }
            InterpreterKind::Node => {
                rules.node_reflection_danger.is_match(script)
                    || rules.node_general_proc.is_match(script)
            }
            _ => rules.general_script_reflection.is_match(script),
        })
    }

    /// 判定是否属于纯只读标准输出打印白名单
    pub fn is_pure_read_only_print(
        kind: InterpreterKind,
        script: &str,
    ) -> Result<bool, PolyglotRulesError> {
        let rules = rules()?;
        Ok(match kind {
            InterpreterKind::Python => rules.py_pure_print.is_match(script),
            InterpreterKind::Node => rules.node_pure_print.is_match(script),
            InterpreterKind::Ruby => rules.ruby_pure_print.is_match(script),
            InterpreterKind::Php => rules.php_pure_print.is_match(script),
            InterpreterKind::Perl => rules.perl_pure_print.is_match(script),
            _ => false,
        })
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
    if upper.len() >= 2
        && upper
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
        && &upper[1..2] == ":"
        && (upper.len() == 2
            || (upper.len() == 3 && &upper[2..3] == "/")
            || (upper.len() >= 4 && (&upper[2..4] == "/*" || &upper[2..4] == "/.")))
    {
        return true;
    }

    // 3. 常见 Unix 核心关键目录
    const UNIX_CRITICAL: &[&str] = &[
        "/BIN",
        "/SBIN",
        "/USR/BIN",
        "/USR/SBIN",
        "/ETC",
        "/BOOT",
        "/DEV",
        "/PROC",
        "/SYS",
        "/LIB",
        "/LIB64",
        "/VAR/RUN",
    ];
    for crit in UNIX_CRITICAL {
        if upper == *crit || upper.starts_with(&format!("{crit}/")) {
            return true;
        }
    }

    // 4. Windows 核心关键目录
    const WIN_CRITICAL: &[&str] = &[
        "WINDOWS",
        "PROGRAM FILES",
        "PROGRAM FILES (X86)",
        "PROGRAMDATA/MICROSOFT",
        "SYSTEM VOLUME INFORMATION",
        "RECOVERY",
        "BOOT",
        "$RECYCLE.BIN",
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
                a.overall_class == CommandClass::Indirect
                    || a.overall_class == CommandClass::DeleteShape,
                "cmd failed: {cmd}, actual: {:?}",
                a.overall_class
            );
            assert!(a.has_indirect_delete, "has_indirect_delete failed: {cmd}");
            assert!(
                a.delete_targets.contains(&target.to_string()),
                "target failed: {cmd}"
            );
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
                a.overall_class == CommandClass::Indirect
                    || a.overall_class == CommandClass::DeleteShape,
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
                a.overall_class == CommandClass::Indirect
                    || a.overall_class == CommandClass::DeleteShape,
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
            assert_eq!(
                a.overall_class,
                CommandClass::Dangerous,
                "cmd failed: {cmd}"
            );
            let gk = SHARED_GATEKEEPER.check_command(cmd, &[]);
            assert_eq!(gk, GatekeeperResult::RequiresApproval, "gk failed: {cmd}");
        }
    }

    /// 规则引擎不变量：全部字面量模式必须可编译。
    /// 这是原 `.expect("valid regex")` 的自动化替代——不变量由测试守门，运行时不再 panic。
    #[test]
    fn test_rules_literal_patterns_compile() {
        let rules = PolyglotRules::compile().expect("规则字面量必须全部可编译（不变量）");
        assert!(rules.py_system.is_match("os.system('ls')"));
        assert!(rules.py_pure_print.is_match("print('hi')"));
        assert!(rules.node_pure_print.is_match("console.log(1)"));
    }

    /// 编译失败路径真实存在：非法模式返回 `Err`（不 panic），调用方据此 fail-closed 阻断。
    #[test]
    fn test_invalid_pattern_returns_err_not_panic() {
        let err = compile_rule("invalid_probe", r#"([a-"#).expect_err("非法正则必须返回 Err");
        assert_eq!(err.rule, "invalid_probe");
        assert!(!err.message.is_empty());
        assert!(format!("{err}").contains("invalid_probe"));
    }

    /// 审查入口正常路径仍返回 `Ok`（规则可用时不引入行为变化）。
    #[test]
    fn test_inspect_script_returns_ok_on_valid_rules() {
        let script = "import os; os.system('rm -rf /')";
        let analysis = PolyglotCodeInspector::inspect_script(InterpreterKind::Python, script, 0)
            .expect("规则可用时审查必须返回 Ok");
        assert_eq!(analysis.overall_class, CommandClass::Redline);
    }
}
