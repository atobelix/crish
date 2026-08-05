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
//!
//! 对外公共面由本文件原样 re-export，签名与既有调用方（orchestrator /
//! agent-workbench / 迁移测试 / upgrade_e2e）保持兼容。

mod agents;
mod error;
mod events;
mod explore_docs_quota_store;
mod import;
mod messages;
mod migrate;
mod runs;
mod schema;
mod sessions;

pub use error::{DbFailure, DbFailureKind};
pub use events::StoredEvent;
pub use explore_docs_quota_store::SessionMetaExploreDocsQuotaStore;
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
}

/// 当前 schema 版本（PE-08 T08.7：PRAGMA user_version 驱动的版本化迁移）。
/// v6：session_agents 新列 task_type / display_label / allowed_write_paths_json
/// （T-D-07 定义扩展落库，纯 ADD COLUMN）。
pub const LATEST_VERSION: u32 = 6;
/// session_meta 中登记的 schema 版本字符串（与 PRAGMA user_version 保持一致）。
pub const SCHEMA_VERSION_STRING: &str = "6";
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
