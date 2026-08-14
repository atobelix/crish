//! background_task 工具（T-AB-13：B01~B04 后台任务管理命令面）
//!
//! 定位（docs/feature-gap-analysis/plans/01-AB命令执行与后台任务方案.md §6.4）：
//! - 五个 action：list（含 includeFinished）/ status / read_log / send_input / kill，
//!   返回形状严格对齐 §4 冻结契约数据结构（camelCase serde），经
//!   [crate::background] 的序列化类型直接出站（不重建字段）；
//! - 经 `ToolContext.background` 访问 [crate::background::BackgroundTaskManager]
//!   （None = 未接线，返回「后台任务管理未接线」结构化错误，不 panic）；
//! - 错误协议：manager 返回的 ToolError（任务不存在 → tool.not_found、
//!   send_input stdin_closed 分类）原样结构化透传，工具不吞错、不改写；
//! - description 边界声明（防 AI 误用）：后台任务 stdin 是非 PTY 管道，
//!   仅适用于 [Y/n] 确认与逐行输入；全屏 TUI（fzf / vi / less 等）在管道
//!   模式下不可用，引导用户走终端面板；timeoutMs 与 waitMsBeforeAsync
//!   两个维度在 shell_command 阶段已确定，后台任务默认无限运行，终止只能
//!   走 kill（两阶段：优雅 → 5 秒 → 强制）或等待健康判定通知（R-AB3）。
//!
//! 接线说明：本工具不持 manager 引用（区别于 subagent 的构造期注入），
//! 执行期一律读 `ToolContext.background`——会话级装配由执行器负责，注册面
//! 构造零依赖，`background=None` 时行为与未接线环境一致（结构化错误）。
//!
//! 已知偏差（登记上报，主 Agent 裁决）：§4.4 `KillResult` 是 enum + struct
//! variant，serde 的 `#[serde(rename_all = "camelCase")]` 只重命名 variant
//! 名与 struct 顶层字段，**不作用于 variant 内字段**——实际序列化为
//! `{"killed":{"task_id":..,"via_force":..}}`（外部标记 + variant 名 camelCase、
//! 字段 snake_case）。本工具忠实序列化冻结类型；若契约意图是 camelCase 字段，
//! 需在 background.rs 追加 `#[serde(rename_all_fields = "camelCase")]`
//! （冻结契约变更，涉及 B1 消费方，非本任务文件域）。其余 §4.2 / §4.4
//! struct 形状（BackgroundTaskInfo / BackgroundTaskStatus / LogSlice）经验证
//! camelCase 直出无偏差。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::error::codes;
use serde_json::Value;

/// read_log 的 maxLines 缺省值（任务书 T-AB-13：默认 100）
const DEFAULT_MAX_LINES: u64 = 100;

/// background_task 工具：后台任务管理命令面（五个 action）
pub(crate) struct BackgroundTaskTool {
    def: ToolDefinition,
}

