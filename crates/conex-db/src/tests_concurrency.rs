//! 并发、组提交与只读连接池测试矩阵 (tests_concurrency).
//!
//! 验证：
//! 1. Group Commit 5ms/50-item 管道批量聚合与 SAVEPOINT 故障隔离；
//! 2. ReaderPool 基于 try_lock 的自适应非阻塞探测与 WAL 并发读；
//! 3. 16 并发 Worker 混合读写 0 死锁压力测试。

use crate::error::{DbFailure, DbFailureKind};
use crate::group_commit::{DbWriteHandle, GroupCommitConfig};
use crate::reader_pool::{ReaderPool, ReaderPoolConfig};
use rusqlite::Connection;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn create_in_memory_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db failed");
    conn.execute_batch(
        "CREATE TABLE test_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            payload TEXT NOT NULL
        );",
    )
    .expect("create test_events table failed");
    conn
}

struct TempDbGuard {
    path: std::path::PathBuf,
}

impl Drop for TempDbGuard {
    fn drop(&mut self) {
        crate::tests::cleanup_temp_path(&self.path);
        crate::tests::cleanup_temp_path(format!("{}-wal", self.path.display()));
        crate::tests::cleanup_temp_path(format!("{}-shm", self.path.display()));
    }
}

static TEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn create_temp_file_db() -> (TempDbGuard, std::path::PathBuf) {
    let id = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "conex_test_wal_{}_{}_{}.db",
        std::process::id(),
        now,
        id
    ));
    let conn = Connection::open(&path).expect("open temp file db failed");
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE test_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            payload TEXT NOT NULL
        );",
    )
    .expect("init WAL db failed");
    let guard = TempDbGuard { path: path.clone() };
    (guard, path)
}

#[tokio::test]
async fn test_group_commit_basic_write() {
    let conn = create_in_memory_db();
    let handle = DbWriteHandle::spawn(conn, GroupCommitConfig::default())
        .expect("writer actor should start");

    let res: i64 = handle
        .write(|c| {
            c.execute(
                "INSERT INTO test_events (session_id, seq, payload) VALUES ('s1', 1, 'p1');",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("insert".into()),
            })?;
            Ok(c.last_insert_rowid())
        })
        .await
        .expect("write failed");

    assert_eq!(res, 1);
    assert_eq!(handle.stats().total_operations, 1);
    assert_eq!(handle.stats().total_batches, 1);
}

#[tokio::test]
async fn test_group_commit_high_concurrency_batching() {
    let conn = create_in_memory_db();
    let config = GroupCommitConfig {
        batch_timeout: Duration::from_millis(10),
        max_batch_size: 50,
        channel_capacity: 1024,
    };
    let handle = DbWriteHandle::spawn(conn, config).expect("writer actor should start");

    let total_tasks = 100;
    let mut join_set = tokio::task::JoinSet::new();

    for i in 0..total_tasks {
        let h = handle.clone();
        join_set.spawn(async move {
            h.write(move |c| {
                c.execute(
                    "INSERT INTO test_events (session_id, seq, payload) VALUES (?1, ?2, ?3);",
                    rusqlite::params![format!("s-{}", i), i as i64, format!("data-{}", i)],
                )
                .map_err(|e| DbFailure {
                    message: e.to_string(),
                    kind: DbFailureKind::Other("insert".into()),
                })?;
                Ok(i)
            })
            .await
        });
    }

    let mut successful = 0;
    while let Some(res) = join_set.join_next().await {
        let val = res.expect("join failed").expect("write task failed");
        assert!(val < total_tasks);
        successful += 1;
    }

    assert_eq!(successful, total_tasks);
    let stats = handle.stats();
    assert_eq!(stats.total_operations, total_tasks as u64);
    // 100 个并发任务在 10ms 窗口下必须被聚合为远少于 100 次事务
    assert!(
        stats.total_batches < total_tasks as u64,
        "Group commit failed to batch! total_batches = {}",
        stats.total_batches
    );
    assert!(
        stats.max_batch_size_seen > 1,
        "Group commit max_batch_size_seen should be > 1"
    );
}

#[tokio::test]
async fn test_group_commit_timeout_flush() {
    let conn = create_in_memory_db();
    let config = GroupCommitConfig {
        batch_timeout: Duration::from_millis(5),
        max_batch_size: 50,
        channel_capacity: 1024,
    };
    let handle = DbWriteHandle::spawn(conn, config).expect("writer actor should start");

    let start = std::time::Instant::now();
    let res = handle
        .write(|c| {
            c.execute(
                "INSERT INTO test_events (session_id, seq, payload) VALUES ('single', 1, 'x');",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("insert".into()),
            })
        })
        .await;

    assert!(res.is_ok());
    assert!(start.elapsed() < Duration::from_millis(200));
}

