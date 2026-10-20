//! WAL 只读连接池与自适应非阻塞连接探测 (ReaderPool).
//!
//! 在 SQLite WAL 模式下，多个只读连接可以与单一写者完全并发执行而互不阻塞。
//! 然而，如果所有读请求直接竞争全局单一互斥锁，或在高并发时频繁阻塞 Tokio 工作线程，
//! 会导致线程池（512 线程）迅速耗尽并引发慢查询护航（Convoy Blocking）。
//!
//! 本模块实现自适应 `try_lock` 探测的只读连接池：
//! 1. 维护一组独立的只读连接槽位（默认 8 个）；
//! 2. 借出连接时，首先通过无锁轮询游标对槽位执行非阻塞 `try_lock` 探测；
//! 3. 命中空闲槽位立即返回（耗时 < 5µs），彻底消除锁争抢与上下文切换；
//! 4. 若全量饱和，执行带微秒级退避的自适应自旋与异步让渡，杜绝线程饥饿。

use crate::error::{DbFailure, DbFailureKind};
use rusqlite::{Connection, OpenFlags};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// 默认只读连接池大小（8 连接）
pub const DEFAULT_READER_POOL_SIZE: usize = 8;
/// 默认最大等待超时（3000ms）
pub const DEFAULT_MAX_WAIT_TIMEOUT_MS: u64 = 3000;
/// 默认 SQLite busy_timeout（5000ms）
pub const DEFAULT_SQLITE_BUSY_TIMEOUT_MS: u64 = 5000;

/// 只读连接池配置
#[derive(Debug, Clone)]
pub struct ReaderPoolConfig {
    /// 池中维持的只读连接数（默认 8）
    pub pool_size: usize,
    /// 槽位争抢时的最长等待时长（默认 3000ms）
    pub max_wait_timeout: Duration,
    /// 传递给 SQLite 底层的 busy_timeout（默认 5000ms）
    pub busy_timeout: Duration,
    /// 初始化连接时执行的只读优化 PRAGMA 列表
    pub custom_pragmas: Vec<String>,
}

impl Default for ReaderPoolConfig {
    fn default() -> Self {
        Self {
            pool_size: DEFAULT_READER_POOL_SIZE,
            max_wait_timeout: Duration::from_millis(DEFAULT_MAX_WAIT_TIMEOUT_MS),
            busy_timeout: Duration::from_millis(DEFAULT_SQLITE_BUSY_TIMEOUT_MS),
            custom_pragmas: vec![
                "PRAGMA query_only = ON;".to_string(),
                "PRAGMA synchronous = NORMAL;".to_string(),
                "PRAGMA cache_size = -4000;".to_string(),
                "PRAGMA temp_store = MEMORY;".to_string(),
                "PRAGMA mmap_size = 268435456;".to_string(),
            ],
        }
    }
}

/// 只读连接池运行期指标快照
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReaderPoolStats {
    /// 连接池总容量
    pub pool_size: usize,
    /// 当前活跃（被借出）连接数
    pub active_readers: usize,
    /// 当前空闲连接数
    pub idle_readers: usize,
    /// 累计成功获取连接次数
    pub total_acquisitions: u64,
    /// 首个探测槽位直接命中的快速路径次数
    pub fast_path_hits: u64,
    /// 需要探测多个槽位或发生退避重试的次数
    pub probe_retries: u64,
    /// 等待超时的次数
    pub timeouts: u64,
}

#[derive(Default)]
struct StatsInner {
    total_acquisitions: AtomicU64,
    fast_path_hits: AtomicU64,
    probe_retries: AtomicU64,
    timeouts: AtomicU64,
}

struct ReaderSlot {
    id: usize,
    conn: Mutex<Connection>,
    borrow_count: AtomicU64,
}

/// 借出的只读连接句柄（RAII Guard）
///
/// 离开作用域时自动释放锁并归还连接槽位，同时通过 `Condvar` / `Notify`
/// 精准唤醒正在等待空闲槽位的同步或异步读者线程（消除 Windows 15.6ms 粗粒度休眠）。
pub struct PooledReader<'a> {
    guard: Option<MutexGuard<'a, Connection>>,
    slot_id: usize,
    inner: &'a ReaderPoolInner,
}

