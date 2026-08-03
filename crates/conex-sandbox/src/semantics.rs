//! 命令语义分析层（I1-S1）：拆段 / 间接执行识别 / 字段级规范化 / 六类分类。
//!
//! 设计目标：静态正则必然被等价变形绕过（`rm -rf -- ./`、`&&` 链、PowerShell 变体），
//! 本模块先建"拆段 + 间接执行递归 + 规范化"底座，再产出六类分类，
//! 供 S2（极端危险拦截）、S4（删除形态重定向）、S6（git 回退面积）消费。
//! lib.rs 的 gatekeeper 接入在 S2 完成，本模块保持纯函数、无 I/O。

/// 命令分类（六类，S1 规格第 4 条）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandClass {
    /// 普通命令（git status / npm test / ls 等）
    Normal,
    /// 确定性毁灭目标（rm -rf /、mkfs 等），100% 拦截层
    Redline,
    /// 常规危险形态（dd 写设备、curl|bash 等），需审批层
    Dangerous,
    /// 删除形态（rm / del / Remove-Item / git rm），走删除接管接口
    DeleteShape,
    /// git 回退形态（reset --hard / checkout 旧 ref 等），走回退护栏
    GitRevertShape,
    /// 间接执行（bash -c / eval / sudo 包裹），递归分析内层
    Indirect,
}

/// 单个命令段（拆段结果）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSegment {
    /// 段命令名（小写规范化）
    pub command: String,
    /// 段参数（引号剥离、转义还原后）
    pub args: Vec<String>,
    /// 段分类（递归分析后）
    pub class: CommandClass,
    /// 段内解析出的目标路径（删除形态用）
    pub targets: Vec<String>,
}

/// 整条命令行的语义分析结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticAnalysis {
    /// 拆段列表
    pub segments: Vec<CommandSegment>,
    /// 整体分类（任一段 Redline 则 Redline；否则按优先级 Dangerous > GitRevertShape > DeleteShape > Indirect > Normal）
    pub overall_class: CommandClass,
    /// 聚合的删除目标（去重保序）
    pub delete_targets: Vec<String>,
    /// 聚合的 git 回退形态描述
    pub git_revert_forms: Vec<String>,
}

/// 间接执行命令名（小写）
const INDIRECT_COMMANDS: &[&str] = &[
    "eval", "source", ".", "bash", "sh", "cmd", "pwsh", "powershell", "sudo", "xargs", "node",
    "python", "python3", "find", "foreach-object",
];

/// 删除形态命令名（小写）
const DELETE_COMMANDS: &[&str] = &[
    "rm", "rmdir", "del", "erase", "rd", "remove-item", "git",
];

/// 危险形态命令名（小写，红线段对象）
const DANGEROUS_COMMANDS: &[&str] = &[
    "mkfs", "mkfs.ext2", "mkfs.ext3", "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs", "format-volume",
    "clear-disk", "format", "dd", "stop-computer", "restart-computer",
];

/// 解析命令行：拆分复合命令，逐段分析。
pub fn analyze(command_line: &str) -> SemanticAnalysis {
    let raw_segments = split_segments(command_line);
    let mut segments = Vec::new();
    let mut delete_targets = Vec::new();
    let mut git_revert_forms = Vec::new();

    for seg in raw_segments {
        let (command, args) = split_command_args(&seg);
        let normalized = normalize_command(&command);
        let mut segment = CommandSegment {
            command: normalized.clone(),
            args: args.clone(),
            class: classify(&normalized, &args, &seg),
            targets: Vec::new(),
        };

        if is_delete_command(&normalized) {
            segment.targets = extract_delete_targets(&normalized, &args);
            for t in &segment.targets {
                if !delete_targets.contains(t) {
                    delete_targets.push(t.clone());
                }
            }
        }
        if normalized == "git" {
            if let Some(form) = classify_git_revert(&args) {
                segment.class = CommandClass::GitRevertShape;
                if !git_revert_forms.contains(&form) {
                    git_revert_forms.push(form);
                }
            }
        }

        segments.push(segment);
    }

    let overall_class = overall(&segments);
    SemanticAnalysis {
        segments,
        overall_class,
        delete_targets,
        git_revert_forms,
    }
}

