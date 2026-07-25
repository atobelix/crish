use serde_json::Value;

use super::super::connection::*;
use super::*;

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
