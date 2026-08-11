//! 浏览器导入目标表域：imported_bookmarks / imported_history 读写访问面
//! （浏览器协同 G-4 收尾，03-方案-书签历史入conex-db目标表 §2）。
//!
//! 设计要点（对齐 blocks.rs 模块模式）：
//! - 行类型叶子纪律：本 crate 独立定义 [`ImportedBookmarkRow`] /
//!   [`ImportedHistoryRow`]，与 conex-browser 解析层类型一一对应，转换由
//!   壳层完成（03-方案 §2.3 / §4.1——conex-browser 不依赖 conex-db）；
//! - 幂等写入：`INSERT OR IGNORE`（书签主键 (url, name)、历史主键
//!   (url, visited_at)，与解析层去重键逐字节对齐）——重复导入（含跨批次
//!   重导）天然跳过，统计经 [`ImportedWriteStats`] 返回供 UI 明示；
//! - 分批事务：每 [`IMPORT_BATCH_SIZE`]（1000）条一个事务，避免长事务锁
//!   （03-方案 §2.3 分批语义）；
//! - 缺表降级（R12/P2-1 纪律，对齐 blocks.rs:13-30）：读写面先探测
//!   sqlite_master（每连接缓存一次），缺表时查询返回空集、写入返回
//!   Ok(空统计)，配 `tracing::warn!`——绝不 SQL 报错 latch 死库。

use super::{DbFailure, DbFailureKind, LocalDb};

/// 单批导入条数（03-方案 §2.3 分批事务语义：1000 条/批提交）。
pub const IMPORT_BATCH_SIZE: usize = 1000;

/// imported_bookmarks 表行（与 conex-browser 的 BookmarkItem 一一对应；
/// 转换由壳层完成，本 crate 不引入 conex-browser 依赖）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ImportedBookmarkRow {
    /// 书签 URL（主键一半）。
    pub url: String,
    /// 书签名（主键一半；与解析层 (url, name) 去重键对齐）。
    pub name: String,
    /// 父文件夹路径链（落库时序列化为 folder_path_json）。
    pub folder_path: Vec<String>,
    /// 来源 guid（Chrome JSON 节点字段；解析层暂不产出 → 首版恒 None，预留扩展）。
    pub guid: Option<String>,
    /// 来源标识（如 `chrome/Default`；信息列不入主键，跨来源同键合并）。
    pub source: String,
    /// 导入时刻（unix 秒，审计/排序）。
    pub imported_at: i64,
}

/// imported_history 表行（与 conex-browser 的 HistoryItem 一一对应）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ImportedHistoryRow {
    /// 访问 URL（主键一半）。
    pub url: String,
    /// 访问时刻（unix 秒；主键一半——同 URL 不同秒的访问各保留一条）。
    pub visited_at: i64,
    /// 页面标题（来源 NULL → None）。
    pub title: Option<String>,
    /// 来源标识（信息列不入主键）。
    pub source: String,
    /// 导入时刻（unix 秒）。
    pub imported_at: i64,
}

/// 导入结果统计（INSERT OR IGNORE 影响行数：1 = 新增，0 = 同键去重跳过）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportedWriteStats {
    /// 新增落库条数。
    pub inserted: u64,
    /// 同主键去重跳过条数（重复导入）。
    pub skipped_dupes: u64,
}

impl ImportedWriteStats {
    /// 累加另一份统计（多批聚合）。
    pub fn merge(&mut self, other: &ImportedWriteStats) {
        self.inserted += other.inserted;
        self.skipped_dupes += other.skipped_dupes;
    }
}

