//! 删除接管工具（I2-S3：delete_file / delete_dir）
//!
//! 支持回收站接管（默认，可恢复）与真实物理删除（permanent: true）。
//! 回收站根目录经构造期配置注入（`BuiltinToolConfig.trash_root`，类似
//! shell 超时的注入模式；R3 T9：会话数据走 ctx，配置仅承载构造期默认值）：
//! - 注入：`DeleteFileTool::new(Some(trash_root))`；
//! - 未注入：执行期回退工作区 `.crish-trash`（模式 B 兜底）。
//!
//! 输出含 `entryId`（TrashEntry id）供后续恢复（trash_restore 引擎命令消费），
//! 并明示 `recoverable` 可恢复路径类型与降级状态。

use crate::audit::{security_audit_event, NoopAuditSink, SecurityAuditSink};
use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{display_path, optional_bool, require_string, resolve_workspace_path};
use crate::write_paths::{claim_write_guard, ClaimMode};
use async_trait::async_trait;
use conex_fs::trash::{TrashKind, TrashService};
use conex_types::events::{SecurityAuditDecision, SecurityAuditOperation};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 未注入回收站根时的兜底目录名（工作区下）
pub(crate) const DEFAULT_TRASH_DIR_NAME: &str = ".crish-trash";

/// 删除文件工具：删除工作区文件（支持回收站可恢复与物理删除）
pub(crate) struct DeleteFileTool {
    def: ToolDefinition,
    trash_root: Option<PathBuf>,
    /// 安全审计 sink（I2-S8：删除动作发射 security-audit；未接线时 no-op）
    audit_sink: Arc<dyn SecurityAuditSink>,
}

