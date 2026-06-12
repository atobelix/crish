use serde_json::Value;
use tauri::Emitter;

use super::types::*;
use crate::process;

// ==================== Run Stream Registration ====================

pub(crate) fn register_run_stream_recovery(run_id: &str, session_id: Option<&str>) {
    let now = process::now_millis();
    if let Ok(mut streams) = sidecar_run_streams().lock() {
        streams.insert(
            run_id.to_string(),
            RunStreamRecoveryState {
                run_id: run_id.to_string(),
                session_id: session_id.map(str::to_string),
                last_cursor: None,
                started_at_ms: now,
                last_observed_at_ms: now,
                disconnected_generation: None,
                disconnected_at_ms: None,
                disconnect_message: None,
            },
        );
    }
}

pub(crate) fn unregister_run_stream_recovery(run_id: &str) {
    if let Ok(mut streams) = sidecar_run_streams().lock() {
        streams.remove(run_id);
    }
}

pub(crate) fn mark_run_streams_disconnected(generation: u64, message: &str) {
    let now = process::now_millis();
    if let Ok(mut streams) = sidecar_run_streams().lock() {
        for stream in streams.values_mut() {
            stream.disconnected_generation = Some(generation);
            stream.disconnected_at_ms = Some(now);
            stream.disconnect_message = Some(message.to_string());
        }
    }
}

