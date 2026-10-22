//! workbench_run_shell 门禁（红线 / 需审批 / 混淆 / 越界 cwd）与子进程环境测试

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
