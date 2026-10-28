use super::super::*;
use super::approval_fixture::*;
use super::fixture::*;
use crate::safe_point::AbortSignal;
use conex_types::tool::ToolConcurrency;
use std::sync::Arc;
use std::time::Duration;

// ── F1-02（PS-04 T4.2）：批级审批挂起红测试 ──
// 缺陷：三个 `gate.request_approval(...).await` 裸挂起（顺序路径 /
// 并行组审批循环 / requires_approval 重试），abort 信号在审批等待
// 期间无法打断 run，run 无限悬挂（F1-02）。

/// T4.2-R3（红，顺序路径 abort 竞速）：审批门挂起不返回 + abort 置位
/// → 批执行必须**立即**收敛为取消（不等待 gate）。修复前裸挂起，
/// abort 无法打断，外层 tokio timeout 触发（红）
#[tokio::test]
async fn approval_hang_sequential_abort_race_converges() {
    let reg = registry_with(vec![Arc::new(DangerousEchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let abort = AbortSignal::new();
    // 50ms 后触发 abort（审批仍挂起中）
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
    )
    .await
    .expect("审批挂起必须被 abort 竞速收敛（不得悬挂）");
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[0].error_message.as_deref(), Some("aborted"));
    assert!(
        elapsed.as_millis() < 1000,
        "abort 竞速应在数百 ms 内生效（不等 gate 不响应窗口），实际 {elapsed:?}"
    );
}

/// T4.2-R3（红，并行组 abort 竞速）：并行组审批循环挂起 + abort →
/// 全组有限时间收敛为取消（不悬挂），approval-requested 全组先发
/// 事件顺序契约保持
#[tokio::test]
async fn approval_hang_parallel_group_abort_race_converges() {
    let reg = registry_with(vec![Arc::new(DangerousEchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p0", "echo", ToolConcurrency::Parallel),
        call("p1", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let abort = AbortSignal::new();
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
    )
    .await
    .expect("并行组审批挂起必须被 abort 竞速收敛（不得悬挂）");
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");
    // 全部以取消收场（无决策 = abort 中断，复用既有取消路径）
    assert!(out
        .results
        .iter()
        .all(|r| r.error_kind == Some(ToolErrorKind::Cancelled)));
    assert!(
        elapsed.as_millis() < 1000,
        "并行组 abort 竞速应在数百 ms 内收敛，实际 {elapsed:?}"
    );
    // approval-requested 全组先发契约保持（等待前已全部广播）
    let approvals = out
        .events
        .iter()
        .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .count();
    assert!(approvals >= 1, "审批请求事件应先于等待发出");
}

/// T4.2-R4（红，requires_approval 重试路径 abort 竞速）：批级审批
/// 通过 → 工具返回 ApprovalRequired → 重试审批挂起 + abort → 有限
/// 时间收敛为取消（修复前 :1140 裸挂起，红）
#[tokio::test]
async fn requires_approval_retry_hang_abort_race_converges() {
    let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        ..Default::default()
    };
    // 首次问询（批级审批）通过，重试审批挂起
    let gate = Arc::new(HangAfterApprovals::new(1));
    let abort = AbortSignal::new();
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
    )
    .await
    .expect("重试审批挂起必须被 abort 竞速收敛（不得悬挂）");
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert!(
        elapsed.as_millis() < 1000,
        "重试审批 abort 竞速应在数百 ms 内收敛，实际 {elapsed:?}"
    );
}

/// T4.2-R1（绿，顺序路径超时）：审批门挂起不返回 + 测试注入短超时
/// → 批执行在超时内收敛为 Expired（内核 timeout 真实收敛，外层
/// tokio timeout 不触发）
#[tokio::test]
async fn approval_wait_times_out_when_gate_hangs() {
    let reg = registry_with(vec![Arc::new(DangerousEchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let start = std::time::Instant::now();
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
    )
    .await
    .expect("审批挂起必须被超时收敛（不得悬挂）");
    let elapsed = start.elapsed();
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired),
        "超时应复用 Expired 分支"
    );
    assert!(
        elapsed.as_millis() < 1000,
        "超时应在内核审批超时附近收敛，实际 {elapsed:?}"
    );
    // 非致命：喂回模型继续
    assert!(out.fatal.is_none());
    // G-9：超时 → Expired 权威语义落库——approval-resolved(expired)
    // 事件进批事件流，顺序契约：
    // approval-requested → approval-resolved → tool-end
    let req = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1"))
        .expect("应有 approval-requested");
    let resolved = out
        .events
        .iter()
        .position(|e| {
            matches!(e, ToolEvent::ApprovalResolved { call_id, decision }
                    if call_id == "c1" && *decision == ApprovalDecision::Expired)
        })
        .expect("超时应收敛为 approval-resolved(expired) 落库");
    let end = out
        .events
        .iter()
        .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == "c1"))
        .expect("应有 tool-end");
    assert!(
        req < resolved && resolved < end,
        "approval-resolved(expired) 应位于 approval-requested 与 tool-end 之间"
    );
}

