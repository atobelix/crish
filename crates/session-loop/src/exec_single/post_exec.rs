use agent_tools::definition::{Tool, ToolError};
use serde_json::Value;

use super::super::*;
use super::types::*;

impl ToolExecutor {
    pub(super) async fn handle_execution_outcome(
        &self,
        outcome: Option<
            Result<
                Result<agent_tools::executor::ToolResult, ToolError>,
                tokio::time::error::Elapsed,
            >,
        >,
        cx: &PostExecContext<'_>,
        timing: ExecTiming,
        exec_input: Value,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        match outcome {
            None => {
                let mut r = Self::cancelled_result(cx.call, timing.duration_ms);
                r.attempt = timing.attempt;
                r.executed_input = Some(exec_input);
                r.occurred_at_ms = Some(timing.occurred_at_ms);
                (r, recorded)
            }
            Some(Err(_)) => {
                let mut r = ClassifiedToolResult::error(
                    &cx.call.id,
                    &cx.call.tool_name,
                    ToolErrorKind::Timeout,
                    format!(
                        "tool {} timed out after {:?}",
                        cx.call.tool_name,
                        std::time::Duration::from_millis(timing.duration_ms)
                    ),
                    timing.duration_ms,
                );
                r.attempt = timing.attempt;
                r.executed_input = Some(exec_input);
                r.occurred_at_ms = Some(timing.occurred_at_ms);
                (r, recorded)
            }
            Some(Ok(Ok(tool_result))) => {
                if tool_result.deduplicated {
                    self.handle_dedup_success(tool_result, cx, timing, exec_input, recorded)
                        .await
                } else {
                    self.handle_success_with_middleware(
                        tool_result,
                        cx,
                        timing,
                        exec_input,
                        recorded,
                    )
                    .await
                }
            }
            Some(Ok(Err(err))) => {
                self.handle_error_branch(err, cx, timing, exec_input, recorded)
                    .await
            }
        }
    }

    async fn handle_dedup_success(
        &self,
        tool_result: agent_tools::executor::ToolResult,
        cx: &PostExecContext<'_>,
        timing: ExecTiming,
        exec_input: Value,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        if let Some(hooks) = &self.hooks {
            // 观察面分派：失败只记日志，不阻断工具结果（BLK-05：不得丢弃赋值吞错）
            if let Err(err) = hooks
                .dispatch(&HookEvent::ToolPost {
                    session_id: cx.ctx.session_id.clone(),
                    tool_name: cx.call.tool_name.clone(),
                    output: tool_result.output.clone(),
                    duration_ms: 0,
                    is_error: false,
                })
                .await
            {
                tracing::warn!(
                    tool_name = %cx.call.tool_name,
                    error = %err,
                    "tool.post hook 分派失败（去重命中路径，观察面不阻断工具结果）"
                );
            }
        }
        // U-OUT-RS：ok() 内部包 Arc——出口共享边界自此建立
        let mut r =
            ClassifiedToolResult::ok(&cx.call.id, &cx.call.tool_name, tool_result.output, 0);
        r.attempt = timing.attempt;
        r.deduplicated = true;
        // SL-PERF-12：直接移交所有权，避免 Value 深克隆
        r.executed_input = Some(exec_input);
        r.occurred_at_ms = Some(timing.occurred_at_ms);
        (r, recorded)
    }

    async fn handle_success_with_middleware(
        &self,
        tool_result: agent_tools::executor::ToolResult,
        cx: &PostExecContext<'_>,
        timing: ExecTiming,
        exec_input: Value,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        // U-OUT-RS：中间件链仍操作 Value；ok() 收口时包 Arc 作出口共享
        // SL-PERF-12：无中间件时直接使用工具原生输出，不进入链式处理
        let final_output = if self.middleware.is_empty() {
            tool_result.output
        } else {
            self.apply_on_result_chain(cx.tool, &exec_input, tool_result.output, cx.mw_ctx)
                .await
        };
        if let Some(hooks) = &self.hooks {
            // 观察面分派：失败只记日志，不阻断工具结果（BLK-05）
            if let Err(err) = hooks
                .dispatch(&HookEvent::ToolPost {
                    session_id: cx.ctx.session_id.clone(),
                    tool_name: cx.call.tool_name.clone(),
                    output: final_output.clone(),
                    duration_ms: timing.duration_ms,
                    is_error: false,
                })
                .await
            {
                tracing::warn!(
                    tool_name = %cx.call.tool_name,
                    error = %err,
                    "tool.post hook 分派失败（成功路径，观察面不阻断工具结果）"
                );
            }
        }
        let mut r = ClassifiedToolResult::ok(
            &cx.call.id,
            &cx.call.tool_name,
            final_output,
            timing.duration_ms,
        );
        r.attempt = timing.attempt;
        // SL-PERF-12：直接移交所有权，避免 Value 深克隆
        r.executed_input = Some(exec_input);
        r.occurred_at_ms = Some(timing.occurred_at_ms);
        (r, recorded)
    }

