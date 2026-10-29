//! wait_subagents 测试 · 产出文件收集与完成信封（G02，T-EG-10；自 wait_subagents_tests.rs 纯搬迁）

use super::*;

// ── 产出文件（G02 完成通知字段，T-EG-10）──────────────────────

/// 从 write_claims 持有者记录收集产出文件：写模式声明命中、目录声明
/// 展开为直接子文件（不递归）、其他持有者与删除模式声明排除、
/// 摘要取子代理最终消息摘要、字节数为实际文件大小、路径为工作区相对
#[test]
fn output_files_collected_from_write_claims() {
    let ws = TempWorkspace::new("output_files_collect");
    let root = ws.path();
    std::fs::write(root.join("01-kernel-analysis.md"), "# 内核分析\n正文").unwrap();
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("docs/02-frontend.md"), "# 前端分析").unwrap();
    std::fs::create_dir_all(root.join("docs/nested")).unwrap();
    std::fs::write(root.join("docs/nested/03-inner.md"), "嵌套子目录").unwrap();
    std::fs::write(root.join("99-delete-mode.md"), "删除模式声明").unwrap();
    std::fs::write(root.join("04-other-holder.md"), "其他持有者").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    // 子代理 sub-1：单文件声明 + 目录级声明（产出目录语义）
    let _a = registry
        .claim_one("sub-1", "01-kernel-analysis.md", ClaimMode::Write)
        .unwrap();
    let _b = registry
        .claim_one("sub-1", "docs", ClaimMode::Write)
        .unwrap();
    // 其他持有者 / 删除模式声明 → 不得混入产出清单
    let _c = registry
        .claim_one("sub-2", "04-other-holder.md", ClaimMode::Write)
        .unwrap();
    let _d = registry
        .claim_one("sub-3", "99-delete-mode.md", ClaimMode::Delete)
        .unwrap();

    let files = collect_subagent_output_files(Some(&registry), "sub-1", root, Some("sub-1 完成"));
    let paths = files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>();
    assert_eq!(
        paths,
        ["01-kernel-analysis.md", "docs/02-frontend.md"],
        "目录声明展开为直接子文件，嵌套子目录与越权持有者/删除模式不产出"
    );
    // 字节数为实际文件大小
    assert_eq!(files[0].bytes, "# 内核分析\n正文".len() as u64);
    assert_eq!(files[1].bytes, "# 前端分析".len() as u64);
    // 摘要取子代理最终消息摘要（同一子代理全部产出共享）
    assert_eq!(files[0].summary, "sub-1 完成");
    assert_eq!(files[1].summary, "sub-1 完成");
}

/// 无最终消息摘要时摘要回退文件首行概述（§4.6）；空文件 → 空摘要
#[test]
fn output_files_summary_falls_back_to_first_line() {
    let ws = TempWorkspace::new("output_files_summary");
    let root = ws.path();
    std::fs::write(root.join("a.md"), "# 标题\n\n正文第二行").unwrap();
    std::fs::write(root.join("empty.md"), "").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    let _a = registry
        .claim_one("sub-1", "a.md", ClaimMode::Write)
        .unwrap();
    let _b = registry
        .claim_one("sub-1", "empty.md", ClaimMode::Write)
        .unwrap();

    let files = collect_subagent_output_files(Some(&registry), "sub-1", root, None);
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].summary, "# 标题", "首行概述（跳过空行）");
    assert_eq!(files[1].summary, "", "空文件无首行可概述");
}

/// 声明路径已被删除 → 不产出（运行期删除的中间文件不进完成通知）
#[test]
fn output_files_skip_deleted_paths() {
    let ws = TempWorkspace::new("output_files_deleted");
    let root = ws.path();
    std::fs::write(root.join("gone.md"), "已删除").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    let _a = registry
        .claim_one("sub-1", "gone.md", ClaimMode::Write)
        .unwrap();
    std::fs::remove_file(root.join("gone.md")).unwrap();
    let files = collect_subagent_output_files(Some(&registry), "sub-1", root, None);
    assert!(files.is_empty(), "删除后的路径不得出现在产出清单");
}

/// 注册表未接线（None）→ 空清单（fail-open，不报错）
#[test]
fn output_files_unwired_registry_returns_empty() {
    assert!(collect_subagent_output_files(None, "sub-1", Path::new("."), None).is_empty());
}

/// await-all 终态载荷附带 outputFiles（path/summary/bytes），且产出
/// 清单随 dispatch_* 持久化（persist_outputs 调用，G02 完成通知字段）
#[tokio::test]
async fn await_all_envelope_carries_output_files() {
    let ws = TempWorkspace::new("wait_output_files");
    let root = ws.path();
    std::fs::write(root.join("01-kernel-analysis.md"), "KERNEL_BODY").unwrap();
    let registry = Arc::new(WritePathRegistry::new("s1", root));
    let _guard = registry
        .claim_one("sub-1", "01-kernel-analysis.md", ClaimMode::Write)
        .unwrap();
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![SubagentWaitStatus {
            subagent_id: "sub-1".to_string(),
            status: SubagentState::Completed,
            summary: Some("内核分析完成".to_string()),
            elapsed_ms: 12_000,
            terminal: true,
        }],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let mut ctx = ToolContext::new("s1", root.to_path_buf());
    ctx.write_claims = Some(Arc::clone(&registry));

    let out = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1"] }))
        .await
        .unwrap();
    // 结构与内容断言：路径相对化、摘要取最终消息、字节数为实际大小
    let files = out["agents"][0]["outputFiles"]
        .as_array()
        .expect("outputFiles 必须是数组");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "01-kernel-analysis.md");
    assert_eq!(files[0]["summary"], "内核分析完成");
    assert_eq!(files[0]["bytes"], 11, "KERNEL_BODY 共 11 字节");
    // 产出清单已随 dispatch 持久化（dispatch_outputs 键承载）
    let output_persists = channel.output_persists();
    assert_eq!(output_persists.len(), 1);
    assert_eq!(output_persists[0]["sub-1"].len(), 1);
    assert_eq!(output_persists[0]["sub-1"][0].path, "01-kernel-analysis.md");
}

/// 未接线 write_claims（None）→ 载荷输出空数组，等待主流程不受影响
#[tokio::test]
async fn await_all_envelope_output_files_empty_when_unwired() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![status("sub-1", SubagentState::Completed, 12_000)],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1"] }))
        .await
        .unwrap();
    assert_eq!(out["agents"][0]["outputFiles"].as_array().unwrap().len(), 0);
    assert!(channel.output_persists().is_empty(), "无产出不得触发持久化");
}
