//! 英文场景文案：标题 / 正文 / 审计操作英文展示名（自 push/copy.rs 原样搬迁）
//
// 2026-11-03 tray/notification batch copy rule: human-identifiable
// subject first; a bare runId/taskId must never be the body on its own
// (approval S1/S2 keep their current compliant form).

use crate::push::copy::clip_subject;
use crate::push::intent::PayloadDigest;
use crate::push::scenes::SceneId;

/// subject -> "name" display form (clipped, double-quoted)
fn subject_label_en(subject: &str) -> String {
    format!("\"{}\"", clip_subject(subject))
}

pub(super) fn render_title_en(scene: SceneId) -> String {
    match scene {
        SceneId::ApprovalRequested => "Crish Needs Your Approval".to_string(),
        SceneId::ApprovalExpired => "Approval Request Expired".to_string(),
        SceneId::RunCompleted => "Run Completed".to_string(),
        SceneId::RunFailed => "Run Failed".to_string(),
        SceneId::RunCancelled => "Run Cancelled".to_string(),
        SceneId::SubagentCompleted => "Subagent Completed".to_string(),
        SceneId::SubagentFailed => "Subagent Failed".to_string(),
        SceneId::TaskStarted => "Background Task Started".to_string(),
        SceneId::TaskCompleted => "Task Completed".to_string(),
        SceneId::TaskSuspicious => "Task Suspected Stalled".to_string(),
        SceneId::TaskFailed => "Background Task Failed".to_string(),
        SceneId::TaskKilled => "Task Terminated".to_string(),
        SceneId::TimerFired => "Timer Reminder".to_string(),
        SceneId::CronFired => "Scheduled Reminder".to_string(),
        SceneId::RuntimeError => "Runtime Error".to_string(),
        SceneId::InterventionRequired => "Intervention Required".to_string(),
        SceneId::SecurityBlocked => "Security Interception".to_string(),
        SceneId::CacheWasteAlert => "Cache Waste Alert".to_string(),
    }
}

pub(super) fn render_body_en(scene: SceneId, payload: &PayloadDigest) -> String {
    match scene {
        SceneId::ApprovalRequested => format!(
            "{}: {}",
            payload.detail.as_deref().unwrap_or_default(),
            payload.digest.as_deref().unwrap_or_default()
        ),
        SceneId::ApprovalExpired => format!(
            "Approval request ({}) timed out and was automatically rejected",
            payload.biz_key
        ),
        SceneId::RunCompleted => match payload.subject.as_deref() {
            Some(subject) => format!("{} completed", subject_label_en(subject)),
            None => "Task completed".to_string(),
        },
        SceneId::RunFailed => {
            let error = payload.digest.as_deref().unwrap_or_default();
            match (payload.subject.as_deref(), error.is_empty()) {
                (Some(subject), false) => {
                    format!("{} failed: {error}", subject_label_en(subject))
                }
                (Some(subject), true) => format!("{} failed", subject_label_en(subject)),
                (None, false) => error.to_string(),
                (None, true) => "Run failed".to_string(),
            }
        }
        SceneId::RunCancelled => match payload.subject.as_deref() {
            Some(subject) => format!("{} has been cancelled", subject_label_en(subject)),
            None => "Task has been cancelled".to_string(),
        },
        SceneId::SubagentCompleted => {
            let mut body = "Subagent completed".to_string();
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!(" - {summary}"));
            }
            body
        }
        SceneId::SubagentFailed => {
            let mut body = "Subagent failed".to_string();
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!(" - {summary}"));
            }
            body
        }
        SceneId::TaskStarted => payload.digest.clone().unwrap_or_default(),
        SceneId::TaskCompleted => {
            let head = match payload.subject.as_deref() {
                Some(subject) => format!("{} completed", subject_label_en(subject)),
                None => "Task completed".to_string(),
            };
            match payload.detail.as_deref() {
                Some(detail) => format!("{head}, {detail}"),
                None => head,
            }
        }
        SceneId::TaskSuspicious => {
            let secs = payload.digest.as_deref().unwrap_or_default();
            match payload.subject.as_deref() {
                Some(subject) => format!(
                    "{} suspected stalled (no output for {secs}s)",
                    subject_label_en(subject)
                ),
                None => format!("Task suspected stalled (no output for {secs}s)"),
            }
        }
        SceneId::TaskFailed => {
            let detail = payload.detail.as_deref().unwrap_or("unknown exit code");
            let mut body = match payload.subject.as_deref() {
                Some(subject) => {
                    format!("{} exited abnormally ({detail})", subject_label_en(subject))
                }
                None => format!("Task exited abnormally ({detail})"),
            };
            if let Some(tail) = payload.digest.as_deref() {
                if !tail.is_empty() {
                    body.push_str(&format!(": {tail}"));
                }
            }
            body
        }
        SceneId::TaskKilled => match payload.subject.as_deref() {
            Some(subject) => format!("{} has been terminated", subject_label_en(subject)),
            None => "Task has been terminated".to_string(),
        },
        SceneId::TimerFired => format!(
            "{} (Timer {} expired)",
            payload.digest.as_deref().unwrap_or_default(),
            payload.biz_key
        ),
        SceneId::CronFired => {
            let iteration = payload
                .detail
                .as_deref()
                .and_then(|d| d.strip_prefix("iteration "));
            match iteration {
                Some(n) => format!(
                    "{} (Cron {} triggered iteration {n})",
                    payload.digest.as_deref().unwrap_or_default(),
                    payload.biz_key
                ),
                None => format!(
                    "{} (Cron {} triggered)",
                    payload.digest.as_deref().unwrap_or_default(),
                    payload.biz_key
                ),
            }
        }
        SceneId::RuntimeError => payload.digest.clone().unwrap_or_default(),
        SceneId::InterventionRequired => payload.digest.clone().unwrap_or_default(),
        SceneId::SecurityBlocked => format!(
            "Blocked {} operation",
            operation_display_en(payload.digest.as_deref().unwrap_or_default())
        ),
        SceneId::CacheWasteAlert => match payload.detail.as_deref() {
            Some(cost) => format!(
                "Wasted approximately {} tokens in this run (approx. ${cost})",
                payload.digest.as_deref().unwrap_or_default()
            ),
            None => format!(
                "Wasted approximately {} tokens in this run",
                payload.digest.as_deref().unwrap_or_default()
            ),
        },
    }
}

/// 审计操作 wire（Debug 串）→ 英文展示名
fn operation_display_en(wire: &str) -> String {
    match wire {
        "Delete" => "delete".to_string(),
        "TrashRestore" => "trash restore".to_string(),
        "TrashPurge" => "trash purge".to_string(),
        "GitRevert" => "git revert".to_string(),
        "CommandExec" => "command execution".to_string(),
        "UndeclaredWrite" => "undeclared write".to_string(),
        other => other.to_string(),
    }
}
