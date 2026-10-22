//! 会话删除级联、session_meta 前缀键清理、孤儿清理、touch / insert 时间戳。

use super::*;
use conex_types::SessionAgent;

#[test]
fn delete_session_cascades() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();
    db.save_session_agents(
        "s1",
        &[SessionAgent {
            id: "a1".into(),
            subagent_run_id: "run-1".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-1".into(),
            parent_tool_call_id: None,
            description: "test".into(),
            mode: "explore".into(),
            status: "completed".into(),
            summary: None,
            messages: vec![sample_message("am1", "assistant", 1)],
            started_at: 0,
            ended_at: Some(100),
            depth: Some(0),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
        }],
    )
    .unwrap();

    db.delete_session("s1").unwrap();

    // 级联：messages / agents / agent_messages 应全部被清除
    assert!(db.load_session_body("s1").unwrap().is_empty());
    assert!(db.load_session_agents("s1").unwrap().is_empty());
    assert!(db.list_sessions().unwrap().is_empty());
}

// ===== RUN-15：删除会话级联清理 session_meta 前缀键 =====

/// 按前缀统计 session_meta 键数（测试断言用）
fn count_meta_by_prefix(db: &LocalDb, prefix: &str) -> usize {
    let full = format!("{prefix}%");
    db.read(|conn| {
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM session_meta WHERE key LIKE ?1")
            .unwrap();
        // 前缀含 %/_ 的用例改走 substr 精确路径；此 helper 仅用于普通前缀
        let n: i64 = stmt
            .query_row(rusqlite::params![full], |r| r.get(0))
            .unwrap();
        Ok(n as usize)
    })
    .unwrap()
}

/// delete_session：会话行删除后 `{session_id}:*` 前缀键同事务清零；
/// 其它会话的前缀键与全局键不受影响
#[test]
fn delete_session_cascades_session_meta_prefix_keys() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.upsert_session_entry(&sample_entry("s2")).unwrap();
    // s1 的会话作用域键（output_dir / output_root / explore / revert / compact_stage）
    db.set_session_meta("s1:output_dir", ".agent-outputs/2026-08-05-s1")
        .unwrap();
    db.set_session_meta("s1:output_root", ".agent-outputs")
        .unwrap();
    db.set_session_meta("s1:explore_docs_consumed", "3")
        .unwrap();
    db.set_session_meta("s1:revert_streak_count", "1").unwrap();
    db.set_session_meta("s1:compact_stage_summaries", "[]")
        .unwrap();
    // s2 的键（应保留）+ 全局键（应保留，含含冒号全局键）
    db.set_session_meta("s2:output_dir", ".agent-outputs/2026-08-05-s2")
        .unwrap();
    db.set_session_meta("sched:cron-0", "{}").unwrap();
    db.set_session_meta("workflow:cron-0", "{}").unwrap();
    db.set_session_meta("schema_version", "13").unwrap();

    db.delete_session("s1").unwrap();

    // 删会话 → 按前缀查询 session_meta 返回 0 行（RUN-15 验收 2）
    assert_eq!(count_meta_by_prefix(&db, "s1:"), 0, "s1 前缀键应全部清理");
    assert_eq!(
        db.get_session_meta("s1:output_dir").unwrap(),
        None,
        "output_dir 键不应残留"
    );
    // 其它会话与全局键不受影响
    assert_eq!(
        db.get_session_meta("s2:output_dir").unwrap().as_deref(),
        Some(".agent-outputs/2026-08-05-s2")
    );
    assert_eq!(
        db.get_session_meta("sched:cron-0").unwrap().as_deref(),
        Some("{}")
    );
    assert_eq!(
        db.get_session_meta("workflow:cron-0").unwrap().as_deref(),
        Some("{}")
    );
    assert!(db.get_session_meta("schema_version").unwrap().is_some());
    assert_eq!(db.list_sessions().unwrap().len(), 1, "s2 会话行保留");
}

/// delete_session：会话 id 含 LIKE 通配符时不误删（substr 精确前缀，非 LIKE）
#[test]
fn delete_session_meta_prefix_immune_to_like_wildcards() {
    let db = LocalDb::open_in_memory().unwrap();
    // 会话 id 含 % / _ ：LIKE 展开会误伤其它键，substr 前缀匹配不受影响
    db.upsert_session_entry(&sample_entry("s%1")).unwrap();
    db.upsert_session_entry(&sample_entry("sa1")).unwrap();
    db.set_session_meta("s%1:output_dir", "d1").unwrap();
    db.set_session_meta("sa1:output_dir", "d2").unwrap();

    db.delete_session("s%1").unwrap();

    assert_eq!(
        db.get_session_meta("s%1:output_dir").unwrap(),
        None,
        "目标键应删除"
    );
    assert_eq!(
        db.get_session_meta("sa1:output_dir").unwrap().as_deref(),
        Some("d2"),
        "通配符展开误伤的键必须保留"
    );
}

