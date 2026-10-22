use super::*;

// ── 事件序列与持久化分流（T-D1-A：NoPersist-first）──

#[tokio::test]
async fn queue_assigns_continuous_sequences_and_splits_persistence() {
    let (mem, store) = setup();
    let mut queue = EventQueue::new(store, 1, None);

    let mut sequences = Vec::new();
    sequences.push(queue.push("s1", agent_start()).await.unwrap());
    for i in 0..3 {
        sequences.push(queue.push("s1", message_delta(i)).await.unwrap());
    }
    sequences.push(queue.push("s1", message_end()).await.unwrap());

    // T-D1-A（NoPersist-first）：delta 不取号——sequence = last_reserved
    // （夹在两条持久化事件之间时共享同一镜像值）；持久化事件仍连续取号。
    let seqs: Vec<u64> = sequences.iter().map(|s| s.sequence).collect();
    assert_eq!(
        seqs,
        vec![1, 1, 1, 1, 2],
        "delta 复用 last_reserved，不推进计数器"
    );
    // delta 不落库；持久化事件已落库
    assert_eq!(
        sequences.iter().map(|s| s.persisted).collect::<Vec<_>>(),
        vec![true, false, false, false, true]
    );
    assert_eq!(queue.next_sequence(), 3, "仅持久化事件推进镜像");

    // 落库集合 = 持久化事件（delta 不在其中）
    let stored = mem.events();
    let types: Vec<&str> = stored.iter().map(|e| e.event_type.as_str()).collect();
    assert_eq!(types, vec!["agent-start", "message-end"]);
    assert_eq!(stored[0].sequence, 1);
    assert_eq!(stored[1].sequence, 2, "持久化事件取号连续，无 delta 空洞");
}

/// N1（T-D1-A / U-NOPE）：NoPersist push 的 reserve 调用次数 = 0。
/// 用计数包装 Store 断言 store.reserve_sequence 零命中。
#[tokio::test]
async fn no_persist_push_does_not_reserve() {
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 计数包装：reserve_sequence 调用计数（N1 探针）
    struct CountingReserves {
        inner: Arc<InMemoryStore>,
        reserve_calls: AtomicU32,
    }

    #[async_trait::async_trait]
    impl Store for CountingReserves {
        async fn insert_run(
            &self,
            run_id: &str,
            session_id: &str,
            status: conex_db::RunStatus,
            end_reason: Option<&str>,
            cursor: i64,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .insert_run(run_id, session_id, status, end_reason, cursor)
                .await
        }

        async fn update_run_status(
            &self,
            run_id: &str,
            status: conex_db::RunStatus,
            end_reason: Option<&str>,
            cursor: Option<i64>,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .update_run_status(run_id, status, end_reason, cursor)
                .await
        }

        async fn reserve_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
            self.reserve_calls.fetch_add(1, Ordering::SeqCst);
            self.inner.reserve_sequence(session_id).await
        }

        async fn seed_sequence(
            &self,
            session_id: &str,
            next_sequence: u64,
        ) -> crate::persist::StoreResult<()> {
            self.inner.seed_sequence(session_id, next_sequence).await
        }

        async fn append_event(
            &self,
            session_id: &str,
            sequence: u64,
            event_type: &str,
            payload: &str,
            run_id: Option<&str>,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .append_event(session_id, sequence, event_type, payload, run_id)
                .await
        }

        async fn query_events(
            &self,
            session_id: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events(session_id, after_sequence, limit)
                .await
        }

        async fn query_events_by_run(
            &self,
            session_id: &str,
            run_id: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events_by_run(session_id, run_id, after_sequence, limit)
                .await
        }

        async fn max_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
            self.inner.max_sequence(session_id).await
        }

        async fn query_events_by_type(
            &self,
            session_id: &str,
            run_id: &str,
            event_type: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events_by_type(session_id, run_id, event_type, after_sequence, limit)
                .await
        }

        async fn query_runs(&self) -> crate::persist::StoreResult<Vec<conex_db::StoredRun>> {
            self.inner.query_runs().await
        }

        async fn save_pending_input(
            &self,
            id: &str,
            session_id: &str,
            run_id: Option<&str>,
            payload: &str,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .save_pending_input(id, session_id, run_id, payload)
                .await
        }

        async fn load_pending_inputs(
            &self,
            session_id: &str,
        ) -> crate::persist::StoreResult<Vec<conex_db::PendingInput>> {
            self.inner.load_pending_inputs(session_id).await
        }

        async fn delete_pending_input(&self, id: &str) -> crate::persist::StoreResult<bool> {
            self.inner.delete_pending_input(id).await
        }
    }

    let mem = Arc::new(InMemoryStore::new());
    let wrapped = Arc::new(CountingReserves {
        inner: mem.clone(),
        reserve_calls: AtomicU32::new(0),
    });
    let store: Arc<dyn Store> = wrapped.clone();
    let mut queue = EventQueue::new(store.clone(), 1, None);

    // NoPersist 批：3 条 delta 全部 push 成功，reserve 调用 = 0
    let mut sequences = Vec::new();
    for i in 0..3 {
        sequences.push(queue.push("s1", message_delta(i)).await.unwrap());
    }
    assert_eq!(
        wrapped.reserve_calls.load(Ordering::SeqCst),
        0,
        "N1：NoPersist push 的 reserve 调用次数必须为 0"
    );
    assert!(
        sequences.iter().all(|s| !s.persisted),
        "NoPersist 事件 persisted = false"
    );
    // sequence = last_reserved 镜像（未推进）
    assert_eq!(queue.next_sequence(), 1, "NoPersist 不推进本地镜像");

    // 持久化事件仍恰好 reserve 1 次
    queue.push("s1", agent_start()).await.unwrap();
    assert_eq!(
        wrapped.reserve_calls.load(Ordering::SeqCst),
        1,
        "持久化事件 reserve 恰一次"
    );
}