    pub(super) async fn apply_on_result_chain(
        &self,
        tool: &dyn Tool,
        input: &Value,
        mut output: Value,
        mw_ctx: &ToolExecutionContext,
    ) -> Value {
        if self.middleware.is_empty() {
            return output;
        }
        for m in &self.middleware {
            let result = run_hook_with_timeout(
                self.middleware_timeouts.on_result,
                None,
                m.on_result(tool, input, output.clone(), mw_ctx),
            )
            .await;
            match result {
                Some(Ok(Ok(AfterExecuteResult::Passthrough))) => {}
                Some(Ok(Ok(AfterExecuteResult::Replace(v)))) => output = v,
                Some(Ok(Err(e))) => {
                    tracing::error!(middleware = %m.name(), error = %e, "中间件 on_result 失败，降级透传原输出");
                }
                Some(Err(_)) => {
                    tracing::error!(middleware = %m.name(), timeout_ms = self.middleware_timeouts.on_result.as_millis(), "中间件 on_result 超时，降级透传原输出");
                }
                None => {
                    tracing::error!(middleware = %m.name(), "中间件 on_result 竞速异常，降级透传原输出");
                }
            }
        }
        output
    }

    async fn handle_error_branch(
        &self,
        err: ToolError,
        cx: &PostExecContext<'_>,
        timing: ExecTiming,
        exec_input: Value,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        if !self.middleware.is_empty() {
            self.apply_on_error_chain(cx.tool, &exec_input, &err, cx.mw_ctx)
                .await;
        }
        if let Some(hooks) = &self.hooks {
            // 观察面分派（失败路径两条事件）：失败只记日志，不覆盖工具错误本身
            // （BLK-05：不得丢弃赋值吞错）
            if let Err(hook_err) = hooks
                .dispatch(&HookEvent::ToolPost {
                    session_id: cx.ctx.session_id.clone(),
                    tool_name: cx.call.tool_name.clone(),
                    output: serde_json::json!(err.to_string()),
                    duration_ms: timing.duration_ms,
                    is_error: true,
                })
                .await
            {
                tracing::warn!(
                    tool_name = %cx.call.tool_name,
                    error = %hook_err,
                    "tool.post hook 分派失败（失败路径，观察面不阻断）"
                );
            }
            if let Err(hook_err) = hooks
                .dispatch(&HookEvent::ToolError {
                    session_id: cx.ctx.session_id.clone(),
                    tool_name: cx.call.tool_name.clone(),
                    error: err.to_string(),
                })
                .await
            {
                tracing::warn!(
                    tool_name = %cx.call.tool_name,
                    error = %hook_err,
                    "tool.error hook 分派失败（失败路径，观察面不阻断）"
                );
            }
        }
        let (kind, msg) = classify_tool_error(&err);
        let mut r = ClassifiedToolResult::error(
            &cx.call.id,
            &cx.call.tool_name,
            kind,
            msg,
            timing.duration_ms,
        );
        r.attempt = timing.attempt;
        // SL-PERF-12：直接移交所有权，避免 Value 深克隆
        r.executed_input = Some(exec_input);
        r.occurred_at_ms = Some(timing.occurred_at_ms);
        (r, recorded)
    }

    pub(super) async fn apply_on_error_chain(
        &self,
        tool: &dyn Tool,
        input: &Value,
        err: &ToolError,
        mw_ctx: &ToolExecutionContext,
    ) {
        if self.middleware.is_empty() {
            return;
        }
        for m in &self.middleware {
            let result = run_hook_with_timeout(
                self.middleware_timeouts.on_error,
                None,
                m.on_error(tool, input, err, mw_ctx),
            )
            .await;
            match result {
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(e))) => {
                    tracing::error!(middleware = %m.name(), error = %e, "中间件 on_error 失败（仅观察，不吞原错误）");
                }
                Some(Err(_)) => {
                    tracing::error!(middleware = %m.name(), timeout_ms = self.middleware_timeouts.on_error.as_millis(), "中间件 on_error 超时（仅观察，不吞原错误）");
                }
                None => {
                    tracing::error!(middleware = %m.name(), "中间件 on_error 竞速异常（仅观察，不吞原错误）");
                }
            }
        }
    }
}
