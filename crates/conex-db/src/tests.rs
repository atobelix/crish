//! 核心 API 与事务单测（原 lib.rs tests 模块核心部分，行为不变）。

// G2 禁令豁免：测试临时 DB 清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use crate::messages::parse_session_messages_flexible;
use conex_types::{SessionAgent, SessionIndexEntry, SessionMessage};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// 真实临时 WAL 文件库守卫（open_temp_wal_for_test 尚未落地，先用
/// 与 tests_concurrency 同源的 tempfile 真库模式；禁止用纯内存库冒充
/// 持久化 Upsert / Diff Shrink 验收）。
struct TempWalDbGuard {
    path: std::path::PathBuf,
}

impl Drop for TempWalDbGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(format!("{}-wal", self.path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", self.path.display()));
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

/// 打开真实临时 WAL 文件库（LocalDb::open → 完整迁移链 + 单写 Actor + ReaderPool）。
fn open_temp_wal_db() -> (LocalDb, TempWalDbGuard) {
    static TEST_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = TEST_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "conex_msg_body_{}_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        id
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("sessions.db");
    let db = LocalDb::open(&path).expect("open temp wal db");
    (db, TempWalDbGuard { path })
}

#[test]
fn two_recovery_events_and_session_meta_commit_with_contiguous_sequences() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "recovery batch").unwrap();

    let first = db.reserve_sequence("s1").unwrap();
    assert_eq!(first, 1);
    db.append_event("s1", first, "existing", "{}", None)
        .unwrap();

    let sequences = db
        .append_two_events_and_set_session_meta(
            "s1",
            ("recovery-escalated", r#"{"type":"recovery-escalated"}"#),
            ("recover_notifications", r#"[{"pending":true}]"#),
            ("recovery-steering", r#"{"type":"recovery-steering"}"#),
        )
        .unwrap();

    assert_eq!(sequences, [2, 3]);
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(events[1].event_type, "recovery-escalated");
    assert_eq!(events[1].payload, r#"{"type":"recovery-escalated"}"#);
    assert_eq!(events[2].event_type, "recovery-steering");
    assert_eq!(events[2].payload, r#"{"type":"recovery-steering"}"#);
    assert_eq!(events[1].run_id, None);
    assert_eq!(events[2].run_id, None);
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":true}]"#)
    );
}

#[test]
fn two_recovery_events_and_session_meta_roll_back_as_one_transaction() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "recovery batch rollback").unwrap();
    db.set_session_meta("recover_notifications", "old").unwrap();
    db.write_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_recovery_steering
             BEFORE INSERT ON events
             WHEN NEW.event_type = 'recovery-steering'
             BEGIN SELECT RAISE(ABORT, 'injected recovery batch failure'); END;",
        )
        .map_err(|e| DbFailure {
            message: e.to_string(),
            kind: DbFailureKind::Other("test_trigger".to_string()),
        })?;
        Ok(())
    })
    .unwrap();

    let failed = db.append_two_events_and_set_session_meta(
        "s1",
        ("recovery-escalated", r#"{"type":"recovery-escalated"}"#),
        ("recover_notifications", r#"[{"pending":true}]"#),
        ("recovery-steering", r#"{"type":"recovery-steering"}"#),
    );
    assert!(failed.is_err(), "触发器必须注入第二个事件插入失败");
    assert!(db.query_events("s1", 0, None).unwrap().is_empty());
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some("old"),
        "事件失败时元数据必须回滚"
    );

    db.write_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER reject_recovery_steering;")
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("test_trigger".to_string()),
            })?;
        Ok(())
    })
    .unwrap();
    let sequences = db
        .append_two_events_and_set_session_meta(
            "s1",
            ("recovery-escalated", r#"{"type":"recovery-escalated"}"#),
            ("recover_notifications", r#"[{"pending":true}]"#),
            ("recovery-steering", r#"{"type":"recovery-steering"}"#),
        )
        .unwrap();
    assert_eq!(sequences, [1, 2], "失败事务的序号预留也必须回滚");
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_type, "recovery-escalated");
    assert_eq!(events[1].event_type, "recovery-steering");
    assert_eq!(events[0].run_id, None);
    assert_eq!(events[1].run_id, None);
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":true}]"#)
    );
}

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
fn save_session_body_cas_conflict_rejects_stale_batch() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 首批 batch_version=1 成功
    db.save_session_body_versioned("s1", &[sample_message("m1", "user", 1)], Some(1))
        .unwrap();
    let list = db.list_sessions().unwrap();
    assert_eq!(list[0].message_count, 1);

    // 陈旧批次 batch_version=1（<= 当前 body_version=1）→ CasConflict
    let err = db
        .save_session_body_versioned("s1", &[sample_message("m-stale", "user", 2)], Some(1))
        .unwrap_err();
    assert_eq!(err.kind, crate::error::DbFailureKind::CasConflict);
    // 冲突批次不得污染正文
    assert_eq!(db.load_session_body("s1").unwrap().len(), 1);

    // 更新批次 batch_version=2 成功
    db.save_session_body_versioned(
        "s1",
        &[
            sample_message("m2", "user", 3),
            sample_message("m3", "assistant", 4),
        ],
        Some(2),
    )
    .unwrap();
    let list2 = db.list_sessions().unwrap();
    assert_eq!(list2[0].message_count, 2);
}