impl<'a> PooledReader<'a> {
    /// 获取当前连接所属的槽位 ID
    pub fn slot_id(&self) -> usize {
        self.slot_id
    }
}

impl<'a> Deref for PooledReader<'a> {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        self.guard
            .as_ref()
            .expect("PooledReader guard must be present before drop")
    }
}

impl<'a> DerefMut for PooledReader<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.guard
            .as_mut()
            .expect("PooledReader guard must be present before drop")
    }
}

impl<'a> Drop for PooledReader<'a> {
    fn drop(&mut self) {
        if let Some(guard) = self.guard.take() {
            // 防护：若借用方开启了显式只读事务但未提交/回滚，归还前主动回滚，
            // 避免残留事务长持 WAL read-mark 阻塞 checkpoint
            if !guard.is_autocommit() {
                // Drop 中无法上抛：回滚失败会让该连接长持 read-mark，
                // 进而阻塞 WAL checkpoint，必须 error 级留痕
                if let Err(err) = guard.execute_batch("ROLLBACK;") {
                    tracing::error!(
                        target: "conex_db",
                        error = %err,
                        "归还只读连接前回滚残留事务失败：该连接可能持续阻塞 WAL checkpoint"
                    );
                }
            }
            // 先释放底层连接 MutexGuard，确保被唤醒的等待者调用 try_acquire 时立即可见空闲槽位
            drop(guard);
        }
        if self.inner.waiters.load(Ordering::SeqCst) > 0 {
            let _wait_guard = match self.inner.wait_lock.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            self.inner.slot_cvar.notify_one();
        }
        self.inner.async_notify.notify_one();
    }
}

struct SyncWaiterGuard<'a>(&'a AtomicUsize);

