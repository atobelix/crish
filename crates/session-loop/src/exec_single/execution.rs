use std::sync::Arc;

use agent_tools::definition::{Tool, ToolError};
use agent_tools::executor::{
    execute_stream_with_output_policy, ExecutorContext, ToolExecutionPolicy,
};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::ToolContext;
use serde_json::Value;

use super::super::*;
use super::types::*;

impl ToolExecutor {
    pub(crate) async fn execute_single(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
        attempt: u32,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let tool = match self.registry.get(&call.tool_name) {
            Some(t) => t,
            None => return (Self::not_found_result(call), Vec::new()),
        };
        if !self.registry.is_tool_enabled(&call.tool_name) {
            return (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::UserDenied,
                    format!("tool disabled: {}", call.tool_name),
                    0,
                ),
                Vec::new(),
            );
        }
        // 能力 gate（运行中升级/降级即时生效；注册表裁剪只是纵深防御）
        if let Some(capability) = options.capability_cell.as_ref() {
            if !capability.allows_tool(&call.tool_name) {
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::PolicyBlocked,
                        conex_agents::capability::denial_message(
                            &call.tool_name,
                            capability.effective(),
                        ),
                        0,
                    ),
                    Vec::new(),
                );
            }
        }
        let (tool_ctx, approval_channel, mw_ctx, exec_ctx, abort_token) =
            self.build_execution_contexts(call, ctx, options, abort, &approval);
        let pre = self
            .run_pre_checks(tool.as_ref(), call, ctx, &mw_ctx, abort)
            .await;
        let exec_input = match pre {
            PreExecOutcome::Aborted => {
                abort_token.abort();
                return (Self::cancelled_result(call, 0), Vec::new());
            }
            PreExecOutcome::Blocked(reason) => {
                return (Self::blocked_result(call, reason), Vec::new());
            }
            PreExecOutcome::Proceed(v) => v,
        };
        let policy = ToolExecutionPolicy {
            output_budget_bytes: options.output_budget_bytes,
            idempotency: self.idempotency.is_some(),
        };
        let guard = self.idempotency.clone();
        let start = std::time::Instant::now();
        let outcome = self
            .race_execution(RaceExecParams {
                tool: tool.as_ref(),
                exec_input: exec_input.clone(),
                tool_ctx: &tool_ctx,
                exec_ctx: &exec_ctx,
                guard: guard.as_ref().map(|v| v.as_ref()),
                policy: &policy,
                timeout: options.timeout,
                abort,
            })
            .await;
        let duration_ms = start.elapsed().as_millis() as u64;
        let occurred_at_ms = conex_shared::time::unix_millis() as u64;
        let recorded = approval_channel
            .as_ref()
            .map(|c| c.take_recorded())
            .unwrap_or_default();
        if abort.map(|s| s.is_aborted()).unwrap_or(false) {
            tool_ctx.abort_token.abort();
            let mut r = Self::cancelled_result(call, duration_ms);
            r.attempt = attempt;
            r.executed_input = Some(exec_input);
            r.occurred_at_ms = Some(occurred_at_ms);
            return (r, recorded);
        }
        let post_cx = PostExecContext {
            tool: tool.as_ref(),
            call,
            ctx,
            mw_ctx: &mw_ctx,
        };
        let timing = ExecTiming {
            attempt,
            duration_ms,
            occurred_at_ms,
        };
        self.handle_execution_outcome(outcome, &post_cx, timing, exec_input, recorded)
            .await
    }

    async fn race_execution(
        &self,
        p: RaceExecParams<'_>,
    ) -> Option<
        Result<Result<agent_tools::executor::ToolResult, ToolError>, tokio::time::error::Elapsed>,
    > {
        let execute = async move {
            if let Some(g) = p.guard {
                execute_stream_with_output_policy(
                    p.tool,
                    p.exec_input,
                    p.tool_ctx,
                    p.exec_ctx,
                    Some(g),
                    p.policy,
                    None,
                )
                .await
            } else {
                execute_stream_with_output_policy(
                    p.tool,
                    p.exec_input,
                    p.tool_ctx,
                    p.exec_ctx,
                    None,
                    p.policy,
                    None,
                )
                .await
            }
        };
        match p.abort {
            Some(sig) => tokio::select! {
                biased;
                _ = sig.wait_aborted() => {
                    p.tool_ctx.abort_token.abort();
                    None
                }
                res = tokio::time::timeout(p.timeout, execute) => Some(res),
            },
            None => Some(tokio::time::timeout(p.timeout, execute).await),
        }
    }

    pub(crate) async fn execute_single_with_retry(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let (result, mut events) = self
            .execute_single(call, ctx, options, abort, approval.clone(), 1)
            .await;
        // 工具返回 tool.requires_approval → 发起第二次真实审批，批准后重试执行
        // （T10：requires_approval 不再折叠为软拒绝；无门时保持 ApprovalRequired 透传）
        if result.error_kind != Some(ToolErrorKind::ApprovalRequired) {
            return (result, events);
        }
        // Full 模式不发起审批（工具返回 ApprovalRequired 原样喂回模型）
        if options.effective_permission_mode() == PermissionMode::Full {
            return (result, events);
        }
        let Some(gate) = approval else {
            return (result, events);
        };
        let requester = self.approval_requester_for(ctx, &call.input);
        events.push(ToolEvent::ApprovalRequested {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            args: call.input.clone(),
            requester: requester.clone(),
            reason: Some(format!("工具 {} 请求执行审批", call.tool_name)),
        });
        match approval_wait(
            gate.as_ref(),
            &call.id,
            &call.tool_name,
            &call.input,
            requester.as_ref(),
            Some("工具执行请求审批"),
            abort,
            options.approval_timeout,
        )
        .await
        {
            ApprovalWaitOutcome::Cancelled => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                    0,
                ),
                events,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                let (retried, extra) = self
                    .execute_single(call, ctx, options, abort, Some(gate), 2)
                    .await;
                events.extend(extra);
                (retried, events)
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::UserDenied,
                    denied_message(requester.is_some(), &reason),
                    0,
                ),
                events,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                events.push(ToolEvent::ApprovalResolved {
                    call_id: call.id.clone(),
                    decision: ApprovalDecision::Expired,
                });
                (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::ApprovalExpired,
                        "approval expired",
                        0,
                    ),
                    events,
                )
            }
        }
    }
}
