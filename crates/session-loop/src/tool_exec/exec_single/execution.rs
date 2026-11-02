use std::sync::Arc;

use agent_tools::definition::ToolError;
use agent_tools::executor::{execute_stream_with_output_policy, ToolExecutionPolicy};
use crate::tool_events::{
    ToolBackgroundAdmission, ToolBackgroundHost, ToolBackgroundRegistration,
};

use super::super::*;
use super::types::*;

impl ToolExecutor {
    pub(crate) async fn execute_single(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        attempt: u32,
    ) -> ClassifiedToolResult {
        let tool = match self.registry.get(&call.tool_name) {
            Some(t) => t,
            None => return Self::not_found_result(call),
        };
        if !self.registry.is_tool_enabled(&call.tool_name) {
            return ClassifiedToolResult::error(
                &call.id,
                &call.tool_name,
                ToolErrorKind::UserDenied,
                format!("tool disabled: {}", call.tool_name),
                0,
            );
        }
        // 能力 gate（运行中升级/降级即时生效；注册表裁剪只是纵深防御）
        if let Some(capability) = options.capability_cell.as_ref() {
            if !capability.allows_tool(&call.tool_name) {
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::PolicyBlocked,
                    conex_agents::capability::denial_message(
                        &call.tool_name,
                        capability.effective(),
                    ),
                    0,
                );
            }
        }
        let (tool_ctx, mw_ctx, exec_ctx) = self.build_execution_contexts(call, ctx, options, abort);
        let pre = self
            .run_pre_checks(tool.as_ref(), call, ctx, &mw_ctx, abort)
            .await;
        let exec_input = match pre {
            PreExecOutcome::Aborted => return Self::cancelled_result(call, 0),
            PreExecOutcome::Blocked(reason) => return Self::blocked_result(call, reason),
            PreExecOutcome::Proceed(v) => v,
        };
        let policy = ToolExecutionPolicy {
            output_budget_bytes: options.output_budget_bytes,
            idempotency: self.idempotency.is_some(),
        };
        let guard = self.idempotency.clone();
        // BG2：转后台计划（工具定义有资格 + 批选项装配宿主才成立；
        // 不成立走现行二方竞速，行为不变）。在途去重先行：同
        // (session, tool, 摘要) 已有他调用在后台执行 → 直接以指向
        // 在途条目的占位收口，不重复执行。
        let bg_plan = self.background_plan(tool.as_ref(), call, &exec_ctx, &exec_input, options);
        if let Some(plan) = &bg_plan {
            if let Some(existing) = plan
                .host
                .find_inflight(&ctx.session_id, &call.tool_name, &plan.args_digest)
            {
                if existing != call.id {
                    let elapsed = plan
                        .host
                        .inflight_elapsed_ms(&existing, conex_shared::time::now_millis())
                        .unwrap_or(0);
                    let mut r =
                        Self::background_placeholder(call, &existing, elapsed, true, attempt);
                    r.executed_input = Some(exec_input);
                    r.occurred_at_ms = Some(conex_shared::time::now_millis());
                    return r;
                }
            }
        }
        let start = std::time::Instant::now();
        let outcome = if let Some(plan) = bg_plan {
            // ── BG2 三方竞速：abort（现行不变）/ 阈值到点 detach /
            // 本体（含 60s 硬超时臂——仅未 detach 时生效）──
            // 执行 future 先 owned 化（工具 Arc + 上下文克隆 + 守卫
            // Arc），detach 时可整体移交后台包装任务继续驱动。
            let unit_tool_ctx = tool_ctx.clone();
            let unit_exec_ctx = exec_ctx.clone();
            let mut execute: std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<agent_tools::executor::ToolResult, ToolError>,
                        > + Send,
                >,
            > = {
                let tool_fut = tool.clone();
                let guard_fut = guard.clone();
                let input_fut = exec_input.clone();
                Box::pin(async move {
                    execute_stream_with_output_policy(
                        tool_fut.as_ref(),
                        input_fut,
                        &unit_tool_ctx,
                        &unit_exec_ctx,
                        guard_fut.as_deref(),
                        &policy,
                        None,
                    )
                    .await
                })
            };
            tokio::select! {
                biased;
                () = tool_ctx.abort_token.wait_aborted() => None,
                () = tokio::time::sleep(plan.threshold) => {
                    let unit = OwnedToolExecution {
                        executor: self.clone_executor(),
                        execute,
                        tool: tool.clone(),
                        call: call.clone(),
                        ctx: ctx.clone(),
                        mw_ctx: mw_ctx.clone(),
                        exec_input,
                        attempt,
                        abort_token: tool_ctx.abort_token.clone(),
                        pre_detach_elapsed: start.elapsed(),
                    };
                    return self.detach_to_background(plan, unit, abort);
                }
                res = tokio::time::timeout(options.timeout, &mut execute) => Some(res),
            }
        } else {
            self.race_execution(RaceExecParams {
                tool: tool.as_ref(),
                exec_input: exec_input.clone(),
                tool_ctx: &tool_ctx,
                exec_ctx: &exec_ctx,
                guard: guard.as_ref().map(|v| v.as_ref()),
                policy: &policy,
                timeout: options.timeout,
            })
            .await
        };
        let duration_ms = start.elapsed().as_millis() as u64;
        let occurred_at_ms = conex_shared::time::now_millis();
        // 取消判定看工具令牌（语义见 race_execution 注释）
        if tool_ctx.abort_token.is_aborted() {
            let mut r = Self::cancelled_result(call, duration_ms);
            r.attempt = attempt;
            r.executed_input = Some(exec_input);
            r.occurred_at_ms = Some(occurred_at_ms);
            return r;
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
        self.handle_execution_outcome(outcome, &post_cx, timing, exec_input)
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
        // 取消语义：工具令牌是本次调用唯一的取消通道（Run 信号的子令牌）。
        // - Run 中止沿令牌链级联，竞速立即醒来；
        // - 工具自行 abort 自己的令牌同样视为本次调用被取消：agent-tools 执行器
        //   （executor_run）见令牌中止即停止消费工具流、丢弃 Terminal 并返回
        //   runtime.aborted，本就不存在可保留的「真实结果」；runtime.aborted 在
        //   错误码映射中即 Cancelled，这里统一判为 Cancelled（基点把它落成
        //   ExecutionFailed 属错分）。令牌中止不回传 Run 信号，批内其余调用照常执行。
        tokio::select! {
            biased;
            () = p.tool_ctx.abort_token.wait_aborted() => None,
            res = tokio::time::timeout(p.timeout, execute) => Some(res),
        }
    }

