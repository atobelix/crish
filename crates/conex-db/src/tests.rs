//! 核心 API 与事务单测（原 lib.rs tests 模块核心部分，行为不变）。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::messages::parse_session_messages_flexible;
use conex_types::{SessionAgent, SessionIndexEntry, SessionMessage};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn open_in_memory_and_migrate() {
    let db = LocalDb::open_in_memory().unwrap();
    assert!(db.get_failure().is_none());
}

#[test]
fn insert_and_query_session() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Test Session").unwrap();

    // Inserting same session again should not error (OR IGNORE)
    db.insert_session("s1", "Duplicate").unwrap();
}

#[test]
fn append_and_query_events() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    db.append_event("s1", 1, "user-message", r#"{"text":"hello"}"#, None)
        .unwrap();
    db.append_event("s1", 2, "assistant-message", r#"{"text":"hi"}"#, None)
        .unwrap();
    db.append_event("s1", 3, "tool-call", r#"{"name":"search"}"#, None)
        .unwrap();

    // Query all events (无限制)
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event_type, "user-message");
    assert_eq!(events[2].sequence, 3);

    // Query after sequence 1
    let events_after = db.query_events("s1", 1, None).unwrap();
    assert_eq!(events_after.len(), 2);
    assert_eq!(events_after[0].sequence, 2);
}

#[test]
fn query_events_respects_limit() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    for i in 1..=5 {
        db.append_event("s1", i, "event", "{}", None).unwrap();
    }

    let limited = db.query_events("s1", 0, Some(3)).unwrap();
    assert_eq!(limited.len(), 3);
    assert_eq!(limited[0].sequence, 1);
    assert_eq!(limited[2].sequence, 3);
}

#[test]
fn query_events_empty_session() {
    let db = LocalDb::open_in_memory().unwrap();
    let events = db.query_events("nonexistent", 0, None).unwrap();
    assert!(events.is_empty());
}

// ===== DM-02：run_id 归属写入回读 + 按 run 查询 + created_at 毫秒 =====

/// run_id 写入与读取 roundtrip：append 带 run_id → query_events 回读
/// StoredEvent.run_id 列值一致；None 行保持 NULL。
#[test]
fn append_event_run_id_roundtrip() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    db.append_event("s1", 1, "agent-start", "{}", Some("run-1"))
        .unwrap();
    db.append_event("s1", 2, "agent-end", "{}", Some("run-1"))
        .unwrap();
    db.append_event("s1", 3, "idle", "{}", None).unwrap();

    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].run_id.as_deref(), Some("run-1"), "run_id 列回读");
    assert_eq!(events[1].run_id.as_deref(), Some("run-1"));
    assert_eq!(events[2].run_id, None, "None 行保持 NULL");
}

/// 交错 run 只返本 run（按 sequence 升序）+ after 开区间（> after）。
#[test]
fn query_events_by_run_filters_own_run_and_after_open_interval() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    db.append_event("s1", 1, "agent-start", "{}", Some("run-a"))
        .unwrap();
    db.append_event("s1", 2, "agent-start", "{}", Some("run-b"))
        .unwrap();
    db.append_event("s1", 3, "agent-end", "{}", Some("run-a"))
        .unwrap();
    db.append_event("s1", 4, "agent-end", "{}", Some("run-b"))
        .unwrap();

    let a = db.query_events_by_run("s1", "run-a", 0, None).unwrap();
    assert_eq!(a.len(), 2, "交错 run 只返本 run");
    assert_eq!(a[0].sequence, 1);
    assert_eq!(a[1].sequence, 3);
    assert_eq!(a[1].event_type, "agent-end");
    assert!(a.iter().all(|e| e.run_id.as_deref() == Some("run-a")));

    let b = db.query_events_by_run("s1", "run-b", 0, None).unwrap();
    assert_eq!(b.len(), 2);
    assert_eq!(b[0].sequence, 2);

    // after 开区间：sequence > after，不含 after 本身
    let a_after = db.query_events_by_run("s1", "run-a", 1, None).unwrap();
    assert_eq!(a_after.len(), 1);
    assert_eq!(a_after[0].sequence, 3);
}

/// limit 直下推：只返前 limit 条（按 sequence 升序）。
#[test]
fn query_events_by_run_limit_effective() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    for i in 1..=5 {
        db.append_event("s1", i, "event", "{}", Some("run-x"))
            .unwrap();
    }

    let limited = db.query_events_by_run("s1", "run-x", 0, Some(3)).unwrap();
    assert_eq!(limited.len(), 3);
    assert_eq!(limited[0].sequence, 1);
    assert_eq!(limited[2].sequence, 3);

    let unlimited = db.query_events_by_run("s1", "run-x", 0, None).unwrap();
    assert_eq!(unlimited.len(), 5, "None 等价无限制");
}

