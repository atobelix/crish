//! conex-db：本地 SQLite 会话库（single-writer 模型，Mutex 串行化连接）。
//!
//! 模块按域拆分（R4-T15）：
//! - [`error`]：失败类型（`DbFailure` / `DbFailureKind`）
//! - [`schema`]：v1 起点 / v5 目标建表 DDL
//! - [`migrate`]：v1→v5 版本化迁移链（PE-08 T08.7，实现保持不变）
//! - [`sessions`]：sessions 表 CRUD / 会话索引 / 孤儿清理 / session_meta
//! - [`messages`]：session_messages 正文读写与增量追加
//! - [`agents`]：session_agents 协作子代理读写
//! - [`events`]：events 表读写与会话级 sequence 取号
//! - [`runs`]：run 生命周期 / pending_inputs / RunStatus / run 级 usage 落库
//! - [`import`]：localStorage 历史数据一次性导入
//! - [`explore_docs_quota_store`]：探索类文档配额 session_meta 存储（C5 后端）
//! - [`blocks`]：compression_blocks 压缩块表读写（v7 迁移，T-15/T-16）
//! - [`imported`]：imported_bookmarks / imported_history 浏览器导入目标表
//!   读写（v8 迁移，浏览器协同 G-4 收尾）
//!
//! 对外公共面由本文件原样 re-export，签名与既有调用方（orchestrator /
//! agent-workbench / 迁移测试 / upgrade_e2e）保持兼容。

mod agents;
mod agents_ops;
mod blocks;
pub mod cas_gc;
pub mod compression_store;
mod error;
mod events;
mod explore_docs_quota_store;
pub mod group_commit;
mod import;
mod imported;
pub mod lease_guard;
mod messages;
mod migrate;
mod migrate_steps;
pub mod preferences;
pub mod reader_pool;
mod runs;
mod schema;
mod sessions;
pub mod usage_analytics;

pub use blocks::{BlockState, CompactionBlockRow, BLOCK_SCHEMA_VERSION};
pub use cas_gc::{compute_sha256_hex, spawn_cas_gc_loop, CasBlobRow, CasGcConfig, GcScanStats};
pub use compression_store::DbCompressionContextStore;
pub use error::{DbFailure, DbFailureKind};
pub use events::StoredEvent;
pub use explore_docs_quota_store::SessionMetaExploreDocsQuotaStore;
pub use group_commit::{
    DbWriteHandle, GroupCommitConfig, GroupCommitStats, WriterConnFactory,
    DEFAULT_GROUP_COMMIT_CHANNEL_CAPACITY, DEFAULT_GROUP_COMMIT_MAX_BATCH,
    DEFAULT_GROUP_COMMIT_TIMEOUT_MS, WRITER_REBUILD_FAILURE_THRESHOLD,
};
pub use imported::{
    ImportedBookmarkRow, ImportedHistoryRow, ImportedWriteStats, IMPORT_BATCH_SIZE,
};
pub use lease_guard::{
    generate_lease_id, ActiveBlobLease, BlobLeaseGuard, DEFAULT_LEASE_DURATION,
    DEFAULT_LEASE_DURATION_SECS,
};
pub use preferences::AppPreferenceRow;
pub use reader_pool::{
    PooledReader, ReaderPool, ReaderPoolConfig, ReaderPoolStats, DEFAULT_MAX_WAIT_TIMEOUT_MS,
    DEFAULT_READER_POOL_SIZE, DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
};
pub use runs::{ParseRunStatusError, PendingInput, RunStatus, StoredRun};
pub use usage_analytics::{
    ActivityMatrixCell, ActivityMatrixDto, InsertUsageRecordInput, UsageDashboardDto,
    UsageHeroStats, UsageModelBreakdownItem, UsageRecordRow, UsageTimeseriesPoint,
};

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Local SQLite database with connection pooling semantics (single-writer model).
/// Clone is cheap (Arc reference count increment).
#[derive(Clone)]
pub struct LocalDb {
    conn: Arc<Mutex<Connection>>,
    writer: DbWriteHandle,
    reader_pool: Arc<ReaderPool>,
    lease_guard: Arc<BlobLeaseGuard>,
    gc_config: CasGcConfig,
    failure: Arc<Mutex<Option<DbFailure>>>,
    /// compression_blocks 表存在性缓存（R12/P2-1 缺表降级用；
    /// None = 尚未探测，首次访问时查询 sqlite_master 并缓存——每连接一次）。
    compression_blocks_present: Arc<Mutex<Option<bool>>>,
    /// imported_bookmarks / imported_history 表存在性缓存（同 R12/P2-1
    /// 缺表降级机制；两张表由 v8 迁移同建，共用一个探测位）。
    imported_tables_present: Arc<Mutex<Option<bool>>>,
}