/// 回归（实证 2026-09-15，真实宿主）：重启后首批 `None`（rebase）必须把
/// `body_version` **归零**，使前端随后递传的 `Some(1..n)` 与库中序列连续。
///
/// 旧实现只更新 `message_count`、保留旧纪元版本 ⇒ 首批 rebase 之后每一批都
/// 命中 `n <= 旧纪元版本` 而 `CasConflict`，真实宿主表现为 **65 个会话的正文
/// 全部写不进 SQLite、整批降级 LS**（前端批次计数器是模块级内存变量，每次
/// 启动从 0 开始，首批恒为 1）。
#[test]
fn rebase_resets_body_version_so_post_restart_batches_are_accepted() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 旧纪元：上次运行写到 batch_version=40（留下高 body_version）
    db.save_session_body_versioned("s1", &[sample_message("m1", "user", 1)], Some(40))
        .unwrap();

    // 模拟重启：前端首批传 None（显式 rebase）——必须成功并归零纪元
    db.save_session_body_versioned("s1", &[sample_message("m1", "user", 1)], None)
        .unwrap();

    // 重启后的递增批次必须被接受（旧实现此处恒 CasConflict）
    db.save_session_body_versioned(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
        Some(1),
    )
    .unwrap();
    db.save_session_body_versioned(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
        Some(2),
    )
    .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 3);

    // 归零不得削弱 CAS 防线：同版本重放仍被拒
    let err = db
        .save_session_body_versioned("s1", &[sample_message("m4", "user", 4)], Some(2))
        .unwrap_err();
    assert_eq!(err.kind, crate::error::DbFailureKind::CasConflict);
    assert_eq!(
        db.load_session_body("s1").unwrap().len(),
        3,
        "冲突批次不得污染正文"
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

/// 追加语义：短数组 → 长数组时 Diff Shrink 匹配 0 行，尾部仅新增 Upsert。
#[test]
fn save_session_body_append_grows_and_keeps_prefix() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 1);
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1);

    // 追加：前缀 m1 保持，新增 m2 / m3
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 3, "追加后物理行数 = 新长度");
    assert_eq!(loaded[0].id, "m1");
    assert_eq!(loaded[1].id, "m2");
    assert_eq!(loaded[2].id, "m3");
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 3);
}

/// 覆盖语义：同长度数组按 (session_id, seq) Upsert 全字段（含 id/sender/text）。
#[test]
fn save_session_body_upsert_overwrites_all_fields() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();

    // 同长度再保存：同 seq 位置全字段被 excluded 覆盖
    let mut m1 = sample_message("m1-x", "assistant", 10);
    m1.text = Some("overwritten".into());
    db.save_session_body("s1", &[m1, sample_message("m3", "user", 3)])
        .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 2, "同长度覆盖不增不减行");
    assert_eq!(loaded[0].id, "m1-x", "id 全字段覆盖");
    assert_eq!(loaded[0].sender, "assistant", "sender 全字段覆盖");
    assert_eq!(
        loaded[0].text.as_deref(),
        Some("overwritten"),
        "text 全字段覆盖"
    );
    assert_eq!(loaded[1].id, "m3");
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 2);
}

/// Diff Shrink 收缩语义：长数组 → 短数组时仅删 seq >= 新长度的尾部。
#[test]
fn save_session_body_diff_shrink_removes_tail() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 3);

    // 收缩：保留前缀 m1，物理删除 seq >= 1 的尾部
    db.save_session_body("s1", &[sample_message("m1", "user", 1)])
        .unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 1, "Diff Shrink 后仅剩前缀");
    assert_eq!(loaded[0].id, "m1");
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        1,
        "message_count 绝对赋值 = messages.len()"
    );
}

