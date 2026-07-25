use serde_json::Value;

use super::super::connection::*;
use super::super::run_stream::*;
use super::*;

#[tauri::command]
pub(crate) async fn workbench_list_sessions(app: tauri::AppHandle) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "list-sessions" }),
        "sessions-listed",
        None,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_list_runs(
    app: tauri::AppHandle,
    session_id: Option<String>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "list-runs" });
    let key_value = session_id.filter(|value| !value.trim().is_empty());
    if let Some(value) = key_value.as_ref() {
        cmd["sessionId"] = serde_json::Value::String(value.clone());
    }
    send_sidecar_query(
        &app,
        cmd,
        "runs-listed",
        key_value.as_ref().map(|_| "sessionId"),
        key_value,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_read_session_events(
    app: tauri::AppHandle,
    session_id: String,
    after_sequence: Option<u64>,
    last_event_id: Option<String>,
    max_events: Option<u64>,
    cursor: Option<Value>,
    include_snapshot: Option<bool>,
) -> Result<Value, String> {
    let cmd = build_read_session_events_command(
        session_id,
        after_sequence,
        last_event_id,
        max_events,
        cursor,
        include_snapshot,
    );
    let key_value = cmd
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    send_sidecar_query(&app, cmd, "session-events", Some("sessionId"), key_value).await
}

#[tauri::command]
pub(crate) async fn workbench_read_run_events(
    app: tauri::AppHandle,
    run_id: String,
    after_sequence: Option<u64>,
    last_event_id: Option<String>,
    include_snapshot: Option<bool>,
    max_events: Option<u64>,
    cursor: Option<Value>,
) -> Result<Value, String> {
    let cmd = build_read_run_events_command(
        run_id,
        after_sequence,
        last_event_id,
        include_snapshot,
        max_events,
        cursor,
    );
    let key_value = cmd.get("runId").and_then(Value::as_str).map(str::to_string);
    let response = send_sidecar_query(&app, cmd, "run-events", Some("runId"), key_value).await?;
    if let Some(cursor) = replay_cursor_from_run_events_response(&response) {
        update_run_stream_cursor(
            response
                .get("runId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            cursor,
        );
    }
    if let Some(events) = response.get("events").and_then(Value::as_array) {
        for event in events {
            observe_run_stream_event(event);
        }
    }
    Ok(response)
}

#[tauri::command]
pub(crate) async fn workbench_get_run_snapshot(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Value, String> {
    let cmd = serde_json::json!({
        "type": "get-run-snapshot",
        "runId": run_id,
    });
    let key_value = cmd.get("runId").and_then(Value::as_str).map(str::to_string);
    send_sidecar_query(&app, cmd, "run-snapshot", Some("runId"), key_value).await
}

#[tauri::command]
pub(crate) async fn workbench_get_metrics(
    app: tauri::AppHandle,
    run_id: Option<String>,
    session_id: Option<String>,
    include_runs: Option<bool>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "get-metrics" });
    let key_value = run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .or_else(|| {
            session_id
                .as_ref()
                .filter(|value| !value.trim().is_empty())
                .cloned()
        });
    if let Some(value) = run_id.filter(|value| !value.trim().is_empty()) {
        cmd["runId"] = Value::String(value);
    }
    if let Some(value) = session_id.filter(|value| !value.trim().is_empty()) {
        cmd["sessionId"] = Value::String(value);
    }
    if let Some(value) = include_runs {
        cmd["includeRuns"] = Value::Bool(value);
    }
    let key_field = key_value
        .as_ref()
        .map(|_| if cmd.get("runId").is_some() { "runId" } else { "sessionId" });
    send_sidecar_query(&app, cmd, "metrics-response", key_field, key_value)
    .await
}

#[tauri::command]
pub(crate) async fn workbench_enqueue_pending_input(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = daemon_command_with_type(request, "enqueue-pending-input")?;
    let key_value = cmd
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    send_sidecar_query(
        &app,
        cmd,
        "pending-input-queued",
        Some("sessionId"),
        key_value,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_cancel_pending_input(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = daemon_command_with_type(request, "cancel-pending-input")?;
    let key_value = cmd
        .get("inputId")
        .and_then(Value::as_str)
        .map(str::to_string);
    send_sidecar_query(
        &app,
        cmd,
        "pending-input-cancelled",
        Some("inputId"),
        key_value,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_dispatch_pending_input(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = daemon_command_with_type(request, "dispatch-pending-input")?;
    let key_value = cmd
        .get("inputId")
        .and_then(Value::as_str)
        .map(str::to_string);
    send_sidecar_query(
        &app,
        cmd,
        "pending-input-dispatched",
        Some("inputId"),
        key_value,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_list_pending_inputs(
    app: tauri::AppHandle,
    session_id: Option<String>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "list-pending-inputs" });
    let key_value = session_id.filter(|value| !value.trim().is_empty());
    if let Some(value) = key_value.as_ref() {
        cmd["sessionId"] = Value::String(value.clone());
    }
    send_sidecar_query(
        &app,
        cmd,
        "pending-inputs-listed",
        key_value.as_ref().map(|_| "sessionId"),
        key_value,
    )
    .await
}
