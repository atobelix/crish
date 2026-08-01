use conex_types::{codes, CrishError, ImportStats, SessionAgent, SessionIndexEntry, SessionMessage};
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

/// 失败类别（R6 目标形状；`kind` 由 String 收敛为枚举，Display 保持
/// 操作名语义——session_commands 的 `format!("{}: {}", e.kind, ...)` 兼容）。
///
/// ⚠️ 临时验证垫片（R6 落地后删除）：仅为打通 orchestrator/persist.rs 的
/// 编译与测试而补，最终形状以 R6 产出为准。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbFailureKind {
    /// 锁竞争 / 锁中毒
    Lock,
    /// 底层 IO 错误
    Io,
    /// 数据损坏
    Corrupt,
    /// 迁移失败
    Migration,
    /// 打开数据库失败
    Open,
    /// 导入 folder 序列化失败
    ImportFolderSerialize,
    /// 导入索引解析失败
    ImportIndexParse,
    /// 其它操作名（保留 String 兼容）
    Other(String),
}

impl DbFailureKind {
    /// 操作名字面量（诊断 / metadata 用）
    pub fn as_str(&self) -> &str {
        match self {
            DbFailureKind::Lock => "lock",
            DbFailureKind::Io => "io",
            DbFailureKind::Corrupt => "corrupt",
            DbFailureKind::Migration => "migration",
            DbFailureKind::Open => "open",
            DbFailureKind::ImportFolderSerialize => "import_folder_serialize",
            DbFailureKind::ImportIndexParse => "import_index_parse",
            DbFailureKind::Other(name) => name.as_str(),
        }
    }
}

impl std::fmt::Display for DbFailureKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Failure latch: once set, remains set until explicitly cleared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbFailure {
    pub message: String,
    pub kind: DbFailureKind,
}

impl std::fmt::Display for DbFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

/// DbFailure → CrishError（R6 接线点：77 码 store.write_failed + dbKind metadata，
/// cause 链保留底层分类）。
impl From<DbFailure> for CrishError {
    fn from(failure: DbFailure) -> Self {
        CrishError::new(codes::STORE_WRITE_FAILED, failure.message.clone()).with_metadata(
            serde_json::json!({ "dbKind": failure.kind.as_str() }),
        )
    }
}

/// Local SQLite database with connection pooling semantics (single-writer model).
/// Clone is cheap (Arc reference count increment).
#[derive(Clone)]
pub struct LocalDb {
    conn: Arc<Mutex<Connection>>,
    failure: Arc<Mutex<Option<DbFailure>>>,
}

/// 当前 schema 版本（PE-08 T08.7：PRAGMA user_version 驱动的版本化迁移）。
pub const LATEST_VERSION: u32 = 4;
/// session_meta 中登记的 schema 版本字符串（与 PRAGMA user_version 保持一致）。
pub const SCHEMA_VERSION_STRING: &str = "4";
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

    /// 读取当前 schema 版本（PRAGMA user_version，PE-08 T08.7）。
    pub fn user_version(&self) -> Result<u32, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version", e))
    }

    /// 迁移备份：整库拷贝到 `sessions.db.bak-v{n}`，保留最近 [BACKUP_KEEP] 份。
    fn backup_before_drop(&self, path: &Path, version: u32) {
        let Some(dir) = path.parent() else {
            return;
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "sessions.db".into());
        let backup = dir.join(format!("{name}.bak-v{version}"));
        if let Err(e) = std::fs::copy(path, &backup) {
            eprintln!("[conex-db] 迁移备份失败 v{version}: {e}（路径 {}）", path.display());
        }
        // 清理旧备份，只保留最近 BACKUP_KEEP 份
        let mut backups: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(&format!("{name}.bak-v")))
                    .unwrap_or(false)
            })
            .collect();
        backups.sort();
        while backups.len() > BACKUP_KEEP {
            if let Some(oldest) = backups.first() {
                let _ = std::fs::remove_file(oldest);
                backups.remove(0);
            }
        }
    }

    /// Run schema migrations.
    ///
    /// 版本化迁移（PE-08 T08.7）：以 `PRAGMA user_version` 为权威源，
    /// 从当前版本逐级迁移到 [LATEST_VERSION]；每版本独立事务、幂等可重试；
    /// DROP 前备份（[backup_before_drop]）；新库直接建 v4 结构。
    fn migrate(&self) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| self.latch_error("pragma_foreign_keys", e))?;
        // WAL 模式 + busy_timeout（PE-08 T08.7：并发写友好）
        let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

        let current: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| self.latch_error("user_version_read", e))?;

        if current == LATEST_VERSION {
            // 已是目标版本：确保关键结构存在（幂等兜底，含备份恢复场景）
            conn.execute_batch(create_v4_schema())
                .map_err(|e| self.latch_error("schema_ensure", e))?;
            self.record_schema_version(&conn)?;
            return Ok(());
        }

        // 全新库（无 sessions 表）：建 v1 形态后走完整迁移链
        // （fresh_db_full_chain 测试锚定：全新建库也执行 v1..v4 全部迁移，
        // 验证迁移链自身正确性，且 DROP 前备份产生）。
        let has_sessions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
                [],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error("has_sessions", e))?;
        if current == 0 && has_sessions == 0 {
            conn.execute_batch(create_v1_schema())
                .map_err(|e| self.latch_error("schema_create_v1", e))?;
            conn.execute_batch("PRAGMA user_version = 1;")
                .map_err(|e| self.latch_error("user_version_set_1", e))?;
        }

        // 逐版本迁移（旧生产形态 user_version=0 但已有旧表：按 v1 起点迁移）
        let path: Option<std::path::PathBuf> = conn
            .path()
            .map(std::path::PathBuf::from)
            .filter(|p| p != Path::new(":memory:"));
        let start_version = if current == 0 { 1 } else { current };

        for version in (start_version + 1)..=LATEST_VERSION {
            let mut tx = conn
                .transaction()
                .map_err(|e| self.latch_error(&format!("migrate_tx_v{version}"), e))?;
            let step_result = match version {
                2 => migrate_v1_to_v2(&tx),
                3 => migrate_v2_to_v3(&tx),
                4 => migrate_v3_to_v4(&tx),
                _ => unreachable!(),
            };
            if let Err(e) = step_result {
                let msg = format!("migrate_v{version} failed: {e}");
                let failure = DbFailure {
                    message: msg,
                    kind: DbFailureKind::Migration,
                };
                self.set_failure(failure.clone());
                return Err(failure);
            }
            tx.commit()
                .map_err(|e| self.latch_error(&format!("migrate_commit_v{version}"), e))?;
            conn.execute_batch(&format!("PRAGMA user_version = {version};"))
                .map_err(|e| self.latch_error(&format!("user_version_set_v{version}"), e))?;
            if let Some(p) = &path {
                self.backup_before_drop(p, version);
            }
        }

        // 迁移完成后 ensure v4 结构（补触发器/索引；幂等）
        conn.execute_batch(create_v4_schema())
            .map_err(|e| self.latch_error("schema_ensure_post_migrate", e))?;
        self.record_schema_version(&conn)?;

        Ok(())
    }

    /// 登记 schema 版本到 session_meta（JS 侧经 get_session_meta 读取）。
    fn record_schema_version(&self, conn: &rusqlite::Connection) -> Result<(), DbFailure> {
        conn.execute(
            "INSERT OR IGNORE INTO session_meta (key, value) VALUES ('schema_version', ?1)",
            rusqlite::params![SCHEMA_VERSION_STRING],
        )
        .map_err(|e| self.latch_error("schema_version_set", e))?;
        conn.execute(
            "UPDATE session_meta SET value = ?1 WHERE key = 'schema_version'",
            rusqlite::params![SCHEMA_VERSION_STRING],
        )
        .map_err(|e| self.latch_error("schema_version_update", e))?;
        Ok(())
    }
}

