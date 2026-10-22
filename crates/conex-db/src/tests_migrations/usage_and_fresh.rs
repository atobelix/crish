//! v5 usage 列读写、run usage 往返与全新库 v5/v9/v11 结构单测。

use super::*;

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
