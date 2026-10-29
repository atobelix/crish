//! 智能放行：只读白名单、空重定向剥离，以及敏感操作审批。
//!
//! 消费语义分析产出的同一份 [`Segment`]，不再对整行重新拆参。

use super::git::{inspect_git_mutation, inspect_git_sensitive};
use super::indirect::unwrap_interpreter_wrapper;
use super::redline::inspect_redline_denial;
use super::{analyze_depth, ApprovalReason, Segment, SmartDecision, MAX_WRAP_DEPTH};
use crate::lex::normalize_token;

/// 智能裁决入口。段由语义分析一次拆出，这里只做规则判定。
pub(crate) fn smart_decision(command_line: &str, segments: &[Segment]) -> SmartDecision {
    smart_decision_depth(command_line, segments, 0)
}

fn smart_decision_depth(
    command_line: &str,
    segments: &[Segment],
    depth: usize,
) -> SmartDecision {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return SmartDecision {
            deny_reason: None,
            approval: None,
            pure_read_only: true,
        };
    }
    if depth > MAX_WRAP_DEPTH {
        return SmartDecision {
            deny_reason: None,
            approval: Some(ApprovalReason::UnsafeSideEffect {
                command: trimmed.to_string(),
            }),
            pure_read_only: false,
        };
    }
    let normalized = strip_null_redirects(trimmed);
    let unsafe_shape = has_unsafe_shell_shape(&normalized);
    if is_remote_pipe_execution(trimmed, segments) {
        return SmartDecision {
            deny_reason: None,
            approval: Some(ApprovalReason::RemotePipeExecution {
                pipeline: trimmed.to_string(),
            }),
            pure_read_only: false,
        };
    }
    if segments.is_empty() {
        return SmartDecision {
            deny_reason: None,
            approval: None,
            pure_read_only: !unsafe_shape,
        };
    }
    let mut require_approval_reason: Option<ApprovalReason> = None;
    let mut all_read_only = !unsafe_shape;
    for seg in segments {
        if let Some(inner_cmd) = unwrap_interpreter_wrapper(seg) {
            let inner_semantics = analyze_depth(&inner_cmd, depth + 1);
            let inner = smart_decision_depth(&inner_cmd, &inner_semantics.segments, depth + 1);
            if let Some(reason) = inner.deny_reason {
                return SmartDecision {
                    deny_reason: Some(reason),
                    approval: None,
                    pure_read_only: false,
                };
            }
            if let Some(reason) = inner.approval {
                require_approval_reason.get_or_insert(reason);
                all_read_only = false;
                continue;
            }
            all_read_only &= inner.pure_read_only;
        }
        if let Some(deny_reason) = inspect_redline_denial(seg) {
            return SmartDecision {
                deny_reason: Some(deny_reason),
                approval: None,
                pure_read_only: false,
            };
        }
        if let Some(reason) = inspect_find_mutation(seg).or_else(|| inspect_git_mutation(seg)) {
            require_approval_reason.get_or_insert(reason);
            all_read_only = false;
            continue;
        }
        if let Some(reason) = inspect_sensitive_operation(seg) {
            require_approval_reason.get_or_insert(reason);
            all_read_only = false;
            continue;
        }
        if !is_segment_safe(seg) {
            require_approval_reason.get_or_insert(ApprovalReason::UnsafeSideEffect {
                command: seg.raw.clone(),
            });
            all_read_only = false;
        } else if !is_segment_pure_read_only(seg) {
            all_read_only = false;
        }
    }
    if unsafe_shape {
        require_approval_reason.get_or_insert(ApprovalReason::UnsafeSideEffect {
            command: trimmed.to_string(),
        });
        all_read_only = false;
    }
    match require_approval_reason {
        Some(reason) => SmartDecision {
            deny_reason: None,
            approval: Some(reason),
            pure_read_only: false,
        },
        None => SmartDecision {
            deny_reason: None,
            approval: None,
            pure_read_only: all_read_only,
        },
    }
}

pub(crate) fn strip_null_redirects(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    let mut out = String::with_capacity(command.len());
    let bytes = command.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let rest = &lower_bytes[index..];
        let skip_len = [
            "2>>/dev/null",
            "2> /dev/null",
            "2>> /dev/null",
            "2>/dev/null",
            "1>>/dev/null",
            "1> /dev/null",
            "1>/dev/null",
            ">>/dev/null",
            ">> /dev/null",
            "> /dev/null",
            ">/dev/null",
            "2>&1",
            "1>&2",
            "2>>nul",
            "2>> nul",
            "2>nul",
            "2> nul",
            ">>nul",
            ">> nul",
            "> nul",
            ">nul",
        ]
        .iter()
        .find_map(|pat| rest.starts_with(pat.as_bytes()).then_some(pat.len()));
        if let Some(len) = skip_len {
            index += len;
            continue;
        }
        let ch = command[index..].chars().next().unwrap_or(' ');
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

pub(crate) fn has_unsafe_shell_shape(command: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if !in_single => {
                let escaped_char = chars.next();
                if escaped_char.is_none() {
                    break;
                }
            }
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            _ if in_single => {}
            '\n' | '\r' | '<' | '>' => return true,
            '`' => return true,
            '$' if chars.peek() == Some(&'(') => return true,
            _ => {}
        }
    }
    false
}