/// v1 形态 schema（全新建库的迁移链起点，与 tests/migrations.rs 的
/// build_v1_fixture 结构一致；随后经 v2/v3/v4 迁移到目标形态）。
fn create_v1_schema() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        timestamp TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);

    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
        text TEXT,
        thinking TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT CHECK (status IN ('queued','processing','completed','error')),
        stream_text_offset INTEGER,
        thinking_time INTEGER,
        tool_calls_json TEXT,
        blocks_json TEXT,
        tool_call_results_json TEXT,
        PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_session_messages_id ON session_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS session_agents (
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
        PRIMARY KEY (session_id, agent_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_agent_messages (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
        text TEXT,
        thinking TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT,
        stream_text_offset INTEGER,
        thinking_time INTEGER,
        tool_calls_json TEXT,
        blocks_json TEXT,
        tool_call_results_json TEXT,
        PRIMARY KEY (session_id, agent_id, seq),
        FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        end_reason TEXT,
        cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS pending_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    "#
}

/// v4 目标 schema 全量 DDL（PE-08 T08.7）。
///
/// 结构要点：
/// - events：组合主键 `(session_id, sequence)` + FK，无 AUTOINCREMENT id 列（P14）；
/// - runs / pending_inputs：FK 到 sessions（孤儿行迁移时过滤）；
/// - session_messages：新增 `updated_at`；
/// - session_sequence：会话级 sequence 原子分配表（T08.12）；
/// - metadata 旧表不创建（v4 删除）。
fn create_v4_schema() -> &'static str {
    r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL DEFAULT '常规会话',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        branch_parent_id TEXT,
        timestamp TEXT NOT NULL DEFAULT '',
        timestamp_source TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        pinned_message_ids TEXT,
        engine_cursor INTEGER,
        engine_last_run_id TEXT,
        hydrated_from_engine INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        end_reason TEXT,
        cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

    CREATE TABLE IF NOT EXISTS pending_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_inputs(session_id, created_at);

    CREATE TABLE IF NOT EXISTS session_sequence (
        session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL DEFAULT 1
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
        text TEXT,
        thinking TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT CHECK (status IN ('queued','processing','completed','error')),
        stream_text_offset INTEGER,
        thinking_time INTEGER,
        tool_calls_json TEXT,
        blocks_json TEXT,
        tool_call_results_json TEXT,
        updated_at INTEGER,
        PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_session_messages_id ON session_messages(session_id, id);

    CREATE TABLE IF NOT EXISTS session_agents (
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
        PRIMARY KEY (session_id, agent_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_agent_messages (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL,
        sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
        text TEXT,
        thinking TEXT,
        timestamp INTEGER NOT NULL,
        status TEXT CHECK (status IN ('queued','processing','completed','error')),
        stream_text_offset INTEGER,
        thinking_time INTEGER,
        tool_calls_json TEXT,
        blocks_json TEXT,
        tool_call_results_json TEXT,
        PRIMARY KEY (session_id, agent_id, seq),
        FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS session_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TRIGGER IF NOT EXISTS trg_session_messages_insert
    AFTER INSERT ON session_messages
    BEGIN
        UPDATE sessions SET message_count = message_count + 1 WHERE id = NEW.session_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_session_messages_delete
    AFTER DELETE ON session_messages
    BEGIN
        UPDATE sessions SET message_count = message_count - 1 WHERE id = OLD.session_id;
    END;
    "#
}

/// v1 → v2：sessions 补 folder 等列（ADD COLUMN，避免 RENAME+DROP 父表
/// 触发 ON DELETE CASCADE 清空 session_messages / session_agents 数据）。
fn migrate_v1_to_v2(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    let cols: Vec<String> = tx
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    let add = |tx: &rusqlite::Transaction<'_>, col: &str, ddl: &str| -> Result<(), rusqlite::Error> {
        if !cols.iter().any(|c| c == col) {
            tx.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {ddl};"))?;
        }
        Ok(())
    };
    add(tx, "folder", "folder TEXT NOT NULL DEFAULT '常规会话'")?;
    add(tx, "is_pinned", "is_pinned INTEGER NOT NULL DEFAULT 0")?;
    add(tx, "is_archived", "is_archived INTEGER NOT NULL DEFAULT 0")?;
    add(tx, "branch_parent_id", "branch_parent_id TEXT")?;
    add(tx, "timestamp_source", "timestamp_source TEXT")?;
    add(tx, "pinned_message_ids", "pinned_message_ids TEXT")?;
    add(tx, "engine_cursor", "engine_cursor INTEGER")?;
    add(tx, "engine_last_run_id", "engine_last_run_id TEXT")?;
    add(tx, "hydrated_from_engine", "hydrated_from_engine INTEGER")?;
    Ok(())
}

/// v2 → v3：session_agent_messages 重建补 CHECK (status IN ...) 约束（数据拷贝）。
fn migrate_v2_to_v3(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "ALTER TABLE session_agent_messages RENAME TO sam_v2;
         CREATE TABLE session_agent_messages (
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            id TEXT NOT NULL,
            sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
            text TEXT,
            thinking TEXT,
            timestamp INTEGER NOT NULL,
            status TEXT CHECK (status IN ('queued','processing','completed','error')),
            stream_text_offset INTEGER,
            thinking_time INTEGER,
            tool_calls_json TEXT,
            blocks_json TEXT,
            tool_call_results_json TEXT,
            PRIMARY KEY (session_id, agent_id, seq),
            FOREIGN KEY (session_id, agent_id) REFERENCES session_agents(session_id, agent_id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO session_agent_messages
            (session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
             stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json)
            SELECT session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
             stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json
            FROM sam_v2;
         DROP TABLE sam_v2;",
    )
}

/// v3 → v4：events 重建为组合主键（无 id 列 + FK）、metadata 删除、
/// runs/pending_inputs 加 FK（孤儿行过滤）、session_messages 加 updated_at、
/// session_sequence 建表/对齐。
fn migrate_v3_to_v4(tx: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    // 孤儿计数（会话不存在的 events/runs/pending 行）→ 写入 session_meta 可观测
    let orphan_events: i64 = tx.query_row(
        "SELECT COUNT(*) FROM events WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    let orphan_runs: i64 = tx.query_row(
        "SELECT COUNT(*) FROM runs WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    let orphan_pending: i64 = tx.query_row(
        "SELECT COUNT(*) FROM pending_inputs WHERE session_id NOT IN (SELECT id FROM sessions)",
        [],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO session_meta (key, value) VALUES ('migration_v4_dropped_orphans', ?1)",
        rusqlite::params![format!("{orphan_events}:{orphan_runs}:{orphan_pending}")],
    )?;
    tx.execute_batch(
        "ALTER TABLE events RENAME TO events_v3;
         CREATE TABLE events (
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_id, sequence),
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO events (session_id, sequence, event_type, payload, created_at)
            SELECT session_id, sequence, event_type, payload, created_at FROM events_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE events_v3;

         DROP TABLE IF EXISTS metadata;

         ALTER TABLE runs RENAME TO runs_v3;
         CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            end_reason TEXT,
            cursor INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
            SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at FROM runs_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE runs_v3;
         CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

         ALTER TABLE pending_inputs RENAME TO pending_v3;
         CREATE TABLE pending_inputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
         ) WITHOUT ROWID;
         INSERT INTO pending_inputs (id, session_id, run_id, payload, created_at)
            SELECT id, session_id, run_id, payload, created_at FROM pending_v3
            WHERE session_id IN (SELECT id FROM sessions);
         DROP TABLE pending_v3;
         CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_inputs(session_id, created_at);

         ALTER TABLE session_messages ADD COLUMN updated_at INTEGER;",
    )?;
    // session_sequence：v3 形态可能不存在（v1/v2 fixture）——不存在则直接建；
    // 存在则重建对齐 next_sequence 列名并过滤孤儿。
    let has_ss: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_sequence'",
        [],
        |r| r.get(0),
    )?;
    if has_ss > 0 {
        tx.execute_batch(
            "ALTER TABLE session_sequence RENAME TO ss_v3;
             CREATE TABLE session_sequence (
                session_id TEXT PRIMARY KEY,
                next_sequence INTEGER NOT NULL DEFAULT 1
             ) WITHOUT ROWID;
             INSERT INTO session_sequence (session_id, next_sequence)
                SELECT session_id, next_seq FROM ss_v3
                WHERE session_id IN (SELECT id FROM sessions);
             DROP TABLE ss_v3;",
        )?;
    } else {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_sequence (
                session_id TEXT PRIMARY KEY,
                next_sequence INTEGER NOT NULL DEFAULT 1
             ) WITHOUT ROWID;",
        )?;
    }
    Ok(())
}

impl LocalDb {
    pub fn insert_session(&self, id: &str, title: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, title) VALUES (?1, ?2)",
            rusqlite::params![id, title],
        )
        .map_err(|e| self.latch_error("insert_session", e))?;

        Ok(())
    }

    /// Append an event to a session.
    pub fn append_event(
        &self,
        session_id: &str,
        sequence: i64,
        event_type: &str,
        payload: &str,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT INTO events (session_id, sequence, event_type, payload) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, sequence, event_type, payload],
        )
        .map_err(|e| self.latch_error("append_event", e))?;

        Ok(())
    }

    /// Query events for a session after a given sequence number.
    ///
    /// `limit` 限制返回条数（修复无界查询性能问题，对齐 Stream B 6.3）。
    /// 传 `None` 等价于无限制（兼容旧行为），但推荐显式传 `Some(n)`。
    pub fn query_events(
        &self,
        session_id: &str,
        after_sequence: i64,
        limit: Option<i64>,
    ) -> Result<Vec<StoredEvent>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT session_id, sequence, event_type, payload, created_at
                 FROM events WHERE session_id = ?1 AND sequence > ?2
                 ORDER BY sequence ASC LIMIT ?3",
            )
            .map_err(|e| self.latch_error("query_events_prepare", e))?;

        let limit_value = limit.unwrap_or(i64::MAX);
        let events = stmt
            .query_map(rusqlite::params![session_id, after_sequence, limit_value], |row| {
                Ok(StoredEvent {
                    session_id: row.get(0)?,
                    sequence: row.get(1)?,
                    event_type: row.get(2)?,
                    payload: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| self.latch_error("query_events_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("query_events_collect", e))?;

        Ok(events)
    }

    // ===== Stream B: Session 持久化方法 =====

    /// 幂等写入会话索引条目。
    /// 使用 `ON CONFLICT DO UPDATE` 而非 `INSERT OR REPLACE`，避免触发
    /// `ON DELETE CASCADE` 误删 session_messages / session_agents。
    /// `message_count` / `created_at` 不被覆盖（由触发器 / 创建时维护）。
    pub fn upsert_session_entry(&self, entry: &SessionIndexEntry) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let is_pinned: i64 = entry.is_pinned.into();
        let is_archived: i64 = entry.is_archived.into();
        let hydrated: Option<i64> = entry.hydrated_from_engine.map(|b| b.into());

        conn.execute(
            "INSERT INTO sessions (
                id, title, folder, is_pinned, is_archived, branch_parent_id,
                timestamp, updated_at, pinned_message_ids,
                engine_cursor, engine_last_run_id, hydrated_from_engine
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                folder = excluded.folder,
                is_pinned = excluded.is_pinned,
                is_archived = excluded.is_archived,
                branch_parent_id = excluded.branch_parent_id,
                timestamp = excluded.timestamp,
                updated_at = excluded.updated_at,
                pinned_message_ids = excluded.pinned_message_ids,
                engine_cursor = excluded.engine_cursor,
                engine_last_run_id = excluded.engine_last_run_id,
                hydrated_from_engine = excluded.hydrated_from_engine",
            rusqlite::params![
                entry.id,
                entry.title,
                entry.folder,
                is_pinned,
                is_archived,
                entry.branch_parent_id,
                entry.timestamp,
                entry.updated_at,
                entry.pinned_message_ids,
                entry.engine_cursor,
                entry.engine_last_run_id,
                hydrated,
            ],
        )
        .map_err(|e| self.latch_error("upsert_session_entry", e))?;

        Ok(())
    }

    /// 列出所有会话索引条目，按 `updated_at` 降序（最近更新在前）。
    pub fn list_sessions(&self) -> Result<Vec<SessionIndexEntry>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, title, folder, is_pinned, is_archived, branch_parent_id,
                        timestamp, updated_at, message_count, pinned_message_ids,
                        engine_cursor, engine_last_run_id, hydrated_from_engine
                 FROM sessions
                 ORDER BY updated_at DESC, id ASC",
            )
            .map_err(|e| self.latch_error("list_sessions_prepare", e))?;

        let entries = stmt
            .query_map([], |row| {
                let is_pinned: i64 = row.get(3)?;
                let is_archived: i64 = row.get(4)?;
                let hydrated: Option<i64> = row.get(12)?;
                Ok(SessionIndexEntry {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    folder: row.get(2)?,
                    is_pinned: is_pinned != 0,
                    is_archived: is_archived != 0,
                    branch_parent_id: row.get(5)?,
                    timestamp: row.get(6)?,
                    updated_at: row.get(7)?,
                    message_count: row.get(8)?,
                    pinned_message_ids: row.get(9)?,
                    engine_cursor: row.get(10)?,
                    engine_last_run_id: row.get(11)?,
                    hydrated_from_engine: hydrated.map(|v| v != 0),
                })
            })
            .map_err(|e| self.latch_error("list_sessions_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("list_sessions_collect", e))?;

        Ok(entries)
    }

    /// 加载会话正文消息（按 seq 升序）。
    pub fn load_session_body(&self, session_id: &str) -> Result<Vec<SessionMessage>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json
                 FROM session_messages
                 WHERE session_id = ?1
                 ORDER BY seq ASC",
            )
            .map_err(|e| self.latch_error("load_session_body_prepare", e))?;

        let messages = stmt
            .query_map(rusqlite::params![session_id], |row| {
                Ok(SessionMessage {
                    id: row.get(0)?,
                    sender: row.get(1)?,
                    text: row.get(2)?,
                    thinking: row.get(3)?,
                    timestamp: row.get(4)?,
                    status: row.get(5)?,
                    stream_text_offset: row.get(6)?,
                    thinking_time: row.get(7)?,
                    tool_calls_json: row.get(8)?,
                    blocks_json: row.get(9)?,
                    tool_call_results_json: row.get(10)?,
                })
            })
            .map_err(|e| self.latch_error("load_session_body_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_session_body_collect", e))?;

        Ok(messages)
    }

    /// 全量保存会话正文（先删后插，事务原子）。
    /// 触发器自动维护 `message_count`。
    pub fn save_session_body(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
    ) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("save_session_body_tx", e))?;

        tx.execute(
            "DELETE FROM session_messages WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("save_session_body_delete", e))?;

        for (seq, msg) in messages.iter().enumerate() {
            let seq_i64 = seq as i64;
            tx.execute(
                "INSERT INTO session_messages (
                    session_id, seq, id, sender, text, thinking, timestamp, status,
                    stream_text_offset, thinking_time, tool_calls_json,
                    blocks_json, tool_call_results_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    session_id,
                    seq_i64,
                    msg.id,
                    msg.sender,
                    msg.text,
                    msg.thinking,
                    msg.timestamp,
                    msg.status,
                    msg.stream_text_offset,
                    msg.thinking_time,
                    msg.tool_calls_json,
                    msg.blocks_json,
                    msg.tool_call_results_json,
                ],
            )
            .map_err(|e| self.latch_error("save_session_body_insert", e))?;
        }

        tx.commit()
            .map_err(|e| self.latch_error("save_session_body_commit", e))?;

        Ok(())
    }

    /// 增量追加消息（在当前 max seq 后续写）。
    pub fn append_session_messages(
        &self,
        session_id: &str,
        new_messages: &[SessionMessage],
    ) -> Result<(), DbFailure> {
        if new_messages.is_empty() {
            return Ok(());
        }

        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("append_session_messages_tx", e))?;

        let next_seq: i64 = {
            let mut stmt = tx
                .prepare("SELECT COALESCE(MAX(seq), -1) + 1 FROM session_messages WHERE session_id = ?1")
                .map_err(|e| self.latch_error("append_session_messages_max_seq", e))?;
            stmt.query_row(rusqlite::params![session_id], |row| row.get::<_, i64>(0))
                .map_err(|e| self.latch_error("append_session_messages_max_seq_row", e))?
        };

        for (offset, msg) in new_messages.iter().enumerate() {
            let seq = next_seq + offset as i64;
            tx.execute(
                "INSERT INTO session_messages (
                    session_id, seq, id, sender, text, thinking, timestamp, status,
                    stream_text_offset, thinking_time, tool_calls_json,
                    blocks_json, tool_call_results_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    session_id,
                    seq,
                    msg.id,
                    msg.sender,
                    msg.text,
                    msg.thinking,
                    msg.timestamp,
                    msg.status,
                    msg.stream_text_offset,
                    msg.thinking_time,
                    msg.tool_calls_json,
                    msg.blocks_json,
                    msg.tool_call_results_json,
                ],
            )
            .map_err(|e| self.latch_error("append_session_messages_insert", e))?;
        }

        tx.commit()
            .map_err(|e| self.latch_error("append_session_messages_commit", e))?;

        Ok(())
    }

    /// 删除会话（级联删除 messages / agents / agent_messages，由 ON DELETE CASCADE 保证）。
    pub fn delete_session(&self, session_id: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "DELETE FROM sessions WHERE id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("delete_session", e))?;

        Ok(())
    }

    /// 加载会话下的协作子 agent（含每个 agent 的消息，按 seq 升序）。
    pub fn load_session_agents(&self, session_id: &str) -> Result<Vec<SessionAgent>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut agent_stmt = conn
            .prepare(
                "SELECT agent_id, subagent_run_id, parent_session_id, parent_run_id,
                        parent_tool_call_id, description, mode, status, summary,
                        started_at, ended_at, depth, subagent_path_json
                 FROM session_agents
                 WHERE session_id = ?1
                 ORDER BY started_at ASC, agent_id ASC",
            )
            .map_err(|e| self.latch_error("load_session_agents_prepare", e))?;

        let agent_rows: Vec<SessionAgent> = agent_stmt
            .query_map(rusqlite::params![session_id], |row| {
                Ok(SessionAgent {
                    id: row.get(0)?,
                    subagent_run_id: row.get(1)?,
                    parent_session_id: row.get(2)?,
                    parent_run_id: row.get(3)?,
                    parent_tool_call_id: row.get(4)?,
                    description: row.get(5)?,
                    mode: row.get(6)?,
                    status: row.get(7)?,
                    summary: row.get(8)?,
                    started_at: row.get(9)?,
                    ended_at: row.get(10)?,
                    depth: row.get(11)?,
                    subagent_path_json: row.get(12)?,
                    messages: Vec::new(),
                })
            })
            .map_err(|e| self.latch_error("load_session_agents_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_session_agents_collect", e))?;

        // 为每个 agent 单独查询消息
        let mut msg_stmt = conn
            .prepare(
                "SELECT id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json
                 FROM session_agent_messages
                 WHERE session_id = ?1 AND agent_id = ?2
                 ORDER BY seq ASC",
            )
            .map_err(|e| self.latch_error("load_session_agents_msg_prepare", e))?;

        let mut agents = agent_rows;
        for agent in &mut agents {
            let messages = msg_stmt
                .query_map(rusqlite::params![session_id, agent.id], |row| {
                    Ok(SessionMessage {
                        id: row.get(0)?,
                        sender: row.get(1)?,
                        text: row.get(2)?,
                        thinking: row.get(3)?,
                        timestamp: row.get(4)?,
                        status: row.get(5)?,
                        stream_text_offset: row.get(6)?,
                        thinking_time: row.get(7)?,
                        tool_calls_json: row.get(8)?,
                        blocks_json: row.get(9)?,
                        tool_call_results_json: row.get(10)?,
                    })
                })
                .map_err(|e| self.latch_error("load_session_agents_msg_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("load_session_agents_msg_collect", e))?;
            agent.messages = messages;
        }

        Ok(agents)
    }

    /// 全量保存会话的协作子 agent（先删后插，事务原子）。
    pub fn save_session_agents(
        &self,
        session_id: &str,
        agents: &[SessionAgent],
    ) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("save_session_agents_tx", e))?;

        // 级联 FK 会自动清理 session_agent_messages
        tx.execute(
            "DELETE FROM session_agents WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("save_session_agents_delete", e))?;

        for agent in agents {
            tx.execute(
                "INSERT INTO session_agents (
                    session_id, agent_id, subagent_run_id, parent_session_id, parent_run_id,
                    parent_tool_call_id, description, mode, status, summary,
                    started_at, ended_at, depth, subagent_path_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                rusqlite::params![
                    session_id,
                    agent.id,
                    agent.subagent_run_id,
                    agent.parent_session_id,
                    agent.parent_run_id,
                    agent.parent_tool_call_id,
                    agent.description,
                    agent.mode,
                    agent.status,
                    agent.summary,
                    agent.started_at,
                    agent.ended_at,
                    agent.depth,
                    agent.subagent_path_json,
                ],
            )
            .map_err(|e| self.latch_error("save_session_agents_insert", e))?;

            for (seq, msg) in agent.messages.iter().enumerate() {
                let seq_i64 = seq as i64;
                tx.execute(
                    "INSERT INTO session_agent_messages (
                        session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    rusqlite::params![
                        session_id,
                        agent.id,
                        seq_i64,
                        msg.id,
                        msg.sender,
                        msg.text,
                        msg.thinking,
                        msg.timestamp,
                        msg.status,
                        msg.stream_text_offset,
                        msg.thinking_time,
                        msg.tool_calls_json,
                        msg.blocks_json,
                        msg.tool_call_results_json,
                    ],
                )
                .map_err(|e| self.latch_error("save_session_agents_msg_insert", e))?;
            }
        }

        tx.commit()
            .map_err(|e| self.latch_error("save_session_agents_commit", e))?;

        Ok(())
    }

    /// 读取会话级元数据键。
    pub fn get_session_meta(&self, key: &str) -> Result<Option<String>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare("SELECT value FROM session_meta WHERE key = ?1")
            .map_err(|e| self.latch_error("get_session_meta_prepare", e))?;

        let value = stmt
            .query_row(rusqlite::params![key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| self.latch_error("get_session_meta_row", e))?;

        Ok(value)
    }

    /// 写入会话级元数据键（幂等 upsert）。
    pub fn set_session_meta(&self, key: &str, value: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT INTO session_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| self.latch_error("set_session_meta", e))?;

        Ok(())
    }

    /// 清理不在 `active_ids` 中的会话（孤儿清理）。
    /// 返回被删除的会话数。
    pub fn cleanup_orphan_sessions(&self, active_ids: &[String]) -> Result<usize, DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("cleanup_orphan_tx", e))?;

        // 宽限期（PE-08 T08.2）：updated_at 距今小于该值的会话不被清理。
        // 值可从 session_meta 的 orphan_grace_ms 覆盖（默认 ORPHAN_GRACE_MS）。
        let grace_ms: i64 = tx
            .query_row(
                "SELECT value FROM session_meta WHERE key = ?1",
                rusqlite::params![ORPHAN_GRACE_MS_KEY],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(ORPHAN_GRACE_MS);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let grace_cutoff = now_ms - grace_ms;

        let total_before: i64 = tx
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| self.latch_error("cleanup_orphan_count_before", e))?;

        if active_ids.is_empty() {
            // 空 keepIds 的全表清理由壳层守卫（confirm_empty）把关；
            // 库层仍执行宽限期保护（近宽限期内新建的会话保留）。
            tx.execute(
                "DELETE FROM sessions WHERE updated_at < ?1",
                rusqlite::params![grace_cutoff],
            )
            .map_err(|e| self.latch_error("cleanup_orphan_delete_all", e))?;
        } else {
            // 构造 IN (?, ?, ...) 占位符
            let placeholders: Vec<String> = (0..active_ids.len()).map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM sessions WHERE id NOT IN ({}) AND updated_at < ?{}",
                placeholders.join(", "),
                active_ids.len() + 1
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = active_ids
                .iter()
                .map(|s| s as &dyn rusqlite::ToSql)
                .collect();
            params.push(&grace_cutoff);
            tx.execute(&sql, params.as_slice())
                .map_err(|e| self.latch_error("cleanup_orphan_delete", e))?;
        }

        let total_after: i64 = tx
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .map_err(|e| self.latch_error("cleanup_orphan_count_after", e))?;

        tx.commit()
            .map_err(|e| self.latch_error("cleanup_orphan_commit", e))?;

        Ok((total_before - total_after) as usize)
    }

    /// 从 localStorage 历史数据迁移到 SQLite。
    ///
    /// - `index_json`: `crish_session_index_v1` 的 JSON 数组字符串
    /// - `bodies`: `crish_session_body_v1:<id>` → JSONL 或 JSON 数组字符串
    /// - `agents`: `crish_session_agents_v1:<id>` → JSON 数组字符串
    /// - `active_id`: `crish_active_session_v1` 的值
    /// - `folder_order`: `crish_folder_order_v1` 数组
    ///
    /// body 解析策略：先尝试 `Vec<SessionMessage>` JSON 数组，失败再走 JSONL 行解析。
    /// 整个迁移在单事务内完成，任一会话失败则回滚。
    pub fn import_from_localstorage(
        &self,
        index_json: &str,
        bodies: HashMap<String, String>,
        agents: HashMap<String, String>,
        active_id: Option<&str>,
        folder_order: &[String],
    ) -> Result<ImportStats, DbFailure> {
        let entries: Vec<SessionIndexEntry> = serde_json::from_str(index_json).map_err(|e| {
            DbFailure {
                message: format!("import_from_localstorage: parse index failed: {e}"),
                kind: DbFailureKind::ImportIndexParse,
            }
        })?;

        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("import_tx", e))?;

        let mut stats = ImportStats::default();

        for entry in &entries {
            let is_pinned: i64 = entry.is_pinned.into();
            let is_archived: i64 = entry.is_archived.into();
            let hydrated: Option<i64> = entry.hydrated_from_engine.map(|b| b.into());

            tx.execute(
                "INSERT INTO sessions (
                    id, title, folder, is_pinned, is_archived, branch_parent_id,
                    timestamp, updated_at, pinned_message_ids,
                    engine_cursor, engine_last_run_id, hydrated_from_engine
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    folder = excluded.folder,
                    is_pinned = excluded.is_pinned,
                    is_archived = excluded.is_archived,
                    branch_parent_id = excluded.branch_parent_id,
                    timestamp = excluded.timestamp,
                    updated_at = excluded.updated_at,
                    pinned_message_ids = excluded.pinned_message_ids,
                    engine_cursor = excluded.engine_cursor,
                    engine_last_run_id = excluded.engine_last_run_id,
                    hydrated_from_engine = excluded.hydrated_from_engine",
                rusqlite::params![
                    entry.id,
                    entry.title,
                    entry.folder,
                    is_pinned,
                    is_archived,
                    entry.branch_parent_id,
                    entry.timestamp,
                    entry.updated_at,
                    entry.pinned_message_ids,
                    entry.engine_cursor,
                    entry.engine_last_run_id,
                    hydrated,
                ],
            )
            .map_err(|e| self.latch_error("import_upsert_session", e))?;

            // 迁移 body
            if let Some(body_raw) = bodies.get(&entry.id) {
                let messages = parse_session_messages_flexible(body_raw);
                // 先清空已有消息（避免重复导入导致 UNIQUE 冲突）
                tx.execute(
                    "DELETE FROM session_messages WHERE session_id = ?1",
                    rusqlite::params![entry.id],
                )
                .map_err(|e| self.latch_error("import_delete_messages", e))?;

                for (seq, msg) in messages.iter().enumerate() {
                    let seq_i64 = seq as i64;
                    tx.execute(
                        "INSERT INTO session_messages (
                            session_id, seq, id, sender, text, thinking, timestamp, status,
                            stream_text_offset, thinking_time, tool_calls_json,
                            blocks_json, tool_call_results_json
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                        rusqlite::params![
                            entry.id,
                            seq_i64,
                            msg.id,
                            msg.sender,
                            msg.text,
                            msg.thinking,
                            msg.timestamp,
                            msg.status,
                            msg.stream_text_offset,
                            msg.thinking_time,
                            msg.tool_calls_json,
                            msg.blocks_json,
                            msg.tool_call_results_json,
                        ],
                    )
                    .map_err(|e| self.latch_error("import_insert_message", e))?;
                }
                stats.messages += messages.len() as u64;
            }

            // 迁移 agents
            if let Some(agents_raw) = agents.get(&entry.id) {
                let agent_list: Vec<SessionAgent> = parse_session_agents_safe(agents_raw);
                tx.execute(
                    "DELETE FROM session_agents WHERE session_id = ?1",
                    rusqlite::params![entry.id],
                )
                .map_err(|e| self.latch_error("import_delete_agents", e))?;

                for agent in &agent_list {
                    tx.execute(
                        "INSERT INTO session_agents (
                            session_id, agent_id, subagent_run_id, parent_session_id, parent_run_id,
                            parent_tool_call_id, description, mode, status, summary,
                            started_at, ended_at, depth, subagent_path_json
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                        rusqlite::params![
                            entry.id,
                            agent.id,
                            agent.subagent_run_id,
                            agent.parent_session_id,
                            agent.parent_run_id,
                            agent.parent_tool_call_id,
                            agent.description,
                            agent.mode,
                            agent.status,
                            agent.summary,
                            agent.started_at,
                            agent.ended_at,
                            agent.depth,
                            agent.subagent_path_json,
                        ],
                    )
                    .map_err(|e| self.latch_error("import_insert_agent", e))?;

                    for (seq, msg) in agent.messages.iter().enumerate() {
                        let seq_i64 = seq as i64;
                        tx.execute(
                            "INSERT INTO session_agent_messages (
                                session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
                                stream_text_offset, thinking_time, tool_calls_json,
                                blocks_json, tool_call_results_json
                            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                            rusqlite::params![
                                entry.id,
                                agent.id,
                                seq_i64,
                                msg.id,
                                msg.sender,
                                msg.text,
                                msg.thinking,
                                msg.timestamp,
                                msg.status,
                                msg.stream_text_offset,
                                msg.thinking_time,
                                msg.tool_calls_json,
                                msg.blocks_json,
                                msg.tool_call_results_json,
                            ],
                        )
                        .map_err(|e| self.latch_error("import_insert_agent_message", e))?;
                    }
                }
                stats.agents += agent_list.len() as u64;
            }

            stats.sessions += 1;
        }

        // 写入 active_session_id 到 session_meta
        if let Some(active) = active_id {
            if !active.trim().is_empty() {
                tx.execute(
                    "INSERT INTO session_meta (key, value) VALUES ('active_session_id', ?1)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    rusqlite::params![active],
                )
                .map_err(|e| self.latch_error("import_set_active", e))?;
            }
        }

        // 写入 folder_order 到 session_meta
        if !folder_order.is_empty() {
            let folder_json = serde_json::to_string(folder_order).map_err(|e| DbFailure {
                message: format!("import_from_localstorage: serialize folder_order failed: {e}"),
                kind: DbFailureKind::ImportFolderSerialize,
            })?;
            tx.execute(
                "INSERT INTO session_meta (key, value) VALUES ('folder_order', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![folder_json],
            )
            .map_err(|e| self.latch_error("import_set_folder_order", e))?;
        }

        tx.commit()
            .map_err(|e| self.latch_error("import_commit", e))?;

        Ok(stats)
    }

    /// 更新会话的 `updated_at` 为当前 epoch ms。
    pub fn touch_session(&self, session_id: &str) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "UPDATE sessions SET updated_at = strftime('%s','now') * 1000 WHERE id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("touch_session", e))?;

        Ok(())
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

