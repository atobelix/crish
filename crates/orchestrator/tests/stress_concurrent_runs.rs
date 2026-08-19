//! 16 子 Agent 并发压力与零死锁拓扑实证（Unit 7.2 / PE-11 T11.6.2）
//!
//! 验证场景与铁律断言：
//! 1. 10 路同会话 / 20 跨会话并发 run：SessionSequencer 会话级原子取号连续且唯一；
//! 2. 16 子 Agent 真实 LocalDb (WAL) 高频并发请求：QPS、延迟百分位数、零持久化失败；
//! 3. 五级单向偏序锁序定理验证（L0 内存守卫 -> L1 SessionTree -> L2 RecoveryCoordinator -> L3 DbWriteActor -> L4 ReaderPool）：
//!    在高频并发争用下死锁发生率为 0，Tokio 线程池无饥饿，SQLite Group Commit P99 延迟满足 SLA；
//! 4. 全局一键终止（Kill All）并发级联压测：
//!    16 个子 Agent 密集执行期间触发 kill_all，验证所有子进程、PTY 句柄与内存会话 100% 安全释放，无孤儿泄漏，数据完整保留。

mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner, SubagentState,
};
use async_trait::async_trait;
use conex_db::{
    DbFailure, DbFailureKind, DbWriteHandle, GroupCommitConfig, LocalDb, ReaderPool,
    ReaderPoolConfig, RunStatus,
};
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use conex_types::{SessionAgent, SessionMessage};
use orchestrator::events::{drive_outcome, EventQueue, PersistFailureInfo};
use orchestrator::lifecycle::{ForceCancelSink, SubagentLifecycleService};
use orchestrator::persist::{InMemoryStore, LocalDbStore, Store};
use orchestrator::recovery::{RecoveryCoordinator, RecoveryRetryPolicy};
use orchestrator::run::RunManager;
use orchestrator::session::SessionTree;
use orchestrator::steering_queue::PendingMessageQueue;

use common::{agent_end, agent_start, message_delta, message_end, outcome};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RAII 临时数据库清理守卫
struct TempDbGuard {
    path: PathBuf,
}

impl Drop for TempDbGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
    }
}

static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn create_temp_db_path() -> (TempDbGuard, PathBuf) {
    let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "conex_stress_orchestrator_{}_{}_{}.db",
        std::process::id(),
        now,
        id
    ));
    let guard = TempDbGuard { path: path.clone() };
    (guard, path)
}

/// 单 run 全生命周期驱动：agent-start + n 条 message-end + agent-end
async fn drive_completed_run(
    store: Arc<dyn Store>,
    session_id: &str,
    run_id: &str,
    message_ends: usize,
) -> (RunTerminalStatus, Option<PersistFailureInfo>) {
    let manager = RunManager::new(store.clone());
    let mut run = manager
        .start_run(session_id, run_id)
        .await
        .expect("注册 run 不应失败");
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
    let mut events = vec![agent_start(session_id)];
    for _ in 0..message_ends {
        events.push(message_end(session_id));
    }
    events.push(agent_end(session_id, AgentEndReason::Stop));
    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(AgentEndReason::Stop, None, events),
    )
    .await
    .expect("驱动 run 不应失败");
    (result.terminal_status, result.persist_failure)
}

/// 场景 1：同会话 10 路并发 run（SessionSequencer 压力）
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn stress_same_session_10_concurrent_runs() {
    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    let started = Instant::now();

    let mut handles = Vec::new();
    for i in 0..10u64 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            drive_completed_run(store, "s_shared", &format!("r{i}"), 48).await
        }));
    }
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("并发任务不应 panic"));
    }
    let elapsed = started.elapsed();

    for (i, (status, failure)) in results.iter().enumerate() {
        assert_eq!(
            *status,
            RunTerminalStatus::Completed,
            "run {i} 应 completed 收场"
        );
        assert!(
            failure.is_none(),
            "run {i} 不得有持久化失败（无 UNIQUE 冲突）"
        );
    }

    let stored = mem.events();
    let total = stored.len();
    assert_eq!(total, 510, "10 run × 51 事件全部落库");
    let mut seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        (1..=total as u64).collect::<Vec<_>>(),
        "同会话并发 run 序列必须唯一连续（SessionSequencer 压力）"
    );

    let runs = mem.runs();
    assert_eq!(runs.len(), 10, "10 条 run 记录全部落库");
    assert!(
        runs.iter().all(|r| r.status == RunStatus::Completed),
        "全部 run 终态 completed"
    );
    assert!(
        runs.iter().all(|r| r.cursor > 0),
        "终态 cursor 全部落库（T08.4）"
    );

    let qps = total as f64 / elapsed.as_secs_f64();
    println!(
        "[STRESS-METRICS] 同会话 10 并发 run: 事件总数={total}, 耗时={elapsed:?}, QPS={qps:.2} ops/s"
    );
}