    /// BG2：转后台计划——工具定义有资格（`is_background_eligible`）
    /// 且批选项装配了托管宿主时成立。阈值解析：定义声明的具体值
    /// （> 0）优先；声明 `Some(0)`（有资格未指定具体值）取批选项
    /// 的全局默认 T。摘要按 ToolIdempotencyGuard 的执行键口径生成
    /// （[agent_tools::idempotency::inflight_digest] 薄适配，与守卫
    /// 同一上下文构造），注册表只做不透明比较。
    fn background_plan(
        &self,
        tool: &dyn agent_tools::definition::Tool,
        call: &ToolBatchCall,
        exec_ctx: &ExecutorContext,
        exec_input: &Value,
        options: &ToolBatchOptions,
    ) -> Option<BackgroundPlan> {
        let definition = tool.definition();
        if !definition.is_background_eligible() {
            return None;
        }
        let host = options.tool_background.clone()?;
        let threshold = match definition.background_after_ms {
            Some(ms) if ms > 0 => std::time::Duration::from_millis(u64::from(ms)),
            _ => options.background_after_default,
        };
        let idem_ctx =
            agent_tools::executor::build_idempotency_context(exec_ctx, &call.tool_name, exec_input);
        let args_digest = agent_tools::idempotency::inflight_digest(&idem_ctx, exec_input);
        Some(BackgroundPlan {
            host,
            threshold,
            args_digest,
        })
    }

    /// BG2 占位信封收口（方案 §3.3）：`mode=background` + callId /
    /// toolName / elapsedMs / note 的结构化输出，以 ok 结果返回——
    /// is_ok 为真，不触发 fatal / steering-reset，整批照常收口、
    /// 对话继续。`deduplicated` 时 callId 指向在途的他调用、本调用
    /// 未真正执行（deduplicated 标记随之置真，与 ToolEnd 事件的
    /// 既有口径一致）。
    pub(super) fn background_placeholder(
        call: &ToolBatchCall,
        target_call_id: &str,
        elapsed_ms: u64,
        deduplicated: bool,
        attempt: u32,
    ) -> ClassifiedToolResult {
        let note = if deduplicated {
            "已有相同调用正在后台执行（callId 为在途调用），不要重复执行；完成时结果会自动送达，或用 tool_task 查询。"
        } else {
            "该工具已转入后台继续执行，尚未完成。不要假设其结果；完成时结果会自动送达，或用 tool_task 查询。"
        };
        let output = serde_json::json!({
            "mode": "background",
            "callId": target_call_id,
            "toolName": call.tool_name,
            "elapsedMs": elapsed_ms,
            "note": note,
        });
        let mut r = ClassifiedToolResult::ok(&call.id, &call.tool_name, output, elapsed_ms);
        r.attempt = attempt;
        r.deduplicated = deduplicated;
        r
    }

