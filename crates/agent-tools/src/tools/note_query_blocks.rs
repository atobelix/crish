//! 笔记域工具：`query_blocks`（W4-A 接线）
//!
//! # 契约
//! - Schema 对齐 `docs/block-workspace-architecture/plans/specs/query-blocks-tool-schema.md`
//!   与 `packages/block-paper-contract/src/query-blocks.ts` / store
//!   `conex-workspace-store::query_blocks::QueryBlocksParams`。
//! - **禁止**任意 SQL 字符串入参；全表扫不得作为默认路径。
//!
//! # 不变量（读 / 写路径纪律）
//! - **读 md**：即时 S(树)，**禁止**默认走 disk mirror 文件。
//! - **写路径**（本工具只读）：仅允许 `Transaction.apply`。
//!
//! # 执行面
//! - `ctx.note_backend` 已注入 → 调 [`crate::note_backend::NoteBackend::query_blocks`]
//! - 未注入 → 稳定占位 `{"ok":false,"reason":"note_backend_unwired"}`
//!
//! # 诚实边界
//! - **≠ EL-05**；Memory 测绿 **禁关**生产 A-AGT / EL-05

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{NoteBackendError, NoteQueryBlocksParams};
use crate::tools::{optional_string, optional_u64, require_string};
use async_trait::async_trait;
use serde_json::{Map, Value as JsonValue};

/// limit 默认值（与 TS `QUERY_BLOCKS_LIMIT_DEFAULT` / store 对齐）
const LIMIT_DEFAULT: u64 = 50;
/// limit 硬上限（与 TS `QUERY_BLOCKS_LIMIT_MAX` / store 对齐）
const LIMIT_MAX: u64 = 200;

/// 笔记后端未接线时的稳定 reason 字面量（契约面占位，勿随意改名）
pub const NOTE_BACKEND_UNWIRED: &str = "note_backend_unwired";

/// `query_blocks` 工具（dangerous=false，只读，进子 agent 只读集）
pub(crate) struct QueryBlocksTool {
    def: ToolDefinition,
}

impl QueryBlocksTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "query_blocks".to_string(),
                description: "在笔记文档内组合查询块（kind ∩ 属性等值 ∩ FTS 文本 ∩ refs）。\
入参禁止任意 SQL；结果为块摘要列表（id/kind/snippet/attrs），非全文。\
读路径走块树权威，不默认 mirror 文件。后端未接线时返回 ok=false 占位。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "目标文档 ID（必填）"
                        },
                        "kind_in": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "块 kind / flavour 白名单；缺省或空 = 不过滤 kind"
                        },
                        "attrs_eq": {
                            "type": "object",
                            "additionalProperties": true,
                            "description": "属性等值组合（白名单键，多键 AND）；实现须拒绝非法键"
                        },
                        "text_match": {
                            "type": "string",
                            "description": "FTS 子串 / 短语"
                        },
                        "ref_to": {
                            "type": "string",
                            "description": "引用目标 block_id（谁引用了该块）"
                        },
                        "ref_from": {
                            "type": "string",
                            "description": "引用源 block_id（该块引用了谁）"
                        },
                        "limit": {
                            "type": "integer",
                            "maximum": 200,
                            "default": 50,
                            "description": "结果上限，默认 50，硬上限 200"
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

fn parse_kind_in(args: &JsonValue) -> Result<Option<Vec<String>>, ToolError> {
    match args.get("kind_in") {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => {
            let arr = v
                .as_array()
                .ok_or_else(|| ToolError::invalid_input("kind_in must be an array of strings"))?;
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let s = item
                    .as_str()
                    .ok_or_else(|| ToolError::invalid_input("kind_in items must be strings"))?;
                out.push(s.to_string());
            }
            Ok(Some(out))
        }
    }
}

fn parse_attrs_eq(args: &JsonValue) -> Result<Option<Map<String, JsonValue>>, ToolError> {
    match args.get("attrs_eq") {
        None | Some(JsonValue::Null) => Ok(None),
        Some(v) => {
            let obj = v
                .as_object()
                .ok_or_else(|| ToolError::invalid_input("attrs_eq must be an object"))?;
            Ok(Some(obj.clone()))
        }
    }
}

#[async_trait]
impl Tool for QueryBlocksTool {
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
        let kind_in = parse_kind_in(&args)?;
        let attrs_eq = parse_attrs_eq(&args)?;
        let text_match = optional_string(&args, "text_match");
        let ref_to = optional_string(&args, "ref_to");
        let ref_from = optional_string(&args, "ref_from");
        let limit = optional_u64(&args, "limit")
            .unwrap_or(LIMIT_DEFAULT)
            .clamp(1, LIMIT_MAX);

        let Some(backend) = ctx.note_backend.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": NOTE_BACKEND_UNWIRED,
                "blocks": [],
                "truncated": false,
            }));
        };

        let params = NoteQueryBlocksParams {
            doc_id,
            kind_in,
            attrs_eq,
            text_match,
            ref_to,
            ref_from,
            limit: Some(limit as u32),
        };

        match backend.query_blocks(params).await {
            Ok(result) => Ok(serde_json::json!({
                "ok": true,
                "blocks": result.blocks,
                "truncated": result.truncated,
            })),
            Err(NoteBackendError::Invalid(m)) => Err(ToolError::invalid_input(m)),
            Err(e) => Ok(serde_json::json!({
                "ok": false,
                "reason": e.code(),
                "message": e.message(),
                "blocks": [],
                "truncated": false,
            })),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use crate::note_backend::MemoryNoteBackend;
    use std::sync::Arc;

    #[tokio::test]
    async fn query_blocks_stub_returns_unwired_placeholder() {
        let tool = QueryBlocksTool::new();
        assert_eq!(tool.name(), "query_blocks");
        assert!(!tool.definition().dangerous);
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(&ctx, serde_json::json!({ "doc_id": "doc-1" }))
            .await
            .expect("stub 不得 panic / Err");
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
        assert!(out["blocks"].as_array().unwrap().is_empty());
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn query_blocks_requires_doc_id() {
        let tool = QueryBlocksTool::new();
        let ctx = create_mock_tool_context();
        let err = tool.execute(&ctx, serde_json::json!({})).await.unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[tokio::test]
    async fn query_blocks_rejects_bad_kind_in() {
        let tool = QueryBlocksTool::new();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "doc_id": "d", "kind_in": "not-array" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[test]
    fn query_blocks_schema_requires_doc_id() {
        let tool = QueryBlocksTool::new();
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("doc_id")));
        assert_eq!(schema["properties"]["limit"]["maximum"], 200);
        assert_eq!(schema["properties"]["limit"]["default"], 50);
    }

    #[tokio::test]
    async fn query_blocks_with_memory_backend_hits() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-1",
            vec![
                ("b1".into(), "paragraph".into(), "alpha beta".into()),
                ("b2".into(), "paragraph".into(), "gamma".into()),
            ],
        );
        let tool = QueryBlocksTool::new();
        let ctx = ToolContext {
            note_backend: Some(backend),
            ..create_mock_tool_context()
        };
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-1",
                    "text_match": "alpha",
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        let blocks = out["blocks"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["id"], "b1");
        assert_eq!(out["truncated"], false);
    }
}
