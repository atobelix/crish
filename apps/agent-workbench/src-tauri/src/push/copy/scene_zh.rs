//! 中文场景文案：标题 / 正文 / 审计操作中文展示名（自 push/copy.rs 原样搬迁）
//
// 2026-11-03 托盘/通知批文案口径：人类可识别名（subject）优先，
// **禁止裸 runId/taskId 单独作正文**——S3/S4/S5/S6/S7/S8b/S8c/S8d/S8e
// 全部改名优先形态，subject 缺失时回落无标识文案（审批 S1/S2 保持
// 现行达标形态不动）。

use crate::push::copy::clip_subject;
use crate::push::intent::PayloadDigest;
use crate::push::scenes::SceneId;

/// subject → 「name」展示形态（钳制后加中文引号）
fn subject_label_zh(subject: &str) -> String {
    format!("「{}」", clip_subject(subject))
}

pub(super) fn render_title_zh(scene: SceneId) -> String {
    match scene {
        SceneId::ApprovalRequested => "Crish 需要你的批准".to_string(),
        SceneId::ApprovalExpired => "审批已过期".to_string(),
        SceneId::RunCompleted => "任务已完成".to_string(),
        SceneId::RunFailed => "任务运行失败".to_string(),
        SceneId::RunCancelled => "任务已取消".to_string(),
        SceneId::SubagentCompleted => "子代理已完成".to_string(),
        SceneId::SubagentFailed => "子代理失败".to_string(),
        SceneId::TaskStarted => "后台任务已启动".to_string(),
        SceneId::TaskCompleted => "任务已完成".to_string(),
        SceneId::TaskSuspicious => "任务疑似卡死".to_string(),
        SceneId::TaskFailed => "后台任务异常退出".to_string(),
        SceneId::TaskKilled => "任务已终止".to_string(),
        SceneId::TimerFired | SceneId::CronFired => "定时器提醒".to_string(),
        SceneId::RuntimeError => "运行异常".to_string(),
        SceneId::InterventionRequired => "需要你介入".to_string(),
        SceneId::SecurityBlocked => "安全拦截".to_string(),
        SceneId::CacheWasteAlert => "缓存浪费告警".to_string(),
    }
}

pub(super) fn render_body_zh(scene: SceneId, payload: &PayloadDigest) -> String {
    match scene {
        SceneId::ApprovalRequested => format!(
            "{}：{}",
            payload.detail.as_deref().unwrap_or_default(),
            payload.digest.as_deref().unwrap_or_default()
        ),
        SceneId::ApprovalExpired => {
            format!("审批（{}）等待超时，已自动拒绝", payload.biz_key)
        }
        SceneId::RunCompleted => match payload.subject.as_deref() {
            Some(subject) => format!("{}已完成", subject_label_zh(subject)),
            None => "任务已完成".to_string(),
        },
        SceneId::RunFailed => {
            let error = payload.digest.as_deref().unwrap_or_default();
            match (payload.subject.as_deref(), error.is_empty()) {
                (Some(subject), false) => {
                    format!("{}运行失败：{error}", subject_label_zh(subject))
                }
                (Some(subject), true) => format!("{}运行失败", subject_label_zh(subject)),
                (None, false) => error.to_string(),
                (None, true) => "任务运行失败".to_string(),
            }
        }
        SceneId::RunCancelled => match payload.subject.as_deref() {
            Some(subject) => format!("{}已被取消", subject_label_zh(subject)),
            None => "任务已被取消".to_string(),
        },
        SceneId::SubagentCompleted => {
            let mut body = "子代理已完成".to_string();
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!("——{summary}"));
            }
            body
        }
        SceneId::SubagentFailed => {
            let mut body = "子代理失败".to_string();
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!("——{summary}"));
            }
            body
        }
        SceneId::TaskStarted => payload.digest.clone().unwrap_or_default(),
        SceneId::TaskCompleted => {
            let head = match payload.subject.as_deref() {
                Some(subject) => format!("{}已完成", subject_label_zh(subject)),
                None => "任务已完成".to_string(),
            };
            match payload.detail.as_deref() {
                Some(detail) => format!("{head}，{detail}"),
                None => head,
            }
        }
        SceneId::TaskSuspicious => {
            let secs = payload.digest.as_deref().unwrap_or_default();
            match payload.subject.as_deref() {
                Some(subject) => {
                    format!("{}疑似卡死（{secs} 秒无输出）", subject_label_zh(subject))
                }
                None => format!("任务疑似卡死（{secs} 秒无输出）"),
            }
        }
        SceneId::TaskFailed => {
            let detail = payload.detail.as_deref().unwrap_or("exit code 未知");
            let mut body = match payload.subject.as_deref() {
                Some(subject) => format!("{}异常退出（{detail}）", subject_label_zh(subject)),
                None => format!("任务异常退出（{detail}）"),
            };
            if let Some(tail) = payload.digest.as_deref() {
                if !tail.is_empty() {
                    body.push_str(&format!("：{tail}"));
                }
            }
            body
        }
        SceneId::TaskKilled => match payload.subject.as_deref() {
            Some(subject) => format!("{}已被终止", subject_label_zh(subject)),
            None => "任务已被终止".to_string(),
        },
        SceneId::TimerFired => format!(
            "{}（定时器 {} 已到期）",
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
                    "{}（cron {} 第 {n} 次触发）",
                    payload.digest.as_deref().unwrap_or_default(),
                    payload.biz_key
                ),
                None => format!(
                    "{}（cron {} 已触发）",
                    payload.digest.as_deref().unwrap_or_default(),
                    payload.biz_key
                ),
            }
        }
        SceneId::RuntimeError => payload.digest.clone().unwrap_or_default(),
        SceneId::InterventionRequired => payload.digest.clone().unwrap_or_default(),
        SceneId::SecurityBlocked => format!(
            "拦截{}操作",
            operation_display_zh(payload.digest.as_deref().unwrap_or_default())
        ),
        SceneId::CacheWasteAlert => match payload.detail.as_deref() {
            Some(cost) => format!(
                "本次运行浪费约 {} token（约 ${cost}）",
                payload.digest.as_deref().unwrap_or_default()
            ),
            None => format!(
                "本次运行浪费约 {} token",
                payload.digest.as_deref().unwrap_or_default()
            ),
        },
    }
}

/// 审计操作 wire（Debug 串）→ 中文展示名（S11 正文；未知值保留原串）
fn operation_display_zh(wire: &str) -> String {
    match wire {
        "Delete" => "删除".to_string(),
        "TrashRestore" => "恢复".to_string(),
        "TrashPurge" => "彻底清除".to_string(),
        "GitRevert" => "Git 回退".to_string(),
        "CommandExec" => "命令执行".to_string(),
        "UndeclaredWrite" => "未声明写入".to_string(),
        other => other.to_string(),
    }
}

#[allow(dead_code)]
fn operation_display(wire: &str) -> String {
    operation_display_zh(wire)
}
