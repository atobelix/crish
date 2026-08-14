//! B4.5 run 全生命周期驱动测试（05 §5.4 run::drive）
//!
//! 对齐 packages/agent-orchestrator/src/orchestrator.test.ts:34-91
//! （run 事件序列与 sequence 连续）与 :93-237（delta 非持久化不阻塞）：
//! - queued → running → completed 主路径，落库状态全程断言；
//! - run-terminal 事件产出序列（类型序 + sequence 连续 + 终态唯一）；
//! - message-delta 非持久化：不落库、不阻塞 drive loop（慢 store 场景）；
//! - error / max-turns 收场 → failed（05 §2.8：max-turns 以 failed 收场）；
//! - 终态后再次驱动 → TerminalImmutable（不产生第二个终态事件）。

mod common;

use std::time::{Duration, Instant};

use conex_db::RunStatus;
use conex_types::events::{AgentEvent, RunTerminalStatus};
use conex_types::session::AgentEndReason;
use orchestrator::events::{DriveOutcome, EventQueue, SequencedEvent};
use orchestrator::run::{RunError, RunManager};

use common::{agent_end, agent_start, message_delta, message_end, outcome, setup};

/// 断言驱动结果的事件类型序（含终态）
fn assert_type_order(events: &[SequencedEvent], expected: &[&str]) {
    let actual: Vec<&str> = events
        .iter()
        .map(|e| orchestrator::events::event_type_name(&e.event))
        .collect();
    assert_eq!(actual, expected);
}

/// 断言事件序列连续（1..=n，终态唯一性前提）
fn assert_sequences_continuous(events: &[SequencedEvent]) {
    let seqs: Vec<u64> = events.iter().map(|e| e.sequence).collect();
    assert_eq!(seqs, (1..=events.len() as u64).collect::<Vec<_>>());
}

/// start_run：注册即落库，queued → initializing → running（05 §5.4 主路径）
#[tokio::test]
async fn start_run_registers_and_reaches_running() {
    let (mem, store) = setup();
    let manager = RunManager::new(store);

    let run = manager.start_run("s1", "r1").await.unwrap();

    assert_eq!(run.status, RunStatus::Running);
    assert_eq!(run.run_id, "r1");
    assert_eq!(run.session_id, "s1");
    assert_eq!(run.cursor, 0, "事件序列游标初始为 0");
    assert!(!run.is_terminal());
    assert!(!run.terminal_sent());

    let runs = mem.runs();
    assert_eq!(runs.len(), 1, "insert_run 只落一条记录");
    assert_eq!(runs[0].status, RunStatus::Running, "落库状态应为 running");
    assert_eq!(runs[0].end_reason, None);
    assert_eq!(runs[0].cursor, 0);
    assert!(runs[0].created_at > 0);
}

/// 完整生命周期：queued → running → completed，事件类型序与 sequence 连续
#[tokio::test]
async fn full_lifecycle_queued_to_completed_emits_terminal_sequence() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_main").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    // 运行时产出：agent-start → 120…，此处用最小序列
    let result = drive_outcome_wrap(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![
                agent_start("s1"),
                message_delta("s1", 0),
                message_delta("s1", 1),
                message_end("s1"),
                agent_end("s1", AgentEndReason::Stop),
            ],
        ),
    )
    .await;
    // 事件类型序（05 §2.8 orchestrator.test.ts:34：run-queued→run-started→
    // runtime-event→run-completed 的等价断言：终态事件唯一且收尾）
    assert_type_order(
        &result.events,
        &[
            "agent-start",
            "message-delta",
            "message-delta",
            "message-end",
            "agent-end",
            "run-terminal",
        ],
    );
    assert_sequences_continuous(&result.events);
    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert_eq!(result.end_reason, "stop");
    assert!(result.terminal_error.is_none());
    assert!(result.persist_failure.is_none());

    // 终态唯一（03 §5.2-2）
    common::assert_single_terminal(&result.events, RunTerminalStatus::Completed);

    // run-terminal 事件体字段（runId/sessionId/error 齐备）
    match &result.events.last().unwrap().event {
        AgentEvent::RunTerminal {
            session_id,
            run_id,
            terminal,
            error,
            ..
        } => {
            assert_eq!(session_id, "s1");
            assert_eq!(run_id, "r_main");
            assert_eq!(*terminal, RunTerminalStatus::Completed);
            assert!(error.is_none());
        }
        other => panic!("终态事件类型不符：{other:?}"),
    }

    // 序列游标推进到末事件
    assert_eq!(run.cursor, 6);
    assert_eq!(queue.next_sequence(), 7, "序列分配应连续无空洞");

    // 持久化分流：delta 不落库，其余全落库
    assert_eq!(
        result
            .events
            .iter()
            .map(|e| e.persisted)
            .collect::<Vec<_>>(),
        vec![true, false, false, true, true, true]
    );
    let stored_types: Vec<String> = mem.events().iter().map(|e| e.event_type.clone()).collect();
    assert_eq!(
        stored_types,
        vec!["agent-start", "message-end", "agent-end", "run-terminal"]
    );

    // 落库终态记录
    assert_eq!(mem.runs()[0].status, RunStatus::Completed);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("stop"));

    // 终态后再驱动 → 拒绝（不产生第二个终态事件）
    let seq_before = queue.next_sequence();
    let err = drive_outcome_wrap_err(
        &mut run,
        &mut queue,
        outcome(AgentEndReason::Stop, None, vec![agent_start("s1")]),
    )
    .await;
    assert_eq!(err, RunError::TerminalImmutable);
    assert_eq!(queue.next_sequence(), seq_before, "终态后不再分配序列");
    assert_eq!(
        mem.events()
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .count(),
        1,
        "run-terminal 只落库一次"
    );
}

