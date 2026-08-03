//! 删除接管工具（I2-S3：delete_file / delete_dir）
//!
//! 唯一删除接口：调用 conex-fs 回收站服务（`TrashService::trash_file`）
//! 移入应用内 trash 目录并登记，**绝不物理删除**（S3 方案「删除只走接口」）；
//! 工具定义 dangerous=true → ask 模式走审批、plan 模式拒绝（S10 统一门禁）。
//!
//! 回收站根目录经构造期配置注入（`BuiltinToolConfig.trash_root`，类似
//! shell 超时的注入模式；R3 T9：会话数据走 ctx，配置仅承载构造期默认值）：
//! - 注入：`DeleteFileTool::new(Some(trash_root))`；
//! - 未注入：执行期回退工作区 `.crish-trash`（模式 B 兜底）。
//!
//! 输出含 `entryId`（TrashEntry id）供后续恢复（trash_restore 引擎命令消费），
//! 并明示 `recoverable: app-trash` 可恢复路径类型与降级状态。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{display_path, optional_bool, require_string, resolve_workspace_path};
use async_trait::async_trait;
use conex_fs::trash::{TrashKind, TrashService};
use std::path::{Path, PathBuf};

/// 未注入回收站根时的兜底目录名（工作区下）
pub(crate) const DEFAULT_TRASH_DIR_NAME: &str = ".crish-trash";

/// 解析执行期回收站根：构造期注入优先，否则回退工作区 `.crish-trash`
fn trash_service_for(config_root: &Option<PathBuf>, ctx: &ToolContext) -> TrashService {
    let root = config_root
        .clone()
        .unwrap_or_else(|| ctx.workspace_root.join(DEFAULT_TRASH_DIR_NAME));
    TrashService::new(root)
}

/// 删除文件工具：删除工作区文件到回收站（可恢复）
pub(crate) struct DeleteFileTool {
    def: ToolDefinition,
    trash_root: Option<PathBuf>,
}