/// 复合命令拆段：`&&` / `;` / `||` / `|` / `|&` 拆分；引号内与转义符不拆。
fn split_segments(line: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    while let Some(c) = chars.next() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            current.push(c);
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            current.push(c);
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                current.push(c);
            }
            ';' | '&' | '|' => {
                // 处理 && / || / |& 双字符操作符
                if let Some(&next_c) = chars.peek() {
                    if (c == '&' && next_c == '&') || (c == '|' && (next_c == '|' || next_c == '&')) {
                        chars.next();
                    }
                }
                let trimmed = current.trim();
                if !trimmed.is_empty() {
                    segments.push(trimmed.to_string());
                }
                current = String::new();
            }
            _ => current.push(c),
        }
    }
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        segments.push(trimmed.to_string());
    }
    segments
}

/// 拆分段为（命令, 参数）：处理引号、转义，命令为第一个 token。
fn split_command_args(segment: &str) -> (String, Vec<String>) {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut started = false;

    for c in segment.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            started = true;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                current.push(c);
            }
            started = true;
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                started = true;
            }
            c if c.is_whitespace() => {
                if started && !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                started = false;
            }
            _ => {
                current.push(c);
                started = true;
            }
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }

    if tokens.is_empty() {
        (String::new(), Vec::new())
    } else {
        let command = tokens.remove(0);
        (command, tokens)
    }
}

/// 命令名规范化：小写、去路径前缀（/bin/rm -> rm）。
fn normalize_command(command: &str) -> String {
    let trimmed = command.trim();
    let name = if trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    // 去路径前缀（支持 / 与 \）
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name);
    base.to_lowercase()
}

fn is_delete_command(cmd: &str) -> bool {
    DELETE_COMMANDS.contains(&cmd)
}

/// 归一化参数：剥离 --，返回有效参数列表（-- 之后的作为位置参数保留语义但标记）。
fn strip_double_dash(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut effective = Vec::new();
    let mut positional = Vec::new();
    let mut after_dd = false;
    for a in args {
        if after_dd {
            positional.push(a.clone());
        } else if a == "--" {
            after_dd = true;
        } else {
            effective.push(a.clone());
        }
    }
    (effective, positional)
}

/// 删除目标的参数解析（rm 的路径参数）。
fn extract_delete_targets(command: &str, args: &[String]) -> Vec<String> {
    if command == "git" {
        // git rm <path...>
        let mut targets = Vec::new();
        let mut after_rm = false;
        let mut skip_next = false;
        for a in args {
            if skip_next {
                skip_next = false;
                continue;
            }
            if !after_rm {
                if a == "rm" {
                    after_rm = true;
                }
                continue;
            }
            if a == "--" || a == "-r" || a == "-f" || a == "-rf" || a == "-fr" || a == "--cached" {
                continue;
            }
            if a.starts_with('-') {
                // 可能是 -r -f 组合或 --cached，跳过；若带值的选项（--ignore-unmatch 无值）忽略
                continue;
            }
            targets.push(a.clone());
        }
        return targets;
    }

    let (effective, positional) = strip_double_dash(args);
    let mut targets = Vec::new();
    // rm 的短选项：-r -f -R -rf -fr -v -d 等；长选项：--recursive --force --dir 等
    for a in effective.iter().chain(positional.iter()) {
        if a.starts_with('-') {
            continue;
        }
        if a.starts_with("C:") || a.starts_with('C') && a.len() >= 2 && a.as_bytes()[1] == b':' {
            // Windows 盘符路径
            targets.push(a.clone());
        } else if a.starts_with('/') || a.starts_with("./") || a.starts_with("../") || a == "." || a == ".." || a == "~" {
            targets.push(a.clone());
        } else if command == "rm" || command == "rmdir" || command == "del" || command == "erase" || command == "rd" || command == "remove-item" {
            // 无前缀的普通路径（rm foo.txt）
            targets.push(a.clone());
        }
    }
    targets
}