/// 场景 2：跨会话 20 路并发 run（会话级计数器隔离）
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn stress_cross_session_20_concurrent_runs() {
    let mem = Arc::new(InMemoryStore::new());
    let store: Arc<dyn Store> = mem.clone();
    let started = Instant::now();

    let mut handles = Vec::new();
    for i in 0..20u64 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            drive_completed_run(store, &format!("s{i}"), &format!("r{i}"), 3).await
        }));
    }
    for handle in handles {
        let (status, failure) = handle.await.expect("并发任务不应 panic");
        assert_eq!(
            status,
            RunTerminalStatus::Completed,
            "跨会话 run 应 completed 收场"
        );
        assert!(failure.is_none(), "跨会话并发 run 不得有持久化失败");
    }
    let elapsed = started.elapsed();

    let stored = mem.events();
    for i in 0..20u64 {
        let session = format!("s{i}");
        let mut seqs: Vec<u64> = stored
            .iter()
            .filter(|e| e.session_id == session)
            .map(|e| e.sequence)
            .collect();
        seqs.sort_unstable();
        assert_eq!(
            seqs,
            vec![1, 2, 3, 4, 5, 6],
            "会话 {session} 序列应 1..=6 连续"
        );
    }
    assert_eq!(mem.runs().len(), 20, "20 条 run 记录全部落库");
    assert!(
        mem.runs().iter().all(|r| r.status == RunStatus::Completed),
        "全部 run 终态 completed"
    );

    let total = stored.len();
    let qps = total as f64 / elapsed.as_secs_f64();
    println!(
        "[STRESS-METRICS] 跨会话 20 并发 run: 事件总数={total}, 耗时={elapsed:?}, QPS={qps:.2} ops/s"
    );
}

