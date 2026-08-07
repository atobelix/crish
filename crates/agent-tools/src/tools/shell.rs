//! 命令执行工具（任务书 B5.2：shell_command）
//!
//! 执行链路（对齐 05 §5.5 tools::shell 与 Tauri 壳 workbench_run_shell 语义）：
//! 1. 命令门禁：conex-sandbox CommandGatekeeper 检查，Blocked → tool.command_blocked，
//!    RequiresApproval → 经 ctx.ask 审批通道发起真实审批（R4 T10；未接线时
//!    返回 tool.requires_approval，执行器分类为 ApprovalRequired 透传审批状态）
//! 2. 删除形态重定向（I2-S4）：semantics 判定 DeleteShape 的命令不再直接执行，
//!    改走删除接管接口（conex-fs trash 服务，目标移入回收站并可恢复）；
//!    复合链 / 间接执行包裹删除形态整链拦截 + 引导（链内其他段副作用不可控）；
//!    工作区外目标一律拒绝。红线仍由门禁先行 100% 拦截（S2）。
//! 3. Windows 包装：系统 PowerShell + -EncodedCommand（UTF-16LE → base64），
//!    命令体再经 UTF-8 → base64 包进 scriptblock，避免引号/管道被外壳二次解析
//! 4. 执行：tokio 子进程，stdout/stderr 管道收集，超时树杀，输出按上限截断

use crate::audit::{NoopAuditSink, SecurityAuditSink, security_audit_event};
use crate::background::{BackgroundAdoptRequest, BackgroundTaskManager};
use crate::context::{AskDecision, ToolContext};
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{
    display_path, optional_bool, optional_string, optional_u64, require_string,
    resolve_workspace_path, delete::DEFAULT_TRASH_DIR_NAME,
};
use crate::write_paths::{claim_write_guard, ClaimMode};
use async_trait::async_trait;
use conex_fs::impact::ImpactAssessment;
use conex_fs::trash::TrashService;
use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
use conex_sandbox::semantics::{CommandClass, SemanticAnalysis};
use conex_types::events::{SecurityAuditDecision, SecurityAuditOperation};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::time::Duration;

/// 越界命令：需上层审批（error.code 供执行器路由到审批流）
pub(crate) const TOOL_REQUIRES_APPROVAL: &str = "tool.requires_approval";
/// 红线命令：直接拒绝
pub(crate) const TOOL_COMMAND_BLOCKED: &str = "tool.command_blocked";
/// 用户明确拒绝（ask 通道 Denied → Denied 语义）
pub(crate) const TOOL_USER_DENIED: &str = "tool.user_denied";

/// 命令长度上限（对齐 workbench_run_shell）
const MAX_COMMAND_LEN: usize = 32_000;
/// 超时上限（毫秒）
const MAX_TIMEOUT_MS: u64 = 600_000;

/// cd 形态拦截错误码（T-AB-04：A02 工具段，纯 cd / 复合链含 cd 段统一使用）
pub(crate) const TOOL_CD_BLOCKED: &str = "tool.cd_blocked";

/// 流式输出内存预览上限（T-AB-01：头部/尾部各 24KB，结果侧不驻留全量字节）
const PREVIEW_HEAD_BYTES: usize = 24 * 1024;
/// 流式输出内存预览上限（T-AB-01：尾部 24KB）
const PREVIEW_TAIL_BYTES: usize = 24 * 1024;

/// auto-background 模式等待窗口缺省值（毫秒，T-AB-02）
const DEFAULT_WAIT_MS_BEFORE_ASYNC: u64 = 3_000;

/// 命令执行工具
pub(crate) struct ShellCommandTool {
    def: ToolDefinition,
    default_timeout_ms: u64,
    max_output_bytes: usize,
    /// 删除重定向的回收站根（I2-S4：None 时执行期回退工作区 `.crish-trash`，
    /// 与 delete 工具共用 `BuiltinToolConfig.trash_root`）
    trash_root: Option<PathBuf>,
    /// 安全审计 sink（I2-S8：重定向/拦截发射 security-audit；未接线时 no-op）
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
                description: "执行项目命令并等待完成（git status、快速脚本等）。先经命令门禁检查，越界命令需审批。\
                              timeoutMs 为 AI 显式设置的绝对长跑防护上限，waitMsBeforeAsync 为 auto-background 模式的\
                              转后台等待窗口——两个维度独立。转后台任务默认无限运行，终止依赖 kill 工具（R-AB2 交付）\
                              或健康判定通知（R-AB3 交付）。"
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
                        "resourceMonitor": { "type": "boolean", "description": "资源监控开关（默认 false）：true 时后台任务启用 CPU/内存/IO 采样（R-AB3 接线）" }
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
        let command = require_string(&args, "command")?.trim().to_string();
        if command.is_empty() {
            return Err(ToolError::invalid_input(
                "command must be a non-empty string",
            ));
        }
        if command.len() > MAX_COMMAND_LEN {
            return Err(ToolError::invalid_input("command too long"));
        }
        let workspace_root = &ctx.workspace_root;
        let cwd = resolve_workspace_path(
            workspace_root,
            &optional_string(&args, "cwd").unwrap_or_else(|| ".".to_string()),
        )?;
        if !cwd.is_dir() {
            return Err(ToolError::invalid_input(format!(
                "cwd is not a directory: {}",
                display_path(workspace_root, &cwd)
            )));
        }
        let timeout_ms = optional_u64(&args, "timeoutMs")
            .unwrap_or(self.default_timeout_ms)
            .clamp(1, MAX_TIMEOUT_MS);
        let max_output_bytes =
            optional_u64(&args, "maxOutputBytes").unwrap_or(self.max_output_bytes as u64) as usize;
        // T-AB-02：三模式入参（mode / waitMsBeforeAsync / isDaemon / resourceMonitor）
        let mode = parse_mode(&args)?;
        let wait_ms = optional_u64(&args, "waitMsBeforeAsync")
            .unwrap_or(DEFAULT_WAIT_MS_BEFORE_ASYNC)
            .clamp(1, MAX_TIMEOUT_MS);
        let is_daemon =
            mode == ShellMode::Daemon || optional_bool(&args, "isDaemon").unwrap_or(false);
        let resource_monitor = optional_bool(&args, "resourceMonitor").unwrap_or(false);

        // 命令门禁：越界/危险命令在解析前先拦下（对齐 workbench_run_shell）
        // 上下文字符串统一为门禁比较格式：剥离 \\?\ 前缀、反斜杠转斜杠、Windows 小写
        let gatekeeper = CommandGatekeeper::new();
        let cwd_str = gate_path(&cwd);
        let root_str = gate_path(workspace_root);
        let verdict = gatekeeper.check_command_with_context(&command, &[], &cwd_str, &root_str);
        if verdict == GatekeeperResult::Blocked || gatekeeper.patterns().is_match(&command) {
            // I2-S8：红线拦截审计事件（decision=blocked，operation=command-exec）
            emit_blocked_audit(
                &self.audit_sink,
                ctx,
                SecurityAuditOperation::CommandExec,
                vec![command.clone()],
            );
            return Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                format!(
                    "PermissionDenied: Command blocked by safety red-line gatekeeper: {command}"
                ),
            ));
        }
        if verdict == GatekeeperResult::RequiresApproval {
            // R4 T10：经 ctx.ask 审批通道发起真实审批——approval-requested
            // 事件由通道侧记录并广播，等待用户裁决（abort 可取消）；
            // 用户同意后继续执行（等价重试该命令），拒绝返回明确拒绝结果。
            // 未接线（ask: None）时返回 tool.requires_approval，执行器
            // 分类为 ApprovalRequired 透传审批状态（不再折叠 SoftDeny）。
            match &ctx.ask {
                Some(ask) => match ask.ask(&self.def.name, &args).await {
                    Ok(AskDecision::Allowed) => {}
                    Ok(AskDecision::Denied { reason }) => {
                        return Err(ToolError::new(
                            TOOL_USER_DENIED,
                            format!("user denied: {reason}"),
                        ));
                    }
                    Err(err) => return Err(err),
                },
                None => {
                    return Err(ToolError::new(
                        TOOL_REQUIRES_APPROVAL,
                        format!("Command requires approval: {command}"),
                    ));
                }
            }
        }

        // I2-S4：删除形态重定向——semantics 判定 DeleteShape 的命令不再直接
        // 执行，改走删除接管接口（trash 服务，移入回收站可恢复）；复合链 /
        // 间接执行包裹删除形态整链拦截 + 引导。红线（Redline）已由上方门禁
        // 100% 拦截（S2），此处只处理删除形态。
        let analysis = conex_sandbox::semantics::analyze(&command);
        if analysis.overall_class == CommandClass::DeleteShape || analysis.has_indirect_delete {
            return redirect_or_intercept_delete(
                &analysis,
                &command,
                workspace_root,
                &cwd,
                self.trash_root.clone(),
                ctx,
                Arc::clone(&self.audit_sink),
            );
        }

        // T-AB-04：第五项「cd 形态」拦截（判定优先级：门禁 → 删除形态 →
        // cd 形态 → 执行；`cd x && rm -rf y` 同时命中时删除形态已先行拦截，
        // 此处只处理残留的 cd 形态）——纯 cd 命令结构化错误（tool.cd_blocked），
        // 复合链含 cd 段整链拦截 + 引导（链内其他段依赖目录状态，不代为执行）。
        if let Some(err) = intercept_cd_shape(&analysis, &command) {
            return Err(err);
        }

        // 执行：三模式（manager 优先读会话级 ToolContext.background，回退注册配置）
        let manager = ctx
            .background
            .clone()
            .or_else(|| self.background_manager.clone());
        run_command_maybe_background(
            &command,
            &cwd,
            timeout_ms,
            max_output_bytes,
            mode,
            wait_ms,
            is_daemon,
            resource_monitor,
            manager,
            ctx.log_root.clone(),
            &ctx.session_id,
        )
        .await
    }
}

/// 删除形态引导文案（模型可改走统一删除接口）
const DELETE_REDIRECT_GUIDANCE: &str =
    "如确需删除请改用 delete_file / delete_dir 工具（统一删除接口，可恢复）";

/// 拦截类审计发射（I2-S8：decision=blocked；targets 为被拦目标/命令原文；
/// 影响面未知 → 空载荷，与审计字段语义一致——操作未执行）
fn emit_blocked_audit(
    audit_sink: &Arc<dyn SecurityAuditSink>,
    ctx: &ToolContext,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
) {
    audit_sink.emit(&security_audit_event(
        &ctx.session_id,
        operation,
        targets,
        ImpactAssessment::default(),
        SecurityAuditDecision::Blocked,
        None,
    ));
}

