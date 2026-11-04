//! shell 工具 · 命令行绝对路径安全围栏（BC10-4 原样恢复）
//!
//! 2026-10-27 恢复说明：权限三模式改造曾把 shell 降为纯 I/O，误删本围栏；
//! 审计发现"绝对路径越界写/删不再拦截"后原样恢复。本模块只承担**执行行为**
//! （系统关键目录物理红线 + 写/删目标越界阻断），不参与 allow/deny 裁决。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::definition::ToolError;

use conex_types::error::codes;

/// 编译期常量正则的惰性缓存（结果含错误：编译失败不得 panic）
type CompiledRegex = LazyLock<Result<Regex, regex::Error>>;

/// 取用编译期常量正则。
///
/// 模式串是固定字面量，编译失败属程序缺陷；但安全围栏必须 fail-closed
/// 且不能以 panic 打死整轮执行，故统一转成工具错误上抛。
fn compiled_regex(
    cell: &'static CompiledRegex,
    name: &'static str,
) -> Result<&'static Regex, ToolError> {
    cell.as_ref().map_err(|e| {
        ToolError::execution_failed(
            "shell_command",
            format!("命令路径围栏正则 {name} 编译失败（内部缺陷）：{e}"),
        )
    })
}

/// 命令行绝对路径安全围栏（BC10-4）
pub struct CommandPathInspector;

impl CommandPathInspector {
    /// 检查命令中的绝对路径安全围栏（系统关键目录红线 + 写/删目标越界阻断）
    pub fn inspect(command_line: &str, workspace_root: &Path) -> Result<(), ToolError> {
        let extracted_paths = Self::extract_absolute_paths(command_line)?;

        for path in &extracted_paths {
            // 1. 系统核心关键目录物理红线（命中则刚性 Deny 阻断）
            if Self::is_critical_path(path) {
                return Err(ToolError::new(
                    codes::TOOL_COMMAND_BLOCKED,
                    format!(
                        "PermissionDenied: 命令包含指向系统核心关键目录的敏感路径：{}，硬性阻断！",
                        path.display()
                    ),
                ));
            }

            // 2. 校验写/删目标路径是否越出 workspace_root
            if Self::is_write_or_delete_target(command_line, path)
                && !conex_fs::ConexPathNormalizer::is_subpath(path, workspace_root)
            {
                return Err(ToolError::new(
                    codes::TOOL_COMMAND_BLOCKED,
                    format!(
                        "PermissionDenied: 命令试图向工作区外写入或删除绝对路径：{}，严禁越界！",
                        path.display()
                    ),
                ));
            }
        }

        Ok(())
    }

