//! 命令执行工具（任务书 B5.2：shell_command）
//!
//! 执行链路：
//! 1. Windows 包装：系统 PowerShell + -EncodedCommand（UTF-16LE → base64），
//!    命令体再经 UTF-8 → base64 包进 scriptblock，避免引号/管道被外壳二次解析
//! 2. 执行：tokio 子进程，stdout/stderr 管道收集，超时树杀，输出按上限截断

use crate::audit::{NoopAuditSink, SecurityAuditSink};
use crate::background::BackgroundTaskManager;
use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::streaming::{terminal_only, ToolStream};
use crate::tools::{
    display_path, optional_bool, optional_string, optional_u64, require_string,
    resolve_workspace_path,
};
use async_trait::async_trait;
use conex_types::events::SecurityAuditOperation;
use std::path::PathBuf;
use std::sync::Arc;

/// 越界命令：需上层审批（保留供错误码兼容）
#[allow(dead_code)]
pub(crate) const TOOL_REQUIRES_APPROVAL: &str = "tool.requires_approval";
/// 红线命令：直接拒绝（保留供错误码兼容）
#[allow(dead_code)]
pub(crate) const TOOL_COMMAND_BLOCKED: &str = "tool.command_blocked";
/// 用户明确拒绝（保留供错误码兼容）
#[allow(dead_code)]
pub(crate) const TOOL_USER_DENIED: &str = "tool.user_denied";

/// 命令长度上限（对齐 workbench_run_shell）
const MAX_COMMAND_LEN: usize = 32_000;
/// 超时上限（毫秒）
const MAX_TIMEOUT_MS: u64 = 600_000;

/// cd 形态拦截错误码（已废除）
#[allow(dead_code)]
pub(crate) const TOOL_CD_BLOCKED: &str = "tool.cd_blocked";

/// auto-background 模式等待窗口缺省值（毫秒，T-AB-02）
const DEFAULT_WAIT_MS_BEFORE_ASYNC: u64 = 3_000;

/// 命令执行工具
pub(crate) struct ShellCommandTool {
    def: ToolDefinition,
    default_timeout_ms: u64,
    max_output_bytes: usize,
    /// 回收站根（保持构造器参数兼容）
    #[allow(dead_code)]
    trash_root: Option<PathBuf>,
    /// 安全审计 sink（保持构造器参数兼容）
    #[allow(dead_code)]
    audit_sink: Arc<dyn SecurityAuditSink>,
    /// 后台任务管理器（T-AB-02：None = 未接线，超时保持「树杀」现状；
    /// 执行期优先读 ToolContext.background，回退本字段）
    background_manager: Option<Arc<dyn BackgroundTaskManager>>,
}

impl ShellCommandTool {
    /// 新建命令工具（默认 no-op 审计 sink）。G11a 备注：非 test 构建无
    /// 生产消费者（注册面统一经 with_audit_sink 注入审计 sink），本构造器
    /// 供测试直接覆盖——dead_code 静音。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(
        default_timeout_ms: u64,
        max_output_bytes: usize,
        trash_root: Option<PathBuf>,
    ) -> Self {
        Self::with_audit_sink(
            default_timeout_ms,
            max_output_bytes,
            trash_root,
            Arc::new(NoopAuditSink),
        )
    }

    /// 新建命令工具并注入审计 sink（I2-S8 发射点接线；默认 no-op）
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_audit_sink(
        default_timeout_ms: u64,
        max_output_bytes: usize,
        trash_root: Option<PathBuf>,
        audit_sink: Arc<dyn SecurityAuditSink>,
    ) -> Self {
        Self::with_background_manager(
            default_timeout_ms,
            max_output_bytes,
            trash_root,
            audit_sink,
            None,
        )
    }

    /// 新建命令工具并注入后台任务管理器（T-AB-02 注册面接线点：
    /// BuiltinToolConfig.background_manager 透传；None = 未接线保持现状）
    pub(crate) fn with_background_manager(
        default_timeout_ms: u64,
        max_output_bytes: usize,
        trash_root: Option<PathBuf>,
        audit_sink: Arc<dyn SecurityAuditSink>,
        background_manager: Option<Arc<dyn BackgroundTaskManager>>,
    ) -> Self {
        Self {
            def: ToolDefinition {
                name: "shell_command".to_string(),
                description: "执行项目命令并等待完成（git status、快速脚本等）。\
                              timeoutMs 为 AI 显式设置的绝对长跑防护上限，waitMsBeforeAsync 为 auto-background 模式的\
                              转后台等待窗口——两个维度独立。转后台任务默认无限运行，终止依赖 kill 工具\
                              或健康判定通知。"
                    .to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的命令" },
                        "cwd": { "type": "string", "description": "工作目录（工作区内相对或绝对路径），缺省为工作区根" },
                        "timeoutMs": { "type": "number", "description": "超时毫秒数（默认 30000），AI 显式设置的绝对长跑防护上限；与 waitMsBeforeAsync（转后台窗口）是两个维度" },
                        "maxOutputBytes": { "type": "number", "description": "保留输出上限（字节），默认 200000" },
                        "mode": {
                            "type": "string",
                            "enum": ["sync", "auto-background", "daemon"],
                            "description": "执行模式（默认 sync）：sync 同步等待、超时树杀；auto-background 等待窗口（waitMsBeforeAsync）后转后台托管（不杀进程）；daemon 立即转后台守护（run 结束不回收）"
                        },
                        "waitMsBeforeAsync": { "type": "number", "description": "auto-background 模式的等待窗口毫秒数（默认 3000）：窗口内完成返回同步结果，窗口超时转后台" },
                        "isDaemon": { "type": "boolean", "description": "守护标记（daemon 模式专用）：true 时 spawn 后立即转后台，不经过等待窗口" },
                        "resourceMonitor": { "type": "boolean", "description": "资源监控开关（默认 false）：true 时后台任务启用 CPU/内存/IO 采样" }
                    },
                    "required": ["command"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
            default_timeout_ms,
            max_output_bytes,
            trash_root,
            audit_sink,
            background_manager,
        }
    }
}

