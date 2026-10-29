//! 间接执行：解释器包裹、编码载荷、调用运算符与脚本块。
//!
//! 段内 `program` / `args` 由唯一分词给出；本模块只负责把内层命令行重新交给
//! 分析入口，不再对同一段二次拆参。

use super::delete_shape::normalize_command;
use super::redline::{deterministic_semantics, ClassSignal};
use super::{analyze_depth, Semantics, Segment, MAX_RECURSION_DEPTH};
use crate::powershell::{extract_and_decode_ps_payload, is_ps_encoded_command_flag};

const INDIRECT_COMMANDS: &[&str] = &[
    "&",
    "eval",
    "source",
    ".",
    "bash",
    "sh",
    "zsh",
    "cmd",
    "cmd.exe",
    "pwsh",
    "powershell",
    "sudo",
    "xargs",
    "node",
    "nodejs",
    "bun",
    "deno",
    "python",
    "python3",
    "py",
    "pythonw",
    "ruby",
    "perl",
    "php",
    "find",
    "foreach-object",
    "iex",
    "invoke-expression",
    "start-process",
    "invoke-command",
    "icm",
];

pub(crate) fn is_indirect_command(cmd: &str) -> bool {
    INDIRECT_COMMANDS.contains(&cmd)
}

/// 分析间接执行的内层命令行。`program` 必须命中 [`is_indirect_command`]。
pub(crate) fn analyze_inner(program: &str, args: &[String], depth: usize) -> Semantics {
    if depth >= MAX_RECURSION_DEPTH {
        return super::dangerous_fallback();
    }
    let inner = match program {
        "&" => {
            if args.is_empty() {
                None
            } else {
                Some(args.join(" "))
            }
        }
        "invoke-command" | "icm" => extract_named_rest(
            args,
            |arg| arg.eq_ignore_ascii_case("-ScriptBlock") || arg.eq_ignore_ascii_case("-Command"),
            true,
        ),
        "bash" | "sh" | "zsh" | "cmd" | "cmd.exe" | "pwsh" | "powershell" | "node" | "nodejs"
        | "bun" | "deno" | "python" | "python3" | "py" | "pythonw" | "ruby" | "perl" | "php" => {
            if (program == "pwsh" || program == "powershell")
                && args.iter().any(|arg| is_ps_encoded_command_flag(arg))
            {
                if let Some(decoded_str) = extract_and_decode_ps_payload(args) {
                    let mut decoded = analyze_depth(&decoded_str, depth + 1);
                    decoded.decoded_payload = Some(decoded_str);
                    return decoded;
                }
                return deterministic_semantics(ClassSignal::UndecodablePayload);
            }
            extract_shell_c(args)
        }
        "eval" | "source" | "." | "sudo" | "xargs" | "iex" | "invoke-expression" => {
            Some(args.join(" "))
        }
        "start-process" => extract_start_process(args),
        "find" => extract_find_exec(args),
        "foreach-object" => extract_foreach(args),
        _ => None,
    };
    match inner {
        Some(inner_cmd) if !inner_cmd.trim().is_empty() => analyze_depth(&inner_cmd, depth + 1),
        _ => super::empty_normal(),
    }
}

fn extract_named_rest(
    args: &[String],
    is_flag: impl Fn(&str) -> bool,
    fallback_all: bool,
) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if is_flag(arg) {
            let rest: Vec<&String> = iter.by_ref().collect();
            if rest.is_empty() {
                break;
            }
            let joined = rest
                .iter()
                .map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            return Some(strip_scriptblock_braces(&joined));
        }
    }
    if fallback_all && !args.is_empty() {
        return Some(strip_scriptblock_braces(&args.join(" ")));
    }
    None
}

fn extract_shell_c(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg.eq_ignore_ascii_case("-c")
            || arg.eq_ignore_ascii_case("-command")
            || arg.eq_ignore_ascii_case("/c")
        {
            let rest: Vec<&String> = iter.by_ref().collect();
            if rest.is_empty() {
                return None;
            }
            return Some(
                rest.iter()
                    .map(|item| item.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        let lower = arg.to_lowercase();
        if lower.starts_with("-command") && arg.len() > 8 {
            return Some(arg[8..].trim_start_matches(['=', ':']).trim().to_string());
        }
        if lower.starts_with("/c") && arg.len() > 2 {
            return Some(arg[2..].trim_start().to_string());
        }
    }
    None
}

fn extract_start_process(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg.eq_ignore_ascii_case("-ArgumentList")
            || arg.eq_ignore_ascii_case("-Argument")
            || arg.eq_ignore_ascii_case("-Args")
        {
            let rest: Vec<&String> = iter.by_ref().collect();
            if rest.is_empty() {
                return None;
            }
            let joined = rest
                .iter()
                .map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let stripped = joined.trim_start();
            return Some(
                stripped
                    .strip_prefix("/c")
                    .map(|rest| rest.trim_start().to_string())
                    .unwrap_or_else(|| joined.clone()),
            );
        }
    }
    None
}

fn extract_find_exec(args: &[String]) -> Option<String> {
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if arg == "-exec" || arg == "-execdir" {
            let mut cmd_parts = Vec::new();
            for next in iter.by_ref() {
                if next == ";" || next == "{}" || next == "+" {
                    break;
                }
                cmd_parts.push(next.clone());
            }
            if cmd_parts.is_empty() {
                return None;
            }
            return Some(cmd_parts.join(" "));
        }
    }
    None
}

fn extract_foreach(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-Process" {
            let rest: Vec<&String> = iter.by_ref().collect();
            if rest.is_empty() {
                return None;
            }
            let joined = rest
                .iter()
                .map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            return Some(strip_scriptblock_braces(&joined));
        }
        if arg.starts_with('{') {
            let mut parts = vec![arg.clone()];
            for next in iter.by_ref() {
                parts.push(next.clone());
                if next.contains('}') {
                    break;
                }
            }
            return Some(strip_scriptblock_braces(&parts.join(" ")));
        }
    }
    None
}

fn strip_scriptblock_braces(joined: &str) -> String {
    let trimmed = joined.trim();
    let without_open = trimmed.strip_prefix('{').unwrap_or(trimmed);
    let without_close = without_open.strip_suffix('}').unwrap_or(without_open);
    without_close.trim().to_string()
}

pub(crate) fn unwrap_interpreter_wrapper(seg: &Segment) -> Option<String> {
    let cmd = seg.program.as_str();
    if !matches!(cmd, "bash" | "sh" | "zsh" | "cmd" | "pwsh" | "powershell") {
        return None;
    }
    if matches!(cmd, "pwsh" | "powershell") {
        if let Some(decoded) = extract_and_decode_ps_payload(&seg.args) {
            return Some(decoded);
        }
    }
    let mut iter = seg.args.iter();
    while let Some(arg) = iter.next() {
        if arg.eq_ignore_ascii_case("-c")
            || arg.eq_ignore_ascii_case("-lc")
            || arg.eq_ignore_ascii_case("-command")
            || arg.eq_ignore_ascii_case("--command")
            || arg.eq_ignore_ascii_case("/c")
        {
            let remaining: Vec<&String> = iter.collect();
            if remaining.is_empty() {
                return None;
            }
            let joined = remaining
                .iter()
                .map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            let unquoted = joined.trim().trim_matches(['"', '\'']);
            if unquoted.is_empty() {
                return None;
            }
            return Some(unquoted.to_string());
        }
    }
    None
}
