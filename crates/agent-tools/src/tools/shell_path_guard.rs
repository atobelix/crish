//! shell 工具 · 命令行绝对路径安全围栏（BC10-4 原样恢复）
//!
//! 2026-10-27 恢复说明：权限三模式改造曾把 shell 降为纯 I/O，误删本围栏；
//! 审计发现"绝对路径越界写/删不再拦截"后原样恢复。本模块只承担**执行行为**
//! （系统关键目录物理红线 + 写/删目标越界阻断），不参与 allow/deny 裁决。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::definition::ToolError;

use super::TOOL_COMMAND_BLOCKED;

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
                    TOOL_COMMAND_BLOCKED,
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
                    TOOL_COMMAND_BLOCKED,
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
        static WIN_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(
                r#"(?i)(?:\A|[^a-zA-Z0-9_./\\-])([a-zA-Z]:(?:[\\/][^\s"'`=,;()<>{}\r\n*?|]*)?)"#,
            )
        });

        static QUOTED_WIN_PATH_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"(?i)["']([a-zA-Z]:[\\/][^"'\r\n*?|]+)["']"#));

        static UNIX_PATH_REGEX: CompiledRegex =
            LazyLock::new(|| Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])(/[\w.\-]+(?:/[\w.\-]+)*)"#));

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
            compiled_regex(&QUOTED_WIN_PATH_REGEX, "QUOTED_WIN_PATH")?.captures_iter(command_line)
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
            compiled_regex(&QUOTED_UNIX_PATH_REGEX, "QUOTED_UNIX_PATH")?.captures_iter(command_line)
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
            compiled_regex(&QUOTED_UNC_PATH_REGEX, "QUOTED_UNC_PATH")?.captures_iter(command_line)
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
            compiled_regex(&QUOTED_HOME_PATH_REGEX, "QUOTED_HOME_PATH")?.captures_iter(command_line)
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
        for cap in compiled_regex(&WIN_PATH_REGEX, "WIN_PATH")?.captures_iter(command_line) {
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

        // 2. Unix 绝对路径
        for cap in compiled_regex(&UNIX_PATH_REGEX, "UNIX_PATH")?.captures_iter(command_line) {
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

        // 3. 独立根路径 /
        if compiled_regex(&STANDALONE_ROOT_REGEX, "STANDALONE_ROOT")?.is_match(command_line) {
            let root = PathBuf::from("/");
            if !paths.contains(&root) {
                paths.push(root);
            }
        }

        // 4. UNC 路径
        for cap in compiled_regex(&UNC_PATH_REGEX, "UNC_PATH")?.captures_iter(command_line) {
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
        for cap in compiled_regex(&HOME_PATH_REGEX, "HOME_PATH")?.captures_iter(command_line) {
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
    if !s.starts_with('/') {
        return false;
    }
    if s[1..].contains('/') {
        return true;
    }
    let rest = &s[1..];
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
    rest.contains('.') || rest.len() > 2
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
}
