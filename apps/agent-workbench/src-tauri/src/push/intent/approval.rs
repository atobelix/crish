//! S1/S2 审批族推送意图（审批请求必达 / 仅 expired 推）

use conex_types::events::{AgentEvent, ApprovalDecision};

use super::{dedupe_key, ApprovalPushRef, PayloadDigest, PushIntent};
use crate::push::scenes::SceneId;
use crate::push::{PushLevel, PushTargetScreen};

/// S1/S2 审批族判定（臂体与拆分前 `push_intent_with_kill_source` 同臂逐字一致）
pub(super) fn approval_intent(event: &AgentEvent) -> Option<PushIntent> {
    match event {
        // ── S1 审批请求（P0 必达最高）──
        AgentEvent::ApprovalRequested {
            session_id,
            request,
            ..
        } => {
            let key = dedupe_key("approval-requested", &request.tool_call_id);
            Some(PushIntent {
                scene: SceneId::ApprovalRequested,
                level: PushLevel::P0Critical,
                dedupe_key: key.clone(),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Approval,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: request.tool_call_id.clone(),
                    digest: Some(request.summary.clone()),
                    detail: Some(request.tool_name.clone()),
                },
                approval: Some(ApprovalPushRef {
                    tool_call_id: request.tool_call_id.clone(),
                    session_id: session_id.clone(),
                    dedupe_key: key,
                }),
            })
        }

        // ── S2 审批结果（仅 expired 推；approved/denied 不推）──
        AgentEvent::ApprovalResolved {
            session_id,
            tool_call_id,
            decision,
            ..
        } => {
            if *decision != ApprovalDecision::Expired {
                return None;
            }
            let key = dedupe_key("approval-resolved", &format!("{tool_call_id}:expired"));
            Some(PushIntent {
                scene: SceneId::ApprovalExpired,
                level: PushLevel::P0Critical,
                dedupe_key: key.clone(),
                collapse_key: format!("session:{session_id}"),
                target: PushTargetScreen::Approval,
                payload: PayloadDigest {
                    session_id: session_id.clone(),
                    biz_key: tool_call_id.clone(),
                    digest: None,
                    detail: None,
                },
                approval: Some(ApprovalPushRef {
                    tool_call_id: tool_call_id.clone(),
                    session_id: session_id.clone(),
                    dedupe_key: key,
                }),
            })
        }
        // 非本族变体：分发层（mod.rs `push_intent_with_kill_source`）已按事件族
        // 穷尽路由，不会进入本函数；保守按 P3 不推返回 None
        _ => None,
    }
}
