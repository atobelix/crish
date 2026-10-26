//! Ladder-4 recovery report idempotency tests.

use super::*;

#[test]
fn recovery_report_once_deduplicates_by_session_and_run_not_payload_timestamp() {
    let (db, _guard) = open_temp_wal_db();
    db.insert_session("s1", "recovery reports").unwrap();
    db.insert_session("s2", "independent recovery reports")
        .unwrap();

    let payload = |run_id: &str, stuck_at_ms: i64| {
        serde_json::json!({
            "type": "recovery-report",
            "sessionId": "s1",
            "subagentId": "sub-a",
            "subagentRunId": run_id,
            "stuckAtMs": stuck_at_ms,
            "suggestion": "check provider"
        })
        .to_string()
    };

    assert!(db
        .append_recovery_report_once("s1", "run-1", &payload("run-1", 100))
        .unwrap());
    assert!(!db
        .append_recovery_report_once("s1", "run-1", &payload("run-1", 200))
        .unwrap());
    assert!(db
        .append_recovery_report_once("s1", "run-2", &payload("run-2", 300))
        .unwrap());
    assert!(db
        .append_recovery_report_once("s2", "run-1", &payload("run-1", 400))
        .unwrap());

    let s1_reports: Vec<_> = db
        .query_events("s1", 0, None)
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "recovery-report")
        .collect();
    let s2_reports: Vec<_> = db
        .query_events("s2", 0, None)
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "recovery-report")
        .collect();
    assert_eq!(s1_reports.len(), 2);
    assert_eq!(s2_reports.len(), 1);
    assert_eq!(s1_reports[0].sequence, 1);
    assert_eq!(s1_reports[1].sequence, 2, "重复报告不应消耗 sequence");
}
