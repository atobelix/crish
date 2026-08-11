//! Round7 · Tauri 笔记命令面（前端 `noteApi.ts` IPC）
//!
//! 命令名（wire = 函数名）：
//! - `note_document_apply_md`
//! - `note_query_blocks`
//! - `note_send_to_note`
//!
//! 入参/出参 snake_case 线格式，对齐 `apps/crish-desktop/src/api/noteApi.ts`
//! 与 `agent_tools::note_backend` 契约。
//!
//! 成功/业务失败均以 `{ ok: true|false, ... }` JSON 返回（Ok 包装），
//! 便于前端 `parseApplyOutcome` / `parseQueryOutcome`；仅 IPC 级故障走
//! `CoreError` reject。
//!
//! 纪律：
//! - 写路径仅 `apply_md_fragment` / send_to_note（intent 幂等）
//! - **不**静默流式写笔记
//! - 读路径走 store 投影；**不**默认读 MD mirror

use agent_tools::note_backend::{
    apply_result_json, NoteApplyMdRequest, NoteApplyMode, NoteBackendError, NoteQueryBlocksParams,
};
#[cfg(test)]
use agent_tools::note_backend::{NoteApplyMdResult, NoteBackend as _};
use conex_types::CoreError;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use crate::note_runtime;

/// 未接线时的结构化失败（对齐 noteApi `note.command_missing` 语义族）。
fn unwired_failure() -> JsonValue {
    json!({
        "ok": false,
        "code": "note.unwired",
        "reason": "note backend not wired (workspace.db 未打开 / NoteRuntime 未装配)",
    })
}

fn err_outcome(err: NoteBackendError) -> JsonValue {
    json!({
        "ok": false,
        "code": err.code(),
        "reason": err.message(),
    })
}

/// send_to_note 专用入参（intent_id 必填；与 apply 字段同形）。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteSendToNoteArgs {
    pub intent_id: String,
    pub markdown: String,
    pub doc_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub after_block_id: Option<String>,
    #[serde(default)]
    pub mode: Option<NoteApplyMode>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub batch_id: Option<String>,
}

/// 事务化 apply MD 片段 → 块树（权威路径）。
///
/// wire 名 = `note_document_apply_md`（前端 NOTE_CMD_DOCUMENT_APPLY_MD）。
#[tauri::command]
pub async fn note_document_apply_md(req: NoteApplyMdRequest) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    match backend.apply_md_fragment(req).await {
        Ok(result) => Ok(apply_result_json(&result)),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// 组合查询块摘要（投影 / FTS；非 mirror）。
///
/// wire 名 = `note_query_blocks`（前端 NOTE_CMD_QUERY_BLOCKS）。
#[tauri::command]
pub async fn note_query_blocks(params: NoteQueryBlocksParams) -> Result<JsonValue, CoreError> {
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    match backend.query_blocks(params).await {
        Ok(result) => Ok(json!({
            "ok": true,
            "blocks": result.blocks,
            "truncated": result.truncated,
        })),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// 显式 send_to_note Intent 写路径（幂等 intent_id；禁止静默缝合）。
///
/// wire 名 = `note_send_to_note`（前端 NOTE_CMD_SEND_TO_NOTE）。
#[tauri::command]
pub async fn note_send_to_note(req: NoteSendToNoteArgs) -> Result<JsonValue, CoreError> {
    if req.intent_id.trim().is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "intent_id must be non-empty",
        }));
    }
    let Some(backend) = note_runtime::try_backend() else {
        return Ok(unwired_failure());
    };
    let apply_req = NoteApplyMdRequest {
        doc_id: req.doc_id,
        markdown: req.markdown,
        parent_id: req.parent_id,
        after_block_id: req.after_block_id,
        mode: req.mode.unwrap_or(NoteApplyMode::ApplyMdFragment),
        intent_id: Some(req.intent_id),
        batch_id: req.batch_id,
        message_id: req.message_id,
        origin: Some(req.origin.unwrap_or_else(|| "user".into())),
    };
    match backend.apply_md_fragment(apply_req).await {
        Ok(result) => Ok(apply_result_json(&result)),
        Err(e) => Ok(err_outcome(e)),
    }
}

/// 命令层同步 smoke 助手（测试 / 非 Tauri 路径）：apply 后返回结果。
#[cfg(test)]
pub(crate) async fn apply_md_for_test(
    req: NoteApplyMdRequest,
) -> Result<NoteApplyMdResult, NoteBackendError> {
    let backend = note_runtime::try_backend().ok_or(NoteBackendError::Unwired)?;
    backend.apply_md_fragment(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::note_backend::NoteApplyMode;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_install() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "workbench-note-cmd-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            n
        ));
        let _ = std::fs::create_dir_all(&dir);
        let db = dir.join("workspace.db");
        note_runtime::install_for_test(&db).expect("install note runtime");
        dir
    }

    #[tokio::test]
    async fn command_apply_and_query_roundtrip() {
        let dir = temp_install();
        let apply = note_document_apply_md(NoteApplyMdRequest {
            doc_id: "cmd-doc".into(),
            markdown: "## Cmd Test\n\nhello note command".into(),
            parent_id: None,
            after_block_id: None,
            mode: NoteApplyMode::ApplyMdFragment,
            intent_id: None,
            batch_id: None,
            message_id: None,
            origin: Some("user".into()),
        })
        .await
        .unwrap();
        assert_eq!(apply["ok"], true);
        assert!(apply["inserted"].as_u64().unwrap_or(0) >= 1);

        let q = note_query_blocks(NoteQueryBlocksParams {
            doc_id: "cmd-doc".into(),
            text_match: Some("command".into()),
            ..Default::default()
        })
        .await
        .unwrap();
        assert_eq!(q["ok"], true);
        assert!(q["blocks"].as_array().map(|a| !a.is_empty()).unwrap_or(true));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn send_to_note_idempotent() {
        let dir = temp_install();
        let req = NoteSendToNoteArgs {
            intent_id: "intent-cmd-1".into(),
            markdown: "send once".into(),
            doc_id: "send-doc".into(),
            message_id: Some("msg-1".into()),
            parent_id: None,
            after_block_id: None,
            mode: None,
            origin: Some("user".into()),
            batch_id: None,
        };
        let first = note_send_to_note(req.clone()).await.unwrap();
        assert_eq!(first["ok"], true);
        assert_eq!(first["idempotent"], false);
        let second = note_send_to_note(req).await.unwrap();
        assert_eq!(second["ok"], true);
        assert_eq!(second["idempotent"], true);
        assert_eq!(second["inserted"], 0);
        assert_eq!(second["block_ids"], first["block_ids"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn send_rejects_empty_intent() {
        let dir = temp_install();
        let out = note_send_to_note(NoteSendToNoteArgs {
            intent_id: "  ".into(),
            markdown: "x".into(),
            doc_id: "d".into(),
            message_id: None,
            parent_id: None,
            after_block_id: None,
            mode: None,
            origin: None,
            batch_id: None,
        })
        .await
        .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["code"], "note.invalid");
        let _ = std::fs::remove_dir_all(dir);
    }
}