/// 灵活解析会话消息：先尝试 JSON 数组，失败再走 JSONL 行解析。
/// 对齐 `sessionLocalStorage.loadSessionBody` 的兼容策略。
fn parse_session_messages_flexible(raw: &str) -> Vec<SessionMessage> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    // 路径 1：JSON 数组
    if trimmed.starts_with('[') {
        if let Ok(msgs) = serde_json::from_str::<Vec<SessionMessage>>(trimmed) {
            return msgs;
        }
    }

    // 路径 2：JSONL（每行一条 JSON）
    let mut out = Vec::new();
    for line in trimmed.split('\n') {
        let line_trimmed = line.trim();
        if line_trimmed.is_empty() {
            continue;
        }
        if let Ok(msg) = serde_json::from_str::<SessionMessage>(line_trimmed) {
            out.push(msg);
        }
    }
    out
}

/// 宽容解析 agent 数组：坏元素跳过，整体不失败。
fn parse_session_agents_safe(raw: &str) -> Vec<SessionAgent> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<SessionAgent>>(trimmed).unwrap_or_default()
}

#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub session_id: String,
    pub sequence: i64,
    pub event_type: String,
    pub payload: String,
    pub created_at: String,
}

// ════════════════════════════════════════════════════════════════════
// 临时验证垫片（R6 落地后删除）：run 生命周期 + 待处理输入 + 会话级
// 序列号计数器——orchestrator persist/restore 层消费的最小 API 面。
// ════════════════════════════════════════════════════════════════════

