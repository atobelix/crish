use super::super::shell_invoke::base64_encode;
use super::super::*;
use super::{ctx, tool};
use conex_test_utils::TempWorkspace;
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn shell_blocked_command_rejected() {
    let ws = TempWorkspace::new("shell_blocked");
    let t = tool();
    let err = t
        .execute(&ctx(&ws), json!({ "command": "rm -rf /" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
}

/// PS-01 T1.5 端到端：换行包裹的毁灭性命令（printf x\n/bin/rm -rf -- /，
/// 真实换行）经门禁拦截（先例 shell_blocked_command_rejected:1516）
#[tokio::test]
async fn shell_newline_wrapped_rm_blocked() {
    let ws = TempWorkspace::new("shell_newline_blocked");
    let t = tool();
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "printf x\n/bin/rm -rf -- /" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
}

/// S8：红线命令（rm -rf /）经门禁拦截时发射 security-audit
/// （operation=command-exec，decision=blocked）
#[tokio::test]
async fn redline_blocked_emits_security_audit() {
    use crate::audit::RecordingAuditSink;
    use conex_types::events::SecurityAuditDecision as Decision;
    use conex_types::events::SecurityAuditOperation as Op;
    use conex_types::AgentEvent;

    let ws = TempWorkspace::new("shell_s8_redline");
    let sink = Arc::new(RecordingAuditSink::new());
    let t = ShellCommandTool::with_audit_sink(
        30_000,
        200_000,
        None,
        Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
    );

    let err = t
        .execute(&ctx(&ws), json!({ "command": "rm -rf /" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    let events = sink.emitted();
    assert_eq!(events.len(), 1, "红线拦截应发射 1 条审计事件");
    match &events[0] {
        AgentEvent::SecurityAudit {
            operation,
            targets,
            decision,
            ..
        } => {
            assert_eq!(operation, &Op::CommandExec);
            assert_eq!(targets, &vec!["rm -rf /".to_string()]);
            assert_eq!(decision, &Decision::Blocked);
        }
        other => panic!("应为 security-audit，实际 {}", other.type_name()),
    }
}

// ===== T-AB-04：禁 cd 工具层拦截 =====

/// 任务卡验收：`shell_command({command: "cd sub"})` 返回拦截文案
/// （含「Cwd 参数」）
#[tokio::test]
async fn shell_cd_blocked_with_cwd_guidance() {
    let ws = TempWorkspace::new("shell_cd_block");
    let t = tool();
    let err = t
        .execute(&ctx(&ws), json!({ "command": "cd sub" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_CD_BLOCKED);
    assert!(err.to_string().contains("Cwd 参数"));
    assert!(err.to_string().contains("而非 cd 命令"));
}

/// 任务卡验收：`cd sub && git status` 整链拦截（链内其他段不代为执行）
#[tokio::test]
async fn shell_cd_chain_intercepted() {
    let ws = TempWorkspace::new("shell_cd_chain");
    let t = tool();
    let err = t
        .execute(&ctx(&ws), json!({ "command": "cd sub && git status" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_CD_BLOCKED);
    assert!(err.to_string().contains("整链"));
    assert!(err.to_string().contains("Cwd 参数"));
}

/// 冻结接口 #3（conex-sandbox T-AB-05 语义层）：cd / Set-Location / sl /
/// pushd / popd 命中；git -C / echo "cd x" 不命中
#[test]
fn classify_cd_shape_variants() {
    use conex_sandbox::semantics::{classify_command_segments, CommandClass};
    assert_eq!(
        classify_command_segments(&["cd sub".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["cd".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["cd /d".to_string(), "git status".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["set-location sub".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["sl sub".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["pushd x".to_string(), "popd".to_string()]),
        CommandClass::CdShape
    );
    // CD_COMMANDS 扩充：Push-Location / Pop-Location / chdir
    assert_eq!(
        classify_command_segments(&["Push-Location sub".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["Pop-Location".to_string()]),
        CommandClass::CdShape
    );
    assert_eq!(
        classify_command_segments(&["chdir sub".to_string()]),
        CommandClass::CdShape
    );
    // 不命中：git -C 不依赖进程内目录状态；echo "cd x" 段首非 cd
    assert_eq!(
        classify_command_segments(&["git -C src status".to_string()]),
        CommandClass::Normal
    );
    assert_eq!(
        classify_command_segments(&["echo cd x".to_string()]),
        CommandClass::Normal
    );
    assert_eq!(
        classify_command_segments(&["git status".to_string()]),
        CommandClass::Normal
    );
}

/// 任务卡验收：Push-Location / Pop-Location / chdir / 间接执行 cd / pwsh -wd 及解码明文拦截
#[tokio::test]
async fn shell_cd_expansion_and_indirect_intercepted() {
    let ws = TempWorkspace::new("shell_cd_exp");
    let t = tool();

    // 1. Push-Location / Pop-Location / chdir 单段拦截
    for cmd in ["Push-Location sub", "Pop-Location", "chdir sub"] {
        let err = t
            .execute(&ctx(&ws), json!({ "command": cmd }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_CD_BLOCKED);
        assert!(err.to_string().contains("Cwd 参数"));
    }

    // 2. 间接执行包裹内的 cd 形态（如 cmd /c "cd /d sub && whoami"）
    let err_indirect = t
        .execute(
            &ctx(&ws),
            json!({ "command": "cmd /c \"cd /d sub && whoami\"" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err_indirect.code(), TOOL_CD_BLOCKED);
    assert!(err_indirect.to_string().contains("Cwd 参数"));

    // 3. PowerShell -WorkingDirectory / -wd 启动参数目录逃逸拦截
    let err_wd = t
        .execute(&ctx(&ws), json!({ "command": "pwsh -wd sub" }))
        .await
        .unwrap_err();
    assert_eq!(err_wd.code(), TOOL_CD_BLOCKED);
    assert!(err_wd
        .to_string()
        .contains("PowerShell 启动参数 (-WorkingDirectory / -wd) 目录篡改"));

    // 4. Base64 编码命令拦截并展示解码明文
    let b64_cd = {
        let utf16: Vec<u8> = "cd sub"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect();
        base64_encode(&utf16)
    };
    let err_ec_cd = t
        .execute(
            &ctx(&ws),
            json!({ "command": format!("powershell -ec {b64_cd}") }),
        )
        .await
        .unwrap_err();
    assert_eq!(err_ec_cd.code(), TOOL_CD_BLOCKED);
    assert!(err_ec_cd.to_string().contains("[解码明文: cd sub]"));
}

/// BC10-4: 命令行正文绝对路径系统核心关键目录物理红线刚性拦截
#[tokio::test]
async fn command_path_inspector_blocks_system_critical_paths() {
    let ws = TempWorkspace::new("shell_path_critical");
    let t = tool();
    let ctx = ctx(&ws);

    let critical_cmds = [
        "cat C:\\Windows\\System32\\drivers\\etc\\hosts",
        "type \"C:/Program Files/app/config.ini\"",
        "cat /etc/passwd",
        "ls /usr/bin/python3",
        "cat ~/.ssh/id_rsa",
        "echo test > C:\\Windows\\temp.txt",
    ];

    for cmd in critical_cmds {
        let res = t.execute(&ctx, json!({ "command": cmd })).await;
        let err = res.expect_err(&format!("命令包含系统关键目录必须被硬性拦截: {cmd}"));
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED, "命令: {cmd}");
        assert!(
            err.to_string().contains("系统核心关键目录"),
            "错误信息必须明确提示包含系统关键目录敏感路径，实际: {err}，命令: {cmd}"
        );
    }
}

/// BC10-4: 命令行绝对路径写操作（重定向、Out-File、mkdir 等）越出工作区刚性阻断
#[tokio::test]
async fn command_path_inspector_blocks_out_of_workspace_write() {
    let ws = TempWorkspace::new("shell_path_write_outside");
    let t = tool();
    let ctx = ctx(&ws);

    let outside_write_cmds = [
        "echo hacked > C:\\outside_test_ws_999\\evil.txt",
        "echo hacked >> C:\\outside_test_ws_999\\evil.txt",
        "mkdir C:\\outside_test_ws_999\\new_dir",
        "Get-Process | Out-File C:\\outside_test_ws_999\\proc.txt",
        "touch /tmp/outside_test_ws_999.txt",
    ];

    for cmd in outside_write_cmds {
        let res = t.execute(&ctx, json!({ "command": cmd })).await;
        let err = res.expect_err(&format!("向工作区外写操作必须被拦截: {cmd}"));
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED, "命令: {cmd}");
        assert!(
            err.to_string().contains("工作区外写入或删除"),
            "错误信息必须明确提示禁止越界写，实际: {err}，命令: {cmd}"
        );
    }
}

/// BC10-4: 工作区内绝对路径合法写操作正常放行
#[tokio::test]
async fn command_path_inspector_allows_in_workspace_write() {
    let ws = TempWorkspace::new("shell_path_write_inside");
    let t = tool();
    let ctx = ctx(&ws);

    let target_file = ws.path().join("in_workspace_test.txt");
    let target_str = target_file.to_string_lossy();

    let cmd = format!("echo hello > \"{target_str}\"");
    let res = t.execute(&ctx, json!({ "command": cmd })).await;
    assert!(
        res.is_ok(),
        "工作区内绝对路径写操作应正常执行，实际错误: {:?}",
        res
    );
    assert!(target_file.exists(), "文件应已成功在工作区写入");
}

/// R3（BLK-04）：`/c`、`/Z` 这类单字母路径按 Windows 盘符别名处理，不当成 Unix
/// 绝对路径。该分支原为 `.chars().next().unwrap()`（单字母不变量），改为 match
/// 后行为必须与旧实现逐值一致（回归锁）。
#[test]
fn single_letter_slash_path_is_not_unix_path() {
    assert!(!is_valid_unix_path("/c"));
    assert!(!is_valid_unix_path("/Z"));
    assert!(is_valid_unix_path("/tmp"));
    assert!(is_valid_unix_path("/usr"));
}