/// cleanup_orphan_sessions（生产删除路径）：被删孤儿会话的 meta 前缀键级联清理，
/// 宽限期内会话与保留会话的键不受影响
#[test]
fn cleanup_orphan_sessions_cascades_meta_prefix_keys() {
    let db = LocalDb::open_in_memory().unwrap();
    // 孤儿：updated_at 远超宽限期（ORPHAN_GRACE_MS = 300_000ms）
    db.upsert_session_entry(&sample_entry("orphan-1")).unwrap();
    db.upsert_session_entry(&sample_entry("keep-1")).unwrap();
    db.write_blocking(|conn| {
        conn.execute(
            "UPDATE sessions SET updated_at = 1000 WHERE id IN ('orphan-1')",
            [],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    db.set_session_meta("orphan-1:output_dir", "d-old").unwrap();
    db.set_session_meta("orphan-1:explore_docs_consumed", "9")
        .unwrap();
    db.set_session_meta("keep-1:output_dir", "d-keep").unwrap();

    // keep-1 在 keepIds 内；orphan-1 被孤儿清理删除
    let outcomes = db.cleanup_orphan_sessions(&["keep-1".to_string()]).unwrap();
    assert_eq!(outcomes.len(), 1, "应删除 1 个孤儿会话");
    // RUN-07：删除事务内捕获的产出 meta 值随结果返回
    assert_eq!(outcomes[0].session_id, "orphan-1");
    assert_eq!(outcomes[0].output_dir.as_deref(), Some("d-old"));
    assert!(db.list_sessions().unwrap().iter().all(|s| s.id == "keep-1"));
    // meta 键级联：孤儿前缀清零，保留会话键不动
    assert_eq!(
        count_meta_by_prefix(&db, "orphan-1:"),
        0,
        "孤儿 meta 键应级联清理"
    );
    assert_eq!(
        db.get_session_meta("keep-1:output_dir").unwrap().as_deref(),
        Some("d-keep"),
        "保留会话的 meta 键不受影响"
    );
}

#[test]
fn session_meta_roundtrip() {
    let db = LocalDb::open_in_memory().unwrap();
    assert!(db.get_session_meta("missing").unwrap().is_none());

    db.set_session_meta("schema_version", "2").unwrap();
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some("2")
    );

    // 再次 set 应 upsert
    db.set_session_meta("schema_version", "3").unwrap();
    assert_eq!(
        db.get_session_meta("schema_version").unwrap().as_deref(),
        Some("3")
    );
}

#[test]
fn cleanup_orphan_sessions() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.upsert_session_entry(&sample_entry("s2")).unwrap();
    db.upsert_session_entry(&sample_entry("s3")).unwrap();

    let deleted = db.cleanup_orphan_sessions(&["s1".to_string()]).unwrap();
    assert_eq!(deleted.len(), 2);

    let list = db.list_sessions().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "s1");
}

#[test]
fn cleanup_orphan_all_when_active_empty() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.upsert_session_entry(&sample_entry("s2")).unwrap();

    let deleted = db.cleanup_orphan_sessions(&[]).unwrap();
    assert_eq!(deleted.len(), 2);
    assert!(db.list_sessions().unwrap().is_empty());
}

#[test]
fn touch_session_updates_timestamp() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // touch 后 updated_at 应不小于原始 1000
    db.touch_session("s1").unwrap();
    let list = db.list_sessions().unwrap();
    assert!(list[0].updated_at >= 1000);
}

/// N0-2 ④ 回归：insert_session（自愈路径）必须写真实 updated_at——
/// 此前自愈行 updated_at=0，孤儿清理宽限期对其无效，boot 窗口的
/// keepIds 缺失会直接命中这些行（宽限期形同虚设）。
#[test]
fn insert_session_writes_current_updated_at() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "").unwrap();

    let list = db.list_sessions().unwrap();
    assert_eq!(list.len(), 1);
    let ts = list[0].updated_at;
    assert!(ts > 0, "自愈行 updated_at 不得为 0（宽限期需生效）");

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    assert!(
        now - ts < 60_000,
        "updated_at 应为当前时间附近（now={now}, ts={ts}）"
    );

    // 幂等：重复 insert 不覆盖既有 updated_at（OR IGNORE）
    db.insert_session("s1", "dup").unwrap();
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].updated_at, ts, "重复 insert 不重置 updated_at");
}
