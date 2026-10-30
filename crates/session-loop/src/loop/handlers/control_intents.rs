//! 安全点 control-intent 事件发射（自 handlers/mod.rs 拆出，纯体积拆分，
//! 零逻辑改动）。
//!
//! EV-04（D-03）：control-intent 两态发射（enqueued 先、consumed 后，
//! intent_id 配对），由 [super::check_control] 与 streaming 收流路径调用。

use conex_types::events::AgentEvent;

use crate::control::ControlIntent;

use super::LoopState;

/// EV-04：control-intent 两态发射（enqueued 先、consumed 后，intent_id 配对）。
pub(crate) fn emit_control_intents(state: &mut LoopState, intents: &[ControlIntent]) {
    let session_id = state.machine.context().session_id.clone();
    for intent in intents {
        state.events.push(AgentEvent::ControlIntent {
            session_id: session_id.clone(),
            timestamp: conex_shared::time::now_iso_utc(),
            kind: intent.kind.as_event_kind().to_string(),
            intent_id: intent.id.clone(),
            source: intent.source.clone(),
            reason: intent.reason.clone(),
            state: "enqueued".to_string(),
        });
    }
    for intent in intents {
        state.events.push(AgentEvent::ControlIntent {
            session_id: session_id.clone(),
            timestamp: conex_shared::time::now_iso_utc(),
            kind: intent.kind.as_event_kind().to_string(),
            intent_id: intent.id.clone(),
            source: intent.source.clone(),
            reason: intent.reason.clone(),
            state: "consumed".to_string(),
        });
    }
}
