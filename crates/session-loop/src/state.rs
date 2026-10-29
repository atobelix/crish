//! 会话状态机内核（B3.1，对齐 01 §1.1-1.6 / §五.1-2）
//!
//! [AgentSessionMachine] 持有当前状态与上下文；转移表本体复用 conex-types
//! 的 [apply_transition]（B1.2 产出，01 §1.4 全表逐行穷举），本层负责：
//! - 状态保持（初始 idle）与终态守卫（done 拒绝任何事件）；
//! - 转移成功后应用上下文 effect（01 §1.4「上下文 effect」列）；
//! - endReason patch 语义（01 §1.5：error 收场仅由 §1.6 四事件产生，
//!   max-turns 为独立预算 reason，cooperative_stop 不 abort）。
//!
//! 未定义转移返回显式 [TransitionError]（01 §五.1：不得静默忽略），
//! 且失败时机器状态与上下文均不改变（先查表后变更）。
//!
//! 说明：HAS_TOOL_CALLS 的载荷（count）已内嵌在事件枚举变体中，
//! 故 dispatch 只需接收事件本身，无需单独的 payload 参数。

use conex_types::session::{AgentSessionContext, AgentSessionEvent, AgentSessionState};
use conex_types::transition::{apply_transition, TransitionError};

/// 会话状态机实例
///
/// 对应 TS 端 `createAgentSessionMachine` 产物（agent-session.ts:234-260）。
/// 初始状态 idle、初始上下文见 [AgentSessionContext::initial]。
#[derive(Debug, Clone)]
pub struct AgentSessionMachine {
    state: AgentSessionState,
    context: AgentSessionContext,
}

impl AgentSessionMachine {
    /// 新建状态机（idle + 初始上下文）
    pub fn new(session_id: impl Into<String>, max_turns: u32) -> Self {
        Self {
            state: AgentSessionState::Idle,
            context: AgentSessionContext::initial(session_id, max_turns),
        }
    }

    /// 当前状态
    pub fn state(&self) -> AgentSessionState {
        self.state
    }

    /// 当前上下文（只读）
    pub fn context(&self) -> &AgentSessionContext {
        &self.context
    }

    /// 测试注入点（F1-03 溢出/边界单测构造 u32::MAX 等极值用；
    /// 生产路径无改写面——仅测试构建编译）
    #[cfg(test)]
    pub(crate) fn context_mut(&mut self) -> &mut AgentSessionContext {
        &mut self.context
    }

    /// 是否到达终态 done
    pub fn is_done(&self) -> bool {
        self.state == AgentSessionState::Done
    }

    /// 分派一次事件（payload 内嵌于事件变体，如 HAS_TOOL_CALLS { count }）
    ///
    /// 成功：应用 endReason patch 与上下文 effect，推进到目标状态。
    /// 失败（未定义转移 / 终态）：返回 [TransitionError]，状态与上下文不变。
    pub fn dispatch(&mut self, event: AgentSessionEvent) -> Result<(), TransitionError> {
        let transition = apply_transition(self.state, event)?;
        self.apply_transition(transition);
        Ok(())
    }

