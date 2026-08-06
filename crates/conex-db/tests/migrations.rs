//! T08.7 迁移矩阵集成测试（AA-07 P07 缺口补齐）：
//! 手工构造 v1/v2/v3 fixture（含脏数据）→ `LocalDb::open` → 断言到达 v4、
//! 数据保留、events 组合主键 + FK、metadata 删除、runs/pending FK、
//! session_messages.updated_at、DROP 前备份文件、二次 open 幂等。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use conex_db::{LocalDb, LATEST_VERSION, SCHEMA_VERSION_STRING};
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
            "conex-migration-{name}-{}-{n}",
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

fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(|c| c.ok())
        .collect()
}

fn table_sql(conn: &Connection, table: &str) -> String {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
        rusqlite::params![table],
        |r| r.get::<_, Option<String>>(0),
    )
    .unwrap()
    .unwrap_or_default()
}

fn has_fk(conn: &Connection, table: &str) -> bool {
    let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_list({table})")).unwrap();
    let mut rows = stmt.query([]).unwrap();
    rows.next().unwrap().is_some()
}

fn count_rows(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

// ══════════ v1 fixture（初始形态：sessions 无 folder、agent_messages 无 CHECK）══════════

fn build_v1_fixture(db: &TempDb) {
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
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE session_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            id TEXT NOT NULL,
            sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
            text TEXT,
            thinking TEXT,
            timestamp INTEGER NOT NULL,
            status TEXT CHECK (status IN ('queued','processing','completed','error')),
            PRIMARY KEY (session_id, seq)
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
            PRIMARY KEY (session_id, agent_id)
        ) WITHOUT ROWID;
        CREATE TABLE session_agent_messages (
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
        CREATE TABLE session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (
                'queued','initializing','running','awaiting-approval',
                'cancelling','completing','completed','failed','cancelled'
            )),
            end_reason TEXT,
            cursor INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE pending_inputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        INSERT INTO sessions (id, title, timestamp, updated_at, message_count, created_at)
            VALUES ('s1', 'V1 会话', '2026-01-01T00:00:00Z', 1000, 1, 2000);
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp)
            VALUES ('s1', 0, 'm1', 'user', '你好', 500);
        INSERT INTO session_agents (session_id, agent_id, subagent_run_id, parent_session_id,
            parent_run_id, description, mode, status, started_at)
            VALUES ('s1', 'a1', 'r-a1', 's1', 'p1', '探索', 'explore', 'completed', 600);
        INSERT INTO session_agent_messages (session_id, agent_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 'a1', 0, 'am1', 'assistant', '子代理消息', 700, 'completed');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 1, 'agent-start', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 2, 'agent-end', '{}');
        INSERT INTO metadata (key, value) VALUES ('legacy', 'dead');
        INSERT INTO runs (run_id, session_id, status, cursor) VALUES ('r1', 's1', 'completed', 2);
        INSERT INTO pending_inputs (id, session_id, run_id, payload) VALUES ('p1', 's1', 'r1', '{}');
        PRAGMA user_version = 1;",
    )
    .unwrap();
}

/// v2 fixture：sessions 已含 folder（v2 形状），但 agent_messages 仍无 CHECK。
fn build_v2_fixture(db: &TempDb) {
    let conn = Connection::open(db.path()).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
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
            created_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE session_messages (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL,
            id TEXT NOT NULL,
            sender TEXT NOT NULL CHECK (sender IN ('user','assistant')),
            text TEXT,
            timestamp INTEGER NOT NULL,
            status TEXT CHECK (status IN ('queued','processing','completed','error')),
            PRIMARY KEY (session_id, seq)
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
            PRIMARY KEY (session_id, agent_id)
        ) WITHOUT ROWID;
        CREATE TABLE session_agent_messages (
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
        CREATE TABLE session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            end_reason TEXT,
            cursor INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE pending_inputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        INSERT INTO sessions (id, title, folder, updated_at, created_at)
            VALUES ('s1', 'V2 会话', '工作', 1500, 2500);
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp)
            VALUES ('s1', 0, 'm1', 'user', 'v2 消息', 800);
        INSERT INTO session_agents (session_id, agent_id, subagent_run_id, parent_session_id,
            parent_run_id, description, mode, status, started_at)
            VALUES ('s1', 'a1', 'r-a1', 's1', 'p1', '探索', 'explore', 'completed', 900);
        INSERT INTO session_agent_messages (session_id, agent_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 'a1', 0, 'am1', 'assistant', 'v2 子代理', 950, 'completed');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 1, 'agent-start', '{}');
        INSERT INTO runs (run_id, session_id, status, cursor) VALUES ('r1', 's1', 'completed', 1);
        PRAGMA user_version = 2;",
    )
    .unwrap();
}

