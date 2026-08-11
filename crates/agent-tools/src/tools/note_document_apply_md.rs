//! 笔记写工具：`document_apply_md`（W4-A/B）
//!
//! # 契约
//! - 事务化 `apply_md` / replace_via_tx 语义；**禁止** `fs.write` 后当权威。
//! - 别名语义：`document_write_md` ≡ 本工具（注册名固定为 `document_apply_md`）。
//! - 入参：doc_id, markdown, parent_id?, after_block_id?, mode?, batch_id?
//! - **出参**（W4-A）：`ok / block_ids / inserted / idempotent / lossy.items[]`
//!   —— Store 路径透出 `ApplyReport.lossy`；Memory 可为空 items。
//!
//! # 审批
//! dangerous=true；若 `ctx.ask` 存在则走审批；无 ask 时按 write_file 惯例直接执行
//! （权限层在 execute 前已判定）。
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 满表**（本工具可调 ≠ 批/矩阵/execution_unknown 关闭）
//! - Memory 测绿 **禁止**关生产 A-AGT

use crate::context::{AskDecision, ToolContext};
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{
    apply_result_json, backend_err_to_tool_err, NoteApplyMdRequest, NoteApplyMode,
    NoteBackendError,
};
use crate::tools::{optional_string, require_string};
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use async_trait::async_trait;
use serde_json::Value as JsonValue;

/// `document_apply_md`（dangerous=true，写工具，不进只读集）
pub(crate) struct DocumentApplyMdTool {
    def: ToolDefinition,
}

