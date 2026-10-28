use std::path::PathBuf;
use std::sync::Arc;

use agent_tools::executor::ExecutorContext;
use agent_tools::permission::PermissionVerdict;
use agent_tools::ToolContext;
use serde_json::Value;

use super::super::*;
use super::types::*;

impl ToolExecutor {
    pub(super) async fn handle_verdict_and_approval(
        &self,
        cx: &ExecCallContext<'_>,
        events: &mut Vec<ToolEvent>,
    ) -> ClassifiedToolResult {
        let mut opts_buf;
        let effective_options = if cx.options.task_type.is_none() && cx.ctx.task_type.is_some() {
            opts_buf = cx.options.clone();
            opts_buf.task_type = cx.ctx.task_type.clone();
            &opts_buf
        } else {
            cx.options
        };
        let decision = self.call_verdict_detailed(cx.call, effective_options);
        // 审批门只在非 Full 模式生效（permission_mode = 单一准绳；
        // approval_enabled 字段已废弃，不再参与门控）
        let approval_active = cx.approval.is_some()
            && effective_options.effective_permission_mode() != PermissionMode::Full;
        match (&cx.approval, approval_active) {
            (Some(gate), true) => self.handle_gated_verdict(cx, gate, events, decision).await,
            _ => {
                self.handle_ungated_verdict(cx, events, decision.verdict)
                    .await
            }
        }
    }

    async fn handle_gated_verdict(
        &self,
        cx: &ExecCallContext<'_>,
        gate: &Arc<dyn ApprovalGate>,
        events: &mut Vec<ToolEvent>,
        decision: VerdictDecision,
    ) -> ClassifiedToolResult {
        match decision.verdict {
            PermissionVerdict::Allow => {
                let (r, extra) = self
                    .execute_single_with_retry(
                        cx.call,
                        cx.ctx,
                        cx.options,
                        cx.abort,
                        Some(Arc::clone(gate)),
                    )
                    .await;
                events.extend(extra);
                r
            }
            PermissionVerdict::Deny => denied_result(cx.call, cx.options, Some(&self.registry)),
            PermissionVerdict::NeedsApproval => {
                self.handle_gated_needs_approval(cx, gate, events, decision.reason)
                    .await
            }
        }
    }

