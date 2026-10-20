//! Schema 迁移、版本化升级与跨版本兼容性单测。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::migrate_steps::{migrate_v10_to_v11, step_10_to_11};
use crate::schema::create_v5_schema;
use conex_types::{RunCacheStats, SessionIndexEntry, SessionMessage};
use rusqlite::Connection;
use std::collections::HashMap;

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
        usage: None,
    }
}

#[test]
fn schema_version_is_current() {
    let db = LocalDb::open_in_memory().unwrap();
    let v = db
        .get_session_meta("schema_version")
        .unwrap()
        .expect("schema_version should be set by migrate()");
    assert_eq!(v, SCHEMA_VERSION_STRING);
}

// ===== 历史 localStorage 兼容性与迁移导入单测 =====

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
    let folder = db
        .get_session_meta("folder_order")
        .unwrap()
        .expect("folder_order");
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
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 2, "import 必须同步更新 sessions.message_count");
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
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1, "import 幂等且保持正确的 message_count");
}

// ===== P5 T-39：v5 迁移（runs usage/cache 列 + session_messages.usage_json）=====

/// 唯一临时文件库（v5 迁移磁盘 fixture；Drop 清理主文件 / WAL / SHM / 目录）。
struct TempV5Db {
    path: std::path::PathBuf,
}

impl TempV5Db {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "conex-v5-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ));
        if let Err(err) = std::fs::create_dir_all(&dir) {
            // 创建失败会让后续 open 以真实错误暴露；此处留痕以区分「目录建不出来」
            eprintln!(
                "[conex-db test] 创建临时目录失败 {}: {err}",
                dir.display()
            );
        }
        let path = dir.join("sessions.db");
        crate::tests::cleanup_temp_path(&path);
        Self { path }
    }
}

impl Drop for TempV5Db {
    fn drop(&mut self) {
        crate::tests::cleanup_temp_path(&self.path);
        crate::tests::cleanup_temp_path(format!("{}-wal", self.path.display()));
        crate::tests::cleanup_temp_path(format!("{}-shm", self.path.display()));
        if let Some(parent) = self.path.parent() {
            crate::tests::cleanup_temp_path(parent);
        }
    }
}

fn table_columns_v5(conn: &Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .filter_map(|c| c.ok())
        .collect()
}

/// v4 形状磁盘库 fixture（runs 7 列、session_messages 无 usage_json）+ 数据。
/// 与 tests/migrations.rs 的 fixture 手法一致（原始 SQL，非 create_v5_schema）。
fn build_v4_fixture(temp: &TempV5Db) {
    let conn = Connection::open(&temp.path).unwrap();
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
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
        ) WITHOUT ROWID;
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
            updated_at INTEGER,
            PRIMARY KEY (session_id, seq)
        ) WITHOUT ROWID;
        INSERT INTO sessions (id, title, created_at, message_count)
            VALUES ('s1', 'v4 会话', 1000, 1);
        INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp)
            VALUES ('s1', 0, 'm1', 'user', '旧消息', 500);
        INSERT INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
            VALUES ('r1', 's1', 'completed', NULL, 3, 100, 200);
        PRAGMA user_version = 4;",
    )
    .unwrap();
}