impl LocalDb {
    /// imported_bookmarks / imported_history 两张表是否都在场
    /// （sqlite_master 探测，每连接缓存一次；任一缺失视为缺表形态）。
    fn imported_tables_present(&self) -> Result<bool, DbFailure> {
        if let Some(present) = *self
            .imported_tables_present
            .lock()
            .map_err(|e| DbFailure {
                message: format!("lock poisoned: {e}"),
                kind: DbFailureKind::Lock,
            })?
        {
            return Ok(present);
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let present: bool = conn
            .query_row(
                "SELECT COUNT(*) = 2 FROM sqlite_master
                 WHERE type='table' AND name IN ('imported_bookmarks', 'imported_history')",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .map_err(|e| self.latch_error("imported_tables_present", e))?;
        if let Ok(mut cache) = self.imported_tables_present.lock() {
            *cache = Some(present);
        }
        Ok(present)
    }

    /// 缺表降级告警（备份恢复/异常中间态，R12/P2-1：不 SQL 报错）。
    fn warn_missing_imported_tables(&self, operation: &str) {
        tracing::warn!(
            operation,
            "imported_bookmarks/imported_history 表缺失（备份恢复异常态？）：{operation} 降级返回空/Ok，不报错"
        );
    }

    /// 书签落库（03-方案 §2.3）：单批 [IMPORT_BATCH_SIZE] 条一个事务 +
    /// `INSERT OR IGNORE` 幂等——同 (url, name) 重导跳过（`skipped_dupes`
    /// 计数供 UI 明示）。缺表降级返回 Ok(空统计)。
    pub fn import_bookmarks(
        &self,
        rows: &[ImportedBookmarkRow],
    ) -> Result<ImportedWriteStats, DbFailure> {
        if !self.imported_tables_present()? {
            self.warn_missing_imported_tables("import_bookmarks");
            return Ok(ImportedWriteStats::default());
        }
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stats = ImportedWriteStats::default();
        for chunk in rows.chunks(IMPORT_BATCH_SIZE) {
            let tx = conn
                .transaction()
                .map_err(|e| self.latch_error("import_bookmarks_tx", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT OR IGNORE INTO imported_bookmarks
                         (url, name, folder_path_json, guid, source, imported_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    )
                    .map_err(|e| self.latch_error("import_bookmarks_prepare", e))?;
                for row in chunk {
                    let folder_path_json = serde_json::to_string(&row.folder_path).map_err(|e| {
                        let failure = DbFailure {
                            message: format!("import_bookmarks_folder_json: {e}"),
                            kind: DbFailureKind::Other(
                                "import_bookmarks_folder_json".to_string(),
                            ),
                        };
                        self.set_failure(failure.clone());
                        failure
                    })?;
                    let changed = stmt
                        .execute(rusqlite::params![
                            row.url,
                            row.name,
                            folder_path_json,
                            row.guid,
                            row.source,
                            row.imported_at,
                        ])
                        .map_err(|e| self.latch_error("import_bookmarks_exec", e))?;
                    if changed > 0 {
                        stats.inserted += 1;
                    } else {
                        stats.skipped_dupes += 1;
                    }
                }
            }
            tx.commit()
                .map_err(|e| self.latch_error("import_bookmarks_commit", e))?;
        }
        Ok(stats)
    }

    /// 历史落库（03-方案 §2.3）：同上；主键 (url, visited_at) 幂等——
    /// 同 URL 不同秒的访问各保留一条。缺表降级返回 Ok(空统计)。
    pub fn import_history(
        &self,
        rows: &[ImportedHistoryRow],
    ) -> Result<ImportedWriteStats, DbFailure> {
        if !self.imported_tables_present()? {
            self.warn_missing_imported_tables("import_history");
            return Ok(ImportedWriteStats::default());
        }
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stats = ImportedWriteStats::default();
        for chunk in rows.chunks(IMPORT_BATCH_SIZE) {
            let tx = conn
                .transaction()
                .map_err(|e| self.latch_error("import_history_tx", e))?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT OR IGNORE INTO imported_history
                         (url, visited_at, title, source, imported_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                    )
                    .map_err(|e| self.latch_error("import_history_prepare", e))?;
                for row in chunk {
                    let changed = stmt
                        .execute(rusqlite::params![
                            row.url,
                            row.visited_at,
                            row.title,
                            row.source,
                            row.imported_at,
                        ])
                        .map_err(|e| self.latch_error("import_history_exec", e))?;
                    if changed > 0 {
                        stats.inserted += 1;
                    } else {
                        stats.skipped_dupes += 1;
                    }
                }
            }
            tx.commit()
                .map_err(|e| self.latch_error("import_history_commit", e))?;
        }
        Ok(stats)
    }

    /// 书签全量查询（导入时间倒序——面板书签侧栏展示面）。缺表返回空集。
    pub fn list_bookmarks(&self) -> Result<Vec<ImportedBookmarkRow>, DbFailure> {
        if !self.imported_tables_present()? {
            self.warn_missing_imported_tables("list_bookmarks");
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT url, name, folder_path_json, guid, source, imported_at
                 FROM imported_bookmarks
                 ORDER BY imported_at DESC, url ASC",
            )
            .map_err(|e| self.latch_error("list_bookmarks_prepare", e))?;
        let rows = stmt
            .query_map([], bookmark_from_row)
            .map_err(|e| self.latch_error("list_bookmarks_query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("list_bookmarks_collect", e))?;
        Ok(rows)
    }

    /// 历史查询（visited_at 倒序——对齐解析层 ORDER BY visit_time DESC 语义；
    /// `since` 过滤为严格大于；`limit` 钳制条数）。缺表返回空集。
    pub fn list_history(
        &self,
        since: Option<i64>,
        limit: usize,
    ) -> Result<Vec<ImportedHistoryRow>, DbFailure> {
        if !self.imported_tables_present()? {
            self.warn_missing_imported_tables("list_history");
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT url, visited_at, title, source, imported_at
                 FROM imported_history
                 WHERE (?1 IS NULL OR visited_at > ?1)
                 ORDER BY visited_at DESC, url ASC
                 LIMIT ?2",
            )
            .map_err(|e| self.latch_error("list_history_prepare", e))?;
        let rows = stmt
            .query_map(rusqlite::params![since, limit as i64], history_from_row)
            .map_err(|e| self.latch_error("list_history_query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("list_history_collect", e))?;
        Ok(rows)
    }

    /// 书签总数（缺表返回 0）。
    pub fn count_bookmarks(&self) -> Result<u64, DbFailure> {
        if !self.imported_tables_present()? {
            self.warn_missing_imported_tables("count_bookmarks");
            return Ok(0);
        }
        self.count_imported_rows("imported_bookmarks", "count_bookmarks")
    }

    /// 历史总数（缺表返回 0）。
    pub fn count_history(&self) -> Result<u64, DbFailure> {
        if !self.imported_tables_present()? {
            self.warn_missing_imported_tables("count_history");
            return Ok(0);
        }
        self.count_imported_rows("imported_history", "count_history")
    }

    /// 表行数统计（count_bookmarks / count_history 复用）。
    fn count_imported_rows(&self, table: &str, operation: &str) -> Result<u64, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table}"),
                [],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error(operation, e))?;
        Ok(count as u64)
    }
}

/// imported_bookmarks 行 → 结构映射（folder_path_json 反序列化，损坏时
/// 宽松降级为空数组——对齐 blocks.rs 的 unwrap_or_else 模式）。
fn bookmark_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportedBookmarkRow> {
    let folder_path_json: String = row.get(2)?;
    let folder_path: Vec<String> =
        serde_json::from_str(&folder_path_json).unwrap_or_else(|_| Vec::new());
    Ok(ImportedBookmarkRow {
        url: row.get(0)?,
        name: row.get(1)?,
        folder_path,
        guid: row.get(3)?,
        source: row.get(4)?,
        imported_at: row.get(5)?,
    })
}

/// imported_history 行 → 结构映射。
fn history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ImportedHistoryRow> {
    Ok(ImportedHistoryRow {
        url: row.get(0)?,
        visited_at: row.get(1)?,
        title: row.get(2)?,
        source: row.get(3)?,
        imported_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bookmark_row(url: &str, name: &str, folder: &[&str]) -> ImportedBookmarkRow {
        ImportedBookmarkRow {
            url: url.to_string(),
            name: name.to_string(),
            folder_path: folder.iter().map(|f| f.to_string()).collect(),
            guid: None,
            source: "chrome/Default".to_string(),
            imported_at: 1_752_000_000,
        }
    }

    fn history_row(url: &str, visited_at: i64, title: Option<&str>) -> ImportedHistoryRow {
        ImportedHistoryRow {
            url: url.to_string(),
            visited_at,
            title: title.map(|t| t.to_string()),
            source: "chrome/Default".to_string(),
            imported_at: 1_752_000_000,
        }
    }

    /// 行类型 serde 往返（Tauri IPC 直通面）。
    #[test]
    fn row_serde_roundtrip() {
        let b = bookmark_row("https://a.example.com", "A", &["书签栏", "工作"]);
        let json = serde_json::to_string(&b).expect("序列化");
        let back: ImportedBookmarkRow = serde_json::from_str(&json).expect("反序列化");
        assert_eq!(back, b);
        let h = history_row("https://h.example.com", 123, Some("标题"));
        let json = serde_json::to_string(&h).expect("序列化");
        let back: ImportedHistoryRow = serde_json::from_str(&json).expect("反序列化");
        assert_eq!(back, h);
        assert_eq!(ImportedWriteStats::default().inserted, 0);
    }

    /// 往返（验收 6）：import_bookmarks(3 行) → list_bookmarks 3 行，
    /// url/name/folder_path（反序列化后逐元素）/guid/source/imported_at 全等。
    #[test]
    fn bookmark_roundtrip() {
        let db = LocalDb::open_in_memory().unwrap();
        let rows = vec![
            bookmark_row("https://a.example.com", "A", &["书签栏"]),
            bookmark_row("https://b.example.com", "B", &["书签栏", "工作"]),
            bookmark_row("https://c.example.com", "C", &[]),
        ];
        let stats = db.import_bookmarks(&rows).unwrap();
        assert_eq!(stats.inserted, 3);
        assert_eq!(stats.skipped_dupes, 0);

        let loaded = db.list_bookmarks().unwrap();
        assert_eq!(loaded.len(), 3);
        for (got, want) in loaded.iter().zip(rows.iter()) {
            assert_eq!(got, want);
        }
        // guid 首版恒 None 落库
        assert!(loaded.iter().all(|r| r.guid.is_none()));
        assert_eq!(db.count_bookmarks().unwrap(), 3);
    }

    /// 书签幂等（验收 7）：同批再导 → 不新增行、skipped_dupes 全量；
    /// 同 (url, name) 不同 folder_path → 仍 1 行（IGNORE 语义，首版信息保留）。
    #[test]
    fn bookmark_reimport_idempotent() {
        let db = LocalDb::open_in_memory().unwrap();
        let rows = vec![
            bookmark_row("https://a.example.com", "A", &["书签栏"]),
            bookmark_row("https://b.example.com", "B", &["书签栏"]),
            bookmark_row("https://c.example.com", "C", &["书签栏"]),
        ];
        db.import_bookmarks(&rows).unwrap();
        // 同键重导（folder_path 不同也按主键跳过）
        let dup = vec![
            bookmark_row("https://a.example.com", "A", &["其他书签"]),
            bookmark_row("https://b.example.com", "B", &["移动端书签"]),
            bookmark_row("https://c.example.com", "C", &["同步书签"]),
        ];
        let stats = db.import_bookmarks(&dup).unwrap();
        assert_eq!(stats.inserted, 0, "全部同键跳过");
        assert_eq!(stats.skipped_dupes, 3);
        assert_eq!(db.count_bookmarks().unwrap(), 3, "行数不变");
        // 首版信息保留（IGNORE 语义）：folder_path 未被覆盖
        let loaded = db.list_bookmarks().unwrap();
        assert_eq!(loaded[0].folder_path, vec!["书签栏"]);
        // 部分重复：2 新 + 1 旧
        let mixed = vec![
            bookmark_row("https://a.example.com", "A", &["书签栏"]),
            bookmark_row("https://d.example.com", "D", &["书签栏"]),
            bookmark_row("https://e.example.com", "E", &["书签栏"]),
        ];
        let stats = db.import_bookmarks(&mixed).unwrap();
        assert_eq!(stats.inserted, 2);
        assert_eq!(stats.skipped_dupes, 1);
        assert_eq!(db.count_bookmarks().unwrap(), 5);
    }

    /// 历史幂等（验收 8）：同 (url, visited_at) 两次 → 1 行；
    /// 同 url 不同 visited_at → 2 行；title None/Some 往返。
    #[test]
    fn history_idempotent_and_multi_visits() {
        let db = LocalDb::open_in_memory().unwrap();
        let rows = vec![
            history_row("https://h.example.com", 100, Some("标题")),
            history_row("https://h.example.com", 200, None),
            history_row("https://o.example.com", 100, None),
        ];
        let stats = db.import_history(&rows).unwrap();
        assert_eq!(stats.inserted, 3);
        // 同 (url, visited_at) 重导跳过；同 url 不同 visited_at 保留
        let dup = vec![
            history_row("https://h.example.com", 100, None),
            history_row("https://h.example.com", 300, Some("新标题")),
        ];
        let stats = db.import_history(&dup).unwrap();
        assert_eq!(stats.inserted, 1, "同 url 新秒数新增一条");
        assert_eq!(stats.skipped_dupes, 1);
        assert_eq!(db.count_history().unwrap(), 4);
        let loaded = db.list_history(None, usize::MAX).unwrap();
        let h100 = loaded
            .iter()
            .find(|r| r.url == "https://h.example.com" && r.visited_at == 100)
            .expect("存在");
        assert_eq!(h100.title.as_deref(), Some("标题"), "首版标题保留（IGNORE）");
        let o100 = loaded
            .iter()
            .find(|r| r.url == "https://o.example.com")
            .expect("存在");
        assert_eq!(o100.title, None, "title None 往返");
    }

    /// 查询面（验收 9）：visited_at DESC 排序 + since 严格大于过滤 + limit 截断。
    #[test]
    fn list_history_sorts_filters_limits() {
        let db = LocalDb::open_in_memory().unwrap();
        for (i, v) in [100i64, 300, 200, 150].iter().enumerate() {
            db.import_history(&[history_row(
                &format!("https://{i}.example.com"),
                *v,
                None,
            )])
            .unwrap();
        }
        let all = db.list_history(None, usize::MAX).unwrap();
        let times: Vec<i64> = all.iter().map(|r| r.visited_at).collect();
        assert_eq!(times, vec![300, 200, 150, 100], "visited_at DESC");
        // since 严格大于：> 150 → 2 条
        let since = db.list_history(Some(150), usize::MAX).unwrap();
        let times: Vec<i64> = since.iter().map(|r| r.visited_at).collect();
        assert_eq!(times, vec![300, 200]);
        // limit 截断（倒序取前 2）
        let limited = db.list_history(None, 2).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].visited_at, 300);
        assert_eq!(limited[1].visited_at, 200);
    }

    /// 分批事务（验收 10）：2005 行一次落库（1000/1000/5 三批），无部分提交丢失。
    #[test]
    fn batch_commit_persists_all_rows() {
        let db = LocalDb::open_in_memory().unwrap();
        let rows: Vec<ImportedBookmarkRow> = (0..2005)
            .map(|i| bookmark_row(&format!("https://{i}.example.com"), &format!("n{i}"), &[]))
            .collect();
        let stats = db.import_bookmarks(&rows).unwrap();
        assert_eq!(stats.inserted, 2005);
        assert_eq!(stats.skipped_dupes, 0);
        assert_eq!(db.count_bookmarks().unwrap(), 2005);
        assert_eq!(db.list_bookmarks().unwrap().len(), 2005);
    }

    /// 缺表降级（验收 11 / R12/P2-1）：删表后查询返回空集、写入返回 Ok(空统计)，
    /// 不 latch 死库。
    #[test]
    fn missing_tables_degrade_without_latch() {
        let db = LocalDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("DROP TABLE imported_bookmarks; DROP TABLE imported_history;")
            .unwrap();
        drop(conn);

        assert_eq!(db.list_bookmarks().unwrap().len(), 0);
        assert_eq!(db.list_history(None, 10).unwrap().len(), 0);
        assert_eq!(db.count_bookmarks().unwrap(), 0);
        assert_eq!(db.count_history().unwrap(), 0);
        let stats = db
            .import_bookmarks(&[bookmark_row("https://a.example.com", "A", &[])])
            .unwrap();
        assert_eq!(stats, ImportedWriteStats::default(), "写入 Ok 空统计");
        db.import_history(&[history_row("https://h.example.com", 1, None)])
            .unwrap();
        assert_eq!(db.get_failure(), None, "缺表降级不得 latch 死库");
    }
}
