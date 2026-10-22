use super::*;

// ── T08.4 / T08.8 / T08.12 / Q25 新增测试 ──

/// T08.8 + T08.12：同会话连续两个 run——R2 从会话已落库最大序列续接
/// （跨 run 不重置，首事件 != 1），终态 cursor 正确
#[tokio::test]
async fn sequences_continue_across_runs_in_session() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    // R1：agent-start=1，agent-end=2，run-terminal=3
    let mut run = manager.start_run("s1", "r1").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.events.last().unwrap().sequence, 3);
    assert_eq!(
        mem.runs()[0].cursor,
        3,
        "R1 终态 cursor = 最后事件 sequence"
    );

    // R2：序列续接（会话内全局单调，跨 run 不重置——Q24/T08.12）
    let mut run2 = manager.start_run("s1", "r2").await.unwrap();
    let mut queue2 = EventQueue::new(store.clone(), run2.cursor + 1, None);
    let result2 = drive_outcome(
        &mut run2,
        &mut queue2,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();
    let seqs2: Vec<u64> = result2.events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs2, vec![4, 5, 6], "R2 从会话 max+1 续接（不等于 1）");
    assert_eq!(mem.runs()[1].cursor, 6, "R2 终态 cursor（T08.4）");

    // 全事件唯一连续
    let stored = mem.events();
    let mut all: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    all.sort_unstable();
    assert_eq!(all, (1..=6).collect::<Vec<_>>(), "会话内全事件连续无冲突");
}

/// T08.12 Q23：同会话双 run 并发各取 50 号——序列唯一连续、全部落库
/// 成功（无 UNIQUE 冲突 → 无 event-store-write-failed）
#[tokio::test]
async fn concurrent_runs_reserve_unique_sequences() {
    let (mem, store) = setup();
    let store_b = store.clone();
    let run_a = tokio::spawn(async move {
        let mut queue = EventQueue::new(store, 1, None);
        let mut seqs = Vec::new();
        for _ in 0..50 {
            seqs.push(queue.push("s1", message_end()).await.unwrap().sequence);
        }
        seqs
    });
    let run_b = tokio::spawn(async move {
        let mut queue = EventQueue::new(store_b, 1, None);
        let mut seqs = Vec::new();
        for _ in 0..50 {
            seqs.push(queue.push("s1", message_end()).await.unwrap().sequence);
        }
        seqs
    });
    let (sa, sb) = tokio::join!(run_a, run_b);
    let mut all = sa.unwrap();
    all.extend(sb.unwrap());
    all.sort_unstable();
    assert_eq!(
        all,
        (1..=100).collect::<Vec<_>>(),
        "并发取号全唯一连续（Q23）"
    );

    // 全部落库成功且不重复（无 event-store-write-failed）
    let stored = mem.events();
    assert_eq!(stored.len(), 100, "100 条事件全部落库");
    let mut seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=100).collect::<Vec<_>>());
}

/// Q25（必做）：中途持久化失败路径——终态复用失败的 sequence，
/// 落库序列无空洞（对齐重发路径语义）
#[tokio::test]
async fn mid_failure_terminal_reuses_failed_sequence_no_hole() {
    let (mem, store) = setup();
    // 单次故障：agent-start 落库失败后恢复正常
    mem.fail_next_append("一次失败");
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_hole").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
    // 落库序列无空洞：agent-start 失败（seq=1）→ 终态复用 seq=1
    let stored = mem.events();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].event_type, "run-terminal");
    assert_eq!(stored[0].sequence, 1, "终态复用失败序列，不留空洞（Q25）");
    // T08.4：失败路径 cursor = 最后已分配序列（含失败占位）
    assert_eq!(mem.runs()[0].cursor, 1, "失败路径 cursor 落库（T08.4）");
}

// ── C3：取号失败不推进本地镜像，终态只信 store.reserve_sequence ──

/// 前 N 次 `reserve_sequence` 失败且不推进内层计数器；其余方法委托内存 store。
struct FailNReserves {
    inner: Arc<InMemoryStore>,
    remaining: std::sync::atomic::AtomicU32,
}

impl FailNReserves {
    fn new(inner: Arc<InMemoryStore>, fails: u32) -> Self {
        Self {
            inner,
            remaining: std::sync::atomic::AtomicU32::new(fails),
        }
    }
}

