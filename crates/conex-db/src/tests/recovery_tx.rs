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

#[test]
fn acknowledgment_event_and_notification_meta_commit_together() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "recovery acknowledgment").unwrap();
    db.set_session_meta("recover_notifications", r#"[{"pending":true}]"#)
        .unwrap();

    let sequence = db
        .append_event_and_set_session_meta(
            "s1",
            (
                "recovery-acknowledged",
                r#"{"type":"recovery-acknowledged","subagentRunId":"run-1"}"#,
            ),
            ("recover_notifications", r#"[{"pending":false}]"#),
        )
        .unwrap();

    assert_eq!(sequence, 1);
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, "recovery-acknowledged");
    assert_eq!(events[0].run_id, None);
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":false}]"#)
    );
}

#[test]
fn acknowledgment_event_failure_rolls_back_meta_and_sequence_for_retry() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "recovery acknowledgment rollback")
        .unwrap();
    db.set_session_meta("recover_notifications", r#"[{"pending":true}]"#)
        .unwrap();
    db.write_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_recovery_acknowledged
             BEFORE INSERT ON events
             WHEN NEW.event_type = 'recovery-acknowledged'
             BEGIN SELECT RAISE(ABORT, 'injected acknowledgment event failure'); END;",
        )
        .map_err(|e| DbFailure {
            message: e.to_string(),
            kind: DbFailureKind::Other("test_trigger".to_string()),
        })?;
        Ok(())
    })
    .unwrap();

    let failed = db.append_event_and_set_session_meta(
        "s1",
        (
            "recovery-acknowledged",
            r#"{"type":"recovery-acknowledged","subagentRunId":"run-1"}"#,
        ),
        ("recover_notifications", r#"[{"pending":false}]"#),
    );
    assert!(failed.is_err());
    assert!(db.query_events("s1", 0, None).unwrap().is_empty());
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":true}]"#)
    );

    db.write_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER reject_recovery_acknowledged;")
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("test_trigger".to_string()),
            })?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        db.append_event_and_set_session_meta(
            "s1",
            (
                "recovery-acknowledged",
                r#"{"type":"recovery-acknowledged","subagentRunId":"run-1"}"#,
            ),
            ("recover_notifications", r#"[{"pending":false}]"#),
        )
        .unwrap(),
        1,
        "failed insert must not consume sequence"
    );
    assert_eq!(db.query_events("s1", 0, None).unwrap().len(), 1);
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":false}]"#)
    );
}

