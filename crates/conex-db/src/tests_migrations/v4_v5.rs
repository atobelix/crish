//! v4→v5 迁移（磁盘 fixture）数据保留与幂等重跑单测。

use super::*;

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
        -- v1 schema 即有的 KV 表（RUN-15 v13 GC 依赖；真实 v4 库必然存在）
        CREATE TABLE session_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
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
