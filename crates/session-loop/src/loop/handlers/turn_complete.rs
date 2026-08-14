//! handleTurnComplete（01 §2.9，决策顺序按 §五.7 / 任务书 B3.4）
//!
//! 触发：turn-complete。
//! 决策顺序（优先级从高到低）：
//!   1. `turn-end` 事件（toolCallCount 供观测）；
//!   2. abortReason / abort 信号 → FINISH + aborted；
//!   3. ctx.endReason==error/aborted → FINISH + 对应 reason
//!      （streaming PROVIDER_ERROR / executing-tools ERROR 经此收敛）；
//!   4. lifecycle turn.end 钩子的 stop 建议 → SHOULD_STOP
//!      （**与 shouldStopAfterTurn 合并时以 turn.end 为准**，01 遗留问题 3）；
//! - 插件钩子 turn.end（步骤 4.5；HookRegistry 广播；handler Block = stop 建议。
//!   propagate 失败记录日志后继续收场，不中断会话——与 tool.pre 的
//!   propagate（降级为工具错误结果）语义一致：钩子失败不打断执行流）；
//!   5. maxTurns（turnIndex >= maxTurns）→ runtime-error 观测事件 +
//!   MAX_TURNS_REACHED（独立预算 reason，非错误非中止，01 §1.5）；
//!   6. shouldStopAfterTurn 兼容层 → SHOULD_STOP；
//!   7. toolCallCount > 0 → NEXT_TURN；
//!   8. idle 输入（followUp 仅在此 promote）→ INPUT_AVAILABLE；
//!   9. 默认 SHOULD_STOP（stop 收场）。
//!
//! 自终止诊断（D2/D4 裁决）：tool-promise 机制删除；诊断事件保留为
//! 非 error 语义（本任务无计数源，字段结构见 steering::diagnostics）。

use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::session::{AgentEndReason, AgentSessionEvent as E};

use super::super::end::EndDecision;
use super::super::handlers::{check_control, dispatch, HandlerOutcome, LoopState};
use super::super::{LoopError, TurnEndContext};

/// turn-complete handler（01 §2.9）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    // 0. 安全点检查（进入 turn-complete 的控制意图：L3 / L2 / L1）
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 1. turn-end 事件（01 §2.9 步骤 1）
    let ctx = state.machine.context().clone();
    state.events.push(AgentEvent::TurnEnd {
        session_id: ctx.session_id.clone(),
        turn_index: ctx.turn_index,
        timestamp: crate::steering::now_iso_utc(),
        tool_call_count: ctx.tool_call_count,
        // D-03 契约窗口（EV-11/EV-13）：turn 级 usage 真值——streaming
        // consume 后写入槽位（六字段：prompt/completion/total/cache_read/
        // cache_write/cache_miss tokens），provider 未报告时 None（旧帧
        // 缺省兼容；take 消费防同一槽位被二次发射复用）
        usage: state.turn_usage.take(),
    });
    // EV-08：正常发射完成，清除未闭合 turn 标记（收敛路径兜底补发不再触发；
    // turn-complete 起始的 check_control 收敛由 check_control 内单点兜底）
    state.current_turn_index = None;

    // 2. abort 检查 → FINISH + aborted（01 §2.9 步骤 2）
    if state.abort_signal.is_aborted() {
        dispatch(state, E::Finish)?;
        return Ok(HandlerOutcome::end(EndDecision::aborted(state)));
    }

    // 3. ctx.endReason error/aborted → FINISH + 对应 reason（01 §2.9 步骤 3；
    //    streaming PROVIDER_ERROR / executing-tools ERROR 经此收敛）
    match ctx.end_reason {
        AgentEndReason::Error => {
            let terminal = state.terminal_error.take().unwrap_or_else(|| {
                // Q31（T06.5.5）：兜底文案携带状态机状态与事件类型，人读可定位
                let machine_state = state.machine.state();
                format!("run 失败（状态={machine_state:?}，事件=Error 收场）")
            });
            dispatch(state, E::Finish)?;
            return Ok(HandlerOutcome::end(EndDecision::error(state, terminal)));
        }
        AgentEndReason::Aborted => {
            dispatch(state, E::Finish)?;
            return Ok(HandlerOutcome::end(EndDecision::aborted(state)));
        }
        _ => {}
    }

    // 4. lifecycle turn.end 钩子的 stop 建议（01 §2.9 步骤 5 / 遗留问题 3：
    //    与 shouldStopAfterTurn 合并时以此为准）
    let stop_suggested = state
        .options
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

    // 4.5 插件钩子 turn.end（HookRegistry 广播；handler Block = stop 建议，
    //    优先级低于编排层 turn_end_hook、高于 maxTurns）。
    //    propagate 失败：记录日志后继续收场（钩子失败不中断收场流程，
    //    与 tool.pre 的 propagate 降级语义一致，见 hooks.rs 模块头注）。
    if let Some(hooks) = &state.options.hooks {
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

    // 5. maxTurns（shouldStopForMaxTurns = turnIndex >= maxTurns，01 §2.9 步骤 4）
    if ctx.should_stop_for_max_turns() {
        // runtime-error 观测事件（retryable=true 纯观测；max-turns 不是错误，
        // 01 §1.5 / 05 §2.8 对齐 core:index.ts:593-608）
        state.events.push(AgentEvent::RuntimeError {
            session_id: ctx.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            error: format!(
                "maxTurns 预算用尽（turnIndex={}，maxTurns={}）",
                ctx.turn_index, ctx.max_turns
            ),
            retryable: Some(true),
        });
        // I8-E1 第二批：error.occurred 钩子广播（runtime-error 事件同点位；
        // observe 默认，失败吞掉 + 计数，收场流程继续）
        if let Some(hooks) = &state.options.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::ErrorOccurred {
                    session_id: ctx.session_id.clone(),
                    error: format!(
                        "maxTurns 预算用尽（turnIndex={}，maxTurns={}）",
                        ctx.turn_index, ctx.max_turns
                    ),
                    retryable: true,
                })
                .await;
        }
        // 错误日志（T04.3-3，点位同 T04.2-2）：max-turns 边界按类型化错误码
        // 记录（纯观测事件：retryable=true 只表可重试，与收场 reason=max-turns 正交）
        tracing::error!(
            target: "run",
            event = "runtime_error",
            error_code = %codes::AGENT_MAX_TURNS_REACHED,
            retryable = true,
            "maxTurns 预算用尽"
        );
        dispatch(state, E::MaxTurnsReached)?;
        return Ok(HandlerOutcome::end(EndDecision::max_turns(state)));
    }

    // 6. shouldStopAfterTurn 兼容层（无 turn_end_hook 时生效；01 遗留问题 3）
    let should_stop = state
        .options
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

    // 7. toolCallCount > 0 → NEXT_TURN（有工具结果续轮，01 §2.9 步骤 6）
    if ctx.tool_call_count > 0 {
        dispatch(state, E::NextTurn)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // 8. idle 输入：followUp 仅在此 promote（01 §2.9 步骤 6 / 01 §五.5）；
    //    promote 后或已有可运行输入 → INPUT_AVAILABLE（awaiting-input，
    //    轮次计数归零）
    let promoted = state.input_queue.promote_follow_up();
    if promoted > 0 || state.input_queue.has_runnable_pending() {
        dispatch(state, E::InputAvailable)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // 9. 默认：SHOULD_STOP（stop 收场，纯文字回复的收口路径）
    dispatch(state, E::ShouldStop)?;
    Ok(HandlerOutcome::end(EndDecision::stop(state)))
}