/// delta 非持久化：慢 store（40ms/条）下 120 条 delta 不阻塞 drive loop
/// （05 §2.8 orchestrator.test.ts:93 语义）
#[tokio::test]
async fn delta_streams_do_not_block_drive_loop_on_slow_store() {
    let (mem, store) = setup();
    mem.set_append_delay(Duration::from_millis(40));
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_delta").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let mut events = vec![agent_start("s1")];
    for i in 0..120 {
        events.push(message_delta("s1", i));
    }
    events.push(message_end("s1"));
    events.push(agent_end("s1", AgentEndReason::Stop));

    let started = Instant::now();
    let result = drive_outcome_wrap(
        &mut run,
        &mut queue,
        outcome(AgentEndReason::Stop, None, events),
    )
    .await;
    let elapsed = started.elapsed();

    // 120 条 delta 若各自等待 40ms 需约 4.8s；只等待 4 条持久化事件
    assert!(
        elapsed < Duration::from_millis(120 * 40 / 2),
        "delta 不应阻塞 drive loop：elapsed={elapsed:?}"
    );

    // 全部 delta 存活于事件流且不落库
    let live_deltas = result
        .events
        .iter()
        .filter(|e| matches!(e.event, AgentEvent::MessageDelta { .. }))
        .count();
    assert_eq!(live_deltas, 120);
    assert!(
        !mem.events().iter().any(|e| e.event_type == "message-delta"),
        "delta 不应落库"
    );
    assert_sequences_continuous(&result.events);
}

/// max-turns 收场 → failed 而非 completed（05 §2.8 orchestrator.test.ts:1223）
#[tokio::test]
async fn max_turns_ends_failed_with_message() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_max_turns").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome_wrap(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::MaxTurns,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::MaxTurns)],
        ),
    )
    .await;

    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, "max-turns");
    assert_eq!(
        result.terminal_error.as_deref(),
        Some(orchestrator::events::MAX_TURNS_FAILED_MESSAGE)
    );
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(run.end_reason.as_deref(), Some("max-turns"));
    assert_eq!(mem.runs()[0].status, RunStatus::Failed);
    common::assert_single_terminal(&result.events, RunTerminalStatus::Failed);
}

/// error 收场 → failed，错误文案与终态事件 error 字段保留
/// （05 §2.8 orchestrator.test.ts:1270：preserves provider detail）
#[tokio::test]
async fn error_outcome_ends_failed_preserving_message() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_error").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome_wrap(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Error,
            Some("provider 调用失败"),
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Error)],
        ),
    )
    .await;

    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(result.end_reason, "error");
    assert_eq!(result.terminal_error.as_deref(), Some("provider 调用失败"));
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(mem.runs()[0].status, RunStatus::Failed);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("error"));

    // 终态事件 error 字段保留文案（前端可观测）
    match &result.events.last().unwrap().event {
        AgentEvent::RunTerminal { error, .. } => {
            assert_eq!(error.as_deref(), Some("provider 调用失败"));
        }
        other => panic!("终态事件类型不符：{other:?}"),
    }
}

/// 持久化失败 → run-failed(event-store-write-failed)，不假装可回放
/// （05 §2.8 orchestrator.test.ts:239 语义）
#[tokio::test]
async fn store_write_failure_fails_run_without_replayable_history() {
    let (mem, store) = setup();
    mem.fail_all_appends("disk is read-only");
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_store_fail").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    let result = drive_outcome_wrap(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stop)],
        ),
    )
    .await;

    assert_eq!(result.terminal_status, RunTerminalStatus::Failed);
    assert_eq!(
        result.end_reason,
        orchestrator::run::EVENT_STORE_WRITE_FAILED_REASON
    );
    let failure = result.persist_failure.as_ref().expect("应有持久化失败详情");
    assert_eq!(failure.event_type, "agent-start");
    assert!(failure.error.message.contains("disk is read-only"));

    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        run.end_reason.as_deref(),
        Some(orchestrator::run::EVENT_STORE_WRITE_FAILED_REASON)
    );
    // 事件流只有未落库的终态事件（不能重放）
    assert_eq!(result.events.len(), 1);
    assert!(!result.events[0].persisted);
    assert!(mem.events().is_empty(), "失败期间不应有任何事件落库");
}

// ── 小助手：drive_outcome 成功/失败解包 ──

async fn drive_outcome_wrap(
    run: &mut orchestrator::run::RunHandle,
    queue: &mut EventQueue,
    outcome: session_loop::RunOutcome,
) -> DriveOutcome {
    orchestrator::events::drive_outcome(run, queue, outcome)
        .await
        .unwrap_or_else(|e| panic!("驱动 run 失败：{e}"))
}

async fn drive_outcome_wrap_err(
    run: &mut orchestrator::run::RunHandle,
    queue: &mut EventQueue,
    outcome: session_loop::RunOutcome,
) -> RunError {
    orchestrator::events::drive_outcome(run, queue, outcome)
        .await
        .expect_err("终态 run 驱动应被拒绝")
}
