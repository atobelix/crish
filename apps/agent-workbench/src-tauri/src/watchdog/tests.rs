//! Watchdog 测试（watchdog.rs 拆分）。

use super::*;
use agent_tools::tools::wait_subagents::WaitMode;
use conex_run::wait_channel::{DispatchStore, MemoryWaitStore, WaitStore};
use std::sync::atomic::{AtomicU64, Ordering};

/// 测试时钟（Arc 共享：闭包读取 + 测试推进）
fn test_clock() -> (Arc<AtomicU64>, WatchdogOptions) {
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let shared = Arc::clone(&clock);
    let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || shared.load(Ordering::Relaxed));
    let options = WatchdogOptions {
        idle_minutes: 10,
        period: Duration::from_secs(60),
        now,
    };
    (clock, options)
}

/// 构造测试 watchdog（内存 store + 无活跃定时器 + 独立队列）
#[allow(clippy::type_complexity)]
fn test_watchdog() -> (
    Arc<Watchdog>,
    Arc<Mutex<PendingMessageQueue>>,
    Arc<MemoryWaitStore>,
    Arc<LastWakeupTracker>,
    Arc<AtomicU64>,
) {
    let (clock, options) = test_clock();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let store = Arc::new(MemoryWaitStore::new());
    let last_wakeup = Arc::new(LastWakeupTracker::new());
    let watchdog = Arc::new(Watchdog::new(
        "sess-1".to_string(),
        Arc::clone(&queue),
        Arc::clone(&store) as Arc<dyn DispatchStore>,
        Arc::clone(&last_wakeup),
        Arc::new(|| 0),
        options,
    ));
    (watchdog, queue, store, last_wakeup, clock)
}

/// dispatch 声明构造（await-all 模式等待一个子代理）
fn declaration(subagent_id: &str, dispatched_at_ms: u64) -> DispatchDeclaration {
    DispatchDeclaration {
        mode: WaitMode::AwaitAll,
        wait_ms: None,
        subagent_ids: vec![subagent_id.to_string()],
        dispatched_at_ms,
    }
}

/// 队列条目快照（取走全部）
fn drain_entries(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
    queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .dequeue_all()
}

// ── T-CF-13 验收断言 ─────────────────────────────────────────

/// 失联超时：分发于 11 分钟前、从未有事件唤醒 → steering 条目出现，
/// 文案含任务 ID 与时长，group_id = watchdog-<session>
#[tokio::test]
async fn watchdog_fires_after_n_minutes_idle() {
    let (watchdog, queue, store, _, clock) = test_watchdog();
    store.save(&declaration(
        "sa-1",
        clock.load(Ordering::Relaxed) - 11 * 60_000,
    ));
    watchdog.tick().await;
    let entries = drain_entries(&queue);
    assert_eq!(entries.len(), 1, "失联超过 N 分钟应触发兜底");
    assert_eq!(entries[0].group_id.as_deref(), Some("watchdog-sess-1"));
    assert!(
        entries[0].text.contains("sa-1"),
        "文案应含任务 ID：{}",
        entries[0].text
    );
    assert!(
        entries[0].text.contains("11 分钟"),
        "文案应含时长：{}",
        entries[0].text
    );
    assert!(entries[0].is_steering, "兜底条目应置 is_steering 受保护位");
}

/// 最近有事件唤醒（last_wakeup 更新）→ 不触发
#[tokio::test]
async fn watchdog_no_fire_when_events_recent() {
    let (watchdog, queue, store, last_wakeup, clock) = test_watchdog();
    let base = clock.load(Ordering::Relaxed);
    store.save(&declaration("sa-1", base.saturating_sub(30 * 60_000)));
    last_wakeup.mark_wakeup_at(base.saturating_sub(60_000));
    watchdog.tick().await;
    assert!(
        drain_entries(&queue).is_empty(),
        "最近有事件唤醒不应触发兜底"
    );
}

