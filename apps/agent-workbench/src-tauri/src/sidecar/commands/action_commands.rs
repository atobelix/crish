use serde_json::Value;

use super::super::connection::*;
use super::*;

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
