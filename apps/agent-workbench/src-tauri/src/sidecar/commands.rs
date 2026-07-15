use serde_json::Value;

use super::connection::*;
use super::run_stream::*;
use super::supervisor::*;
use super::types::*;
use crate::{commands::WorkbenchRunTaskRequest, process};
use tokio_tungstenite::tungstenite::Message;

// ==================== Connection Status Commands ====================

#[tauri::command]
pub(crate) async fn workbench_daemon_endpoint() -> Result<Value, String> {
    let endpoint = active_sidecar_daemon_endpoint();
    match endpoint {
        Some(endpoint) => Ok(serde_json::json!({
            "available": true,
            "url": format!("ws://127.0.0.1:{}/", endpoint.port),
            "port": endpoint.port,
            "pid": endpoint.pid,
            "buildHash": endpoint.build_hash,
        })),
        None => Ok(serde_json::json!({
            "available": false,
            "url": null,
            "port": null,
            "pid": null,
            "buildHash": null,
        })),
    }
}

#[tauri::command]
pub(crate) async fn workbench_connection_status() -> Result<Value, String> {
    let snapshot = sidecar_supervisor_snapshot();
    let connected = matches!(snapshot.state, SidecarSupervisorState::Ready);
    Ok(serde_json::json!({
        "connected": connected,
        "state": snapshot.state,
        "generation": snapshot.generation,
        "pid": snapshot.pid,
        "disconnectCount": snapshot.disconnect_count,
        "reconnectRetryCount": snapshot.reconnect_retry_count,
        "lastReconnectError": snapshot.last_reconnect_error,
        "lastReconnectAttempt": snapshot.last_reconnect_attempt,
        "lastTransitionAt": snapshot.last_transition_at,
        "daemonBuildHash": snapshot.daemon_build_hash,
        "checkedAt": process::now_millis(),
    }))
}

#[tauri::command]
pub(crate) async fn workbench_status(app: tauri::AppHandle) -> Result<Value, String> {
    let mut status = match send_sidecar_query(
        &app,
        serde_json::json!({ "type": "get-status" }),
        "status-response",
        None,
        None,
    )
    .await
    {
        Ok(status) => status,
        Err(error) => {
            update_sidecar_supervisor(
                SidecarSupervisorState::Degraded,
                None,
                None,
                Some(error.clone()),
            );
            return Ok(serde_json::json!({
                "daemonConnected": false,
                "desktopPid": std::process::id(),
                "statusCheckedAt": process::now_millis(),
                "lifecycle": {
                    "state": "degraded",
                    "recentError": error,
                },
                "sidecarSupervisor": sidecar_supervisor_snapshot(),
            }));
        }
    };

    if let Value::Object(ref mut object) = status {
        object.insert("daemonConnected".to_string(), Value::Bool(true));
        object.insert(
            "desktopPid".to_string(),
            serde_json::json!(std::process::id()),
        );
        object.insert(
            "statusCheckedAt".to_string(),
            serde_json::json!(process::now_millis()),
        );
        object.insert(
            "sidecarSupervisor".to_string(),
            serde_json::json!(sidecar_supervisor_snapshot()),
        );
    }

    Ok(status)
}

#[tauri::command]
pub(crate) async fn workbench_provider_diagnostics(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let status = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "get-status" }),
        "status-response",
        None,
        None,
    )
    .await?;

    status
        .get("providerStatus")
        .cloned()
        .ok_or_else(|| "Invalid status response: missing providerStatus".to_string())
}

#[tauri::command]
pub(crate) async fn workbench_stop_daemon() -> Result<Value, String> {
    cleanup_sidecar();
    Ok(serde_json::json!({
        "ok": true,
        "daemonConnected": false,
        "status": "stopped",
        "sidecarSupervisor": sidecar_supervisor_snapshot(),
    }))
}

#[tauri::command]
pub(crate) async fn workbench_restart_daemon(app: tauri::AppHandle) -> Result<Value, String> {
    cleanup_sidecar();
    let app_dir = crate::host_paths::app_dir()?;
    let sender = ensure_sidecar_connected(&app, &app_dir).await?;

    Ok(serde_json::json!({
        "ok": true,
        "daemonConnected": true,
        "status": "ready",
        "generation": sender.generation,
        "sidecarSupervisor": sidecar_supervisor_snapshot(),
    }))
}

