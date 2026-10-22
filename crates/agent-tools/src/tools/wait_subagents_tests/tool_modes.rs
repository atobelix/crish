//! wait_subagents 测试 · 模式 wire 解析、工具入参解析与三模式行为（自 wait_subagents_tests.rs 纯搬迁）

use super::*;

// ── 模式 wire 解析 ────────────────────────────────────────────

#[test]
fn wait_mode_wire_roundtrip() {
    for (wire, mode) in [
        ("await-all", WaitMode::AwaitAll),
        ("timer", WaitMode::Timer),
        ("parallel-work", WaitMode::ParallelWork),
    ] {
        assert_eq!(WaitMode::parse(wire), Some(mode));
        assert_eq!(mode.as_str(), wire);
    }
    assert_eq!(WaitMode::parse("await_all"), None);
    assert_eq!(WaitMode::parse("unknown"), None);
}

#[test]
fn hard_cap_and_timer_default_constants() {
    // 02 §5.4：timeout 硬上限 10 分钟（对齐 grok cap）
    assert_eq!(MAX_WAIT_TIMEOUT_MS, 600_000);
    // 04 C8 §2.1：timer 默认 30s
    assert_eq!(DEFAULT_TIMER_WAIT_MS, 30_000);
}

// ── 工具入参解析 ──────────────────────────────────────────────

#[tokio::test]
async fn tool_requires_subagent_ids() {
    let channel = Arc::new(RecordingWaitChannel::new(
        Vec::new(),
        SubagentWaitResult {
            mode: WaitMode::AwaitAll,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool.execute(&ctx, serde_json::json!({})).await.unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": [] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1", ""] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(channel.persists().is_empty(), "入参非法不得持久化声明");
}

#[tokio::test]
async fn tool_rejects_unknown_mode() {
    let channel = Arc::new(RecordingWaitChannel::new(
        Vec::new(),
        SubagentWaitResult {
            mode: WaitMode::AwaitAll,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "mode": "wait-forever" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知等待模式"));
    assert!(channel.persists().is_empty());
}

#[tokio::test]
async fn tool_rejects_timeout_over_hard_cap() {
    let channel = Arc::new(RecordingWaitChannel::new(
        Vec::new(),
        SubagentWaitResult {
            mode: WaitMode::AwaitAll,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "timeoutMs": 600_001 }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("10 分钟"));
    // 恰在上限内（600_000）不拒绝
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "timeoutMs": 600_000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "await-all");
}

// ── 三模式行为 ────────────────────────────────────────────────

#[tokio::test]
async fn parallel_work_returns_immediately_with_snapshot() {
    let snap = vec![status("sub-1", SubagentState::Running, 1_000)];
    let channel = Arc::new(RecordingWaitChannel::new(
        snap,
        SubagentWaitResult {
            mode: WaitMode::ParallelWork,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "subagentIds": ["sub-1"],
                "mode": "parallel-work",
                "timeoutMs": 300_000
            }),
        )
        .await
        .unwrap();
    // 立即返回：快照非终态 → allTerminal=false、未走 wait_for_terminal
    assert_eq!(out["mode"], "parallel-work");
    assert_eq!(out["allTerminal"], false);
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["agents"][0]["subagentId"], "sub-1");
    assert_eq!(out["agents"][0]["status"], "running");
    assert_eq!(out["agents"][0]["terminal"], false);
    assert!(channel.waits().is_empty(), "parallel-work 不得走阻塞等待");
    // 声明已持久化（模式 + 已分发清单）
    let persists = channel.persists();
    assert_eq!(persists.len(), 1);
    assert_eq!(persists[0].mode, WaitMode::ParallelWork);
    assert_eq!(persists[0].subagent_ids, vec!["sub-1"]);
}

#[tokio::test]
async fn await_all_waits_all_terminal_before_returning() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![
            status("sub-1", SubagentState::Completed, 12_000),
            status("sub-2", SubagentState::Failed, 8_000),
        ],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1", "sub-2"] }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "await-all", "缺省模式 = await-all");
    assert_eq!(out["allTerminal"], true);
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["agents"][0]["status"], "completed");
    assert_eq!(out["agents"][1]["status"], "failed");
    assert_eq!(out["agents"][0]["elapsedMs"], 12_000);
    let waits = channel.waits();
    assert_eq!(waits.len(), 1);
    assert_eq!(waits[0].0, vec!["sub-1", "sub-2"]);
    assert_eq!(waits[0].1, None, "await-all 缺省不限时");
    // 声明含 wait_ms=None
    assert_eq!(channel.persists()[0].wait_ms, None);
}

#[tokio::test]
async fn timer_returns_incomplete_list_at_timeout() {
    let timed_out = SubagentWaitResult {
        mode: WaitMode::Timer,
        all_terminal: false,
        timed_out: true,
        agents: vec![
            status("sub-1", SubagentState::Completed, 5_000),
            status("sub-2", SubagentState::Running, 30_000),
        ],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), timed_out));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    // 缺省 timeoutMs → 默认 30s（dispatch_wait_ms）
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1", "sub-2"], "mode": "timer" }),
        )
        .await
        .unwrap();
    assert_eq!(out["timedOut"], true);
    assert_eq!(out["allTerminal"], false);
    assert_eq!(
        out["agents"][1]["status"], "running",
        "未完成 run 保持 running"
    );
    let waits = channel.waits();
    assert_eq!(waits[0].1, Some(30_000), "timer 缺省等待窗 30s");
    assert_eq!(channel.persists()[0].wait_ms, Some(30_000));
    // 显式 timeoutMs 生效
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "subagentIds": ["sub-1", "sub-2"],
                "mode": "timer",
                "timeoutMs": 120_000
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "timer");
    assert_eq!(channel.waits()[1].1, Some(120_000));
}

