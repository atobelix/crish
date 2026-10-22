//! 夜间折叠摘要文案（双语 + 设备语言感知；自 push/copy.rs 原样搬迁）

use super::{is_english, CopyText};
use crate::push::quiet::{NightSummary, NightSummaryGroup};
use crate::push::scenes::SceneId;
use crate::push::vendor::VendorDevice;

/// 针对夜间折叠摘要渲染标题与正文（兼容默认）
pub fn render_night_summary_copy(summary: &NightSummary) -> CopyText {
    render_night_summary_with_locale(summary, None)
}

/// 针对夜间折叠摘要渲染多语言标题与正文
pub fn render_night_summary_with_locale(summary: &NightSummary, locale: Option<&str>) -> CopyText {
    let is_en = is_english(locale);
    let title = if is_en {
        "Nighttime Summary".to_string()
    } else {
        "夜间通知摘要".to_string()
    };

    let body = if is_en {
        let total = summary.total;
        let clauses: Vec<String> = summary.groups.iter().map(night_group_clause_en).collect();
        let mut text = if total == 1 {
            "1 item completed during quiet hours".to_string()
        } else {
            format!("{total} items completed during quiet hours")
        };
        if !clauses.is_empty() {
            text.push_str(": ");
            text.push_str(&clauses.join(", "));
        }
        text
    } else if !summary.body.is_empty() {
        summary.body.clone()
    } else {
        let total = summary.total;
        let clauses: Vec<String> = summary.groups.iter().map(night_group_clause_zh).collect();
        let mut text = format!("夜间完成 {total} 项");
        if !clauses.is_empty() {
            text.push('：');
            text.push_str(&clauses.join("、"));
        }
        text
    };

    CopyText { title, body }
}

/// 为特定目标设备渲染夜间折叠摘要
pub fn render_night_summary_for_device(summary: &NightSummary, device: &VendorDevice) -> CopyText {
    render_night_summary_with_locale(summary, device.preferred_language.as_deref())
}

fn night_group_clause_en(group: &NightSummaryGroup) -> String {
    let n = group.count;
    match group.scene {
        SceneId::RunCompleted => {
            if n == 1 {
                format!("Run {} completed", group.first_biz_key)
            } else {
                format!("{n} runs completed")
            }
        }
        SceneId::RunCancelled => {
            if n == 1 {
                format!("Run {} cancelled", group.first_biz_key)
            } else {
                format!("{n} runs cancelled")
            }
        }
        SceneId::SubagentCompleted => {
            if n == 1 {
                format!("Subagent {} completed", group.first_biz_key)
            } else {
                format!("{n} subagents completed")
            }
        }
        SceneId::TaskCompleted => {
            if n == 1 {
                format!("Task {} completed", group.first_biz_key)
            } else {
                format!("{n} tasks completed")
            }
        }
        SceneId::TaskKilled => {
            if n == 1 {
                format!("Task {} terminated", group.first_biz_key)
            } else {
                format!("{n} tasks terminated")
            }
        }
        SceneId::TaskFailed => {
            if n == 1 {
                format!("Task {} failed", group.first_biz_key)
            } else {
                format!("{n} tasks failed")
            }
        }
        SceneId::TaskSuspicious => {
            if n == 1 {
                format!("Task {} suspected stalled", group.first_biz_key)
            } else {
                format!("{n} tasks suspected stalled")
            }
        }
        SceneId::TimerFired => {
            if n == 1 {
                format!("Timer {} expired", group.first_biz_key)
            } else {
                format!("{n} timers expired")
            }
        }
        SceneId::CronFired => {
            if n == 1 {
                format!("{} triggered 1 time", group.first_biz_key)
            } else {
                format!("{} triggered {n} times", group.first_biz_key)
            }
        }
        _ => format!("{} ×{n}", group.scene.as_str()),
    }
}

fn night_group_clause_zh(group: &NightSummaryGroup) -> String {
    let n = group.count;
    match group.scene {
        SceneId::RunCompleted => {
            if n == 1 {
                format!("任务 {} 已完成", group.first_biz_key)
            } else {
                format!("任务完成 ×{n}")
            }
        }
        SceneId::RunCancelled => {
            if n == 1 {
                format!("任务 {} 已取消", group.first_biz_key)
            } else {
                format!("任务取消 ×{n}")
            }
        }
        SceneId::SubagentCompleted => {
            if n == 1 {
                format!("子代理 {} 完成", group.first_biz_key)
            } else {
                format!("子代理完成 ×{n}")
            }
        }
        SceneId::TaskCompleted => {
            if n == 1 {
                format!("任务 {} 已完成", group.first_biz_key)
            } else {
                format!("任务完成 ×{n}")
            }
        }
        SceneId::TaskKilled => {
            if n == 1 {
                format!("任务 {} 已被终止", group.first_biz_key)
            } else {
                format!("任务终止 ×{n}")
            }
        }
        SceneId::TaskFailed => {
            if n == 1 {
                format!("任务 {} 失败", group.first_biz_key)
            } else {
                format!("任务失败 ×{n}")
            }
        }
        SceneId::TaskSuspicious => {
            if n == 1 {
                format!("任务 {} 疑似卡死", group.first_biz_key)
            } else {
                format!("任务疑似卡死 ×{n}")
            }
        }
        SceneId::TimerFired => {
            if n == 1 {
                format!("定时器 {} 已到期", group.first_biz_key)
            } else {
                format!("定时器到期 ×{n}")
            }
        }
        SceneId::CronFired => format!("{} 触发 {n} 次", group.first_biz_key),
        _ => format!("{} ×{n}", group.scene.as_str()),
    }
}
