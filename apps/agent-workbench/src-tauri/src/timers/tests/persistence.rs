//! 定时器持久化与跨重启恢复（内存版与 LocalDb 真适配）单元测试

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conex_db::LocalDb;
use conex_types::timer::TimerCondition;
use orchestrator::PendingMessageQueue;

use crate::timers::registry::TimerRegistry;
use crate::timers::store::{
    LocalDbTimerStore, MemoryTimerStore, SESSION_META_TIMER_INDEX_KEY, TimerStore, store_key,
};
use crate::timers::tests::{ProbeEvents, declaration, poll_until, queue_len, queue_snapshot};
use crate::timers::types::{EventSink, QueuePendingSink, TimerEvent, steering_group_id};

/// 重启恢复：注册 → 重建注册表（共享 store + 共享注入时钟）→
/// restore → 剩余时间重建轮询且到期恰好注入一次；已到期已注入的
/// 声明恢复后不重复注入。
#[tokio::test]
async fn timer_registry_persists_and_recovers() {
    let store = MemoryTimerStore::shared();
    // 共享注入时钟：重启模拟下时间连续（阶段 A 残留 fire 任务与
    // 阶段 B/C 同基准，均只向自己的探针发射，不互相污染）
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let shared = Arc::clone(&clock);
    let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || shared.load(Ordering::Relaxed));
    // 阶段 A（注册后、时钟推进前）：未到期不发射（确定性断言）
    // 探针本地仅块内断言用；残留 fire 任务持有其 Arc，注入不受影响
    let (registry_a, _queue_a, _events_a) = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn TimerStore>,
            Arc::clone(&now),
        ));
        let handle = registry
            .register(1, "重启恢复".to_string(), TimerCondition::Never)
            .await
            .expect("注册应成功");
        assert_eq!(handle.timer_id, "timer-0");
        // 三态断言之一：未到期不发射（时钟冻结下确定性成立）
        assert!(
            queue_snapshot(&queue).is_empty(),
            "阶段 A：未到期不得注入 steering 条目"
        );
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "阶段 A：未到期不得发射 TimerFired"
        );
        (registry, queue, events)
    };
    drop(registry_a); // 模拟重启（注册表消亡，store 残留；残留 fire
    // 任务仅向自己的探针发射，不污染阶段 B 断言）
    // 阶段 B：restore 扫描重建 → 推进时钟 → 恰好注入一条
    let (_registry_b, queue_b, events_b) = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn TimerStore>,
            Arc::clone(&now),
        ));
        registry.restore().await;
        (registry, queue, events)
    };
    clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
    poll_until(|| queue_len(&queue_b) == 1).await;
    let entries = queue_snapshot(&queue_b);
    assert_eq!(entries.len(), 1, "恢复后到期应注入恰好一条");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some(steering_group_id("timer-0").as_str())
    );
    // 三态断言之二：恢复侧恰好一条 TimerFired（残留任务只向
    // events_a 发射，events_b 计数不受污染）
    {
        let emitted_b = events_b.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted_b.len(), 1, "恢复侧应恰好发射一条 TimerFired");
        assert!(matches!(
            emitted_b[0],
            TimerEvent::Fired { ref timer_id, .. } if timer_id == "timer-0"
        ));
    }
    // 再模拟一次重启：声明已 fired=true → 不得重复注入
    let (_registry_c, queue_c, events_c) = {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::clone(&store) as Arc<dyn TimerStore>,
            Arc::clone(&now),
        ));
        registry.restore().await;
        (registry, queue, events)
    };
    // 三态断言之三：fired=true 不重复注入（短窗收口后断言空）
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        queue_snapshot(&queue_c).is_empty(),
        "fired=true 的声明恢复后不得重复注入"
    );
    assert!(
        events_c
            .emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "fired=true 的声明恢复后不得重复发射"
    );
}

// ── LocalDb 真适配（D6 §3.1 ①）────────────────────────────────

/// 声明往返：save → load_all 一致；同 id 重复 save 幂等覆盖
/// （索引不重复追加）；多 id 经 timer_ids 索引枚举齐全。
#[test]
fn local_db_timer_store_roundtrip() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbTimerStore::new(db);
    let first = declaration("timer-0");
    store.save(&first);
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0], first, "读回应与写入一致");
    // 同 id 重复保存 → 覆盖不新增（索引幂等追加）
    store.save(&first);
    assert_eq!(store.load_all().len(), 1, "同 id 重复保存不得新增");
    // 多 id → 索引枚举齐全
    let second = declaration("timer-1");
    store.save(&second);
    let all = store.load_all();
    assert_eq!(all.len(), 2, "多 id 经 timer_ids 索引枚举齐全");
    assert!(all.iter().any(|d| d.timer_id == "timer-1"));
}

