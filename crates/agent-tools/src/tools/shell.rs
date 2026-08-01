//! 命令执行工具（任务书 B5.2：shell_command）
//!
//! 执行链路（对齐 05 §5.5 tools::shell 与 Tauri 壳 workbench_run_shell 语义）：
//! 1. 命令门禁：conex-sandbox CommandGatekeeper 检查，Blocked → tool.command_blocked，
//!    RequiresApproval → tool.requires_approval（上层据此走审批流）
//! 2. Windows 包装：系统 PowerShell + -EncodedCommand（UTF-16LE → base64），
//!    命令体再经 UTF-8 → base64 包进 scriptblock，避免引号/管道被外壳二次解析
//! 3. 执行：tokio 子进程，stdout/stderr 管道收集，超时树杀，输出按上限截断

use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{display_path, optional_string, optional_u64, require_string, resolve_workspace_path};
use async_trait::async_trait;
use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration};

/// 越界命令：需上层审批（error.code 供执行器路由到审批流）
pub(crate) const TOOL_REQUIRES_APPROVAL: &str = "tool.requires_approval";
/// 红线命令：直接拒绝
pub(crate) const TOOL_COMMAND_BLOCKED: &str = "tool.command_blocked";

/// 命令长度上限（对齐 workbench_run_shell）
const MAX_COMMAND_LEN: usize = 32_000;
/// 超时上限（毫秒）
const MAX_TIMEOUT_MS: u64 = 600_000;

/// 命令执行工具
pub(crate) struct ShellCommandTool {
    def: ToolDefinition,
    workspace_root: PathBuf,
    default_timeout_ms: u64,
    max_output_bytes: usize,
}

impl ShellCommandTool {
    pub(crate) fn new(
        workspace_root: PathBuf,
        default_timeout_ms: u64,
        max_output_bytes: usize,
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
            workspace_root,
            default_timeout_ms,
            max_output_bytes,
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

    async fn execute(&self, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        let command = require_string(&args, "command")?.trim().to_string();
        if command.is_empty() {
            return Err(ToolError::invalid_input(
                "command must be a non-empty string",
            ));
        }
        if command.len() > MAX_COMMAND_LEN {
            return Err(ToolError::invalid_input("command too long"));
        }
        let cwd = resolve_workspace_path(
            &self.workspace_root,
            &optional_string(&args, "cwd").unwrap_or_else(|| ".".to_string()),
        )?;
        if !cwd.is_dir() {
            return Err(ToolError::invalid_input(format!(
                "cwd is not a directory: {}",
                display_path(&self.workspace_root, &cwd)
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
        let root_str = gate_path(&self.workspace_root);
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
            return Err(ToolError::new(
                TOOL_REQUIRES_APPROVAL,
                format!("Command requires approval: {command}"),
            ));
        }

        run_command(&command, &cwd, timeout_ms, max_output_bytes).await
    }
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
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    fn tool(ws: &TempWorkspace) -> ShellCommandTool {
        ShellCommandTool::new(ws.path().clone(), 30_000, 200_000)
    }

    #[tokio::test]
    async fn shell_echo_succeeds() {
        let ws = TempWorkspace::new("shell_echo");
        let t = tool(&ws);
        let command = if cfg!(windows) {
            "Write-Output hello-shell"
        } else {
            "echo hello-shell"
        };
        let out = t.execute(json!({ "command": command })).await.unwrap();
        assert_eq!(out["timedOut"], false);
        assert_eq!(out["exitCode"], 0);
        let stdout = out["stdout"].as_str().unwrap();
        assert!(stdout.contains("hello-shell"), "stdout: {stdout}");
        assert!(out["text"].as_str().unwrap().contains("hello-shell"));
    }

    #[tokio::test]
    async fn shell_blocked_command_rejected() {
        let ws = TempWorkspace::new("shell_blocked");
        let t = tool(&ws);
        let err = t
            .execute(json!({ "command": "rm -rf /" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    }

    #[tokio::test]
    async fn shell_approval_command_requires_approval() {
        let ws = TempWorkspace::new("shell_approval");
        let t = tool(&ws);
        let err = t
            .execute(json!({ "command": "git push --force origin main" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_REQUIRES_APPROVAL);
    }

    #[tokio::test]
    async fn shell_timeout_kills_and_marks() {
        let ws = TempWorkspace::new("shell_timeout");
        let t = ShellCommandTool::new(ws.path().clone(), 30_000, 200_000);
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 10"
        } else {
            "sleep 10"
        };
        let out = t
            .execute(json!({ "command": command, "timeoutMs": 2000 }))
            .await
            .unwrap();
        assert_eq!(out["timedOut"], true);
        assert!(out["stderr"].as_str().unwrap().contains("超时"));
    }

    #[tokio::test]
    async fn shell_cwd_must_be_valid() {
        let ws = TempWorkspace::new("shell_cwd");
        let t = tool(&ws);
        let err = t
            .execute(json!({ "command": "echo hi", "cwd": "no/such/dir" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not a directory"));
        // 越界 cwd 拒绝
        let err = t
            .execute(json!({ "command": "echo hi", "cwd": "../outside" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");
    }

    #[tokio::test]
    async fn shell_exit_code_captured() {
        let ws = TempWorkspace::new("shell_exit");
        let t = tool(&ws);
        let out = t.execute(json!({ "command": "exit 42" })).await.unwrap();
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
}
