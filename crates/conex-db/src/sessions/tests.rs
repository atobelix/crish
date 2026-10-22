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
