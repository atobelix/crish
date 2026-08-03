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
//!   5. 上下文压缩预检（P4 阶段 3-2 / §3.4.1 触发点 1：阈值触发——T-33
//!      恢复 T06.2.3 Q04 删除的触发点，真实压缩引擎接线；条件与动作见
//!      [maybe_compact_preflight]）；
//!   6. TURN_PREPARED → streaming。

use conex_types::events::AgentEvent;
use conex_types::session::AgentSessionEvent as E;

use crate::steering::SteeringPhase;

use super::super::end::EndDecision;
use super::super::handlers::{
    check_control, dispatch, maybe_compact_preflight, record_message, steering_context,
    HandlerOutcome, LoopState,
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

    // 5. 上下文压缩预检（P4 阶段 3-2 / §3.4.1 触发点 1：阈值触发）——
    //    estimate ≥ window - reserve 且本 run 压缩次数未达上限时同步压缩
    //    （对话替换 + 事件广播在预检函数内完成；压缩是唯一前缀重写点，
    //    I1 不变量，P1 追加点纪律的 P4 闸门例外）。
    //    T06.2.3 Q04 删除的触发点在 T-33 恢复：真实压缩引擎
    //    （conex-compaction AgentMessage 面）已接线，CompressionHook
    //    死配置由阈值预检替代。
    maybe_compact_preflight(state);

    // 6. TURN_PREPARED → streaming（turnIndex+1，toolCallCount 归零）
    dispatch(state, E::TurnPrepared)?;
    Ok(HandlerOutcome::continue_run())
}
