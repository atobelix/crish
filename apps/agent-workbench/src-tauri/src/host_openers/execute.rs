//! 主机打开器执行：解析打开器命令与目标，经安全闸门（双防线）校验后拉起进程。
//!
//! 安全模型（PE-07 T07.3）：
//! - 第一道防线：`CommandGatekeeper::check_command`（命令 + 参数整行正则）；
//! - 第二道防线：`gatekeeper.patterns().is_match` 逐参 / 逐路径匹配；
//! - 任一命中 → `CoreError::InvalidInput`（"Command blocked by safety red-line
//!   gatekeeper (InvalidCommand)"），不执行任何进程。
//!
//! 错误统一 `CoreError`（IPC 面唯一协议），`HostOpenerError` 经 `to_core_error` 映射。

// G2 禁令豁免（clippy.toml 文件头「豁免面」）：host opener 进程执行面——
// 本文件每个 spawn 点（open_host_target / open_with_shortcut /
// open_path_with_default_app）执行前必过 CommandGatekeeper 双防线
// （check_command + patterns 逐参匹配，见文件头安全模型与各函数体内校验），
// 是「子进程经命令门禁」的门禁落地处本身。
// 收敛说明：2026-08-06 由模块级 `#![allow]` 收敛为函数级豁免 + 理由
// （对齐 clippy.toml 豁免面「函数级 allow + 理由」，33 方案 DD4-T2），
// 模块级豁免会连带覆盖未来新增代码（豁免面蔓延），函数级仅覆盖三个
// 门禁函数本身；本段注释保留为函数级理由的引用源。

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use conex_types::CoreError;

use crate::host_openers::discovery::opener_candidates;
use crate::host_openers::resolve::{
    open_target_display, opener_args, resolve_candidate_command, resolve_open_target_for_roots,
    unavailable_diagnostic,
};
use crate::host_openers::types::{
    host_opener_diagnostic, host_opener_error, to_core_error, HostOpenerError, HostOpenResult,
    HostOpenTarget, HostOpenTargetKindForResult, ResolvedOpenTarget,
};

// G2 禁令豁免：host opener 执行面——本函数所有拉起点（.spawn()）执行前必过
// CommandGatekeeper 双防线（check_command + patterns 逐参匹配，见函数体内
// gatekeeper 校验与文件头安全模型），即门禁落地处本身；函数级 allow
// （对齐 clippy.toml 豁免面「函数级 allow + 理由」），理由详见文件头安全模型。
#[allow(clippy::disallowed_methods)]
pub(crate) fn open_host_target(
    opener_id: String,
    target: HostOpenTarget,
) -> Result<HostOpenResult, CoreError> {
    if let Some(lnk_path) = opener_id.strip_prefix("lnk:") {
        let lnk_owned = lnk_path.to_string();
        return open_with_shortcut(&lnk_owned, target, opener_id);
    }
    let path_env = std::env::var_os("PATH");
    let env_lookup = |key: &str| std::env::var_os(key);
    let path_exists = |path: &Path| path.exists();
    let path_dirs = std::env::split_paths(&path_env.unwrap_or_default())
        .collect::<Vec<_>>();
    let candidates = opener_candidates(&env_lookup);
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.id == opener_id)
        .ok_or_else(|| {
            to_core_error(host_opener_error(
                "host-opener-not-found",
                format!("Host opener id is not known on this OS: {opener_id}"),
                None,
                None,
            ))
        })?;
    let resolved = resolve_candidate_command(candidate, &path_dirs, &path_exists).ok_or_else(|| {
        let diagnostic = unavailable_diagnostic(candidate);
        to_core_error(HostOpenerError {
            code: "host-opener-unavailable".to_string(),
            message: diagnostic.message.clone(),
            diagnostic,
        })
    })?;
    let app_dir = crate::host_paths::app_dir()
        .map_err(|message| to_core_error(host_opener_error(
            "host-path-root-unavailable", message, None, None,
        )))?;
    let workspace = crate::host_paths::workspace_root(&app_dir);
    let roots = [workspace.as_path()];
    let resolved_target = resolve_open_target_for_roots(&target, &roots).map_err(to_core_error)?;
    let args = opener_args(candidate, &resolved_target).map_err(to_core_error)?;

    let command_display = resolved.command.display().to_string();
    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    let args_strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    if gatekeeper.check_command(&command_display, &args_strs) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || args.iter().any(|a| gatekeeper.patterns().is_match(a))
    {
        return Err(to_core_error(host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            Some(command_display),
            None,
        )));
    }

    Command::new(&resolved.command)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            to_core_error(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to launch host opener {opener_id}: {error}"),
                Some(command_display.clone()),
                None,
            ))
        })?;

    Ok(HostOpenResult {
        ok: true,
        opener_id,
        target_kind: match resolved_target {
            ResolvedOpenTarget::Path(_) => HostOpenTargetKindForResult::Path,
            ResolvedOpenTarget::Url(_) => HostOpenTargetKindForResult::Url,
        },
        target: open_target_display(&resolved_target),
        command: command_display,
        diagnostic: host_opener_diagnostic(
            "host-opener-launched",
            "Host opener launch command was started.",
            Some(resolved.command.display().to_string()),
            Some(open_target_display(&resolved_target)),
        ),
    })
}