/// 场景 3：16 子 Agent 真实 LocalDb (WAL) 高频并发请求压力测试
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
async fn stress_16_subagents_high_concurrency_real_db() {
    let (_guard, db_path) = create_temp_db_path();
    let db = LocalDb::open(&db_path).expect("打开真实 LocalDb 失败");
    let store = Arc::new(LocalDbStore::new(db.clone())) as Arc<dyn Store>;

    let total_agents = 16usize;
    let events_per_agent = 20usize;
    let parent_session_id = "parent-master-session";
    db.insert_session(parent_session_id, "主控编排会话")
        .expect("创建主会话失败");

    // 预先初始化 16 个子会话记录
    for agent_idx in 0..total_agents {
        let session_id = format!("subagent-sess-{agent_idx}");
        db.insert_session(&session_id, &format!("子 Agent 会话 {agent_idx}"))
            .expect("初始化子会话失败");
    }

    let started = Instant::now();
    let mut handles = Vec::new();
    let active_peak = Arc::new(AtomicUsize::new(0));
    let current_concurrency = Arc::new(AtomicUsize::new(0));
    let latencies = Arc::new(Mutex::new(Vec::new()));

    for agent_idx in 0..total_agents {
        let store = store.clone();
        let active_peak = active_peak.clone();
        let current_concurrency = current_concurrency.clone();
        let latencies = latencies.clone();
        let session_id = format!("subagent-sess-{agent_idx}");
        let run_id = format!("subagent-run-{agent_idx}");

        handles.push(tokio::spawn(async move {
            let cur = current_concurrency.fetch_add(1, Ordering::SeqCst) + 1;
            active_peak.fetch_max(cur, Ordering::SeqCst);

            let op_start = Instant::now();
            let manager = RunManager::new(store.clone());
            let mut run = manager
                .start_run(&session_id, &run_id)
                .await
                .expect("注册子 Agent run 失败");

            let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);
            let mut events = vec![agent_start(&session_id)];

            for msg_idx in 0..events_per_agent {
                events.push(message_delta(&session_id, msg_idx as u64));
                events.push(message_end(&session_id));
            }
            events.push(agent_end(&session_id, AgentEndReason::Stop));

            let result = drive_outcome(
                &mut run,
                &mut queue,
                outcome(AgentEndReason::Stop, None, events),
            )
            .await
            .expect("驱动子 Agent run 失败");

            let dur = op_start.elapsed();
            latencies.lock().unwrap().push(dur);
            current_concurrency.fetch_sub(1, Ordering::SeqCst);

            (result.terminal_status, result.persist_failure)
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("子 Agent 并发任务 panic"));
    }
    let elapsed = started.elapsed();

    for (i, (status, failure)) in results.iter().enumerate() {
        assert_eq!(
            *status,
            RunTerminalStatus::Completed,
            "子 Agent {i} 必须正常收口为 Completed"
        );
        assert!(
            failure.is_none(),
            "子 Agent {i} 不得发生持久化失败: {failure:?}"
        );
    }

    // 验证各子会话事件落库单调递增性与完整性
    for agent_idx in 0..total_agents {
        let session_id = format!("subagent-sess-{agent_idx}");
        let events = store
            .query_events(&session_id, 0, None)
            .await
            .expect("查询事件失败");
        // agent_start (1) + events_per_agent * (message_end (1)) + agent_end (1) + run_terminal (1) = 23 条持久化事件
        // (注意 message_delta 消费 sequence 但不持久化入库)
        let expected_persisted = 1 + events_per_agent + 1 + 1;
        assert_eq!(
            events.len(),
            expected_persisted,
            "子会话 {session_id} 事件数不符合预期"
        );
        let seqs: Vec<u64> = events.iter().map(|e| e.sequence).collect();

        let mut expected_seqs = vec![1u64];
        for i in 0..events_per_agent {
            expected_seqs.push((1 + i * 2 + 2) as u64);
        }
        expected_seqs.push((1 + events_per_agent * 2 + 1) as u64);
        expected_seqs.push((1 + events_per_agent * 2 + 2) as u64);

        assert_eq!(
            seqs, expected_seqs,
            "子会话 {session_id} sequence 必须完全匹配预期序列分配"
        );
    }

    let total_events = total_agents * (1 + events_per_agent + 1 + 1);
    let qps = total_events as f64 / elapsed.as_secs_f64();
    let peak = active_peak.load(Ordering::SeqCst);
    let mut lat_list = latencies.lock().unwrap().clone();
    lat_list.sort_unstable();
    let p50 = lat_list
        .get(lat_list.len() / 2)
        .cloned()
        .unwrap_or_default();
    let p95 = lat_list
        .get((lat_list.len() as f64 * 0.95) as usize)
        .cloned()
        .unwrap_or_default();
    let p99 = lat_list
        .get((lat_list.len() as f64 * 0.99) as usize)
        .cloned()
        .unwrap_or_default();

    println!(
        "[STRESS-METRICS] 16-Agent 真实 LocalDb 并发压测: 并发峰值={peak}/16, 事件总数={total_events}, 总耗时={elapsed:?}, QPS={qps:.2} ops/s, 延迟 P50={p50:?}, P95={p95:?}, P99={p99:?}"
    );
}

#[derive(Debug)]
struct MockSpawner;

#[async_trait]
impl SubagentSpawner for MockSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        Ok(SubagentSpawnResult {
            subagent_id: "sub-mock".to_string(),
            subagent_run_id: "run-mock".to_string(),
            session_id: "sess-mock".to_string(),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }
}

/// 场景 4：五级锁偏序与零死锁拓扑实证
///
/// 偏序拓扑：L0 (纳秒级内存守卫) -> L1 (微秒级领域状态锁) -> L2 (异步互斥业务锁) -> L3 (数据库独占写锁) -> L4 (无锁只读连接池)
///
/// 断言：
/// 1. 死锁发生率为 0（在 16 并发高频争用下 100% 正常完成）；
/// 2. Tokio 线程池无饥饿（无跨 await 裸锁阻塞）；
/// 3. Group Commit P99 延迟满足 SLA；
/// 4. ReaderPool 零超时，自适应 try_lock 快速路径命中率高。
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
async fn stress_five_tier_lock_ordering_zero_deadlock() {
    let (_guard, db_path) = create_temp_db_path();

    // 1. 初始化 L3: SQLite Single Writer Actor (Group Commit 5ms 管道)
    let write_conn = rusqlite::Connection::open(&db_path).expect("打开 SQLite 写连接失败");
    write_conn
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             CREATE TABLE test_five_tier_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_id INTEGER NOT NULL,
                iteration INTEGER NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
             );",
        )
        .expect("初始化五级锁测试表失败");

    let group_commit_config = GroupCommitConfig {
        batch_timeout: Duration::from_millis(5),
        max_batch_size: 50,
        channel_capacity: 1024,
    };
    let l3_writer = DbWriteHandle::spawn(write_conn, group_commit_config);

    // 2. 初始化 L4: ReaderPool (WAL 8 连接自适应探测池)
    let l4_reader_pool = ReaderPool::open(
        &db_path,
        ReaderPoolConfig {
            pool_size: 8,
            max_wait_timeout: Duration::from_secs(5),
            ..Default::default()
        },
    )
    .expect("打开 L4 ReaderPool 失败");

    // 3. 初始化 L2: RecoveryCoordinator 异步业务互斥锁
    let l2_db = LocalDb::open(&db_path).expect("打开 Recovery LocalDb 失败");
    let master_sess = "session_recovery_master";
    l2_db
        .insert_session(master_sess, "恢复主会话")
        .expect("插入主会话失败");
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new(master_sess)));
    let spawner = Arc::new(MockSpawner);
    let coordinator = RecoveryCoordinator::new(
        master_sess,
        Arc::new(l2_db),
        queue,
        tree,
        spawner,
        RecoveryRetryPolicy::default(),
    )
    .expect("构造 RecoveryCoordinator 失败");
    let l2_recovery = Arc::new(tokio::sync::Mutex::new(coordinator));

    // 4. 初始化 L1: SessionTree 微秒级领域状态锁
    let l1_session_tree = Arc::new(Mutex::new(SessionTree::new("session_domain_tree")));

    // 5. 初始化 L0: 纳秒级内存守卫 (模拟 InFlightExportGuard / WritePathRegistry)
    let l0_mem_guard = Arc::new(Mutex::new(HashMap::<String, u64>::new()));

    // 并发运行统计
    let total_workers = 16usize;
    let iterations_per_worker = 25usize;
    let read_workers = 8usize;
    let reads_per_worker = 50usize;

    let write_latencies = Arc::new(Mutex::new(Vec::new()));
    let l0_wait_times = Arc::new(Mutex::new(Vec::new()));
    let l1_wait_times = Arc::new(Mutex::new(Vec::new()));
    let l2_wait_times = Arc::new(Mutex::new(Vec::new()));
    let completed_tasks = Arc::new(AtomicUsize::new(0));

    let mut join_set = tokio::task::JoinSet::new();
    let test_start = Instant::now();

    // 启动 16 个写 Worker：严格按 L0 -> L1 -> L2 -> L3 偏序申请资源并执行
    for worker_id in 0..total_workers {
        let l0 = l0_mem_guard.clone();
        let l1 = l1_session_tree.clone();
        let l2 = l2_recovery.clone();
        let l3 = l3_writer.clone();
        let write_latencies = write_latencies.clone();
        let l0_wait_times = l0_wait_times.clone();
        let l1_wait_times = l1_wait_times.clone();
        let l2_wait_times = l2_wait_times.clone();
        let completed = completed_tasks.clone();

        join_set.spawn(async move {
            for iter in 0..iterations_per_worker {
                // Tier L0: 纳秒级内存守卫（持锁极短，不可跨 await）
                let t0 = Instant::now();
                {
                    let mut guard = l0.lock().expect("L0 锁中毒");
                    guard.insert(format!("w{worker_id}"), iter as u64);
                }
                let l0_dur = t0.elapsed();
                l0_wait_times.lock().unwrap().push(l0_dur);

                // Tier L1: 微秒级领域状态锁（同步锁，立即释放，不跨 await）
                let t1 = Instant::now();
                {
                    let mut tree = l1.lock().expect("L1 锁中毒");
                    let _ = tree.append(
                        &format!("node-{worker_id}-{iter}"),
                        serde_json::json!({ "worker": worker_id, "iter": iter }),
                    );
                }
                let l1_dur = t1.elapsed();
                l1_wait_times.lock().unwrap().push(l1_dur);

                // Tier L2: 异步业务锁（全异步 tokio::sync::Mutex）
                let t2 = Instant::now();
                {
                    let mut recovery = l2.lock().await;
                    let ctx = orchestrator::recovery::RunFailureContext {
                        subagent_id: format!("sub-{worker_id}"),
                        subagent_run_id: format!("run-{worker_id}-{iter}"),
                        task: format!("task payload {worker_id}-{iter}"),
                        error_kind: conex_types::error::ProviderErrorKind::Network,
                        retries: (iter % 3) as u32,
                        retry_elapsed_ms: 1000,
                        produced_content: false,
                        from_leaf_id: Some("root".to_string()),
                        started_at_ms: 1700000000000,
                        inject_bytes: 50,
                        window_bytes: 1000,
                    };
                    let outcome = recovery.on_subagent_run_failure(&ctx).await.expect("恢复决策失败");
                    assert!(matches!(
                        outcome.action,
                        orchestrator::recovery::RecoveryAction::AutoRetry { .. }
                            | orchestrator::recovery::RecoveryAction::SteeringQueued { .. }
                            | orchestrator::recovery::RecoveryAction::NeedsUser { .. }
                    ));
                }
                let l2_dur = t2.elapsed();
                l2_wait_times.lock().unwrap().push(l2_dur);

                // Tier L3: 毫秒级数据库独占写锁（Group Commit 管道）
                let t3 = Instant::now();
                let now_epoch = now_ms();
                let payload = format!("payload-data-{worker_id}-{iter}");
                l3.write(move |conn| {
                    conn.execute(
                        "INSERT INTO test_five_tier_events (worker_id, iteration, payload, created_at) VALUES (?1, ?2, ?3, ?4);",
                        rusqlite::params![worker_id as i64, iter as i64, payload, now_epoch],
                    )
                    .map_err(|e| DbFailure {
                        message: e.to_string(),
                        kind: DbFailureKind::Other("insert".into()),
                    })?;
                    Ok(())
                })
                .await
                .expect("L3 写入失败");
                let l3_dur = t3.elapsed();
                write_latencies.lock().unwrap().push(l3_dur);

                completed.fetch_add(1, Ordering::Relaxed);
            }
        });
    }

    // 启动 8 个读 Worker：独立并发查询 Tier L4 (ReaderPool)
    for _r in 0..read_workers {
        let pool = l4_reader_pool.clone();
        join_set.spawn(async move {
            for _ in 0..reads_per_worker {
                let _count: i64 = pool
                    .read_async(|conn| {
                        conn.query_row("SELECT count(*) FROM test_five_tier_events;", [], |row| {
                            row.get(0)
                        })
                        .map_err(|e| DbFailure {
                            message: e.to_string(),
                            kind: DbFailureKind::Other("query".into()),
                        })
                    })
                    .await
                    .expect("L4 读连接查询失败");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });
    }

    // 10 秒硬超时判定死锁与饥饿
    let timeout_res = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(res) = join_set.join_next().await {
            res.expect("Worker 任务 panic");
        }
    })
    .await;

    assert!(
        timeout_res.is_ok(),
        "五级锁偏序并发压力测试超时（发生死锁或 Tokio 线程饥饿）！"
    );

    let total_test_duration = test_start.elapsed();
    let expected_writes = total_workers * iterations_per_worker;
    assert_eq!(
        completed_tasks.load(Ordering::Relaxed),
        expected_writes,
        "所有写操作必须 100% 完成"
    );

    // 统计指标计算
    let mut w_lats = write_latencies.lock().unwrap().clone();
    w_lats.sort_unstable();
    let p50_write = w_lats.get(w_lats.len() / 2).cloned().unwrap_or_default();
    let p95_write = w_lats
        .get((w_lats.len() as f64 * 0.95) as usize)
        .cloned()
        .unwrap_or_default();
    let p99_write = w_lats
        .get((w_lats.len() as f64 * 0.99) as usize)
        .cloned()
        .unwrap_or_default();

    // 激活死数据：计算各锁层级的 P99 等待时延并断言偏序单调性
    let mut l0_sorted = l0_wait_times.lock().unwrap().clone();
    let mut l1_sorted = l1_wait_times.lock().unwrap().clone();
    let mut l2_sorted = l2_wait_times.lock().unwrap().clone();
    l0_sorted.sort_unstable();
    l1_sorted.sort_unstable();
    l2_sorted.sort_unstable();

    let p99_idx_0 =
        ((l0_sorted.len() as f64 * 0.99) as usize).min(l0_sorted.len().saturating_sub(1));
    let p99_idx_1 =
        ((l1_sorted.len() as f64 * 0.99) as usize).min(l1_sorted.len().saturating_sub(1));
    let p99_idx_2 =
        ((l2_sorted.len() as f64 * 0.99) as usize).min(l2_sorted.len().saturating_sub(1));
    let p99_l0 = l0_sorted.get(p99_idx_0).cloned().unwrap_or_default();
    let p99_l1 = l1_sorted.get(p99_idx_1).cloned().unwrap_or_default();
    let p99_l2 = l2_sorted.get(p99_idx_2).cloned().unwrap_or_default();

    // 偏序时延单调性物理断言：L0 (纳秒级内存守卫) <= L1 (微秒级领域状态锁) <= L2 (异步业务互斥锁)
    assert!(
        p99_l0 <= p99_l1,
        "L0 纳秒内存守卫 P99 ({p99_l0:?}) 必须 <= L1 微秒领域状态锁 P99 ({p99_l1:?})"
    );
    assert!(
        p99_l1 <= p99_l2,
        "L1 微秒领域状态锁 P99 ({p99_l1:?}) 必须 <= L2 异步业务锁 P99 ({p99_l2:?})"
    );

    // Group Commit P99 写入延迟 SLA 硬断言
    assert!(
        p99_write < Duration::from_millis(50),
        "Group Commit P99 写入延迟必须小于 50ms SLA 门槛: {p99_write:?}"
    );

    let pool_stats = l4_reader_pool.stats();
    let writer_stats = l3_writer.stats();

    // 验证 ReaderPool 零超时
    assert_eq!(pool_stats.timeouts, 0, "ReaderPool 发生超时争用");
    assert!(
        pool_stats.total_acquisitions > 0,
        "ReaderPool 应有有效借出记录"
    );

    let qps = expected_writes as f64 / total_test_duration.as_secs_f64();

    println!(
        "[STRESS-METRICS] 五级锁偏序与零死锁拓扑实证:\n  - 死锁发生率: 0.00% (0/{expected_writes})\n  - 线程饥饿: 0 (全部 {total_workers} Worker 顺利完成)\n  - 写入 QPS: {qps:.2} ops/s (总耗时: {total_test_duration:?})\n  - 锁等待时延: P99(L0)={p99_l0:?}, P99(L1)={p99_l1:?}, P99(L2)={p99_l2:?}\n  - Group Commit 写入延迟: P50={p50_write:?}, P95={p95_write:?}, P99={p99_write:?}\n  - Group Commit 批统计: 总操作={ops}, 批次总数={batches}, 最大批量={max_batch}\n  - ReaderPool 统计: 获取次数={acqs}, 快速路径命中={fast_hits}, 超时={timeouts}",
        ops = writer_stats.total_operations,
        batches = writer_stats.total_batches,
        max_batch = writer_stats.max_batch_size_seen,
        acqs = pool_stats.total_acquisitions,
        fast_hits = pool_stats.fast_path_hits,
        timeouts = pool_stats.timeouts,
    );
}

