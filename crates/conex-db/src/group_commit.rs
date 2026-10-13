//! SQLite Single Writer Actor 与 5ms/50-item 组提交管道 (Group Commit).
//!
//! 在高并发多 Agent / 多任务场景下，频繁的短事务写入会导致激烈的锁竞争与大量的磁盘 fsync。
//! 本模块实现 Single Writer Actor 模型：
//! 1. 所有写操作通过 `tokio::sync::mpsc` 发送至独占的写入者处理循环；
//! 2. 写入者在收到首个任务后，在 5ms 窗口内至多聚合 50 个写入请求作为一个批次；
//! 3. 批次使用单一 `BEGIN IMMEDIATE ... COMMIT` 事务包裹，内部通过 `SAVEPOINT` 隔离单项错误；
//! 4. 将高频单条提交的 I/O 放大降低一个数量级，同时消除多线程写锁争用与死锁风险。

use crate::error::{DbFailure, DbFailureKind};
use std::any::Any;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// 默认组提交窗口等待时长（5ms）
pub const DEFAULT_GROUP_COMMIT_TIMEOUT_MS: u64 = 5;
/// 默认最大批次容量（50 条）
pub const DEFAULT_GROUP_COMMIT_MAX_BATCH: usize = 50;
/// 默认写请求通道容量（1024 条）
pub const DEFAULT_GROUP_COMMIT_CHANNEL_CAPACITY: usize = 1024;

/// 组提交管道配置
#[derive(Debug, Clone)]
pub struct GroupCommitConfig {
    /// 批次聚合等待超时（默认 5ms）
    pub batch_timeout: Duration,
    /// 单事务最大聚合条数（默认 50）
    pub max_batch_size: usize,
    /// 写入通道缓冲区深度（默认 1024）
    pub channel_capacity: usize,
}

impl Default for GroupCommitConfig {
    fn default() -> Self {
        Self {
            batch_timeout: Duration::from_millis(DEFAULT_GROUP_COMMIT_TIMEOUT_MS),
            max_batch_size: DEFAULT_GROUP_COMMIT_MAX_BATCH,
            channel_capacity: DEFAULT_GROUP_COMMIT_CHANNEL_CAPACITY,
        }
    }
}

/// 组提交运行期统计指标快照
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroupCommitStats {
    /// 累计处理的写操作总数
    pub total_operations: u64,
    /// 累计提交的批次总数
    pub total_batches: u64,
    /// 历史观察到的最大单批聚合量
    pub max_batch_size_seen: usize,
    /// 单项或批次级执行失败总数
    pub total_errors: u64,
}

#[derive(Default)]
struct StatsInner {
    total_operations: AtomicU64,
    total_batches: AtomicU64,
    max_batch_size_seen: AtomicUsize,
    total_errors: AtomicU64,
}

impl StatsInner {
    fn record_batch(&self, batch_size: usize) {
        self.total_operations
            .fetch_add(batch_size as u64, Ordering::Relaxed);
        self.total_batches.fetch_add(1, Ordering::Relaxed);
        self.max_batch_size_seen
            .fetch_max(batch_size, Ordering::Relaxed);
    }

    fn record_error(&self) {
        self.total_errors.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self) -> GroupCommitStats {
        GroupCommitStats {
            total_operations: self.total_operations.load(Ordering::Relaxed),
            total_batches: self.total_batches.load(Ordering::Relaxed),
            max_batch_size_seen: self.max_batch_size_seen.load(Ordering::Relaxed),
            total_errors: self.total_errors.load(Ordering::Relaxed),
        }
    }
}

type AnySendResult = Result<Box<dyn Any + Send>, DbFailure>;
type BoxedWriteFn = Box<dyn FnOnce(&mut rusqlite::Connection) -> AnySendResult + Send>;

struct WriteTask {
    op: BoxedWriteFn,
    respond_to: oneshot::Sender<AnySendResult>,
}

/// SQLite 专用单写句柄 (Single Writer Handle)
///
/// 具备轻量 Clone 能力，可安全跨线程 / 异步任务分发。
#[derive(Clone)]
pub struct DbWriteHandle {
    sender: mpsc::Sender<WriteTask>,
    stats: Arc<StatsInner>,
}