    async fn handle_gated_needs_approval(
        &self,
        cx: &ExecCallContext<'_>,
        gate: &Arc<dyn ApprovalGate>,
        events: &mut Vec<ToolEvent>,
        reason: Option<String>,
    ) -> ClassifiedToolResult {
        let requester = self.approval_requester_for(cx.ctx, &cx.call.input);
        events.push(ToolEvent::ApprovalRequested {
            call_id: cx.call.id.clone(),
            tool_name: cx.call.tool_name.clone(),
            args: cx.call.input.clone(),
            requester: requester.clone(),
            reason: reason.clone(),
        });
        match approval_wait(
            gate.as_ref(),
            &cx.call.id,
            &cx.call.tool_name,
            &cx.call.input,
            requester.as_ref(),
            reason.as_deref(),
            cx.abort,
            cx.options.approval_timeout,
        )
        .await
        {
            ApprovalWaitOutcome::Cancelled => ClassifiedToolResult::error(
                &cx.call.id,
                &cx.call.tool_name,
                ToolErrorKind::Cancelled,
                "aborted",
                0,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                let (r, extra) = self
                    .execute_single_with_retry(
                        cx.call,
                        cx.ctx,
                        cx.options,
                        cx.abort,
                        Some(Arc::clone(gate)),
                    )
                    .await;
                events.extend(extra);
                r
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => {
                ClassifiedToolResult::error(
                    &cx.call.id,
                    &cx.call.tool_name,
                    ToolErrorKind::UserDenied,
                    denied_message(requester.is_some(), &reason),
                    0,
                )
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                events.push(ToolEvent::ApprovalResolved {
                    call_id: cx.call.id.clone(),
                    decision: ApprovalDecision::Expired,
                });
                ClassifiedToolResult::error(
                    &cx.call.id,
                    &cx.call.tool_name,
                    ToolErrorKind::ApprovalExpired,
                    "approval expired",
                    0,
                )
            }
        }
    }

    async fn handle_ungated_verdict(
        &self,
        cx: &ExecCallContext<'_>,
        events: &mut Vec<ToolEvent>,
        verdict: PermissionVerdict,
    ) -> ClassifiedToolResult {
        match verdict {
            PermissionVerdict::Deny => denied_result(cx.call, cx.options, Some(&self.registry)),
            PermissionVerdict::NeedsApproval => ClassifiedToolResult::error(
                &cx.call.id,
                &cx.call.tool_name,
                ToolErrorKind::ApprovalRequired,
                self.revert_refusal_message(cx.call),
                0,
            ),
            PermissionVerdict::Allow => {
                let (r, extra) = self
                    .execute_single_with_retry(
                        cx.call,
                        cx.ctx,
                        cx.options,
                        cx.abort,
                        cx.approval.clone(),
                    )
                    .await;
                events.extend(extra);
                r
            }
        }
    }

    pub(super) fn build_execution_contexts(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        _approval: &Option<Arc<dyn ApprovalGate>>,
    ) -> (
        ToolContext,
        Option<Arc<ApprovalChannel>>,
        ToolExecutionContext,
        ExecutorContext,
        AbortToken,
    ) {
        let exec_ctx = ExecutorContext {
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            tool_call_id: Some(call.id.clone()),
            cwd: ctx.cwd.clone(),
        };
        let abort_token = AbortToken::new();
        // BC03-1 / 04A / 04B：将 Run 级 AbortSignal 与工具级 AbortToken 物理绑定
        if let Some(signal) = abort {
            if signal.is_aborted() {
                abort_token.abort();
            } else {
                let sig_clone = signal.clone();
                let tok_clone = abort_token.clone();
                tokio::spawn(async move {
                    sig_clone.wait_aborted().await;
                    tok_clone.abort();
                });
            }
        }
        let tool_ctx = ToolContext {
            session_id: ctx.session_id.clone(),
            abort_token: abort_token.clone(),
            workspace_root: ctx
                .workspace_root
                .clone()
                .or_else(|| ctx.cwd.clone().map(PathBuf::from))
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
            permission_mode: options.effective_permission_mode(),
            write_claims: ctx.write_claims.clone(),
            write_claim_holder: Some(ctx.run_id.clone()),
            explore_docs_quota: ctx.explore_docs_quota.clone(),
            output_dir: ctx.output_dir.clone(),
            background: ctx.background.clone(),
            log_root: ctx.log_root.clone(),
            compression_store: ctx
                .compression_store
                .clone()
                .or_else(agent_tools::compression_store::global_compression_store),
            note_backend: ctx.note_backend.clone(),
            tool_call_id: Some(call.id.clone()),
            task_type: options.task_type.clone().or_else(|| ctx.task_type.clone()),
        };
        let mw_ctx = ToolExecutionContext {
            session_id: Some(ctx.session_id.clone()),
            run_id: Some(ctx.run_id.clone()),
            tool_call_id: Some(call.id.clone()),
            cwd: ctx.cwd.clone(),
        };
        (tool_ctx, None, mw_ctx, exec_ctx, abort_token)
    }

    pub(super) async fn run_pre_checks(
        &self,
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        mw_ctx: &ToolExecutionContext,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> PreExecOutcome {
        let after_mw = match self.run_middleware_before(tool, call, mw_ctx, abort).await {
            Ok(v) => v,
            Err(e) => return e,
        };
        // SL-PERF-12：无 pre hook 时直接跳过克隆
        if self.hooks.is_some() {
            if let Some(reason) = self.dispatch_pre_hook(call, ctx, after_mw.clone()).await {
                return PreExecOutcome::Blocked(reason);
            }
        }
        PreExecOutcome::Proceed(after_mw)
    }

    pub(super) async fn run_middleware_before(
        &self,
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        mw_ctx: &ToolExecutionContext,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> Result<Value, PreExecOutcome> {
        // SL-PERF-12：无中间件时零冗余深拷贝
        if self.middleware.is_empty() {
            return Ok(call.input.clone());
        }
        let mut current_input: Option<Value> = None;
        for m in &self.middleware {
            let input_for_mw = current_input.as_ref().unwrap_or(&call.input).clone();
            let result = run_hook_with_timeout(
                self.middleware_timeouts.before_execute,
                abort,
                m.before_execute(tool, input_for_mw, mw_ctx),
            )
            .await;
            let Some(result) = result else {
                return Err(PreExecOutcome::Aborted);
            };
            match result {
                Ok(Ok(BeforeExecuteResult::Proceed { modified_input })) => {
                    if let Some(v) = modified_input {
                        current_input = Some(v);
                    }
                }
                Ok(Ok(BeforeExecuteResult::Block { reason })) => {
                    return Err(PreExecOutcome::Blocked(format!(
                        "被中间件 {} 阻止：{reason}",
                        m.name()
                    )));
                }
                Ok(Err(e)) => {
                    return Err(PreExecOutcome::Blocked(format!(
                        "中间件 {} 前置钩子错误：{e}",
                        m.name()
                    )));
                }
                Err(_elapsed) => {
                    return Err(PreExecOutcome::Blocked(format!(
                        "中间件 {} 前置钩子超时（{}ms），按阻止处理",
                        m.name(),
                        self.middleware_timeouts.before_execute.as_millis()
                    )));
                }
            }
        }
        Ok(current_input.unwrap_or_else(|| call.input.clone()))
    }

    pub(super) async fn dispatch_pre_hook(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        input: Value,
    ) -> Option<String> {
        let Some(hooks) = &self.hooks else {
            return None;
        };
        let event = HookEvent::ToolPre {
            session_id: ctx.session_id.clone(),
            tool_name: call.tool_name.clone(),
            input,
        };
        match hooks.dispatch(&event).await {
            Ok(outcome) => outcome.blocked.map(|r| format!("tool.pre 钩子阻止：{r}")),
            Err(e) => Some(format!("tool.pre 钩子失败（propagate）：{e}")),
        }
    }
}
