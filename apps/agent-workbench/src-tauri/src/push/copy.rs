//! 推送文案渲染（R3-01 部分 3：D7 §6.5 push/copy.rs）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md` §6.5（文案生成：新增
//!   push/copy.rs，复用 wakeup_summary 风格与「无占位符残留」测试护栏）、
//!   §3.3 场景明细（S1-S12 文案规则）、§3.3.13（场景载荷样例 = §10.2 文案
//!   单测的 golden fixture）；
//! - `docs/multi-device/plans/M8-push-release.md`（render_copy(intent) →
//!   {title, body}）。
//!
//! 输入契约：[crate::push::intent::PayloadDigest]（`digest` = 正文主体文本、
//! `detail` = 次级文本）；输出 [CopyText] {title, body}，经
//! [crate::push::schema::PushMessage::with_copy] 填入 [PushMessage]
//! （[message_with_copy] 为组装入口——[crate::push::pusher::PushDispatcher]
//! 分发时调用，WS 直推与离线 pending 一并携带完整文案；厂商通道消费
//! [crate::push::vendor::consumer::notification_from_pending] 的
//! title/body→digest 桥接即还原完整通知）。
//!
//! 场景 → 文案映射（对齐 D7 §3.3 明细 + §3.3.13 样例；样例缺失的场景按
//! 明细模板渲染。载荷缺口如实注记：时长/退出码/角色/拦截目标等不在
//! [PayloadDigest] 的面——装配轮如需补齐，扩展 PayloadDigest 或文案入参即可，
//! 本层按现有契约渲染）：
//!
//! | 场景 | 标题 | 正文 |
//! | --- | --- | --- |
//! | S1 审批请求 | Crish 需要你的批准 | `{toolName}：{summary}` |
//! | S2 审批过期 | 审批已过期 | `审批（{toolCallId}）等待超时，已自动拒绝` |
//! | S3 run 完成 | 任务已完成 | `任务 {runId} 已完成` |
//! | S4 run 失败 | 任务运行失败 | `{runId}：{error}` |
//! | S5 run 取消 | 任务已取消 | `任务 {runId} 已被取消` |
//! | S6 子代理完成 | 子代理已完成 | `子代理（{id}）已完成：成功[——{summary}]` |
//! | S7 子代理失败 | 子代理失败 | `子代理（{id}）失败[——{summary}]` |
//! | S8a 任务启动 | 后台任务已启动 | `{command}` |
//! | S8b 任务完成 | 任务已完成 | `任务 {taskId} 已完成[，{exit code N}]` |
//! | S8c 任务卡死 | 任务疑似卡死 | `任务 {taskId} 疑似卡死（{N} 秒无输出）` |
//! | S8d 任务失败 | 后台任务异常退出 | `任务 {taskId} 异常退出（exit code N）` |
//! | S8e 任务终止 | 任务已终止 | `任务 {taskId} 已被终止` |
//! | S9a 定时器 | 定时器提醒 | `{prompt}（定时器 {id} 已到期）` |
//! | S9b cron | 定时器提醒 | `{prompt}（cron {id} 第 {n} 次触发）` |
//! | S10a 运行异常 | 运行异常 | `{error}` |
//! | S10b 需介入 | 需要你介入 | `{reason}` |
//! | S11 安全拦截 | 安全拦截 | `拦截{操作}操作` |
//! | S12 缓存告警 | 缓存浪费告警 | `本次运行浪费约 {N} token[（约 ${cost}）]` |

use super::engine::PushDecision;
use super::intent::PayloadDigest;
use super::quiet::{NightSummary, NightSummaryGroup};
use super::scenes::SceneId;
use super::schema::{message_from_decision, PushMessage};
use super::vendor::VendorDevice;

/// 渲染产物（title/body；[crate::push::schema::PushMessage::with_copy] 入参）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyText {
    /// 通知标题（移动端横幅主文本）
    pub title: String,
    /// 通知正文
    pub body: String,
}

/// 判断指定 locale 是否为英文（"en", "en-US", "en_GB" 等）
pub fn is_english(locale: Option<&str>) -> bool {
    locale
        .map(|l| l.trim().to_ascii_lowercase().starts_with("en"))
        .unwrap_or(false)
}

