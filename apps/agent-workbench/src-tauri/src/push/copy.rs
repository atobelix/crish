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
use super::scenes::SceneId;
use super::schema::{message_from_decision, PushMessage};

/// 渲染产物（title/body；[crate::push::schema::PushMessage::with_copy] 入参）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyText {
    /// 通知标题（移动端横幅主文本）
    pub title: String,
    /// 通知正文
    pub body: String,
}

/// 场景 → 标题/正文渲染（D7 §6.5：PayloadDigest + 场景映射；纯函数无 I/O）
pub fn render_copy(scene: SceneId, payload: &PayloadDigest) -> CopyText {
    let title = match scene {
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
    };
    let body = match scene {
        // S1 审批请求：`{toolName}：{summary}`（D7 §3.3 S1；样例 S1
        // 「bash：执行部署脚本…」——子代理来源/理由为 data 面扩展，本层省略）
        SceneId::ApprovalRequested => format!(
            "{}：{}",
            payload.detail.as_deref().unwrap_or_default(),
            payload.digest.as_deref().unwrap_or_default()
        ),
        // S2 审批过期：样例「bash 调用（tc-9f3a）等待超时，已自动拒绝」——
        // toolName 不在 S2 载荷（事件体无该字段），按 toolCallId 降级渲染
        SceneId::ApprovalExpired => {
            format!("审批（{}）等待超时，已自动拒绝", payload.biz_key)
        }
        // S3 run 完成：样例「任务 run-42 已运行 3 分 12 秒，退出码 0」——
        // 时长/退出码不在载荷，降级为「已完成」
        SceneId::RunCompleted => format!("任务 {} 已完成", payload.biz_key),
        // S4 run 失败：`{runId}：{error}`（样例「run-42：provider 返回 401…」）
        SceneId::RunFailed => format!(
            "{}：{}",
            payload.biz_key,
            payload.digest.as_deref().unwrap_or_default()
        ),
        // S5 run 取消（样例「任务 run-42 已被取消」）
        SceneId::RunCancelled => format!("任务 {} 已被取消", payload.biz_key),
        // S6 子代理完成：样例「子代理 分析（sa-3）已完成：成功——已产出缺口
        // 分析 5 页」——role 不在载荷（D7 注记：需从 SubagentStarted 补充），
        // 降级省略 role；summary 存在时追加
        SceneId::SubagentCompleted => {
            let mut body = format!("子代理（{}）已完成：成功", payload.biz_key);
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!("——{summary}"));
            }
            body
        }
        // S7 子代理失败：样例「子代理 评审（sa-4）失败——工具执行超时」
        SceneId::SubagentFailed => {
            let mut body = format!("子代理（{}）失败", payload.biz_key);
            if let Some(summary) = payload.digest.as_deref() {
                body.push_str(&format!("——{summary}"));
            }
            body
        }
        // S8a 任务启动（D7 §3.3 S8a「后台任务已启动：<command 摘要>」）
        SceneId::TaskStarted => payload.digest.clone().unwrap_or_default(),
        // S8b 任务完成（D7 §3.3 S8b「任务 <id> 已完成，退出码 0」）
        SceneId::TaskCompleted => match payload.detail.as_deref() {
            Some(detail) => format!("任务 {} 已完成，{detail}", payload.biz_key),
            None => format!("任务 {} 已完成", payload.biz_key),
        },
        // S8c 任务卡死（样例「任务 t-12 疑似卡死（120 秒无输出）」逐字对齐）
        SceneId::TaskSuspicious => format!(
            "任务 {} 疑似卡死（{} 秒无输出）",
            payload.biz_key,
            payload.digest.as_deref().unwrap_or_default()
        ),
        // S8d 任务失败（样例「任务 t-11 异常退出（exit code 1），运行 2 分
        // 5 秒」——时长不在载荷，降级省略）
        SceneId::TaskFailed => format!(
            "任务 {} 异常退出（{}）",
            payload.biz_key,
            payload.detail.as_deref().unwrap_or("exit code 未知")
        ),
        // S8e 任务终止（D7 §3.3 S8e；diagnostics 不在载荷时不追加）
        SceneId::TaskKilled => format!("任务 {} 已被终止", payload.biz_key),
        // S9a 定时器（样例「请检查任务进度（定时器 timer-1 已到期）」）
        SceneId::TimerFired => format!(
            "{}（定时器 {} 已到期）",
            payload.digest.as_deref().unwrap_or_default(),
            payload.biz_key
        ),
        // S9b cron（D7 §3.3 S9b「<prompt>（cron <id> 第 <n> 次触发）」；
        // n 取自 intent 的 `iteration N` 次级文本）
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
        // S10a 运行异常（D7 §3.3 S10a「运行异常（可重试）：<error 摘要>」——
        // retryable 标记不在载荷，按标题承载场景语义）
        SceneId::RuntimeError => payload.digest.clone().unwrap_or_default(),
        // S10b 需介入（样例「缺少 API 密钥，可选择：设置密钥 / 跳过」——
        // 候选动作清单为事件 data 面扩展，本层渲染 reason）
        SceneId::InterventionRequired => payload.digest.clone().unwrap_or_default(),
        // S11 安全拦截（样例「拦截删除操作：…」；targets/decision 不在载荷，
        // 操作名经 [operation_display] 映射；purged 的「已彻底清除」变体待
        // 装配层将 decision 注入载荷后扩展）
        SceneId::SecurityBlocked => format!(
            "拦截{}操作",
            operation_display(payload.digest.as_deref().unwrap_or_default())
        ),
        // S12 缓存告警（样例「本次运行浪费约 24,000 token（约 $0.12）」——
        // 千分位为示意，本层按载荷原值渲染）
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
    };
    CopyText { title, body }
}

/// 审计操作 wire（Debug 串）→ 中文展示名（S11 正文；未知值保留原串——
/// 枚举冻结，未来新增操作不 panic 不降级为空）
fn operation_display(wire: &str) -> String {
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

/// 组装入口：决策 → 带完整文案的 [PushMessage]
///
/// 接线说明：[crate::push::schema::message_from_decision] 保持 title/body
/// 置 None 的纯映射契约；本函数叠加 [crate::push::schema::PushMessage::
/// with_copy] 渲染文案——[crate::push::pusher::PushDispatcher] 分发时经此
/// 入口产出，WS 直推与离线 pending 均携带完整 title/body。
pub fn message_with_copy(
    decision: &PushDecision,
    id: String,
    seq: u64,
    now_ms: u64,
) -> PushMessage {
    let copy = render_copy(decision.scene, &decision.payload);
    message_from_decision(decision, id, seq, now_ms).with_copy(copy.title, copy.body)
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
}
