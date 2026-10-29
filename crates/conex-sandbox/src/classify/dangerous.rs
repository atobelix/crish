//! 危险形态：反射启动、环境变量拼接、赋值隐藏命令与下载管道。
//!
//! 反射与环境拼接只报告 [`ClassSignal`]；红线由 `redline::resolve` 裁决。

use super::delete_shape::{classify_delete_command, is_delete_command, normalize_command};
use super::indirect::is_indirect_command;
use super::redline::{listed_command, resolve, ClassSignal};
use super::{analyze_depth, CommandClass, MAX_RECURSION_DEPTH};
use crate::lex::split_command_args_normalized;
use crate::powershell::{extract_and_decode_ps_payload, is_ps_encoded_command_flag};

const DANGEROUS_COMMANDS: &[&str] = &[
    "mkfs",
    "mkfs.ext2",
    "mkfs.ext3",
    "mkfs.ext4",
    "mkfs.xfs",
    "mkfs.btrfs",
    "format-volume",
    "clear-disk",
    "format",
    "dd",
    "stop-computer",
    "restart-computer",
];

const PRINT_WHITELIST: &[&str] = &["echo", "write-output", "printf", "cat", "grep", "type"];

pub(crate) fn is_dangerous_command(cmd: &str) -> bool {
    DANGEROUS_COMMANDS.contains(&cmd)
}

pub(crate) fn is_print_whitelist(cmd: &str) -> bool {
    PRINT_WHITELIST.contains(&cmd)
}

/// 单标记的危险信号。反射启动为红线，环境变量拼接为危险。
pub(crate) fn analyze_token_danger(token: &str) -> Option<ClassSignal> {
    let lower = token.to_lowercase();
    if lower.starts_with("[system.diagnostics.process]")
        || lower.contains("::start")
        || lower.starts_with("[scriptblock]")
        || lower.contains("::create")
        || lower.starts_with("[powershell]")
        || lower.starts_with("[system.appdomain]")
        || lower.starts_with("[system.reflection.")
    {
        return Some(ClassSignal::Reflection);
    }
    if lower.contains("$env:comspec") || lower.contains("$env:systemroot") {
        return Some(ClassSignal::EnvironmentInterpolation);
    }
    None
}

/// 段内语法与动态执行。深度达到上限时直接判危险。
pub(crate) fn analyze_segment_ast(
    command: &str,
    args: &[String],
    depth: usize,
) -> CommandClass {
    if depth >= MAX_RECURSION_DEPTH {
        return CommandClass::Dangerous;
    }
    if let Some(signal) = analyze_token_danger(command) {
        return resolve(signal);
    }
    for arg in args {
        if let Some(signal) = analyze_token_danger(arg) {
            return resolve(signal);
        }
    }
    if command == "&" && !args.is_empty() {
        let target = &args[0];
        if target.starts_with('$') || target.starts_with('(') || target.starts_with('{') {
            return CommandClass::Dangerous;
        }
    }
    if command.starts_with("$(") || command.starts_with("&(") || command.starts_with("&{") {
        return CommandClass::Dangerous;
    }
    if command.starts_with('$')
        && !args.first().is_some_and(|arg| arg == "=")
        && !is_print_whitelist(command)
    {
        return CommandClass::Dangerous;
    }
    let lower_cmd = command.to_lowercase();
    if lower_cmd == "powershell" || lower_cmd == "pwsh" {
        for arg in args {
            if is_ps_encoded_command_flag(arg) {
                if let Some(decoded) = extract_and_decode_ps_payload(args) {
                    return analyze_depth(&decoded, depth + 1).overall;
                }
                return resolve(ClassSignal::UndecodablePayload);
            }
        }
    }
    if lower_cmd == "%" || lower_cmd == "foreach-object" {
        for arg in args {
            if arg.starts_with('{') && arg.ends_with('}') && arg.len() >= 2 {
                let inner = &arg[1..arg.len() - 1];
                let (sub_cmd, sub_args) = split_command_args_normalized(inner);
                if !sub_cmd.is_empty() {
                    let sub_norm = normalize_command(&sub_cmd);
                    if is_delete_command(&sub_norm) {
                        return CommandClass::Dangerous;
                    }
                    let sub_class = analyze_segment_ast(&sub_norm, &sub_args, depth + 1);
                    if sub_class == CommandClass::Redline || sub_class == CommandClass::Dangerous {
                        return sub_class;
                    }
                }
            }
        }
    }
    CommandClass::Normal
}

/// 赋值形态或未知命令的参数里藏着清单命令时，按该命令的分类回升。
pub(crate) fn scan_ps_command_tokens(
    command: &str,
    args: &[String],
) -> Option<CommandClass> {
    let is_assignment = command.starts_with('$') && args.first().is_some_and(|arg| arg == "=");
    let is_known = is_indirect_command(command)
        || is_delete_command(command)
        || listed_command(command).is_some()
        || is_dangerous_command(command)
        || is_print_whitelist(command);
    if !is_assignment && is_known {
        return None;
    }
    let start = if is_assignment { 1 } else { 0 };
    for (index, token) in args[start..].iter().enumerate() {
        let candidate = normalize_command(token);
        if listed_command(&candidate).is_some() {
            return Some(resolve(ClassSignal::ListedCommand));
        }
        if is_delete_command(&candidate) {
            let rest: Vec<String> = args[start + index + 1..].to_vec();
            return classify_delete_command(&candidate, &rest).map(resolve);
        }
        if is_indirect_command(&candidate) {
            let sub_line = args[start + index..].join(" ");
            let inner = analyze_depth(&sub_line, 1);
            if inner.overall == CommandClass::Redline {
                return Some(resolve(ClassSignal::NestedRedline));
            }
            if inner.overall == CommandClass::Dangerous {
                return Some(CommandClass::Dangerous);
            }
            return Some(CommandClass::Indirect);
        }
    }
    None
}