#[test]
fn migrate_v4_fixture_to_v5_preserves_data_and_adds_columns() {
    let temp = TempV5Db::new("v4to5");
    build_v4_fixture(&temp);

    let db = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING)
    );

    // runs 九列 + session_messages.usage_json 存在
    let conn = Connection::open(&temp.path).unwrap();
    let runs_cols = table_columns_v5(&conn, "runs");
    for col in [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "cache_miss_tokens",
        "sample_count",
        "missed_tokens",
        "warm_until_ms",
    ] {
        assert!(runs_cols.contains(&col.to_string()), "runs 缺列 {col}");
    }
    assert!(
        table_columns_v5(&conn, "session_messages").contains(&"usage_json".to_string()),
        "session_messages 缺 usage_json 列"
    );

    // 旧数据保留 + 旧行默认值（NOT NULL DEFAULT 0 / warm_until_ms NULL 兼容）
    let (title, msg_count): (String, i64) = conn
        .query_row(
            "SELECT title, message_count FROM sessions WHERE id='s1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(title, "v4 会话");
    assert_eq!(msg_count, 1, "旧消息保留");
    let (prompt_tokens, warm_until_ms): (i64, Option<i64>) = conn
        .query_row(
            "SELECT prompt_tokens, warm_until_ms FROM runs WHERE run_id='r1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(prompt_tokens, 0, "旧行自动补 0");
    assert_eq!(warm_until_ms, None, "warm_until_ms NULL 兼容");
}

#[test]
fn migrate_v4_to_v5_idempotent_rerun() {
    let temp = TempV5Db::new("v5idem");
    build_v4_fixture(&temp);

    // 首次 open：v4 → v5
    let db1 = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db1.user_version().unwrap(), LATEST_VERSION);
    let conn = Connection::open(&temp.path).unwrap();
    let runs_cols = table_columns_v5(&conn, "runs");

    // 二次 open：幂等重跑，不重复加列、不报错
    let db2 = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    let conn2 = Connection::open(&temp.path).unwrap();
    assert_eq!(
        table_columns_v5(&conn2, "runs"),
        runs_cols,
        "二次 open 列清单不变（无重复 ADD COLUMN）"
    );
    assert_eq!(
        table_columns_v5(&conn2, "runs")
            .iter()
            .filter(|c| c.as_str() == "prompt_tokens")
            .count(),
        1
    );
    // 数据稳定
    let title: String = conn2
        .query_row("SELECT title FROM sessions WHERE id='s1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "v4 会话");
}

#[test]
fn usage_json_column_read_write_roundtrip() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "S").unwrap();
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp, usage_json)
         VALUES ('s1', 0, 'm1', 'assistant', 'hi', 1, ?1)",
        rusqlite::params![r#"{"promptTokens":12000,"cacheReadTokens":9000}"#],
    )
    .unwrap();
    let raw: Option<String> = conn
        .query_row(
            "SELECT usage_json FROM session_messages WHERE id='m1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        raw.as_deref(),
        Some(r#"{"promptTokens":12000,"cacheReadTokens":9000}"#)
    );

    // 缺省行（无 usage 快照）→ NULL，读取兼容
    conn.execute(
        "INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp)
         VALUES ('s1', 1, 'm2', 'user', 'no usage', 2)",
        [],
    )
    .unwrap();
    let raw2: Option<String> = conn
        .query_row(
            "SELECT usage_json FROM session_messages WHERE id='m2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(raw2, None, "无 usage 行读回 NULL");
}

#[test]
fn save_load_session_body_usage_roundtrip() {
    // save → load 全链路：usage_json 列往返，camelCase CacheUsage JSON 原样透传
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let usage_json = r#"{"promptTokens":12000,"cacheReadTokens":9000,"cacheWriteTokens":500,"cacheMissTokens":3000}"#;
    let mut with_usage = sample_message("m1", "assistant", 100);
    with_usage.usage = Some(usage_json.to_string());
    let mut without_usage = sample_message("m2", "user", 200);
    without_usage.usage = None;
    db.save_session_body("s1", &[with_usage, without_usage])
        .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 2);
    // usage 与前端写入的 JSON 逐字节一致（Rust 侧不解析不转换）
    assert_eq!(loaded[0].usage.as_deref(), Some(usage_json));
    assert_eq!(loaded[1].usage, None, "None 往返保持 None");
}

#[test]
fn load_session_body_usage_none_for_legacy_rows() {
    // 旧库行（v5 之前无 usage_json 列值）→ 列 NULL → usage None，兼容不炸
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();

    // 直接以旧形态 SQL 补插一行（不携带 usage_json 列）
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO session_messages (session_id, seq, id, sender, text, timestamp)
         VALUES ('s1', 1, 'legacy-m', 'assistant', '旧数据', 3)",
        [],
    )
    .unwrap();
    drop(conn);

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[1].id, "legacy-m");
    assert_eq!(loaded[1].usage, None, "旧行 usage_json 为 NULL → None");
}

#[test]
fn save_run_usage_write_read_roundtrip() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "S").unwrap();
    db.insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 3)
        .unwrap();

    let stats = RunCacheStats {
        prompt_tokens: 12000,
        completion_tokens: 400,
        total_tokens: 12400,
        cache_read_tokens: 9000,
        cache_write_tokens: 500,
        cache_miss_tokens: 3000,
        sample_count: 4,
        hit_ratio: Some(0.75),
        write_ratio: Some(0.04),
        missed_tokens: 20000,
        warm_until_ms: Some(1_750_000_000_000),
    };
    db.save_run_usage("r1", stats).unwrap();

    let got = db.get_run_usage("r1").unwrap().expect("usage 应回读");
    assert_eq!(got.prompt_tokens, 12000);
    assert_eq!(got.completion_tokens, 400);
    assert_eq!(got.total_tokens, 12400);
    assert_eq!(got.cache_read_tokens, 9000);
    assert_eq!(got.cache_write_tokens, 500);
    assert_eq!(got.cache_miss_tokens, 3000);
    assert_eq!(got.sample_count, 4);
    assert_eq!(got.missed_tokens, 20000);
    assert_eq!(got.warm_until_ms, Some(1_750_000_000_000));
    // hit_ratio / write_ratio 可派生不落库：读回 None
    assert_eq!(got.hit_ratio, None);
    assert_eq!(got.write_ratio, None);

    // 覆盖写（幂等 UPDATE）
    let stats2 = RunCacheStats {
        sample_count: 5,
        ..stats
    };
    db.save_run_usage("r1", stats2).unwrap();
    assert_eq!(db.get_run_usage("r1").unwrap().unwrap().sample_count, 5);
}

