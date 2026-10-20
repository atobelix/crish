//! 单工具执行面（SR-03 拆分 · ≠ EL）：execute_one / execute_single /
//! execute_single_with_retry
//!
//! 顺序路径完整事件序列（execute_one）、无事件产出的单工具执行
//! （execute_single，中间件链 + tool.pre/post 钩子 + 超时/abort 竞速）
//! 与 requires_approval 真实审批重试（execute_single_with_retry）随本模落位。
//! 语义与拆分前逐行一致（只搬移不改行为）。

use super::*;

/// execute_one 事件相：start / 未执行 abort 收场 / 正常 tool-end。
enum ToolEmit<'a> {
    Start,
    EndAborted,
    End(&'a ClassifiedToolResult),
}

/// 预执行结果（中间件/钩子阶段）
enum PreExecOutcome {
    Proceed(Value),
    Blocked(String),
    Aborted,
}

impl ToolExecutor {
    /// 执行单个工具（顺序路径：完整事件序列 + 审批）
    // G2 允许理由（clippy::too_many_arguments）：参数为工具执行上下文聚合
    // 注入（批调用/下标/执行上下文/审批门/批选项/中止信号/事件收集/致命
    // 错误槽），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_one(
        &self,
        calls: &[ToolBatchCall],
        idx: usize,
        ctx: &ToolExecCtx,
        approval: Option<Arc<dyn ApprovalGate>>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
        fatal: &mut Option<String>,
    ) -> ClassifiedToolResult {
        let call = &calls[idx];
        Self::emit_tool_events(call, events, ToolEmit::Start);

        // abort 前置检查
        if let Some(sig) = abort {
            if sig.is_aborted() {
                Self::emit_tool_events(call, events, ToolEmit::EndAborted);
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                    0,
                );
            }
        }

        let r = self
            .handle_verdict_and_approval(call, ctx, approval, options, abort, events)
            .await;
        if self.result_is_fatal(call, &r) {
            *fatal = Some(
                r.error_message
                    .clone()
                    .unwrap_or_else(|| "tool failed".into()),
            );
        }
        Self::emit_tool_events(call, events, ToolEmit::End(&r));
        r
    }

    /// 顺序路径 tool-start / tool-end 发射（从 execute_one 抽出，只搬移）。
    /// abort 未执行收场与正常收场载荷不同（原子要素留空 vs 透传），故分相。
    fn emit_tool_events(call: &ToolBatchCall, events: &mut Vec<ToolEvent>, kind: ToolEmit<'_>) {
        match kind {
            ToolEmit::Start => {
                events.push(ToolEvent::ToolStart {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    input: call.input.clone(),
                    category: call.category,
                    concurrency: call.concurrency,
                    summary: call.summary.clone(),
                    // EV-09（D-03）：工具开始时刻打点（翻译层回填 timestamp）
                    occurred_at_ms: Some(conex_shared::time::unix_millis() as u64),
                });
            }
            ToolEmit::EndAborted => {
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: true,
                    duration_ms: 0,
                    // U-OUT-RS：出口 Arc——Null 也走共享边界
                    output: Arc::new(serde_json::Value::Null),
                    // Tier-1（02 §4.1）：统一 codes::TOOL_CANCELLED 常量
                    error_code: Some(conex_types::error::codes::TOOL_CANCELLED.to_string()),
                    error_message: Some("aborted".to_string()),
                    // EV-09（D-03）：未执行路径原子要素留空
                    attempt: None,
                    deduplicated: None,
                    executed_input: None,
                    occurred_at_ms: None,
                });
            }
            ToolEmit::End(r) => {
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: r.error_kind.is_some(),
                    duration_ms: r.duration_ms,
                    // U-OUT-RS：Arc::clone 浅拷贝（refcount+1），消除深 clone
                    output: Arc::clone(&r.output),
                    error_code: r.error_kind.map(|k| k.error_code().to_string()),
                    error_message: r.error_message.clone(),
                    // EV-09（D-03）：原子要素透传（attempt/dedup/实际入参/打点）
                    attempt: Some(r.attempt),
                    deduplicated: Some(r.deduplicated),
                    executed_input: r.executed_input.clone(),
                    occurred_at_ms: r.occurred_at_ms,
                });
            }
        }
    }

    async fn handle_verdict_and_approval(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        approval: Option<Arc<dyn ApprovalGate>>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
    ) -> ClassifiedToolResult {
        let mut opts_buf;
        let effective_options = if options.task_type.is_none() && ctx.task_type.is_some() {
            opts_buf = options.clone();
            opts_buf.task_type = ctx.task_type.clone();
            &opts_buf
        } else {
            options
        };
        let verdict = self.call_verdict(call, effective_options);
        match (&approval, options.approval_enabled) {
            (Some(gate), true) => {
                self.handle_gated_verdict(call, ctx, gate, options, abort, events, verdict)
                    .await
            }
            _ => {
                self.handle_ungated_verdict(call, ctx, options, abort, approval, events, verdict)
                    .await
            }
        }
    }

    async fn handle_gated_verdict(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        gate: &Arc<dyn ApprovalGate>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
        verdict: PermissionVerdict,
    ) -> ClassifiedToolResult {
        match verdict {
            PermissionVerdict::Allow => {
                let (r, extra) = self
                    .execute_single_with_retry(call, ctx, options, abort, Some(Arc::clone(gate)))
                    .await;
                events.extend(extra);
                r
            }
            PermissionVerdict::Deny => denied_result(call, options, Some(&self.registry)),
            PermissionVerdict::NeedsApproval => {
                self.handle_gated_needs_approval(call, ctx, gate, options, abort, events)
                    .await
            }
        }
    }

    async fn handle_gated_needs_approval(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        gate: &Arc<dyn ApprovalGate>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
    ) -> ClassifiedToolResult {
        let requester = self.approval_requester_for(ctx, &call.input);
        events.push(ToolEvent::ApprovalRequested {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            args: call.input.clone(),
            requester: requester.clone(),
        });
        match approval_wait(
            gate.as_ref(),
            &call.id,
            &call.tool_name,
            &call.input,
            requester.as_ref(),
            abort,
            options.approval_timeout,
        )
        .await
        {
            ApprovalWaitOutcome::Cancelled => ClassifiedToolResult::error(
                &call.id,
                &call.tool_name,
                ToolErrorKind::Cancelled,
                "aborted",
                0,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                let (r, extra) = self
                    .execute_single_with_retry(call, ctx, options, abort, Some(Arc::clone(gate)))
                    .await;
                events.extend(extra);
                r
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => {
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::UserDenied,
                    denied_message(requester.is_some(), &reason),
                    0,
                )
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                events.push(ToolEvent::ApprovalResolved {
                    call_id: call.id.clone(),
                    decision: ApprovalDecision::Expired,
                });
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::ApprovalExpired,
                    "approval expired",
                    0,
                )
            }
        }
    }

    async fn handle_ungated_verdict(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
        events: &mut Vec<ToolEvent>,
        verdict: PermissionVerdict,
    ) -> ClassifiedToolResult {
        match verdict {
            PermissionVerdict::Deny => denied_result(call, options, Some(&self.registry)),
            PermissionVerdict::NeedsApproval => ClassifiedToolResult::error(
                &call.id,
                &call.tool_name,
                ToolErrorKind::ApprovalRequired,
                self.revert_refusal_message(call),
                0,
            ),
            PermissionVerdict::Allow => {
                let (r, extra) = self
                    .execute_single_with_retry(call, ctx, options, abort, approval.clone())
                    .await;
                events.extend(extra);
                r
            }
        }
    }

    async fn execute_single(
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
            .race_execution(
                tool.as_ref(),
                exec_input.clone(),
                &tool_ctx,
                &exec_ctx,
                guard.as_ref().map(|v| v.as_ref()),
                &policy,
                options.timeout,
                abort,
            )
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
        self.handle_execution_outcome(
            outcome,
            tool.as_ref(),
            call,
            ctx,
            &mw_ctx,
            exec_input,
            attempt,
            duration_ms,
            occurred_at_ms,
            recorded,
        )
        .await
    }

    fn not_found_result(call: &ToolBatchCall) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::NotFound,
            format!("unknown tool: {}", call.tool_name),
            0,
        )
    }

    fn blocked_result(call: &ToolBatchCall, reason: String) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::ExecutionFailed,
            reason,
            0,
        )
    }

    fn cancelled_result(call: &ToolBatchCall, duration_ms: u64) -> ClassifiedToolResult {
        ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::Cancelled,
            "aborted",
            duration_ms,
        )
    }

    fn build_execution_contexts(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: &Option<Arc<dyn ApprovalGate>>,
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
        let mut approval_channel: Option<Arc<ApprovalChannel>> = None;
        let requester = self.approval_requester_for(ctx, &call.input);
        let ask: Option<AskCallback> = match options.permission_mode {
            Some(PermissionMode::FullAccess) => Some(Arc::new(NoopAskChannel)),
            _ => approval.as_ref().map(|gate| {
                let channel = Arc::new(ApprovalChannel::new(
                    Arc::clone(gate),
                    &call.id,
                    abort.cloned(),
                    abort_token.clone(),
                    requester.clone(),
                ));
                approval_channel = Some(Arc::clone(&channel));
                channel as AskCallback
            }),
        };
        let tool_ctx = ToolContext {
            session_id: ctx.session_id.clone(),
            abort_token: abort_token.clone(),
            ask,
            workspace_root: ctx
                .workspace_root
                .clone()
                .or_else(|| ctx.cwd.clone().map(PathBuf::from))
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
            permission_mode: options.permission_mode.unwrap_or_default(),
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
        (tool_ctx, approval_channel, mw_ctx, exec_ctx, abort_token)
    }

    async fn run_pre_checks(
        &self,
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        mw_ctx: &ToolExecutionContext,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> PreExecOutcome {
        let after_mw = match self
            .run_middleware_before(tool, call, mw_ctx, abort)
            .await
        {
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

    async fn run_middleware_before(
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

    async fn dispatch_pre_hook(
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

    async fn race_execution(
        &self,
        tool: &dyn agent_tools::definition::Tool,
        exec_input: Value,
        tool_ctx: &ToolContext,
        exec_ctx: &ExecutorContext,
        guard: Option<&agent_tools::idempotency::ToolIdempotencyGuard>,
        policy: &ToolExecutionPolicy,
        timeout: std::time::Duration,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> Option<
        Result<Result<agent_tools::executor::ToolResult, ToolError>, tokio::time::error::Elapsed>,
    > {
        let execute = async move {
            if let Some(g) = guard {
                execute_stream_with_output_policy(
                    tool,
                    exec_input,
                    tool_ctx,
                    exec_ctx,
                    Some(g),
                    policy,
                    None,
                )
                .await
            } else {
                execute_stream_with_output_policy(
                    tool,
                    exec_input,
                    tool_ctx,
                    exec_ctx,
                    None,
                    policy,
                    None,
                )
                .await
            }
        };
        match abort {
            Some(sig) => tokio::select! {
                biased;
                _ = sig.wait_aborted() => {
                    tool_ctx.abort_token.abort();
                    None
                }
                result = tokio::time::timeout(timeout, execute) => {
                    if result.is_err() {
                        tool_ctx.abort_token.abort();
                    }
                    Some(result)
                }
            },
            None => {
                let result = tokio::time::timeout(timeout, execute).await;
                if result.is_err() {
                    tool_ctx.abort_token.abort();
                }
                Some(result)
            }
        }
    }

    async fn handle_execution_outcome(
        &self,
        outcome: Option<
            Result<
                Result<agent_tools::executor::ToolResult, ToolError>,
                tokio::time::error::Elapsed,
            >,
        >,
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        mw_ctx: &ToolExecutionContext,
        exec_input: Value,
        attempt: u32,
        duration_ms: u64,
        occurred_at_ms: u64,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        match outcome {
            None => {
                let mut r = Self::cancelled_result(call, duration_ms);
                r.attempt = attempt;
                r.executed_input = Some(exec_input.clone());
                r.occurred_at_ms = Some(occurred_at_ms);
                (r, recorded)
            }
            Some(Err(_)) => {
                let mut r = ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Timeout,
                    format!(
                        "tool {} timed out after {:?}",
                        call.tool_name,
                        std::time::Duration::from_millis(duration_ms)
                    ),
                    duration_ms,
                );
                r.attempt = attempt;
                r.executed_input = Some(exec_input.clone());
                r.occurred_at_ms = Some(occurred_at_ms);
                (r, recorded)
            }
            Some(Ok(Ok(tool_result))) => {
                if tool_result.deduplicated {
                    self.handle_dedup_success(
                        tool_result,
                        call,
                        ctx,
                        exec_input,
                        attempt,
                        occurred_at_ms,
                        recorded,
                    )
                    .await
                } else {
                    self.handle_success_with_middleware(
                        tool,
                        call,
                        ctx,
                        mw_ctx,
                        tool_result,
                        exec_input,
                        attempt,
                        duration_ms,
                        occurred_at_ms,
                        recorded,
                    )
                    .await
                }
            }
            Some(Ok(Err(err))) => {
                self.handle_error_branch(
                    tool,
                    call,
                    ctx,
                    mw_ctx,
                    err,
                    exec_input,
                    attempt,
                    duration_ms,
                    occurred_at_ms,
                    recorded,
                )
                .await
            }
        }
    }

    async fn handle_dedup_success(
        &self,
        tool_result: agent_tools::executor::ToolResult,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        exec_input: Value,
        attempt: u32,
        occurred_at_ms: u64,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        if let Some(hooks) = &self.hooks {
            // 观察面分派：失败只记日志，不阻断工具结果（BLK-05：不得丢弃赋值吞错）
            if let Err(err) = hooks
                .dispatch(&HookEvent::ToolPost {
                    session_id: ctx.session_id.clone(),
                    tool_name: call.tool_name.clone(),
                    output: tool_result.output.clone(),
                    duration_ms: 0,
                    is_error: false,
                })
                .await
            {
                tracing::warn!(
                    tool_name = %call.tool_name,
                    error = %err,
                    "tool.post hook 分派失败（去重命中路径，观察面不阻断工具结果）"
                );
            }
        }
        // U-OUT-RS：ok() 内部包 Arc——出口共享边界自此建立
        let mut r = ClassifiedToolResult::ok(&call.id, &call.tool_name, tool_result.output, 0);
        r.attempt = attempt;
        r.deduplicated = true;
        // SL-PERF-12：直接移交所有权，避免 Value 深克隆
        r.executed_input = Some(exec_input);
        r.occurred_at_ms = Some(occurred_at_ms);
        (r, recorded)
    }

    async fn handle_success_with_middleware(
        &self,
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        mw_ctx: &ToolExecutionContext,
        tool_result: agent_tools::executor::ToolResult,
        exec_input: Value,
        attempt: u32,
        duration_ms: u64,
        occurred_at_ms: u64,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        // U-OUT-RS：中间件链仍操作 Value；ok() 收口时包 Arc 作出口共享
        // SL-PERF-12：无中间件时直接使用工具原生输出，不进入链式处理
        let final_output = if self.middleware.is_empty() {
            tool_result.output
        } else {
            self.apply_on_result_chain(tool, &exec_input, tool_result.output, mw_ctx)
                .await
        };
        if let Some(hooks) = &self.hooks {
            // 观察面分派：失败只记日志，不阻断工具结果（BLK-05）
            if let Err(err) = hooks
                .dispatch(&HookEvent::ToolPost {
                    session_id: ctx.session_id.clone(),
                    tool_name: call.tool_name.clone(),
                    output: final_output.clone(),
                    duration_ms,
                    is_error: false,
                })
                .await
            {
                tracing::warn!(
                    tool_name = %call.tool_name,
                    error = %err,
                    "tool.post hook 分派失败（成功路径，观察面不阻断工具结果）"
                );
            }
        }
        let mut r = ClassifiedToolResult::ok(&call.id, &call.tool_name, final_output, duration_ms);
        r.attempt = attempt;
        // SL-PERF-12：直接移交所有权，避免 Value 深克隆
        r.executed_input = Some(exec_input);
        r.occurred_at_ms = Some(occurred_at_ms);
        (r, recorded)
    }

    async fn apply_on_result_chain(
        &self,
        tool: &dyn agent_tools::definition::Tool,
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
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        mw_ctx: &ToolExecutionContext,
        err: ToolError,
        exec_input: Value,
        attempt: u32,
        duration_ms: u64,
        occurred_at_ms: u64,
        recorded: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        if !self.middleware.is_empty() {
            self.apply_on_error_chain(tool, &exec_input, &err, mw_ctx)
                .await;
        }
        if let Some(hooks) = &self.hooks {
            // 观察面分派（失败路径两条事件）：失败只记日志，不覆盖工具错误本身
            // （BLK-05：不得丢弃赋值吞错）
            if let Err(hook_err) = hooks
                .dispatch(&HookEvent::ToolPost {
                    session_id: ctx.session_id.clone(),
                    tool_name: call.tool_name.clone(),
                    output: serde_json::json!(err.to_string()),
                    duration_ms,
                    is_error: true,
                })
                .await
            {
                tracing::warn!(
                    tool_name = %call.tool_name,
                    error = %hook_err,
                    "tool.post hook 分派失败（失败路径，观察面不阻断）"
                );
            }
            if let Err(hook_err) = hooks
                .dispatch(&HookEvent::ToolError {
                    session_id: ctx.session_id.clone(),
                    tool_name: call.tool_name.clone(),
                    error: err.to_string(),
                })
                .await
            {
                tracing::warn!(
                    tool_name = %call.tool_name,
                    error = %hook_err,
                    "tool.error hook 分派失败（失败路径，观察面不阻断）"
                );
            }
        }
        let (kind, msg) = classify_tool_error(&err);
        let mut r = ClassifiedToolResult::error(&call.id, &call.tool_name, kind, msg, duration_ms);
        r.attempt = attempt;
        // SL-PERF-12：直接移交所有权，避免 Value 深克隆
        r.executed_input = Some(exec_input);
        r.occurred_at_ms = Some(occurred_at_ms);
        (r, recorded)
    }

    async fn apply_on_error_chain(
        &self,
        tool: &dyn agent_tools::definition::Tool,
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

    pub(crate) async fn execute_single_with_retry(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let (r, extra) = self
            .execute_single(call, ctx, options, abort, approval.clone(), 1)
            .await;
        if r.error_kind != Some(ToolErrorKind::ApprovalRequired) {
            return (r, extra);
        }
        self.handle_retry_after_approval_required(call, ctx, options, abort, approval, r, extra)
            .await
    }

    async fn handle_retry_after_approval_required(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
        _initial_result: ClassifiedToolResult,
        extra: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let verdict = match options.permission_mode {
            Some(mode) => decide(false, true, mode),
            None => PermissionVerdict::NeedsApproval,
        };
        match verdict {
            PermissionVerdict::Deny => (denied_result(call, options, Some(&self.registry)), extra),
            PermissionVerdict::Allow => {
                self.retry_after_allow(call, ctx, options, abort, approval, extra)
                    .await
            }
            PermissionVerdict::NeedsApproval => {
                self.handle_retry_needs_approval(call, ctx, options, abort, approval, extra)
                    .await
            }
        }
    }

    async fn retry_after_allow(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
        extra: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let (r2, extra2) = self
            .execute_single(call, ctx, options, abort, approval, 2)
            .await;
        (r2, [extra, extra2].concat())
    }

    async fn handle_retry_needs_approval(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
        extra: Vec<ToolEvent>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let Some(gate) = approval else {
            return (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::ApprovalRequired,
                    self.revert_refusal_message(call),
                    0,
                ),
                extra,
            );
        };
        let mut extra_mut = extra;
        let requester = self.approval_requester_for(ctx, &call.input);
        extra_mut.push(ToolEvent::ApprovalRequested {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            args: call.input.clone(),
            requester: requester.clone(),
        });
        match approval_wait(
            gate.as_ref(),
            &call.id,
            &call.tool_name,
            &call.input,
            requester.as_ref(),
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
                extra_mut,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                let (r2, extra2) = self
                    .execute_single(call, ctx, options, abort, Some(gate), 2)
                    .await;
                (r2, [extra_mut, extra2].concat())
            }
            ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::UserDenied,
                    denied_message(requester.is_some(), &reason),
                    0,
                ),
                extra_mut,
            ),
            ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                extra_mut.push(ToolEvent::ApprovalResolved {
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
                    extra_mut,
                )
            }
        }
    }
}