/// 重启恢复：新 store 实例读同一 db → 声明完全恢复（模拟引擎
/// 重启，D6 §3.1 段 3 restore 重建衔接的数据面）。
#[test]
fn local_db_timer_store_recovers_across_instances() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    {
        let store = LocalDbTimerStore::new(db.clone());
        store.save(&declaration("timer-0"));
        store.save(&declaration("timer-1"));
    }
    // 模拟重启：新实例读回（store 消亡，session_meta 残留）
    let store = LocalDbTimerStore::new(db);
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 2, "重启后声明应完全恢复");
    assert!(loaded.iter().any(|d| d.timer_id == "timer-0"));
    assert!(loaded.iter().any(|d| d.timer_id == "timer-1"));
}

/// fail-open：无索引键 → 空集；索引指向坏 JSON 键值 → 跳过不
/// panic；索引孤儿 id（键缺失）→ 跳过；索引键本身坏 JSON → 空集。
#[test]
fn local_db_timer_store_fail_open() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbTimerStore::new(db.clone());
    assert!(store.load_all().is_empty(), "空库 → 空集（fail-open）");
    // 索引指向坏 JSON 键值 → 跳过（对齐内存版 filter_map 语义）
    let _ = db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, r#"["timer-0"]"#);
    let _ = db.set_session_meta(&store_key("timer-0"), "not-json");
    assert!(store.load_all().is_empty(), "坏 JSON 键值 → 跳过不 panic");
    // 索引孤儿 id（键值缺失）→ 跳过
    let _ = db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, r#"["timer-9"]"#);
    assert!(store.load_all().is_empty(), "孤儿 id（键缺失）→ 跳过");
    // 索引键本身坏 JSON → 空集
    let _ = db.set_session_meta(SESSION_META_TIMER_INDEX_KEY, "not-json");
    assert!(store.load_all().is_empty(), "索引坏 JSON → 空集");
}

/// LocalDb 真 store 版跨重启端到端（D6 §5.1「换真 store 同断言」；
/// 审计 04 重要项：定时器跨重启持久化缺专项测试）：注册（LocalDb
/// 真 store 落库）→ 模拟引擎重启（新注册表 + 同 db）→ restore 重建
/// sleep → 推进注入时钟 → 到期注入**恰好一次** + TimerFired 恰好
/// 一条 + fired=true 落库 → 再次重启 → 不重复注入（fired 位幂等）。
#[tokio::test]
async fn local_db_timer_registry_persists_and_recovers() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    // 共享注入时钟：重启模拟下时间连续（残留 fire 任务只向自己的
    // 探针发射，不污染后续阶段断言——对齐既有 Memory 版测试模式）
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let shared = Arc::clone(&clock);
    let now: Arc<dyn Fn() -> u64 + Send + Sync> = Arc::new(move || shared.load(Ordering::Relaxed));
    // 阶段 A：注册（LocalDb 真 store 落库；时钟冻结下不发射）
    {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::new(LocalDbTimerStore::new(db.clone())) as Arc<dyn TimerStore>,
            Arc::clone(&now),
        ));
        let handle = registry
            .register(1, "LocalDb 重启恢复".to_string(), TimerCondition::Never)
            .await
            .expect("注册应成功");
        assert_eq!(handle.timer_id, "timer-0");
        assert!(
            queue_snapshot(&queue).is_empty(),
            "阶段 A：未到期不得注入 steering 条目"
        );
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "阶段 A：未到期不得发射 TimerFired"
        );
    }
    // 阶段 B：模拟重启 → restore 重建 sleep → 推进时钟 → 恰好注入一次
    {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::new(LocalDbTimerStore::new(db.clone())) as Arc<dyn TimerStore>,
            Arc::clone(&now),
        ));
        registry.restore().await;
        clock.store(clock.load(Ordering::Relaxed) + 2_000, Ordering::Relaxed);
        poll_until(|| queue_len(&queue) == 1).await;
        let entries = queue_snapshot(&queue);
        assert_eq!(entries.len(), 1, "恢复后到期应注入恰好一条");
        assert_eq!(
            entries[0].group_id.as_deref(),
            Some(steering_group_id("timer-0").as_str())
        );
        let emitted = events.emitted.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(emitted.len(), 1, "恢复侧应恰好发射一条 TimerFired");
        assert!(matches!(
            emitted[0],
            TimerEvent::Fired { ref timer_id, .. } if timer_id == "timer-0"
        ));
        // fired=true 落库（重启后避免重复注入）
        let persisted = LocalDbTimerStore::new(db.clone()).load_all();
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].fired, "到期声明应标 fired=true");
    }
    // 阶段 C：再次重启 → fired=true 跳过 → 不重复注入
    {
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let events = Arc::new(ProbeEvents::default());
        let registry = Arc::new(TimerRegistry::with_clock(
            Arc::new(QueuePendingSink::new(Arc::clone(&queue))),
            Arc::clone(&events) as Arc<dyn EventSink>,
            Arc::new(LocalDbTimerStore::new(db.clone())) as Arc<dyn TimerStore>,
            Arc::clone(&now),
        ));
        registry.restore().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            queue_snapshot(&queue).is_empty(),
            "fired=true 的声明恢复后不得重复注入"
        );
        assert!(
            events
                .emitted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty(),
            "fired=true 的声明恢复后不得重复发射"
        );
    }
}
