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
pub mod reader_pool;
mod runs;
mod schema;
mod sessions;
pub mod usage_analytics;

pub use blocks::{BlockState, CompactionBlockRow, BLOCK_SCHEMA_VERSION};
pub use cas_gc::{compute_sha256_hex, spawn_cas_gc_loop, CasBlobRow, CasGcConfig, GcScanStats};
pub use error::{DbFailure, DbFailureKind};
pub use events::StoredEvent;
pub use explore_docs_quota_store::SessionMetaExploreDocsQuotaStore;
pub use group_commit::{
    DbWriteHandle, GroupCommitConfig, GroupCommitStats, DEFAULT_GROUP_COMMIT_CHANNEL_CAPACITY,
    DEFAULT_GROUP_COMMIT_MAX_BATCH, DEFAULT_GROUP_COMMIT_TIMEOUT_MS,
};
pub use imported::{
    ImportedBookmarkRow, ImportedHistoryRow, ImportedWriteStats, IMPORT_BATCH_SIZE,
};
pub use lease_guard::{
    generate_lease_id, ActiveBlobLease, BlobLeaseGuard, DEFAULT_LEASE_DURATION,
    DEFAULT_LEASE_DURATION_SECS,
};
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
use std::path::Path;
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
/// v10：新增 usage_records 时序流水表及 4 组复合时序索引（用量监控系统全链路移植）。
pub const LATEST_VERSION: u32 = 10;
/// session_meta 中登记的 schema 版本字符串（与 PRAGMA user_version 保持一致）。
pub const SCHEMA_VERSION_STRING: &str = "10";
/// 孤儿会话宽限期（毫秒）：updated_at 距今小于该值的会话不被清理（PE-08 T08.2）。
pub const ORPHAN_GRACE_MS: i64 = 300_000;
/// session_meta 中可配宽限期的键。
pub const ORPHAN_GRACE_MS_KEY: &str = "orphan_grace_ms";
/// 迁移备份目录后缀：DROP 前整库拷贝 `sessions.db.bak-v{n}`，保留最近 2 份。
const BACKUP_KEEP: usize = 2;

impl LocalDb {
    /// Open (or create) a database at the given path.
    /// Use ":memory:" for an in-memory database (testing).
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbFailure> {
        let path_ref = path.as_ref();
        let conn = Connection::open(path_ref).map_err(|e| DbFailure {
            message: format!("failed to open database: {e}"),
            kind: DbFailureKind::Open,
        })?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));

        // 启用 WAL 模式优化与 busy_timeout
        let _ = conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
        );

        let write_conn = Connection::open(path_ref).map_err(|e| DbFailure {
            message: format!("failed to open writer database: {e}"),
            kind: DbFailureKind::Open,
        })?;
        let _ = write_conn.busy_timeout(std::time::Duration::from_millis(5000));
        let _ = write_conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
        );
        let writer = DbWriteHandle::spawn(write_conn, GroupCommitConfig::default());

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
    pub fn open_in_memory() -> Result<Self, DbFailure> {
        let conn = Connection::open_in_memory().map_err(|e| DbFailure {
            message: format!("failed to open in-memory database: {e}"),
            kind: DbFailureKind::Open,
        })?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
        let _ = conn.execute_batch("PRAGMA busy_timeout = 5000;");

        let writer_conn = Connection::open_in_memory().map_err(|e| DbFailure {
            message: format!("failed to open in-memory writer: {e}"),
            kind: DbFailureKind::Open,
        })?;
        let _ = writer_conn.busy_timeout(std::time::Duration::from_millis(5000));
        let _ = writer_conn.execute_batch("PRAGMA busy_timeout = 5000;");
        let writer = DbWriteHandle::spawn(writer_conn, GroupCommitConfig::default());

        let reader_pool = Arc::new(ReaderPool::from_connections(
            vec![],
            ReaderPoolConfig::default(),
        ));

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
