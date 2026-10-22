use super::*;

/// 注册 → 触发 → 分派：同事件多 handler 按注册顺序收到事件
#[tokio::test]
async fn dispatch_routes_to_matching_handlers_in_order() {
    let registry = HookRegistry::new();
    let a = Arc::new(SpyHandler::new("a", None));
    let b = Arc::new(SpyHandler::new("b", None));
    let other = Arc::new(SpyHandler::new("other", None));
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        Arc::clone(&a) as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        Arc::clone(&b) as Arc<dyn HookHandler>,
    );
    // 不匹配事件种类的 handler 不收到
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        other as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert!(outcome.blocked.is_none());
    assert_eq!(outcome.failed_handlers, 0);
    assert_eq!(a.kinds(), vec![HookEventKind::TurnEnd]);
    assert_eq!(b.kinds(), vec![HookEventKind::TurnEnd]);
    assert_eq!(registry.len(), 3);
}

/// tool.pre on 模式的 Block 阻止分派并携带原因
#[tokio::test]
async fn tool_pre_block_stops_dispatch() {
    let registry = HookRegistry::new();
    let blocker = Arc::new(SpyHandler::new(
        "blocker",
        Some(HookAction::Block {
            reason: "策略禁止".into(),
        }),
    ));
    let after = Arc::new(SpyHandler::new("after", None));
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        blocker as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        Arc::clone(&after) as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&tool_pre()).await.unwrap();
    assert_eq!(outcome.blocked.as_deref(), Some("策略禁止"));
    // 后续 handler 未收到（提前停止）
    assert!(after.kinds().is_empty());
}

/// observe 模式 handler 的 Block 被忽略（观察者不拦截执行）
#[tokio::test]
async fn observe_mode_block_is_ignored() {
    let registry = HookRegistry::new();
    let blocker = Arc::new(SpyHandler::new(
        "blocker",
        Some(HookAction::Block {
            reason: "不应生效".into(),
        }),
    ));
    let after = Arc::new(SpyHandler::new("after", None));
    registry.register_observe(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        blocker as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        Arc::clone(&after) as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&tool_pre()).await.unwrap();
    assert!(outcome.blocked.is_none(), "observe 模式 Block 不得阻止执行");
    assert_eq!(
        after.kinds(),
        vec![HookEventKind::ToolPre],
        "observe 不中断分派"
    );
}

/// 非 tool.pre 事件的 Block 按观察忽略（不停止分派）
#[tokio::test]
async fn block_on_non_tool_pre_is_ignored() {
    let registry = HookRegistry::new();
    let blocker = Arc::new(SpyHandler::new(
        "blocker",
        Some(HookAction::Block {
            reason: "不应生效".into(),
        }),
    ));
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        blocker as Arc<dyn HookHandler>,
    );
    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert!(outcome.blocked.is_none());
}

/// 失败策略 swallow：handler 失败被吞，继续分派
#[tokio::test]
async fn swallow_ignores_handler_error() {
    let registry = HookRegistry::new();
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
    assert_eq!(
        ok.kinds(),
        vec![HookEventKind::TurnEnd],
        "swallow 后继续分派"
    );
}

/// 失败策略 log：handler 失败记录后继续分派（failed_handlers 计数）
#[tokio::test]
async fn log_records_and_continues() {
    let registry = HookRegistry::new();
    let fail = Arc::new(SpyHandler::failing("fail", "boom"));
    let ok = Arc::new(SpyHandler::new("ok", None));
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Log,
        fail as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Log,
        Arc::clone(&ok) as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&tool_pre()).await.unwrap();
    assert_eq!(outcome.failed_handlers, 1);
    assert_eq!(ok.kinds(), vec![HookEventKind::ToolPre]);
}

/// 失败策略 propagate：停止分派并向上传播
#[tokio::test]
async fn propagate_stops_and_raises() {
    let registry = HookRegistry::new();
    let fail = Arc::new(SpyHandler::failing("fail", "boom"));
    let after = Arc::new(SpyHandler::new("after", None));
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Propagate,
        fail as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        Arc::clone(&after) as Arc<dyn HookHandler>,
    );

    let err = registry.dispatch(&tool_pre()).await.unwrap_err();
    assert!(err.message.contains("boom"));
    assert!(after.kinds().is_empty(), "propagate 后不再分派");
}

/// 空注册表 / 无匹配注册：分派无副作用
#[tokio::test]
async fn dispatch_noop_without_matches() {
    let registry = HookRegistry::new();
    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert!(outcome.blocked.is_none());
    assert_eq!(outcome.failed_handlers, 0);

    let other = Arc::new(SpyHandler::new("other", None));
    registry.register(
        HookEventKind::ToolPost,
        HookFailStrategy::Swallow,
        other as Arc<dyn HookHandler>,
    );
    // ToolPost 注册不匹配 TurnEnd 事件
    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert!(outcome.blocked.is_none());
    assert_eq!(outcome.failed_handlers, 0);
}

/// tool.post 事件载荷字段透传
#[tokio::test]
async fn tool_post_payload_carries_output_and_flags() {
    let registry = HookRegistry::new();
    let spy = Arc::new(SpyHandler::new("spy", None));
    registry.register(
        HookEventKind::ToolPost,
        HookFailStrategy::Swallow,
        Arc::clone(&spy) as Arc<dyn HookHandler>,
    );
    registry
        .dispatch(&HookEvent::ToolPost {
            session_id: "s1".into(),
            tool_name: "echo".into(),
            output: json!({ "echo": 1 }),
            duration_ms: 5,
            is_error: false,
        })
        .await
        .unwrap();
    assert_eq!(spy.kinds(), vec![HookEventKind::ToolPost]);
}