/// 删除形态重定向（I2-S4 主入口）：
/// - 间接执行包裹删除形态 → 整链拦截 + 引导（外层无法安全解析内层目标）；
/// - 复合链含删除段 → 整链拦截 + 引导（链内其他段副作用不可控，不代为执行）；
/// - 纯删除命令 → 解析目标（工作区外一律拒绝）→ trash 服务移入回收站 →
///   返回 TrashEntry 列表（entryId 供恢复）+ 影响面审计载荷。
///
/// 审计（I2-S8）：拦截分支发射 decision=blocked，成功重定向发射
/// decision=redirected（影响面来自预检）。
fn redirect_or_intercept_delete(
    analysis: &SemanticAnalysis,
    command: &str,
    workspace_root: &Path,
    cwd: &Path,
    trash_root: Option<PathBuf>,
    ctx: &ToolContext,
    audit_sink: Arc<dyn SecurityAuditSink>,
) -> Result<serde_json::Value, ToolError> {
    // 1. 间接执行包裹（bash -c 'rm x' / xargs rm 等）：内层目标无法安全解析，
    //    整链拦截 + 引导，防包裹绕过统一删除门禁
    if analysis.has_indirect_delete {
        emit_blocked_audit(
            &audit_sink,
            ctx,
            SecurityAuditOperation::Delete,
            vec![command.to_string()],
        );
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到间接执行包裹的物理删除形态（eval / bash -c / xargs 等），已拦截；{DELETE_REDIRECT_GUIDANCE}。原始命令：{command}"
            ),
        ));
    }
    // 2. 复合链：任一段命中删除形态 → 整链拦截（其他段副作用不可控，不代为执行）
    let has_non_delete_segment = analysis
        .segments
        .iter()
        .any(|s| s.class != CommandClass::DeleteShape);
    if has_non_delete_segment {
        emit_blocked_audit(
            &audit_sink,
            ctx,
            SecurityAuditOperation::Delete,
            vec![command.to_string()],
        );
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到复合命令链中的物理删除形态，整链已拦截（链内其他段副作用不可控）；{DELETE_REDIRECT_GUIDANCE}。原始命令：{command}"
            ),
        ));
    }
    // 3. 无法解析删除目标（如 rm --cached 无路径）→ 拦截 + 引导
    if analysis.delete_targets.is_empty() {
        emit_blocked_audit(
            &audit_sink,
            ctx,
            SecurityAuditOperation::Delete,
            vec![command.to_string()],
        );
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到物理删除形态但无法解析删除目标；{DELETE_REDIRECT_GUIDANCE}。原始命令：{command}"
            ),
        ));
    }
    // 4. 解析目标：相对 cwd 解析 + 工作区包含性校验（越界一律拒绝，不引导不降级）
    let mut targets = Vec::new();
    for target in &analysis.delete_targets {
        match resolve_delete_target(workspace_root, cwd, target) {
            Ok(t) => targets.push(t),
            Err(e) => {
                emit_blocked_audit(
                    &audit_sink,
                    ctx,
                    SecurityAuditOperation::Delete,
                    vec![target.clone()],
                );
                return Err(e);
            }
        }
    }
    // T-D-08：删除重定向目标的硬沙箱越权拒绝（白名单下目标不在允许集 → 整链
    // 拒绝；未装配策略 = 不强制；先越权后互斥，串行叠加）
    for target in &targets {
        crate::write_paths::check_write_allowance_for_ctx(ctx, target)?;
    }
    // I4-M3：删除重定向目标的写路径互斥——全部目标先声明（Delete 模式）再执行，
    // 任一目标被占用 → 整链拒绝（不产生部分删除）；未接线（None）不强制；
    // 守卫集合随函数结束自动释放
    let mut claims = Vec::new();
    for target in &targets {
        claims.push(claim_write_guard(
            ctx,
            &target.display().to_string(),
            ClaimMode::Delete,
        )?);
    }
    // 5. trash 服务执行（模式 B：应用内回收站；未注入根时回退工作区 .crish-trash）
    let service_root = trash_root.unwrap_or_else(|| workspace_root.join(DEFAULT_TRASH_DIR_NAME));
    let service = TrashService::new(&service_root);
    // 影响面预检必须先于删除（目标移入回收站后原路径已不存在）
    let impact = conex_fs::impact::assess(&targets);
    let mut entries = Vec::new();
    for target in &targets {
        let display = display_path(workspace_root, target);
        if target == workspace_root || target == cwd {
            emit_blocked_audit(
                &audit_sink,
                ctx,
                SecurityAuditOperation::Delete,
                vec![display.clone()],
            );
            return Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                format!(
                    "PermissionDenied: 删除目标为工作区根或当前工作目录，拒绝执行：{display}；{DELETE_REDIRECT_GUIDANCE}"
                ),
            ));
        }
        match service.trash_file(target, true) {
            Ok(entry) => {
                let mut v = serde_json::to_value(&entry)
                    .unwrap_or_else(|_| serde_json::json!({}));
                v["path"] = serde_json::Value::String(display);
                v["entryId"] = serde_json::Value::String(entry.id.clone());
                entries.push(v);
            }
            Err(e) => {
                return Err(ToolError::execution_failed(
                    "shell_command",
                    format!(
                        "删除重定向失败（{display}）：{e}；已移入回收站的条目可经 trash_restore 恢复"
                    ),
                ));
            }
        }
    }
    // 6. 审计：重定向成功（decision=redirected，影响面来自预检）——
    //    经审计 sink 发射（引擎侧接线后汇入事件流落库；未接线 no-op）
    let target_displays: Vec<String> = targets
        .iter()
        .map(|t| t.display().to_string())
        .collect();
    audit_sink.emit(&security_audit_event(
        &ctx.session_id,
        SecurityAuditOperation::Delete,
        target_displays.clone(),
        impact,
        SecurityAuditDecision::Redirected,
        None,
    ));
    // 7. 审计日志（结构化安全审计；工具结果经 tool-end 事件流落库）
    let entry_ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["entryId"].as_str())
        .collect();
    tracing::info!(
        target: "security.audit",
        kind = "delete-redirect",
        session_id = %ctx.session_id,
        command = %command,
        targets = ?target_displays,
        entry_ids = ?entry_ids,
        impact = ?impact,
        "删除形态重定向审计：shell 删除命令已改走回收站接口（可恢复）"
    );
    Ok(build_redirect_output(
        command,
        workspace_root,
        cwd,
        &targets,
        &entries,
        impact,
        &service_root,
    ))
}

/// 解析删除目标：相对 cwd 拼接后做工作区包含性校验；通配符 / 特殊路径 /
/// 工作区外目标一律拒绝（I2-S4 内容 3：越界目标不引导不降级）。
fn resolve_delete_target(
    workspace_root: &Path,
    cwd: &Path,
    target: &str,
) -> Result<PathBuf, ToolError> {
    let trimmed = target.trim();
    if trimmed.is_empty() || matches!(trimmed, "." | ".." | "~") || trimmed.starts_with('~') {
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("删除目标为特殊路径，已拒绝：{target:?}；请改用 delete_file / delete_dir 指定明确路径"),
        ));
    }
    if trimmed.contains(['*', '?', '[']) {
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("删除目标含通配符，已拒绝：{target:?}；请改用 delete_file / delete_dir 指定明确路径"),
        ));
    }
    let raw = Path::new(trimmed);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };
    resolve_workspace_path(workspace_root, &candidate.to_string_lossy()).map_err(|_| {
        ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("删除目标在工作区外或越界，已拒绝：{target:?}"),
        )
    })
}

/// 重定向结果：TrashEntry 列表（entryId 供恢复）+ 影响面 + 引导文案
fn build_redirect_output(
    command: &str,
    workspace_root: &Path,
    cwd: &Path,
    targets: &[PathBuf],
    entries: &[serde_json::Value],
    impact: ImpactAssessment,
    trash_root: &Path,
) -> serde_json::Value {
    let target_displays: Vec<String> = targets
        .iter()
        .map(|t| display_path(workspace_root, t))
        .collect();
    let entry_ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["entryId"].as_str())
        .collect();
    let text = format!(
        "检测到物理删除形态，已重定向到删除接管接口（未物理删除）：{} 个目标已移入回收站（条目 {}）。\n\
         可恢复路径类型：应用内回收站。恢复：调用 trash_restore（entryId={}）。",
        entries.len(),
        entry_ids.join(", "),
        entry_ids.first().copied().unwrap_or(""),
    );
    serde_json::json!({
        "command": command,
        "cwd": cwd.display().to_string(),
        "redirected": true,
        "redirect": {
            "kind": "delete-redirect",
            "reason": "semantics 判定为删除形态（DeleteShape），已改走删除接管接口（回收站），未物理删除",
            "targets": target_displays,
            "guidance": DELETE_REDIRECT_GUIDANCE,
        },
        "trashEntries": entries,
        "impact": impact,
        "trashRoot": trash_root.to_string_lossy().into_owned(),
        "text": text,
    })
}

/// 门禁比较用路径串：剥离 `\\?\` 前缀、反斜杠转斜杠、Windows 小写
/// （与 CommandGatekeeper 内部 normalize 方式一致，避免误升级审批）
fn gate_path(p: &Path) -> String {
    let s = crate::tools::strip_verbatim_prefix(p)
        .to_string_lossy()
        .replace('\\', "/");
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

/// 构建外壳调用：Windows 用系统 PowerShell EncodedCommand，其它平台 bash -lc
fn build_shell_invocation(command: &str) -> Result<(String, Vec<String>, String), String> {
    if cfg!(windows) {
        let ps = resolve_system_powershell()?;
        let script = build_windows_powershell_script(command);
        let encoded = encode_powershell_encoded_command(&script);
        Ok((
            ps,
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-EncodedCommand".into(),
                encoded,
            ],
            "powershell.exe".into(),
        ))
    } else {
        Ok((
            "bash".into(),
            vec!["-lc".into(), command.to_string()],
            "bash".into(),
        ))
    }
}

/// 优先系统目录 Windows PowerShell 5.x，再回落 PATH 上的 powershell.exe
fn resolve_system_powershell() -> Result<String, String> {
    if let Ok(root) = std::env::var("SystemRoot") {
        let candidate = std::path::Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            return Ok(candidate.display().to_string());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("powershell.exe").is_file() {
                return Ok("powershell.exe".into());
            }
        }
    }
    Err("system powershell.exe not found".into())
}

