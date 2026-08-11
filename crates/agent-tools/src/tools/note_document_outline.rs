//! 笔记域工具：`document_outline`（W4-A 最小骨架）
//!
//! # 契约
//! - 逻辑工具对应扩展面 `outline.get`（见 round-D `06-扩展宿主与Agent工具面.md` §6.1）：
//!   返回文档标题树 / 大纲，不回传块全文。
//! - 工具名选用 verb 拆分 `document_outline`（与 `query_blocks` 并列注册；
//!   避免与 MCP 前缀冲突）。
//!
//! # 不变量（读 / 写路径纪律，W4 接线须守）
//! - **读 md / 大纲**：即时 S(树) 投影，**禁止**默认走 disk mirror 文件。
//! - **写路径**（本工具只读；未来 `document_*` 写类）：仅允许
//!   `Transaction.apply` / 事务化 `apply_md`，禁止 `fs.write` 后当权威。
//!
//! # 执行面（本波）
//! DocSession 未注入——校验 `doc_id` 后返回稳定占位
//! `{"ok":false,"reason":"note_backend_unwired"}`，不 panic。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{optional_u64, require_string};
use async_trait::async_trait;

/// 笔记后端未接线时的稳定 reason（与 query_blocks 共用字面量，便于契约断言）
pub use super::note_query_blocks::NOTE_BACKEND_UNWIRED;

/// `document_outline` 工具（dangerous=false，只读，进子 agent 只读集）
pub(crate) struct DocumentOutlineTool {
    def: ToolDefinition,
}

impl DocumentOutlineTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "document_outline".to_string(),
                description: "获取笔记文档的标题大纲树（heading 层级结构）。\
返回 outline 节点列表（id/level/title/children），不回传块全文。\
读路径走块树权威，不默认 mirror 文件。当前后端未接线时返回 ok=false 占位。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "目标文档 ID（必填）"
                        },
                        "max_depth": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 16,
                            "default": 6,
                            "description": "大纲最大展开深度（heading level 上限），默认 6"
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
impl Tool for DocumentOutlineTool {
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
        let doc_id = require_string(&args, "doc_id")?;
        let _max_depth = optional_u64(&args, "max_depth")
            .unwrap_or(6)
            .clamp(1, 16);

        // W4-A 最小：DocSession 未注入 → 稳定占位
        // 将来接线：ctx.note_backend.document_outline(doc_id, max_depth)
        //   → { outline: [...], truncated: bool }
        let _ = doc_id;
        Ok(serde_json::json!({
            "ok": false,
            "reason": NOTE_BACKEND_UNWIRED,
            "outline": [],
            "truncated": false,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;

    #[tokio::test]
    async fn document_outline_stub_returns_unwired_placeholder() {
        let tool = DocumentOutlineTool::new();
        assert_eq!(tool.name(), "document_outline");
        assert!(!tool.definition().dangerous);
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(&ctx, serde_json::json!({ "doc_id": "doc-1" }))
            .await
            .expect("stub 不得 panic / Err");
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
        assert!(out["outline"].as_array().unwrap().is_empty());
        assert_eq!(out["truncated"], false);
    }

    #[tokio::test]
    async fn document_outline_requires_doc_id() {
        let tool = DocumentOutlineTool::new();
        let ctx = create_mock_tool_context();
        let err = tool
            .execute(&ctx, serde_json::json!({ "max_depth": 3 }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[test]
    fn document_outline_schema_requires_doc_id() {
        let tool = DocumentOutlineTool::new();
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("doc_id")));
    }
}