/// 判定路径是否解析为根/盘符根（rm -rf / 归一后 Redline）。
fn is_root_target(target: &str) -> bool {
    let normalized = target.trim();
    if normalized == "/" || normalized == "*" || normalized == "/*" {
        return true;
    }
    // Windows 盘符根：恰好 "C:\" / "C:/" / "C:"（后面不能再有路径成分）
    let lower = normalized.to_lowercase();
    if lower.len() >= 2
        && lower.as_bytes()[0].is_ascii_alphabetic()
        && lower.as_bytes()[1] == b':'
    {
        if lower.len() == 2 {
            return true;
        }
        if lower.as_bytes()[2] == b'\\' || lower.as_bytes()[2] == b'/' {
            // 仅当盘符根后直接结束（C:\ 或 C:/），或仅跟通配根（C:\*）
            let rest = &lower[3..];
            return rest.is_empty() || rest == "*" || rest == "\\*" || rest == "/*";
        }
    }
    false
}

/// 短选项归一：-r/-R 与 --recursive 等价；-f 与 --force 等价。
fn has_recursive(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "-r" || a == "-R" || a == "--recursive" || a == "-rf" || a == "-fr" || a == "-rF"
            || (a.starts_with('-') && a.len() > 1 && a[1..].chars().any(|c| c == 'r' || c == 'R'))
    })
}

fn has_force(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "-f" || a == "--force" || a == "-rf" || a == "-fr" || a == "-fR" || a == "-rF"
            || (a.starts_with('-') && a.len() > 1 && a[1..].chars().any(|c| c == 'f'))
    })
}

/// 递归分析间接执行的内层命令内容。
fn analyze_indirect(segment_raw: &str) -> SemanticAnalysis {
    // 提取 -c 之后的字符串参数作为内层命令
    let (command, args) = split_command_args(segment_raw);
    let normalized = normalize_command(&command);
    let inner = match normalized.as_str() {
        "bash" | "sh" | "cmd" | "pwsh" | "powershell" | "node" | "python" | "python3" => {
            // 找 -c / -Command / /c / -e 后的所有剩余参数（join 保留空格，恢复内层命令全文）
            let mut inner: Option<String> = None;
            let mut iter = args.iter();
            while let Some(a) = iter.next() {
                if a == "-c" || a == "-Command" || a == "/c" || a == "-e" || a == "-E" {
                    let rest: Vec<&String> = iter.by_ref().collect();
                    if !rest.is_empty() {
                        inner = Some(rest.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" "));
                    }
                    break;
                }
                if a.starts_with("-Command") && a.len() > 8 {
                    inner = Some(a[8..].trim_start_matches('=').to_string());
                    break;
                }
                if a.starts_with("/c") && a.len() > 2 {
                    inner = Some(a[2..].trim_start().to_string());
                    break;
                }
            }
            inner
        }
        "eval" | "source" | "." => {
            // 剩余参数拼接为内层命令
            Some(args.join(" "))
        }
        "sudo" | "xargs" => {
            // 剩余参数为内层命令（sudo bash -c '...' 时 bash 会再被递归）
            Some(args.join(" "))
        }
        "find" => {
            // find ... -exec cmd {} \; 提取 cmd
            let mut inner: Option<String> = None;
            let mut iter = args.iter().peekable();
            while let Some(a) = iter.next() {
                if a == "-exec" || a == "-execdir" {
                    let mut cmd_parts = Vec::new();
                    for nxt in iter.by_ref() {
                        if nxt == ";" || nxt == "{}" || nxt == "+" {
                            break;
                        }
                        cmd_parts.push(nxt.clone());
                    }
                    if !cmd_parts.is_empty() {
                        inner = Some(cmd_parts.join(" "));
                    }
                    break;
                }
            }
            inner
        }
        "foreach-object" => {
            let mut inner: Option<String> = None;
            let mut iter = args.iter().peekable();
            while let Some(a) = iter.next() {
                if a == "-Process" {
                    inner = iter.next().cloned();
                    break;
                }
            }
            inner
        }
        _ => None,
    };

    match inner {
        Some(inner_cmd) if !inner_cmd.trim().is_empty() => analyze(&inner_cmd),
        _ => SemanticAnalysis {
            segments: Vec::new(),
            overall_class: CommandClass::Normal,
            delete_targets: Vec::new(),
            git_revert_forms: Vec::new(),
        },
    }
}

