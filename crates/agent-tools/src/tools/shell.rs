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

use crate::audit::{NoopAuditSink, SecurityAuditSink};
use crate::background::BackgroundTaskManager;
use crate::context::{AskDecision, ToolContext};
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::permission::{PermissionMode, PermissionVerdict};
use crate::streaming::{terminal_only, ToolStream};
use crate::tools::{
    display_path, optional_bool, optional_string, optional_u64, require_string,
    resolve_workspace_path,
};
use async_trait::async_trait;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

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

/// 预检结果（execute / execute_stream 共用准备面，S1 §3.1.6）：
/// - `Run`：通过全部预检，携带执行参数（门禁 / 审批 / 删除形态 / cd 形态
///   均已放行）；
/// - `Done`：无需执行——拦截 / 审批拒绝 / 删除重定向 / 入参错误的既定结果，
///   两条执行路径经本面保证输出逐字节一致（防各自复制逻辑漂移）。
enum Prepared {
    Run(PreparedCommand),
    Done(Result<serde_json::Value, ToolError>),
}

/// u64 → usize 钳制转换（F3-16）：32 位平台裸 `as usize` 截断会把超大值
/// 变形成小值（如 maxOutputBytes=4GiB+1 → 1，输出预算从「宽松」变「极紧」
/// 并静默截断输出）；钳到 usize::MAX 保「大 = 预算宽松」语义。64 位恒等。
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
    /// 预检（execute / execute_stream 共用）：入参解析 → 命令门禁 →
    /// 审批通道 → 删除形态重定向 → cd 形态拦截。任何拦截 / 错误收敛为
    /// `Prepared::Done`（既定结果），放行返回 `Prepared::Run`（执行参数）。
    ///
    /// S1 验收（§3.1.6）：流式路径与旧 execute 路径的错误面 / 重定向面
    /// 逐字节一致——两路径必须共用本函数，不得各自复制逻辑。
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
        // F3-16：u64→usize 钳制（32 位平台截断失真防护；64 位恒等）
        let max_output_bytes = clamp_u64_to_usize(
            optional_u64(args, "maxOutputBytes").unwrap_or(self.max_output_bytes as u64),
        );
        // T-AB-02：三模式入参（mode / waitMsBeforeAsync / isDaemon / resourceMonitor）
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

        // 权限集中评估（P1 权限归一 A2/D8：命令判定唯一链 =
        // decide_analysis_with_revert，与执行器 call_verdict 同链——不再存在
        // 第二套命令评估实现；门禁层上下文感知（工作区越界 / 危险形态 →
        // RequiresApproval）折算为 requires_approval 入链；工具级形态机制
        // （物理红线 / Plan 阻断 / 删除重定向 / CD 拦截）保持为工具行为，
        // 不构成平行 allow/deny 判定）
        // U-GATE / 14-SB2：analyze 恰 1 次 → 沿链传递门禁 + decide + 工具形态
        let analysis = conex_sandbox::semantics::analyze(&command);
        let full_line = command.clone();

        // 0. TaskType 白名单刚性检查（BC10-6）：
        // 对 commit 等任务类型代理，严格调用 command_allowed_for_task_type 门禁，除 git 外禁止执行任何 shell 命令
        if let Some(task_type) = &ctx.task_type {
            if !crate::readonly::command_allowed_for_task_type(task_type, &command) {
                emit_blocked_audit(
                    &self.audit_sink,
                    ctx,
                    conex_types::events::SecurityAuditOperation::CommandExec,
                    vec![command.clone()],
                );
                return Prepared::Done(Err(ToolError::new(
                    TOOL_COMMAND_BLOCKED,
                    format!(
                        "PermissionDenied: 任务类型 [{task_type}] 严格禁止执行非白名单命令：{command}"
                    ),
                )));
            }
        }

        let gate_result = conex_sandbox::gatekeeper::SHARED_GATEKEEPER
            .check_command_with_context_and_analysis(
                &analysis,
                &command,
                &[],
                &full_line,
                &gate_path(&cwd),
                &gate_path(workspace_root),
            );

        // 1. 物理红线（门禁层 Blocked = 静态清单 + 语义 Redline）与系统核心
        //    关键目录：一律 Deny（S2/S4 定理，任何权限模式不可豁免）
        if gate_result == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
            || conex_fs::ConexPathNormalizer::is_system_critical_path(&cwd)
        {
            emit_blocked_audit(
                &self.audit_sink,
                ctx,
                conex_types::events::SecurityAuditOperation::CommandExec,
                vec![command.clone()],
            );
            return Prepared::Done(Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                format!(
                    "PermissionDenied: Command blocked by safety red-line gatekeeper: {command}"
                ),
            )));
        }

        // 2. Plan 模式硬性阻断（DIM-04：只读规划模式严禁执行任何 Shell 命令）
        if ctx.permission_mode == PermissionMode::Plan {
            return Prepared::Done(Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                "PermissionDenied: Shell command execution is prohibited in Plan (Read-Only) mode."
                    .to_string(),
            )));
        }

        // 3. 删除形态重定向（I2-S4 / BC10-7）：彻底拔除 FullAccess 特权分支！
        //    无论是 Ask 还是 FullAccess 模式，只要判定为 DeleteShape 或间接删除，
        //    一律强制走回收站 WAL 事务体系，计算 SHA-256 校验和并创建快照备份，
        //    彻底杜绝物理抹除！
        if analysis.overall_class == conex_sandbox::semantics::CommandClass::DeleteShape
            || analysis.has_indirect_delete
        {
            return Prepared::Done(redirect_or_intercept_delete(
                &analysis,
                &command,
                workspace_root,
                &cwd,
                self.trash_root.clone(),
                ctx,
                Arc::clone(&self.audit_sink),
            ));
        }

        // 4. CD 形态拦截（T-AB-04：引导使用 cwd 参数）
        if let Some(err) = intercept_cd_shape(&analysis, &command) {
            return Prepared::Done(Err(ToolError::new(TOOL_CD_BLOCKED, err.to_string())));
        }

        // 4.1 绝对路径安全围栏（BC10-4：正文绝对路径系统关键目录物理红线与工作区越界写/删阻断）
        if let Err(e) = CommandPathInspector::inspect(&command, workspace_root) {
            emit_blocked_audit(
                &self.audit_sink,
                ctx,
                conex_types::events::SecurityAuditOperation::CommandExec,
                vec![command.clone()],
            );
            return Prepared::Done(Err(e));
        }

        // 5. 单一判定链（红线先行 → C3 回退护栏 → 三态矩阵）：越界/危险形态
        //    由门禁层折算为 requires_approval 入链（Ask 矩阵 → NeedsApproval
        //    → ctx.ask 审批通道）；回退护栏用默认策略（与执行器
        //    ToolExecutor 默认同源，保证 pre/during 判定同链同果）
        let requires_approval =
            gate_result == conex_sandbox::gatekeeper::GatekeeperResult::RequiresApproval;
        let verdict = crate::permission::decide_analysis_with_revert(
            &analysis,
            false,
            requires_approval,
            ctx.permission_mode,
            &crate::revert::RevertPolicy::default(),
        );
        match verdict {
            PermissionVerdict::Deny => {
                return Prepared::Done(Err(ToolError::new(
                    TOOL_COMMAND_BLOCKED,
                    format!("PermissionDenied: Command denied by permission policy: {command}"),
                )));
            }
            PermissionVerdict::NeedsApproval => match &ctx.ask {
                Some(ask) => match ask.ask(&self.def.name, args).await {
                    Ok(AskDecision::Allowed) => {}
                    Ok(AskDecision::Denied { reason }) => {
                        return Prepared::Done(Err(ToolError::new(
                            TOOL_USER_DENIED,
                            format!("user denied: {reason}"),
                        )));
                    }
                    Err(err) => return Prepared::Done(Err(err)),
                },
                None => {
                    return Prepared::Done(Err(ToolError::new(
                        TOOL_REQUIRES_APPROVAL,
                        format!("Command requires approval: {command}"),
                    )));
                }
            },
            PermissionVerdict::Allow => {}
        }

        // 执行上下文：三模式（manager 优先读会话级 ToolContext.background，
        // 回退注册配置）
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
            // 预检已定结果（拦截 / 审批拒绝 / 删除重定向 / 入参错误）原样返回
            Prepared::Done(result) => result,
            // 执行：三模式（manager 优先读会话级 ToolContext.background，
            // 回退注册配置）
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

    /// S1 流式执行（TOOLS-01 §3.1.6）：tokio process 逐块读 stdout/stderr
    /// （async read），每块 `ToolProgress::Text` 推送（stderr 块带
    /// `[stderr] ` 前缀——展示面可区分，聚合结果 stderr 字段独立捕获，
    /// 形状不变）；进程退出后 Terminal 返回聚合结果——复用
    /// build_sync_result，output/json 形状与 execute 完全一致（退出码 /
    /// stderr 捕获 / 截断 / 超时 / 落盘）。
    ///
    /// 预算：maxOutputBytes 升级为**累计流式字节预算**（§3.1.6）——累计
    /// 超限即停止推送 Progress（结果仍标记 truncated，语义与现状 200KB
    /// 上限一致，只是从「事后截断」变「实时截断」）；管道仍持续排空
    /// （防子进程写满管道阻塞 → 超时误判，行为与 execute 一致）。
    ///
    /// abort：每块读取前自查 ctx.abort_token（§3.1.6）——中止即停止推送、
    /// 杀进程尽快收口（执行器侧 drop 流完成取消，已发 Progress 保留，
    /// §3.1.8「drop 即取消」）。
    ///
    /// 非 sync 模式（auto-background / daemon）回落既有 execute：管道
    /// 转移 / 收养语义逐字节不变，流式改造只覆盖 sync 路径。
    async fn execute_stream(&self, ctx: &ToolContext, args: serde_json::Value) -> ToolStream {
        // 模式预解析：非法 mode 交给 prepare 以既有错误路径收口（此处
        // 缺省 sync 仅用于路径分流，不改变错误文案）
        if parse_mode(&args).unwrap_or(ShellMode::Sync) != ShellMode::Sync {
            return terminal_only(self.execute(ctx, args).await);
        }
        match self.prepare(ctx, &args).await {
            // 预检已定结果（拦截 / 审批拒绝 / 删除重定向 / 入参错误）：
            // 单元素流，与 execute 返回逐字节一致
            Prepared::Done(result) => terminal_only(result),
            Prepared::Run(c) => run_command_streaming(ctx, c).await,
        }
    }
}

