//! T11.5.1 升级端到端测试（PE-11 迁移/升级测试）：生产路径 e2e。
//!
//! 与 tests/migrations.rs（PE-08 T08.7 fixture 级测试）互补：
//! 本文件构造「生产形态 v3 库 + 真实脏数据」（多会话/置顶/归档/分支、
//! tool_calls/blocks 负载、子代理消息、事件流、run、待处理输入、会话级 sequence、
//! 孤儿残留行）→ 走真实启动路径 `LocalDb::open` 全链升级到 v4 → 断言：
//! - 版本与元数据：user_version=4、session_meta.schema_version='4'；
//! - 数据完整性：行数 + 公共 API（list_sessions / load_session_body /
//!   load_session_agents / query_events）可读回升级前数据；
//! - 二次 open 幂等：不重复迁移、不堆积备份；
//! - 备份文件：`sessions.db.bak-v4` 含迁移前数据（可回滚）；
//! - 升级后全部 API 可用：run 生命周期 / reserve_sequence / append_event /
//!   messages / agents / pending / cleanup / import_from_localstorage 走一遍。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use conex_db::{LocalDb, RunStatus, LATEST_VERSION, SCHEMA_VERSION_STRING};
use conex_types::{SessionAgent, SessionMessage};
use rusqlite::Connection;
use std::collections::HashMap;
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
            "conex-upgrade-e2e-{name}-{}-{n}",
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

fn count_rows(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(|c| c.ok())
        .collect()
}

/// 生产形态 v3 库（真实升级前的磁盘状态，与 PE-08 migrations.rs 的 v3 fixture
/// 同构但数据更贴近真实使用：置顶/归档/分支会话、工具调用负载、子代理消息、
/// 事件流、run 记录、待处理输入、会话级 sequence；并含孤儿残留行验证过滤）。
fn build_v3_production_fixture(db: &TempDb) {
    let conn = Connection::open(db.path()).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn.execute_batch(
        r#"CREATE TABLE sessions (
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

        INSERT INTO sessions (id, title, folder, is_pinned, updated_at, created_at)
            VALUES ('s1', '生产会话', '生产', 1, 2000, 3000);
        INSERT INTO sessions (id, title, folder, is_archived, branch_parent_id, updated_at, created_at)
            VALUES ('s2', '归档会话', '归档', 1, 's1', 1500, 2500);
        INSERT INTO sessions (id, title, updated_at, created_at)
            VALUES ('s3', '空会话', 1000, 2000);

        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 0, 'm1', 'user', '帮我查一下 API', 1000, 'completed');
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp, status,
            thinking, stream_text_offset, thinking_time, tool_calls_json, blocks_json, tool_call_results_json)
            VALUES ('s1', 1, 'm2', 'assistant', '查询结果如下', 1100, 'completed',
                '内部推理过程', 12, 800,
                '[{"id":"tc1","name":"web_search","arguments":{"q":"crish api"}}]',
                '[{"type":"paragraph","text":"查询结果如下"}]',
                '[{"id":"tc1","status":"success"}]');
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 2, 'm3', 'user', '继续', 1200, 'completed');
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp, status)
            VALUES ('s2', 0, 'm1', 'user', '旧对话消息', 900, 'completed');

        INSERT INTO session_agents (session_id, agent_id, subagent_run_id, parent_session_id,
            parent_run_id, description, mode, status, started_at, ended_at, depth, subagent_path_json)
            VALUES ('s1', 'a1', 'r-a1', 's1', 'r1', '探索子代理', 'explore', 'completed', 1050, 1150, 1, '["a1"]');
        INSERT INTO session_agent_messages (session_id, agent_id, seq, id, sender, text, timestamp, status)
            VALUES ('s1', 'a1', 0, 'am1', 'assistant', '子代理汇报', 1080, 'completed');

        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 1, 'agent-start', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 2, 'tool-call-batch', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s1', 3, 'run-terminal', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('s2', 1, 'agent-start', '{}');
        INSERT INTO events (session_id, sequence, event_type, payload) VALUES ('ghost', 5, 'agent-start', '{}');

        INSERT INTO metadata (key, value) VALUES ('legacy', 'dead');

        INSERT INTO runs (run_id, session_id, status, cursor) VALUES ('r1', 's1', 'completed', 3);
        INSERT INTO runs (run_id, session_id, status, cursor) VALUES ('r-ghost', 'ghost', 'failed', 5);

        INSERT INTO pending_inputs (id, session_id, run_id, payload) VALUES ('p1', 's1', 'r1', '{}');
        INSERT INTO pending_inputs (id, session_id, run_id, payload) VALUES ('p-ghost', 'ghost', NULL, '{}');

        INSERT INTO session_sequence (session_id, next_seq) VALUES ('s1', 4);
        INSERT INTO session_sequence (session_id, next_seq) VALUES ('s2', 2);
        PRAGMA user_version = 3;"#,
    )
    .unwrap();
}