/// 清空语义：空数组 + Diff Shrink(seq >= 0) 清空该会话全部消息行。
#[test]
fn save_session_body_clear_empty_array_empties_session() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "user", 2),
        ],
    )
    .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 2);

    // 显式清空（空数组）：显式 CAS 版本号推进清空
    db.save_session_body_versioned("s1", &[], Some(1)).unwrap();

    assert!(db.load_session_body("s1").unwrap().is_empty());
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 0);
}

/// 覆盖 + 收缩组合：既有字段覆盖又有尾部收缩，端到端行数与内容一致。
#[test]
fn save_session_body_replace_with_shrink_combined() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
            sample_message("m3", "user", 3),
        ],
    )
    .unwrap();
    // 再次保存：覆盖 m1 全字段 + 收缩删除 m2/m3
    let mut m1 = sample_message("m1b", "assistant", 20);
    m1.text = Some("rewritten".into());
    db.save_session_body("s1", &[m1]).unwrap();

    let loaded = db.load_session_body("s1").unwrap();
    assert_eq!(loaded.len(), 1, "覆盖 + 收缩后仅 1 行");
    assert_eq!(loaded[0].id, "m1b");
    assert_eq!(loaded[0].text.as_deref(), Some("rewritten"));
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1);
}

/// message_count 绝对赋值：与序列长度严格相等（追加 / 收缩 / 清空三段）。
#[test]
fn message_count_absolute_assign_tracks_len() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 追加：2 条
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 2);

    // 收缩：1 条（旧「先 delete(-2) 再 insert(+1)」触发器双轨口径已退役）
    db.save_session_body("s1", &[sample_message("m-only", "user", 10)])
        .unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 1);

    // 显式清空：0 条（需带 CAS 版本）
    db.save_session_body_versioned("s1", &[], Some(1)).unwrap();
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 0);
}

/// Task-2 物理防误删守卫：无 CAS 的盲写空数组禁止清空已有历史消息或历史事件的会话。
#[test]
fn save_session_body_empty_without_cas_guarded_against_accidental_delete() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    // 1. 会话已有 2 条消息，盲写空数组 (batch_version = None) 必须被物理拦截
    db.save_session_body(
        "s1",
        &[
            sample_message("m1", "user", 1),
            sample_message("m2", "assistant", 2),
        ],
    )
    .unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 2);

    // 模拟前端启动未水合懒壳盲写 []
    db.save_session_body("s1", &[]).unwrap();

    // 消息完好保留，message_count 未被归零
    assert_eq!(
        db.load_session_body("s1").unwrap().len(),
        2,
        "盲写空数组必须被物理拦截，消息不能丢失"
    );
    assert_eq!(
        db.list_sessions().unwrap()[0].message_count,
        2,
        "message_count 必须保持原值"
    );

    // 2. 会话 session_messages 为空，但在 events 表中存在 message-start / message-end
    db.upsert_session_entry(&sample_entry("s2")).unwrap();
    db.append_event(
        "s2",
        1,
        "message-start",
        r#"{"type":"message-start","sessionId":"s2"}"#,
        None,
    )
    .unwrap();
    db.append_event(
        "s2",
        2,
        "message-end",
        r#"{"type":"message-end","sessionId":"s2"}"#,
        None,
    )
    .unwrap();

    // 对 s2 尝试盲写空数组：因为 events 表存在对话事件，同样被守卫拦截
    db.save_session_body("s2", &[]).unwrap();

    // 3. 真正无消息且无事件的纯新空会话，盲写空数组允许放行
    db.upsert_session_entry(&sample_entry("s_empty")).unwrap();
    db.save_session_body("s_empty", &[]).unwrap();
    assert_eq!(db.load_session_body("s_empty").unwrap().len(), 0);

    // 4. 显式带有 CAS 版本号的清空操作，允许正常清空
    db.save_session_body_versioned("s1", &[], Some(1)).unwrap();
    assert_eq!(db.load_session_body("s1").unwrap().len(), 0);
    assert_eq!(db.list_sessions().unwrap()[0].message_count, 0);
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

// ===== 全局恢复排他租约（04 详案 §6.2：session_meta 键，零 DDL） =====

