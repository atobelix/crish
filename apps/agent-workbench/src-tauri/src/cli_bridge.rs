use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    path::Path,
    process::{Command, Stdio},
};

use crate::host_paths::{app_dir, workspace_root};

// Developer diagnostics only. Product run/snapshot/continuation commands use
// the daemon sidecar path registered from sidecar.rs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliStatusOutput {
    snapshot: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchCliRunResult {
    ok: bool,
    command: String,
    cwd: String,
    stdout: String,
    stderr: String,
    status: Option<i32>,
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_task_snapshot() -> Result<Value, String> {
    let output = run_workbench_cli_json("status", Vec::new())?;
    let parsed: CliStatusOutput = serde_json::from_value(output).map_err(|e| e.to_string())?;
    Ok(parsed.snapshot)
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_bootstrap() -> Result<Value, String> {
    run_workbench_cli_json("status", Vec::new())
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_continuation(prompt: Option<String>) -> Result<Value, String> {
    let mut args = Vec::new();
    if let Some(prompt) = prompt.filter(|v| !v.trim().is_empty()) {
        args.push(format!("--prompt={prompt}"));
    }
    run_workbench_cli_json("continue", args)
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_background_demo(prompt: Option<String>) -> Result<Value, String> {
    let mut args = Vec::new();
    if let Some(prompt) = prompt.filter(|v| !v.trim().is_empty()) {
        args.push(format!("--prompt={prompt}"));
    }
    run_workbench_cli_json("background-demo", args)
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_run_task(prompt: String) -> Result<Value, String> {
    run_workbench_cli_json("run-json", prompt_extra_args(prompt))
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_run_goal(prompt: String) -> Result<Value, String> {
    run_workbench_cli_json("goal-json", prompt_extra_args(prompt))
}

#[tauri::command]
pub(crate) fn workbench_dev_cli_probe(command: String) -> Result<WorkbenchCliRunResult, String> {
    run_workbench_cli_raw(&command, Vec::new())
}

fn run_workbench_cli_json(command: &str, args: Vec<String>) -> Result<Value, String> {
    let raw = run_workbench_cli_raw(command, args)?;
    if !raw.ok {
        return Err(format!(
            "agent-workbench CLI failed: status={:?}, stderr={}",
            raw.status, raw.stderr
        ));
    }
    serde_json::from_str(&raw.stdout).map_err(|e| {
        format!(
            "agent-workbench CLI returned invalid JSON: {e}; stdout={}",
            raw.stdout
        )
    })
}

fn run_workbench_cli_raw(
    command: &str,
    extra_args: Vec<String>,
) -> Result<WorkbenchCliRunResult, String> {
    if !matches!(
        command,
        "status" | "continue" | "background-demo" | "run" | "run-json" | "goal-run" | "goal-json"
    ) {
        return Err(format!("unsupported workbench CLI command: {command}"));
    }

    let gatekeeper = conex_sandbox::gatekeeper::CommandGatekeeper::new();
    let extra_refs: Vec<&str> = extra_args.iter().map(|s| s.as_str()).collect();
    if gatekeeper.check_command(command, &extra_refs) == conex_sandbox::gatekeeper::GatekeeperResult::Blocked
        || extra_args.iter().any(|a| gatekeeper.patterns().is_match(a))
    {
        return Err(
            "PermissionDenied: Command blocked by safety red-line gatekeeper (InvalidCommand)"
                .to_string(),
        );
    }

    let app_dir = app_dir()?;
    let root_dir = workspace_root(&app_dir);
    let cwd = env::current_dir().unwrap_or_else(|_| root_dir.clone());
    let mut args = workbench_cli_npm_args(command, &cwd);
    args.extend(extra_args);

    let output = Command::new(npm_command())
        .args(&args)
        .current_dir(&root_dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start agent-workbench CLI: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(WorkbenchCliRunResult {
        ok: output.status.success(),
        command: command.to_string(),
        cwd: cwd.display().to_string(),
        stdout: strip_npm_banner(&stdout).trim().to_string(),
        stderr,
        status: output.status.code(),
    })
}

fn prompt_extra_args(prompt: String) -> Vec<String> {
    vec![format!("--prompt={prompt}")]
}

fn workbench_cli_npm_args(command: &str, cwd: &Path) -> Vec<String> {
    vec![
        "--workspace".to_string(),
        "@crish/agent-workbench".to_string(),
        "run".to_string(),
        "cli".to_string(),
        "--".to_string(),
        command.to_string(),
        format!("--cwd={}", cwd.display()),
    ]
}

fn npm_command() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn strip_npm_banner(stdout: &str) -> String {
    let mut json_started = false;
    let mut lines = Vec::new();
    for line in stdout.lines() {
        if !json_started {
            let trimmed = line.trim_start();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                json_started = true;
                lines.push(line);
            }
            continue;
        }
        lines.push(line);
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_bridge_blocks_red_line_commands() {
        let red_lines = vec![
            vec!["--prompt=rm -rf /".to_string()],
            vec!["--prompt=rm -rf /*".to_string()],
            vec!["--prompt=rm --no-preserve-root -rf /".to_string()],
            vec!["--prompt=dd if=/dev/zero of=/dev/sda".to_string()],
            vec!["--prompt=dd if=/dev/random of=/dev/sda".to_string()],
            vec!["--prompt=mkfs.ext4 /dev/sda".to_string()],
            vec!["--prompt=Remove-Item -Recurse -Path C:\\".to_string()],
            vec!["--prompt=Remove-Item -Recurse C:\\".to_string()],
            vec!["--prompt=format C:".to_string()],
            vec!["--prompt=del /f C:\\".to_string()],
            vec!["--prompt=rd /s C:\\".to_string()],
        ];

        for extra in red_lines {
            let res = run_workbench_cli_raw("run", extra.clone());
            assert!(
                res.is_err(),
                "Expected CLI bridge to block red line extra_args {:?}",
                extra
            );
            let err = res.unwrap_err();
            assert!(err.contains("PermissionDenied"), "Err should contain PermissionDenied");
            assert!(err.contains("InvalidCommand"), "Err should contain InvalidCommand");
        }
    }
}
