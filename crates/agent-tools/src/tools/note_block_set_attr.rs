//! 笔记写工具：`block_set_attr`（W4-R 细粒度独立工具）
//!
//! # 契约
//! - 入参：`doc_id` + `id` + `attrs`（对象或 JSON 对象字符串）；可选 `batch_id`
//! - 经 [`NoteBackend::block_set_attr`]（默认委托 `apply_block_ops` 单 `SetAttr`）
//! - `dangerous=true`；plan **Deny**
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 全表关闭**；**≠ W6-E**
//! - Memory 禁关生产 A-AGT；Store 真路径见 `conex-note-runtime`
//! - **不**整包重做 `block_insert` / `block_update` / `block_delete` / `block_move`
//! - **不**重做 SD-14 `note_plan_ops` kind 切开

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{backend_err_to_tool_err, NoteBackendError, NoteBlockSetAttrRequest};
use crate::tools::note_document_apply_md::maybe_ask_note_write;
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use crate::tools::{optional_string, require_string};
use async_trait::async_trait;
use serde_json::{Map, Value as JsonValue};

/// `block_set_attr`（dangerous=true）
pub(crate) struct BlockSetAttrTool {
    def: ToolDefinition,
}

impl BlockSetAttrTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "block_set_attr".to_string(),
                description: "设置笔记文档中单个块的属性（细粒度 mutate）。\
入参 doc_id + id + attrs（对象或 JSON）；可选 batch_id。\
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
                        "attrs": {
                            "oneOf": [
                                { "type": "object" },
                                { "type": "string" }
                            ],
                            "description": "块属性（对象或 JSON 对象字符串；必填）"
                        },
                        "batch_id": {
                            "type": "string",
                            "description": "会话 batch token（可选）"
                        }
                    },
                    "required": ["doc_id", "id", "attrs"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

/// attrs：对象，或可解析为对象的 JSON 字符串
fn require_attrs(args: &JsonValue) -> Result<Map<String, JsonValue>, ToolError> {
    let value = args
        .get("attrs")
        .ok_or_else(|| ToolError::invalid_input("attrs must be an object or JSON object string"))?;
    match value {
        JsonValue::Object(map) => Ok(map.clone()),
        JsonValue::String(s) => {
            let parsed: JsonValue = serde_json::from_str(s).map_err(|_| {
                ToolError::invalid_input("attrs JSON string must parse to an object")
            })?;
            parsed.as_object().cloned().ok_or_else(|| {
                ToolError::invalid_input("attrs JSON string must parse to an object")
            })
        }
        _ => Err(ToolError::invalid_input(
            "attrs must be an object or JSON object string",
        )),
    }
}

#[async_trait]
impl Tool for BlockSetAttrTool {
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
        let attrs = require_attrs(&args)?;
        let batch_id = optional_string(&args, "batch_id");

        if ctx.abort_token.is_aborted() {
            return Err(ToolError::new(
                "note.execution_unknown",
                "write interrupted (abort) before block_set_attr; execution state unknown — do not auto-retry write",
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

        let req = NoteBlockSetAttrRequest {
            doc_id,
            id,
            attrs,
            batch_id,
            origin: Some("agent".into()),
        };

        match backend.block_set_attr(req).await {
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
    fn block_set_attr_schema_shape() {
        let tool = BlockSetAttrTool::new();
        assert_eq!(tool.name(), "block_set_attr");
        assert!(tool.definition().dangerous);
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        for key in ["doc_id", "id", "attrs"] {
            assert!(
                required.iter().any(|v| v.as_str() == Some(key)),
                "missing required {key}"
            );
        }
        let props = schema["properties"].as_object().unwrap();
        for key in ["doc_id", "id", "attrs", "batch_id"] {
            assert!(props.contains_key(key), "missing {key}");
        }
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn block_set_attr_unwired() {
        let tool = BlockSetAttrTool::new();
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "d",
                    "id": "b1",
                    "attrs": { "checked": true }
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
    }

    #[tokio::test]
    async fn block_set_attr_writes_attrs() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-sa",
            vec![("b1".into(), "paragraph".into(), "body".into())],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockSetAttrTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-sa",
                    "id": "b1",
                    "attrs": { "checked": true, "level": 2 },
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["id"], "b1");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-sa".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
        assert_eq!(q.blocks[0].attrs["checked"], true);
        assert_eq!(q.blocks[0].attrs["level"], 2);
    }

    #[tokio::test]
    async fn block_set_attr_accepts_json_string_attrs() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-js",
            vec![("b1".into(), "paragraph".into(), "body".into())],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockSetAttrTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-js",
                    "id": "b1",
                    "attrs": "{\"lang\":\"zh\"}",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-js".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks[0].attrs["lang"], "zh");
    }

    #[tokio::test]
    async fn block_set_attr_empty_id_fails() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-eid",
            vec![("b1".into(), "paragraph".into(), "stay".into())],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockSetAttrTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-eid",
                    "id": "",
                    "attrs": { "x": 1 },
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-eid".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(q.blocks[0].attrs.is_empty(), "空 id 不得改属性");
    }

    /// abort → note.execution_unknown，零写
    #[tokio::test]
    async fn block_set_attr_abort_execution_unknown() {
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
        let tool = BlockSetAttrTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-ab",
                    "id": "b1",
                    "attrs": { "x": 1 },
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "note.execution_unknown");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-ab".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(q.blocks[0].attrs.is_empty());
    }

    #[test]
    fn block_set_attr_plan_denied() {
        assert!(plan_denies_note_tool("block_set_attr"));
        assert_eq!(
            decide_note_tool("block_set_attr", PermissionMode::Plan),
            Some(PermissionVerdict::Deny)
        );
    }

    #[derive(Debug)]
    struct DenyAskChannel {
        reason: String,
    }

    #[async_trait]
    impl crate::context::AskChannel for DenyAskChannel {
        async fn ask(
            &self,
            _tool_name: &str,
            _args: &serde_json::Value,
        ) -> Result<crate::context::AskDecision, ToolError> {
            Ok(crate::context::AskDecision::Denied {
                reason: self.reason.clone(),
            })
        }
    }

    /// ask 拒绝 → `tool.user_denied`，与其它写工具一致
    #[tokio::test]
    async fn block_set_attr_ask_denied_returns_user_denied() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-deny",
            vec![("b1".into(), "paragraph".into(), "stay".into())],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ask: Some(std::sync::Arc::new(DenyAskChannel {
                reason: "no note write".into(),
            })),
            ..create_mock_tool_context()
        };
        let tool = BlockSetAttrTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-deny",
                    "id": "b1",
                    "attrs": { "x": 1 },
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.user_denied");
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-deny".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(q.blocks[0].attrs.is_empty());
    }
}
