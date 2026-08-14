// SR-06d · 拆分 · ≠ EL：recovery.rs 测试旁挂第 2 段（include! 接线，无孤儿；
// 协调器逐级测试原样保留——阶梯 1-4 全链 + 重启恢复 + 预算超限 + G10 统计）。

// ── 协调器逐级测试 ────────────────────────────────────────────

/// 阶梯 1 自动重试：瞬态错误预算内 → AutoRetry，无 steering、无通知
#[tokio::test]
async fn ladder1_auto_retry_within_budget() {
    let (env, mut coordinator) = env();
    for (retries, expected_attempt, expected_delay) in [(0u32, 1u32, 750u64), (1, 2, 1500)] {
        let outcome = coordinator
            .on_subagent_run_failure(&ctx("run-1", ProviderErrorKind::Network, retries, 0))
            .await
            .unwrap();
        assert_eq!(outcome.ladder, RecoveryLadder::Ladder1AutoRetry);
        match outcome.action {
            RecoveryAction::AutoRetry { attempt, delay } => {
                assert_eq!(attempt, expected_attempt);
                assert_eq!(delay, Duration::from_millis(expected_delay));
            }
            other => panic!("期望 AutoRetry：{other:?}"),
        }
    }
    // 无 steering 条目、无通知落库、无任何留痕事件
    assert!(!env.queue.lock().unwrap().has_pending());
    assert_eq!(coordinator.pending_notifications(), 0);
    assert!(env.store.events().is_empty(), "重试不计入留痕");
}

/// 阶梯 2：预算耗尽 → steering 条目入队 + 通知落库 + 事件留痕
#[tokio::test]
async fn ladder2_steering_queued_on_budget_exhaustion() {
    let (env, mut coordinator) = env();
    let outcome = coordinator
        .on_subagent_run_failure(&ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000))
        .await
        .unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder2MainAgent);
    let RecoveryAction::SteeringQueued { notification } = outcome.action else {
        panic!("期望 SteeringQueued");
    };
    assert!(notification.pending);
    assert_eq!(notification.retries, 5);
    assert_eq!(
        notification.error_kind,
        Some(ProviderErrorKind::ServerError),
        "steering 通知承载错误分类（ctx.error_kind 透传）"
    );
    // 主 agent 可读（dequeue_all 取到条目）
    let mut queue = env.queue.lock().unwrap();
    let drained = queue.dequeue_all();
    assert_eq!(drained.len(), 1);
    assert!(drained[0].text.contains("run-1"));
    assert!(
        drained[0].text.contains("服务端类错误(ServerError)"),
        "steering 文本含具体 kind"
    );
    drop(queue);
    // 通知已落库（重启恢复依据）
    assert_eq!(coordinator.pending_notifications(), 1);
    // 留痕事件：升级 + steering 两条
    let events = env.store.events();
    let types: Vec<&str> = events.iter().map(|(_, t, _)| t.as_str()).collect();
    assert_eq!(types, vec![RECOVER_ESCALATED_EVENT, RECOVER_STEERING_EVENT]);
}

