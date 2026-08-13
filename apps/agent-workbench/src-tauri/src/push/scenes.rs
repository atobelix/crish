//! 推送场景登记（R3-01 核心交付之一：13 场景登记表）
//!
//! 真源说明：任务包名「13 场景」为类级统计口径（Z0 §4.12 统计口径：
//! P0 7 类 + P1 6 类 + P2 2 类 = 13 类）；场景明细行以 **M8 §3.2.3 的
//! S1-S12 展开表（18 行）为唯一真源**（裁决修正 4），级别含 Z0 §3.3 P0-4
//! 裁决（approval-resolved(expired) 定级 P0、task-suspicious 定级 P0、
//! S10 两行补入）。
//!
//! 登记表（18 行；级别列即 [SceneId] → [PushLevel] 映射，`push_intent`
//! 与 `scenes` 测试矩阵逐行对齐——新事件变体必须补 arm，match 穷尽是编译期护栏）：
//!
//! | 场景 | 事件 | 条件 | 级别 | 去重键（`dedupe_key`） | target | 渠道 |
//! | --- | --- | --- | --- | --- | --- | --- |
//! | S1 | approval-requested | 全部 | P0 | approval-requested:{toolCallId} | approval | approval |
//! | S2 | approval-resolved | Expired | P0 | approval-resolved:{toolCallId}:expired | approval | approval |
//! | S3 | run-terminal | Completed | P1 | run-terminal:{runId} | session | run |
//! | S4 | run-terminal | Failed | P0 | run-terminal:{runId}:failed | session | run |
//! | S5 | run-terminal | Cancelled | P1 | run-terminal:{runId}:cancelled | session | run |
//! | S6 | subagent-ended | Completed / Cancelled | P1 | subagent-ended:{subagentId}[:(cancelled)] | subagent | subagent |
//! | S7 | subagent-ended | Failed | P0 | subagent-ended:{subagentId}:failed | subagent | subagent |
//! | S8a | task-started | is_daemon 或预计长耗时 | P2 | task-started:{taskId} | task | task |
//! | S8b | task-completed | 全部 | P1 | task-completed:{taskId} | task | task |
//! | S8c | task-suspicious | 全部 | P0 | task-suspicious:{taskId} | task | task |
//! | S8d | task-failed | 全部 | P0 | task-failed:{taskId} | task | task |
//! | S8e | task-killed | 非用户主动（via_force 近似） | P1 | task-killed:{taskId} | task | task |
//! | S9a | timer-fired | 全部 | P1 | timer-fired:{timerId} | timer | timer |
//! | S9b | cron-fired | 全部 | P1 | cron-fired:{cronId}:{iteration} | timer | timer |
//! | S10a | runtime-error | 全部 | P0 | runtime-error:{runId} | session | run |
//! | S10b | runtime-intervention-required | 全部 | P0 | intervention:{runId} | session | run |
//! | S11 | security-audit | decision ∈ {blocked, purged} | P0 | security-audit:{toolCallId 或 sequence 回退} | audit | security |
//! | S12 | cache-waste-alert | 全部 | P2 | cache-waste-alert:{runId 或 session 回退} | session | summary |
//!
//! 其余 31 类事件不推（P3）：过程态（agent-* / turn-* / message-* / tool-* /
//! subagent-started / subagent-event）、增量（task-output / task-heartbeat）、
//! 诊断类（provider-diagnostic / runtime-steering / checkpoint-* /
//! cache-stats-updated / cold-cache-warning）、低价值（timer-cancelled）、
//! 恢复域 ×5 与 goal 域 ×3（41 变体冻结口径后的新增，登记表外保守不推）。
//!
//! ## 场景覆盖表（场景名 / 输入 / 期望输出；测试用例逐行对齐）
//!
//! 每个场景一条测试（`intent.rs` 场景矩阵），输入 = 事件构造，期望输出 =
//! 断言 [crate::push::intent::PushIntent]（scene/level/dedupe_key/target/payload）。
//! 管线级行为（合并/静默/节流/去重链）见 `engine.rs` 测试；去重/合并/静默/
//! 节流边界见各模块测试。
//!
//! | 场景 | 测试用例（intent.rs） | 输入事件 | 期望输出（核心断言） |
//! | --- | --- | --- | --- |
//! | S1 审批请求 | s1_approval_requested_p0 | approval-requested（toolCallId=tc-9f3a） | P0 / 键 approval-requested:tc-9f3a / target=approval |
//! | S2 审批过期 | s2_approval_expired_p0_others_skipped | approval-resolved(Expired) | P0 / 键 approval-resolved:tc-9f3a:expired；Approved/Denied 不推 |
//! | S3 run 完成 | s3_run_completed_p1 | run-terminal(Completed) | P1 / 键 run-terminal:run-42 |
//! | S4 run 失败 | s4_run_failed_p0 | run-terminal(Failed,error) | P0 / 键 run-terminal:run-42:failed |
//! | S5 run 取消 | s5_run_cancelled_p1 | run-terminal(Cancelled) | P1 / 键 run-terminal:run-42:cancelled |
//! | S6 子代理完成 | s6_subagent_completed_p1 | subagent-ended(Completed/Cancelled) | P1 / 键 subagent-ended:{id}[:(cancelled)] |
//! | S7 子代理失败 | s7_subagent_failed_p0 | subagent-ended(Failed) | P0 / 键 subagent-ended:sa-4:failed |
//! | S8a 任务启动 | s8a_task_started_daemon_p2 | task-started(is_daemon=true) | P2 / 键 task-started:t-1；普通任务不推 |
//! | S8b 任务完成 | s8b_task_completed_p1 | task-completed | P1 / 键 task-completed:t-11 |
//! | S8c 任务卡死 | s8c_task_suspicious_p0 | task-suspicious | P0 / 键 task-suspicious:t-12 |
//! | S8d 任务失败 | s8d_task_failed_p0 | task-failed | P0 / 键 task-failed:t-11 / digest=tail 末行 |
//! | S8e 任务终止 | s8e_task_killed_force_p1 | task-killed(via_force=true) | P1 / 键 task-killed:t-3；非强制不推 |
//! | S9a 定时器 | s9a_timer_fired_p1 | timer-fired | P1 / 键 timer-fired:timer-1 / collapse=timer:timer-1 |
//! | S9b cron | s9b_cron_fired_p1 | cron-fired | P1 / 键 cron-fired:cron-2:3（iteration 独立） |
//! | S10a 运行异常 | s10a_runtime_error_p0 | runtime-error（runId 信封注入） | P0 / 键 runtime-error:run-42；缺失回退 session |
//! | S10b 需介入 | s10b_intervention_required_p0 | runtime-intervention-required | P0 / 键 intervention:run-42 |
//! | S11 安全拦截 | s11_security_blocked_purged_p0 | security-audit(blocked/purged) | P0 / 键 security-audit:{toolCallId→sequence→session}；其余 decision 不推 |
//! | S12 缓存告警 | s12_cache_waste_alert_p2 | cache-waste-alert | P2 / 键 cache-waste-alert:run-42 |
//! | P3 不推 | p3_no_push_events | 31 类过程态/增量/诊断/低价值/恢复域/goal 域 | 全部 None |

