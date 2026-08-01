//! 会话状态机转移表（01 §1.4 穷举实现）
//!
//! 未定义转移返回显式错误（对应 TS 的 INVALID_TRANSITION 抛错，
//! 01 §五.1），不得静默忽略。endReason 语义按 01 §1.5/§1.6：
//! error 收场仅由 ERROR / INTERVENTION_REQUIRED / PROVIDER_ERROR /
//! STEERING_BUDGET_EXHAUSTED 四个事件产生。
//!
//! 注意：turn-complete 没有 ERROR 转移（01 §1.4 表尾注）——
//! 该状态下的致命错误经 recovery 映射为 FINISH。

use crate::session::{AgentEndReason, AgentSessionEvent, AgentSessionState};

/// 转移的上下文效果（01 §1.4「上下文 effect」列）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentTransitionEffect {
    /// TURN_PREPARED：turnIndex + 1
    pub turn_index_increment: bool,
    /// TURN_PREPARED：toolCallCount 归零
    pub reset_tool_call_count: bool,
    /// HAS_TOOL_CALLS：toolCallCount 置为载荷 count
    pub set_tool_call_count: Option<u32>,
    /// turn-complete INPUT_AVAILABLE：turnIndex/toolCallCount/steeringCount 全归零
    pub reset_all_counters: bool,
}

impl AgentTransitionEffect {
    /// 无副作用
    pub fn none() -> Self {
        Self::default()
    }
}

/// 一次合法转移的结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTransition {
    /// 目标状态
    pub to: AgentSessionState,
    /// 若为 Some，本次转移把上下文 endReason 置为该值（其余转移不改）
    pub end_reason: Option<AgentEndReason>,
    /// 上下文计数效果
    pub effect: AgentTransitionEffect,
}

impl AgentTransition {
    fn plain(to: AgentSessionState) -> Self {
        Self {
            to,
            end_reason: None,
            effect: AgentTransitionEffect::none(),
        }
    }

    fn with_end_reason(to: AgentSessionState, end_reason: AgentEndReason) -> Self {
        Self {
            to,
            end_reason: Some(end_reason),
            effect: AgentTransitionEffect::none(),
        }
    }

    fn with_effect(to: AgentSessionState, effect: AgentTransitionEffect) -> Self {
        Self {
            to,
            end_reason: None,
            effect,
        }
    }
}

/// 未定义转移的显式错误
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransitionError {
    /// done 为终态，不接受任何事件（01 §1.4 最后一行）
    #[error("终态 done 不接受任何事件")]
    Terminal,
    /// 该（状态, 事件）组合未定义（01 §1.4 转移表之外）
    #[error("未定义转移：{state:?} + {event:?}")]
    Undefined {
        state: AgentSessionState,
        event: AgentSessionEvent,
    },
}

