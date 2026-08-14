//! 删除前自动备份中间件（I3-S10b：middleware before_execute 自动备份钩子）
//!
//! 工程铁律（05 §13.3 / 01 方案 §0 原则 2）：任何破坏性写操作执行前自动
//! 暂存备份，无需用户同意（只读低成本，不触发审批）。本中间件实现
//! [crate::middleware::ToolMiddleware] 的 before_execute 钩子——该链只在
//! 「审批已通过（或无需审批）」后进入执行面（tool_exec.rs 优先级语义：
//! 审批优先于中间件），因此自动备份天然不会绕过审批，审批拒绝时本钩子
//! 根本不会被调用。
//!
//! 与删除接管（I2-S3）的边界：
//! - DeleteShape 类工具（delete_file / delete_dir）**内置**备份（backup=true，
//!   见 tools/delete.rs），本中间件跳过（[BUILTIN_BACKUP_TOOLS]），避免双份
//!   快照——删除走工具内置、写类走中间件快照；
//! - 本中间件覆盖**非删除但会修改文件**的工具（默认 [default_backup_tools]
//!   为 write_file / multi_replace_file_content）：执行前把目标文件**复制快照**
//!   进回收站域（[conex_fs::trash::TrashService::snapshot]，原路径保留，工具
//!   随后覆盖写入），快照条目可在回收站登记中列出并经 restore_force 覆盖恢复。
//!
//! 失败策略（安全优先）：快照失败 → [BeforeExecuteResult::Block]（阻止操作）；
//! 成功 → Proceed。目标为「原不存在」的新文件时登记 nil-content 条目
//! （恢复 = 删除原路径，对齐 FileSnap `Content == nil` 反向语义）。
//!
//! 挂载点（合并轮交接登记）：执行器中间件链经
//! `session-loop` 的 `SessionLoopOptions.tool_middleware` 注入（壳层装配，
//! 见 apps/agent-workbench/src-tauri/src/core_run_commands.rs 的 options
//! 构建处，tool_exec.rs 中间件链本身已接线，本钩子为数据驱动挂载，无需
//! 改动执行器）。建议以 BuiltinToolConfig.trash_root 同源值构造
//! （None 时执行期回退工作区 `.crish-trash`，与删除工具兜底一致）。

use crate::definition::{Tool, ToolError};
use crate::middleware::{BeforeExecuteResult, ToolExecutionContext, ToolMiddleware};
use async_trait::async_trait;
use conex_fs::trash::TrashService;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;

/// 内置备份工具名单（DeleteShape 类，I2-S3）：工具内部已写备份，中间件跳过
pub const BUILTIN_BACKUP_TOOLS: [&str; 2] = ["delete_file", "delete_dir"];

/// 默认声明需备份的工具名单（写类工具：覆盖写入前快照）
///
/// 含 multi_replace_file_content（T-EG-02 名单登记）：与 write_file 同为
/// 非删除写类工具，写前快照语义一致。
pub fn default_backup_tools() -> Vec<String> {
    vec![
        "write_file".to_string(),
        "multi_replace_file_content".to_string(),
    ]
}

/// 删除前自动备份中间件（S10b）
///
/// 仅实现 before_execute（on_result / on_error 保持默认空实现）：快照登记
/// 即审计线索（回收站登记可列出），on_result 改写输出会污染工具结果面，
/// 故不做记录性后置钩子。
pub struct BackupMiddleware {
    name: String,
    /// 回收站根目录（None → 执行期回退工作区 `.crish-trash`）
    trash_root: Option<PathBuf>,
    /// 声明需备份的工具名集合
    backup_tools: HashSet<String>,
}

impl BackupMiddleware {
    /// 新建备份中间件：backup_tools 为声明需备份的工具名列表
    pub fn new(trash_root: Option<PathBuf>, backup_tools: Vec<String>) -> Self {
        Self {
            name: "backup".to_string(),
            trash_root,
            backup_tools: backup_tools.into_iter().collect(),
        }
    }

    /// 新建备份中间件（默认备份名单：[default_backup_tools]）
    pub fn with_defaults(trash_root: Option<PathBuf>) -> Self {
        Self::new(trash_root, default_backup_tools())
    }
}