// ==================== Session Commands ====================

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
pub(crate) async fn workbench_apply_session_action(
    app: tauri::AppHandle,
    action: Value,
) -> Result<Value, String> {
    let session_id = action
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let cmd = serde_json::json!({
        "type": "apply-session-action",
        "action": action,
    });
    send_sidecar_query(
        &app,
        cmd,
        "session-action-receipt",
        Some("sessionId"),
        session_id,
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

pub(crate) fn build_read_session_events_command(
    session_id: String,
    after_sequence: Option<u64>,
    last_event_id: Option<String>,
    max_events: Option<u64>,
    cursor: Option<Value>,
    include_snapshot: Option<bool>,
) -> Value {
    let mut cmd = serde_json::json!({
        "type": "read-session-events",
        "sessionId": session_id,
    });
    if let Some(sequence) = after_sequence {
        cmd["afterSequence"] = serde_json::Value::Number(sequence.into());
    }
    if let Some(event_id) = last_event_id.filter(|value| !value.trim().is_empty()) {
        cmd["lastEventId"] = serde_json::Value::String(event_id);
    }
    if let Some(value) = max_events {
        cmd["maxEvents"] = serde_json::Value::Number(value.into());
    }
    if let Some(value) = cursor {
        cmd["cursor"] = value;
    }
    if let Some(value) = include_snapshot {
        cmd["includeSnapshot"] = serde_json::Value::Bool(value);
    }
    cmd
}

pub(crate) fn build_read_run_events_command(
    run_id: String,
    after_sequence: Option<u64>,
    last_event_id: Option<String>,
    include_snapshot: Option<bool>,
    max_events: Option<u64>,
    cursor: Option<Value>,
) -> Value {
    let mut cmd = serde_json::json!({
        "type": "read-run-events",
        "runId": run_id,
    });
    if let Some(sequence) = after_sequence {
        cmd["afterSequence"] = serde_json::Value::Number(sequence.into());
    }
    if let Some(event_id) = last_event_id.filter(|value| !value.trim().is_empty()) {
        cmd["lastEventId"] = serde_json::Value::String(event_id);
    }
    if let Some(value) = include_snapshot {
        cmd["includeSnapshot"] = serde_json::Value::Bool(value);
    }
    if let Some(value) = max_events {
        cmd["maxEvents"] = serde_json::Value::Number(value.into());
    }
    if let Some(value) = cursor {
        cmd["cursor"] = value;
    }
    cmd
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

// ==================== Pending Input Commands ====================

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

// ==================== Run Task Commands ====================

#[tauri::command]
pub(crate) async fn workbench_run_task_stream(
    app: tauri::AppHandle,
    request: WorkbenchRunTaskRequest,
) -> Result<Value, String> {
    send_workbench_run_task_stream(app, request, None, "run-task command").await
}

#[tauri::command]
pub(crate) async fn workbench_run_goal_stream(
    app: tauri::AppHandle,
    request: WorkbenchRunTaskRequest,
) -> Result<Value, String> {
    send_workbench_run_task_stream(app, request, Some("goal"), "goal run-task command").await
}

async fn send_workbench_run_task_stream(
    app: tauri::AppHandle,
    request: WorkbenchRunTaskRequest,
    forced_mode: Option<&str>,
    context: &str,
) -> Result<Value, String> {
    let (cmd_json, run_id, session_id) = build_workbench_run_task_command(request, forced_mode);

    // Send the command to the daemon through the sidecar WebSocket.
    send_sidecar_command(&app, cmd_json, context).await?;

    // PID 0 marks a daemon-owned run rather than a directly spawned CLI process.
    process::register_active_run(&run_id, 0);
    register_run_stream_recovery(&run_id, session_id.as_deref());

    // The WebSocket reader task emits workbench-run-event and approval events.

    let mut response = serde_json::json!({ "runId": run_id });
    if let Some(session_id) = session_id {
        response["sessionId"] = serde_json::Value::String(session_id);
    }
    Ok(response)
}

fn build_workbench_run_task_command(
    request: WorkbenchRunTaskRequest,
    forced_mode: Option<&str>,
) -> (Value, String, Option<String>) {
    let run_id = request
        .run_id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("run-{}", process::now_millis()));
    let session_id = request.session_id.filter(|v| !v.trim().is_empty());
    let mode = forced_mode
        .map(str::to_string)
        .or_else(|| request.mode.filter(|v| !v.trim().is_empty()));

    // Build the run-task command with cwd and permission mode.
    let mut cmd_json = serde_json::json!({
        "type": "run-task",
        "runId": run_id,
        "prompt": request.prompt,
    });
    if let Some(mode) = mode {
        cmd_json["mode"] = serde_json::Value::String(mode);
    }
    if let Some(workspace_mode) = request.workspace_mode.filter(|v| !v.trim().is_empty()) {
        cmd_json["workspaceMode"] = serde_json::Value::String(workspace_mode);
    }
    if let Some(visible_goal) = request.visible_goal.filter(|v| !v.trim().is_empty()) {
        cmd_json["visibleGoal"] = serde_json::Value::String(visible_goal);
    }
    if let Some(budget_difficulty) = request.budget_difficulty.filter(|v| !v.trim().is_empty()) {
        cmd_json["budgetDifficulty"] = serde_json::Value::String(budget_difficulty);
    }
    if let Some(run_token_budget) = request.run_token_budget {
        cmd_json["runTokenBudget"] = serde_json::Value::Number(run_token_budget.into());
    }
    if let Some(max_rounds) = request.max_rounds {
        cmd_json["maxRounds"] = serde_json::Value::Number(max_rounds.into());
    }
    if let Some(max_stalled_rounds) = request.max_stalled_rounds {
        cmd_json["maxStalledRounds"] = serde_json::Value::Number(max_stalled_rounds.into());
    }
    if let Some(background_drain_timeout_ms) = request.background_drain_timeout_ms {
        cmd_json["backgroundDrainTimeoutMs"] =
            serde_json::Value::Number(background_drain_timeout_ms.into());
    }
    if let Some(cwd) = request.cwd.filter(|v| !v.trim().is_empty()) {
        cmd_json["cwd"] = serde_json::Value::String(cwd);
    }
    if let Some(session_id) = session_id.as_ref() {
        cmd_json["sessionId"] = serde_json::Value::String(session_id.clone());
    }
    if let Some(permission_mode) = request.permission_mode.filter(|v| !v.trim().is_empty()) {
        cmd_json["permissionMode"] = serde_json::Value::String(permission_mode);
    }

    (cmd_json, run_id, session_id)
}

#[tauri::command]
pub(crate) async fn workbench_cancel_run(run_id: String) -> WorkbenchCancelRunResult {
    let pid = process::active_run_pid(&run_id);

    let mut cancel_sent = false;
    if let Some(sender) = current_sidecar_sender() {
        let cancel_cmd = serde_json::json!({
            "type": "cancel-run",
            "runId": run_id,
        });
        match sender
            .writer
            .send(Message::Text(cancel_cmd.to_string()))
            .await
        {
            Ok(()) => cancel_sent = true,
            Err(error) => {
                let message = format!("Failed to send cancel command: {error}");
                eprintln!("[Sidecar] {message}");
                disconnect_sidecar_generation(sender.generation, &message, false);
            }
        }
    }

    if !cancel_sent && pid.is_none() {
        eprintln!(
            "[Sidecar] Could not send cancel command: no sidecar connection and no PID for run {}",
            run_id
        );
    }

    process::unregister_active_run(&run_id);
    unregister_run_stream_recovery(&run_id);

    let Some(pid) = pid.filter(|&p| p > 0) else {
        return WorkbenchCancelRunResult {
            ok: true,
            run_id,
            pid: None,
            message: if cancel_sent {
                "Cancellation sent to Sidecar".to_string()
            } else {
                "No active sidecar process for run".to_string()
            },
        };
    };

    match process::terminate_process_tree(pid) {
        Ok(()) => WorkbenchCancelRunResult {
            ok: true,
            run_id,
            pid: Some(pid),
            message: "Cancellation requested".to_string(),
        },
        Err(error) => WorkbenchCancelRunResult {
            ok: false,
            run_id,
            pid: Some(pid),
            message: error,
        },
    }
}

// ==================== Approval Commands ====================

#[tauri::command]
pub(crate) async fn workbench_approve_tool(
    app: tauri::AppHandle,
    tool_call_id: String,
    scope: Option<String>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({
        "type": "approve-tool",
        "toolCallId": tool_call_id,
    });
    if let Some(s) = scope.filter(|v| !v.trim().is_empty()) {
        cmd["scope"] = serde_json::Value::String(s);
    }
    match send_sidecar_command(&app, cmd, "approve-tool command").await {
        Ok(()) => Ok(serde_json::json!({
            "ok": true,
            "toolCallId": tool_call_id,
            "decision": "approved"
        })),
        Err(message) => Ok(serde_json::json!({
            "ok": false,
            "toolCallId": tool_call_id,
            "message": message
        })),
    }
}

/// Deny a tool call through the daemon WebSocket.
#[tauri::command]
pub(crate) async fn workbench_deny_tool(
    app: tauri::AppHandle,
    tool_call_id: String,
) -> Result<Value, String> {
    let cmd = serde_json::json!({
        "type": "deny-tool",
        "toolCallId": tool_call_id,
    });
    match send_sidecar_command(&app, cmd, "deny-tool command").await {
        Ok(()) => Ok(serde_json::json!({
            "ok": true,
            "toolCallId": tool_call_id,
            "decision": "denied"
        })),
        Err(message) => Ok(serde_json::json!({
            "ok": false,
            "toolCallId": tool_call_id,
            "message": message
        })),
    }
}

// ==================== MCP Server Commands ====================

#[tauri::command]
pub(crate) async fn workbench_list_mcp_servers(app: tauri::AppHandle) -> Result<Value, String> {
    let status = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "get-status" }),
        "status-response",
        None,
        None,
    )
    .await?;

    let mcp_status = status.get("mcpStatus").cloned().unwrap_or(Value::Null);
    let servers = mcp_status
        .get("servers")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(Value::Array(servers))
}