impl<'a> SyncWaiterGuard<'a> {
    fn new(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl<'a> Drop for SyncWaiterGuard<'a> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 自适应无阻塞只读连接池 (ReaderPool)
#[derive(Clone)]
pub struct ReaderPool {
    inner: Arc<ReaderPoolInner>,
}

struct ReaderPoolInner {
    slots: Vec<ReaderSlot>,
    cursor: AtomicUsize,
    waiters: AtomicUsize,
    wait_lock: Mutex<()>,
    slot_cvar: Condvar,
    async_notify: tokio::sync::Notify,
    config: ReaderPoolConfig,
    stats: StatsInner,
    db_path: Option<PathBuf>,
}

impl ReaderPool {
    /// 打开指定路径的 SQLite 数据库并建立只读连接池。
    pub fn open(path: impl AsRef<Path>, config: ReaderPoolConfig) -> Result<Self, DbFailure> {
        let path_ref = path.as_ref();
        let pool_size = config.pool_size.max(1);
        let mut slots = Vec::with_capacity(pool_size);

        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;

        for id in 0..pool_size {
            let conn = Connection::open_with_flags(path_ref, flags).map_err(|e| DbFailure {
                message: format!("failed to open reader connection #{id}: {e}"),
                kind: DbFailureKind::Open,
            })?;

            // 配置 busy_timeout 与只读优化 PRAGMA
            let busy_ms = config.busy_timeout.as_millis() as u64;
            conn.busy_timeout(config.busy_timeout)
                .map_err(|e| DbFailure {
                    message: format!("failed to set busy_timeout on reader #{id}: {e}"),
                    kind: DbFailureKind::Other(format!("busy_timeout_{busy_ms}ms")),
                })?;

            for pragma in &config.custom_pragmas {
                conn.execute_batch(pragma).map_err(|e| DbFailure {
                    message: format!("failed to execute pragma '{pragma}' on reader #{id}: {e}"),
                    kind: DbFailureKind::Other("pragma_failed".to_string()),
                })?;
            }

            slots.push(ReaderSlot {
                id,
                conn: Mutex::new(conn),
                borrow_count: AtomicU64::new(0),
            });
        }

        Ok(Self {
            inner: Arc::new(ReaderPoolInner {
                slots,
                cursor: AtomicUsize::new(0),
                waiters: AtomicUsize::new(0),
                wait_lock: Mutex::new(()),
                slot_cvar: Condvar::new(),
                async_notify: tokio::sync::Notify::new(),
                config,
                stats: StatsInner::default(),
                db_path: Some(path_ref.to_path_buf()),
            }),
        })
    }

    /// 从已有的连接列表直接构造只读连接池（便于内存数据库与单元测试）。
    pub fn from_connections(conns: Vec<Connection>, config: ReaderPoolConfig) -> Self {
        let slots = conns
            .into_iter()
            .enumerate()
            .map(|(id, conn)| ReaderSlot {
                id,
                conn: Mutex::new(conn),
                borrow_count: AtomicU64::new(0),
            })
            .collect();

        Self {
            inner: Arc::new(ReaderPoolInner {
                slots,
                cursor: AtomicUsize::new(0),
                waiters: AtomicUsize::new(0),
                wait_lock: Mutex::new(()),
                slot_cvar: Condvar::new(),
                async_notify: tokio::sync::Notify::new(),
                config,
                stats: StatsInner::default(),
                db_path: None,
            }),
        }
    }

    /// 尝试非阻塞获取一个空闲的只读连接。
    ///
    /// 算法：基于无锁递增游标作为起点，执行全槽位 `try_lock` 扫描。
    /// 若有任意连接空闲，立即无阻塞借出，耗时 < 5µs；
    /// 若前序持锁线程发生 panic 导致槽位 Poisoned，执行非阻塞自愈（提取底层连接、
    /// 回滚残留未决事务并执行健康探针），防止槽位永久死锁泄露（SEC-01）。
    pub fn try_acquire(&self) -> Option<PooledReader<'_>> {
        let pool_size = self.inner.slots.len();
        if pool_size == 0 {
            return None;
        }

        let start = self.inner.cursor.fetch_add(1, Ordering::Relaxed) % pool_size;
        for i in 0..pool_size {
            let idx = (start + i) % pool_size;
            let slot = &self.inner.slots[idx];
            let guard = match slot.conn.try_lock() {
                Ok(g) => {
                    if !g.is_autocommit() {
                        // 残留事务回滚失败 → 该连接会读到旧快照，禁止借出；
                        // 记告警并跳过该槽位（下一轮轮询会再尝试，不污染读者）
                        if let Err(err) = g.execute_batch("ROLLBACK;") {
                            tracing::warn!(
                                target: "conex_db",
                                error = %err,
                                slot = idx,
                                "只读连接残留未决事务回滚失败，跳过该槽位避免借出脏快照连接"
                            );
                            continue;
                        }
                    }
                    g
                }
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    let g = poisoned.into_inner();
                    if !g.is_autocommit() {
                        if let Err(err) = g.execute_batch("ROLLBACK;") {
                            tracing::warn!(
                                target: "conex_db",
                                error = %err,
                                slot = idx,
                                "中毒槽位残留未决事务回滚失败，跳过该槽位"
                            );
                            continue;
                        }
                    }
                    if g.execute_batch("SELECT 1;").is_err() {
                        continue;
                    }
                    g
                }
                Err(std::sync::TryLockError::WouldBlock) => continue,
            };

            slot.borrow_count.fetch_add(1, Ordering::Relaxed);
            self.inner
                .stats
                .total_acquisitions
                .fetch_add(1, Ordering::Relaxed);
            if i == 0 {
                self.inner
                    .stats
                    .fast_path_hits
                    .fetch_add(1, Ordering::Relaxed);
            } else {
                self.inner
                    .stats
                    .probe_retries
                    .fetch_add(1, Ordering::Relaxed);
            }
            return Some(PooledReader {
                guard: Some(guard),
                slot_id: idx,
                inner: &self.inner,
            });
        }
        None
    }

    /// 探测当前是否至少存在一个可立即借出的空闲槽位。
    #[inline]
    pub fn has_idle_slot(&self) -> bool {
        self.inner.slots.iter().any(|slot| {
            !matches!(
                slot.conn.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            )
        })
    }