/// T4.2-R2（绿，并行组超时）：审批门挂起 + 短超时 → 全组收敛为
/// Expired，无悬挂；approval-requested 全组先发事件顺序契约保持
#[tokio::test]
async fn approval_wait_parallel_group_timeout_converges() {
    let reg = registry_with(vec![Arc::new(DangerousEchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("p0", "echo", ToolConcurrency::Parallel),
        call("p1", "echo", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        approval_timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    let gate = Arc::new(PendingApproval);
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
    )
    .await
    .expect("并行组审批挂起必须被超时收敛（不得悬挂）");
    assert!(out
        .results
        .iter()
        .all(|r| r.error_kind == Some(ToolErrorKind::ApprovalExpired)));
    // approval-requested 全组先发契约保持（等待前已全部广播）
    let approvals = out
        .events
        .iter()
        .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .count();
    assert_eq!(approvals, 2, "全组审批请求应先于等待发出");
    assert!(out.fatal.is_none());
    // G-9：超时 → Expired 权威语义落库——每项一条
    // approval-resolved(expired)，位于本项 approval-requested 与
    // tool-end 之间
    let resolved = out
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                ToolEvent::ApprovalResolved {
                    decision: ApprovalDecision::Expired,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        resolved, 2,
        "并行组超时每项都应落一条 approval-resolved(expired)"
    );
    for id in ["p0", "p1"] {
        let req = out
            .events
            .iter()
            .position(
                |e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == id),
            )
            .unwrap_or_else(|| panic!("{id} 应有 approval-requested"));
        let res = out
            .events
            .iter()
            .position(|e| {
                matches!(e, ToolEvent::ApprovalResolved { call_id, decision }
                        if call_id == id && *decision == ApprovalDecision::Expired)
            })
            .unwrap_or_else(|| panic!("{id} 应有 approval-resolved(expired)"));
        let end = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
            .unwrap_or_else(|| panic!("{id} 应有 tool-end"));
        assert!(
            req < res && res < end,
            "{id} 的 approval-resolved(expired) 应位于 approval-requested 与 tool-end 之间"
        );
    }
}

/// T4.2-R4（绿，requires_approval 重试路径超时）：批级审批通过 →
/// 工具返回 ApprovalRequired → 重试审批挂起 + 短超时 → ApprovalExpired
/// 收敛（:1140 点位不再裸挂起）
#[tokio::test]
async fn requires_approval_retry_hang_times_out() {
    let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        approval_timeout: Some(Duration::from_millis(50)),
        ..Default::default()
    };
    // 首次问询（批级审批）通过，重试审批挂起
    let gate = Arc::new(HangAfterApprovals::new(1));
    let out = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
    )
    .await
    .expect("重试审批挂起必须被超时收敛（不得悬挂）");
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired),
        "重试审批超时应收敛为 ApprovalExpired：{:?}",
        out.results[0]
    );
    assert!(out.fatal.is_none());
    // G-9：超时 → Expired 权威语义落库——requires_approval 重试路径
    // 同样落 approval-resolved(expired)（首次问询通过不落 resolved，
    // 只有超时决策落；本路径事件仅一条）
    let resolved = out
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                ToolEvent::ApprovalResolved {
                    decision: ApprovalDecision::Expired,
                    ..
                }
            )
        })
        .count();
    assert_eq!(
        resolved, 1,
        "重试审批超时应落一条 approval-resolved(expired)"
    );
}

// ── R4 T10：真实审批事件（requires_approval / dangerous / permissionMode）──

/// T10 回归：tool.requires_approval 不再落入软拒绝分类，归类为
/// ApprovalRequired 透传审批状态（无审批门时）
#[tokio::test]
async fn requires_approval_is_not_soft_deny_without_gate() {
    let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalRequired),
        "requires_approval 应分类为 ApprovalRequired"
    );
    assert_ne!(
        out.results[0].error_kind,
        Some(ToolErrorKind::SoftDeny),
        "不再折叠为 SoftDeny"
    );
    assert_eq!(
        out.results[0].error_kind.map(|k| k.error_code()),
        Some("tool.requires_approval")
    );
    // 审批/控制类错误永不致命
    assert!(out.fatal.is_none());
}

/// T10：requires_approval 产生真实审批请求（走 gate），用户同意后
/// 重试执行该工具调用
#[tokio::test]
async fn requires_approval_approved_then_retries_execution() {
    let tool = ApprovalOnceTool::new();
    let reg = registry_with(vec![Arc::new(tool.clone())]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "approval_once", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    // 批级审批通过 → 工具首调 requires_approval → ApprovalRequired →
    // 真实审批（gate 再次问询）→ 用户同意 → 重试执行成功
    assert!(out.results[0].is_ok(), "重试后应成功：{:?}", out.results[0]);
    assert_eq!(tool.call_count(), 2, "工具应被重试执行（共 2 次）");
    // 两次审批请求均产生 approval-requested 事件（批级 + 重试）
    let approvals = out
        .events
        .iter()
        .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
        .count();
    assert_eq!(approvals, 2);
    assert!(out.fatal.is_none());
}

/// T10：requires_approval 重试审批被拒绝 → 明确拒绝结果（Denied 语义）
#[tokio::test]
async fn requires_approval_denied_returns_user_denied() {
    let tool = AlwaysRequiresApprovalTool;
    let reg = registry_with(vec![Arc::new(tool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        ..Default::default()
    };
    // 批级审批通过（首问），重试审批拒绝（次问）
    let gate = SequenceApproval::new(vec![
        ApprovalDecision::Approved,
        ApprovalDecision::Denied {
            reason: "no".into(),
        },
    ]);
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert!(out.results[0]
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("user denied: no"));
    // 拒绝非致命（喂回模型，Denied 语义）
    assert!(out.fatal.is_none());
}

/// T10：requires_approval 重试审批过期 → ApprovalExpired
#[tokio::test]
async fn requires_approval_expired_returns_approval_expired() {
    let tool = AlwaysRequiresApprovalTool;
    let reg = registry_with(vec![Arc::new(tool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        ..Default::default()
    };
    let gate = SequenceApproval::new(vec![ApprovalDecision::Approved, ApprovalDecision::Expired]);
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ApprovalExpired)
    );
}
