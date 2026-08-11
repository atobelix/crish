//! 笔记域工具：`query_blocks`（W4-A 最小骨架）
//!
//! # 契约
//! - Schema 对齐 `docs/block-workspace-architecture/plans/specs/query-blocks-tool-schema.md`
//!   与 `packages/block-paper-contract/src/query-blocks.ts` / store
//!   `conex-workspace-store::query_blocks::QueryBlocksParams`。
//! - **禁止**任意 SQL 字符串入参；全表扫不得作为默认路径。
//!
//! # 不变量（读 / 写路径纪律，W4 接线须守）
//! - **读 md**：即时 S(树)，**禁止**默认走 disk mirror 文件。
//! - **写路径**（本工具只读，未来写类工具）：仅允许 `Transaction.apply`，
//!   禁止 `fs.write` 后当权威。
//!
//! # 执行面（本波）
//! DocSession / WorkspaceStore 尚未注入 ToolContext——execute 校验入参后
//! 返回稳定占位 JSON `{"ok":false,"reason":"note_backend_unwired"}`，
//! 不 panic、不假命中。真实查询留待后续接线 store.query_blocks。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{optional_string, optional_u64, require_string};
use async_trait::async_trait;

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
读路径走块树权威，不默认 mirror 文件。当前后端未接线时返回 ok=false 占位。"
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
        _ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        // 入参形状校验（与 schema / store 对齐）；真实查询未接线前仍 fail-fast 非法入参
        let doc_id = require_string(&args, "doc_id")?;
        // kind_in：可选字符串数组（非法类型 → invalid_input）
        if let Some(v) = args.get("kind_in") {
            if !v.is_null() {
                let arr = v.as_array().ok_or_else(|| {
                    ToolError::invalid_input("kind_in must be an array of strings")
                })?;
                for item in arr {
                    if !item.is_string() {
                        return Err(ToolError::invalid_input(
                            "kind_in items must be strings",
                        ));
                    }
                }
            }
        }
        // attrs_eq：可选 object
        if let Some(v) = args.get("attrs_eq") {
            if !v.is_null() && !v.is_object() {
                return Err(ToolError::invalid_input(
                    "attrs_eq must be an object",
                ));
            }
        }
        let _text_match = optional_string(&args, "text_match");
        let _ref_to = optional_string(&args, "ref_to");
        let _ref_from = optional_string(&args, "ref_from");
        let _limit = optional_u64(&args, "limit")
            .unwrap_or(LIMIT_DEFAULT)
            .min(LIMIT_MAX)
            .max(1);

        // W4-A 最小：DocSession / WorkspaceStore 未注入 → 稳定占位，不 panic
        // 将来接线：ctx.note_backend.query_blocks(...) → { blocks, truncated }
        let _ = doc_id;
        Ok(serde_json::json!({
            "ok": false,
            "reason": NOTE_BACKEND_UNWIRED,
            "blocks": [],
            "truncated": false,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;

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
        let err = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .unwrap_err();
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
}