    /// BG2 detach 收口：向宿主登记（幂等）→ spawn 后台包装任务 →
    /// 本调用以占位信封收口。批信号量 permit 随 execute_single
    /// 返回、批层 future drop 自动释放（execute_group 的 permit
    /// 覆盖单工具执行全程），同批其余工具不被慢工具饿死——
    /// exec_batch 无需为此改动。
    fn detach_to_background(
        &self,
        plan: BackgroundPlan,
        unit: OwnedToolExecution,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> ClassifiedToolResult {
        let call = &unit.call;
        let elapsed_ms = unit.pre_detach_elapsed.as_millis() as u64;
        let now_ms = conex_shared::time::now_millis();
        let admission = plan.host.register(ToolBackgroundRegistration {
            call_id: call.id.clone(),
            session_id: unit.ctx.session_id.clone(),
            run_id: Some(unit.ctx.run_id.clone()),
            tool_name: call.tool_name.clone(),
            args_digest: plan.args_digest.clone(),
            parent_token: abort
                .map_or_else(AbortToken::new, crate::safe_point::AbortSignal::tool_token),
            now_ms,
        });
        let mut r = Self::background_placeholder(call, &call.id, elapsed_ms, false, unit.attempt);
        r.executed_input = Some(unit.exec_input.clone());
        r.occurred_at_ms = Some(now_ms);
        if admission == ToolBackgroundAdmission::AlreadyExists {
            // 同 callId 已有执行单元在托管中（防御分支：占位为 ok
            // 结果、审批重试不会在 detach 后再入本函数，正常时序
            // 不可达）——不重复 spawn，直接占位收口；传入的执行
            // 单元未被驱动即丢弃
            return r;
        }
        let host = plan.host.clone();
        let call_id = call.id.clone();
        let admitted = admission == ToolBackgroundAdmission::Admitted;
        let handle = tokio::spawn(run_detached_unit(host.clone(), unit, admitted));
        if admitted {
            // 仅已获槽条目挂句柄（注册表取消时 abort 硬停）；排队
            // 条目的包装任务自等获槽，取消走条目令牌竞速收口
            host.attach_handle(&call_id, handle);
        }
        r
    }

    pub(crate) async fn execute_single_with_retry(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let result = self.execute_single(call, ctx, options, abort, 1).await;
        // 工具返回 tool.requires_approval → 发起第二次真实审批，批准后重试执行
        // （T10：requires_approval 不再折叠为软拒绝；无门时保持 ApprovalRequired 透传）
        if result.error_kind != Some(ToolErrorKind::ApprovalRequired) {
            return (result, Vec::new());
        }
        // Full 模式不发起审批（工具返回 ApprovalRequired 原样喂回模型）
        if options.effective_permission_mode() == PermissionMode::Full {
            return (result, Vec::new());
        }
        let Some(gate) = approval else {
            return (result, Vec::new());
        };
        let requester = self.approval_requester_for(ctx, &call.input);
        let mut events = vec![ToolEvent::ApprovalRequested {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            args: call.input.clone(),
            requester: requester.clone(),
            reason: Some(format!("工具 {} 请求执行审批", call.tool_name)),
        }];
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
            ApprovalWaitOutcome::Decision(outcome) => match outcome.decision {
                ApprovalDecision::Approved => {
                    let retried = self.execute_single(call, ctx, options, abort, 2).await;
                    (retried, events)
                }
                ApprovalDecision::Denied => (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::UserDenied,
                        denied_message(
                            requester.is_some(),
                            outcome.reason.as_deref().unwrap_or_default(),
                        ),
                        0,
                    ),
                    events,
                ),
                ApprovalDecision::Expired => {
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
            },
        }
    }
}

/// BG2 转后台计划（资格成立后的一次性解析结果）
pub(super) struct BackgroundPlan {
    /// 后台托管宿主（批选项注入的注册表适配）
    host: Arc<dyn ToolBackgroundHost>,
    /// 本工具生效的 detach 阈值（逐工具声明优先，全局默认 T 兜底）
    threshold: std::time::Duration,
    /// 在途去重摘要（ToolIdempotencyGuard 执行键口径）
    args_digest: String,
}