#[tokio::test]
async fn timeout_zero_is_non_blocking_snapshot() {
    // 02 Top 7：省略 timeout 或 0 = 非阻塞快照
    let snap = vec![status("sub-1", SubagentState::Completed, 9_000)];
    let channel = Arc::new(RecordingWaitChannel::new(
        snap,
        SubagentWaitResult {
            mode: WaitMode::Timer,
            all_terminal: true,
            timed_out: false,
            agents: Vec::new(),
        },
    ));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentIds": ["sub-1"], "mode": "timer", "timeoutMs": 0 }),
        )
        .await
        .unwrap();
    assert_eq!(out["agents"][0]["status"], "completed");
    assert!(channel.waits().is_empty(), "timeoutMs=0 不得阻塞等待");
}

#[tokio::test]
async fn inject_routed_to_channel_during_wait() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: vec![status("sub-1", SubagentState::Completed, 1_000)],
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "subagentIds": ["sub-1"],
                "inject": { "subagentId": "sub-1", "prompt": "调整方向：优先低风险改动" }
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["allTerminal"], true);
    let injects = channel.injects();
    assert_eq!(injects.len(), 1, "等待期间注入一次");
    assert_eq!(injects[0].0, "sub-1");
    assert_eq!(injects[0].1, "调整方向：优先低风险改动");
    // 注入先于等待
    assert!(!channel.persists().is_empty());
}

#[tokio::test]
async fn tool_without_channel_returns_structured_unavailable() {
    let tool = WaitSubagentsTool::new();
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentIds": ["sub-1"] }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "common.unsupported");
    assert!(err.to_string().contains("未接线"));
}

#[tokio::test]
async fn inject_malformed_args_rejected() {
    let done = SubagentWaitResult {
        mode: WaitMode::AwaitAll,
        all_terminal: true,
        timed_out: false,
        agents: Vec::new(),
    };
    let channel = Arc::new(RecordingWaitChannel::new(Vec::new(), done));
    let tool = WaitSubagentsTool::with_channel(Some(channel.clone()));
    let ctx = create_mock_tool_context();
    for bad in [
        serde_json::json!({ "subagentIds": ["sub-1"], "inject": "x" }),
        serde_json::json!({ "subagentIds": ["sub-1"], "inject": { "prompt": "p" } }),
        serde_json::json!({ "subagentIds": ["sub-1"], "inject": { "subagentId": "s" } }),
    ] {
        let err = tool.execute(&ctx, bad).await.unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");
    }
    assert!(channel.persists().is_empty());
}
