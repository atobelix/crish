use super::*;

// ── I8-E1 新增：matcher / timeout / 模式分派 / 错误事件化 / 冻结 ──

/// matcher 过滤：tool.pre 按工具名正则过滤（E1 验收断言：
/// `^fs_` 匹配 fs_read、不匹配 shell_run）
#[tokio::test]
async fn matcher_filters_tool_events_by_tool_name() {
    let registry = HookRegistry::new();
    let spy = Arc::new(SpyHandler::new("spy", None));
    registry
        .register_with(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
            HookRegisterOptions {
                matcher: Some("^fs_".into()),
                ..Default::default()
            },
        )
        .unwrap();

    registry
        .dispatch(&HookEvent::ToolPre {
            session_id: "s1".into(),
            tool_name: "fs_read".into(),
            input: json!({}),
        })
        .await
        .unwrap();
    assert_eq!(
        spy.kinds(),
        vec![HookEventKind::ToolPre],
        "fs_read 必须匹配 ^fs_"
    );

    // 不匹配的工具名跳过
    registry
        .dispatch(&HookEvent::ToolPre {
            session_id: "s1".into(),
            tool_name: "shell_run".into(),
            input: json!({}),
        })
        .await
        .unwrap();
    assert_eq!(
        spy.kinds(),
        vec![HookEventKind::ToolPre],
        "shell_run 不匹配 ^fs_，handler 不得再次收到"
    );
}

/// matcher 仅对 tool.* 事件生效（其余事件忽略 matcher）
#[tokio::test]
async fn matcher_ignored_for_non_tool_events() {
    let registry = HookRegistry::new();
    let spy = Arc::new(SpyHandler::new("spy", None));
    registry
        .register_with(
            HookEventKind::TurnEnd,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
            HookRegisterOptions {
                matcher: Some("^fs_".into()),
                ..Default::default()
            },
        )
        .unwrap();
    registry.dispatch(&turn_end()).await.unwrap();
    assert_eq!(
        spy.kinds(),
        vec![HookEventKind::TurnEnd],
        "非 tool 事件忽略 matcher"
    );
}