/// 阶梯 2 激活路径：steering 条目可转为用户消息注入主 agent
/// （transfer_follow_up 语义）；acknowledge 后重启不重排
#[tokio::test]
async fn ladder2_activation_path_and_acknowledge() {
    let (env, mut coordinator) = env();
    coordinator
        .on_subagent_run_failure(&ctx("run-1", ProviderErrorKind::Timeout, 3, 61_000))
        .await
        .unwrap();
    // 引擎在主 agent 下一条消息边界消费：条目转为用户消息（L1 载体）
    let mut queue = env.queue.lock().unwrap();
    let mut input = session_loop::input::AgentInputQueue::new();
    let count = queue.transfer_follow_up(&mut input);
    assert_eq!(count, 1);
    assert!(input.has_follow_up_pending());
    assert_eq!(input.promote_follow_up(), 1);
    let message = input.dequeue().expect("promote 后可消费");
    assert!(message.text().contains("run-1"));
    assert_eq!(
        message
            .metadata
            .as_ref()
            .and_then(|m| m.get("kind"))
            .and_then(|k| k.as_str()),
        Some("steering")
    );
    drop(queue);
    // acknowledge：主 agent 已处理 → pending = false
    assert!(coordinator.acknowledge("run-1").unwrap());
    assert!(
        !coordinator.acknowledge("run-1").unwrap(),
        "幂等：二次确认无变更"
    );
    assert_eq!(coordinator.pending_notifications(), 0);
    // EV-08：翻转留痕——每次实际翻转发 recovery-acknowledged（typed
    // 序列化，载荷含 subagentRunId；幂等二次确认无新事件）
    let events = env.store.events();
    let ack: Vec<_> = events
        .iter()
        .filter(|(_, t, _)| t == RECOVER_ACKNOWLEDGED_EVENT)
        .collect();
    assert_eq!(ack.len(), 1, "仅实际翻转发射一次（幂等不发）");
    let (session, event_type, payload) = &ack[0];
    assert_eq!(session, "s1");
    assert_eq!(event_type, "recovery-acknowledged");
    let value: serde_json::Value = serde_json::from_str(payload).expect("载荷合法 JSON");
    assert_eq!(value["type"], "recovery-acknowledged", "typed 顶层 type 键");
    assert_eq!(value["sessionId"], "s1");
    assert_eq!(value["subagentRunId"], "run-1", "载荷携带被确认的 run id");
    assert!(value["timestamp"].as_str().is_some(), "时间戳非空");
}

/// 重启恢复：未处理的阶梯 2 通知仍在队列（04 C7 验收 5）
#[tokio::test]
async fn restart_keeps_pending_steering() {
    let (env, mut coordinator) = env();
    coordinator
        .on_subagent_run_failure(&ctx("run-1", ProviderErrorKind::Network, 4, 62_000))
        .await
        .unwrap();
    // 模拟重启：同一 store 新建协调器（预算/通知恢复）
    let new_queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let mut restarted = RecoveryCoordinator::new(
        "s1",
        env.store.clone(),
        new_queue.clone(),
        env.tree.clone(),
        env.spawner.clone(),
        RecoveryRetryPolicy {
            max_retries: 5,
            ..RecoveryRetryPolicy::default()
        },
    )
    .unwrap();
    assert_eq!(restarted.pending_notifications(), 1, "通知跨重启恢复");
    // 重排入队后主 agent 可读
    let restored = restarted.restore_steering_notifications().unwrap();
    assert_eq!(restored, 1);
    let mut queue = new_queue.lock().unwrap();
    let drained = queue.dequeue_all();
    assert_eq!(drained.len(), 1);
    assert!(drained[0].text.contains("run-1"));
}

/// 阶梯 3：fork 新 run + 路径落库 + 原 run failed + 事件留痕
#[tokio::test]
async fn ladder3_fork_creates_new_run_with_path() {
    let (env, mut coordinator) = env();
    let failure_ctx = ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000);
    coordinator
        .on_subagent_run_failure(&failure_ctx)
        .await
        .unwrap();
    let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let RecoveryAction::Forked { record } = outcome.action else {
        panic!("期望 Forked");
    };
    assert_eq!(record.from_run_id, "run-1");
    assert_eq!(record.new_run_id, "fork-run-0");
    assert_eq!(record.context_mode, ForkContextMode::Verbatim);
    // 会话树：新叶子挂在源叶子下
    let tree = env.tree.lock().unwrap();
    let new_leaf = tree.entry(&record.new_leaf_id).expect("fork 叶子必须存在");
    assert_eq!(new_leaf.parent_id.as_deref(), Some("leaf-a"));
    // 工作流路径（根 → 新叶子）
    let path = tree.read_branch_path(Some(&record.new_leaf_id)).unwrap();
    let ids: Vec<&str> = path.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["leaf-a", record.new_leaf_id.as_str()]);
    drop(tree);
    // 路径落 subagent_path_json（新 run 行）
    let path_json = env.store.path("fork-run-0").expect("路径必须落库");
    let ids: Vec<String> = serde_json::from_str(&path_json).unwrap();
    assert_eq!(ids, vec!["leaf-a".to_string(), record.new_leaf_id]);
    // 原 run 置 failed
    assert_eq!(
        env.store.run_status("run-1").unwrap(),
        ("failed".to_string(), "recovery-fork".to_string())
    );
    // spawner 请求：同一目标 prompt
    let requests = env.spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].prompt, "完成模块 A");
    // 事件留痕
    let events = env.store.events();
    let types: Vec<&str> = events.iter().map(|(_, t, _)| t.as_str()).collect();
    assert!(types.contains(&RECOVER_FORK_EVENT));
    // 预算计数
    assert_eq!(
        coordinator
            .budget()
            .count(&fingerprint("sub-1", "完成模块 A")),
        1
    );
}

