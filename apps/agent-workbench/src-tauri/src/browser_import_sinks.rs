//! 书签/历史落库适配（03-方案-书签历史入conex-db目标表 §4.1/§4.2 U4）
//!
//! - 架构约束（§4.1）：conex-browser 不依赖 conex-db（纯解析叶子），落库
//!   编排在 Tauri 壳层；本模块是解析层 [`BookmarkSink`]/[`HistorySink`] trait
//!   的 conex-db 适配面（行映射 + `LocalDb::import_bookmarks` /
//!   `LocalDb::import_history`），由 browser_commands.rs 命令层消费；
//! - 行映射：`PersistedBookmark` → `ImportedBookmarkRow`（guid 首版恒 None，
//!   03-方案 §2.1 预留列）、`PersistedHistory` → `ImportedHistoryRow`；
//! - 幂等语义透传：conex-db 侧 `INSERT OR IGNORE`（书签主键 (url, name)、
//!   历史主键 (url, visited_at)）——重复导入天然跳过，统计原样上抛；
//! - 锁纪律（31-security-baseline B8）：本模块不持锁，LocalDb 内部
//!   Arc<Mutex<Connection>> 由 conex-db 单写模型串行（lib.rs:41-49）。

use conex_browser::import::bookmarks::{BookmarkSink, PersistedBookmark};
use conex_browser::import::history::{HistorySink, PersistedHistory};
use conex_db::{ImportedBookmarkRow, ImportedHistoryRow, LocalDb};

/// 书签落库接收器（BookmarkSink 的 LocalDb 适配）。
pub(crate) struct LocalDbBookmarkSink {
    db: LocalDb,
}

impl LocalDbBookmarkSink {
    /// 绑定数据库连接（LocalDb clone 为 Arc 引用 +1，可跨线程持有）。
    pub(crate) fn new(db: LocalDb) -> Self {
        LocalDbBookmarkSink { db }
    }
}

impl BookmarkSink for LocalDbBookmarkSink {
    fn write_bookmarks(&mut self, rows: &[PersistedBookmark]) -> Result<(u64, u64), String> {
        let converted: Vec<ImportedBookmarkRow> = rows
            .iter()
            .map(|r| ImportedBookmarkRow {
                url: r.url.clone(),
                name: r.name.clone(),
                folder_path: r.folder_path.clone(),
                // 03-方案 §2.1：guid 列预留，解析层暂不产出 → 恒 None
                guid: None,
                source: r.source.clone(),
                imported_at: r.imported_at,
            })
            .collect();
        let stats = self
            .db
            .import_bookmarks(&converted)
            .map_err(|e| format!("{}: {}", e.kind, e.message))?;
        Ok((stats.inserted, stats.skipped_dupes))
    }
}

/// 历史落库接收器（HistorySink 的 LocalDb 适配）。
pub(crate) struct LocalDbHistorySink {
    db: LocalDb,
}

impl LocalDbHistorySink {
    /// 绑定数据库连接（LocalDb clone 为 Arc 引用 +1，可跨线程持有）。
    pub(crate) fn new(db: LocalDb) -> Self {
        LocalDbHistorySink { db }
    }
}

impl HistorySink for LocalDbHistorySink {
    fn write_history(&mut self, rows: &[PersistedHistory]) -> Result<(u64, u64), String> {
        let converted: Vec<ImportedHistoryRow> = rows
            .iter()
            .map(|r| ImportedHistoryRow {
                url: r.url.clone(),
                visited_at: r.visited_at,
                title: r.title.clone(),
                source: r.source.clone(),
                imported_at: r.imported_at,
            })
            .collect();
        let stats = self
            .db
            .import_history(&converted)
            .map_err(|e| format!("{}: {}", e.kind, e.message))?;
        Ok((stats.inserted, stats.skipped_dupes))
    }
}