/// 转移表（01 §1.4 逐行实现）
///
/// 穷举所有已定义组合；未定义组合落入各状态的兜底分支返回
/// [TransitionError::Undefined]。转移表正确性由
/// tests 目录的穷举用例（8 态 × 20 事件全对）锚定。
pub fn apply_transition(
    state: AgentSessionState,
    event: AgentSessionEvent,
) -> Result<AgentTransition, TransitionError> {
    use AgentEndReason::{Aborted, Error, MaxTurns};
    use AgentSessionEvent as E;
    use AgentSessionState as S;

    match state {
        // ── idle ──
        S::Idle => match event {
            E::Initialized => Ok(AgentTransition::plain(S::AwaitingInput)),
            E::Error => Ok(AgentTransition::with_end_reason(S::Done, Error)),
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── awaiting-input ──
        S::AwaitingInput => match event {
            E::InputReady => Ok(AgentTransition::plain(S::PreparingTurn)),
            // NO_INPUT 默认 stop 收场（初始 endReason 即 stop，不 patch）
            E::NoInput => Ok(AgentTransition::plain(S::Done)),
            E::Abort => Ok(AgentTransition::with_end_reason(S::Done, Aborted)),
            E::Error => Ok(AgentTransition::with_end_reason(S::Done, Error)),
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── preparing-turn ──
        S::PreparingTurn => match event {
            E::TurnPrepared => Ok(AgentTransition::with_effect(
                S::Streaming,
                AgentTransitionEffect {
                    turn_index_increment: true,
                    reset_tool_call_count: true,
                    ..AgentTransitionEffect::none()
                },
            )),
            E::InterventionRequired => {
                Ok(AgentTransition::with_end_reason(S::Done, Error))
            }
            E::Abort => Ok(AgentTransition::with_end_reason(S::Done, Aborted)),
            E::Error => Ok(AgentTransition::with_end_reason(S::Done, Error)),
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── streaming ──
        S::Streaming => match event {
            E::HasToolCalls { count } => Ok(AgentTransition::with_effect(
                S::ExecutingTools,
                AgentTransitionEffect {
                    set_tool_call_count: Some(count),
                    ..AgentTransitionEffect::none()
                },
            )),
            E::NoToolCalls => Ok(AgentTransition::plain(S::TurnComplete)),
            // 不 bump steeringCount（01 §1.4：由策略/coordinator 掌管预算）
            E::SteeringNeeded => Ok(AgentTransition::plain(S::SteeringEvaluation)),
            E::NoProgressContinue => Ok(AgentTransition::plain(S::PreparingTurn)),
            E::InterventionRequired => {
                Ok(AgentTransition::with_end_reason(S::TurnComplete, Error))
            }
            // 抢救已产出内容：streaming 中 abort 只推进到 turn-complete
            E::Abort => Ok(AgentTransition::with_end_reason(S::TurnComplete, Aborted)),
            E::ProviderError => {
                Ok(AgentTransition::with_end_reason(S::TurnComplete, Error))
            }
            E::Error => Ok(AgentTransition::with_end_reason(S::TurnComplete, Error)),
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── steering-evaluation ──
        S::SteeringEvaluation => match event {
            // 注入完成后必须重进 provider 循环，不停止本轮
            E::SteeringComplete => Ok(AgentTransition::plain(S::PreparingTurn)),
            E::SteeringBudgetExhausted => {
                Ok(AgentTransition::with_end_reason(S::TurnComplete, Error))
            }
            E::InterventionRequired => {
                Ok(AgentTransition::with_end_reason(S::TurnComplete, Error))
            }
            E::Abort => Ok(AgentTransition::with_end_reason(S::Done, Aborted)),
            E::Error => Ok(AgentTransition::with_end_reason(S::Done, Error)),
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── executing-tools ──
        S::ExecutingTools => match event {
            E::ToolsComplete => Ok(AgentTransition::plain(S::TurnComplete)),
            E::InputAvailable => Ok(AgentTransition::plain(S::PreparingTurn)),
            E::Abort => Ok(AgentTransition::with_end_reason(S::TurnComplete, Aborted)),
            // fatalOnError 等工具级致命错误：保留已产出内容进 turn-complete
            E::Error => Ok(AgentTransition::with_end_reason(S::TurnComplete, Error)),
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── turn-complete ──
        S::TurnComplete => match event {
            // 输入可用：回到等待输入，全部轮次计数归零（01 §1.4 表）
            E::InputAvailable => Ok(AgentTransition::with_effect(
                S::AwaitingInput,
                AgentTransitionEffect {
                    reset_all_counters: true,
                    ..AgentTransitionEffect::none()
                },
            )),
            E::NextTurn => Ok(AgentTransition::plain(S::PreparingTurn)),
            E::MaxTurnsReached => {
                Ok(AgentTransition::with_end_reason(S::Done, MaxTurns))
            }
            // 协作停止建议：默认 stop 收场
            E::ShouldStop => Ok(AgentTransition::plain(S::Done)),
            E::Abort => Ok(AgentTransition::with_end_reason(S::Done, Aborted)),
            E::Finish => Ok(AgentTransition::plain(S::Done)),
            // 注意：turn-complete 无 ERROR 转移（01 §1.4 表尾注）
            _ => Err(TransitionError::Undefined { state, event }),
        },
        // ── done（终态）──
        S::Done => Err(TransitionError::Terminal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::AgentEndReason as R;
    use crate::session::AgentSessionEvent as E;
    use crate::session::AgentSessionState as S;

    fn apply(
        state: AgentSessionState,
        event: AgentSessionEvent,
    ) -> Result<AgentTransition, TransitionError> {
        apply_transition(state, event)
    }

    fn plain(to: AgentSessionState) -> AgentTransition {
        AgentTransition::plain(to)
    }

    fn end(to: AgentSessionState, reason: AgentEndReason) -> AgentTransition {
        AgentTransition::with_end_reason(to, reason)
    }

    fn effect(to: AgentSessionState, e: AgentTransitionEffect) -> AgentTransition {
        AgentTransition::with_effect(to, e)
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
            E::HasToolCalls { count: 2 },
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

    /// 01 §1.4 转移表逐行断言（33 条已定义转移）
    #[test]
    fn transition_table_matches_01_section_1_4() {
        // idle
        assert_eq!(apply(S::Idle, E::Initialized), Ok(plain(S::AwaitingInput)));
        assert_eq!(apply(S::Idle, E::Error), Ok(end(S::Done, R::Error)));
        // awaiting-input
        assert_eq!(apply(S::AwaitingInput, E::InputReady), Ok(plain(S::PreparingTurn)));
        assert_eq!(apply(S::AwaitingInput, E::NoInput), Ok(plain(S::Done)));
        assert_eq!(apply(S::AwaitingInput, E::Abort), Ok(end(S::Done, R::Aborted)));
        assert_eq!(apply(S::AwaitingInput, E::Error), Ok(end(S::Done, R::Error)));
        // preparing-turn
        assert_eq!(
            apply(S::PreparingTurn, E::TurnPrepared),
            Ok(effect(
                S::Streaming,
                AgentTransitionEffect {
                    turn_index_increment: true,
                    reset_tool_call_count: true,
                    ..AgentTransitionEffect::none()
                }
            ))
        );
        assert_eq!(
            apply(S::PreparingTurn, E::InterventionRequired),
            Ok(end(S::Done, R::Error))
        );
        assert_eq!(apply(S::PreparingTurn, E::Abort), Ok(end(S::Done, R::Aborted)));
        assert_eq!(apply(S::PreparingTurn, E::Error), Ok(end(S::Done, R::Error)));
        // streaming
        assert_eq!(
            apply(S::Streaming, E::HasToolCalls { count: 2 }),
            Ok(effect(
                S::ExecutingTools,
                AgentTransitionEffect {
                    set_tool_call_count: Some(2),
                    ..AgentTransitionEffect::none()
                }
            ))
        );
        assert_eq!(apply(S::Streaming, E::NoToolCalls), Ok(plain(S::TurnComplete)));
        assert_eq!(
            apply(S::Streaming, E::SteeringNeeded),
            Ok(plain(S::SteeringEvaluation))
        );
        assert_eq!(
            apply(S::Streaming, E::NoProgressContinue),
            Ok(plain(S::PreparingTurn))
        );
        assert_eq!(
            apply(S::Streaming, E::InterventionRequired),
            Ok(end(S::TurnComplete, R::Error))
        );
        assert_eq!(
            apply(S::Streaming, E::Abort),
            Ok(end(S::TurnComplete, R::Aborted))
        );
        assert_eq!(
            apply(S::Streaming, E::ProviderError),
            Ok(end(S::TurnComplete, R::Error))
        );
        assert_eq!(
            apply(S::Streaming, E::Error),
            Ok(end(S::TurnComplete, R::Error))
        );
        // steering-evaluation
        assert_eq!(
            apply(S::SteeringEvaluation, E::SteeringComplete),
            Ok(plain(S::PreparingTurn))
        );
        assert_eq!(
            apply(S::SteeringEvaluation, E::SteeringBudgetExhausted),
            Ok(end(S::TurnComplete, R::Error))
        );
        assert_eq!(
            apply(S::SteeringEvaluation, E::InterventionRequired),
            Ok(end(S::TurnComplete, R::Error))
        );
        assert_eq!(
            apply(S::SteeringEvaluation, E::Abort),
            Ok(end(S::Done, R::Aborted))
        );
        assert_eq!(
            apply(S::SteeringEvaluation, E::Error),
            Ok(end(S::Done, R::Error))
        );
        // executing-tools
        assert_eq!(apply(S::ExecutingTools, E::ToolsComplete), Ok(plain(S::TurnComplete)));
        assert_eq!(
            apply(S::ExecutingTools, E::InputAvailable),
            Ok(plain(S::PreparingTurn))
        );
        assert_eq!(
            apply(S::ExecutingTools, E::Abort),
            Ok(end(S::TurnComplete, R::Aborted))
        );
        assert_eq!(
            apply(S::ExecutingTools, E::Error),
            Ok(end(S::TurnComplete, R::Error))
        );
        // turn-complete
        assert_eq!(
            apply(S::TurnComplete, E::InputAvailable),
            Ok(effect(
                S::AwaitingInput,
                AgentTransitionEffect {
                    reset_all_counters: true,
                    ..AgentTransitionEffect::none()
                }
            ))
        );
        assert_eq!(apply(S::TurnComplete, E::NextTurn), Ok(plain(S::PreparingTurn)));
        assert_eq!(
            apply(S::TurnComplete, E::MaxTurnsReached),
            Ok(end(S::Done, R::MaxTurns))
        );
        assert_eq!(apply(S::TurnComplete, E::ShouldStop), Ok(plain(S::Done)));
        assert_eq!(apply(S::TurnComplete, E::Abort), Ok(end(S::Done, R::Aborted)));
        assert_eq!(apply(S::TurnComplete, E::Finish), Ok(plain(S::Done)));
    }

    /// 未定义转移必须显式失败（01 §五.1：不得静默忽略）
    #[test]
    fn undefined_transitions_return_explicit_error() {
        // done 为终态：任何事件都拒绝
        for event in all_events() {
            assert_eq!(apply(S::Done, event), Err(TransitionError::Terminal));
        }
        // 关键未定义组合抽样
        // turn-complete 没有 ERROR 转移（01 §1.4 表尾注：经 recovery 映射为 FINISH）
        assert!(matches!(
            apply(S::TurnComplete, E::Error),
            Err(TransitionError::Undefined { .. })
        ));
        assert!(matches!(
            apply(S::Idle, E::TurnPrepared),
            Err(TransitionError::Undefined { .. })
        ));
        assert!(matches!(
            apply(S::AwaitingInput, E::ShouldStop),
            Err(TransitionError::Undefined { .. })
        ));
        assert!(matches!(
            apply(S::Streaming, E::Finish),
            Err(TransitionError::Undefined { .. })
        ));
        assert!(matches!(
            apply(S::ExecutingTools, E::NoToolCalls),
            Err(TransitionError::Undefined { .. })
        ));
        assert!(matches!(
            apply(S::SteeringEvaluation, E::SteeringNeeded),
            Err(TransitionError::Undefined { .. })
        ));
        assert!(matches!(
            apply(S::TurnComplete, E::InterventionRequired),
            Err(TransitionError::Undefined { .. })
        ));
    }

    /// 全 160 对（8 态 × 20 事件）要么转移要么显式错误，不允许 panic/静默
    #[test]
    fn every_state_event_pair_is_defined_or_explicitly_undefined() {
        let mut defined = 0usize;
        let mut undefined = 0usize;
        for state in all_states() {
            for event in all_events() {
                match apply(state, event) {
                    Ok(_) => defined += 1,
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

    /// endReason 语义：error 收场仅由 01 §1.6 四事件产生
    #[test]
    fn error_end_reason_only_from_the_four_events() {
        let mut error_terminals = 0usize;
        for state in all_states() {
            for event in all_events() {
                if let Ok(t) = apply(state, event) {
                    if t.end_reason == Some(AgentEndReason::Error) {
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
        }
        // 表中共 11 行 error 收场（idle 1 + awaiting-input 1 + preparing-turn 2 +
        // streaming 3 + steering-evaluation 2 + executing-tools 1 + 无 turn-complete）
        assert_eq!(error_terminals, 11);
    }
}
