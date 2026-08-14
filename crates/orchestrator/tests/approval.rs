//! B4.5 审批挂起/恢复测试（05 §5.4 run::approval）
//!
//! 对齐 packages/agent-orchestrator/src/orchestrator.test.ts:291-358 与
//! state-machine/run-lifecycle.test.ts:40（running → awaiting-approval →
//! running 不终结 run）：
//! - awaiting-approval 中间态落库可观测（持久化事件同步等待语义）；
//! - 批准恢复 → 回 running → 驱动 completed；
//! - 拒绝路径：决策经 approval-resolved(denied) 事件表达，run 状态机不因
//!   拒绝而变化，恢复后照常收口；
//! - 审批挂起期间取消 → cancelled（run-lifecycle.test.ts:52 取消路径）；
//! - 审批事件持久化类别断言（非 delta，落库可回放）。

mod common;

use conex_db::RunStatus;
use conex_types::events::RunTerminalStatus;
use conex_types::session::AgentEndReason;
use orchestrator::events::EventQueue;
use orchestrator::run::{CancelMode, CancelPath, RunManager};

use common::{
    agent_end, agent_start, approval_requested, approval_resolved, assert_single_terminal,
    outcome, setup,
};

/// 审批挂起/恢复往返：awaiting-approval 为中间态，不终结 run
/// （run-lifecycle.test.ts:40）
#[tokio::test]
async fn request_and_resolve_approval_roundtrip_keeps_run_alive() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_approval").await.unwrap();

    // 挂起：running → awaiting-approval，中间态落库（05 §2.8 :291）
    run.request_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, RunStatus::AwaitingApproval);
    assert!(!run.is_terminal(), "awaiting-approval 为中间态");
    assert!(!run.terminal_sent());
    assert_eq!(mem.runs()[0].status, RunStatus::AwaitingApproval, "中间态可观测");

    // 恢复：awaiting-approval → running
    run.resolve_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, RunStatus::Running);
    assert_eq!(mem.runs()[0].status, RunStatus::Running);
}

/// 批准后回 running → completed（orchestrator.test.ts:291 主流程）
#[tokio::test]
async fn approved_run_resumes_and_completes() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_approve_ok").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    run.request_approval(store.as_ref()).await.unwrap();
    run.resolve_approval(store.as_ref()).await.unwrap();

    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![
                agent_start("s1"),
                approval_requested("s1", "tc-1"),
                approval_resolved("s1", "tc-1", conex_types::ApprovalDecision::Approved),
                agent_end("s1", AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert_eq!(result.end_reason, "stop");
    assert_single_terminal(&result.events, RunTerminalStatus::Completed);
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(mem.runs()[0].status, RunStatus::Completed);

    // 审批事件为持久化类别（delta 之外的事件均落库，05 §2.8 :191）
    let stored_types: Vec<String> = mem.events().iter().map(|e| e.event_type.clone()).collect();
    assert!(stored_types.contains(&"approval-requested".to_string()));
    assert!(stored_types.contains(&"approval-resolved".to_string()));
}

/// 拒绝路径：approval-resolved(denied) 后 run 状态机不受决策影响，
/// 恢复 running 照常收口（决策由事件表达，03 §5.3-3）
#[tokio::test]
async fn denied_approval_resumes_and_completes() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_denied").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    // 运行时挂起审批
    run.request_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, RunStatus::AwaitingApproval);

    // 审批人拒绝 → 恢复运行（拒绝只影响工具是否执行，不影响 run 状态机）
    run.resolve_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, RunStatus::Running);

    let result = orchestrator::events::drive_outcome(
        &mut run,
        &mut queue,
        outcome(
            AgentEndReason::Stop,
            None,
            vec![
                agent_start("s1"),
                approval_requested("s1", "tc-1"),
                approval_resolved("s1", "tc-1", conex_types::ApprovalDecision::Denied),
                agent_end("s1", AgentEndReason::Stop),
            ],
        ),
    )
    .await
    .unwrap();

    assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
    assert_eq!(run.status, RunStatus::Completed);

    // 拒绝事件已落库（决策值保留可审计）
    let stored_types: Vec<String> = mem.events().iter().map(|e| e.event_type.clone()).collect();
    assert!(stored_types.contains(&"approval-resolved".to_string()));
    let resolved = mem
        .events()
        .into_iter()
        .find(|e| e.event_type == "approval-resolved")
        .expect("approval-resolved 应已落库");
    let value: serde_json::Value = serde_json::from_str(&resolved.payload).unwrap();
    assert_eq!(value["decision"], "denied", "拒绝决策值保留");
}

/// 审批挂起期间取消 → cancelled（run-lifecycle.test.ts:52 取消路径：
/// awaiting-approval → cancelling → cancelled）
#[tokio::test]
async fn cancel_while_awaiting_approval_ends_cancelled() {
    let (mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_approval_cancel").await.unwrap();
    let mut queue = EventQueue::new(store.clone(), run.cursor + 1, None);

    run.request_approval(store.as_ref()).await.unwrap();
    assert_eq!(run.status, RunStatus::AwaitingApproval);

    let path = run
        .cancel_run(
            CancelMode::Force,
            None,
            "approval-cancelled",
            store.as_ref(),
        )
        .await
        .unwrap();
    assert_eq!(path, CancelPath::Force);
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
    assert_single_terminal(&result.events, RunTerminalStatus::Cancelled);
    assert_eq!(run.status, RunStatus::Cancelled);
    assert_eq!(mem.runs()[0].status, RunStatus::Cancelled);
    assert_eq!(mem.runs()[0].end_reason.as_deref(), Some("aborted"));
}

/// 未挂起审批时直接请求 → 状态机拒绝（防御性：未定义转移显式失败）
#[tokio::test]
async fn resolve_approval_without_request_is_rejected() {
    let (_mem, store) = setup();
    let manager = RunManager::new(store.clone());

    let mut run = manager.start_run("s1", "r_approval_miss").await.unwrap();

    let err = run.resolve_approval(store.as_ref()).await.unwrap_err();
    assert_eq!(err, orchestrator::run::RunError::Transition(
        orchestrator::run::TransitionError {
            from: RunStatus::Running,
            event: "APPROVAL_RESOLVED",
        }
    ));
}
