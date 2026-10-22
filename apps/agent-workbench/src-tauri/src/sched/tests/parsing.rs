//! Cron 表达式解析、序列化与 Steering 路由测试

use std::sync::Arc;
use std::time::Duration;

use conex_types::error::codes;

use super::super::types::*;
use super::*;

#[tokio::test]
async fn scheduler_registry_invalid_expression_rejected() {
    let (registry, _, _, store) = test_registry();
    let err = registry
        .register(test_input("0 0 9 * * *", None, false))
        .await;
    assert!(
        matches!(&err, Err(SchedulerError::InvalidExpression(_))),
        "6 字段表达式应被拒绝：{err:?}"
    );
    let err = registry
        .register(test_input("0 0 30 2 *", None, false))
        .await;
    assert!(
        matches!(&err, Err(SchedulerError::NoNextFire(_))),
        "2 月 30 日表达式应被拒绝：{err:?}"
    );
    assert!(store.load_all().is_empty(), "非法注册不得落库");
    assert!(!registry.has_active(), "非法注册不得产生活跃条目");
    assert_eq!(
        SchedulerError::InvalidExpression("x".into()).code(),
        codes::TOOL_INVALID_INPUT
    );
    assert_eq!(SchedulerError::IdNotFound.code(), codes::COMMON_NOT_FOUND);
}

#[test]
fn cron_task_serializes_camel_case() {
    let task = CronTask {
        cron_id: "cron-3".to_string(),
        expression: "0 9 * * *".to_string(),
        prompt: "日报".to_string(),
        max_iterations: Some(2),
        is_daemon: true,
        next_fire_at_ms: 12_345,
        fired_count: 1,
        status: CronTaskStatus::Completed,
        enabled: false,
        target_session_id: None,
        created_at_ms: 10_000,
        updated_at_ms: 10_000,
    };
    let json = serde_json::to_value(&task).expect("序列化应成功");
    assert_eq!(json["cronId"], "cron-3");
    assert_eq!(json["expression"], "0 9 * * *");
    assert_eq!(json["prompt"], "日报");
    assert_eq!(json["maxIterations"], 2);
    assert_eq!(json["isDaemon"], true);
    assert_eq!(json["nextFireAtMs"], 12_345);
    assert_eq!(json["firedCount"], 1);
    assert_eq!(json["status"], "completed");
    assert_eq!(json["enabled"], false);

    let back: CronTask = serde_json::from_value(json).expect("反序列化应成功");
    assert_eq!(back, task);
}

#[test]
fn steering_group_id_shape() {
    assert_eq!(steering_group_id("cron-0"), "cron-cron-0");
}

#[test]
fn scheduler_registry_pause_for_sets_and_refreshes_deadline() {
    let (registry, _, _, store) = test_registry();
    let before = now_ms();
    let first = registry.pause_for(3600);
    assert!(
        first >= before + 3600 * 1000,
        "pause_for(3600) 截止应 ≈ now+1h：{first}"
    );
    assert_eq!(registry.pause_deadline(), Some(first));
    let refreshed = registry.pause_for(120);
    assert!(refreshed < first, "刷新应覆盖旧截止");
    assert_eq!(registry.pause_deadline(), Some(refreshed));
    assert!(store.load_all().is_empty(), "暂停不得落库（内存态）");
}