// G2 禁令豁免：host opener 执行面——本函数拉起点（.spawn()，仅 Windows 分支）
// 执行前必过 CommandGatekeeper 双防线（check_command + patterns 逐参匹配，
// 见函数体内 gatekeeper 校验与文件头安全模型），即门禁落地处本身；
// 函数级 allow（对齐 clippy.toml 豁免面「函数级 allow + 理由」），
// 理由详见文件头安全模型。
#[allow(clippy::disallowed_methods)]
fn open_with_shortcut(
    lnk_path: &str,
    target: HostOpenTarget,
    opener_id: String,
) -> Result<HostOpenResult, CoreError> {
    let lnk = PathBuf::from(lnk_path);
    if !lnk.exists() {
        return Err(to_core_error(host_opener_error(
            "host-opener-not-found",
            format!("Shortcut not found: {lnk_path}"),
            Some(lnk_path.to_string()),
            None,
        )));
    }
    let app_dir = crate::host_paths::app_dir()
        .map_err(|message| to_core_error(host_opener_error(
            "host-path-root-unavailable", message, None, None,
        )))?;
    let workspace = crate::host_paths::workspace_root(&app_dir);
    let roots = [workspace.as_path()];
    let resolved_target = resolve_open_target_for_roots(&target, &roots).map_err(to_core_error)?;
    let file_arg = match &resolved_target {
        ResolvedOpenTarget::Path(p) => p.display().to_string(),
        ResolvedOpenTarget::Url(u) => u.clone(),
    };

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    if gatekeeper.check_command(lnk_path, &[&file_arg]) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || gatekeeper.patterns().is_match(lnk_path)
        || gatekeeper.patterns().is_match(&file_arg)
    {
        return Err(to_core_error(host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            Some(lnk_path.to_string()),
            Some(file_arg),
        )));
    }

    #[cfg(windows)]
    {
        let script = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}'); Start-Process -FilePath $s.TargetPath -ArgumentList @('{}') -WorkingDirectory (Split-Path $s.TargetPath -Parent) -ErrorAction Stop",
            lnk_path.replace('\'', "''"),
            file_arg.replace('\'', "''"),
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id,
                target_kind: HostOpenTargetKindForResult::Path,
                target: file_arg.clone(),
                command: lnk_path.to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened via Start Menu shortcut.",
                    Some(lnk_path.to_string()),
                    Some(file_arg),
                ),
            }),
            Err(error) => Err(to_core_error(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to launch shortcut: {error}"),
                Some(lnk_path.to_string()),
                Some(file_arg),
            ))),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = file_arg;
        Err(to_core_error(host_opener_error(
            "host-opener-unavailable",
            "Shortcut open is only implemented on Windows.",
            Some(lnk_path.to_string()),
            None,
        )))
    }
}