#[test]
fn recovery_lease_acquire_exclusive_renew_release_flow() {
    let db = LocalDb::open_in_memory().unwrap();

    // 首次抢占成功
    assert!(db.try_acquire_recovery_lease("proc-a", None).unwrap());
    // 他人未过期抢占被拒
    assert!(!db.try_acquire_recovery_lease("proc-b", None).unwrap());
    // 同一实例未过期重抢也被拒（须走 renew）
    assert!(!db.try_acquire_recovery_lease("proc-a", None).unwrap());

    // 持有者可续期；他人续期被拒
    assert!(db.renew_recovery_lease("proc-a", None).unwrap());
    assert!(!db.renew_recovery_lease("proc-b", None).unwrap());

    // 他人释放失败；持有者释放成功；释放后可被他人抢占
    assert!(!db.release_recovery_lease("proc-b").unwrap());
    assert!(db.release_recovery_lease("proc-a").unwrap());
    assert!(db.get_session_meta(RECOVERY_LEASE_KEY).unwrap().is_none());
    assert!(db.try_acquire_recovery_lease("proc-b", None).unwrap());
}

#[test]
fn recovery_lease_expired_can_be_taken_over() {
    let db = LocalDb::open_in_memory().unwrap();

    // 以极短 TTL 抢占，等待其过期
    assert!(db.try_acquire_recovery_lease("proc-a", Some(1)).unwrap());
    std::thread::sleep(std::time::Duration::from_millis(10));

    // 过期后他人可接管（Fail-Safe TTL 容灾）
    assert!(db.try_acquire_recovery_lease("proc-b", None).unwrap());
    // 过期租约上原持有者续期失败（已易主）
    assert!(!db.renew_recovery_lease("proc-a", None).unwrap());
    assert!(db.release_recovery_lease("proc-b").unwrap());
}

// ===== ADD-01：save_session_agents 增量 Upsert + 移除差集（禁级联抹白）=====

fn sample_agent(id: &str, status: &str, messages: Vec<SessionMessage>) -> SessionAgent {
    SessionAgent {
        id: id.into(),
        subagent_run_id: format!("run-{id}"),
        parent_session_id: "s1".into(),
        parent_run_id: format!("prun-{id}"),
        parent_tool_call_id: None,
        description: format!("desc-{id}"),
        mode: "explore".into(),
        status: status.into(),
        summary: None,
        messages,
        started_at: 100,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    }
}

/// ADD-01 物证：save_session_agents 仅更新元数据（状态流转）后，
/// session_agent_messages 历史消息必须完整存活——零级联抹白。
#[test]
fn save_session_agents_metadata_update_preserves_messages() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let mut a1 = sample_agent(
        "a1",
        "running",
        vec![
            sample_message("am1", "assistant", 1),
            sample_message("am2", "user", 2),
        ],
    );
    db.save_session_agents("s1", std::slice::from_ref(&a1))
        .unwrap();

    // 状态流转 running → completed（快照仍携带全部消息）
    a1.status = "completed".into();
    a1.ended_at = Some(300);
    db.save_session_agents("s1", &[a1]).unwrap();

    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "completed");
    assert_eq!(rows[0].ended_at, Some(300));
    assert_eq!(
        rows[0].messages.len(),
        2,
        "状态更新后子代理历史消息必须存活（零级联抹白）"
    );
    assert_eq!(rows[0].messages[0].id, "am1");
    assert_eq!(rows[0].messages[1].id, "am2");
}

/// 消息 Upsert + 尾部收缩：短数组覆盖长数组时多余 seq 被清理，内容以载荷为准。
#[test]
fn save_session_agents_message_upsert_and_tail_shrink() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let a1 = sample_agent(
        "a1",
        "running",
        vec![
            sample_message("am1", "assistant", 1),
            sample_message("am2", "assistant", 2),
            sample_message("am3", "assistant", 3),
        ],
    );
    db.save_session_agents("s1", std::slice::from_ref(&a1))
        .unwrap();

    // 缩短为 2 条 + 更新首条内容
    let mut shorter = a1.clone();
    shorter.messages = vec![
        {
            let mut m = sample_message("am1", "assistant", 1);
            m.text = Some("updated".into());
            m
        },
        sample_message("am2x", "user", 2),
    ];
    db.save_session_agents("s1", &[shorter]).unwrap();

    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows[0].messages.len(), 2, "尾部收缩清理多余 seq");
    assert_eq!(rows[0].messages[0].text.as_deref(), Some("updated"));
    assert_eq!(rows[0].messages[1].id, "am2x");
}

/// 移除差集：本次列表未包含的 agent 行被删除（级联仅作用于确要移除的行）；
/// 保留行的消息不受影响。
#[test]
fn save_session_agents_removal_diff_set() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();

    let a1 = sample_agent(
        "a1",
        "completed",
        vec![sample_message("am1", "assistant", 1)],
    );
    let a2 = sample_agent("a2", "running", vec![sample_message("bm1", "assistant", 1)]);
    db.save_session_agents("s1", &[a1.clone(), a2]).unwrap();
    assert_eq!(db.load_session_agents("s1").unwrap().len(), 2);

    // 仅保留 a1：a2 应被移除差集删除（其消息随之级联），a1 消息存活
    db.save_session_agents("s1", &[a1]).unwrap();
    let rows = db.load_session_agents("s1").unwrap();
    assert_eq!(rows.len(), 1, "未包含的 agent 行被移除");
    assert_eq!(rows[0].id, "a1");
    assert_eq!(rows[0].messages.len(), 1, "保留行消息不受差集影响");
}

