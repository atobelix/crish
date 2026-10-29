use conex_types::CoreError;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

#[cfg(not(windows))]
mod group_unix;
#[cfg(windows)]
mod job_windows;
mod shell;
mod terminate;

#[cfg(not(windows))]
pub(crate) use group_unix::*;
#[cfg(windows)]
pub(crate) use job_windows::*;
use shell::{build_shell_invocation, clamp_output_bytes, resolve_shell_cwd};
pub(crate) use terminate::*;

/// 当前进程启动后的毫秒时间戳（run 时长 / 超时计时用）。
pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ==================== Interactive terminal shell ====================

const DEFAULT_SHELL_TIMEOUT_MS: u64 = 60_000;
const MAX_SHELL_OUTPUT_BYTES: usize = 400_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchRunShellRequest {
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchRunShellResult {
    ok: bool,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    cancelled: bool,
    shell: String,
    cwd: String,
    duration_ms: u64,
    truncated: bool,
}

/// 终端面板直接执行：Windows 用系统 powershell.exe，其它平台用 bash。
/// 与 agent shell_command 同源语义，但不经 daemon 审批（用户主动输入）。
/// 错误统一为 CoreError（IPC 面唯一协议）；红线拦截 → InvalidInput。
#[tauri::command]
// G2 禁令豁免（clippy.toml 文件头「豁免面」）：命令门禁执行面——本函数执行前
// 必过 CommandGatekeeper 双防线（见函数体内 :65-72 的 check_command + patterns
// 校验），是「子进程经命令门禁」的门禁落地处本身；不经 daemon 审批的
// 用户主动输入同样先过红线检查。
#[allow(clippy::disallowed_methods)]
pub(crate) async fn workbench_run_shell(
    request: WorkbenchRunShellRequest,
) -> Result<WorkbenchRunShellResult, CoreError> {
    let command = request.command.trim().to_string();
    if command.is_empty() {
        return Err(CoreError::InvalidInput(
            "command must be a non-empty string".to_string(),
        ));
    }
    if command.len() > 32_000 {
        return Err(CoreError::InvalidInput("command too long".to_string()));
    }

    let cwd = resolve_shell_cwd(request.cwd.as_deref())?;
    let workspace_root = if let Ok(app) = crate::host_paths::app_dir() {
        crate::host_paths::workspace_root(&app)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };

    let gatekeeper = &*conex_sandbox::gatekeeper::SHARED_GATEKEEPER;
    let cwd_str = cwd.to_string_lossy();
    let root_str = workspace_root.to_string_lossy();

    // 1. 调用带工作区上下文的完整门禁（第一道 AST 门禁）
    let verdict = gatekeeper.check_command_with_context(&command, &[], &cwd_str, &root_str);

    match verdict {
        conex_sandbox::gatekeeper::GatekeeperResult::Blocked => {
            return Err(CoreError::InvalidInput(
                "Command blocked by safety red-line gatekeeper (InvalidCommand)".to_string(),
            ));
        }
        conex_sandbox::gatekeeper::GatekeeperResult::RequiresApproval => {
            // Local IPC 若未弹窗确认，必须 Fail-Closed 严禁静默放行 Dangerous 命令！
            return Err(CoreError::InvalidInput(
                "Dangerous command requires explicit user approval before execution in workbench shell".to_string(),
            ));
        }
        conex_sandbox::gatekeeper::GatekeeperResult::Allowed => {}
    }

    // 门禁只做一次：`command` 即最终执行载荷（Windows 侧 base64 包装仅编码
    // 同一字符串，bash 侧 -lc 直传），不存在二次组装面，重复校验只会制造
    // 「已二次防护」的假象。
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_SHELL_TIMEOUT_MS)
        .clamp(1_000, 600_000);

    let (program, args, shell_label) = build_shell_invocation(&command)?;

    let started = now_millis();

    let mut child_cmd = TokioCommand::new(&program);
    child_cmd
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Windows: hide console flash
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // Prefer UTF-8 for child tools
    child_cmd.env("PYTHONUTF8", "1");
    child_cmd.env("PYTHONIOENCODING", "utf-8");
    // 防溢（G4）：PAGER=cat —— 交互式分页器（less/more）在无人值守下会挂起；
    // Unix 直接注入环境；Windows 由包装脚本显式写入（见 build_windows_powershell_script）。
    // 口径与 T-AB-03（agent-tools 段）一致，双端同步。
    child_cmd.env("PAGER", "cat");

    let child = child_cmd
        .spawn()
        .map_err(|e| CoreError::Internal(format!("failed to spawn {shell_label}: {e}")))?;
    let child_pid = child.id();

    // Windows 平台挂载原生 Job Object 防孤儿第一防线（宿主崩溃/退出时内核自动杀树）：
    #[cfg(windows)]
    let _job_guard = if let Some(pid) = child_pid {
        match ProcessJobGuard::new_for_pid(pid) {
            Ok(guard) => guard,
            Err(e) => {
                tracing::warn!(target: "process::shell", pid, error = %e, "配置 Job Object 失败，优雅降级为显式进程树终止兜底");
                None
            }
        }
    } else {
        None
    };

    // wait_with_output 会拿走 child；超时后靠 kill_on_drop + taskkill 树杀
    let wait_fut = child.wait_with_output();
    let timed = timeout(Duration::from_millis(timeout_ms), wait_fut).await;

    let finished = now_millis();
    let duration_ms = finished.saturating_sub(started) as u64;

    match timed {
        Ok(Ok(output)) => {
            let (stdout, trunc_out) = clamp_output_bytes(&output.stdout);
            let (stderr, trunc_err) = clamp_output_bytes(&output.stderr);
            let exit_code = output.status.code();
            Ok(WorkbenchRunShellResult {
                ok: output.status.success(),
                stdout,
                stderr,
                exit_code,
                timed_out: false,
                cancelled: false,
                shell: shell_label,
                cwd: cwd.display().to_string(),
                duration_ms,
                truncated: trunc_out || trunc_err,
            })
        }
        Ok(Err(e)) => Err(CoreError::Internal(format!("shell wait failed: {e}"))),
        Err(_elapsed) => {
            if let Some(pid) = child_pid {
                let _ = terminate_process_tree(pid);
            }
            Ok(WorkbenchRunShellResult {
                ok: false,
                stdout: String::new(),
                stderr: format!("(命令超时，已终止 · {timeout_ms}ms)"),
                exit_code: None,
                timed_out: true,
                cancelled: false,
                shell: shell_label,
                cwd: cwd.display().to_string(),
                duration_ms,
                truncated: false,
            })
        }
    }
}

#[cfg(test)]
mod tests;