/// v3 fixture（当前生产形态 + user_version=3）：events 含 AUTOINCREMENT id、
/// metadata 存在、runs/pending 无 FK、session_messages 无 updated_at、
/// agent_messages 已带 CHECK、session_sequence 已存在（T08.12）。
/// 含孤儿残留（events/runs/pending 指向已删除会话）验证 v4 过滤。
fn build_v3_fixture(db: &TempDb) {
    let conn = Connection::open(db.path()).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(
        "CREATE TABLE sessions (
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
            created_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, sequence);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE session_messages (
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
            PRIMARY KEY (session_id, agent_id)
        ) WITHOUT ROWID;
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
        CREATE TABLE session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
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
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (
                'queued','initializing','running','awaiting-approval',
                'cancelling','completing','completed','failed','cancelled'
            )),
            end_reason TEXT,
            cursor INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
        CREATE TABLE pending_inputs (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_pending_inputs_session ON pending_inputs(session_id, created_at);
        CREATE TABLE session_sequence (
            session_id TEXT PRIMARY KEY,
            next_seq INTEGER NOT NULL DEFAULT 1
        ) WITHOUT ROWID;
        INSERT INTO sessions (id, title, folder, updated_at, created_at)
            VALUES ('s1', 'V3 会话', '生产', 2000, 3000);
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 0, 'm1', 'user', 'v3 消息', 1000, 'completed');
        INSERT INTO session_agents (session_id, agent_id, subagent_run_id, parent_session_id,
            parent_run_id, description, mode, status, started_at)
            VALUES ('s1', 'a1', 'r-a1', 's1', 'p1', '探索', 'explore', 'completed', 1100);
        INSERT INTO session_agent_messages (session_id, agent_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 'a1', 0, 'am1', 'assistant', 'v3 子代理', 1150, 'completed');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 1, 'agent-start', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 2, 'run-terminal', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('ghost', 5, 'agent-start', '{}');
        INSERT INTO metadata (key, value) VALUES ('legacy', 'dead');
        INSERT INTO runs (run_id, session_id, status, cursor) VALUES ('r1', 's1', 'completed', 2);
        INSERT INTO runs (run_id, session_id, status, cursor) VALUES ('r-ghost', 'ghost', 'failed', 5);
        INSERT INTO pending_inputs (id, session_id, run_id, payload) VALUES ('p1', 's1', 'r1', '{}');
        INSERT INTO pending_inputs (id, session_id, run_id, payload) VALUES ('p-ghost', 'ghost', NULL, '{}');
        INSERT INTO session_sequence (session_id, next_seq) VALUES ('s1', 3);
        PRAGMA user_version = 3;",
    )
    .unwrap();
}

/// 生产真实路径：v3 生产形态但 user_version = 0（旧代码从不写 user_version，
/// 靠检测迁移——v1..v4 全链必须幂等跳过已满足版本）。
fn build_production_shape_v0_fixture(db: &TempDb) {
    build_v3_fixture(db);
    let conn = Connection::open(db.path()).unwrap();
    conn.execute_batch("PRAGMA user_version = 0;").unwrap();
}