#[tokio::test]
async fn test_group_commit_error_isolation_savepoint() {
    let conn = create_in_memory_db();
    let config = GroupCommitConfig {
        batch_timeout: Duration::from_millis(20),
        max_batch_size: 10,
        channel_capacity: 64,
    };
    let handle = DbWriteHandle::spawn(conn, config).expect("writer actor should start");

    // 提交 3 个请求：前两个正确，中间一个故意触发 SQL 语法错误，第四个正确
    let h1 = handle.clone();
    let h2 = handle.clone();
    let h3 = handle.clone();

    let f1 = tokio::spawn(async move {
        h1.write(|c| {
            c.execute(
                "INSERT INTO test_events (session_id, seq, payload) VALUES ('ok1', 1, 'd1');",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("insert".into()),
            })
        })
        .await
    });

    let f2 = tokio::spawn(async move {
        h2.write(|c| {
            c.execute("INVALID SQL SYNTAX STATEMENT HERE;", [])
                .map_err(|e| DbFailure {
                    message: e.to_string(),
                    kind: DbFailureKind::Other("syntax_error".into()),
                })
        })
        .await
    });

    let f3 = tokio::spawn(async move {
        h3.write(|c| {
            c.execute(
                "INSERT INTO test_events (session_id, seq, payload) VALUES ('ok2', 2, 'd2');",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("insert".into()),
            })
        })
        .await
    });

    let r1 = f1.await.unwrap();
    let r2 = f2.await.unwrap();
    let r3 = f3.await.unwrap();

    assert!(r1.is_ok(), "task 1 must succeed");
    assert!(r2.is_err(), "task 2 must fail with syntax error");
    assert!(r3.is_ok(), "task 3 must succeed despite task 2 failure");

    let count: i64 = handle
        .write(|c| {
            c.query_row("SELECT count(*) FROM test_events;", [], |row| row.get(0))
                .map_err(|e| DbFailure {
                    message: e.to_string(),
                    kind: DbFailureKind::Other("count".into()),
                })
        })
        .await
        .unwrap();

    assert_eq!(count, 2, "2 successful rows must be committed");
}

#[tokio::test]
async fn test_group_commit_dedicated_os_thread() {
    let conn = create_in_memory_db();
    let handle = DbWriteHandle::spawn_dedicated_thread(
        conn,
        GroupCommitConfig::default(),
        Some("test-dedicated-writer"),
    )
    .expect("dedicated-thread writer actor should start");

    let res = handle
        .execute(
            "INSERT INTO test_events (session_id, seq, payload) VALUES (?1, ?2, ?3);",
            ("s_thread", 42i64, "payload_thread"),
        )
        .await;

    assert!(res.is_ok());
    assert_eq!(res.unwrap(), 1);
}

#[test]
fn test_reader_pool_basic_and_try_lock() {
    let (_dir, path) = create_temp_file_db();
    let pool = ReaderPool::open(&path, ReaderPoolConfig::default()).expect("open pool failed");

    assert_eq!(pool.len(), 8);
    let res = pool
        .read(|c| {
            c.query_row("SELECT count(*) FROM test_events;", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("query".into()),
            })
        })
        .expect("read failed");

    assert_eq!(res, 0);

    let stats = pool.stats();
    assert_eq!(stats.total_acquisitions, 1);
    assert_eq!(stats.fast_path_hits, 1);
    assert_eq!(stats.probe_retries, 0);
    assert_eq!(stats.timeouts, 0);
}

#[test]
fn test_reader_pool_read_only_enforcement() {
    let (_dir, path) = create_temp_file_db();
    let pool = ReaderPool::open(&path, ReaderPoolConfig::default()).expect("open pool failed");

    let err = pool.read(|c| {
        c.execute(
            "INSERT INTO test_events (session_id, seq, payload) VALUES ('bad', 0, 'bad');",
            [],
        )
        .map_err(|e| DbFailure {
            message: e.to_string(),
            kind: DbFailureKind::Other("insert".into()),
        })
    });

    assert!(
        err.is_err(),
        "Writer operation on ReaderPool must be rejected"
    );
}

