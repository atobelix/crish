//! 删除形态：目标提取、盘符根信号与递归/强制开关。
//!
//! 本模块只报告形态（[`ClassSignal::DeleteShape`] / [`ClassSignal::RootDestructiveDelete`]），
//! 是否红线由 `redline::resolve` 决定。

use super::redline::ClassSignal;
use crate::lex::normalize_token;

const DELETE_COMMANDS: &[&str] = &["rm", "rmdir", "del", "erase", "rd", "remove-item", "git"];

pub(crate) fn is_delete_command(cmd: &str) -> bool {
    DELETE_COMMANDS.contains(&cmd)
}

/// 归一化参数：剥离 `--`。`--` 之后仍保留为位置参数。
pub(crate) fn strip_double_dash(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut effective = Vec::new();
    let mut positional = Vec::new();
    let mut after_dd = false;
    for arg in args {
        if after_dd {
            positional.push(arg.clone());
        } else if arg == "--" {
            after_dd = true;
        } else {
            effective.push(arg.clone());
        }
    }
    (effective, positional)
}

pub(crate) fn extract_delete_targets(command: &str, args: &[String]) -> Vec<String> {
    if command == "git" {
        let mut targets = Vec::new();
        let mut after_rm = false;
        let mut skip_next = false;
        for arg in args {
            if skip_next {
                skip_next = false;
                continue;
            }
            if !after_rm {
                if arg == "rm" {
                    after_rm = true;
                }
                continue;
            }
            if arg == "--"
                || arg == "-r"
                || arg == "-f"
                || arg == "-rf"
                || arg == "-fr"
                || arg == "--cached"
            {
                continue;
            }
            if arg.starts_with('-') {
                continue;
            }
            targets.push(arg.clone());
        }
        return targets;
    }

    let (effective, positional) = strip_double_dash(args);
    let mut targets = Vec::new();
    for arg in effective.iter().chain(positional.iter()) {
        if arg.starts_with('-') {
            continue;
        }
        let lower = arg.to_lowercase();
        if lower == "/s" || lower == "/q" || lower == "/f" {
            continue;
        }
        let drive = arg.starts_with("C:")
            || (arg.starts_with('C') && arg.len() >= 2 && arg.as_bytes()[1] == b':');
        let rooted = arg.starts_with('/')
            || arg.starts_with("./")
            || arg.starts_with("../")
            || arg == "."
            || arg == ".."
            || arg == "~";
        let delete_name = matches!(
            command,
            "rm" | "rmdir" | "del" | "erase" | "rd" | "remove-item"
        );
        if drive || rooted || delete_name {
            targets.push(arg.clone());
        }
    }
    targets
}

/// 路径是否为根或盘符根。
pub(crate) fn is_root_target(target: &str) -> bool {
    let normalized = target.trim();
    if normalized == "/" || normalized == "*" || normalized == "/*" {
        return true;
    }
    let lower = normalized.to_lowercase();
    if lower.len() >= 2 && lower.as_bytes()[0].is_ascii_alphabetic() && lower.as_bytes()[1] == b':'
    {
        if lower.len() == 2 {
            return true;
        }
        if lower.as_bytes()[2] == b'\\' || lower.as_bytes()[2] == b'/' {
            let rest = &lower[3..];
            return rest.is_empty() || rest == "*" || rest == "\\*" || rest == "/*";
        }
    }
    false
}

pub(crate) fn has_recursive(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "-r"
            || arg == "-R"
            || arg == "--recursive"
            || arg == "-rf"
            || arg == "-fr"
            || arg == "-rF"
            || (arg.starts_with('-')
                && arg.len() > 1
                && arg[1..].chars().any(|ch| ch == 'r' || ch == 'R'))
    })
}

pub(crate) fn has_force(args: &[String]) -> bool {
    args.iter().any(|arg| {
        arg == "-f"
            || arg == "--force"
            || arg == "-rf"
            || arg == "-fr"
            || arg == "-fR"
            || arg == "-rF"
            || (arg.starts_with('-') && arg.len() > 1 && arg[1..].chars().any(|ch| ch == 'f'))
    })
}

/// 删除命令的形态信号。`git` 不在这里判定。
pub(crate) fn classify_delete_command(command: &str, args: &[String]) -> Option<ClassSignal> {
    if !is_delete_command(command) || command == "git" {
        return None;
    }
    let targets = extract_delete_targets(command, args);
    if command == "rm"
        || command == "rmdir"
        || command == "del"
        || command == "erase"
        || command == "rd"
        || command == "remove-item"
    {
        let win_recursive = args
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("/s") || arg.eq_ignore_ascii_case("/S"));
        let win_force = args
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("/q") || arg.eq_ignore_ascii_case("/f"));
        let recursive = has_recursive(args) || win_recursive;
        let force = has_force(args) || win_force;
        if targets.iter().any(|target| is_root_target(target)) && (recursive || force) {
            return Some(ClassSignal::RootDestructiveDelete);
        }
    }
    Some(ClassSignal::DeleteShape)
}

pub(crate) fn normalize_command(command: &str) -> String {
    normalize_token(command)
}