/// 空结果（无匹配 run）+ run_id NULL 行不命中 by_run 但按会话命中。
#[test]
fn query_events_by_run_empty_and_null_run_id_not_matched() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    // 仅会话域事件（run_id = NULL）与另一个 run 的事件
    db.append_event("s1", 1, "idle", "{}", None).unwrap();
    db.append_event("s1", 2, "agent-start", "{}", Some("other-run"))
        .unwrap();

    assert!(
        db.query_events_by_run("s1", "no-such-run", 0, None)
            .unwrap()
            .is_empty(),
        "不存在的 run → 空结果"
    );
    assert!(
        db.query_events_by_run("s1", "no-such-run", 0, Some(10))
            .unwrap()
            .is_empty(),
        "带 limit 的未命中同样为空"
    );
    // run_id NULL 行不命中任何 by_run（SQL NULL 比较语义）
    assert!(
        db.query_events_by_run("s1", "other-run", 0, None)
            .unwrap()
            .iter()
            .all(|e| e.sequence != 1),
        "NULL run_id 行不命中 by_run"
    );
    // 但按会话查询命中（含 NULL 行）
    let all = db.query_events("s1", 0, None).unwrap();
    assert_eq!(all.len(), 2, "会话查询含 NULL run_id 行");
    assert_eq!(all[0].run_id, None);
}

/// 新行 created_at 毫秒精度断言：INSERT 显式写 `%Y-%m-%d %H:%M:%S.%f`
/// 形态（23 字符：`YYYY-MM-DD HH:MM:SS.SSS`），不再依赖秒级列 DEFAULT。
#[test]
fn append_event_created_at_millisecond_precision() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();
    db.append_event("s1", 1, "agent-start", "{}", Some("run-1"))
        .unwrap();

    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 1);
    let created_at = &events[0].created_at;
    assert_eq!(
        created_at.len(),
        23,
        "created_at 应为 YYYY-MM-DD HH:MM:SS.SSS，实际: {created_at}"
    );
    let bytes = created_at.as_bytes();
    assert_eq!(bytes[4], b'-');
    assert_eq!(bytes[7], b'-');
    assert_eq!(bytes[10], b' ');
    assert_eq!(bytes[13], b':');
    assert_eq!(bytes[16], b':');
    assert_eq!(bytes[19], b'.');
    assert!(
        created_at[..4].chars().all(|c| c.is_ascii_digit()),
        "年份为数字: {created_at}"
    );
    assert!(
        created_at[20..].chars().all(|c| c.is_ascii_digit()),
        "毫秒为三位数字: {created_at}"
    );
}

#[test]
fn duplicate_event_sequence_fails() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();
    db.append_event("s1", 1, "msg", "{}", None).unwrap();

    // Same session_id + sequence should fail (UNIQUE constraint)
    let result = db.append_event("s1", 1, "msg2", "{}", None);
    assert!(result.is_err());
    // Failure latch should be set
    assert!(db.get_failure().is_some());
}

#[test]
fn concurrent_access() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();

    let db_arc = Arc::new(db);
    let mut handles = vec![];

    for i in 0..10 {
        let db_clone = Arc::clone(&db_arc);
        handles.push(std::thread::spawn(move || {
            db_clone
                .append_event("s1", i + 1, "event", &format!(r#"{{"i":{i}}}"#), None)
                .unwrap();
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let events = db_arc.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 10);
}

// ===== Stream B 新增测试 =====

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
fn upsert_and_list_sessions() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.upsert_session_entry(&sample_entry("s2")).unwrap();

    let list = db.list_sessions().unwrap();
    assert_eq!(list.len(), 2);
    // updated_at 相同，按 id 升序
    assert_eq!(list[0].id, "s1");
    assert_eq!(list[1].id, "s2");
}

#[test]
fn upsert_does_not_cascade_delete_messages() {
    // INSERT OR REPLACE 会触发 ON DELETE CASCADE，必须用 ON CONFLICT DO UPDATE
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();

    // 再次 upsert 同一会话，不应丢失消息
    let mut entry = sample_entry("s1");
    entry.title = "Updated Title".to_string();
    db.upsert_session_entry(&entry).unwrap();

    let body = db.load_session_body("s1").unwrap();
    assert_eq!(body.len(), 2, "messages must survive upsert");
    assert_eq!(db.list_sessions().unwrap()[0].title, "Updated Title");
}

#[test]
fn save_and_load_session_body() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let msgs = vec![
        sample_message("m1", "user", 100),
        sample_message("m2", "assistant", 200),
        sample_message("m3", "user", 300),
    ];
    db.save_session_body("s1", &msgs).unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[0].id, "m1");
    assert_eq!(loaded[2].id, "m3");
    assert_eq!(loaded[1].sender, "assistant");
}

#[test]
fn save_session_body_replaces() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();
    // 再次保存覆盖
    db.save_session_body(
        "s1",
        &[
            sample_message("m2", "user", 2),
            sample_message("m3", "assistant", 3),
        ],
    )
    .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id, "m2");
}