/// run 状态字面量（对齐 restore.rs 快照 / frontend RunStatus 契约）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Queued,
    Initializing,
    Running,
    AwaitingApproval,
    /// 收口中（AgentStop / MaxTurns / GoalComplete 后，finalize 前）
    Completing,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    /// 状态字面量（runs.status 列存储值）
    pub fn as_str(&self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Initializing => "initializing",
            RunStatus::Running => "running",
            RunStatus::AwaitingApproval => "awaiting-approval",
            RunStatus::Completing => "completing",
            RunStatus::Cancelling => "cancelling",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }
}

/// RunStatus 字面量解析错误（restore.rs:211 消费 `e.message` 字段）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseRunStatusError {
    pub message: String,
}

impl FromStr for RunStatus {
    type Err = ParseRunStatusError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(RunStatus::Queued),
            "initializing" => Ok(RunStatus::Initializing),
            "running" => Ok(RunStatus::Running),
            "awaiting-approval" => Ok(RunStatus::AwaitingApproval),
            "completing" => Ok(RunStatus::Completing),
            "cancelling" => Ok(RunStatus::Cancelling),
            "completed" => Ok(RunStatus::Completed),
            "failed" => Ok(RunStatus::Failed),
            "cancelled" => Ok(RunStatus::Cancelled),
            other => Err(ParseRunStatusError {
                message: format!("unknown run status: {other}"),
            }),
        }
    }
}