#[tauri::command]
pub(crate) async fn workbench_start_mcp_server(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "start-mcp-server", "serverId": server_id }),
        "mcp-server-started",
        Some("serverId"),
        Some(server_id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_stop_mcp_server(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "stop-mcp-server", "serverId": server_id }),
        "mcp-server-stopped",
        Some("serverId"),
        Some(server_id),
    )
    .await
}

// ==================== Background Task Commands ====================

#[tauri::command]
pub(crate) async fn workbench_list_background_tasks(
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let result = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "list-background-tasks", "includeHistory": true }),
        "background-tasks-listed",
        None,
        None,
    )
    .await?;

    match result.get("tasks") {
        Some(Value::Array(tasks)) => Ok(Value::Array(tasks.clone())),
        Some(_) => Err("Invalid background tasks response: tasks must be an array".to_string()),
        None => Err("Invalid background tasks response: missing tasks".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn workbench_list_mutation_leases(app: tauri::AppHandle) -> Result<Value, String> {
    let result = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "list-mutation-leases" }),
        "mutation-leases-listed",
        None,
        None,
    )
    .await?;

    match result.get("leases") {
        Some(Value::Array(leases)) => Ok(Value::Array(leases.clone())),
        Some(_) => Err("Invalid mutation leases response: leases must be an array".to_string()),
        None => Err("Invalid mutation leases response: missing leases".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn workbench_git_status(
    app: tauri::AppHandle,
    cwd: Option<String>,
) -> Result<Value, String> {
    let cmd = build_git_status_command(cwd);
    let key_value = cmd.get("cwd").and_then(Value::as_str).map(str::to_string);
    let key_field = if key_value.is_some() { Some("cwd") } else { None };
    send_sidecar_query(&app, cmd, "git-status-response", key_field, key_value).await
}

#[tauri::command]
pub(crate) async fn workbench_git_diff(
    app: tauri::AppHandle,
    cwd: Option<String>,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<Value, String> {
    let cmd = build_git_diff_command(cwd, path, staged);
    let key_value = cmd
        .get("path")
        .and_then(Value::as_str)
        .or_else(|| cmd.get("cwd").and_then(Value::as_str))
        .map(str::to_string);
    let key_field = if cmd.get("path").and_then(Value::as_str).is_some() {
        Some("path")
    } else if cmd.get("cwd").and_then(Value::as_str).is_some() {
        Some("cwd")
    } else {
        None
    };
    send_sidecar_query(&app, cmd, "git-diff-response", key_field, key_value).await
}

fn build_git_status_command(cwd: Option<String>) -> Value {
    let mut cmd = serde_json::json!({ "type": "git-status" });
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        cmd["cwd"] = Value::String(cwd);
    }
    cmd
}

fn build_git_diff_command(cwd: Option<String>, path: Option<String>, staged: Option<bool>) -> Value {
    let mut cmd = serde_json::json!({ "type": "git-diff" });
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        cmd["cwd"] = Value::String(cwd);
    }
    if let Some(path) = path.filter(|value| !value.trim().is_empty()) {
        cmd["path"] = Value::String(path);
    }
    if let Some(staged) = staged {
        cmd["staged"] = Value::Bool(staged);
    }
    cmd
}

#[tauri::command]
pub(crate) async fn workbench_cancel_background_task(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<Value, String> {
    let result = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "cancel-background-task", "taskId": task_id }),
        "background-task-cancelled",
        None,
        None,
    )
    .await?;

    match result.get("task") {
        Some(task) => Ok(task.clone()),
        None => Err("Invalid background task cancellation response: missing task".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn workbench_get_background_task_output(
    app: tauri::AppHandle,
    task_id: String,
) -> Result<String, String> {
    let result = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "list-background-tasks", "includeHistory": true }),
        "background-tasks-listed",
        None,
        None,
    )
    .await?;

    let tasks = result
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| "Invalid background tasks response: missing tasks".to_string())?;
    let task = tasks
        .iter()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(task_id.as_str()))
        .ok_or_else(|| format!("Background task not found: {task_id}"))?;
    Ok(task
        .get("outputPreview")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

// ==================== Plan Document Commands ====================

fn daemon_command_with_type(mut request: Value, message_type: &str) -> Result<Value, String> {
    match request {
        Value::Object(ref mut object) => {
            object.insert("type".to_string(), Value::String(message_type.to_string()));
            Ok(request)
        }
        _ => Err(format!(
            "Invalid {message_type} request: request must be a JSON object"
        )),
    }
}

fn normalize_rewind_request_for_daemon(
    mut request: Value,
    allow_dry_run: bool,
) -> Result<Value, String> {
    if let Value::Object(ref mut object) = request {
        object.remove("runId");
        if object
            .remove("dryRun")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
            && !allow_dry_run
        {
            return Err(
                "Invalid conversation rewind request: dryRun must use preview, not apply"
                    .to_string(),
            );
        }
        if object
            .remove("force")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return Err(
                "Invalid conversation rewind request: force is not supported by the daemon protocol"
                    .to_string(),
            );
        }
        if let Some(retain) = object
            .remove("retainTargetUserMessage")
            .and_then(|value| value.as_bool())
        {
            object.insert(
                "mode".to_string(),
                Value::String(
                    if retain {
                        "keep-user-message"
                    } else {
                        "remove-user-message"
                    }
                    .to_string(),
                ),
            );
        }
    }
    Ok(request)
}

