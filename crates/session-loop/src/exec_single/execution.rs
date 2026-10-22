use std::sync::Arc;

use agent_tools::definition::{Tool, ToolError};
use agent_tools::executor::{
    execute_stream_with_output_policy, ExecutorContext, ToolExecutionPolicy,
};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::permission::{decide, PermissionVerdict};
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
        let call_cx = ExecCallContext {
            call,
            ctx,
            options,
            abort,
            approval,
        };
        let (r, extra) = self
            .execute_single(
                call_cx.call,
                call_cx.ctx,
                call_cx.options,
                call_cx.abort,
                call_cx.approval.clone(),
                1,
            )
            .await;
        if r.error_kind != Some(ToolErrorKind::ApprovalRequired) {
            return (r, extra);
        }
        self.handle_retry_after_approval_required(&call_cx, r, extra)
            .await
    }

    async fn handle_retry_after_approval_required(
        &self,
        cx: &ExecCallContext<'_>,
        _initial_result: ClassifiedToolResult,
        extra: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let verdict = match cx.options.permission_mode {
            Some(mode) => decide(false, true, mode),
            None => PermissionVerdict::NeedsApproval,
        };
        match verdict {
            PermissionVerdict::Deny => (
                denied_result(cx.call, cx.options, Some(&self.registry)),
                extra,
            ),
            PermissionVerdict::Allow => self.retry_after_allow(cx, extra).await,
            PermissionVerdict::NeedsApproval => self.handle_retry_needs_approval(cx, extra).await,
        }
    }

    async fn retry_after_allow(
        &self,
        cx: &ExecCallContext<'_>,
        extra: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let (r2, extra2) = self
            .execute_single(
                cx.call,
                cx.ctx,
                cx.options,
                cx.abort,
                cx.approval.clone(),
                2,
            )
            .await;
        (r2, [extra, extra2].concat())
    }

    async fn handle_retry_needs_approval(
        &self,
        cx: &ExecCallContext<'_>,
        extra: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let Some(gate) = cx.approval.as_ref() else {
            return (
                ClassifiedToolResult::error(
                    &cx.call.id,
                    &cx.call.tool_name,
                    ToolErrorKind::ApprovalRequired,
                    self.revert_refusal_message(cx.call),
                    0,
                ),
                extra,
            );
        };
        let mut extra_mut = extra;
        let requester = self.approval_requester_for(cx.ctx, &cx.call.input);
        extra_mut.push(ToolEvent::ApprovalRequested {
            call_id: cx.call.id.clone(),
            tool_name: cx.call.tool_name.clone(),
            args: cx.call.input.clone(),
            requester: requester.clone(),
        });
        match approval_wait(
            &**gate,
            &cx.call.id,
            &cx.call.tool_name,
            &cx.call.input,
            requester.as_ref(),
            cx.abort,
            cx.options.approval_timeout,
        )
        .await
        {
            ApprovalWaitOutcome::Cancelled => (
                ClassifiedToolResult::error(
                    &cx.call.id,
                    &cx.call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                    0,
                ),
                extra_mut,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                let (r2, extra2) = self
                    .execute_single(
                        cx.call,
                        cx.ctx,
                        cx.options,
                        cx.abort,
                        Some(Arc::clone(gate)),
                        2,
                    )
                    .await;
                (r2, [extra_mut, extra2].concat())
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => (
                ClassifiedToolResult::error(
                    &cx.call.id,
                    &cx.call.tool_name,
                    ToolErrorKind::UserDenied,
                    denied_message(requester.is_some(), &reason),
                    0,
                ),
                extra_mut,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                extra_mut.push(ToolEvent::ApprovalResolved {
                    call_id: cx.call.id.clone(),
                    decision: ApprovalDecision::Expired,
                });
                (
                    ClassifiedToolResult::error(
                        &cx.call.id,
                        &cx.call.tool_name,
                        ToolErrorKind::ApprovalExpired,
                        "approval expired",
                        0,
                    ),
                    extra_mut,
                )
            }
        }
    }
}