/// 编译期常量正则的惰性缓存（结果含错误：编译失败不得 panic）
type CompiledRegex = LazyLock<Result<Regex, regex::Error>>;

/// 取用编译期常量正则。
///
/// 模式串是固定字面量，编译失败属程序缺陷；但安全围栏必须 fail-closed
/// 且不能以 panic 打死整轮执行，故统一转成工具错误上抛。
fn compiled_regex(
    cell: &'static CompiledRegex,
    name: &'static str,
) -> Result<&'static Regex, ToolError> {
    cell.as_ref().map_err(|e| {
        ToolError::execution_failed(
            "shell_command",
            format!("命令路径围栏正则 {name} 编译失败（内部缺陷）：{e}"),
        )
    })
}

/// 命令行绝对路径安全围栏（BC10-4）
pub struct CommandPathInspector;

impl CommandPathInspector {
    /// 检查命令中的绝对路径安全围栏（系统关键目录红线 + 写/删目标越界阻断）
    pub fn inspect(command_line: &str, workspace_root: &Path) -> Result<(), ToolError> {
        let extracted_paths = Self::extract_absolute_paths(command_line)?;

        for path in &extracted_paths {
            // 1. 系统核心关键目录物理红线（命中则刚性 Deny 阻断）
            if Self::is_critical_path(path) {
                return Err(ToolError::new(
                    TOOL_COMMAND_BLOCKED,
                    format!(
                        "PermissionDenied: 命令包含指向系统核心关键目录的敏感路径：{}，硬性阻断！",
                        path.display()
                    ),
                ));
            }

            // 2. 校验写/删目标路径是否越出 workspace_root
            if Self::is_write_or_delete_target(command_line, path)
                && !conex_fs::ConexPathNormalizer::is_subpath(path, workspace_root)
            {
                return Err(ToolError::new(
                    TOOL_COMMAND_BLOCKED,
                    format!(
                        "PermissionDenied: 命令试图向工作区外写入或删除绝对路径：{}，严禁越界！",
                        path.display()
                    ),
                ));
            }
        }

        Ok(())
    }

