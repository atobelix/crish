//! wait_subagents 测试 · 事件驱动等待原语（自 wait_subagents_tests.rs 纯搬迁）

use super::*;

// ── 事件驱动等待原语 ──────────────────────────────────────────

fn terminal_event(id: &str, state: SubagentState, ended_at_ms: u64) -> SubagentTerminalEvent {
    SubagentTerminalEvent {
        subagent_id: id.to_string(),
        status: state,
        summary: Some(format!("{id} 完成")),
        ended_at_ms,
    }
}

#[tokio::test]
async fn primitive_waits_all_terminal_via_events() {
    let (tx, rx) = mpsc::channel(8);
    tx.send(terminal_event("sub-2", SubagentState::Completed, 2_000))
        .await
        .unwrap();
    tx.send(terminal_event("sub-1", SubagentState::Failed, 1_000))
        .await
        .unwrap();
    drop(tx);
    let result = wait_for_terminal_events(
        &["sub-1".to_string(), "sub-2".to_string()],
        rx,
        Some(Duration::from_secs(5)),
        0,
    )
    .await;
    assert!(result.all_terminal, "全部终态事件到达 → all_terminal");
    assert!(!result.timed_out);
    assert_eq!(result.agents[0].status, SubagentState::Failed);
    assert_eq!(
        result.agents[0].elapsed_ms, 1_000,
        "elapsed = ended - dispatched"
    );
    assert_eq!(result.agents[1].status, SubagentState::Completed);
    assert_eq!(result.agents[1].summary.as_deref(), Some("sub-2 完成"));
}

#[tokio::test]
async fn primitive_times_out_returning_incomplete() {
    let (tx, rx) = mpsc::channel(8);
    tx.send(terminal_event("sub-1", SubagentState::Completed, 500))
        .await
        .unwrap();
    // 不发送 sub-2 终态：到点返回
    let result = wait_for_terminal_events(
        &["sub-1".to_string(), "sub-2".to_string()],
        rx,
        Some(Duration::from_millis(60)),
        0,
    )
    .await;
    assert!(!result.all_terminal);
    assert!(result.timed_out, "timer 到点返回");
    assert_eq!(result.agents[0].status, SubagentState::Completed);
    assert_eq!(
        result.agents[1].status,
        SubagentState::Running,
        "未完成保持 running"
    );
    assert!(!result.agents[1].terminal);
    drop(tx);
}

#[tokio::test]
async fn primitive_no_timeout_waits_until_stream_closed_or_all_terminal() {
    let (tx, rx) = mpsc::channel(8);
    tx.send(terminal_event("sub-1", SubagentState::Completed, 100))
        .await
        .unwrap();
    drop(tx);
    // 无超时 + 流关闭：返回当前态（fail-open 不 panic）
    let result =
        wait_for_terminal_events(&["sub-1".to_string(), "sub-2".to_string()], rx, None, 0).await;
    assert!(!result.all_terminal);
    assert!(!result.timed_out);
    assert_eq!(result.agents[1].status, SubagentState::Running);
}

#[tokio::test]
async fn primitive_ignores_duplicates_and_unknown_ids() {
    let (tx, rx) = mpsc::channel(8);
    // 重复终态事件（幂等）+ 非等待名单子代理终态（并发其它子代理）
    tx.send(terminal_event("sub-1", SubagentState::Completed, 100))
        .await
        .unwrap();
    tx.send(terminal_event("sub-1", SubagentState::Completed, 200))
        .await
        .unwrap();
    tx.send(terminal_event("sub-9", SubagentState::Completed, 300))
        .await
        .unwrap();
    tx.send(terminal_event("sub-2", SubagentState::Failed, 400))
        .await
        .unwrap();
    let result = wait_for_terminal_events(
        &["sub-1".to_string(), "sub-2".to_string()],
        rx,
        Some(Duration::from_secs(5)),
        0,
    )
    .await;
    assert!(result.all_terminal);
    assert_eq!(
        result.agents[0].elapsed_ms, 100,
        "首条终态事件生效，重复事件不覆盖"
    );
}

#[tokio::test]
async fn primitive_empty_ids_returns_immediately() {
    let (_tx, rx) = mpsc::channel(8);
    let result = wait_for_terminal_events(&[], rx, None, 0).await;
    assert!(result.all_terminal);
    assert!(result.agents.is_empty());
}

#[tokio::test]
async fn channel_level_event_driven_wait() {
    // 通道级联测：EventStreamChannel（引擎侧实现同构）经 mpsc 对接原语
    let (tx, rx) = mpsc::channel(8);
    let channel = EventStreamChannel {
        rx: Mutex::new(Some(rx)),
        dispatched_at_ms: 1_000,
    };
    let tool = WaitSubagentsTool::with_channel(Some(Arc::new(channel)));
    let ctx = create_mock_tool_context();
    let wait_task = tool.execute(
        &ctx,
        serde_json::json!({ "subagentIds": ["sub-1"], "mode": "timer", "timeoutMs": 60_000 }),
    );
    // 等待期间注入终态事件（subagent-ended 消费点）
    tx.send(terminal_event("sub-1", SubagentState::Completed, 2_000))
        .await
        .unwrap();
    drop(tx);
    let out = wait_task.await.unwrap();
    assert_eq!(out["allTerminal"], true);
    assert_eq!(out["agents"][0]["status"], "completed");
    assert_eq!(
        out["agents"][0]["elapsedMs"], 1_000,
        "elapsed = ended(2000) - dispatched(1000)"
    );
}