pub(crate) fn inspect_find_mutation(seg: &Segment) -> Option<ApprovalReason> {
    if seg.program != "find" {
        return None;
    }
    let mut destructive = false;
    for arg in &seg.args {
        match arg.to_ascii_lowercase().as_str() {
            "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" => destructive = true,
            "-fprint" | "-fprint0" | "-fprintf" | "-fls" => {
                return Some(ApprovalReason::UnsafeSideEffect {
                    command: seg.raw.clone(),
                })
            }
            _ => {}
        }
    }
    destructive.then(|| ApprovalReason::DestructiveDelete {
        targets: vec![seg.raw.clone()],
    })
}

pub(crate) fn is_segment_pure_read_only(seg: &Segment) -> bool {
    let cmd = seg.program.as_str();
    if matches!(
        cmd,
        "ls" | "dir"
            | "cat"
            | "type"
            | "head"
            | "tail"
            | "more"
            | "less"
            | "grep"
            | "rg"
            | "findstr"
            | "which"
            | "where"
            | "pwd"
            | "file"
            | "wc"
            | "stat"
            | "diff"
            | "echo"
            | "printf"
            | "uname"
            | "hostname"
            | "whoami"
            | "date"
            | "uptime"
    ) {
        return true;
    }
    if cmd == "find" {
        return inspect_find_mutation(seg).is_none();
    }
    if cmd != "git" {
        return false;
    }
    let Some(sub) = seg.args.first().map(|item| item.to_ascii_lowercase()) else {
        return true;
    };
    matches!(
        sub.as_str(),
        "status"
            | "diff"
            | "log"
            | "show"
            | "rev-parse"
            | "check-ignore"
            | "ls-files"
            | "describe"
            | "version"
            | "help"
            | "branch"
            | "tag"
            | "remote"
            | "config"
    )
}

fn is_segment_safe(seg: &Segment) -> bool {
    let cmd = seg.program.as_str();
    if is_segment_pure_read_only(seg) && cmd != "git" && cmd != "find" {
        return true;
    }
    if cmd == "find" {
        return inspect_find_mutation(seg).is_none();
    }
    if matches!(
        cmd,
        "cd" | "chdir"
            | "pushd"
            | "popd"
            | "set-location"
            | "sl"
            | "push-location"
            | "pop-location"
    ) {
        return true;
    }
    if cmd == "git" {
        if let Some(sub) = seg.args.first().map(|item| item.to_ascii_lowercase()) {
            if matches!(
                sub.as_str(),
                "status"
                    | "diff"
                    | "log"
                    | "branch"
                    | "show"
                    | "rev-parse"
                    | "remote"
                    | "tag"
                    | "check-ignore"
                    | "ls-files"
                    | "describe"
                    | "version"
                    | "help"
                    | "config"
            ) {
                return true;
            }
            if sub == "checkout" || sub == "switch" {
                return true;
            }
        } else {
            return true;
        }
    }
    if cmd == "cargo" {
        if let Some(sub) = seg.args.first().map(|item| item.to_ascii_lowercase()) {
            if matches!(
                sub.as_str(),
                "check"
                    | "build"
                    | "test"
                    | "clippy"
                    | "fmt"
                    | "bench"
                    | "tree"
                    | "version"
                    | "metadata"
                    | "verify-project"
                    | "locate-project"
            ) {
                return true;
            }
        }
    }
    if matches!(cmd, "npm" | "pnpm" | "yarn" | "bun") {
        if let Some(sub) = seg.args.first().map(|item| item.to_ascii_lowercase()) {
            if matches!(
                sub.as_str(),
                "test"
                    | "run"
                    | "check"
                    | "lint"
                    | "typecheck"
                    | "list"
                    | "outdated"
                    | "why"
                    | "exec"
                    | "version"
            ) {
                return true;
            }
        }
    }
    if matches!(cmd, "npx" | "bunx") {
        if let Some(sub) = seg.args.first() {
            let sub_clean = normalize_token(sub);
            if matches!(
                sub_clean.as_str(),
                "eslint"
                    | "vitest"
                    | "jest"
                    | "prettier"
                    | "tsc"
                    | "stylelint"
                    | "webpack"
                    | "vite"
                    | "rollup"
                    | "esbuild"
                    | "tailwind"
                    | "tailwindcss"
                    | "rimraf"
                    | "cross-env"
            ) && sub_clean.as_str() != "rimraf"
            {
                return true;
            }
        }
    }
    if matches!(
        cmd,
        "pytest"
            | "vitest"
            | "jest"
            | "tsc"
            | "eslint"
            | "prettier"
            | "ruff"
            | "black"
            | "mypy"
            | "flake8"
            | "golangci-lint"
            | "go"
            | "mvn"
            | "gradle"
            | "make"
            | "cmake"
            | "ninja"
    ) {
        return true;
    }
    if matches!(cmd, "python" | "python3" | "py") {
        if seg.args.iter().any(|arg| arg == "-V" || arg == "--version") {
            return true;
        }
        if let Some(idx) = seg.args.iter().position(|arg| arg == "-m") {
            if let Some(module) = seg.args.get(idx + 1) {
                if matches!(module.as_str(), "unittest" | "pytest" | "test" | "venv") {
                    return true;
                }
            }
        }
    }
    matches!(
        cmd,
        "true" | "false" | "test" | "[" | "env" | "export" | "set" | "alias" | "clear"
    )
}

