//! v7 → v8 迁移集成测试（浏览器协同 G-4 收尾，03-方案 §3.3）。
//!
//! - v7 形态库（user_version=7，含 sessions/events 数据行、无 imported 表）
//!   经真实启动路径升级到 v8：新表/索引在场、user_version/schema_version
//!   收敛、老表行数不变、新表可写读回；
//! - 二次 open 幂等：不重复迁移、不堆积备份（v8 纯建表无 DROP，对齐
//!   tests/blocks.rs 的 v6→v7 模式）。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）——
// 对齐 tests/blocks.rs 文件头同款豁免（唯一差异为 fixture 名与版本号）。
#![allow(clippy::disallowed_methods)]

use conex_db::{
    ImportedBookmarkRow, ImportedHistoryRow, LocalDb, LATEST_VERSION, SCHEMA_VERSION_STRING,
};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 唯一临时文件库（并行测试隔离；Drop 清理主文件 / WAL / SHM / 备份）。
struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new(name: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conex-imported-upgrade-{name}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("sessions.db");
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        if let Some(parent) = self.path.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.starts_with("sessions.db.bak-v") {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

/// 备份文件清单（sessions.db.bak-v{n}，按版本升序）。
fn backup_files(db_path: &Path) -> Vec<(i32, PathBuf)> {
    let mut out = Vec::new();
    let parent = db_path.parent().expect("临时目录");
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("sessions.db.bak-v") {
                if let Ok(v) = rest.parse::<i32>() {
                    out.push((v, entry.path()));
                }
            }
        }
    }
    out.sort_by_key(|(v, _)| *v);
    out
}

/// v7 形态库（user_version=7）：v7 结构完整（含 v7 列与数据行），但无
/// imported_bookmarks / imported_history 表——模拟「v7 生产库被新代码读」
/// 的升级前形态（03-方案 §3.3）。
fn build_v7_fixture(db: &TempDb) {
    let conn = Connection::open(db.path()).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            timestamp TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE events (
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, sequence),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        ) WITHOUT ROWID;
        CREATE TABLE session_sequence (
            session_id TEXT PRIMARY KEY,
            next_sequence INTEGER NOT NULL DEFAULT 1
        ) WITHOUT ROWID;
        CREATE TABLE session_agents (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            subagent_run_id TEXT NOT NULL,
            parent_session_id TEXT NOT NULL,
            parent_run_id TEXT NOT NULL,
            parent_tool_call_id TEXT,
            description TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK (status IN ('running','completed','failed','stopped')),
            summary TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            depth INTEGER DEFAULT 0,
            subagent_path_json TEXT,
            task_type TEXT,
            display_label TEXT,
            allowed_write_paths_json TEXT,
            PRIMARY KEY (session_id, agent_id)
        ) WITHOUT ROWID;
        INSERT INTO sessions (id, title, updated_at, created_at)
            VALUES ('s1', 'V7 会话', 2000, 3000);
        INSERT INTO events (session_id, sequence, event_type, payload)
            VALUES ('s1', 1, 'agent-start', '{}');
        INSERT INTO session_meta (key, value) VALUES ('schema_version', '7');
        PRAGMA user_version = 7;",
    )
    .unwrap();
}

fn sample_bookmark(url: &str, name: &str) -> ImportedBookmarkRow {
    ImportedBookmarkRow {
        url: url.to_string(),
        name: name.to_string(),
        folder_path: vec!["书签栏".to_string(), "工作".to_string()],
        guid: None,
        source: "chrome/Default".to_string(),
        imported_at: 1_752_000_000,
    }
}

fn sample_history(url: &str, visited_at: i64) -> ImportedHistoryRow {
    ImportedHistoryRow {
        url: url.to_string(),
        visited_at,
        title: Some("标题".to_string()),
        source: "chrome/Default".to_string(),
        imported_at: 1_752_000_000,
    }
}