/// BG2 detach 移交单元：「执行本体 + 后处理」的完整 owned 块——
/// 工具 Arc / 上下文克隆 / 入参 / 执行器浅克隆全部所有权化，不
/// 借用 loop 侧任何引用；由后台包装任务驱动至
/// [ClassifiedToolResult]（与在环路径同构：同一
/// `execute_stream_with_output_policy` 本体 + 同一
/// `handle_execution_outcome` 后处理——输出预算、on_result 中间件、
/// 钩子、结果分类全程一致）。
pub(super) struct OwnedToolExecution {
    /// 执行器浅克隆（后处理面与在环路径同一实现）
    executor: ToolExecutor,
    /// 执行本体（owned future；无 timeout 竞速臂——detach 后与
    /// loop 竞速脱钩，后台不设时长上限）
    execute: std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<agent_tools::executor::ToolResult, ToolError>,
                > + Send,
        >,
    >,
    /// 工具本体（后处理上下文用）
    tool: Arc<dyn agent_tools::definition::Tool>,
    /// 本调用（克隆）
    call: ToolBatchCall,
    /// 批执行上下文（克隆）
    ctx: ToolExecCtx,
    /// 中间件上下文（克隆）
    mw_ctx: ToolExecutionContext,
    /// 中间件改写后的实际执行入参
    exec_input: Value,
    /// 审批重试 attempt 序号（透传至终态结果）
    attempt: u32,
    /// 本次调用的工具令牌（Run 级信号子令牌；收口后复查口径与
    /// 在环路径一致）
    abort_token: AbortToken,
    /// detach 前在环已耗时（总耗时 = 本段 + 获槽后驱动段；排队
    /// 等待不计入——对齐注册表「排队不计时」口径）
    pre_detach_elapsed: std::time::Duration,
}

impl OwnedToolExecution {
    /// 驱动执行本体并完成后处理，产出与在环路径同构的分类结果。
    /// 后台段**不设任何时长上限**（定案）：终止只来自执行落定、
    /// 条目令牌取消（包装层竞速）与工具自身令牌语义。
    async fn run(mut self) -> ClassifiedToolResult {
        let drive_start = std::time::Instant::now();
        let raw = self.execute.as_mut().await;
        let duration_ms = (self.pre_detach_elapsed + drive_start.elapsed()).as_millis() as u64;
        let occurred_at_ms = conex_shared::time::now_millis();
        // 与在环路径同一收口纪律：令牌中止 → Cancelled 优先于结果分类
        if self.abort_token.is_aborted() {
            let mut r = ToolExecutor::cancelled_result(&self.call, duration_ms);
            r.attempt = self.attempt;
            r.executed_input = Some(self.exec_input.clone());
            r.occurred_at_ms = Some(occurred_at_ms);
            return r;
        }
        let post_cx = PostExecContext {
            tool: self.tool.as_ref(),
            call: &self.call,
            ctx: &self.ctx,
            mw_ctx: &self.mw_ctx,
        };
        let timing = ExecTiming {
            attempt: self.attempt,
            duration_ms,
            occurred_at_ms,
        };
        self.executor
            .handle_execution_outcome(Some(Ok(raw)), &post_cx, timing, self.exec_input.clone())
            .await
    }
}

/// BG2 后台包装任务：排队条目先等获槽（获槽前终态 → 条目已由
/// 注册表收口，执行单元直接丢弃）；驱动期与条目子令牌竞速——
/// 注册表侧取消（显式 cancel / 会话关闭 / run 中止经父令牌级联）
/// 命中时以 Cancelled 结果尝试落定（条目已终态时 settle 被拒，
/// 无副作用）；正常落定把完整分类结果交注册表（先落定者胜）。
async fn run_detached_unit(
    host: Arc<dyn ToolBackgroundHost>,
    unit: OwnedToolExecution,
    admitted: bool,
) {
    let call_id = unit.call.id.clone();
    if !admitted && !host.wait_admitted(&call_id).await {
        return;
    }
    let Some(token) = host.entry_token(&call_id) else {
        // 条目已终态/不存在（取消竞速）——无落定对象，丢弃执行单元
        return;
    };
    // 取消收口视图先行抽出（drive 消费 unit 本体）
    let cancel_call = unit.call.clone();
    let cancel_attempt = unit.attempt;
    let cancel_elapsed = unit.pre_detach_elapsed;
    let cancel_input = unit.exec_input.clone();
    let drive = unit.run();
    tokio::pin!(drive);
    let result = tokio::select! {
        biased;
        () = token.wait_aborted() => {
            let mut r = ToolExecutor::cancelled_result(
                &cancel_call,
                cancel_elapsed.as_millis() as u64,
            );
            r.attempt = cancel_attempt;
            r.executed_input = Some(cancel_input);
            r.occurred_at_ms = Some(conex_shared::time::now_millis());
            r
        }
        r = &mut drive => r,
    };
    host.settle(&call_id, result, conex_shared::time::now_millis());
}
