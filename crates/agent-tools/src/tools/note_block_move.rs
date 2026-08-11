//! 笔记写工具：`block_move`（W4-F 细粒度 · A-AGT-01…03 形状）
//!
//! # 契约
//! - 入参：`doc_id` + `id`；可选 `previous_id` / `parent_id` / `batch_id`
//! - 经 [`NoteBackend::block_move`]（默认委托 `apply_block_ops` 单 move）
//! - `dangerous=true`；plan **Deny**
//! - abort / 中断 → `note.execution_unknown`（禁止自动重试写）
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 全表关闭**；**≠ W6-E**
//! - Memory 禁关生产 A-AGT；Store 真路径见 `conex-note-runtime`

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{backend_err_to_tool_err, NoteBackendError, NoteBlockMoveRequest};
use crate::tools::note_document_apply_md::maybe_ask_note_write;
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use crate::tools::{optional_string, require_string};
use async_trait::async_trait;

/// `block_move`（dangerous=true）
pub(crate) struct BlockMoveTool {
    def: ToolDefinition,
}

impl BlockMoveTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "block_move".to_string(),
                description: "重排笔记文档中的单个块（细粒度 move）。\
入参 doc_id + id；可选 previous_id（落点前序兄弟）/ parent_id / batch_id。\
走 NoteBackend 事务化路径，禁止 fs.write 当权威。\
≠ EL-05 / ≠ W6-E / ≠ A-AGT 全表。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "目标文档 ID（必填）"
                        },
                        "id": {
                            "type": "string",
                            "description": "被移动的块 ID（必填）"
                        },
                        "previous_id": {
                            "type": "string",
                            "description": "新位置前序兄弟块 ID（可选；缺省移到父级末尾）"
                        },
                        "parent_id": {
                            "type": "string",
                            "description": "新父块 ID（可选；Memory 扁平树可忽略）"
                        },
                        "batch_id": {
                            "type": "string",
                            "description": "会话 batch token（可选）"
                        }
                    },
                    "required": ["doc_id", "id"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for BlockMoveTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        let doc_id = require_string(&args, "doc_id")?;
        let id = require_string(&args, "id")?;
        let previous_id = optional_string(&args, "previous_id");
        let parent_id = optional_string(&args, "parent_id");
        let batch_id = optional_string(&args, "batch_id");

        if ctx.abort_token.is_aborted() {
            return Err(ToolError::new(
                "note.execution_unknown",
                "write interrupted (abort) before block_move; execution state unknown — do not auto-retry write",
            ));
        }

        maybe_ask_note_write(ctx, self.name(), &args).await?;

        if ctx.abort_token.is_aborted() {
            return Err(ToolError::new(
                "note.execution_unknown",
                "write interrupted (abort) after approval; execution state unknown — do not auto-retry write",
            ));
        }

        let Some(backend) = ctx.note_backend.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": NOTE_BACKEND_UNWIRED,
                "id": id,
            }));
        };

        let req = NoteBlockMoveRequest {
            doc_id,
            id,
            previous_id,
            parent_id,
            batch_id,
            origin: Some("agent".into()),
        };

        match backend.block_move(req).await {
            Ok(r) => Ok(serde_json::json!({
                "ok": true,
                "id": r.id,
            })),
            Err(e @ NoteBackendError::ExecutionUnknown(_)) => {
                Err(backend_err_to_tool_err(self.name(), e))
            }
            Err(e) => Err(backend_err_to_tool_err(self.name(), e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{create_mock_tool_context, AbortToken};
    use crate::note_backend::{MemoryNoteBackend, NoteBackend};
    use crate::note_permission::{decide_note_tool, plan_denies_note_tool};
    use crate::permission::{PermissionMode, PermissionVerdict};
    use std::sync::Arc;

    #[test]
    fn block_move_schema_shape() {
        let tool = BlockMoveTool::new();
        assert_eq!(tool.name(), "block_move");
        assert!(tool.definition().dangerous);
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        for key in ["doc_id", "id"] {
            assert!(
                required.iter().any(|v| v.as_str() == Some(key)),
                "missing required {key}"
            );
        }
        let props = schema["properties"].as_object().unwrap();
        for key in ["doc_id", "id", "previous_id", "parent_id", "batch_id"] {
            assert!(props.contains_key(key), "missing {key}");
        }
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn block_move_unwired() {
        let tool = BlockMoveTool::new();
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "d", "id": "b1" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
    }

    /// Memory：将 b1 移到 b2 之后（b1,b2,b3 → b2,b1,b3）
    #[tokio::test]
    async fn block_move_reorders_blocks_memory() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-mv",
            vec![
                ("b1".into(), "paragraph".into(), "one".into()),
                ("b2".into(), "paragraph".into(), "two".into()),
                ("b3".into(), "paragraph".into(), "three".into()),
            ],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockMoveTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-mv",
                    "id": "b1",
                    "previous_id": "b2",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["id"], "b1");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-mv".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let ids: Vec<&str> = q.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["b2", "b1", "b3"]);
    }

    /// abort → note.execution_unknown，零写（顺序不变）
    #[tokio::test]
    async fn block_move_abort_execution_unknown() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-ab-mv",
            vec![
                ("b1".into(), "paragraph".into(), "a".into()),
                ("b2".into(), "paragraph".into(), "b".into()),
            ],
        );
        let abort = AbortToken::new();
        abort.abort();
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            abort_token: abort,
            ..create_mock_tool_context()
        };
        let tool = BlockMoveTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-ab-mv",
                    "id": "b1",
                    "previous_id": "b2",
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "note.execution_unknown");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-ab-mv".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let ids: Vec<&str> = q.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["b1", "b2"]);
    }

    #[test]
    fn block_move_plan_denied() {
        assert!(plan_denies_note_tool("block_move"));
        assert_eq!(
            decide_note_tool("block_move", PermissionMode::Plan),
            Some(PermissionVerdict::Deny)
        );
    }
}
