//! 中止链回归（SL-01 / R2）：工具级令牌为 Run 信号子令牌，不派生监听任务

use super::super::*;
use super::fixture::*;
use agent_tools::context::ToolContext;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use conex_types::tool::ToolConcurrency;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;

fn test_definition(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: format!("{name} test tool"),
        input_schema: serde_json::json!({"type": "object"}),
        dangerous: false,
        fatal_on_error: false,
    }
}

/// 测试工具：开始执行即发出就绪通知，随后永久挂起（只能被取消收场）
struct GateTool {
    started: Arc<Notify>,
}
#[async_trait::async_trait]
impl Tool for GateTool {
    fn name(&self) -> &str {
        "gate"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| test_definition("gate"))
    }
    async fn execute(&self, _ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        // notify_one 存许可：即便等待方稍后才 await 也不会丢通知
        self.started.notify_one();
        std::future::pending::<Result<Value, ToolError>>().await
    }
}

/// 测试工具：中止自己的令牌后返回结果（工具级自取消）
struct SelfAbortTool;
#[async_trait::async_trait]
impl Tool for SelfAbortTool {
    fn name(&self) -> &str {
        "self_abort"
    }
    fn definition(&self) -> &ToolDefinition {
        static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
        DEF.get_or_init(|| test_definition("self_abort"))
    }
    async fn execute(&self, ctx: &ToolContext, _args: Value) -> Result<Value, ToolError> {
        ctx.abort_token.abort();
        assert!(ctx.abort_token.is_aborted());
        Ok(serde_json::json!({"done": true}))
    }
}

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

/// Run 信号中止立即取消在途工具（无需监听任务转发）。
/// 确定性：工具开始执行后才触发中止（就绪通知同步），工具本身永不完成，
/// 只能经中止收场；外层超时仅作回归时防挂死的兜底，不参与判定。
#[tokio::test]
async fn signal_abort_cancels_in_flight_tool_via_child_token() {
    let started = Arc::new(Notify::new());
    let gate = GateTool {
        started: started.clone(),
    };
    let exec = ToolExecutor::new(registry_with(vec![Arc::new(gate)]));
    let calls = vec![call("c1", "gate", ToolConcurrency::Sequential)];
    let signal = AbortSignal::new();
    let ctx = exec_ctx();
    let options = ToolBatchOptions::default();
    let run = tokio::time::timeout(
        Duration::from_secs(30),
        exec.execute_batch(&calls, &ctx, None, &options, Some(&signal)),
    );
    let fire = async {
        started.notified().await;
        signal.abort();
    };
    let (out, ()) = tokio::join!(run, fire);
    let out = out.expect("中止后批处理应收场（工具本身永不完成）");
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
}

/// 工具自中止令牌 = 本次调用被取消（与 agent-tools 执行器 runtime.aborted
/// 收口一致，统一为 Cancelled）；令牌中止不回传 Run 信号，批内后续调用照常执行
#[tokio::test]
async fn tool_self_abort_cancels_only_that_call() {
    let exec = ToolExecutor::new(registry_with(vec![
        Arc::new(SelfAbortTool),
        Arc::new(EchoTool),
    ]));
    let calls = vec![
        call("c1", "self_abort", ToolConcurrency::Sequential),
        call("c2", "echo", ToolConcurrency::Sequential),
    ];
    let signal = AbortSignal::new();
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            Some(&signal),
        )
        .await;
    assert_eq!(out.results.len(), 2);
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert!(out.results[1].is_ok(), "批内后续调用不受影响");
    assert!(!signal.is_aborted(), "工具令牌中止不应回传 Run 信号");
}