impl DbWriteHandle {
    /// 创建并启动组提交 Single Writer Actor。
    ///
    /// 接收一个专有的 SQLite 写连接所有权，并在**独立 OS 线程**中循环批处理
    /// （禁止挂在调用方 tokio runtime 上：否则 async 上下文 `write_blocking`
    /// 与 actor 同 runtime 会在 current_thread 下死锁/panic）。
    pub fn spawn(conn: rusqlite::Connection, config: GroupCommitConfig) -> Self {
        Self::spawn_dedicated_thread(conn, config, None)
    }

    /// 在专有的独立 OS 线程中启动 Single Writer Actor（隔绝通用异步运行时抖动）。
    pub fn spawn_dedicated_thread(
        conn: rusqlite::Connection,
        config: GroupCommitConfig,
        thread_name: Option<&str>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(config.channel_capacity);
        let stats = Arc::new(StatsInner::default());
        let stats_clone = Arc::clone(&stats);
        let name = thread_name.unwrap_or("conex-sqlite-writer").to_string();

        std::thread::Builder::new()
            .name(name)
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("failed to create dedicated runtime for DbWriteActor");
                rt.block_on(run_actor_loop(conn, receiver, config, stats_clone));
            })
            .expect("failed to spawn dedicated OS thread for DbWriteActor");

        Self { sender, stats }
    }

    /// 异步提交写操作闭包并等待批提交结果。
    pub async fn write<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&mut rusqlite::Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let task = WriteTask {
            op: Box::new(move |conn| f(conn).map(|r| Box::new(r) as Box<dyn Any + Send>)),
            respond_to: tx,
        };

        self.sender.send(task).await.map_err(|_| DbFailure {
            message: "Single writer actor channel is closed".to_string(),
            kind: DbFailureKind::Other("writer_closed".to_string()),
        })?;

        let res = rx.await.map_err(|_| DbFailure {
            message: "Single writer actor dropped response channel".to_string(),
            kind: DbFailureKind::Other("channel_dropped".to_string()),
        })??;

        match res.downcast::<R>() {
            Ok(val) => Ok(*val),
            Err(_) => Err(DbFailure {
                message: "Internal error: downcast write result failed".to_string(),
                kind: DbFailureKind::Other("downcast_failed".to_string()),
            }),
        }
    }

    /// 快捷辅助函数：在写连接上执行单条 SQL 语句。
    pub async fn execute<P>(&self, sql: &'static str, params: P) -> Result<usize, DbFailure>
    where
        P: rusqlite::Params + Clone + Send + 'static,
    {
        self.write(move |conn| {
            conn.execute(sql, params).map_err(|e| DbFailure {
                message: format!("execute failed: {e}"),
                kind: DbFailureKind::Other(e.to_string()),
            })
        })
        .await
    }

    /// 阻塞写桥：同步外观提交写闭包至组提交 Actor 并等待批提交结果。
    ///
    /// - 非 async：直接 `blocking_send` + `blocking_recv`。
    /// - multi_thread runtime：在 Tokio blocking region 内直接执行，交还当前
    ///   worker core，避免每次写入创建并 join 一个 OS 线程。
    /// - current_thread runtime：继续把 submit+wait 移到临时 OS 线程，避免
    ///   `blocking_send` panic，并允许独立 writer actor 正常处理请求。
    pub fn write_blocking<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&mut rusqlite::Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            if runtime.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread {
                return tokio::task::block_in_place(|| self.write_blocking_inner(f));
            }

            let handle = self.clone();
            return std::thread::spawn(move || handle.write_blocking_inner(f))
                .join()
                .map_err(|_| DbFailure {
                    message: "write_blocking offload thread panicked".to_string(),
                    kind: DbFailureKind::Other("writer_join_failed".to_string()),
                })?;
        }
        self.write_blocking_inner(f)
    }

    fn write_blocking_inner<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&mut rusqlite::Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        let task = WriteTask {
            op: Box::new(move |conn| f(conn).map(|r| Box::new(r) as Box<dyn Any + Send>)),
            respond_to: tx,
        };

        self.sender.blocking_send(task).map_err(|_| DbFailure {
            message: "Single writer actor channel is closed".to_string(),
            kind: DbFailureKind::Other("writer_closed".to_string()),
        })?;

        let res = rx.blocking_recv().map_err(|_| DbFailure {
            message: "Single writer actor dropped response channel".to_string(),
            kind: DbFailureKind::Other("channel_dropped".to_string()),
        })??;

        match res.downcast::<R>() {
            Ok(val) => Ok(*val),
            Err(_) => Err(DbFailure {
                message: "Internal error: downcast write result failed".to_string(),
                kind: DbFailureKind::Other("downcast_failed".to_string()),
            }),
        }
    }

    /// 获取当前统计指标快照。
    pub fn stats(&self) -> GroupCommitStats {
        self.stats.snapshot()
    }

    /// 检查写通道是否已关闭。
    pub fn is_closed(&self) -> bool {
        self.sender.is_closed()
    }
}