/// 当前 schema 版本（PE-08 T08.7：PRAGMA user_version 驱动的版本化迁移）。
/// v6：session_agents 新列 task_type / display_label / allowed_write_paths_json
/// （T-D-07 定义扩展落库，纯 ADD COLUMN）；
/// v7：新增 compression_blocks 压缩块单表（T-15，R-A 复合主键，零既有列改动）；
/// v8：新增 imported_bookmarks / imported_history 浏览器导入目标表
/// （03-方案-书签历史入conex-db目标表 §3.2，纯建表 + 索引，零既有列改动）；
/// v9：events 补 run_id 列 + idx_events_run 索引、session_agents 补 sub_session_id 列；
/// v10：新增 usage_records 时序流水表及 4 组复合时序索引（用量监控系统全链路移植）；
/// v11：新增 app_preferences 偏好存储表（设计Token与偏好SSOT端到端重构 B1）；
/// v12：DROP session_messages 双触发器 + sessions.body_version CAS 列 +
/// idx_events_session_type / idx_sessions_updated（D3 写单轨：批末重算 message_count）；
/// v13：存量孤儿 session_meta 键一次性 GC（RUN-15：会话段不在 sessions 表
/// 且命中已知会话作用域后缀才删，防误删 sched:/workflow: 等含冒号全局键）。
pub const LATEST_VERSION: u32 = 13;
/// session_meta 中登记的 schema 版本字符串（与 PRAGMA user_version 保持一致）。
pub const SCHEMA_VERSION_STRING: &str = "13";
/// 写连接 PRAGMA cache_size（负值 = KiB；写侧 8 MiB，D0 预算源命名常量）。
pub const WRITE_CONN_CACHE_SIZE_KIB: i64 = -8000;
/// 读连接 PRAGMA cache_size（负值 = KiB；读侧 4 MiB）。
pub const READER_CONN_CACHE_SIZE_KIB: i64 = -4000;
/// 孤儿会话宽限期（毫秒）：updated_at 距今小于该值的会话不被清理（PE-08 T08.2）。
pub const ORPHAN_GRACE_MS: i64 = 300_000;
/// session_meta 中可配宽限期的键。
pub const ORPHAN_GRACE_MS_KEY: &str = "orphan_grace_ms";
/// 全局恢复排他租约的 session_meta 标准键名（04 详案 §6.2；零 DDL，
/// 载荷为 `{instanceId, acquiredAt, expiresAt}` JSON）。
pub const RECOVERY_LEASE_KEY: &str = "global_recovery_lease";
/// 全局恢复排他租约默认 TTL：30 秒（04 详案 §6.2 硬性锁定）。
pub const RECOVERY_LEASE_TTL_MS: i64 = 30_000;
/// 迁移备份目录后缀：DROP 前整库拷贝 `sessions.db.bak-v{n}`，保留最近 2 份。
const BACKUP_KEEP: usize = 2;

fn reserve_unique_temp_path<F>(mut next_path: F) -> std::io::Result<PathBuf>
where
    F: FnMut() -> PathBuf,
{
    loop {
        let path = next_path();
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(reservation) => {
                drop(reservation);
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

/// 打开并初始化一个组提交写连接（唯一构造路径）。
///
/// `LocalDb::open` 与 Writer Actor 的故障自愈连接重建共用本函数，
/// 保证 PRAGMA / 初始化语义完全一致：
/// FK ON + WAL + synchronous NORMAL + busy_timeout 5000 + cache_size 8 MiB。
fn open_writer_conn(path: &Path) -> Result<Connection, DbFailure> {
    let write_conn = Connection::open(path).map_err(|e| DbFailure {
        message: format!("failed to open writer database: {e}"),
        kind: DbFailureKind::Open,
    })?;
    // 写连接不变量（busy_timeout / FK / WAL）：失败必须 fail-fast 上抛——
    // 静默通过会让并发写在后续以偶发 SQLITE_BUSY / FK 级联失效的形式暴露
    write_conn
        .busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| DbFailure {
            message: format!("failed to configure writer busy_timeout: {e}"),
            kind: DbFailureKind::Open,
        })?;
    // 写连接：spawn 前必须 FK ON（否则组提交 Actor 上 FK 级联失效，05-S2）
    write_conn
        .execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA cache_size = {WRITE_CONN_CACHE_SIZE_KIB};"
        ))
        .map_err(|e| DbFailure {
            message: format!("failed to initialize writer connection pragmas: {e}"),
            kind: DbFailureKind::Open,
        })?;
    Ok(write_conn)
}

