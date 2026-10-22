//! intervention-required 收场语义与干预事件载荷。

use super::*;
use crate::steering::strategy::RecoverySteeringStrategy;
use conex_types::events::AgentEvent;

/// D7/D9 收场语义：empty-response 预算耗尽 → intervention 事件照发、
/// 不再注入、结果无 error 语义（stop 收场由 B3.4 保证）
#[test]
fn empty_response_exhaustion_intervention_without_error_semantics() {
    // 真实策略 + 默认 maxSteeringMessages=1
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(RecoverySteeringStrategy::default())],
        SteeringCoordinatorOptions::default(),
    );
    let mut conversation = Vec::new();

    // 第 1 次 empty-response：预算内重试（D7）
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1, "第 1 次空响应预算内注入");
    let result = coordinator.apply(&actions, "sess-1", &mut conversation);
    assert!(!result.intervention_required);
    assert_eq!(conversation.len(), 1);
    assert_eq!(coordinator.get_steering_count(), 1);

    // 第 2 次 empty-response：预算耗尽 → intervention-required（D7/D9）
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1);
    assert!(matches!(
        actions[0],
        SteeringAction::InterventionRequired {
            reason: SteeringReason::EmptyResponse,
            ..
        }
    ));
    let result = coordinator.apply(&actions, "sess-1", &mut conversation);
    assert!(result.intervention_required, "intervention 事件照发");
    assert_eq!(conversation.len(), 1, "耗尽后不再注入");
    assert_eq!(coordinator.get_steering_count(), 1, "干预不消耗预算");
    assert!(
        result
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::RuntimeInterventionRequired { .. })),
        "runtime-intervention-required 事件照发"
    );
}

/// 干预事件 choices 固定为 rollback/pause/user-instruction（对齐 TS）
#[test]
fn intervention_event_carries_choices() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InterventionRequired {
                reason: SteeringReason::ToolLoop,
                message: Some("stop repeating".into()),
            },
        })],
        SteeringCoordinatorOptions::default(),
    );
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    let result = coordinator.apply(&actions, "sess-1", &mut Vec::new());
    match &result.events[0] {
        AgentEvent::RuntimeInterventionRequired {
            choices,
            message,
            reason,
            ..
        } => {
            assert_eq!(
                choices,
                &vec![
                    "rollback".to_string(),
                    "pause".to_string(),
                    "user-instruction".to_string()
                ]
            );
            assert_eq!(message, "stop repeating");
            assert_eq!(reason, "tool-loop");
        }
        other => panic!("应为 runtime-intervention-required 事件，实际 {other:?}"),
    }
}
