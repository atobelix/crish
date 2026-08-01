//! handlePrepareTurn（01 §2.3）
//!
//! 触发：preparing-turn（含 NO_PROGRESS_CONTINUE 重进）。
//! 行为顺序：
//!   1. 安全点检查（abort / 控制意图）；
//!   2. 消费 hasRunnablePending（force/steer；**不消费 followUp**）→ recordMessage；
//!   3. `turn-start` 事件；
//!   4. steering 评估（after-tools / before-turn 两相位，D3 预注入短路：
//!      输入队列有可运行输入即跳过评估；`steering_enabled=false` 时跳过
//!      评估，T06.2.1 Q03）；intervention-required 事件照发，但 run
//!      **不以 error 收场**（00 D6 / 01 §五.4 裁决：stop + 诊断）；
//!   5. 上下文压缩（已删除，T06.2.3 Q04：CompressionHook 死配置无消费者）；
//!   6. TURN_PREPARED → streaming。

use conex_types::events::AgentEvent;
use conex_types::session::AgentSessionEvent as E;

use crate::steering::SteeringPhase;

use super::super::end::EndDecision;
use super::super::handlers::{
    check_control, dispatch, record_message, steering_context, HandlerOutcome, LoopState,
};
use super::super::LoopError;

/// preparing-turn handler（01 §2.3）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    // 1. abort / 控制意图检查
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 2. 消费 hasRunnablePending（force/steer；不消费 followUp，01 §2.3 步骤 2）
    while let Some(message) = state.input_queue.dequeue() {
        record_message(state, message);
    }

    // 3. turn-start 事件（turn_index 以 TURN_PREPARED 递增后的值展示）
    let session_id = state.machine.context().session_id.clone();
    state.events.push(AgentEvent::TurnStart {
        session_id,
        turn_index: state.machine.context().turn_index + 1,
        timestamp: crate::steering::now_iso_utc(),
    });

    // 4. steering 评估（D3 预注入短路：有可运行输入即跳过策略评估，
    //    避免对已注入 nudge 重复 steering；T06.2.1 Q03：steering_enabled
    //    =false 时跳过 AfterTools/BeforeTurn 评估）
    if state.options.steering_enabled && !state.input_queue.has_runnable_pending() {
        for phase in [SteeringPhase::AfterTools, SteeringPhase::BeforeTurn] {
            let actions = state.steering.evaluate(phase, &steering_context(state));
            if actions.is_empty() {
                continue;
            }
            let session_id = state.machine.context().session_id.clone();
            let applied =
                state.steering.apply(&actions, &session_id, &mut state.conversation);
            state.events.extend(applied.events);
            if applied.intervention_required {
                // 裁决（00 D6 / 01 §五.4）：intervention 事件照发，
                // 但 run 以 stop + 诊断收场，不以 error 收场
                dispatch(state, E::InterventionRequired)?;
                return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
                    state,
                    crate::steering::DEFAULT_INTERVENTION_MESSAGE,
                )));
            }
        }
    }

    // 5. 上下文压缩（已删除，T06.2.3 / AA-01 Q04）：CompressionHook 死配置
    //    无消费者（payload 阶梯亦已删除，T06.2.2）。上下文压缩 = 未来任务，
    //    需真实压缩实现 + payload 阶梯一并恢复（AA-06 P11 登记不做，PE-09）。

    // 6. TURN_PREPARED → streaming（turnIndex+1，toolCallCount 归零）
    dispatch(state, E::TurnPrepared)?;
    Ok(HandlerOutcome::continue_run())
}