    /// 从命令行中提取所有绝对路径候选
    ///
    /// 返回值改为 `Result`：正则编译失败（内部缺陷）以工具错误上抛，
    /// 绝不 panic；调用方 `inspect` 直接 `?` 传播。
    pub fn extract_absolute_paths(command_line: &str) -> Result<Vec<PathBuf>, ToolError> {
        static WIN_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?i)(?:\A|[^a-zA-Z0-9_./\\-])([a-zA-Z]:(?:[\\/][^\s"'`=,;()<>{}\r\n*?|]*)?)"#)
        });

        static QUOTED_WIN_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?i)["']([a-zA-Z]:[\\/][^"'\r\n*?|]+)["']"#)
        });

        static UNIX_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])(/[\w.\-]+(?:/[\w.\-]+)*)"#)
        });

        static QUOTED_UNIX_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"["'](/[^"'\r\n*?|]+)["']"#)
        });

        static STANDALONE_ROOT_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])/(?:\z|[^a-zA-Z0-9_./\\-])"#)
        });

        static UNC_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])((?:\\\\|//)[^\s"'`=,;()<>{}\r\n*?|]+)"#)
        });

        static QUOTED_UNC_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"["']((?:\\\\|//)[^"'\r\n*?|]+)["']"#)
        });

        static HOME_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"(?:\A|[^a-zA-Z0-9_./\\-])(~[\\/][^\s"'`=,;()<>{}\r\n*?|]*)"#)
        });

        static QUOTED_HOME_PATH_REGEX: CompiledRegex = LazyLock::new(|| {
            Regex::new(r#"["'](~[\\/][^"'\r\n*?|]*)["']"#)
        });

        let mut paths = Vec::new();

        // 0. 引号包裹路径（支持空格，如 "C:/Program Files/..."）
        for cap in compiled_regex(&QUOTED_WIN_PATH_REGEX, "QUOTED_WIN_PATH")?
            .captures_iter(command_line)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }
        for cap in compiled_regex(&QUOTED_UNIX_PATH_REGEX, "QUOTED_UNIX_PATH")?
            .captures_iter(command_line)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if is_valid_unix_path(&s) {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }
        for cap in compiled_regex(&QUOTED_UNC_PATH_REGEX, "QUOTED_UNC_PATH")?
            .captures_iter(command_line)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }
        for cap in compiled_regex(&QUOTED_HOME_PATH_REGEX, "QUOTED_HOME_PATH")?
            .captures_iter(command_line)
        {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 1. Windows 盘符路径
        for cap in compiled_regex(&WIN_PATH_REGEX, "WIN_PATH")?.captures_iter(command_line) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 2. Unix 绝对路径
        for cap in compiled_regex(&UNIX_PATH_REGEX, "UNIX_PATH")?.captures_iter(command_line) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if is_valid_unix_path(&s) {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 3. 独立根路径 /
        if compiled_regex(&STANDALONE_ROOT_REGEX, "STANDALONE_ROOT")?.is_match(command_line) {
            let root = PathBuf::from("/");
            if !paths.contains(&root) {
                paths.push(root);
            }
        }

        // 4. UNC 路径
        for cap in compiled_regex(&UNC_PATH_REGEX, "UNC_PATH")?.captures_iter(command_line) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        // 5. 家目录路径 (~/...)
        for cap in compiled_regex(&HOME_PATH_REGEX, "HOME_PATH")?.captures_iter(command_line) {
            if let Some(m) = cap.get(1) {
                let s = clean_path_candidate(m.as_str());
                if !s.is_empty() {
                    let pb = PathBuf::from(s);
                    if !paths.contains(&pb) {
                        paths.push(pb);
                    }
                }
            }
        }

        Ok(paths)
    }

    /// 判定路径是否为系统核心关键目录或敏感文件（物理红线）
    pub fn is_critical_path(path: &Path) -> bool {
        if conex_fs::ConexPathNormalizer::is_system_critical_path(path) {
            return true;
        }

        let norm = conex_fs::ConexPathNormalizer::normalize(path);
        let s = norm.to_string_lossy().replace('\\', "/");
        let upper = s.to_ascii_uppercase();

        if s == "/" || upper == "/" || upper == "/*" || upper == "/." {
            return true;
        }

        if upper.len() >= 2
            && upper
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false)
            && &upper[1..2] == ":"
            && (upper.len() == 2
                || (upper.len() == 3 && &upper[2..3] == "/")
                || (upper.len() >= 4 && (&upper[2..4] == "/*" || &upper[2..4] == "/.")))
        {
            return true;
        }

        const POSIX_CRITICAL: &[&str] = &[
            "/BIN", "/SBIN", "/USR/BIN", "/USR/SBIN", "/ETC",
            "/BOOT", "/DEV", "/PROC", "/SYS", "/LIB", "/LIB64", "/VAR/RUN",
        ];
        for crit in POSIX_CRITICAL {
            if upper == *crit || upper.starts_with(&format!("{crit}/")) {
                return true;
            }
        }

        const WIN_CRITICAL: &[&str] = &[
            "WINDOWS",
            "PROGRAM FILES",
            "PROGRAM FILES (X86)",
            "PROGRAMDATA/MICROSOFT",
            "SYSTEM VOLUME INFORMATION",
            "RECOVERY",
            "BOOT",
            "$RECYCLE.BIN",
        ];
        if upper.len() >= 3 && &upper[1..3] == ":/" {
            let after_drive = &upper[3..];
            for win_pat in WIN_CRITICAL {
                if after_drive == *win_pat || after_drive.starts_with(&format!("{win_pat}/")) {
                    return true;
                }
            }
        }

        if upper.contains("/.SSH")
            || upper.contains("/.GNUPG")
            || upper.contains("/.AWS")
            || upper.contains("/.KUBE")
            || upper.contains("/.GITCONFIG")
            || upper.starts_with("~/.SSH")
            || upper.starts_with("~/.GNUPG")
            || upper.starts_with("~/.AWS")
        {
            return true;
        }

        false
    }

    /// 判定路径是否作为写入或删除目标出现在命令中
    pub fn is_write_or_delete_target(command_line: &str, path: &Path) -> bool {
        let p_str = path.to_string_lossy();
        let p_clean = p_str.trim();
        if p_clean.is_empty() {
            return false;
        }

        let p_escaped = regex::escape(p_clean);
        let p_alt = regex::escape(&p_clean.replace('/', "\\"));
        let p_fwd = regex::escape(&p_clean.replace('\\', "/"));
        let p_pattern = format!("(?:{p_escaped}|{p_alt}|{p_fwd})");

        // 1. 重定向写入目标: > path, >> path, 1> path, 2> path, | Out-File path, | Set-Content path, | Add-Content path, | tee path
        let redir_pat = format!(
            r#"(?i)(?:>>?|[12]>>?|\bOut-File\s+(?:-FilePath\s+)?|\bSet-Content\s+(?:-Path\s+)?|\bAdd-Content\s+(?:-Path\s+)?|\btee\s+(?:-a\s+)?)\s*['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&redir_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        // 2. 删除命令参数: rm path, del path, Remove-Item path, rmdir path, git rm path, unlink path
        let del_pat = format!(
            r#"(?i)\b(?:rm|del|erase|rmdir|rd|Remove-Item|ri|unlink|git\s+rm)\b[^\r\n;|&]*?['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&del_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        // 3. 文件修改/创建命令目标: touch path, mkdir path, New-Item path, truncate path, cp/mv destination
        let create_pat = format!(
            r#"(?i)\b(?:touch|mkdir|New-Item|truncate|sed\s+-i)\b[^\r\n;|&]*?['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&create_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        let copy_move_pat = format!(
            r#"(?i)\b(?:cp|mv|copy|move|Move-Item|Copy-Item)\b[^\r\n;|&]*\s+['"]?{p_pattern}(?:\s|$|['"\r\n;|&,)])"#
        );
        if let Ok(re) = Regex::new(&copy_move_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        // 4. 多语言解释器删除 API 内部目标
        let poly_del_pat = format!(
            r#"(?i)\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir)|fs\.(?:promises\.)?(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)|FileUtils\.(?:rm_rf|rm_r|rm)|File\.(?:delete|unlink)|Dir\.(?:delete|rmdir))\s*\(\s*['"]?{p_pattern}['"]?"#
        );
        if let Ok(re) = Regex::new(&poly_del_pat) {
            if re.is_match(command_line) {
                return true;
            }
        }

        false
    }
}

fn clean_path_candidate(raw: &str) -> String {
    let mut s = raw
        .trim()
        .trim_matches(['"', '\'', '`', ',', ';', '(', ')', '[', ']', '{', '}'])
        .to_string();
    while s.ends_with(')') && !s.contains('(') {
        s.pop();
    }
    while s.ends_with(']') && !s.contains('[') {
        s.pop();
    }
    while s.ends_with('}') && !s.contains('{') {
        s.pop();
    }
    s
}

fn is_valid_unix_path(s: &str) -> bool {
    if !s.starts_with('/') {
        return false;
    }
    if s[1..].contains('/') {
        return true;
    }
    let rest = &s[1..];
    // 单字符且为 ASCII 字母视作 Windows 盘符（如 /c），不是 Unix 路径
    if rest.len() == 1 && matches!(rest.chars().next(), Some(ch) if ch.is_ascii_alphabetic()) {
        return false;
    }
    const WIN_FLAGS: &[&str] = &[
        "quiet", "norestart", "passive", "wait", "min", "max", "help",
    ];
    if WIN_FLAGS.contains(&rest.to_ascii_lowercase().as_str()) {
        return false;
    }
    const KNOWN_UNIX_DIRS: &[&str] = &[
        "etc", "bin", "sbin", "usr", "var", "tmp", "dev", "proc", "sys",
        "boot", "lib", "lib64", "root", "home", "opt", "mnt", "media", "srv",
    ];
    if KNOWN_UNIX_DIRS.contains(&rest.to_ascii_lowercase().as_str()) {
        return true;
    }
    rest.contains('.') || rest.len() > 2
}

// ==================== 拆分接线（SR-06a-2 · 结构拆分 · ≠ EL）====================
//
// 本文件为薄门面：ShellCommandTool（工具定义 / 预检 prepare / 执行入口）与
// Prepared / PreparedCommand 保留于此；实现按逻辑域拆入四个子模块：
//   shell_invoke（命令构造 / 模式解析 / 文本解码）
//   shell_redirect（删除形态重定向 / 拦截 / 审计发射）
//   shell_exec（前后台执行 / 流式状态机 / 进程树杀）
//   shell_output（输出读取 / 累积 / 结果构造 / 落盘）
// 测试整体外置 shell_tests.rs（#[path] 接线，零删除）。
// 诚实边界：仅结构拆分，语义零改动（≠ EL-01…10 / ≠ 打开完成 / ≠ 结构债清零）。
#[path = "shell_exec.rs"]
mod shell_exec;
#[path = "shell_invoke.rs"]
mod shell_invoke;
#[path = "shell_output.rs"]
mod shell_output;
#[path = "shell_redirect.rs"]
mod shell_redirect;

pub(crate) use shell_exec::{run_command_maybe_background, run_command_streaming};
pub(crate) use shell_invoke::{parse_mode, ShellMode};
pub(crate) use shell_redirect::{
    emit_blocked_audit, gate_path, intercept_cd_shape, redirect_or_intercept_delete,
};

#[cfg(test)]
#[path = "shell_tests/mod.rs"]
mod tests;
