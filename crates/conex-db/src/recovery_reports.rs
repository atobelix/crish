//! Idempotent persistence for ladder-4 recovery reports.

use crate::events::{append_event_conn, reserve_sequence_conn};
use crate::{DbFailure, DbFailureKind, LocalDb};

impl LocalDb {
    /// Append one recovery report per session/run pair.
    ///
    /// The dedupe key is stable across report payload timestamps: `(session_id,
    /// subagent_run_id)`. Lookup and insert run inside the same writer transaction,
    /// so a replay cannot append a second report for the same unresolved run.
    pub fn append_recovery_report_once(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        payload: &str,
    ) -> Result<bool, DbFailure> {
        let session_id = session_id.to_string();
        let subagent_run_id = subagent_run_id.to_string();
        let payload = payload.to_string();
        self.write_blocking(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT payload FROM events
                     WHERE session_id = ?1 AND event_type = 'recovery-report'",
                )
                .map_err(|e| DbFailure {
                    message: format!("append_recovery_report_once: prepare lookup: {e}"),
                    kind: DbFailureKind::Other("append_recovery_report_once".to_string()),
                })?;
            let mut rows = statement
                .query(rusqlite::params![session_id])
                .map_err(|e| DbFailure {
                    message: format!("append_recovery_report_once: query lookup: {e}"),
                    kind: DbFailureKind::Other("append_recovery_report_once".to_string()),
                })?;
            while let Some(row) = rows.next().map_err(|e| DbFailure {
                message: format!("append_recovery_report_once: read lookup: {e}"),
                kind: DbFailureKind::Other("append_recovery_report_once".to_string()),
            })? {
                let existing_payload: String = row.get(0).map_err(|e| DbFailure {
                    message: format!("append_recovery_report_once: decode payload: {e}"),
                    kind: DbFailureKind::Other("append_recovery_report_once".to_string()),
                })?;
                let existing_run_id = serde_json::from_str::<serde_json::Value>(&existing_payload)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("subagentRunId")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    });
                if existing_run_id.as_deref() == Some(subagent_run_id.as_str()) {
                    return Ok(false);
                }
            }
            drop(rows);
            drop(statement);

            let sequence = reserve_sequence_conn(conn, &session_id)?;
            append_event_conn(
                conn,
                &session_id,
                sequence,
                "recovery-report",
                &payload,
                None,
            )?;
            Ok(true)
        })
    }
}