/// 单段分类（含间接执行递归升级）。
fn classify(command: &str, args: &[String], segment_raw: &str) -> CommandClass {
    // 1. 间接执行：先递归分析内层
    if INDIRECT_COMMANDS.contains(&command) {
        let inner = analyze_indirect(segment_raw);
        if inner.overall_class == CommandClass::Redline {
            return CommandClass::Redline;
        }
        if inner.overall_class == CommandClass::Dangerous || inner.overall_class == CommandClass::GitRevertShape {
            return CommandClass::Indirect;
        }
        if inner.overall_class == CommandClass::DeleteShape {
            return CommandClass::Indirect;
        }
        if !inner.segments.is_empty() {
            return CommandClass::Indirect;
        }
        // 无内层命令内容时按自身判定
    }

    // 2. 删除形态（含红线判定）——git 除外（git 只走回退形态分支）
    if is_delete_command(command) && command != "git" {
        let targets = extract_delete_targets(command, args);
        if command == "rm" || command == "rmdir" || command == "del" || command == "erase" || command == "rd" || command == "remove-item" {
            // Windows 风格参数（rd /s /q、del /f /q）与 Unix 风格（-r -f）都算
            let win_recursive = args.iter().any(|a| a.eq_ignore_ascii_case("/s") || a.eq_ignore_ascii_case("/S"));
            let win_force = args.iter().any(|a| a.eq_ignore_ascii_case("/q") || a.eq_ignore_ascii_case("/f"));
            let recursive = has_recursive(args) || win_recursive;
            let force = has_force(args) || win_force;
            if targets.iter().any(|t| is_root_target(t)) && (recursive || force) {
                return CommandClass::Redline;
            }
        }
        return CommandClass::DeleteShape;
    }

    // 3. git 回退形态
    if command == "git" {
        if classify_git_revert(args).is_some() {
            return CommandClass::GitRevertShape;
        }
        return CommandClass::Normal;
    }

    // 4. 危险形态
    if DANGEROUS_COMMANDS.contains(&command) {
        return CommandClass::Dangerous;
    }

    // 5. curl|bash 管道（stdin 管道间接执行）——在整体分析后处理，这里按 Dangerous 提示
    if command == "curl" || command == "wget" {
        return CommandClass::Dangerous;
    }

    CommandClass::Normal
}

/// git 回退形态识别：返回形态描述字符串，None 表示非回退。
fn classify_git_revert(args: &[String]) -> Option<String> {
    let (effective, positional) = strip_double_dash(args);
    let first = effective.first()?;
    match first.as_str() {
        "reset" => {
            // git reset --hard <ref>
            if effective.iter().any(|a| a == "--hard") {
                Some("git reset --hard".to_string())
            } else {
                None
            }
        }
        "clean" => {
            if effective.iter().any(|a| a == "-f" || a == "--force") {
                Some("git clean -f".to_string())
            } else {
                None
            }
        }
        "stash" => {
            if effective.get(1).map(|s| s.as_str()) == Some("drop") {
                Some("git stash drop".to_string())
            } else {
                None
            }
        }
        "revert" => {
            if effective.iter().any(|a| a == "--no-commit") {
                Some("git revert --no-commit".to_string())
            } else {
                None
            }
        }
        "restore" => {
            // git restore --source=<ref>
            if effective.iter().any(|a| a.starts_with("--source")) {
                Some("git restore --source".to_string())
            } else {
                None
            }
        }
        "checkout" => {
            // git checkout <旧ref>（分支名 vs commit hash 区分：全 hex 且 >=7 字符视为 ref）
            if positional.is_empty() && effective.len() >= 2 {
                let target = &effective[1];
                let is_hex_ref = !target.starts_with('-')
                    && target != "."
                    && !target.starts_with("--")
                    && target.len() >= 7
                    && target.chars().all(|c| c.is_ascii_hexdigit());
                if is_hex_ref {
                    Some(format!("git checkout {}", target))
                } else {
                    None
                }
            } else {
                None
            }
        }
        "rm" => Some("git rm".to_string()),
        _ => None,
    }
}

