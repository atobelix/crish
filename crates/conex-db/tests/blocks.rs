//! T-15/T-16 集成测试（00-plan §10 轮次 2 持久层）：v7 迁移与压缩块表访问面。
//!
//! 覆盖（§11 测试 14/16 + 评审 01 P0-3/P0-4 + R12 降级）：
//! - v6 形态库（缺 compression_blocks 表）经真实启动路径升级到 v7，
//!   二次 open 幂等、不产生新备份（v7 纯建表无 DROP）；
//! - 块表 CRUD / INSERT OR IGNORE 幂等 / UPDATE 推进 / list 排序 /
//!   复合主键跨会话隔离 / 缺表降级（R12：空集 + 不 latch）。
//!
//! 缺表降级的精确模拟：v7 库上 DROP 块表 = 「v6 库被新代码读」的表缺失
//! 形态（该库不含 compression_blocks 表），无需重建完整 v6 结构。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use conex_db::{BlockState, CompactionBlockRow, LocalDb, LATEST_VERSION, SCHEMA_VERSION_STRING};
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
            "conex-blocks-{name}-{}-{n}",
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

/// v6 形态库（user_version=6）：v6 结构完整（含 v6 列），但无
/// compression_blocks 表——模拟「v6 库被新代码读」的升级前形态。
fn build_v6_fixture(db: &TempDb) {
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
            VALUES ('s1', 'V6 会话', 2000, 3000);
        INSERT INTO events (session_id, sequence, event_type, payload)
            VALUES ('s1', 1, 'agent-start', '{}');
        PRAGMA user_version = 6;",
    )
    .unwrap();
}

fn sample_row(session_id: &str, block_id: &str, generation: u32) -> CompactionBlockRow {
    CompactionBlockRow {
        session_id: session_id.to_string(),
        block_id: block_id.to_string(),
        sequence: 100 + generation as u64,
        generation,
        prev_block_id: None,
        dropped_message_ids: vec!["u1".to_string(), "a1".to_string()],
        first_kept_message_id: Some("u2".to_string()),
        summary: format!("摘要 {generation}"),
        summary_is_llm: false,
        tokens_before: 10_000,
        tokens_after: 2_000,
        dropped_at_ms: 1_752_000_000_000,
        state: BlockState::Awaiting,
        summary_json: None,
        schema_version: conex_db::BLOCK_SCHEMA_VERSION,
        height: 1,
        tier: None,
        attempts: 0,
        created_at: 1_752_000_000_000,
        updated_at: 1_752_000_000_000,
    }
}

/// v6 → v7 迁移：块表/索引在场、user_version/schema_version 收敛、
/// 旧库数据（事件等）保留、无 DROP 故不产生备份。
#[test]
fn v6_fixture_upgrades_to_v7_blocks_table_present() {
    let temp = TempDb::new("v6-to-v7");
    build_v6_fixture(&temp);

    // 真实启动路径：LocalDb::open 触发 v6→v7 迁移
    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.get_failure(), None, "升级后无失败闩");
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION, "user_version=7");
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING),
        "schema_version 计数值 '7'"
    );

    // 块表 + 索引在场
    let conn = Connection::open(temp.path()).unwrap();
    let has_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='compression_blocks'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_table, 1, "compression_blocks 表已建");
    let has_index: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='index' AND name='idx_compression_blocks_session_gen'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_index, 1, "会话/代数索引已建");

    // 旧库数据保留（事件仍可读）
    assert_eq!(db.query_events("s1", 0, None).unwrap().len(), 1);

    // v7 纯建表无 DROP → 不产生新备份（v3→v4 前的 v6 起点本无备份）
    assert_eq!(backup_files(temp.path()).len(), 0, "v6→v7 不产生备份");
}

/// v7 迁移幂等重跑：二次 open 不重复迁移、不堆积备份、块表可正常读写。
#[test]
fn v7_migration_idempotent_second_open() {
    let temp = TempDb::new("v7-idem");
    build_v6_fixture(&temp);

    let db1 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db1.user_version().unwrap(), LATEST_VERSION);
    let backups_after_first = backup_files(temp.path()).len();
    assert_eq!(backups_after_first, 0, "v6 起点只跑 v6→v7（无备份）");

    // 二次 open（模拟重启）：无重复迁移、无备份堆积
    let db2 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        backup_files(temp.path()).len(),
        backups_after_first,
        "二次 open 不产生新备份"
    );

    // 升级后的块表可正常读写（升级 → 使用闭环）
    db2.insert_block(&sample_row("s1", "compacted-summary-1-1", 1)).unwrap();
    assert_eq!(db2.count_blocks("s1").unwrap(), 1);
    assert!(db2.get_block("s1", "compacted-summary-1-1").unwrap().is_some());
}

/// 复合主键冲突行为：同 (session_id, block_id) 重插被 INSERT OR IGNORE
/// 静默忽略；跨会话同 block_id 各自成行（R-B 会话内唯一语义）。
#[test]
fn composite_primary_key_conflict_ignored_cross_session_isolated() {
    let db = LocalDb::open_in_memory().unwrap();

    db.insert_block(&sample_row("s1", "b1", 1)).unwrap();
    db.insert_block(&sample_row("s1", "b1", 2)).unwrap();
    assert_eq!(db.count_blocks("s1").unwrap(), 1, "同键重插被忽略");

    db.insert_block(&sample_row("s2", "b1", 1)).unwrap();
    assert_eq!(db.count_blocks("s2").unwrap(), 1);
    assert_eq!(db.count_blocks("s1").unwrap(), 1, "跨会话互不干扰");
}

/// 缺表降级（R12/P2-1）：v6 库被新代码读（无 compression_blocks 表）→
/// 全部访问面返回空集 / Ok，不 SQL 报错、不 latch 死库。
#[test]
fn missing_blocks_table_degrades_gracefully() {
    let temp = TempDb::new("deg");
    let db = LocalDb::open(temp.path()).unwrap();
    // 独立连接删除块表 = v6 库形态（该库不含 compression_blocks 表）
    let conn = Connection::open(temp.path()).unwrap();
    conn.execute_batch("DROP TABLE compression_blocks;").unwrap();
    drop(conn);

    assert_eq!(db.list_blocks("s1", None).unwrap().len(), 0);
    assert!(db.get_block("s1", "b1").unwrap().is_none());
    assert_eq!(db.count_blocks("s1").unwrap(), 0);
    db.insert_block(&sample_row("s1", "b1", 1)).unwrap();
    db.update_block_state("s1", "b1", BlockState::Committed, None, 1, 1)
        .unwrap();
    assert_eq!(db.get_failure(), None, "缺表降级不得 latch 死库");
}