/// Windows 包装脚本：UTF-8 → base64 载荷，避免引号/管道被外壳二次解析弄坏
/// （与 agent-runtime 对齐：UTF-8 输出 + base64 载荷）
fn build_windows_powershell_script(user_command: &str) -> String {
    let payload = base64_encode(user_command.as_bytes());
    [
        "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
        "$env:PYTHONUTF8='1'",
        "$env:PYTHONIOENCODING='utf-8'",
        // T-AB-03：PAGER=cat——防交互式分页器（git log 等）挂起等待输入
        "$env:PAGER='cat'",
        "$global:LASTEXITCODE=$null",
        &format!(
            "$__conexCmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('{payload}'))"
        ),
        "& ([scriptblock]::Create($__conexCmd))",
        "$success=$?",
        "$exitCode=$LASTEXITCODE",
        "if ($exitCode -ne $null -and $exitCode -ne 0) { exit $exitCode }",
        "if (-not $success) { exit 1 }",
    ]
    .join("; ")
}

/// PowerShell -EncodedCommand：UTF-16LE → base64
fn encode_powershell_encoded_command(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for u in script.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    base64_encode(&bytes)
}

/// 标准 base64 编码（无外部依赖，与 Tauri 壳 process.rs 的 base64_encode_std 同构）
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= data.len() {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8) | (data[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = data.len() - i;
    if rem == 1 {
        let n = (data[i] as u32) << 16;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((data[i] as u32) << 16) | ((data[i + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

/// 命令执行三模式（T-AB-02：REQ-A01）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellMode {
    /// 同步等待（窗口 = timeoutMs，超时树杀——改造前语义）
    Sync,
    /// 等待窗口（waitMsBeforeAsync）内完成返回同步结果；窗口超时不杀，
    /// Child 经 manager.adopt 转后台托管
    AutoBackground,
    /// spawn 后立即转后台守护（is_daemon=true，run 结束不回收）
    Daemon,
}

/// 解析 mode 入参（缺省 sync；未知值结构化报错）
fn parse_mode(args: &serde_json::Value) -> Result<ShellMode, ToolError> {
    match optional_string(args, "mode").as_deref() {
        None | Some("sync") => Ok(ShellMode::Sync),
        Some("auto-background") => Ok(ShellMode::AutoBackground),
        Some("daemon") => Ok(ShellMode::Daemon),
        Some(other) => Err(ToolError::invalid_input(format!(
            "未知 mode：{other:?}（可选 sync / auto-background / daemon）"
        ))),
    }
}

/// 执行命令并收集输出（T-AB-01 流式化 + T-AB-02 三模式）
// G2 允许理由（clippy::too_many_arguments）：参数为上下文聚合注入（命令/
// cwd/超时/输出上限/模式/等待时长/后台收养/日志根/会话号等），各参数来源
// 独立，收缩将退化为全局态或拆分 struct 而收益低。
// G2 禁令豁免（clippy.toml 文件头「豁免面」）：命令门禁执行面——本函数只被
// shell 工具调用，且调用前必经 CommandGatekeeper 检查（blocked/approval，
// 见本文件 execute），是「子进程经命令门禁」的门禁落地处本身。
#[allow(clippy::too_many_arguments, clippy::disallowed_methods)]
async fn run_command_maybe_background(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
    max_output_bytes: usize,
    mode: ShellMode,
    wait_ms: u64,
    is_daemon: bool,
    resource_monitor: bool,
    manager: Option<Arc<dyn BackgroundTaskManager>>,
    log_root: Option<PathBuf>,
    session_id: &str,
) -> Result<serde_json::Value, ToolError> {
    let (program, args, shell_label) =
        build_shell_invocation(command).map_err(|e| ToolError::execution_failed("shell_command", e))?;

    let mut child_cmd = TokioCommand::new(&program);
    child_cmd
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // T-AB-02：kill_on_drop(false)——后台化后 drop 不得连杀子进程；
        // 同步路径的超时树杀改为显式执行（见超时分支），两条路径不双杀
        .kill_on_drop(false);
    // Windows：隐藏控制台闪现（trait 方法已稳定，导入仅保编译兼容）
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 子进程优先 UTF-8 输出（T-AB-03：PAGER=cat 防交互式分页器挂起）
    child_cmd.env("PYTHONUTF8", "1");
    child_cmd.env("PYTHONIOENCODING", "utf-8");
    child_cmd.env("PAGER", "cat");

    let mut child = child_cmd
        .spawn()
        .map_err(|e| ToolError::execution_failed("shell_command", format!("failed to spawn {shell_label}: {e}")))?;
    let child_pid = child.id();
    let started = std::time::Instant::now();

    // 模式 3（daemon）：spawn 后立即 adopt（is_daemon=true），管道原样留在
    // Child 内不取出；未接线（manager None）时回退同步语义（不报错）
    let effective_mode = if mode == ShellMode::Daemon {
        if let Some(mgr) = &manager {
            return adopt_child(
                Arc::clone(mgr),
                child,
                command,
                cwd,
                true,
                resource_monitor,
                shell_label,
            )
            .await;
        }
        ShellMode::Sync
    } else {
        mode
    };

    // T-AB-01：拆 stdout/stderr 两个 BufReader 流式读取（fill_buf/consume
    // 持续消费——管道写满不会阻塞子进程，且缓冲内不残留未消费字节，
    // 转后台移交管道时不丢数据）
    let out_pipe = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::execution_failed("shell_command", "stdout pipe missing"))?;
    let err_pipe = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::execution_failed("shell_command", "stderr pipe missing"))?;
    let mut out_reader = BufReader::new(out_pipe);
    let mut err_reader = BufReader::new(err_pipe);
    let mut acc_out = OutputAccumulator::new();
    let mut acc_err = OutputAccumulator::new();

    // 等待窗口：sync = timeoutMs（AI 显式设置的绝对上限）；auto-background =
    // min(waitMsBeforeAsync, timeoutMs)——timeoutMs 仍是等待上限，超窗一律
    // 不杀（转后台），「转后台任务默认无限运行」
    let window_ms = match effective_mode {
        ShellMode::Sync => timeout_ms,
        ShellMode::AutoBackground => wait_ms.min(timeout_ms),
        ShellMode::Daemon => unreachable!("daemon 已在上面短路"),
    };
    let deadline = tokio::time::Instant::now() + Duration::from_millis(window_ms);

    let streamed = stream_until_deadline(&mut out_reader, &mut err_reader, &mut acc_out, &mut acc_err, deadline).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match streamed {
        // 窗口内完成：同步路径自行回收（wait 后 drop，无泄漏；无 adopt 调用）
        StreamEnd::Completed => {
            let exit_code = child.wait().await.ok().and_then(|s| s.code());
            build_sync_result(
                command,
                cwd,
                &shell_label,
                exit_code,
                duration_ms,
                &acc_out,
                &acc_err,
                max_output_bytes,
                log_root.as_deref(),
                session_id,
            )
        }
        // 窗口超时
        StreamEnd::TimedOut => {
            if effective_mode == ShellMode::AutoBackground {
                // 不杀：管道收回 Child → adopt 转移（所有权归 registry）。
                // 超时已完成读取的字节经 BufReader::into_inner 丢弃为空的缓冲
                // 无损失（fill_buf/consume 全程消费），registry 从管道续读
                child.stdout = Some(out_reader.into_inner());
                child.stderr = Some(err_reader.into_inner());
                match manager {
                    Some(manager) => {
                        adopt_child(
                            manager,
                            child,
                            command,
                            cwd,
                            is_daemon,
                            resource_monitor,
                            shell_label,
                        )
                        .await
                    }
                // 未接线环境：保持现状（超时即杀 + 树杀），零回归——
                // 管道已收回 child，reader 已被 into_inner 消费，无需再 drop
                None => {
                    if let Some(pid) = child_pid {
                        let _ = terminate_process_tree(pid);
                    }
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                        let stderr = format!("(命令超时，已终止 · {timeout_ms}ms)");
                        Ok(serde_json::json!({
                            "command": command,
                            "cwd": cwd.display().to_string(),
                            "shell": shell_label,
                            "exitCode": null,
                            "stdout": "",
                            "stderr": stderr,
                            "timedOut": true,
                            "truncated": false,
                            "durationMs": duration_ms,
                            "mode": "sync",
                            "text": stderr,
                        }))
                    }
                }
            } else {
                // 同步模式：树杀语义不变（先 drop 流式 reader 句柄再树杀，
                // 避免句柄泄漏与子进程写端永久阻塞）
                drop(out_reader);
                drop(err_reader);
                if let Some(pid) = child_pid {
                    let _ = terminate_process_tree(pid);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                let stderr = format!("(命令超时，已终止 · {timeout_ms}ms)");
                Ok(serde_json::json!({
                    "command": command,
                    "cwd": cwd.display().to_string(),
                    "shell": shell_label,
                    "exitCode": null,
                    "stdout": "",
                    "stderr": stderr,
                    "timedOut": true,
                    "truncated": false,
                    "durationMs": duration_ms,
                    "mode": "sync",
                    "text": stderr,
                }))
            }
        }
    }
}

/// 流式读取结果（T-AB-01）
enum StreamEnd {
    /// 双管道 EOF，进程已可回收
    Completed,
    /// 等待窗口耗尽（尚未完成）
    TimedOut,
}

/// 双管道流式读取直到 deadline 或双 EOF（T-AB-01）
///
/// fill_buf/consume 语义：每次 fill_buf 返回缓冲内全部可用数据，consume
/// 全部消费——BufReader 内不残留未消费字节，窗口超时后 into_inner 收回
/// 管道移交 registry 时不丢已读数据。两个管道在 select! 中交替消费，
/// 任一管道持续输出不会阻塞另一管道（管道缓冲死锁防护）。
async fn stream_until_deadline(
    out_reader: &mut BufReader<tokio::process::ChildStdout>,
    err_reader: &mut BufReader<tokio::process::ChildStderr>,
    acc_out: &mut OutputAccumulator,
    acc_err: &mut OutputAccumulator,
    deadline: tokio::time::Instant,
) -> StreamEnd {
    let mut out_eof = false;
    let mut err_eof = false;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return StreamEnd::TimedOut;
        }
        if out_eof && err_eof {
            return StreamEnd::Completed;
        }
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::select! {
            _ = tokio::time::sleep(remain) => {
                return StreamEnd::TimedOut;
            }
            r = drain_available(out_reader, acc_out), if !out_eof => {
                // 读取错误按 EOF 处理（管道异常不致命，进程退出码仍可回收）
                out_eof = r.unwrap_or(true);
            }
            r = drain_available(err_reader, acc_err), if !err_eof => {
                err_eof = r.unwrap_or(true);
            }
        }
    }
}

/// 消费当前可用数据（fill_buf → append → consume，循环至管道暂空或 EOF）；
/// 返回 true = 已 EOF。管道写满不会阻塞子进程（持续读取即死锁防护）。
async fn drain_available<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    acc: &mut OutputAccumulator,
) -> std::io::Result<bool> {
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(true);
        }
        acc.append(buf, epoch_millis_now());
        let len = buf.len();
        reader.consume(len);
    }
}