/// 模拟活跃子代理运行时句柄（追踪 PTY 句柄与内存会话，用于孤儿泄漏审计）
struct MockActiveSubagentHandle {
    _run_id: String,
    cancelled: Arc<AtomicBool>,
    pty_handle_freed: Arc<AtomicBool>,
}

struct MockCanceller {
    handles: Mutex<HashMap<String, MockActiveSubagentHandle>>,
}

impl MockCanceller {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            handles: Mutex::new(HashMap::new()),
        })
    }

    fn register(&self, run_id: &str) -> (Arc<AtomicBool>, Arc<AtomicBool>) {
        let cancelled = Arc::new(AtomicBool::new(false));
        let pty_handle_freed = Arc::new(AtomicBool::new(false));
        self.handles.lock().unwrap().insert(
            run_id.to_string(),
            MockActiveSubagentHandle {
                _run_id: run_id.to_string(),
                cancelled: cancelled.clone(),
                pty_handle_freed: pty_handle_freed.clone(),
            },
        );
        (cancelled, pty_handle_freed)
    }

    fn active_count(&self) -> usize {
        self.handles
            .lock()
            .unwrap()
            .values()
            .filter(|h| !h.pty_handle_freed.load(Ordering::SeqCst))
            .count()
    }
}

impl ForceCancelSink for MockCanceller {
    fn request_force_cancel(&self, subagent_run_id: &str, _reason: &str) -> bool {
        if let Some(handle) = self.handles.lock().unwrap().get(subagent_run_id) {
            handle.cancelled.store(true, Ordering::SeqCst);
            handle.pty_handle_freed.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }
}

/// 场景 5：全局一键终止（Kill All）并发级联压测
///
/// 在 16 个子 Agent 密集执行期间触发 `kill_all`，验证所有子进程、PTY 句柄与内存会话 100% 安全释放，无孤儿泄漏。
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
async fn stress_kill_all_cascade_no_orphans() {
    let timeout_res = tokio::time::timeout(Duration::from_secs(10), async {
        let (_guard, db_path) = create_temp_db_path();
        let db = LocalDb::open(&db_path).expect("打开 LocalDb 失败");
        let main_session_id = "master-session-kill-all";
        db.insert_session(main_session_id, "主控级联终止测试会话")
            .expect("创建主会话失败");

        let total_subagents = 16usize;
        let canceller = MockCanceller::new();
        let now = now_ms();

        // 预置 16 个 running 状态的子 Agent 记录，每条带有产出消息和活跃句柄
        let mut initial_agents = Vec::new();
        let mut cancel_flags = Vec::new();
        let mut pty_flags = Vec::new();

        for i in 0..total_subagents {
            let subagent_id = format!("sub-agent-{i}");
            let run_id = format!("sub-run-{i}");
            let (cancelled, pty_freed) = canceller.register(&run_id);
            cancel_flags.push(cancelled);
            pty_flags.push(pty_freed);

            initial_agents.push(SessionAgent {
                id: subagent_id.clone(),
                subagent_run_id: run_id.clone(),
                parent_session_id: main_session_id.to_string(),
                parent_run_id: "master-run-0".to_string(),
                parent_tool_call_id: Some(format!("tc-{i}")),
                description: format!("任务执行单元 {i}"),
                mode: "implement".to_string(),
                status: "running".to_string(),
                summary: None,
                messages: vec![SessionMessage {
                    id: format!("msg-sub-{i}"),
                    sender: "user".to_string(),
                    text: Some(format!("执行子任务产出数据 #{i}")),
                    thinking: None,
                    timestamp: now,
                    status: None,
                    stream_text_offset: None,
                    thinking_time: None,
                    tool_calls_json: None,
                    blocks_json: None,
                    tool_call_results_json: None,
                    usage: None,
                }],
                started_at: now,
                ended_at: None,
                depth: Some(1),
                subagent_path_json: None,
                task_type: None,
                display_label: Some(format!("Worker #{i}")),
                allowed_write_paths_json: None,
                sub_session_id: None,
            });
        }

        db.save_session_agents(main_session_id, &initial_agents)
            .expect("保存初始 session_agents 失败");

        // 确认此时有 16 个活跃句柄
        assert_eq!(canceller.active_count(), 16, "初始必须有 16 个活跃运行句柄");

        // 启动 16 个并发后台异步写入任务模拟运行中的事件与写争用
        let mut bg_handles = Vec::new();
        let stop_signal = Arc::new(AtomicBool::new(false));
        let bg_ready_counter = Arc::new(AtomicUsize::new(0));

        for i in 0..total_subagents {
            let db_clone = db.clone();
            let stop_clone = stop_signal.clone();
            let bg_ready = bg_ready_counter.clone();
            let sub_sess = format!("subagent-runtime-sess-{i}");
            let _ = db_clone.insert_session(&sub_sess, "子代理临时会话");
            bg_handles.push(tokio::spawn(async move {
                bg_ready.fetch_add(1, Ordering::SeqCst);
                let mut seq = 1i64;
                while !stop_clone.load(Ordering::Relaxed) {
                    let _ = db_clone.append_event(
                        &sub_sess,
                        seq,
                        "message_delta",
                        r#"{"text":"streaming chunk"}"#,
                        None,
                    );
                    seq += 1;
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }));
        }

        // 确定性状态等待：确保全部 16 个后台写争用任务已启动并进入循环
        common::wait_until(
            Duration::from_secs(5),
            Duration::from_millis(1),
            || async {
                if bg_ready_counter.load(Ordering::SeqCst) == total_subagents {
                    Some(())
                } else {
                    None
                }
            },
        )
        .await
        .expect("所有 16 个后台写争用任务必须已进入高频执行态");

        // 触发 SubagentLifecycleService::kill_all 批量终止
        let service = SubagentLifecycleService::new(Arc::new(db.clone()), canceller.clone());
        let kill_start = Instant::now();
        let outcome = service
            .kill_all(main_session_id, "stress_kill_all")
            .expect("kill_all 执行不应报错");
        let kill_elapsed = kill_start.elapsed();

        // 停止后台任务
        stop_signal.store(true, Ordering::SeqCst);
        for h in bg_handles {
            let _ = h.await;
        }

        // 断言 1: KillAllOutcome 汇报精准
        assert_eq!(
            outcome.terminated.len(),
            16,
            "16 个 running 子代理必须全部被终止"
        );
        assert_eq!(
            outcome.non_terminal.len(),
            0,
            "不应存在未投递成功或未终态条目"
        );

        // 断言 2: 16 个子 Agent 的 PTY / 进程句柄 100% 释放，无孤儿泄漏
        assert_eq!(
            canceller.active_count(),
            0,
            "kill_all 级联终止后活跃 PTY / 进程句柄数必须为 0（零孤儿泄漏）"
        );
        for (i, pty_flag) in pty_flags.iter().enumerate() {
            assert!(
                pty_flag.load(Ordering::SeqCst),
                "子 Agent {i} 的 PTY / 进程句柄未释放"
            );
        }

        // 断言 3: 数据库 session_agents 行全部归一为 failed，且产出数据完整保留
        let final_agents = db
            .load_session_agents(main_session_id)
            .expect("加载最终 session_agents 失败");
        assert_eq!(final_agents.len(), 16, "16 个子代理行必须依然存在");
        for agent in &final_agents {
            assert_eq!(
                agent.status, "failed",
                "子代理 {} 终态必须归一为 failed",
                agent.id
            );
            assert!(
                agent.ended_at.is_some(),
                "子代理 {} 必须记录 ended_at 终态时间戳",
                agent.id
            );
            assert_eq!(
                agent.messages.len(),
                1,
                "子代理 {} 历史产出消息必须完整保留",
                agent.id
            );
            let expected_text = format!("执行子任务产出数据 #{}", &agent.id["sub-agent-".len()..]);
            assert_eq!(
                agent.messages[0].text.as_deref(),
                Some(expected_text.as_str())
            );
        }

        // 断言 4: 数据库无损坏，ReaderPool 健康探测通过
        let reader_pool = ReaderPool::open(&db_path, ReaderPoolConfig::default())
            .expect("打开 ReaderPool 验证健康失败");
        reader_pool.check_health().expect("数据库健康检查必须通过");

        println!(
            "[STRESS-METRICS] 16-Agent 全局一键终止 (Kill All) 级联压测:\n  - 终止目标数: 16/16\n  - 终止总耗时: {kill_elapsed:?}\n  - 活跃 PTY / 孤儿句柄泄漏: 0 (100% 干净释放)\n  - 历史产出保留率: 100% (16/16 消息完整落库)\n  - 数据库一致性检查: PASS"
        );
    })
    .await;

    assert!(
        timeout_res.is_ok(),
        "全局一键终止级联压测在 10 秒内未完成：发生死锁或挂起！"
    );
}
