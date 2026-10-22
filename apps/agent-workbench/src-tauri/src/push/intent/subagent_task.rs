//! S6–S8e 子代理终态与后台任务推送意图（S8e 与 kill 来源联动）

use conex_types::events::{AgentEvent, SubagentEndStatus};

use super::{dedupe_key, task_killed_should_push, PayloadDigest, PushIntent, RunTerminationSource};
use crate::push::scenes::SceneId;
use crate::push::{PushLevel, PushTargetScreen};

/// S6–S8e 子代理 / 后台任务判定（臂体与拆分前 `push_intent_with_kill_source` 同臂逐字一致；
/// `kill_source` 仅 S8e 消费）
pub(super) fn subagent_task_intent(
    event: &AgentEvent,
    kill_source: Option<RunTerminationSource>,
) -> Option<PushIntent> {
    match event {
        // ── S6/S7 子代理终态 ──
        AgentEvent::SubagentEnded {
            session_id,
            subagent_id,
            status,
            summary,
            ..
        } => match status {
            SubagentEndStatus::Failed => Some(PushIntent {
                scene: SceneId::SubagentFailed,
                level: PushLevel::P0Critical,
                dedupe_key: dedupe_key("subagent-ended", &format!("{subagent_id}:failed")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Subagent,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: subagent_id.clone(),
                    digest: summary.clone(),
                    detail: None,
                },
                approval: None,
            }),
            // completed / cancelled 同族 P1（D7 §3.2 行 31：cancelled→P1）；
            // cancelled 用独立去重键，避免与 completed 的推发互相抑制
            SubagentEndStatus::Completed => Some(PushIntent {
                scene: SceneId::SubagentCompleted,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("subagent-ended", subagent_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Subagent,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: subagent_id.clone(),
                    digest: summary.clone(),
                    detail: None,
                },
                approval: None,
            }),
            SubagentEndStatus::Cancelled => Some(PushIntent {
                scene: SceneId::SubagentCompleted,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("subagent-ended", &format!("{subagent_id}:cancelled")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Subagent,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: subagent_id.clone(),
                    digest: summary.clone(),
                    detail: None,
                },
                approval: None,
            }),
        },

        // ── S8a 任务启动（仅 daemon/预计长耗时；D7 §3.3 S8a）──
        AgentEvent::TaskStarted {
            session_id,
            task_id,
            command,
            is_daemon,
            ..
        } => {
            if !is_daemon {
                return None;
            }
            Some(PushIntent {
                scene: SceneId::TaskStarted,
                level: PushLevel::P2Collapsible,
                dedupe_key: dedupe_key("task-started", task_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Task,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: task_id.clone(),
                    digest: Some(command.clone()),
                    detail: None,
                },
                approval: None,
            })
        }

        // ── S8b 任务完成（P1）──
        AgentEvent::TaskCompleted {
            session_id,
            task_id,
            exit_code,
            ..
        } => Some(PushIntent {
            scene: SceneId::TaskCompleted,
            level: PushLevel::P1Important,
            dedupe_key: dedupe_key("task-completed", task_id),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Task,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: task_id.clone(),
                digest: None,
                detail: Some(format!("exit code {exit_code}")),
            },
            approval: None,
        }),

        // ── S8c 任务疑似卡死（P0）──
        AgentEvent::TaskSuspicious {
            session_id,
            task_id,
            silence_ms,
            ..
        } => Some(PushIntent {
            scene: SceneId::TaskSuspicious,
            level: PushLevel::P0Critical,
            dedupe_key: dedupe_key("task-suspicious", task_id),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Task,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: task_id.clone(),
                digest: Some(format!("{silence_ms}")),
                detail: None,
            },
            approval: None,
        }),

        // ── S8d 任务失败（P0）──
        AgentEvent::TaskFailed {
            session_id,
            task_id,
            exit_code,
            tail,
            ..
        } => Some(PushIntent {
            scene: SceneId::TaskFailed,
            level: PushLevel::P0Critical,
            dedupe_key: dedupe_key("task-failed", task_id),
            collapse_key: format!("session:{session_id}"),
            target: PushTargetScreen::Task,
            payload: PayloadDigest {
                session_id: session_id.clone(),
                biz_key: task_id.clone(),
                // 日志尾部末行作正文素材（全量 tail 由 copy/任务详情消费）
                digest: tail.last().cloned(),
                detail: Some(format!("exit code {exit_code}")),
            },
            approval: None,
        }),

        // ── S8e 任务被终止（P1；与 kill 来源联动——用户主动 kill 不推，
        //    系统/watchdog 强制 kill 才推；来源经
        //    [push_intent_with_kill_source] 注入，未知回退 via_force 近似）──
        AgentEvent::TaskKilled {
            session_id,
            task_id,
            via_force,
            diagnostics,
            ..
        } => {
            if !task_killed_should_push(kill_source, *via_force) {
                return None;
            }
            Some(PushIntent {
                scene: SceneId::TaskKilled,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("task-killed", task_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Task,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: task_id.clone(),
                    digest: diagnostics.clone(),
                    detail: None,
                },
                approval: None,
            })
        }
        // 非本族变体：分发层（mod.rs `push_intent_with_kill_source`）已按事件族
        // 穷尽路由，不会进入本函数；保守按 P3 不推返回 None
        _ => None,
    }
}