/// v7 → v8 迁移（验收 17 / 03-方案 §3.3）：老表行数不变、新表/索引在场、
/// user_version/schema_version 收敛、无 DROP 故不产生备份、新表可写读回。
#[test]
fn v7_fixture_upgrades_to_v8_imported_tables_present() {
    let temp = TempDb::new("v7-to-v8");
    build_v7_fixture(&temp);

    // 真实启动路径：LocalDb::open 触发 v7→v8 迁移
    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.get_failure(), None, "升级后无失败闩");
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION, "user_version=8");
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING),
        "schema_version 收敛为 '8'"
    );

    // 老表行数不变（数据完好，零既有列改动）
    let conn = Connection::open(temp.path()).unwrap();
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sessions, 1, "sessions 行数不变");
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(events, 1, "events 行数不变");

    // 两张新表 + 3 个索引在场（对齐 03-方案 §2.1/§2.2 DDL）
    for table in ["imported_bookmarks", "imported_history"] {
        let has_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_table, 1, "{table} 表已建");
    }
    // 列清单与 03-方案 §2.1/§2.2 逐列一致（PRAGMA table_info 校验）
    let bookmark_cols: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(imported_bookmarks)")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect()
    };
    assert_eq!(
        bookmark_cols,
        vec![
            "url",
            "name",
            "folder_path_json",
            "guid",
            "source",
            "imported_at",
        ],
        "imported_bookmarks 列清单与方案 §2.1 一致"
    );
    let history_cols: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(imported_history)")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect()
    };
    assert_eq!(
        history_cols,
        vec!["url", "visited_at", "title", "source", "imported_at"],
        "imported_history 列清单与方案 §2.2 一致"
    );
    for index in [
        "idx_imported_bookmarks_imported_at",
        "idx_imported_history_visited_at",
        "idx_imported_history_url",
    ] {
        let has_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                [index],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_index, 1, "{index} 索引已建");
    }
    drop(conn);

    // v8 纯建表无 DROP → 不产生新备份
    assert_eq!(backup_files(temp.path()).len(), 0, "v7→v8 不产生备份");

    // 新表写入读回正常（书签 + 历史各 2 行，幂等）
    let stats = db
        .import_bookmarks(&[
            sample_bookmark("https://a.example.com", "A"),
            sample_bookmark("https://b.example.com", "B"),
        ])
        .unwrap();
    assert_eq!(stats.inserted, 2);
    let stats = db
        .import_history(&[
            sample_history("https://h.example.com", 100),
            sample_history("https://h.example.com", 200),
        ])
        .unwrap();
    assert_eq!(stats.inserted, 2, "同 url 不同 visited_at 各保留一条");
    assert_eq!(db.list_bookmarks().unwrap().len(), 2);
    assert_eq!(db.list_history(None, usize::MAX).unwrap().len(), 2);
}

/// v8 迁移幂等重跑（验收 4 / 03-方案 §3.3 崩溃中间态）：二次 open 不重复
/// 迁移、不堆积备份、老库数据完好、新表数据保留。
#[test]
fn v8_migration_idempotent_second_open() {
    let temp = TempDb::new("v8-idem");
    build_v7_fixture(&temp);

    let db1 = LocalDb::open(temp.path()).unwrap();
    db1.import_bookmarks(&[sample_bookmark("https://a.example.com", "A")])
        .unwrap();
    assert_eq!(backup_files(temp.path()).len(), 0, "v7 起点只跑 v7→v8（无备份）");

    // 二次 open：短路路径（current == LATEST_VERSION）幂等，不报错
    let db2 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(db2.list_bookmarks().unwrap().len(), 1, "新表数据保留");
    assert_eq!(
        db2.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING)
    );
    assert_eq!(backup_files(temp.path()).len(), 0, "二次 open 不堆积备份");
    assert_eq!(db2.get_failure(), None, "幂等重跑无失败闩");
}
