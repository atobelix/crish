//! 笔记写工具：`send_to_note`（W4-B / dual-engine-surface §5）
//!
//! # 契约
//! - 显式桥：chat 完成态 → note-paper；**禁止**静默缝合。
//! - 内部走同一 `apply_md_fragment` 后端路径。
//! - 重复 `intent_id`：幂等 no-op / 返回首次结果（Memory 用 HashMap）。
//!
//! 入参对齐 Intent：intent_id, message_id?, markdown, doc_id, parent_id?,
//! after_block_id?, mode, origin。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{
    apply_result_json, backend_err_to_tool_err, NoteApplyMdRequest, NoteBackendError,
};
use crate::tools::note_document_apply_md::{
    maybe_ask_note_write, parse_apply_mode, require_markdown,
};
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use crate::tools::{optional_string, require_string};
use async_trait::async_trait;

/// `send_to_note`（dangerous=true，写工具，不进只读集）
pub(crate) struct SendToNoteTool {
    def: ToolDefinition,
}

impl SendToNoteTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "send_to_note".to_string(),
                description: "将 chat 完成态 Markdown 显式发送到笔记文档（send_to_note Intent）。\
内部走 apply_md_fragment，禁止静默缝合 / 禁止 fs.write 当权威。\
intent_id 幂等：重复调用不双插。后端未接线时返回 ok=false / note_backend_unwired。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "intent_id": {
                            "type": "string",
                            "description": "幂等键（必填）；重复调用返回首次结果"
                        },
                        "message_id": {
                            "type": "string",
                            "description": "源 chat 消息 ID（可选）"
                        },
                        "markdown": {
                            "type": "string",
                            "description": "发送瞬间的 MD 快照（必填）"
                        },
                        "doc_id": {
                            "type": "string",
                            "description": "目标笔记文档 ID（必填）"
                        },
                        "parent_id": {
                            "type": "string",
                            "description": "父块 ID（可选）"
                        },
                        "after_block_id": {
                            "type": "string",
                            "description": "插入到该块之后（可选）"
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["apply_md_fragment", "insert_blocks", "append_to_block"],
                            "default": "apply_md_fragment",
                            "description": "写入模式"
                        },
                        "origin": {
                            "type": "string",
                            "enum": ["user", "agent"],
                            "default": "agent",
                            "description": "来源：user UI 或 agent 工具"
                        },
                        "batch_id": {
                            "type": "string",
                            "description": "会话 batch token（可选）"
                        }
                    },
                    "required": ["intent_id", "markdown", "doc_id"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for SendToNoteTool {
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
        let intent_id = require_string(&args, "intent_id")?;
        let doc_id = require_string(&args, "doc_id")?;
        let markdown = require_markdown(&args)?;
        let message_id = optional_string(&args, "message_id");
        let parent_id = optional_string(&args, "parent_id");
        let after_block_id = optional_string(&args, "after_block_id");
        let mode = parse_apply_mode(&args)?;
        let origin = optional_string(&args, "origin").unwrap_or_else(|| "agent".to_string());
        if origin != "user" && origin != "agent" {
            return Err(ToolError::invalid_input(
                "origin must be 'user' or 'agent'",
            ));
        }
        let batch_id = optional_string(&args, "batch_id");

        maybe_ask_note_write(ctx, self.name(), &args).await?;

        let Some(backend) = ctx.note_backend.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": NOTE_BACKEND_UNWIRED,
                "block_ids": [],
                "inserted": 0,
                "idempotent": false,
                "lossy": { "items": [] },
            }));
        };

        let req = NoteApplyMdRequest {
            doc_id,
            markdown,
            parent_id,
            after_block_id,
            mode,
            intent_id: Some(intent_id),
            batch_id,
            message_id,
            origin: Some(origin),
        };

        match backend.apply_md_fragment(req).await {
            Ok(result) => Ok(apply_result_json(&result)),
            Err(e @ NoteBackendError::Invalid(_))
            | Err(e @ NoteBackendError::BatchTokenInvalid(_))
            | Err(e @ NoteBackendError::BatchTokenExpired(_)) => {
                Err(backend_err_to_tool_err(self.name(), e))
            }
            Err(e) => Err(backend_err_to_tool_err(self.name(), e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use crate::note_backend::MemoryNoteBackend;
    use crate::tools::note_query_blocks::QueryBlocksTool;
    use std::sync::Arc;

    #[tokio::test]
    async fn send_to_note_unwired() {
        let tool = SendToNoteTool::new();
        assert!(tool.definition().dangerous);
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "intent_id": "i1",
                    "doc_id": "d",
                    "markdown": "x",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
    }

    #[tokio::test]
    async fn send_to_note_idempotent_no_double_insert() {
        let backend = Arc::new(MemoryNoteBackend::new());
        let ctx = ToolContext {
            note_backend: Some(backend),
            ..create_mock_tool_context()
        };
        let tool = SendToNoteTool::new();
        let args = serde_json::json!({
            "intent_id": "intent-dup",
            "doc_id": "doc-s",
            "markdown": "once only line",
            "origin": "agent",
        });
        let first = tool.execute(&ctx, args.clone()).await.unwrap();
        assert_eq!(first["ok"], true);
        assert_eq!(first["inserted"], 1);
        assert_eq!(first["idempotent"], false);

        let second = tool.execute(&ctx, args).await.unwrap();
        assert_eq!(second["ok"], true);
        assert_eq!(second["idempotent"], true);
        assert_eq!(second["inserted"], 0);
        assert_eq!(second["block_ids"], first["block_ids"]);

        // 查询确认只有一条
        let q = QueryBlocksTool::new();
        let qb = q
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-s",
                    "text_match": "once only",
                }),
            )
            .await
            .unwrap();
        assert_eq!(qb["blocks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn send_to_note_schema_requires_intent() {
        let tool = SendToNoteTool::new();
        let required = tool.definition().input_schema["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("intent_id")));
        assert!(required.iter().any(|v| v.as_str() == Some("doc_id")));
        assert!(required.iter().any(|v| v.as_str() == Some("markdown")));
    }
}
