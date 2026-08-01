//! B4.5 run 取消三路径测试（05 §5.4 run::cancel）
//!
//! 对齐 packages/agent-orchestrator/src/orchestrator.test.ts:1073-1221：
//! - L2 协作取消（cooperative）：ControlBus 注入，不 hard abort，安全点以
//!   stopped 收场 → cancelled/aborted（05 §2.8 :1113）；
//! - L3 强制取消（force）：hard abort provider（05 §2.8 :1151）；
//! - 引擎不支持 L2 → 回落 L3，mode=cooperative-fallback-force（:1186）；
//! - 无引擎时协作请求同样回落 L3；
//! - 终态 run 拒绝取消。

mod common;

use conex_db::RunStatus;
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use orchestrator::events::EventQueue;
use orchestrator::run::{CancelMode, CancelPath, RunError, RunManager};

use common::{agent_end, agent_start, assert_single_terminal, outcome, setup, TestEngine};

/// L2 协作取消：注入协作停止意图，不 hard abort；stopped 收场 → cancelled
/// （05 §2.8 orchestrator.test.ts:1113）
#[tokio::test]
async fn l2_cooperative_cancel_injects_without_hard_abort() {
    let (mem, store) = setup();
    let engine = TestEngine::new(true);
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_coop").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

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
    assert_eq!(engine.abort_calls(), Vec::<String>::new(), "L2 不 hard abort");
    assert_eq!(
        engine.cooperative_calls(),
        vec!["cancelled-by-user".to_string()],
        "协作停止意图注入引擎"
    );
    assert!(run.cancel_requested());
    assert_eq!(run.cancel_path(), Some(CancelPath::Cooperative));
    assert_eq!(run.cancel_reason(), Some("cancelled-by-user"));
    assert_eq!(run.status, RunStatus::Cancelling, "协作停止进入 cancelling 中间态");
    assert_eq!(mem.runs()[0].status, RunStatus::Cancelling);

    // 安全点收场（stopped）→ 终态 cancelled（end_reason=aborted，05 §2.8）
    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stopped,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stopped)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(result.end_reason, "aborted");
    assert_single_terminal(&result.events, RunTerminalStatus::Cancelled);
    assert_eq!(run.status, RunStatus::Cancelled);
    assert!(run.is_terminal());
    assert!(run.terminal_sent());
    assert_eq!(mem.runs()[0].status, RunStatus::Cancelled);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("aborted"));
}

/// L3 强制取消：hard abort provider，无协作停止；aborted 收场 → cancelled
/// （05 §2.8 orchestrator.test.ts:1151）
#[tokio::test]
async fn l3_force_cancel_hard_aborts_and_ends_cancelled() {
    let (_mem, store) = setup();
    let engine = TestEngine::new(true);
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_force").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    let path = run
        .cancel_run(CancelMode::Force, Some(&engine), "ui-force", store.as_ref())
        .await
        .unwrap();
    assert_eq!(path, CancelPath::Force);
    assert_eq!(engine.abort_calls(), vec!["ui-force".to_string()], "L3 hard abort");
    assert_eq!(engine.cooperative_calls(), Vec::<String>::new());
    assert_eq!(run.cancel_path(), Some(CancelPath::Force));
    assert_eq!(run.status, RunStatus::Cancelling);

    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Aborted,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Aborted)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(result.end_reason, "aborted");
    assert_eq!(run.status, RunStatus::Cancelled);
    assert_eq!(run.end_reason.as_deref(), Some("aborted"));
}

/// 引擎不支持 L2 → 协作请求回落 L3 强制（mode=cooperative-fallback-force，
/// 05 §2.8 orchestrator.test.ts:1186）
#[tokio::test]
async fn cooperative_cancel_falls_back_to_force_without_l2_support() {
    let (_mem, store) = setup();
    let engine = TestEngine::new(false);
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_fallback").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

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
    assert_eq!(engine.abort_calls(), vec!["no-bus".to_string()], "回落按 L3 执行");
    assert_eq!(engine.cooperative_calls(), Vec::<String>::new());
    assert_eq!(run.cancel_path(), Some(CancelPath::CooperativeFallbackForce));

    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Aborted,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Aborted)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(run.status, RunStatus::Cancelled);
}

/// 无引擎时协作请求同样回落 L3（无 abort 目标可调，仅记录路径）
#[tokio::test]
async fn cooperative_cancel_without_engine_falls_back() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_no_engine").await.unwrap();

    let path = run
        .cancel_run(CancelMode::Cooperative, None, "no-engine", store.as_ref())
        .await
        .unwrap();
    assert_eq!(path, CancelPath::CooperativeFallbackForce);
    assert_eq!(run.cancel_reason(), Some("no-engine"));
    assert_eq!(mem.runs()[0].status, RunStatus::Cancelling);
}

/// 终态 run 拒绝取消（05 §5.4：终态拒绝再转移）
#[tokio::test]
async fn terminal_run_rejects_cancel() {
    let (_mem, store) = setup();
    let engine = TestEngine::new(true);
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_terminal_cancel").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(run.status, RunStatus::Completed);

    let err = run
        .cancel_run(
            CancelMode::Force,
            Some(&engine),
            "too-late",
            store.as_ref(),
        )
        .await
        .unwrap_err();
    assert_eq!(err, RunError::TerminalImmutable);
    assert!(!run.cancel_requested(), "终态 run 不接受取消请求");
    assert_eq!(engine.abort_calls(), Vec::<String>::new(), "终态不触发 abort");
}

/// 终态事件与取消路径的组合：L2 之后自然 stop 收场也归为 cancelled
/// （map_outcome_to_terminal：已请求取消 → cancelled，05 §2.8）
#[tokio::test]
async fn l2_then_natural_stop_still_ends_cancelled() {
    let (mem, store) = setup();
    let engine = TestEngine::new(true);
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_coop_stop").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1);

    run.cancel_run(
        CancelMode::Cooperative,
        Some(&engine),
        "user-stop",
        store.as_ref(),
    )
    .await
    .unwrap();

    // 安全点以普通 stop 收场（未及走 stopped 分支）
    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stop)],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Cancelled);
    assert_eq!(result.end_reason, "aborted");
    assert_eq!(run.status, RunStatus::Cancelled);
    assert_eq!(mem.runs()[0].status, RunStatus::Cancelled);
    assert!(matches!(
        mem.events().last().map(|e| e.event_type.as_str()),
        Some("run-terminal")
    ));
}
