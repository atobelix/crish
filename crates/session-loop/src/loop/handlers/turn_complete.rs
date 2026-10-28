//! handleTurnComplete（收敛七级无阻塞阶梯）
//!
//! 触发：TurnComplete 状态。
//! 权威收敛顺序（优先级从高到低，严格杜绝内层睡眠阻塞）：
//!   - Step 0 控制中断：
//!     1. 安全点检查（check_control）；
//!     2. TurnEnd 事件广播并结算 usage；
//!     3. abort 信号检查（AbortSignal）；
//!     4. 上下文未决异常（Error / Aborted）。
//!   - Step 1 动态租约评估：
//!     动态核查实质物理推进并续订租约（try_renew_lease）。
//!   - Step 2 最大轮次硬限：
//!     核查 should_stop_for_max_turns（0 恒代表无上限），超限时按 MaxTurns 预算收场。
//!   - Step 3 排队输入检查：
//!     promote_follow_up 与 runnable 输入检查，有输入立即转入 InputAvailable 消费。
//!   - Step 4 工具调用存在性：
//!     tool_call_count > 0 续轮回路（NextTurn）。
//!   - Step 5 正常收场：
//!     外部钩子（turn_end_hook、插件广播、should_stop_after_turn）显式请求停机时分派 ShouldStop。
//!   - Step 6 挂起收口：
//!     既无工具调用又无排队输入时，立即原子分派 ShouldStop 并返回 YieldSuspended 决策，
//!     交由外层编排层释放排他锁并挂起等待事件（Reactive Wakeup），内层绝不 sleep 阻塞！

use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::session::AgentSessionEvent as E;

use super::super::end::EndDecision;
use super::super::handlers::{check_control, dispatch, HandlerOutcome, LoopState};
use super::super::{LoopError, TurnEndContext};

/// 默认单次租约追加轮次（对齐方案 04 §4.3）
#[allow(dead_code)]
pub const DEFAULT_LEASE_ADDITIONAL_TURNS: u32 = 64;

/// 默认租约预警余量（headroom：默认剩余 3 轮内评估续订）
pub const DEFAULT_LEASE_HEADROOM: u32 = 3;

/// 动态租约续订决策
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum LeaseRenewalDecision {
    /// 批准续订指定轮次（保持单调自增）
    Renew(u32),
    /// 拒绝续订（维持当前上限，按原预算流程收场）
    Deny,
}

/// 租约续订评估上下文
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct LeaseRenewalContext {
    pub session_id: String,
    pub turn_index: u32,
    pub max_turns: u32,
    pub tool_call_count: u32,
    pub has_pending_inputs: bool,
}

/// 动态租约守护接口（Lease Renewal Guard）
///
/// 当会话轮次逼近上限（max_turns > 0 且 is_approaching_lease_limit 或 should_stop_for_max_turns）时，
/// 供编排层/外部环境核查任务是否持续产生实质物理推进，并决定是否向状态机动态追加轮次租约。
pub trait LeaseRenewalGuard: Send + Sync {
    /// 评估是否应该为当前会话续订轮次租约
    fn evaluate_renewal(&self, context: &LeaseRenewalContext) -> LeaseRenewalDecision;
}

/// 基于实质物理推进判定续订的默认租约守护器
#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct SubstantiveProgressLeaseGuard {
    pub additional_turns: u32,
    pub max_total_turns: Option<u32>,
}

#[allow(dead_code)]
impl SubstantiveProgressLeaseGuard {
    pub fn new(additional_turns: u32) -> Self {
        Self {
            additional_turns,
            max_total_turns: None,
        }
    }

    pub fn with_cap(additional_turns: u32, max_total_turns: u32) -> Self {
        Self {
            additional_turns,
            max_total_turns: Some(max_total_turns),
        }
    }
}

impl LeaseRenewalGuard for SubstantiveProgressLeaseGuard {
    fn evaluate_renewal(&self, context: &LeaseRenewalContext) -> LeaseRenewalDecision {
        let has_progress = context.tool_call_count > 0 || context.has_pending_inputs;
        if !has_progress {
            return LeaseRenewalDecision::Deny;
        }
        if let Some(cap) = self.max_total_turns {
            if context.turn_index >= cap {
                return LeaseRenewalDecision::Deny;
            }
        }
        LeaseRenewalDecision::Renew(self.additional_turns)
    }
}

/// 尝试动态续订租约
///
/// 当 max_turns > 0 且任务逼近或达到上限时，若提供了 LeaseRenewalGuard 且判定批准，
/// 调用 machine.renew_budget 续订租约，保持单调自增。
pub fn try_renew_lease(
    state: &mut LoopState,
    guard: Option<&dyn LeaseRenewalGuard>,
    headroom: u32,
) -> bool {
    let ctx = state.machine.context().clone();
    if ctx.max_turns == 0 {
        return false;
    }
    // 逼近上限判定（默认剩余 headroom 轮以内或已达上限）
    if !ctx.is_approaching_lease_limit(headroom) && !ctx.should_stop_for_max_turns() {
        return false;
    }

    if let Some(g) = guard {
        let renewal_ctx = LeaseRenewalContext {
            session_id: ctx.session_id.clone(),
            turn_index: ctx.turn_index,
            max_turns: ctx.max_turns,
            tool_call_count: ctx.tool_call_count,
            has_pending_inputs: state.input_queue.has_runnable_pending(),
        };
        match g.evaluate_renewal(&renewal_ctx) {
            LeaseRenewalDecision::Renew(additional) if additional > 0 => {
                let old_max = ctx.max_turns;
                let new_budget = state.machine.renew_budget(additional);
                tracing::info!(
                    session_id = %ctx.session_id,
                    old_max_turns = old_max,
                    new_max_turns = new_budget,
                    additional_turns = additional,
                    "任务持续产生实质推进，动态租约已成功续订"
                );
                true
            }
            _ => false,
        }
    } else {
        false
    }
}