/// 断言 v4 终态形态 + 数据保留。
fn assert_v4_state(db: &LocalDb, temp: &TempDb) {
    let conn = Connection::open(temp.path()).unwrap();
    // 版本与计数
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING),
        "schema_version 计数值修正为 '4'"
    );
    // events：组合主键（无 id 列）+ FK
    let events_cols = table_columns(&conn, "events");
    assert!(!events_cols.contains(&"id".to_string()), "AUTOINCREMENT id 已删除（P14）");
    for c in ["session_id", "sequence", "event_type", "payload", "created_at"] {
        assert!(events_cols.contains(&c.to_string()), "events 缺列 {c}");
    }
    assert!(has_fk(&conn, "events"), "events 有 sessions FK（P03）");
    // metadata 删除（P12）
    let meta_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='metadata'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(meta_exists, 0, "metadata 死表已删除");
    // runs / pending_inputs FK
    assert!(has_fk(&conn, "runs"), "runs 有 sessions FK");
    assert!(has_fk(&conn, "pending_inputs"), "pending_inputs 有 sessions FK");
    // session_messages.updated_at（D4 乐观锁预留）
    assert!(table_columns(&conn, "session_messages").contains(&"updated_at".to_string()));
    // session_sequence 存在（T08.12）
    assert!(table_columns(&conn, "session_sequence").contains(&"session_id".to_string()));
    // 备份文件存在
    let backups = backup_files(temp.path());
    assert!(!backups.is_empty(), "DROP 前备份文件必须存在");
    assert!(backups.len() <= 2, "备份最多保留最近 2 份，实际: {backups:?}");
}

