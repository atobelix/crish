//! S3/S4/S5 run 终态推送意图（completed/cancelled P1，failed P0）

use conex_types::events::{AgentEvent, RunTerminalStatus};

use super::{dedupe_key, PayloadDigest, PushIntent};
use crate::push::scenes::SceneId;
use crate::push::{PushLevel, PushTargetScreen};

/// S3/S4/S5 run 终态判定（臂体与拆分前 `push_intent_with_kill_source` 同臂逐字一致）
pub(super) fn run_terminal_intent(event: &AgentEvent) -> Option<PushIntent> {
    match event {
        // ── S3/S4/S5 run 终态 ──
        AgentEvent::RunTerminal {
            session_id,
            run_id,
            terminal,
            error,
            ..
        } => match terminal {
            RunTerminalStatus::Completed => Some(PushIntent {
                scene: SceneId::RunCompleted,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("run-terminal", run_id),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Session,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: run_id.clone(),
                    digest: None,
                    detail: None,
                },
                approval: None,
            }),
            RunTerminalStatus::Failed => Some(PushIntent {
                scene: SceneId::RunFailed,
                level: PushLevel::P0Critical,
                dedupe_key: dedupe_key("run-terminal", &format!("{run_id}:failed")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Session,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: run_id.clone(),
                    digest: error.clone(),
                    detail: None,
                },
                approval: None,
            }),
            RunTerminalStatus::Cancelled => Some(PushIntent {
                scene: SceneId::RunCancelled,
                level: PushLevel::P1Important,
                dedupe_key: dedupe_key("run-terminal", &format!("{run_id}:cancelled")),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Session,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: run_id.clone(),
                    digest: None,
                    detail: None,
                },
                approval: None,
            }),
        },
        // 非本族变体：分发层（mod.rs `push_intent_with_kill_source`）已按事件族
        // 穷尽路由，不会进入本函数；保守按 P3 不推返回 None
        _ => None,
    }
}
