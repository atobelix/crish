//! 终端面板 shell 执行辅助：cd 判定点、cwd 解析、PowerShell/bash 调用组装、
//! base64 编码与输出截断解码（自 process.rs 原样搬迁）

use conex_types::CoreError;
use std::path::{Path, PathBuf};

use super::MAX_SHELL_OUTPUT_BYTES;

/// cd 判定点（预留）：终端面板是用户主动输入的单命令面板，`cd` 属合法交互，
/// 产品决策**保留允许 cd**（不拦截，与 AI 侧工具层 T-AB-04 的全路径禁 cd 不同——
/// 用户在自己终端面板里的 cd 是期望行为）。
///
/// 若需求演进为全路径禁 cd：在本函数内调用 conex-sandbox 的 CdShape 分类
/// （T-AB-05 冻结接口：段级分类器，`cd x` / `Set-Location x` / `pushd x` 命中；
/// `git -C` / 引号内 `echo "cd x"` 不命中），命中即返回 InvalidInput，
/// 文案引导「请使用 Cwd 参数指定工作目录，而非 cd 命令」（对齐 T-AB-04 拦截文案）。
pub(super) fn check_cd_policy(command: &str) -> Option<CoreError> {
    let _ = command;
    None
}

pub(super) fn resolve_shell_cwd(cwd: Option<&str>) -> Result<PathBuf, CoreError> {
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

pub(super) fn build_shell_invocation(
    command: &str,
) -> Result<(String, Vec<String>, String), CoreError> {
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

pub(super) fn clamp_output_bytes(raw: &[u8]) -> (String, bool) {
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
