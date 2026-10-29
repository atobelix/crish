//! handleTurnComplete（收敛六级无阻塞阶梯）
//!
//! 触发：TurnComplete 状态。
//! 权威收敛顺序（优先级从高到低，严格杜绝内层睡眠阻塞）：
//!   - Step 0 控制中断：
//!     1. 安全点检查（check_control）；
//!     2. TurnEnd 事件广播并结算 usage；
//!     3. abort 信号检查（AbortSignal）；
//!     4. 上下文未决异常（Error / Aborted）。
//!   - Step 1 最大轮次硬限：
//!     核查 should_stop_for_max_turns（0 恒代表无上限），超限时按 MaxTurns 预算收场。
//!   - Step 2 排队输入检查：
//!     promote_follow_up 与 runnable 输入检查，有输入立即转入 InputAvailable 消费。
//!   - Step 3 工具调用存在性：
//!     tool_call_count > 0 续轮回路（NextTurn）。
//!   - Step 4 正常收场：
//!     外部钩子（turn_end_hook、插件广播、should_stop_after_turn）显式请求停机时分派 ShouldStop。
//!   - Step 5 挂起收口：
//!     既无工具调用又无排队输入时，立即原子分派 ShouldStop 并返回 YieldSuspended 决策，
//!     交由外层编排层释放排他锁并挂起等待事件（Reactive Wakeup），内层绝不 sleep 阻塞！

use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::session::AgentSessionEvent as E;

use super::super::end::EndDecision;
use super::super::handlers::{check_control, dispatch, HandlerOutcome, LoopState};
use super::super::{LoopError, TurnEndContext};