impl std::fmt::Display for RunStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// run 记录行（persist.rs `Store::query_runs` 返回）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRun {
    pub run_id: String,
    pub session_id: String,
    pub status: RunStatus,
    pub end_reason: Option<String>,
    pub cursor: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 待处理输入行（persist.rs `Store::load_pending_inputs` 返回）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInput {
    pub id: String,
    pub session_id: String,
    pub run_id: Option<String>,
    pub payload: String,
    pub created_at: i64,
}

impl LocalDb {
    /// 插入（或覆盖）一条 run 记录。
    pub fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let now = now_millis();
        conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                run_id,
                session_id,
                status.as_str(),
                end_reason,
                cursor,
                now,
                now
            ],
        )
        .map_err(|e| self.latch_error("insert_run", e))?;
        Ok(())
    }

    /// 更新 run 状态（end_reason 为 None 时保留旧值；cursor 为 Some 时写入）。
    pub fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "UPDATE runs SET
                status = ?2,
                end_reason = COALESCE(?3, end_reason),
                cursor = COALESCE(?4, cursor),
                updated_at = ?5
             WHERE run_id = ?1",
            rusqlite::params![
                run_id,
                status.as_str(),
                end_reason,
                cursor,
                now_millis()
            ],
        )
        .map_err(|e| self.latch_error("update_run_status", e))?;
        Ok(())
    }

    /// 按 run_id 读取单条记录（persist.rs 测试用）。
    pub fn get_run(&self, run_id: &str) -> Result<Option<StoredRun>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.query_row(
            "SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at
             FROM runs WHERE run_id = ?1",
            rusqlite::params![run_id],
            map_run_row,
        )
        .optional()
        .map_err(|e| self.latch_error("get_run", e))
    }

    /// 读取全部 run 记录（按创建时间升序）。
    pub fn query_all_runs(&self) -> Result<Vec<StoredRun>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT run_id, session_id, status, end_reason, cursor, created_at, updated_at
                 FROM runs ORDER BY created_at ASC",
            )
            .map_err(|e| self.latch_error("query_all_runs_prepare", e))?;
        let rows = stmt
            .query_map([], map_run_row)
            .map_err(|e| self.latch_error("query_all_runs_map", e))?;
        let mut runs = Vec::new();
        for row in rows {
            runs.push(row.map_err(|e| self.latch_error("query_all_runs_row", e))?);
        }
        Ok(runs)
    }

    /// 会话级序列号原子取号（T08.12 Q23：store 端自增；首次取号按库内
    /// max(sequence)+1 对齐——首个待发号即 max+1，取号后计数器 +1）。
    pub fn reserve_sequence(&self, session_id: &str) -> Result<i64, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        // 首次：以已落库 max(sequence)+1 建行（隐式预热）——该值即首个待发号
        conn.execute(
            "INSERT OR IGNORE INTO session_sequence (session_id, next_sequence)
             SELECT ?1, COALESCE((SELECT MAX(sequence) FROM events WHERE session_id = ?1), 0) + 1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("reserve_sequence_seed", e))?;
        // 读当前待发号（单连接互斥下「读 + 写」等效单语句原子性）
        let sequence = conn
            .query_row(
                "SELECT next_sequence FROM session_sequence WHERE session_id = ?1",
                rusqlite::params![session_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| self.latch_error("reserve_sequence_read", e))?;
        conn.execute(
            "UPDATE session_sequence SET next_sequence = next_sequence + 1
             WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("reserve_sequence_bump", e))?;
        Ok(sequence)
    }

    /// 会话级序列号预热校准（MAX 语义：只抬高不回退，幂等；
    /// seed(n) 后下次取号返回 n）。
    pub fn seed_sequence(&self, session_id: &str, next_sequence: i64) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "INSERT OR IGNORE INTO session_sequence (session_id, next_sequence) VALUES (?1, 1)",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("seed_sequence_seed", e))?;
        conn.execute(
            "UPDATE session_sequence
             SET next_sequence = MAX(next_sequence, ?2)
             WHERE session_id = ?1",
            rusqlite::params![session_id, next_sequence],
        )
        .map_err(|e| self.latch_error("seed_sequence_set", e))?;
        Ok(())
    }

    /// 保存一条待处理输入（按 id 幂等覆盖）。
    pub fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "INSERT OR REPLACE INTO pending_inputs (id, session_id, run_id, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, session_id, run_id, payload, now_millis()],
        )
        .map_err(|e| self.latch_error("save_pending_input", e))?;
        Ok(())
    }

    /// 加载某会话的全部待处理输入（FIFO：创建时间升序，含 id 决胜）。
    pub fn load_pending_inputs(&self, session_id: &str) -> Result<Vec<PendingInput>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, run_id, payload, created_at
                 FROM pending_inputs WHERE session_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|e| self.latch_error("load_pending_inputs_prepare", e))?;
        let rows = stmt
            .query_map(rusqlite::params![session_id], |row| {
                Ok(PendingInput {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    run_id: row.get(2)?,
                    payload: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| self.latch_error("load_pending_inputs_map", e))?;
        let mut inputs = Vec::new();
        for row in rows {
            inputs.push(row.map_err(|e| self.latch_error("load_pending_inputs_row", e))?);
        }
        Ok(inputs)
    }

    /// 删除一条待处理输入（返回是否实际删除了行）。
    pub fn delete_pending_input(&self, id: &str) -> Result<bool, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let deleted = conn
            .execute("DELETE FROM pending_inputs WHERE id = ?1", rusqlite::params![id])
            .map_err(|e| self.latch_error("delete_pending_input", e))?;
        Ok(deleted > 0)
    }
}

