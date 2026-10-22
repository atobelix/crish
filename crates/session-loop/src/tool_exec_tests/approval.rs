use super::super::*;
use super::approval_fixture::*;
use super::fixture::*;
use crate::safe_point::AbortSignal;
use conex_types::tool::ToolConcurrency;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn approval_denied_is_not_fatal() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.fatal.is_none());
    // 事件含 approval-requested
    assert!(out
        .events
        .iter()
        .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
}

#[tokio::test]
async fn approval_approved_executes() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert!(out.results[0].is_ok());
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn approval_expired_not_fatal() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Expired,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired)
    );
    assert!(out.fatal.is_none());
}

/// T09.6/P8：审批开启时并行组恢复并行——5×50ms 慢工具批耗时远小于
/// 串行（串行退化 ≈ 5×50ms = 250ms）。B4 并发上限（默认 4）下 5 个
/// 工具拆 2 波 ≈ 100ms 量级，断言阈值取 180ms（2 波上界 ~130ms 与
/// 串行 250ms 之间的安全中线，证明并行仍生效且并发有界）
#[tokio::test]
async fn approval_parallel_executes_concurrently() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 50 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..5)
        .map(|i| call(&format!("p{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let start = std::time::Instant::now();
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    let elapsed = start.elapsed();
    assert!(out.results.iter().all(|r| r.is_ok()));
    assert!(
        elapsed.as_millis() < 180,
        "审批并行批耗应远小于串行 250ms（B4 上限 4 → 2 波 ~100ms），实际 {elapsed:?}"
    );
}

/// T09.6/P8：审批并行组事件顺序与决策顺序——每项保持
/// tool-start → approval-requested → tool-end；审批逐个按组序发起
#[tokio::test]
async fn approval_parallel_event_order_preserved() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let ids = ["p0", "p1", "p2"];
    let calls = ids
        .iter()
        .map(|id| call(id, "echo", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(RecordingApproval {
        order: Arc::clone(&order),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    // 审批逐个按组序发起
    assert_eq!(
        *order.lock().unwrap(),
        ids.iter().map(|s| s.to_string()).collect::<Vec<_>>()
    );
    // 每项事件顺序：tool-start 先于 approval-requested 先于 tool-end
    let start_pos = |id: &str| {
        out.events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == id))
            .unwrap()
    };
    let approval_pos = |id: &str| {
        out.events
            .iter()
            .position(
                |e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == id),
            )
            .unwrap()
    };
    let end_pos = |id: &str| {
        out.events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
            .unwrap()
    };
    for id in ids {
        assert!(
            start_pos(id) < approval_pos(id),
            "{id}: tool-start 应先于 approval-requested"
        );
        assert!(
            approval_pos(id) < end_pos(id),
            "{id}: approval-requested 应先于 tool-end"
        );
    }
}

/// T09.6/P8：并行组中单项被拒 → 该项 user_denied 不执行，其余项并行执行
#[tokio::test]
async fn approval_parallel_denied_skips_execution() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p0", "echo", ToolConcurrency::Parallel),
        call("p1", "echo", ToolConcurrency::Parallel),
        call("p2", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let gate = Arc::new(DenySomeApproval {
        deny: "p1".to_string(),
    });
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
        .await;
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[0].is_ok());
    assert!(out.results[2].is_ok());
    assert!(out.fatal.is_none());
}

/// T09.6/P8：审批等待期间 abort → 已发起审批保留决策，剩余项不再
/// 发起审批并全部以取消收场（与顺序路径逐项 abort 前置检查一致）
#[tokio::test]
async fn approval_parallel_abort_skips_remaining_approvals() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let calls = (0..3)
        .map(|i| call(&format!("a{i}"), "slow", ToolConcurrency::Parallel))
        .collect::<Vec<_>>();
    let opts = ToolBatchOptions {
        approval_enabled: true,
        ..Default::default()
    };
    let release = Arc::new(tokio::sync::Notify::new());
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let gate = Arc::new(BlockingApproval {
        release: Arc::clone(&release),
        order: Arc::clone(&order),
    });
    let abort = AbortSignal::new();
    let aborter = {
        let abort = abort.clone();
        let release = Arc::clone(&release);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
            release.notify_waiters();
        })
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort))
        .await;
    aborter.await.expect("aborter 不应 panic");
    // 仅首个审批被发起（abort 后不再发起剩余审批）
    assert_eq!(order.lock().unwrap().as_slice(), &["a0".to_string()]);
    // 全部以取消收场
    assert!(out
        .results
        .iter()
        .all(|r| r.error_kind == Some(ToolErrorKind::Cancelled)));
    assert!(out
        .results
        .iter()
        .all(|r| r.error_message.as_deref() == Some("aborted")));
}