/// 纪元毫秒（流式循环维护 last_output_at_ms 用）
fn epoch_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 流式输出累积器（T-AB-01）
///
/// - `bytes`：全量字节——clamp 与截断落盘（T-AB-03）需要，命令完成后即释放；
/// - `preview`：有界内存预览（头 24KB + 尾 24KB）——截断时结果侧展示内容，
///   原始全量字节不驻留结果；
/// - `lines` / `last_output_at_ms`：行计数与最近输出时间（后台化预留，
///   R-AB3 资源监控消费）。
struct OutputAccumulator {
    bytes: Vec<u8>,
    preview: BoundedPreview,
    lines: u64,
    last_output_at_ms: u64,
}

impl OutputAccumulator {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            preview: BoundedPreview::new(),
            lines: 0,
            last_output_at_ms: 0,
        }
    }

    /// 追加一个数据块（更新全量字节 / 有界预览 / 行计数 / 最近输出时间）
    fn append(&mut self, chunk: &[u8], now_ms: u64) {
        self.bytes.extend_from_slice(chunk);
        self.preview.append(chunk);
        self.lines += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
        if !chunk.is_empty() {
            self.last_output_at_ms = now_ms;
        }
    }

    /// 预览文本：头 24KB + 截断标记 + 尾 24KB（未截断时为全量）
    fn preview_text(&self, max_output_bytes: usize) -> (String, bool) {
        if self.bytes.len() <= max_output_bytes {
            return (decode_console_bytes(&self.bytes), false);
        }
        let omitted = self
            .bytes
            .len()
            .saturating_sub(self.preview.head.len() + self.preview.tail.len());
        let text = format!(
            "{}\n\n[output truncated: {omitted} bytes omitted]\n\n{}",
            decode_console_bytes(&self.preview.head),
            decode_console_bytes(&self.preview.tail),
        );
        (text, true)
    }
}

/// 有界内存预览（头部/尾部各 24KB，T-AB-01）
struct BoundedPreview {
    head: Vec<u8>,
    tail: Vec<u8>,
}

