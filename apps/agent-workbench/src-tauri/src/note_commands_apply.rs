//! SR-06f · note_commands 拆分 · apply 面（写路径）
//!
//! 三个写命令：`note_document_apply_md` / `note_send_to_note` / `note_apply_ops`，
//! 均经 `note_runtime` 共享句柄落盘（apply 事务化 / intent 幂等 / collab wire）。
//! 共享失败面（`unwired_failure` / `err_outcome`）持有于门面 `note_commands`
//! （本模经 `super::` 引用）。
//!
//! SR-06f · 拆分 · ≠ 关闭任何 EL（搬移不改语义；B2 spawn_blocking 与
//! CT-01 err_outcome 映射排本拆分之后，本模不加）。

use agent_tools::note_backend::{apply_result_json, NoteApplyMdRequest, NoteApplyMode};
use conex_types::CoreError;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};

use crate::note_runtime;

use super::{err_outcome, unwired_failure};

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

/// CONN-B3 · collab wire apply 入参（对齐前端 `NoteApplyOpsRequest`）。
///
/// `ops_json` = TS `createCollabApplySink` 产出的 collab Op 数组 JSON 字符串。
#[derive(Debug, Clone, Deserialize)]
pub struct NoteApplyOpsArgs {
    pub doc_id: String,
    /// collab Op 数组 JSON（`ops_from_json` 形状）
    pub ops_json: String,
    /// 幂等 / 审计键（可选；前端 ApplyOpsAdapter meta.intentId）
    #[serde(default)]
    pub intent_id: Option<String>,
    /// `user` | `agent` | `remote` | `system`；默认 user
    #[serde(default)]
    pub origin: Option<String>,
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

/// collab wire JSON → 真 `DocSession::apply`（CONN-B3 产品写锥 IPC）。
///
/// wire 名 = `note_apply_ops`（前端 `NOTE_CMD_APPLY_OPS`）。
///
/// # 形状
/// - 入参：`doc_id` + `ops_json`（collab Op 数组字符串，对齐
///   TS `createCollabApplySink` / `collabOpsToJson`）
/// - 成功：`{ ok:true, doc_id, rev, applied, source:'tauri-ipc', intent_id? }`
/// - 失败：`{ ok:false, code, reason }`（解析失败 / apply 拒 / unwired）
///
/// # 诚实边界
/// - **≠ EL-01**；**≠ A-BLK 全表 e2e**；命令可测 **≠** 打开完成
/// - 无 NoteRuntime → `note.unwired`（结构化失败，不抛）
#[tauri::command]
pub async fn note_apply_ops(req: NoteApplyOpsArgs) -> Result<JsonValue, CoreError> {
    let doc_id = req.doc_id.trim().to_string();
    if doc_id.is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "doc_id must be non-empty",
        }));
    }
    if req.ops_json.trim().is_empty() {
        return Ok(json!({
            "ok": false,
            "code": "note.invalid",
            "reason": "ops_json must be non-empty",
        }));
    }
    let Some(store) = note_runtime::try_store_backend() else {
        return Ok(unwired_failure());
    };
    match store.apply_collab_ops_json(&doc_id, &req.ops_json, req.origin.as_deref()) {
        Ok(out) => {
            let mut body = json!({
                "ok": true,
                "doc_id": doc_id,
                "rev": out.rev,
                "applied": out.applied,
                "source": "tauri-ipc",
            });
            if let Some(intent) = req
                .intent_id
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("intent_id".into(), json!(intent));
                }
            }
            Ok(body)
        }
        Err(e) => Ok(err_outcome(e)),
    }
}
