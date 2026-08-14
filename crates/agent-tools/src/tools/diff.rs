//! 文本 diff 工具（任务书 B5.2：diff_text）
//!
//! 复用 conex-diff 的 DiffEngine（行级 unified diff + hunk 结构），
//! 支持两种输入模式：两文件路径（pathA/pathB）或两段内容（contentA/contentB），
//! 输出 unified diff 文本与结构化 hunk 数据。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{display_path, optional_string, require_string, resolve_workspace_path};
use async_trait::async_trait;
use conex_diff::diff_engine::DiffEngine;
use conex_types::{DiffLineKind, DiffResult};

/// 文本 diff 工具
pub(crate) struct DiffTextTool {
    def: ToolDefinition,
}

impl DiffTextTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "diff_text".to_string(),
                description: "对比两份文本（文件路径或内容），输出 unified diff。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "pathA": { "type": "string", "description": "旧文件路径（与 contentA 二选一，需成对出现）" },
                        "pathB": { "type": "string", "description": "新文件路径（与 contentB 二选一，需成对出现）" },
                        "contentA": { "type": "string", "description": "旧文本内容" },
                        "contentB": { "type": "string", "description": "新文本内容" }
                    },
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for DiffTextTool {
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
        let path_a = optional_string(&args, "pathA");
        let path_b = optional_string(&args, "pathB");
        let has_path_mode = path_a.is_some() || path_b.is_some();
        let has_content_mode = args.get("contentA").is_some() || args.get("contentB").is_some();
        if has_path_mode && has_content_mode {
            return Err(ToolError::invalid_input(
                "pathA/pathB 与 contentA/contentB 只能选一种模式",
            ));
        }

        let (old_text, new_text, label_a, label_b, mode) = if has_path_mode {
            let a = path_a.ok_or_else(|| {
                ToolError::invalid_input("pathA and pathB must be provided together")
            })?;
            let b = path_b.ok_or_else(|| {
                ToolError::invalid_input("pathA and pathB must be provided together")
            })?;
            let pa = resolve_workspace_path(&ctx.workspace_root, &a)?;
            let pb = resolve_workspace_path(&ctx.workspace_root, &b)?;
            let old_text = read_file_text(&pa)?;
            let new_text = read_file_text(&pb)?;
            let label_a = display_path(&ctx.workspace_root, &pa);
            let label_b = display_path(&ctx.workspace_root, &pb);
            (old_text, new_text, label_a, label_b, "files")
        } else {
            let a = require_string(&args, "contentA")?;
            let b = require_string(&args, "contentB")?;
            (
                a,
                b,
                "contentA".to_string(),
                "contentB".to_string(),
                "contents",
            )
        };

        let result = DiffEngine::diff(&old_text, &new_text);
        let diff_text = render_unified(&label_a, &label_b, &result);
        let text = if diff_text.is_empty() {
            "(无差异)".to_string()
        } else {
            diff_text.clone()
        };
        Ok(serde_json::json!({
            "pathA": label_a,
            "pathB": label_b,
            "mode": mode,
            "addedLines": result.added_lines,
            "removedLines": result.removed_lines,
            "hunks": result.hunks,
            "diff": diff_text,
            "text": text,
        }))
    }
}

/// 读文件为文本（UTF-8 lossy，二进制含 NUL 拒绝）
fn read_file_text(path: &std::path::Path) -> Result<String, ToolError> {
    let bytes = std::fs::read(path).map_err(|e| {
        ToolError::execution_failed("diff_text", format!("{}: {e}", path.display()))
    })?;
    if bytes.contains(&0u8) {
        return Err(ToolError::execution_failed(
            "diff_text",
            format!(
                "File is binary and cannot be read as text: {}",
                path.display()
            ),
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 将 hunk 结构渲染为 unified diff 文本
fn render_unified(label_a: &str, label_b: &str, result: &DiffResult) -> String {
    if result.hunks.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push_str(&format!("--- a/{label_a}\n+++ b/{label_b}\n"));
    for hunk in &result.hunks {
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
        ));
        for line in &hunk.lines {
            let prefix = match line.kind {
                DiffLineKind::Context => " ",
                DiffLineKind::Addition => "+",
                DiffLineKind::Deletion => "-",
            };
            out.push_str(&format!("{prefix}{}\n", line.content));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{create_mock_tool_context, ToolContext};
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    /// 测试用会话上下文：workspace_root 指向临时工作区
    fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        }
    }

    #[tokio::test]
    async fn diff_contents_produces_unified_text() {
        // contents 模式不触碰 workspace_root，直接使用 mock 上下文
        let ctx = create_mock_tool_context();
        let tool = DiffTextTool::new();
        let out = tool
            .execute(
                &ctx,
                json!({ "contentA": "aaa\nbbb\nccc\n", "contentB": "aaa\nxxx\nccc\n" }),
            )
            .await
            .unwrap();
        assert_eq!(out["mode"], "contents");
        assert_eq!(out["addedLines"], 1);
        assert_eq!(out["removedLines"], 1);
        let diff = out["diff"].as_str().unwrap();
        assert!(diff.starts_with("--- a/contentA\n+++ b/contentB\n"));
        assert!(diff.contains("@@ "));
        assert!(diff.contains("-bbb"));
        assert!(diff.contains("+xxx"));
        assert!(diff.contains(" aaa"));
    }

    #[tokio::test]
    async fn diff_identical_contents_empty() {
        let ctx = create_mock_tool_context();
        let tool = DiffTextTool::new();
        let out = tool
            .execute(&ctx, json!({ "contentA": "same\n", "contentB": "same\n" }))
            .await
            .unwrap();
        assert_eq!(out["addedLines"], 0);
        assert_eq!(out["hunks"].as_array().unwrap().len(), 0);
        assert_eq!(out["text"], "(无差异)");
    }

    #[tokio::test]
    async fn diff_by_file_paths() {
        let ws = TempWorkspace::new("diff_files");
        ws.write_file("old.txt", "line1\nline2\n");
        ws.write_file("new.txt", "line1\nchanged\n");
        let tool = DiffTextTool::new();
        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "pathA": "old.txt", "pathB": "new.txt" }),
            )
            .await
            .unwrap();
        assert_eq!(out["mode"], "files");
        assert!(out["diff"].as_str().unwrap().contains("--- a/old.txt"));
        assert!(out["diff"].as_str().unwrap().contains("+++ b/new.txt"));
        assert!(out["diff"].as_str().unwrap().contains("-line2"));
        assert!(out["diff"].as_str().unwrap().contains("+changed"));
    }

    #[tokio::test]
    async fn diff_mixed_mode_rejected() {
        let ctx = create_mock_tool_context();
        let tool = DiffTextTool::new();
        let err = tool
            .execute(&ctx, json!({ "pathA": "a.txt", "contentB": "x" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("只能选一种模式"));
    }

    #[tokio::test]
    async fn diff_missing_path_errors() {
        let ws = TempWorkspace::new("diff_missing");
        ws.write_file("a.txt", "x");
        let tool = DiffTextTool::new();
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "pathA": "a.txt" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("together"));
    }
}