#[test]
fn save_run_usage_missing_row_silently_skipped() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "S").unwrap();
    // 缺行：UPDATE 命中 0 行，静默跳过（不报错）
    db.save_run_usage("no-such-run", RunCacheStats::default())
        .unwrap();
    assert!(db.get_run_usage("no-such-run").unwrap().is_none());
}

#[test]
fn get_run_usage_none_for_legacy_rows() {
    // v4 迁移后旧行：全零列（NOT NULL DEFAULT 0）+ warm_until_ms NULL
    // → sample_count == 0 → None（前端隐藏而非 0% 误导）
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "S").unwrap();
    db.insert_run("r1", "s1", RunStatus::Completed, None, 0)
        .unwrap();
    assert!(db.get_run_usage("r1").unwrap().is_none());
}

#[test]
fn save_run_usage_warm_until_none_roundtrip() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "S").unwrap();
    db.insert_run("r1", "s1", RunStatus::Running, None, 1)
        .unwrap();
    let stats = RunCacheStats {
        sample_count: 1,
        warm_until_ms: None,
        ..RunCacheStats::default()
    };
    db.save_run_usage("r1", stats).unwrap();
    let got = db.get_run_usage("r1").unwrap().unwrap();
    assert_eq!(got.sample_count, 1);
    assert_eq!(got.warm_until_ms, None, "warm_until_ms NULL 兼容读写");
}

#[test]
fn fresh_db_includes_v5_columns() {
    // 全新库：v1→v5 全链后 runs/session_messages 直接带 v5 列
    let db = LocalDb::open_in_memory().unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    let conn = db.conn.lock().unwrap();
    let runs_cols = table_columns_v5(&conn, "runs");
    assert!(runs_cols.contains(&"sample_count".to_string()));
    assert!(runs_cols.contains(&"warm_until_ms".to_string()));
    let msg_cols = table_columns_v5(&conn, "session_messages");
    assert!(msg_cols.contains(&"usage_json".to_string()));
}

#[test]
fn v5_ensure_path_uses_target_schema_ddl() {
    // create_v5_schema 幂等可重放：直接执行不报错（备份恢复 / ensure 兜底场景）
    let db = LocalDb::open_in_memory().unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    let conn = db.conn.lock().unwrap();
    conn.execute_batch(create_v5_schema()).unwrap();
}

#[test]
fn fresh_db_includes_v9_columns() {
    // 全新库：v1→v9 全链 + ensure 后 events 直接带 run_id 列、
    // session_agents 直接带 sub_session_id 列（D-01 DM-01 两形态之二）
    let db = LocalDb::open_in_memory().unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    let conn = db.conn.lock().unwrap();
    let event_cols = table_columns_v5(&conn, "events");
    assert!(
        event_cols.contains(&"run_id".to_string()),
        "新库 events 缺 run_id 列"
    );
    let agent_cols = table_columns_v5(&conn, "session_agents");
    assert!(
        agent_cols.contains(&"sub_session_id".to_string()),
        "新库 session_agents 缺 sub_session_id 列"
    );
    // idx_events_run 索引对新库同样落位（v9 迁移臂建出）
    let idx_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_events_run'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(idx_count, 1, "新库 idx_events_run 索引必须存在");
}

#[test]
fn migration_v11_creates_app_preferences_table() {
    let db = LocalDb::open_in_memory().unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING),
    );

    let conn = db.conn.lock().unwrap();
    let has_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_preferences';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_table, 1, "app_preferences 表必须存在");

    let cols = table_columns_v5(&conn, "app_preferences");
    assert!(cols.contains(&"key".to_string()), "缺 key 列");
    assert!(cols.contains(&"value".to_string()), "缺 value 列");
    assert!(cols.contains(&"updated_at".to_string()), "缺 updated_at 列");

    // 验证与已废弃 metadata 表明确隔离（metadata 表不应存在）
    let has_metadata: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='metadata';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_metadata, 0, "metadata 表不得存在（保持废弃隔离）");

    // 验证 app_preferences 表读写正常
    conn.execute(
        "INSERT INTO app_preferences (key, value, updated_at) VALUES (?1, ?2, ?3);",
        rusqlite::params!["appearance.theme", "\"dark\"", 1700000000000i64],
    )
    .unwrap();

    let (val, ts): (String, i64) = conn
        .query_row(
            "SELECT value, updated_at FROM app_preferences WHERE key = ?1;",
            ["appearance.theme"],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(val, "\"dark\"");
    assert_eq!(ts, 1700000000000i64);
}

#[test]
fn migration_v11_step_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    let tx = conn.transaction().unwrap();
    // 首次执行
    step_10_to_11(&tx).unwrap();
    // 别名与二次执行（天然幂等）
    migrate_v10_to_v11(&tx).unwrap();
    tx.commit().unwrap();

    let has_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='app_preferences';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_table, 1, "幂等重复执行后表正常存在");
}