impl BoundedPreview {
    fn new() -> Self {
        Self {
            head: Vec::new(),
            tail: Vec::new(),
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        if self.head.len() < PREVIEW_HEAD_BYTES {
            let take = (PREVIEW_HEAD_BYTES - self.head.len()).min(chunk.len());
            self.head.extend_from_slice(&chunk[..take]);
        }
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > PREVIEW_TAIL_BYTES {
            let over = self.tail.len() - PREVIEW_TAIL_BYTES;
            self.tail.drain(..over);
        }
    }
}

/// adopt 转移（T-AB-02）：Child 所有权交 registry；返回 background 结果信封
async fn adopt_child(
    manager: Arc<dyn BackgroundTaskManager>,
    child: tokio::process::Child,
    command: &str,
    cwd: &Path,
    is_daemon: bool,
    resource_monitor: bool,
    shell_label: String,
) -> Result<serde_json::Value, ToolError> {
    // 命令摘要（前 64 字符）
    let summary: String = command.chars().take(64).collect();
    let req = BackgroundAdoptRequest {
        child,
        command: summary,
        cwd: cwd.to_path_buf(),
        is_daemon,
        resource_monitor,
        // R-AB3 接线 owner_run_id（审计与过滤用，不级联杀）
        owner_run_id: None,
    };
    let result = manager.adopt(req).await.map_err(|e| {
        ToolError::new(
            e.code(),
            format!("后台托管失败（adopt）：{e}"),
        )
    })?;
    let text = format!("命令已转后台（task {}），可随时查询状态", result.task_id);
    Ok(serde_json::json!({
        "mode": "background",
        "taskId": result.task_id,
        "logPath": result.log_path.display().to_string(),
        "command": command,
        "cwd": cwd.display().to_string(),
        "shell": shell_label,
        "text": text,
    }))
}

/// 同步结果构造（T-AB-01/03）：截断判定 + 有界预览结果 + 截断落盘 + 建议
// G2 允许理由（clippy::too_many_arguments）：参数为命令执行上下文聚合注入
// （命令/cwd/退出码/时长/双输出累加器/截断上限/日志根/会话号），各参数来源
// 独立，收缩将退化为全局态或拆分 struct 而收益低。
#[allow(clippy::too_many_arguments)]
fn build_sync_result(
    command: &str,
    cwd: &Path,
    shell_label: &str,
    exit_code: Option<i32>,
    duration_ms: u64,
    acc_out: &OutputAccumulator,
    acc_err: &OutputAccumulator,
    max_output_bytes: usize,
    log_root: Option<&Path>,
    session_id: &str,
) -> Result<serde_json::Value, ToolError> {
    // T-AB-01：窗口内完成 = 输出与改造前逐字节一致（未截断时全量字节）；
    // 截断时结果展示有界预览（头/尾 24KB），全量字节仅用于落盘
    let (stdout, trunc_out) = acc_out.preview_text(max_output_bytes);
    let (stderr, trunc_err) = acc_err.preview_text(max_output_bytes);
    let truncated = trunc_out || trunc_err;

    // T-AB-03：截断落盘（best-effort）——log_root 为 None 或写盘失败 → 仅
    // 截断 + 无 logPath，命令不失败（对齐 perf/jsonl.rs:49-72 错误风格）
    let log_path = if truncated {
        spill_full_output(log_root, session_id, &acc_out.bytes, &acc_err.bytes)
    } else {
        None
    };

    let mut text = format_command_result(&stdout, &stderr, exit_code, false);
    if let Some(lp) = &log_path {
        text.push_str(&format!(
            "\n\n输出已截断，完整日志保存在 {lp}，可通过文件读取工具查看完整内容"
        ));
    }
    // T-AB-03：高输出命令建议（纯函数，不引入调度逻辑）
    if truncated {
        if let Some(suggestion) = high_output_suggestion(command) {
            text.push_str(&format!("\n提示：{suggestion}"));
        }
    }

    let mut v = serde_json::json!({
        "command": command,
        "cwd": cwd.display().to_string(),
        "shell": shell_label,
        "exitCode": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "timedOut": false,
        "truncated": truncated,
        "durationMs": duration_ms,
        "mode": "sync",
        "text": text,
    });
    if let Some(lp) = log_path {
        v["logPath"] = serde_json::Value::String(lp);
    }
    Ok(v)
}

/// 截断落盘（T-AB-03）：`<log_root>/sessions/<session_id>/<ts>-<seq>.log`，
/// 写入原始完整字节（stdout + stderr 顺序拼接）；失败返回 None（不失败）
fn spill_full_output(
    log_root: Option<&Path>,
    session_id: &str,
    stdout: &[u8],
    stderr: &[u8],
) -> Option<String> {
    let root = log_root?;
    let dir = root.join("sessions").join(session_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    let seq = SPILL_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = dir.join(format!("{ts}-{seq}.log"));
    let mut full = Vec::with_capacity(stdout.len() + stderr.len());
    full.extend_from_slice(stdout);
    full.extend_from_slice(stderr);
    if std::fs::write(&path, &full).is_err() {
        return None;
    }
    Some(path.display().to_string())
}

/// 截断落盘文件序号（进程级单调递增；会话内唯一）
static SPILL_SEQ: AtomicU64 = AtomicU64::new(0);

/// 高输出命令建议（T-AB-03，纯函数）：检测已知高输出形态（git log 无 -n /
/// git diff 无 --stat 等），追加「建议添加限制参数」提示——不引入调度逻辑
fn high_output_suggestion(command: &str) -> Option<String> {
    let lower = command.to_lowercase();
    if lower.contains("git log")
        && !lower.contains("-n")
        && !lower.contains("--max-count")
        && !lower.contains("--oneline")
        && !lower.contains("--stat")
    {
        return Some(
            "git log 输出可能较大，建议添加 -n <行数>（或 --oneline）限制输出行数".to_string(),
        );
    }
    if (lower.contains("git diff") || lower.contains("git show"))
        && !lower.contains("--stat")
        && !lower.contains("--name-only")
    {
        return Some("git diff/git show 输出可能较大，建议添加 --stat 或 --name-only 限制输出".to_string());
    }
    None
}

// ==================== T-AB-04：cd 形态拦截 ====================

/// cd 形态拦截（T-AB-04：判定优先级「门禁 → 删除形态 → cd 形态 → 执行」，
/// 由调用方保证删除形态先行；本函数只处理残留 cd 形态）：
/// - 纯 cd 命令（单段整体分类 == CdShape）→ 结构化错误 tool.cd_blocked，
///   文案引导使用 `Cwd` 参数；
/// - 复合链含 cd 段（多段）→ 整链拦截 + 引导（链内其他段依赖目录状态，
///   不代为执行）。
fn intercept_cd_shape(analysis: &SemanticAnalysis, command: &str) -> Option<ToolError> {
    // 复用分析结果的拆段（参照 :276-293 整链拦截模式）：命令 + 参数重建
    // 段字符串（引号内容已剥离，`echo "cd x"` 段首为 echo 不命中）
    let segments: Vec<String> = analysis
        .segments
        .iter()
        .map(|s| {
            if s.args.is_empty() {
                s.command.clone()
            } else {
                format!("{} {}", s.command, s.args.join(" "))
            }
        })
        .collect();
    if segments.is_empty() {
        return None;
    }
    if conex_sandbox::semantics::classify_command_segments(&segments)
        != CommandClass::CdShape
    {
        return None;
    }
    let pure_cd = segments.len() == 1;
    let message = if pure_cd {
        "请使用 Cwd 参数指定工作目录，而非 cd 命令"
    } else {
        "检测到复合命令链中的 cd 形态，整链已拦截（链内其他段依赖目录状态，不代为执行）；请使用 Cwd 参数指定工作目录"
    };
    Some(ToolError::new(
        TOOL_CD_BLOCKED,
        format!("{message}。原始命令：{command}"),
    ))
}

/// 输出截断：保留头尾各一半，中间省略（对齐 workbench clamp_output_bytes）
///
/// T-AB-01 改造后结果侧改由 OutputAccumulator::preview_text（有界 24KB
/// 头尾预览）承担，本函数保留为纯函数基准（G8 截断不回归，测试覆盖）
#[cfg_attr(not(test), allow(dead_code))]
fn clamp_output_bytes(raw: &[u8], max_bytes: usize) -> (String, bool) {
    if raw.len() <= max_bytes {
        return (decode_console_bytes(raw), false);
    }
    let half = max_bytes / 2;
    let head = &raw[..half];
    let tail = &raw[raw.len() - half..];
    let omitted = raw.len() - head.len() - tail.len();
    let text = format!(
        "{}\n\n[output truncated: {omitted} bytes omitted]\n\n{}",
        decode_console_bytes(head),
        decode_console_bytes(tail),
    );
    (text, true)
}

/// 控制台字节解码：先按 UTF-8，失败 lossy
fn decode_console_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

/// 结果正文（对齐 TS formatCommandResult：正文 + 超时/退出码尾注）
fn format_command_result(
    stdout: &str,
    stderr: &str,
    exit_code: Option<i32>,
    timed_out: bool,
) -> String {
    let output = [stdout.trim_end(), stderr.trim_end()]
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    if timed_out {
        return if output.is_empty() {
            "(命令超时)".to_string()
        } else {
            format!("{output}\n\n(命令超时)")
        };
    }
    if let Some(code) = exit_code {
        if code != 0 {
            return if output.is_empty() {
                format!("(exit {code})")
            } else {
                format!("{output}\n\n(exit {code})")
            };
        }
    }
    if output.is_empty() {
        "(无输出)".to_string()
    } else {
        output
    }
}

/// 终止进程树：Windows taskkill 树杀，其它平台 kill -TERM
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：taskkill 树杀——
// 工具执行面终止原语：命令已过命令门禁才产生进程，树杀是执行后的生命周期
// 清理（同 process.rs terminate_process_tree 语义）；固定系统工具 + PID 数字
// 参数，output() 同步等待型，子进程不脱离会话存活。
#[allow(clippy::disallowed_methods)]
#[cfg(target_os = "windows")]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start taskkill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// 终止进程树（Unix 简化版：kill -TERM）
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：kill -TERM 进程树
// 终止（Unix 分支，同 Windows taskkill 语义）——固定系统工具 + PID 数字参数，
// output() 同步等待型，子进程不脱离会话存活。
#[allow(clippy::disallowed_methods)]
#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start kill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试 mod——真实 spawn 探测命令门禁语义（红线目标断言
    // Blocked）+ pid 存活探测（tasklist / kill -0，T-AB-06/07 验收辅助），
    // 非产品执行面；测试 mod 内 allow + 理由（裁决 D8 背书）。
    #![allow(clippy::disallowed_methods)]
    use super::*;
    use crate::background::{
        BackgroundTaskInfo, BackgroundTaskRef, BackgroundTaskStatus, KillResult, LogSlice,
    };
    use crate::context::{create_mock_tool_context, AskChannel, ToolContext};
    use conex_test_utils::TempWorkspace;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::Mutex;

    fn tool() -> ShellCommandTool {
        ShellCommandTool::new(30_000, 200_000, None)
    }

    /// 测试用会话上下文：workspace_root 指向临时工作区
    fn ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        }
    }

    /// 测试用审批通道：记录审批请求（工具名）并返回预设裁决
    #[derive(Clone, Debug)]
    struct MockAskChannel {
        decision: AskDecision,
        requested: Arc<std::sync::Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl AskChannel for MockAskChannel {
        async fn ask(
            &self,
            tool_name: &str,
            _args: &serde_json::Value,
        ) -> Result<AskDecision, ToolError> {
            self.requested
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(tool_name.to_string());
            Ok(self.decision.clone())
        }
    }

    /// T10：带 dangerous 标记的 shell 命令触发审批（拒绝路径）——approval
    /// 事件产生（通道被问询）且命令未直接执行（返回 Denied 拒绝结果）
    #[tokio::test]
    async fn dangerous_command_asks_then_denied_never_executes() {
        let ws = TempWorkspace::new("shell_ask_deny");
        let t = tool();
        let requested = Arc::new(std::sync::Mutex::new(Vec::new()));
        let ask = Arc::new(MockAskChannel {
            decision: AskDecision::Denied {
                reason: "user says no".into(),
            },
            requested: Arc::clone(&requested),
        });
        let ctx = ToolContext {
            ask: Some(ask),
            ..ctx(&ws)
        };
        let err = t
            .execute(
                &ctx,
                json!({ "command": "echo sudo-hi", "timeoutMs": 5000 }),
            )
            .await
            .unwrap_err();
        // 审批事件产生：通道被问询一次
        // （timeoutMs 5000 仅约束「拒绝路径不执行命令」，命令本身未跑，无负载风险）
        assert_eq!(
            *requested.lock().unwrap_or_else(|e| e.into_inner()),
            vec!["shell_command".to_string()]
        );
        // 命令未直接执行：返回明确拒绝结果（Denied 语义）
        assert_eq!(err.code(), TOOL_USER_DENIED);
        assert!(err.to_string().contains("user says no"));
    }

    /// T10：带 dangerous 标记的 shell 命令触发审批（同意路径）——approval
    /// 事件产生，用户同意后命令真正执行（越过门禁）
    #[tokio::test]
    async fn dangerous_command_asks_then_allowed_executes() {
        let ws = TempWorkspace::new("shell_ask_allow");
        let t = tool();
        let requested = Arc::new(std::sync::Mutex::new(Vec::new()));
        let ask = Arc::new(MockAskChannel {
            decision: AskDecision::Allowed,
            requested: Arc::clone(&requested),
        });
        let ctx = ToolContext {
            ask: Some(ask),
            ..ctx(&ws)
        };
        // 越界命令（gatekeeper RequiresApproval）：经审批放行后真正执行。
        // timeoutMs 用 60s：并行全量跑时 PowerShell 冷启动可能超过 5s，
        // 5s 上限曾导致负载型 flaky（命令被误判超时 → exitCode 为空）
        let out = t
            .execute(
                &ctx,
                json!({ "command": "echo sudo-hi", "timeoutMs": 60000 }),
            )
            .await
            .unwrap();
        assert_eq!(
            *requested.lock().unwrap_or_else(|e| e.into_inner()),
            vec!["shell_command".to_string()]
        );
        // 命令已执行（不再被审批拦截）：正常输出且退出码 0
        assert_eq!(out["exitCode"], 0);
        assert!(out["text"].as_str().unwrap().contains("sudo-hi"));
    }

    #[tokio::test]
    async fn shell_echo_succeeds() {
        let ws = TempWorkspace::new("shell_echo");
        let t = tool();
        let command = if cfg!(windows) {
            "Write-Output hello-shell"
        } else {
            "echo hello-shell"
        };
        let out = t.execute(&ctx(&ws), json!({ "command": command })).await.unwrap();
        assert_eq!(out["timedOut"], false);
        assert_eq!(out["exitCode"], 0);
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.contains("hello-shell"), "stdout: {stdout}");
        assert!(out["text"].as_str().unwrap().contains("hello-shell"));
    }

    #[tokio::test]
    async fn shell_blocked_command_rejected() {
        let ws = TempWorkspace::new("shell_blocked");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "rm -rf /" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    }

    /// PS-01 T1.5 端到端：换行包裹的毁灭性命令（printf x\n/bin/rm -rf -- /，
    /// 真实换行）经门禁拦截（先例 shell_blocked_command_rejected:1516）
    #[tokio::test]
    async fn shell_newline_wrapped_rm_blocked() {
        let ws = TempWorkspace::new("shell_newline_blocked");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "printf x\n/bin/rm -rf -- /" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    }

    #[tokio::test]
    async fn shell_approval_command_requires_approval() {
        let ws = TempWorkspace::new("shell_approval");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "git push --force origin main" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_REQUIRES_APPROVAL);
    }

    #[tokio::test]
    async fn shell_timeout_kills_and_marks() {
        let ws = TempWorkspace::new("shell_timeout");
        let t = ShellCommandTool::new(30_000, 200_000, None);
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 10"
        } else {
            "sleep 10"
        };
        let out = t
            .execute(&ctx(&ws), json!({ "command": command, "timeoutMs": 2000 }))
            .await
            .unwrap();
        assert_eq!(out["timedOut"], true);
        assert!(out["stderr"].as_str().unwrap().contains("超时"));
    }

    #[tokio::test]
    async fn shell_cwd_must_be_valid() {
        let ws = TempWorkspace::new("shell_cwd");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "echo hi", "cwd": "no/such/dir" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not a directory"));
        // 越界 cwd 拒绝
        let err = t
            .execute(&ctx(&ws), json!({ "command": "echo hi", "cwd": "../outside" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
    }

    #[tokio::test]
    async fn shell_exit_code_captured() {
        let ws = TempWorkspace::new("shell_exit");
        let t = tool();
        let out = t.execute(&ctx(&ws), json!({ "command": "exit 42" })).await.unwrap();
        assert_eq!(out["exitCode"], 42);
        assert!(out["text"].as_str().unwrap().contains("(exit 42)"));
    }

    #[test]
    fn base64_encoder_matches_standard() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 中文 UTF-8 与 Unicode 转义混合
        assert_eq!(base64_encode("你好".as_bytes()), "5L2g5aW9");
    }

    #[test]
    fn powershell_script_wraps_command_base64() {
        let script = build_windows_powershell_script("echo hi | Out-String");
        assert!(script.contains("scriptblock"));
        assert!(script.contains("FromBase64String"));
        // 原始命令不直接出现在脚本中（防注入）
        assert!(!script.contains("Out-String"));
    }

    #[test]
    fn clamp_output_caps_at_limit() {
        let raw = vec![b'a'; 1000];
        let (text, truncated) = clamp_output_bytes(&raw, 100);
        assert!(truncated);
        assert!(text.contains("[output truncated: 900 bytes omitted]"));
        assert!(text.starts_with("aaa"));
        assert!(text.ends_with("aaa"));

        let (text, truncated) = clamp_output_bytes(&raw, 2000);
        assert!(!truncated);
        assert_eq!(text.len(), 1000);
    }

    #[test]
    fn format_result_annotations() {
        assert_eq!(format_command_result("out", "", Some(0), false), "out");
        assert_eq!(format_command_result("", "", Some(0), false), "(无输出)");
        assert_eq!(format_command_result("out", "", Some(3), false), "out\n\n(exit 3)");
        assert_eq!(format_command_result("", "", Some(3), false), "(exit 3)");
        assert_eq!(format_command_result("out", "", None, true), "out\n\n(命令超时)");
    }

    // ===== I2-S4：删除形态重定向（rm/del/Remove-Item/git rm → trash 服务）=====

    /// 任务卡验收：`rm -rf ./tmp/foo` 经执行链 → 不实际删除 → 产生 trash entry
    #[tokio::test]
    async fn delete_shape_redirected_to_trash_not_executed() {
        let ws = TempWorkspace::new("shell_s4_rm");
        ws.write_file("tmp/foo.txt", "doomed");
        let trash = TempWorkspace::new("shell_s4_trash");
        let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

        let out = t
            .execute(&ctx(&ws), json!({ "command": "rm -rf ./tmp/foo.txt" }))
            .await
            .unwrap();
        // 重定向而非直接执行
        assert_eq!(out["redirected"], true);
        assert_eq!(out["redirect"]["kind"], "delete-redirect");
        // 目标未物理删除（原路径消失 = 已移入回收站），回收站产生条目
        assert!(!ws.path().join("tmp/foo.txt").exists(), "原路径消失（已移入回收站）");
        let entries = TrashService::new(trash.path()).list();
        assert_eq!(entries.len(), 1, "必须产生 trash entry");
        assert_eq!(out["trashEntries"][0]["entryId"], entries[0].id);
        // 可恢复：恢复后字节一致
        TrashService::new(trash.path()).restore(&entries[0].id).unwrap();
        assert_eq!(ws.read_file("tmp/foo.txt"), "doomed");
    }

    /// 任务卡验收：`git status` 正常执行（非删除命令不受影响；临时工作区非
    /// git 仓库时 git 自身以 128 退出，断言关键是「真实执行而非被拦截」）
    #[tokio::test]
    async fn git_status_executes_normally() {
        let ws = TempWorkspace::new("shell_s4_git");
        let t = tool();
        let out = t
            .execute(&ctx(&ws), json!({ "command": "git status" }))
            .await
            .unwrap();
        assert!(
            out.get("redirected").is_none(),
            "非删除命令结果不得带重定向标记"
        );
        assert_eq!(out["timedOut"], false);
        assert!(
            out["exitCode"].is_number(),
            "git 应真实执行并产生退出码"
        );
    }

    /// 删除形态全变体：rm / del / Remove-Item / git rm 一律重定向
    #[tokio::test]
    async fn delete_shape_variants_redirected() {
        for (cmd, target) in [
            ("rm file.txt", "file.txt"),
            ("del file.txt", "file.txt"),
            ("Remove-Item -LiteralPath file.txt -Force", "file.txt"),
            ("git rm file.txt", "file.txt"),
        ] {
            let ws = TempWorkspace::new("shell_s4_var");
            ws.write_file(target, "variant");
            let trash = TempWorkspace::new("shell_s4_var_trash");
            let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

            let out = t
                .execute(&ctx(&ws), json!({ "command": cmd }))
                .await
                .unwrap_or_else(|e| panic!("命令 {cmd:?} 应重定向而非报错：{e}"));
            assert_eq!(out["redirected"], true, "命令 {cmd:?} 应被重定向");
            assert_eq!(
                TrashService::new(trash.path()).list().len(),
                1,
                "命令 {cmd:?} 应产生 trash entry"
            );
            assert!(!ws.path().join(target).exists());
        }
    }

    /// 复合链：`echo done && rm x` → 整链拦截 + 引导（不执行任何段、不代为删除）
    #[tokio::test]
    async fn compound_chain_with_delete_intercepted() {
        let ws = TempWorkspace::new("shell_s4_chain");
        ws.write_file("x.txt", "keep");
        let trash = TempWorkspace::new("shell_s4_chain_trash");
        let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

        let err = t
            .execute(&ctx(&ws), json!({ "command": "echo done && rm x.txt" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
        assert!(err.to_string().contains("复合命令链"));
        assert!(err.to_string().contains("delete_file"));
        // 链未执行：文件仍在、回收站无条目
        assert!(ws.path().join("x.txt").exists(), "整链拦截后不得删除任何文件");
        assert_eq!(TrashService::new(trash.path()).list().len(), 0);
    }

    /// 间接执行包裹删除形态：`bash -c 'rm -rf tmp/foo'` → 拦截 + 引导
    #[tokio::test]
    async fn indirect_delete_wrapper_intercepted() {
        let ws = TempWorkspace::new("shell_s4_indirect");
        ws.write_file("tmp/foo.txt", "keep");
        let trash = TempWorkspace::new("shell_s4_indirect_trash");
        let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

        let err = t
            .execute(&ctx(&ws), json!({ "command": "bash -c 'rm -rf tmp/foo.txt'" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
        assert!(err.to_string().contains("间接执行"));
        assert!(ws.path().join("tmp/foo.txt").exists(), "间接执行删除形态不得执行");
        assert_eq!(TrashService::new(trash.path()).list().len(), 0);
    }

    /// 工作区外目标：一律拒绝（不引导不降级）
    #[tokio::test]
    async fn delete_target_outside_workspace_rejected() {
        let ws = TempWorkspace::new("shell_s4_outside");
        let t = tool();
        let err = t
            .execute(
                &ctx(&ws),
                json!({ "command": "rm C:\\Users\\x\\Desktop\\f.txt" }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
        assert!(err.to_string().contains("工作区外"));
    }

    /// 工作区根 / 当前工作目录目标：拒绝（rm -rf -- ./ 归一会命中）
    #[tokio::test]
    async fn delete_target_workspace_root_rejected() {
        let ws = TempWorkspace::new("shell_s4_root");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "rm -rf -- ./" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
        assert!(err.to_string().contains("工作区根"));
    }

    /// 通配符 / 特殊路径目标：拒绝并引导改用删除接口
    #[tokio::test]
    async fn delete_target_glob_rejected() {
        let ws = TempWorkspace::new("shell_s4_glob");
        let t = tool();
        for cmd in ["rm *.txt", "rm -rf tmp/*"] {
            let err = t
                .execute(&ctx(&ws), json!({ "command": cmd }))
                .await
                .unwrap_err();
            assert_eq!(err.code(), TOOL_COMMAND_BLOCKED, "命令 {cmd:?}");
            assert!(err.to_string().contains("通配符"), "命令 {cmd:?}");
        }
        let err = t
            .execute(&ctx(&ws), json!({ "command": "rm ~/notes.txt" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("特殊路径"));
    }

    /// S8：重定向结果携带影响面审计载荷（文件数 / 大小 / 跨目录 / 谨慎标记）
    #[tokio::test]
    async fn delete_redirect_carries_impact_audit() {
        let ws = TempWorkspace::new("shell_s8_impact");
        ws.write_file("sub/a.txt", "aaaa");
        ws.write_file("sub/b.txt", "bbbb");
        let trash = TempWorkspace::new("shell_s8_trash");
        let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

        let out = t
            .execute(&ctx(&ws), json!({ "command": "rm -rf sub" }))
            .await
            .unwrap();
        let impact = &out["impact"];
        assert_eq!(impact["fileCount"], 2);
        assert_eq!(impact["totalSizeBytes"], 8);
        assert_eq!(impact["directoryCount"], 1);
        assert_eq!(impact["flagged"], false);
        // 审计字段：重定向 kind / 引导 / 回收站条目
        assert_eq!(out["redirect"]["kind"], "delete-redirect");
        assert!(out["redirect"]["guidance"].as_str().unwrap().contains("delete_file"));
        assert_eq!(out["trashEntries"].as_array().unwrap().len(), 1);
        assert!(out["text"].as_str().unwrap().contains("trash_restore"));
    }

    /// S8：删除形态重定向发射 security-audit（decision=redirected，影响面载荷）
    #[tokio::test]
    async fn delete_redirect_emits_security_audit_event() {
        use crate::audit::RecordingAuditSink;
        use conex_types::events::SecurityAuditOperation as Op;
        use conex_types::AgentEvent;

        let ws = TempWorkspace::new("shell_s8_audit");
        ws.write_file("sub/a.txt", "aaaa");
        ws.write_file("sub/b.txt", "bbbb");
        let trash = TempWorkspace::new("shell_s8_audit_trash");
        let sink = Arc::new(RecordingAuditSink::new());
        let t = ShellCommandTool::with_audit_sink(
            30_000,
            200_000,
            Some(trash.path().clone()),
            Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
        );

        t.execute(&ctx(&ws), json!({ "command": "rm -rf sub" }))
            .await
            .unwrap();
        let events = sink.emitted();
        assert_eq!(events.len(), 1, "重定向应发射 1 条审计事件");
        match &events[0] {
            AgentEvent::SecurityAudit {
                operation,
                targets,
                impact,
                decision,
                ..
            } => {
                assert_eq!(operation, &Op::Delete);
                assert_eq!(
                    targets,
                    &vec![ws.path().join("sub").display().to_string()],
                    "目标为解析后的绝对路径"
                );
                assert_eq!(impact.file_count, 2);
                assert_eq!(impact.total_size_bytes, 8);
                assert_eq!(decision, &conex_types::events::SecurityAuditDecision::Redirected);
            }
            other => panic!("应为 security-audit，实际 {}", other.type_name()),
        }
    }

    /// S8：拦截分支发射 security-audit（decision=blocked）——复合链 / 间接执行 /
    /// 通配符 / 工作区外四种形态各一条
    #[tokio::test]
    async fn delete_intercept_emits_blocked_audit() {
        use crate::audit::RecordingAuditSink;
        use conex_types::events::SecurityAuditDecision as Decision;
        use conex_types::events::SecurityAuditOperation as Op;
        use conex_types::AgentEvent;

        let ws = TempWorkspace::new("shell_s8_block");
        ws.write_file("x.txt", "keep");
        let trash = TempWorkspace::new("shell_s8_block_trash");
        let sink = Arc::new(RecordingAuditSink::new());
        let t = ShellCommandTool::with_audit_sink(
            30_000,
            200_000,
            Some(trash.path().clone()),
            Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
        );

        for cmd in [
            "echo done && rm x.txt",
            "bash -c 'rm -rf x.txt'",
            "rm *.txt",
            "rm C:\\Users\\x\\Desktop\\f.txt",
        ] {
            assert!(
                t.execute(&ctx(&ws), json!({ "command": cmd })).await.is_err(),
                "命令 {cmd:?} 应被拦截"
            );
        }
        let events = sink.emitted();
        assert_eq!(events.len(), 4, "四种拦截形态各发射 1 条审计事件");
        for event in &events {
            match event {
                AgentEvent::SecurityAudit {
                    operation,
                    decision,
                    ..
                } => {
                    assert_eq!(operation, &Op::Delete, "拦截对象为删除形态");
                    assert_eq!(decision, &Decision::Blocked, "拦截决策为 blocked");
                }
                other => panic!("应为 security-audit，实际 {}", other.type_name()),
            }
        }
    }

    /// S8：红线命令（rm -rf /）经门禁拦截时发射 security-audit
    /// （operation=command-exec，decision=blocked）
    #[tokio::test]
    async fn redline_blocked_emits_security_audit() {
        use crate::audit::RecordingAuditSink;
        use conex_types::events::SecurityAuditDecision as Decision;
        use conex_types::events::SecurityAuditOperation as Op;
        use conex_types::AgentEvent;

        let ws = TempWorkspace::new("shell_s8_redline");
        let sink = Arc::new(RecordingAuditSink::new());
        let t = ShellCommandTool::with_audit_sink(
            30_000,
            200_000,
            None,
            Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
        );

        let err = t
            .execute(&ctx(&ws), json!({ "command": "rm -rf /" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
        let events = sink.emitted();
        assert_eq!(events.len(), 1, "红线拦截应发射 1 条审计事件");
        match &events[0] {
            AgentEvent::SecurityAudit {
                operation,
                targets,
                decision,
                ..
            } => {
                assert_eq!(operation, &Op::CommandExec);
                assert_eq!(targets, &vec!["rm -rf /".to_string()]);
                assert_eq!(decision, &Decision::Blocked);
            }
            other => panic!("应为 security-audit，实际 {}", other.type_name()),
        }
    }

    /// 越界 / 特殊路径被拒时：不产生任何回收站条目（不半删除）
    #[tokio::test]
    async fn rejected_delete_produces_no_trash_entries() {
        let ws = TempWorkspace::new("shell_s4_noentry");
        ws.write_file("a.txt", "x");
        let trash = TempWorkspace::new("shell_s4_noentry_trash");
        let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

        for cmd in ["echo hi && rm a.txt", "rm *.txt"] {
            assert!(t.execute(&ctx(&ws), json!({ "command": cmd })).await.is_err());
        }
        assert_eq!(TrashService::new(trash.path()).list().len(), 0);
        assert!(ws.path().join("a.txt").exists());
    }

    // ===== T-AB-01：同步路径流式化 =====

    /// 平台无关睡眠命令（测试超时 / 转后台用）
    fn sleep_cmd(secs: u32) -> String {
        if cfg!(windows) {
            format!("Start-Sleep -Seconds {secs}")
        } else {
            format!("sleep {secs}")
        }
    }

    /// 平台无关大输出命令（写 N 个字符到 stdout，单行）
    fn big_output_cmd(ch: char, count: usize) -> String {
        if cfg!(windows) {
            format!("'{}' * {count}", ch)
        } else {
            format!("printf '{ch}%.0s' {{1..{count}}}")
        }
    }

    /// 任务卡验收：窗口内完成的命令 stdout/stderr/exitCode 与改造前逐字节一致
    #[tokio::test]
    async fn shell_streaming_preserves_sync_semantics() {
        let ws = TempWorkspace::new("shell_stream_sync");
        let t = tool();
        let command = if cfg!(windows) {
            "Write-Output stream-out-abc; [Console]::Error.WriteLine('stream-err-xyz'); exit 7"
        } else {
            "echo stream-out-abc; echo stream-err-xyz >&2; exit 7"
        };
        let out = t
            .execute(&ctx(&ws), json!({ "command": command }))
            .await
            .unwrap();
        assert_eq!(out["timedOut"], false);
        assert_eq!(out["exitCode"], 7, "退出码与改造前一致");
        assert_eq!(
            out["stdout"].as_str().unwrap().trim_end(),
            "stream-out-abc",
            "stdout 与改造前逐字节一致"
        );
        // stderr 断言用包含而非逐字节：Windows PowerShell 5.1 首启会在
        // stderr 混入 CLIXML 进度记录（"正在准备首次使用模块"），改造前后
        // 行为一致（wait_with_output 同样收集），非流式化回归
        assert!(
            out["stderr"].as_str().unwrap().contains("stream-err-xyz"),
            "stderr 必须包含预期输出：{}",
            out["stderr"].as_str().unwrap()
        );
        assert!(out["text"].as_str().unwrap().contains("stream-out-abc"));
        assert!(out["text"].as_str().unwrap().contains("(exit 7)"));
    }

    /// 任务卡验收：stdout 写 1MB 的命令 30s 内完成且输出完整
    /// （流式读取解决 wait_with_output 收口下 64KB 管道写满阻塞）
    #[tokio::test]
    async fn shell_streaming_no_pipe_deadlock() {
        let ws = TempWorkspace::new("shell_stream_deadlock");
        let t = tool();
        let command = big_output_cmd('x', 1_048_576);
        let out = t
            .execute(
                &ctx(&ws),
                json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 1200000 }),
            )
            .await
            .unwrap();
        assert_eq!(out["timedOut"], false, "1MB 输出不得 30s 内超时（管道写满死锁）");
        assert_eq!(out["truncated"], false);
        let stdout = out["stdout"].as_str().unwrap();
        assert_eq!(
            stdout.chars().filter(|c| *c == 'x').count(),
            1_048_576,
            "1MB 输出必须完整（流式读取持续消费）"
        );
        let duration = out["durationMs"].as_u64().unwrap();
        assert!(duration < 30_000, "30s 内完成，实际 {duration}ms");
    }

    // ===== T-AB-02：三模式 + trait 契约 =====

    /// 记录式后台任务管理器（测试替身，参照 RunSubagentTool 测试的
    /// RecordingSpawner 风格）：记录 adopt 请求标量字段并按序号应答
    #[derive(Debug)]
    struct RecordingBackgroundManager {
        adopts: Mutex<Vec<AdoptRecord>>,
        next_task_id: std::sync::atomic::AtomicUsize,
    }

    /// adopt 请求标量快照（Child 不可 Clone，只记录字段）
    #[derive(Debug, Clone)]
    struct AdoptRecord {
        command: String,
        cwd: PathBuf,
        is_daemon: bool,
        resource_monitor: bool,
        owner_run_id: Option<String>,
    }

    impl RecordingBackgroundManager {
        fn new() -> Self {
            Self {
                adopts: Mutex::new(Vec::new()),
                next_task_id: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn adopts(&self) -> usize {
            self.adopts.lock().unwrap().len()
        }

        fn adopts_requests(&self) -> Vec<AdoptRecord> {
            self.adopts.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl BackgroundTaskManager for RecordingBackgroundManager {
        async fn adopt(
            &self,
            req: BackgroundAdoptRequest,
        ) -> Result<BackgroundTaskRef, ToolError> {
            let n = self.next_task_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let task_id = format!("task-{n}");
            self.adopts.lock().unwrap().push(AdoptRecord {
                command: req.command,
                cwd: req.cwd,
                is_daemon: req.is_daemon,
                resource_monitor: req.resource_monitor,
                owner_run_id: req.owner_run_id,
            });
            Ok(BackgroundTaskRef {
                task_id: task_id.clone(),
                log_path: PathBuf::from(format!("logs/tasks/{task_id}.log")),
            })
        }

        async fn list(
            &self,
            _include_finished: bool,
        ) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
            Ok(Vec::new())
        }

        async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
            Err(ToolError::not_found(task_id))
        }

        async fn read_log(
            &self,
            task_id: &str,
            _start_line: Option<u64>,
            _max_lines: u64,
        ) -> Result<LogSlice, ToolError> {
            Err(ToolError::not_found(task_id))
        }

        async fn send_input(
            &self,
            _task_id: &str,
            _text: &str,
            _append_newline: bool,
        ) -> Result<(), ToolError> {
            Ok(())
        }

        async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
            Err(ToolError::not_found(task_id))
        }
    }

    /// 任务卡验收：waitMsBeforeAsync 窗口内完成的命令——无 adopt 调用、
    /// 返回同步结果（timedOut=false 且无 taskId）
    #[tokio::test]
    async fn background_window_completed_no_adopt() {
        let ws = TempWorkspace::new("bg_window_ok");
        let manager = Arc::new(RecordingBackgroundManager::new());
        let ctx = ToolContext {
            background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
            ..ctx(&ws)
        };
        let t = tool();
        let command = if cfg!(windows) {
            "Write-Output fast-done"
        } else {
            "echo fast-done"
        };
        // 窗口取 60s：断言语义是「快速命令在窗口内完成」——窗口只须足够大，
        // 并行全量跑时 PowerShell 冷启动可能超过 5s（曾导致误转后台 flaky）
        let out = t
            .execute(
                &ctx,
                json!({ "command": command, "mode": "auto-background", "waitMsBeforeAsync": 60000 }),
            )
            .await
            .unwrap();
        assert_eq!(out["timedOut"], false);
        assert_eq!(out["mode"], "sync");
        assert!(out.get("taskId").is_none(), "窗口内完成不得产生 taskId");
        assert_eq!(manager.adopts(), 0, "窗口内完成不得调用 adopt");
        assert!(out["stdout"].as_str().unwrap().contains("fast-done"));
    }

    /// 任务卡验收：窗口超时的命令——adopt 恰好一次、参数含 command/cwd/
    /// isDaemon 正确值、返回 taskId
    #[tokio::test]
    async fn background_window_expired_adopts_once() {
        let ws = TempWorkspace::new("bg_window_expire");
        ws.write_file("sub/.keep", "");
        let manager = Arc::new(RecordingBackgroundManager::new());
        let ctx = ToolContext {
            background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
            ..ctx(&ws)
        };
        let t = tool();
        let out = t
            .execute(
                &ctx,
                json!({
                    "command": sleep_cmd(3),
                    "mode": "auto-background",
                    "waitMsBeforeAsync": 300,
                    "cwd": "sub",
                    "resourceMonitor": true
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["mode"], "background");
        let task_id = out["taskId"].as_str().unwrap().to_string();
        assert!(task_id.starts_with("task-"), "taskId 命名风格 task-<seq>");
        assert!(
            out["logPath"].as_str().unwrap().contains(&task_id),
            "logPath 应含 taskId"
        );
        assert!(
            out["text"].as_str().unwrap().contains(&format!("task {task_id}")),
            "text 应提示任务 id"
        );
        // adopt 恰好一次，参数正确
        assert_eq!(manager.adopts(), 1, "adopt 必须恰好调用一次");
        let reqs = manager.adopts_requests();
        assert_eq!(reqs[0].cwd, ws.path().join("sub"), "adopt 参数 cwd 正确");
        assert!(!reqs[0].is_daemon, "auto-background 非 daemon");
        assert!(reqs[0].resource_monitor, "resourceMonitor 透传");
        assert_eq!(reqs[0].owner_run_id, None, "R-AB1 不携带 run 关联（R-AB3 接线）");
        assert!(reqs[0].command.len() <= 64, "命令摘要前 64 字符");
    }

    /// 任务卡验收：background=None 时窗口超时仍走树杀
    /// （回归 shell_timeout_kills_and_marks 语义）
    #[tokio::test]
    async fn background_none_keeps_tree_kill() {
        let ws = TempWorkspace::new("bg_none");
        let t = tool();
        let out = t
            .execute(
                &ctx(&ws),
                json!({ "command": sleep_cmd(10), "mode": "auto-background", "timeoutMs": 2000 }),
            )
            .await
            .unwrap();
        assert_eq!(out["timedOut"], true, "未接线时超时仍走树杀");
        assert_eq!(out["mode"], "sync");
        assert!(out["stderr"].as_str().unwrap().contains("超时"));
    }

    /// 任务卡验收：模式 3（daemon）立即 adopt（不经过等待窗口，is_daemon=true）
    #[tokio::test]
    async fn daemon_mode_adopts_immediately() {
        let ws = TempWorkspace::new("bg_daemon");
        let manager = Arc::new(RecordingBackgroundManager::new());
        let ctx = ToolContext {
            background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
            ..ctx(&ws)
        };
        let t = tool();
        let out = t
            .execute(&ctx, json!({ "command": sleep_cmd(3), "mode": "daemon" }))
            .await
            .unwrap();
        assert_eq!(out["mode"], "background");
        assert!(out["taskId"].as_str().is_some());
        assert_eq!(manager.adopts(), 1, "daemon 模式立即 adopt");
        assert!(manager.adopts_requests()[0].is_daemon, "is_daemon 必须置位");
    }

    /// 任务卡验收：kill_on_drop(false) 生效——spawn 后 drop 掉 Child 引用，
    /// 进程仍存活（用 Start-Sleep 类命令断言 pid 存活）
    // G2 禁令豁免：测试直接 spawn 探测 kill_on_drop 语义（非命令门禁执行面）
    #[allow(clippy::disallowed_methods)]
    #[tokio::test]
    async fn kill_on_drop_false_child_survives_drop() {
        let (program, args, _) = build_shell_invocation(&sleep_cmd(10)).expect("invocation 构造失败");
        let mut child_cmd = TokioCommand::new(&program);
        child_cmd
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        #[cfg(windows)]
        {
            #[allow(unused_imports)]
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            child_cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = child_cmd.spawn().expect("spawn 失败");
        let pid = child.id().expect("pid 缺失");
        drop(child);
        // 等 600ms 后进程应仍存活（kill_on_drop(false) 下 drop 不杀）
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            process_alive(pid),
            "kill_on_drop(false) 下 drop Child 不得杀进程"
        );
        // 清理：树杀（避免测试残留进程）
        let _ = terminate_process_tree(pid);
    }

    /// 进程存活探测（Windows tasklist / Unix /proc）
    fn process_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}")])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
                .unwrap_or(false)
        }
        #[cfg(not(windows))]
        {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }
    }

    // ===== T-AB-03：输出防溢（PAGER / 截断落盘 / 高输出建议）=====

    /// 任务卡验收：1MB 输出 → truncated=true、logPath 非空、文件为完整原始输出
    #[tokio::test]
    async fn shell_output_full_log_saved() {
        let ws = TempWorkspace::new("shell_spill");
        let t = tool();
        let ctx = ToolContext {
            log_root: Some(ws.path().join("logs")),
            ..ctx(&ws)
        };
        let command = big_output_cmd('y', 1_048_576);
        let out = t
            .execute(
                &ctx,
                json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 100000 }),
            )
            .await
            .unwrap();
        assert_eq!(out["truncated"], true, "1MB 输出应判定截断");
        let log_path = out["logPath"].as_str().expect("截断应回填 logPath").to_string();
        let file_bytes = std::fs::read(&log_path).expect("完整日志文件应存在");
        assert_eq!(
            file_bytes.iter().filter(|&&b| b == b'y').count(),
            1_048_576,
            "日志文件必须为完整原始输出"
        );
        let text = out["text"].as_str().unwrap();
        assert!(
            text.contains("输出已截断，完整日志保存在"),
            "text 尾部应追加完整日志指引"
        );
        assert!(text.contains("可通过文件读取工具查看完整内容"));
    }

    /// 任务卡验收：注入不可写 log_root——命令仍成功执行且 logPath 缺失
    /// （不 panic 不失败，best-effort 降级）
    #[tokio::test]
    async fn shell_output_spill_failure_degrades() {
        let ws = TempWorkspace::new("shell_spill_fail");
        let t = tool();
        // log_root 指向「文件」而非目录 → create_dir_all 失败 → 降级无 logPath
        let file_path = ws.path().join("not-a-dir");
        std::fs::write(&file_path, "x").unwrap();
        let ctx = ToolContext {
            log_root: Some(file_path),
            ..ctx(&ws)
        };
        let command = big_output_cmd('z', 1_048_576);
        let out = t
            .execute(
                &ctx,
                json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 100000 }),
            )
            .await
            .unwrap();
        assert_eq!(out["truncated"], true);
        assert!(out.get("logPath").is_none(), "写盘失败应无 logPath（不失败不 panic）");
        assert_eq!(out["timedOut"], false, "命令仍成功执行");
    }

    /// 任务卡验收：spawn 的子进程环境含 PAGER=cat
    #[tokio::test]
    async fn shell_pager_env_set() {
        let ws = TempWorkspace::new("shell_pager");
        let t = tool();
        let command = if cfg!(windows) {
            "Write-Output $env:PAGER"
        } else {
            "echo $PAGER"
        };
        let out = t
            .execute(&ctx(&ws), json!({ "command": command }))
            .await
            .unwrap();
        assert_eq!(out["timedOut"], false);
        assert!(
            out["stdout"].as_str().unwrap().contains("cat"),
            "子进程环境必须含 PAGER=cat"
        );
    }

    /// 高输出命令建议（纯函数）：git log 无 -n / git diff 无 --stat 命中，
    /// 带限制参数不命中
    #[test]
    fn high_output_suggestion_forms() {
        assert!(high_output_suggestion("git log").is_some());
        assert!(high_output_suggestion("git log --oneline").is_none());
        assert!(high_output_suggestion("git log -n 5").is_none());
        assert!(high_output_suggestion("git log --max-count=10").is_none());
        assert!(high_output_suggestion("git diff").is_some());
        assert!(high_output_suggestion("git diff --stat").is_none());
        assert!(high_output_suggestion("git show").is_some());
        assert!(high_output_suggestion("git status").is_none());
        assert!(high_output_suggestion("npm test").is_none());
    }

    // ===== T-AB-04：禁 cd 工具层拦截 =====

    /// 任务卡验收：`shell_command({command: "cd sub"})` 返回拦截文案
    /// （含「Cwd 参数」）
    #[tokio::test]
    async fn shell_cd_blocked_with_cwd_guidance() {
        let ws = TempWorkspace::new("shell_cd_block");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "cd sub" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_CD_BLOCKED);
        assert!(err.to_string().contains("Cwd 参数"));
        assert!(err.to_string().contains("而非 cd 命令"));
    }

    /// 任务卡验收：`cd sub && git status` 整链拦截（链内其他段不代为执行）
    #[tokio::test]
    async fn shell_cd_chain_intercepted() {
        let ws = TempWorkspace::new("shell_cd_chain");
        let t = tool();
        let err = t
            .execute(&ctx(&ws), json!({ "command": "cd sub && git status" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_CD_BLOCKED);
        assert!(err.to_string().contains("整链"));
        assert!(err.to_string().contains("Cwd 参数"));
    }

    /// 任务卡验收：`git status` + cwd 参数正常执行（不被 cd 拦截误伤）
    #[tokio::test]
    async fn shell_git_status_with_cwd_executes() {
        let ws = TempWorkspace::new("shell_cd_cwd_ok");
        ws.write_file("sub/.keep", "");
        let t = tool();
        let out = t
            .execute(&ctx(&ws), json!({ "command": "git status", "cwd": "sub" }))
            .await
            .unwrap();
        assert_eq!(out["timedOut"], false);
        assert!(
            out["exitCode"].is_number(),
            "git 应真实执行并产生退出码（临时目录非 git 仓库时 128）"
        );
    }

    /// 任务卡验收：`git -C` 形态不误拦（不依赖进程内目录状态的形态放行）
    #[tokio::test]
    async fn shell_git_dash_c_not_blocked() {
        let ws = TempWorkspace::new("shell_cd_gitc");
        ws.write_file("sub/.keep", "");
        let t = tool();
        let out = t
            .execute(&ctx(&ws), json!({ "command": "git -C sub status" }))
            .await
            .unwrap();
        assert_eq!(out["timedOut"], false);
        assert!(
            out["exitCode"].is_number(),
            "git -C 形态不得被 cd 拦截误伤"
        );
    }

    /// 冻结接口 #3（conex-sandbox T-AB-05 语义层）：cd / Set-Location / sl /
    /// pushd / popd 命中；git -C / echo "cd x" 不命中
    #[test]
    fn classify_cd_shape_variants() {
        use conex_sandbox::semantics::{classify_command_segments, CommandClass};
        assert_eq!(
            classify_command_segments(&["cd sub".to_string()]),
            CommandClass::CdShape
        );
        assert_eq!(
            classify_command_segments(&["cd".to_string()]),
            CommandClass::CdShape
        );
        assert_eq!(
            classify_command_segments(&["cd /d".to_string(), "git status".to_string()]),
            CommandClass::CdShape
        );
        assert_eq!(
            classify_command_segments(&["set-location sub".to_string()]),
            CommandClass::CdShape
        );
        assert_eq!(
            classify_command_segments(&["sl sub".to_string()]),
            CommandClass::CdShape
        );
        assert_eq!(
            classify_command_segments(&["pushd x".to_string(), "popd".to_string()]),
            CommandClass::CdShape
        );
        // 不命中：git -C 不依赖进程内目录状态；echo "cd x" 段首非 cd
        assert_eq!(
            classify_command_segments(&["git -C src status".to_string()]),
            CommandClass::Normal
        );
        assert_eq!(
            classify_command_segments(&["echo cd x".to_string()]),
            CommandClass::Normal
        );
        assert_eq!(
            classify_command_segments(&["git status".to_string()]),
            CommandClass::Normal
        );
    }

    /// mode 入参解析：未知值结构化报错，缺省 sync
    #[test]
    fn parse_mode_rejects_unknown_and_defaults_sync() {
        let err = parse_mode(&json!({ "mode": "async" })).unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
        assert!(err.to_string().contains("auto-background"));
        assert_eq!(parse_mode(&json!({})).unwrap(), ShellMode::Sync);
        assert_eq!(
            parse_mode(&json!({ "mode": "auto-background" })).unwrap(),
            ShellMode::AutoBackground
        );
        assert_eq!(
            parse_mode(&json!({ "mode": "daemon" })).unwrap(),
            ShellMode::Daemon
        );
    }
}