#[test]
fn v1_fixture_upgrades_to_v4_data_preserved() {
    let temp = TempDb::new("v1");
    build_v1_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_v4_state(&db, &temp);

    // 数据保留：sessions（id/title/created_at 拷贝）+ messages + agents + events + runs + pending
    let conn = Connection::open(temp.path()).unwrap();
    let (title, created_at): (String, i64) = conn
        .query_row("SELECT title, created_at FROM sessions WHERE id='s1'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(title, "V1 会话", "v1 标题保留");
    assert_eq!(created_at, 2000, "created_at 保留");
    assert_eq!(count_rows(&conn, "session_messages"), 1);
    assert_eq!(count_rows(&conn, "session_agents"), 1);
    assert_eq!(count_rows(&conn, "session_agent_messages"), 1, "v3 重建拷贝 agent 消息");
    assert_eq!(count_rows(&conn, "events"), 2, "v4 重建拷贝事件");
    assert_eq!(count_rows(&conn, "runs"), 1);
    assert_eq!(count_rows(&conn, "pending_inputs"), 1);
    // 触发器重建后 message_count 维护正常
    let mc: i64 = conn
        .query_row("SELECT message_count FROM sessions WHERE id='s1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mc, 1, "触发器在 v2 重建后仍工作");
}

#[test]
fn v2_fixture_adds_check_and_upgrades_to_v4() {
    let temp = TempDb::new("v2");
    build_v2_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_v4_state(&db, &temp);

    let conn = Connection::open(temp.path()).unwrap();
    // v3 目标：status CHECK 已加 + 数据保留
    assert!(
        table_sql(&conn, "session_agent_messages").contains("CHECK (status IN"),
        "v2→v3 重建补 CHECK"
    );
    assert_eq!(count_rows(&conn, "session_agent_messages"), 1, "重建拷贝数据");
    assert_eq!(count_rows(&conn, "sessions"), 1);
    let folder: String = conn
        .query_row("SELECT folder FROM sessions WHERE id='s1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(folder, "工作", "v2 已有 folder 不被覆盖");
    assert_eq!(count_rows(&conn, "events"), 1);
}

#[test]
fn v3_fixture_production_shape_upgrades_to_v4() {
    let temp = TempDb::new("v3");
    build_v3_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_v4_state(&db, &temp);

    let conn = Connection::open(temp.path()).unwrap();
    // 数据保留（含孤儿过滤）
    assert_eq!(count_rows(&conn, "sessions"), 1);
    assert_eq!(count_rows(&conn, "events"), 2, "孤儿事件（ghost 会话）被过滤，正常事件保留");
    assert_eq!(count_rows(&conn, "runs"), 1, "孤儿 run 被过滤");
    assert_eq!(count_rows(&conn, "pending_inputs"), 1, "孤儿 pending 被过滤");
    // 孤儿丢弃可观测
    let orphans: String = conn
        .query_row(
            "SELECT value FROM session_meta WHERE key='migration_v4_dropped_orphans'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphans, "1:1:1", "孤儿计数 events:runs:pending");
    // FK 级联：删除会话 → 事件级联清理（P03）
    db.delete_session("s1").unwrap();
    assert_eq!(count_rows(&conn, "events"), 0, "events FK 级联删除生效");
}

#[test]
fn production_shape_with_user_version_zero_detects_and_upgrades() {
    // 真实生产路径：旧代码从不写 PRAGMA user_version（恒 0），
    // v1..v4 检测链必须幂等跳过已满足版本并完成 v4。
    let temp = TempDb::new("v0");
    build_production_shape_v0_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_v4_state(&db, &temp);
    let conn = Connection::open(temp.path()).unwrap();
    assert_eq!(count_rows(&conn, "events"), 2, "v0 检测路径数据保留");
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING)
    );
}

#[test]
fn second_open_idempotent_no_extra_backups() {
    let temp = TempDb::new("idem");
    build_v3_fixture(&temp);

    let db1 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db1.user_version().unwrap(), LATEST_VERSION);
    let backups_after_first = backup_files(temp.path()).len();

    // 二次 open：无重复迁移、无备份堆积
    let db2 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    let backups_after_second = backup_files(temp.path()).len();
    assert_eq!(
        backups_after_second, backups_after_first,
        "二次 open 不产生新备份"
    );
    assert!(backups_after_second <= 2, "备份不堆积");

    // 数据稳定
    let conn = Connection::open(temp.path()).unwrap();
    assert_eq!(count_rows(&conn, "events"), 2);
    assert_eq!(count_rows(&conn, "sessions"), 1);
}

#[test]
fn backup_file_contains_pre_migration_data() {
    // DROP 前备份可读且含迁移前数据（v3 形态：events 仍有 id 列、user_version=3）
    let temp = TempDb::new("bak");
    build_v3_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    let backups = backup_files(temp.path());
    assert_eq!(backups.len(), 1, "v3→v4 只产生 .bak-v4");
    let (v, path) = &backups[0];
    assert_eq!(*v, 4);

    let bak = Connection::open(path).unwrap();
    let uv: i32 = bak.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(uv, 3, "备份快照在 v4 迁移前（user_version=3）");
    let events_cols = table_columns(&bak, "events");
    assert!(events_cols.contains(&"id".to_string()), "备份中 events 仍是旧形态（含 id）");
    assert_eq!(count_rows(&bak, "events"), 3, "备份含迁移前全部事件（含孤儿）");
    assert_eq!(count_rows(&bak, "sessions"), 1);
    assert!(table_columns(&bak, "metadata").contains(&"key".to_string()), "备份含 metadata 表");
}

#[test]
fn fresh_db_full_chain_reaches_v4() {
    // 全新空库：v1..v4 全链执行（v2/v3/v4 重建空表），终态 = v4
    let temp = TempDb::new("fresh");
    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    assert_v4_state(&db, &temp);
}

/// v5 fixture：目标形态库（user_version=5）——session_agents 尚无
/// task_type / display_label / allowed_write_paths_json 三列（v6 待加），
/// 其余表缺省由迁移收尾的 ensure（create_v5_schema，IF NOT EXISTS）补建。
/// 仅构造最小会话面（sessions / session_agents / 一行旧数据），验证
/// v5→v6 的纯 ADD COLUMN 幂等路径与旧库数据兼容。
fn build_v5_fixture(db: &TempDb) {
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
            PRIMARY KEY (session_id, agent_id)
        ) WITHOUT ROWID;
        CREATE TABLE session_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        INSERT INTO sessions (id, title, updated_at, created_at)
            VALUES ('s1', 'V5 会话', 2000, 3000);
        INSERT INTO session_agents (session_id, agent_id, subagent_run_id, parent_session_id,
            parent_run_id, description, mode, status, started_at, depth)
            VALUES ('s1', 'a1', 'r-a1', 's1', 'p1', '探索', 'explore', 'completed', 1100, 1);
        PRAGMA user_version = 5;",
    )
    .unwrap();
}

