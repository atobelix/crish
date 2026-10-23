//! 定时器生命周期（注册、到期、取消、早退与冲突）单元测试

use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_tools::tools::set_timer::TimerError;
use conex_types::events::AgentEvent;
use conex_types::timer::TimerCondition;

use crate::timers::store::TimerStore;
use crate::timers::tests::{
    assert_early_exit_notice, poll_until, queue_len, queue_snapshot, subagent_ended, test_registry,
};
use crate::timers::types::{TimerCancelReason, TimerEvent, steering_group_id};

// ── T-CF-06：注册 / 到期 / 取消 ───────────────────────────────────

/// 到期后 steering 条目（group_id=timer-<id>、text 含 prompt）与
/// TimerFired 事件均已产出；声明 fired=true 落库。
#[tokio::test]
async fn timer_registry_fires_steering_entry() {
    let (registry, queue, events, store, clock) = test_registry();
    let handle = registry
        .register(1, "检查编译结果".to_string(), TimerCondition::Never)
        .await
        .expect("注册应成功");
    assert_eq!(handle.timer_id, "timer-0");
    // 冻结时钟下注册：未推进 → 未到期不发射（确定性，无真实等待）
    assert!(
        queue_snapshot(&queue).is_empty(),
        "未到期不得注入 steering 条目"
    );
    assert!(
        events
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "未到期不得发射 TimerFired"
    );
    // 推进时钟越过到期点（expires_at = 注册时钟 + 1s）→ 轮询任务
    // fire；poll_until 收口（500ms 真实上限护栏）
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    poll_until(|| queue_len(&queue) == 1).await;
    let entries = queue_snapshot(&queue);
    assert_eq!(entries.len(), 1, "应恰好注入一条 steering 条目");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id("timer-0").as_str()),
        "group_id 应为 timer-<id>"
    );
    assert!(
        entries[0].text.contains("检查编译结果"),
        "steering 文本应含 prompt：{}",
        entries[0].text
    );
    // TimerFired 已发射（恰好一条：fired_at_ms 走注入时钟）
    let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(emitted.len(), 1);
    assert!(matches!(
        emitted[0],
        TimerEvent::Fired { ref timer_id, .. } if timer_id == "timer-0"
    ));
    // 声明 fired=true 落库（重启后避免重复注入）
    let persisted = store.load_all();
    assert_eq!(persisted.len(), 1);
    assert!(persisted[0].fired, "到期声明应标 fired=true");
    assert!(!persisted[0].cancelled);
}

/// 注册后立即取消：到期时刻无 steering 条目、声明 cancelled=true、
/// TimerCancelled(reason=cancelled) 已发射。
#[tokio::test]
async fn timer_registry_cancel_stops_fire() {
    let (registry, queue, events, store, clock) = test_registry();
    let handle = registry
        .register(1, "不应到期".to_string(), TimerCondition::Never)
        .await
        .expect("注册应成功");
    let cancelled = registry.cancel(&handle.timer_id).await.expect("取消应成功");
    assert!(cancelled);
    // 推进时钟越过到期点 + 100ms 收口窗：abort 生效则无到期条目
    // （推进是必须的——防「未 abort 而时钟未到」的假绿）
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(queue_snapshot(&queue).is_empty(), "取消后不得有到期条目");
    {
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 1);
        assert!(matches!(
            emitted[0],
            TimerEvent::Cancelled { ref timer_id, reason: TimerCancelReason::Cancelled, .. }
                if timer_id == &handle.timer_id
        ));
    }
    let persisted = store.load_all();
    assert_eq!(persisted.len(), 1);
    assert!(persisted[0].cancelled, "取消声明应标 cancelled=true");
    assert!(!persisted[0].fired);
    // 重复取消 → IdNotFound（条目已移除）
    let again = registry.cancel(&handle.timer_id).await;
    assert!(matches!(again, Err(TimerError::IdNotFound)));
}

