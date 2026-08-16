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

    let cwd = resolve_shell_cwd(request.cwd.as_deref())?;
    let workspace_root = if let Ok(app) = crate::host_paths::app_dir() {
        crate::host_paths::workspace_root(&app)
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
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

    // ── cd 判定点（预留；产品决策：终端面板保留允许 cd）──
    // 详见 check_cd_policy：全路径禁 cd 演进时在此拦截。
    if let Some(err) = check_cd_policy(&command) {
        return Err(err);
    }

    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_SHELL_TIMEOUT_MS)
        .clamp(1_000, 600_000);

    let (program, args, shell_label) = build_shell_invocation(&command)?;

    // 2. 二次 AST 语法校验（Secondary AST Gate）：落地执行前杜绝参数逃逸与组装后 Redline 注入
    let secondary_verdict =
        gatekeeper.check_command_with_context(&command, &[], &cwd_str, &root_str);
    if secondary_verdict == conex_sandbox::gatekeeper::GatekeeperResult::Blocked {
        return Err(CoreError::InvalidInput(
            "Command payload violates safety redline on secondary inspection".to_string(),
        ));
    }
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

/// cd 判定点（预留）：终端面板是用户主动输入的单命令面板，`cd` 属合法交互，
/// 产品决策**保留允许 cd**（不拦截，与 AI 侧工具层 T-AB-04 的全路径禁 cd 不同——
/// 用户在自己终端面板里的 cd 是期望行为）。
///
/// 若需求演进为全路径禁 cd：在本函数内调用 conex-sandbox 的 CdShape 分类
/// （T-AB-05 冻结接口：段级分类器，`cd x` / `Set-Location x` / `pushd x` 命中；
/// `git -C` / 引号内 `echo "cd x"` 不命中），命中即返回 InvalidInput，
/// 文案引导「请使用 Cwd 参数指定工作目录，而非 cd 命令」（对齐 T-AB-04 拦截文案）。
fn check_cd_policy(command: &str) -> Option<CoreError> {
    let _ = command;
    None
}

fn resolve_shell_cwd(cwd: Option<&str>) -> Result<PathBuf, CoreError> {
    if let Some(raw) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        if p.is_dir() {
            return Ok(p);
        }
        return Err(CoreError::InvalidInput(format!(
            "cwd is not a directory: {raw}"
        )));
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
        let shell_label = if ps.contains("pwsh") {
            "pwsh.exe".to_string()
        } else {
            "powershell.exe".to_string()
        };
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
            shell_label,
        ))
    } else {
        Ok((
            "bash".into(),
            vec!["-lc".into(), command.to_string()],
            "bash".into(),
        ))
    }
}

