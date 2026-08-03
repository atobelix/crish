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

use crate::context::{AskDecision, ToolContext};
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{
    display_path, optional_string, optional_u64, require_string, resolve_workspace_path,
    delete::DEFAULT_TRASH_DIR_NAME,
};
use async_trait::async_trait;
use conex_fs::impact::ImpactAssessment;
use conex_fs::trash::TrashService;
use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
use conex_sandbox::semantics::{CommandClass, SemanticAnalysis};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

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

/// 命令执行工具
pub(crate) struct ShellCommandTool {
    def: ToolDefinition,
    default_timeout_ms: u64,
    max_output_bytes: usize,
    /// 删除重定向的回收站根（I2-S4：None 时执行期回退工作区 `.crish-trash`，
    /// 与 delete 工具共用 `BuiltinToolConfig.trash_root`）
    trash_root: Option<PathBuf>,
}

impl ShellCommandTool {
    pub(crate) fn new(
        default_timeout_ms: u64,
        max_output_bytes: usize,
        trash_root: Option<PathBuf>,
    ) -> Self {
        Self {
            def: ToolDefinition {
                name: "shell_command".to_string(),
                description: "执行项目命令并等待完成（git status、快速脚本等）。先经命令门禁检查，越界命令需审批。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "要执行的命令" },
                        "cwd": { "type": "string", "description": "工作目录（工作区内相对或绝对路径），缺省为工作区根" },
                        "timeoutMs": { "type": "number", "description": "超时毫秒数，默认 30000" },
                        "maxOutputBytes": { "type": "number", "description": "保留输出上限（字节），默认 200000" }
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

        // 命令门禁：越界/危险命令在解析前先拦下（对齐 workbench_run_shell）
        // 上下文字符串统一为门禁比较格式：剥离 \\?\ 前缀、反斜杠转斜杠、Windows 小写
        let gatekeeper = CommandGatekeeper::new();
        let cwd_str = gate_path(&cwd);
        let root_str = gate_path(workspace_root);
        let verdict = gatekeeper.check_command_with_context(&command, &[], &cwd_str, &root_str);
        if verdict == GatekeeperResult::Blocked || gatekeeper.patterns().is_match(&command) {
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
            );
        }

        run_command(&command, &cwd, timeout_ms, max_output_bytes).await
    }
}

/// 删除形态引导文案（模型可改走统一删除接口）
const DELETE_REDIRECT_GUIDANCE: &str =
    "如确需删除请改用 delete_file / delete_dir 工具（统一删除接口，可恢复）";

/// 删除形态重定向（I2-S4 主入口）：
/// - 间接执行包裹删除形态 → 整链拦截 + 引导（外层无法安全解析内层目标）；
/// - 复合链含删除段 → 整链拦截 + 引导（链内其他段副作用不可控，不代为执行）；
/// - 纯删除命令 → 解析目标（工作区外一律拒绝）→ trash 服务移入回收站 →
///   返回 TrashEntry 列表（entryId 供恢复）+ 影响面审计载荷。
fn redirect_or_intercept_delete(
    analysis: &SemanticAnalysis,
    command: &str,
    workspace_root: &Path,
    cwd: &Path,
    trash_root: Option<PathBuf>,
    ctx: &ToolContext,
) -> Result<serde_json::Value, ToolError> {
    // 1. 间接执行包裹（bash -c 'rm x' / xargs rm 等）：内层目标无法安全解析，
    //    整链拦截 + 引导，防包裹绕过统一删除门禁
    if analysis.has_indirect_delete {
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
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到复合命令链中的物理删除形态，整链已拦截（链内其他段副作用不可控）；{DELETE_REDIRECT_GUIDANCE}。原始命令：{command}"
            ),
        ));
    }
    // 3. 无法解析删除目标（如 rm --cached 无路径）→ 拦截 + 引导
    if analysis.delete_targets.is_empty() {
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
        targets.push(resolve_delete_target(workspace_root, cwd, target)?);
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
    // 6. 审计日志（结构化安全审计；工具结果经 tool-end 事件流落库）
    let entry_ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["entryId"].as_str())
        .collect();
    let target_displays: Vec<String> = targets
        .iter()
        .map(|t| t.display().to_string())
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

/// 执行命令并收集输出（超时则树杀）
async fn run_command(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
    max_output_bytes: usize,
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
        .kill_on_drop(true);
    // Windows：隐藏控制台闪现（trait 方法已稳定，导入仅保编译兼容）
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 子进程优先 UTF-8 输出
    child_cmd.env("PYTHONUTF8", "1");
    child_cmd.env("PYTHONIOENCODING", "utf-8");

    let child = child_cmd
        .spawn()
        .map_err(|e| ToolError::execution_failed("shell_command", format!("failed to spawn {shell_label}: {e}")))?;
    let child_pid = child.id();
    let started = std::time::Instant::now();

    // wait_with_output 会拿走 child；超时后靠 kill_on_drop + 树杀兜底
    let wait_fut = child.wait_with_output();
    let timed = timeout(Duration::from_millis(timeout_ms), wait_fut).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match timed {
        Ok(Ok(output)) => {
            let (stdout, trunc_out) = clamp_output_bytes(&output.stdout, max_output_bytes);
            let (stderr, trunc_err) = clamp_output_bytes(&output.stderr, max_output_bytes);
            let exit_code = output.status.code();
            let text = format_command_result(&stdout, &stderr, exit_code, false);
            Ok(serde_json::json!({
                "command": command,
                "cwd": cwd.display().to_string(),
                "shell": shell_label,
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "timedOut": false,
                "truncated": trunc_out || trunc_err,
                "durationMs": duration_ms,
                "text": text,
            }))
        }
        Ok(Err(e)) => Err(ToolError::execution_failed(
            "shell_command",
            format!("shell wait failed: {e}"),
        )),
        Err(_elapsed) => {
            // 超时：先树杀再报超时结果（taskkill 树杀子进程）
            if let Some(pid) = child_pid {
                let _ = terminate_process_tree(pid);
            }
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
                "text": stderr,
            }))
        }
    }
}

/// 输出截断：保留头尾各一半，中间省略（对齐 workbench clamp_output_bytes）
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
    use super::*;
    use crate::context::{create_mock_tool_context, AskChannel, ToolContext};
    use conex_test_utils::TempWorkspace;
    use serde_json::json;
    use std::sync::Arc;

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
        // 越界命令（gatekeeper RequiresApproval）：经审批放行后真正执行
        let out = t
            .execute(
                &ctx,
                json!({ "command": "echo sudo-hi", "timeoutMs": 5000 }),
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
}