#[test]
fn test_reader_pool_multi_thread_concurrent_reads() {
    let (_dir, path) = create_temp_file_db();
    let pool = ReaderPool::open(
        &path,
        ReaderPoolConfig {
            pool_size: 8,
            ..Default::default()
        },
    )
    .expect("open pool failed");

    let total_threads = 16;
    let ops_per_thread = 50;
    let completed = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();

    for _ in 0..total_threads {
        let p = pool.clone();
        let c = Arc::clone(&completed);
        handles.push(std::thread::spawn(move || {
            for _ in 0..ops_per_thread {
                let count: i64 = p
                    .read(|conn| {
                        conn.query_row("SELECT count(*) FROM test_events;", [], |row| row.get(0))
                            .map_err(|e| DbFailure {
                                message: e.to_string(),
                                kind: DbFailureKind::Other("query".into()),
                            })
                    })
                    .expect("read in thread failed");
                assert_eq!(count, 0);
                c.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    for h in handles {
        h.join().expect("thread panicked");
    }

    assert_eq!(
        completed.load(Ordering::Relaxed),
        total_threads * ops_per_thread
    );
    let stats = pool.stats();
    assert_eq!(
        stats.total_acquisitions,
        (total_threads * ops_per_thread) as u64
    );
    assert_eq!(stats.timeouts, 0);
}

#[tokio::test]
async fn test_reader_pool_async_read() {
    let (_dir, path) = create_temp_file_db();
    let pool = ReaderPool::open(&path, ReaderPoolConfig::default()).expect("open pool failed");

    let res = pool
        .read_async(|c| {
            c.query_row("SELECT 1 + 1;", [], |row| row.get::<_, i64>(0))
                .map_err(|e| DbFailure {
                    message: e.to_string(),
                    kind: DbFailureKind::Other("query".into()),
                })
        })
        .await
        .expect("read_async failed");

    assert_eq!(res, 2);
}

#[tokio::test]
async fn test_high_concurrency_reader_writer_wal_stress() {
    let (_dir, path) = create_temp_file_db();

    // 1. 初始化 Writer Actor
    let write_conn = Connection::open(&path).expect("open writer failed");
    write_conn
        .execute_batch("PRAGMA journal_mode = WAL;")
        .unwrap();
    let writer = DbWriteHandle::spawn(
        write_conn,
        GroupCommitConfig {
            batch_timeout: Duration::from_millis(5),
            max_batch_size: 50,
            channel_capacity: 1024,
        },
    )
    .expect("writer actor should start on the temp file db");

    // 2. 初始化 ReaderPool
    let pool = ReaderPool::open(
        &path,
        ReaderPoolConfig {
            pool_size: 8,
            max_wait_timeout: Duration::from_secs(5),
            ..Default::default()
        },
    )
    .expect("open reader pool failed");

    let total_writers = 8;
    let total_readers = 8;
    let writes_per_actor = 25;
    let reads_per_actor = 50;

    let mut join_set = tokio::task::JoinSet::new();

    // 启动写任务
    for w in 0..total_writers {
        let w_handle = writer.clone();
        join_set.spawn(async move {
            for i in 0..writes_per_actor {
                let session_id = format!("sess_{w}_{i}");
                let seq = i as i64;
                w_handle
                    .write(move |conn| {
                        conn.execute(
                            "INSERT INTO test_events (session_id, seq, payload) VALUES (?1, ?2, ?3);",
                            rusqlite::params![session_id, seq, "payload_data"],
                        )
                        .map_err(|e| DbFailure {
                            message: e.to_string(),
                            kind: DbFailureKind::Other("insert".into()),
                        })?;
                        Ok(())
                    })
                    .await
                    .expect("writer stress write failed");
            }
        });
    }

    // 启动读任务（并发查询 WAL）
    for _r in 0..total_readers {
        let r_pool = pool.clone();
        join_set.spawn(async move {
            for _ in 0..reads_per_actor {
                let _count: i64 = r_pool
                    .read_async(|conn| {
                        conn.query_row("SELECT count(*) FROM test_events;", [], |row| row.get(0))
                            .map_err(|e| DbFailure {
                                message: e.to_string(),
                                kind: DbFailureKind::Other("query".into()),
                            })
                    })
                    .await
                    .expect("reader stress read failed");
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        });
    }

    // 10 秒硬超时判定死锁
    let timeout_res = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(res) = join_set.join_next().await {
            res.expect("task join failed");
        }
    })
    .await;

    assert!(
        timeout_res.is_ok(),
        "WAL 混合读写高并发压力测试发生死锁或超时！"
    );

    // 最终断言：所有写入均落库
    let final_count: i64 = pool
        .read(|c| {
            c.query_row("SELECT count(*) FROM test_events;", [], |row| row.get(0))
                .map_err(|e| DbFailure {
                    message: e.to_string(),
                    kind: DbFailureKind::Other("count".into()),
                })
        })
        .expect("final count failed");

    assert_eq!(
        final_count,
        (total_writers * writes_per_actor) as i64,
        "All writes must be successfully committed to WAL"
    );
}

#[tokio::test]
async fn test_group_commit_panic_isolation_and_recovery() {
    let conn = create_in_memory_db();
    let config = GroupCommitConfig {
        batch_timeout: Duration::from_millis(5),
        max_batch_size: 50,
        channel_capacity: 1024,
    };
    let handle = DbWriteHandle::spawn(conn, config).expect("writer actor should start");

    // 1. 发起一个会 panic 的任务
    let panic_res = handle
        .write(|_c| {
            panic!("simulated crash inside write closure");
            #[allow(unreachable_code)]
            Ok::<(), DbFailure>(())
        })
        .await;

    assert!(panic_res.is_err(), "Panicking task must return error");
    let err = panic_res.unwrap_err();
    assert_eq!(
        err.kind,
        DbFailureKind::Other("write_closure_panic".to_string())
    );
    assert!(err.message.contains("simulated crash inside write closure"));

    // 2. 验证 Actor 依然存活，紧随其后的后续写操作 100% 成功
    let success_res: i64 = handle
        .write(|c| {
            c.execute(
                "INSERT INTO test_events (session_id, seq, payload) VALUES ('after_panic', 100, 'alive');",
                [],
            )
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("insert".into()),
            })?;
            Ok(c.last_insert_rowid())
        })
        .await
        .expect("write after panic must succeed");

    assert_eq!(success_res, 1);
    assert!(
        !handle.is_closed(),
        "Actor channel must remain open and alive"
    );
}
