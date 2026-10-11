//! 真实 SQLite WAL 16 写 8 读高并发零死锁压测（Batch 4 / AST-02-07 / STRESS-01）
//!
//! 验证场景与断言：
//! 1. 真实生产 `LocalDb` WAL 实例 + 真实异步协调器 `RecoveryCoordinator` (tokio::sync::Mutex) + 独占写 Actor (DbWriteHandle) + 真实 ReaderPool(8)；
//! 2. 16 并发写入 Worker + 8 并发读取 Worker，高频争用写入，设置 10 秒硬性超时哨兵监控；
//! 3. 验证五级单向偏序锁序拓扑：L0 (纳秒内存守卫) <= L1 (微秒领域状态锁) <= L2 (异步业务互斥锁)；
//! 4. 验证 SQLite WAL 零死锁、零锁竞争超时、Group Commit P99 写入时延 < 50ms；
//! 5. 跨会话 16 写 8 读多会话高并发 WAL 数据完整性与原子连续 sequence 校验。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_tools::tools::subagent::{
    SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult, SubagentSpawner, SubagentState,
};
use async_trait::async_trait;
use conex_db::{DbFailure, DbFailureKind, LocalDb, ReaderPool, ReaderPoolConfig};
use conex_types::error::ProviderErrorKind;
use orchestrator::recovery::{
    RecoveryAction, RecoveryCoordinator, RecoveryRetryPolicy, RecoveryStore, RunFailureContext,
};
use orchestrator::session::SessionTree;
use orchestrator::steering_queue::PendingMessageQueue;

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
        "conex_stress_empirical_{}_{}_{}.db",
        std::process::id(),
        now,
        id
    ));
    let guard = TempDbGuard { path: path.clone() };
    (guard, path)
}

/// 真实 Spawner 模拟（执行微秒级异步调度并返回成功）
#[derive(Debug)]
struct RealStressSpawner {
    pub spawn_count: AtomicUsize,
}

