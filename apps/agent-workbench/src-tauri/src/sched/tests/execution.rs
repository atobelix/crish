//! Cron 周期触发、重叠并发抑制、动态生命周期控制与 ScheduledTaskLauncher 真实启动单测

use std::sync::Arc;
use std::time::Duration;

use super::*;

#[tokio::test]
async fn scheduler_registry_fires_cron_steering() {
    let (registry, pending, events, store) = test_registry();
    registry.set_fire_override_ms(40);
    let cron_id = registry
        .register(test_input("* * * * *", Some(1), false))
        .await
        .expect("注册应成功");
    assert_eq!(cron_id, "cron-0");

    let events_cond = Arc::clone(&events);
    let pending_cond = Arc::clone(&pending);
    wait_until(
        "首次触发完成（CronFired 1 条 + 队列完成通知）",
        move || {
            events_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 1
                && queue_len(&pending_cond) == 1
        },
    )
    .await;

    let entries = snapshot_queue(&pending);
    assert_eq!(entries.len(), 1, "应恰好一条 steering 条目");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id(&cron_id).as_str())
    );
    assert!(
        entries[0].text.contains("已达最大触发次数 1，已停止"),
        "完成通知文本：{}",
        entries[0].text
    );

    let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(emitted.len(), 1);
    match &emitted[0] {
        CronEvent::Fired {
            cron_id: id,
            prompt,
            expression,
            iteration,
            fired_at_ms,
        } => {
            assert_eq!(id, &cron_id);
            assert_eq!(prompt, "检查编译结果");
            assert_eq!(expression, "* * * * *");
            assert_eq!(*iteration, 1);
            assert!(*fired_at_ms > 0);
        }
    }

    let persisted = store.load_all();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].fired_count, 1, "应恰好触发一次");
    assert_eq!(persisted[0].status, CronTaskStatus::Completed);
    assert!(!persisted[0].enabled, "max 达到后应 enabled=false");
    assert!(!registry.has_active(), "停止后不应有活跃任务");
}

#[tokio::test]
async fn scheduler_registry_max_iterations_stops() {
    let (registry, pending, events, store) = test_registry();
    registry.set_fire_override_ms(40);
    registry
        .register(test_input("* * * * *", Some(2), false))
        .await
        .expect("注册应成功");

    let events_cond = Arc::clone(&events);
    let pending_cond = Arc::clone(&pending);
    wait_until(
        "两次触发完成（CronFired 2 条 + 队列完成通知）",
        move || {
            events_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 2
                && queue_len(&pending_cond) == 1
        },
    )
    .await;

    let entries = snapshot_queue(&pending);
    assert_eq!(entries.len(), 1, "应仅剩完成通知（触发条目同组替换）");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id("cron-0").as_str())
    );
    assert!(
        entries[0]
            .text
            .contains("cron cron-0 已达最大触发次数 2，已停止"),
        "完成通知文本：{}",
        entries[0].text
    );

    let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(emitted.len(), 2, "两次触发后应停止，无第三次事件");
    let iterations: Vec<u64> = emitted
        .iter()
        .map(|e| match e {
            CronEvent::Fired { iteration, .. } => *iteration,
        })
        .collect();
    assert_eq!(iterations, vec![1, 2], "触发次数应从 1 起逐次递增");

    let persisted = store.load_all();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].fired_count, 2);
    assert_eq!(persisted[0].status, CronTaskStatus::Completed);
    assert!(!persisted[0].enabled);
    assert!(!registry.has_active(), "任务清除后不应有活跃条目");
}