/// 阶梯 3 幂等：同指纹同源 run 重复 fork 返回既有记录，不重复 spawn
#[tokio::test]
async fn ladder3_fork_idempotent() {
    let (env, mut coordinator) = env();
    let failure_ctx = ctx("run-1", ProviderErrorKind::Network, 4, 61_000);
    let first = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    let second = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    let RecoveryAction::Forked { record: a } = first.action else {
        panic!("期望 Forked");
    };
    let RecoveryAction::Forked { record: b } = second.action else {
        panic!("期望 Forked");
    };
    assert_eq!(a, b, "幂等：重复 fork 返回同一记录");
    assert_eq!(env.spawner.requests().len(), 1, "不重复 spawn");
    assert_eq!(coordinator.budget().count(&a.fingerprint), 1, "不重复计数");
}

/// 预算超限：fork 第 4 次（limit=3）→ 阶梯 4 上报用户，不再 fork
#[tokio::test]
async fn ladder3_budget_exhausted_goes_ladder4() {
    let (env, mut coordinator) = env();
    // 前 3 次 fork 成功
    for i in 0..3 {
        let failure_ctx = ctx(
            &format!("run-{i}"),
            ProviderErrorKind::ServerError,
            4,
            61_000,
        );
        let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
        assert_eq!(
            outcome.ladder,
            RecoveryLadder::Ladder3Fork,
            "第 {} 次 fork",
            i + 1
        );
    }
    // 第 4 次（不同 run 同指纹）→ 直接阶梯 4
    let failure_ctx = ctx("run-3", ProviderErrorKind::ServerError, 4, 61_000);
    let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
    let RecoveryAction::NeedsUser { report } = outcome.action else {
        panic!("期望 NeedsUser");
    };
    assert_eq!(report.subagent_run_id, "run-3");
    assert!(report.suggestion.contains("人工决策"));
    assert!(
        env.store.run_status("run-3").is_none(),
        "预算超限不再置 failed 之外的状态"
    );
    // 需介入标记 + 上报事件
    assert!(coordinator.run_needs_user("run-3"));
    let events = env.store.events();
    let types: Vec<&str> = events.iter().map(|(_, t, _)| t.as_str()).collect();
    assert!(types.contains(&RECOVER_BUDGET_DENIED_EVENT));
    assert!(types.contains(&RECOVER_REPORT_EVENT));
}

/// 预算超限直接阶梯 4（on_subagent_run_failure 路径：不产生阶梯 2 通知）
#[tokio::test]
async fn ladder2_skipped_when_budget_exhausted() {
    let (env, mut coordinator) = env();
    // 前 3 次 fork 耗尽预算
    for i in 0..3 {
        let failure_ctx = ctx(&format!("run-{i}"), ProviderErrorKind::Network, 4, 61_000);
        coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    }
    // 新 run 再失败：预算已耗尽 → 跳过阶梯 2 直接阶梯 4
    let outcome = coordinator
        .on_subagent_run_failure(&ctx("run-9", ProviderErrorKind::Network, 4, 61_000))
        .await
        .unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
    // 无新的 steering 条目
    assert_eq!(env.queue.lock().unwrap().len(), 0);
    // 上报含 3 次 fork 尝试记录
    let RecoveryAction::NeedsUser { report } = outcome.action else {
        panic!("期望 NeedsUser");
    };
    let fork_attempts = report
        .attempts
        .iter()
        .filter(|a| a.ladder == RecoveryLadder::Ladder3Fork)
        .count();
    assert_eq!(fork_attempts, 3, "试过什么：3 次 fork 记录");
}

