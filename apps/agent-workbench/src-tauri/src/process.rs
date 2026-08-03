use conex_types::CoreError;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

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

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    if gatekeeper.check_command(&command, &[]) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || gatekeeper.patterns().is_match(&command)
    {
        return Err(CoreError::InvalidInput(
            "Command blocked by safety red-line gatekeeper (InvalidCommand)".to_string(),
        ));
    }

    let cwd = resolve_shell_cwd(request.cwd.as_deref())?;
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

    let child = child_cmd
        .spawn()
        .map_err(|e| CoreError::Internal(format!("failed to spawn {shell_label}: {e}")))?;
    let child_pid = child.id();

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

fn resolve_shell_cwd(cwd: Option<&str>) -> Result<PathBuf, CoreError> {
    if let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            return Ok(p);
        }
        return Err(CoreError::InvalidInput(format!("cwd is not a directory: {raw}")));
    }
    // 回落到 monorepo 根或当前进程目录
    if let Ok(app) = crate::host_paths::app_dir() {
        let root = crate::host_paths::workspace_root(&app);
        if root.is_dir() {
            return Ok(root);
        }
    }
    std::env::current_dir().map_err(|e| CoreError::Internal(format!("no valid cwd: {e}")))
}

fn build_shell_invocation(command: &str) -> Result<(String, Vec<String>, String), CoreError> {
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

/// 优先系统目录下的 Windows PowerShell 5.x，再回落 PATH 上的 powershell.exe。
fn resolve_system_powershell() -> Result<String, CoreError> {
    if let Ok(root) = std::env::var("SystemRoot") {
        let candidate = Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if candidate.is_file() {
            return Ok(candidate.display().to_string());
        }
    }
    // PATH 探测
    if which_on_path("powershell.exe") {
        return Ok("powershell.exe".into());
    }
    Err(CoreError::Internal("system powershell.exe not found".into()))
}

fn which_on_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return true;
        }
    }
    false
}

/// 与 agent-runtime 对齐：UTF-8 输出 + base64 载荷，避免引号/管道被外壳二次解析弄坏。
fn build_windows_powershell_script(user_command: &str) -> String {
    let payload = base64_encode_std(user_command.as_bytes());
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
    let utf16: Vec<u16> = script.encode_utf16().collect();
    let mut bytes = Vec::with_capacity(utf16.len() * 2);
    for u in utf16 {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    base64_encode_std(&bytes)
}

fn base64_encode_std(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
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

fn clamp_output_bytes(raw: &[u8]) -> (String, bool) {
    if raw.len() <= MAX_SHELL_OUTPUT_BYTES {
        return (decode_console_bytes(raw), false);
    }
    let head = &raw[..MAX_SHELL_OUTPUT_BYTES / 2];
    let tail = &raw[raw.len() - MAX_SHELL_OUTPUT_BYTES / 2..];
    let omitted = raw.len() - head.len() - tail.len();
    let text = format!(
        "{}\n\n[output truncated: {} bytes omitted]\n\n{}",
        decode_console_bytes(head),
        omitted,
        decode_console_bytes(tail)
    );
    (text, true)
}

fn decode_console_bytes(raw: &[u8]) -> String {
    // 先按 UTF-8；失败则 lossy（Windows 控制台偶发本机代码页）
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}

// ==================== Process Termination ====================

#[cfg(target_os = "windows")]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
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

#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
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

// ==================== Job Objects (Orphan Process Protection) ====================
//
// Shared primitive: `create_kill_on_close_job_object` — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// When the last handle to a job is closed (host exit or crash), Windows kills every process
// still assigned to that job (and their descendants that inherited membership).
//
// Single job in use (G11a: daemon/sidecar job series was orphaned after sidecar removal):
//   - Interactive PTY shells: assigned at spawn in pty/session.rs (shared app-wide PTY job)
//
// Explicit kill paths remain:
//   - PTY: `pty::kill_all_sessions()` on `RunEvent::Exit` (main.rs) and per-session kill
//   - Dock unmount must NOT kill PTYs (frontend contract) — Job only fires on handle close
//
// Cross-ref: pty/mod.rs, pty/session.rs (Windows assign; Unix process-group best-effort).
//

/// Opaque job handle wrapper for OnceLock statics.
#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// SAFETY: JobHandle 仅含整数句柄；Create/Assign/Close 由调用方串行化到 OnceLock
unsafe impl Send for JobHandle {}

#[cfg(windows)]
// SAFETY: JobHandle 仅含整数句柄
unsafe impl Sync for JobHandle {}

/// Create an anonymous job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
/// Caller owns the returned handle (CloseHandle when done, or store for process lifetime).
/// Used by daemon and PTY orphan protection — see module comment above.
#[cfg(windows)]
pub(crate) fn create_kill_on_close_job_object(
) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use core::mem;
    use core::ptr;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;

    // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION 栈分配；失败时 CloseHandle
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null_mut());
        if job.is_null() {
            return Err("CreateJobObjectW failed: unable to create job object".to_string());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ret = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ret == 0 {
            let _ = CloseHandle(job);
            return Err("SetInformationJobObject failed: unable to set kill-on-close".to_string());
        }

        Ok(job)
    }
}