/// 预检结果（execute / execute_stream 共用准备面）：
/// - `Run`：通过参数校验，携带执行参数；
/// - `Done`：入参错误等既定结果。
enum Prepared {
    Run(PreparedCommand),
    Done(Result<serde_json::Value, ToolError>),
}

/// u64 → usize 钳制转换（F3-16）：32 位平台裸 `as usize` 截断防护
fn clamp_u64_to_usize(value: u64) -> usize {
    value.min(usize::MAX as u64) as usize
}

/// 通过预检的可执行命令参数（execute / execute_stream 消费）
pub(crate) struct PreparedCommand {
    command: String,
    cwd: PathBuf,
    timeout_ms: u64,
    max_output_bytes: usize,
    mode: ShellMode,
    wait_ms: u64,
    is_daemon: bool,
    resource_monitor: bool,
    manager: Option<Arc<dyn BackgroundTaskManager>>,
}

impl ShellCommandTool {
    /// 预检（execute / execute_stream 共用）：
    ///
    /// 负责入参校验 + **执行行为安全门**（非权限裁决，裁决唯一入口在
    /// session-loop `call_verdict`）：
    /// - 门禁静态红线 / 系统关键 cwd 一律阻断（审计 decision=blocked）；
    /// - 删除形态 → 回收站 WAL 重定向（永不物理删除）；
    /// - cd 形态拦截（引导使用 Cwd 参数）；
    /// - 绝对路径围栏（系统关键目录 + 工作区外写/删阻断）。
    async fn prepare(&self, ctx: &ToolContext, args: &serde_json::Value) -> Prepared {
        let command = match require_string(args, "command") {
            Ok(c) => c.trim().to_string(),
            Err(e) => return Prepared::Done(Err(e)),
        };
        if command.is_empty() {
            return Prepared::Done(Err(ToolError::invalid_input(
                "command must be a non-empty string",
            )));
        }
        if command.len() > MAX_COMMAND_LEN {
            return Prepared::Done(Err(ToolError::invalid_input("command too long")));
        }
        let workspace_root = &ctx.workspace_root;
        let cwd = match resolve_workspace_path(
            workspace_root,
            &optional_string(args, "cwd").unwrap_or_else(|| ".".to_string()),
        ) {
            Ok(c) => c,
            Err(e) => return Prepared::Done(Err(e)),
        };
        if !cwd.is_dir() {
            return Prepared::Done(Err(ToolError::invalid_input(format!(
                "cwd is not a directory: {}",
                display_path(workspace_root, &cwd)
            ))));
        }
        let timeout_ms = optional_u64(args, "timeoutMs")
            .unwrap_or(self.default_timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);
        let max_output_bytes = clamp_u64_to_usize(
            optional_u64(args, "maxOutputBytes").unwrap_or(self.max_output_bytes as u64),
        );
        let mode = match parse_mode(args) {
            Ok(m) => m,
            Err(e) => return Prepared::Done(Err(e)),
        };
        let wait_ms = optional_u64(args, "waitMsBeforeAsync")
            .unwrap_or(DEFAULT_WAIT_MS_BEFORE_ASYNC)
            .clamp(1, MAX_TIMEOUT_MS);
        let is_daemon =
            mode == ShellMode::Daemon || optional_bool(args, "isDaemon").unwrap_or(false);
        let resource_monitor = optional_bool(args, "resourceMonitor").unwrap_or(false);

        // ── 执行行为安全门（与权限模式无关的物理底线）──────────────
        let analysis = conex_sandbox::semantics::analyze(&command);
        let full_line = command.clone();
        let gate_result = conex_sandbox::gatekeeper::SHARED_GATEKEEPER
            .check_command_with_context_and_analysis(
                &analysis,
                &command,
                &[],
                &full_line,
                &shell_redirect::gate_path(&cwd),
                &shell_redirect::gate_path(workspace_root),
            );

        if gate_result == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
            || conex_fs::ConexPathNormalizer::is_system_critical_path(&cwd)
        {
            shell_redirect::emit_blocked_audit(
                &self.audit_sink,
                ctx,
                SecurityAuditOperation::CommandExec,
                vec![command.clone()],
            );
            return Prepared::Done(Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                format!(
                    "PermissionDenied: Command blocked by safety red-line gatekeeper: {command}"
                ),
            )));
        }

        // 删除形态 → 回收站（任何模式都不得物理抹除）
        if analysis.overall_class == conex_sandbox::semantics::CommandClass::DeleteShape
            || analysis.has_indirect_delete
        {
            return Prepared::Done(shell_redirect::redirect_or_intercept_delete(
                &analysis,
                &command,
                workspace_root,
                &cwd,
                self.trash_root.clone(),
                ctx,
                Arc::clone(&self.audit_sink),
            ));
        }

        // cd 形态 → 引导使用 Cwd 参数
        if let Some(err) = shell_redirect::intercept_cd_shape(&analysis, &command) {
            return Prepared::Done(Err(err));
        }

        // 绝对路径围栏（系统关键目录 + 工作区外写/删）
        if let Err(e) = shell_path_guard::CommandPathInspector::inspect(&command, workspace_root) {
            shell_redirect::emit_blocked_audit(
                &self.audit_sink,
                ctx,
                SecurityAuditOperation::CommandExec,
                vec![command.clone()],
            );
            return Prepared::Done(Err(e));
        }

        let manager = ctx
            .background
            .clone()
            .or_else(|| self.background_manager.clone());
        Prepared::Run(PreparedCommand {
            command,
            cwd,
            timeout_ms,
            max_output_bytes,
            mode,
            wait_ms,
            is_daemon,
            resource_monitor,
            manager,
        })
    }
}