/// 断言升级后的终态：版本、元数据、行数、孤儿过滤、备份存在。
fn assert_upgraded_state(db: &LocalDb, temp: &TempDb) {
    let conn = Connection::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION, "user_version=4");
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING)
    );
    assert_eq!(count_rows(&conn, "sessions"), 3, "3 个会话全部保留");
    assert_eq!(count_rows(&conn, "session_messages"), 4, "消息保留（s1×3 + s2×1）");
    assert_eq!(count_rows(&conn, "session_agents"), 1);
    assert_eq!(count_rows(&conn, "session_agent_messages"), 1);
    assert_eq!(count_rows(&conn, "events"), 4, "孤儿事件（ghost）被过滤");
    assert_eq!(count_rows(&conn, "runs"), 1, "孤儿 run 被过滤");
    assert_eq!(count_rows(&conn, "pending_inputs"), 1, "孤儿 pending 被过滤");
    assert_eq!(count_rows(&conn, "session_sequence"), 2);
    let orphans: String = conn
        .query_row(
            "SELECT value FROM session_meta WHERE key='migration_v4_dropped_orphans'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(orphans, "1:1:1", "孤儿计数 events:runs:pending");
    let backups = backup_files(temp.path());
    assert!(!backups.is_empty(), "迁移备份必须存在");
    assert!(backups.len() <= 2, "备份最多保留 2 份");
    let _ = conn;
}

#[test]
fn upgrade_e2e_v3_to_v4_data_visible_via_public_api() {
    let temp = TempDb::new("api");
    build_v3_production_fixture(&temp);

    // 真实启动路径：LocalDb::open 触发检测链 → v3→v4 迁移
    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.get_failure(), None, "升级后无失败闩");
    assert_upgraded_state(&db, &temp);

    // 会话索引可读：标题 / folder / 置顶 / 归档 / 分支 全部保留
    let sessions = db.list_sessions().unwrap();
    assert_eq!(sessions.len(), 3);
    let s1 = sessions.iter().find(|s| s.id == "s1").expect("s1 存在");
    assert_eq!(s1.title, "生产会话");
    assert_eq!(s1.folder, "生产");
    assert!(s1.is_pinned);
    assert_eq!(s1.message_count, 3, "触发器维护的 message_count 保留");
    let s2 = sessions.iter().find(|s| s.id == "s2").expect("s2 存在");
    assert!(s2.is_archived);
    assert_eq!(s2.branch_parent_id.as_deref(), Some("s1"), "分支关系保留");

    // 会话正文可读：含 tool_calls / thinking 负载
    let body = db.load_session_body("s1").unwrap();
    assert_eq!(body.len(), 3);
    let m2 = &body[1];
    assert_eq!(m2.sender, "assistant");
    assert!(m2.thinking.as_deref().unwrap_or("").contains("推理"), "thinking 保留");
    assert!(m2.tool_calls_json.as_deref().unwrap_or("").contains("web_search"));
    assert!(m2.blocks_json.as_deref().unwrap_or("").contains("paragraph"));
    assert!(m2.tool_call_results_json.as_deref().unwrap_or("").contains("success"));
    assert_eq!(db.load_session_body("s2").unwrap().len(), 1);

    // 子代理可读
    let agents = db.load_session_agents("s1").unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, "a1");
    assert_eq!(agents[0].description, "探索子代理");
    assert_eq!(agents[0].messages.len(), 1);

    // 事件流可读（组合主键 + FK 重建后）
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event_type, "agent-start");
    assert_eq!(events[2].event_type, "run-terminal");
}