/// G10 月度统计收集点：预算耗尽拒绝同时累计全局 denied 统计
/// （delta 断言，防全局实例跨测试累计污染）
#[tokio::test]
async fn g10_budget_denied_increments_global_stats() {
    use conex_types::denied_stats::global_denied_stats;
    let before = global_denied_stats().summary().recovery_budget_denied;
    let (env, mut coordinator) = env();
    // 前 3 次 fork 耗尽预算（limit=3）
    for i in 0..3 {
        let failure_ctx = ctx(&format!("run-{i}"), ProviderErrorKind::Network, 4, 61_000);
        coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    }
    // 新 run 再失败：预算耗尽 → recovery-budget-denied 事件 + 全局计数 +1
    let outcome = coordinator
        .on_subagent_run_failure(&ctx("run-g10", ProviderErrorKind::Network, 4, 61_000))
        .await
        .unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
    assert!(
        env.store
            .events()
            .iter()
            .any(|(_, t, _)| t == RECOVER_BUDGET_DENIED_EVENT),
        "预算拒绝事件留痕"
    );
    let after = global_denied_stats().summary().recovery_budget_denied;
    assert_eq!(
        after,
        before + 1,
        "全局恢复预算 denied 计数应 +1（月度报告数据源）"
    );
}

/// 重启恢复预算：跨重启计数一致，不重放授权
#[tokio::test]
async fn restart_recovers_budget_counts() {
    let (env, mut coordinator) = env();
    for i in 0..2 {
        let failure_ctx = ctx(
            &format!("run-{i}"),
            ProviderErrorKind::ServerError,
            4,
            61_000,
        );
        coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    }
    // 模拟重启
    let mut restarted = RecoveryCoordinator::new(
        "s1",
        env.store.clone(),
        env.queue.clone(),
        env.tree.clone(),
        env.spawner.clone(),
        RecoveryRetryPolicy {
            max_retries: 5,
            ..RecoveryRetryPolicy::default()
        },
    )
    .unwrap();
    let fp = fingerprint("sub-1", "完成模块 A");
    assert_eq!(restarted.budget().count(&fp), 2, "预算跨重启恢复");
    assert!(restarted.budget().can_recover(&fp), "2 < 3 仍可恢复");
    // 第 3 次 fork 后超限
    let failure_ctx = ctx("run-2", ProviderErrorKind::ServerError, 4, 61_000);
    let outcome = restarted.fork_and_reassign(&failure_ctx).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    assert!(!restarted.budget().can_recover(&fp));
}

/// 阶梯 4 上报内容：卡在哪一步 + 试过什么 + 建议怎么办
#[tokio::test]
async fn ladder4_report_content() {
    let (env, mut coordinator) = env();
    // 一次阶梯 2 通知 + 一次 fork
    let failure_ctx = ctx("run-1", ProviderErrorKind::Timeout, 3, 61_000);
    coordinator
        .on_subagent_run_failure(&failure_ctx)
        .await
        .unwrap();
    coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    // 新 run 再失败 → 预算仍够 → 阶梯 2；主 agent 决策上报
    let failure_ctx = ctx("fork-run-0", ProviderErrorKind::Timeout, 3, 61_000);
    let outcome = coordinator.report_to_user(&failure_ctx).unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder4User);
    let RecoveryAction::NeedsUser { report } = outcome.action else {
        panic!("期望 NeedsUser");
    };
    assert_eq!(report.subagent_run_id, "fork-run-0");
    // 尝试记录：阶梯 1 + 阶梯 2 + 阶梯 3 各 ≥1 条
    assert!(report
        .attempts
        .iter()
        .any(|a| a.ladder == RecoveryLadder::Ladder1AutoRetry));
    assert!(report
        .attempts
        .iter()
        .any(|a| a.ladder == RecoveryLadder::Ladder2MainAgent));
    assert!(report
        .attempts
        .iter()
        .any(|a| a.ladder == RecoveryLadder::Ladder3Fork));
    assert!(report.suggestion.contains("人工决策"), "建议含决策指引");
    assert!(report.suggestion.contains("fork-run-0"), "建议引用停摆 run");
    // 需介入标记落库
    assert!(coordinator.run_needs_user("fork-run-0"));
    let raw = env
        .store
        .meta
        .lock()
        .unwrap()
        .get(RECOVER_NEEDS_USER_KEY)
        .cloned();
    let ids: Vec<String> = serde_json::from_str(&raw.unwrap()).unwrap();
    assert_eq!(ids, vec!["fork-run-0"]);
}