/// runs 行 → StoredRun 映射（status 字面量解析失败按 Unknown 兜底）
fn map_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRun> {
    let status_str: String = row.get(2)?;
    let status = RunStatus::from_str(&status_str).unwrap_or(RunStatus::Failed);
    Ok(StoredRun {
        run_id: row.get(0)?,
        session_id: row.get(1)?,
        status,
        end_reason: row.get(3)?,
        cursor: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// 当前 UTC 毫秒时间戳（epoch ms；runs / pending_inputs 时间列）
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_and_migrate() {
        let db = LocalDb::open_in_memory().unwrap();
        assert!(db.get_failure().is_none());
    }

    #[test]
    fn insert_and_query_session() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "Test Session").unwrap();

        // Inserting same session again should not error (OR IGNORE)
        db.insert_session("s1", "Duplicate").unwrap();
    }

    #[test]
    fn append_and_query_events() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "Session").unwrap();

        db.append_event("s1", 1, "user-message", r#"{"text":"hello"}"#).unwrap();
        db.append_event("s1", 2, "assistant-message", r#"{"text":"hi"}"#).unwrap();
        db.append_event("s1", 3, "tool-call", r#"{"name":"search"}"#).unwrap();

        // Query all events (无限制)
        let events = db.query_events("s1", 0, None).unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].event_type, "user-message");
        assert_eq!(events[2].sequence, 3);

        // Query after sequence 1
        let events_after = db.query_events("s1", 1, None).unwrap();
        assert_eq!(events_after.len(), 2);
        assert_eq!(events_after[0].sequence, 2);
    }

    #[test]
    fn query_events_respects_limit() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "Session").unwrap();

        for i in 1..=5 {
            db.append_event("s1", i, "event", "{}").unwrap();
        }

        let limited = db.query_events("s1", 0, Some(3)).unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].sequence, 1);
        assert_eq!(limited[2].sequence, 3);
    }

    #[test]
    fn query_events_empty_session() {
        let db = LocalDb::open_in_memory().unwrap();
        let events = db.query_events("nonexistent", 0, None).unwrap();
        assert!(events.is_empty());
    }

    #[test]
    fn duplicate_event_sequence_fails() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "Session").unwrap();
        db.append_event("s1", 1, "msg", "{}").unwrap();

        // Same session_id + sequence should fail (UNIQUE constraint)
        let result = db.append_event("s1", 1, "msg2", "{}");
        assert!(result.is_err());
        // Failure latch should be set
        assert!(db.get_failure().is_some());
    }

    #[test]
    fn concurrent_access() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "Session").unwrap();

        let db_arc = Arc::new(db);
        let mut handles = vec![];

        for i in 0..10 {
            let db_clone = Arc::clone(&db_arc);
            handles.push(std::thread::spawn(move || {
                db_clone
                    .append_event("s1", i + 1, "event", &format!(r#"{{"i":{i}}}"#))
                    .unwrap();
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let events = db_arc.query_events("s1", 0, None).unwrap();
        assert_eq!(events.len(), 10);
    }

    // ===== Stream B 新增测试 =====

    fn sample_entry(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            id: id.to_string(),
            title: format!("Title {id}"),
            folder: "常规会话".to_string(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            updated_at: 1000,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: None,
            engine_last_run_id: None,
            hydrated_from_engine: None,
        }
    }

    fn sample_message(id: &str, sender: &str, ts: i64) -> SessionMessage {
        SessionMessage {
            id: id.to_string(),
            sender: sender.to_string(),
            text: Some(format!("text-{id}")),
            thinking: None,
            timestamp: ts,
            status: Some("completed".to_string()),
            stream_text_offset: None,
            thinking_time: None,
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
        }
    }

    #[test]
    fn upsert_and_list_sessions() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.upsert_session_entry(&sample_entry("s2")).unwrap();

        let list = db.list_sessions().unwrap();
        assert_eq!(list.len(), 2);
        // updated_at 相同，按 id 升序
        assert_eq!(list[0].id, "s1");
        assert_eq!(list[1].id, "s2");
    }

    #[test]
    fn upsert_does_not_cascade_delete_messages() {
        // INSERT OR REPLACE 会触发 ON DELETE CASCADE，必须用 ON CONFLICT DO UPDATE
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body(
            "s1",
            &[sample_message("m1", "user", 1), sample_message("m2", "assistant", 2)],
        )
        .unwrap();

        // 再次 upsert 同一会话，不应丢失消息
        let mut entry = sample_entry("s1");
        entry.title = "Updated Title".to_string();
        db.upsert_session_entry(&entry).unwrap();

        let body = db.load_session_body("s1").unwrap();
        assert_eq!(body.len(), 2, "messages must survive upsert");
        assert_eq!(db.list_sessions().unwrap()[0].title, "Updated Title");
    }

    #[test]
    fn save_and_load_session_body() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();

        let msgs = vec![
            sample_message("m1", "user", 100),
            sample_message("m2", "assistant", 200),
            sample_message("m3", "user", 300),
        ];
        db.save_session_body("s1", &msgs).unwrap();

        let loaded = db.load_session_body("s1").unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0].id, "m1");
        assert_eq!(loaded[2].id, "m3");
        assert_eq!(loaded[1].sender, "assistant");
    }

    #[test]
    fn save_session_body_replaces() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body("s1", &[sample_message("m1", "user", 1)]).unwrap();
        // 再次保存覆盖
        db.save_session_body(
            "s1",
            &[sample_message("m2", "user", 2), sample_message("m3", "assistant", 3)],
        )
        .unwrap();

        let loaded = db.load_session_body("s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "m2");
    }

    #[test]
    fn append_session_messages_increments_seq() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body("s1", &[sample_message("m1", "user", 1)]).unwrap();

        db.append_session_messages(
            "s1",
            &[sample_message("m2", "assistant", 2), sample_message("m3", "user", 3)],
        )
        .unwrap();

        let loaded = db.load_session_body("s1").unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[2].id, "m3");
    }

    #[test]
    fn trigger_maintains_message_count() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body(
            "s1",
            &[sample_message("m1", "user", 1), sample_message("m2", "assistant", 2)],
        )
        .unwrap();

        let list = db.list_sessions().unwrap();
        assert_eq!(list[0].message_count, 2);

        db.append_session_messages("s1", &[sample_message("m3", "user", 3)]).unwrap();
        let list2 = db.list_sessions().unwrap();
        assert_eq!(list2[0].message_count, 3);

        // save_session_body 替换为 1 条：先 delete(-2) 再 insert(+1) = -1
        db.save_session_body("s1", &[sample_message("m-only", "user", 10)]).unwrap();
        let list3 = db.list_sessions().unwrap();
        assert_eq!(list3[0].message_count, 1);
    }

    #[test]
    fn delete_session_cascades() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.save_session_body("s1", &[sample_message("m1", "user", 1)]).unwrap();
        db.save_session_agents(
            "s1",
            &[SessionAgent {
                id: "a1".into(),
                subagent_run_id: "run-1".into(),
                parent_session_id: "s1".into(),
                parent_run_id: "prun-1".into(),
                parent_tool_call_id: None,
                description: "test".into(),
                mode: "explore".into(),
                status: "completed".into(),
                summary: None,
                messages: vec![sample_message("am1", "assistant", 1)],
                started_at: 0,
                ended_at: Some(100),
                depth: Some(0),
                subagent_path_json: None,
            }],
        )
        .unwrap();

        db.delete_session("s1").unwrap();

        // 级联：messages / agents / agent_messages 应全部被清除
        assert!(db.load_session_body("s1").unwrap().is_empty());
        assert!(db.load_session_agents("s1").unwrap().is_empty());
        assert!(db.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn save_and_load_session_agents() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();

        let agents = vec![
            SessionAgent {
                id: "a1".into(),
                subagent_run_id: "run-1".into(),
                parent_session_id: "s1".into(),
                parent_run_id: "prun-1".into(),
                parent_tool_call_id: Some("tc-1".into()),
                description: "explore".into(),
                mode: "explore".into(),
                status: "completed".into(),
                summary: Some("done".into()),
                messages: vec![sample_message("am1", "assistant", 1)],
                started_at: 100,
                ended_at: Some(200),
                depth: Some(0),
                subagent_path_json: Some(r#"["a1"]"#.into()),
            },
            SessionAgent {
                id: "a2".into(),
                subagent_run_id: "run-2".into(),
                parent_session_id: "s1".into(),
                parent_run_id: "prun-2".into(),
                parent_tool_call_id: None,
                description: "implement".into(),
                mode: "implement".into(),
                status: "running".into(),
                summary: None,
                messages: vec![],
                started_at: 300,
                ended_at: None,
                depth: Some(1),
                subagent_path_json: None,
            },
        ];
        db.save_session_agents("s1", &agents).unwrap();

        let loaded = db.load_session_agents("s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "a1");
        assert_eq!(loaded[0].messages.len(), 1);
        assert_eq!(loaded[0].summary.as_deref(), Some("done"));
        assert_eq!(loaded[1].id, "a2");
        assert!(loaded[1].messages.is_empty());
    }

    #[test]
    fn session_meta_roundtrip() {
        let db = LocalDb::open_in_memory().unwrap();
        assert!(db.get_session_meta("missing").unwrap().is_none());

        db.set_session_meta("schema_version", "2").unwrap();
        assert_eq!(db.get_session_meta("schema_version").unwrap().as_deref(), Some("2"));

        // 再次 set 应 upsert
        db.set_session_meta("schema_version", "3").unwrap();
        assert_eq!(db.get_session_meta("schema_version").unwrap().as_deref(), Some("3"));
    }

    #[test]
    fn schema_version_is_four() {
        let db = LocalDb::open_in_memory().unwrap();
        let v = db
            .get_session_meta("schema_version")
            .unwrap()
            .expect("schema_version should be set by migrate()");
        assert_eq!(v, SCHEMA_VERSION_STRING);
    }

    #[test]
    fn cleanup_orphan_sessions() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.upsert_session_entry(&sample_entry("s2")).unwrap();
        db.upsert_session_entry(&sample_entry("s3")).unwrap();

        let deleted = db.cleanup_orphan_sessions(&["s1".to_string()]).unwrap();
        assert_eq!(deleted, 2);

        let list = db.list_sessions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "s1");
    }

    #[test]
    fn cleanup_orphan_all_when_active_empty() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();
        db.upsert_session_entry(&sample_entry("s2")).unwrap();

        let deleted = db.cleanup_orphan_sessions(&[]).unwrap();
        assert_eq!(deleted, 2);
        assert!(db.list_sessions().unwrap().is_empty());
    }

    #[test]
    fn touch_session_updates_timestamp() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&sample_entry("s1")).unwrap();

        // touch 后 updated_at 应不小于原始 1000
        db.touch_session("s1").unwrap();
        let list = db.list_sessions().unwrap();
        assert!(list[0].updated_at >= 1000);
    }

    #[test]
    fn import_from_localstorage_json_array_body() {
        let db = LocalDb::open_in_memory().unwrap();

        let index = serde_json::json!([{
            "id": "s1",
            "title": "Imported",
            "folder": "work",
            "isPinned": true,
            "isArchived": false,
            "timestamp": "2026-01-01T00:00:00Z",
            "updatedAt": 1500,
            "messageCount": 2,
        }])
        .to_string();

        let body = serde_json::json!([
            {"id": "m1", "sender": "user", "text": "hi", "timestamp": 100},
            {"id": "m2", "sender": "assistant", "text": "hello", "timestamp": 200},
        ])
        .to_string();

        let agents = serde_json::json!([{
            "id": "a1",
            "subagentRunId": "run-1",
            "parentSessionId": "s1",
            "parentRunId": "prun-1",
            "description": "explore",
            "mode": "explore",
            "status": "completed",
            "messages": [],
            "startedAt": 0,
        }])
        .to_string();

        let mut bodies = HashMap::new();
        bodies.insert("s1".to_string(), body);
        let mut agents_map = HashMap::new();
        agents_map.insert("s1".to_string(), agents);

        let stats = db
            .import_from_localstorage(
                &index,
                bodies,
                agents_map,
                Some("s1"),
                &["work".to_string(), "常规会话".to_string()],
            )
            .unwrap();

        assert_eq!(stats.sessions, 1);
        assert_eq!(stats.messages, 2);
        assert_eq!(stats.agents, 1);

        let list = db.list_sessions().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "s1");
        assert_eq!(list[0].title, "Imported");
        assert!(list[0].is_pinned);

        let body_loaded = db.load_session_body("s1").unwrap();
        assert_eq!(body_loaded.len(), 2);
        assert_eq!(body_loaded[0].id, "m1");

        let agents_loaded = db.load_session_agents("s1").unwrap();
        assert_eq!(agents_loaded.len(), 1);
        assert_eq!(agents_loaded[0].id, "a1");

        assert_eq!(
            db.get_session_meta("active_session_id").unwrap().as_deref(),
            Some("s1")
        );
        let folder = db.get_session_meta("folder_order").unwrap().expect("folder_order");
        assert!(folder.contains("work"));
    }

    #[test]
    fn import_from_localstorage_jsonl_body() {
        let db = LocalDb::open_in_memory().unwrap();

        let index = r#"[{"id":"s1","title":"JL","updatedAt":1,"messageCount":2}]"#.to_string();
        // JSONL 格式：每行一条消息
        let body = r#"{"id":"m1","sender":"user","text":"hi","timestamp":100}
{"id":"m2","sender":"assistant","text":"hello","timestamp":200}"#
            .to_string();

        let mut bodies = HashMap::new();
        bodies.insert("s1".to_string(), body);

        let stats = db
            .import_from_localstorage(&index, bodies, HashMap::new(), None, &[])
            .unwrap();

        assert_eq!(stats.sessions, 1);
        assert_eq!(stats.messages, 2);

        let body_loaded = db.load_session_body("s1").unwrap();
        assert_eq!(body_loaded.len(), 2);
        assert_eq!(body_loaded[1].id, "m2");
    }

    #[test]
    fn import_from_localstorage_idempotent() {
        let db = LocalDb::open_in_memory().unwrap();
        let index = r#"[{"id":"s1","title":"T","updatedAt":1,"messageCount":1}]"#.to_string();
        let body = r#"[{"id":"m1","sender":"user","text":"hi","timestamp":100}]"#.to_string();
        let mut bodies = HashMap::new();
        bodies.insert("s1".to_string(), body);

        // 第一次导入
        db.import_from_localstorage(&index, bodies.clone(), HashMap::new(), None, &[])
            .unwrap();
        // 第二次导入（应幂等，不报错不重复）
        db.import_from_localstorage(&index, bodies, HashMap::new(), None, &[])
            .unwrap();

        let body_loaded = db.load_session_body("s1").unwrap();
        assert_eq!(body_loaded.len(), 1);
    }

    #[test]
    fn parse_session_messages_flexible_handles_empty() {
        assert!(parse_session_messages_flexible("").is_empty());
        assert!(parse_session_messages_flexible("   \n  ").is_empty());
    }

    #[test]
    fn parse_session_messages_flexible_handles_bad_jsonl() {
        let raw = "not json\n{\"id\":\"m1\",\"sender\":\"user\",\"timestamp\":1}\nalso bad";
        let msgs = parse_session_messages_flexible(raw);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "m1");
    }
}