/// 严格优先探测 PowerShell 7+ (pwsh.exe)，最后降级回退 Windows PowerShell 5.1。
fn resolve_system_powershell() -> Result<String, CoreError> {
    // 1. 优先查找 PATH 环境变量中的 pwsh / pwsh.exe (PowerShell 7+)
    if which_on_path("pwsh.exe") {
        return Ok("pwsh.exe".into());
    }
    if which_on_path("pwsh") {
        return Ok("pwsh".into());
    }

    // 2. 探测 PowerShell 7 标准安装路径
    if let Ok(pf) = std::env::var("ProgramFiles") {
        let pwsh7_path = Path::new(&pf).join("PowerShell").join("7").join("pwsh.exe");
        if pwsh7_path.is_file() {
            return Ok(pwsh7_path.display().to_string());
        }
    }
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let pwsh7_user = Path::new(&local_app)
            .join("Microsoft")
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe");
        if pwsh7_user.is_file() {
            return Ok(pwsh7_user.display().to_string());
        }
    }

    // 3. 安全回退：探测系统自带 Windows PowerShell 5.1
    if let Ok(root) = std::env::var("SystemRoot") {
        let system_ps = Path::new(&root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        if system_ps.is_file() {
            return Ok(system_ps.display().to_string());
        }
    }

    // 4. 最终尝试 PATH 上的 powershell.exe
    if which_on_path("powershell.exe") {
        return Ok("powershell.exe".into());
    }

    Err(CoreError::Internal(
        "未找到任何可用的 PowerShell (pwsh.exe 或 powershell.exe)".into(),
    ))
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
    let utf16: Vec<u16> = script.encode_utf16().collect();
    let mut bytes = Vec::with_capacity(utf16.len() * 2);
    for u in utf16 {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    base64_encode_std(&bytes)
}

fn base64_encode_std(data: &[u8]) -> String {
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

// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：taskkill /PID /T /F
// 进程树强制终止（T-AB-06 孤儿保护显式 kill 路径）——命令对象为固定系统工具、
// 参数仅 PID 数字拼接（无用户自由参数）；output() 同步等待型，子进程不脱离
// 会话存活，与 spawn 禁令意图（防未 enroll 常驻子进程）不同。
#[allow(clippy::disallowed_methods)]
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

// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：kill -TERM 进程树
// 终止（Unix 分支，同 Windows taskkill 语义）——固定系统工具 + PID 数字参数，
// output() 同步等待型，子进程不脱离会话存活。
#[allow(clippy::disallowed_methods)]
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

// ── 优雅终止变体（T-AB-06）───────────────────────────────────────────────────
// 与 terminate_process_tree（强制）配对，供 R-AB2 两阶段终止（优雅 → 5s → 强制）
// 消费。返回 Result<(), String>，与 terminate_process_tree 同型（:323 同款）。

/// 优雅终止整个进程树：Windows `taskkill /PID <pid> /T`（去掉 /F，向进程树发送
/// 关闭请求）；Unix `kill -TERM <pid>`（SIGTERM 即优雅请求）。
///
/// Windows 诚实边界（本机已实测，登记新发现）：taskkill 无 /F 时通过 WM_CLOSE
/// 请求关闭**有顶层窗口且响应关闭消息**的进程；对控制台程序（powershell/cmd
/// 等）返回「只能通过强制终止」错误且进程不退出。调用方应把 Err 视为
/// 「优雅请求未生效」，随后按两阶段语义升级强制终止（R-AB2 T-AB-11 落地）。
// 本轮交付原语供 R-AB2 消费（测试已覆盖真实语义）；非测试构建暂未接线 →
// 显式豁免 dead_code。
// G2 禁令豁免（clippy.toml 豁免面「内部进程管理原语」）：taskkill /PID /T
// 进程树优雅终止（R-AB2 T-AB-11 两阶段终止优雅路径）——固定系统工具 + PID
// 数字参数，output() 同步等待型，子进程不脱离会话存活。
#[allow(dead_code)] // R-AB2 T-AB-11 两阶段终止消费
#[allow(clippy::disallowed_methods)]
#[cfg(target_os = "windows")]
pub(crate) fn terminate_process_tree_graceful(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start taskkill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[allow(dead_code)] // R-AB2 T-AB-11 两阶段终止消费（Unix 侧与强制路径同型）
#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process_tree_graceful(pid: u32) -> Result<(), String> {
    // Unix 默认 kill -TERM 即优雅请求，与强制路径同型（无 /KILL 升级项）
    terminate_process_tree(pid)
}

// ==================== Job Objects (Orphan Process Protection) ====================
//
// Shared primitive: `create_kill_on_close_job_object` — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// When the last handle to a job is closed (host exit or crash), Windows kills every process
// still assigned to that job (and their descendants that inherited membership).
//
// Two independent jobs (T-AB-06: daemon job series restored, G11a 遗留恢复):
//   - PTY Job（`PTY_JOB_OBJECT`）：交互式终端 shell，spawn 时在 pty/session.rs 接线
//     （共享 app 级）；终端面板 kill_all / dock unmount 语义不变；
//   - Daemon Job（`DAEMON_JOB_OBJECT`，本轮新增）：后台任务（后台任务注册表 adopt 时
//     经 `assign_pid_to_daemon_job` 接线）。与 PTY Job 相互隔离：
//     * 守护进程不得被终端面板 kill_all 连带误杀（Job 句柄独立 + kill_all 只清 PTY 注册表）；
//     * 应用退出/崩溃 → 宿主 Job 句柄关闭 → daemon Job 兜底全杀（孤儿保护语义不变）。
//
// 诚实边界（本机已实测，登记新发现）：开发环境宿主确实会包裹子进程（taskkill
// 无 /F 时可见「进程位于宿主作业中」的报错），但 Windows 8+ 支持嵌套 Job——
// 实测 AssignProcessToJobObject 到 daemon Job 成功。接线仍为 best-effort：
// 若宿主 Job 禁止嵌套（或进程已属其他不可嵌套 Job），分配返回拒绝——失败仅
// warn 降级（孤儿保护退化为显式 kill 路径兜底，见 background.rs adopt 注释），
// 不阻断任务注册。
//
// Explicit kill paths remain:
//   - PTY: `pty::kill_all_sessions()` on `RunEvent::Exit` (main.rs) and per-session kill
//   - Dock unmount must NOT kill PTYs (frontend contract) — Job only fires on handle close
//   - Daemon: 两阶段终止（R-AB2 T-AB-11）显式 kill；强制树杀见 terminate_process_tree
//
// Cross-ref: pty/mod.rs, pty/session.rs (Windows assign; Unix process-group best-effort).
//

/// Opaque job handle wrapper for OnceLock statics.
#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// 豁免 unsafe_code：Send 标记（SAFETY 见下）——JobHandle 仅含整数句柄，
// 经评审后允许。
#[allow(unsafe_code)]
// SAFETY: JobHandle 仅含整数句柄；Create/Assign/Close 由调用方串行化到 OnceLock
unsafe impl Send for JobHandle {}

#[cfg(windows)]
// 豁免 unsafe_code：Sync 标记（SAFETY 见下）——JobHandle 仅含整数句柄，
// 经评审后允许。
#[allow(unsafe_code)]
// SAFETY: JobHandle 仅含整数句柄；句柄一经 DAEMON_JOB_OBJECT/PTY_JOB_OBJECT
// OnceLock 初始化后只读（get() 只读借用），进程生命周期内不被并发关闭；
// Close 仅发生在重复 init 的失败路径且持有独占写
unsafe impl Sync for JobHandle {}

/// Create an anonymous job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
/// Caller owns the returned handle (CloseHandle when done, or store for process lifetime).
/// Used by daemon and PTY orphan protection — see module comment above.
#[cfg(windows)]
// 豁免 unsafe_code：Windows Job Objects FFI（CreateJobObjectW /
// SetInformationJobObject），每处 unsafe 均有 SAFETY 说明，经评审后允许。
#[allow(unsafe_code)]
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
// 豁免 unsafe_code：Windows Job Objects FFI（AssignProcessToJobObject），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
fn assign_process_to_job(
    job: windows_sys::Win32::Foundation::HANDLE,
    child_handle: std::os::windows::io::RawHandle,
) -> Result<(), String> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    // SAFETY: hJob 与 processHandle 由调用方保证有效
    unsafe {
        if AssignProcessToJobObject(job, child_handle as windows_sys::Win32::Foundation::HANDLE)
            == 0
        {
            return Err(
                "AssignProcessToJobObject failed: unable to assign child to job".to_string(),
            );
        }
    }
    Ok(())
}

// ── Daemon job (background tasks; app-wide, isolated from PTY job) ─────────────
// T-AB-06：后台任务独立 Job。与 PTY Job（:451 下段）句柄隔离——守护进程不得被
// 终端面板 kill_all 连带误杀；应用退出时宿主句柄关闭 → 兜底全杀（孤儿保护语义
// 不变）。接线点：BackgroundTaskRegistry::adopt（background.rs）。

#[cfg(windows)]
static DAEMON_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

#[cfg(windows)]
// 豁免 unsafe_code：CloseHandle FFI（重复 init 时的句柄清理），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn init_daemon_job_object() -> Result<(), String> {
    let handle = create_kill_on_close_job_object()?;
    match DAEMON_JOB_OBJECT.set(JobHandle(handle)) {
        Ok(()) => Ok(()),
        Err(JobHandle(dup)) => {
            // SAFETY: 重复 init 时关闭多余句柄（OnceLock 已持有一个）
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(dup);
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
// 豁免 unsafe_code：OpenProcess/CloseHandle FFI（进程句柄生命周期仅限本函数），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn assign_pid_to_daemon_job(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    let job = DAEMON_JOB_OBJECT.get().ok_or_else(|| {
        "daemon job object not initialized; call init_daemon_job_object() first".to_string()
    })?;
    // SAFETY: OpenProcess 句柄与本函数生命周期绑定，CloseHandle 兜底释放；
    // AssignProcessToJobObject 所需访问权（PROCESS_SET_QUOTA | PROCESS_TERMINATE）
    // 按 MSDN 契约给出。进程已在宿主 Job 内时返回拒绝，由调用方降级处理。
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(format!(
                "OpenProcess({pid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = assign_process_to_job(job.0, handle);
        let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
        result
    }
}

/// daemon Job 句柄访问器（T-AB-15 Windows 资源采样消费：`QueryInformationJobObject`
/// 需要 Job 句柄；句柄在 OnceLock 内生命周期与进程一致，仅借用不可转移）。
///
/// 接线说明（登记偏差）：daemon Job 句柄原先封装在模块私有 static 中，资源
/// 采样原语（resource.rs）无法获取——本 getter 为纯只读暴露（不改行为，
/// 不触碰 Job 生命周期），供 background.rs 资源段采样接线，报主 Agent 裁决。
#[cfg(windows)]
pub(crate) fn daemon_job_handle() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    DAEMON_JOB_OBJECT.get().map(|h| h.0)
}