pub(crate) fn pending_disconnected_run_streams() -> Vec<RunStreamRecoveryState> {
    sidecar_run_streams()
        .lock()
        .map(|streams| {
            streams
                .values()
                .filter(|stream| stream.disconnected_generation.is_some())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn update_run_stream_cursor(run_id: &str, cursor: RunEventReplayCursor) {
    if let Ok(mut streams) = sidecar_run_streams().lock() {
        if let Some(stream) = streams.get_mut(run_id) {
            stream.last_cursor = Some(cursor);
            stream.last_observed_at_ms = process::now_millis();
            stream.disconnected_generation = None;
            stream.disconnected_at_ms = None;
            stream.disconnect_message = None;
        }
    }
}

pub(crate) fn observe_run_stream_event(event: &Value) {
    let Some(run_id) = event_run_id(event) else {
        return;
    };
    let terminal = is_terminal_run_event(event);
    if let Ok(mut streams) = sidecar_run_streams().lock() {
        if terminal {
            streams.remove(run_id);
        } else if let Some(stream) = streams.get_mut(run_id) {
            stream.last_observed_at_ms = process::now_millis();
        }
    }
}

// ==================== Event Helpers ====================

pub(crate) fn event_run_id(event: &Value) -> Option<&str> {
    event
        .get("runId")
        .and_then(Value::as_str)
        .or_else(|| event.get("payload")?.get("runId")?.as_str())
        .or_else(|| event.get("event")?.get("runId")?.as_str())
}

pub(crate) fn is_terminal_run_event(event: &Value) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("run-completed" | "run-failed" | "run-cancelled")
    ) || matches!(
        event
            .get("event")
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .or_else(|| {
                event
                    .get("payload")
                    .and_then(|value| value.get("event"))
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
            }),
        Some("agent-end" | "runtime-error")
    )
}

// ==================== Diagnostics Emission ====================

pub(crate) fn emit_run_stream_diagnostics(
    app: &tauri::AppHandle,
    code: &'static str,
    severity: &'static str,
    generation: u64,
    message: &str,
    replayed_events: Option<usize>,
) {
    for stream in pending_disconnected_run_streams() {
        emit_run_stream_diagnostic(
            app,
            &stream,
            code,
            severity,
            generation,
            message,
            replayed_events,
        );
    }
}

pub(crate) fn emit_run_stream_diagnostic(
    app: &tauri::AppHandle,
    stream: &RunStreamRecoveryState,
    code: &'static str,
    severity: &'static str,
    generation: u64,
    message: &str,
    replayed_events: Option<usize>,
) {
    let diagnostic = RunStreamRecoveryDiagnostic {
        code,
        severity,
        run_id: stream.run_id.clone(),
        session_id: stream.session_id.clone(),
        message: message.to_string(),
        cursor: stream.last_cursor.clone(),
        replayed_events,
        generation: Some(generation),
        disconnected_at: stream
            .disconnected_at_ms
            .unwrap_or(stream.started_at_ms)
            .to_string(),
    };
    let event = serde_json::json!({
        "type": "daemon-diagnostic",
        "runId": stream.run_id,
        "sessionId": stream.session_id,
        "diagnostic": diagnostic,
    });
    let _ = app.emit("workbench-run-event", &event);
}

// ==================== Replay Logic ====================

pub(crate) fn spawn_run_stream_replay(app: tauri::AppHandle, generation: u64) {
    if pending_disconnected_run_streams().is_empty() {
        return;
    }

    tokio::spawn(async move {
        replay_disconnected_run_streams(app, generation).await;
    });
}

async fn replay_disconnected_run_streams(app: tauri::AppHandle, generation: u64) {
    let streams = pending_disconnected_run_streams();
    for stream in streams {
        let disconnect_message = stream
            .disconnect_message
            .as_deref()
            .unwrap_or("Daemon WebSocket disconnected");
        emit_run_stream_diagnostic(
            &app,
            &stream,
            "daemon-disconnected",
            "warning",
            generation,
            disconnect_message,
            None,
        );
        replay_single_run_stream(app.clone(), generation, stream).await;
    }
}

async fn replay_single_run_stream(
    app: tauri::AppHandle,
    generation: u64,
    stream: RunStreamRecoveryState,
) {
    let mut cursor = stream.last_cursor.clone();
    let mut total_replayed = 0usize;
    let mut idle_polls = 0usize;

    loop {
        let mut page_replayed = 0usize;
        loop {
            let cursor_value = cursor
                .as_ref()
                .and_then(|cursor| serde_json::to_value(cursor).ok());
            let after_sequence = cursor.as_ref().map(|cursor| cursor.after_sequence);
            let cmd = super::commands::build_read_run_events_command(
                stream.run_id.clone(),
                after_sequence,
                None,
                Some(false),
                Some(RUN_STREAM_REPLAY_PAGE_SIZE),
                cursor_value,
            );
            let response = match super::connection::send_sidecar_query(
                &app,
                cmd,
                "run-events",
                Some("runId"),
                Some(stream.run_id.clone()),
            )
            .await
            {
                Ok(response) => response,
                Err(error) => {
                    emit_run_stream_diagnostic(
                        &app,
                        &stream,
                        "replay-failed",
                        "error",
                        generation,
                        &error,
                        Some(total_replayed),
                    );
                    return;
                }
            };

            let events = response
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for event in &events {
                observe_run_stream_event(event);
                let _ = app.emit("workbench-run-event", event);
            }
            page_replayed = page_replayed.saturating_add(events.len());
            total_replayed = total_replayed.saturating_add(events.len());

            if let Some(next_cursor) = replay_cursor_from_run_events_response(&response) {
                update_run_stream_cursor(&stream.run_id, next_cursor.clone());
                cursor = Some(next_cursor);
            }

            if events.iter().any(is_terminal_run_event) {
                unregister_run_stream_recovery(&stream.run_id);
                emit_run_stream_diagnostic(
                    &app,
                    &stream,
                    "replay-complete",
                    "info",
                    generation,
                    "Run stream replay reached a terminal event.",
                    Some(total_replayed),
                );
                return;
            }

            if response
                .get("hasMore")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && !events.is_empty()
            {
                continue;
            }

            break;
        }

        if page_replayed > 0 {
            idle_polls = 0;
            emit_run_stream_diagnostic(
                &app,
                &stream,
                "replay-complete",
                "info",
                generation,
                "Run stream replay delivered daemon-owned events after reconnect.",
                Some(total_replayed),
            );
        } else {
            idle_polls = idle_polls.saturating_add(1);
        }

        if idle_polls >= RUN_STREAM_REPLAY_IDLE_LIMIT {
            emit_run_stream_diagnostic(
                &app,
                &stream,
                "replay-failed",
                "warning",
                generation,
                "Run stream replay stopped after the recovered run stayed idle without a terminal event.",
                Some(total_replayed),
            );
            return;
        }

        tokio::time::sleep(tokio::time::Duration::from_secs(
            RUN_STREAM_REPLAY_POLL_INTERVAL_SECS,
        ))
        .await;
    }
}

pub(crate) fn replay_cursor_from_run_events_response(response: &Value) -> Option<RunEventReplayCursor> {
    if let Some(cursor) = response.get("nextCursor") {
        if let Ok(cursor) = serde_json::from_value::<RunEventReplayCursor>(cursor.clone()) {
            return Some(cursor);
        }
    }

    let event_log = response.get("eventLog")?;
    Some(RunEventReplayCursor {
        event_log_id: event_log.get("eventLogId")?.as_str()?.to_string(),
        generation: event_log.get("generation")?.as_u64()?,
        schema_version: event_log.get("schemaVersion")?.as_u64()?,
        protocol_version: event_log.get("protocolVersion")?.as_u64()?,
        after_sequence: response.get("nextAfterSequence")?.as_u64()?,
        last_event_id: response
            .get("events")
            .and_then(Value::as_array)
            .and_then(|events| events.last())
            .and_then(|event| event.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}