#[test]
fn acknowledgment_meta_failure_rolls_back_event_and_sequence_for_retry() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "recovery acknowledgment metadata rollback")
        .unwrap();
    db.set_session_meta("recover_notifications", r#"[{"pending":true}]"#)
        .unwrap();
    db.write_blocking(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_recovery_ack_meta
             BEFORE UPDATE ON session_meta
             WHEN OLD.key = 'recover_notifications'
             BEGIN SELECT RAISE(ABORT, 'injected acknowledgment metadata failure'); END;",
        )
        .map_err(|e| DbFailure {
            message: e.to_string(),
            kind: DbFailureKind::Other("test_trigger".to_string()),
        })?;
        Ok(())
    })
    .unwrap();

    let failed = db.append_event_and_set_session_meta(
        "s1",
        (
            "recovery-acknowledged",
            r#"{"type":"recovery-acknowledged","subagentRunId":"run-1"}"#,
        ),
        ("recover_notifications", r#"[{"pending":false}]"#),
    );
    assert!(failed.is_err());
    assert!(db.query_events("s1", 0, None).unwrap().is_empty());
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":true}]"#)
    );

    db.write_blocking(|conn| {
        conn.execute_batch("DROP TRIGGER reject_recovery_ack_meta;")
            .map_err(|e| DbFailure {
                message: e.to_string(),
                kind: DbFailureKind::Other("test_trigger".to_string()),
            })?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        db.append_event_and_set_session_meta(
            "s1",
            (
                "recovery-acknowledged",
                r#"{"type":"recovery-acknowledged","subagentRunId":"run-1"}"#,
            ),
            ("recover_notifications", r#"[{"pending":false}]"#),
        )
        .unwrap(),
        1,
        "failed metadata write must roll back event and sequence"
    );
    assert_eq!(db.query_events("s1", 0, None).unwrap().len(), 1);
    assert_eq!(
        db.get_session_meta("recover_notifications")
            .unwrap()
            .as_deref(),
        Some(r#"[{"pending":false}]"#)
    );
}

#[test]
fn recovery_fork_completion_is_atomic_and_retry_deduplicates_event() {
    let payload = r#"{"type":"recovery-fork","newRunId":"child-1","newLeafId":"fork-1","fromRunId":"source-1","fromLeafId":"root"}"#;
    let tree_entry = r#"{"id":"fork-1","parentId":"root","createdAt":42,"kind":{"type":"node","payload":{"kind":"recovery-fork","fromRunId":"source-1","fromLeafId":"root","task":"task","contextMode":"verbatim"}}}"#;
    let seed = || {
        let (db, guard) = open_temp_wal_db();
        db.insert_session("s1", "recovery fork completion").unwrap();
        db.insert_run("source-1", "s1", RunStatus::Running, None, 0)
            .unwrap();
        db.insert_run("child-1", "s1", RunStatus::Running, None, 0)
            .unwrap();
        db.upsert_session_agent(&conex_types::SessionAgent {
            id: "child-agent".to_string(),
            subagent_run_id: "child-1".to_string(),
            parent_session_id: "s1".to_string(),
            parent_run_id: "source-1".to_string(),
            parent_tool_call_id: None,
            description: "recovery fork".to_string(),
            mode: "default".to_string(),
            status: "running".to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: 1,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
            capability_mode: None,
            model_override: None,
            resumable: false,
            last_heartbeat_ms: None,
        })
        .unwrap();
        (db, guard)
    };
    let persist = |db: &LocalDb| {
        db.persist_recovery_fork_completion(crate::RecoveryForkCompletion {
            session_id: "s1",
            new_run_id: "child-1",
            path_json: r#"["root","fork-1"]"#,
            original_run_id: "source-1",
            forks_json: r#"[{"newRunId":"child-1"}]"#,
            episodes_json: r#"{"fingerprint":1}"#,
            event_payload: payload,
            tree_entry_json: tree_entry,
        })
    };

    for (trigger, sql) in [
        (
            "reject_fork_path",
            "CREATE TRIGGER reject_fork_path BEFORE UPDATE ON session_agents
             WHEN NEW.subagent_run_id = 'child-1'
             BEGIN SELECT RAISE(ABORT, 'injected fork path failure'); END;",
        ),
        (
            "reject_fork_source_status",
            "CREATE TRIGGER reject_fork_source_status BEFORE UPDATE ON runs
             WHEN OLD.run_id = 'source-1'
             BEGIN SELECT RAISE(ABORT, 'injected fork source status failure'); END;",
        ),
        (
            "reject_fork_records_meta",
            "CREATE TRIGGER reject_fork_records_meta BEFORE INSERT ON session_meta
             WHEN NEW.key = 'recover_forks'
             BEGIN SELECT RAISE(ABORT, 'injected fork records meta failure'); END;",
        ),
        (
            "reject_fork_budget_meta",
            "CREATE TRIGGER reject_fork_budget_meta BEFORE INSERT ON session_meta
             WHEN NEW.key = 'recover_episodes'
             BEGIN SELECT RAISE(ABORT, 'injected fork budget meta failure'); END;",
        ),
        (
            "reject_fork_event",
            "CREATE TRIGGER reject_fork_event BEFORE INSERT ON events
             WHEN NEW.event_type = 'recovery-fork'
             BEGIN SELECT RAISE(ABORT, 'injected fork event failure'); END;",
        ),
        (
            "reject_fork_tree_entry",
            "CREATE TRIGGER reject_fork_tree_entry BEFORE INSERT ON session_meta
             WHEN NEW.key = 's1:recover_fork_nodes'
             BEGIN SELECT RAISE(ABORT, 'injected fork tree entry failure'); END;",
        ),
    ] {
        let (db, _guard) = seed();
        db.write_blocking(move |conn| {
            conn.execute_batch(sql).map_err(|e| DbFailure {
                message: format!("create {trigger}: {e}"),
                kind: DbFailureKind::Other("test_trigger".to_string()),
            })?;
            Ok(())
        })
        .unwrap();

        assert!(persist(&db).is_err(), "{trigger} must fail the transaction");
        assert_eq!(
            db.get_run("source-1").unwrap().unwrap().status,
            RunStatus::Running
        );
        assert_eq!(
            db.load_session_agents("s1").unwrap()[0].subagent_path_json,
            None
        );
        assert_eq!(db.get_session_meta("recover_forks").unwrap(), None);
        assert_eq!(db.get_session_meta("recover_episodes").unwrap(), None);
        assert!(db.query_events("s1", 0, None).unwrap().is_empty());
    }

    let (db, _guard) = seed();
    assert_eq!(persist(&db).unwrap(), 1);
    assert_eq!(persist(&db).unwrap(), 1);

    let source = db.get_run("source-1").unwrap().unwrap();
    assert_eq!(source.status, RunStatus::Failed);
    assert_eq!(source.end_reason.as_deref(), Some("recovery-fork"));
    assert_eq!(
        db.load_session_agents("s1").unwrap()[0]
            .subagent_path_json
            .as_deref(),
        Some(r#"["root","fork-1"]"#)
    );
    assert_eq!(
        db.get_session_meta("recover_forks").unwrap().as_deref(),
        Some(r#"[{"newRunId":"child-1"}]"#)
    );
    assert_eq!(
        db.get_session_meta("recover_episodes").unwrap().as_deref(),
        Some(r#"{"fingerprint":1}"#)
    );
    let events = db.query_events("s1", 0, None).unwrap();
    assert_eq!(
        events.len(),
        1,
        "retry must not duplicate recovery-fork event"
    );
    assert_eq!(
        events[0].sequence, 1,
        "retry must not consume another sequence"
    );
    assert_eq!(events[0].event_type, "recovery-fork");
    assert_eq!(events[0].payload, payload);
    assert_eq!(events[0].run_id, None);
    let sidecar: serde_json::Value = serde_json::from_str(
        &db.get_session_meta("s1:recover_fork_nodes")
            .unwrap()
            .expect("fork tree sidecar must be persisted"),
    )
    .unwrap();
    assert_eq!(sidecar[0]["eventSequence"], 1);
    assert_eq!(
        sidecar[0]["entry"],
        serde_json::from_str::<serde_json::Value>(tree_entry).unwrap(),
        "sidecar stores the exact tree entry"
    );
}