impl Default for BackupMiddleware {
    fn default() -> Self {
        Self::with_defaults(None)
    }
}

#[async_trait]
impl ToolMiddleware for BackupMiddleware {
    fn name(&self) -> &str {
        &self.name
    }

    /// 执行前钩子：声明需备份的写类工具在修改前复制快照到回收站域
    ///
    /// - 未声明工具 / 删除类内置备份工具 → 原样放行；
    /// - 入参无 `path` → 无备份义务，放行；
    /// - 路径解析失败（越界/非法）或快照失败 → Block（安全优先）；
    /// - 快照成功 → Proceed（原入参透传，不改写输入）。
    async fn before_execute(
        &self,
        tool: &dyn Tool,
        input: Value,
        ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        let tool_name = tool.name();
        if !self.backup_tools.contains(tool_name) {
            return Ok(BeforeExecuteResult::Proceed {
                modified_input: None,
            });
        }
        if BUILTIN_BACKUP_TOOLS.contains(&tool_name) {
            // 删除类工具内置备份（S3），跳过避免双份快照
            return Ok(BeforeExecuteResult::Proceed {
                modified_input: None,
            });
        }
        // 写目标入参名归一：write_file/multi_replace 等写类工具统一取
        // 目标路径（multi_replace 的 schema 入参是 `target_file`，与
        // write_file 的 `path` 不同名——F5 L1 登记缺口，此处回退识别，
        // 保证写前快照对 multi_replace 同样生效）
        let path_str = input
            .get("path")
            .or_else(|| input.get("target_file"))
            .and_then(Value::as_str);
        let Some(path_str) = path_str else {
            // 无路径目标：无备份义务，放行
            return Ok(BeforeExecuteResult::Proceed {
                modified_input: None,
            });
        };
        let ws_root = ctx
            .cwd
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let target = match crate::tools::resolve_workspace_path(&ws_root, path_str) {
            Ok(p) => p,
            Err(e) => {
                return Ok(BeforeExecuteResult::Block {
                    reason: format!("写前自动备份路径解析失败（安全优先，阻止执行）：{e}"),
                });
            }
        };
        let root = self
            .trash_root
            .clone()
            .unwrap_or_else(|| ws_root.join(crate::tools::delete::DEFAULT_TRASH_DIR_NAME));
        let service = TrashService::new(root);
        match service.snapshot(&target) {
            Ok(entry) => {
                tracing::info!(
                    target: "security.backup",
                    session_id = ctx.session_id.as_deref().unwrap_or_default(),
                    tool = tool_name,
                    target_path = ?target,
                    entry_id = %entry.id,
                    "写前自动备份快照已登记（S10b 钩子）"
                );
                Ok(BeforeExecuteResult::Proceed {
                    modified_input: None,
                })
            }
            Err(e) => Ok(BeforeExecuteResult::Block {
                reason: format!("写前自动备份失败（安全优先，阻止执行）：{e}"),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::ToolContext;
    use crate::definition::{Tool, ToolDefinition};
    use conex_fs::trash::EntryMode;
    use conex_test_utils::TempWorkspace;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 测试写工具：只记录执行次数，不落盘（中间件测试只关心 before 链）
    struct TestWriteTool {
        name: String,
        executed: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Tool for TestWriteTool {
        fn name(&self) -> &str {
            &self.name
        }

        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "write_file".to_string(),
                description: "测试写工具".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
                dangerous: true,
                fatal_on_error: false,
            })
        }

        async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
            self.executed.fetch_add(1, Ordering::SeqCst);
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    /// 中间件上下文：cwd 指向临时工作区
    fn mw_ctx(ws: &TempWorkspace) -> ToolExecutionContext {
        ToolExecutionContext {
            session_id: Some("s1".to_string()),
            run_id: Some("r1".to_string()),
            tool_call_id: Some("c1".to_string()),
            cwd: Some(ws.path_str()),
        }
    }

    fn write_tool() -> (TestWriteTool, Arc<AtomicUsize>) {
        let executed = Arc::new(AtomicUsize::new(0));
        let tool = TestWriteTool {
            name: "write_file".to_string(),
            executed: Arc::clone(&executed),
        };
        (tool, executed)
    }

    #[test]
    fn default_backup_tools_covers_write_and_multi_replace() {
        // 名单登记护栏（T-EG-02）：写类工具必须声明写前快照
        let names = default_backup_tools();
        assert!(
            names.contains(&"write_file".to_string()),
            "write_file 必须在备份名单"
        );
        assert!(
            names.contains(&"multi_replace_file_content".to_string()),
            "multi_replace_file_content 必须在备份名单"
        );
    }

    #[tokio::test]
    async fn backup_success_snapshot_created_and_proceeds() {
        let ws = TempWorkspace::new("bw_snap");
        ws.write_file("a.txt", "original content");
        let trash = TempWorkspace::new("bw_trash");
        let mw = BackupMiddleware::with_defaults(Some(trash.path().clone()));
        let (tool, _) = write_tool();

        let r = mw
            .before_execute(
                &tool,
                json!({ "path": "a.txt", "content": "new" }),
                &mw_ctx(&ws),
            )
            .await
            .unwrap();
        assert!(
            matches!(r, BeforeExecuteResult::Proceed { .. }),
            "快照成功应放行"
        );

        // 快照登记出现条目（模式 snapshot），原路径未被修改（复制语义）
        let svc = TrashService::new(trash.path());
        let entries = svc.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].mode, EntryMode::Snapshot);
        assert_eq!(entries[0].original_path, ws.path().join("a.txt"));
        assert_eq!(ws.read_file("a.txt"), "original content");
    }

    #[tokio::test]
    async fn backup_new_file_registers_nil_content_and_restore_deletes() {
        let ws = TempWorkspace::new("bw_nil");
        let trash = TempWorkspace::new("bw_nil_trash");
        let mw = BackupMiddleware::with_defaults(Some(trash.path().clone()));
        let (tool, _) = write_tool();

        // 目标原不存在 → nil-content 快照，仍放行（写新文件不被误拦）
        let r = mw
            .before_execute(
                &tool,
                json!({ "path": "fresh.txt", "content": "x" }),
                &mw_ctx(&ws),
            )
            .await
            .unwrap();
        assert!(matches!(r, BeforeExecuteResult::Proceed { .. }));

        let svc = TrashService::new(trash.path());
        let entries = svc.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].mode, EntryMode::Snapshot);
        assert_eq!(entries[0].checksum, None);

