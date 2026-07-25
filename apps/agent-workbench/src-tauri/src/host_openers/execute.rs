use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use crate::host_paths::{app_dir, workspace_root};
use crate::host_openers::discovery::opener_candidates;
use crate::host_openers::resolve::{
    open_target_display, opener_args, resolve_candidate_command, resolve_open_target_for_roots,
    unavailable_diagnostic,
};
use crate::host_openers::types::{
    host_opener_diagnostic, host_opener_error, HostOpenerError, HostOpenResult,
    HostOpenTarget, HostOpenTargetKindForResult, ResolvedOpenTarget,
};

pub(crate) fn open_host_target(
    opener_id: String,
    target: HostOpenTarget,
) -> Result<HostOpenResult, HostOpenerError> {
    if let Some(lnk_path) = opener_id.strip_prefix("lnk:") {
        let lnk_owned = lnk_path.to_string();
        return open_with_shortcut(&lnk_owned, target, opener_id);
    }
    let path_env = std::env::var_os("PATH");
    let env_lookup = |key: &str| std::env::var_os(key);
    let path_exists = |path: &Path| path.exists();
    let path_dirs = std::env::split_paths(&path_env.unwrap_or_default())
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    let candidates = opener_candidates(&env_lookup);
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.id == opener_id)
        .ok_or_else(|| {
            host_opener_error(
                "host-opener-not-found",
                format!("Host opener id is not known on this OS: {opener_id}"),
                None,
                None,
            )
        })?;
    let resolved = resolve_candidate_command(candidate, &path_dirs, &path_exists).ok_or_else(|| {
        let diagnostic = unavailable_diagnostic(candidate);
        HostOpenerError {
            code: "host-opener-unavailable".to_string(),
            message: diagnostic.message.clone(),
            diagnostic,
        }
    })?;
    let app_dir = app_dir().map_err(|message| {
        host_opener_error("host-path-root-unavailable", message, None, None)
    })?;
    let workspace = workspace_root(&app_dir);
    let roots = [workspace.as_path()];
    let resolved_target = resolve_open_target_for_roots(&target, &roots)?;
    let args = opener_args(candidate, &resolved_target)?;

    let command_display = resolved.command.display().to_string();
    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    let args_strs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    if gatekeeper.check_command(&command_display, &args_strs) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || args.iter().any(|a| gatekeeper.patterns().is_match(a))
    {
        return Err(host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            Some(command_display),
            None,
        ));
    }

    Command::new(&resolved.command)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to launch host opener {opener_id}: {error}"),
                Some(command_display.clone()),
                None,
            )
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

fn open_with_shortcut(
    lnk_path: &str,
    target: HostOpenTarget,
    opener_id: String,
) -> Result<HostOpenResult, HostOpenerError> {
    let lnk = PathBuf::from(lnk_path);
    if !lnk.exists() {
        return Err(host_opener_error(
            "host-opener-not-found",
            format!("Shortcut not found: {lnk_path}"),
            Some(lnk_path.to_string()),
            None,
        ));
    }
    let app_dir = app_dir().map_err(|message| {
        host_opener_error("host-path-root-unavailable", message, None, None)
    })?;
    let workspace = workspace_root(&app_dir);
    let roots = [workspace.as_path()];
    let resolved_target = resolve_open_target_for_roots(&target, &roots)?;
    let file_arg = match &resolved_target {
        ResolvedOpenTarget::Path(p) => p.display().to_string(),
        ResolvedOpenTarget::Url(u) => u.clone(),
    };

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    if gatekeeper.check_command(lnk_path, &[&file_arg]) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || gatekeeper.patterns().is_match(lnk_path)
        || gatekeeper.patterns().is_match(&file_arg)
    {
        return Err(host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            Some(lnk_path.to_string()),
            Some(file_arg),
        ));
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
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to launch shortcut: {error}"),
                Some(lnk_path.to_string()),
                Some(file_arg),
            )),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = file_arg;
        Err(host_opener_error(
            "host-opener-unavailable",
            "Shortcut open is only implemented on Windows.",
            Some(lnk_path.to_string()),
            None,
        ))
    }
}

pub(crate) fn open_path_with_default_app(path: String) -> Result<HostOpenResult, HostOpenerError> {
    let target = path.trim().to_string();
    if target.is_empty() {
        return Err(host_opener_error(
            "host-path-empty",
            "Path is empty.",
            None,
            None,
        ));
    }

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    if gatekeeper.check_command("start", &[&target]) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || gatekeeper.patterns().is_match(&target)
    {
        return Err(host_opener_error(
            "PermissionDenied",
            "Command blocked by safety red-line gatekeeper (InvalidCommand)",
            None,
            Some(target.clone()),
        ));
    }

    let p = PathBuf::from(&target);
    if !p.exists() {
        return Err(host_opener_error(
            "host-path-missing",
            format!("Path does not exist: {target}"),
            None,
            Some(target.clone()),
        ));
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
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("cmd /C start".to_string()),
                Some(target),
            )),
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
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("open".to_string()),
                Some(target),
            )),
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
            Err(error) => Err(host_opener_error(
                "host-opener-spawn-failed",
                format!("Failed to open with system default: {error}"),
                Some("xdg-open".to_string()),
                Some(target),
            )),
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
            assert_eq!(err.code, "PermissionDenied");
            assert!(err.message.contains("InvalidCommand"));
        }
    }
}
