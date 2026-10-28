//! 笔记写工具：`block_batch`（W4-F Strict 子集 · A-AGT-05 形状）
//!
//! # 契约
//! - 入参：`doc_id` + `ops[]` + **`dryRun`/`dry_run`** 布尔 + 可选 `batch_id`
//! - `dryRun=true`：**零写**权威树；返回将应用的 ops preview
//! - 实写：经 [`NoteBackend::apply_block_ops`] 批路径；origin=agent
//! - 写中断 / abort：稳定码 **`note.execution_unknown`**（A-AGT-07）；**禁止**半写
//!
//! # 权限
//! - `dangerous=true`；由内核调度层统一裁决判定。
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 全表关闭**；**≠ W6-E Strict** 千次+恶意闭环
//! - 千次批压测夹具 / 恶意扩展拒写方向见 **W6-E-S**（`note_stress_guard`；Skeleton ≠ Strict）
//! - Memory 测绿 **禁关**生产 A-AGT
//! - `block_update`/`block_delete`/`block_move` 已有独立工具；batch 仍可含 move op

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::note_backend::{
    backend_err_to_tool_err, block_batch_result_json, NoteBackendError, NoteBlockBatchRequest,
    NoteBlockOp, NoteBlockOpKind,
};
use crate::tools::note_query_blocks::NOTE_BACKEND_UNWIRED;
use crate::tools::{optional_string, require_string};
use async_trait::async_trait;
use serde_json::Value as JsonValue;

/// `block_batch`（dangerous=true）
pub(crate) struct BlockBatchTool {
    def: ToolDefinition,
}

impl BlockBatchTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "block_batch".to_string(),
                description: "批处理笔记块 ops（insert/update/delete/move/set_attr）。\
入参 doc_id + ops[]；dryRun/dry_run=true 时仅预览、零写权威树。\
可选 batch_id（会话 batch token）。写中断返回 note.execution_unknown，禁止半写与盲目重试。\
后端未接线时 ok=false / note_backend_unwired。≠ EL-05 / ≠ W6-E。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "doc_id": {
                            "type": "string",
                            "description": "目标文档 ID（必填）"
                        },
                        "ops": {
                            "type": "array",
                            "description": "块 op 列表（批内应按实现原子语义）",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "op": {
                                        "type": "string",
                                        "enum": ["insert", "update", "delete", "move", "set_attr"],
                                        "description": "操作种类"
                                    },
                                    "id": {
                                        "type": "string",
                                        "description": "块 ID（update/delete/move/set_attr 必填）"
                                    },
                                    "parent_id": {
                                        "type": "string",
                                        "description": "父块 ID（insert 可选）"
                                    },
                                    "previous_id": {
                                        "type": "string",
                                        "description": "前序兄弟锚点（insert/move 可选）"
                                    },
                                    "content": {
                                        "type": "string",
                                        "description": "文本内容（insert/update）"
                                    },
                                    "kind": {
                                        "type": "string",
                                        "description": "块 kind（insert 默认 paragraph）"
                                    },
                                    "attrs": {
                                        "type": "object",
                                        "description": "属性（insert 初始属性 / set_attr 增量属性可选；update 不接受 attrs）"
                                    }
                                },
                                "required": ["op"],
                                "additionalProperties": false
                            }
                        },
                        "dryRun": {
                            "type": "boolean",
                            "default": false,
                            "description": "true=仅预览、不写权威树（A-AGT-05）"
                        },
                        "dry_run": {
                            "type": "boolean",
                            "default": false,
                            "description": "dryRun 的 snake_case 别名"
                        },
                        "batch_id": {
                            "type": "string",
                            "description": "会话 batch token（可选；提供则须已占用且未过期）"
                        }
                    },
                    "required": ["doc_id", "ops"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

/// 解析 dryRun / dry_run（优先 dryRun，与 D6 草案对齐）
pub(crate) fn parse_dry_run(args: &JsonValue) -> bool {
    if let Some(v) = args.get("dryRun").and_then(|x| x.as_bool()) {
        return v;
    }
    args.get("dry_run")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
}

/// 解析 ops 数组
pub(crate) fn parse_block_ops(args: &JsonValue) -> Result<Vec<NoteBlockOp>, ToolError> {
    let arr = args
        .get("ops")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ToolError::invalid_input("ops must be an array"))?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let op_s = item
            .get("op")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::invalid_input(format!("ops[{i}].op must be a string")))?;
        let op = NoteBlockOpKind::parse(op_s).map_err(|e| ToolError::invalid_input(e.message()))?;
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let parent_id = item
            .get("parent_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let previous_id = item
            .get("previous_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let content = item
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let kind = item
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let attrs = item.get("attrs").and_then(|v| v.as_object()).cloned();
        out.push(NoteBlockOp {
            op,
            id,
            parent_id,
            previous_id,
            content,
            kind,
            attrs,
        });
    }
    Ok(out)
}

