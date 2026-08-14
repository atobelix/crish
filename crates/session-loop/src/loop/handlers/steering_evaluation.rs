//! handleSteeringEvaluation（01 §2.7 + D3/D7/D9 裁决落点）
//!
//! 触发：STEERING_NEEDED（empty-response）。
//! 行为：
//!   1. **预注入短路（D3，仅本 handler）**：inputQueue 有可运行输入
//!      （force/steer）→ 直接 STEERING_COMPLETE，跳过策略评估避免重复注入；
//!   2. evaluate('empty-response')：无动作（coordinator 预算耗尽）→
//!      STEERING_BUDGET_EXHAUSTED → **stop 收场**（不 error，D9）；
//!   3. apply：interventionRequired → INTERVENTION_REQUIRED 事件照发但
//!      **stop 收场**（D7 裁决，00 D6：空响应 = 模型输出异常而非任务失败）；
//!      否则 STEERING_COMPLETE → preparing-turn（重进 provider 循环）。
//!
//! 预算语义（01 §3.3 / D10）：单一计数源在 coordinator（本 handler 不
//! 直接读机器上下文 steeringCount 死检查）；策略层 maxSteeringMessages=1
//! 默认——第 1 次空响应注入、第 2 次即 intervention（D7 二次即干预）。

use conex_types::session::AgentSessionEvent as E;

use crate::steering::SteeringPhase;

use super::super::end::EndDecision;
use super::super::handlers::{dispatch, steering_context, HandlerOutcome, LoopState};
use super::super::LoopError;

/// steering-evaluation handler（01 §2.7）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    // 0. 防御性短路（T06.2.1 Q03）：steering_enabled=false 时 empty-response
    //    不可恢复——正常路径已在 streaming.rs 的 Empty 分支短路，此处防
    //    未来新路径直接进入本状态
    if !state.options.steering_enabled {
        return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
            state,
            "steering 已禁用，空响应无法恢复",
        )));
    }

    // 1. 预注入短路（D3）：有可运行输入（force/steer）直接重进 provider 循环，
    //    避免对已注入内容重复 steering
    if state.input_queue.has_runnable_pending() {
        dispatch(state, E::SteeringComplete)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // 2-3. 评估并执行（budget / intervention 由 coordinator 与策略掌管）
    let (actions, trace) = state
        .steering
        .evaluate_traced(SteeringPhase::EmptyResponse, &steering_context(state));
    // EV-03（D-03）：evaluate 命中/跳过聚合发射——每次评估一条
    // steering-evaluated（含无动作空命中；reset=false；预算剩余 =
    // max_steering_budget − 潜在计数）
    state.events.push(crate::steering::steering_evaluated_event(
        &state.machine.context().session_id,
        SteeringPhase::EmptyResponse.as_str(),
        &trace,
        Some(state.steering.budget_remaining()),
        false,
    ));
    if actions.is_empty() {
        // 预算耗尽且无任何动作（含 intervention）：D9 → stop 收场，不 error
        tracing::info!(
            steering_count = state.steering.get_steering_count(),
            "steering 预算耗尽"
        );
        dispatch(state, E::SteeringBudgetExhausted)?;
        return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
            state,
            "steering 预算耗尽（empty-response 连续触发）",
        )));
    }

    let session_id = state.machine.context().session_id.clone();
    tracing::info!(action_count = actions.len(), "steering 注入");
    let applied = state
        .steering
        .apply(&actions, &session_id, &mut state.conversation);
    state.events.extend(applied.events);

    if applied.intervention_required {
        // D7 裁决：intervention 事件照发，run 以 stop + 诊断收场（不 error）
        dispatch(state, E::InterventionRequired)?;
        return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
            state,
            crate::steering::DEFAULT_INTERVENTION_MESSAGE,
        )));
    }

    // 注入完成：STEERING_COMPLETE → preparing-turn（重进 provider 循环，01 §1.4）
    dispatch(state, E::SteeringComplete)?;
    Ok(HandlerOutcome::continue_run())
}