impl DeleteFileTool {
    /// 新建删除工具（trash_root 为回收站根；None 时执行期回退工作区 `.crish-trash`）。
    /// G11a 备注：非 test 构建无生产消费者（注册面统一经 with_audit_sink
    /// 注入审计 sink），本构造器供测试直接覆盖——dead_code 静音。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(trash_root: Option<PathBuf>) -> Self {
        Self::with_audit_sink(trash_root, Arc::new(NoopAuditSink))
    }

    /// 新建删除工具并注入审计 sink（I2-S8 发射点接线；默认 no-op）
    pub(crate) fn with_audit_sink(
        trash_root: Option<PathBuf>,
        audit_sink: Arc<dyn SecurityAuditSink>,
    ) -> Self {
        Self {
            def: ToolDefinition {
                name: "delete_file".to_string(),
                description:
                    "删除工作区文件。支持移入回收站（默认，可恢复）或物理抹除（permanent=true）。"
                        .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区文件路径（相对或绝对）" },
                        "backup": { "type": "boolean", "description": "是否写快照（checksum + 原始元数据），默认 true（仅回收站模式有效）" },
                        "permanent": { "type": "boolean", "description": "是否物理删除（直接抹除文件，不进入回收站），默认 false" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
            trash_root,
            audit_sink,
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
        execute_delete(
            ctx,
            args,
            "delete_file",
            self.trash_root.clone(),
            Arc::clone(&self.audit_sink),
            true,
        )
        .await
    }
}

/// 删除目录工具：删除工作区目录（含子树，支持回收站可恢复与物理删除）
pub(crate) struct DeleteDirTool {
    def: ToolDefinition,
    trash_root: Option<PathBuf>,
    /// 安全审计 sink（I2-S8：删除动作发射 security-audit；未接线时 no-op）
    audit_sink: Arc<dyn SecurityAuditSink>,
}

impl DeleteDirTool {
    /// 新建删除工具（trash_root 为回收站根；None 时执行期回退工作区 `.crish-trash`）。
    /// G11a 备注：非 test 构建无生产消费者（注册面统一经 with_audit_sink
    /// 注入审计 sink），本构造器供测试直接覆盖——dead_code 静音。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(trash_root: Option<PathBuf>) -> Self {
        Self::with_audit_sink(trash_root, Arc::new(NoopAuditSink))
    }

    /// 新建删除工具并注入审计 sink（I2-S8 发射点接线；默认 no-op）
    pub(crate) fn with_audit_sink(
        trash_root: Option<PathBuf>,
        audit_sink: Arc<dyn SecurityAuditSink>,
    ) -> Self {
        Self {
            def: ToolDefinition {
                name: "delete_dir".to_string(),
                description: "删除工作区目录（含子树）。支持移入回收站（默认，可恢复）或物理抹除（permanent=true）。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "工作区目录路径（相对或绝对）" },
                        "backup": { "type": "boolean", "description": "是否写快照（checksum + 原始元数据），默认 true（仅回收站模式有效）" },
                        "permanent": { "type": "boolean", "description": "是否物理删除（直接抹除目录及内容，不进入回收站），默认 false" }
                    },
                    "required": ["path"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
            trash_root,
            audit_sink,
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
        execute_delete(
            ctx,
            args,
            "delete_dir",
            self.trash_root.clone(),
            Arc::clone(&self.audit_sink),
            false,
        )
        .await
    }
}

/// 删除执行公共面：路径校验（工作区越界拒绝）→ 类型断言 → 物理删除或移入回收站 →
/// 发射安全审计事件（permanent 为 Allowed，回收站接管为 Redirected）
// G2 例外：permanent=true 是用户显式要求不可恢复删除的唯一合法物理删除面，
// 已由工具 schema + 审计事件双门控；会话历史清理仍强制走 conex-fs trash。
#[allow(clippy::disallowed_methods)]
async fn execute_delete(
    ctx: &ToolContext,
    args: serde_json::Value,
    tool_name: &str,
    trash_root: Option<PathBuf>,
    audit_sink: Arc<dyn SecurityAuditSink>,
    require_file: bool,
) -> Result<serde_json::Value, ToolError> {
    let path_str = require_string(&args, "path")?;
    let target = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
    let display = display_path(&ctx.workspace_root, &target);
    // T-D-08：硬沙箱越权拒绝（Allowed 白名单下删除目标不在允许集 → 拒绝；
    // 未装配策略 = 不强制，与 write_file 同款；先越权后互斥，串行叠加）
    crate::write_paths::check_write_allowance_for_ctx(ctx, &target)?;
    // I4-M3：写路径互斥——删除目标声明 Delete 模式；冲突拒绝（谁占用/何时），
    // 守卫随函数结束自动释放（任何错误路径均释放，不残留记账）
    let _claim = claim_write_guard(ctx, &path_str, ClaimMode::Delete)?;

    let backup = optional_bool(&args, "backup").unwrap_or(true);
    let permanent = optional_bool(&args, "permanent").unwrap_or(false);
    // ToolContext 非 Send：回收站根在闭包外解析（与 trash_service_for 同语义）
    let effective_trash_root =
        trash_root.unwrap_or_else(|| ctx.workspace_root.join(DEFAULT_TRASH_DIR_NAME));
    let tool_name_owned = tool_name.to_string();
    // U-BLOCK：同步 metadata / impact / trash 全路径经 spawn_blocking（INV-B3）
    let (impact, entry, trash_root_path) = {
        let target = target.clone();
        let display = display.clone();
        tokio::task::spawn_blocking(move || -> Result<
            (
                conex_fs::impact::ImpactAssessment,
                Option<conex_fs::trash::TrashEntry>,
                PathBuf,
            ),
            ToolError,
        > {
            let metadata = std::fs::metadata(&target).map_err(|e| {
                ToolError::execution_failed(&tool_name_owned, format!("{display}: {e}"))
            })?;
            if require_file && !metadata.is_file() {
                return Err(ToolError::execution_failed(
                    &tool_name_owned,
                    format!("Path is not a file: {display}"),
                ));
            }
            if !require_file && !metadata.is_dir() {
                return Err(ToolError::execution_failed(
                    &tool_name_owned,
                    format!("Path is not a directory: {display}"),
                ));
            }
            // I2-S8：删除前影响面预检（文件数 / 大小 / 跨目录），随工具结果与审计日志输出
            let impact = conex_fs::impact::assess(std::slice::from_ref(&target));
            if permanent {
                if require_file {
                    std::fs::remove_file(&target).map_err(|e| {
                        ToolError::execution_failed(&tool_name_owned, format!("{display}: {e}"))
                    })?;
                } else {
                    std::fs::remove_dir_all(&target).map_err(|e| {
                        ToolError::execution_failed(&tool_name_owned, format!("{display}: {e}"))
                    })?;
                }
                Ok((impact, None, PathBuf::new()))
            } else {
                let service = TrashService::new(effective_trash_root);
                let entry = service.trash_file(&target, backup).map_err(|e| {
                    ToolError::execution_failed(&tool_name_owned, format!("{display}: {e}"))
                })?;
                let root = service.root().to_path_buf();
                drop(service);
                Ok((impact, Some(entry), root))
            }
        })
        .await
        .map_err(|e| ToolError::execution_failed(tool_name, format!("spawn_blocking: {e}")))??
    };
    // 安全审计事件：物理删除为 Allowed，回收站接管为 Redirected
    let audit_decision = if permanent {
        SecurityAuditDecision::Allowed
    } else {
        SecurityAuditDecision::Redirected
    };
    audit_sink.emit(&security_audit_event(
        &ctx.session_id,
        SecurityAuditOperation::Delete,
        vec![display.clone()],
        impact,
        audit_decision,
        ctx.tool_call_id.clone(),
    ));
    // 审计记录
    tracing::info!(
        target: "security.audit",
        kind = "delete",
        session_id = %ctx.session_id,
        tool = %tool_name,
        target_path = ?target,
        permanent = %permanent,
        impact = ?impact,
        "删除操作执行完成"
    );

    if permanent {
        let kind_text = if require_file { "文件" } else { "目录" };
        let text = format!("已物理删除{kind_text} {display}（直接抹除，无法恢复）。");
        Ok(serde_json::json!({
            "path": display,
            "permanent": true,
            "recoverable": "none",
            "impact": impact,
            "text": text,
        }))
    } else if let Some(entry) = entry {
        Ok(delete_output(
            &entry,
            &display,
            &trash_root_path,
            backup,
            impact,
        ))
    } else {
        Err(ToolError::execution_failed(
            tool_name,
            "missing trash entry",
        ))
    }
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

    /// 测试用会话上下文：workspace_root 指向临时工作区；
    /// tool_call_id 注入模拟值（LK-03：审计真值断言锚）
    fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            tool_call_id: Some("mock-call-id".to_string()),
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
    async fn delete_file_permanent_physically_removes() {
        let ws = TempWorkspace::new("del_file_perm");
        ws.write_file("a.txt", "hello delete");
        let trash = TempWorkspace::new("del_trash");
        let tool = DeleteFileTool::new(Some(trash.path().clone()));

        let out = tool
            .execute(
                &mock_ctx(&ws),
                json!({ "path": "a.txt", "permanent": true }),
            )
            .await
            .unwrap();
        assert_eq!(out["path"], "a.txt");
        assert_eq!(out["permanent"], true);
        assert_eq!(out["recoverable"], "none");
        assert!(!ws.path().join("a.txt").exists(), "物理删除后原路径消失");

        let service = TrashService::new(trash.path());
        assert_eq!(service.list().len(), 0, "物理删除不写入回收站");
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
    async fn delete_dir_permanent_physically_removes() {
        let ws = TempWorkspace::new("del_dir_perm");
        ws.write_file("sub/inner.txt", "inner");
        let trash = TempWorkspace::new("del_trash");
        let tool = DeleteDirTool::new(Some(trash.path().clone()));

        let out = tool
            .execute(&mock_ctx(&ws), json!({ "path": "sub", "permanent": true }))
            .await
            .unwrap();
        assert_eq!(out["permanent"], true);
        assert!(!ws.path().join("sub").exists(), "物理删除后原目录消失");

        let service = TrashService::new(trash.path());
        assert_eq!(service.list().len(), 0, "物理删除不写入回收站");
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
        assert!(
            file_tool.definition().dangerous,
            "delete_file 必须 dangerous=true"
        );

        let dir_tool = DeleteDirTool::new(None);
        assert_eq!(dir_tool.name(), "delete_dir");
        assert!(
            dir_tool.definition().dangerous,
            "delete_dir 必须 dangerous=true"
        );
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
        assert!(
            ws.path().join("a.txt").exists(),
            "越界拒绝时不得删除任何文件"
        );
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

    /// I2-S8：删除工具经审计 sink 发射 security-audit 事件（decision=redirected，
    /// 影响面载荷来自预检；permissionMode 由 emit 层注入恒为 None）
    #[tokio::test]
    async fn delete_emits_security_audit_event() {
        use crate::audit::RecordingAuditSink;
        use conex_types::events::{
            SecurityAuditDecision as Decision, SecurityAuditOperation as Op,
        };
        use conex_types::AgentEvent;

        let ws = TempWorkspace::new("del_audit");
        ws.write_file("sub/a.txt", "aaaa");
        ws.write_file("sub/b.txt", "bbbb");
        let trash = TempWorkspace::new("del_audit_trash");
        let sink = Arc::new(RecordingAuditSink::new());
        let tool = DeleteDirTool::with_audit_sink(
            Some(trash.path().clone()),
            Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
        );

        tool.execute(&mock_ctx(&ws), json!({ "path": "sub" }))
            .await
            .unwrap();
        let events = sink.emitted();
        assert_eq!(events.len(), 1, "删除工具应发射 1 条审计事件");
        match &events[0] {
            AgentEvent::SecurityAudit {
                session_id,
                operation,
                targets,
                impact,
                decision,
                permission_mode,
                tool_call_id,
                ..
            } => {
                assert_eq!(session_id, "mock-session");
                assert_eq!(operation, &Op::Delete);
                assert_eq!(targets, &vec!["sub".to_string()], "目标为工作区相对路径");
                assert_eq!(impact.file_count, 2);
                assert_eq!(impact.total_size_bytes, 8);
                assert_eq!(impact.directory_count, 1);
                assert_eq!(decision, &Decision::Redirected);
                assert!(permission_mode.is_none(), "permissionMode 由 emit 层注入");
                assert_eq!(
                    tool_call_id,
                    &Some("mock-call-id".to_string()),
                    "LK-03：工具执行 → security-audit 携带真实调用 id（非 None）"
                );
            }
            other => panic!("应为 security-audit，实际 {}", other.type_name()),
        }
    }
}
