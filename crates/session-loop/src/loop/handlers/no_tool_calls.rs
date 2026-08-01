//! handleNoToolCalls（01 §2.6，tool-promise steering 已删除 D2）
//!
//! 触发：streaming 中消息无 tool-call。
//! 行为：
//!   1. stopReason=length：length 恢复阶梯——max_tokens 翻倍升级
//!      （8192→16384→32768，上限 2 次）→ resetSteeringCount +
//!      NO_PROGRESS_CONTINUE；阶梯用尽后 continue-nudge 上限内再试一次
//!      （01 §2.6 步骤 1；nudge 文本按 D8 不注入当前 run，仅重试）；
//!   2. 非 length：重置 length 计数器（01 §2.6 步骤 2）；
//!   3. resetSteeringCount（01 §2.6 步骤 3 / 01 §3.3 ③）；
//!   4. NO_TOOL_CALLS → turn-complete（纯文字回复 = 正常结束，01 D6）。
//!
//! 期望语义：无 tool-call 的纯文字回复 = 正常收场（永不 error，本次 bug 锚点）。

use conex_types::session::AgentSessionEvent as E;

use crate::stream::ConsumeStopReason;

use super::super::handlers::{dispatch, HandlerOutcome, LoopState};
use super::super::LoopError;

/// no-tool-calls handler（01 §2.6）
pub(crate) async fn handle(
    state: &mut LoopState,
    stop_reason: Option<ConsumeStopReason>,
) -> Result<HandlerOutcome, LoopError> {
    if stop_reason == Some(ConsumeStopReason::Length) {
        // length 恢复阶梯（01 §2.6 步骤 1）
        let upgrade_limit = state.options.length_upgrade_limit;
        if state.length_upgrades < upgrade_limit {
            state.length_upgrades += 1;
            state.max_tokens *= 2;
            // 01 §3.3 ②：length 升级时重置 steering 计数
            state.steering.reset();
            // 重进 provider 循环（更高 max_tokens）
            dispatch(state, E::NoProgressContinue)?;
            return Ok(HandlerOutcome::continue_run());
        }
        // 阶梯用尽：continue nudge 上限内再试一次（D8：不注入 nudge 文本，
        // 仅重试；上限 1）
        if state.continue_nudges < state.options.continue_nudge_limit {
            state.continue_nudges += 1;
            dispatch(state, E::NoProgressContinue)?;
            return Ok(HandlerOutcome::continue_run());
        }
        // 阶梯与 nudge 均用尽：正常收场（length 截断不视为错误）
    } else {
        // 非 length：重置 length 计数器（01 §2.6 步骤 2）
        state.length_upgrades = 0;
        state.continue_nudges = 0;
    }

    // 无 tool-call 正常结束：重置 steering 计数（01 §2.6 步骤 3 / 01 §3.3 ③）
    state.steering.reset();
    // NO_TOOL_CALLS → turn-complete（纯文字回复正常收场）
    dispatch(state, E::NoToolCalls)?;
    Ok(HandlerOutcome::continue_run())
}