#[async_trait]
impl Tool for ShellCommandTool {
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
        match self.prepare(ctx, &args).await {
            Prepared::Done(result) => result,
            Prepared::Run(c) => {
                run_command_maybe_background(
                    &c.command,
                    &c.cwd,
                    c.timeout_ms,
                    c.max_output_bytes,
                    c.mode,
                    c.wait_ms,
                    c.is_daemon,
                    c.resource_monitor,
                    c.manager,
                    ctx.log_root.clone(),
                    &ctx.session_id,
                )
                .await
            }
        }
    }

    async fn execute_stream(&self, ctx: &ToolContext, args: serde_json::Value) -> ToolStream {
        if parse_mode(&args).unwrap_or(ShellMode::Sync) != ShellMode::Sync {
            return terminal_only(self.execute(ctx, args).await);
        }
        match self.prepare(ctx, &args).await {
            Prepared::Done(result) => terminal_only(result),
            Prepared::Run(c) => run_command_streaming(ctx, c).await,
        }
    }
}

// ==================== 拆分接线 ====================
#[path = "shell_exec.rs"]
mod shell_exec;
#[path = "shell_invoke.rs"]
mod shell_invoke;
#[path = "shell_output.rs"]
mod shell_output;
#[path = "shell_path_guard.rs"]
mod shell_path_guard;
#[path = "shell_redirect.rs"]
mod shell_redirect;

pub(crate) use shell_exec::{run_command_maybe_background, run_command_streaming};
pub(crate) use shell_invoke::{parse_mode, ShellMode};

#[cfg(test)]
#[path = "shell_tests/mod.rs"]
mod tests;