#[tauri::command]
pub(crate) async fn workbench_list_plan_documents(app: tauri::AppHandle) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "list-plan-documents" }),
        "plan-documents-listed",
        None,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_create_plan_document(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = daemon_command_with_type(request, "create-plan-document")?;
    send_sidecar_query(&app, cmd, "plan-document-created", None, None).await
}

#[tauri::command]
pub(crate) async fn workbench_create_requirements_alignment_plan(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = daemon_command_with_type(request, "create-requirements-alignment-plan")?;
    send_sidecar_query(&app, cmd, "plan-document-created", None, None).await
}

#[tauri::command]
pub(crate) async fn workbench_get_plan_document(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({
            "type": "get-plan-document",
            "documentId": document_id,
        }),
        "plan-document",
        None,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_patch_plan_document(
    app: tauri::AppHandle,
    document_id: String,
    patch: Value,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({
            "type": "patch-plan-document",
            "documentId": document_id,
            "patch": patch,
        }),
        "plan-document-patched",
        None,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_delete_plan_document(
    app: tauri::AppHandle,
    document_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({
            "type": "delete-plan-document",
            "documentId": document_id,
        }),
        "plan-document-deleted",
        None,
        None,
    )
    .await
}

// ==================== Artifact Commands ====================

#[tauri::command]
pub(crate) async fn workbench_list_artifacts(
    app: tauri::AppHandle,
    session_id: Option<String>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "list-artifacts" });
    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        cmd["sessionId"] = Value::String(sid);
    }
    send_sidecar_query(&app, cmd, "artifacts-listed", None, None).await
}

#[tauri::command]
pub(crate) async fn workbench_get_artifact_content(
    app: tauri::AppHandle,
    artifact_uri: String,
) -> Result<String, String> {
    let result = send_sidecar_query(
        &app,
        serde_json::json!({ "type": "get-artifact-content", "artifactUri": artifact_uri }),
        "artifact-content",
        Some("artifactUri"),
        Some(artifact_uri),
    )
    .await
    .map_err(|e| e.to_string())?;

    result
        .get("content")
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "No content in response".to_string())
}

// ==================== Memory Commands ====================

#[tauri::command]
pub(crate) async fn workbench_list_memories(app: tauri::AppHandle) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "list-memories" }),
        "memories-listed",
        None,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_delete_memory(
    app: tauri::AppHandle,
    memory_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "delete-memory", "memoryId": memory_id }),
        "memory-deleted",
        Some("memoryId"),
        Some(memory_id),
    )
    .await
}

// ==================== Checkpoint Commands ====================

#[tauri::command]
pub(crate) async fn workbench_list_checkpoints(
    app: tauri::AppHandle,
    session_id: Option<String>,
) -> Result<Value, String> {
    let mut cmd = serde_json::json!({ "type": "list-checkpoints" });
    if let Some(sid) = session_id.filter(|s| !s.trim().is_empty()) {
        cmd["sessionId"] = Value::String(sid);
    }
    send_sidecar_query(&app, cmd, "checkpoints-listed", None, None).await
}