async fn run_actor_loop(
    mut conn: rusqlite::Connection,
    mut receiver: mpsc::Receiver<WriteTask>,
    config: GroupCommitConfig,
    stats: Arc<StatsInner>,
) {
    let mut batch = Vec::with_capacity(config.max_batch_size);

    loop {
        let first_task = match receiver.recv().await {
            Some(task) => task,
            None => break, // 通道关闭，正常退出
        };

        batch.push(first_task);

        // 5ms / 50-item 窗口聚合
        let deadline = tokio::time::Instant::now() + config.batch_timeout;
        while batch.len() < config.max_batch_size {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline - now;
            match tokio::time::timeout(remaining, receiver.recv()).await {
                Ok(Some(task)) => batch.push(task),
                Ok(None) => break,
                Err(_) => break, // 5ms 超时到达
            }
        }

        process_batch(&mut conn, &mut batch, &stats);
        batch.clear();
    }
}

use std::panic::{catch_unwind, AssertUnwindSafe};

fn process_batch(conn: &mut rusqlite::Connection, batch: &mut Vec<WriteTask>, stats: &StatsInner) {
    if batch.is_empty() {
        return;
    }
    let batch_len = batch.len();
    stats.record_batch(batch_len);

    if batch_len == 1 {
        // 单条快速路径（SEC-05 / SEC-06）：直接事务 BEGIN IMMEDIATE / COMMIT，免除内部单任务 SAVEPOINT / RELEASE 包装与解析开销
        let task = batch.remove(0);
        let res = match conn.execute_batch("BEGIN IMMEDIATE;") {
            Ok(()) => {
                let op = task.op;
                let panic_res = catch_unwind(AssertUnwindSafe(|| op(conn)));
                match panic_res {
                    Ok(Ok(val)) => match conn.execute_batch("COMMIT;") {
                        Ok(()) => Ok(val),
                        Err(e) => {
                            let _ = conn.execute_batch("ROLLBACK;");
                            Err(DbFailure {
                                message: format!("commit failed: {e}"),
                                kind: DbFailureKind::Other("commit_failed".to_string()),
                            })
                        }
                    },
                    Ok(Err(err)) => {
                        let _ = conn.execute_batch("ROLLBACK;");
                        Err(err)
                    }
                    Err(panic_payload) => {
                        let _ = conn.execute_batch("ROLLBACK;");
                        let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                            s.to_string()
                        } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                            s.clone()
                        } else {
                            "unknown panic inside write closure".to_string()
                        };
                        tracing::error!(target: "conex_db", "捕获写闭包内部 Panic (已安全隔离并回滚): {panic_msg}");
                        Err(DbFailure {
                            message: format!("panic in write closure: {panic_msg}"),
                            kind: DbFailureKind::Other("write_closure_panic".to_string()),
                        })
                    }
                }
            }
            Err(e) => Err(DbFailure {
                message: format!("begin immediate failed: {e}"),
                kind: DbFailureKind::Other("begin_failed".to_string()),
            }),
        };

        if res.is_err() {
            stats.record_error();
        }
        let _ = task.respond_to.send(res);
        return;
    }

    // 多条组提交路径：使用 SAVEPOINT 隔离每个任务，最外层统一 COMMIT
    if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE;") {
        let err = DbFailure {
            message: format!("group commit begin immediate failed: {e}"),
            kind: DbFailureKind::Other("begin_failed".to_string()),
        };
        stats.record_error();
        for task in batch.drain(..) {
            let _ = task.respond_to.send(Err(err.clone()));
        }
        return;
    }

    let mut pending_responses = Vec::with_capacity(batch_len);

    for (idx, task) in batch.drain(..).enumerate() {
        let sp_name = format!("gc_sp_{idx}");
        let sp_begin = format!("SAVEPOINT {sp_name};");
        let sp_release = format!("RELEASE {sp_name};");
        let sp_rollback = format!("ROLLBACK TO {sp_name};");

        if let Err(e) = conn.execute_batch(&sp_begin) {
            let err = DbFailure {
                message: format!("savepoint begin failed: {e}"),
                kind: DbFailureKind::Other("savepoint_failed".to_string()),
            };
            stats.record_error();
            pending_responses.push((task.respond_to, Err(err)));
            continue;
        }

        let op = task.op;
        let panic_res = catch_unwind(AssertUnwindSafe(|| op(conn)));
        match panic_res {
            Ok(Ok(val)) => {
                if let Err(e) = conn.execute_batch(&sp_release) {
                    let err = DbFailure {
                        message: format!("savepoint release failed: {e}"),
                        kind: DbFailureKind::Other("savepoint_release_failed".to_string()),
                    };
                    stats.record_error();
                    pending_responses.push((task.respond_to, Err(err)));
                } else {
                    pending_responses.push((task.respond_to, Ok(val)));
                }
            }
            Ok(Err(err)) => {
                stats.record_error();
                let _ = conn.execute_batch(&sp_rollback);
                let _ = conn.execute_batch(&sp_release);
                pending_responses.push((task.respond_to, Err(err)));
            }
            Err(panic_payload) => {
                stats.record_error();
                let _ = conn.execute_batch(&sp_rollback);
                let _ = conn.execute_batch(&sp_release);
                let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                    s.to_string()
                } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "unknown panic inside write closure".to_string()
                };
                tracing::error!(target: "conex_db", "捕获写闭包内部 Panic (已安全隔离并回滚): {panic_msg}");
                let err = DbFailure {
                    message: format!("panic in write closure: {panic_msg}"),
                    kind: DbFailureKind::Other("write_closure_panic".to_string()),
                };
                pending_responses.push((task.respond_to, Err(err)));
            }
        }
    }

    // 统一提交批次内所有成功项
    match conn.execute_batch("COMMIT;") {
        Ok(()) => {
            for (resp, res) in pending_responses {
                let _ = resp.send(res);
            }
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            stats.record_error();
            let err = DbFailure {
                message: format!("group commit batch COMMIT failed: {e}"),
                kind: DbFailureKind::Other("batch_commit_failed".to_string()),
            };
            for (resp, _) in pending_responses {
                let _ = resp.send(Err(err.clone()));
            }
        }
    }
}

