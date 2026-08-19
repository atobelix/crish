//! shell 工具测试（SR-06a-2 拆分 · 经 shell.rs `#[path]` 接线；测试资产保护
//! 铁律：全部既有测试原样迁入，零删除；测试名/断言形状不变）

// G2 禁令豁免：测试 mod——真实 spawn 探测命令门禁语义（红线目标断言
// Blocked）+ pid 存活探测（tasklist / kill -0，T-AB-06/07 验收辅助），
// 非产品执行面；测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]
use super::*;
use crate::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskRef, BackgroundTaskStatus,
    KillResult, LogSlice,
};
use crate::context::{create_mock_tool_context, AskChannel, ToolContext};
use crate::streaming::{ToolProgress, ToolStream, ToolStreamItem};
use conex_fs::trash::TrashService;
use conex_test_utils::TempWorkspace;
use futures_util::StreamExt;
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use tokio::process::Command as TokioCommand;
use tokio::time::Duration;

use super::shell_exec::terminate_process_tree;
use super::shell_invoke::{
    base64_encode, build_shell_invocation, build_windows_powershell_script, parse_mode, ShellMode,
};
use super::shell_output::{clamp_output_bytes, format_command_result, high_output_suggestion};

fn tool() -> ShellCommandTool {
    ShellCommandTool::new(30_000, 200_000, None)
}

/// 测试用会话上下文：workspace_root 指向临时工作区
fn ctx(ws: &TempWorkspace) -> ToolContext {
    ToolContext {
        workspace_root: ws.path().clone(),
        ..create_mock_tool_context()
    }
}

/// 测试用审批通道：记录审批请求（工具名）并返回预设裁决
#[derive(Clone, Debug)]
struct MockAskChannel {
    decision: AskDecision,
    requested: Arc<std::sync::Mutex<Vec<String>>>,
}

#[async_trait]
impl AskChannel for MockAskChannel {
    async fn ask(
        &self,
        tool_name: &str,
        _args: &serde_json::Value,
    ) -> Result<AskDecision, ToolError> {
        self.requested
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tool_name.to_string());
        Ok(self.decision.clone())
    }
}

/// T10：带 dangerous 标记的 shell 命令触发审批（拒绝路径）——approval
/// 事件产生（通道被问询）且命令未直接执行（返回 Denied 拒绝结果）
#[tokio::test]
async fn dangerous_command_asks_then_denied_never_executes() {
    let ws = TempWorkspace::new("shell_ask_deny");
    let t = tool();
    let requested = Arc::new(std::sync::Mutex::new(Vec::new()));
    let ask = Arc::new(MockAskChannel {
        decision: AskDecision::Denied {
            reason: "user says no".into(),
        },
        requested: Arc::clone(&requested),
    });
    let ctx = ToolContext {
        ask: Some(ask),
        ..ctx(&ws)
    };
    let err = t
        .execute(
            &ctx,
            json!({ "command": "echo sudo-hi", "timeoutMs": 5000 }),
        )
        .await
        .unwrap_err();
    // 审批事件产生：通道被问询一次
    // （timeoutMs 5000 仅约束「拒绝路径不执行命令」，命令本身未跑，无负载风险）
    assert_eq!(
        *requested.lock().unwrap_or_else(|e| e.into_inner()),
        vec!["shell_command".to_string()]
    );
    // 命令未直接执行：返回明确拒绝结果（Denied 语义）
    assert_eq!(err.code(), TOOL_USER_DENIED);
    assert!(err.to_string().contains("user says no"));
}

/// T10：带 dangerous 标记的 shell 命令触发审批（同意路径）——approval
/// 事件产生，用户同意后命令真正执行（越过门禁）
#[tokio::test]
async fn dangerous_command_asks_then_allowed_executes() {
    let ws = TempWorkspace::new("shell_ask_allow");
    let t = tool();
    let requested = Arc::new(std::sync::Mutex::new(Vec::new()));
    let ask = Arc::new(MockAskChannel {
        decision: AskDecision::Allowed,
        requested: Arc::clone(&requested),
    });
    let ctx = ToolContext {
        ask: Some(ask),
        ..ctx(&ws)
    };
    // 越界命令（gatekeeper RequiresApproval）：经审批放行后真正执行。
    // timeoutMs 用 60s：并行全量跑时 PowerShell 冷启动可能超过 5s，
    // 5s 上限曾导致负载型 flaky（命令被误判超时 → exitCode 为空）
    let out = t
        .execute(
            &ctx,
            json!({ "command": "echo sudo-hi", "timeoutMs": 60000 }),
        )
        .await
        .unwrap();
    assert_eq!(
        *requested.lock().unwrap_or_else(|e| e.into_inner()),
        vec!["shell_command".to_string()]
    );
    // 命令已执行（不再被审批拦截）：正常输出且退出码 0
    assert_eq!(out["exitCode"], 0);
    assert!(out["text"].as_str().unwrap().contains("sudo-hi"));
}

#[tokio::test]
async fn shell_echo_succeeds() {
    let ws = TempWorkspace::new("shell_echo");
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output hello-shell"
    } else {
        "echo hello-shell"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["exitCode"], 0);
    let stdout = out["stdout"].as_str().unwrap();
    assert!(stdout.contains("hello-shell"), "stdout: {stdout}");
    assert!(out["text"].as_str().unwrap().contains("hello-shell"));
}

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

#[tokio::test]
async fn shell_approval_command_requires_approval() {
    let ws = TempWorkspace::new("shell_approval");
    let t = tool();
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "git push --force origin main" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_REQUIRES_APPROVAL);
}

#[tokio::test]
async fn shell_timeout_kills_and_marks() {
    let ws = TempWorkspace::new("shell_timeout");
    let t = ShellCommandTool::new(30_000, 200_000, None);
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 10"
    } else {
        "sleep 10"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command, "timeoutMs": 2000 }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], true);
    assert!(out["stderr"].as_str().unwrap().contains("超时"));
}

#[tokio::test]
async fn shell_cwd_must_be_valid() {
    let ws = TempWorkspace::new("shell_cwd");
    let t = tool();
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "echo hi", "cwd": "no/such/dir" }),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not a directory"));
    // 越界 cwd 拒绝
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "echo hi", "cwd": "../outside" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.path_escape");
}