/// 场景 → 标题/正文渲染（兼容现有签名，默认中文兜底）
pub fn render_copy(scene: SceneId, payload: &PayloadDigest) -> CopyText {
    render_copy_with_locale(scene, payload, None)
}

/// 场景 → 标题/正文多语言渲染（纯函数无 I/O，支持 en / zh）
pub fn render_copy_with_locale(
    scene: SceneId,
    payload: &PayloadDigest,
    locale: Option<&str>,
) -> CopyText {
    let is_en = is_english(locale);
    let title = if is_en {
        render_title_en(scene)
    } else {
        render_title_zh(scene)
    };
    let body = if is_en {
        render_body_en(scene, payload)
    } else {
        render_body_zh(scene, payload)
    };
    CopyText { title, body }
}

/// 为指定目标设备渲染文案（从设备的 preferred_language 获取 locale）
pub fn render_copy_for_device(
    scene: SceneId,
    payload: &PayloadDigest,
    device: &VendorDevice,
) -> CopyText {
    render_copy_with_locale(scene, payload, device.preferred_language.as_deref())
}

fn render_title_en(scene: SceneId) -> String {
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

fn render_title_zh(scene: SceneId) -> String {
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

fn render_body_en(scene: SceneId, payload: &PayloadDigest) -> String {
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
        SceneId::RunCompleted => format!("Run {} completed successfully", payload.biz_key),
        SceneId::RunFailed => format!(
            "{}: {}",
            payload.biz_key,
            payload.digest.as_deref().unwrap_or_default()
        ),
        SceneId::RunCancelled => format!("Run {} has been cancelled", payload.biz_key),
        SceneId::SubagentCompleted => {
            let mut body = format!("Subagent ({}) completed successfully", payload.biz_key);
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!(" - {summary}"));
            }
            body
        }
        SceneId::SubagentFailed => {
            let mut body = format!("Subagent ({}) failed", payload.biz_key);
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!(" - {summary}"));
            }
            body
        }
        SceneId::TaskStarted => payload.digest.clone().unwrap_or_default(),
        SceneId::TaskCompleted => match payload.detail.as_deref() {
            Some(detail) => format!("Task {} completed, {detail}", payload.biz_key),
            None => format!("Task {} completed", payload.biz_key),
        },
        SceneId::TaskSuspicious => format!(
            "Task {} suspected stalled (no output for {}s)",
            payload.biz_key,
            payload.digest.as_deref().unwrap_or_default()
        ),
        SceneId::TaskFailed => format!(
            "Task {} exited abnormally ({})",
            payload.biz_key,
            payload.detail.as_deref().unwrap_or("unknown exit code")
        ),
        SceneId::TaskKilled => format!("Task {} has been terminated", payload.biz_key),
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