/// fork 源叶子缺失 → 结构化错误（不 panic、不产生 run）
#[tokio::test]
async fn ladder3_fork_without_leaf_rejected() {
    let (_env, mut coordinator) = env();
    let mut ctx = ctx("run-1", ProviderErrorKind::ServerError, 4, 61_000);
    ctx.from_leaf_id = None;
    let err = coordinator.fork_and_reassign(&ctx).await.unwrap_err();
    assert!(
        matches!(err, RecoveryError::InvalidState { .. }),
        "缺少源叶子必须结构化拒绝：{err:?}"
    );
}

/// fork spawn 失败 → 结构化错误上抛（不 panic、原 run 状态不变）
#[tokio::test]
async fn ladder3_spawn_failure_escalates() {
    let store = InMemoryRecoveryStore::new();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new("s1")));
    tree.lock()
        .unwrap()
        .append("leaf-a", json!({ "text": "root" }))
        .unwrap();
    let spawner = RecordingSpawner::rejecting();
    let mut coordinator = RecoveryCoordinator::new(
        "s1",
        store.clone(),
        queue.clone(),
        tree.clone(),
        spawner,
        RecoveryRetryPolicy {
            max_retries: 5,
            ..RecoveryRetryPolicy::default()
        },
    )
    .unwrap();
    let failure_ctx = ctx("run-1", ProviderErrorKind::ServerError, 4, 61_000);
    let err = coordinator
        .fork_and_reassign(&failure_ctx)
        .await
        .unwrap_err();
    assert!(
        matches!(err, RecoveryError::PersistFailed { .. }),
        "spawn 失败必须结构化上抛：{err:?}"
    );
    // 预算未消费（spawn 失败不计数）
    assert_eq!(
        coordinator
            .budget()
            .count(&fingerprint("sub-1", "完成模块 A")),
        0
    );
}

// ── DM-05 直写路径规范化：payload 顶层 type 键 ──────────────────

