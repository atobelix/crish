use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;

use super::super::connection::*;
use super::super::run_stream::*;
use super::*;
use crate::{commands::WorkbenchRunTaskRequest, process};
use crate::sidecar::types::WorkbenchCancelRunResult;

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

    send_sidecar_command(&app, cmd_json, context).await?;

    process::register_active_run(&run_id, 0);
    register_run_stream_recovery(&run_id, session_id.as_deref());

    let mut response = serde_json::json!({ "runId": run_id });
    if let Some(session_id) = session_id {
        response["sessionId"] = serde_json::Value::String(session_id);
    }
    Ok(response)
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