#[async_trait::async_trait]
impl Store for FailNReserves {
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
        loop {
            let left = self.remaining.load(std::sync::atomic::Ordering::SeqCst);
            if left == 0 {
                return self.inner.reserve_sequence(session_id).await;
            }
            if self
                .remaining
                .compare_exchange(
                    left,
                    left - 1,
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                )
                .is_ok()
            {
                return Err(StoreError::new("reserve_sequence", "注入取号失败"));
            }
        }
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

/// C3：取号失败不推进本地镜像；终态经 store.reserve_sequence 重试取号，
/// 落库序号不与 store 计数器冲突。
#[tokio::test]
async fn reserve_failure_does_not_advance_mirror_or_collide_with_store() {
    let mem = Arc::new(InMemoryStore::new());
    let wrapped = Arc::new(FailNReserves::new(mem.clone(), 0));
    let store: Arc<dyn Store> = wrapped.clone();
    let mut queue = EventQueue::new(store.clone(), 1, None);

    let first = queue.push("s1", agent_start()).await.unwrap();
    assert_eq!(first.sequence, 1);
    assert_eq!(queue.next_sequence(), 2);

    wrapped
        .remaining
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let err = queue.push("s1", message_end()).await.unwrap_err();
    assert_eq!(err.error.kind, "reserve_sequence");
    assert_eq!(err.sequence, 1, "失败错误携带上次成功号，不是本地 +1");
    assert_eq!(queue.next_sequence(), 2, "取号失败不得推进本地镜像");

    // 终态：首次 reserve 再失败一次，重试走 store 取到 2
    wrapped
        .remaining
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let terminal = AgentEvent::RunTerminal {
        session_id: "s1".to_string(),
        run_id: "r-c3".to_string(),
        timestamp: ts(),
        terminal: RunTerminalStatus::Failed,
        error: Some("取号重试".to_string()),
    };
    let sequenced = queue.push_terminal_best_effort("s1", terminal).await;
    assert_eq!(sequenced.sequence, 2, "终态号来自 store 重试取号");
    assert!(sequenced.persisted, "重试取号成功后终态应落库");
    assert_eq!(queue.next_sequence(), 3);

    let stored = mem.events();
    let mut seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    seqs.sort_unstable();
    assert_eq!(seqs, vec![1, 2], "落库序列唯一，终态不与 store 冲突");
    assert_eq!(
        store.reserve_sequence("s1").await.unwrap(),
        3,
        "store 下一号接在终态之后——终态消耗的是 store 槽"
    );
}

/// C3：重试仍失败则不落库、不消耗 store 槽；恢复后下一号仍是未分配值。
#[tokio::test]
async fn reserve_retry_exhausted_does_not_persist_unallocated_sequence() {
    let mem = Arc::new(InMemoryStore::new());
    let wrapped = Arc::new(FailNReserves::new(mem.clone(), 0));
    let store: Arc<dyn Store> = wrapped.clone();
    let mut queue = EventQueue::new(store.clone(), 1, None);

    assert_eq!(queue.push("s1", agent_start()).await.unwrap().sequence, 1);

    // push_terminal：reserve + 一次重试，共两次取号均失败
    wrapped
        .remaining
        .store(2, std::sync::atomic::Ordering::SeqCst);
    let terminal = AgentEvent::RunTerminal {
        session_id: "s1".to_string(),
        run_id: "r-c3-ex".to_string(),
        timestamp: ts(),
        terminal: RunTerminalStatus::Failed,
        error: Some("store 仍坏".to_string()),
    };
    let sequenced = queue.push_terminal_best_effort("s1", terminal).await;
    assert!(!sequenced.persisted);
    assert_eq!(sequenced.sequence, 1, "未分配新号，返回上次成功号");
    assert_eq!(queue.next_sequence(), 2, "镜像仍停在上次成功号");
    assert_eq!(mem.events().len(), 1, "不得用未分配序号写库");
    assert_eq!(
        store.reserve_sequence("s1").await.unwrap(),
        2,
        "store 计数器未被本地瞎加抢号"
    );
}

/// C3：drive 中途取号失败后终态走 store 重试，不复用未分配号写库。
#[tokio::test]
async fn drive_outcome_reserve_failure_terminal_retries_store() {
    let mem = Arc::new(InMemoryStore::new());
    let wrapped = Arc::new(FailNReserves::new(mem.clone(), 0));
    let store: Arc<dyn Store> = wrapped.clone();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_c3_drive").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    wrapped
        .remaining
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].sequence, 1, "终态号来自 store 重试");
    assert!(result.events[0].persisted);
    let stored = mem.events();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].event_type, "run-terminal");
    assert_eq!(stored[0].sequence, 1);
    assert_eq!(
        store.reserve_sequence("s1").await.unwrap(),
        2,
        "终态占用 store 槽 1，下一号为 2，无冲突"
    );
}