/// 周期内重复扫描只产生一条（触发后重置计时 + 同组 replace 去重）
#[tokio::test]
async fn watchdog_dedup_same_group() {
    let (watchdog, queue, store, _, _) = test_watchdog();
    store.save(&declaration("sa-1", 100_000));
    watchdog.tick().await;
    watchdog.tick().await;
    let entries = drain_entries(&queue);
    assert_eq!(entries.len(), 1, "同一失联窗口内重复扫描只应产生一条");
}

/// 触发后计时重置：下一周期（60s 后）不重复；再次失联 N 分钟后重新
/// 触发时同组替换（仍只一条，文案时长更新）
#[tokio::test]
async fn watchdog_resets_after_fire() {
    let (watchdog, queue, store, _, clock) = test_watchdog();
    store.save(&declaration("sa-1", 100_000));
    // t0 触发（dispatched_at=100_000 → 已运行 15 分钟）
    watchdog.tick().await;
    let first = drain_entries(&queue);
    assert_eq!(first.len(), 1);
    assert!(
        first[0].text.contains("15 分钟"),
        "首次触发时长：{}",
        first[0].text
    );
    // t0 + 60s：下一周期，未再失联 N 分钟 → 不重复
    clock.fetch_add(60_000, Ordering::Relaxed);
    watchdog.tick().await;
    assert!(drain_entries(&queue).is_empty(), "触发后 60s 不应重复触发");
    // t0 + 11 分钟：再次失联 N 分钟 → 重新触发（同组替换，仍一条，
    // 时长更新为 26 分钟）
    clock.fetch_add(10 * 60_000, Ordering::Relaxed);
    watchdog.tick().await;
    let second = drain_entries(&queue);
    assert_eq!(second.len(), 1, "再次触发应替换同组条目而非新增");
    assert!(
        second[0].text.contains("26 分钟"),
        "文案时长应随再次触发更新：{}",
        second[0].text
    );
}

/// 无 dispatch 声明 → 不触发
#[tokio::test]
async fn watchdog_no_fire_without_declaration() {
    let (watchdog, queue, _, _, _) = test_watchdog();
    watchdog.tick().await;
    assert!(drain_entries(&queue).is_empty());
}

/// 活跃定时器非空（AI 已设置定时器等待）→ 抑制兜底（REQ-C05 条件）
#[tokio::test]
async fn watchdog_no_fire_when_active_timer() {
    let (_clock, options) = test_clock();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let store = Arc::new(MemoryWaitStore::new());
    store.save(&declaration("sa-1", 100_000));
    let watchdog = Arc::new(Watchdog::new(
        "sess-1".to_string(),
        Arc::clone(&queue),
        Arc::clone(&store) as Arc<dyn DispatchStore>,
        Arc::new(LastWakeupTracker::new()),
        Arc::new(|| 1), // 活跃定时器 1 个
        options,
    ));
    watchdog.tick().await;
    assert!(
        drain_entries(&queue).is_empty(),
        "存在活跃定时器不应触发兜底"
    );
}

/// 从未有事件唤醒（last_wakeup = None）→ 视为超时，触发兜底
#[tokio::test]
async fn watchdog_fires_when_never_woken() {
    let (watchdog, queue, store, _, clock) = test_watchdog();
    store.save(&declaration(
        "sa-1",
        clock.load(Ordering::Relaxed) - 10 * 60_000 - 1_000,
    ));
    watchdog.tick().await;
    assert_eq!(drain_entries(&queue).len(), 1, "从未唤醒应触发兜底");
}

/// 时长格式化边界（≥ 1 小时 → 小时 + 分钟；< 1 分钟 → 秒）
#[test]
fn duration_format_hour_boundary() {
    assert_eq!(format_duration_ms(90 * 60_000), "1 小时 30 分钟");
    assert_eq!(format_duration_ms(11 * 60_000), "11 分钟");
    assert_eq!(format_duration_ms(45_000), "45 秒");
}