#[cfg(test)]
mod blocking_write_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn new_writer(config: GroupCommitConfig) -> DbWriteHandle {
        DbWriteHandle::spawn(
            rusqlite::Connection::open_in_memory().expect("open in-memory database"),
            config,
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn write_blocking_offloads_from_current_thread_runtime() {
        let writer = new_writer(GroupCommitConfig::default());

        let result = writer
            .write_blocking(|_| Ok::<_, DbFailure>(41usize))
            .expect("current-thread runtime write should complete");

        assert_eq!(result, 41);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn write_blocking_releases_single_worker_when_bounded_queue_is_full() {
        let writer = new_writer(GroupCommitConfig {
            batch_timeout: Duration::ZERO,
            max_batch_size: 1,
            channel_capacity: 1,
        });
        let (actor_started_tx, actor_started_rx) = oneshot::channel();
        let (actor_gate_tx, actor_gate_rx) = std::sync::mpsc::channel();

        let first_writer = writer.clone();
        let first_write = tokio::spawn(async move {
            first_writer
                .write(move |_| {
                    let _ = actor_started_tx.send(());
                    actor_gate_rx
                        .recv()
                        .expect("actor gate must be released by the test");
                    Ok::<_, DbFailure>(1usize)
                })
                .await
        });
        actor_started_rx
            .await
            .expect("first write should reach the actor");

        let second_writer = writer.clone();
        let second_write =
            tokio::spawn(async move { second_writer.write(|_| Ok::<_, DbFailure>(2usize)).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while writer.sender.capacity() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("second write should fill the bounded queue");

        let runtime_resumed = Arc::new(AtomicBool::new(false));
        let (release_runtime_tx, release_runtime_rx) = oneshot::channel();
        let release_flag = Arc::clone(&runtime_resumed);
        let release_actor = actor_gate_tx.clone();
        let release_task = tokio::spawn(async move {
            release_runtime_rx
                .await
                .expect("test should release the runtime task");
            release_flag.store(true, Ordering::SeqCst);
            let _ = release_actor.send(());
        });

        // The watchdog only prevents a broken implementation from hanging the
        // test process. The assertion below observes whether Tokio resumed this
        // queued task before the blocking write itself completed.
        let (watchdog_cancel_tx, watchdog_cancel_rx) = std::sync::mpsc::channel();
        let watchdog_actor = actor_gate_tx.clone();
        let watchdog = std::thread::spawn(move || {
            if watchdog_cancel_rx
                .recv_timeout(Duration::from_secs(2))
                .is_err()
            {
                let _ = watchdog_actor.send(());
            }
        });

        let blocking_started = Arc::new(AtomicBool::new(false));
        let blocking_started_flag = Arc::clone(&blocking_started);
        let blocking_writer = writer.clone();
        let observed_runtime_resumption = Arc::clone(&runtime_resumed);
        let blocking_write = tokio::spawn(async move {
            blocking_started_flag.store(true, Ordering::SeqCst);
            blocking_writer.write_blocking(move |_| {
                Ok::<_, DbFailure>(observed_runtime_resumption.load(Ordering::SeqCst))
            })
        });

        tokio::time::timeout(Duration::from_secs(2), async {
            while !blocking_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking write task should start");
        release_runtime_tx
            .send(())
            .expect("runtime release task should still be waiting");

        let observed_resumption = blocking_write
            .await
            .expect("blocking write task should not panic")
            .expect("blocking write should complete after the queue drains");

        let _ = watchdog_cancel_tx.send(());
        watchdog.join().expect("watchdog thread should exit");
        assert_eq!(
            first_write
                .await
                .expect("first write task should not panic")
                .unwrap(),
            1
        );
        assert_eq!(
            second_write
                .await
                .expect("second write task should not panic")
                .unwrap(),
            2
        );
        release_task
            .await
            .expect("runtime release task should not panic");
        assert!(
            observed_resumption,
            "Tokio must run the queued task while write_blocking waits on a full channel"
        );
    }

    #[test]
    fn write_blocking_reports_closed_writer_without_losing_error_contract() {
        let (sender, receiver) = mpsc::channel::<WriteTask>(1);
        drop(receiver);
        let writer = DbWriteHandle {
            sender,
            stats: Arc::new(StatsInner::default()),
        };

        let error = writer
            .write_blocking(|_| Ok::<_, DbFailure>(()))
            .expect_err("closed writer should reject blocking writes");

        assert_eq!(
            error,
            DbFailure {
                message: "Single writer actor channel is closed".to_string(),
                kind: DbFailureKind::Other("writer_closed".to_string()),
            }
        );
    }

    #[tokio::test]
    async fn single_task_fast_path_executes_without_savepoint() {
        let writer = new_writer(GroupCommitConfig::default());
        let val = writer
            .write(|conn| {
                conn.execute_batch("CREATE TABLE test_single (id INT); INSERT INTO test_single VALUES (99);")
                    .map_err(|e| DbFailure {
                        message: e.to_string(),
                        kind: DbFailureKind::Other("test".to_string()),
                    })?;
                Ok::<_, DbFailure>(99usize)
            })
            .await
            .expect("single task write succeeds");
        assert_eq!(val, 99);
        assert_eq!(writer.stats().total_operations, 1);
        assert_eq!(writer.stats().total_batches, 1);
        assert_eq!(writer.stats().max_batch_size_seen, 1);
    }
}
