//! 笔记工具 JSON / ToolError 辅助（SD-01 纵向切开）
//!
//! 将后端结果与错误映射为工具面形状；**≠ EL-05**。

use crate::note_types::{
    NoteApplyMdResult, NoteBackendError, NoteBlockBatchResult,
};
use serde_json::Value as JsonValue;

/// 将后端错误映射为工具执行失败（写工具）；读工具更常返回 ok=false
///
/// # W4-B batch token
/// - `BatchTokenInvalid` → `tool.invalid_input`（未占用 / 空 id）
/// - `BatchTokenExpired` → `tool.invalid_input`，message 含 `note.batch_token_expired`
///   （与 invalid 同属调用方契约错误，不进 execution_failed 软失败面）
///
/// # W4-F execution_unknown
/// - `ExecutionUnknown` → 稳定码 `note.execution_unknown`（**禁止**映射为
///   普通 execution_failed 以免 Agent 盲目重试写）
pub fn backend_err_to_tool_err(
    tool_name: &str,
    err: NoteBackendError,
) -> crate::definition::ToolError {
    use crate::definition::ToolError;
    match &err {
        NoteBackendError::Invalid(m) | NoteBackendError::BatchTokenInvalid(m) => {
            ToolError::invalid_input(m.clone())
        }
        NoteBackendError::BatchTokenExpired(m) => {
            ToolError::invalid_input(format!("note.batch_token_expired: {m}"))
        }
        NoteBackendError::ExecutionUnknown(m) => {
            ToolError::new("note.execution_unknown", m.clone())
        }
        NoteBackendError::Unwired => ToolError::execution_failed(tool_name, err.message()),
        other => {
            ToolError::execution_failed(tool_name, format!("{}: {}", other.code(), other.message()))
        }
    }
}

/// 成功 block_batch 结果 → 工具 JSON（A-AGT-05 形状）
pub fn block_batch_result_json(result: &NoteBlockBatchResult) -> JsonValue {
    serde_json::json!({
        "ok": true,
        "dry_run": result.dry_run,
        "dryRun": result.dry_run,
        "applied": result.applied,
        "block_ids": result.block_ids,
        "preview": result.preview.iter().map(|p| {
            serde_json::json!({
                "op": p.op,
                "id": p.id,
                "kind": p.kind,
                "summary": p.summary,
            })
        }).collect::<Vec<_>>(),
    })
}

/// 成功 apply 结果 → 工具 JSON
///
/// W4-A：`lossy.items[]` 进入结果面，调用方（Agent / 审计）可观测有损；
/// 空数组 = 无有损项。**≠ EL-05**。
pub fn apply_result_json(result: &NoteApplyMdResult) -> JsonValue {
    serde_json::json!({
        "ok": true,
        "block_ids": result.block_ids,
        "inserted": result.inserted,
        "idempotent": result.idempotent,
        "lossy": {
            "items": result.lossy.items.iter().map(|i| {
                serde_json::json!({
                    "code": i.code,
                    "detail": i.detail,
                    "line": i.line,
                })
            }).collect::<Vec<_>>(),
        },
    })
}