#[test]
fn append_session_messages_increments_seq() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();

    db.append_session_messages(
        "s1",
        &[
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 3);
    assert_eq!(loaded[2].id, "m3");
}

#[test]
fn trigger_maintains_message_count() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();

    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].message_count, 2);

    db.append_session_messages("s1", &[sample_message("m3", "user", 3)])
        .unwrap();
    let list2 = db.list_sessions().unwrap();
    assert_eq!(list2[0].message_count, 3);

    // save_session_body 替换为 1 条：先 delete(-2) 再 insert(+1) = -1
    db.save_session_body("s1", &[sample_message("m-only", "user", 10)])
        .unwrap();
    let list3 = db.list_sessions().unwrap();
    assert_eq!(list3[0].message_count, 1);
}

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

#[test]
fn save_and_load_session_agents() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let agents = vec![
        SessionAgent {
            id: "a1".into(),
            subagent_run_id: "run-1".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-1".into(),
            parent_tool_call_id: Some("tc-1".into()),
            description: "explore".into(),
            mode: "explore".into(),
            status: "completed".into(),
            summary: Some("done".into()),
            messages: vec![sample_message("am1", "assistant", 1)],
            started_at: 100,
            ended_at: Some(200),
            depth: Some(0),
            subagent_path_json: Some(r#"["a1"]"#.into()),
            task_type: Some("analysis".into()),
            display_label: Some("Rust 内核分析师".into()),
            allowed_write_paths_json: Some(r#"["docs/notes"]"#.into()),
            sub_session_id: Some("sub-sess-0-1".into()),
        },
        SessionAgent {
            id: "a2".into(),
            subagent_run_id: "run-2".into(),
            parent_session_id: "s1".into(),
            parent_run_id: "prun-2".into(),
            parent_tool_call_id: None,
            description: "implement".into(),
            mode: "implement".into(),
            status: "running".into(),
            summary: None,
            messages: vec![],
            started_at: 300,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: Some("implementation".into()),
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
        },
    ];
    db.save_session_agents("s1", &agents).unwrap();

    let loaded = db.load_session_agents("s1").unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id, "a1");
    assert_eq!(loaded[0].messages.len(), 1);
    assert_eq!(loaded[0].summary.as_deref(), Some("done"));
    assert_eq!(loaded[1].id, "a2");
    assert!(loaded[1].messages.is_empty());
    // T-D-07 v6 新列读写（display_label 读回 + task_type / 写路径白名单）
    assert_eq!(loaded[0].task_type.as_deref(), Some("analysis"));
    assert_eq!(loaded[0].display_label.as_deref(), Some("Rust 内核分析师"));
    assert_eq!(
        loaded[0].allowed_write_paths_json.as_deref(),
        Some(r#"["docs/notes"]"#)
    );
    assert_eq!(loaded[1].task_type.as_deref(), Some("implementation"));
    assert_eq!(loaded[1].display_label, None, "未声明的列为 None");
    assert_eq!(loaded[1].allowed_write_paths_json, None);
    // D-02 LK-04 v9 列读写（sub_session_id 读回；未声明 = None）
    assert_eq!(
        loaded[0].sub_session_id.as_deref(),
        Some("sub-sess-0-1"),
        "sub_session_id 随行读回"
    );
    assert_eq!(loaded[1].sub_session_id, None, "未声明子会话映射 = None");
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
    assert_eq!(deleted, 2);

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
    assert_eq!(deleted, 2);
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

#[test]
fn parse_session_messages_flexible_handles_empty() {
    assert!(parse_session_messages_flexible("").is_empty());
    assert!(parse_session_messages_flexible("   \n  ").is_empty());
}

#[test]
fn parse_session_messages_flexible_handles_bad_jsonl() {
    let raw = "not json\n{\"id\":\"m1\",\"sender\":\"user\",\"timestamp\":1}\nalso bad";
    let msgs = parse_session_messages_flexible(raw);
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].id, "m1");
}
