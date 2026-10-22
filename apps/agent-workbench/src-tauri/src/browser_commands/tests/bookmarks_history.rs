use crate::browser_commands::{
    browser_import_bookmarks, browser_import_history, browser_list_bookmarks,
    browser_list_history,
};

/// G-4：书签导入落库（03-方案 §4.2 U4）——解析 → 落库统计聚合；
/// 重导幂等（(url, name) 主键跳过全量）；list_bookmarks 回读行数一致。
#[tokio::test]
async fn import_bookmarks_persists_idempotent_and_lists() {
    use tauri::Manager as _;
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    let shared = crate::session_commands::SharedDb::new(db);
    let app = tauri::test::mock_builder()
        .manage(shared)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let db_state = app.state::<crate::session_commands::SharedDb>();

    let json = r#"{
        "roots": {
            "bookmark_bar": {
                "type": "folder", "name": "书签栏",
                "children": [
                    { "type": "url", "name": "A", "url": "https://a.example.com" },
                    { "type": "url", "name": "A", "url": "https://a.example.com" },
                    { "type": "url", "name": "B", "url": "https://b.example.com" }
                ]
            },
            "other": {
                "type": "folder", "name": "其他书签",
                "children": [
                    { "type": "url", "name": "C", "url": "https://c.example.com" }
                ]
            }
        }
    }"#;
    let payload = browser_import_bookmarks(json.to_string(), db_state.clone())
        .await
        .expect("导入不应失败");
    assert_eq!(payload.parsed_items, 3, "解析层 (url, name) 去重后 3 条");
    assert_eq!(payload.dropped_dupes, 1, "解析层同键去重 1 条");
    assert_eq!(payload.inserted, 3, "落库新增 3 条");
    assert_eq!(payload.skipped_dupes, 0);
    assert_eq!(payload.skipped_invalid, 0);
    assert_eq!(payload.depth_cutoff, 0);
    assert_eq!(payload.truncated, 0);

    // 重导幂等（03-方案 §2.4：INSERT OR IGNORE 主键跳过）
    let payload = browser_import_bookmarks(json.to_string(), db_state.clone())
        .await
        .expect("重导不应失败");
    assert_eq!(payload.inserted, 0, "同键全部跳过");
    assert_eq!(payload.skipped_dupes, 3);

    // 查询面：3 行 + 字段完整（folder_path 反序列化逐元素）
    let rows = browser_list_bookmarks(db_state.clone())
        .await
        .expect("列表不应失败");
    assert_eq!(rows.len(), 3);
    let a = rows
        .iter()
        .find(|r| r.url == "https://a.example.com")
        .expect("A 行存在");
    assert_eq!(a.name, "A");
    assert_eq!(a.folder_path, vec!["书签栏"], "路径链逐元素保留");
    assert_eq!(a.source, "manual/bookmarks", "来源标识固定");
    assert_eq!(a.guid, None, "guid 首版恒 None");
    assert!(a.imported_at > 0, "导入时刻注入");
}

/// G-4：书签导入非法 JSON → `tool.invalid_input` 结构化错误。
#[tokio::test]
async fn import_bookmarks_rejects_bad_json() {
    use tauri::Manager as _;
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    let shared = crate::session_commands::SharedDb::new(db);
    let app = tauri::test::mock_builder()
        .manage(shared)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let db_state = app.state::<crate::session_commands::SharedDb>();

    let err = browser_import_bookmarks("{ not json !!".to_string(), db_state)
        .await
        .expect_err("非法 JSON 必须失败");
    assert!(
        err.starts_with("tool.invalid_input:"),
        "invalid_input 结构化码前缀：{err}"
    );
}

/// G-4：历史导入落库（03-方案 §4.2 U4）——真实 Chrome History 形态
/// fixture 只读读取 → 落库统计聚合；list_history 回读（visited_at
/// 倒序 + since/limit 过滤面）。
#[tokio::test]
async fn import_history_persists_and_lists() {
    use tauri::Manager as _;
    let dir = tempfile::tempdir().expect("临时目录");
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    let shared = crate::session_commands::SharedDb::new(db);
    let app = tauri::test::mock_builder()
        .manage(shared)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let db_state = app.state::<crate::session_commands::SharedDb>();

    // 构造真实 History 库 fixture（urls + visits，WebKit 微秒时间戳）
    let hist = dir.path().join("History");
    {
        let conn = rusqlite::Connection::open(&hist).expect("建库");
        conn.execute_batch(
            "CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT);
             CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL);",
        )
        .expect("建表");
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("时钟")
            .as_secs() as i64;
        for (i, days_ago) in [1i64, 2, 3].iter().enumerate() {
            conn.execute(
                "INSERT INTO urls (url, title) VALUES (?1, ?2)",
                rusqlite::params![format!("https://h{i}.example.com"), format!("H{i}")],
            )
            .expect("插 urls 行");
            let id = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO visits (url, visit_time) VALUES (?1, ?2)",
                rusqlite::params![
                    id,
                    (now_secs - days_ago * 86_400 + 11_644_473_600) * 1_000_000
                ],
            )
            .expect("插 visits 行");
        }
    }
    let payload = browser_import_history(hist.display().to_string(), db_state.clone())
        .await
        .expect("导入不应失败");
    assert_eq!(payload.read_total, 3);
    assert_eq!(payload.skipped_invalid_url, 0);
    assert_eq!(payload.inserted, 3);
    assert_eq!(payload.skipped_dupes, 0);

    // 重导幂等：(url, visited_at) 主键跳过全量
    let payload = browser_import_history(hist.display().to_string(), db_state.clone())
        .await
        .expect("重导不应失败");
    assert_eq!(payload.inserted, 0);
    assert_eq!(payload.skipped_dupes, 3);

    // 查询面：3 行倒序 + 字段完整（title Some/visited_at Unix 秒）
    let rows = browser_list_history(None, None, db_state.clone())
        .await
        .expect("列表不应失败");
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows[0].url, "https://h0.example.com",
        "visited_at 倒序（最近在前）"
    );
    assert_eq!(rows[0].title.as_deref(), Some("H0"));
    assert_eq!(rows[0].source, "manual/history", "来源标识固定");
    // since 过滤（严格大于）+ limit 截断
    let since = rows[2].visited_at;
    let filtered = browser_list_history(Some(since), None, db_state.clone())
        .await
        .expect("列表不应失败");
    assert_eq!(filtered.len(), 2, "since 严格大于");
    let limited = browser_list_history(None, Some(1), db_state.clone())
        .await
        .expect("列表不应失败");
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].url, "https://h0.example.com");
}

/// G-4：历史导入库缺失 → `tool.invalid_input`（输入路径不可用）。
#[tokio::test]
async fn import_history_rejects_missing_file() {
    use tauri::Manager as _;
    let dir = tempfile::tempdir().expect("临时目录");
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    let shared = crate::session_commands::SharedDb::new(db);
    let app = tauri::test::mock_builder()
        .manage(shared)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let db_state = app.state::<crate::session_commands::SharedDb>();

    let err = browser_import_history(
        dir.path().join("Missing-History").display().to_string(),
        db_state,
    )
    .await
    .expect_err("库缺失必须失败");
    assert!(
        err.starts_with("tool.invalid_input:"),
        "invalid_input 结构化码前缀：{err}"
    );
}