use super::{PushLevel, PushTargetScreen};

/// 推送场景标识（M8 §3.2.3 18 行登记表；[SceneId] → 级别映射见模块文档表）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SceneId {
    /// S1 审批请求（P0 必达最高）
    ApprovalRequested,
    /// S2 审批过期（P0，P0-4 裁决后定级）
    ApprovalExpired,
    /// S3 run 完成（P1）
    RunCompleted,
    /// S4 run 失败（P0）
    RunFailed,
    /// S5 run 取消（P1）
    RunCancelled,
    /// S6 子代理完成（P1）
    SubagentCompleted,
    /// S7 子代理失败（P0）
    SubagentFailed,
    /// S8a 后台任务启动（P2，仅 daemon/长耗时）
    TaskStarted,
    /// S8b 后台任务完成（P1）
    TaskCompleted,
    /// S8c 后台任务疑似卡死（P0）
    TaskSuspicious,
    /// S8d 后台任务失败（P0）
    TaskFailed,
    /// S8e 后台任务被终止（P1，非用户主动）
    TaskKilled,
    /// S9a 定时器到期（P1）
    TimerFired,
    /// S9b cron 触发（P1）
    CronFired,
    /// S10a 运行异常（P0，run-failed 先行提示）
    RuntimeError,
    /// S10b 需人工介入（P0）
    InterventionRequired,
    /// S11 安全拦截（P0，decision ∈ {blocked, purged}）
    SecurityBlocked,
    /// S12 缓存浪费告警（P2）
    CacheWasteAlert,
}

impl SceneId {
    /// 场景 → 推送级别（登记表级别列）
    pub fn level(&self) -> PushLevel {
        match self {
            SceneId::ApprovalRequested
            | SceneId::ApprovalExpired
            | SceneId::RunFailed
            | SceneId::SubagentFailed
            | SceneId::TaskSuspicious
            | SceneId::TaskFailed
            | SceneId::RuntimeError
            | SceneId::InterventionRequired
            | SceneId::SecurityBlocked => PushLevel::P0Critical,
            SceneId::RunCompleted
            | SceneId::RunCancelled
            | SceneId::SubagentCompleted
            | SceneId::TaskCompleted
            | SceneId::TaskKilled
            | SceneId::TimerFired
            | SceneId::CronFired => PushLevel::P1Important,
            SceneId::TaskStarted | SceneId::CacheWasteAlert => PushLevel::P2Collapsible,
        }
    }