/// 非法 matcher 正则注册即拒（HookError）
#[tokio::test]
async fn invalid_matcher_rejected_at_registration() {
    let registry = HookRegistry::new();
    let err = registry
        .register_with(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::new(SpyHandler::new("spy", None)) as Arc<dyn HookHandler>,
            HookRegisterOptions {
                matcher: Some("([".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(err.message.contains("非法 matcher 正则"));
    assert_eq!(registry.len(), 0, "非法正则不得注册成功");
}

/// on 模式 handler 超时（timeoutMs=1）→ tool.pre 放行、failed_handlers
/// 计数 +1、timeouts 计数 +1、error.occurred 事件已发（E1 验收断言）
#[tokio::test]
async fn tool_pre_timeout_degrades_to_allow_with_error_event() {
    let registry = HookRegistry::new();
    let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    registry.register_observe(
        HookEventKind::ErrorOccurred,
        HookFailStrategy::Swallow,
        Arc::new(ErrorSpy::new(errors.clone())) as Arc<dyn HookHandler>,
    );
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
    assert!(outcome.blocked.is_none(), "tool.pre 超时固定降级放行");
    assert_eq!(outcome.failed_handlers, 1);
    assert_eq!(outcome.timeouts, 1);
    assert_eq!(outcome.error_events, 1, "超时失败必须广播 error.occurred");
    let errs = errors.lock().unwrap();
    assert_eq!(errs.len(), 1, "error.occurred handler 必须收到诊断事件");
    assert!(
        errs[0].contains("超时"),
        "诊断事件必须含超时文案：{}",
        errs[0]
    );
}

/// handler Err（swallow）→ 广播 error.occurred 诊断事件（错误事件化）
#[tokio::test]
async fn handler_error_emits_error_occurred_event() {
    let registry = HookRegistry::new();
    let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    registry.register_observe(
        HookEventKind::ErrorOccurred,
        HookFailStrategy::Swallow,
        Arc::new(ErrorSpy::new(errors.clone())) as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        Arc::new(SpyHandler::failing("fail", "boom")) as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    assert_eq!(outcome.failed_handlers, 1);
    assert_eq!(outcome.error_events, 1);
    let errs = errors.lock().unwrap();
    assert_eq!(errs.len(), 1);
    assert!(errs[0].contains("boom"));
}

/// error.occurred 自身 handler 失败不级联（重入护栏）
#[tokio::test]
async fn error_event_handler_failure_does_not_cascade() {
    let registry = HookRegistry::new();
    // error.occurred 上挂一个会失败的 handler
    registry.register(
        HookEventKind::ErrorOccurred,
        HookFailStrategy::Swallow,
        Arc::new(SpyHandler::failing("error-fail", "再炸")) as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        Arc::new(SpyHandler::failing("fail", "boom")) as Arc<dyn HookHandler>,
    );

    let outcome = registry.dispatch(&turn_end()).await.unwrap();
    // error.occurred 的 handler 失败被吞（不再级联新错误事件）
    assert_eq!(outcome.failed_handlers, 1, "原 handler 失败计数 1");
    assert_eq!(outcome.error_events, 1, "只广播一次错误事件");
}

/// 并发双失败：两个并发 dispatch 各自失败时，后到者不得丢 error.occurred
/// （回归：全局 AtomicBool 重入护栏 swap 见 true 直接 return 会误伤并发
/// 失败；修复后护栏只由 per-dispatch error_eventing 参数承担）
#[tokio::test]
async fn concurrent_failures_both_emit_error_occurred() {
    let registry = HookRegistry::new();
    let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    // ErrorSpy 带延迟：拉长 error.occurred 分派窗口，让第二个并发
    // dispatch 的失败路径在第一个仍在 emit 期间到达（复现竞态时序）
    registry.register_observe(
        HookEventKind::ErrorOccurred,
        HookFailStrategy::Swallow,
        Arc::new(ErrorSpy::slow(errors.clone(), 30)) as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::TurnEnd,
        HookFailStrategy::Swallow,
        Arc::new(SpyHandler::failing("fail-a", "boom-a")) as Arc<dyn HookHandler>,
    );
    registry.register(
        HookEventKind::ToolPre,
        HookFailStrategy::Swallow,
        Arc::new(SpyHandler::failing("fail-b", "boom-b")) as Arc<dyn HookHandler>,
    );

    // 两个并发 dispatch：TurnEnd 与 ToolPre 各自失败。
    // join! 在单线程 runtime 上于 await 点交错——第一个 dispatch 的
    // ErrorSpy sleep 期间，第二个 dispatch 的失败路径会进入 emit_error_event。
    let ev_a = turn_end();
    let ev_b = tool_pre();
    let (o1, o2) = tokio::join!(registry.dispatch(&ev_a), registry.dispatch(&ev_b),);
    let o1 = o1.expect("dispatch turn_end");
    let o2 = o2.expect("dispatch tool_pre");
    assert_eq!(o1.error_events, 1, "先到失败必须广播 error.occurred");
    assert_eq!(
        o2.error_events, 1,
        "后到失败不得丢 error.occurred（全局 AtomicBool 误伤回归）"
    );
    let errs = errors.lock().unwrap();
    assert_eq!(errs.len(), 2, "ErrorSpy 必须收到两条 error.occurred");
    assert!(errs.iter().any(|e| e.contains("boom-a")));
    assert!(errs.iter().any(|e| e.contains("boom-b")));
}

/// 事件名全集冻结：HookEventKind::as_str() 14 变体与
/// packages/shared-types/src/hooks.ts 的 HOOK_EVENT_NAMES 双向锁定
#[test]
fn hook_kind_names_frozen_14() {
    let kinds = ALL_HOOK_EVENT_KINDS;
    assert_eq!(kinds.len(), 14, "HookEventKind 必须恰好 14 个变体");
    let mut names: Vec<&str> = kinds.iter().map(|k| k.as_str()).collect();
    let mut dedup = names.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(dedup.len(), 14, "as_str() 必须无重复");
    // 与 TS 侧 HOOK_EVENT_NAMES 字面量比对（从 hooks.ts 文件读取）
    let hooks_ts = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared-types/src/hooks.ts"
    ))
    .unwrap_or_else(|e| panic!("读取 hooks.ts 失败：{e}"));
    // 提取 HOOK_EVENT_NAMES 数组内全部字符串字面量
    let start = hooks_ts
        .find("HOOK_EVENT_NAMES")
        .expect("hooks.ts 必须声明 HOOK_EVENT_NAMES");
    let slice = &hooks_ts[start..];
    let mut ts_names = Vec::new();
    for cap in slice
        .lines()
        .take_while(|l| !l.trim_start().starts_with("] as const"))
        .filter_map(|l| {
            l.trim()
                .strip_prefix('\'')
                .and_then(|r| r.split('\'').next())
        })
    {
        ts_names.push(cap.to_string());
    }
    names.sort();
    ts_names.sort();
    assert_eq!(
        names, ts_names,
        "HookEventKind::as_str() 与 hooks.ts HOOK_EVENT_NAMES 必须一一对应（I7-M13 冻结）"
    );
}

#[tokio::test]
async fn new_variant_payloads_are_delivered() {
    let registry = HookRegistry::new();
    let spy = Arc::new(PayloadSpy {
        seen: Arc::new(std::sync::Mutex::new(Vec::new())),
    });
    let kinds = [
        HookEventKind::SessionStart,
        HookEventKind::SessionEnd,
        HookEventKind::TurnStart,
        HookEventKind::ToolError,
        HookEventKind::ContextCompactStart,
        HookEventKind::ContextCompactEnd,
        HookEventKind::ErrorOccurred,
        HookEventKind::ModelBeforeRequest,
        HookEventKind::ModelAfterResponse,
        HookEventKind::SubagentStart,
        HookEventKind::SubagentEnd,
    ];
    for kind in kinds {
        registry.register_observe(
            kind,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
        );
    }
    let events = new_variant_events();
    for event in &events {
        registry.dispatch(event).await.unwrap();
    }
    let seen = spy.seen.lock().unwrap();
    assert_eq!(seen.len(), events.len(), "全部新变体必须送达对应 handler");
}
