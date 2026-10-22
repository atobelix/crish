//! v12→v13 孤儿 session_meta 键 GC 迁移与历史 localStorage 导入单测。

use super::*;

// ===== RUN-15：v12→v13 孤儿 session_meta 键 GC 迁移 =====

/// 构造 v12 形态 fixture：v5 全量 DDL + 会话行 + 孤儿/全局 meta 键 + user_version=12。
/// 返回插入后的完整键值快照（升级前基线，供前后对照断言）。
fn build_v12_fixture_with_orphan_meta(path: &std::path::Path) -> Vec<(String, String)> {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         {};",
        create_v5_schema()
    ))
    .unwrap();
    conn.execute_batch(
        "INSERT INTO sessions (id, title, created_at, message_count)
            VALUES ('live-1', '活会话', 1000, 0);
         INSERT INTO session_meta (key, value) VALUES
            ('orphan-1:output_dir', 'd-old'),
            ('orphan-1:explore_docs_consumed', '9'),
            ('orphan-1:unknown_suffix', 'keep-conservative'),
            ('live-1:output_dir', 'd-live'),
            ('sched:cron-0', '{}'),
            ('workflow:cron-0', '{}'),
            ('goal_state', '{}'),
            ('schema_version', '12');
         PRAGMA user_version = 12;",
    )
    .unwrap();

    let mut stmt = conn
        .prepare("SELECT key, value FROM session_meta ORDER BY key")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows
}

/// v12（含孤儿 meta 键）→ v13：孤儿前缀键被 GC，活会话键与含冒号全局键保留；
/// 二次 open 幂等重入（重跑无重复删除、键集不变）
#[test]
fn migrate_v12_to_v13_gcs_orphan_session_meta_keys() {
    let temp = TempV5Db::new("v13gc");
    let before = build_v12_fixture_with_orphan_meta(&temp.path);

    // 升级前快照锚定：fixture 含孤儿键 + 全局键（防 fixture 自身写错）
    let get = |rows: &[(String, String)], k: &str| {
        rows.iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(
        get(&before, "orphan-1:output_dir").as_deref(),
        Some("d-old")
    );
    assert_eq!(get(&before, "sched:cron-0").as_deref(), Some("{}"));

    // 升级：v12 → v13（LocalDb::open 触发迁移链）
    let db = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING),
        "schema_version 登记应同步到 v13"
    );

    // 孤儿键（会话不存在 + 已知作用域后缀）→ 已清理
    assert_eq!(db.get_session_meta("orphan-1:output_dir").unwrap(), None);
    assert_eq!(
        db.get_session_meta("orphan-1:explore_docs_consumed")
            .unwrap(),
        None
    );
    // 未知后缀孤儿键 → 保守保留（GC 只删已知作用域后缀，白名单收窄）
    assert_eq!(
        db.get_session_meta("orphan-1:unknown_suffix")
            .unwrap()
            .as_deref(),
        Some("keep-conservative"),
        "未知后缀不在 GC 白名单，保守保留"
    );
    // 活会话键保留
    assert_eq!(
        db.get_session_meta("live-1:output_dir").unwrap().as_deref(),
        Some("d-live")
    );
    // 含冒号全局键保留（防误删：sched:/workflow: 会话段不命中会话表）
    assert_eq!(
        db.get_session_meta("sched:cron-0").unwrap().as_deref(),
        Some("{}")
    );
    assert_eq!(
        db.get_session_meta("workflow:cron-0").unwrap().as_deref(),
        Some("{}")
    );
    assert_eq!(
        db.get_session_meta("goal_state").unwrap().as_deref(),
        Some("{}")
    );
    // 活会话行保留
    assert_eq!(db.list_sessions().unwrap().len(), 1);

    // 幂等重入：二次 open（重跑迁移路径 = 已是最新版本的 ensure 分支 + 若再降级
    // 场景重跑 v13 也是纯 DELETE 幂等）——键集与首次升级后完全一致
    let after_first: Vec<(String, String)> = db
        .read(|conn| {
            let mut stmt = conn
                .prepare("SELECT key, value FROM session_meta ORDER BY key")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            Ok(rows)
        })
        .unwrap();
    drop(db);
    let db2 = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    let after_second: Vec<(String, String)> = db2
        .read(|conn| {
            let mut stmt = conn
                .prepare("SELECT key, value FROM session_meta ORDER BY key")
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            Ok(rows)
        })
        .unwrap();
    assert_eq!(after_first, after_second, "二次 open 键集不变（GC 可重入）");
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
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        2,
        "import 必须同步更新 sessions.message_count"
    );
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
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        1,
        "import 幂等且保持正确的 message_count"
    );
}