fn render_body_zh(scene: SceneId, payload: &PayloadDigest) -> String {
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

/// 组装入口：决策 → 带完整文案的 [PushMessage]（默认中文）
pub fn message_with_copy(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
) -> PushMessage {
    message_with_copy_locale(decision, id, seq, now_ms, None)
}

/// 组装入口：决策 → 带多语言文案的 [PushMessage]
pub fn message_with_copy_locale(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
    locale: Option<&str>,
) -> PushMessage {
    let copy = render_copy_with_locale(decision.scene, &decision.payload, locale);
    message_from_decision(decision, id, seq, now_ms).with_copy(copy.title, copy.body)
}

/// 组装入口：决策 → 带目标设备语言文案的 [PushMessage]
pub fn message_with_copy_for_device(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
    device: &VendorDevice,
) -> PushMessage {
    message_with_copy_locale(
        decision,
        id,
        seq,
        now_ms,
        device.preferred_language.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::engine::{DecisionOutcome, PushDecision};

    const T0: u64 = 1_784_078_400_000;

    /// 场景 + 载荷 → 期望文案（D7 §3.3 明细 / §3.3.13 样例逐条对齐）
    fn payload(biz_key: &str, digest: Option<&str>, detail: Option<&str>) -> PayloadDigest {
        PayloadDigest {
            session_id: "s-7".to_string(),
            biz_key: biz_key.to_string(),
            digest: digest.map(str::to_string),
            detail: detail.map(str::to_string),
        }
    }

    fn assert_copy(
        scene: SceneId,
        digest: Option<&str>,
        detail: Option<&str>,
        title: &str,
        body: &str,
    ) {
        let copy = render_copy(scene, &payload("run-42", digest, detail));
        assert_eq!(copy.title, title, "场景 {scene:?} 标题");
        assert_eq!(copy.body, body, "场景 {scene:?} 正文");
    }

    /// S1 审批请求：样例「Crish 需要你的批准」+「bash：执行部署脚本…」
    #[test]
    fn s1_approval_requested_copy() {
        assert_copy(
            SceneId::ApprovalRequested,
            Some("执行部署脚本"),
            Some("bash"),
            "Crish 需要你的批准",
            "bash：执行部署脚本",
        );
    }

    /// S2 审批过期：样例「审批已过期」+「bash 调用（tc-9f3a）等待超时…」——
    /// toolName 不在载荷，按 toolCallId 降级
    #[test]
    fn s2_approval_expired_copy() {
        let copy = render_copy(SceneId::ApprovalExpired, &payload("tc-9f3a", None, None));
        assert_eq!(copy.title, "审批已过期");
        assert_eq!(copy.body, "审批（tc-9f3a）等待超时，已自动拒绝");
    }

    /// S3/S4/S5 run 终态：样例对齐（S4 正文 = `{runId}：{error}`）
    #[test]
    fn s3_s4_s5_run_terminal_copy() {
        assert_copy(
            SceneId::RunCompleted,
            None,
            None,
            "任务已完成",
            "任务 run-42 已完成",
        );
        assert_copy(
            SceneId::RunFailed,
            Some("provider 返回 401，API 密钥可能已失效"),
            None,
            "任务运行失败",
            "run-42：provider 返回 401，API 密钥可能已失效",
        );
        assert_copy(
            SceneId::RunCancelled,
            None,
            None,
            "任务已取消",
            "任务 run-42 已被取消",
        );
    }

    /// S6/S7 子代理终态：样例对齐（role 不在载荷降级省略；summary 存在追加）
    #[test]
    fn s6_s7_subagent_copy() {
        let copy = render_copy(
            SceneId::SubagentCompleted,
            &payload("sa-3", Some("已产出缺口分析 5 页"), None),
        );
        assert_eq!(copy.title, "子代理已完成");
        assert_eq!(copy.body, "子代理（sa-3）已完成：成功——已产出缺口分析 5 页");

        let copy = render_copy(
            SceneId::SubagentFailed,
            &payload("sa-4", Some("工具执行超时"), None),
        );
        assert_eq!(copy.title, "子代理失败");
        assert_eq!(copy.body, "子代理（sa-4）失败——工具执行超时");

        // summary 缺失：不残留空拼接
        let copy = render_copy(SceneId::SubagentCompleted, &payload("sa-5", None, None));
        assert_eq!(copy.body, "子代理（sa-5）已完成：成功");
    }

    /// S8 任务域：S8c 样例逐字对齐（「任务 t-12 疑似卡死（120 秒无输出）」）
    #[test]
    fn s8_task_domain_copy() {
        assert_copy(
            SceneId::TaskStarted,
            Some("npm run build"),
            None,
            "后台任务已启动",
            "npm run build",
        );
        assert_copy(
            SceneId::TaskCompleted,
            None,
            Some("exit code 0"),
            "任务已完成",
            "任务 run-42 已完成，exit code 0",
        );
        let copy = render_copy(SceneId::TaskSuspicious, &payload("t-12", Some("120"), None));
        assert_eq!(copy.title, "任务疑似卡死");
        assert_eq!(
            copy.body, "任务 t-12 疑似卡死（120 秒无输出）",
            "D7 §3.3.13 S8c 样例逐字对齐"
        );
        assert_copy(
            SceneId::TaskFailed,
            Some("构建报错"),
            Some("exit code 1"),
            "后台任务异常退出",
            "任务 run-42 异常退出（exit code 1）",
        );
        assert_copy(
            SceneId::TaskKilled,
            None,
            None,
            "任务已终止",
            "任务 run-42 已被终止",
        );
    }

    /// S9 定时器/cron：样例对齐（S9a 逐字；S9b 第 n 次触发取自 iteration）
    #[test]
    fn s9_timer_cron_copy() {
        let copy = render_copy(
            SceneId::TimerFired,
            &payload("timer-1", Some("请检查任务进度"), None),
        );
        assert_eq!(copy.title, "定时器提醒");
        assert_eq!(
            copy.body, "请检查任务进度（定时器 timer-1 已到期）",
            "D7 §3.3.13 S9a 样例逐字对齐"
        );

        let copy = render_copy(
            SceneId::CronFired,
            &payload("cron-2", Some("日报"), Some("iteration 3")),
        );
        assert_eq!(copy.body, "日报（cron cron-2 第 3 次触发）");

        // iteration 缺失：不残留占位
        let copy = render_copy(SceneId::CronFired, &payload("cron-2", Some("日报"), None));
        assert_eq!(copy.body, "日报（cron cron-2 已触发）");
    }

    /// S10 异常域：标题承载场景语义，正文 = error/reason
    #[test]
    fn s10_runtime_copy() {
        assert_copy(
            SceneId::RuntimeError,
            Some("provider 5xx"),
            None,
            "运行异常",
            "provider 5xx",
        );
        assert_copy(
            SceneId::InterventionRequired,
            Some("缺少 API 密钥"),
            None,
            "需要你介入",
            "缺少 API 密钥",
        );
    }

    /// S11 安全拦截：样例「拦截删除操作」——操作 wire → 中文映射
    #[test]
    fn s11_security_copy_operation_map() {
        let copy = render_copy(
            SceneId::SecurityBlocked,
            &payload("tc-9f4b", Some("Delete"), None),
        );
        assert_eq!(copy.title, "安全拦截");
        assert_eq!(copy.body, "拦截删除操作", "D7 §3.3.13 S11 样例对齐");
        for (wire, expected) in [
            ("TrashRestore", "恢复"),
            ("TrashPurge", "彻底清除"),
            ("GitRevert", "Git 回退"),
            ("CommandExec", "命令执行"),
            ("UndeclaredWrite", "未声明写入"),
        ] {
            let copy = render_copy(SceneId::SecurityBlocked, &payload("tc-1", Some(wire), None));
            assert_eq!(copy.body, format!("拦截{expected}操作"), "操作 {wire}");
        }
        // 未知操作：保留原串（枚举冻结护栏）
        let copy = render_copy(
            SceneId::SecurityBlocked,
            &payload("tc-1", Some("FutureOp"), None),
        );
        assert_eq!(copy.body, "拦截FutureOp操作");
    }

    /// S12 缓存告警：样例「本次运行浪费约 24,000 token（约 $0.12）」——
    /// 千分位为示意，按载荷原值渲染；cost 缺失降级
    #[test]
    fn s12_cache_waste_copy() {
        let copy = render_copy(
            SceneId::CacheWasteAlert,
            &payload("run-42", Some("24000"), Some("0.12")),
        );
        assert_eq!(copy.title, "缓存浪费告警");
        assert_eq!(copy.body, "本次运行浪费约 24000 token（约 $0.12）");
        let copy = render_copy(
            SceneId::CacheWasteAlert,
            &payload("run-42", Some("24000"), None),
        );
        assert_eq!(copy.body, "本次运行浪费约 24000 token");
    }

    /// 18 场景全量扫掠：标题非空 + 无占位符残留（`<...>` 模板泄漏护栏，
    /// 对齐 wakeup_summary.rs 的断言模式）
    #[test]
    fn all_scenes_render_without_placeholder_leak() {
        let cases: Vec<(SceneId, Option<&str>, Option<&str>)> = vec![
            (
                SceneId::ApprovalRequested,
                Some("执行部署脚本"),
                Some("bash"),
            ),
            (SceneId::ApprovalExpired, None, None),
            (SceneId::RunCompleted, None, None),
            (SceneId::RunFailed, Some("provider 401"), None),
            (SceneId::RunCancelled, None, None),
            (
                SceneId::SubagentCompleted,
                Some("已产出缺口分析 5 页"),
                None,
            ),
            (SceneId::SubagentFailed, Some("工具执行超时"), None),
            (SceneId::TaskStarted, Some("npm run build"), None),
            (SceneId::TaskCompleted, None, Some("exit code 0")),
            (SceneId::TaskSuspicious, Some("120"), None),
            (SceneId::TaskFailed, Some("构建报错"), Some("exit code 1")),
            (SceneId::TaskKilled, None, None),
            (SceneId::TimerFired, Some("请检查任务进度"), None),
            (SceneId::CronFired, Some("日报"), Some("iteration 3")),
            (SceneId::RuntimeError, Some("provider 5xx"), None),
            (SceneId::InterventionRequired, Some("缺少 API 密钥"), None),
            (SceneId::SecurityBlocked, Some("Delete"), None),
            (SceneId::CacheWasteAlert, Some("24000"), Some("0.12")),
        ];
        assert_eq!(cases.len(), 18, "M8 §3.2.3 18 行登记");
        for (scene, digest, detail) in cases {
            let copy = render_copy(scene, &payload("run-42", digest, detail));
            assert!(!copy.title.is_empty(), "场景 {scene:?} 标题非空");
            assert!(
                !copy.title.contains('<') && !copy.body.contains('<'),
                "场景 {scene:?} 无占位符残留：title={} body={}",
                copy.title,
                copy.body
            );
        }
    }

    /// message_with_copy 组装：title/body 填充 + 其余 schema 字段保持
    /// （with_copy 接线入口验证）
    #[test]
    fn message_with_copy_fills_title_body_keeps_fields() {
        let decision = PushDecision {
            deliver: true,
            scene: SceneId::RunFailed,
            level: SceneId::RunFailed.level(),
            severity: SceneId::RunFailed.level().severity(),
            dedupe_key: "run-terminal:run-42:failed".to_string(),
            payload: payload("run-42", Some("provider 401"), None),
            outcome: DecisionOutcome::Delivered,
        };
        let message = message_with_copy(&decision, "push-000001".to_string(), 1, T0);
        assert_eq!(message.title.as_deref(), Some("任务运行失败"));
        assert_eq!(message.body.as_deref(), Some("run-42：provider 401"));
        assert_eq!(message.event_type, "run-terminal", "其余字段不变");
        assert_eq!(message.dedupe_key, "run-terminal:run-42:failed");
        assert_eq!(message.target.params["runId"], "run-42");
        // serde wire：title/body 出现（不再缺省跳过）
        let json = serde_json::to_value(&message).expect("可序列化");
        assert_eq!(json["title"], "任务运行失败");
        assert_eq!(json["body"], "run-42：provider 401");
    }

    fn assert_copy_en(
        scene: SceneId,
        digest: Option<&str>,
        detail: Option<&str>,
        title: &str,
        body: &str,
    ) {
        let copy =
            render_copy_with_locale(scene, &payload("run-42", digest, detail), Some("en-US"));
        assert_eq!(copy.title, title, "场景 {scene:?} 英文标题");
        assert_eq!(copy.body, body, "场景 {scene:?} 英文正文");
    }

    /// S1 审批请求（英文）：Crish Needs Your Approval + detail: digest
    #[test]
    fn s1_approval_requested_copy_en() {
        assert_copy_en(
            SceneId::ApprovalRequested,
            Some("Deploy to production"),
            Some("bash"),
            "Crish Needs Your Approval",
            "bash: Deploy to production",
        );
    }

    /// S2 审批过期（英文）
    #[test]
    fn s2_approval_expired_copy_en() {
        let copy = render_copy_with_locale(
            SceneId::ApprovalExpired,
            &payload("tc-9f3a", None, None),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Approval Request Expired");
        assert_eq!(
            copy.body,
            "Approval request (tc-9f3a) timed out and was automatically rejected"
        );
    }

    /// S3/S4/S5 run 终态（英文）
    #[test]
    fn s3_s4_s5_run_terminal_copy_en() {
        assert_copy_en(
            SceneId::RunCompleted,
            None,
            None,
            "Run Completed",
            "Run run-42 completed successfully",
        );
        assert_copy_en(
            SceneId::RunFailed,
            Some("provider returned 401, API key expired"),
            None,
            "Run Failed",
            "run-42: provider returned 401, API key expired",
        );
        assert_copy_en(
            SceneId::RunCancelled,
            None,
            None,
            "Run Cancelled",
            "Run run-42 has been cancelled",
        );
    }

    /// S6/S7 子代理终态（英文）
    #[test]
    fn s6_s7_subagent_copy_en() {
        let copy = render_copy_with_locale(
            SceneId::SubagentCompleted,
            &payload("sa-3", Some("5 pages gap analysis produced"), None),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Subagent Completed");
        assert_eq!(
            copy.body,
            "Subagent (sa-3) completed successfully - 5 pages gap analysis produced"
        );

        let copy = render_copy_with_locale(
            SceneId::SubagentFailed,
            &payload("sa-4", Some("Tool execution timed out"), None),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Subagent Failed");
        assert_eq!(
            copy.body,
            "Subagent (sa-4) failed - Tool execution timed out"
        );

        // summary 缺失
        let copy = render_copy_with_locale(
            SceneId::SubagentCompleted,
            &payload("sa-5", None, None),
            Some("en-US"),
        );
        assert_eq!(copy.body, "Subagent (sa-5) completed successfully");
    }

    /// S8 任务域（英文）
    #[test]
    fn s8_task_domain_copy_en() {
        assert_copy_en(
            SceneId::TaskStarted,
            Some("npm run build"),
            None,
            "Background Task Started",
            "npm run build",
        );
        assert_copy_en(
            SceneId::TaskCompleted,
            None,
            Some("exit code 0"),
            "Task Completed",
            "Task run-42 completed, exit code 0",
        );
        let copy = render_copy_with_locale(
            SceneId::TaskSuspicious,
            &payload("t-12", Some("120"), None),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Task Suspected Stalled");
        assert_eq!(
            copy.body,
            "Task t-12 suspected stalled (no output for 120s)"
        );

        assert_copy_en(
            SceneId::TaskFailed,
            Some("build error"),
            Some("exit code 1"),
            "Background Task Failed",
            "Task run-42 exited abnormally (exit code 1)",
        );
        assert_copy_en(
            SceneId::TaskKilled,
            None,
            None,
            "Task Terminated",
            "Task run-42 has been terminated",
        );
    }

    /// S9 定时器/cron（英文）
    #[test]
    fn s9_timer_cron_copy_en() {
        let copy = render_copy_with_locale(
            SceneId::TimerFired,
            &payload("timer-1", Some("Please review PR"), None),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Timer Reminder");
        assert_eq!(copy.body, "Please review PR (Timer timer-1 expired)");

        let copy = render_copy_with_locale(
            SceneId::CronFired,
            &payload("cron-2", Some("Daily digest"), Some("iteration 3")),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Scheduled Reminder");
        assert_eq!(
            copy.body,
            "Daily digest (Cron cron-2 triggered iteration 3)"
        );

        // iteration 缺失
        let copy = render_copy_with_locale(
            SceneId::CronFired,
            &payload("cron-2", Some("Daily digest"), None),
            Some("en-US"),
        );
        assert_eq!(copy.body, "Daily digest (Cron cron-2 triggered)");
    }

    /// S10 异常域（英文）
    #[test]
    fn s10_runtime_copy_en() {
        assert_copy_en(
            SceneId::RuntimeError,
            Some("provider 5xx error"),
            None,
            "Runtime Error",
            "provider 5xx error",
        );
        assert_copy_en(
            SceneId::InterventionRequired,
            Some("Missing API key"),
            None,
            "Intervention Required",
            "Missing API key",
        );
    }

    /// S11 安全拦截（英文）：操作 wire → 英文映射
    #[test]
    fn s11_security_copy_operation_map_en() {
        let copy = render_copy_with_locale(
            SceneId::SecurityBlocked,
            &payload("tc-9f4b", Some("Delete"), None),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Security Interception");
        assert_eq!(copy.body, "Blocked delete operation");
        for (wire, expected) in [
            ("TrashRestore", "trash restore"),
            ("TrashPurge", "trash purge"),
            ("GitRevert", "git revert"),
            ("CommandExec", "command execution"),
            ("UndeclaredWrite", "undeclared write"),
        ] {
            let copy = render_copy_with_locale(
                SceneId::SecurityBlocked,
                &payload("tc-1", Some(wire), None),
                Some("en-US"),
            );
            assert_eq!(
                copy.body,
                format!("Blocked {expected} operation"),
                "操作 {wire}"
            );
        }
        // 未知操作：保留原串
        let copy = render_copy_with_locale(
            SceneId::SecurityBlocked,
            &payload("tc-1", Some("FutureOp"), None),
            Some("en-US"),
        );
        assert_eq!(copy.body, "Blocked FutureOp operation");
    }

    /// S12 缓存告警（英文）
    #[test]
    fn s12_cache_waste_copy_en() {
        let copy = render_copy_with_locale(
            SceneId::CacheWasteAlert,
            &payload("run-42", Some("24000"), Some("0.12")),
            Some("en-US"),
        );
        assert_eq!(copy.title, "Cache Waste Alert");
        assert_eq!(
            copy.body,
            "Wasted approximately 24000 tokens in this run (approx. $0.12)"
        );
        let copy = render_copy_with_locale(
            SceneId::CacheWasteAlert,
            &payload("run-42", Some("24000"), None),
            Some("en-US"),
        );
        assert_eq!(copy.body, "Wasted approximately 24000 tokens in this run");
    }

    /// 18 场景全量扫掠（英文）：标题非空 + 无占位符残留
    #[test]
    fn all_scenes_render_english_without_placeholder_leak() {
        let cases: Vec<(SceneId, Option<&str>, Option<&str>)> = vec![
            (
                SceneId::ApprovalRequested,
                Some("Deploy to production"),
                Some("bash"),
            ),
            (SceneId::ApprovalExpired, None, None),
            (SceneId::RunCompleted, None, None),
            (SceneId::RunFailed, Some("provider 401"), None),
            (SceneId::RunCancelled, None, None),
            (
                SceneId::SubagentCompleted,
                Some("5 pages gap analysis produced"),
                None,
            ),
            (SceneId::SubagentFailed, Some("Tool timeout"), None),
            (SceneId::TaskStarted, Some("npm run build"), None),
            (SceneId::TaskCompleted, None, Some("exit code 0")),
            (SceneId::TaskSuspicious, Some("120"), None),
            (
                SceneId::TaskFailed,
                Some("build error"),
                Some("exit code 1"),
            ),
            (SceneId::TaskKilled, None, None),
            (SceneId::TimerFired, Some("Review PR"), None),
            (
                SceneId::CronFired,
                Some("Daily digest"),
                Some("iteration 3"),
            ),
            (SceneId::RuntimeError, Some("provider 5xx"), None),
            (SceneId::InterventionRequired, Some("Missing API key"), None),
            (SceneId::SecurityBlocked, Some("Delete"), None),
            (SceneId::CacheWasteAlert, Some("24000"), Some("0.12")),
        ];
        assert_eq!(cases.len(), 18, "18 个场景登记");
        for (scene, digest, detail) in cases {
            let copy =
                render_copy_with_locale(scene, &payload("run-42", digest, detail), Some("en-US"));
            assert!(!copy.title.is_empty(), "场景 {scene:?} 英文标题非空");
            assert!(
                !copy.title.contains('<') && !copy.body.contains('<'),
                "场景 {scene:?} 英文无占位符残留：title={} body={}",
                copy.title,
                copy.body
            );
        }
    }

    /// VendorDevice 设备语言感知测试
    #[test]
    fn render_copy_for_device_respects_device_preferred_language() {
        use crate::push::vendor::VendorPlatform;

        let en_device =
            VendorDevice::new("dev-en", "tok-1", VendorPlatform::Ios).with_language("en-US");
        let zh_device =
            VendorDevice::new("dev-zh", "tok-2", VendorPlatform::Android).with_language("zh-CN");
        let def_device = VendorDevice::new("dev-def", "tok-3", VendorPlatform::Ios);

        let p = payload("run-42", None, None);

        let copy_en = render_copy_for_device(SceneId::RunCompleted, &p, &en_device);
        assert_eq!(copy_en.title, "Run Completed");
        assert_eq!(copy_en.body, "Run run-42 completed successfully");

        let copy_zh = render_copy_for_device(SceneId::RunCompleted, &p, &zh_device);
        assert_eq!(copy_zh.title, "任务已完成");
        assert_eq!(copy_zh.body, "任务 run-42 已完成");

        let copy_def = render_copy_for_device(SceneId::RunCompleted, &p, &def_device);
        assert_eq!(copy_def.title, "任务已完成");
        assert_eq!(copy_def.body, "任务 run-42 已完成");
    }

    /// 夜间折叠摘要渲染（双语及设备感知）
    #[test]
    fn night_summary_copy_rendering_both_locales() {
        use crate::push::vendor::VendorPlatform;

        let groups = vec![
            NightSummaryGroup {
                scene: SceneId::RunCompleted,
                count: 2,
                first_at_ms: T0,
                last_at_ms: T0 + 1000,
                first_biz_key: "r-1".to_string(),
            },
            NightSummaryGroup {
                scene: SceneId::SubagentCompleted,
                count: 1,
                first_at_ms: T0 + 2000,
                last_at_ms: T0 + 2000,
                first_biz_key: "sa-1".to_string(),
            },
        ];

        let summary = NightSummary {
            date: "2026-10-14".to_string(),
            total: 3,
            first_at_ms: T0,
            last_at_ms: T0 + 2000,
            groups,
            body: "夜间完成 3 项：任务完成 ×2、子代理 sa-1 完成".to_string(),
        };

        // 中文默认
        let copy_zh = render_night_summary_copy(&summary);
        assert_eq!(copy_zh.title, "夜间通知摘要");
        assert_eq!(copy_zh.body, "夜间完成 3 项：任务完成 ×2、子代理 sa-1 完成");

        // 英文
        let copy_en = render_night_summary_with_locale(&summary, Some("en-US"));
        assert_eq!(copy_en.title, "Nighttime Summary");
        assert_eq!(
            copy_en.body,
            "3 items completed during quiet hours: 2 runs completed, Subagent sa-1 completed"
        );

        // 单项英文单数语法
        let single_group = vec![NightSummaryGroup {
            scene: SceneId::RunCompleted,
            count: 1,
            first_at_ms: T0,
            last_at_ms: T0,
            first_biz_key: "r-9".to_string(),
        }];
        let single_summary = NightSummary {
            date: "2026-10-14".to_string(),
            total: 1,
            first_at_ms: T0,
            last_at_ms: T0,
            groups: single_group,
            body: "夜间完成 1 项：任务 r-9 已完成".to_string(),
        };
        let single_en = render_night_summary_with_locale(&single_summary, Some("en"));
        assert_eq!(
            single_en.body,
            "1 item completed during quiet hours: Run r-9 completed"
        );

        // 设备渲染
        let en_device =
            VendorDevice::new("dev-en", "tok-1", VendorPlatform::Ios).with_language("en-GB");
        let copy_dev = render_night_summary_for_device(&single_summary, &en_device);
        assert_eq!(copy_dev.title, "Nighttime Summary");
        assert_eq!(
            copy_dev.body,
            "1 item completed during quiet hours: Run r-9 completed"
        );
    }

    /// message_with_copy_locale 组装测试
    #[test]
    fn message_with_copy_locale_fills_title_body() {
        use crate::push::vendor::VendorPlatform;

        let decision = PushDecision {
            deliver: true,
            scene: SceneId::RunFailed,
            level: SceneId::RunFailed.level(),
            severity: SceneId::RunFailed.level().severity(),
            dedupe_key: "run-terminal:run-42:failed".to_string(),
            payload: payload("run-42", Some("provider 401"), None),
            outcome: DecisionOutcome::Delivered,
        };

        // 英文 locale
        let msg_en =
            message_with_copy_locale(&decision, "push-000002".to_string(), 2, T0, Some("en-US"));
        assert_eq!(msg_en.title.as_deref(), Some("Run Failed"));
        assert_eq!(msg_en.body.as_deref(), Some("run-42: provider 401"));

        // 英文 device
        let en_device =
            VendorDevice::new("dev-en", "tok-1", VendorPlatform::Ios).with_language("en-US");
        let msg_dev =
            message_with_copy_for_device(&decision, "push-000003".to_string(), 3, T0, &en_device);
        assert_eq!(msg_dev.title.as_deref(), Some("Run Failed"));
        assert_eq!(msg_dev.body.as_deref(), Some("run-42: provider 401"));
    }
}
