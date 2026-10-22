use super::super::*;
use super::{ctx, tool, MockAskChannel};
use crate::context::ToolContext;
use conex_test_utils::TempWorkspace;
use serde_json::json;
use std::sync::Arc;

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

// ===== BC10-6: 任务类型命令白名单拦截测试 =====

#[tokio::test]
async fn task_type_commit_strictly_enforces_git_only() {
    let ws = TempWorkspace::new("shell_task_type_commit");
    let t = tool();
    let ctx = ToolContext {
        task_type: Some("commit".to_string()),
        permission_mode: crate::permission::PermissionMode::FullAccess,
        ..ctx(&ws)
    };

    // 允许的 git 命令通过 prepare 前置门禁
    let allowed = [
        "git status",
        "git diff",
        "git add .",
        "git commit -m 'test'",
    ];
    for cmd in allowed {
        let res = t.prepare(&ctx, &json!({ "command": cmd })).await;
        match res {
            Prepared::Done(Err(e)) => panic!(
                "git 命令 [{}] 必须通过 task_type 门禁，但被拦截: {:?}",
                cmd, e
            ),
            _ => {}
        }
    }

    // 阻断的非 git 命令必须直接在 prepare 阶段被拦截
    let blocked = [
        "npm test",
        "cargo test",
        "echo hello",
        "del file.txt",
        "rm file.txt",
    ];
    for cmd in blocked {
        let res = t.prepare(&ctx, &json!({ "command": cmd })).await;
        match res {
            Prepared::Done(Err(e)) => {
                assert_eq!(
                    e.code(),
                    TOOL_COMMAND_BLOCKED,
                    "非 git 命令 [{}] 必须被 task_type 门禁拦截",
                    cmd
                );
                assert!(
                    e.to_string().contains("commit"),
                    "错误信息须包含 commit 任务类型"
                );
            }
            _ => panic!("非 git 命令 [{}] 必须被拦截，却通过了 prepare", cmd),
        }
    }
}