#[tokio::test]
async fn shell_exit_code_captured() {
    let ws = TempWorkspace::new("shell_exit");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "exit 42" }))
        .await
        .unwrap();
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
    assert_eq!(
        format_command_result("out", "", Some(3), false),
        "out\n\n(exit 3)"
    );
    assert_eq!(format_command_result("", "", Some(3), false), "(exit 3)");
    assert_eq!(
        format_command_result("out", "", None, true),
        "out\n\n(命令超时)"
    );
}

// ===== I2-S4：删除形态重定向（rm/del/Remove-Item/git rm → trash 服务）=====

/// 任务卡验收：`rm -rf ./tmp/foo` 经执行链 → 不实际删除 → 产生 trash entry
#[tokio::test]
async fn delete_shape_redirected_to_trash_not_executed() {
    let ws = TempWorkspace::new("shell_s4_rm");
    ws.write_file("tmp/foo.txt", "doomed");
    let trash = TempWorkspace::new("shell_s4_trash");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

    let out = t
        .execute(&ctx(&ws), json!({ "command": "rm -rf ./tmp/foo.txt" }))
        .await
        .unwrap();
    // 重定向而非直接执行
    assert_eq!(out["redirected"], true);
    assert_eq!(out["redirect"]["kind"], "delete-redirect");
    // 目标未物理删除（原路径消失 = 已移入回收站），回收站产生条目
    assert!(
        !ws.path().join("tmp/foo.txt").exists(),
        "原路径消失（已移入回收站）"
    );
    let entries = TrashService::new(trash.path()).list();
    assert_eq!(entries.len(), 1, "必须产生 trash entry");
    assert_eq!(out["trashEntries"][0]["entryId"], entries[0].id);
    // 可恢复：恢复后字节一致
    TrashService::new(trash.path())
        .restore(&entries[0].id)
        .unwrap();
    assert_eq!(ws.read_file("tmp/foo.txt"), "doomed");
}

/// 任务卡验收：`git status` 正常执行（非删除命令不受影响；临时工作区非
/// git 仓库时 git 自身以 128 退出，断言关键是「真实执行而非被拦截」）
#[tokio::test]
async fn git_status_executes_normally() {
    let ws = TempWorkspace::new("shell_s4_git");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "git status" }))
        .await
        .unwrap();
    assert!(
        out.get("redirected").is_none(),
        "非删除命令结果不得带重定向标记"
    );
    assert_eq!(out["timedOut"], false);
    assert!(out["exitCode"].is_number(), "git 应真实执行并产生退出码");
}

/// 删除形态全变体：rm / del / Remove-Item / git rm 一律重定向
#[tokio::test]
async fn delete_shape_variants_redirected() {
    for (cmd, target) in [
        ("rm file.txt", "file.txt"),
        ("del file.txt", "file.txt"),
        ("Remove-Item -LiteralPath file.txt -Force", "file.txt"),
        ("git rm file.txt", "file.txt"),
    ] {
        let ws = TempWorkspace::new("shell_s4_var");
        ws.write_file(target, "variant");
        let trash = TempWorkspace::new("shell_s4_var_trash");
        let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

        let out = t
            .execute(&ctx(&ws), json!({ "command": cmd }))
            .await
            .unwrap_or_else(|e| panic!("命令 {cmd:?} 应重定向而非报错：{e}"));
        assert_eq!(out["redirected"], true, "命令 {cmd:?} 应被重定向");
        assert_eq!(
            TrashService::new(trash.path()).list().len(),
            1,
            "命令 {cmd:?} 应产生 trash entry"
        );
        assert!(!ws.path().join(target).exists());
    }
}