/// turn-complete handler（七级无阻塞决断阶梯）
pub(crate) async fn handle_with_guard(
    state: &mut LoopState,
    lease_guard: Option<&dyn LeaseRenewalGuard>,
) -> Result<HandlerOutcome, LoopError> {
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
    // Step 1: 动态租约评估（Lease Renewal Guard）
    // ─────────────────────────────────────────────────────────────
    // 若配置了租约守护，在逼近或达到上限且持续实质推进时尝试动态追加轮次
    try_renew_lease(state, lease_guard, DEFAULT_LEASE_HEADROOM);

    // ─────────────────────────────────────────────────────────────
    // Step 2: 最大轮次硬限核查（0 恒代表无上限）
    // ─────────────────────────────────────────────────────────────
    let ctx = state.machine.context().clone();
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
    // Step 3: 排队输入检查（优先消费已就绪人类插话或待命消息）
    // ─────────────────────────────────────────────────────────────
    let promoted = state.input_queue.promote_follow_up();
    if promoted > 0 || state.input_queue.has_runnable_pending() {
        dispatch(state, E::InputAvailable)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // ─────────────────────────────────────────────────────────────
    // Step 4: 工具调用存在性（有工具结果自驱续轮）
    // ─────────────────────────────────────────────────────────────
    if ctx.tool_call_count > 0 {
        dispatch(state, E::NextTurn)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // ─────────────────────────────────────────────────────────────
    // Step 5: 正常收场检查（外部或插件钩子显式请求停机）
    // ─────────────────────────────────────────────────────────────
    // 5.1 lifecycle turn.end 钩子的 stop 建议
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

    // 5.2 插件钩子 turn.end
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

    // 5.3 shouldStopAfterTurn 兼容层
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
    // Step 6: 终态无阻塞收场（原子返回 YieldSuspended 并交出执行权）
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

/// turn-complete handler（01 §2.9）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    handle_with_guard(state, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::end::AgentEndReason;
    use agent_tools::registry::ToolRegistry;
    use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};
    use crate::r#loop::handlers::LoopState;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::SteeringCoordinator;
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
        // max_turns == 0 时，纯文本默认在 Step 6 以 YieldSuspended 收口，绝不触发 MaxTurns
        let end = outcome.end.as_ref().unwrap();
        assert_eq!(end.reason, AgentEndReason::YieldSuspended);
        assert!(end.yield_payload.is_some());
        assert_eq!(end.yield_payload.as_ref().unwrap().liveness, "no_pending_action");
        assert_eq!(state.machine.state(), S::Done);
    }

    #[tokio::test]
    async fn test_turn_complete_max_turns_reached_without_guard() {
        let mut state = create_test_state(1);
        assert_eq!(state.machine.context().turn_index, 1);
        let outcome = handle(&mut state).await.expect("handle success");
        assert_eq!(outcome.end.as_ref().unwrap().reason, AgentEndReason::MaxTurns);
        assert_eq!(state.machine.state(), S::Done);
    }

    #[tokio::test]
    async fn test_turn_complete_lease_renewal_success_when_progressing() {
        let mut state = create_test_state(1);
        // 模拟当前轮有工具调用推进
        state.machine.context_mut().tool_call_count = 2;
        let guard = SubstantiveProgressLeaseGuard::new(64);
        let outcome = handle_with_guard(&mut state, Some(&guard))
            .await
            .expect("handle success");
        // 租约续订成功：max_turns 从 1 变为 65，放行续轮进入 NextTurn (PreparingTurn)
        assert_eq!(state.machine.context().max_turns, 65);
        assert!(outcome.end.is_none(), "应该继续运行而非终结");
        assert_eq!(state.machine.state(), S::PreparingTurn);
    }

    #[tokio::test]
    async fn test_turn_complete_lease_renewal_denied_when_no_progress() {
        let mut state = create_test_state(1);
        // 无工具调用且无排队输入
        state.machine.context_mut().tool_call_count = 0;
        let guard = SubstantiveProgressLeaseGuard::new(64);
        let outcome = handle_with_guard(&mut state, Some(&guard))
            .await
            .expect("handle success");
        // 无实质推进，拒绝续订，按 MaxTurns 收场
        assert_eq!(state.machine.context().max_turns, 1);
        assert_eq!(outcome.end.as_ref().unwrap().reason, AgentEndReason::MaxTurns);
        assert_eq!(state.machine.state(), S::Done);
    }

    #[tokio::test]
    async fn test_turn_complete_lease_renewal_denied_when_cap_reached() {
        let mut state = create_test_state(10);
        state.machine.context_mut().turn_index = 10;
        state.machine.context_mut().tool_call_count = 1;
        // 设定硬性上限 10
        let guard = SubstantiveProgressLeaseGuard::with_cap(64, 10);
        let outcome = handle_with_guard(&mut state, Some(&guard))
            .await
            .expect("handle success");
        assert_eq!(state.machine.context().max_turns, 10);
        assert_eq!(outcome.end.as_ref().unwrap().reason, AgentEndReason::MaxTurns);
        assert_eq!(state.machine.state(), S::Done);
    }

    #[tokio::test]
    async fn test_turn_complete_yield_suspended_step_six() {
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