/// Persist_push_reserves_once：持久化事件每次 push 恰一次 reserve
#[tokio::test]
async fn persist_push_reserves_once() {
    use std::sync::atomic::{AtomicU32, Ordering};

    struct CountingReserves {
        inner: Arc<InMemoryStore>,
        reserve_calls: AtomicU32,
    }

    #[async_trait::async_trait]
    impl Store for CountingReserves {
        async fn insert_run(
            &self,
            run_id: &str,
            session_id: &str,
            status: conex_db::RunStatus,
            end_reason: Option<&str>,
            cursor: i64,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .insert_run(run_id, session_id, status, end_reason, cursor)
                .await
        }

        async fn update_run_status(
            &self,
            run_id: &str,
            status: conex_db::RunStatus,
            end_reason: Option<&str>,
            cursor: Option<i64>,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .update_run_status(run_id, status, end_reason, cursor)
                .await
        }

        async fn reserve_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
            self.reserve_calls.fetch_add(1, Ordering::SeqCst);
            self.inner.reserve_sequence(session_id).await
        }

        async fn seed_sequence(
            &self,
            session_id: &str,
            next_sequence: u64,
        ) -> crate::persist::StoreResult<()> {
            self.inner.seed_sequence(session_id, next_sequence).await
        }

        async fn append_event(
            &self,
            session_id: &str,
            sequence: u64,
            event_type: &str,
            payload: &str,
            run_id: Option<&str>,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .append_event(session_id, sequence, event_type, payload, run_id)
                .await
        }

        async fn query_events(
            &self,
            session_id: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events(session_id, after_sequence, limit)
                .await
        }

        async fn query_events_by_run(
            &self,
            session_id: &str,
            run_id: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events_by_run(session_id, run_id, after_sequence, limit)
                .await
        }

        async fn max_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
            self.inner.max_sequence(session_id).await
        }

        async fn query_events_by_type(
            &self,
            session_id: &str,
            run_id: &str,
            event_type: &str,
            after_sequence: u64,
            limit: Option<u64>,
        ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
            self.inner
                .query_events_by_type(session_id, run_id, event_type, after_sequence, limit)
                .await
        }

        async fn query_runs(&self) -> crate::persist::StoreResult<Vec<conex_db::StoredRun>> {
            self.inner.query_runs().await
        }

        async fn save_pending_input(
            &self,
            id: &str,
            session_id: &str,
            run_id: Option<&str>,
            payload: &str,
        ) -> crate::persist::StoreResult<()> {
            self.inner
                .save_pending_input(id, session_id, run_id, payload)
                .await
        }

        async fn load_pending_inputs(
            &self,
            session_id: &str,
        ) -> crate::persist::StoreResult<Vec<conex_db::PendingInput>> {
            self.inner.load_pending_inputs(session_id).await
        }

        async fn delete_pending_input(&self, id: &str) -> crate::persist::StoreResult<bool> {
            self.inner.delete_pending_input(id).await
        }
    }

    let mem = Arc::new(InMemoryStore::new());
    let wrapped = Arc::new(CountingReserves {
        inner: mem.clone(),
        reserve_calls: AtomicU32::new(0),
    });
    let store: Arc<dyn Store> = wrapped.clone();
    let mut queue = EventQueue::new(store, 1, None);

    queue.push("s1", agent_start()).await.unwrap();
    assert_eq!(wrapped.reserve_calls.load(Ordering::SeqCst), 1);
    queue.push("s1", message_end()).await.unwrap();
    assert_eq!(wrapped.reserve_calls.load(Ordering::SeqCst), 2);
}

