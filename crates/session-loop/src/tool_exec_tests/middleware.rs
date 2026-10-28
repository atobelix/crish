use super::super::*;
use super::approval_fixture::*;
use super::fixture::*;
use agent_tools::definition::{Tool, ToolError};
use agent_tools::middleware::{
    AfterExecuteResult, BeforeExecuteResult, ToolExecutionContext, ToolMiddleware,
};
use agent_tools::permission::PermissionMode;
use async_trait::async_trait;
use conex_types::tool::{ToolBatchCall, ToolConcurrency};
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// 修改入参的中间件：为 {"v": "x"} 追加后缀（验证 before 链可改输入）
pub(super) struct PrefixMiddleware {
    pub(super) name: String,
    pub(super) suffix: String,
}
#[async_trait]
impl ToolMiddleware for PrefixMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        mut input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        if let Some(v) = input.get_mut("v") {
            if let Some(s) = v.as_str() {
                *v = Value::String(format!("{s}{}", self.suffix));
            }
        }
        Ok(BeforeExecuteResult::Proceed {
            modified_input: Some(input),
        })
    }
}

/// 按入参 block 标记阻止执行的中间件
pub(super) struct BlockingMiddleware {
    pub(super) name: String,
}
#[async_trait]
impl ToolMiddleware for BlockingMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        if input.get("block").and_then(Value::as_bool) == Some(true) {
            Ok(BeforeExecuteResult::Block {
                reason: "策略拦截".into(),
            })
        } else {
            Ok(BeforeExecuteResult::Proceed {
                modified_input: None,
            })
        }
    }
}

/// 替换输出的中间件（验证 on_result 改写）
pub(super) struct ReplaceMiddleware {
    pub(super) name: String,
    pub(super) replacement: Value,
}
#[async_trait]
impl ToolMiddleware for ReplaceMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_result(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        Ok(AfterExecuteResult::Replace(self.replacement.clone()))
    }
}

/// 恒失败的 on_result 中间件（验证降级透传）
pub(super) struct FailingAfterMiddleware {
    pub(super) name: String,
}
#[async_trait]
impl ToolMiddleware for FailingAfterMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_result(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _output: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<AfterExecuteResult, ToolError> {
        Err(ToolError::execution_failed("failing-after", "after boom"))
    }
}

/// 记录 on_error 调用的中间件（验证失败观察）
pub(super) struct ErrorSpyMiddleware {
    pub(super) name: String,
    pub(super) seen: Arc<Mutex<Vec<String>>>,
}
#[async_trait]
impl ToolMiddleware for ErrorSpyMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn on_error(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        error: &ToolError,
        _ctx: &ToolExecutionContext,
    ) -> Result<(), ToolError> {
        self.seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(error.to_string());
        Ok(())
    }
}

/// 计数 before_execute 调用的中间件（审批优先级验证用）
pub(super) struct CallCounterMiddleware {
    pub(super) name: String,
    pub(super) calls: Arc<AtomicUsize>,
}
#[async_trait]
impl ToolMiddleware for CallCounterMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        _input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(BeforeExecuteResult::Proceed {
            modified_input: None,
        })
    }
}

pub(super) fn block_call(id: &str, name: &str) -> ToolBatchCall {
    let mut c = call(id, name, ToolConcurrency::Sequential);
    c.input = serde_json::json!({ "v": id, "block": true });
    c
}

#[tokio::test]
async fn middleware_before_chain_modifies_input() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(PrefixMiddleware {
        name: "prefix".into(),
        suffix: "-mw".into(),
    })]);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert!(out.results[0].is_ok());
    // EchoTool 原样返回入参 → 中间件修改后的入参可见
    assert_eq!(
        out.results[0].output.get("v"),
        Some(&Value::String("c1-mw".into())),
        "before 链应修改入参"
    );
}

#[tokio::test]
async fn middleware_before_block_prevents_execution() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(BlockingMiddleware {
        name: "blocker".into(),
    })]);
    let calls = vec![block_call("c1", "countecho")];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    let r = &out.results[0];
    assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
    assert!(
        r.error_message
            .as_deref()
            .unwrap_or_default()
            .contains("被中间件 blocker 阻止"),
        "阻止文案应携带中间件名：{:?}",
        r.error_message
    );
    assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "被阻止的工具不应执行");
}

#[tokio::test]
async fn middleware_on_result_replace_output() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(ReplaceMiddleware {
        name: "replacer".into(),
        replacement: serde_json::json!({ "wrapped": true }),
    })]);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
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
        out.results[0].output,
        serde_json::json!({ "wrapped": true }).into()
    );
}

#[tokio::test]
async fn middleware_on_error_observes_failure() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let reg = registry_with(vec![Arc::new(FailTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(ErrorSpyMiddleware {
        name: "spy".into(),
        seen: Arc::clone(&seen),
    })]);
    let calls = vec![call("c1", "fail", ToolConcurrency::Sequential)];
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
    let msgs = seen.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(msgs.len(), 1);
    assert!(msgs[0].contains("boom"));
}

#[tokio::test]
async fn middleware_on_result_error_degrades_to_passthrough() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(FailingAfterMiddleware {
        name: "failing".into(),
    })]);
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    // 后置钩子错误：记录日志并降级透传原输出（不改变已完成的执行结果）
    assert!(out.results[0].is_ok(), "on_result 失败应降级透传原输出");
    assert_eq!(
        out.results[0].output,
        serde_json::json!({ "v": "c1" }).into()
    );
}

#[tokio::test]
async fn middleware_empty_chain_is_noop() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(Vec::new());
    let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            None,
        )
        .await;
    assert!(out.results[0].is_ok());
    assert_eq!(
        out.results[0].output,
        serde_json::json!({ "v": "c1" }).into()
    );
}

/// 审批优先于中间件：拒绝时不进入中间件链，通过后中间件参与执行
#[tokio::test]
async fn middleware_runs_after_approval_gate() {
    let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
    let opts = ToolBatchOptions {
        permission_mode: Some(PermissionMode::Ask),
        ..Default::default()
    };

    // 审批拒绝：中间件 before_execute 不被调用（审批优先语义）
    let counter = Arc::new(AtomicUsize::new(0));
    let reg = registry_with(vec![Arc::new(DangerousTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(CallCounterMiddleware {
        name: "counter".into(),
        calls: Arc::clone(&counter),
    })]);
    let gate = MockApproval {
        decision: ApprovalDecision::Denied {
            reason: "no".into(),
        },
    };
    let out = exec
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
    assert_eq!(counter.load(Ordering::SeqCst), 0, "审批拒绝时中间件不参与");

    // 审批通过：中间件进入执行面
    let counter2 = Arc::new(AtomicUsize::new(0));
    let reg2 = registry_with(vec![Arc::new(DangerousTool)]);
    let exec2 = ToolExecutor::new(reg2).with_middleware(vec![Arc::new(CallCounterMiddleware {
        name: "counter".into(),
        calls: Arc::clone(&counter2),
    })]);
    let gate2 = MockApproval {
        decision: ApprovalDecision::Approved,
    };
    let out2 = exec2
        .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate2)), &opts, None)
        .await;
    assert!(out2.results[0].is_ok());
    assert_eq!(
        counter2.load(Ordering::SeqCst),
        1,
        "审批通过后中间件参与执行"
    );
}