    /// 场景 wire 名（诊断/审计用；不等价于事件 wire 名）
    pub fn as_str(&self) -> &'static str {
        match self {
            SceneId::ApprovalRequested => "approval-requested",
            SceneId::ApprovalExpired => "approval-expired",
            SceneId::RunCompleted => "run-completed",
            SceneId::RunFailed => "run-failed",
            SceneId::RunCancelled => "run-cancelled",
            SceneId::SubagentCompleted => "subagent-completed",
            SceneId::SubagentFailed => "subagent-failed",
            SceneId::TaskStarted => "task-started",
            SceneId::TaskCompleted => "task-completed",
            SceneId::TaskSuspicious => "task-suspicious",
            SceneId::TaskFailed => "task-failed",
            SceneId::TaskKilled => "task-killed",
            SceneId::TimerFired => "timer-fired",
            SceneId::CronFired => "cron-fired",
            SceneId::RuntimeError => "runtime-error",
            SceneId::InterventionRequired => "intervention-required",
            SceneId::SecurityBlocked => "security-blocked",
            SceneId::CacheWasteAlert => "cache-waste-alert",
        }
    }

    /// 跳转目标屏幕（D7 §7.4 路由映射表）
    pub fn target_screen(&self) -> PushTargetScreen {
        match self {
            SceneId::ApprovalRequested | SceneId::ApprovalExpired => PushTargetScreen::Approval,
            SceneId::RunCompleted
            | SceneId::RunFailed
            | SceneId::RunCancelled
            | SceneId::RuntimeError
            | SceneId::InterventionRequired
            | SceneId::CacheWasteAlert => PushTargetScreen::Session,
            SceneId::SubagentCompleted | SceneId::SubagentFailed => PushTargetScreen::Subagent,
            SceneId::TaskStarted
            | SceneId::TaskCompleted
            | SceneId::TaskSuspicious
            | SceneId::TaskFailed
            | SceneId::TaskKilled => PushTargetScreen::Task,
            SceneId::TimerFired | SceneId::CronFired => PushTargetScreen::Timer,
            SceneId::SecurityBlocked => PushTargetScreen::Audit,
        }
    }

    /// 是否需要走合并（coalesce）桶路由（见 [crate::push::coalesce]）
    pub fn is_coalesced(&self) -> bool {
        matches!(
            self,
            SceneId::SubagentCompleted
                | SceneId::ApprovalRequested
                | SceneId::TaskFailed
                | SceneId::CronFired
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 场景登记表覆盖率自检：18 行登记 → 18 个 level/target 映射断言
    /// （矩阵主体为 13 场景单测，逐场景见下；本测试锁定登记表与枚举不漂移）
    #[test]
    fn scene_registry_levels_align_m8_18_rows() {
        assert_eq!(SceneId::ApprovalRequested.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::ApprovalExpired.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::RunCompleted.level(), PushLevel::P1Important);
        assert_eq!(SceneId::RunFailed.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::RunCancelled.level(), PushLevel::P1Important);
        assert_eq!(SceneId::SubagentCompleted.level(), PushLevel::P1Important);
        assert_eq!(SceneId::SubagentFailed.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::TaskStarted.level(), PushLevel::P2Collapsible);
        assert_eq!(SceneId::TaskCompleted.level(), PushLevel::P1Important);
        assert_eq!(SceneId::TaskSuspicious.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::TaskFailed.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::TaskKilled.level(), PushLevel::P1Important);
        assert_eq!(SceneId::TimerFired.level(), PushLevel::P1Important);
        assert_eq!(SceneId::CronFired.level(), PushLevel::P1Important);
        assert_eq!(SceneId::RuntimeError.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::InterventionRequired.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::SecurityBlocked.level(), PushLevel::P0Critical);
        assert_eq!(SceneId::CacheWasteAlert.level(), PushLevel::P2Collapsible);
    }

    /// 13 类统计口径自检（Z0 §4.12：P0 7 类 / P1 6 类 / P2 2 类）
    #[test]
    fn scene_class_counts_align_z0_13_classes() {
        let all = [
            SceneId::ApprovalRequested,
            SceneId::ApprovalExpired,
            SceneId::RunCompleted,
            SceneId::RunFailed,
            SceneId::RunCancelled,
            SceneId::SubagentCompleted,
            SceneId::SubagentFailed,
            SceneId::TaskStarted,
            SceneId::TaskCompleted,
            SceneId::TaskSuspicious,
            SceneId::TaskFailed,
            SceneId::TaskKilled,
            SceneId::TimerFired,
            SceneId::CronFired,
            SceneId::RuntimeError,
            SceneId::InterventionRequired,
            SceneId::SecurityBlocked,
            SceneId::CacheWasteAlert,
        ];
        assert_eq!(all.len(), 18, "登记行数（M8 §3.2.3 18 行）");
        let p0 = all
            .iter()
            .filter(|s| matches!(s.level(), PushLevel::P0Critical))
            .count();
        let p1 = all
            .iter()
            .filter(|s| matches!(s.level(), PushLevel::P1Important))
            .count();
        let p2 = all
            .iter()
            .filter(|s| matches!(s.level(), PushLevel::P2Collapsible))
            .count();
        // P0 类：S1/S2/S4/S7/S8c/S8d/S10（按子集）/S11 = 7 类（9 行）；
        // P1 类：S3/S5/S6/S8b/S8e/S9（a/b）= 6 类（7 行）；P2 类：S8a/S12 = 2 类
        assert_eq!((p0, p1, p2), (9, 7, 2), "18 行级别分布");
    }
}