#[tokio::test]
async fn scheduler_registry_pause_blocks_fire_then_resume_continues() {
    let (registry, pending, events, store) = test_registry();
    registry.set_fire_override_ms(40);
    let pause_until = now_ms() + 250;
    registry.set_paused_until_ms_for_test(Some(pause_until));
    registry
        .register(test_input("* * * * *", Some(2), false))
        .await
        .expect("注册应成功");
    assert!(registry.has_active(), "暂停不改变任务登记态");

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        events
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "暂停窗口内不得发射 CronFired"
    );
    assert!(
        snapshot_queue(&pending).is_empty(),
        "暂停窗口内不得注入 steering 条目"
    );
    let persisted = store.load_all();
    assert_eq!(
        persisted[0].fired_count, 0,
        "暂停窗口内 fired_count 不得推进"
    );
    assert!(persisted[0].enabled, "暂停不得禁用任务");

    let events_cond = Arc::clone(&events);
    let pending_cond = Arc::clone(&pending);
    wait_until(
        "暂停结束恢复触发（CronFired 2 条 + 队列完成通知）",
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
    let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(emitted.len(), 2, "恢复后应照常触发两次");
    drop(emitted);
    let persisted = store.load_all();
    assert_eq!(persisted[0].fired_count, 2);
    assert_eq!(persisted[0].status, CronTaskStatus::Completed);
    assert!(!persisted[0].enabled, "max 达到后停止");
    assert!(!registry.has_active());
}

#[tokio::test]
async fn scheduler_registry_cancel_stops_fire() {
    let (registry, pending, events, store) = test_registry();
    registry.set_fire_override_ms(40);
    let cron_id = registry
        .register(test_input("* * * * *", Some(5), false))
        .await
        .expect("注册应成功");
    let cancelled = registry.cancel(&cron_id).await.expect("取消应成功");
    assert!(cancelled);

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(snapshot_queue(&pending).is_empty(), "取消后不得有触发条目");
    assert!(
        events
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "取消后不得发射事件"
    );
    let persisted = store.load_all();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].status, CronTaskStatus::Cancelled);
    assert!(!persisted[0].enabled, "取消应 enabled=false 落库");
    assert!(!registry.has_active());

    let again = registry.cancel(&cron_id).await;
    assert!(matches!(again, Err(SchedulerError::IdNotFound)));
}

#[tokio::test]
async fn test_steering_routes_to_bound_target_session_or_fallback() {
    let (registry, pending, events, _store) = test_registry();
    registry.set_fire_override_ms(60);

    // 1. 绑定 target_session_id = Some("sess-bound-chat-42".into()) 的任务
    let bound_cron_id = registry
        .register(test_input("* * * * *", Some(1), false))
        .await
        .expect("注册绑定任务应成功");
    registry
        .update_task(
            &bound_cron_id,
            CronTaskUpdatePatch {
                target_session_id: Some(Some("sess-bound-chat-42".into())),
                ..Default::default()
            },
        )
        .await
        .expect("绑定 target_session_id 应成功");

    let events_cond = Arc::clone(&events);
    let pending_cond = Arc::clone(&pending);
    wait_until("绑定任务触发并写入 steering 队列", move || {
        events_cond
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
            == 1
            && queue_len(&pending_cond) == 1
    })
    .await;

    let bound_entries = snapshot_queue(&pending);
    assert_eq!(bound_entries.len(), 1);
    assert_eq!(
        bound_entries[0].session_id, "sess-bound-chat-42",
        "绑定了 target_session_id 时，SteeringInputEntry.session_id 必须精确路由至目标对话会话"
    );

    // 2. 未绑定 target_session_id（None）的任务：回退至默认的 sched-{cron_id}
    let unbound_cron_id = registry
        .register(test_input("* * * * *", Some(1), false))
        .await
        .expect("注册未绑定任务应成功");

    let events_cond2 = Arc::clone(&events);
    let pending_cond2 = Arc::clone(&pending);
    wait_until(
        "未绑定任务触发并写入 steering 队列",
        move || {
            events_cond2
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                == 2
                && queue_len(&pending_cond2) == 1
        },
    )
    .await;

    let unbound_entries = snapshot_queue(&pending);
    assert_eq!(unbound_entries.len(), 1);
    assert_eq!(
        unbound_entries[0].session_id,
        format!("sched-{unbound_cron_id}"),
        "未绑定 target_session_id 时，SteeringInputEntry.session_id 必须回退为 sched-<cron_id>"
    );
}
