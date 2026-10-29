//! 版本库回退形态，以及智能裁决里的写操作识别。

use super::delete_shape::strip_double_dash;
use super::ApprovalReason;
use super::Segment;

pub(crate) fn classify_git_revert(args: &[String]) -> Option<String> {
    let (effective, positional) = strip_double_dash(args);
    let first = effective.first()?;
    match first.as_str() {
        "reset" => {
            if effective.iter().any(|arg| arg == "--hard") {
                Some("git reset --hard".to_string())
            } else {
                None
            }
        }
        "clean" => {
            if effective.iter().any(|arg| arg == "-f" || arg == "--force") {
                Some("git clean -f".to_string())
            } else {
                None
            }
        }
        "stash" => {
            if effective.get(1).map(String::as_str) == Some("drop") {
                Some("git stash drop".to_string())
            } else {
                None
            }
        }
        "revert" => {
            if effective.iter().any(|arg| arg == "--no-commit") {
                Some("git revert --no-commit".to_string())
            } else {
                None
            }
        }
        "restore" => {
            if effective.iter().any(|arg| arg.starts_with("--source")) {
                Some("git restore --source".to_string())
            } else {
                None
            }
        }
        "checkout" => {
            if positional.is_empty() && effective.len() >= 2 {
                let target = &effective[1];
                let is_hex_ref = !target.starts_with('-')
                    && target != "."
                    && !target.starts_with("--")
                    && target.len() >= 7
                    && target.chars().all(|ch| ch.is_ascii_hexdigit());
                if is_hex_ref {
                    Some(format!("git checkout {target}"))
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 写参数与任意检出。检出无法区分切分支和丢弃文件，一律审批。
pub(crate) fn inspect_git_mutation(seg: &Segment) -> Option<ApprovalReason> {
    if seg.program != "git" {
        return None;
    }
    let sub = seg.args.first()?.to_ascii_lowercase();
    let rest = &seg.args[1..];
    let has_any = |needles: &[&str]| {
        rest.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            needles
                .iter()
                .any(|needle| lower == *needle || lower.starts_with(&format!("{needle}=")))
        })
    };
    let positional = rest.iter().filter(|arg| !arg.starts_with('-')).count();
    match sub.as_str() {
        "checkout" => Some(ApprovalReason::GitHistoryRewrite {
            operation: "git checkout（可能丢弃工作区改动）".to_string(),
        }),
        "branch" => {
            let write_flag = has_any(&[
                "-d",
                "-D",
                "-m",
                "-M",
                "-c",
                "-C",
                "--delete",
                "--move",
                "--copy",
                "--set-upstream-to",
                "--unset-upstream",
                "--edit-description",
                "-u",
            ]);
            (write_flag || positional > 0).then(|| ApprovalReason::GitHistoryRewrite {
                operation: seg.raw.clone(),
            })
        }
        "tag" => {
            let write_flag = has_any(&[
                "-d",
                "--delete",
                "-a",
                "--annotate",
                "-s",
                "--sign",
                "-f",
                "--force",
                "-m",
                "-F",
                "-u",
            ]);
            (write_flag || positional > 0).then(|| ApprovalReason::GitHistoryRewrite {
                operation: seg.raw.clone(),
            })
        }
        "remote" => {
            let mutating = rest.first().is_some_and(|arg| {
                matches!(
                    arg.to_ascii_lowercase().as_str(),
                    "add"
                        | "remove"
                        | "rm"
                        | "set-url"
                        | "rename"
                        | "prune"
                        | "update"
                        | "set-head"
                        | "set-branches"
                )
            });
            mutating.then(|| ApprovalReason::GitHistoryRewrite {
                operation: seg.raw.clone(),
            })
        }
        "config" => {
            let write_flag = has_any(&[
                "--global",
                "--local",
                "--system",
                "--worktree",
                "--unset",
                "--unset-all",
                "--add",
                "--replace-all",
                "--rename-section",
                "--remove-section",
            ]);
            (write_flag || positional >= 2).then(|| ApprovalReason::GitHistoryRewrite {
                operation: seg.raw.clone(),
            })
        }
        _ => None,
    }
}

pub(crate) fn inspect_git_sensitive(seg: &Segment) -> Option<ApprovalReason> {
    if seg.program != "git" {
        return None;
    }
    let sub = seg.args.first().map(|item| item.to_ascii_lowercase())?;
    match sub.as_str() {
        "push" => {
            let is_force = seg.args.iter().any(|arg| {
                arg == "-f"
                    || arg == "--force"
                    || arg.starts_with("--force-with-lease")
                    || arg.starts_with('+')
            });
            is_force.then(|| ApprovalReason::GitHistoryRewrite {
                operation: "git push --force".to_string(),
            })
        }
        "reset" => {
            let is_hard = seg.args.iter().any(|arg| arg == "--hard");
            is_hard.then(|| ApprovalReason::GitHistoryRewrite {
                operation: "git reset --hard".to_string(),
            })
        }
        "clean" => {
            let is_force = seg.args.iter().any(|arg| arg.contains('f'));
            is_force.then(|| ApprovalReason::DestructiveDelete {
                targets: vec!["untracked git files".to_string()],
            })
        }
        "rm" => {
            let targets: Vec<String> = seg.args[1..]
                .iter()
                .filter(|arg| !arg.starts_with('-'))
                .cloned()
                .collect();
            Some(ApprovalReason::DestructiveDelete { targets })
        }
        "restore" => Some(ApprovalReason::GitHistoryRewrite {
            operation: "git restore (discard changes)".to_string(),
        }),
        "checkout" => {
            let has_force = seg.args.iter().any(|arg| arg == "-f" || arg == "--force");
            let has_dashdash = seg.args.iter().any(|arg| arg == "--");
            let targets = super::read_only::extract_path_targets(&seg.args[1..]);
            let has_dot = targets.iter().any(|target| target == "." || target == "./");
            (has_force || has_dashdash || has_dot).then(|| ApprovalReason::GitHistoryRewrite {
                operation: "git checkout (discard changes)".to_string(),
            })
        }
        "switch" => {
            let has_force = seg
                .args
                .iter()
                .any(|arg| arg == "-f" || arg == "--force" || arg.starts_with("--discard-changes"));
            has_force.then(|| ApprovalReason::GitHistoryRewrite {
                operation: "git switch --discard-changes".to_string(),
            })
        }
        _ => None,
    }
}