/// 冲突拒绝占位联测（T-CF-07 语义落地后全绿）：
/// 同 sender 重复注册 → Conflict；取消后再注册 → 成功。
#[tokio::test]
async fn timer_registry_conflict_rejected() {
    let (registry, _, _, _, _) = test_registry();
    let first = registry
        .register(
            1,
            "第一次".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await
        .expect("首次注册应成功");
    let second = registry
        .register(
            2,
            "第二次".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await;
    assert!(
        matches!(&second, Err(TimerError::Conflict(message)) if message.contains("task-42") && message.contains(&first.timer_id)),
        "同 sender 重复注册应返回 Conflict：{second:?}"
    );
    // 取消后同 sender 再注册成功
    registry.cancel(&first.timer_id).await.expect("取消应成功");
    let third = registry
        .register(
            2,
            "第三次".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await;
    assert!(third.is_ok(), "取消后同 sender 应可再注册：{third:?}");
}

/// 非法时长拒绝（0 / 超上限 → InvalidDuration）
#[tokio::test]
async fn timer_registry_rejects_invalid_duration() {
    let (registry, _, _, _, _) = test_registry();
    for bad in [0u64, 86401] {
        let result = registry
            .register(bad, "非法时长".to_string(), TimerCondition::Never)
            .await;
        assert!(
            matches!(result, Err(TimerError::InvalidDuration)),
            "时长 {bad} 应被拒绝：{result:?}"
        );
    }
    // 上下界合法
    let result = registry
        .register(1, "下界".to_string(), TimerCondition::Never)
        .await;
    assert!(result.is_ok());
    let result = registry
        .register(86400, "上界".to_string(), TimerCondition::Never)
        .await;
    assert!(result.is_ok());
}

// ── T-CF-07：早退 + 冲突 ───────────────────────────────────────

/// Any 条件：注入任意外部消息 → 定时器取消、TimerCancelled
/// (reason=early-exit) 已发射、早退通知已注入、无到期注入。
#[tokio::test]
async fn timer_condition_any_cancels_on_any_message() {
    let (registry, queue, events, store, clock) = test_registry();
    let handle = registry
        .register(1, "any 条件".to_string(), TimerCondition::Any)
        .await
        .expect("注册应成功");
    // 注入 mock SubagentEnded → 早退
    registry.on_event(&subagent_ended("task-99")).await;
    assert_early_exit_notice(&queue, &handle.timer_id, "task-99");
    {
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert!(matches!(
            emitted.iter().find(|e| matches!(e, TimerEvent::Cancelled { .. })),
            Some(TimerEvent::Cancelled { ref timer_id, reason: TimerCancelReason::EarlyExit, .. })
                if timer_id == &handle.timer_id
        ));
    }
    let persisted = store.load_all();
    assert!(
        persisted.iter().all(|d| d.cancelled),
        "早退后声明应标 cancelled=true"
    );
    // 早退路径无需等待到期：任务已 abort——推进时钟越过到期点 +
    // 100ms 收口窗，断言无到期条目（防「未 abort 而时钟未到」假绿）
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let entries = queue_snapshot(&queue);
    assert!(
        entries.is_empty(),
        "早退后不得有到期条目（任务已 abort）：{entries:?}"
    );
}

/// Task 条件：非目标 sender 终态不取消、到期正常注入；
/// 目标 sender 终态 → 取消且无到期注入。
#[tokio::test]
async fn timer_condition_task_cancels_only_target() {
    let (registry, queue, _, _, clock) = test_registry();
    let handle = registry
        .register(
            1,
            "task 条件".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await
        .expect("注册应成功");
    // task-99 终态 → 不取消，推进时钟 → 到期恰好注入一条
    registry.on_event(&subagent_ended("task-99")).await;
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    poll_until(|| queue_len(&queue) == 1).await;
    {
        let entries = queue_snapshot(&queue);
        assert_eq!(entries.len(), 1, "非目标 sender 不应早退，应正常到期");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id(&handle.timer_id).as_str())
        );
        assert!(
            entries[0].text.contains("已到期"),
            "应为到期条目：{}",
            entries[0].text
        );
    }
    // 目标 sender 终态 → 取消且无到期注入（锁守卫已随块结束释放——
    // 不得跨 await 持有：cancel_early_exit 的 steering 注入会再锁同一
    // pending 表，std Mutex 不可重入）
    let handle_b = registry
        .register(
            1,
            "task 条件二".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await
        .expect("注册应成功");
    registry.on_event(&subagent_ended("task-42")).await;
    assert_early_exit_notice(&queue, &handle_b.timer_id, "task-42");
    // 早退路径无需等待：推进时钟 + 100ms 收口窗，断言无到期条目
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let entries = queue_snapshot(&queue);
    assert!(
        entries.is_empty(),
        "第二次注册的定时器应被早退，无到期条目：{entries:?}"
    );
}

/// 联测：task-42 活跃期间重复注册 → Conflict；取消后再注册成功。
#[tokio::test]
async fn timer_condition_conflict_rejected() {
    let (registry, _, _, _, _) = test_registry();
    registry
        .register(
            1,
            "第一".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await
        .expect("首次注册应成功");
    let second = registry
        .register(
            1,
            "第二".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await;
    assert!(
        matches!(&second, Err(TimerError::Conflict(message)) if message.contains("task-42")),
        "活跃期间重复注册应拒绝：{second:?}"
    );
    // 取消后重新注册成功
    let active = registry.list_active().await;
    assert_eq!(active.len(), 1);
    registry
        .cancel(&active[0].timer_id)
        .await
        .expect("取消应成功");
    let third = registry
        .register(
            1,
            "第三".to_string(),
            TimerCondition::Task("task-42".to_string()),
        )
        .await;
    assert!(third.is_ok(), "取消后应可再注册：{third:?}");
    // Any 条件不参与冲突表：task-42 活跃期间注册 Any 不冲突
    let any = registry
        .register(1, "any".to_string(), TimerCondition::Any)
        .await;
    assert!(any.is_ok(), "Any 条件不参与冲突表：{any:?}");
    // 不同 sender 互不冲突
    let other = registry
        .register(
            1,
            "另一 sender".to_string(),
            TimerCondition::Task("task-99".to_string()),
        )
        .await;
    assert!(other.is_ok(), "不同 sender 应互不冲突：{other:?}");
}

/// 自产 TimerFired 不触发 any 早退（事件体带 timer_id 天然可排除）；
/// 其他定时器的 TimerFired 同为内部事件，亦不触发。
#[tokio::test]
async fn timer_any_ignores_own_fire() {
    let (registry, queue, events, store, clock) = test_registry();
    let handle = registry
        .register(1, "any 自产排除".to_string(), TimerCondition::Any)
        .await
        .expect("注册应成功");
    // 注入自产 TimerFired（事件面路径模拟）→ 不早退（fired_at_ms
    // 走注入时钟，与注册基准一致）
    registry
        .on_event(&AgentEvent::TimerFired {
            session_id: String::new(),
            timer_id: handle.timer_id.clone(),
            prompt: "自产".to_string(),
            fired_at_ms: clock.load(Ordering::Relaxed),
        })
        .await;
    assert!(
        queue_snapshot(&queue).is_empty(),
        "自产 TimerFired 不应触发早退"
    );
    // 注入其他定时器的 TimerFired → 同为内部事件，亦不触发
    registry
        .on_event(&AgentEvent::TimerFired {
            session_id: String::new(),
            timer_id: "timer-other".to_string(),
            prompt: "他者".to_string(),
            fired_at_ms: clock.load(Ordering::Relaxed),
        })
        .await;
    // 推进时钟越过到期点 → 正常到期注入（未被早退）
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    poll_until(|| queue_len(&queue) == 1).await;
    let entries = queue_snapshot(&queue);
    assert_eq!(entries.len(), 1, "自产事件排除后应正常到期注入");
    assert!(entries[0].text.contains("已到期"));
    assert!(
        !store.load_all().iter().any(|d| d.cancelled),
        "未被早退，声明不应标 cancelled"
    );
    // 无 early-exit 类取消事件
    let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
    assert!(
        emitted
            .iter()
            .all(|e| matches!(e, TimerEvent::Fired { .. })),
        "不应发射早退取消事件：{emitted:?}"
    );
}
