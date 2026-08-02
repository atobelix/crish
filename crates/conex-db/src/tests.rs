//! 单元测试（原 lib.rs tests 模块整体迁入，行为不变）。

use super::*;
use crate::messages::parse_session_messages_flexible;
use conex_types::{SessionAgent, SessionIndexEntry, SessionMessage};
use std::collections::HashMap;
use std::sync::Arc;

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

    db.append_event("s1", 1, "user-message", r#"{"text":"hello"}"#).unwrap();
    db.append_event("s1", 2, "assistant-message", r#"{"text":"hi"}"#).unwrap();
    db.append_event("s1", 3, "tool-call", r#"{"name":"search"}"#).unwrap();

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
        db.append_event("s1", i, "event", "{}").unwrap();
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

#[test]
fn duplicate_event_sequence_fails() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();
    db.append_event("s1", 1, "msg", "{}").unwrap();

    // Same session_id + sequence should fail (UNIQUE constraint)
    let result = db.append_event("s1", 1, "msg2", "{}");
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
                .append_event("s1", i + 1, "event", &format!(r#"{{"i":{i}}}"#))
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
        &[sample_message("m1", "user", 1), sample_message("m2", "assistant", 2)],
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
    db.save_session_body("s1", &[sample_message("m1", "user", 1)]).unwrap();
    // 再次保存覆盖
    db.save_session_body(
        "s1",
        &[sample_message("m2", "user", 2), sample_message("m3", "assistant", 3)],
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
    db.save_session_body("s1", &[sample_message("m1", "user", 1)]).unwrap();

    db.append_session_messages(
        "s1",
        &[sample_message("m2", "assistant", 2), sample_message("m3", "user", 3)],
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
        &[sample_message("m1", "user", 1), sample_message("m2", "assistant", 2)],
    )
    .unwrap();

    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].message_count, 2);

    db.append_session_messages("s1", &[sample_message("m3", "user", 3)]).unwrap();
    let list2 = db.list_sessions().unwrap();
    assert_eq!(list2[0].message_count, 3);

    // save_session_body 替换为 1 条：先 delete(-2) 再 insert(+1) = -1
    db.save_session_body("s1", &[sample_message("m-only", "user", 10)]).unwrap();
    let list3 = db.list_sessions().unwrap();
    assert_eq!(list3[0].message_count, 1);
}

#[test]
fn delete_session_cascades() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body("s1", &[sample_message("m1", "user", 1)]).unwrap();
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
}

#[test]
fn session_meta_roundtrip() {
    let db = LocalDb::open_in_memory().unwrap();
    assert!(db.get_session_meta("missing").unwrap().is_none());

    db.set_session_meta("schema_version", "2").unwrap();
    assert_eq!(db.get_session_meta("schema_version").unwrap().as_deref(), Some("2"));

    // 再次 set 应 upsert
    db.set_session_meta("schema_version", "3").unwrap();
    assert_eq!(db.get_session_meta("schema_version").unwrap().as_deref(), Some("3"));
}

#[test]
fn schema_version_is_four() {
    let db = LocalDb::open_in_memory().unwrap();
    let v = db
        .get_session_meta("schema_version")
        .unwrap()
        .expect("schema_version should be set by migrate()");
    assert_eq!(v, SCHEMA_VERSION_STRING);
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
    let folder = db.get_session_meta("folder_order").unwrap().expect("folder_order");
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
