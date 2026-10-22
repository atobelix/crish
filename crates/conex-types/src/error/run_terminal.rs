use super::CrishError;
use crate::session::{AgentEndReason, AgentSessionEvent};
use serde::{Deserialize, Serialize};

// ── RunTerminal 收口决策类型（01 §五.2）──

/// run 结束决策约束错误
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunTerminalError {
    /// 非 error 收场不得携带 error（01 §1.6：error 最小集合约束）
    #[error("非 error 收场不得携带 error（reason={0:?}）")]
    ErrorNotAllowed(AgentEndReason),
    /// error 收场必须携带 error
    #[error("error 收场必须携带 error")]
    MissingError,
    /// 事件不属于 01 §1.6 错误收场四事件
    #[error("事件 {0:?} 不属于 01 §1.6 错误收场四事件")]
    NotErrorEvent(AgentSessionEvent),
}

/// run 收口决策类型（01 §五.2：单一 `{reason, error?}` 决策收敛所有收场路径）
///
/// - reason=Error 仅由 01 §1.6 四个事件产生（ERROR / INTERVENTION_REQUIRED /
///   PROVIDER_ERROR / STEERING_BUDGET_EXHAUSTED），且必须携带 error；
/// - 其余 reason 不得携带 error。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunTerminal {
    pub reason: AgentEndReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CrishError>,
}

impl RunTerminal {
    /// 构造收口决策：仅 reason=Error 允许携带 error
    pub fn new(
        reason: AgentEndReason,
        error: Option<CrishError>,
    ) -> Result<Self, RunTerminalError> {
        match (reason, error) {
            (AgentEndReason::Error, Some(error)) => Ok(Self {
                reason,
                error: Some(error),
            }),
            (AgentEndReason::Error, None) => Err(RunTerminalError::MissingError),
            (other, Some(_)) => Err(RunTerminalError::ErrorNotAllowed(other)),
            (other, None) => Ok(Self {
                reason: other,
                error: None,
            }),
        }
    }

    /// 由 01 §1.6 四个错误收场事件构造（其他事件一律拒绝）
    pub fn from_error_event(
        event: AgentSessionEvent,
        error: CrishError,
    ) -> Result<Self, RunTerminalError> {
        match event {
            AgentSessionEvent::Error
            | AgentSessionEvent::InterventionRequired
            | AgentSessionEvent::ProviderError
            | AgentSessionEvent::SteeringBudgetExhausted => Ok(Self {
                reason: AgentEndReason::Error,
                error: Some(error),
            }),
            other => Err(RunTerminalError::NotErrorEvent(other)),
        }
    }

    /// 是否错误收场
    pub fn is_error(&self) -> bool {
        self.reason == AgentEndReason::Error
    }
}