    /// 同步阻塞获取只读连接（带自适应非阻塞探测与 Condvar 微秒级精准唤醒）。
    pub fn acquire(&self) -> Result<PooledReader<'_>, DbFailure> {
        self.acquire_timeout(self.inner.config.max_wait_timeout)
    }

    /// 指定超时的同步自适应获取。
    ///
    /// 前 4 轮使用 `spin_loop` + `thread::yield_now()` 吸收超短瞬态争用；
    /// 第 5 轮起进入 `Condvar::wait_timeout`，由 `PooledReader::drop` 归还槽位时
    /// 立即执行 `notify_one()` 精准唤醒，彻底根除 Windows 平台 `thread::sleep(50µs)`
    /// 退化为 15.625ms 时钟中断的延迟断崖（SEC-01）。
    pub fn acquire_timeout(&self, timeout: Duration) -> Result<PooledReader<'_>, DbFailure> {
        let start_time = Instant::now();
        let mut attempt = 0u32;

        loop {
            if let Some(reader) = self.try_acquire() {
                return Ok(reader);
            }

            if start_time.elapsed() >= timeout {
                self.inner.stats.timeouts.fetch_add(1, Ordering::Relaxed);
                return Err(DbFailure {
                    message: format!(
                        "ReaderPool timeout: all {} connections busy after {:?}",
                        self.inner.slots.len(),
                        timeout
                    ),
                    kind: DbFailureKind::Lock,
                });
            }

            attempt = attempt.saturating_add(1);
            if attempt <= 4 {
                std::hint::spin_loop();
                std::thread::yield_now();
            } else {
                let _waiter_guard = SyncWaiterGuard::new(&self.inner.waiters);
                let wait_guard = match self.inner.wait_lock.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                // 持锁二次校验：消除 try_acquire 失败与进入 wait_timeout 之间的唤醒丢失窗口
                if let Some(reader) = self.try_acquire() {
                    drop(wait_guard);
                    return Ok(reader);
                }
                let remaining = timeout.saturating_sub(start_time.elapsed());
                if !remaining.is_zero() {
                    let wait_slice = remaining.min(Duration::from_millis(2));
                    // 等待本身即目的：超时或被归还唤醒都进入下一轮探测。
                    // wait_lock 中毒（曾有等待线程 panic）不改变轮询语义，取回内部值继续。
                    if let Err(poisoned) =
                        self.inner.slot_cvar.wait_timeout(wait_guard, wait_slice)
                    {
                        drop(poisoned.into_inner());
                    }
                } else {
                    drop(wait_guard);
                }
            }
        }
    }

    /// 异步获取只读连接，竞争时让渡 Tokio 执行权并通过 `Notify` 精准唤醒，不占用 OS 阻塞线程。
    pub async fn acquire_async(&self) -> Result<PooledReader<'_>, DbFailure> {
        let start_time = Instant::now();
        let timeout = self.inner.config.max_wait_timeout;
        let mut attempt = 0u32;

        loop {
            if let Some(reader) = self.try_acquire() {
                return Ok(reader);
            }

            if start_time.elapsed() >= timeout {
                self.inner.stats.timeouts.fetch_add(1, Ordering::Relaxed);
                return Err(DbFailure {
                    message: format!(
                        "ReaderPool async timeout: all {} connections busy after {:?}",
                        self.inner.slots.len(),
                        timeout
                    ),
                    kind: DbFailureKind::Lock,
                });
            }

            attempt = attempt.saturating_add(1);
            if attempt <= 3 {
                tokio::task::yield_now().await;
            } else {
                let notified = self.inner.async_notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                // 启用监听器后二次探测，消除丢唤醒窗口
                if let Some(reader) = self.try_acquire() {
                    return Ok(reader);
                }
                let remaining = timeout.saturating_sub(start_time.elapsed());
                if !remaining.is_zero() {
                    let wait_slice = remaining.min(Duration::from_millis(2));
                    // 等待切片到期或收到归还通知都立即进入下一轮探测：
                    // 到期属正常轮询节奏（不是错误），故不上抛，仅按需留痕
                    if tokio::time::timeout(wait_slice, notified).await.is_err() {
                        tracing::trace!(
                            target: "conex_db",
                            "ReaderPool 等待切片到期，进入下一轮探测"
                        );
                    }
                }
            }
        }
    }

    /// 在只读连接上执行闭包并返回结果。
    pub fn read<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&Connection) -> Result<R, DbFailure>,
    {
        let reader = self.acquire()?;
        f(&reader)
    }

    /// 异步执行只读闭包（防饥饿保护：全槽位饱和时先在异步上下文让渡等待，
    /// 避免直接涌入 `spawn_blocking` 耗尽 Tokio 阻塞线程池，SEC-01 / SEC-17）。
    pub async fn read_async<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        let start_time = Instant::now();
        let timeout = self.inner.config.max_wait_timeout;
        let mut attempt = 0u32;

        while !self.has_idle_slot() {
            if start_time.elapsed() >= timeout {
                self.inner.stats.timeouts.fetch_add(1, Ordering::Relaxed);
                return Err(DbFailure {
                    message: format!(
                        "ReaderPool async timeout: all {} connections busy after {:?}",
                        self.inner.slots.len(),
                        timeout
                    ),
                    kind: DbFailureKind::Lock,
                });
            }

            attempt = attempt.saturating_add(1);
            if attempt <= 3 {
                tokio::task::yield_now().await;
            } else {
                let notified = self.inner.async_notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.has_idle_slot() {
                    break;
                }
                let remaining = timeout.saturating_sub(start_time.elapsed());
                if !remaining.is_zero() {
                    let wait_slice = remaining.min(Duration::from_millis(2));
                    // 等待切片到期或收到归还通知都立即进入下一轮探测：
                    // 到期属正常轮询节奏（不是错误），故不上抛，仅按需留痕
                    if tokio::time::timeout(wait_slice, notified).await.is_err() {
                        tracing::trace!(
                            target: "conex_db",
                            "ReaderPool 等待切片到期，进入下一轮探测"
                        );
                    }
                }
            }
        }

        let remaining = timeout
            .saturating_sub(start_time.elapsed())
            .max(Duration::from_millis(1));
        let pool = self.clone();
        tokio::task::spawn_blocking(move || {
            let reader = pool.acquire_timeout(remaining)?;
            f(&reader)
        })
        .await
        .map_err(|e| DbFailure {
            message: format!("reader pool task join failed: {e}"),
            kind: DbFailureKind::Other("task_join_failed".to_string()),
        })?
    }

    /// 尝试以非阻塞方式读取；若当前池全满则立即返回 Ok(None)。
    pub fn try_read<F, R>(&self, f: F) -> Result<Option<R>, DbFailure>
    where
        F: FnOnce(&Connection) -> Result<R, DbFailure>,
    {
        match self.try_acquire() {
            Some(reader) => f(&reader).map(Some),
            None => Ok(None),
        }
    }

    /// 获取连接池槽位数（容量）
    pub fn pool_size(&self) -> usize {
        self.inner.slots.len()
    }

    /// 获取连接池运行指标快照。
    pub fn stats(&self) -> ReaderPoolStats {
        let pool_size = self.inner.slots.len();
        let mut active = 0;
        for slot in &self.inner.slots {
            if matches!(
                slot.conn.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ) {
                active += 1;
            }
        }
        let idle = pool_size.saturating_sub(active);

        ReaderPoolStats {
            pool_size,
            active_readers: active,
            idle_readers: idle,
            total_acquisitions: self.inner.stats.total_acquisitions.load(Ordering::Relaxed),
            fast_path_hits: self.inner.stats.fast_path_hits.load(Ordering::Relaxed),
            probe_retries: self.inner.stats.probe_retries.load(Ordering::Relaxed),
            timeouts: self.inner.stats.timeouts.load(Ordering::Relaxed),
        }
    }

    /// 对池中所有连接进行有界健康探测与非阻塞自愈恢复（SEC-01）。
    ///
    /// - 若槽位曾因线程 panic 处于 Poisoned 状态，自动提取底层连接并回滚未决事务；
    /// - 若槽位被慢查询长期占用超过 `max_wait_timeout`，返回 `DbFailureKind::Lock` 超时错误而非无限死锁。
    pub fn check_health(&self) -> Result<(), DbFailure> {
        let deadline = Instant::now() + self.inner.config.max_wait_timeout;
        for slot in &self.inner.slots {
            let guard = loop {
                match slot.conn.try_lock() {
                    Ok(g) => break g,
                    Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                        break poisoned.into_inner();
                    }
                    Err(std::sync::TryLockError::WouldBlock) => {
                        let now = Instant::now();
                        if now >= deadline {
                            return Err(DbFailure {
                                message: format!(
                                    "reader slot #{} health check lock timeout after {:?}",
                                    slot.id, self.inner.config.max_wait_timeout
                                ),
                                kind: DbFailureKind::Lock,
                            });
                        }
                        let _waiter_guard = SyncWaiterGuard::new(&self.inner.waiters);
                        let wait_guard = match self.inner.wait_lock.lock() {
                            Ok(g) => g,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if !remaining.is_zero() {
                            let wait_slice = remaining.min(Duration::from_millis(2));
                            // 同上：等待结果只影响唤醒时机，超时/中毒都继续轮询
                            if let Err(poisoned) =
                                self.inner.slot_cvar.wait_timeout(wait_guard, wait_slice)
                            {
                                drop(poisoned.into_inner());
                            }
                        } else {
                            drop(wait_guard);
                        }
                    }
                }
            };
            if !guard.is_autocommit() {
                // 健康检查必须 fail-fast：残留事务回滚失败即视为该连接不健康
                // （继续 SELECT 1 会给出「健康」的假结论）
                guard.execute_batch("ROLLBACK;").map_err(|e| DbFailure {
                    message: format!(
                        "reader slot #{} health check rollback residual tx failed: {e}",
                        slot.id
                    ),
                    kind: DbFailureKind::Other("health_check_failed".to_string()),
                })?;
            }
            guard.execute_batch("SELECT 1;").map_err(|e| DbFailure {
                message: format!("reader slot #{} health check failed: {e}", slot.id),
                kind: DbFailureKind::Other("health_check_failed".to_string()),
            })?;
        }
        Ok(())
    }

    /// 获取当前连接池绑定的数据库路径（若为文件数据库）。
    pub fn db_path(&self) -> Option<&Path> {
        self.inner.db_path.as_deref()
    }

    /// 获取当前连接池大小。
    pub fn len(&self) -> usize {
        self.inner.slots.len()
    }

    /// 检查连接池是否为空。
    pub fn is_empty(&self) -> bool {
        self.inner.slots.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_reader_slot_recovers_non_blocking_and_passes_health_check() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        let pool = ReaderPool::from_connections(
            vec![conn],
            ReaderPoolConfig {
                pool_size: 1,
                max_wait_timeout: Duration::from_millis(200),
                ..Default::default()
            },
        );

        let pool_clone = pool.clone();
        let handle = std::thread::spawn(move || {
            let reader = pool_clone.acquire().expect("acquire before panic");
            reader
                .execute_batch("BEGIN;")
                .expect("start unfinished transaction");
            panic!("simulated reader panic while holding slot and transaction");
        });
        assert!(handle.join().is_err(), "worker must have panicked");

        // Poisoned 槽位不应被误判为活跃占用
        let stats = pool.stats();
        assert_eq!(stats.active_readers, 0);
        assert_eq!(stats.idle_readers, 1);

        // try_acquire 应立即非阻塞自愈并回滚残留事务
        let recovered = pool
            .try_acquire()
            .expect("poisoned slot must recover via try_acquire");
        assert!(
            recovered.is_autocommit(),
            "dangling transaction must be rolled back on recovery"
        );
        drop(recovered);

        // check_health 必须顺利通过
        pool.check_health()
            .expect("health check must succeed after poison recovery");
    }

    #[test]
    fn dangling_transaction_is_rolled_back_on_pooled_reader_drop() {
        let conn = Connection::open_in_memory().expect("open in-memory");
        let pool = ReaderPool::from_connections(vec![conn], ReaderPoolConfig::default());

        {
            let reader = pool.acquire().expect("acquire");
            reader.execute_batch("BEGIN;").expect("begin tx");
            assert!(!reader.is_autocommit());
        }

        let reader2 = pool.acquire().expect("re-acquire");
        assert!(
            reader2.is_autocommit(),
            "PooledReader::drop must rollback uncommitted transaction"
        );
    }
}