#[tokio::test]
async fn scheduler_registry_is_daemon_spawns_run() {
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
    let events = Arc::new(ProbeEvents::default());
    let launcher = Arc::new(ProbeLauncher::default());
    let store = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(
        Arc::clone(&pending) as Arc<dyn PendingSink>,
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        Some(Arc::clone(&launcher) as Arc<dyn DaemonRunLauncher>),
    ));
    registry.set_fire_override_ms(40);
    registry
        .register(CronTaskInput {
            expression: "* * * * *".to_string(),
            prompt: "守护进程检查".to_string(),
            max_iterations: Some(1),
            is_daemon: true,
        })
        .await
        .expect("注册应成功");

    let launcher_cond = Arc::clone(&launcher);
    let queue_cond = Arc::clone(&queue);
    wait_until(
        "daemon run 拉起完成（launcher 调用 1 次 + 完成通知）",
        move || {
            launcher_cond
                .prompts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 1
                && queue_len(&queue_cond) == 1
        },
    )
    .await;

    let prompts = launcher.prompts.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(
        prompts.as_slice(),
        &["守护进程检查".to_string()],
        "run 拉起应恰好一次，prompt 为初始消息"
    );

    let entries = snapshot_queue(&queue);
    assert!(
        entries.iter().all(|e| !e.text.contains("第 1 次触发")),
        "daemon 成功路径不应注入触发条目：{entries:?}"
    );
    assert_eq!(entries.len(), 1, "max 停止后应仅完成通知");
    assert!(entries[0].text.contains("已达最大触发次数 1，已停止"));

    assert_eq!(
        events
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        1
    );
}

#[tokio::test]
async fn scheduler_registry_daemon_without_launcher_falls_back_to_steering() {
    let (registry, pending, events, _) = test_registry();
    registry.set_fire_override_ms(40);
    registry
        .register(CronTaskInput {
            expression: "* * * * *".to_string(),
            prompt: "守护进程检查".to_string(),
            max_iterations: None,
            is_daemon: true,
        })
        .await
        .expect("注册应成功");

    let events_cond = Arc::clone(&events);
    wait_until(
        "daemon 降级触发 ≥2 次（CronFired 事件 ≥2）",
        move || {
            events_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                >= 2
        },
    )
    .await;
    let entries = snapshot_queue(&pending);
    assert_eq!(
        entries.len(),
        1,
        "launcher 未接线应降级为 steering 条目（同组替换）"
    );
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id("cron-0").as_str())
    );
    assert!(
        entries[0].text.contains("守护进程检查（cron cron-0 第"),
        "降级条目文本应含 prompt 与唤醒模板：{}",
        entries[0].text
    );
    assert!(
        events
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
            >= 2,
        "持续触发应发射多条 CronFired"
    );
}

#[tokio::test]
async fn scheduler_registry_daemon_launch_failure_falls_back_to_steering() {
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
    let events = Arc::new(ProbeEvents::default());
    let launcher = Arc::new(ProbeLauncher {
        fail: true,
        ..Default::default()
    });
    let store = MemorySchedStore::shared();
    let registry = Arc::new(SchedulerRegistry::new(
        Arc::clone(&pending) as Arc<dyn PendingSink>,
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        Some(Arc::clone(&launcher) as Arc<dyn DaemonRunLauncher>),
    ));
    registry.set_fire_override_ms(40);
    registry
        .register(CronTaskInput {
            expression: "* * * * *".to_string(),
            prompt: "守护进程检查".to_string(),
            max_iterations: None,
            is_daemon: true,
        })
        .await
        .expect("注册应成功");

    let events_cond = Arc::clone(&events);
    let queue_cond = Arc::clone(&queue);
    wait_until(
        "launch 失败降级条目出现（CronFired ≥1 + 队列非空）",
        move || {
            !events_cond
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty()
                && queue_len(&queue_cond) == 1
        },
    )
    .await;

    let entries = snapshot_queue(&queue);
    assert_eq!(
        entries.len(),
        1,
        "启动失败应降级为 steering 条目（同组替换）"
    );
    assert!(
        entries[0].text.contains("守护进程检查（cron cron-0 第"),
        "降级条目文本应含 prompt 与唤醒模板：{}",
        entries[0].text
    );
    assert!(launcher
        .prompts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_empty());
}

