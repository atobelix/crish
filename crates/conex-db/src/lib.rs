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
pub mod group_commit;
mod explore_docs_quota_store;
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

pub use blocks::{BlockState, CompactionBlockRow, BLOCK_SCHEMA_VERSION};
pub use cas_gc::{compute_sha256_hex, CasBlobRow, CasGcConfig, GcScanStats};
pub use error::{DbFailure, DbFailureKind};
pub use events::StoredEvent;
pub use explore_docs_quota_store::SessionMetaExploreDocsQuotaStore;
pub use group_commit::{
    DbWriteHandle, GroupCommitConfig, GroupCommitStats, DEFAULT_GROUP_COMMIT_CHANNEL_CAPACITY,
    DEFAULT_GROUP_COMMIT_MAX_BATCH, DEFAULT_GROUP_COMMIT_TIMEOUT_MS,
};
pub use imported::{ImportedBookmarkRow, ImportedHistoryRow, ImportedWriteStats, IMPORT_BATCH_SIZE};
pub use lease_guard::{
    generate_lease_id, ActiveBlobLease, BlobLeaseGuard, DEFAULT_LEASE_DURATION,
    DEFAULT_LEASE_DURATION_SECS,
};
pub use reader_pool::{
    PooledReader, ReaderPool, ReaderPoolConfig, ReaderPoolStats, DEFAULT_MAX_WAIT_TIMEOUT_MS,
    DEFAULT_READER_POOL_SIZE, DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
};
pub use runs::{ParseRunStatusError, PendingInput, RunStatus, StoredRun};

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Local SQLite database with connection pooling semantics (single-writer model).
/// Clone is cheap (Arc reference count increment).
#[derive(Clone)]
pub struct LocalDb {
    conn: Arc<Mutex<Connection>>,
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
/// v9：events 补 run_id 列 + idx_events_run 索引（agent 循环可追溯性战役
/// D-01 DM-01：run 归属第一类数据，列 = 查询权威；存量行不回填诚实未知）、
/// session_agents 补 sub_session_id 列（D-02 LK-04 主控代收列定义，
/// 读写面轮 3 实现）——纯 ADD COLUMN + 索引，零既有列语义改动。
pub const LATEST_VERSION: u32 = 9;
/// session_meta 中登记的 schema 版本字符串（与 PRAGMA user_version 保持一致）。
pub const SCHEMA_VERSION_STRING: &str = "9";
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
        let conn = Connection::open(path.as_ref()).map_err(|e| DbFailure {
            message: format!("failed to open database: {e}"),
            kind: DbFailureKind::Open,
        })?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
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

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            failure: Arc::new(Mutex::new(None)),
            compression_blocks_present: Arc::new(Mutex::new(None)),
            imported_tables_present: Arc::new(Mutex::new(None)),
        };
        db.migrate()?;
        Ok(db)
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
mod tests_migrations;
#[cfg(test)]
mod tests_concurrency;
#[cfg(test)]
mod tests_cas_gc;

