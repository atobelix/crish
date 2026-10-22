use super::super::*;
use super::fixture::*;
use super::middleware::PrefixMiddleware;
use crate::safe_point::AbortSignal;
use agent_tools::definition::{Tool, ToolError};
use agent_tools::middleware::{
    AfterExecuteResult, BeforeExecuteResult, MiddlewareTimeoutConfig, ToolExecutionContext,
    ToolMiddleware,
};
use async_trait::async_trait;
use conex_types::tool::ToolConcurrency;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ── E4：middleware 超时竞速窗口（06 遗留 :148-152 收口）──────────

/// 慢 before_execute 中间件：sleep 后放行（超时竞速断言用）
struct SlowBeforeMiddleware {
    name: String,
    sleep_ms: u64,
}
#[async_trait]
impl ToolMiddleware for SlowBeforeMiddleware {
    fn name(&self) -> &str {
        &self.name
    }
    async fn before_execute(
        &self,
        _tool: &dyn Tool,
        input: Value,
        _ctx: &ToolExecutionContext,
    ) -> Result<BeforeExecuteResult, ToolError> {
        tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
        Ok(BeforeExecuteResult::Proceed {
            modified_input: Some(input),
        })
    }
}

/// 慢 on_result / on_error 中间件：sleep 后透传（超时降级断言用）
struct SlowAfterMiddleware {
    name: String,
    sleep_ms: u64,
}
#[async_trait]
impl ToolMiddleware for SlowAfterMiddleware {
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
        tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
        Ok(AfterExecuteResult::Passthrough)
    }
}

/// before_execute 超时 → 视为 Err → Block（守门者报错 = 不放行，
/// 06:57）：工具未执行、结果 ExecutionFailed、文案含中间件名与超时
#[tokio::test]
async fn middleware_before_timeout_blocks_tool() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let timeouts = MiddlewareTimeoutConfig {
        before_execute: Duration::from_millis(1),
        ..MiddlewareTimeoutConfig::default()
    };
    let exec = ToolExecutor::new(reg)
        .with_middleware(vec![Arc::new(SlowBeforeMiddleware {
            name: "slow".into(),
            sleep_ms: 300,
        })])
        .with_middleware_timeouts(timeouts);
    let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
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
            .contains("slow"),
        "超时阻止文案应携带中间件名：{:?}",
        r.error_message
    );
    assert!(
        r.error_message
            .as_deref()
            .unwrap_or_default()
            .contains("超时"),
        "超时阻止文案应标注超时：{:?}",
        r.error_message
    );
    assert_eq!(
        tool.calls.load(Ordering::SeqCst),
        0,
        "超时阻止时工具不应执行"
    );
}

/// on_result 超时 → 日志 + 降级透传原输出（06:58）
#[tokio::test]
async fn middleware_on_result_timeout_degrades_to_passthrough() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let timeouts = MiddlewareTimeoutConfig {
        on_result: Duration::from_millis(1),
        ..MiddlewareTimeoutConfig::default()
    };
    let exec = ToolExecutor::new(reg)
        .with_middleware(vec![Arc::new(SlowAfterMiddleware {
            name: "slow-after".into(),
            sleep_ms: 300,
        })])
        .with_middleware_timeouts(timeouts);
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
    assert!(out.results[0].is_ok(), "on_result 超时应降级透传原输出");
    assert_eq!(
        out.results[0].output,
        serde_json::json!({ "v": "c1" }).into()
    );
}

/// on_error 超时 → 仅日志（06:59）：原错误结果保持（不吞错）
#[tokio::test]
async fn middleware_on_error_timeout_keeps_error_result() {
    let reg = registry_with(vec![Arc::new(FailTool)]);
    let timeouts = MiddlewareTimeoutConfig {
        on_error: Duration::from_millis(1),
        ..MiddlewareTimeoutConfig::default()
    };
    let exec = ToolExecutor::new(reg)
        .with_middleware(vec![Arc::new(SlowAfterMiddleware {
            name: "slow-error".into(),
            sleep_ms: 300,
        })])
        .with_middleware_timeouts(timeouts);
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
    // 工具失败结果原样保持（on_error 超时只影响观察链，不改变结果）
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::ExecutionFailed)
    );
    assert!(out.results[0]
        .error_message
        .as_deref()
        .unwrap_or_default()
        .contains("boom"));
}

/// 默认超时 = 宽松放行：快中间件在默认竞速窗口内正常通过（现有
/// 中间件语义不受引入超时窗口影响）
#[tokio::test]
async fn middleware_default_timeouts_allow_fast_hooks() {
    let reg = registry_with(vec![Arc::new(EchoTool)]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(PrefixMiddleware {
        name: "prefix".into(),
        suffix: "-ok".into(),
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
    assert!(out.results[0].is_ok(), "默认超时下快中间件正常放行");
    assert_eq!(
        out.results[0].output.get("v"),
        Some(&Value::String("c1-ok".into()))
    );
}

/// 超时窗口内 abort 可取消：before 链执行期间 abort 触发 →
/// 调用取消（Cancelled），工具不执行
#[tokio::test]
async fn middleware_before_abort_cancels_call() {
    let tool = Arc::new(CountingEchoTool {
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
    let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(SlowBeforeMiddleware {
        name: "slow".into(),
        sleep_ms: 300,
    })]);
    let sig = AbortSignal::new();
    let abort = sig.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        abort.abort();
    });
    let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
    let out = exec
        .execute_batch(
            &calls,
            &exec_ctx(),
            None,
            &ToolBatchOptions::default(),
            Some(&sig),
        )
        .await;
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
    assert_eq!(
        tool.calls.load(Ordering::SeqCst),
        0,
        "abort 取消后工具不应执行"
    );
}