fn test_agent(id: &str, status: &str) -> conex_types::SessionAgent {
    conex_types::SessionAgent {
        id: id.to_string(),
        subagent_run_id: format!("run-{id}"),
        parent_session_id: "sess-1".to_string(),
        parent_run_id: "run-main".to_string(),
        parent_tool_call_id: None,
        description: "test".to_string(),
        mode: "general".to_string(),
        status: status.to_string(),
        summary: None,
        messages: Vec::new(),
        started_at: 100_000,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
        capability_mode: None,
        model_override: None,
        resumable: false,
        last_heartbeat_ms: None,
    }
}

/// §6.2 状态过滤与历史声明核销测试：
/// 当所有子代理均已 completed 时，过滤掉并核销声明，不触发虚假报警风暴
#[tokio::test]
async fn watchdog_filters_completed_subagents_and_clears_declarations() {
    let (clock, options) = test_clock();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let store = Arc::new(MemoryWaitStore::new());
    let last_wakeup = Arc::new(LastWakeupTracker::new());
    let agent_source = Arc::new(conex_run::wait_channel::MemoryAgentSource::new());
    agent_source.set_agents(vec![test_agent("sa-1", "completed")]);

    let watchdog = Arc::new(
        Watchdog::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::clone(&store) as Arc<dyn DispatchStore>,
            Arc::clone(&last_wakeup),
            Arc::new(|| 0),
            options,
        )
        .with_agents_source(
            Arc::clone(&agent_source) as Arc<dyn conex_run::wait_channel::SubagentStatusSource>
        ),
    );

    // 注入 11 分钟前的分发声明
    store.save(&declaration(
        "sa-1",
        clock.load(Ordering::Relaxed) - 11 * 60_000,
    ));

    // 周期扫描：检测到 sa-1 已 completed，自动核销声明并不触发报警
    watchdog.tick().await;

    assert!(
        drain_entries(&queue).is_empty(),
        "已完成的子代理绝对不得触发超时报警"
    );
    assert!(
        store.load_declarations().is_empty(),
        "已完成子代理的历史声明必须被自动核销清理"
    );
}

/// 运行中的子代理在超时后正常触发报警
#[tokio::test]
async fn watchdog_fires_for_running_subagent() {
    let (clock, options) = test_clock();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let store = Arc::new(MemoryWaitStore::new());
    let last_wakeup = Arc::new(LastWakeupTracker::new());
    let agent_source = Arc::new(conex_run::wait_channel::MemoryAgentSource::new());
    agent_source.set_agents(vec![test_agent("sa-1", "running")]);

    let watchdog = Arc::new(
        Watchdog::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::clone(&store) as Arc<dyn DispatchStore>,
            Arc::clone(&last_wakeup),
            Arc::new(|| 0),
            options,
        )
        .with_agents_source(
            Arc::clone(&agent_source) as Arc<dyn conex_run::wait_channel::SubagentStatusSource>
        ),
    );

    store.save(&declaration(
        "sa-1",
        clock.load(Ordering::Relaxed) - 11 * 60_000,
    ));

    watchdog.tick().await;

    let entries = drain_entries(&queue);
    assert_eq!(entries.len(), 1, "真正运行中且失联超时的子代理应正常报警");
    assert!(entries[0].text.contains("sa-1"));
}

/// 状态源为空时 fail-open 保留声明
#[tokio::test]
async fn watchdog_fail_open_on_empty_agents_source() {
    let (clock, options) = test_clock();
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let store = Arc::new(MemoryWaitStore::new());
    let last_wakeup = Arc::new(LastWakeupTracker::new());
    let agent_source = Arc::new(conex_run::wait_channel::MemoryAgentSource::new());

    let watchdog = Arc::new(
        Watchdog::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::clone(&store) as Arc<dyn DispatchStore>,
            Arc::clone(&last_wakeup),
            Arc::new(|| 0),
            options,
        )
        .with_agents_source(
            Arc::clone(&agent_source) as Arc<dyn conex_run::wait_channel::SubagentStatusSource>
        ),
    );

    store.save(&declaration(
        "sa-1",
        clock.load(Ordering::Relaxed) - 11 * 60_000,
    ));

    watchdog.tick().await;

    assert_eq!(
        drain_entries(&queue).len(),
        1,
        "状态源为空时应 fail-open 触发兜底"
    );
}
