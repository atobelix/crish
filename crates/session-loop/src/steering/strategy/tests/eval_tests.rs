use super::*;

/// 策略关注的阶段 = after-tools / empty-response（01 §3.1）
#[test]
fn phases_are_after_tools_and_empty_response() {
    let strategy = RecoverySteeringStrategy::default();
    assert_eq!(
        strategy.phases(),
        &[SteeringPhase::AfterTools, SteeringPhase::EmptyResponse]
    );
}

/// empty-response 第 1 次（计数 0 < 默认 1）：注入 system 消息（D7）
#[test]
fn empty_response_first_response_injects() {
    let strategy = RecoverySteeringStrategy::default();
    let (message, reason) = inject_of(
        strategy
            .evaluate(SteeringPhase::EmptyResponse, &context(&[], 0))
            .expect("第 1 次应注入"),
    );
    assert_eq!(reason, SteeringReason::EmptyResponse);
    assert_eq!(message.role, AgentMessageRole::System);
    assert!(!message.text().is_empty());
    let metadata = message.metadata.as_ref().expect("注入消息须带元数据");
    assert_eq!(
        metadata.get("kind").and_then(|k| k.as_str()),
        Some(metadata_kind_wire(AgentMessageMetadataKind::Steering).as_str()),
        "kind 走 T1a 枚举 canonical wire（I1-α④ 收编 runtime-steering）"
    );
    assert_eq!(
        metadata.get("reason").and_then(|r| r.as_str()),
        Some("empty-response")
    );
    assert_eq!(
        metadata.get("steeringCount").and_then(|c| c.as_u64()),
        Some(1),
        "元数据 steeringCount = 注入后计数"
    );
}

/// empty-response 第 2 次（计数 1 >= 默认 1）：intervention-required（D7）
#[test]
fn empty_response_second_response_intervenes() {
    let strategy = RecoverySteeringStrategy::default();
    let action = strategy
        .evaluate(SteeringPhase::EmptyResponse, &context(&[], 1))
        .expect("第 2 次应返回干预");
    match action {
        SteeringAction::InterventionRequired { reason, message } => {
            assert_eq!(reason, SteeringReason::EmptyResponse);
            assert_eq!(message.as_deref(), Some(DEFAULT_INTERVENTION_MESSAGE));
        }
        other => panic!("应为 intervention-required，实际 {other:?}"),
    }
}

/// 边界 N-1/N：maxSteeringMessages=2 时第 1/2 次注入、第 3 次干预
#[test]
fn empty_response_custom_max_steering_messages_boundary() {
    let strategy = RecoverySteeringStrategy::new(RecoverySteeringStrategyOptions {
        max_steering_messages: Some(2),
        ..Default::default()
    });
    assert_eq!(
        strategy
            .evaluate(SteeringPhase::EmptyResponse, &context(&[], 0))
            .and_then(action_type),
        Some("inject")
    );
    assert_eq!(
        strategy
            .evaluate(SteeringPhase::EmptyResponse, &context(&[], 1))
            .and_then(action_type),
        Some("inject")
    );
    assert_eq!(
        strategy
            .evaluate(SteeringPhase::EmptyResponse, &context(&[], 2))
            .and_then(action_type),
        Some("intervention"),
        "计数达到 maxSteeringMessages 即干预"
    );
}

/// after-tools 无错误环、无重复调用：不产生动作
#[test]
fn after_tools_without_loop_returns_none() {
    let strategy = RecoverySteeringStrategy::default();
    let messages = arc_messages(vec![
        user("hi"),
        assistant_with_tool_calls(&[("read", json!({}))]),
    ]);
    assert!(strategy
        .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
        .is_none());
}

/// after-tools 预算耗尽：检测到环仍返回 intervention-required（D9）
#[test]
fn after_tools_budget_exhausted_intervenes_with_detected_reason() {
    let strategy = RecoverySteeringStrategy::default();
    let messages = arc_messages(vec![
        tool_result("boom-1", true),
        tool_result("boom-2", true),
    ]);
    let action = strategy
        .evaluate(SteeringPhase::AfterTools, &context(&messages, 1))
        .expect("检测到环且预算耗尽应干预");
    match action {
        SteeringAction::InterventionRequired { reason, .. } => {
            assert_eq!(reason, SteeringReason::ToolErrors, "干预携带检测到的原因")
        }
        other => panic!("应为 intervention-required，实际 {other:?}"),
    }
}

/// after-tools 注入消息元数据带注入后计数
#[test]
fn after_tools_inject_metadata_steering_count() {
    // 自定义策略预算 3，当前计数 2 时仍在预算内注入
    let strategy = RecoverySteeringStrategy::new(RecoverySteeringStrategyOptions {
        max_steering_messages: Some(3),
        ..Default::default()
    });
    let messages = arc_messages(vec![
        tool_result("boom-1", true),
        tool_result("boom-2", true),
    ]);
    let (message, _) = inject_of(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 2))
            .expect("计数 2 < 预算 3，应注入"),
    );
    assert_eq!(
        message
            .metadata
            .as_ref()
            .and_then(|m| m.get("steeringCount"))
            .and_then(|c| c.as_u64()),
        Some(3),
        "元数据 steeringCount = 注入后计数（当前计数 + 1）"
    );
}
