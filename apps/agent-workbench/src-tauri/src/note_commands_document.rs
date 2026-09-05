//! 多笔记综合管理体系 Tauri IPC 命令实现。
//!
//! 提供四大命令：
//! - `note_document_list`
//! - `note_document_create`
//! - `note_document_rename`
//! - `note_document_delete`
//!
//! 编译器级安全纪律：
//! 1. 显式标注 spawn_blocking 闭包返回类型 `-> Result<..., StoreError>`，根除类型推断二义性报错；
//! 2. 失败时返回标准 JSON `{ ok: false, code, reason }`，对齐前端类型契约。

use crate::note_runtime;
use conex_types::CoreError;
use conex_workspace_store::document_meta::NoteDocumentMeta;
use conex_workspace_store::StoreError;
use serde_json::{json, Value as JsonValue};

/// 1. 获取文档元数据列表
#[tauri::command]
pub async fn note_document_list(
    include_archived: Option<bool>,
) -> Result<JsonValue, CoreError> {
    let _ = include_archived; // 保持入参兼容性，底层单轨全量返回
    let Some(backend) = note_runtime::try_store_backend() else {
        return Ok(super::unwired_failure());
    };

    let joined = tokio::task::spawn_blocking(move || -> Result<Vec<NoteDocumentMeta>, StoreError> {
        backend.store().list_documents()
    })
    .await;

    match joined {
        Ok(Ok(documents)) => {
            let total = documents.len();
            Ok(json!({
                "ok": true,
                "documents": documents,
                "totalCount": total
            }))
        }
        Ok(Err(e)) => Ok(json!({
            "ok": false,
            "code": "note.store_error",
            "reason": e.to_string()
        })),
        Err(e) => Ok(json!({
            "ok": false,
            "code": "note.task_failed",
            "reason": e.to_string()
        })),
    }
}

/// 2. 新建笔记文档
#[tauri::command]
pub async fn note_document_create(
    title: Option<String>,
    initial_markdown: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<JsonValue, CoreError> {
    let _ = tags; // 保持契约宽容，底层不持久化死属性
    let Some(backend) = note_runtime::try_store_backend() else {
        return Ok(super::unwired_failure());
    };

    let joined = tokio::task::spawn_blocking(move || -> Result<NoteDocumentMeta, StoreError> {
        backend.store().create_document(
            title.as_deref(),
            initial_markdown.as_deref(),
        )
    })
    .await;

    match joined {
        Ok(Ok(document)) => Ok(json!({
            "ok": true,
            "document": document
        })),
        Ok(Err(e)) => Ok(json!({
            "ok": false,
            "code": "note.store_error",
            "reason": e.to_string()
        })),
        Err(e) => Ok(json!({
            "ok": false,
            "code": "note.task_failed",
            "reason": e.to_string()
        })),
    }
}

/// 3. 重命名笔记文档
#[tauri::command]
pub async fn note_document_rename(doc_id: String, title: String) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_store_backend() else {
        return Ok(super::unwired_failure());
    };

    let doc_id_clone = doc_id.clone();
    let title_clone = title.clone();
    let joined = tokio::task::spawn_blocking(move || -> Result<i64, StoreError> {
        let updated_at = backend.store().rename_document(&doc_id_clone, &title_clone)?;
        Ok(updated_at)
    })
    .await;

    match joined {
        Ok(Ok(updated_at)) => Ok(json!({
            "ok": true,
            "docId": doc_id,
            "title": title,
            "updatedAt": updated_at
        })),
        Ok(Err(e)) => Ok(json!({
            "ok": false,
            "code": "note.store_error",
            "reason": e.to_string()
        })),
        Err(e) => Ok(json!({
            "ok": false,
            "code": "note.task_failed",
            "reason": e.to_string()
        })),
    }
}

/// 4. 彻底删除笔记文档（物理级联硬删除）
#[tauri::command]
pub async fn note_document_delete(
    doc_id: String,
    hard_delete: Option<bool>,
) -> Result<JsonValue, CoreError> {
    let _ = hard_delete; // 坚决执行真实物理硬删除
    let Some(backend) = note_runtime::try_store_backend() else {
        return Ok(super::unwired_failure());
    };

    let doc_id_clone = doc_id.clone();
    let joined = tokio::task::spawn_blocking(move || -> Result<bool, StoreError> {
        backend.store().delete_document(&doc_id_clone)
    })
    .await;

    match joined {
        Ok(Ok(deleted)) => Ok(json!({
            "ok": true,
            "docId": doc_id,
            "hardDeleted": deleted
        })),
        Ok(Err(e)) => Ok(json!({
            "ok": false,
            "code": "note.store_error",
            "reason": e.to_string()
        })),
        Err(e) => Ok(json!({
            "ok": false,
            "code": "note.task_failed",
            "reason": e.to_string()
        })),
    }
}