impl BackgroundTaskTool {
    /// 新建工具（manager 经 ToolContext.background 注入，构造期不持引用）
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: "background_task".to_string(),
                description: "管理后台任务（shell_command 转后台托管产生的任务，taskId 来自 shell_command 的转后台结果）：\
                              list 查询任务列表（含已结束任务用 includeFinished），status 查询单任务状态与尾部输出，\
                              read_log 按行读取任务日志，send_input 向任务标准输入写入文本，kill 两阶段终止任务。\
                              边界声明：后台任务 stdin 是非 PTY 管道，只适用于 [Y/n] 确认与逐行输入；\
                              全屏 TUI 交互（fzf / vi / less 等）在管道模式下不可用，请引导用户在终端面板手动操作。\
                              timeoutMs 与 waitMsBeforeAsync 两个维度在 shell_command 阶段已确定；转后台任务默认无限运行，\
                              终止只能走 kill（优雅 → 5 秒 → 强制）或等待健康判定通知（R-AB3 交付）。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["list", "status", "read_log", "send_input", "kill"],
                            "description": "要执行的操作"
                        },
                        "taskId": {
                            "type": "string",
                            "description": "后台任务 id（shell_command 转后台结果中的 taskId）"
                        },
                        "includeFinished": {
                            "type": "boolean",
                            "description": "list 专用：是否包含已结束任务（默认 false，只返回活跃任务）"
                        },
                        "startLine": {
                            "type": "number",
                            "description": "read_log 专用：起始行号（1-indexed，可选；缺省读尾部）"
                        },
                        "maxLines": {
                            "type": "number",
                            "description": "read_log 专用：最大返回行数（默认 100）"
                        },
                        "text": {
                            "type": "string",
                            "description": "send_input 专用：写入任务标准输入的文本（可含换行的逐行输入）"
                        },
                        "appendNewline": {
                            "type": "boolean",
                            "description": "send_input 专用：末尾是否自动追加换行（默认 true）"
                        }
                    },
                    "required": ["action"],
                    "additionalProperties": false
                }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for BackgroundTaskTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // 先解析 action（入参校验独立于接线状态，保证错误分类稳定）
        let action = super::require_string(&args, "action")?;
        // 后台任务管理器未接线 → 结构化不可用错误（不 panic，与
        // run_subagent 未接线的 common.unsupported 风格对齐）
        let Some(manager) = &ctx.background else {
            return Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "background_task 未接线：后台任务管理未装配（引擎侧注入 BackgroundTaskManager 后可用）",
            ));
        };
        // 五 action 分发：入参解析与出站形状逐 action 对齐 §4 契约
        match action.as_str() {
            "list" => action_list(manager.as_ref(), &args).await,
            "status" => action_status(manager.as_ref(), &args).await,
            "read_log" => action_read_log(manager.as_ref(), &args).await,
            "send_input" => action_send_input(manager.as_ref(), &args).await,
            "kill" => action_kill(manager.as_ref(), &args).await,
            other => Err(ToolError::invalid_input(format!(
                "未知 action：{other}（可选 list / status / read_log / send_input / kill）"
            ))),
        }
    }
}

/// list action：查询任务列表（§4.2 BackgroundTaskInfo；includeFinished
/// 缺省 false 只返回活跃任务；出站形状 `{ "tasks": [...] }` 对齐前端
/// backgroundTasksApi.ts 解析层）
async fn action_list(
    manager: &dyn crate::background::BackgroundTaskManager,
    args: &Value,
) -> Result<Value, ToolError> {
    let include_finished = super::optional_bool(args, "includeFinished").unwrap_or(false);
    let tasks = manager.list(include_finished).await?;
    Ok(serde_json::json!({ "tasks": tasks }))
}

/// status action：查询单任务状态与尾部日志（§4.2 BackgroundTaskStatus，
/// camelCase 直出；任务不存在由 manager 返回 tool.not_found 风格错误透传）
async fn action_status(
    manager: &dyn crate::background::BackgroundTaskManager,
    args: &Value,
) -> Result<Value, ToolError> {
    let task_id = super::require_string(args, "taskId")?;
    let status = manager.status(&task_id).await?;
    serialize_contract(&status)
}

/// read_log action：按行范围读取日志（§4.4 LogSlice；startLine 缺省 = None
/// 读尾部 maxLines 行，maxLines 缺省 100）
async fn action_read_log(
    manager: &dyn crate::background::BackgroundTaskManager,
    args: &Value,
) -> Result<Value, ToolError> {
    let task_id = super::require_string(args, "taskId")?;
    let start_line = super::optional_u64(args, "startLine");
    let max_lines = super::optional_u64(args, "maxLines").unwrap_or(DEFAULT_MAX_LINES);
    let slice = manager.read_log(&task_id, start_line, max_lines).await?;
    serialize_contract(&slice)
}

/// send_input action：向任务 stdin 写入（appendNewline 缺省 true 追加换行；
/// 失败由 manager 分类——stdin_closed 等结构化错误原样透传，不吞不改写）
async fn action_send_input(
    manager: &dyn crate::background::BackgroundTaskManager,
    args: &Value,
) -> Result<Value, ToolError> {
    let task_id = super::require_string(args, "taskId")?;
    let text = super::require_string(args, "text")?;
    let append_newline = super::optional_bool(args, "appendNewline").unwrap_or(true);
    manager.send_input(&task_id, &text, append_newline).await?;
    Ok(serde_json::json!({}))
}

/// kill action：两阶段终止任务（§4.4 KillResult 三态；任务不存在 →
/// manager 返回 NotFound 风格错误透传）
async fn action_kill(
    manager: &dyn crate::background::BackgroundTaskManager,
    args: &Value,
) -> Result<Value, ToolError> {
    let task_id = super::require_string(args, "taskId")?;
    let result = manager.kill(&task_id).await?;
    serialize_contract(&result)
}

