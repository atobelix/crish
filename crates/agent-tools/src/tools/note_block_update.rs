//! 笔记写工具：`block_update`（W4-F 细粒度 · A-AGT-01…03 形状）
//!
//! # 契约
//! - 入参：`doc_id` + `id` + `content`；可选 `batch_id`
//! - 经 [`NoteBackend::block_update`]（默认委托 `apply_block_ops` 单 update）
//! - `dangerous=true`；plan **Deny**
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 全表关闭**；**≠ W6-E**
//! - Memory 禁关生产 A-AGT；Store 真路径见 `conex-note-runtime`

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{backend_err_to_tool_err, NoteBackendError, NoteBlockUpdateRequest};
use crate::tools::note_document_apply_md::require_markdown;
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use crate::tools::{optional_string, require_string};
use async_trait::async_trait;

/// `block_update`（dangerous=true）
pub(crate) struct BlockUpdateTool {
    def: ToolDefinition,
}

impl BlockUpdateTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "block_update".to_string(),
                description: "更新笔记文档中单个块的文本（细粒度 mutate）。\
入参 doc_id + id + content；可选 batch_id。\
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
                            "description": "目标块 ID（必填）"
                        },
                        "content": {
                            "type": "string",
                            "description": "新文本内容（必填；可为空串）"
                        },
                        "batch_id": {
                            "type": "string",
                            "description": "会话 batch token（可选）"
                        }
                    },
                    "required": ["doc_id", "id", "content"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

/// content 允许空串（与 markdown 写工具一致）
fn require_content(args: &serde_json::Value) -> Result<String, ToolError> {
    let mut aliased = args.clone();
    if let Some(obj) = aliased.as_object_mut() {
        if let Some(c) = obj.get("content").cloned() {
            obj.insert("markdown".into(), c);
        }
    }
    require_markdown(&aliased)
}

#[async_trait]
impl Tool for BlockUpdateTool {
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
        let content = require_content(&args)?;
        let batch_id = optional_string(&args, "batch_id");

        if ctx.abort_token.is_aborted() {
            return Err(ToolError::new(
                "note.execution_unknown",
                "write interrupted (abort) before block_update; execution state unknown — do not auto-retry write",
            ));
        }

        let Some(backend) = ctx.note_backend.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": NOTE_BACKEND_UNWIRED,
                "id": id,
            }));
        };

        let req = NoteBlockUpdateRequest {
            doc_id,
            id,
            content,
            batch_id,
            origin: Some("agent".into()),
        };

        match backend.block_update(req).await {
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

    use std::sync::Arc;

    #[test]
    fn block_update_schema_shape() {
        let tool = BlockUpdateTool::new();
        assert_eq!(tool.name(), "block_update");
        assert!(tool.definition().dangerous);
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        for key in ["doc_id", "id", "content"] {
            assert!(
                required.iter().any(|v| v.as_str() == Some(key)),
                "missing required {key}"
            );
        }
        let props = schema["properties"].as_object().unwrap();
        for key in ["doc_id", "id", "content", "batch_id"] {
            assert!(props.contains_key(key), "missing {key}");
        }
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn block_update_unwired() {
        let tool = BlockUpdateTool::new();
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "d", "id": "b1", "content": "x" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
    }

    #[tokio::test]
    async fn block_update_writes_content() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-up",
            vec![("b1".into(), "paragraph".into(), "old".into())],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockUpdateTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-up",
                    "id": "b1",
                    "content": "new body",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["id"], "b1");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-up".into(),
                text_match: Some("new body".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
    }

    /// abort → note.execution_unknown，零写
    #[tokio::test]
    async fn block_update_abort_execution_unknown() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-ab",
            vec![("b1".into(), "paragraph".into(), "stay".into())],
        );
        let abort = AbortToken::new();
        abort.abort();
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            abort_token: abort,
            ..create_mock_tool_context()
        };
        let tool = BlockUpdateTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-ab",
                    "id": "b1",
                    "content": "nope",
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "note.execution_unknown");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-ab".into(),
                text_match: Some("stay".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
    }
}