// G2 禁令豁免：host opener 执行面——本函数所有拉起点（.spawn()，
// Windows cmd start / macOS open / 其余 Unix xdg-open 三个 cfg 分支）
// 执行前必过 CommandGatekeeper 双防线（check_command + patterns 逐参匹配，
// 见函数体内 gatekeeper 校验与文件头安全模型），即门禁落地处本身；
// 函数级 allow 覆盖函数体全部 cfg 分支（对齐 clippy.toml 豁免面
// 「函数级 allow + 理由」），理由详见文件头安全模型。
#[allow(clippy::disallowed_methods)]
pub(crate) fn open_path_with_default_app(path: String) -> Result<HostOpenResult, CoreError> {
    let target = path.trim().to_string();
    if target.is_empty() {
        return Err(to_core_error(host_opener_error(
            "host-path-empty",
            "Path is empty.",
            None,
            None,
        )));
    }

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    if gatekeeper.check_command("start", &[&target]) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || gatekeeper.patterns().is_match(&target)
    {
        return Err(to_core_error(host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            None,
            Some(target.clone()),
        )));
    }

    let p = PathBuf::from(&target);
    if !p.exists() {
        return Err(to_core_error(host_opener_error(
            "host-path-missing",
            format!("Path does not exist: {target}"),
            None,
            Some(target.clone()),
        )));
    }

    #[cfg(windows)]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id: "system-default".to_string(),
                target_kind: HostOpenTargetKindForResult::Path,
                target: target.clone(),
                command: "cmd /C start".to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened path with system default association.",
                    Some("cmd /C start".to_string()),
                    Some(target),
                ),
            }),
            Err(error) => Err(to_core_error(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("cmd /C start".to_string()),
                Some(target),
            ))),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id: "system-default".to_string(),
                target_kind: HostOpenTargetKindForResult::Path,
                target: target.clone(),
                command: "open".to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened path with system default association.",
                    Some("open".to_string()),
                    Some(target),
                ),
            }),
            Err(error) => Err(to_core_error(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("open".to_string()),
                Some(target),
            ))),
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match status {
            Ok(_) => Ok(HostOpenResult {
                ok: true,
                opener_id: "system-default".to_string(),
                target_kind: HostOpenTargetKindForResult::Path,
                target: target.clone(),
                command: "xdg-open".to_string(),
                diagnostic: host_opener_diagnostic(
                    "host-opener-launched",
                    "Opened path with system default association.",
                    Some("xdg-open".to_string()),
                    Some(target),
                ),
            }),
            Err(error) => Err(to_core_error(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("xdg-open".to_string()),
                Some(target),
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_opener_blocks_eleven_red_line_targets() {
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

        for target in red_lines {
            let res = open_path_with_default_app(target.to_string());
            assert!(
                res.is_err(),
                "Expected open_path_with_default_app to block red line target `{}`",
                target
            );
            let err = res.unwrap_err();
            match err {
                CoreError::InvalidInput(detail) => {
                    assert!(
                        detail.contains("InvalidCommand"),
                        "detail should contain InvalidCommand: {detail}"
                    );
                }
                other => panic!("expected InvalidInput, got {other:?}"),
            }
        }
    }

    #[test]
    fn to_core_error_maps_permission_denied_to_invalid_input() {
        let e = host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            None,
            None,
        );
        match to_core_error(e) {
            CoreError::InvalidInput(msg) => assert!(msg.contains("InvalidCommand")),
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn to_core_error_keeps_code_for_other_errors() {
        let e = host_opener_error(
            "host-opener-spawn-failed",
            "Failed to launch host opener",
            None,
            None,
        );
        match to_core_error(e) {
            CoreError::Internal(msg) => assert!(msg.contains("host-opener-spawn-failed")),
            other => panic!("expected Internal, got {other:?}"),
        }
    }

    /// P1-S5 红测试：含 cmd 元字符（`&`/`|`）的已存在路径不得放行——
    /// `cmd /C start "" <target>` 会被 cmd 二次解释（`a&whoami` 拆为
    /// `start a` + `whoami` 两条命令）。修复语义：拒绝该类路径。
    // 测试临时目录清理豁免（clippy.toml「测试代码临时目录清理」豁免面）
    #[allow(clippy::disallowed_methods)]
    #[test]
    fn open_path_with_default_app_rejects_metachar_targets() {
        let dir = std::env::temp_dir().join(format!("conex-opener-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        for name in ["a&whoami", "a&whoami.txt", "a&&whoami", "b|whoami"] {
            let file = dir.join(name);
            let _ = std::fs::write(&file, b"x");
            let target = file.to_string_lossy().to_string();
            let res = open_path_with_default_app(target.clone());
            assert!(
                res.is_err(),
                "含 cmd 元字符的路径必须拒绝（F6-02 注入面）：`{target}`"
            );
            let err = res.unwrap_err();
            match err {
                CoreError::InvalidInput(detail) => {
                    assert!(
                        detail.contains("InvalidCommand"),
                        "detail should contain InvalidCommand: {detail}"
                    );
                }
                other => panic!("expected InvalidInput, got {other:?}"),
            }
        }
        // 测试临时目录清理（走 test 豁免面，产物为测试自建）
        let _ = std::fs::remove_dir_all(&dir);
    }
}
