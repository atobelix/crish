use super::super::*;
use super::fixture::*;
use crate::safe_point::AbortSignal;
use conex_types::tool::ToolConcurrency;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn timeout_tool() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 500 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        timeout: Duration::from_millis(50),
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
    // 超时不是 fatal（排除清单）
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn cancel_siblings_strategy() {
    let reg = registry_with(vec![
        Arc::new(FailTool),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "fail", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    // 未标记 fatalOnError：执行失败非致命 → 兄弟工具继续执行
    assert!(out.fatal.is_none());
    assert!(out.results[1].is_ok());
    assert!(out.results[2].is_ok());
}

#[tokio::test]
async fn cancel_siblings_strategy_fatal_tool() {
    // fatalOnError 工具失败 → 致命：同批未执行项 cancelled
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert!(out.fatal.is_some());
}

/// 混排用例 1：并行组致命 + 后置顺序项 → 全部未执行项取消 + 事件对齐全
#[tokio::test]
async fn cancel_siblings_mixed_parallel_fatal_then_sequential() {
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // 并行组致命 → 后置两个顺序项全部取消（真实 id/tool_name）
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[1].id, "c2");
    assert_eq!(out.results[1].tool_name, "echo");
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].id, "c3");
    assert_eq!(out.results[2].tool_name, "slow");
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 混排用例 2：并行组致命（join_all 全完成才判 fatal）+ 后置顺序项
/// → 组内兄弟正常完成，顺序项取消且事件对齐全
#[tokio::test]
async fn cancel_siblings_parallel_group_completes_before_fatal_judged() {
    let reg = registry_with(vec![
        Arc::new(SlowTool { ms: 20 }),
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "slow", ToolConcurrency::Parallel),
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // 并行组 join_all 全完成才判 fatal：slow 兄弟仍正常完成
    assert!(out.results[0].is_ok(), "并行组兄弟应正常完成");
    assert_eq!(
        out.results[1].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    // 后置顺序项取消，携带真实 id/tool_name
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].id, "c3");
    assert_eq!(out.results[2].tool_name, "echo");
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 混排用例 3：并行组致命 + 中间夹顺序项 → 中间项取消且事件对齐全
/// （AA-01 Q01 原始触发路径：calls = [failfatal(P), echo(S), slow(P)]）
#[tokio::test]
async fn cancel_siblings_mixed_middle_sequential_cancelled() {
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(EchoTool),
        Arc::new(SlowTool { ms: 0 }),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c2", "echo", ToolConcurrency::Sequential),
        call("c3", "slow", ToolConcurrency::Parallel),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, None)
        .await;
    // 中间顺序项 echo：未被执行 → 取消（修复前为空 id 脏数据）
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[1].id, "c2");
    assert_eq!(out.results[1].tool_name, "echo");
    // 并行组兄弟 slow 经 join_all 正常完成
    assert!(out.results[2].is_ok());
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 混排用例 4：审批并行（T09.6/P8）——并行组 join_all 全完成才判
/// fatal：组内兄弟正常完成，后置顺序项取消且事件对齐全（与无审批
/// 并行组 `cancel_siblings_parallel_group_completes_before_fatal_judged`
/// 行为一致——审批不再把并行组退化串行）
#[tokio::test]
async fn cancel_siblings_approval_parallel_completes_before_fatal_judged() {
    let reg = registry_with(vec![
        Arc::new(FailToolFatal),
        Arc::new(SlowTool { ms: 0 }),
        Arc::new(EchoTool),
    ]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "failfatal", ToolConcurrency::Parallel),
        call("c2", "slow", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let opts = ToolBatchOptions {
        fail_strategy: FailStrategy::CancelSiblings,
        ..Default::default()
    };
    let gate = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    // 审批并行：并行组 join_all 全完成才判 fatal——slow 兄弟正常完成
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[1].is_ok());
    assert_eq!(out.results[1].id, "c2");
    assert_eq!(out.results[1].tool_name, "slow");
    // 后置顺序项同样取消
    assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[2].id, "c3");
    assert_eq!(out.results[2].tool_name, "echo");
    assert!(out.fatal.is_some());
    assert_event_contract(&calls, &out.results, &out.events);
}

/// 成功路径回归：混排批次全部成功 → 事件序列不破坏
/// （每个工具一对 ToolStart→ToolEnd，BatchStart 打头、BatchEnd 收尾）
#[tokio::test]
async fn success_path_mixed_batch_event_sequence() {
    let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("c1", "echo", ToolConcurrency::Parallel),
        call("c2", "slow", ToolConcurrency::Parallel),
        call("c3", "echo", ToolConcurrency::Sequential),
    ];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert!(out.results.iter().all(|r| r.is_ok()));
    assert!(out.fatal.is_none());
    assert!(out.results.iter().all(|r| !r.id.is_empty()));
    assert_event_contract(&calls, &out.results, &out.events);
}

#[tokio::test]
async fn continue_drain_strategy() {
    let reg = registry_with(vec![Arc::new(FailTool), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("f", "fail", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
    ];
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
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[1].is_ok());
    // 未标记 fatalOnError：执行失败非致命
    assert!(out.fatal.is_none());
}

#[tokio::test]
async fn abort_cancels_pending() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 500 }), Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![
        call("s", "slow", ToolConcurrency::Sequential),
        call("e", "echo", ToolConcurrency::Sequential),
    ];
    let abort = AbortSignal::new();
    abort.abort();
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            Some(&abort),
        )
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
}

/// Q21（T09.9）：abort-aware 竞速——模拟 60s 长工具 + 中途 abort →
/// 取消在数百 ms 内生效（不等 `options.timeout` 全长，AA-01 Q21 验收）
///
/// 修复前：abort 只在 timeout 返回后检查，60s 长工具需等满 60s；
/// 修复后：timeout future 与 abort 监听 future 竞速，abort 触发即
/// 取消等待并走取消收场。
#[tokio::test]
async fn abort_interrupts_long_running_tool_promptly() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 60_000 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        timeout: Duration::from_secs(60),
        ..Default::default()
    };
    let abort = AbortSignal::new();
    // 50ms 后触发 abort（长工具仍在执行中）
    let aborter = {
        let abort = abort.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            abort.abort();
        })
    };
    let start = std::time::Instant::now();
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, Some(&abort))
        .await;
    let elapsed = start.elapsed();
    aborter.await.expect("aborter 不应 panic");

    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(out.results[0].error_message.as_deref(), Some("aborted"));
    assert!(
        elapsed.as_millis() < 2000,
        "取消应在数百 ms 内生效（不等 60s timeout），实际 {elapsed:?}"
    );
}

/// Q21（T09.9）对照：无 abort 时 timeout 语义不回归——超时仍以
/// tool.timeout 收场（竞速只加速 abort，不缩短正常执行窗口）
#[tokio::test]
async fn timeout_still_wins_without_abort() {
    let reg = registry_with(vec![Arc::new(SlowTool { ms: 60_000 })]);
    let exec = ToolExecutor::new(reg);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        timeout: Duration::from_millis(80),
        ..Default::default()
    };
    let abort = AbortSignal::new();
    let out = exec
        .execute_batch(&calls, &exec_ctx(), None, &opts, Some(&abort))
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
    assert!(!abort.is_aborted(), "未触发 abort 的对照场景");
}