#[tokio::test]
async fn scheduler_registry_pause_and_resume_task() {
    let (registry, pending, events, store) = test_registry();
    registry.set_fire_override_ms(40);
    let cron_id = registry
        .register(test_input("* * * * *", Some(5), false))
        .await
        .expect("注册成功");

    // 1. 单任务暂停
    registry.pause_task(&cron_id).await.expect("暂停应成功");
    assert!(!registry.has_active(), "暂停后不应有 Active 任务");

    let task_in_store = store.load_all();
    assert_eq!(task_in_store[0].status, CronTaskStatus::Paused);
    assert!(!task_in_store[0].enabled);

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(events.emitted.lock().unwrap().is_empty());
    assert!(snapshot_queue(&pending).is_empty());

    let err = registry.pause_task(&cron_id).await;
    assert!(err.is_err());

    // 2. 恢复任务
    registry.resume_task(&cron_id).await.expect("恢复应成功");
    assert!(registry.has_active(), "恢复后应有 Active 任务");

    let task_in_store = store.load_all();
    assert_eq!(task_in_store[0].status, CronTaskStatus::Active);
    assert!(task_in_store[0].enabled);

    let err = registry.resume_task(&cron_id).await;
    assert!(err.is_err());

    let events_cond = Arc::clone(&events);
    wait_until("恢复后触发至少一次", move || {
        !events_cond.emitted.lock().unwrap().is_empty()
    })
    .await;
}