    /// 应用转移结果（endReason patch + 上下文 effect + 状态推进）
    fn apply_transition(&mut self, transition: conex_types::transition::AgentTransition) {
        // endReason patch（01 §1.4「endReason」列：其余转移不改）
        if let Some(reason) = transition.end_reason {
            self.context.end_reason = reason;
        }
        // 上下文 effect（01 §1.4「上下文 effect」列）
        let effect = transition.effect;
        if effect.turn_index_increment {
            // F1-03：saturating 递增——u32::MAX 时不得溢出（debug panic /
            // release 回绕归零 → max-turns 预算失效）；饱和后
            // `turn_index >= max_turns` 判定照常收敛
            self.context.turn_index = self.context.turn_index.saturating_add(1);
        }
        if effect.reset_tool_call_count {
            self.context.tool_call_count = 0;
        }
        if let Some(count) = effect.set_tool_call_count {
            self.context.tool_call_count = count;
        }
        // turn-complete INPUT_AVAILABLE：单 Run 内部 turn_index 单调自增不重置（01A/01B 核心重构）
        if effect.reset_all_counters {
            self.context.tool_call_count = 0;
            self.context.steering_count = 0;
        }
        self.state = transition.to;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::session::{
        AgentEndReason as R, AgentSessionEvent as E, AgentSessionState as S,
    };

    fn machine() -> AgentSessionMachine {
        AgentSessionMachine::new("sess-1", 16)
    }

    fn all_states() -> [AgentSessionState; 8] {
        [
            S::Idle,
            S::AwaitingInput,
            S::PreparingTurn,
            S::Streaming,
            S::SteeringEvaluation,
            S::ExecutingTools,
            S::TurnComplete,
            S::Done,
        ]
    }

    fn all_events() -> [AgentSessionEvent; 20] {
        [
            E::Initialized,
            E::InputReady,
            E::NoInput,
            E::TurnPrepared,
            E::HasToolCalls { count: 3 },
            E::NoToolCalls,
            E::NoProgressContinue,
            E::ToolsComplete,
            E::InputAvailable,
            E::NextTurn,
            E::ShouldStop,
            E::Abort,
            E::Error,
            E::MaxTurnsReached,
            E::InterventionRequired,
            E::ProviderError,
            E::Finish,
            E::SteeringNeeded,
            E::SteeringComplete,
            E::SteeringBudgetExhausted,
        ]
    }

    /// 把机器推到指定状态的辅助函数（沿 01 §1.4 已定义路径）
    fn goto(m: &mut AgentSessionMachine, target: S) {
        let path: &[(S, E)] = match target {
            S::Idle => &[],
            S::AwaitingInput => &[(S::Idle, E::Initialized)],
            S::PreparingTurn => &[(S::Idle, E::Initialized), (S::AwaitingInput, E::InputReady)],
            S::Streaming => &[
                (S::Idle, E::Initialized),
                (S::AwaitingInput, E::InputReady),
                (S::PreparingTurn, E::TurnPrepared),
            ],
            S::SteeringEvaluation => &[
                (S::Idle, E::Initialized),
                (S::AwaitingInput, E::InputReady),
                (S::PreparingTurn, E::TurnPrepared),
                (S::Streaming, E::SteeringNeeded),
            ],
            S::ExecutingTools => &[
                (S::Idle, E::Initialized),
                (S::AwaitingInput, E::InputReady),
                (S::PreparingTurn, E::TurnPrepared),
                (S::Streaming, E::HasToolCalls { count: 2 }),
            ],
            S::TurnComplete => &[
                (S::Idle, E::Initialized),
                (S::AwaitingInput, E::InputReady),
                (S::PreparingTurn, E::TurnPrepared),
                (S::Streaming, E::NoToolCalls),
            ],
            S::Done => &[
                (S::Idle, E::Initialized),
                (S::AwaitingInput, E::InputReady),
                (S::PreparingTurn, E::TurnPrepared),
                (S::Streaming, E::NoToolCalls),
                (S::TurnComplete, E::ShouldStop),
            ],
        };
        for &(state, event) in path {
            assert_eq!(m.state(), state, "辅助路径前置状态不符");
            m.dispatch(event).expect("辅助路径转移应已定义");
        }
        assert_eq!(m.state(), target);
    }

    /// 01 §1.4 转移表逐行测试（33 条已定义转移，经机器 dispatch 全量覆盖）
    ///
    /// 注：任务书 B3.1 验收写「46 行」，01 §1.4 表实际为 33 行已定义转移
    /// （与 agent-session.ts:69-232 逐字节核对一致），此处按权威表逐行断言。
    #[test]
    fn transition_table_rows_through_machine() {
        // ── idle（2 行）──
        {
            let mut m = machine();
            m.dispatch(E::Initialized).unwrap();
            assert_eq!(m.state(), S::AwaitingInput);
            assert_eq!(m.context().end_reason, R::Stop);
        }
        {
            let mut m = machine();
            m.dispatch(E::Error).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Error);
        }
        // ── awaiting-input（4 行）──
        {
            let mut m = machine();
            goto(&mut m, S::AwaitingInput);
            m.dispatch(E::InputReady).unwrap();
            assert_eq!(m.state(), S::PreparingTurn);
            assert_eq!(m.context().end_reason, R::Stop);
        }
        {
            let mut m = machine();
            goto(&mut m, S::AwaitingInput);
            m.dispatch(E::NoInput).unwrap();
            assert_eq!(m.state(), S::Done);
            // NO_INPUT 默认 stop 收场，不 patch
            assert_eq!(m.context().end_reason, R::Stop);
        }
        {
            let mut m = machine();
            goto(&mut m, S::AwaitingInput);
            m.dispatch(E::Abort).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Aborted);
        }
        {
            let mut m = machine();
            goto(&mut m, S::AwaitingInput);
            m.dispatch(E::Error).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Error);
        }
        // ── preparing-turn（4 行）──
        {
            let mut m = machine();
            goto(&mut m, S::PreparingTurn);
            m.dispatch(E::TurnPrepared).unwrap();
            assert_eq!(m.state(), S::Streaming);
            // effect：turnIndex+1
            assert_eq!(m.context().turn_index, 1);
        }
        {
            let mut m = machine();
            goto(&mut m, S::PreparingTurn);
            m.dispatch(E::InterventionRequired).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Error);
        }
        {
            let mut m = machine();
            goto(&mut m, S::PreparingTurn);
            m.dispatch(E::Abort).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Aborted);
        }
        {
            let mut m = machine();
            goto(&mut m, S::PreparingTurn);
            m.dispatch(E::Error).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Error);
        }
        // ── streaming（8 行）──
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::HasToolCalls { count: 3 }).unwrap();
            assert_eq!(m.state(), S::ExecutingTools);
            assert_eq!(m.context().tool_call_count, 3);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::NoToolCalls).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Stop);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::SteeringNeeded).unwrap();
            assert_eq!(m.state(), S::SteeringEvaluation);
            // 不 bump steeringCount（01 §1.4 注：预算由策略/coordinator 掌管）
            assert_eq!(m.context().steering_count, 0);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::NoProgressContinue).unwrap();
            assert_eq!(m.state(), S::PreparingTurn);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::InterventionRequired).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Error);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::Abort).unwrap();
            // 抢救已产出内容：streaming 中 abort 只推进到 turn-complete
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Aborted);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::ProviderError).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Error);
        }
        {
            let mut m = machine();
            goto(&mut m, S::Streaming);
            m.dispatch(E::Error).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Error);
        }
        // ── steering-evaluation（5 行）──
        {
            let mut m = machine();
            goto(&mut m, S::SteeringEvaluation);
            m.dispatch(E::SteeringComplete).unwrap();
            // 注入完成后必须重进 provider 循环，不停止本轮
            assert_eq!(m.state(), S::PreparingTurn);
        }
        {
            let mut m = machine();
            goto(&mut m, S::SteeringEvaluation);
            m.dispatch(E::SteeringBudgetExhausted).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Error);
        }
        {
            let mut m = machine();
            goto(&mut m, S::SteeringEvaluation);
            m.dispatch(E::InterventionRequired).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Error);
        }
        {
            let mut m = machine();
            goto(&mut m, S::SteeringEvaluation);
            m.dispatch(E::Abort).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Aborted);
        }
        {
            let mut m = machine();
            goto(&mut m, S::SteeringEvaluation);
            m.dispatch(E::Error).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Error);
        }
        // ── executing-tools（4 行）──
        {
            let mut m = machine();
            goto(&mut m, S::ExecutingTools);
            m.dispatch(E::ToolsComplete).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
        }
        {
            let mut m = machine();
            goto(&mut m, S::ExecutingTools);
            m.dispatch(E::InputAvailable).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
        }
        {
            let mut m = machine();
            goto(&mut m, S::ExecutingTools);
            m.dispatch(E::Abort).unwrap();
            // 保留已产出内容：只推进到 turn-complete
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Aborted);
        }
        {
            let mut m = machine();
            goto(&mut m, S::ExecutingTools);
            m.dispatch(E::Error).unwrap();
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(m.context().end_reason, R::Error);
        }
        // ── turn-complete（6 行）──
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            m.dispatch(E::InputAvailable).unwrap();
            assert_eq!(m.state(), S::AwaitingInput);
            assert_eq!(m.context().end_reason, R::Stop);
        }
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            m.dispatch(E::NextTurn).unwrap();
            assert_eq!(m.state(), S::PreparingTurn);
        }
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            m.dispatch(E::MaxTurnsReached).unwrap();
            assert_eq!(m.state(), S::Done);
            // max-turns 独立预算 reason，非 error 非 aborted（01 §1.5）
            assert_eq!(m.context().end_reason, R::MaxTurns);
        }
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            m.dispatch(E::ShouldStop).unwrap();
            assert_eq!(m.state(), S::Done);
            // 协作停止：默认 stop 收场，不 abort（D1 裁决）
            assert_eq!(m.context().end_reason, R::Stop);
        }
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            m.dispatch(E::Abort).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Aborted);
        }
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            m.dispatch(E::Finish).unwrap();
            assert_eq!(m.state(), S::Done);
            assert_eq!(m.context().end_reason, R::Stop);
        }
    }

    /// 未定义转移返回显式错误（01 §五.1：不得静默忽略）
    #[test]
    fn undefined_transitions_return_explicit_error() {
        // done 为终态：任何事件都拒绝（01 §1.4 最后一行）
        let mut m = machine();
        goto(&mut m, S::Done);
        for event in all_events() {
            assert_eq!(m.dispatch(event), Err(TransitionError::Terminal));
            assert_eq!(m.state(), S::Done, "失败时状态不得改变");
        }
        // turn-complete 没有 ERROR 转移（01 §1.4 表尾注：经 recovery 映射为 FINISH）
        {
            let mut m = machine();
            goto(&mut m, S::TurnComplete);
            assert!(matches!(
                m.dispatch(E::Error),
                Err(TransitionError::Undefined {
                    state: S::TurnComplete,
                    event: E::Error
                })
            ));
            assert_eq!(m.state(), S::TurnComplete);
            assert_eq!(
                m.context().end_reason,
                R::Stop,
                "失败时 endReason 不得被 patch"
            );
        }
        // 其余状态抽样：未定义组合必须显式失败且状态不变
        for (target, event) in [
            (S::Idle, E::TurnPrepared),
            (S::AwaitingInput, E::ShouldStop),
            (S::Streaming, E::Finish),
            (S::ExecutingTools, E::NoToolCalls),
            (S::SteeringEvaluation, E::SteeringNeeded),
            (S::PreparingTurn, E::SteeringComplete),
        ] {
            let mut m = machine();
            goto(&mut m, target);
            assert!(matches!(
                m.dispatch(event),
                Err(TransitionError::Undefined { .. })
            ));
            assert_eq!(m.state(), target, "失败时状态不得改变");
        }
    }

    /// 全 160 对（8 态 × 20 事件）：要么合法转移要么显式错误
    #[test]
    fn every_state_event_pair_is_defined_or_explicitly_undefined() {
        let mut defined = 0usize;
        let mut undefined = 0usize;
        for state in all_states() {
            for event in all_events() {
                let mut m = machine();
                goto(&mut m, state);
                match m.dispatch(event) {
                    Ok(()) => defined += 1,
                    Err(TransitionError::Undefined { .. }) | Err(TransitionError::Terminal) => {
                        undefined += 1
                    }
                }
            }
        }
        // 01 §1.4 表：33 条已定义转移
        assert_eq!(defined, 33);
        assert_eq!(undefined, 8 * 20 - 33);
    }

    /// F1-03（红→绿）：turn_index u32 溢出防护——u32::MAX 时 TURN_PREPARED
    /// 不得 panic（修复前 debug 构建 `+= 1` 溢出 panic；release 回绕归零 →
    /// should_stop_for_max_turns 失效 → max-turns 预算被绕过）。
    /// 饱和保持后 `turn_index >= max_turns` 判定照常收敛（F1-03 修复契约）。
    #[test]
    fn turn_index_saturates_at_u32_max() {
        let mut m = machine();
        goto(&mut m, S::PreparingTurn);
        m.context.turn_index = u32::MAX;
        m.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(
            m.context().turn_index,
            u32::MAX,
            "turn_index 必须饱和保持，不得回绕归零（max-turns 预算失效）"
        );
        assert_eq!(m.state(), S::Streaming, "饱和不改变转移语义");
    }

    /// effect 测试：TURN_PREPARED 递增 turnIndex 并重置 toolCallCount
    #[test]
    fn effect_turn_prepared_increments_turn_and_resets_tool_calls() {
        let mut m = machine();
        goto(&mut m, S::PreparingTurn);
        // 预置脏计数（模拟上一轮残留）
        m.context.tool_call_count = 7;
        m.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(m.context().turn_index, 1);
        assert_eq!(m.context().tool_call_count, 0);
        // 第二轮：NO_PROGRESS_CONTINUE 重进准备（01 §1.4 表内已定义路径）
        m.dispatch(E::NoProgressContinue).unwrap();
        assert_eq!(m.state(), S::PreparingTurn);
        m.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(m.context().turn_index, 2);
    }

    /// effect 测试：HAS_TOOL_CALLS 置 toolCallCount = 载荷 count
    #[test]
    fn effect_has_tool_calls_sets_count_from_payload() {
        let mut m = machine();
        goto(&mut m, S::Streaming);
        m.dispatch(E::HasToolCalls { count: 5 }).unwrap();
        assert_eq!(m.context().tool_call_count, 5);
    }

    /// effect 测试：turn-complete INPUT_AVAILABLE 保持 turn_index 单调自增，重置工具调用计数
    #[test]
    fn effect_input_available_preserves_turn_index() {
        let mut m = machine();
        goto(&mut m, S::TurnComplete);
        // 预置本轮积累的计数
        m.context.turn_index = 3;
        m.context.tool_call_count = 4;
        m.context.steering_count = 1;
        m.dispatch(E::InputAvailable).unwrap();
        assert_eq!(
            m.context().turn_index,
            3,
            "turn_index 在单 Run 内必须单调保持，不可归零导致前端覆写"
        );
        assert_eq!(m.context().tool_call_count, 0);
        assert_eq!(m.state(), S::AwaitingInput);
    }

    /// effect 测试：无副作用转移不改任何上下文字段
    #[test]
    fn plain_transitions_do_not_touch_context() {
        let mut m = machine();
        goto(&mut m, S::TurnComplete);
        m.context.turn_index = 2;
        m.context.tool_call_count = 1;
        m.context.steering_count = 0;
        m.dispatch(E::NextTurn).unwrap();
        assert_eq!(m.context().turn_index, 2);
        assert_eq!(m.context().tool_call_count, 1);
        assert_eq!(m.context().end_reason, R::Stop);
        assert_eq!(m.state(), S::PreparingTurn);
    }

    /// endReason 语义：error 收场仅由 01 §1.6 四事件产生
    #[test]
    fn error_end_reason_only_from_the_four_events() {
        let mut error_terminals = 0usize;
        for state in all_states() {
            for event in all_events() {
                let mut m = machine();
                goto(&mut m, state);
                if m.dispatch(event).is_ok() && m.context().end_reason == R::Error {
                    error_terminals += 1;
                    assert!(
                        matches!(
                            event,
                            E::Error
                                | E::InterventionRequired
                                | E::ProviderError
                                | E::SteeringBudgetExhausted
                        ),
                        "事件 {event:?} 不得产生 error 收场（01 §1.6）"
                    );
                }
            }
        }
        // 表中共 11 行 error 收场
        assert_eq!(error_terminals, 11);
    }

    /// max-turns 独立预算 reason：MAX_TURNS_REACHED 以 max-turns 收场（01 §1.5）
    #[test]
    fn max_turns_is_independent_budget_reason() {
        let mut m = machine();
        goto(&mut m, S::TurnComplete);
        m.dispatch(E::MaxTurnsReached).unwrap();
        assert_eq!(m.context().end_reason, R::MaxTurns);
        assert!(matches!(m.context().end_reason, R::MaxTurns));
        assert!(!matches!(m.context().end_reason, R::Error | R::Aborted));
    }

    /// D1：cooperative_stop 推 SM 到 done、不 abort
    ///
    /// 安全点语义（01 §2.10）：cooperative_stop 按当前状态走
    /// NO_TOOL_CALLS/TOOLS_COMPLETE + SHOULD_STOP 路径，不触发 ABORT。
    #[test]
    fn cooperative_stop_drives_machine_to_done_without_abort() {
        // streaming 安全点
        let mut m = machine();
        goto(&mut m, S::Streaming);
        m.dispatch(E::NoToolCalls).unwrap();
        m.dispatch(E::ShouldStop).unwrap();
        assert_eq!(m.state(), S::Done);
        assert_ne!(m.context().end_reason, R::Aborted, "协作停止不 abort");
        assert_eq!(m.context().end_reason, R::Stop);

        // executing-tools 安全点
        let mut m = machine();
        goto(&mut m, S::ExecutingTools);
        m.dispatch(E::ToolsComplete).unwrap();
        m.dispatch(E::ShouldStop).unwrap();
        assert_eq!(m.state(), S::Done);
        assert_ne!(m.context().end_reason, R::Aborted);

        // turn-complete 安全点
        let mut m = machine();
        goto(&mut m, S::TurnComplete);
        m.dispatch(E::ShouldStop).unwrap();
        assert_eq!(m.state(), S::Done);
        assert_ne!(m.context().end_reason, R::Aborted);
    }
}