#[tauri::command]
pub(crate) async fn workbench_get_checkpoint_diff(
    app: tauri::AppHandle,
    checkpoint_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "get-checkpoint-diff", "checkpointId": checkpoint_id }),
        "checkpoint-diff",
        Some("checkpointId"),
        Some(checkpoint_id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_restore_checkpoint(
    app: tauri::AppHandle,
    checkpoint_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({ "type": "restore-checkpoint", "checkpointId": checkpoint_id }),
        "checkpoint-restored",
        Some("checkpointId"),
        Some(checkpoint_id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_preview_conversation_rewind(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = normalize_rewind_request_for_daemon(request, true)?;
    let use_boundary_preview = cmd.get("targetLeafId").is_none() && cmd.get("entries").is_none();
    let message_type = if use_boundary_preview {
        "preview-conversation-rewind-by-boundary"
    } else {
        "preview-conversation-rewind"
    };
    let expected_type = if use_boundary_preview {
        "conversation-rewind-boundary"
    } else {
        "conversation-rewind-preview"
    };
    let cmd = daemon_command_with_type(cmd, message_type)?;
    let key_value = cmd
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    send_sidecar_query(&app, cmd, expected_type, Some("sessionId"), key_value).await
}

#[tauri::command]
pub(crate) async fn workbench_apply_conversation_rewind(
    app: tauri::AppHandle,
    request: Value,
) -> Result<Value, String> {
    let cmd = normalize_rewind_request_for_daemon(request, false)?;
    let cmd = daemon_command_with_type(cmd, "apply-conversation-rewind")?;
    let key_value = cmd
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    send_sidecar_query(
        &app,
        cmd,
        "conversation-rewind-applied",
        Some("sessionId"),
        key_value,
    )
    .await
}

// ==================== Subagent Commands ====================

#[tauri::command]
pub(crate) async fn workbench_send_to_subagent(
    app: tauri::AppHandle,
    subagent_run_id: String,
    message: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({
            "type": "send-to-subagent",
            "subagentRunId": subagent_run_id,
            "message": message,
        }),
        "subagent-message-sent",
        Some("subagentRunId"),
        Some(subagent_run_id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn workbench_get_subagent_status(
    app: tauri::AppHandle,
    subagent_run_id: String,
) -> Result<Value, String> {
    send_sidecar_query(
        &app,
        serde_json::json!({
            "type": "get-subagent-status",
            "subagentRunId": subagent_run_id,
        }),
        "subagent-status",
        Some("subagentRunId"),
        Some(subagent_run_id),
    )
    .await
}

// ==================== Tests ====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon_discovery::*;
    use crate::sidecar::pending::{
        pending_response_context, reject_all_pending_sidecar_responses,
        reject_pending_sidecar_response_by_request_id, resolve_pending_sidecar_response,
    };
    use crate::sidecar::supervisor::{
        record_sidecar_diagnostic, record_sidecar_disconnect, sidecar_command_diagnostic,
        sidecar_supervisor_snapshot,
    };
    use crate::sidecar::types::{
        default_supervisor_snapshot, init_state, sidecar_run_streams, sidecar_supervisor,
        PendingSidecarResponse,
    };
    use std::{
        env, fs,
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    struct TestDir {
        path: std::path::PathBuf,
    }

    impl TestDir {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path = env::temp_dir().join(format!("conex-sidecar-{name}-{nanos}"));
            fs::create_dir_all(&path).expect("create test dir");
            Self { path }
        }

        fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_test_file(path: &std::path::Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, "test").expect("write test file");
    }

    fn test_app_dir(root: &std::path::Path) -> std::path::PathBuf {
        let app_dir = root.join("apps").join("agent-workbench");
        fs::create_dir_all(&app_dir).expect("create app dir");
        app_dir
    }

    fn reset_pending_responses_for_test() {
        init_state();
        pending_sidecar_responses()
            .lock()
            .expect("pending response lock")
            .clear();
        sidecar_run_streams()
            .lock()
            .expect("run streams lock")
            .clear();
        if let Ok(mut snapshot) = sidecar_supervisor()
            .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
            .lock()
        {
            snapshot.recent_diagnostics.clear();
        }
    }

    fn with_dev_runtime_preference<T>(value: Option<&str>, task: impl FnOnce() -> T) -> T {
        with_env_vars(&[("CONEX_DAEMON_DEV_RUNTIME", value)], task)
    }

    fn with_env_vars<T>(overrides: &[(&str, Option<&str>)], task: impl FnOnce() -> T) -> T {
        let previous = overrides
            .iter()
            .map(|(key, _)| (key.to_string(), env::var_os(key)))
            .collect::<Vec<_>>();
        for (key, value) in overrides {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
        let result = task();
        for (key, value) in previous {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
        result
    }

    #[test]
    fn run_task_command_forwards_long_run_fields() {
        let request = WorkbenchRunTaskRequest {
            prompt: "ship it".to_string(),
            visible_goal: Some("visible ship goal".to_string()),
            session_id: Some("session_long".to_string()),
            run_id: Some("run_long".to_string()),
            mode: Some("long-run".to_string()),
            workspace_mode: Some("project".to_string()),
            budget_difficulty: Some("hard".to_string()),
            run_token_budget: Some(123_456),
            max_rounds: Some(8),
            max_stalled_rounds: Some(3),
            background_drain_timeout_ms: Some(9_000),
            cwd: Some("C:\\work".to_string()),
            permission_mode: Some("ask".to_string()),
        };

        let (cmd, run_id, session_id) = build_workbench_run_task_command(request, None);

        assert_eq!(run_id, "run_long");
        assert_eq!(session_id.as_deref(), Some("session_long"));
        assert_eq!(cmd["type"], "run-task");
        assert_eq!(cmd["runId"], "run_long");
        assert_eq!(cmd["prompt"], "ship it");
        assert_eq!(cmd["visibleGoal"], "visible ship goal");
        assert_eq!(cmd["mode"], "long-run");
        assert_eq!(cmd["workspaceMode"], "project");
        assert_eq!(cmd["budgetDifficulty"], "hard");
        assert_eq!(cmd["runTokenBudget"], 123_456);
        assert_eq!(cmd["maxRounds"], 8);
        assert_eq!(cmd["maxStalledRounds"], 3);
        assert_eq!(cmd["backgroundDrainTimeoutMs"], 9_000);
        assert_eq!(cmd["cwd"], "C:\\work");
        assert_eq!(cmd["permissionMode"], "ask");
    }

    #[test]
    fn git_commands_forward_workspace_query_fields() {
        let status = build_git_status_command(Some("C:\\work".to_string()));
        assert_eq!(status["type"], "git-status");
        assert_eq!(status["cwd"], "C:\\work");

        let diff = build_git_diff_command(
            Some("C:\\work".to_string()),
            Some("src/main.ts".to_string()),
            Some(true),
        );
        assert_eq!(diff["type"], "git-diff");
        assert_eq!(diff["cwd"], "C:\\work");
        assert_eq!(diff["path"], "src/main.ts");
        assert_eq!(diff["staged"], true);
    }

    #[test]
    fn read_session_events_command_forwards_paging_cursor_and_legacy_fields() {
        let cursor = serde_json::json!({
            "eventLogId": "log-session",
            "generation": 2,
            "schemaVersion": 1,
            "protocolVersion": 1,
            "afterSequence": 12,
            "lastEventId": "event-12",
        });

        let cmd = build_read_session_events_command(
            "session_events".to_string(),
            Some(7),
            Some("event-7".to_string()),
            Some(50),
            Some(cursor.clone()),
            Some(false),
        );

        assert_eq!(cmd["type"], "read-session-events");
        assert_eq!(cmd["sessionId"], "session_events");
        assert_eq!(cmd["afterSequence"], 7);
        assert_eq!(cmd["lastEventId"], "event-7");
        assert_eq!(cmd["maxEvents"], 50);
        assert_eq!(cmd["cursor"], cursor);
        assert_eq!(cmd["includeSnapshot"], false);
    }

    #[test]
    fn read_run_events_command_forwards_paging_cursor_and_legacy_fields() {
        let cursor = serde_json::json!({
            "eventLogId": "log-run",
            "generation": 3,
            "schemaVersion": 1,
            "protocolVersion": 1,
            "afterSequence": 21,
            "lastEventId": "event-21",
        });

        let cmd = build_read_run_events_command(
            "run_events".to_string(),
            Some(9),
            Some("event-9".to_string()),
            Some(true),
            Some(25),
            Some(cursor.clone()),
        );

        assert_eq!(cmd["type"], "read-run-events");
        assert_eq!(cmd["runId"], "run_events");
        assert_eq!(cmd["afterSequence"], 9);
        assert_eq!(cmd["lastEventId"], "event-9");
        assert_eq!(cmd["includeSnapshot"], true);
        assert_eq!(cmd["maxEvents"], 25);
        assert_eq!(cmd["cursor"], cursor);
    }

    #[test]
    fn development_launch_plan_uses_source_entry_by_default() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        with_dev_runtime_preference(None, || {
            let dir = TestDir::new("dev-source");
            let app_dir = test_app_dir(dir.path());
            let source_entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
            let local_tsx = dir
                .path()
                .join("node_modules")
                .join(".bin")
                .join(tsx_executable_name());
            write_test_file(&source_entry);
            write_test_file(&local_tsx);

            let isolated_home = dir.path().to_string_lossy().to_string();
            let plan = with_env_vars(
                &[
                    ("CONEX_BUN_BIN", None),
                    ("BUN_BIN", None),
                    ("USERPROFILE", Some(&isolated_home)),
                    ("HOME", Some(&isolated_home)),
                    ("PATH", Some("")),
                ],
                || resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan"),
            );

            assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentLocalTsx);
            assert_eq!(plan.launcher, local_tsx);
            assert_eq!(plan.entry.as_deref(), Some(source_entry.as_path()));

            assert_eq!(plan.args, source_runtime_args(&source_entry));
            assert_eq!(
                plan.selection_reason.as_deref(),
                Some("development mode uses the current daemon source protocol")
            );

            record_sidecar_launch_plan(&plan);
            let launch = sidecar_supervisor_snapshot()
                .launch
                .expect("launch snapshot");
            assert_eq!(launch.runtime_kind, "development-local-tsx");
            assert_eq!(launch.entry_path, source_entry.display().to_string());
            assert!(launch.command.contains(&source_entry.display().to_string()));
            assert_eq!(
                launch.selection_reason.as_deref(),
                Some("development mode uses the current daemon source protocol")
            );
        });
    }

    #[test]
    fn development_launch_plan_rejects_forced_dist_runtime() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        with_dev_runtime_preference(Some("dist"), || {
            let dir = TestDir::new("dev-dist-rejected");
            let app_dir = test_app_dir(dir.path());
            let source_entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
            write_test_file(&source_entry);

            let error = resolve_daemon_launch_plan_inner(&app_dir, false).expect_err("dist disabled");
            let diagnostic = error.diagnostic();

            assert_eq!(error.code, "development-runtime-unsupported");
            assert!(diagnostic.contains("unsupported CONEX_DAEMON_DEV_RUNTIME value: dist"));
            assert!(diagnostic.contains("development runtime must be auto, bun, tsx, or npx"));
        });
    }

    #[test]
    fn development_launch_plan_prefers_bun_source_entry() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        with_dev_runtime_preference(Some("bun"), || {
            let dir = TestDir::new("dev-bun");
            let app_dir = test_app_dir(dir.path());
            let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
            let local_bun = dir
                .path()
                .join("node_modules")
                .join(".bin")
                .join(bun_executable_names()[0]);
            let local_tsx = dir
                .path()
                .join("node_modules")
                .join(".bin")
                .join(tsx_executable_name());
            write_test_file(&entry);
            write_test_file(&local_bun);
            write_test_file(&local_tsx);
            let isolated_home = dir.path().to_string_lossy().to_string();

            let plan = with_env_vars(
                &[
                    ("CONEX_BUN_BIN", None),
                    ("BUN_BIN", None),
                    ("USERPROFILE", Some(&isolated_home)),
                    ("HOME", Some(&isolated_home)),
                    ("PATH", Some("")),
                ],
                || resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan"),
            );

            assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentBun);
            assert_eq!(plan.launcher, local_bun);
            assert_eq!(plan.entry.as_deref(), Some(entry.as_path()));
            assert_eq!(plan.work_dir, dir.path());
            assert_eq!(plan.args, source_runtime_args(&entry));
            assert_eq!(
                plan.selection_reason.as_deref(),
                Some("CONEX_DAEMON_DEV_RUNTIME selected a development source runtime")
            );
        });
    }

    #[test]
    fn development_launch_plan_prefers_local_tsx_source_entry() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        with_dev_runtime_preference(Some("tsx"), || {
            let dir = TestDir::new("dev-local-tsx");
            let app_dir = test_app_dir(dir.path());
            let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
            let local_tsx = dir
                .path()
                .join("node_modules")
                .join(".bin")
                .join(tsx_executable_name());
            write_test_file(&entry);
            write_test_file(&local_tsx);

            let plan = resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan");

            assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentLocalTsx);
            assert_eq!(plan.launcher, local_tsx);
            assert_eq!(plan.entry.as_deref(), Some(entry.as_path()));
            assert_eq!(plan.work_dir, dir.path());
            assert_eq!(plan.args, source_runtime_args(&entry));
        });
    }

    #[test]
    fn development_launch_plan_uses_npx_source_runtime_when_requested() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        with_dev_runtime_preference(Some("npx"), || {
            let dir = TestDir::new("dev-npx");
            let app_dir = test_app_dir(dir.path());
            let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
            write_test_file(&entry);

            let plan = resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan");

            assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentNpx);
            assert_eq!(plan.launcher, std::path::PathBuf::from(npx_executable_name()));
            assert_eq!(
                plan.args,
                npx_tsx_source_runtime_args(&entry)
            );
            assert_eq!(plan.work_dir, dir.path());
        });
    }

    #[test]
    fn development_launch_plan_reports_forced_bun_missing() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        with_dev_runtime_preference(Some("bun"), || {
            let dir = TestDir::new("dev-bun-missing");
            let app_dir = test_app_dir(dir.path());
            let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
            write_test_file(&entry);
            let isolated_home = dir.path().to_string_lossy().to_string();

            let error = with_env_vars(
                &[
                    ("CONEX_BUN_BIN", None),
                    ("BUN_BIN", None),
                    ("USERPROFILE", Some(&isolated_home)),
                    ("HOME", Some(&isolated_home)),
                    ("PATH", Some("")),
                ],
                || resolve_daemon_launch_plan_inner(&app_dir, false).expect_err("missing bun"),
            );

            assert_eq!(error.code, "development-bun-missing");
            assert_eq!(error.mode, DaemonLaunchMode::DevelopmentBun);
            assert!(error.diagnostic().contains("forced to bun"));
        });
    }

    #[test]
    fn production_launch_plan_prefers_bundled_executable() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = TestDir::new("prod-bundled");
        let app_dir = test_app_dir(dir.path());
        let launcher = app_dir
            .join("resources")
            .join(production_daemon_executable_names()[0]);
        write_test_file(&launcher);

        let plan = resolve_daemon_launch_plan_inner(&app_dir, true).expect("launch plan");

        assert_eq!(plan.mode, DaemonLaunchMode::ProductionBundled);
        assert_eq!(plan.launcher, launcher);
        assert!(plan.args.is_empty());
        assert!(plan.entry.is_none());
        assert_eq!(plan.work_dir, app_dir.join("resources"));
    }

    #[test]
    fn production_launch_plan_rejects_loose_javascript_entry() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = TestDir::new("prod-loose-js");
        let app_dir = test_app_dir(dir.path());
        let loose_entry = app_dir
            .join("resources")
            .join("agent-daemon")
            .join("dist")
            .join("index.js");
        write_test_file(&loose_entry);

        let error = resolve_daemon_launch_plan_inner(&app_dir, true).expect_err("loose JS rejected");
        let diagnostic = error.diagnostic();

        assert_eq!(error.code, "packaging-missing");
        assert!(diagnostic.contains("release sidecar requires a bundled daemon executable"));
        assert!(!diagnostic.contains(&loose_entry.display().to_string()));
    }

    #[test]
    fn production_launch_plan_reports_packaging_missing_without_source_or_npx_runtime() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = TestDir::new("prod-missing");
        let app_dir = test_app_dir(dir.path());
        let source_entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        write_test_file(&source_entry);

        let error = resolve_daemon_launch_plan_inner(&app_dir, true).expect_err("missing package");
        let diagnostic = error.diagnostic();

        assert_eq!(error.code, "packaging-missing");
        assert!(diagnostic.contains("runtime_kind: production-bundled-daemon"));
        assert!(diagnostic.contains("code: packaging-missing"));
        assert!(diagnostic.contains("command: (unresolved)"));
        assert!(diagnostic.contains(
            "selection_reason: release mode requires a bundled daemon executable"
        ));
        assert!(diagnostic.contains("launcher_candidates"));
        assert!(diagnostic.contains("entry_candidates"));
        assert!(!diagnostic.contains(npx_executable_name()));
        assert!(!diagnostic.contains(DAEMON_ENTRY_RELATIVE));
    }

    fn push_pending_response_for_test(
        id: u64,
        request_id: &str,
        expected_type: &str,
    ) -> tokio::sync::oneshot::Receiver<Result<Value, String>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        pending_sidecar_responses()
            .lock()
            .expect("pending response lock")
            .push_back(PendingSidecarResponse {
                id,
                request_id: request_id.to_string(),
                expected_type: expected_type.to_string(),
                command_type: "test-query".to_string(),
                command_size_bytes: 2,
                started_at_ms: crate::process::now_millis(),
                key_field: None,
                key_value: None,
                context: pending_response_context(expected_type, None, None),
                sender,
            });
        receiver
    }

    #[test]
    fn daemon_error_with_request_id_rejects_only_matching_pending_response() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();
        let mut first = push_pending_response_for_test(1, "q1", "status-response");
        let mut second = push_pending_response_for_test(2, "q2", "run-snapshot");

        let handled = resolve_pending_sidecar_response(&serde_json::json!({
            "type": "error",
            "requestId": "q2",
            "message": "run missing"
        }));

        assert!(handled);
        assert!(matches!(
            first.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(
            second.try_recv(),
            Ok(Err(
                "run missing (requestId: q2, expectedType: run-snapshot, context: query expectedType=run-snapshot)"
                    .to_string()
            ))
        );

        let pending = pending_sidecar_responses()
            .lock()
            .expect("pending response lock");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].request_id, "q1");
    }

    #[test]
    fn daemon_error_without_request_id_does_not_reject_pending_response() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();
        let mut receiver = push_pending_response_for_test(1, "q1", "error");

        let handled = resolve_pending_sidecar_response(&serde_json::json!({
            "type": "error",
            "message": "broadcast failure"
        }));

        assert!(!handled);
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(
            pending_sidecar_responses()
                .lock()
                .expect("pending response lock")
                .len(),
            1
        );
    }

    #[test]
    fn disconnect_rejects_all_pending_responses_with_request_diagnostics() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();
        let mut first = push_pending_response_for_test(1, "q1", "status-response");
        let mut second = push_pending_response_for_test(2, "q2", "run-snapshot");

        let rejected =
            reject_all_pending_sidecar_responses("Sidecar disconnected: test".to_string());

        assert_eq!(rejected, 2);
        assert_eq!(
            first.try_recv(),
            Ok(Err(
                "Sidecar disconnected: test (requestId: q1, expectedType: status-response, context: query expectedType=status-response)"
                    .to_string()
            ))
        );
        assert_eq!(
            second.try_recv(),
            Ok(Err(
                "Sidecar disconnected: test (requestId: q2, expectedType: run-snapshot, context: query expectedType=run-snapshot)"
                    .to_string()
            ))
        );
        assert_eq!(
            pending_sidecar_responses()
                .lock()
                .expect("pending response lock")
                .len(),
            0
        );
    }

    #[test]
    fn sidecar_disconnect_snapshot_records_reason_and_rejected_count() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        init_state();
        let before = sidecar_supervisor_snapshot().disconnect_count;

        record_sidecar_disconnect(42, "Daemon WebSocket read error: test", 3);
        let snapshot = sidecar_supervisor_snapshot();

        assert_eq!(snapshot.disconnect_count, before + 1);
        let disconnect = snapshot.last_disconnect.expect("last disconnect");
        assert_eq!(disconnect.generation, 42);
        assert_eq!(disconnect.message, "Daemon WebSocket read error: test");
        assert_eq!(disconnect.rejected_pending_responses, 3);
        assert!(!disconnect.disconnected_at.is_empty());
    }

    #[test]
    fn rejected_pending_response_records_sanitized_recent_diagnostic() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();
        let mut receiver = push_pending_response_for_test(1, "q1", "run-snapshot");

        let handled = reject_pending_sidecar_response_by_request_id(
            "q1",
            format!("daemon failed with secret {}", "x".repeat(400)),
        );

        assert!(handled);
        assert!(matches!(receiver.try_recv(), Ok(Err(_))));
        let snapshot = sidecar_supervisor_snapshot();
        let diagnostic = snapshot
            .recent_diagnostics
            .last()
            .expect("recent diagnostic");
        assert_eq!(diagnostic.request_id, "q1");
        assert_eq!(diagnostic.command_type, "test-query");
        assert_eq!(diagnostic.command_size_bytes, 2);
        assert_eq!(diagnostic.status, SidecarCommandDiagnosticStatus::Error);
        let error = diagnostic.error.as_ref().expect("error diagnostic");
        assert_eq!(error.layer, "daemon-response");
        assert!(error.message.len() <= SIDECAR_ERROR_MESSAGE_LIMIT + 3);
    }

    #[test]
    fn recent_diagnostics_are_bounded() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();

        for index in 0..(SIDECAR_RECENT_DIAGNOSTICS_LIMIT + 3) {
            record_sidecar_diagnostic(sidecar_command_diagnostic(
                format!("q{index}"),
                "status".to_string(),
                16,
                None,
                crate::process::now_millis(),
                SidecarCommandDiagnosticStatus::Ok,
                None,
            ));
        }

        let snapshot = sidecar_supervisor_snapshot();
        assert_eq!(
            snapshot.recent_diagnostics.len(),
            SIDECAR_RECENT_DIAGNOSTICS_LIMIT
        );
        assert_eq!(snapshot.recent_diagnostics[0].request_id, "q3");
    }

    #[test]
    fn replay_cursor_falls_back_to_event_log_and_next_sequence() {
        let response = serde_json::json!({
            "type": "run-events",
            "runId": "run_replay",
            "events": [
                { "id": "event-8", "sequence": 8, "type": "runtime-event", "sessionId": "session_replay", "runId": "run_replay", "timestamp": "2026-01-01T00:00:00Z", "payload": {} }
            ],
            "eventLog": {
                "eventLogId": "eventlog_replay",
                "generation": 4,
                "schemaVersion": 1,
                "protocolVersion": 1
            },
            "nextAfterSequence": 8
        });

        let cursor = replay_cursor_from_run_events_response(&response).expect("cursor");

        assert_eq!(
            cursor,
            RunEventReplayCursor {
                event_log_id: "eventlog_replay".to_string(),
                generation: 4,
                schema_version: 1,
                protocol_version: 1,
                after_sequence: 8,
                last_event_id: Some("event-8".to_string()),
            }
        );
    }

    #[test]
    fn run_stream_disconnect_marks_registered_daemon_owned_runs() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();

        register_run_stream_recovery("run_live", Some("session_live"));
        mark_run_streams_disconnected(7, "Daemon WebSocket read error: test");

        let streams = pending_disconnected_run_streams();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].run_id, "run_live");
        assert_eq!(streams[0].session_id.as_deref(), Some("session_live"));
        assert_eq!(streams[0].disconnected_generation, Some(7));
        assert_eq!(
            streams[0].disconnect_message.as_deref(),
            Some("Daemon WebSocket read error: test")
        );
    }

    #[test]
    fn terminal_run_event_clears_stream_recovery_state() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        reset_pending_responses_for_test();

        register_run_stream_recovery("run_done", Some("session_done"));
        observe_run_stream_event(&serde_json::json!({
            "id": "event-9",
            "sequence": 9,
            "type": "run-completed",
            "sessionId": "session_done",
            "runId": "run_done",
            "timestamp": "2026-01-01T00:00:00Z",
            "payload": {}
        }));

        assert!(sidecar_run_streams()
            .lock()
            .expect("run streams lock")
            .is_empty());
    }
}
