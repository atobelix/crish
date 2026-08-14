//! 笔记域工具：`document_get_md`（Round7：即时 S(树) 读全文）
//!
//! # 契约
//! - 对齐 `packages/block-paper-contract/src/document-get-md.ts`
//! - Agent 读 = **即时 S(树)**，禁止默认读陈旧 exports / mirror
//! - 出参 `md` = 当前权威块树的 Conex-MD 序列化（含 `<!--c:…-->` 时）
//!
//! # 执行面
//! - `ctx.note_backend` 已注入 → [`NoteBackend::get_md`]
//! - 未注入 → `{"ok":false,"reason":"note_backend_unwired","md":""}`
//!
//! # 诚实边界
//! - **≠ EL-05**；Memory 测绿 **禁关**生产 A-AGT / EL-05

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::NoteBackendError;
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use crate::tools::require_string;
use async_trait::async_trait;

/// `document_get_md` 工具（dangerous=false，只读，进子 agent 只读集）
pub(crate) struct DocumentGetMdTool {
    def: ToolDefinition,
}

impl DocumentGetMdTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "document_get_md".to_string(),
                description: "获取笔记文档的即时 Conex-MD 全文（get_md = 即时 S(树)）。\
返回当前权威块树序列化（含 <!--c:UUID--> 块 ID 注释）；\
禁止读陈旧 mirror/export 文件。后端未接线时返回 ok=false 占位。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "目标文档 ID（必填）"
                        }
                    },
                    "required": ["doc_id"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for DocumentGetMdTool {
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

        let Some(backend) = ctx.note_backend.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": NOTE_BACKEND_UNWIRED,
                "md": "",
            }));
        };

        match backend.get_md(&doc_id).await {
            Ok(md) => Ok(serde_json::json!({
                "ok": true,
                "md": md,
            })),
            Err(NoteBackendError::Invalid(m)) => Err(ToolError::invalid_input(m)),
            Err(e) => Ok(serde_json::json!({
                "ok": false,
                "reason": e.code(),
                "message": e.message(),
                "md": "",
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use crate::note_backend::{MemoryNoteBackend, NoteApplyMdRequest, NoteApplyMode, NoteBackend};
    use std::sync::Arc;

    #[tokio::test]
    async fn document_get_md_stub_returns_unwired_placeholder() {
        let tool = DocumentGetMdTool::new();
        assert_eq!(tool.name(), "document_get_md");
        assert!(!tool.definition().dangerous);
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(&ctx, serde_json::json!({ "doc_id": "doc-1" }))
            .await
            .expect("stub 不得 panic / Err");
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
        assert_eq!(out["md"], "");
    }

    #[tokio::test]
    async fn document_get_md_requires_doc_id() {
        let tool = DocumentGetMdTool::new();
        let ctx = create_mock_tool_context();
        let err = tool.execute(&ctx, serde_json::json!({})).await.unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[test]
    fn document_get_md_schema_requires_doc_id() {
        let tool = DocumentGetMdTool::new();
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("doc_id")));
    }

    #[tokio::test]
    async fn document_get_md_with_memory_backend_after_apply() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend
            .apply_md_fragment(NoteApplyMdRequest {
                doc_id: "doc-1".into(),
                markdown: "# Title\n\nhello get_md body".into(),
                parent_id: None,
                after_block_id: None,
                mode: NoteApplyMode::ApplyMdFragment,
                intent_id: None,
                batch_id: None,
                message_id: None,
                origin: Some("agent".into()),
            })
            .await
            .unwrap();

        let tool = DocumentGetMdTool::new();
        let ctx = ToolContext {
            note_backend: Some(backend),
            ..create_mock_tool_context()
        };
        let out = tool
            .execute(&ctx, serde_json::json!({ "doc_id": "doc-1" }))
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let md = out["md"].as_str().unwrap();
        assert!(
            md.contains("Title") || md.contains("hello get_md"),
            "md must contain applied content: {md:?}"
        );
        assert!(
            md.contains("<!--c:"),
            "md should include block id comments: {md:?}"
        );
    }
}