impl DeleteFileTool {
    /// 新建删除工具（trash_root 为回收站根；None 时执行期回退工作区 `.crish-trash`）
    pub(crate) fn new(trash_root: Option<PathBuf>) -> Self {
        Self {
            def: ToolDefinition {
                name: "delete_file".to_string(),
                description: "删除工作区文件到回收站（可恢复）：移入应用内 trash 目录并登记，返回条目 id 供恢复。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
                        "backup": { "type": "boolean", "description": "是否写快照（checksum + 原始元数据），默认 true" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
            trash_root,
        }
    }
}

#[async_trait]
impl Tool for DeleteFileTool {
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
        execute_delete(ctx, args, "delete_file", self.trash_root.clone(), true).await
    }
}

/// 删除目录工具：删除工作区目录（含子树）到回收站（可恢复）
pub(crate) struct DeleteDirTool {
    def: ToolDefinition,
    trash_root: Option<PathBuf>,
}

impl DeleteDirTool {
    /// 新建删除工具（trash_root 为回收站根；None 时执行期回退工作区 `.crish-trash`）
    pub(crate) fn new(trash_root: Option<PathBuf>) -> Self {
        Self {
            def: ToolDefinition {
                name: "delete_dir".to_string(),
                description: "删除工作区目录（含子树）到回收站（可恢复）：移入应用内 trash 目录并登记，返回条目 id 供恢复。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区目录路径（相对或绝对）" },
                        "backup": { "type": "boolean", "description": "是否写快照（checksum + 原始元数据），默认 true" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
            trash_root,
        }
    }
}

#[async_trait]
impl Tool for DeleteDirTool {
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
        execute_delete(ctx, args, "delete_dir", self.trash_root.clone(), false).await
    }
}

/// 删除执行公共面：路径校验（工作区越界拒绝）→ 类型断言 → 移入回收站
async fn execute_delete(
    ctx: &ToolContext,
    args: serde_json::Value,
    tool_name: &str,
    trash_root: Option<PathBuf>,
    require_file: bool,
) -> Result<serde_json::Value, ToolError> {
    let path_str = require_string(&args, "path")?;
    let target = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
    let display = display_path(&ctx.workspace_root, &target);

    let metadata = std::fs::metadata(&target)
        .map_err(|e| ToolError::execution_failed(tool_name, format!("{display}: {e}")))?;
    if require_file && !metadata.is_file() {
        return Err(ToolError::execution_failed(
            tool_name,
            format!("Path is not a file: {display}"),
        ));
    }
    if !require_file && !metadata.is_dir() {
        return Err(ToolError::execution_failed(
            tool_name,
            format!("Path is not a directory: {display}"),
        ));
    }

    let backup = optional_bool(&args, "backup").unwrap_or(true);
    // I2-S8：删除前影响面预检（文件数 / 大小 / 跨目录），随工具结果与审计日志输出
    let impact = conex_fs::impact::assess(std::slice::from_ref(&target));
    let service = trash_service_for(&trash_root, ctx);
    let entry = service
        .trash_file(&target, backup)
        .map_err(|e| ToolError::execution_failed(tool_name, format!("{display}: {e}")))?;
    // 审计记录（结构化安全审计日志；工具结果经 tool-end 事件流落库）
    tracing::info!(
        target: "security.audit",
        kind = "delete",
        session_id = %ctx.session_id,
        tool = %tool_name,
        target_path = ?target,
        entry_id = %entry.id,
        impact = ?impact,
        "删除接管审计：目标已移入回收站（可恢复）"
    );

    Ok(delete_output(&entry, &display, service.root(), backup, impact))
}

/// 结构化输出：TrashEntry 全字段 + 展示路径 + 可恢复路径类型 + 影响面 + 文本摘要
fn delete_output(
    entry: &conex_fs::trash::TrashEntry,
    display: &str,
    trash_root: &Path,
    backup: bool,
    impact: conex_fs::impact::ImpactAssessment,
) -> serde_json::Value {
    let kind_text = match entry.kind {
        TrashKind::File => "文件",
        TrashKind::Dir => "目录",
    };
    let text = format!(
        "已删除 {display} 至回收站（条目 {}，类型 {kind_text}，大小 {} 字节）。\n\
         可恢复路径类型：应用内回收站。恢复：调用 trash_restore（entryId={}）。",
        entry.id, entry.size, entry.id,
    );
    let mut v = serde_json::to_value(entry).expect("TrashEntry 序列化不应失败");
    v["path"] = serde_json::Value::String(display.to_string());
    v["entryId"] = serde_json::Value::String(entry.id.clone());
    v["backup"] = serde_json::Value::Bool(backup);
    v["recoverable"] = serde_json::Value::String("app-trash".to_string());
    v["trashRoot"] = serde_json::Value::String(trash_root.to_string_lossy().into_owned());
    v["impact"] = serde_json::to_value(impact).expect("ImpactAssessment 序列化不应失败");
    v["text"] = serde_json::Value::String(text);
    v
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
    async fn delete_file_moves_to_injected_trash_and_restores() {
        let ws = TempWorkspace::new("del_file");
        ws.write_file("a.txt", "hello delete");
        let trash = TempWorkspace::new("del_trash");
        let tool = DeleteFileTool::new(Some(trash.path().clone()));

        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "a.txt" }))
            .await
            .unwrap();
        assert_eq!(out["path"], "a.txt");
        assert_eq!(out["kind"], "file");
        assert_eq!(out["recoverable"], "app-trash");
        assert!(out["entryId"].as_str().unwrap().starts_with('t'));
        assert!(!ws.path().join("a.txt").exists(), "删除后原路径消失");

        let service = TrashService::new(trash.path());
        let entries = service.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, out["entryId"]);
        assert!(entries[0].checksum.is_some(), "默认 backup=true 写校验和");

        service.restore(&entries[0].id).unwrap();
        assert_eq!(ws.read_file("a.txt"), "hello delete");
    }

    #[tokio::test]
    async fn delete_dir_recursive_roundtrip() {
        let ws = TempWorkspace::new("del_dir");
        ws.write_file("sub/inner.txt", "inner");
        ws.write_file("sub/deep/x.txt", "x");
        let trash = TempWorkspace::new("del_trash");
        let tool = DeleteDirTool::new(Some(trash.path().clone()));

        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "sub" }))
            .await
            .unwrap();
        assert_eq!(out["kind"], "dir");
        assert!(!ws.path().join("sub").exists());

        let service = TrashService::new(trash.path());
        let entries = service.list();
        assert_eq!(entries.len(), 1);
        service.restore(&entries[0].id).unwrap();
        assert_eq!(ws.read_file("sub/inner.txt"), "inner");
        assert_eq!(ws.read_file("sub/deep/x.txt"), "x");
    }

    #[tokio::test]
    async fn delete_file_rejects_directory_and_dir_rejects_file() {
        let ws = TempWorkspace::new("del_kind");
        ws.write_file("a.txt", "x");
        ws.write_file("sub/b.txt", "y");
        let trash = TempWorkspace::new("del_trash");

        let file_tool = DeleteFileTool::new(Some(trash.path().clone()));
        let err = file_tool
            .execute(&mock_ctx(&ws), json!({ "path": "sub" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not a file"));

        let dir_tool = DeleteDirTool::new(Some(trash.path().clone()));
        let err = dir_tool
            .execute(&mock_ctx(&ws), json!({ "path": "a.txt" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not a directory"));
    }

    #[tokio::test]
    async fn delete_tools_marked_dangerous() {
        let file_tool = DeleteFileTool::new(None);
        assert_eq!(file_tool.name(), "delete_file");
        assert!(file_tool.definition().dangerous, "delete_file 必须 dangerous=true");

        let dir_tool = DeleteDirTool::new(None);
        assert_eq!(dir_tool.name(), "delete_dir");
        assert!(dir_tool.definition().dangerous, "delete_dir 必须 dangerous=true");
    }

    #[tokio::test]
    async fn delete_file_default_trash_root_fallback() {
        let ws = TempWorkspace::new("del_fallback");
        ws.write_file("a.txt", "fallback");
        let tool = DeleteFileTool::new(None);

        tool.execute(&mock_ctx(&ws), json!({ "path": "a.txt" }))
            .await
            .unwrap();

        let fallback_root = ws.path().join(DEFAULT_TRASH_DIR_NAME);
        assert!(fallback_root.is_dir(), "未注入时回退工作区 .crish-trash");
        assert_eq!(TrashService::new(&fallback_root).list().len(), 1);
    }

    #[tokio::test]
    async fn delete_file_rejects_path_escape() {
        let ws = TempWorkspace::new("del_escape");
        ws.write_file("a.txt", "x");
        let tool = DeleteFileTool::new(None);
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "../outside.txt" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
        assert!(ws.path().join("a.txt").exists(), "越界拒绝时不得删除任何文件");
    }

    #[tokio::test]
    async fn delete_file_missing_target_errors() {
        let ws = TempWorkspace::new("del_missing");
        let tool = DeleteFileTool::new(None);
        let err = tool
            .execute(&mock_ctx(&ws), json!({ "path": "ghost.txt" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.execution_failed");
    }

    #[tokio::test]
    async fn delete_file_backup_false_omits_checksum() {
        let ws = TempWorkspace::new("del_nobackup");
        ws.write_file("a.txt", "no backup");
        let trash = TempWorkspace::new("del_trash");
        let tool = DeleteFileTool::new(Some(trash.path().clone()));

        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "a.txt", "backup": false }))
            .await
            .unwrap();
        assert_eq!(out["backup"], false);
        assert!(out["checksum"].is_null());

        let entries = TrashService::new(trash.path()).list();
        assert!(entries[0].checksum.is_none());
    }

    /// I2-S8：删除工具输出携带影响面审计载荷（S8 测试：删除工具调用产生审计记录）
    #[tokio::test]
    async fn delete_tool_output_carries_impact_audit() {
        let ws = TempWorkspace::new("del_impact");
        ws.write_file("sub/a.txt", "aaaa");
        ws.write_file("sub/b.txt", "bbbb");
        let trash = TempWorkspace::new("del_impact_trash");
        let tool = DeleteDirTool::new(Some(trash.path().clone()));

        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "sub" }))
            .await
            .unwrap();
        let impact = &out["impact"];
        assert_eq!(impact["fileCount"], 2);
        assert_eq!(impact["totalSizeBytes"], 8);
        assert_eq!(impact["directoryCount"], 1);
        assert!(impact["crossDirectory"].as_bool().is_some());
        assert_eq!(impact["flagged"], false);
        // 影响面在移入回收站后仍可读取（预检先于删除执行）
        assert_eq!(TrashService::new(trash.path()).list().len(), 1);
    }
}
