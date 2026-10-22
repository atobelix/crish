use super::*;

/// 普通 dispatch（ok 路径）→ 发射 hook-outcome(outcome=ok)，载荷含种类
#[tokio::test]
async fn hook_outcome_ok_on_normal_dispatch() {
    let registry = HookRegistry::new();
    let (sink, captured) = sink_capture();
    registry.set_outcome_sink(sink);
    let spy = Arc::new(SpyHandler::new("spy", None));
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        spy as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&tool_pre()).await.unwrap();
    assert!(outcome.blocked.is_none());
    let events = take_hook_outcomes(&captured);
    assert_eq!(events.len(), 1, "每批次恰一条 hook-outcome");
    assert_eq!(events[0].0, "tool.pre", "hook_type 必须为事件种类");
    assert_eq!(events[0].1, "ok");
    assert!(events[0].2.is_none(), "ok 路径无触发 handler 名");
    assert!(events[0].3.is_none());
}

/// tool.pre 阻止（on 模式 Block）→ hook-outcome(outcome=blocked)，
/// blocked_reason 非空且 hook_name = 阻止 handler 名
#[tokio::test]
async fn hook_outcome_blocked_carries_reason_and_handler() {
    let registry = HookRegistry::new();
    let (sink, captured) = sink_capture();
    registry.set_outcome_sink(sink);
    let blocker = Arc::new(SpyHandler::new(
        "blocker",
        Some(HookAction::Block {
            reason: "策略禁止".into(),
        }),
    ));
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        blocker as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&tool_pre()).await.unwrap();
    assert_eq!(outcome.blocked.as_deref(), Some("策略禁止"));
    assert_eq!(outcome.blocked_handler.as_deref(), Some("blocker"));
    let events = take_hook_outcomes(&captured);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "tool.pre");
    assert_eq!(events[0].1, "blocked");
    assert_eq!(
        events[0].2.as_deref(),
        Some("blocker"),
        "hook_name 必须为阻止 handler 名"
    );
    assert_eq!(
        events[0].3.as_deref(),
        Some("策略禁止"),
        "blocked 必须带原因"
    );
}

/// 失败 handler（swallow）→ 也发 hook-outcome(outcome=failed)，hook_name 可辨
#[tokio::test]
async fn hook_outcome_failed_on_handler_error() {
    let registry = HookRegistry::new();
    let (sink, captured) = sink_capture();
    registry.set_outcome_sink(sink);
    let fail = Arc::new(SpyHandler::failing("fail", "boom"));
    let ok = Arc::new(SpyHandler::new("ok", None));
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        fail as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        Arc::clone(&ok) as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert_eq!(outcome.failed_handlers, 1);
    let events = take_hook_outcomes(&captured);
    assert_eq!(events.len(), 1, "失败批次仍只发一条聚合事件");
    assert_eq!(events[0].0, "turn.end");
    assert_eq!(events[0].1, "failed");
    assert_eq!(
        events[0].2.as_deref(),
        Some("fail"),
        "hook_name 必须为失败 handler 名"
    );
}

/// 超时 handler（timeout_ms 注入）→ outcome=timeout 可辨（与 failed 区分）
#[tokio::test]
async fn hook_outcome_timeout_distinct_from_failed() {
    let registry = HookRegistry::new();
    let (sink, captured) = sink_capture();
    registry.set_outcome_sink(sink);
    let slow = Arc::new(SpyHandler::slow("slow", 50));
    registry
        .register_with(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            slow as Arc<dyn HookHandler>,
            HookRegisterOptions {
                mode: HookMode::On,
                timeout_ms: Some(1),
                ..Default::default()
            },
        )
        .unwrap();

    let outcome = registry.dispatch(&tool_pre()).await.unwrap();
    assert_eq!(outcome.timeouts, 1);
    let events = take_hook_outcomes(&captured);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].1, "timeout", "超时必须与普通失败可辨");
    assert_eq!(events[0].2.as_deref(), Some("slow"));
}

/// propagate 失败 → dispatch 返回 Err，但仍发 hook-outcome(failed)
/// 且 hook_name 携带失败 handler 名（Err 路径单点发射）
#[tokio::test]
async fn hook_outcome_emitted_on_propagate_error() {
    let registry = HookRegistry::new();
    let (sink, captured) = sink_capture();
    registry.set_outcome_sink(sink);
    let fail = Arc::new(SpyHandler::failing("fail", "boom"));
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Propagate,
        fail as Arc<dyn HookHandler>,
    );

    let err = registry.dispatch(&tool_pre()).await.unwrap_err();
    assert!(err.message.contains("boom"));
    assert_eq!(err.handler_name.as_deref(), Some("fail"));
    let events = take_hook_outcomes(&captured);
    assert_eq!(events.len(), 1, "Err 路径也必须发 hook-outcome");
    assert_eq!(events[0].1, "failed");
    assert_eq!(events[0].2.as_deref(), Some("fail"));
}

/// 四 hook 变体（model.beforeRequest / model.afterResponse /
/// subagent.start / subagent.end）：dispatch 单点通用，任意种类
/// 聚合发射（宿主接线后自动覆盖；本层不硬造生产发射点）
#[tokio::test]
async fn hook_outcome_covers_four_hook_variants() {
    let registry = HookRegistry::new();
    let (sink, captured) = sink_capture();
    registry.set_outcome_sink(sink);
    let spy = Arc::new(SpyHandler::new("spy", None));
    for kind in [
        HookEventKind::ModelBeforeRequest,
        HookEventKind::ModelAfterResponse,
        HookEventKind::SubagentStart,
        HookEventKind::SubagentEnd,
    ] {
        registry.register_observe(
            kind,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
        );
    }

    let events = vec![
        HookEvent::ModelBeforeRequest {
            session_id: "s1".into(),
            provider_id: Some("deepseek".into()),
            model: Some("v4".into()),
        },
        HookEvent::ModelAfterResponse {
            session_id: "s1".into(),
            provider_id: None,
            model: None,
            ok: true,
        },
        HookEvent::SubagentStart {
            parent_session_id: "p1".into(),
            subagent_session_id: "a1".into(),
            role: Some("researcher".into()),
        },
        HookEvent::SubagentEnd {
            parent_session_id: "p1".into(),
            subagent_session_id: "a1".into(),
            reason: Some("completed".into()),
        },
    ];
    for event in &events {
        registry.dispatch(event).await.unwrap();
    }
    let outcomes = take_hook_outcomes(&captured);
    assert_eq!(outcomes.len(), 4, "四变体各发一条聚合事件");
    let types: Vec<&str> = outcomes.iter().map(|o| o.0.as_str()).collect();
    assert_eq!(
        types,
        vec![
            "model.beforeRequest",
            "model.afterResponse",
            "subagent.start",
            "subagent.end"
        ],
        "四变体 hook_type 载荷必须对应事件种类"
    );
    assert!(outcomes.iter().all(|o| o.1 == "ok"));
}

/// 未接线观测出口 → 无 hook-outcome 事件（dispatch 语义不变，纯观测）
#[tokio::test]
async fn hook_outcome_absent_without_sink() {
    let registry = HookRegistry::new();
    let spy = Arc::new(SpyHandler::new("spy", None));
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        spy as Arc<dyn HookHandler>,
    );
    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert!(outcome.blocked.is_none());
    assert_eq!(outcome.failed_handlers, 0);
}