/// 空列表 = 显式清空该会话全部子代理元数据（允许级联清消息）。
#[test]
fn save_session_agents_empty_list_clears_session() {
    let (db, _guard) = open_temp_wal_db();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.save_session_agents(
        "s1",
        &[sample_agent(
            "a1",
            "completed",
            vec![sample_message("am1", "assistant", 1)],
        )],
    )
    .unwrap();

    db.save_session_agents("s1", &[]).unwrap();
    assert!(
        db.load_session_agents("s1").unwrap().is_empty(),
        "空列表显式清空全部子代理"
    );
}

// ===== 导入路径 Upsert：冲突以载荷覆盖 + 差集（DEL-05 / DEL-05b）=====

/// 导入幂等 + 覆盖：重复导入时 session_messages / session_agents 以载荷
/// DO UPDATE，且载荷未包含的 agent 被移除差集删除（无全量 DELETE 毁窗）。
#[test]
fn import_agents_and_messages_upsert_with_removal_diff() {
    let (db, _guard) = open_temp_wal_db();

    let index = serde_json::json!([{
        "id": "s1",
        "title": "T",
        "updatedAt": 1,
        "messageCount": 1,
    }])
    .to_string();

    let agent_json = |ids: &[&str], msg_ids: &[&str]| -> String {
        let list: Vec<serde_json::Value> = ids
            .iter()
            .map(|id| {
                let msgs: Vec<serde_json::Value> = msg_ids
                    .iter()
                    .map(|mid| {
                        serde_json::json!({
                            "id": mid,
                            "sender": "assistant",
                            "text": format!("text-{mid}"),
                            "timestamp": 1,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": id,
                    "subagentRunId": format!("run-{id}"),
                    "parentSessionId": "s1",
                    "parentRunId": format!("prun-{id}"),
                    "description": format!("desc-{id}"),
                    "mode": "explore",
                    "status": "completed",
                    "messages": msgs,
                    "startedAt": 0,
                })
            })
            .collect();
        serde_json::to_string(&list).unwrap()
    };

    // 首次导入：a1+a2，消息 am1/am2
    let body = serde_json::json!([
        {"id": "m1", "sender": "user", "text": "hi", "timestamp": 100},
        {"id": "m2", "sender": "assistant", "text": "hello", "timestamp": 200},
    ])
    .to_string();
    let mut bodies = HashMap::new();
    bodies.insert("s1".to_string(), body);
    let mut agents_map = HashMap::new();
    agents_map.insert("s1".to_string(), agent_json(&["a1", "a2"], &["am1", "am2"]));

    db.import_from_localstorage(&index, bodies.clone(), agents_map, None, &[])
        .unwrap();
    assert_eq!(db.load_session_agents("s1").unwrap().len(), 2);
    assert_eq!(db.load_session_body("s1").unwrap().len(), 2);

    // 二次导入：body 缩短为 1 条；agents 仅 a1 且消息缩为 1 条
    let body2 = serde_json::json!([
        {"id": "m1x", "sender": "user", "text": "hi2", "timestamp": 100},
    ])
    .to_string();
    let mut bodies2 = HashMap::new();
    bodies2.insert("s1".to_string(), body2);
    let mut agents_map2 = HashMap::new();
    agents_map2.insert("s1".to_string(), agent_json(&["a1"], &["am1x"]));

    db.import_from_localstorage(&index, bodies2, agents_map2, None, &[])
        .unwrap();

    // 消息：载荷覆盖 + 尾部收缩
    let body_loaded = db.load_session_body("s1").unwrap();
    assert_eq!(body_loaded.len(), 1);
    assert_eq!(body_loaded[0].id, "m1x");

    // agents：a2 被移除差集删除；a1 消息以载荷覆盖并收缩
    let agents_loaded = db.load_session_agents("s1").unwrap();
    assert_eq!(agents_loaded.len(), 1, "载荷未包含的 agent 被移除差集删除");
    assert_eq!(agents_loaded[0].id, "a1");
    assert_eq!(agents_loaded[0].messages.len(), 1);
    assert_eq!(agents_loaded[0].messages[0].id, "am1x");
}