#[test]
fn v5_fixture_upgrades_to_v6_new_columns_read_write_idempotent() {
    // T-D-07 迁移验收：新列可读写 + 旧库兼容 + 迁移脚本幂等
    let temp = TempDb::new("v5");
    build_v5_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION, "v5 → v6 升级完成");

    // 新列存在（v6 纯 ADD COLUMN，幂等 col-check）
    let conn = Connection::open(temp.path()).unwrap();
    let agent_cols = table_columns(&conn, "session_agents");
    for c in ["task_type", "display_label", "allowed_write_paths_json"] {
        assert!(agent_cols.contains(&c.to_string()), "session_agents 缺 v6 新列 {c}");
    }
    // 旧库数据保留（旧行新列为 NULL）
    assert_eq!(count_rows(&conn, "session_agents"), 1);
    let (task_type, display_label): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT task_type, display_label FROM session_agents WHERE agent_id='a1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(task_type, None, "旧行 task_type 自动补 NULL");
    assert_eq!(display_label, None, "旧行 display_label 自动补 NULL");

    // 新列读写（公开 API 全链路）
    let mut agents = db.load_session_agents("s1").unwrap();
    assert_eq!(agents[0].id, "a1");
    agents[0].task_type = Some("analysis".to_string());
    agents[0].display_label = Some("Rust 内核分析师".to_string());
    agents[0].allowed_write_paths_json = Some(r#"["docs/notes"]"#.to_string());
    db.save_session_agents("s1", &agents).unwrap();
    let loaded = db.load_session_agents("s1").unwrap();
    assert_eq!(loaded[0].task_type.as_deref(), Some("analysis"));
    assert_eq!(loaded[0].display_label.as_deref(), Some("Rust 内核分析师"));
    assert_eq!(
        loaded[0].allowed_write_paths_json.as_deref(),
        Some(r#"["docs/notes"]"#)
    );

    // 幂等：二次 open 不重复迁移、不堆积备份、数据稳定
    let db2 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        backup_files(temp.path()).len(),
        0,
        "v6 纯 ADD COLUMN 不产生备份（v5 起点只跑 v6 一步）"
    );
    let again = db2.load_session_agents("s1").unwrap();
    assert_eq!(again[0].display_label.as_deref(), Some("Rust 内核分析师"));
    assert_eq!(again[0].allowed_write_paths_json.as_deref(), Some(r#"["docs/notes"]"#));
}

// ══════════ 11-T2 迁移备份时序确定化（checkpoint + 版本事务前备份）══════════

/// 黄金字节对比：备份内容与「迁移前显式 checkpoint(TRUNCATE) 后」主文件
/// 逐字节一致（31 文档 T2 测试要求）。时序语义锁定：备份 = 迁移前完整旧库
/// 形态的确定性拷贝（备份路径 .bak-vN 打开后 user_version == N-1 且数据为
/// 迁移前形态）；WAL 数据是否遗漏由 [backup_includes_uncheckpointed_wal_data]
/// 单独锚定（本测试场景数据量小、无 autocheckpoint，主文件本就完整）。
#[test]
fn backup_content_deterministic_golden_bytes() {
    let temp = TempDb::new("golden");
    build_v3_fixture(&temp);

    // 捕获基准字节：与迁移内同构的 WAL 化 + checkpoint(TRUNCATE) 后主文件
    let pre_bytes = {
        let conn = Connection::open(temp.path()).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        std::fs::read(temp.path()).unwrap()
    };

    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);

    let backups = backup_files(temp.path());
    assert_eq!(backups.len(), 1, "v3→v4 只产生 .bak-v4");
    let (v, path) = &backups[0];
    assert_eq!(*v, 4);

    let post_bytes = std::fs::read(path).unwrap();
    assert_eq!(
        post_bytes, pre_bytes,
        "备份必须与迁移前 checkpoint 后主文件逐字节一致（内容确定化，非 WAL 偶然）"
    );
}

/// 区分性锚定（修复前失败、修复后通过）：备份必须包含「已提交但未 checkpoint
/// 的 WAL 数据」。构造：WAL 连接插入会话后保持打开（不触发最后连接关闭的
/// 自动 checkpoint），数据仅存在于 WAL——修复前备份（无 checkpoint 直接拷贝
/// 主文件）会漏掉该数据；修复后迁移内 checkpoint(TRUNCATE) 固化后再拷贝，
/// 备份 = 完整旧库。
#[test]
fn backup_includes_uncheckpointed_wal_data() {
    let temp = TempDb::new("golden-wal");
    build_v3_fixture(&temp);

    // 持连接插入 s2：WAL 模式打开后写入，保持连接存活（WAL 残留未固化）
    let keep_open = Connection::open(temp.path()).unwrap();
    keep_open.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    keep_open
        .execute(
            "INSERT INTO sessions (id, title, updated_at, created_at)
             VALUES ('s2', 'WAL 会话', 3000, 4000)",
            [],
        )
        .unwrap();
    // 此刻主文件仍为 v3 fixture 形态（缺 s2），s2 仅存在于 WAL

    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION, "迁移完成");

    let backups = backup_files(temp.path());
    assert_eq!(backups.len(), 1, "v3→v4 只产生 .bak-v4");
    let (v, path) = &backups[0];
    assert_eq!(*v, 4);

    // 备份 = 迁移前完整旧库：含 WAL 中追加的会话（修复前会缺失）
    let bak = Connection::open(path).unwrap();
    assert_eq!(count_rows(&bak, "sessions"), 2, "备份含 WAL 追加会话 s2");
    assert_eq!(count_rows(&bak, "events"), 3, "备份含迁移前全部事件（含孤儿）");
    let uv: i32 = bak
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(uv, 3, "备份为 v4 迁移前形态");

    // 持连接清理（关闭触发自动 checkpoint，主文件补全 s2，无碍断言）
    drop(keep_open);
}