#[cfg(windows)]
fn assign_process_to_job(
    job: windows_sys::Win32::Foundation::HANDLE,
    child_handle: std::os::windows::io::RawHandle,
) -> Result<(), String> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    // SAFETY: hJob 与 processHandle 由调用方保证有效
    unsafe {
        if AssignProcessToJobObject(job, child_handle as windows_sys::Win32::Foundation::HANDLE) == 0
        {
            return Err(
                "AssignProcessToJobObject failed: unable to assign child to job".to_string(),
            );
        }
    }
    Ok(())
}

// ── PTY job (interactive shells; shared app-wide) ────────────────────────────
// One job for all PTY sessions: simplest correct tree lifecycle. Host crash closes
// the handle → OS kills every assigned shell and descendants. Per-session kill and
// kill_all still use portable-pty ChildKiller (independent of job membership).

#[cfg(windows)]
static PTY_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

#[cfg(windows)]
pub(crate) fn init_pty_job_object() -> Result<(), String> {
    let handle = create_kill_on_close_job_object()?;
    match PTY_JOB_OBJECT.set(JobHandle(handle)) {
        Ok(()) => Ok(()),
        Err(JobHandle(dup)) => {
            // SAFETY: 重复 init 时关闭多余句柄
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(dup);
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
pub(crate) fn assign_child_to_pty_job_object(
    child_handle: std::os::windows::io::RawHandle,
) -> Result<(), String> {
    let job = PTY_JOB_OBJECT.get().ok_or_else(|| {
        "pty job object not initialized; call init_pty_job_object() first".to_string()
    })?;
    assign_process_to_job(job.0, child_handle)
}

#[cfg(not(windows))]
pub(crate) fn set_child_process_group(pid: u32) -> Result<(), String> {
    // SAFETY: POSIX 标准 API
    unsafe {
        if libc::setpgid(pid as libc::pid_t, pid as libc::pid_t) != 0 {
            return Err(format!(
                "setpgid failed for PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn kill_process_group(pid: u32) -> Result<(), String> {
    // SAFETY: POSIX 标准 API
    unsafe {
        if libc::killpg(pid as libc::pid_t, libc::SIGTERM) != 0 {
            return Err(format!(
                "killpg failed for PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_workbench_run_shell_blocks_eleven_red_lines() {
        let red_lines = vec![
            "rm -rf /",
            "rm -rf /*",
            "rm --no-preserve-root -rf /",
            "dd if=/dev/zero of=/dev/sda",
            "dd if=/dev/random of=/dev/sdb",
            "mkfs.ext4 /dev/sda",
            "Remove-Item -Recurse -Path C:\\",
            "Remove-Item -Recurse D:\\",
            "format C:",
            "del /f C:\\",
            "rd /s C:\\",
        ];

        for cmd in red_lines {
            let req = WorkbenchRunShellRequest {
                command: cmd.to_string(),
                cwd: None,
                timeout_ms: Some(5000),
            };
            let res = workbench_run_shell(req).await;
            assert!(res.is_err(), "Expected workbench_run_shell to block `{}`", cmd);
            let err = res.unwrap_err();
            match err {
                CoreError::InvalidInput(msg) => {
                    assert!(
                        msg.contains("InvalidCommand"),
                        "detail should contain InvalidCommand for `{cmd}`: {msg}"
                    );
                }
                other => panic!("expected InvalidInput for `{cmd}`, got {other:?}"),
            }
        }
    }

    /// Empty job create: verifies CreateJobObjectW + KILL_ON_JOB_CLOSE limit flags.
    /// Manual crash verification (Windows): spawn a PTY shell (`workbench_pty_create`), note
    /// shell PID, force-kill the workbench process — shell tree should exit without orphans.
    #[cfg(windows)]
    #[test]
    fn create_kill_on_close_job_object_empty_ok() {
        let job = create_kill_on_close_job_object().expect("create empty kill-on-close job");
        assert!(!job.is_null(), "job handle must be non-null");
        // SAFETY: we own this handle from create_kill_on_close_job_object
        unsafe {
            let closed = windows_sys::Win32::Foundation::CloseHandle(job);
            assert_ne!(closed, 0, "CloseHandle on empty job should succeed");
        }
    }

    #[cfg(windows)]
    #[test]
    fn init_pty_job_object_idempotent() {
        init_pty_job_object().expect("first init");
        init_pty_job_object().expect("second init is no-op success");
        assert!(PTY_JOB_OBJECT.get().is_some());
    }
}