/// 复合链：`echo done && rm x` → 整链拦截 + 引导（不执行任何段、不代为删除）
#[tokio::test]
async fn compound_chain_with_delete_intercepted() {
    let ws = TempWorkspace::new("shell_s4_chain");
    ws.write_file("x.txt", "keep");
    let trash = TempWorkspace::new("shell_s4_chain_trash");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

    let err = t
        .execute(&ctx(&ws), json!({ "command": "echo done && rm x.txt" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(err.to_string().contains("复合命令链"));
    assert!(err.to_string().contains("delete_file"));
    // 链未执行：文件仍在、回收站无条目
    assert!(
        ws.path().join("x.txt").exists(),
        "整链拦截后不得删除任何文件"
    );
    assert_eq!(TrashService::new(trash.path()).list().len(), 0);
}

/// 间接执行包裹删除形态：`bash -c 'rm -rf tmp/foo'` → 拦截 + 引导
#[tokio::test]
async fn indirect_delete_wrapper_intercepted() {
    let ws = TempWorkspace::new("shell_s4_indirect");
    ws.write_file("tmp/foo.txt", "keep");
    let trash = TempWorkspace::new("shell_s4_indirect_trash");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "bash -c 'rm -rf tmp/foo.txt'" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(err.to_string().contains("间接执行"));
    assert!(
        ws.path().join("tmp/foo.txt").exists(),
        "间接执行删除形态不得执行"
    );
    assert_eq!(TrashService::new(trash.path()).list().len(), 0);
}

/// 工作区外目标：一律拒绝（不引导不降级）
#[tokio::test]
async fn delete_target_outside_workspace_rejected() {
    let ws = TempWorkspace::new("shell_s4_outside");
    let t = tool();
    let err = t
        .execute(
            &ctx(&ws),
            json!({ "command": "rm C:\\Users\\x\\Desktop\\f.txt" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(err.to_string().contains("工作区外"));
}

/// 工作区根 / 当前工作目录目标：拒绝（rm -rf -- ./ 归一会命中）
#[tokio::test]
async fn delete_target_workspace_root_rejected() {
    let ws = TempWorkspace::new("shell_s4_root");
    let t = tool();
    let err = t
        .execute(&ctx(&ws), json!({ "command": "rm -rf -- ./" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(err.to_string().contains("工作区根"));
}

/// 通配符 / 特殊路径目标：拒绝并引导改用删除接口
#[tokio::test]
async fn delete_target_glob_rejected() {
    let ws = TempWorkspace::new("shell_s4_glob");
    let t = tool();
    for cmd in ["rm *.txt", "rm -rf tmp/*"] {
        let err = t
            .execute(&ctx(&ws), json!({ "command": cmd }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_COMMAND_BLOCKED, "命令 {cmd:?}");
        assert!(err.to_string().contains("通配符"), "命令 {cmd:?}");
    }
    let err = t
        .execute(&ctx(&ws), json!({ "command": "rm ~/notes.txt" }))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("特殊路径"));
}

/// S8：重定向结果携带影响面审计载荷（文件数 / 大小 / 跨目录 / 谨慎标记）
#[tokio::test]
async fn delete_redirect_carries_impact_audit() {
    let ws = TempWorkspace::new("shell_s8_impact");
    ws.write_file("sub/a.txt", "aaaa");
    ws.write_file("sub/b.txt", "bbbb");
    let trash = TempWorkspace::new("shell_s8_trash");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

    let out = t
        .execute(&ctx(&ws), json!({ "command": "rm -rf sub" }))
        .await
        .unwrap();
    let impact = &out["impact"];
    assert_eq!(impact["fileCount"], 2);
    assert_eq!(impact["totalSizeBytes"], 8);
    assert_eq!(impact["directoryCount"], 1);
    assert_eq!(impact["flagged"], false);
    // 审计字段：重定向 kind / 引导 / 回收站条目
    assert_eq!(out["redirect"]["kind"], "delete-redirect");
    assert!(out["redirect"]["guidance"]
        .as_str()
        .unwrap()
        .contains("delete_file"));
    assert_eq!(out["trashEntries"].as_array().unwrap().len(), 1);
    assert!(out["text"].as_str().unwrap().contains("trash_restore"));
}

/// S8：删除形态重定向发射 security-audit（decision=redirected，影响面载荷）
#[tokio::test]
async fn delete_redirect_emits_security_audit_event() {
    use crate::audit::RecordingAuditSink;
    use conex_types::events::SecurityAuditOperation as Op;
    use conex_types::AgentEvent;

    let ws = TempWorkspace::new("shell_s8_audit");
    ws.write_file("sub/a.txt", "aaaa");
    ws.write_file("sub/b.txt", "bbbb");
    let trash = TempWorkspace::new("shell_s8_audit_trash");
    let sink = Arc::new(RecordingAuditSink::new());
    let t = ShellCommandTool::with_audit_sink(
        30_000,
        200_000,
        Some(trash.path().clone()),
        Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
    );

    t.execute(&ctx(&ws), json!({ "command": "rm -rf sub" }))
        .await
        .unwrap();
    let events = sink.emitted();
    assert_eq!(events.len(), 1, "重定向应发射 1 条审计事件");
    match &events[0] {
        AgentEvent::SecurityAudit {
            operation,
            targets,
            impact,
            decision,
            ..
        } => {
            assert_eq!(operation, &Op::Delete);
            assert_eq!(
                targets,
                &vec![
                    conex_fs::ConexPathNormalizer::normalize(&ws.path().join("sub"))
                        .display()
                        .to_string()
                ],
                "目标为解析后的绝对路径"
            );
            assert_eq!(impact.file_count, 2);
            assert_eq!(impact.total_size_bytes, 8);
            assert_eq!(
                decision,
                &conex_types::events::SecurityAuditDecision::Redirected
            );
        }
        other => panic!("应为 security-audit，实际 {}", other.type_name()),
    }
}

/// S8：拦截分支发射 security-audit（decision=blocked）——复合链 / 间接执行 /
/// 通配符 / 工作区外四种形态各一条
#[tokio::test]
async fn delete_intercept_emits_blocked_audit() {
    use crate::audit::RecordingAuditSink;
    use conex_types::events::SecurityAuditDecision as Decision;
    use conex_types::events::SecurityAuditOperation as Op;
    use conex_types::AgentEvent;

    let ws = TempWorkspace::new("shell_s8_block");
    ws.write_file("x.txt", "keep");
    let trash = TempWorkspace::new("shell_s8_block_trash");
    let sink = Arc::new(RecordingAuditSink::new());
    let t = ShellCommandTool::with_audit_sink(
        30_000,
        200_000,
        Some(trash.path().clone()),
        Arc::clone(&sink) as Arc<dyn SecurityAuditSink>,
    );

    for cmd in [
        "echo done && rm x.txt",
        "bash -c 'rm -rf x.txt'",
        "rm *.txt",
        "rm C:\\Users\\x\\Desktop\\f.txt",
    ] {
        assert!(
            t.execute(&ctx(&ws), json!({ "command": cmd }))
                .await
                .is_err(),
            "命令 {cmd:?} 应被拦截"
        );
    }
    let events = sink.emitted();
    assert_eq!(events.len(), 4, "四种拦截形态各发射 1 条审计事件");
    for event in &events {
        match event {
            AgentEvent::SecurityAudit {
                operation,
                decision,
                ..
            } => {
                assert_eq!(operation, &Op::Delete, "拦截对象为删除形态");
                assert_eq!(decision, &Decision::Blocked, "拦截决策为 blocked");
            }
            other => panic!("应为 security-audit，实际 {}", other.type_name()),
        }
    }
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

/// 越界 / 特殊路径被拒时：不产生任何回收站条目（不半删除）
#[tokio::test]
async fn rejected_delete_produces_no_trash_entries() {
    let ws = TempWorkspace::new("shell_s4_noentry");
    ws.write_file("a.txt", "x");
    let trash = TempWorkspace::new("shell_s4_noentry_trash");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));

    for cmd in ["echo hi && rm a.txt", "rm *.txt"] {
        assert!(t
            .execute(&ctx(&ws), json!({ "command": cmd }))
            .await
            .is_err());
    }
    assert_eq!(TrashService::new(trash.path()).list().len(), 0);
    assert!(ws.path().join("a.txt").exists());
}

// ===== T-AB-01：同步路径流式化 =====

/// 平台无关睡眠命令（测试超时 / 转后台用）
fn sleep_cmd(secs: u32) -> String {
    if cfg!(windows) {
        format!("Start-Sleep -Seconds {secs}")
    } else {
        format!("sleep {secs}")
    }
}

/// 平台无关大输出命令（写 N 个字符到 stdout，单行）
fn big_output_cmd(ch: char, count: usize) -> String {
    if cfg!(windows) {
        format!("'{}' * {count}", ch)
    } else {
        format!("printf '{ch}%.0s' {{1..{count}}}")
    }
}

/// 任务卡验收：窗口内完成的命令 stdout/stderr/exitCode 与改造前逐字节一致
#[tokio::test]
async fn shell_streaming_preserves_sync_semantics() {
    let ws = TempWorkspace::new("shell_stream_sync");
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output stream-out-abc; [Console]::Error.WriteLine('stream-err-xyz'); exit 7"
    } else {
        "echo stream-out-abc; echo stream-err-xyz >&2; exit 7"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["exitCode"], 7, "退出码与改造前一致");
    assert_eq!(
        out["stdout"].as_str().unwrap().trim_end(),
        "stream-out-abc",
        "stdout 与改造前逐字节一致"
    );
    // stderr 断言用包含而非逐字节：Windows PowerShell 5.1 首启会在
    // stderr 混入 CLIXML 进度记录（"正在准备首次使用模块"），改造前后
    // 行为一致（wait_with_output 同样收集），非流式化回归
    assert!(
        out["stderr"].as_str().unwrap().contains("stream-err-xyz"),
        "stderr 必须包含预期输出：{}",
        out["stderr"].as_str().unwrap()
    );
    assert!(out["text"].as_str().unwrap().contains("stream-out-abc"));
    assert!(out["text"].as_str().unwrap().contains("(exit 7)"));
}

/// 任务卡验收：stdout 写 1MB 的命令 30s 内完成且输出完整
/// （流式读取解决 wait_with_output 收口下 64KB 管道写满阻塞）
#[tokio::test]
async fn shell_streaming_no_pipe_deadlock() {
    let ws = TempWorkspace::new("shell_stream_deadlock");
    let t = tool();
    let command = big_output_cmd('x', 1_048_576);
    let out = t
        .execute(
            &ctx(&ws),
            json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 1200000 }),
        )
        .await
        .unwrap();
    assert_eq!(
        out["timedOut"], false,
        "1MB 输出不得 30s 内超时（管道写满死锁）"
    );
    assert_eq!(out["truncated"], false);
    let stdout = out["stdout"].as_str().unwrap();
    assert_eq!(
        stdout.chars().filter(|c| *c == 'x').count(),
        1_048_576,
        "1MB 输出必须完整（流式读取持续消费）"
    );
    let duration = out["durationMs"].as_u64().unwrap();
    assert!(duration < 30_000, "30s 内完成，实际 {duration}ms");
}

// ===== T-AB-02：三模式 + trait 契约 =====

/// 记录式后台任务管理器（测试替身，参照 RunSubagentTool 测试的
/// RecordingSpawner 风格）：记录 adopt 请求标量字段并按序号应答
#[derive(Debug)]
struct RecordingBackgroundManager {
    adopts: Mutex<Vec<AdoptRecord>>,
    next_task_id: std::sync::atomic::AtomicUsize,
}

/// adopt 请求标量快照（Child 不可 Clone，只记录字段）
#[derive(Debug, Clone)]
struct AdoptRecord {
    command: String,
    cwd: PathBuf,
    is_daemon: bool,
    resource_monitor: bool,
    owner_run_id: Option<String>,
}

impl RecordingBackgroundManager {
    fn new() -> Self {
        Self {
            adopts: Mutex::new(Vec::new()),
            next_task_id: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn adopts(&self) -> usize {
        self.adopts.lock().unwrap().len()
    }

    fn adopts_requests(&self) -> Vec<AdoptRecord> {
        self.adopts.lock().unwrap().clone()
    }
}

#[async_trait]
impl BackgroundTaskManager for RecordingBackgroundManager {
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        let n = self
            .next_task_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let task_id = format!("task-{n}");
        self.adopts.lock().unwrap().push(AdoptRecord {
            command: req.command,
            cwd: req.cwd,
            is_daemon: req.is_daemon,
            resource_monitor: req.resource_monitor,
            owner_run_id: req.owner_run_id,
        });
        Ok(BackgroundTaskRef {
            task_id: task_id.clone(),
            log_path: PathBuf::from(format!("logs/tasks/{task_id}.log")),
        })
    }

    async fn list(&self, _include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        Ok(Vec::new())
    }

    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
        Err(ToolError::not_found(task_id))
    }

    async fn read_log(
        &self,
        task_id: &str,
        _start_line: Option<u64>,
        _max_lines: u64,
    ) -> Result<LogSlice, ToolError> {
        Err(ToolError::not_found(task_id))
    }

    async fn send_input(
        &self,
        _task_id: &str,
        _text: &str,
        _append_newline: bool,
    ) -> Result<(), ToolError> {
        Ok(())
    }

    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
        Err(ToolError::not_found(task_id))
    }
}

/// 任务卡验收：waitMsBeforeAsync 窗口内完成的命令——无 adopt 调用、
/// 返回同步结果（timedOut=false 且无 taskId）
#[tokio::test]
async fn background_window_completed_no_adopt() {
    let ws = TempWorkspace::new("bg_window_ok");
    let manager = Arc::new(RecordingBackgroundManager::new());
    let ctx = ToolContext {
        background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(&ws)
    };
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output fast-done"
    } else {
        "echo fast-done"
    };
    // 窗口取 60s：断言语义是「快速命令在窗口内完成」——窗口只须足够大，
    // 并行全量跑时 PowerShell 冷启动可能超过 5s（曾导致误转后台 flaky）
    let out = t
        .execute(
            &ctx,
            json!({ "command": command, "mode": "auto-background", "waitMsBeforeAsync": 60000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["mode"], "sync");
    assert!(out.get("taskId").is_none(), "窗口内完成不得产生 taskId");
    assert_eq!(manager.adopts(), 0, "窗口内完成不得调用 adopt");
    assert!(out["stdout"].as_str().unwrap().contains("fast-done"));
}

/// 任务卡验收：窗口超时的命令——adopt 恰好一次、参数含 command/cwd/
/// isDaemon 正确值、返回 taskId
#[tokio::test]
async fn background_window_expired_adopts_once() {
    let ws = TempWorkspace::new("bg_window_expire");
    ws.write_file("sub/.keep", "");
    let manager = Arc::new(RecordingBackgroundManager::new());
    let ctx = ToolContext {
        background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(&ws)
    };
    let t = tool();
    let out = t
        .execute(
            &ctx,
            json!({
                "command": sleep_cmd(3),
                "mode": "auto-background",
                "waitMsBeforeAsync": 300,
                "cwd": "sub",
                "resourceMonitor": true
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "background");
    let task_id = out["taskId"].as_str().unwrap().to_string();
    assert!(task_id.starts_with("task-"), "taskId 命名风格 task-<seq>");
    assert!(
        out["logPath"].as_str().unwrap().contains(&task_id),
        "logPath 应含 taskId"
    );
    assert!(
        out["text"]
            .as_str()
            .unwrap()
            .contains(&format!("task {task_id}")),
        "text 应提示任务 id"
    );
    // adopt 恰好一次，参数正确
    assert_eq!(manager.adopts(), 1, "adopt 必须恰好调用一次");
    let reqs = manager.adopts_requests();
    assert_eq!(reqs[0].cwd, ws.path().join("sub"), "adopt 参数 cwd 正确");
    assert!(!reqs[0].is_daemon, "auto-background 非 daemon");
    assert!(reqs[0].resource_monitor, "resourceMonitor 透传");
    assert_eq!(
        reqs[0].owner_run_id, None,
        "R-AB1 不携带 run 关联（R-AB3 接线）"
    );
    assert!(reqs[0].command.len() <= 64, "命令摘要前 64 字符");
}

/// 任务卡验收：background=None 时窗口超时仍走树杀
/// （回归 shell_timeout_kills_and_marks 语义）
#[tokio::test]
async fn background_none_keeps_tree_kill() {
    let ws = TempWorkspace::new("bg_none");
    let t = tool();
    let out = t
        .execute(
            &ctx(&ws),
            json!({ "command": sleep_cmd(10), "mode": "auto-background", "timeoutMs": 2000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["timedOut"], true, "未接线时超时仍走树杀");
    assert_eq!(out["mode"], "sync");
    assert!(out["stderr"].as_str().unwrap().contains("超时"));
}

/// 任务卡验收：模式 3（daemon）立即 adopt（不经过等待窗口，is_daemon=true）
#[tokio::test]
async fn daemon_mode_adopts_immediately() {
    let ws = TempWorkspace::new("bg_daemon");
    let manager = Arc::new(RecordingBackgroundManager::new());
    let ctx = ToolContext {
        background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(&ws)
    };
    let t = tool();
    let out = t
        .execute(&ctx, json!({ "command": sleep_cmd(3), "mode": "daemon" }))
        .await
        .unwrap();
    assert_eq!(out["mode"], "background");
    assert!(out["taskId"].as_str().is_some());
    assert_eq!(manager.adopts(), 1, "daemon 模式立即 adopt");
    assert!(manager.adopts_requests()[0].is_daemon, "is_daemon 必须置位");
}

/// 任务卡验收：kill_on_drop(false) 生效——spawn 后 drop 掉 Child 引用，
/// 进程仍存活（用 Start-Sleep 类命令断言 pid 存活）
// G2 禁令豁免：测试直接 spawn 探测 kill_on_drop 语义（非命令门禁执行面）
#[allow(clippy::disallowed_methods)]
#[tokio::test]
async fn kill_on_drop_false_child_survives_drop() {
    let (program, args, _) = build_shell_invocation(&sleep_cmd(10)).expect("invocation 构造失败");
    let mut child_cmd = TokioCommand::new(&program);
    child_cmd
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = child_cmd.spawn().expect("spawn 失败");
    let pid = child.id().expect("pid 缺失");
    drop(child);
    // 等 600ms 后进程应仍存活（kill_on_drop(false) 下 drop 不杀）
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        process_alive(pid),
        "kill_on_drop(false) 下 drop Child 不得杀进程"
    );
    // 清理：树杀（避免测试残留进程）
    let _ = terminate_process_tree(pid);
}

/// 进程存活探测（Windows tasklist / Unix /proc）
fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}

// ===== T-AB-03：输出防溢（PAGER / 截断落盘 / 高输出建议）=====

/// 任务卡验收：1MB 输出 → truncated=true、logPath 非空、文件为完整原始输出
#[tokio::test]
async fn shell_output_full_log_saved() {
    let ws = TempWorkspace::new("shell_spill");
    let t = tool();
    let ctx = ToolContext {
        log_root: Some(ws.path().join("logs")),
        ..ctx(&ws)
    };
    let command = big_output_cmd('y', 1_048_576);
    let out = t
        .execute(
            &ctx,
            json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 100000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["truncated"], true, "1MB 输出应判定截断");
    let log_path = out["logPath"]
        .as_str()
        .expect("截断应回填 logPath")
        .to_string();
    let file_bytes = std::fs::read(&log_path).expect("完整日志文件应存在");
    assert_eq!(
        file_bytes.iter().filter(|&&b| b == b'y').count(),
        1_048_576,
        "日志文件必须为完整原始输出"
    );
    let text = out["text"].as_str().unwrap();
    assert!(
        text.contains("输出已截断，完整日志保存在"),
        "text 尾部应追加完整日志指引"
    );
    assert!(text.contains("可通过文件读取工具查看完整内容"));
}

/// 任务卡验收：注入不可写 log_root——命令仍成功执行且 logPath 缺失
/// （不 panic 不失败，best-effort 降级）
#[tokio::test]
async fn shell_output_spill_failure_degrades() {
    let ws = TempWorkspace::new("shell_spill_fail");
    let t = tool();
    // log_root 指向「文件」而非目录 → create_dir_all 失败 → 降级无 logPath
    let file_path = ws.path().join("not-a-dir");
    std::fs::write(&file_path, "x").unwrap();
    let ctx = ToolContext {
        log_root: Some(file_path),
        ..ctx(&ws)
    };
    let command = big_output_cmd('z', 1_048_576);
    let out = t
        .execute(
            &ctx,
            json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 100000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["truncated"], true);
    assert!(
        out.get("logPath").is_none(),
        "写盘失败应无 logPath（不失败不 panic）"
    );
    assert_eq!(out["timedOut"], false, "命令仍成功执行");
}

/// 任务卡验收：spawn 的子进程环境含 PAGER=cat
#[tokio::test]
async fn shell_pager_env_set() {
    let ws = TempWorkspace::new("shell_pager");
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output $env:PAGER"
    } else {
        "echo $PAGER"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert!(
        out["stdout"].as_str().unwrap().contains("cat"),
        "子进程环境必须含 PAGER=cat"
    );
}

/// 高输出命令建议（纯函数）：git log 无 -n / git diff 无 --stat 命中，
/// 带限制参数不命中
#[test]
fn high_output_suggestion_forms() {
    assert!(high_output_suggestion("git log").is_some());
    assert!(high_output_suggestion("git log --oneline").is_none());
    assert!(high_output_suggestion("git log -n 5").is_none());
    assert!(high_output_suggestion("git log --max-count=10").is_none());
    assert!(high_output_suggestion("git diff").is_some());
    assert!(high_output_suggestion("git diff --stat").is_none());
    assert!(high_output_suggestion("git show").is_some());
    assert!(high_output_suggestion("git status").is_none());
    assert!(high_output_suggestion("npm test").is_none());
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

/// 任务卡验收：`git status` + cwd 参数正常执行（不被 cd 拦截误伤）
#[tokio::test]
async fn shell_git_status_with_cwd_executes() {
    let ws = TempWorkspace::new("shell_cd_cwd_ok");
    ws.write_file("sub/.keep", "");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "git status", "cwd": "sub" }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert!(
        out["exitCode"].is_number(),
        "git 应真实执行并产生退出码（临时目录非 git 仓库时 128）"
    );
}

/// 任务卡验收：`git -C` 形态不误拦（不依赖进程内目录状态的形态放行）
#[tokio::test]
async fn shell_git_dash_c_not_blocked() {
    let ws = TempWorkspace::new("shell_cd_gitc");
    ws.write_file("sub/.keep", "");
    let t = tool();
    let out = t
        .execute(&ctx(&ws), json!({ "command": "git -C sub status" }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert!(out["exitCode"].is_number(), "git -C 形态不得被 cd 拦截误伤");
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

/// mode 入参解析：未知值结构化报错，缺省 sync
#[test]
fn parse_mode_rejects_unknown_and_defaults_sync() {
    let err = parse_mode(&json!({ "mode": "async" })).unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("auto-background"));
    assert_eq!(parse_mode(&json!({})).unwrap(), ShellMode::Sync);
    assert_eq!(
        parse_mode(&json!({ "mode": "auto-background" })).unwrap(),
        ShellMode::AutoBackground
    );
    assert_eq!(
        parse_mode(&json!({ "mode": "daemon" })).unwrap(),
        ShellMode::Daemon
    );
}

// ===== S1：流式执行（TOOLS-01 §3.1.6，A3 交付）=====

/// 收集流式全部项直到 Terminal：返回 (Progress 序列, Terminal 结果)。
/// 断言流不变式：Terminal 恒为末项，其后不得再有项。
async fn collect_stream(
    stream: ToolStream,
) -> (Vec<ToolStreamItem>, Result<serde_json::Value, ToolError>) {
    use futures_util::StreamExt;
    let mut progress = Vec::new();
    let mut terminal = None;
    let mut stream = stream;
    while let Some(item) = stream.next().await {
        if item.is_terminal() {
            terminal = Some(item);
            break;
        }
        progress.push(item);
    }
    assert!(stream.next().await.is_none(), "Terminal 后不得再有项");
    match terminal {
        Some(ToolStreamItem::Terminal(r)) => (progress, r),
        _ => panic!("流必须产出恰好一个 Terminal"),
    }
}

/// 平台无关「分时多块输出」命令：每块输出后睡眠，保证管道内块不合并
/// （逐块到达断言的前提）
fn chunked_output_cmd() -> String {
    if cfg!(windows) {
        "1..3 | ForEach-Object { Write-Output \"chunk-$_\"; Start-Sleep -Milliseconds 200 }"
            .to_string()
    } else {
        "for i in 1 2 3; do echo chunk-$i; sleep 0.2; done".to_string()
    }
}

/// S1 验收（§3.1.8 流式输出逐块到达）：mock 进程分时输出多块——每块
/// 独立 ToolProgress::Text 到达（块间 200ms 间隔 + fill_buf 阻塞读，
/// 保证块不合并），全部 Progress 在 Terminal 前，Terminal stdout 为
/// 全量拼接
#[tokio::test]
async fn stream_yields_progress_chunks_then_terminal() {
    let ws = TempWorkspace::new("shell_stream_chunks");
    let t = tool();
    let ctx = ctx(&ws);
    let stream = t
        .execute_stream(&ctx, json!({ "command": chunked_output_cmd() }))
        .await;
    let (progress, terminal) = collect_stream(stream).await;
    let out = terminal.expect("流式执行不得失败");
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["exitCode"], 0);
    assert_eq!(out["truncated"], false);
    // 至少 2 块：块间 200ms 间隔 + 逐帧阻塞读，正常 3 块；极端负载
    // 下相邻块可能合并，2 块断言保留容错余量（拼接内容仍须完整）
    assert!(
        progress.len() >= 2,
        "多块输出应逐块到达（独立 Progress），实际 {} 块",
        progress.len()
    );
    let joined: String = progress
        .iter()
        .filter_map(|p| match p {
            ToolStreamItem::Progress(ToolProgress::Text { text }) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    for marker in ["chunk-1", "chunk-2", "chunk-3"] {
        assert!(joined.contains(marker), "进度拼接须含 {marker}：{joined:?}");
    }
    let stdout = out["stdout"].as_str().unwrap();
    assert_eq!(
        stdout.trim_end().lines().count(),
        3,
        "Terminal stdout 为全量拼接：{stdout:?}"
    );
}

/// S1 验收（§3.1.8 一致性回归）：同命令 execute / execute_stream 的
/// 聚合结果逐字节一致（stdout/stderr/text/exitCode/timedOut/truncated/
/// command/shell；durationMs 为执行时序差异，排除比较）
#[tokio::test]
async fn stream_terminal_matches_execute_bytewise() {
    let ws = TempWorkspace::new("shell_stream_parity");
    let t = tool();
    let ctx = ctx(&ws);
    let command = if cfg!(windows) {
        "Write-Output parity-out; [Console]::Error.WriteLine('parity-err'); exit 9"
    } else {
        "echo parity-out; echo parity-err >&2; exit 9"
    };
    let args = json!({ "command": command });
    let legacy = t.execute(&ctx, args.clone()).await.unwrap();
    let (_, terminal) = collect_stream(t.execute_stream(&ctx, args).await).await;
    let out = terminal.expect("流式执行不得失败");
    for key in [
        "command",
        "shell",
        "stdout",
        "stderr",
        "text",
        "exitCode",
        "timedOut",
        "truncated",
        "mode",
    ] {
        assert_eq!(out[key], legacy[key], "字段 {key} 须与 execute 一致");
    }
}

/// S1 验收（§3.1.6 累计预算）：maxOutputBytes 升级为累计流式字节预算——
/// 超限实时停止推送（已推字节 ≤ 预算），结果仍标记 truncated（头尾
/// 预览 + 截断标记，与 execute 一致）；管道持续排空（不超时不失败）
#[tokio::test]
async fn stream_budget_stops_progress_and_marks_truncation() {
    let ws = TempWorkspace::new("shell_stream_budget");
    let t = tool();
    let ctx = ToolContext {
        log_root: Some(ws.path().join("logs")),
        ..ctx(&ws)
    };
    let args = json!({ "command": big_output_cmd('q', 1_048_576), "timeoutMs": 30000, "maxOutputBytes": 2048 });
    let legacy = t.execute(&ctx, args.clone()).await.unwrap();
    assert_eq!(legacy["truncated"], true, "前置：execute 路径应判定截断");
    let (progress, terminal) = collect_stream(t.execute_stream(&ctx, args).await).await;
    let out = terminal.expect("流式执行不得失败");
    // 预算实时截断：已推字节 ≤ 预算（严格），超限后不再推送
    let pushed: usize = progress
        .iter()
        .map(|p| match p {
            ToolStreamItem::Progress(ToolProgress::Text { text }) => text.len(),
            _ => 0,
        })
        .sum();
    assert!(pushed <= 2048, "已推字节不得超过预算：{pushed}");
    // 截断标记 + 排空语义：结果截断、无超时、与 execute 逐字节一致
    assert_eq!(out["truncated"], true, "结果须标记 truncation");
    assert_eq!(
        out["timedOut"], false,
        "预算截断不得触发超时（管道持续排空）"
    );
    assert!(out["stdout"]
        .as_str()
        .unwrap()
        .contains("[output truncated"));
    for key in ["stdout", "stderr", "exitCode", "timedOut", "truncated"] {
        assert_eq!(out[key], legacy[key], "字段 {key} 须与 execute 一致");
    }
}

/// S1 验收（§3.1.8 abort）：执行前已 abort → 零 Progress，尽快收口为
/// Terminal（已聚合结果），流不悬挂
#[tokio::test]
async fn stream_abort_before_start_terminates_promptly() {
    let ws = TempWorkspace::new("shell_stream_abort_pre");
    let t = tool();
    let ctx = ctx(&ws);
    ctx.abort_token.abort();
    let stream = t
        .execute_stream(&ctx, json!({ "command": "echo never-seen" }))
        .await;
    let (progress, terminal) = collect_stream(stream).await;
    assert_eq!(progress.len(), 0, "执行前 abort 不得推任何 Progress");
    assert!(terminal.is_ok(), "abort 收口为 Terminal(Ok(已聚合结果))");
}

/// S1 验收（§3.1.8 abort）：流中途 abort → 停止推送（已发 Progress
/// 保留），杀进程尽快收口（3s 睡眠被中止，收口远快于自然结束），
/// 流不变式仍成立（Terminal 恒为末项）
#[tokio::test]
async fn stream_abort_mid_stream_stops_pushing() {
    let ws = TempWorkspace::new("shell_stream_abort_mid");
    let t = tool();
    let ctx = ctx(&ws);
    let command = if cfg!(windows) {
        "Write-Output first; Start-Sleep -Seconds 3"
    } else {
        "echo first; sleep 3"
    };
    let mut stream = t.execute_stream(&ctx, json!({ "command": command })).await;
    // 第一帧到达后 abort：首帧可能是 stdout「first」块，也可能是
    // PowerShell 首启混入的 CLIXML stderr 进度噪音（既有测试注释同述，
    // shell_streaming_preserves_sync_semantics）——不断言内容，只断言
    // 是 Progress；块后 3s 睡眠保证 abort 后下一帧必然命中中止检查
    let first = stream.next().await.expect("第一帧应到达");
    assert!(
        matches!(first, ToolStreamItem::Progress(_)),
        "第一帧应为 Progress"
    );
    ctx.abort_token.abort();
    let started = std::time::Instant::now();
    let next = stream.next().await;
    let elapsed = started.elapsed();
    // 3s 睡眠若未被中止，收口需等自然结束（≈3s）；杀进程收口远快于此
    assert!(
        elapsed.as_millis() < 2500,
        "中止后应杀进程尽快收口，实际 {elapsed:?}"
    );
    match next {
        Some(ToolStreamItem::Terminal(r)) => assert!(r.is_ok(), "收口 Terminal 为已聚合结果"),
        Some(_) => panic!("abort 后不得再推 Progress"),
        None => panic!("流必须收口为 Terminal（流不变式）"),
    }
}

/// S1 错误路径一致性：门禁拦截命令经 execute_stream → Terminal(Err)，
/// 与 execute 错误逐字节一致（无 Progress、恒为末项）
#[tokio::test]
async fn stream_blocked_command_error_terminal_matches_execute() {
    let ws = TempWorkspace::new("shell_stream_blocked");
    let t = tool();
    let ctx = ctx(&ws);
    let legacy = t
        .execute(&ctx, json!({ "command": "rm -rf /" }))
        .await
        .unwrap_err();
    let stream = t
        .execute_stream(&ctx, json!({ "command": "rm -rf /" }))
        .await;
    let (progress, terminal) = collect_stream(stream).await;
    assert_eq!(progress.len(), 0, "拦截路径不得产生 Progress");
    match terminal {
        Err(e) => {
            assert_eq!(e.code(), TOOL_COMMAND_BLOCKED);
            assert_eq!(e.to_string(), legacy.to_string(), "错误文案与 execute 一致");
        }
        Ok(_) => panic!("红线命令必须拦截"),
    }
}

/// S1 重定向一致性：删除形态经 execute_stream → 重定向结果与 execute
/// 结构一致（entryId 为时间戳、两调用产物不同，只比稳定字段；
/// 两次调用各用一个目标文件——首次调用已把目标移入回收站）
#[tokio::test]
async fn stream_delete_redirect_matches_execute() {
    let ws = TempWorkspace::new("shell_stream_redirect");
    ws.write_file("tmp/a.txt", "stream");
    ws.write_file("tmp/b.txt", "stream");
    let trash = TempWorkspace::new("shell_stream_redirect_trash");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash.path().clone()));
    let ctx = ctx(&ws);
    let legacy = t
        .execute(&ctx, json!({ "command": "rm -rf ./tmp/a.txt" }))
        .await
        .unwrap();
    let stream = t
        .execute_stream(&ctx, json!({ "command": "rm -rf ./tmp/b.txt" }))
        .await;
    let (_, terminal) = collect_stream(stream).await;
    let out = terminal.expect("重定向不得失败");
    assert_eq!(out["redirected"], legacy["redirected"]);
    assert_eq!(out["redirect"]["kind"], legacy["redirect"]["kind"]);
    assert_eq!(out["redirect"]["reason"], legacy["redirect"]["reason"]);
    assert_eq!(out["trashEntries"].as_array().unwrap().len(), 1);
    assert_eq!(out["impact"], legacy["impact"]);
    assert!(out["text"].as_str().unwrap().contains("trash_restore"));
}

/// S1 兼容面：非 sync 模式（auto-background）回落既有 execute——结果
/// 与 execute 逐字节一致（窗口内完成，无 taskId）
#[tokio::test]
async fn stream_non_sync_mode_falls_back_to_execute() {
    let ws = TempWorkspace::new("shell_stream_fallback");
    let t = tool();
    let ctx = ctx(&ws);
    let args = json!({
        "command": if cfg!(windows) { "Write-Output fallback-ok" } else { "echo fallback-ok" },
        "mode": "auto-background",
        "waitMsBeforeAsync": 60000,
    });
    let legacy = t.execute(&ctx, args.clone()).await.unwrap();
    assert_eq!(legacy["timedOut"], false);
    let (_, terminal) = collect_stream(t.execute_stream(&ctx, args).await).await;
    let out = terminal.expect("回落路径不得失败");
    for key in ["stdout", "exitCode", "timedOut", "mode", "text"] {
        assert_eq!(
            out[key], legacy[key],
            "回落路径字段 {key} 须与 execute 一致"
        );
    }
    assert!(out.get("taskId").is_none(), "窗口内完成不得产生 taskId");
}

/// F3-16：maxOutputBytes u64→usize 钳制——32 位平台裸 `as usize` 截断
/// 失真防护（win32 x64 平台截断不可复现，恒等路径；32 位分支编译期
/// 锁定：4GiB+1 不得截断为 1，钳到 usize::MAX）
#[test]
fn max_output_bytes_clamped_to_usize_range() {
    assert_eq!(clamp_u64_to_usize(0), 0);
    assert_eq!(clamp_u64_to_usize(123), 123);
    assert_eq!(clamp_u64_to_usize(u64::MAX), usize::MAX);
    #[cfg(target_pointer_width = "32")]
    {
        assert_eq!(
            clamp_u64_to_usize(0x1_0000_0000),
            usize::MAX,
            "32 位：4GiB+1 必须钳到 usize::MAX（裸截断为 1 会静默截断输出）"
        );
        assert_ne!(clamp_u64_to_usize(0x1_0000_0000), 1);
    }
}

/// DIM-04: Plan 模式禁止任何 Shell 命令执行
#[tokio::test]
async fn plan_mode_blocks_shell_execution() {
    let ws = TempWorkspace::new("shell_plan_mode");
    let t = tool();
    let ctx = ToolContext {
        permission_mode: crate::permission::PermissionMode::Plan,
        ..ctx(&ws)
    };
    let err = t
        .execute(&ctx, json!({ "command": "echo test" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(err.to_string().contains("Plan (Read-Only)"));
}

/// DIM-04: FullAccess 模式直接放行复合删除与间接删除
#[tokio::test]
async fn full_access_mode_allows_compound_and_indirect_delete() {
    let ws = TempWorkspace::new("shell_full_access");
    ws.write_file("temp.txt", "will delete");
    let t = tool();
    let ctx = ToolContext {
        permission_mode: crate::permission::PermissionMode::FullAccess,
        ..ctx(&ws)
    };
    let cmd = if cfg!(windows) {
        "cmd /c del temp.txt"
    } else {
        "rm temp.txt"
    };
    let res = t.execute(&ctx, json!({ "command": cmd })).await;
    assert!(res.is_ok(), "FullAccess 模式下应直接放行删除命令");
    assert!(!ws.path().join("temp.txt").exists());
}

/// DIM-04: 输出超限溢出落盘测试
#[tokio::test]
async fn shell_output_spills_to_log_root_when_truncated() {
    let ws = TempWorkspace::new("shell_spill_ws");
    let log_ws = TempWorkspace::new("shell_log_ws");
    let t = tool();
    let ctx = ToolContext {
        log_root: Some(log_ws.path().clone()),
        session_id: "test-sess-spill".to_string(),
        ..ctx(&ws)
    };
    let cmd = if cfg!(windows) {
        "Write-Output '1234567890abcdefghijklmnopqrstuvwxyz'"
    } else {
        "echo '1234567890abcdefghijklmnopqrstuvwxyz'"
    };
    let res = t
        .execute(
            &ctx,
            json!({
                "command": cmd,
                "maxOutputBytes": 10
            }),
        )
        .await
        .unwrap();

    assert_eq!(res["truncated"], true);
    assert!(res.get("logPath").is_some());
    let log_path_str = res["logPath"].as_str().unwrap();
    let log_path = std::path::PathBuf::from(log_path_str);
    assert!(log_path.exists(), "溢出日志文件应已落盘");
}
