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
    assert_timeline_injection_hygiene, check_control, dispatch, maybe_compact_preflight,
    record_message, steering_context, HandlerOutcome, LoopState,
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

    // 3. turn-start 事件（turn_index 以 TURN_PREPARED 递增后的值展示；
    //    F1-03：饱和加——u32::MAX 时事件载荷保持上限，不得溢出 panic）
    let session_id = state.machine.context().session_id.clone();
    let turn_index = state.machine.context().turn_index.saturating_add(1);
    state.events.push(AgentEvent::TurnStart {
        session_id: session_id.clone(),
        turn_index,
        timestamp: crate::steering::now_iso_utc(),
    });
    // I8-E1 第一批：turn.start 钩子广播（turn 编排起点；observe 默认，
    // 失败吞掉 + 计数，编排继续——03 §2.4 表）
    if let Some(hooks) = &state.options.hooks {
        let _ = hooks
            .dispatch(&crate::hooks::HookEvent::TurnStart {
                session_id,
                turn_index,
            })
            .await;
    }

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
    maybe_compact_preflight(state).await;
    // T-35 注入卫生（debug 面）：本 handler 是 steering 注入（InjectMessage
    // 直写对话）与 user 消息消费（record_message）的汇聚点——预检压缩
    // 后再做一次尾部卫生断言，覆盖 steering 注入路径
    assert_timeline_injection_hygiene(&state.conversation);

    // 6. TURN_PREPARED → streaming（turnIndex+1，toolCallCount 归零）
    dispatch(state, E::TurnPrepared)?;
    Ok(HandlerOutcome::continue_run())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::handlers::LoopState;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use agent_tools::registry::ToolRegistry;
    use conex_types::events::AgentEvent;
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};
    use std::sync::Arc;

    /// 构造处于 preparing-turn 状态的 LoopState（F1-03 单测驱动）
    fn preparing_state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let mut state = LoopState::new(
            "sess-1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        );
        state.machine.dispatch(E::Initialized).unwrap();
        state.machine.dispatch(E::InputReady).unwrap();
        assert_eq!(state.machine.state(), S::PreparingTurn);
        state.input_queue.enqueue_force(AgentMessage {
            id: "user-1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "hello".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        });
        state
    }

    /// F1-03（红→绿）：turn-start 事件在 turn_index=u32::MAX 时不得溢出
    /// panic（修复前 prepare_turn.rs:43 `turn_index + 1` debug panic）；
    /// 饱和后事件载荷保持 u32::MAX，不产生回绕显示值
    #[tokio::test]
    async fn turn_start_event_saturates_at_u32_max() {
        let mut state = preparing_state();
        state.machine.context_mut().turn_index = u32::MAX;
        let outcome = handle(&mut state).await.expect("handler 不得 panic");
        assert!(outcome.end.is_none(), "正常轮次不应收场");
        let turn_index = state.events.iter().find_map(|e| match e {
            AgentEvent::TurnStart { turn_index, .. } => Some(*turn_index),
            _ => None,
        });
        assert_eq!(
            turn_index,
            Some(u32::MAX),
            "turn-start 事件必须饱和保持（修复前 `+1` 溢出 panic，红）"
        );
    }
}