#[tokio::test]
async fn test_update_task_crit_01_generation_binding() {
    let (registry, pending, events, store) = test_registry();
    registry.set_fire_override_ms(80);
    let cron_id = registry
        .register(test_input("* * * * *", Some(5), false))
        .await
        .expect("注册成功");

    let initial_gen = {
        let map = registry.components.tasks.lock().unwrap();
        map.get(&cron_id).unwrap().generation
    };
    assert_eq!(initial_gen, 1);

    // 【CRIT-01 核心断言 1】：仅更新 prompt，严禁推进 generation，保留原倒计时协程！
    tokio::time::sleep(Duration::from_millis(20)).await;
    registry
        .update_task(
            &cron_id,
            CronTaskUpdatePatch {
                prompt: Some("全新任务提示词".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("更新 prompt 成功");

    let current_gen = {
        let map = registry.components.tasks.lock().unwrap();
        map.get(&cron_id).unwrap().generation
    };
    assert_eq!(
        current_gen, 1,
        "【CRIT-01 防御】：仅改 prompt 严禁推进 generation！"
    );

    let events_cond = Arc::clone(&events);
    wait_until("协程正常触发", move || {
        !events_cond.emitted.lock().unwrap().is_empty()
    })
    .await;

    {
        let emitted = events.emitted.lock().unwrap();
        assert_eq!(emitted.len(), 1);
        match &emitted[0] {
            CronEvent::Fired { prompt, .. } => {
                assert_eq!(prompt, "全新任务提示词", "触发必须执行最新提示词！");
            }
        }
    }

    // 【CRIT-01 核心断言 2】：当表达式变动时，必须推进代际并重启协程
    registry
        .update_task(
            &cron_id,
            CronTaskUpdatePatch {
                expression: Some("*/10 * * * *".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("更新表达式成功");

    let new_gen = {
        let map = registry.components.tasks.lock().unwrap();
        map.get(&cron_id).unwrap().generation
    };
    assert_eq!(new_gen, 2, "表达式变更必须推进代际！");

    let in_store = store.load_all();
    assert_eq!(in_store[0].expression, "*/10 * * * *");
    assert_eq!(in_store[0].cron_id, cron_id, "就地更新保持 cron_id 恒定！");
    let _ = snapshot_queue(&pending);
}

#[tokio::test]
async fn test_generation_race_defense_when_paused_during_countdown() {
    let (registry, pending, events, _) = test_registry();
    registry.set_fire_override_ms(150);
    let cron_id = registry
        .register(test_input("* * * * *", Some(2), false))
        .await
        .expect("注册成功");

    tokio::time::sleep(Duration::from_millis(50)).await;
    registry.pause_task(&cron_id).await.expect("暂停成功");

    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        events.emitted.lock().unwrap().is_empty(),
        "暂停后绝不得触发"
    );
    assert!(snapshot_queue(&pending).is_empty());
    assert!(!registry.has_active());
}

#[tokio::test]
async fn test_scheduled_task_launcher_real_async_terminal_writeback() {
    let store = MemorySchedStore::shared();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
    let events = Arc::new(ProbeEvents::default());
    let registry = Arc::new(SchedulerRegistry::new(
        pending,
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        None,
    ));
    let launcher = Arc::new(ProbeScheduledLauncher::new(false));
    registry.set_launcher(Arc::clone(&launcher) as Arc<dyn ScheduledTaskLauncher>);
    registry.set_fire_override_ms(30);

    let cron_id = registry
        .register(test_input("* * * * *", Some(1), false))
        .await
        .expect("注册应成功");

    let store_cond = Arc::clone(&store);
    wait_until("ScheduledTaskLauncher 终态回写 completed", move || {
        let runs = store_cond.load_runs();
        runs.len() == 1 && runs[0].status == "completed"
    })
    .await;

    let runs = store.load_runs();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].workflow_id, cron_id);
    assert_eq!(runs[0].status, "completed");
    assert!(
        runs[0].duration_ms.unwrap_or(0) >= 10,
        "真实异步执行耗时应大于 0ms，实际: {:?}",
        runs[0].duration_ms
    );
    assert!(runs[0].finished_at_ms.is_some());
    let ctxs = launcher.contexts.lock().unwrap();
    assert_eq!(ctxs.len(), 1);
    assert_eq!(ctxs[0].cron_id, cron_id);
}

#[tokio::test]
async fn test_scheduled_task_zombie_session_self_healing_int04() {
    let store = MemorySchedStore::shared();
    store.set_existing_sessions(vec!["valid-session".to_string()]);

    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let pending = Arc::new(QueuePendingSink::new(Arc::clone(&queue)));
    let events = Arc::new(ProbeEvents::default());
    let registry = Arc::new(SchedulerRegistry::new(
        pending,
        Arc::clone(&events) as Arc<dyn EventSink>,
        Arc::clone(&store) as Arc<dyn SchedStore>,
        None,
    ));
    let launcher = Arc::new(ProbeScheduledLauncher::new(false));
    registry.set_launcher(Arc::clone(&launcher) as Arc<dyn ScheduledTaskLauncher>);
    registry.set_fire_override_ms(60);

    let cron_id = registry
        .register(test_input("* * * * *", Some(1), false))
        .await
        .expect("注册应成功");
    registry
        .update_task(
            &cron_id,
            CronTaskUpdatePatch {
                expression: None,
                prompt: None,
                max_iterations: None,
                is_daemon: None,
                target_session_id: Some(Some("zombie-session-deleted".to_string())),
            },
        )
        .await
        .expect("更新 target_session_id 应成功");

    let store_cond = Arc::clone(&store);
    wait_until("僵尸会话自愈并完成执行", move || {
        let runs = store_cond.load_runs();
        runs.len() == 1 && runs[0].status == "completed"
    })
    .await;

    // 断言 1：持久化任务中的 target_session_id 已被自动抹除为 None
    let persisted = store.load_all();
    assert_eq!(persisted.len(), 1);
    assert_eq!(
        persisted[0].target_session_id, None,
        "已删除的目标会话 ID 必须在触发时自愈抹除"
    );

    // 断言 2：传递给 launcher 的上下文中 target_session_id 已降级为 None，且生成独立 sched-run-* 会话
    let ctxs = launcher.contexts.lock().unwrap();
    assert_eq!(ctxs.len(), 1);
    assert_eq!(ctxs[0].target_session_id, None);
    let runs = store.load_runs();
    assert!(
        runs[0]
            .session_id
            .as_deref()
            .unwrap_or("")
            .starts_with(&format!("sched-run-{cron_id}-")),
        "应降级至独立后台会话 sched-run-*，实际: {:?}",
        runs[0].session_id
    );
}
