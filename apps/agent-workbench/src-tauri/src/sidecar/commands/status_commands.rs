use serde_json::Value;

use super::super::connection::*;
use super::super::supervisor::*;
use super::super::types::*;
use crate::process;

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

pub(crate) fn build_git_status_command(cwd: Option<String>) -> Value {
    let mut cmd = serde_json::json!({ "type": "git-status" });
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        cmd["cwd"] = Value::String(cwd);
    }
    cmd
}

pub(crate) fn build_git_diff_command(cwd: Option<String>, path: Option<String>, staged: Option<bool>) -> Value {
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
