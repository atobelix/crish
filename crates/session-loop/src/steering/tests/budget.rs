//! 预算与计数：唯一增量点、预算边界、预算耗尽诊断、阶段过滤、reset。

use super::*;
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessageMetadataKind;

/// 计数唯一增量点：evaluate 不改计数，apply 的 inject-message 才 +1（D10）
#[test]
fn evaluate_does_not_bump_count_apply_is_the_only_increment_point() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions::default(),
    );
    let mut conversation = Vec::new();

    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1);
    assert_eq!(
        coordinator.get_steering_count(),
        0,
        "evaluate 不得改变计数（计数唯一增量点在 apply）"
    );

    coordinator
        .apply(&actions, "sess-1", &mut conversation)
        .events
        .len();
    assert_eq!(
        coordinator.get_steering_count(),
        1,
        "apply inject-message 后计数 +1"
    );
    assert_eq!(conversation.len(), 1, "注入消息已 append 进对话");
}

/// 预算边界：预算 N 允许恰好 N 次注入（N-1 为最后一次允许），第 N+1 次跳过
#[test]
fn inject_budget_boundary_n_minus_1_and_n() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(3),
        },
    );
    let mut conversation = Vec::new();

    for expected in 1..=3 {
        let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
        assert_eq!(actions.len(), 1, "预算内第 {expected} 次注入应被允许");
        coordinator.apply(&actions, "sess-1", &mut conversation);
        assert_eq!(coordinator.get_steering_count(), expected);
    }

    // 预算耗尽：第 4 次 inject-message 被跳过（D9 禁止超预算注入）——
    // 不静默跳过，改产 budget-exhausted 诊断事件（T06.3 Q08 接线）
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1, "预算耗尽应产出诊断事件而非空（Q32 修复）");
    assert!(matches!(
        actions.as_slice(),
        [SteeringAction::EmitDiagnostic { reason, .. }]
            if reason == "steering-budget-exhausted"
    ));
    assert_eq!(coordinator.get_steering_count(), 3, "计数不再增长");
    assert_eq!(conversation.len(), 3, "对话不再追加");
}

/// 干预动作不受预算限制：预算 0 时 intervention-required 仍照发（D9）
#[test]
fn intervention_not_limited_by_budget() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InterventionRequired {
                reason: SteeringReason::EmptyResponse,
                message: None,
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(0),
        },
    );
    let mut conversation = Vec::new();

    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1, "预算耗尽不阻断 intervention-required");

    let result = coordinator.apply(&actions, "sess-1", &mut conversation);
    assert!(result.intervention_required);
    assert_eq!(coordinator.get_steering_count(), 0, "干预不消耗预算");
    assert!(conversation.is_empty(), "干预不修改对话");
    assert!(
        result
            .events
            .iter()
            .any(|e| matches!(e, AgentEvent::RuntimeInterventionRequired { .. })),
        "intervention 事件照发"
    );
}

/// 诊断动作不受预算限制且不计数、不修改对话
#[test]
fn emit_diagnostic_unlimited_no_count_no_conversation_change() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::AfterTools],
            action: SteeringAction::EmitDiagnostic {
                diagnostic: serde_json::json!({"note": "observability"}),
                reason: "after-tools".into(),
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(0),
        },
    );
    let mut conversation = Vec::new();

    let actions = coordinator.evaluate(SteeringPhase::AfterTools, &empty_context());
    assert_eq!(actions.len(), 1);

    let result = coordinator.apply(&actions, "sess-1", &mut conversation);
    assert!(!result.intervention_required);
    assert_eq!(coordinator.get_steering_count(), 0, "诊断不计数");
    assert!(conversation.is_empty(), "诊断不修改对话");
    let steering = result
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::RuntimeSteering { message, .. } => Some(message),
            _ => None,
        })
        .expect("应发射 runtime-steering 事件");
    assert_eq!(
        steering
            .metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str()),
        Some(metadata_kind_wire(AgentMessageMetadataKind::Diagnostic).as_str())
    );
}

/// T06.3 Q08 / Q32：预算耗尽跳过 inject-message 时产出
/// budget-exhausted 诊断事件——不静默跳过，用户可见预算/计数
#[test]
fn budget_exhausted_emits_diagnostic_instead_of_silent_skip() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(1),
        },
    );
    let mut conversation = Vec::new();

    // 预算 1：首次注入允许
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1);
    coordinator.apply(&actions, "sess-1", &mut conversation);
    assert_eq!(coordinator.get_steering_count(), 1);

    // 预算耗尽：产出 EmitDiagnostic（reason=steering-budget-exhausted，
    // 载荷含 budget 与 steeringCount），不静默跳过
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1);
    match &actions[0] {
        SteeringAction::EmitDiagnostic { reason, diagnostic } => {
            assert_eq!(reason, "steering-budget-exhausted");
            assert_eq!(diagnostic.get("budget").and_then(|b| b.as_u64()), Some(1));
            assert_eq!(
                diagnostic.get("steeringCount").and_then(|c| c.as_u64()),
                Some(1)
            );
        }
        other => panic!("应为 EmitDiagnostic，实际 {other:?}"),
    }
    // apply：诊断事件照发、不计数、不修改对话
    let result = coordinator.apply(&actions, "sess-1", &mut conversation);
    assert!(!result.intervention_required);
    assert_eq!(coordinator.get_steering_count(), 1, "诊断不消耗预算");
    assert_eq!(
        conversation.len(),
        1,
        "诊断不修改对话（首轮注入的消息保留）"
    );
    let steering = result
        .events
        .iter()
        .find_map(|e| match e {
            AgentEvent::RuntimeSteering { message, .. } => Some(message),
            _ => None,
        })
        .expect("应发射 runtime-steering 诊断事件");
    assert_eq!(
        steering
            .metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str()),
        Some(metadata_kind_wire(AgentMessageMetadataKind::Diagnostic).as_str())
    );
}

/// 阶段过滤：策略只在其 phases 声明的阶段被调用
#[test]
fn phase_filtering_skips_unlisted_phases() {
    let coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::AfterTools],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions::default(),
    );
    assert!(
        coordinator
            .evaluate(SteeringPhase::EmptyResponse, &empty_context())
            .is_empty()
    );
    assert_eq!(
        coordinator
            .evaluate(SteeringPhase::AfterTools, &empty_context())
            .len(),
        1
    );
}

/// reset 语义：清零后注入重新可用（01 §3.3 重置时机由 B3.4 调用）
#[test]
fn reset_clears_count_and_reopens_budget() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(1),
        },
    );
    let mut conversation = Vec::new();

    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    coordinator.apply(&actions, "sess-1", &mut conversation);
    assert_eq!(coordinator.get_steering_count(), 1);

    // 预算耗尽：不再注入——改产 EmitDiagnostic（T06.3 Q32：不静默跳过）
    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1);
    assert!(
        matches!(
            &actions[0],
            SteeringAction::EmitDiagnostic {
                reason,
                ..
            } if reason == "steering-budget-exhausted"
        ),
        "预算耗尽应产出 budget-exhausted 诊断而非注入"
    );

    coordinator.reset();
    assert_eq!(coordinator.get_steering_count(), 0);

    let actions = coordinator.evaluate(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1, "reset 后注入重新可用");
    coordinator.apply(&actions, "sess-1", &mut conversation);
    assert_eq!(coordinator.get_steering_count(), 1);
}