impl DocumentApplyMdTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "document_apply_md".to_string(),
                description: "向笔记文档事务化写入 Markdown 片段（apply_md_fragment）。\
等价 document_write_md：禁止 fs.write 当权威，仅经块树 Transaction.apply。\
入参 doc_id + markdown；可选 parent_id / after_block_id / mode / batch_id（幂等 batch）。\
成功出参含 block_ids / inserted / idempotent / lossy.items（有损码如 missing_block_id，Agent 可审计）。\
后端未接线时返回 ok=false / note_backend_unwired。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "目标文档 ID（必填）"
                        },
                        "markdown": {
                            "type": "string",
                            "description": "要写入的 Markdown 片段（必填；可为空串 = 无块插入）"
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
                        "batch_id": {
                            "type": "string",
                            "description": "会话 batch token（可选；提供则须已占用且未过期）"
                        },
                        "intent_id": {
                            "type": "string",
                            "description": "幂等键（可选；重复调用返回首次结果）"
                        }
                    },
                    "required": ["doc_id", "markdown"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

/// 写工具审批：ask 存在则询问；Denied → user_denied；无 ask → 放行（write_file 惯例）
pub(crate) async fn maybe_ask_note_write(
    ctx: &ToolContext,
    tool_name: &str,
    args: &JsonValue,
) -> Result<(), ToolError> {
    if let Some(ask) = &ctx.ask {
        match ask.ask(tool_name, args).await? {
            AskDecision::Allowed => Ok(()),
            AskDecision::Denied { reason } => Err(ToolError::new(
                "tool.user_denied",
                format!("user denied: {reason}"),
            )),
        }
    } else {
        Ok(())
    }
}

pub(crate) fn parse_apply_mode(args: &JsonValue) -> Result<NoteApplyMode, ToolError> {
    match optional_string(args, "mode") {
        None => Ok(NoteApplyMode::default()),
        Some(s) => NoteApplyMode::parse(&s).map_err(|e| ToolError::invalid_input(e.message())),
    }
}

/// markdown 允许空串（与 require_string 非空不同）
pub(crate) fn require_markdown(args: &JsonValue) -> Result<String, ToolError> {
    let value = args.get("markdown").ok_or_else(|| {
        ToolError::invalid_input("markdown must be a string")
    })?;
    let s = value.as_str().ok_or_else(|| {
        ToolError::invalid_input("markdown must be a string")
    })?;
    if s.chars().any(|c| {
        matches!(
            c,
            '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'
        )
    }) {
        return Err(ToolError::invalid_input(
            "markdown contains invalid control characters",
        ));
    }
    Ok(s.to_string())
}

#[async_trait]
impl Tool for DocumentApplyMdTool {
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
        let markdown = require_markdown(&args)?;
        let parent_id = optional_string(&args, "parent_id");
        let after_block_id = optional_string(&args, "after_block_id");
        let mode = parse_apply_mode(&args)?;
        let batch_id = optional_string(&args, "batch_id");
        let intent_id = optional_string(&args, "intent_id");

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
            intent_id,
            batch_id,
            message_id: None,
            origin: Some("agent".into()),
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
    use crate::tools::note_document_outline::DocumentOutlineTool;
    use crate::tools::note_query_blocks::QueryBlocksTool;
    use std::sync::Arc;

    #[tokio::test]
    async fn document_apply_md_unwired() {
        let tool = DocumentApplyMdTool::new();
        assert!(tool.definition().dangerous);
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "d", "markdown": "hi" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
    }

    #[tokio::test]
    async fn document_apply_md_then_outline_changes() {
        let backend = Arc::new(MemoryNoteBackend::new());
        let ctx = ToolContext {
            note_backend: Some(backend),
            ..create_mock_tool_context()
        };
        let write = DocumentApplyMdTool::new();
        let out = write
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-a",
                    "markdown": "# Hello\nworld",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["inserted"], 2);

        let outline = DocumentOutlineTool::new();
        let o = outline
            .execute(&ctx, serde_json::json!({ "doc_id": "doc-a" }))
            .await
            .unwrap();
        assert_eq!(o["ok"], true);
        assert!(!o["outline"].as_array().unwrap().is_empty());

        let q = QueryBlocksTool::new();
        let qb = q
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "doc-a", "text_match": "world" }),
            )
            .await
            .unwrap();
        assert_eq!(qb["ok"], true);
        assert_eq!(qb["blocks"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn document_apply_md_batch_token_required_when_set() {
        let backend = Arc::new(MemoryNoteBackend::new());
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = DocumentApplyMdTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "d",
                    "markdown": "x",
                    "batch_id": "nope",
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");

        backend.batch_tokens().acquire("tok-1").unwrap();
        let ok = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "d",
                    "markdown": "ok line",
                    "batch_id": "tok-1",
                }),
            )
            .await
            .unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["inserted"], 1);
    }

    #[test]
    fn document_apply_md_schema_shape() {
        let tool = DocumentApplyMdTool::new();
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("doc_id")));
        assert!(required.iter().any(|v| v.as_str() == Some("markdown")));
        // 属性键契约（query 向并列：apply 入参白名单）
        let props = schema["properties"].as_object().unwrap();
        for key in [
            "doc_id",
            "markdown",
            "parent_id",
            "after_block_id",
            "mode",
            "batch_id",
            "intent_id",
        ] {
            assert!(props.contains_key(key), "schema missing property {key}");
        }
        assert_eq!(schema["additionalProperties"], false);
        assert!(tool.definition().dangerous, "apply_md must be dangerous");
    }

    /// W4-A：工具成功路径 result 含 `lossy` 键（Memory 为空 items 亦必须出现）。
    /// **≠ EL-05**；仅证调用契约形状。
    #[tokio::test]
    async fn document_apply_md_result_includes_lossy_field() {
        let backend = Arc::new(MemoryNoteBackend::new());
        let ctx = ToolContext {
            note_backend: Some(backend),
            ..create_mock_tool_context()
        };
        let tool = DocumentApplyMdTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-lossy",
                    "markdown": "plain line without block id comment",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert!(out.get("lossy").is_some(), "lossy must be on tool result");
        assert!(
            out["lossy"]["items"].as_array().is_some(),
            "lossy.items must be array"
        );
        // Memory 伪路径不产生真 lossy；真码可观测见 StoreNoteBackend 测
        assert!(out["lossy"]["items"].as_array().unwrap().is_empty());
    }

    /// W4-A：unwired 占位亦带 lossy 形状（调用方解析稳定）。
    #[tokio::test]
    async fn document_apply_md_unwired_includes_lossy_shape() {
        let tool = DocumentApplyMdTool::new();
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "d", "markdown": "hi" }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert!(out["lossy"]["items"].as_array().unwrap().is_empty());
    }
}