/// DM-05：恢复域六直写点 payload 全部补顶层 type 键（与 event_type 列
/// 一致，读侧 D8 fallback 可路由）；typed 路径（escalated / budget-denied）
/// 字段形状与 conex-types 注册表（engine-events.json id 42/46）对齐；
/// 镜像路径（steering / fork / report）字段保真不丢失（errorKind /
/// createdAtMs / attempts 为 typed 变体形状之外的超集字段，降级保真）
#[tokio::test]
async fn recovery_event_payload_type_tagged() {
    let (env, mut coordinator) = env();
    // 阶梯 2 路径：escalated + steering
    let failure_ctx = ctx("run-1", ProviderErrorKind::ServerError, 5, 61_000);
    coordinator
        .on_subagent_run_failure(&failure_ctx)
        .await
        .unwrap();
    // 阶梯 3 fork 路径（同指纹三次 fork 耗尽预算 limit=3）
    coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    for i in 1..=2 {
        let fork_ctx = ctx(
            &format!("run-fork-{i}"),
            ProviderErrorKind::ServerError,
            4,
            61_000,
        );
        coordinator.fork_and_reassign(&fork_ctx).await.unwrap();
    }
    // 预算耗尽：fork 路径 budget-denied + report
    coordinator
        .fork_and_reassign(&ctx("run-fork-3", ProviderErrorKind::ServerError, 4, 61_000))
        .await
        .unwrap();
    // 预算耗尽：on_subagent_run_failure 路径 budget-denied + report
    coordinator
        .on_subagent_run_failure(&ctx("run-9", ProviderErrorKind::Network, 4, 61_000))
        .await
        .unwrap();

    let events = env.store.events();
    // 六直写点留痕 = escalated×2 + steering + fork×3 + denied×2 +
    // report×2（run-9 阶梯 1 上行先写 escalated 再预算拒绝，共 10 条）
    assert_eq!(events.len(), 10, "六直写点全部留痕");
    for (_, event_type, payload) in &events {
        let value: serde_json::Value = serde_json::from_str(payload)
            .unwrap_or_else(|e| panic!("{event_type} payload 非法 JSON：{e}"));
        assert_eq!(
            value["type"].as_str(),
            Some(event_type.as_str()),
            "{event_type} payload 顶层 type 键须与事件类型一致"
        );
    }
    let payload_of = |event_type: &str| {
        events
            .iter()
            .find(|(_, t, _)| t == event_type)
            .unwrap()
            .2
            .clone()
    };
    // typed 路径（engine-events.json id 42）：字段形状与注册表对齐
    let escalated: serde_json::Value =
        serde_json::from_str(&payload_of(RECOVER_ESCALATED_EVENT)).unwrap();
    assert_eq!(escalated["sessionId"], "s1");
    assert_eq!(escalated["subagentRunId"], "run-1");
    assert_eq!(escalated["retries"], 5);
    assert_eq!(escalated["elapsedMs"], 61_000);
    assert!(escalated.get("kind").is_some());
    // typed 路径（engine-events.json id 46）：budget-denied 双路径同形
    // （fork 路径 run-fork-3 + failure 路径 run-9）
    let denied: Vec<serde_json::Value> = events
        .iter()
        .filter(|(_, t, _)| t == RECOVER_BUDGET_DENIED_EVENT)
        .map(|(_, _, p)| serde_json::from_str(p).unwrap())
        .collect();
    assert_eq!(denied.len(), 2, "budget-denied 双路径各一");
    for d in &denied {
        assert_eq!(d["count"], 3);
        assert_eq!(d["max"], 3);
        assert_eq!(d["sessionId"], "s1");
        assert!(d.get("fingerprint").is_some());
    }
    let denied_ids: Vec<Option<&str>> = denied
        .iter()
        .map(|d| d["subagentRunId"].as_str())
        .collect();
    assert_eq!(
        denied_ids,
        vec![Some("run-fork-3"), Some("run-9")],
        "fork 路径 + failure 路径 subagentRunId 各一"
    );
    // 镜像路径保真（typed 变体无 errorKind/createdAtMs/attempts 字段，
    // 降级为镜像 + type 键，字段不丢失）
    let steering: serde_json::Value =
        serde_json::from_str(&payload_of(RECOVER_STEERING_EVENT)).unwrap();
    assert_eq!(
        steering["errorKind"], "server-error",
        "steering 镜像保真 errorKind"
    );
    assert_eq!(steering["subagentRunId"], "run-1");
    let fork: serde_json::Value = serde_json::from_str(&payload_of(RECOVER_FORK_EVENT)).unwrap();
    assert!(fork.get("createdAtMs").is_some(), "fork 镜像保真 createdAtMs");
    let report: serde_json::Value = serde_json::from_str(&payload_of(RECOVER_REPORT_EVENT)).unwrap();
    assert!(
        report.get("attempts").is_some(),
        "report 镜像保真 attempts（typed 变体不含该字段）"
    );
}

// ── LK-02 fork 反查传播（parent_tool_call_id 双态）───────────────

/// LK-02 S5 测钉（有行态）：fork 前反查原 session_agents 行并传播
/// parent_tool_call_id——fork 请求携带原行真值（链路键随 fork 延续）
#[tokio::test]
async fn fork_propagates_parent_tool_call_id_from_original_row() {
    let (env, mut coordinator) = env();
    env.store
        .seed_parent_tool_call("run-1", Some("call-orig-1".to_string()));
    let failure_ctx = ctx("run-1", ProviderErrorKind::ServerError, 4, 61_000);
    let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let requests = env.spawner.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].parent_tool_call_id.as_deref(),
        Some("call-orig-1"),
        "fork 请求必须传播原 run 行的 parent_tool_call_id"
    );
}

/// LK-02 S5 测钉（无行态）：原 run 行不存在（或键为空）→ fork 照常
/// 成功，请求 parent_tool_call_id = None（键是观测增强非前置条件，
/// 不因缺键阻断恢复）
#[tokio::test]
async fn fork_without_parent_tool_call_row_keeps_none_and_succeeds() {
    let (env, mut coordinator) = env();
    // 不预置原 run 行（store 反查 None）
    let failure_ctx = ctx("run-ghost", ProviderErrorKind::ServerError, 4, 61_000);
    let outcome = coordinator.fork_and_reassign(&failure_ctx).await.unwrap();
    assert_eq!(outcome.ladder, RecoveryLadder::Ladder3Fork);
    let requests = env.spawner.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].parent_tool_call_id.is_none(),
        "查不到原行键 → 保持 None（fork 不被观测缺口阻断）"
    );
}