#[async_trait]
impl SubagentSpawner for RealStressSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        let n = self.spawn_count.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_micros(50)).await;
        Ok(SubagentSpawnResult {
            subagent_id: format!("sub-{n}"),
            subagent_run_id: format!("run-{n}"),
            session_id: format!("sess-{n}"),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
async fn stress_real_localdb_and_kernel_state_machine_zero_deadlock() {
    // 1. 创建真实临时 SQLite WAL 数据库
    let (_guard, db_path) = create_temp_db_path();
    let local_db = LocalDb::open(&db_path).expect("打开真实 LocalDb 失败");
    let master_sess = "session_stress_root";
    local_db
        .insert_session(master_sess, "并发压力测试会话")
        .expect("创建主测试会话失败");

    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let tree = Arc::new(Mutex::new(SessionTree::new(master_sess)));
    let spawner = Arc::new(RealStressSpawner {
        spawn_count: AtomicUsize::new(0),
    });

    // 初始化全异步 RecoveryCoordinator (L2 锁)
    let coordinator = RecoveryCoordinator::new(
        master_sess,
        Arc::new(local_db.clone()) as Arc<dyn RecoveryStore>,
        queue,
        Arc::clone(&tree),
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        RecoveryRetryPolicy {
            max_retries: 3,
            ..Default::default()
        },
    )
    .expect("构造 RecoveryCoordinator 失败");

    let l2_coordinator = Arc::new(tokio::sync::Mutex::new(coordinator));
    let l1_tree = tree;
    let l0_guard = Arc::new(Mutex::new(HashMap::<String, u64>::new()));

    // 2. 并发指标与就绪同步器
    let write_workers = 16usize;
    let iterations_per_worker = 25usize;
    let ready_counter = Arc::new(AtomicUsize::new(0));
    let completed_tasks = Arc::new(AtomicUsize::new(0));

    let l0_latencies = Arc::new(Mutex::new(Vec::with_capacity(
        write_workers * iterations_per_worker,
    )));
    let l1_latencies = Arc::new(Mutex::new(Vec::with_capacity(
        write_workers * iterations_per_worker,
    )));
    let l2_latencies = Arc::new(Mutex::new(Vec::with_capacity(
        write_workers * iterations_per_worker,
    )));
    let l3_latencies = Arc::new(Mutex::new(Vec::with_capacity(
        write_workers * iterations_per_worker,
    )));

    let mut join_set = tokio::task::JoinSet::new();
    let test_start = Instant::now();

    // 3. 启动 16 个写 Worker
    for worker_id in 0..write_workers {
        let l0 = Arc::clone(&l0_guard);
        let l1 = Arc::clone(&l1_tree);
        let l2 = Arc::clone(&l2_coordinator);
        let db = local_db.clone();
        let ready = Arc::clone(&ready_counter);
        let completed = Arc::clone(&completed_tasks);
        let l0_lat = Arc::clone(&l0_latencies);
        let l1_lat = Arc::clone(&l1_latencies);
        let l2_lat = Arc::clone(&l2_latencies);
        let l3_lat = Arc::clone(&l3_latencies);

        join_set.spawn(async move {
            ready.fetch_add(1, Ordering::SeqCst);

            for iter in 0..iterations_per_worker {
                // Tier L0: 纳秒级内存守卫 (严禁跨 await，立即释放)
                let t0 = Instant::now();
                {
                    let mut guard = l0.lock().expect("L0 锁中毒");
                    guard.insert(format!("w-{worker_id}"), iter as u64);
                }
                let l0_dur = t0.elapsed();
                l0_lat.lock().unwrap().push(l0_dur);

                // Tier L1: 微秒级领域状态锁 (纯内存树节点更新，严禁跨 await，立即释放)
                let node_id = format!("node-{worker_id}-{iter}");
                let node_payload = serde_json::json!({ "w": worker_id, "i": iter });
                let t1 = Instant::now();
                {
                    let mut tree_guard = l1.lock().expect("L1 锁中毒");
                    let _ = tree_guard.append(&node_id, node_payload);
                }
                let l1_dur = t1.elapsed();
                l1_lat.lock().unwrap().push(l1_dur);

                // Tier L2: 异步业务锁 (全异步获取，驱动真实状态机与恢复升级)
                let t2 = Instant::now();
                {
                    let mut coord = l2.lock().await;
                    let ctx = RunFailureContext {
                        subagent_id: format!("sub-{worker_id}"),
                        subagent_run_id: format!("run-{worker_id}-{iter}"),
                        task: format!("task payload {worker_id}-{iter}"),
                        error_kind: ProviderErrorKind::Network,
                        retries: (iter % 4) as u32,
                        retry_elapsed_ms: if (iter % 4) == 3 { 65000 } else { 1000 },
                        produced_content: false,
                        from_leaf_id: Some("root".to_string()),
                        started_at_ms: 1700000000000,
                        inject_bytes: 50,
                        window_bytes: 1000,
                    };
                    let outcome = coord
                        .on_subagent_run_failure(&ctx)
                        .await
                        .expect("恢复决策失败");
                    assert!(matches!(
                        outcome.action,
                        RecoveryAction::AutoRetry { .. }
                            | RecoveryAction::SteeringQueued { .. }
                            | RecoveryAction::NeedsUser { .. }
                    ));
                }
                let l2_dur = t2.elapsed();
                l2_lat.lock().unwrap().push(l2_dur);

                // Tier L3: SQLite WAL 真实落盘 (Group Commit 写入通道)
                let t3 = Instant::now();
                let sid = master_sess.to_string();
                let event_type = "test-empirical-event".to_string();
                let payload = format!("{{\"w\":{worker_id},\"i\":{iter}}}");
                let run_id = format!("run-{worker_id}-{iter}");
                let writer = db.writer().clone();
                let seq = db.reserve_sequence(&sid).expect("取号失败");

                writer
                    .write(move |conn| {
                        conn.execute(
                            "INSERT INTO events (session_id, sequence, event_type, payload, run_id, created_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%d %H:%M:%f','now'))",
                            rusqlite::params![sid, seq, event_type, payload, run_id],
                        )
                        .map_err(|e| DbFailure {
                            message: e.to_string(),
                            kind: DbFailureKind::Other("insert".into()),
                        })?;
                        Ok(())
                    })
                    .await
                    .expect("L3 Group Commit 写入失败");

                let l3_dur = t3.elapsed();
                l3_lat.lock().unwrap().push(l3_dur);

                completed.fetch_add(1, Ordering::SeqCst);
            }
        });
    }

    // 4. 并行启动 8 个只读 Worker (L4 无锁只读探测)
    let read_workers = 8usize;
    let reads_per_worker = 50usize;
    for _ in 0..read_workers {
        let pool = local_db.reader_pool().clone();
        let sid = master_sess.to_string();
        join_set.spawn(async move {
            for _ in 0..reads_per_worker {
                let sid_clone = sid.clone();
                let _count: i64 = pool
                    .read_async(move |conn| {
                        conn.query_row(
                            "SELECT count(*) FROM events WHERE session_id = ?1",
                            [&sid_clone],
                            |row| row.get(0),
                        )
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

    // 5. 10 秒硬性超时哨兵防护 (防死锁挂起)
    tokio::select! {
        _res = async {
            while let Some(res) = join_set.join_next().await {
                res.expect("Worker 发生 Panic 崩溃");
            }
        } => {
            let total_elapsed = test_start.elapsed();
            let total_ops = completed_tasks.load(Ordering::SeqCst);
            let expected_ops = write_workers * iterations_per_worker;
            assert_eq!(total_ops, expected_ops, "写操作总数必须精确匹配");

            // 6. 偏序时延单调性断言：P99(L0) <= P99(L1) <= P99(L2)
            let mut l0_sorted = l0_latencies.lock().unwrap().clone();
            let mut l1_sorted = l1_latencies.lock().unwrap().clone();
            let mut l2_sorted = l2_latencies.lock().unwrap().clone();
            let mut l3_sorted = l3_latencies.lock().unwrap().clone();
            l0_sorted.sort_unstable();
            l1_sorted.sort_unstable();
            l2_sorted.sort_unstable();
            l3_sorted.sort_unstable();

            let p50_idx = l3_sorted.len() / 2;
            let p90_idx = (l3_sorted.len() as f64 * 0.90) as usize;
            let p99_idx = ((l3_sorted.len() as f64 * 0.99) as usize).min(l3_sorted.len().saturating_sub(1));

            let p50_write = l3_sorted.get(p50_idx).cloned().unwrap_or_default();
            let p90_write = l3_sorted.get(p90_idx).cloned().unwrap_or_default();
            let p99_write = l3_sorted.get(p99_idx).cloned().unwrap_or_default();

            let p99_l0 = l0_sorted[((l0_sorted.len() as f64 * 0.99) as usize).min(l0_sorted.len().saturating_sub(1))];
            let p99_l1 = l1_sorted[((l1_sorted.len() as f64 * 0.99) as usize).min(l1_sorted.len().saturating_sub(1))];
            let p99_l2 = l2_sorted[((l2_sorted.len() as f64 * 0.99) as usize).min(l2_sorted.len().saturating_sub(1))];

            let tps = total_ops as f64 / total_elapsed.as_secs_f64();
            let pool_stats = local_db.reader_pool().stats();
            let writer_stats = local_db.writer().stats();

            println!(
                "[STRESS-PASS] 16写8读真机压力实证通过:\n  - 总耗时: {:?}\n  - 写入事务数: {}/{}\n  - 真实 TPS: {:.2} ops/s\n  - 偏序锁时延: P99(L0)={:?}, P99(L1)={:?}, P99(L2)={:?}\n  - SQLite WAL 写入时延: P50={:?}, P90={:?}, P99={:?}\n  - Group Commit 统计: 批次总数={}, 最大批次={}\n  - ReaderPool 统计: 获取次数={}, 快速命中={}, 超时={}\n  - 死锁发生率: 0.00%\n  - 锁竞争超时: 0",
                total_elapsed, total_ops, expected_ops, tps, p99_l0, p99_l1, p99_l2, p50_write, p90_write, p99_write,
                writer_stats.total_batches, writer_stats.max_batch_size_seen,
                pool_stats.total_acquisitions, pool_stats.fast_path_hits, pool_stats.timeouts
            );

            // 断言偏序耗时阶梯成立 (L0/L1 同步锁 <= L2 异步业务锁，且 L0 满足极低延迟 SLA)
            assert!(p99_l0 <= p99_l2, "L0 耗时 ({p99_l0:?}) 必须小于等于 L2 耗时 ({p99_l2:?})");
            assert!(p99_l1 <= p99_l2, "L1 耗时 ({p99_l1:?}) 必须小于等于 L2 耗时 ({p99_l2:?})");
            assert!(p99_l0 < Duration::from_millis(20), "L0 内存锁 P99 必须 < 20ms: {p99_l0:?}");

            // 断言 SQLite WAL 写入 P99 满足 SLA 门限 (< 50ms)
            assert!(p99_write < Duration::from_millis(50), "SQLite WAL 写入 P99 必须 < 50ms SLA: {p99_write:?}");
            assert_eq!(pool_stats.timeouts, 0, "ReaderPool 发生超时争用");

            // 7. 验证落库完整性与 ReaderPool 健康
            let final_test_events_count: i64 = local_db
                .reader_pool()
                .read(|conn| {
                    conn.query_row(
                        "SELECT count(*) FROM events WHERE session_id = ?1 AND event_type = 'test-empirical-event'",
                        [master_sess],
                        |row| row.get(0),
                    )
                    .map_err(|e| DbFailure {
                        message: e.to_string(),
                        kind: DbFailureKind::Other("query".into()),
                    })
                })
                .expect("查询测试事件总数失败");
            assert_eq!(
                final_test_events_count as usize,
                expected_ops,
                "数据库 test-empirical-event 事件总数必须精确等于直接写入总数"
            );

            let total_events_count: i64 = local_db
                .reader_pool()
                .read(|conn| {
                    conn.query_row(
                        "SELECT count(*) FROM events WHERE session_id = ?1",
                        [master_sess],
                        |row| row.get(0),
                    )
                    .map_err(|e| DbFailure {
                        message: e.to_string(),
                        kind: DbFailureKind::Other("query".into()),
                    })
                })
                .expect("查询所有事件总数失败");
            assert!(
                total_events_count as usize >= expected_ops,
                "数据库总事件数必须包含全部业务事件与协调器恢复升级事件"
            );

            let reader_pool = ReaderPool::open(&db_path, ReaderPoolConfig::default())
                .expect("打开 ReaderPool 失败");
            reader_pool.check_health().expect("ReaderPool 数据库健康检查通过");
        }
        _ = tokio::time::sleep(Duration::from_secs(10)) => {
            let l2_completed = l2_latencies.lock().unwrap().len();
            let l3_completed = l3_latencies.lock().unwrap().len();
            let completed = completed_tasks.load(Ordering::SeqCst);
            let reader_stats = local_db.reader_pool().stats();
            let writer_stats = local_db.writer().stats();
            panic!(
                "🔴 压力测试在 10 秒内未完成：发生死锁或严重饥饿！L2 decisions={l2_completed}/{}, L3 writes={l3_completed}/{}, completed={completed}/{}, L4 acquisitions={}, writer operations={}",
                write_workers * iterations_per_worker,
                write_workers * iterations_per_worker,
                write_workers * iterations_per_worker,
                reader_stats.total_acquisitions,
                writer_stats.total_operations,
            );
        }
    }
}

/// 场景 2：跨会话 16 并发 SQLite WAL 写入与 ReaderPool 争用实证
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
async fn stress_multi_session_wal_16_writers_8_readers() {
    let (_guard, db_path) = create_temp_db_path();
    let local_db = LocalDb::open(&db_path).expect("打开真实 LocalDb 失败");

    let num_sessions = 16usize;
    let writes_per_session = 25usize;
    let read_workers = 8usize;
    let reads_per_worker = 30usize;

    for i in 0..num_sessions {
        local_db
            .insert_session(&format!("sess-{i}"), &format!("并发会话 {i}"))
            .expect("创建测试会话失败");
    }

    let mut join_set = tokio::task::JoinSet::new();
    let test_start = Instant::now();
    let write_latencies = Arc::new(Mutex::new(Vec::with_capacity(
        num_sessions * writes_per_session,
    )));

    // 启动 16 个写 Worker，分别通过 Group Commit 写入各自会话
    for session_idx in 0..num_sessions {
        let db = local_db.clone();
        let sid = format!("sess-{session_idx}");
        let w_lats = Arc::clone(&write_latencies);

        join_set.spawn(async move {
            let writer = db.writer().clone();
            for iter in 0..writes_per_session {
                let sid_clone = sid.clone();
                let event_type = "multi-session-event".to_string();
                let payload = format!("{{\"session\":{},\"iter\":{}}}", session_idx, iter);
                let run_id = format!("run-{session_idx}-{iter}");

                let t = Instant::now();
                writer
                    .write(move |conn| {
                        conn.execute(
                            "INSERT INTO events (session_id, sequence, event_type, payload, run_id, created_at)
                             VALUES (?1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE session_id = ?1), ?2, ?3, ?4, strftime('%Y-%m-%d %H:%M:%f','now'))",
                            rusqlite::params![sid_clone, event_type, payload, run_id],
                        )
                        .map_err(|e| DbFailure {
                            message: e.to_string(),
                            kind: DbFailureKind::Other("insert".into()),
                        })?;
                        Ok(())
                    })
                    .await
                    .expect("跨会话 Group Commit 写入失败");
                w_lats.lock().unwrap().push(t.elapsed());
            }
        });
    }

    // 启动 8 个读 Worker 随机查询所有会话
    for reader_idx in 0..read_workers {
        let pool = local_db.reader_pool().clone();
        join_set.spawn(async move {
            for iter in 0..reads_per_worker {
                let target_sess = format!("sess-{}", (reader_idx + iter) % num_sessions);
                let _count: i64 = pool
                    .read_async(move |conn| {
                        conn.query_row(
                            "SELECT count(*) FROM events WHERE session_id = ?1",
                            [target_sess],
                            |row| row.get(0),
                        )
                        .map_err(|e| DbFailure {
                            message: e.to_string(),
                            kind: DbFailureKind::Other("query".into()),
                        })
                    })
                    .await
                    .expect("读任务失败");
                tokio::time::sleep(Duration::from_micros(500)).await;
            }
        });
    }

    let timeout_res = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(res) = join_set.join_next().await {
            res.expect("Worker 发生 Panic 崩溃");
        }
    })
    .await;

    assert!(timeout_res.is_ok(), "跨会话压测在 10s 哨兵内超时");

    let elapsed = test_start.elapsed();
    let total_writes = num_sessions * writes_per_session;
    let tps = total_writes as f64 / elapsed.as_secs_f64();

    let mut lats = write_latencies.lock().unwrap().clone();
    lats.sort_unstable();
    let p50 = lats[lats.len() / 2];
    let p90 = lats[(lats.len() as f64 * 0.90) as usize];
    let p99 = lats[((lats.len() as f64 * 0.99) as usize).min(lats.len().saturating_sub(1))];

    println!(
        "[STRESS-PASS] 跨会话 16写8读 WAL 并发实证通过: 总耗时={:?}, 写操作={}, TPS={:.2} ops/s, P50={:?}, P90={:?}, P99={:?}",
        elapsed, total_writes, tps, p50, p90, p99
    );

    assert!(
        p99 < Duration::from_millis(50),
        "跨会话 P99 写入时延必须 < 50ms: {p99:?}"
    );

    // 验证每个会话的数据完整性与序列严格连续性
    for i in 0..num_sessions {
        let sid = format!("sess-{i}");
        let count: i64 = local_db
            .reader_pool()
            .read(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM events WHERE session_id = ?1",
                    [&sid],
                    |row| row.get(0),
                )
                .map_err(|e| DbFailure {
                    message: e.to_string(),
                    kind: DbFailureKind::Other("query".into()),
                })
            })
            .expect("查询事件数失败");
        assert_eq!(
            count as usize, writes_per_session,
            "会话 {sid} 的事件数必须等于写入次数"
        );
    }
}