#[test]
fn upgrade_e2e_v3_to_v4_all_apis_usable_after_upgrade() {
    let temp = TempDb::new("api-full");
    build_v3_production_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_upgraded_state(&db, &temp);

    // ── run 生命周期：insert → update → get → list ──
    db.insert_run("r-new", "s1", RunStatus::Running, None, 4).unwrap();
    db.update_run_status("r-new", RunStatus::Completed, Some("goal-complete"), Some(5))
        .unwrap();
    let run = db.get_run("r-new").unwrap().expect("r-new 存在");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.end_reason.as_deref(), Some("goal-complete"));
    assert_eq!(run.cursor, 5);
    let all = db.query_all_runs().unwrap();
    assert!(all.iter().any(|r| r.run_id == "r1"));
    assert!(all.iter().any(|r| r.run_id == "r-new"));

    // ── 会话级 sequence：迁移对齐后的首号 = 旧库 next_seq（s1=4）──
    assert_eq!(db.reserve_sequence("s1").unwrap(), 4, "取号接续旧计数器");
    assert_eq!(db.reserve_sequence("s1").unwrap(), 5);
    db.seed_sequence("s3", 42).unwrap();
    assert_eq!(db.reserve_sequence("s3").unwrap(), 42, "seed 抬高不回退");

    // ── 事件：升级后追加 + 查询 ──
    db.append_event("s1", 4, "run-terminal", r#"{"reason":"ok"}"#, None).unwrap();
    let after = db.query_events("s1", 3, None).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].sequence, 4);

    // ── 正文：全量替换 / 增量追加 ──
    db.save_session_body("s3", &[sample_message("n1", "user")]).unwrap();
    db.append_session_messages("s3", &[sample_message("n2", "assistant")]).unwrap();
    assert_eq!(db.load_session_body("s3").unwrap().len(), 2);

    // ── 子代理：保存 → 读回 ──
    db.save_session_agents("s3", &[sample_agent("a1")]).unwrap();
    let loaded = db.load_session_agents("s3").unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].messages.len(), 1);
    // T-D-07 v6 新列：升级后写入与读回一致（display_label 读回验收）
    assert_eq!(loaded[0].task_type.as_deref(), Some("analysis"));
    assert_eq!(loaded[0].display_label.as_deref(), Some("测试分析师"));
    assert_eq!(loaded[0].allowed_write_paths_json, None);

    // ── 待处理输入 ──
    db.save_pending_input("p2", "s1", Some("r-new"), r#"{"type":"text"}"#).unwrap();
    let inputs = db.load_pending_inputs("s1").unwrap();
    assert_eq!(inputs.len(), 2, "旧 p1 + 新 p2");
    assert!(db.delete_pending_input("p2").unwrap());
    assert_eq!(db.load_pending_inputs("s1").unwrap().len(), 1);

    // ── 元数据 ──
    db.set_session_meta("upgraded_at", "t1").unwrap();
    assert_eq!(db.get_session_meta("upgraded_at").unwrap().as_deref(), Some("t1"));

    // ── 孤儿清理（宽限期显式归零保证确定性）──
    db.set_session_meta("orphan_grace_ms", "0").unwrap();
    let deleted = db.cleanup_orphan_sessions(&["s1".to_string()]).unwrap();
    assert_eq!(deleted, 2, "s2/s3 被清理，s1 保留");
    assert_eq!(db.list_sessions().unwrap().len(), 1);

    // ── 级联删除 ──
    db.delete_session("s1").unwrap();
    assert_eq!(db.list_sessions().unwrap().len(), 0);
    assert!(db.load_session_body("s1").unwrap().is_empty());
    assert!(db.load_session_agents("s1").unwrap().is_empty());
    assert_eq!(db.query_events("s1", 0, None).unwrap().len(), 0, "events FK 级联");
    assert!(db.get_run("r1").unwrap().is_none(), "runs FK 级联");
    assert!(db.get_failure().is_none(), "全部 API 无失败闩");
}

#[test]
fn upgrade_e2e_second_open_idempotent_no_backup_stacking() {
    let temp = TempDb::new("idem");
    build_v3_production_fixture(&temp);

    let db1 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db1.user_version().unwrap(), LATEST_VERSION);
    let backups_after_first = backup_files(temp.path()).len();
    assert!(backups_after_first >= 1);

    // 二次 open（模拟重启）：无重复迁移、无备份堆积、数据稳定
    let db2 = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        backup_files(temp.path()).len(),
        backups_after_first,
        "二次 open 不产生新备份"
    );
    assert_eq!(db2.list_sessions().unwrap().len(), 3);
    assert_eq!(db2.load_session_body("s1").unwrap().len(), 3);
    assert_eq!(
        db2.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING)
    );
}

