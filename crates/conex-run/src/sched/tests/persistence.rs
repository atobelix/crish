//! Cron SQLite 持久化、LocalDb 真适配、字段保护与重启恢复测试

use std::sync::Arc;
use std::time::Duration;

use conex_db::LocalDb;
use orchestrator::PendingMessageQueue;

use super::*;

#[tokio::test]
async fn scheduler_registry_persists_and_recovers() {
    let store = MemorySchedStore::shared();
    let next_fire_at_snapshot = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::clone(&pending) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));
        let cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册应成功");
        assert_eq!(cron_id, "cron-0");
        let persisted = store.load_all();
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].enabled, "注册后应 enabled=true");
        assert_eq!(persisted[0].status, CronTaskStatus::Active);
        persisted[0].next_fire_at_ms
    };

    let (registry_b, queue_b, events_b) = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::clone(&pending) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn SchedStore>,
            None,
        ));
        registry.set_fire_override_ms(40);
        registry.restore().await;
        let persisted = store.load_all();
        assert_eq!(
            persisted[0].next_fire_at_ms, next_fire_at_snapshot,
            "重启恢复应保留 next_fire_at_ms"
        );
        assert!(
            registry.has_active(),
            "未到期任务恢复后应为活跃（sleep 已重建）"
        );
        (registry, queue, events)
    };

    let events_b_cond = Arc::clone(&events_b);
    let queue_b_cond = Arc::clone(&queue_b);
    wait_until(
        "恢复后触发完成（CronFired 1 条 + 完成通知）",
        move || {
            events_b_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 1
                && queue_len(&queue_b_cond) == 1
        },
    )
    .await;
    let entries = snapshot_queue(&queue_b);
    assert_eq!(entries.len(), 1, "恢复后触发应恰好一条");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id("cron-0").as_str())
    );
    assert!(
        entries[0].text.contains("已达最大触发次数 1，已停止"),
        "恢复触发收口应为完成通知：{}",
        entries[0].text
    );
    assert_eq!(
        events_b
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        1
    );
    let persisted = store.load_all();
    assert_eq!(persisted[0].fired_count, 1);
    assert_eq!(persisted[0].status, CronTaskStatus::Completed);
    assert!(!persisted[0].enabled);
    assert!(!registry_b.has_active());

    // 再次模拟重启 → Completed 跳过 → 不重复触发
    let queue_c = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending_c = Arc::new(QueuePendingSink::new(Arc::clone(&queue_c)));
    let events_c = Arc::new(ProbeEvents::default());
    let registry_c = Arc::new(SchedulerRegistry::new(
        Arc::clone(&pending_c) as Arc<dyn PendingSink>,
        Arc::clone(&events_c) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        None,
    ));
    registry_c.set_fire_override_ms(40);
    registry_c.restore().await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        snapshot_queue(&queue_c).is_empty(),
        "Completed 的声明恢复后不得重复触发"
    );
    assert!(
        events_c
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "Completed 的声明恢复后不得重复发射"
    );
    assert!(!registry_c.has_active());
}

#[test]
fn local_db_sched_store_roundtrip() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbSchedStore::new(db);
    let first = task("cron-0");
    store.save(&first);
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0], first, "读回应与写入一致");

    store.save(&first);
    assert_eq!(store.load_all().len(), 1, "同 id 重复保存不得新增");

    let second = task("cron-1");
    store.save(&second);
    let all = store.load_all();
    assert_eq!(all.len(), 2, "多 id 经 sched_index 索引枚举齐全");
    assert!(all.iter().any(|t| t.cron_id == "cron-1"));
}