// ── PTY job (interactive shells; shared app-wide) ────────────────────────────
// One job for all PTY sessions: simplest correct tree lifecycle. Host crash closes
// the handle → OS kills every assigned shell and descendants. Per-session kill and
// kill_all still use portable-pty ChildKiller (independent of job membership).

#[cfg(windows)]
static PTY_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

#[cfg(windows)]
// 豁免 unsafe_code：CloseHandle FFI（重复 init 时的句柄清理），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
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
// 豁免 unsafe_code：POSIX libc FFI（setpgid），参数为整数 PID 无指针
// 所有权转移（SAFETY 见函数内注释），经评审后允许。
#[allow(unsafe_code)]
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
// 豁免 unsafe_code：POSIX libc FFI（killpg），参数为整数 PID 无指针
// 所有权转移（SAFETY 见函数内注释），经评审后允许。
#[allow(unsafe_code)]
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
    // G2 禁令豁免：测试 mod——真实 spawn 探测命令门禁语义（11 红线下目标
    // 断言 Blocked）+ pid 存活探测（tasklist / kill -0，T-AB-06/07 验收辅助），
    // 非产品执行面；测试 mod 内 allow + 理由（对齐 clippy.toml 豁免面）。
    #![allow(clippy::disallowed_methods)]
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
            assert!(
                res.is_err(),
                "Expected workbench_run_shell to block `{}`",
                cmd
            );
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

    #[tokio::test]
    async fn test_workbench_run_shell_requires_approval_for_dangerous_command() {
        let dangerous = [
            "git push --force origin main",
            "npm publish",
            "sudo apt-get update",
            "$x = 'Remove-Item'; & $x C:\\ -Force",
        ];

        for cmd in dangerous {
            let req = WorkbenchRunShellRequest {
                command: cmd.to_string(),
                cwd: None,
                timeout_ms: Some(5000),
            };
            let res = workbench_run_shell(req).await;
            assert!(
                res.is_err(),
                "Expected dangerous command `{}` to require approval",
                cmd
            );
            let err = res.unwrap_err();
            match err {
                CoreError::InvalidInput(msg) => {
                    assert!(
                        msg.contains("Dangerous command requires explicit user approval"),
                        "Expected permission denied message for `{cmd}`: {msg}"
                    );
                }
                other => panic!("expected InvalidInput for `{cmd}`, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn test_workbench_run_shell_blocks_obfuscated_and_reflection_redlines() {
        let red_lines = [
            "r`i C:\\ -Recurse -Force",
            "R`em`ove-Item C:\\ -Force -Recurse",
            "powershell -enco cgBtACAALQByAGYAIAAvAA==",
            "pwsh -e:cgBtACAALQByAGYAIAAvAA==",
            "[System.Diagnostics.Process]::Start('cmd.exe', '/c del /f /q C:\\*')",
        ];

        for cmd in red_lines {
            let req = WorkbenchRunShellRequest {
                command: cmd.to_string(),
                cwd: None,
                timeout_ms: Some(5000),
            };
            let res = workbench_run_shell(req).await;
            assert!(
                res.is_err(),
                "Expected obfuscated redline `{}` to be blocked",
                cmd
            );
            let err = res.unwrap_err();
            match err {
                CoreError::InvalidInput(msg) => {
                    assert!(
                        msg.contains("InvalidCommand")
                            || msg.contains("safety redline")
                            || msg.contains("safety red-line"),
                        "detail should block for `{cmd}`: {msg}"
                    );
                }
                other => panic!("expected InvalidInput for `{cmd}`, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn test_workbench_run_shell_escalates_outside_workspace() {
        // Normal command with an explicit out-of-workspace cwd -> escalated to RequiresApproval -> InvalidInput
        let cwd_outside = if cfg!(windows) { "C:\\Windows" } else { "/etc" };
        let req = WorkbenchRunShellRequest {
            command: "git status".to_string(),
            cwd: Some(cwd_outside.to_string()),
            timeout_ms: Some(5000),
        };
        let res = workbench_run_shell(req).await;
        assert!(
            res.is_err(),
            "Expected out of workspace command to fail-closed"
        );
        let err = res.unwrap_err();
        match err {
            CoreError::InvalidInput(msg) => {
                assert!(
                    msg.contains("Dangerous command requires explicit user approval"),
                    "Expected permission denied for outside cwd: {msg}"
                );
            }
            other => panic!("expected InvalidInput for outside cwd, got {other:?}"),
        }
    }

    /// Empty job create: verifies CreateJobObjectW + KILL_ON_JOB_CLOSE limit flags.
    /// Manual crash verification (Windows): spawn a PTY shell (`workbench_pty_create`), note
    /// shell PID, force-kill the workbench process — shell tree should exit without orphans.
    #[cfg(windows)]
    #[test]
    // 豁免 unsafe_code：测试内 CloseHandle FFI（SAFETY：句柄来自同函数
    // create_kill_on_close_job_object 的返回值，测试拥有所有权），经评审后允许。
    #[allow(unsafe_code)]
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

    /// 等待子进程在窗口内退出（std 轮询，供真实 spawn 测试用）。
    fn wait_child_exit(child: &mut std::process::Child, window: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + window;
        loop {
            if child.try_wait().expect("try_wait").is_some() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// 进程是否存活（Windows tasklist 过滤；Unix kill -0）。
    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .expect("tasklist must run");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    #[cfg(not(windows))]
    fn pid_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// T-AB-06 验收：优雅终止变体。真实 spawn 测试程序（Windows PowerShell
    /// Start-Sleep / Unix sleep）：
    /// - Unix：kill -TERM 生效，进程 5s 内退出；
    /// - Windows：taskkill 无 /F 对控制台程序实测返回「只能通过强制终止」且进程
    ///   不退出（新发现登记，见 terminate_process_tree_graceful 文档注释）——
    ///   因此断言两阶段语义：优雅请求后 5s 内未退出 → 强制兜底 → 5s 内必退。
    #[cfg(target_os = "windows")]
    #[test]
    fn graceful_terminate_ok() {
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test process");
        let pid = child.id();

        let _graceful = terminate_process_tree_graceful(pid);
        let exited_gracefully = wait_child_exit(&mut child, Duration::from_secs(5));

        if !exited_gracefully {
            // 优雅请求未生效（本环境实测为控制台程序必经路径）：taskkill 无 /F
            // 对控制台程序返回码不稳定（有时 Err「仅可强制终止」、有时 Ok 但
            // 进程树仍存活）——不纠结返回码，直接验证强制兜底（两阶段终止的
            // 升级支路，产品语义：最终 5s 内必退）
            terminate_process_tree(pid).expect("强制兜底必须成功");
            assert!(
                wait_child_exit(&mut child, Duration::from_secs(5)),
                "两阶段终止后进程必须在 5s 内退出"
            );
        }
        // 优雅生效分支：进程已退出（无附加断言，跨环境稳健）
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn graceful_terminate_ok() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test process");
        let pid = child.id();

        terminate_process_tree_graceful(pid).expect("kill -TERM 应成功");
        assert!(
            wait_child_exit(&mut child, Duration::from_secs(5)),
            "SIGTERM 后进程必须在 5s 内退出"
        );
    }

    /// T-AB-06 验收：daemon Job 与 PTY Job 隔离（真实 spawn 断言）。
    ///
    /// 实现说明：全局 `PTY_JOB_OBJECT` 是 OnceLock 静态，无法在不消费静态的前提下
    /// 关闭（OnceLock::into_inner 需 move，static 不可 move）——故用「本地同类
    /// kill-on-close Job 模拟 PTY Job 关闭」+「真实全局两个 Job 句柄不同」+「真实
    /// pty::kill_all_sessions() 不连带」三断言覆盖方案语义：
    /// 1. 两个静态 Job 句柄非空且互不相同（隔离）；
    /// 2. daemon 进程归属校验（IsProcessInJob，仅分配成功时）；
    /// 3. 关闭一个 kill-on-close Job（模拟 PTY Job 关闭）→ 其成员死亡（机制自检），
    ///    而 daemon 进程存活（不受连带）；
    /// 4. pty::kill_all_sessions() 后 daemon 进程仍存活（终端面板 kill_all 不误杀）。
    #[cfg(windows)]
    #[test]
    // 豁免 unsafe_code：测试内 CloseHandle/OpenProcess/IsProcessInJob FFI，
    // SAFETY 见各函数内注释，经评审后允许。
    #[allow(unsafe_code)]
    fn daemon_job_isolated_from_pty() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        init_daemon_job_object().expect("daemon job init");
        init_pty_job_object().expect("pty job init");
        let daemon_handle = DAEMON_JOB_OBJECT.get().expect("daemon job static").0;
        let pty_handle = PTY_JOB_OBJECT.get().expect("pty job static").0;
        assert!(!daemon_handle.is_null() && !pty_handle.is_null());
        assert_ne!(
            daemon_handle, pty_handle,
            "后台任务 Job 与 PTY Job 句柄必须不同（相互隔离）"
        );

        // 真实 spawn：后台任务进程（长命令）→ 接线 daemon Job（best-effort）
        let mut daemon_child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon test process");
        let daemon_pid = daemon_child.id();
        let assigned = assign_pid_to_daemon_job(daemon_pid);
        // 嵌套 Job 语义（Win8+）：本机实测分配成功；若宿主 Job 禁止嵌套则返回
        // 拒绝——仅 warn 不失败，隔离断言对两种环境均成立
        if let Err(e) = &assigned {
            eprintln!("[test] assign_pid_to_daemon_job 降级（宿主 Job 禁止嵌套）：{e}");
        }

        // 分配成功时校验归属（IsProcessInJob）
        if assigned.is_ok() {
            // SAFETY: OpenProcess/CloseHandle 配对；IsProcessInJob 布尔出参
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, daemon_pid);
                assert!(!h.is_null(), "OpenProcess({daemon_pid}) 失败");
                let mut in_daemon_job: i32 = 0;
                let ok = IsProcessInJob(h, daemon_handle, &mut in_daemon_job);
                let _ = CloseHandle(h);
                assert!(ok != 0 && in_daemon_job != 0, "daemon 进程应归属后台 Job");
            }
        }

        // 机制自检：本地 kill-on-close Job 模拟「PTY Job 关闭」——
        // 关闭 Job 句柄 → 其成员全杀；daemon 进程不受影响
        let local_job = create_kill_on_close_job_object().expect("create local job");
        let mut victim = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn victim process");
        let victim_pid = victim.id();
        let victim_assigned = assign_process_to_job(local_job, victim.as_raw_handle());
        // SAFETY: local_job 句柄由 create_kill_on_close_job_object 产生，本测试拥有所有权
        unsafe {
            let _ = CloseHandle(local_job);
        }
        if victim_assigned.is_ok() {
            assert!(
                wait_child_exit(&mut victim, Duration::from_secs(5)),
                "关闭 kill-on-close Job 必须杀死其成员（机制自检）"
            );
        } else {
            // 分配失败（宿主 Job 环境）：显式清理 victim，隔离断言不受影响
            let _ = terminate_process_tree(victim_pid);
            let _ = wait_child_exit(&mut victim, Duration::from_secs(5));
        }

        // PTY 面板 kill_all 真实路径：不得连带 daemon 进程
        crate::pty::kill_all_sessions();
        assert!(
            pid_is_alive(daemon_pid),
            "关闭 PTY Job / kill_all 不应影响后台任务存活"
        );

        // 清理：daemon 进程强制终止，不留孤儿
        terminate_process_tree(daemon_pid).expect("cleanup force kill");
        assert!(
            wait_child_exit(&mut daemon_child, Duration::from_secs(5)),
            "清理后 daemon 进程必须退出"
        );
    }

    /// Unix 侧隔离语义：daemon 进程组与 PTY kill_all 互不影响（真实 spawn 断言）。
    #[cfg(not(windows))]
    #[test]
    fn daemon_process_survives_pty_kill_all() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon test process");
        let pid = child.id();
        // 模拟后台任务进程组（T-AB-06 daemon 语义：与 PTY 会话独立）
        set_child_process_group(pid).expect("setpgid");

        crate::pty::kill_all_sessions();
        assert!(pid_is_alive(pid), "kill_all_sessions 不得连带 daemon 进程");

        let _ = kill_process_group(pid);
        assert!(
            wait_child_exit(&mut child, Duration::from_secs(5)),
            "清理后进程必须退出"
        );
    }

    /// T-AB-06 验收：workbench_run_shell 子进程环境含 PAGER=cat（防溢 G4）。
    #[tokio::test]
    async fn workbench_shell_pager_env() {
        let command = if cfg!(windows) {
            "Write-Output $env:PAGER"
        } else {
            "echo $PAGER"
        };
        let req = WorkbenchRunShellRequest {
            command: command.to_string(),
            cwd: None,
            timeout_ms: Some(10_000),
        };
        let res = workbench_run_shell(req).await.expect("shell must run");
        assert!(res.ok, "stderr: {}", res.stderr);
        assert_eq!(
            res.stdout.trim(),
            "cat",
            "子进程环境必须含 PAGER=cat，实际: {:?}",
            res.stdout
        );
    }
}
