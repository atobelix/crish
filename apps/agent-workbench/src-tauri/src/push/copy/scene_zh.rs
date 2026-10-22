//! 中文场景文案：标题 / 正文 / 审计操作中文展示名（自 push/copy.rs 原样搬迁）

use crate::push::intent::PayloadDigest;
use crate::push::scenes::SceneId;

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
        SceneId::RunCompleted => format!("任务 {} 已完成", payload.biz_key),
        SceneId::RunFailed => format!(
            "{}：{}",
            payload.biz_key,
            payload.digest.as_deref().unwrap_or_default()
        ),
        SceneId::RunCancelled => format!("任务 {} 已被取消", payload.biz_key),
        SceneId::SubagentCompleted => {
            let mut body = format!("子代理（{}）已完成：成功", payload.biz_key);
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!("——{summary}"));
            }
            body
        }
        SceneId::SubagentFailed => {
            let mut body = format!("子代理（{}）失败", payload.biz_key);
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!("——{summary}"));
            }
            body
        }
        SceneId::TaskStarted => payload.digest.clone().unwrap_or_default(),
        SceneId::TaskCompleted => match payload.detail.as_deref() {
            Some(detail) => format!("任务 {} 已完成，{detail}", payload.biz_key),
            None => format!("任务 {} 已完成", payload.biz_key),
        },
        SceneId::TaskSuspicious => format!(
            "任务 {} 疑似卡死（{} 秒无输出）",
            payload.biz_key,
            payload.digest.as_deref().unwrap_or_default()
        ),
        SceneId::TaskFailed => format!(
            "任务 {} 异常退出（{}）",
            payload.biz_key,
            payload.detail.as_deref().unwrap_or("exit code 未知")
        ),
        SceneId::TaskKilled => format!("任务 {} 已被终止", payload.biz_key),
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
