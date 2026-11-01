//! 会话索引列表与 Keyset 分页的查询计划 / 排序单测。

use super::*;

fn sample_entry(id: &str, updated_at: i64) -> SessionIndexEntry {
    SessionIndexEntry {
        id: id.to_string(),
        title: format!("Title {id}"),
        folder: "常规会话".to_string(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-10-13T00:00:00Z".to_string(),
        updated_at,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: None,
        engine_last_run_id: None,
        hydrated_from_engine: None,
    }
}

#[test]
fn list_sessions_and_keyset_pagination_use_aligned_index_without_temp_btree() {
    let db = LocalDb::open_in_memory().unwrap();
    for (id, ts) in [
        ("s-c", 200),
        ("s-a", 300),
        ("s-b", 300),
        ("s-d", 100),
        ("s-e", 200),
    ] {
        db.upsert_session_entry(&sample_entry(id, ts)).unwrap();
    }

    // 1. 验证 EXPLAIN QUERY PLAN：全表排序与 Keyset 游标分页均走 idx_sessions_updated，零 TEMP B-TREE
    let (plan_full, plan_page) = db
        .read(|conn| {
            let mut s1 = conn
                .prepare(
                    "EXPLAIN QUERY PLAN
                         SELECT id, title FROM sessions
                         ORDER BY updated_at DESC, id ASC",
                )
                .unwrap();
            let p1 = s1
                .query_map([], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join(" | ");

            let mut s2 = conn
                .prepare(
                    "EXPLAIN QUERY PLAN
                         SELECT id, title FROM sessions
                         WHERE updated_at <= ?1 AND (updated_at < ?1 OR id > ?2)
                         ORDER BY updated_at DESC, id ASC
                         LIMIT ?3",
                )
                .unwrap();
            let p2 = s2
                .query_map(rusqlite::params![300i64, "s-a", 2i64], |r| {
                    r.get::<_, String>(3)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
                .join(" | ");

            Ok((p1, p2))
        })
        .unwrap();

    assert!(
        plan_full.contains("idx_sessions_updated") && !plan_full.contains("TEMP B-TREE"),
        "list_sessions must use idx_sessions_updated without TEMP B-TREE, got: {plan_full}"
    );
    assert!(
        plan_page.contains("idx_sessions_updated") && !plan_page.contains("TEMP B-TREE"),
        "list_sessions_page must use idx_sessions_updated without TEMP B-TREE, got: {plan_page}"
    );

    // 2. 验证排序顺序：(300, s-a), (300, s-b), (200, s-c), (200, s-e), (100, s-d)
    let all = db.list_sessions().unwrap();
    let all_ids: Vec<&str> = all.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(all_ids, vec!["s-a", "s-b", "s-c", "s-e", "s-d"]);

    // 3. 验证 Keyset 游标分页（每次取 2 条，涵盖同 updated_at 的次级键 id ASC 推进）
    let mut paged_ids = Vec::new();
    let mut cursor: Option<(i64, String)> = None;
    loop {
        let page = db
            .list_sessions_page(cursor.as_ref().map(|(ts, id)| (*ts, id.as_str())), 2)
            .unwrap();
        if page.is_empty() {
            break;
        }
        let last = page.last().unwrap();
        cursor = Some((last.updated_at, last.id.clone()));
        for item in page {
            paged_ids.push(item.id);
        }
    }
    assert_eq!(paged_ids, all_ids);
}

// ── G3 定向字段面（C40-C43 存储层）──

fn insert_run_row(db: &LocalDb, run_id: &str, session_id: &str, status: &str) {
    let run_id = run_id.to_string();
    let session_id = session_id.to_string();
    let status = status.to_string();
    db.write_blocking(move |conn| {
        conn.execute(
            "INSERT INTO runs (run_id, session_id, status, end_reason, cursor, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, 0, 0, 0)",
            rusqlite::params![run_id, session_id, status],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
}

fn insert_pending_row(db: &LocalDb, id: &str, session_id: &str) {
    let id = id.to_string();
    let session_id = session_id.to_string();
    db.write_blocking(move |conn| {
        conn.execute(
            "INSERT INTO pending_inputs (id, session_id, run_id, payload, created_at)
             VALUES (?1, ?2, 'r-x', '{}', 0)",
            rusqlite::params![id, session_id],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
}

#[test]
fn g3_targeted_updates_hit_single_columns_only() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s-1", 500)).unwrap();

    assert!(db.update_session_title("s-1", "新标题").unwrap());
    assert!(db.update_session_pinned("s-1", true).unwrap());
    assert!(db.update_session_archived("s-1", true).unwrap());

    let entry = db.get_session_entry("s-1").unwrap().expect("条目应存在");
    assert_eq!(entry.title, "新标题");
    assert!(entry.is_pinned);
    assert!(entry.is_archived);
    // 其余列不动：updated_at 保持原值（定向更新不刷新活动时刻）
    assert_eq!(entry.updated_at, 500);
    assert_eq!(entry.folder, "常规会话");

    // 不存在的会话：命中 false、读取 None（命令层据此回 cmd.not_found）
    assert!(!db.update_session_title("s-missing", "x").unwrap());
    assert!(!db.update_session_pinned("s-missing", true).unwrap());
    assert!(!db.update_session_archived("s-missing", true).unwrap());
    assert!(db.get_session_entry("s-missing").unwrap().is_none());
}

#[test]
fn g3_guarded_delete_removes_row_meta_and_captures_outputs() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s-1", 500)).unwrap();
    db.set_session_meta("s-1:output_dir", "C:/ws/.agent-outputs/s-1")
        .unwrap();
    db.set_session_meta("s-1:output_root", "C:/ws/.agent-outputs")
        .unwrap();
    db.set_session_meta("s-1:other", "v").unwrap();

    let outcome = db.delete_session_guarded("s-1").unwrap();
    assert_eq!(
        outcome,
        SessionDeleteOutcome::Deleted {
            output_dir: Some("C:/ws/.agent-outputs/s-1".to_string()),
            output_root: Some("C:/ws/.agent-outputs".to_string()),
        }
    );
    assert!(db.get_session_entry("s-1").unwrap().is_none());
    // meta 前缀键同事务清干净（RUN-15 口径）
    assert!(db.get_session_meta("s-1:other").unwrap().is_none());
}

#[test]
fn g3_guarded_delete_blocks_active_run_pending_and_hydrated() {
    let db = LocalDb::open_in_memory().unwrap();

    db.upsert_session_entry(&sample_entry("s-run", 500))
        .unwrap();
    insert_run_row(&db, "r-1", "s-run", "running");
    assert_eq!(
        db.delete_session_guarded("s-run").unwrap(),
        SessionDeleteOutcome::Blocked(SessionDeleteBlocker::ActiveRun)
    );
    assert!(db.get_session_entry("s-run").unwrap().is_some());

    // 终态 run 不阻断
    db.upsert_session_entry(&sample_entry("s-done", 500))
        .unwrap();
    insert_run_row(&db, "r-2", "s-done", "completed");
    assert!(matches!(
        db.delete_session_guarded("s-done").unwrap(),
        SessionDeleteOutcome::Deleted { .. }
    ));

    db.upsert_session_entry(&sample_entry("s-pending", 500))
        .unwrap();
    insert_pending_row(&db, "p-1", "s-pending");
    assert_eq!(
        db.delete_session_guarded("s-pending").unwrap(),
        SessionDeleteOutcome::Blocked(SessionDeleteBlocker::PendingInputs)
    );

    let mut hydrated = sample_entry("s-sub", 500);
    hydrated.hydrated_from_engine = Some(true);
    db.upsert_session_entry(&hydrated).unwrap();
    assert_eq!(
        db.delete_session_guarded("s-sub").unwrap(),
        SessionDeleteOutcome::Blocked(SessionDeleteBlocker::EngineHydrated)
    );

    assert_eq!(
        db.delete_session_guarded("s-missing").unwrap(),
        SessionDeleteOutcome::NotFound
    );
}