#[test]
fn upgrade_e2e_backup_contains_pre_migration_data() {
    let temp = TempDb::new("bak");
    build_v3_production_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);

    let backups = backup_files(temp.path());
    assert_eq!(backups.len(), 1, "v3→v4 只产生 .bak-v4");
    let (v, path) = &backups[0];
    assert_eq!(*v, 4);

    // 备份 = 迁移前快照（可回滚）：user_version=3、events 仍含 AUTOINCREMENT id、
    // metadata 表仍在、数据（含孤儿）完整
    let bak = Connection::open(path).unwrap();
    let uv: i32 = bak.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(uv, 3, "备份在 v4 迁移前");
    let events_cols = table_columns(&bak, "events");
    assert!(events_cols.contains(&"id".to_string()), "备份 events 仍是旧形态");
    assert!(table_columns(&bak, "metadata").contains(&"key".to_string()), "备份含 metadata");
    assert_eq!(count_rows(&bak, "events"), 5, "备份含全部事件（含孤儿）");
    assert_eq!(count_rows(&bak, "sessions"), 3);
}

#[test]
fn upgrade_e2e_import_from_localstorage_after_upgrade() {
    // 升级到 v4 后，localStorage→SQLite 一次性导入（T08.10 语义）仍可用
    let temp = TempDb::new("import");
    build_v3_production_fixture(&temp);

    let db = LocalDb::open(temp.path()).unwrap();
    assert_upgraded_state(&db, &temp);

    let index = serde_json::json!([{
        "id": "ls-s1",
        "title": "本地迁移会话",
        "folder": "工作",
        "isPinned": false,
        "isArchived": false,
        "timestamp": "2026-01-01T00:00:00Z",
        "updatedAt": 5000,
        "messageCount": 1,
    }])
    .to_string();
    let body = serde_json::json!([
        { "id": "lm1", "sender": "user", "text": "来自 localStorage", "timestamp": 100 }
    ])
    .to_string();
    let mut bodies = HashMap::new();
    bodies.insert("ls-s1".to_string(), body);

    let stats = db
        .import_from_localstorage(&index, bodies, HashMap::new(), Some("ls-s1"), &["工作".to_string()])
        .unwrap();
    assert_eq!(stats.sessions, 1);
    assert_eq!(stats.messages, 1);

    let sessions = db.list_sessions().unwrap();
    assert_eq!(sessions.len(), 4, "升级后导入新增会话");
    assert_eq!(db.load_session_body("ls-s1").unwrap()[0].text.as_deref(), Some("来自 localStorage"));
    assert_eq!(
        db.get_session_meta("active_session_id").unwrap().as_deref(),
        Some("ls-s1")
    );
    assert!(db.get_session_meta("folder_order").unwrap().unwrap().contains("工作"));
}

/// 测试样本消息/代理构造（本文件内小助手，避免引入新依赖）。
fn sample_message(id: &str, sender: &str) -> SessionMessage {
    SessionMessage {
        id: id.to_string(),
        sender: sender.to_string(),
        text: Some(format!("text-{id}")),
        thinking: None,
        timestamp: 1_000,
        status: Some("completed".to_string()),
        stream_text_offset: None,
        thinking_time: None,
        tool_calls_json: None,
        blocks_json: None,
        tool_call_results_json: None,
        usage: None,
    }
}

fn sample_agent(id: &str) -> SessionAgent {
    SessionAgent {
        id: id.to_string(),
        subagent_run_id: format!("run-{id}"),
        parent_session_id: "s3".to_string(),
        parent_run_id: "r-parent".to_string(),
        parent_tool_call_id: None,
        description: "测试".to_string(),
        mode: "explore".to_string(),
        status: "completed".to_string(),
        summary: None,
        messages: vec![sample_message("am1", "assistant")],
        started_at: 0,
        ended_at: Some(1),
        depth: Some(0),
        subagent_path_json: None,
        task_type: Some("analysis".to_string()),
        display_label: Some("测试分析师".to_string()),
        allowed_write_paths_json: None,
    }
}
