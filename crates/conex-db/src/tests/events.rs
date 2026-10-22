//! 事件表：建库迁移、追加 / 查询、run_id 归属、序号预留与并发访问。

use super::*;
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
fn reserve_sequence_single_stmt_returns_monotonic() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "S").unwrap();
    // 冷路径 seed + 热路径 RETURNING：1,2,3 连续单调
    assert_eq!(db.reserve_sequence("s1").unwrap(), 1);
    assert_eq!(db.reserve_sequence("s1").unwrap(), 2);
    assert_eq!(db.reserve_sequence("s1").unwrap(), 3);
    // seed 只抬高不回退
    db.seed_sequence("s1", 10).unwrap();
    assert_eq!(db.reserve_sequence("s1").unwrap(), 10);
}

#[test]
fn duplicate_event_sequence_fails() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "Session").unwrap();
    db.append_event("s1", 1, "msg", "{}", None).unwrap();

    // Same session_id + sequence should fail (UNIQUE constraint)
    let result = db.append_event("s1", 1, "msg2", "{}", None);
    assert!(result.is_err());
    // D3 写单轨：错误经组提交 Actor oneshot 回传（Result 为 Err）；
    // failure latch 为 DB 级致命故障闩（open 失败等），单条约束冲突不强制 latch。
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