/// turn-complete handler（01 §2.9；六级无阻塞决断阶梯）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    // ─────────────────────────────────────────────────────────────
    // Step 0: 控制中断核查与事件闭合（最高优先级干预与状态清理）
    // ─────────────────────────────────────────────────────────────

    // 0.1 安全点检查（进入 turn-complete 的控制总线意图：L3 / L2 / L1）
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 0.2 TurnEnd 事件广播并结算 Token Usage
    let ctx = state.machine.context().clone();
    let turn_end_event = AgentEvent::TurnEnd {
        session_id: ctx.session_id.clone(),
        turn_index: ctx.turn_index,
        timestamp: conex_shared::time::now_iso_utc(),
        tool_call_count: ctx.tool_call_count,
        usage: state.budget_state.turn_usage.take(),
    };
    state.emit_event(turn_end_event);
    state.current_turn_index = None;

    // 0.3 abort 信号检查 → Finish + Aborted
    if state.abort_signal.is_aborted() {
        dispatch(state, E::Finish)?;
        return Ok(HandlerOutcome::end(EndDecision::aborted(state)));
    }

    // 0.4 上下文异常收场（streaming PROVIDER_ERROR / executing-tools ERROR 经此收敛）
    match ctx.end_reason {
        conex_types::session::AgentEndReason::Error => {
            let terminal = state.terminal_error.take().unwrap_or_else(|| {
                let machine_state = state.machine.state();
                format!("run 失败（状态={machine_state:?}，事件=Error 收场）")
            });
            dispatch(state, E::Finish)?;
            return Ok(HandlerOutcome::end(EndDecision::error(state, terminal)));
        }
        conex_types::session::AgentEndReason::Aborted => {
            dispatch(state, E::Finish)?;
            return Ok(HandlerOutcome::end(EndDecision::aborted(state)));
        }
        _ => {}
    }

    // ─────────────────────────────────────────────────────────────
    // Step 1: 最大轮次硬限核查（0 恒代表无上限）
    // ─────────────────────────────────────────────────────────────
    if ctx.should_stop_for_max_turns() {
        state.emit_event(AgentEvent::RuntimeError {
            session_id: ctx.session_id.clone(),
            timestamp: conex_shared::time::now_iso_utc(),
            error: format!(
                "maxTurns 预算用尽（turnIndex={}，maxTurns={}）",
                ctx.turn_index, ctx.max_turns
            ),
            retryable: Some(false),
        });
        if let Some(hooks) = &state.options.tool_exec.hooks {
            if let Err(err) = hooks
                .dispatch(&crate::hooks::HookEvent::ErrorOccurred {
                    session_id: ctx.session_id.clone(),
                    error: format!(
                        "maxTurns 预算用尽（turnIndex={}，maxTurns={}）",
                        ctx.turn_index, ctx.max_turns
                    ),
                    retryable: false,
                })
                .await
            {
                tracing::warn!(
                    session_id = %ctx.session_id,
                    error = %err,
                    "max-turns error.occurred hook 分派失败（观察面不阻断收场）"
                );
            }
        }
        tracing::error!(
            target: "run",
            event = "runtime_error",
            error_code = %codes::AGENT_MAX_TURNS_REACHED,
            retryable = false,
            "maxTurns 预算用尽"
        );
        dispatch(state, E::MaxTurnsReached)?;
        return Ok(HandlerOutcome::end(EndDecision::max_turns(state)));
    }

    // ─────────────────────────────────────────────────────────────
    // Step 2: 排队输入检查（优先消费已就绪人类插话或待命消息）
    // ─────────────────────────────────────────────────────────────
    let promoted = state.input_queue.promote_follow_up();
    if promoted > 0 || state.input_queue.has_runnable_pending() {
        dispatch(state, E::InputAvailable)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // ─────────────────────────────────────────────────────────────
    // Step 3: 工具调用存在性（有工具结果自驱续轮）
    // ─────────────────────────────────────────────────────────────
    if ctx.tool_call_count > 0 {
        dispatch(state, E::NextTurn)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // ─────────────────────────────────────────────────────────────
    // Step 4: 正常收场检查（外部或插件钩子显式请求停机）
    // ─────────────────────────────────────────────────────────────
    // 4.1 lifecycle turn.end 钩子的 stop 建议
    let stop_suggested = state
        .options
        .hooks
        .turn_end_hook
        .as_ref()
        .map(|hook| {
            hook.on_turn_end(&TurnEndContext {
                session_id: ctx.session_id.clone(),
                turn_index: ctx.turn_index,
                tool_call_count: ctx.tool_call_count,
            })
        })
        .unwrap_or(false);
    if stop_suggested {
        dispatch(state, E::ShouldStop)?;
        return Ok(HandlerOutcome::end(EndDecision::stop(state)));
    }

    // 4.2 插件钩子 turn.end
    if let Some(hooks) = &state.options.tool_exec.hooks {
        let event = crate::hooks::HookEvent::TurnEnd {
            session_id: ctx.session_id.clone(),
            turn_index: ctx.turn_index,
            tool_call_count: ctx.tool_call_count,
        };
        match hooks.dispatch(&event).await {
            Ok(outcome) => {
                if let Some(reason) = outcome.blocked {
                    tracing::info!(reason = %reason, "turn.end 钩子建议 stop");
                    dispatch(state, E::ShouldStop)?;
                    return Ok(HandlerOutcome::end(EndDecision::stop(state)));
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "turn.end 钩子分派失败（propagate），按忽略继续收场");
            }
        }
    }

    // 4.3 shouldStopAfterTurn 兼容层
    let should_stop = state
        .options
        .hooks
        .should_stop_after_turn
        .as_ref()
        .map(|hook| {
            hook.on_turn_end(&TurnEndContext {
                session_id: ctx.session_id.clone(),
                turn_index: ctx.turn_index,
                tool_call_count: ctx.tool_call_count,
            })
        })
        .unwrap_or(false);
    if should_stop {
        dispatch(state, E::ShouldStop)?;
        return Ok(HandlerOutcome::end(EndDecision::stop(state)));
    }

    // ─────────────────────────────────────────────────────────────
    // Step 5: 终态无阻塞收场（原子返回 YieldSuspended 并交出执行权）
    // ─────────────────────────────────────────────────────────────
    // 本轮无工具调用且队列无 runnable 输入：立即原子转移至 Done，
    // 返回 YieldSuspended 决策，交由外层编排层释放排他锁并挂起等待事件；
    // 严禁在此调用任何 tokio::time::sleep 轮询，保持 session-loop 为纯计算回合单元！
    dispatch(state, E::ShouldStop)?;
    Ok(HandlerOutcome::end(EndDecision::yield_suspended(
        state,
        "no_pending_action",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::end::AgentEndReason;
    use crate::r#loop::handlers::LoopState;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::SteeringCoordinator;
    use agent_tools::registry::ToolRegistry;
    use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};
    use std::sync::Arc;

    fn create_test_state(max_turns: u32) -> LoopState {
        let steering = SteeringCoordinator::new(Vec::new(), Default::default());
        let mut state = LoopState::new(
            "test-sess",
            max_turns,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        );
        state.machine.dispatch(E::Initialized).unwrap();
        state.machine.dispatch(E::InputReady).unwrap();
        state.machine.dispatch(E::TurnPrepared).unwrap();
        state.machine.dispatch(E::NoToolCalls).unwrap();
        assert_eq!(state.machine.state(), S::TurnComplete);
        state
    }

    #[tokio::test]
    async fn test_turn_complete_max_turns_zero_yields_suspended() {
        let mut state = create_test_state(0);
        state.machine.context_mut().turn_index = 100;
        let outcome = handle(&mut state).await.expect("handle success");
        // max_turns == 0 时，纯文本默认在 Step 5 以 YieldSuspended 收口，绝不触发 MaxTurns
        let end = outcome.end.as_ref().unwrap();
        assert_eq!(end.reason, AgentEndReason::YieldSuspended);
        assert!(end.yield_payload.is_some());
        assert_eq!(
            end.yield_payload.as_ref().unwrap().liveness,
            "no_pending_action"
        );
        assert_eq!(state.machine.state(), S::Done);
    }

    #[tokio::test]
    async fn test_turn_complete_max_turns_reached() {
        let mut state = create_test_state(1);
        assert_eq!(state.machine.context().turn_index, 1);
        let outcome = handle(&mut state).await.expect("handle success");
        assert_eq!(
            outcome.end.as_ref().unwrap().reason,
            AgentEndReason::MaxTurns
        );
        assert_eq!(state.machine.state(), S::Done);
    }

    #[tokio::test]
    async fn test_turn_complete_yield_suspended_final_step() {
        let mut state = create_test_state(10);
        state.machine.context_mut().turn_index = 3;
        state.machine.context_mut().tool_call_count = 0;
        assert!(!state.input_queue.has_runnable_pending());

        let outcome = handle(&mut state).await.expect("handle success");
        let end = outcome.end.expect("end decision present");
        assert_eq!(end.reason, AgentEndReason::YieldSuspended);
        let payload = end.yield_payload.expect("yield payload present");
        assert_eq!(payload.liveness, "no_pending_action");
        assert_eq!(payload.turns_executed, 3);
        assert_eq!(state.machine.state(), S::Done);
    }
}
