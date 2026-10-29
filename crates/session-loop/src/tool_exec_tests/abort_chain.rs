//! 中止链回归（SL-01 / R2）：工具级令牌为 Run 信号子令牌，不派生监听任务

use super::super::*;
use super::fixture::*;
use conex_types::tool::ToolConcurrency;
use std::sync::Arc;
use std::time::Duration;

/// R2：携带 Run 信号执行 100 次工具调用，正常收尾后存活任务数回到基线
/// （旧实现每次调用 spawn 一个永不触发的监听任务，此处会多出 100 个）
#[tokio::test]
async fn tool_calls_under_signal_leave_no_alive_tasks() {
    let exec = ToolExecutor::new(registry_with(vec![Arc::new(EchoTool)]));
    let calls: Vec<_> = (0..100)
        .map(|i| call(&format!("c{i}"), "echo", ToolConcurrency::Sequential))
        .collect();
    let signal = AbortSignal::new();
    let metrics = tokio::runtime::Handle::current().metrics();
    let baseline = metrics.num_alive_tasks();

    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            Some(&signal),
        )
        .await;

    assert_eq!(out.results.len(), 100);
    assert!(
        out.results.iter().all(|r| r.is_ok()),
        "100 次调用应全部成功"
    );
    assert_eq!(
        metrics.num_alive_tasks(),
        baseline,
        "工具执行不得遗留后台监听任务"
    );
}

/// Run 信号中止经子令牌立即取消在途工具（无需监听任务转发）
#[tokio::test]
async fn signal_abort_cancels_in_flight_tool_via_child_token() {
    let exec = ToolExecutor::new(registry_with(vec![Arc::new(SlowTool { ms: 10_000 })]));
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let signal = AbortSignal::new();
    let ctx = exec_ctx();
    let options = ToolBatchOptions::default();
    let run = tokio::time::timeout(
        Duration::from_secs(2),
        exec.execute_batch(&calls, &ctx, None, &options, Some(&signal)),
    );
    let fire = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        signal.abort();
    };
    let (out, ()) = tokio::join!(run, fire);
    let out = out.expect("中止后批处理应及时收场");
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
}