/// 整体分类：任一段 Redline 则 Redline；否则优先级 Dangerous > GitRevertShape > DeleteShape > Indirect > Normal。
fn overall(segments: &[CommandSegment]) -> CommandClass {
    let mut has_dangerous = false;
    let mut has_revert = false;
    let mut has_delete = false;
    let mut has_indirect = false;
    for s in segments {
        match s.class {
            CommandClass::Redline => return CommandClass::Redline,
            CommandClass::Dangerous => has_dangerous = true,
            CommandClass::GitRevertShape => has_revert = true,
            CommandClass::DeleteShape => has_delete = true,
            CommandClass::Indirect => has_indirect = true,
            CommandClass::Normal => {}
        }
    }
    if has_dangerous {
        CommandClass::Dangerous
    } else if has_revert {
        CommandClass::GitRevertShape
    } else if has_delete {
        CommandClass::DeleteShape
    } else if has_indirect {
        CommandClass::Indirect
    } else {
        CommandClass::Normal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_compound_with_and() {
        let a = analyze("echo hi && rm -rf /");
        assert_eq!(a.segments.len(), 2);
        assert_eq!(a.segments[0].command, "echo");
        assert_eq!(a.segments[1].command, "rm");
        assert_eq!(a.segments[1].class, CommandClass::Redline);
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn splits_semicolon_and_pipe() {
        let a = analyze("git status; ls -la | grep foo");
        assert_eq!(a.segments.len(), 3);
        assert_eq!(a.segments[0].command, "git");
        assert_eq!(a.segments[1].command, "ls");
        assert_eq!(a.segments[2].command, "grep");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn indirect_sudo_bash_c_recursive() {
        let a = analyze("sudo bash -c 'rm -rf /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
        assert!(a.segments[0].class == CommandClass::Redline || a.segments[0].class == CommandClass::Indirect);
    }

    #[test]
    fn indirect_eval_recursive() {
        let a = analyze("eval rm -rf /");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn indirect_bash_c_recursive_redline() {
        let a = analyze("bash -c 'rm -rf /'");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn rm_double_dash_dot_is_delete_not_redline() {
        let a = analyze("rm -rf -- ./");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(!a.delete_targets.is_empty());
    }

    #[test]
    fn rm_plain_file_is_delete() {
        let a = analyze("rm -r -f /tmp/x");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(a.delete_targets.contains(&"/tmp/x".to_string()));
    }

    #[test]
    fn remove_item_literal_path() {
        let a = analyze("Remove-Item -LiteralPath 'C:\\x\\y.txt' -Force");
        assert_eq!(a.overall_class, CommandClass::DeleteShape);
        assert!(a.delete_targets.iter().any(|t| t.contains("y.txt")));
    }

    #[test]
    fn git_reset_hard_is_revert() {
        let a = analyze("git reset --hard HEAD~5");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
        assert!(!a.git_revert_forms.is_empty());
    }

    #[test]
    fn git_clean_f_is_revert() {
        let a = analyze("git clean -f");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_stash_drop_is_revert() {
        let a = analyze("git stash drop");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_restore_source_is_revert() {
        let a = analyze("git restore --source=HEAD~3 src/main.rs");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_checkout_branch_is_normal() {
        let a = analyze("git checkout main");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn git_checkout_old_ref_is_revert() {
        let a = analyze("git checkout abc1234");
        assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    }

    #[test]
    fn git_status_is_normal() {
        let a = analyze("git status");
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn normal_commands_are_normal() {
        assert_eq!(analyze("npm test").overall_class, CommandClass::Normal);
        assert_eq!(analyze("ls -la").overall_class, CommandClass::Normal);
    }

    #[test]
    fn quoted_semicolon_not_split() {
        let a = analyze("echo \"a;b\"");
        assert_eq!(a.segments.len(), 1);
        assert_eq!(a.overall_class, CommandClass::Normal);
    }

    #[test]
    fn mkfs_is_dangerous() {
        let a = analyze("mkfs.ext4 /dev/sdb");
        assert_eq!(a.overall_class, CommandClass::Dangerous);
    }

    #[test]
    fn rm_dash_rf_root_redline() {
        let a = analyze("rm -r -f /");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn normalize_path_prefix() {
        let a = analyze("/bin/rm -rf /");
        assert_eq!(a.segments[0].command, "rm");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }

    #[test]
    fn windows_drive_root_redline() {
        let a = analyze("rd /s /q C:\\");
        assert_eq!(a.overall_class, CommandClass::Redline);
    }
}
