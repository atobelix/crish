//! 恢复批次事务：两事件 + session_meta 同事务提交 / 回滚。

use super::*;

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