#[async_trait]
impl Tool for BlockBatchTool {
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
        let ops = parse_block_ops(&args)?;
        let dry_run = parse_dry_run(&args);
        let batch_id = optional_string(&args, "batch_id");

        // 写中断（abort）：在审批/写之前识别 → execution_unknown，零半写
        if ctx.abort_token.is_aborted() && !dry_run {
            return Err(ToolError::new(
                "note.execution_unknown",
                "write interrupted (abort) before block_batch; execution state unknown — do not auto-retry write",
            ));
        }

        let Some(backend) = ctx.note_backend.as_ref() else {
            return Ok(serde_json::json!({
                "ok": false,
                "reason": NOTE_BACKEND_UNWIRED,
                "dry_run": dry_run,
                "dryRun": dry_run,
                "applied": 0,
                "block_ids": [],
                "preview": [],
            }));
        };

        let req = NoteBlockBatchRequest {
            doc_id,
            ops,
            dry_run,
            batch_id,
            origin: Some("agent".into()),
            force_execution_unknown: false,
        };

        match backend.apply_block_ops(req).await {
            Ok(result) => Ok(block_batch_result_json(&result)),
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
    fn block_batch_schema_shape() {
        let tool = BlockBatchTool::new();
        assert_eq!(tool.name(), "block_batch");
        assert!(tool.definition().dangerous);
        let schema = &tool.definition().input_schema;
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v.as_str() == Some("doc_id")));
        assert!(required.iter().any(|v| v.as_str() == Some("ops")));
        let props = schema["properties"].as_object().unwrap();
        assert!(props.contains_key("dryRun"), "schema must expose dryRun");
        assert!(props.contains_key("ops"));
        assert_eq!(schema["additionalProperties"], false);
    }

    #[tokio::test]
    async fn block_batch_unwired() {
        let tool = BlockBatchTool::new();
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "d",
                    "ops": [{ "op": "insert", "content": "x" }],
                    "dryRun": true,
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], false);
        assert_eq!(out["reason"], NOTE_BACKEND_UNWIRED);
    }

    /// A-AGT-05：dryRun=true 零写 + preview
    #[tokio::test]
    async fn block_batch_dry_run_zero_write_with_preview() {
        let backend = Arc::new(MemoryNoteBackend::new());
        backend.seed_doc(
            "doc-dr",
            vec![("p1".into(), "paragraph".into(), "stay".into())],
        );
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockBatchTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-dr",
                    "ops": [{
                        "op": "insert",
                        "content": "preview only",
                        "previous_id": "p1"
                    }],
                    "dryRun": true,
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["dryRun"], true);
        assert_eq!(out["dry_run"], true);
        assert_eq!(out["applied"], 1);
        assert!(!out["preview"].as_array().unwrap().is_empty());
        // 零写
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-dr".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
    }

    /// 实写 insert
    #[tokio::test]
    async fn block_batch_apply_inserts() {
        let backend = Arc::new(MemoryNoteBackend::new());
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            ..create_mock_tool_context()
        };
        let tool = BlockBatchTool::new();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-ap",
                    "ops": [{ "op": "insert", "content": "batch body", "kind": "paragraph" }],
                    "dry_run": false,
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["dryRun"], false);
        assert_eq!(out["applied"], 1);
        let q = backend
            .query_blocks(crate::note_backend::NoteQueryBlocksParams {
                doc_id: "doc-ap".into(),
                text_match: Some("batch body".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(q.blocks.len(), 1);
    }

    /// A-AGT-07：abort → note.execution_unknown，零写
    #[tokio::test]
    async fn block_batch_abort_execution_unknown_no_write() {
        let backend = Arc::new(MemoryNoteBackend::new());
        let abort = AbortToken::new();
        abort.abort();
        let ctx = ToolContext {
            note_backend: Some(backend.clone()),
            abort_token: abort,
            ..create_mock_tool_context()
        };
        let tool = BlockBatchTool::new();
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "doc_id": "doc-ab",
                    "ops": [{ "op": "insert", "content": "nope" }],
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
        assert!(q.blocks.is_empty(), "abort 不得半写");
    }

    #[test]
    fn parse_dry_run_accepts_camel_and_snake() {
        assert!(parse_dry_run(&serde_json::json!({ "dryRun": true })));
        assert!(parse_dry_run(&serde_json::json!({ "dry_run": true })));
        assert!(!parse_dry_run(&serde_json::json!({})));
        assert!(!parse_dry_run(&serde_json::json!({ "dryRun": false })));
    }
}
