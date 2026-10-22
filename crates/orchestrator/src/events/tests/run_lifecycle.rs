use super::*;

// ── run 生命周期（drive 集成）──

#[tokio::test]
async fn full_lifecycle_queued_to_completed() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_main").await.unwrap();
    assert_eq!(run.status, conex_db::RunStatus::Running);
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(run.status, conex_db::RunStatus::Completed);
    assert_eq!(run.end_reason.as_deref(), Some("stop"));
    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert!(result.persist_failure.is_none());
    assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Completed);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("stop"));
    // T08.4：终态游标 = 该 run 最后事件 sequence（agent-start=1，
    // agent-end=2，run-terminal=3）
    assert_eq!(mem.runs()[0].cursor, 3, "终态 cursor 落库（T08.4）");
}

#[tokio::test]
async fn approval_flow_pauses_and_resumes_then_completes() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_approval").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    // 审批挂起：awaiting-approval 中间态（05 §5.4 run::approval）
    run.request_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, conex_db::RunStatus::AwaitingApproval);
    assert_eq!(mem.runs()[0].status, conex_db::RunStatus::AwaitingApproval);

    // 批准恢复：回 running → completed
    run.resolve_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, conex_db::RunStatus::Running);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert_eq!(run.status, conex_db::RunStatus::Completed);
}

#[tokio::test]
async fn l2_cooperative_cancel_does_not_hard_abort() {
    let (mem, store) = setup();
    let engine = TestEngine::new(true);
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_coop").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let path = run
        .cancel_run(
            CancelMode::Cooperative,
            Some(&engine),
            "cancelled-by-user",
            store.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(path, CancelPath::Cooperative);
    // L2：协作停止注入，不 hard abort（05 §2.8 orchestrator.test.ts:1113）
    assert_eq!(engine.abort_calls(), Vec::<String>::new());
    assert_eq!(
        engine.cooperative_calls(),
        vec!["cancelled-by-user".to_string()]
    );
    assert!(run.cancel_requested());
    assert_eq!(run.cancel_path(), Some(CancelPath::Cooperative));

    // 安全点收场（stopped）→ run 以 cancelled 收尾（end_reason=aborted）
    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stopped,
            vec![agent_start(), agent_end(AgentEndReason::Stopped)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(run.status, conex_db::RunStatus::Cancelled);
    assert_eq!(run.end_reason.as_deref(), Some("aborted"));
    assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Cancelled);
}

#[tokio::test]
async fn l3_force_cancel_hard_aborts() {
    let (_mem, store) = setup();
    let engine = TestEngine::new(true);
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_force").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let path = run
        .cancel_run(CancelMode::Force, Some(&engine), "ui-force", store.as_ref())
        .await
        .unwrap();
    assert_eq!(path, CancelPath::Force);
    // L3：hard abort，无协作停止
    assert_eq!(engine.abort_calls(), vec!["ui-force".to_string()]);
    assert_eq!(engine.cooperative_calls(), Vec::<String>::new());
    assert_eq!(run.cancel_path(), Some(CancelPath::Force));

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Aborted,
            vec![agent_start(), agent_end(AgentEndReason::Aborted)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(run.status, conex_db::RunStatus::Cancelled);
    assert_eq!(run.end_reason.as_deref(), Some("aborted"));
}

#[tokio::test]
async fn cooperative_cancel_falls_back_to_force_without_l2_support() {
    let (_mem, store) = setup();
    // 引擎不支持 L2（无协作停止注入点）→ 回落 L3
    let engine = TestEngine::new(false);
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_fallback").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let path = run
        .cancel_run(
            CancelMode::Cooperative,
            Some(&engine),
            "no-bus",
            store.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(path, CancelPath::CooperativeFallbackForce);
    // 回落 L3：强制中断（05 §2.8 orchestrator.test.ts:1186）
    assert_eq!(engine.abort_calls(), vec!["no-bus".to_string()]);
    assert_eq!(engine.cooperative_calls(), Vec::<String>::new());
    assert_eq!(
        run.cancel_path(),
        Some(CancelPath::CooperativeFallbackForce)
    );

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Aborted,
            vec![agent_start(), agent_end(AgentEndReason::Aborted)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(run.status, conex_db::RunStatus::Cancelled);
}

// ── 持久化失败与终态唯一性 ──

#[tokio::test]
async fn persist_failure_marks_run_failed_and_does_not_pretend_replayable() {
    let (mem, store) = setup();
    mem.fail_all_appends("disk is read-only");
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_fail").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();

    // run-failed(event-store-write-failed)，不假装可回放
    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, EVENT_STORE_WRITE_FAILED_REASON);
    let failure = result.persist_failure.as_ref().expect("应有持久化失败详情");
    assert_eq!(failure.event_type, "agent-start");
    assert!(failure.error.message.contains("disk is read-only"));

    assert_eq!(run.status, conex_db::RunStatus::Failed);
    assert_eq!(
        run.end_reason.as_deref(),
        Some(EVENT_STORE_WRITE_FAILED_REASON)
    );
    assert!(run
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("disk is read-only"));
    assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Failed);
    assert_eq!(
        mem.runs()[0].end_reason.as_deref(),
        Some(EVENT_STORE_WRITE_FAILED_REASON)
    );
    // 事件流只有终态事件，且未落库（不能重放）
    assert_eq!(result.events.len(), 1);
    assert!(!result.events[0].persisted);
    assert!(mem.events().is_empty(), "失败期间不应有任何事件落库");
}

#[tokio::test]
async fn run_terminal_is_emitted_exactly_once() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_terminal_once").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(terminal_count(&result.events), 1, "run-terminal 只发一次");
    assert!(run.terminal_sent());

    // 再次驱动 → 终态拒绝，不产生第二个终态事件
    let seq_before = queue.next_sequence();
    let err = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            vec![agent_start(), agent_end(AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(err, RunError::TerminalImmutable);
    assert_eq!(queue.next_sequence(), seq_before, "终态后不再分配序列");
    assert_eq!(
        mem.events()
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .count(),
        1
    );
}

#[tokio::test]
async fn max_turns_ends_failed_with_message() {
    let (_mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_max_turns").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::MaxTurns,
            vec![agent_start(), agent_end(AgentEndReason::MaxTurns)],
        ),
    )
    .await
    .unwrap();
    // max-turns → failed 而非 completed（05 §2.8 orchestrator.test.ts:1223）
    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, "max-turns");
    assert_eq!(
        result.terminal_error.as_deref(),
        Some(MAX_TURNS_FAILED_MESSAGE)
    );
    assert_eq!(run.status, conex_db::RunStatus::Failed);
}

#[tokio::test]
async fn runtime_error_ends_failed_preserving_error() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());
    let mut run = manager.start_run("s1", "r_error").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Error,
            vec![agent_start(), agent_end(AgentEndReason::Error)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, "error");
    assert_eq!(result.terminal_error.as_deref(), Some("provider 调用失败"));
    assert_eq!(run.status, conex_db::RunStatus::Failed);
    assert_eq!(mem.runs()[0].status, conex_db::RunStatus::Failed);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("error"));
}
