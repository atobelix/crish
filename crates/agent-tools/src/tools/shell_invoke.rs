//! shell 工具 · 命令构造 / 模式解析 / 文本解码（SR-06a-2 拆分子模块）
//!
//! 逻辑域：外壳调用构造（Windows PowerShell EncodedCommand / Unix bash -lc）、
//! 三模式枚举与入参解析（ShellMode / parse_mode）、控制台字节解码。不含门禁
//! 与执行逻辑（门禁在门面 prepare，执行在 shell_exec）。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL-01…10 / ≠ 打开完成 / ≠ 结构债清零）。

use crate::definition::ToolError;
use crate::tools::optional_string;

/// 构建外壳调用：Windows 用系统 PowerShell EncodedCommand，其它平台 bash -lc
pub(crate) fn build_shell_invocation(
    command: &str,
) -> Result<(String, Vec<String>, String), String> {
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
pub(crate) fn build_windows_powershell_script(user_command: &str) -> String {
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
pub(crate) fn base64_encode(data: &[u8]) -> String {
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
pub(crate) enum ShellMode {
    /// 同步等待（窗口 = timeoutMs，超时树杀——改造前语义）
    Sync,
    /// 等待窗口（waitMsBeforeAsync）内完成返回同步结果；窗口超时不杀，
    /// Child 经 manager.adopt 转后台托管
    AutoBackground,
    /// spawn 后立即转后台守护（is_daemon=true，run 结束不回收）
    Daemon,
}

/// 解析 mode 入参（缺省 sync；未知值结构化报错）
pub(crate) fn parse_mode(args: &serde_json::Value) -> Result<ShellMode, ToolError> {
    match optional_string(args, "mode").as_deref() {
        None | Some("sync") => Ok(ShellMode::Sync),
        Some("auto-background") => Ok(ShellMode::AutoBackground),
        Some("daemon") => Ok(ShellMode::Daemon),
        Some(other) => Err(ToolError::invalid_input(format!(
            "未知 mode：{other:?}（可选 sync / auto-background / daemon）"
        ))),
    }
}

/// 控制台字节解码：先按 UTF-8，失败 lossy
pub(crate) fn decode_console_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(raw).into_owned(),
    }
}
