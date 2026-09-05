use conex_workspace_store::migrate::migrate;
use conex_workspace_store::SCHEMA_VERSION;
use rusqlite::Connection;

#[test]
fn test_fresh_database_has_schema_version_8_and_5_columns() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let version: i64 = conn
        .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 8, "全新数据库迁移后 schema_version 必须为 8");
    assert_eq!(version, SCHEMA_VERSION);

    // 验证 doc_meta 5 列极简表结构存在
    let mut stmt = conn.prepare("PRAGMA table_info(doc_meta)").unwrap();
    let columns: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    for expected in [
        "doc_id",
        "rev",
        "updated_at",
        "title",
        "created_at",
    ] {
        assert!(
            columns.iter().any(|c| c == expected),
            "doc_meta 必须包含列 {expected}"
        );
    }

    // 刚性负向断言：过度设计字段绝对不得入库
    for forbidden in ["is_pinned", "is_archived", "tags_json"] {
        assert!(
            !columns.iter().any(|c| c == forbidden),
            "过度设计字段 {forbidden} 严禁存在于 doc_meta"
        );
    }
}

#[test]
fn test_migration_v8_version_gate_preserves_custom_title_on_reboot() {
    let conn = Connection::open_in_memory().unwrap();

    // 1. 模拟 v7 老数据库
    conn.execute_batch(
        r#"
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (7);

        CREATE TABLE doc_meta (
            doc_id TEXT PRIMARY KEY,
            rev INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 1700000000
        );

        CREATE TABLE blocks (
            doc_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            parent_id TEXT,
            kind TEXT NOT NULL DEFAULT '',
            order_key TEXT NOT NULL DEFAULT '',
            plain_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 1700000000,
            PRIMARY KEY (doc_id, block_id)
        );

        -- 插入一篇历史无标题笔记，包含首行正文
        INSERT INTO doc_meta (doc_id, rev, updated_at) VALUES ('doc_legacy_1', 1, 1700001000);
        INSERT INTO blocks (doc_id, block_id, plain_text, updated_at)
            VALUES ('doc_legacy_1', 'b1', '# 架构设计总纲\n正文内容', 1700001000);
        "#,
    ).unwrap();

    // 2. 执行第一次迁移（升至 v8）
    migrate(&conn).unwrap();

    // 断言标题已从首行智能提取
    let title: String = conn
        .query_row("SELECT title FROM doc_meta WHERE doc_id = 'doc_legacy_1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "架构设计总纲", "v8 迁移应自动提取首行 heading 回填标题");

    // 验证时间戳已自动转换为 13 位毫秒级
    let updated_at: i64 = conn
        .query_row("SELECT updated_at FROM doc_meta WHERE doc_id = 'doc_legacy_1'", [], |r| r.get(0))
        .unwrap();
    assert!(updated_at >= 1_000_000_000_000, "时间戳必须已归一化为 13 位毫秒");

    // 3. 用户将标题主动修改为自定义名称
    conn.execute(
        "UPDATE doc_meta SET title = '用户自定义专属标题' WHERE doc_id = 'doc_legacy_1'",
        [],
    ).unwrap();

    // 4. 模拟应用重启再次调用 migrate(&conn)
    migrate(&conn).unwrap();

    // 刚性断言：BUG-A04 门闩生效，版本已是 8，绝不再执行回填扫描！
    let title_after_reboot: String = conn
        .query_row("SELECT title FROM doc_meta WHERE doc_id = 'doc_legacy_1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        title_after_reboot,
        "用户自定义专属标题",
        "重启时绝不允许无条件扫描覆盖用户自定义标题"
    );
}

#[test]
fn test_index_idx_doc_meta_updated_exists() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT count(1) FROM sqlite_master WHERE type='index' AND name='idx_doc_meta_updated'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "idx_doc_meta_updated 索引必须成功创建");
}