        // 写工具随后创建文件；nil-content 恢复 = 删除原路径
        ws.write_file("fresh.txt", "created later");
        svc.restore_force(&entries[0].id).unwrap();
        assert!(!ws.path().join("fresh.txt").exists());
        assert!(svc.list().is_empty());
    }

    #[tokio::test]
    async fn backup_failure_blocks_execution() {
        // 目标位于回收站根内 → 快照守卫拒绝 → Block（工具不得执行）
        let ws = TempWorkspace::new("bw_block");
        ws.write_file(".crish-trash/x.txt", "in trash");
        let mw = BackupMiddleware::with_defaults(Some(ws.path().join(".crish-trash")));
        let (tool, executed) = write_tool();

        let r = mw
            .before_execute(
                &tool,
                json!({ "path": ".crish-trash/x.txt", "content": "y" }),
                &mw_ctx(&ws),
            )
            .await
            .unwrap();
        match r {
            BeforeExecuteResult::Block { reason } => {
                assert!(
                    reason.contains("备份失败"),
                    "Block 文案应带失败原因：{reason}"
                );
            }
            BeforeExecuteResult::Proceed { .. } => panic!("备份失败必须阻止执行"),
        }
        assert_eq!(executed.load(Ordering::SeqCst), 0, "阻止后工具不得执行");
        // 目标文件未被动过
        assert_eq!(ws.read_file(".crish-trash/x.txt"), "in trash");
    }

    #[tokio::test]
    async fn backup_success_allows_execution() {
        let ws = TempWorkspace::new("bw_pass");
        ws.write_file("a.txt", "v1");
        let trash = TempWorkspace::new("bw_pass_trash");
        let mw = BackupMiddleware::with_defaults(Some(trash.path().clone()));
        let (tool, executed) = write_tool();

        let r = mw
            .before_execute(
                &tool,
                json!({ "path": "a.txt", "content": "v2" }),
                &mw_ctx(&ws),
            )
            .await
            .unwrap();
        assert!(
            matches!(r, BeforeExecuteResult::Proceed { .. }),
            "备份成功应放行"
        );
        // 放行后工具可正常执行
        let _ = tool
            .execute(
                &crate::context::create_mock_tool_context(),
                json!({ "path": "a.txt" }),
            )
            .await
            .unwrap();
        assert_eq!(executed.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn undeclared_tool_skips_backup() {
        let ws = TempWorkspace::new("bw_skip");
        ws.write_file("a.txt", "x");
        let trash = TempWorkspace::new("bw_skip_trash");
        let mw = BackupMiddleware::with_defaults(Some(trash.path().clone()));
        // read_file 未声明需备份 → 不产生快照，放行
        let tool = TestWriteTool {
            name: "read_file".to_string(),
            executed: Arc::new(AtomicUsize::new(0)),
        };

        let r = mw
            .before_execute(&tool, json!({ "path": "a.txt" }), &mw_ctx(&ws))
            .await
            .unwrap();
        assert!(matches!(r, BeforeExecuteResult::Proceed { .. }));
        assert!(
            TrashService::new(trash.path()).list().is_empty(),
            "未声明工具不得产生快照"
        );
    }

    #[tokio::test]
    async fn delete_tool_skipped_even_if_declared() {
        // 边界：即使配置误把 delete_file 声明进备份名单，也跳过
        //（删除工具内置备份，避免双份快照）
        let ws = TempWorkspace::new("bw_del");
        ws.write_file("a.txt", "x");
        let trash = TempWorkspace::new("bw_del_trash");
        let mw = BackupMiddleware::new(Some(trash.path().clone()), vec!["delete_file".to_string()]);
        let tool = TestWriteTool {
            name: "delete_file".to_string(),
            executed: Arc::new(AtomicUsize::new(0)),
        };

        let r = mw
            .before_execute(&tool, json!({ "path": "a.txt" }), &mw_ctx(&ws))
            .await
            .unwrap();
        assert!(matches!(r, BeforeExecuteResult::Proceed { .. }));
        assert!(
            TrashService::new(trash.path()).list().is_empty(),
            "删除类工具由内置备份承担，中间件不得再快照"
        );
    }

    #[tokio::test]
    async fn backup_no_path_arg_proceeds() {
        let ws = TempWorkspace::new("bw_nopath");
        let trash = TempWorkspace::new("bw_nopath_trash");
        let mw = BackupMiddleware::with_defaults(Some(trash.path().clone()));
        let (tool, _) = write_tool();

        // 入参无 path（同名单工具的另类用法）→ 无备份义务，放行
        let r = mw
            .before_execute(&tool, json!({ "content": "x" }), &mw_ctx(&ws))
            .await
            .unwrap();
        assert!(matches!(r, BeforeExecuteResult::Proceed { .. }));
        assert!(TrashService::new(trash.path()).list().is_empty());
    }

    #[tokio::test]
    async fn backup_snapshot_restore_force_roundtrip() {
        // 集成语义：快照 → 写坏 → 覆盖恢复 → 内容还原（消费侧闭环）
        let ws = TempWorkspace::new("bw_roundtrip");
        ws.write_file("doc.txt", "good version");
        let trash = TempWorkspace::new("bw_roundtrip_trash");
        let mw = BackupMiddleware::with_defaults(Some(trash.path().clone()));
        let (tool, _) = write_tool();

        let r = mw
            .before_execute(
                &tool,
                json!({ "path": "doc.txt", "content": "bad" }),
                &mw_ctx(&ws),
            )
            .await
            .unwrap();
        assert!(matches!(r, BeforeExecuteResult::Proceed { .. }));

        // 模拟写工具覆盖写入「坏版本」
        ws.write_file("doc.txt", "bad version");
        let svc = TrashService::new(trash.path());
        let entries = svc.list();
        assert_eq!(entries.len(), 1);
        svc.restore_force(&entries[0].id).unwrap();
        assert_eq!(ws.read_file("doc.txt"), "good version");
        assert!(svc.list().is_empty());
    }
}