impl LocalDb {
    /// Open (or create) a database at the given path.
    /// Use ":memory:" for an in-memory database (testing).
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbFailure> {
        let path_ref = path.as_ref();
        let conn = Connection::open(path_ref).map_err(|e| DbFailure {
            message: format!("failed to open database: {e}"),
            kind: DbFailureKind::Open,
        })?;
        // 主连接：FK ON + WAL + NORMAL + busy_timeout + cache_size（读者侧）。
        // 与写连接同一不变量口径：初始化失败 fail-fast，不静默降级为无保护连接。
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(|e| DbFailure {
                message: format!("failed to configure busy_timeout: {e}"),
                kind: DbFailureKind::Open,
            })?;
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = {READER_CONN_CACHE_SIZE_KIB};"
        ))
        .map_err(|e| DbFailure {
            message: format!("failed to initialize connection pragmas: {e}"),
            kind: DbFailureKind::Open,
        })?;

        let write_conn = open_writer_conn(path_ref)?;
        // 写连接重建工厂：ROLLBACK 补救失败 / BEGIN 连续失败达到阈值时，
        // Actor 经由此工厂按同一构造路径重开连接自愈（不复制初始化逻辑）。
        let writer_conn_factory: WriterConnFactory = {
            let path = path_ref.to_path_buf();
            Arc::new(move || open_writer_conn(&path))
        };
        let writer = DbWriteHandle::spawn_with_rebuild(
            write_conn,
            GroupCommitConfig::default(),
            Some(writer_conn_factory),
        )?;

        let reader_pool = match ReaderPool::open(path_ref, ReaderPoolConfig::default()) {
            Ok(pool) => Arc::new(pool),
            Err(_) => Arc::new(ReaderPool::from_connections(
                vec![],
                ReaderPoolConfig::default(),
            )),
        };

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            writer,
            reader_pool,
            lease_guard: Arc::new(BlobLeaseGuard::new()),
            gc_config: CasGcConfig::default(),
            failure: Arc::new(Mutex::new(None)),
            compression_blocks_present: Arc::new(Mutex::new(None)),
            imported_tables_present: Arc::new(Mutex::new(None)),
        };
        db.migrate()?;
        Ok(db)
    }

    /// Open an in-memory database (for testing).
    ///
    /// 历史实现 = 主连接与 Writer 共享同一 shared-cache 内存库
    /// （`file:...?mode=memory&cache=shared`，保证组提交 Actor 写入对读
    /// 路径可见——此前两个独立 `:memory:` 库互不可见，写 Actor 形同虚设）。
    ///
    /// **2026-09-14 根治**：shared-cache 内存库在双连接并发下暴露 SQLite
    /// 表级锁（`database table is locked`，busy_timeout 不覆盖 shared-cache
    /// 表锁语义），run e2e 测试的收口落库与轮询读随机撞锁（单跑绿/并行
    /// 挂的时序脆弱根源）。内存库模式无法启用 WAL（journal_mode=memory
    /// 锁定），故测试库改为**临时 WAL 文件**落地（与生产 open(path) 同一
    /// 锁语义：WAL 读写不互斥）；路径包含 pid、纳秒时间和进程内序号，并由
    /// `create_new` 原子占位，避免 PID 复用后重开历史残留库。临时文件残留
    /// 由系统 temp 目录清理策略兜底。调用面（42 处测试）零改动。
    pub fn open_in_memory() -> Result<Self, DbFailure> {
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::{SystemTime, UNIX_EPOCH};

        static MEM_SEQ: AtomicU64 = AtomicU64::new(0);
        let temp_dir = std::env::temp_dir();
        let path = reserve_unique_temp_path(|| {
            let seq = MEM_SEQ.fetch_add(1, Ordering::Relaxed);
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            temp_dir.join(format!(
                "conex_mem_{}_{}_{}.db",
                std::process::id(),
                timestamp,
                seq
            ))
        })
        .map_err(|error| DbFailure {
            message: format!("failed to reserve temporary database path: {error}"),
            kind: DbFailureKind::Open,
        })?;
        Self::open(&path)
    }

    /// 专用单写 Actor 句柄
    pub fn writer(&self) -> &DbWriteHandle {
        &self.writer
    }

    /// 自适应 WAL 只读连接池
    pub fn reader_pool(&self) -> &ReaderPool {
        &self.reader_pool
    }

    /// 活数据租约守卫
    pub fn lease_guard(&self) -> &BlobLeaseGuard {
        &self.lease_guard
    }

    /// CAS GC 配置
    pub fn gc_config(&self) -> &CasGcConfig {
        &self.gc_config
    }

    /// 异步写操作
    pub async fn write<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        self.writer.write(f).await
    }

    /// 阻塞写桥（同步域方法改道组提交 Writer）。
    ///
    /// 域方法保持同步签名，内部 oneshot 等待 `writer.write_blocking` 批提交结果。
    /// **必须**在非 async 上下文调用（`spawn_blocking` 线程 / 普通测试线程）；
    /// async 上下文请先 `tokio::task::spawn_blocking`。
    ///
    /// 注意：写闭包运行于组提交 Actor 的 `BEGIN IMMEDIATE` 事务内，
    /// 闭包内**禁止**再开 `transaction()` / `BEGIN`（会嵌套失败）。
    pub fn write_blocking<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&mut Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        self.writer.write_blocking(f)
    }

    /// 只读查询（优先调度至 ReaderPool 8 槽位无锁并发读取，无池时平滑回退主连接）
    pub fn read<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&Connection) -> Result<R, DbFailure>,
    {
        if self.reader_pool.pool_size() > 0 {
            if let Ok(reader) = self.reader_pool.acquire() {
                return f(&reader);
            }
        }

        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        f(&conn)
    }

    /// 异步只读查询（优先调度至 ReaderPool 8 槽位无锁并发读取，无池时平滑回退主连接）
    pub async fn read_async<F, R>(&self, f: F) -> Result<R, DbFailure>
    where
        F: FnOnce(&Connection) -> Result<R, DbFailure> + Send + 'static,
        R: Send + 'static,
    {
        if self.reader_pool.pool_size() > 0 {
            self.reader_pool.read_async(f).await
        } else {
            let conn = Arc::clone(&self.conn);
            tokio::task::spawn_blocking(move || {
                let conn = conn.lock().map_err(|e| DbFailure {
                    message: format!("lock poisoned: {e}"),
                    kind: DbFailureKind::Lock,
                })?;
                f(&conn)
            })
            .await
            .map_err(|e| DbFailure {
                message: format!("read task join failed: {e}"),
                kind: DbFailureKind::Other("task_join_failed".to_string()),
            })?
        }
    }

    /// Get the current failure latch (None if healthy).
    pub fn get_failure(&self) -> Option<DbFailure> {
        self.failure.lock().ok()?.clone()
    }

    /// Clear the failure latch (e.g., after successful retry/recovery).
    pub fn clear_failure(&self) {
        if let Ok(mut guard) = self.failure.lock() {
            *guard = None;
        }
    }

    /// Set the failure latch.
    fn set_failure(&self, failure: DbFailure) {
        if let Ok(mut guard) = self.failure.lock() {
            *guard = Some(failure);
        }
    }

    /// Helper to create a latched error and set the failure state.
    fn latch_error(&self, operation: &str, e: rusqlite::Error) -> DbFailure {
        let failure = DbFailure {
            message: format!("{operation}: {e}"),
            kind: DbFailureKind::Other(operation.to_string()),
        };
        self.set_failure(failure.clone());
        failure
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_cas_gc;
#[cfg(test)]
mod tests_concurrency;
#[cfg(test)]
mod tests_migrations;
#[cfg(test)]
mod tests_usage;

#[cfg(test)]
mod temp_path_tests {
    #![allow(clippy::disallowed_methods)]

    use super::reserve_unique_temp_path;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn colliding_candidate_is_retried_without_overwriting_existing_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let test_dir = std::env::temp_dir().join(format!(
            "conex_temp_path_test_{}_{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir(&test_dir).expect("create isolated temp-path test directory");

        let occupied = test_dir.join("occupied.db");
        let available = test_dir.join("available.db");
        let sentinel = b"existing database bytes must remain intact";
        fs::write(&occupied, sentinel).expect("write existing candidate contents");

        let mut candidates = [occupied.clone(), available.clone()].into_iter();
        let selected = reserve_unique_temp_path(|| {
            candidates
                .next()
                .expect("allocator should request one new candidate after a collision")
        })
        .expect("allocator should reserve the next free candidate");

        assert_eq!(selected, available);
        assert_eq!(
            fs::read(&occupied).expect("read original candidate"),
            sentinel
        );
        assert!(
            available.is_file(),
            "free candidate should be atomically reserved"
        );
        fs::remove_dir_all(test_dir).expect("remove isolated temp-path test directory");
    }
}
