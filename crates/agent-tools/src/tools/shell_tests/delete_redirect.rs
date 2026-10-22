use super::super::*;
use super::{ctx, tool};
use crate::context::ToolContext;
use conex_fs::trash::TrashService;
use conex_test_utils::TempWorkspace;
use serde_json::json;
use std::sync::Arc;

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

/// BC10-7: 彻底拔除 FullAccess 特权后，间接删除在 FullAccess 模式下必须被拦截（严禁物理抹除）
#[tokio::test]
async fn full_access_mode_blocks_compound_and_indirect_delete() {
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
        "bash -c 'rm temp.txt'"
    };
    let res = t.execute(&ctx, json!({ "command": cmd })).await;
    let err = res.expect_err("BC10-7: FullAccess 模式下间接删除必须被拦截，不可逃逸");
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(
        ws.path().join("temp.txt").exists(),
        "被拦截命令不应在原工作区产生物理抹除"
    );
}

// ===== BC10-7: FullAccess 模式删除形态重定向与间接删除拦截测试 =====

#[tokio::test]
async fn full_access_mode_redirects_delete_to_trash_wal() {
    let ws = TempWorkspace::new("shell_full_access_trash");
    ws.write_file("data_to_trash.txt", "critical data");
    let trash_ws = TempWorkspace::new("shell_trash_store");
    let t = ShellCommandTool::new(30_000, 200_000, Some(trash_ws.path().clone()));
    let ctx = ToolContext {
        permission_mode: crate::permission::PermissionMode::FullAccess,
        ..ctx(&ws)
    };

    let cmd = if cfg!(windows) {
        "del data_to_trash.txt"
    } else {
        "rm data_to_trash.txt"
    };

    let res = t.execute(&ctx, json!({ "command": cmd })).await;
    assert!(
        res.is_ok(),
        "FullAccess 模式下删除命令应重定向成功返回: {:?}",
        res
    );

    assert!(
        !ws.path().join("data_to_trash.txt").exists(),
        "原文件应已不在工作区"
    );

    // 检查回收站存储目录非空（已记录 WAL 与快照）
    let entries = std::fs::read_dir(trash_ws.path())
        .unwrap()
        .collect::<Vec<_>>();
    assert!(
        !entries.is_empty(),
        "回收站根目录应包含删除重定向写入的 WAL/数据条目"
    );
}

#[tokio::test]
async fn full_access_mode_blocks_indirect_delete() {
    let ws = TempWorkspace::new("shell_full_access_indirect");
    ws.write_file("data.txt", "content");
    let t = tool();
    let ctx = ToolContext {
        permission_mode: crate::permission::PermissionMode::FullAccess,
        ..ctx(&ws)
    };

    // 间接删除（bash -c "rm ..."）在 FullAccess 模式下严禁被直接放行物理抹除
    let cmd = "bash -c 'rm data.txt'";
    let res = t.execute(&ctx, json!({ "command": cmd })).await;
    let err = res.expect_err("间接删除在 FullAccess 模式下必须被拦截，严禁特权逃逸");
    assert_eq!(err.code(), TOOL_COMMAND_BLOCKED);
    assert!(err.to_string().contains("间接执行包裹"));
}
