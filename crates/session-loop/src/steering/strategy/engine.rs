//! RecoverySteeringStrategy 策略执行与评估（对齐 TS recovery-steering-strategy.ts）

use crate::steering::nudge::build_steering_message;
use crate::steering::{
    SteeringAction, SteeringContext, SteeringPhase, SteeringReason, SteeringStrategy,
    DEFAULT_INTERVENTION_MESSAGE,
};

use super::types::RecoverySteeringStrategy;

impl SteeringStrategy for RecoverySteeringStrategy {
    fn name(&self) -> &'static str {
        "recovery"
    }

    fn phases(&self) -> &'static [SteeringPhase] {
        &[SteeringPhase::AfterTools, SteeringPhase::EmptyResponse]
    }

    fn evaluate(
        &self,
        phase: SteeringPhase,
        context: &SteeringContext<'_>,
    ) -> Option<SteeringAction> {
        match phase {
            SteeringPhase::EmptyResponse => {
                // D7：预算内重试注入；耗尽返回 intervention-required
                if context.steering_count >= self.max_steering_messages {
                    return Some(SteeringAction::InterventionRequired {
                        reason: SteeringReason::EmptyResponse,
                        message: Some(DEFAULT_INTERVENTION_MESSAGE.to_string()),
                    });
                }
                Some(SteeringAction::InjectMessage {
                    message: build_steering_message(
                        SteeringReason::EmptyResponse,
                        context.steering_count + 1,
                    ),
                    reason: SteeringReason::EmptyResponse,
                })
            }
            SteeringPhase::AfterTools => {
                let reason = self.detect_recovery_need(context.messages)?;
                if context.steering_count >= self.max_steering_messages {
                    return Some(SteeringAction::InterventionRequired {
                        reason,
                        message: Some(DEFAULT_INTERVENTION_MESSAGE.to_string()),
                    });
                }
                Some(SteeringAction::InjectMessage {
                    message: build_steering_message(reason, context.steering_count + 1),
                    reason,
                })
            }
            _ => None,
        }
    }
}