/// 统一断言：任意 `.bak-vN` 打开后 `PRAGMA user_version == N-1`
/// （备份 = 该版本迁移前形态，确定性绑定，与 autocheckpoint 无关）。
#[test]
fn every_backup_user_version_is_previous_version() {
    // v1 全链 v1→v6：v2/v3/v4 各产一份备份（v5/v6 纯 ADD COLUMN 跳过），
    // BACKUP_KEEP=2 清理后保留最近 2 份
    let temp = TempDb::new("bak-uv");
    build_v1_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);

    let backups = backup_files(temp.path());
    assert!(!backups.is_empty(), "v1 全链迁移必须产生备份");
    assert!(backups.len() <= 2, "BACKUP_KEEP=2 只保留最近 2 份");
    for (v, path) in &backups {
        let bak = Connection::open(path).unwrap();
        let uv: i32 = bak
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            uv, v - 1,
            ".bak-v{v} 必须是 v{} 形态（本版本迁移前快照）",
            v - 1
        );
        // 备份可正常打开且含迁移前数据
        assert_eq!(count_rows(&bak, "sessions"), 1, ".bak-v{v} 含迁移前会话数据");
    }
}

/// 备份失败传播（裁定案 2026-08-06）：告警不阻断迁移。
/// 故障注入：预置同名目录占位 `sessions.db.bak-v4` → `std::fs::copy`
/// 目标为目录必然失败 → 版本升级仍完成 + 告警落痕（session_meta 可观测键）。
#[test]
fn backup_failure_warns_and_continues_migration() {
    let temp = TempDb::new("bak-fail");
    build_v3_fixture(&temp);
    let blocker = temp.path().parent().unwrap().join("sessions.db.bak-v4");
    std::fs::create_dir(&blocker).unwrap();

    let db = LocalDb::open(temp.path()).unwrap();

    // 版本升级不被中断（user_version 达最新）
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION, "备份失败不得阻断迁移");

    // 告警落痕：session_meta 可观测键（含版本号）
    let alert = db.get_session_meta("migration_backup_failed").unwrap();
    assert!(alert.is_some(), "备份失败必须留下可观测告警记录");
    assert!(alert.unwrap().contains("v4"), "告警记录含版本号 v4");

    // 迁移本身正常完成：孤儿事件被过滤、数据可用
    let conn = Connection::open(temp.path()).unwrap();
    assert_eq!(count_rows(&conn, "events"), 2, "v3→v4 迁移正常完成（孤儿过滤）");
    assert_eq!(count_rows(&conn, "sessions"), 1);
}
