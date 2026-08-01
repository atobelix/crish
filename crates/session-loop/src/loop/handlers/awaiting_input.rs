//! handleAwaitingInput（01 §2.2）
//!
//! 触发：awaiting-input。行为：安全点检查（abort / 控制意图）→
//! dequeue（force 优先、steer 次之）→ 无输入 NO_INPUT（→ done，stop 收场）；
//! 有输入 recordMessage（message-start/message-end + 落对话）→ INPUT_READY。

use conex_types::session::AgentSessionEvent as E;

use super::super::end::EndDecision;
use super::super::handlers::{check_control, dispatch, record_message, HandlerOutcome, LoopState};
use super::super::LoopError;

/// awaiting-input handler（01 §2.2）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    // abort 检查 + 控制总线意图（L3 强停 / L2 协作停止 / L1 注入）
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    match state.input_queue.dequeue() {
        Some(message) => {
            // 有输入：recordMessage + INPUT_READY → preparing-turn
            record_message(state, message);
            dispatch(state, E::InputReady)?;
            Ok(HandlerOutcome::continue_run())
        }
        None => {
            // 无输入：NO_INPUT → done，默认 stop 收场（01 §1.4）
            dispatch(state, E::NoInput)?;
            Ok(HandlerOutcome::end(EndDecision::stop(state)))
        }
    }
}