#[test]
fn local_db_sched_store_safe_field_merge_preserves_business_fields() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbSchedStore::new(db.clone());

    // 模拟上层业务写入包含 name, schedule 对象, cwd, targetSessionId 等业务元数据
    let raw_workflow_json = serde_json::json!({
        "id": "cron-0",
        "cronId": "cron-0",
        "name": "每日自动化审查",
        "schedule": { "type": "cron", "expression": "0 9 * * *" },
        "cwd": "C:/Software/conex",
        "targetSessionId": "sess-main",
        "prompt": "初始提示词",
        "status": "active",
        "enabled": true,
        "nextFireAtMs": 5000,
        "firedCount": 0,
        "createdAtMs": 1000,
        "updatedAtMs": 1000
    });
    db.set_session_meta(&store_key("cron-0"), &raw_workflow_json.to_string())
        .unwrap();
    db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-0"]"#)
        .unwrap();

    // 底层调度器更新 firedCount 与 nextFireAtMs
    let mut task_update = task("cron-0");
    task_update.fired_count = 3;
    task_update.next_fire_at_ms = 999_999;
    task_update.target_session_id = Some("sess-main".to_string());
    store.save(&task_update);

    // 验证底层读取
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].fired_count, 3);
    assert_eq!(loaded[0].next_fire_at_ms, 999_999);
    assert_eq!(loaded[0].target_session_id.as_deref(), Some("sess-main"));

    // 验证数据库原始 JSON：非调度字段 name, schedule, cwd, createdAtMs 被 100% 完整保留！
    let raw_json_str = db
        .get_session_meta(&store_key("cron-0"))
        .unwrap()
        .expect("key 必须存在");
    let merged_val: serde_json::Value = serde_json::from_str(&raw_json_str).unwrap();
    assert_eq!(
        merged_val["name"], "每日自动化审查",
        "业务字段 name 严禁被抹除！"
    );
    assert_eq!(
        merged_val["cwd"], "C:/Software/conex",
        "业务字段 cwd 严禁被抹除！"
    );
    assert_eq!(
        merged_val["schedule"]["type"], "cron",
        "业务字段 schedule 严禁被抹除！"
    );
    assert_eq!(merged_val["createdAtMs"], 1000, "原创建时间必须被保留！");
    assert_eq!(
        merged_val["firedCount"], 3,
        "运行态 firedCount 必须被更新！"
    );
}

#[test]
fn local_db_sched_store_index_convergence_merges_legacy_sched_ids() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbSchedStore::new(db.clone());

    db.set_session_meta(
        LEGACY_SESSION_META_SCHED_INDEX_KEY,
        r#"["cron-old-1", "cron-old-2"]"#,
    )
    .unwrap();
    db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-new-1"]"#)
        .unwrap();

    store.save(&task("cron-old-1"));
    store.save(&task("cron-old-2"));
    store.save(&task("cron-new-1"));

    let all = store.load_all();
    assert_eq!(
        all.len(),
        3,
        "存量 sched_ids 与新 sched_index 必须无缝聚合！"
    );

    let converged_index: Vec<String> = serde_json::from_str(
        &db.get_session_meta(SESSION_META_SCHED_INDEX_KEY)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(converged_index.len(), 3);
    assert!(converged_index.contains(&"cron-old-1".to_string()));
    assert!(converged_index.contains(&"cron-old-2".to_string()));
    assert!(converged_index.contains(&"cron-new-1".to_string()));
}

#[test]
fn local_db_sched_store_remove() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbSchedStore::new(db.clone());

    store.save(&task("cron-0"));
    store.save(&task("cron-1"));
    assert_eq!(store.load_all().len(), 2);

    store.remove("cron-0");
    let remaining = store.load_all();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].cron_id, "cron-1");
    assert!(db.get_session_meta(&store_key("cron-0")).unwrap().is_none());
}

#[test]
fn local_db_sched_store_recovers_across_instances() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    {
        let store = LocalDbSchedStore::new(db.clone());
        store.save(&task("cron-0"));
        store.save(&task("cron-1"));
    }
    let store = LocalDbSchedStore::new(db);
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 2, "重启后声明应完全恢复");
    assert!(loaded.iter().any(|t| t.cron_id == "cron-0"));
    assert!(loaded.iter().any(|t| t.cron_id == "cron-1"));
}

#[test]
fn local_db_sched_store_fail_open() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbSchedStore::new(db.clone());
    assert!(store.load_all().is_empty(), "空库 → 空集（fail-open）");

    let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-0"]"#);
    let _ = db.set_session_meta(&store_key("cron-0"), "not-json");
    assert!(store.load_all().is_empty(), "坏 JSON 键值 → 跳过不 panic");

    let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, r#"["cron-9"]"#);
    assert!(store.load_all().is_empty(), "孤儿 id（键缺失）→ 跳过");

    let _ = db.set_session_meta(SESSION_META_SCHED_INDEX_KEY, "not-json");
    assert!(store.load_all().is_empty(), "索引坏 JSON → 空集");
}