/// N2（T-D1-A）：NoPersist 夹在两条持久化事件之间时，
/// run.cursor 不回退（相对批内已见最大持久化 sequence）。
#[tokio::test]
async fn nopersist_sandwich_does_not_lower_cursor() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_n2").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    // 批：agent-start(seq1) → 2×delta（NoPersist，seq=1 镜像）→
    // message-end(seq2) → 1×delta（seq=2 镜像）→ agent-end(seq3)
    let events = vec![
        agent_start(),
        message_delta(0),
        message_delta(1),
        message_end(),
        message_delta(2),
        agent_end(AgentEndReason::Stop),
    ];
    let result = drive_outcome(&mut run, &mut queue, outcome(AgentEndReason::Stop, events))
        .await
        .unwrap();

    // 落库序列连续无空洞：agent-start=1, message-end=2, agent-end=3, run-terminal=4
    let stored = mem.events();
    let mut all: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    all.sort_unstable();
    assert_eq!(all, (1..=4).collect::<Vec<_>>(), "持久化序列无空洞");

    // N2：终态 cursor = 最后持久化 sequence（不被 NoPersist 夹心拉低）
    assert_eq!(run.cursor, 4, "cursor 单调推进至终态");
    assert_eq!(mem.runs()[0].cursor, 4, "cursor 落库（T08.4）");

    // 事件流中 NoPersist 的 sequence 不推进计数器
    let deltas: Vec<u64> = result
        .events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::MessageDelta { .. }))
        .map(|e| e.sequence)
        .collect();
    assert!(
        deltas.iter().all(|&s| s <= 4),
        "NoPersist sequence 不产生越过终态的号"
    );
}

#[tokio::test]
async fn queue_persistent_events_wait_for_store() {
    let (mem, store) = setup();
    mem.set_append_delay(Duration::from_millis(40));
    let mut queue = EventQueue::new(store, 1, None);

    // 持久化事件同步等待落库（慢 store 40ms/条 × 3 条 ≈ 120ms）
    let started = Instant::now();
    queue.push("s1", agent_start()).await.unwrap();
    queue.push("s1", message_end()).await.unwrap();
    queue
        .push("s1", agent_end(AgentEndReason::Stop))
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(120),
        "持久化事件应等待落库：elapsed={elapsed:?}"
    );
    // 返回时已落库（中间态可观测）
    let stored = mem.events();
    assert_eq!(stored.len(), 3);
}

#[tokio::test]
async fn delta_does_not_block_drive_loop() {
    let (mem, store) = setup();
    // 慢 store：持久化追加 40ms/条（05 §2.8：120 delta × 40ms ≈ 4.8s 的
    // 场景；delta 不等待则整体远小于该值）
    mem.set_append_delay(Duration::from_millis(40));

    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_delta").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let mut events = vec![agent_start()];
    for i in 0..120 {
        events.push(message_delta(i));
    }
    events.push(message_end());
    events.push(agent_end(AgentEndReason::Stop));
    let outcome = outcome(AgentEndReason::Stop, events);

    let started = Instant::now();
    let result = drive_outcome(&mut run, &mut queue, outcome).await.unwrap();
    let elapsed = started.elapsed();

    // delta 不阻塞：120 条 delta 若各自等待 40ms 需约 4.8s；
    // 实际只等待 4 条持久化事件（agent-start/message-end/agent-end/终态）
    // T-D1-A 后 delta 连 reserve 都不调用——纯本地镜像返回。
    assert!(
        elapsed < Duration::from_millis(120 * 40 / 2),
        "delta 不应阻塞 drive loop：elapsed={elapsed:?}"
    );

    // 全部 120 条 delta 都存活于事件流
    let live_deltas = result
        .events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::MessageDelta { .. }))
        .count();
    assert_eq!(live_deltas, 120);

    // 落库集合不含 delta；持久化事件齐全
    let stored = mem.events();
    let types: Vec<&str> = stored.iter().map(|e| e.event_type.as_str()).collect();
    assert!(!types.contains(&"message-delta"), "delta 不应落库");
    assert!(types.contains(&"agent-start"));
    assert!(types.contains(&"message-end"));
    assert!(types.contains(&"run-terminal"));

    // 持久化序列连续（agent-start=1, message-end=2, agent-end=3, run-terminal=4）
    let mut persisted_seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    persisted_seqs.sort_unstable();
    assert_eq!(
        persisted_seqs,
        (1..=4).collect::<Vec<_>>(),
        "持久化事件序列连续无空洞"
    );
}
