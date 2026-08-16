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
use std::sync::{Arc, Mutex, MutexGuard};
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
                "PRAGMA cache_size = -2000;".to_string(),
                "PRAGMA temp_store = MEMORY;".to_string(),
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
/// 离开作用域时自动释放锁并归还连接槽位。
pub struct PooledReader<'a> {
    guard: MutexGuard<'a, Connection>,
    slot_id: usize,
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
        &self.guard
    }
}

impl<'a> DerefMut for PooledReader<'a> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
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
                config,
                stats: StatsInner::default(),
                db_path: None,
            }),
        }
    }

    /// 尝试非阻塞获取一个空闲的只读连接。
    ///
    /// 算法：基于无锁递增游标作为起点，执行全槽位 `try_lock` 扫描。
    /// 若有任意连接空闲，立即无阻塞借出，耗时 < 5µs。
    pub fn try_acquire(&self) -> Option<PooledReader<'_>> {
        let pool_size = self.inner.slots.len();
        if pool_size == 0 {
            return None;
        }

        let start = self.inner.cursor.fetch_add(1, Ordering::Relaxed) % pool_size;
        for i in 0..pool_size {
            let idx = (start + i) % pool_size;
            let slot = &self.inner.slots[idx];
            if let Ok(guard) = slot.conn.try_lock() {
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
                    guard,
                    slot_id: idx,
                });
            }
        }
        None
    }

    /// 同步阻塞获取只读连接（带自适应非阻塞探测与微秒退避）。
    pub fn acquire(&self) -> Result<PooledReader<'_>, DbFailure> {
        self.acquire_timeout(self.inner.config.max_wait_timeout)
    }

    /// 指定超时的同步自适应获取。
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
                std::thread::yield_now();
            } else {
                let sleep_us = (attempt as u64 * 50).min(1000);
                std::thread::sleep(Duration::from_micros(sleep_us));
            }
        }
    }

    /// 异步获取只读连接，竞争时让渡 Tokio 执行权，不占用 OS 阻塞线程。
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
                let sleep_ms = (attempt / 2).clamp(1, 5);
                tokio::time::sleep(Duration::from_millis(sleep_ms as u64)).await;
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

    /// 异步执行只读闭包（在 spawn_blocking 中借用池连接）。
    pub async fn read_async<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        let pool = self.clone();
        tokio::task::spawn_blocking(move || {
            let reader = pool.acquire()?;
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
            if slot.conn.try_lock().is_err() {
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

    /// 对池中所有连接进行健康探测。
    pub fn check_health(&self) -> Result<(), DbFailure> {
        for slot in &self.inner.slots {
            let guard = slot.conn.lock().map_err(|_| DbFailure {
                message: format!("reader slot #{} mutex is poisoned", slot.id),
                kind: DbFailureKind::Other("lock_poisoned".to_string()),
            })?;
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