    /// 从命令行中提取所有绝对路径候选
    ///
    /// 返回值改为 `Result`：正则编译失败（内部缺陷）以工具错误上抛，
    /// 绝不 panic；调用方 `inspect` 直接 `?` 传播。
    pub fn extract_absolute_paths(command_line: &str) -> Result<Vec<PathBuf>, ToolError> {
        let masked_cmd = mask_search_patterns(command_line);
        let cmd_ref = masked_cmd.as_str();

        static WIN_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(
                r#"(?i)(?:\A|[^a-zA-Z0-9_./\\-])([a-zA-Z]:(?:[\\/][^\s"'`=,;()<>{}\r\n*?|]*)?)"#,
            )
        });

        static QUOTED_WIN_PATH_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"(?i)["']([a-zA-Z]:[\\/][^"'\r\n*?|]+)["']"#));

        static UNIX_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(
                r#"(?:\A|[^a-zA-Z0-9_./\\-])(/[\w.\-]+(?:/[\w.\-]+)*/?)(?:\z|[\s"'`=,;()<>{}\r\n|])"#,
            )
        });

        static QUOTED_UNIX_PATH_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"["'](/[^"'\r\n*?|]+)["']"#));

        static STANDALONE_ROOT_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])/(?:\z|[^a-zA-Z0-9_./\\-])"#));

        static UNC_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])((?:\\\\|//)[^\s"'`=,;()<>{}\r\n*?|]+)"#)
        });

        static QUOTED_UNC_PATH_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"["']((?:\\\\|//)[^"'\r\n*?|]+)["']"#));

        static HOME_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])(~[\\/][^\s"'`=,;()<>{}\r\n*?|]*)"#)
        });

        static QUOTED_HOME_PATH_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"["'](~[\\/][^"'\r\n*?|]*)["']"#));

        let mut paths = Vec::new();

        // 0. 引号包裹路径（支持空格，如 "C:/Program Files/..."）
        for cap in
            compiled_regex(&QUOTED_WIN_PATH_REGEX, "QUOTED_WIN_PATH")?.captures_iter(cmd_ref)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }
        for cap in
            compiled_regex(&QUOTED_UNIX_PATH_REGEX, "QUOTED_UNIX_PATH")?.captures_iter(cmd_ref)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if is_valid_unix_path(&s) {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }
        for cap in
            compiled_regex(&QUOTED_UNC_PATH_REGEX, "QUOTED_UNC_PATH")?.captures_iter(cmd_ref)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }
        for cap in
            compiled_regex(&QUOTED_HOME_PATH_REGEX, "QUOTED_HOME_PATH")?.captures_iter(cmd_ref)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 1. Windows 盘符路径
        for cap in compiled_regex(&WIN_PATH_REGEX, "WIN_PATH")?.captures_iter(cmd_ref) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 2. Unix 绝对路径（带尾部定界符断言，向前递进 group 1 结尾以避免吞并紧邻路径）
        let unix_re = compiled_regex(&UNIX_PATH_REGEX, "UNIX_PATH")?;
        let mut search_from = 0;
        while search_from < cmd_ref.len() {
            if let Some(cap) = unix_re.captures(&cmd_ref[search_from..]) {
                if let Some(m) = cap.get(1) {
                    let s = clean_path_candidate(m.as_str());
                    if is_valid_unix_path(&s) {
                        let pb = PathBuf::from(s);
                        if !paths.contains(&pb) {
                            paths.push(pb);
                        }
                    }
                    let advance = m.end().max(1);
                    search_from += advance;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        // 3. 独立根路径 /
        if compiled_regex(&STANDALONE_ROOT_REGEX, "STANDALONE_ROOT")?.is_match(cmd_ref) {
            let root = PathBuf::from("/");
            if !paths.contains(&root) {
                paths.push(root);
            }
        }

        // 4. UNC 路径
        for cap in compiled_regex(&UNC_PATH_REGEX, "UNC_PATH")?.captures_iter(cmd_ref) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 5. 家目录路径 (~/...)
        for cap in compiled_regex(&HOME_PATH_REGEX, "HOME_PATH")?.captures_iter(cmd_ref) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        Ok(paths)
    }

    /// 判定路径是否为系统核心关键目录或敏感文件（物理红线）
    pub fn is_critical_path(path: &Path) -> bool {
        if conex_fs::ConexPathNormalizer::is_system_critical_path(path) {
            return true;
        }

        let norm = conex_fs::ConexPathNormalizer::normalize(path);
        let s = norm.to_string_lossy().replace('\\', "/");
        let upper = s.to_ascii_uppercase();

        if s == "/" || upper == "/" || upper == "/*" || upper == "/." {
            return true;
        }

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

        const POSIX_CRITICAL: &[&str] = &[
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
        for crit in POSIX_CRITICAL {
            if upper == *crit || upper.starts_with(&format!("{crit}/")) {
                return true;
            }
        }

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

    /// 判定路径是否作为写入或删除目标出现在命令中
    pub fn is_write_or_delete_target(command_line: &str, path: &Path) -> bool {
        let p_str = path.to_string_lossy();
        let p_clean = p_str.trim();
        if p_clean.is_empty() {
            return false;
        }

        let p_escaped = regex::escape(p_clean);
        let p_alt = regex::escape(&p_clean.replace('/', "\\"));
        let p_fwd = regex::escape(&p_clean.replace('\\', "/"));
        let p_pattern = format!("(?:{p_escaped}|{p_alt}|{p_fwd})");

        // 1. 重定向写入目标: > path, >> path, 1> path, 2> path, | Out-File path, | Set-Content path, | Add-Content path, | tee path
        let redir_pat = format!(
            r#"(?i)(?:>>?|[12]>>?|\bOut-File\s+(?:-FilePath\s+)?|\bSet-Content\s+(?:-Path\s+)?|\bAdd-Content\s+(?:-Path\s+)?|\btee\s+(?:-a\s+)?)\s*['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&redir_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        // 2. 删除命令参数: rm path, del path, Remove-Item path, rmdir path, git rm path, unlink path
        let del_pat = format!(
            r#"(?i)\b(?:rm|del|erase|rmdir|rd|Remove-Item|ri|unlink|git\s+rm)\b[^\r\n;|&]*?['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&del_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        // 3. 文件修改/创建命令目标: touch path, mkdir path, New-Item path, truncate path, cp/mv destination
        let create_pat = format!(
            r#"(?i)\b(?:touch|mkdir|New-Item|truncate|sed\s+-i)\b[^\r\n;|&]*?['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&create_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        let copy_move_pat = format!(
            r#"(?i)\b(?:cp|mv|copy|move|Move-Item|Copy-Item)\b[^\r\n;|&]*\s+['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&copy_move_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        // 4. 多语言解释器删除 API 内部目标
        let poly_del_pat = format!(
            r#"(?i)\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)|fs\.(?:promises\.)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)|FileUtils\.(?:rm_rf|rm_r|rm)|File\.(?:delete|unlink)|Dir\.(?:delete|rmdir))\s*\(\s*['"]?{p_pattern}['"]?"#
        );
        if let Ok(re) = Regex::new(&poly_del_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        false
    }
}

fn clean_path_candidate(raw: &str) -> String {
    let mut s = raw
        .trim()
        .trim_matches(['"', '\'', '`', ',', ';', '(', ')', '[', ']', '{', '}'])
        .to_string();
    while s.ends_with(')') && !s.contains('(') {
        s.pop();
    }
    while s.ends_with(']') && !s.contains('[') {
        s.pop();
    }
    while s.ends_with('}') && !s.contains('{') {
        s.pop();
    }
    s
}

fn is_valid_unix_path(s: &str) -> bool {
    let trimmed = s.trim();
    if !trimmed.starts_with('/') {
        return false;
    }
    // 纯根路径或仅由点和斜杠组成的相对遍历段（如 /、/.、/..、/./、/../）非普通 Unix 绝对路径
    let stripped = trimmed.trim_matches('/');
    if stripped.is_empty() || stripped == "." || stripped == ".." {
        return false;
    }
    let segments: Vec<&str> = stripped.split('/').filter(|seg| !seg.is_empty()).collect();
    if segments.is_empty() || segments.iter().all(|seg| *seg == "." || *seg == "..") {
        return false;
    }
    if segments.len() > 1 {
        return true;
    }
    let rest = segments[0];
    // 单字符且为 ASCII 字母视作 Windows 盘符（如 /c），不是 Unix 路径
    if rest.len() == 1 && matches!(rest.chars().next(), Some(ch) if ch.is_ascii_alphabetic()) {
        return false;
    }
    const WIN_FLAGS: &[&str] = &[
        "quiet",
        "norestart",
        "passive",
        "wait",
        "min",
        "max",
        "help",
    ];
    if WIN_FLAGS.contains(&rest.to_ascii_lowercase().as_str()) {
        return false;
    }
    const KNOWN_UNIX_DIRS: &[&str] = &[
        "etc", "bin", "sbin", "usr", "var", "tmp", "dev", "proc", "sys", "boot", "lib", "lib64",
        "root", "home", "opt", "mnt", "media", "srv",
    ];
    if KNOWN_UNIX_DIRS.contains(&rest.to_ascii_lowercase().as_str()) {
        return true;
    }
    // 杜绝纯点序列（如 .、..、...）或相对目录符作为有效路径
    if rest.chars().all(|c| c == '.') {
        return false;
    }
    // 允许隐藏文件（如 /.config）或带后缀文件名（如 /app.js），严禁以点结尾的未闭合片段
    if rest.starts_with('.') && rest.len() > 1 {
        return true;
    }
    if rest.contains('.') {
        return !rest.ends_with('.');
    }
    rest.len() > 2
}

#[derive(Debug, Clone)]
struct CmdToken {
    text: String,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone)]
struct CmdSegment {
    tokens: Vec<CmdToken>,
}

fn tokenize_segments_with_spans(line: &str) -> Vec<CmdSegment> {
    let mut segments = Vec::new();
    let mut cur_tokens = Vec::new();
    let mut cur_text = String::new();
    let mut token_start: Option<usize> = None;
    let mut chars = line.char_indices().peekable();
    let mut quote: Option<char> = None;

    while let Some((idx, c)) = chars.next() {
        if quote == Some('\'') {
            cur_text.push(c);
            if c == '\'' {
                quote = None;
            }
            continue;
        }

        if quote == Some('"') {
            if c == '\\' {
                let after_drive = cur_text.len() >= 2
                    && cur_text.as_bytes()[cur_text.len() - 2].is_ascii_alphabetic()
                    && cur_text.as_bytes()[cur_text.len() - 1] == b':';
                if !after_drive {
                    if let Some(&(_, next_c)) = chars.peek() {
                        if next_c == '"' || next_c == '\\' || next_c == '`' || next_c == '$' {
                            chars.next();
                            cur_text.push(next_c);
                            continue;
                        }
                    }
                }
                cur_text.push(c);
                continue;
            }
            if c == '"' {
                quote = None;
            } else {
                cur_text.push(c);
            }
            continue;
        }

        if c == '\\' {
            if token_start.is_none() {
                token_start = Some(idx);
            }
            if let Some((_, next_c)) = chars.next() {
                cur_text.push(next_c);
            }
            continue;
        }

        match c {
            '\'' | '"' => {
                if token_start.is_none() {
                    token_start = Some(idx);
                }
                quote = Some(c);
            }
            ';' | '|' => {
                if let Some(start) = token_start.take() {
                    cur_tokens.push(CmdToken {
                        text: std::mem::take(&mut cur_text),
                        start,
                        end: idx,
                    });
                }
                if !cur_tokens.is_empty() {
                    segments.push(CmdSegment {
                        tokens: std::mem::take(&mut cur_tokens),
                    });
                }
            }
            '&' => {
                if chars.peek().map(|(_, ch)| *ch) == Some('&') {
                    chars.next();
                    if let Some(start) = token_start.take() {
                        cur_tokens.push(CmdToken {
                            text: std::mem::take(&mut cur_text),
                            start,
                            end: idx,
                        });
                    }
                    if !cur_tokens.is_empty() {
                        segments.push(CmdSegment {
                            tokens: std::mem::take(&mut cur_tokens),
                        });
                    }
                } else {
                    if token_start.is_none() {
                        token_start = Some(idx);
                    }
                    cur_text.push(c);
                }
            }
            '\n' | '\r' => {
                if let Some(start) = token_start.take() {
                    cur_tokens.push(CmdToken {
                        text: std::mem::take(&mut cur_text),
                        start,
                        end: idx,
                    });
                }
                if !cur_tokens.is_empty() {
                    segments.push(CmdSegment {
                        tokens: std::mem::take(&mut cur_tokens),
                    });
                }
            }
            c if c.is_whitespace() => {
                if let Some(start) = token_start.take() {
                    cur_tokens.push(CmdToken {
                        text: std::mem::take(&mut cur_text),
                        start,
                        end: idx,
                    });
                }
            }
            _ => {
                if token_start.is_none() {
                    token_start = Some(idx);
                }
                cur_text.push(c);
            }
        }
    }

    if let Some(start) = token_start.take() {
        cur_tokens.push(CmdToken {
            text: cur_text,
            start,
            end: line.len(),
        });
    }
    if !cur_tokens.is_empty() {
        segments.push(CmdSegment { tokens: cur_tokens });
    }

    segments
}

fn normalize_cmd_name(token: &str) -> String {
    let trimmed = token.trim();
    let name = trimmed.trim_matches(['"', '\'']);
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let stem = if base.to_ascii_lowercase().ends_with(".exe") && base.len() > 4 {
        &base[..base.len() - 4]
    } else {
        base
    };
    stem.to_ascii_lowercase()
}

fn flag_takes_value(prog: &str, flag: &str) -> bool {
    match prog {
        "git" => matches!(
            flag,
            "-f" | "-m" | "-C" | "-B" | "-A" | "-O" | "--max-count" | "--context" | "--threads" | "--open-files-in-pager"
        ),
        "grep" | "egrep" | "fgrep" => matches!(
            flag,
            "-f" | "-m" | "-C" | "-B" | "-A" | "-d" | "-D" | "--file" | "--max-count" | "--context" | "--directories" | "--devices" | "--exclude" | "--include" | "--exclude-dir"
        ),
        "rg" => matches!(
            flag,
            "-t" | "-T" | "-g" | "-m" | "-C" | "-B" | "-A" | "-r" | "-d" | "-f" | "-E" | "-j" | "--type" | "--type-not" | "--glob" | "--max-count" | "--context" | "--replace" | "--max-depth" | "--file" | "--encoding" | "--sort" | "--sortr" | "--threads" | "--field-context-separator" | "--field-match-separator" | "--path-separator"
        ),
        "ag" => matches!(
            flag,
            "-G" | "-g" | "-m" | "-A" | "-B" | "-C" | "--ignore" | "--ignore-dir"
        ),
        _ => false,
    }
}

/// 在进行路径提取前，遮蔽文本检索类命令（grep, git grep, rg, ag, findstr 等）的搜索 pattern 参数位，
/// 避免将正则表达式内部的字符类（如 \.\.?/.*useSplitResize）或模式字符串（如 "/etc/passwd"）误提取为文件系统路径。
fn mask_search_patterns(command_line: &str) -> String {
    let segments = tokenize_segments_with_spans(command_line);
    let mut pattern_spans: Vec<(usize, usize)> = Vec::new();

    for seg in segments {
        if seg.tokens.is_empty() {
            continue;
        }

        let prog = normalize_cmd_name(&seg.tokens[0].text);
        let (effective_prog, args_tokens) = if prog == "git" {
            // Find subcommand after git
            let mut sub_idx = 1;
            while sub_idx < seg.tokens.len() {
                let text = &seg.tokens[sub_idx].text;
                if text == "-C" || text == "-c" || text == "--git-dir" || text == "--work-tree" {
                    sub_idx += 2;
                    continue;
                }
                if text.starts_with('-') {
                    sub_idx += 1;
                    continue;
                }
                break;
            }
            if sub_idx < seg.tokens.len() && seg.tokens[sub_idx].text.to_ascii_lowercase() == "grep" {
                ("git-grep", &seg.tokens[sub_idx + 1..])
            } else {
                continue;
            }
        } else if matches!(prog.as_str(), "grep" | "egrep" | "fgrep" | "rg" | "ag" | "ack" | "findstr") {
            (prog.as_str(), &seg.tokens[1..])
        } else {
            continue;
        };

        if effective_prog == "findstr" {
            let mut found_c_or_r = false;
            let mut idx = 0;
            while idx < args_tokens.len() {
                let tok = &args_tokens[idx];
                let upper = tok.text.to_ascii_uppercase();
                if upper.starts_with("/C:") || upper.starts_with("/R:") {
                    found_c_or_r = true;
                    pattern_spans.push((tok.start, tok.end));
                } else if upper == "/C" || upper == "/R" {
                    found_c_or_r = true;
                    if idx + 1 < args_tokens.len() {
                        let next_tok = &args_tokens[idx + 1];
                        pattern_spans.push((next_tok.start, next_tok.end));
                        idx += 1;
                    }
                }
                idx += 1;
            }
            if !found_c_or_r {
                // First non-flag argument is pattern
                for tok in args_tokens {
                    if !tok.text.starts_with('/') && !tok.text.starts_with('-') {
                        pattern_spans.push((tok.start, tok.end));
                        break;
                    }
                }
            }
            continue;
        }

        // For grep, git-grep, rg, ag, ack:
        let tool_name = if effective_prog == "git-grep" { "git" } else { effective_prog };
        let mut explicit_pattern = false;
        let mut idx = 0;
        while idx < args_tokens.len() {
            let tok = &args_tokens[idx];
            if tok.text == "-e" || tok.text == "--regexp" {
                explicit_pattern = true;
                if idx + 1 < args_tokens.len() {
                    let pat_tok = &args_tokens[idx + 1];
                    pattern_spans.push((pat_tok.start, pat_tok.end));
                    idx += 2;
                    continue;
                }
            } else if tok.text.starts_with("-e") && tok.text.len() > 2 {
                explicit_pattern = true;
                pattern_spans.push((tok.start, tok.end));
            } else if tok.text.starts_with("--regexp=") {
                explicit_pattern = true;
                pattern_spans.push((tok.start, tok.end));
            }
            idx += 1;
        }

        if !explicit_pattern {
            // First positional argument is the pattern
            idx = 0;
            while idx < args_tokens.len() {
                let tok = &args_tokens[idx];
                if tok.text == "--" {
                    break;
                }
                if tok.text.starts_with('-') {
                    if flag_takes_value(tool_name, &tok.text) && !tok.text.contains('=') {
                        // Short flag (len == 2) takes next arg as value
                        if tok.text.len() == 2 {
                            idx += 2;
                            continue;
                        }
                    }
                    idx += 1;
                    continue;
                }
                // First positional argument!
                pattern_spans.push((tok.start, tok.end));
                break;
            }
        }
    }

    if pattern_spans.is_empty() {
        return command_line.to_string();
    }

    let mut bytes = command_line.as_bytes().to_vec();
    for (start, end) in pattern_spans {
        let s = start.min(bytes.len());
        let e = end.min(bytes.len());
        for b in &mut bytes[s..e] {
            *b = b' ';
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|_| command_line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critical_system_paths_are_blocked() {
        let root = std::env::temp_dir();
        for cmd in [
            "cat /etc/passwd",
            r"rm -rf C:\Windows\System32",
            "cp x ~/.ssh/authorized_keys",
        ] {
            let result = CommandPathInspector::inspect(cmd, &root);
            assert!(result.is_err(), "系统关键路径必须阻断：{cmd}");
        }
    }

    #[test]
    fn write_outside_workspace_is_blocked() {
        let root = std::env::temp_dir().join("shell-path-guard-ws");
        let result = CommandPathInspector::inspect("cp file.txt /var/tmp/outside.txt", &root);
        assert!(result.is_err(), "工作区外写入必须阻断");
    }

    #[test]
    fn read_absolute_path_is_not_blocked() {
        let root = std::env::temp_dir();
        let result = CommandPathInspector::inspect("cat /tmp/readme.txt", &root);
        assert!(result.is_ok(), "只读非关键路径不阻断");
    }

    #[test]
    fn regression_user_trigger_git_grep_not_blocked() {
        let root = std::env::temp_dir();
        let cmd = r#"git grep -n -E "hooks/useSplitResize|from ['\"]\.\.?/.*useSplitResize" -- ':!apps/crish-desktop/src/components/ui/SplitResizer/*'"#;
        let result = CommandPathInspector::inspect(cmd, &root);
        assert!(
            result.is_ok(),
            "现场故障回归：git grep 中的 \\.\\.?/.*useSplitResize 严禁误报为 /. 敏感路径：{result:?}"
        );
    }

    #[test]
    fn search_pattern_containing_system_path_not_blocked() {
        let root = std::env::temp_dir();
        for cmd in [
            r#"rg "/etc/passwd" src/"#,
            r#"grep "/etc/passwd" src/"#,
            r#"git grep "/etc/passwd" src/"#,
            r#"grep -e "/bin/sh" file.txt"#,
            r#"findstr /c:"/etc/hosts" hosts.txt"#,
        ] {
            let result = CommandPathInspector::inspect(cmd, &root);
            assert!(
                result.is_ok(),
                "搜索 pattern 中的敏感路径特征严禁被误判为文件访问：{cmd} -> {result:?}"
            );
        }
    }

    #[test]
    fn search_target_file_critical_path_is_still_blocked() {
        let root = std::env::temp_dir();
        for cmd in [
            r#"grep "foo" /etc/passwd"#,
            r#"rg "foo" /etc/passwd"#,
            r#"git grep "foo" -- /etc/passwd"#,
        ] {
            let result = CommandPathInspector::inspect(cmd, &root);
            assert!(
                result.is_err(),
                "作为搜索目标文件的系统敏感路径必须拦截：{cmd}"
            );
        }
    }

    #[test]
    fn unix_path_validation_rejects_bare_dots() {
        assert!(!is_valid_unix_path("/."));
        assert!(!is_valid_unix_path("/.."));
        assert!(!is_valid_unix_path("/"));
        assert!(!is_valid_unix_path("/./"));
        assert!(!is_valid_unix_path("/./.."));
        assert!(!is_valid_unix_path("/..."));
        assert!(is_valid_unix_path("/.config"));
        assert!(is_valid_unix_path("/app.js"));
        assert!(is_valid_unix_path("/etc/passwd"));
    }

    #[test]
    fn consecutive_unix_paths_extracted() {
        let paths = CommandPathInspector::extract_absolute_paths("cp /tmp/file1 /tmp/file2").unwrap();
        assert!(paths.contains(&PathBuf::from("/tmp/file1")));
        assert!(paths.contains(&PathBuf::from("/tmp/file2")));
    }
}
