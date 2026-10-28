//! v13→v14 session_agents 生命周期列迁移（子代理协作 P3）。

use super::*;

/// 从当前全量 DDL 回退到 v13 形态（去掉 v14 四列），写入一行 running，
/// 模拟旧库升级路径。返回升级前路径。
fn build_v13_agent_fixture(path: &std::path::Path) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         {};",
        create_v5_schema()
    ))
    .unwrap();
    conn.execute_batch(
        "ALTER TABLE session_agents DROP COLUMN capability_mode;
         ALTER TABLE session_agents DROP COLUMN model_override;
         ALTER TABLE session_agents DROP COLUMN resumable;
         ALTER TABLE session_agents DROP COLUMN last_heartbeat_ms;
         INSERT INTO sessions (id, title, created_at, message_count)
            VALUES ('s1', '会话', 1000, 0);
         INSERT INTO session_agents (
            session_id, agent_id, subagent_run_id, parent_session_id,
            parent_run_id, status, started_at
         ) VALUES ('s1', 'a1', 'run-1', 's1', 'prun-1', 'running', 100);
         INSERT INTO session_meta (key, value) VALUES ('schema_version', '13');
         PRAGMA user_version = 13;",
    )
    .unwrap();
}

/// v13（无新列）→ v14：四列补齐、旧行数据保留、resumable 默认 0、
/// 心跳默认 NULL、status 索引建立；二次 open 幂等
#[test]
fn migrate_v13_to_v14_adds_agent_lifecycle_columns() {
    let temp = TempV5Db::new("v14agents");
    build_v13_agent_fixture(&temp.path);

    let db = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some(SCHEMA_VERSION_STRING)
    );

    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows.len(), 1, "旧行保留");
    let row = &rows[0];
    assert_eq!(row.id, "a1");
    assert_eq!(row.status, "running");
    assert_eq!(row.started_at, 100);
    assert_eq!(row.capability_mode, None, "旧行能力快照为 NULL");
    assert_eq!(row.model_override, None, "旧行模型覆盖为 NULL");
    assert!(!row.resumable, "resumable 默认 0");
    assert_eq!(row.last_heartbeat_ms, None, "旧行无心跳");

    // 列与索引存在（迁移结构锚定）
    let conn = Connection::open(&temp.path).unwrap();
    let cols = table_columns_v5(&conn, "session_agents");
    for col in [
        "capability_mode",
        "model_override",
        "resumable",
        "last_heartbeat_ms",
    ] {
        assert!(cols.iter().any(|c| c == col), "缺少 v14 列 {col}");
    }
    let has_index: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='index' AND name='idx_session_agents_status'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_index, 1, "status 索引应建立");
    drop(conn);

    // 幂等：二次 open 不重复 ALTER 崩溃
    let db2 = LocalDb::open(&temp.path).unwrap();
    assert_eq!(db2.user_version().unwrap(), LATEST_VERSION);
    assert_eq!(db2.load_session_agents("s1").unwrap().len(), 1);
}