/// 契约类型出站：冻结契约序列化类型（camelCase / kebab-case serde 已内建）
/// 直接转 JSON；理论上不可能失败（均为可序列化类型），map_err 保持诚实
fn serialize_contract<T: serde::Serialize>(value: &T) -> Result<Value, ToolError> {
    serde_json::to_value(value)
        .map_err(|e| ToolError::execution_failed("background_task", e.to_string()))
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：本测试仅用 mock manager，不涉及产品删除路径。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::background::{
        BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef,
        BackgroundTaskStatus, KillResult, LogSlice, ResourceSample, TaskState,
    };
    use crate::context::create_mock_tool_context;
    use std::sync::{Arc, Mutex};

    // ── 测试替身 ──────────────────────────────────────────────────

    /// 记录式后台任务管理器：逐调用记录五 action 入参，按预设结果应答
    /// （adopt 不在工具面内，mock 一律返回未实现错误）
    #[derive(Debug)]
    struct RecordingBackgroundManager {
        list_calls: Mutex<Vec<bool>>,
        status_calls: Mutex<Vec<String>>,
        read_log_calls: Mutex<Vec<(String, Option<u64>, u64)>>,
        send_input_calls: Mutex<Vec<(String, String, bool)>>,
        kill_calls: Mutex<Vec<String>>,
        list_result: Result<Vec<BackgroundTaskInfo>, ToolError>,
        status_result: Result<BackgroundTaskStatus, ToolError>,
        read_log_result: Result<LogSlice, ToolError>,
        send_input_result: Result<(), ToolError>,
        kill_result: Result<KillResult, ToolError>,
    }

    impl RecordingBackgroundManager {
        fn new(
            list_result: Result<Vec<BackgroundTaskInfo>, ToolError>,
            status_result: Result<BackgroundTaskStatus, ToolError>,
            read_log_result: Result<LogSlice, ToolError>,
            send_input_result: Result<(), ToolError>,
            kill_result: Result<KillResult, ToolError>,
        ) -> Self {
            Self {
                list_calls: Mutex::new(Vec::new()),
                status_calls: Mutex::new(Vec::new()),
                read_log_calls: Mutex::new(Vec::new()),
                send_input_calls: Mutex::new(Vec::new()),
                kill_calls: Mutex::new(Vec::new()),
                list_result,
                status_result,
                read_log_result,
                send_input_result,
                kill_result,
            }
        }

        fn list_calls(&self) -> Vec<bool> {
            self.list_calls.lock().unwrap().clone()
        }

        fn status_calls(&self) -> Vec<String> {
            self.status_calls.lock().unwrap().clone()
        }

        fn read_log_calls(&self) -> Vec<(String, Option<u64>, u64)> {
            self.read_log_calls.lock().unwrap().clone()
        }

        fn send_input_calls(&self) -> Vec<(String, String, bool)> {
            self.send_input_calls.lock().unwrap().clone()
        }

        fn kill_calls(&self) -> Vec<String> {
            self.kill_calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl BackgroundTaskManager for RecordingBackgroundManager {
        async fn adopt(
            &self,
            _req: BackgroundAdoptRequest,
        ) -> Result<BackgroundTaskRef, ToolError> {
            Err(ToolError::new(
                codes::COMMON_UNSUPPORTED,
                "mock 不实现 adopt（工具面不消费）",
            ))
        }

        async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
            self.list_calls.lock().unwrap().push(include_finished);
            self.list_result.clone()
        }

        async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
            self.status_calls.lock().unwrap().push(task_id.to_string());
            self.status_result.clone()
        }

        async fn read_log(
            &self,
            task_id: &str,
            start_line: Option<u64>,
            max_lines: u64,
        ) -> Result<LogSlice, ToolError> {
            self.read_log_calls
                .lock()
                .unwrap()
                .push((task_id.to_string(), start_line, max_lines));
            self.read_log_result.clone()
        }

        async fn send_input(
            &self,
            task_id: &str,
            text: &str,
            append_newline: bool,
        ) -> Result<(), ToolError> {
            self.send_input_calls.lock().unwrap().push((
                task_id.to_string(),
                text.to_string(),
                append_newline,
            ));
            self.send_input_result.clone()
        }

        async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
            self.kill_calls.lock().unwrap().push(task_id.to_string());
            self.kill_result.clone()
        }
    }

    // ── 契约样例数据 ──────────────────────────────────────────────

    /// 运行中任务样例（§4.2 字段齐全，resource/prompt 置 None 验证可空）
    fn sample_task_info(task_id: &str) -> BackgroundTaskInfo {
        BackgroundTaskInfo {
            task_id: task_id.to_string(),
            command: "npm install".to_string(),
            cwd: "C:/work".to_string(),
            status: TaskState::Running,
            started_at_ms: 1_700_000_000,
            duration_ms: 12_345,
            finished_at_ms: None,
            exit_code: None,
            log_path: format!("logs/tasks/{task_id}.log"),
            line_count: 42,
            last_output_at_ms: 1_700_000_012,
            is_daemon: false,
            resource: None,
            prompt: None,
            owner_run_id: None,
            // 契约样例：无卡死标记（对齐 14-T2a suspicious 字段新增后的全字段构造）
            suspicious: false,
        }
    }

    /// 终态任务样例（含 resource 采样与 ownerRunId，验证可空字段有值路径）
    fn sample_task_info_finished(task_id: &str) -> BackgroundTaskInfo {
        BackgroundTaskInfo {
            status: TaskState::Completed,
            duration_ms: 12_345,
            finished_at_ms: Some(1_700_000_020),
            exit_code: Some(0),
            resource: Some(ResourceSample {
                sampled_at_ms: 1_700_000_015,
                cpu_percent: 3.5,
                rss_bytes: 12_288,
                last_output_at_ms: 1_700_000_012,
                io_read_bytes: 0,
                io_write_bytes: 0,
            }),
            prompt: Some("Are you sure? [Y/n]".to_string()),
            owner_run_id: Some("run-7".to_string()),
            ..sample_task_info(task_id)
        }
    }

    fn sample_status(task_id: &str) -> BackgroundTaskStatus {
        BackgroundTaskStatus {
            task_id: task_id.to_string(),
            status: TaskState::Running,
            exit_code: None,
            log_path: format!("logs/tasks/{task_id}.log"),
            duration_ms: 12_345,
            line_count: 42,
            last_output_at_ms: 1_700_000_012,
            resource: None,
            tail: "第 41 行\n第 42 行".to_string(),
            prompt: None,
            termination_diagnostics: Vec::new(),
        }
    }

    fn sample_log_slice(task_id: &str) -> LogSlice {
        LogSlice {
            task_id: task_id.to_string(),
            start_line: 1,
            end_line: 2,
            total_lines: 42,
            lines: vec!["第 1 行".to_string(), "第 2 行".to_string()],
            truncated: false,
        }
    }

    /// 默认记录器：全部成功应答
    fn recording_manager() -> Arc<RecordingBackgroundManager> {
        Arc::new(RecordingBackgroundManager::new(
            Ok(vec![
                sample_task_info("task-1"),
                sample_task_info_finished("task-2"),
            ]),
            Ok(sample_status("task-1")),
            Ok(sample_log_slice("task-1")),
            Ok(()),
            Ok(KillResult::Killed {
                task_id: "task-1".to_string(),
                via_force: false,
            }),
        ))
    }

    /// 工具 + 已接线上下文
    fn tool_with_manager(
        manager: Arc<dyn BackgroundTaskManager>,
    ) -> (BackgroundTaskTool, ToolContext) {
        let tool = BackgroundTaskTool::new();
        let ctx = ToolContext {
            background: Some(manager),
            ..create_mock_tool_context()
        };
        (tool, ctx)
    }

    // ── list：includeFinished 缺省与透传 ───────────────────────────

    #[tokio::test]
    async fn list_defaults_include_finished_false() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(&ctx, serde_json::json!({ "action": "list" }))
            .await
            .unwrap();
        assert_eq!(
            manager.list_calls(),
            vec![false],
            "includeFinished 缺省必须为 false（只返回活跃任务）"
        );
        // 出站形状：{ "tasks": [...] }，字段 camelCase
        assert_eq!(out["tasks"].as_array().unwrap().len(), 2);
        let first = &out["tasks"][0];
        assert_eq!(first["taskId"], "task-1");
        assert_eq!(first["status"], "running", "TaskState kebab-case 直出");
        assert_eq!(first["startedAtMs"], 1_700_000_000);
        assert_eq!(first["durationMs"], 12_345);
        assert_eq!(first["logPath"], "logs/tasks/task-1.log");
        assert_eq!(first["lineCount"], 42);
        assert_eq!(first["lastOutputAtMs"], 1_700_000_012);
        assert_eq!(first["isDaemon"], false);
        // 可空字段缺省值
        assert!(first.get("finishedAtMs").unwrap().is_null());
        assert!(first.get("exitCode").unwrap().is_null());
        assert!(first.get("resource").unwrap().is_null());
        assert!(first.get("prompt").unwrap().is_null());
        assert!(first.get("ownerRunId").unwrap().is_null());
        // snake_case 字段不得泄漏
        assert!(first.get("started_at_ms").is_none());
    }

    #[tokio::test]
    async fn list_include_finished_true_passed_and_full_shape() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "list", "includeFinished": true }),
            )
            .await
            .unwrap();
        assert_eq!(
            manager.list_calls(),
            vec![true],
            "includeFinished=true 必须透传"
        );
        // 终态任务字段有值路径（§4.2 全字段形状）
        let second = &out["tasks"][1];
        assert_eq!(second["status"], "completed");
        assert_eq!(second["finishedAtMs"], 1_700_000_020);
        assert_eq!(second["exitCode"], 0);
        assert_eq!(second["resource"]["cpuPercent"], 3.5);
        assert_eq!(second["resource"]["rssBytes"], 12_288);
        assert_eq!(second["prompt"], "Are you sure? [Y/n]");
        assert_eq!(second["ownerRunId"], "run-7");
    }

    // ── status：taskId 校验与出站形状 ──────────────────────────────

    #[tokio::test]
    async fn status_requires_task_id() {
        let (tool, ctx) = tool_with_manager(recording_manager() as Arc<dyn BackgroundTaskManager>);
        let err = tool
            .execute(&ctx, serde_json::json!({ "action": "status" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }

    #[tokio::test]
    async fn status_returns_camel_case_shape() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "status", "taskId": "task-1" }),
            )
            .await
            .unwrap();
        assert_eq!(manager.status_calls(), vec!["task-1".to_string()]);
        // §4.2 BackgroundTaskStatus camelCase 字段逐一断言
        assert_eq!(out["taskId"], "task-1");
        assert_eq!(out["status"], "running");
        assert!(out.get("exitCode").unwrap().is_null());
        assert_eq!(out["logPath"], "logs/tasks/task-1.log");
        assert_eq!(out["durationMs"], 12_345);
        assert_eq!(out["lineCount"], 42);
        assert_eq!(out["lastOutputAtMs"], 1_700_000_012);
        assert!(out.get("resource").unwrap().is_null());
        assert_eq!(out["tail"], "第 41 行\n第 42 行");
        assert!(out.get("prompt").unwrap().is_null());
        assert_eq!(out["terminationDiagnostics"], serde_json::json!([]));
    }

    // ── read_log：startLine 缺省语义与 maxLines 默认值 ─────────────

    #[tokio::test]
    async fn read_log_defaults_tail_and_max_lines_100() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        tool.execute(
            &ctx,
            serde_json::json!({ "action": "read_log", "taskId": "task-1" }),
        )
        .await
        .unwrap();
        assert_eq!(
            manager.read_log_calls(),
            vec![("task-1".to_string(), None, 100)],
            "startLine 缺省 = None（读尾部），maxLines 缺省 = 100"
        );
    }

    #[tokio::test]
    async fn read_log_explicit_range_passed() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        tool.execute(
            &ctx,
            serde_json::json!({
                "action": "read_log",
                "taskId": "task-1",
                "startLine": 5,
                "maxLines": 50
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            manager.read_log_calls(),
            vec![("task-1".to_string(), Some(5), 50)]
        );
    }

    #[tokio::test]
    async fn read_log_returns_shape() {
        let (tool, ctx) = tool_with_manager(recording_manager() as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "read_log", "taskId": "task-1" }),
            )
            .await
            .unwrap();
        // §4.4 LogSlice camelCase 字段逐一断言
        assert_eq!(out["taskId"], "task-1");
        assert_eq!(out["startLine"], 1);
        assert_eq!(out["endLine"], 2);
        assert_eq!(out["totalLines"], 42);
        assert_eq!(out["lines"], serde_json::json!(["第 1 行", "第 2 行"]));
        assert_eq!(out["truncated"], false);
    }

    // ── send_input：appendNewline 缺省与透传 ───────────────────────

    #[tokio::test]
    async fn send_input_defaults_append_newline_true() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "send_input", "taskId": "task-1", "text": "y" }),
            )
            .await
            .unwrap();
        assert_eq!(
            manager.send_input_calls(),
            vec![("task-1".to_string(), "y".to_string(), true)],
            "appendNewline 缺省必须为 true（追加换行提交输入）"
        );
        assert!(out.is_object(), "send_input 成功返回空对象信封");
    }

    #[tokio::test]
    async fn send_input_append_newline_false_passed() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        tool.execute(
            &ctx,
            serde_json::json!({
                "action": "send_input",
                "taskId": "task-1",
                "text": "ls -la",
                "appendNewline": false
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            manager.send_input_calls(),
            vec![("task-1".to_string(), "ls -la".to_string(), false)]
        );
    }

    #[tokio::test]
    async fn send_input_requires_text() {
        let (tool, ctx) = tool_with_manager(recording_manager() as Arc<dyn BackgroundTaskManager>);
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "send_input", "taskId": "task-1" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("text"));
    }

    // ── kill：三态出站形状（§4.4 KillResult）──────────────────────

    #[tokio::test]
    async fn kill_returns_killed_shape() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "kill", "taskId": "task-1" }),
            )
            .await
            .unwrap();
        assert_eq!(manager.kill_calls(), vec!["task-1".to_string()]);
        // 冻结契约 KillResult 的 serde 现状：外部标记 + variant 名 camelCase、
        // variant 内字段不受 rename_all 约束（保持 snake_case）——忠实序列化，
        // 形状偏差登记上报（见模块头注释「已知偏差」）
        assert_eq!(out["killed"]["task_id"], "task-1");
        assert_eq!(out["killed"]["via_force"], false);
    }

    #[tokio::test]
    async fn kill_returns_other_variants_shape() {
        // AlreadyExited：进程已不存在（自然退出），携带退出码
        let manager = Arc::new(RecordingBackgroundManager::new(
            Ok(vec![]),
            Ok(sample_status("task-2")),
            Ok(sample_log_slice("task-2")),
            Ok(()),
            Ok(KillResult::AlreadyExited {
                task_id: "task-2".to_string(),
                exit_code: Some(3),
            }),
        ));
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "kill", "taskId": "task-2" }),
            )
            .await
            .unwrap();
        assert_eq!(out["alreadyExited"]["task_id"], "task-2");
        assert_eq!(out["alreadyExited"]["exit_code"], 3);

        // Failed：终止失败附原因
        let manager = Arc::new(RecordingBackgroundManager::new(
            Ok(vec![]),
            Ok(sample_status("task-3")),
            Ok(sample_log_slice("task-3")),
            Ok(()),
            Ok(KillResult::Failed {
                task_id: "task-3".to_string(),
                reason: "两阶段终止均未收到退出".to_string(),
            }),
        ));
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "kill", "taskId": "task-3" }),
            )
            .await
            .unwrap();
        assert_eq!(out["failed"]["task_id"], "task-3");
        assert!(out["failed"]["reason"].as_str().unwrap().contains("两阶段"));
    }

    // ── 错误协议：未接线 / manager 错误透传 ────────────────────────

    #[tokio::test]
    async fn background_none_returns_structured_unavailable() {
        let tool = BackgroundTaskTool::new();
        let ctx = create_mock_tool_context();
        for args in [
            serde_json::json!({ "action": "list" }),
            serde_json::json!({ "action": "status", "taskId": "task-1" }),
            serde_json::json!({ "action": "read_log", "taskId": "task-1" }),
            serde_json::json!({ "action": "send_input", "taskId": "task-1", "text": "y" }),
            serde_json::json!({ "action": "kill", "taskId": "task-1" }),
        ] {
            let err = tool.execute(&ctx, args).await.unwrap_err();
            assert_eq!(
                err.code(),
                "common.unsupported",
                "未接线必须返回 common.unsupported"
            );
            assert!(
                err.to_string().contains("未接线"),
                "未接线错误必须明示「未接线」：{err}"
            );
            assert!(err.to_string().contains("后台任务管理"));
        }
    }

    #[tokio::test]
    async fn manager_not_found_error_propagates() {
        // 任务不存在：manager 返回 NotFound 风格错误（tool.not_found），
        // 工具必须原样透传（不改码、不改写消息）
        let not_found = ToolError::new(
            codes::TOOL_NOT_FOUND,
            "任务不存在：task-999（已归档，日志文件仍在 logs/tasks/task-999.log）",
        );
        let manager = Arc::new(RecordingBackgroundManager::new(
            Ok(vec![]),
            Err(not_found.clone()),
            Ok(sample_log_slice("task-1")),
            Ok(()),
            Err(not_found.clone()),
        ));
        let (tool, ctx) = tool_with_manager(manager as Arc<dyn BackgroundTaskManager>);
        // status 透传 manager 的 not_found
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "status", "taskId": "task-999" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        assert_eq!(err.to_string(), not_found.to_string(), "错误消息原样透传");
        // kill 透传 manager 的 not_found
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "kill", "taskId": "task-999" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    }

    #[tokio::test]
    async fn send_input_stdin_closed_error_propagates() {
        // send_input 失败分类（stdin_closed）：manager 返回结构化错误，
        // 工具必须原样透传（任务可能已退出，AI 依据消息调整策略）
        let stdin_closed = ToolError::new(
            codes::TOOL_EXECUTION_FAILED,
            "send_input 失败：stdin_closed（任务可能已退出，请用 status 确认）",
        );
        let manager = Arc::new(RecordingBackgroundManager::new(
            Ok(vec![]),
            Ok(sample_status("task-1")),
            Ok(sample_log_slice("task-1")),
            Err(stdin_closed.clone()),
            Ok(KillResult::Killed {
                task_id: "task-1".to_string(),
                via_force: false,
            }),
        ));
        let (tool, ctx) = tool_with_manager(manager as Arc<dyn BackgroundTaskManager>);
        let err = tool
            .execute(
                &ctx,
                serde_json::json!({ "action": "send_input", "taskId": "task-1", "text": "y" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
        assert_eq!(err.to_string(), stdin_closed.to_string());
        assert!(err.to_string().contains("stdin_closed"));
    }

    // ── 入参校验 ──────────────────────────────────────────────────

    #[tokio::test]
    async fn action_required() {
        let (tool, ctx) = tool_with_manager(recording_manager() as Arc<dyn BackgroundTaskManager>);
        let err = tool.execute(&ctx, serde_json::json!({})).await.unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("action"));
    }

    #[tokio::test]
    async fn unknown_action_rejected() {
        let manager = recording_manager();
        let (tool, ctx) = tool_with_manager(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>);
        let err = tool
            .execute(&ctx, serde_json::json!({ "action": "explode" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("explode"));
        // 未知 action 不得触碰 manager（零副作用：manager 未发生任何调用）
        assert!(manager.list_calls().is_empty());
        assert!(manager.status_calls().is_empty());
        assert!(manager.kill_calls().is_empty());
    }

    // ── description 边界声明（防 AI 误用）──────────────────────────

    #[test]
    fn description_contains_boundary_declarations() {
        let tool = BackgroundTaskTool::new();
        let desc = &tool.definition().description;
        // 非 PTY 管道 stdin：仅适用于 [Y/n] 确认与逐行输入
        assert!(desc.contains("PTY"), "必须声明非 PTY 管道边界：{desc}");
        assert!(
            desc.contains("[Y/n]"),
            "必须声明 [Y/n] 确认适用场景：{desc}"
        );
        // 全屏 TUI（fzf / vi）引导用户用终端面板
        assert!(desc.contains("fzf"), "必须点名 fzf：{desc}");
        assert!(desc.contains("vi"), "必须点名 vi：{desc}");
        assert!(desc.contains("终端面板"), "必须引导用户用终端面板：{desc}");
        // timeoutMs 与 waitMsBeforeAsync 两个维度 + 无限运行语义
        assert!(
            desc.contains("timeoutMs"),
            "必须声明 timeoutMs 维度：{desc}"
        );
        assert!(
            desc.contains("waitMsBeforeAsync"),
            "必须声明 waitMsBeforeAsync 维度：{desc}"
        );
        assert!(
            desc.contains("无限运行"),
            "必须声明转后台默认无限运行：{desc}"
        );
        // 终止路径：kill 与健康判定通知
        assert!(desc.contains("kill"), "必须声明 kill 终止路径：{desc}");
        assert!(desc.contains("健康判定"), "必须声明健康判定通知：{desc}");
    }
}