#[tokio::test]
async fn local_db_scheduler_registry_persists_and_recovers() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let next_fire_at_snapshot = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::new(LocalDbSchedStore::new(db.clone())) as Arc<dyn SchedStore>,
            None,
        ));
        let cron_id = registry
            .register(test_input("* * * * *", Some(1), false))
            .await
            .expect("注册应成功");
        assert_eq!(cron_id, "cron-0");
        let persisted = LocalDbSchedStore::new(db.clone()).load_all();
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].enabled, "注册后应 enabled=true");
        assert_eq!(persisted[0].status, CronTaskStatus::Active);
        persisted[0].next_fire_at_ms
    };

    let (registry_b, queue_b, events_b) = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::new(LocalDbSchedStore::new(db.clone())) as Arc<dyn SchedStore>,
            None,
        ));
        registry.set_fire_override_ms(40);
        registry.restore().await;
        let persisted = LocalDbSchedStore::new(db.clone()).load_all();
        assert_eq!(
            persisted[0].next_fire_at_ms, next_fire_at_snapshot,
            "重启恢复应保留 next_fire_at_ms"
        );
        assert!(
            registry.has_active(),
            "未到期任务恢复后应为活跃（sleep 已重建）"
        );
        (registry, queue, events)
    };

    let events_b_cond = Arc::clone(&events_b);
    let queue_b_cond = Arc::clone(&queue_b);
    wait_until(
        "恢复后触发完成（CronFired 1 条 + 完成通知）",
        move || {
            events_b_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 1
                && queue_len(&queue_b_cond) == 1
        },
    )
    .await;
    let entries = snapshot_queue(&queue_b);
    assert_eq!(entries.len(), 1, "恢复后触发应恰好一条");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id("cron-0").as_str())
    );
    assert!(
        entries[0].text.contains("已达最大触发次数 1，已停止"),
        "恢复触发收口应为完成通知：{}",
        entries[0].text
    );
    assert_eq!(
        events_b
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        1
    );
    let persisted = LocalDbSchedStore::new(db.clone()).load_all();
    assert_eq!(persisted[0].fired_count, 1);
    assert_eq!(persisted[0].status, CronTaskStatus::Completed);
    assert!(!persisted[0].enabled);
    assert!(!registry_b.has_active());

    // 再次模拟重启 → Completed 跳过
    {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(SchedulerRegistry::new(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))) as Arc<dyn PendingSink>,
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::new(LocalDbSchedStore::new(db.clone())) as Arc<dyn SchedStore>,
            None,
        ));
        registry.set_fire_override_ms(40);
        registry.restore().await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            snapshot_queue(&queue).is_empty(),
            "Completed 的声明恢复后不得重复触发"
        );
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "Completed 的声明恢复后不得重复发射"
        );
        assert!(!registry.has_active());
    }
}

#[tokio::test]
async fn test_restore_idempotency_and_offline_task_pre_insert() {
    let store = MemorySchedStore::shared();
    let now = now_ms();
    let expired_task = CronTask {
        cron_id: "cron-offline-9".to_string(),
        expression: "* * * * *".to_string(),
        prompt: "离线补发测试".to_string(),
        max_iterations: Some(1),
        is_daemon: false,
        next_fire_at_ms: now.saturating_sub(10_000),
        fired_count: 0,
        status: CronTaskStatus::Active,
        enabled: true,
        target_session_id: Some("session-offline".to_string()),
        created_at_ms: now.saturating_sub(20_000),
        updated_at_ms: now.saturating_sub(20_000),
    };
    store.save(&expired_task);

    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
    let events = Arc::new(ProbeEvents::default());
    let registry = Arc::new(SchedulerRegistry::new(
        pending,
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        None,
    ));

    // 1. 执行 restore()
    registry.restore().await;

    // 离线补发任务在 restore() 返回瞬间必须已被预插入 tasks 表消除真空期
    assert!(
        registry.has_active(),
        "离线补发任务必须在 tasks 内存表中消除真空期"
    );
    registry.restore().await;

    let events_cond = Arc::clone(&events);
    wait_until("离线补发完成", move || {
        !events_cond.emitted.lock().unwrap().is_empty()
    })
    .await;

    let emitted = events.emitted.lock().unwrap();
    assert_eq!(
        emitted.len(),
        1,
        "离线过期任务恰好补发一次，幂等守卫防重复生效！"
    );
    let persisted = store.load_all();
    assert_eq!(persisted[0].fired_count, 1);
    assert_eq!(persisted[0].status, CronTaskStatus::Completed);
}