pub(crate) fn inspect_sensitive_operation(seg: &Segment) -> Option<ApprovalReason> {
    let cmd = seg.program.as_str();
    if matches!(cmd, "sudo" | "runas" | "su") {
        return Some(ApprovalReason::PrivilegeEscalation {
            command: seg.raw.clone(),
        });
    }
    if cmd == "chmod" {
        let is_permissive = seg
            .args
            .iter()
            .any(|arg| arg.contains("777") || arg.contains("a+rwx"));
        if is_permissive {
            return Some(ApprovalReason::PrivilegeEscalation {
                command: seg.raw.clone(),
            });
        }
    }
    if cmd == "chown" {
        return Some(ApprovalReason::PrivilegeEscalation {
            command: seg.raw.clone(),
        });
    }
    if matches!(cmd, "rm" | "del" | "erase" | "rmdir" | "rd" | "remove-item") {
        let targets = extract_path_targets(&seg.args);
        return Some(ApprovalReason::DestructiveDelete { targets });
    }
    if let Some(reason) = inspect_git_sensitive(seg) {
        return Some(reason);
    }
    if matches!(cmd, "npm" | "pnpm" | "yarn")
        && seg.args.first().map(String::as_str) == Some("publish")
    {
        return Some(ApprovalReason::PackagePublish {
            registry: "npm".to_string(),
        });
    }
    if cmd == "cargo" && seg.args.first().map(String::as_str) == Some("publish") {
        return Some(ApprovalReason::PackagePublish {
            registry: "crates.io".to_string(),
        });
    }
    if cmd == "twine" && seg.args.first().map(String::as_str) == Some("upload") {
        return Some(ApprovalReason::PackagePublish {
            registry: "pypi".to_string(),
        });
    }
    if cmd == "gem" && seg.args.first().map(String::as_str) == Some("push") {
        return Some(ApprovalReason::PackagePublish {
            registry: "rubygems".to_string(),
        });
    }
    None
}

pub(crate) fn is_windows_switch(arg: &str) -> bool {
    if !arg.starts_with('/') || arg.len() < 2 {
        return false;
    }
    let bytes = arg.as_bytes();
    if bytes.len() == 2 && bytes[1].is_ascii_alphabetic() {
        return true;
    }
    if bytes.len() > 2 {
        if let Some(sep) = arg[1..].find([':', '=']) {
            let name = &arg[1..1 + sep];
            if !name.is_empty() && name.chars().all(|ch| ch.is_ascii_alphabetic()) {
                return true;
            }
        }
        let lower = arg.to_ascii_lowercase();
        if lower == "/recurse" || lower == "/force" || lower == "/quiet" || lower == "/silent" {
            return true;
        }
    }
    false
}

pub(crate) fn extract_path_targets(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| !arg.starts_with('-') && !is_windows_switch(arg))
        .map(|arg| arg.trim_matches(['"', '\'']).to_string())
        .filter(|arg| !arg.is_empty())
        .collect()
}

/// 远程下载器管道进解释器。段来自同一份语义解析，先按 `|` 快速排除。
pub(crate) fn is_remote_pipe_execution(command_line: &str, segments: &[Segment]) -> bool {
    if !command_line.contains('|') {
        return false;
    }
    let has_downloader = segments.iter().any(|seg| {
        matches!(
            seg.program.as_str(),
            "curl" | "wget" | "iwr" | "invoke-webrequest"
        )
    });
    let has_interpreter = segments.iter().any(|seg| {
        matches!(
            seg.program.as_str(),
            "sh" | "bash"
                | "zsh"
                | "pwsh"
                | "powershell"
                | "iex"
                | "invoke-expression"
                | "python"
                | "python3"
                | "node"
                | "perl"
                | "ruby"
        )
    });
    has_downloader && has_interpreter
}
