//! 工具批处理执行器（任务书 B3.5：executeToolBatch 等价）
//!
//! 行为要点（01 §2.8 / §五.8，05 §2.3）：
//! - 并行/顺序：concurrency=Parallel 的工具并行执行，Sequential/Exclusive 顺序执行；
//! - 未知工具 → tool.not_found；非法入参 → tool.invalid_input（不 panic）；
//! - 超时（ToolBatchOptions.timeout）→ tool.timeout；
//! - abort 置位：已就绪结果返回，未执行项标记 cancelled；
//! - 失败策略：cancel-siblings（致命失败后同批未执行项 cancelled）/ continue-drain；
//! - fatalOnError 判定排除 softDeny/timedOut/cancelled/approval_expired/user_denied；
//! - 审批：approval-requested 事件先于挂起等待发出（防死锁）；
//! - 审批并行（T09.6/P8）：审批模式并行组不再退化串行——审批逐个 await
//!   （执行模型 A，UX 与事件顺序不变），通过后执行阶段 join_all 并行；
//! - 单工具执行复用 agent-tools 的 execute_with_output_policy（幂等+输出预算）。
//!
//! 语义来源：01-session-loop-semantics.md §2.8 / §五.8；05-test-mapping.md §2.3

use crate::tool_events::{
    ApprovalDecision, ApprovalGate, ClassifiedToolResult, FailStrategy, ToolBatchOptions,
    ToolErrorKind, ToolEvent,
};
use agent_tools::definition::ToolError;
use agent_tools::executor::{execute_with_output_policy, ExecutorContext, ToolExecutionPolicy};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::registry::ToolRegistry;
use conex_types::tool::{ToolBatchCall, ToolConcurrency};
use std::sync::Arc;

/// 批处理执行上下文
#[derive(Debug, Clone, Default)]
pub struct ToolExecCtx {
    /// 运行标识
    pub run_id: String,
    /// 会话标识
    pub session_id: String,
    /// 工作目录
    pub cwd: Option<String>,
}

/// 批处理产出：结果 + 事件序列 + 致命错误
#[derive(Debug)]
pub struct ToolBatchOutcome {
    /// 批内全部结果（顺序与入参一致）
    pub results: Vec<ClassifiedToolResult>,
    /// 事件序列（batch-start → tool-start/approval/tool-end → batch-end）
    pub events: Vec<ToolEvent>,
    /// fatalOnError 命中的致命错误文案（有则 run 应以 error 收场）
    pub fatal: Option<String>,
}

/// 工具批处理执行器
pub struct ToolExecutor {
    registry: Arc<ToolRegistry>,
    /// 可选幂等守卫（None 表示禁用幂等）
    idempotency: Option<Arc<ToolIdempotencyGuard>>,
}

impl ToolExecutor {
    /// 新建执行器
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            idempotency: None,
        }
    }

    /// 启用幂等守卫
    pub fn with_idempotency(mut self, guard: Arc<ToolIdempotencyGuard>) -> Self {
        self.idempotency = Some(guard);
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
        }
    }

    /// 重建执行器：Some=启用幂等守卫，None=移除守卫。
    ///
    /// AgentSessionLoop::with_options 派生状态同步用（T06.4.4：开关翻转时
    /// 不必重建执行器，直接替换守卫槽位）。
    pub fn with_idempotency_opt(mut self, guard: Option<Arc<ToolIdempotencyGuard>>) -> Self {
        self.idempotency = guard;
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
        }
    }

    /// 是否启用幂等守卫（测试 / 观测用）
    pub fn idempotency_enabled(&self) -> bool {
        self.idempotency.is_some()
    }

    /// 执行一批工具调用
    ///
    /// 返回结果顺序与入参一致；`abort` 置位时返回已就绪结果，其余标记 cancelled。
    pub async fn execute_batch(
        &self,
        calls: &[ToolBatchCall],
        ctx: &ToolExecCtx,
        approval: Option<Arc<dyn ApprovalGate>>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> ToolBatchOutcome {
        let batch_id = format!("batch-{}", crate::input::next_batch_seq());
        tracing::debug!(count = calls.len(), batch = %batch_id, "工具批处理开始");
        let mut events = vec![ToolEvent::BatchStart {
            batch_id: batch_id.clone(),
            count: calls.len(),
        }];
        let mut results: Vec<Option<ClassifiedToolResult>> =
            calls.iter().map(|_| None).collect();
        let mut fatal: Option<String> = None;

        // 分组：Parallel 组可并行；Sequential/Exclusive 顺序执行
        let mut parallel_group: Vec<usize> = Vec::new();
        let mut order: Vec<usize> = Vec::new();
        for (i, call) in calls.iter().enumerate() {
            match call.concurrency {
                ToolConcurrency::Parallel => parallel_group.push(i),
                _ => order.push(i),
            }
        }
        // 顺序项夹在并行组之后执行（保持工具间依赖顺序：并行组先发，随后顺序项依次）
        let mut sequence: Vec<Vec<usize>> = Vec::new();
        if !parallel_group.is_empty() {
            sequence.push(parallel_group);
        }
        for i in order {
            sequence.push(vec![i]);
        }

        'outer: for group in sequence {
            if group.len() == 1 {
                let idx = group[0];
                let r = self
                    .execute_one(calls, idx, ctx, approval.as_deref(), options, abort, &mut events, &mut fatal)
                    .await;
                results[idx] = Some(r);
                if fatal.is_some() && options.fail_strategy == FailStrategy::CancelSiblings {
                    mark_rest_cancelled(calls, &mut results, &mut events);
                    break 'outer;
                }
            } else {
                // 并行组（T09.6/P8：审批模式恢复并行，不再退化串行）：
                // 事件顺序契约（tool_events.rs 头注）每项保持
                // tool-start → approval-requested → tool-end；执行模型 A
                //（AU-04 F9）：审批逐个 await（UX 与事件顺序不变），
                // 通过后执行阶段 join_all 并行（批延迟 = max(工具耗时) + 审批链）。
                for &idx in &group {
                    let call = &calls[idx];
                    events.push(ToolEvent::ToolStart {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        input: call.input.clone(),
                        category: call.category,
                        concurrency: call.concurrency,
                        summary: call.summary.clone(),
                    });
                }

                // 审批逐个发起：approval-requested 事件全组先发（防死锁
                // 硬契约，01 §五.8），再逐个等待决策；abort 中断后不再
                // 发起剩余审批（与顺序路径逐项 abort 前置检查一致）。
                let mut approvals: Vec<Option<ApprovalDecision>> = Vec::new();
                let approval_active = options.approval_enabled && approval.is_some();
                if options.approval_enabled {
                    if let Some(gate) = approval.as_deref() {
                        for &idx in &group {
                            let call = &calls[idx];
                            events.push(ToolEvent::ApprovalRequested {
                                call_id: call.id.clone(),
                                tool_name: call.tool_name.clone(),
                                args: call.input.clone(),
                            });
                        }
                        for &idx in &group {
                            if let Some(sig) = abort {
                                if sig.is_aborted() {
                                    break;
                                }
                            }
                            let call = &calls[idx];
                            let decision = gate
                                .request_approval(&call.id, &call.tool_name, &call.input)
                                .await;
                            approvals.push(Some(decision));
                        }
                    }
                }

                // 执行阶段：已批准项 join_all 并行执行（拒绝/过期/abort
                // 中断项不执行，直接构造结果）
                let exec = self.clone_executor();
                let ctx_own = ctx.clone();
                let options_own = options.clone();
                let mut futures = Vec::new();
                let mut executed: Vec<Option<ClassifiedToolResult>> = vec![None; group.len()];
                for (pos, &idx) in group.iter().enumerate() {
                    let decided = approvals.get(pos).and_then(Option::as_ref);
                    // 审批未启用/未注入门 → 全部执行；有决策 → 仅通过执行；
                    // 无决策（abort 中断，未发起审批）→ 按取消收场
                    let should_execute = if approval_active {
                        matches!(decided, Some(ApprovalDecision::Approved))
                    } else {
                        true
                    };
                    if !should_execute {
                        let call = &calls[idx];
                        let r = match decided {
                            Some(ApprovalDecision::Denied { reason }) => ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::UserDenied,
                                format!("user denied: {reason}"),
                            ),
                            Some(ApprovalDecision::Expired) => ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::ApprovalExpired,
                                "approval expired",
                            ),
                            // 无决策 = abort 中断，与顺序路径 abort 收场一致
                            _ => ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::Cancelled,
                                "aborted",
                            ),
                        };
                        executed[pos] = Some(r);
                        continue;
                    }
                    let call = calls[idx].clone();
                    let e = exec.clone_executor();
                    let c = ctx_own.clone();
                    let o = options_own.clone();
                    let ab = abort.cloned();
                    futures.push(async move {
                        let r = e.execute_single(&call, &c, &o, ab.as_ref()).await;
                        (pos, r)
                    });
                }
                let finished = futures::future::join_all(futures).await;
                for (pos, r) in finished {
                    executed[pos] = Some(r);
                }

                // 按组序收 tool-end（每项 tool-start → approval-requested → tool-end 顺序保持）
                for (pos, &idx) in group.iter().enumerate() {
                    let call = &calls[idx];
                    let r = executed[pos].take().unwrap_or_else(|| {
                        // 防御性兜底：正常路径不应缺失（与批尾兜底语义一致）
                        ClassifiedToolResult::error(
                            &call.id,
                            &call.tool_name,
                            ToolErrorKind::Cancelled,
                            "cancelled",
                        )
                    });
                    events.push(ToolEvent::ToolEnd {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        is_error: r.error_kind.is_some(),
                        duration_ms: r.duration_ms,
                        output: r.output.clone(),
                        error_code: r.error_kind.map(|k| k.error_code().to_string()),
                        error_message: r.error_message.clone(),
                    });
                    if self.result_is_fatal(call, &r) {
                        fatal = Some(
                            r.error_message
                                .clone()
                                .unwrap_or_else(|| "tool failed".into()),
                        );
                    }
                    results[idx] = Some(r);
                }
                if fatal.is_some() && options.fail_strategy == FailStrategy::CancelSiblings {
                    mark_rest_cancelled(calls, &mut results, &mut events);
                    break 'outer;
                }
            }
        }

        events.push(ToolEvent::BatchEnd {
            batch_id: batch_id.clone(),
        });

        // 防御性兜底：正常路径下（含取消路径）全部结果应有值；
        // debug 构建断言暴露遗漏路径，生产保持降级容错（不回退 panic）
        debug_assert!(results.iter().all(Option::is_some));
        let results = results
            .into_iter()
            .map(|r| r.unwrap_or_else(|| ClassifiedToolResult::error("", "", ToolErrorKind::Cancelled, "cancelled")))
            .collect();

        ToolBatchOutcome {
            results,
            events,
            fatal,
        }
    }

    /// fatalOnError 判定（01 §五.8）：查工具定义标记；未注册/未知工具按
    /// 非致命处理（错误喂回模型）。审批/超时/取消类错误恒不致命。
    fn result_is_fatal(&self, call: &ToolBatchCall, r: &ClassifiedToolResult) -> bool {
        let Some(kind) = r.error_kind else {
            return false;
        };
        if kind.is_never_fatal() {
            return false;
        }
        self.registry
            .get(&call.tool_name)
            .map(|t| t.definition().fatal_on_error)
            .unwrap_or(false)
    }

    /// 执行单个工具（顺序路径：完整事件序列 + 审批）
    #[allow(clippy::too_many_arguments)]
    async fn execute_one(
        &self,
        calls: &[ToolBatchCall],
        idx: usize,
        ctx: &ToolExecCtx,
        approval: Option<&dyn ApprovalGate>,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        events: &mut Vec<ToolEvent>,
        fatal: &mut Option<String>,
    ) -> ClassifiedToolResult {
        let call = &calls[idx];
        events.push(ToolEvent::ToolStart {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            input: call.input.clone(),
            category: call.category,
            concurrency: call.concurrency,
            summary: call.summary.clone(),
        });

        // abort 前置检查
        if let Some(sig) = abort {
            if sig.is_aborted() {
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: true,
                    duration_ms: 0,
                    output: serde_json::Value::Null,
                    error_code: Some("tool.cancelled".to_string()),
                    error_message: Some("aborted".to_string()),
                });
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                );
            }
        }

        // 审批：approval-requested 事件先发出，再挂起等待（防死锁）
        if options.approval_enabled {
            if let Some(gate) = approval {
                events.push(ToolEvent::ApprovalRequested {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    args: call.input.clone(),
                });
                let decision = gate
                    .request_approval(&call.id, &call.tool_name, &call.input)
                    .await;
                let r = match decision {
                    ApprovalDecision::Approved => {
                        self.execute_single(call, ctx, options, abort).await
                    }
                    ApprovalDecision::Denied { reason } => ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::UserDenied,
                        format!("user denied: {reason}"),
                    ),
                    ApprovalDecision::Expired => ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::ApprovalExpired,
                        "approval expired",
                    ),
                };
                if self.result_is_fatal(call, &r) {
                    *fatal = Some(
                        r.error_message
                            .clone()
                            .unwrap_or_else(|| "tool failed".into()),
                    );
                }
                events.push(ToolEvent::ToolEnd {
                    call_id: call.id.clone(),
                    tool_name: call.tool_name.clone(),
                    is_error: r.error_kind.is_some(),
                    duration_ms: r.duration_ms,
                    output: r.output.clone(),
                    error_code: r.error_kind.map(|k| k.error_code().to_string()),
                    error_message: r.error_message.clone(),
                });
                return r;
            }
        }

        let r = self.execute_single(call, ctx, options, abort).await;
        if self.result_is_fatal(call, &r) {
            *fatal = Some(r.error_message.clone().unwrap_or_else(|| "tool failed".into()));
        }
        events.push(ToolEvent::ToolEnd {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            is_error: r.error_kind.is_some(),
            duration_ms: r.duration_ms,
            output: r.output.clone(),
            error_code: r.error_kind.map(|k| k.error_code().to_string()),
            error_message: r.error_message.clone(),
        });
        r
    }

    /// 单工具执行（不含事件产出；审批已通过或未启用）
    async fn execute_single(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
    ) -> ClassifiedToolResult {
        // 未知工具
        let tool = match self.registry.get(&call.tool_name) {
            Some(t) => t,
            None => {
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::NotFound,
                    format!("unknown tool: {}", call.tool_name),
                )
            }
        };

        // 超时执行（abort 时 timeout 竞速后检查）
        let exec_ctx = ExecutorContext {
            run_id: ctx.run_id.clone(),
            session_id: ctx.session_id.clone(),
            tool_call_id: Some(call.id.clone()),
            cwd: ctx.cwd.clone(),
        };
        let policy = ToolExecutionPolicy {
            // T06.4.2：输出预算从 ToolBatchOptions 透传（None = 不截断，
            // 与 executor.rs 的 summarize 截断语义接通）
            output_budget_bytes: options.output_budget_bytes,
            idempotency: self.idempotency.is_some(),
        };
        let call_own = call.clone();
        let guard = self.idempotency.clone();
        let start = std::time::Instant::now();
        // 执行体 future：幂等守卫开启时透传守卫（execute_with_output_policy
        // 的幂等去重 + 输出预算语义，T06.4.2/T06.4.4）
        let execute = async {
            if let Some(g) = guard.as_ref() {
                execute_with_output_policy(
                    tool.as_ref(),
                    call_own.input.clone(),
                    &exec_ctx,
                    Some(g.as_ref()),
                    &policy,
                )
                .await
            } else {
                execute_with_output_policy(
                    tool.as_ref(),
                    call_own.input.clone(),
                    &exec_ctx,
                    None,
                    &policy,
                )
                .await
            }
        };
        // Q21（T09.9）：abort-aware 竞速——`options.timeout` future 与
        // abort 监听 future 并置；abort 触发即取消等待并走取消收场
        // （不等 timeout 全长，AA-01 Q21：60s 长工具取消及时生效）。
        // 执行体 future 随分支丢失被 drop（尽力取消：MCP 远端尽力取消
        // 由传输层 abort 语义承接，本层以 drop 为取消语义）。
        let outcome = match abort {
            Some(sig) => tokio::select! {
                biased;
                _ = sig.wait_aborted() => None,
                result = tokio::time::timeout(options.timeout, execute) => Some(result),
            },
            None => Some(tokio::time::timeout(options.timeout, execute).await),
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        if let Some(sig) = abort {
            if sig.is_aborted() {
                return ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                );
            }
        }

        match outcome {
            // 竞速获胜：abort 已触发（上方检查兜底），防御性按取消处理
            None => ClassifiedToolResult::error(
                &call.id,
                &call.tool_name,
                ToolErrorKind::Cancelled,
                "aborted",
            ),
            Some(Err(_elapsed)) => ClassifiedToolResult::error(
                &call.id,
                &call.tool_name,
                ToolErrorKind::Timeout,
                format!("tool {} timed out after {:?}", call.tool_name, options.timeout),
            ),
            Some(Ok(Ok(tool_result))) => {
                if tool_result.deduplicated {
                    ClassifiedToolResult::ok(&call.id, &call.tool_name, tool_result.output, 0)
                } else {
                    ClassifiedToolResult::ok(&call.id, &call.tool_name, tool_result.output, duration_ms)
                }
            }
            Some(Ok(Err(err))) => {
                let (kind, msg) = classify_tool_error(&err);
                ClassifiedToolResult::error(&call.id, &call.tool_name, kind, msg)
            }
        }
    }

    /// 克隆执行器（共享 Arc 状态）
    fn clone_executor(&self) -> Self {
        Self {
            registry: self.registry.clone(),
            idempotency: self.idempotency.clone(),
        }
    }
}

/// 工具错误 → 分类（排除清单语义：SoftDeny 对应 agent-tools 的拒绝类错误码）
fn classify_tool_error(err: &ToolError) -> (ToolErrorKind, String) {
    let code = err.code();
    let message = err.to_string();
    let kind = match code {
        "tool.not_found" => ToolErrorKind::NotFound,
        "tool.invalid_input" => ToolErrorKind::InvalidInput,
        "tool.soft_deny" | "tool.requires_approval" => ToolErrorKind::SoftDeny,
        "tool.user_denied" => ToolErrorKind::UserDenied,
        "tool.approval_expired" => ToolErrorKind::ApprovalExpired,
        "tool.cancelled" => ToolErrorKind::Cancelled,
        _ => ToolErrorKind::ExecutionFailed,
    };
    (kind, message)
}

/// 取消全部未执行项（cancel-siblings）
///
/// 取消判定：`results[i].is_none()` 即取消——覆盖顺序项夹并行项的混排
/// 场景（并行组致命后，组间顺序项尚未执行也被正确标记取消，杜绝空 id
/// 回退与缺失 tool-start/tool-end 事件对，见 AA-01 Q01）。
fn mark_rest_cancelled(
    calls: &[ToolBatchCall],
    results: &mut [Option<ClassifiedToolResult>],
    events: &mut Vec<ToolEvent>,
) {
    for (i, call) in calls.iter().enumerate() {
        if results[i].is_some() {
            continue;
        }
        events.push(ToolEvent::ToolStart {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            input: call.input.clone(),
            category: call.category,
            concurrency: call.concurrency,
            summary: call.summary.clone(),
        });
        events.push(ToolEvent::ToolEnd {
            call_id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            is_error: true,
            duration_ms: 0,
            output: serde_json::Value::Null,
            error_code: Some("tool.cancelled".to_string()),
            error_message: Some("cancelled: sibling failure".to_string()),
        });
        results[i] = Some(ClassifiedToolResult::error(
            &call.id,
            &call.tool_name,
            ToolErrorKind::Cancelled,
            "cancelled: sibling failure",
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::safe_point::AbortSignal;
    use agent_tools::definition::{Tool, ToolDefinition};
    use agent_tools::registry::ToolRegistry;
    use serde_json::Value;
    use std::sync::Arc;
    use std::time::Duration;

    /// 测试工具：echo
    struct EchoTool;
    #[async_trait::async_trait]
    impl Tool for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "echo".into(),
                description: "echo input".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, args: Value) -> Result<Value, ToolError> {
            Ok(args)
        }
    }

    /// 测试工具：慢工具（睡眠指定毫秒）
    struct SlowTool {
        ms: u64,
    }
    #[async_trait::async_trait]
    impl Tool for SlowTool {
        fn name(&self) -> &str {
            "slow"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "slow".into(),
                description: "slow tool".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, _args: Value) -> Result<Value, ToolError> {
            tokio::time::sleep(Duration::from_millis(self.ms)).await;
            Ok(serde_json::json!({"ok": true}))
        }
    }

    /// 测试工具：总是失败
    struct FailTool;
    #[async_trait::async_trait]
    impl Tool for FailTool {
        fn name(&self) -> &str {
            "fail"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "fail".into(),
                description: "always fails".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, _args: Value) -> Result<Value, ToolError> {
            Err(ToolError::execution_failed("fail", "boom"))
        }
    }

    /// 标记 fatalOnError 的失败工具（验证工具级致命语义）
    struct FailToolFatal;
    #[async_trait::async_trait]
    impl Tool for FailToolFatal {
        fn name(&self) -> &str {
            "failfatal"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "failfatal".into(),
                description: "always fails (fatal)".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: true,
            })
        }
        async fn execute(&self, _args: Value) -> Result<Value, ToolError> {
            Err(ToolError::execution_failed("failfatal", "boom"))
        }
    }

    fn registry_with(tools: Vec<Arc<dyn Tool>>) -> Arc<ToolRegistry> {
        let mut reg = ToolRegistry::new();
        for t in tools {
            reg.register(t).expect("register");
        }
        Arc::new(reg)
    }

    fn call(id: &str, name: &str, concurrency: ToolConcurrency) -> ToolBatchCall {
        ToolBatchCall {
            id: id.into(),
            tool_name: name.into(),
            summary: format!("call {name}"),
            input: serde_json::json!({"v": id}),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency,
        }
    }

    fn exec_ctx() -> ToolExecCtx {
        ToolExecCtx {
            run_id: "run-1".into(),
            session_id: "sess-1".into(),
            cwd: None,
        }
    }

    #[tokio::test]
    async fn single_tool_success() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(out.results.len(), 1);
        assert!(out.results[0].is_ok());
        assert_eq!(out.results[0].id, "c1");
        assert!(out.fatal.is_none());
        // 事件序列
        assert!(matches!(out.events[0], ToolEvent::BatchStart { .. }));
        assert!(matches!(out.events[1], ToolEvent::ToolStart { .. }));
        assert!(matches!(out.events[2], ToolEvent::ToolEnd { .. }));
        assert!(matches!(out.events[3], ToolEvent::BatchEnd { .. }));
    }

    #[tokio::test]
    async fn unknown_tool() {
        let reg = registry_with(vec![]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "nope", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::NotFound));
        // 未知工具：未标记 fatalOnError → 非致命（错误喂回模型继续）
        assert!(out.fatal.is_none());
    }

    #[tokio::test]
    async fn parallel_readonly_tools() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 50 }), Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("p1", "slow", ToolConcurrency::Parallel),
            call("p2", "echo", ToolConcurrency::Parallel),
        ];
        let start = std::time::Instant::now();
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        let elapsed = start.elapsed();
        // 并行：总耗时接近单工具（50ms）而非 100ms+
        assert!(elapsed.as_millis() < 95, "parallel took {elapsed:?}");
        assert!(out.results.iter().all(|r| r.is_ok()));
    }

    #[tokio::test]
    async fn timeout_tool() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 500 })]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            timeout: Duration::from_millis(50),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
        // 超时不是 fatal（排除清单）
        assert!(out.fatal.is_none());
    }

    #[tokio::test]
    async fn cancel_siblings_strategy() {
        let reg = registry_with(vec![
            Arc::new(FailTool),
            Arc::new(EchoTool),
            Arc::new(SlowTool { ms: 0 }),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("f", "fail", ToolConcurrency::Sequential),
            call("c2", "echo", ToolConcurrency::Sequential),
            call("c3", "slow", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            fail_strategy: FailStrategy::CancelSiblings,
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        // 未标记 fatalOnError：执行失败非致命 → 兄弟工具继续执行
        assert!(out.fatal.is_none());
        assert!(out.results[1].is_ok());
        assert!(out.results[2].is_ok());
    }

    #[tokio::test]
    async fn cancel_siblings_strategy_fatal_tool() {
        // fatalOnError 工具失败 → 致命：同批未执行项 cancelled
        let reg = registry_with(vec![
            Arc::new(FailToolFatal),
            Arc::new(EchoTool),
            Arc::new(SlowTool { ms: 0 }),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("f", "failfatal", ToolConcurrency::Sequential),
            call("c2", "echo", ToolConcurrency::Sequential),
            call("c3", "slow", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            fail_strategy: FailStrategy::CancelSiblings,
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
        assert!(out.fatal.is_some());
    }

    /// 事件序列契约断言（01 §五.6）：
    /// - BatchStart 打头、BatchEnd 收尾；
    /// - 每个取消项都有 ToolStart→ToolEnd 事件对（配对次数各一）；
    /// - 全部结果携带真实 id / tool_name（无空 id 回退）。
    fn assert_event_contract(
        calls: &[ToolBatchCall],
        results: &[ClassifiedToolResult],
        events: &[ToolEvent],
    ) {
        assert!(
            matches!(events.first(), Some(ToolEvent::BatchStart { .. })),
            "事件序列应以 BatchStart 打头"
        );
        assert!(
            matches!(events.last(), Some(ToolEvent::BatchEnd { .. })),
            "事件序列应以 BatchEnd 收尾"
        );
        let starts = |id: &str| {
            events
                .iter()
                .filter(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == id))
                .count()
        };
        let ends = |id: &str| {
            events
                .iter()
                .filter(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
                .count()
        };
        for (i, (call, r)) in calls.iter().zip(results).enumerate() {
            assert!(!r.id.is_empty(), "结果 {i} 的 id 不得为空");
            assert!(!r.tool_name.is_empty(), "结果 {i} 的 tool_name 不得为空");
            assert_eq!(r.id, call.id, "结果 {i} 的 id 应与入参一致");
            assert_eq!(r.tool_name, call.tool_name, "结果 {i} 的 tool_name 应与入参一致");
            if r.error_kind == Some(ToolErrorKind::Cancelled) {
                assert_eq!(starts(&r.id), 1, "取消项 {i}（{}）缺 tool-start 事件对", r.id);
                assert_eq!(ends(&r.id), 1, "取消项 {i}（{}）缺 tool-end 事件对", r.id);
            }
        }
    }

    /// 混排用例 1：并行组致命 + 后置顺序项 → 全部未执行项取消 + 事件对齐全
    #[tokio::test]
    async fn cancel_siblings_mixed_parallel_fatal_then_sequential() {
        let reg = registry_with(vec![
            Arc::new(FailToolFatal),
            Arc::new(EchoTool),
            Arc::new(SlowTool { ms: 0 }),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("f", "failfatal", ToolConcurrency::Parallel),
            call("c2", "echo", ToolConcurrency::Sequential),
            call("c3", "slow", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            fail_strategy: FailStrategy::CancelSiblings,
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        // 并行组致命 → 后置两个顺序项全部取消（真实 id/tool_name）
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[1].id, "c2");
        assert_eq!(out.results[1].tool_name, "echo");
        assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[2].id, "c3");
        assert_eq!(out.results[2].tool_name, "slow");
        assert!(out.fatal.is_some());
        assert_event_contract(&calls, &out.results, &out.events);
    }

    /// 混排用例 2：并行组致命（join_all 全完成才判 fatal）+ 后置顺序项
    /// → 组内兄弟正常完成，顺序项取消且事件对齐全
    #[tokio::test]
    async fn cancel_siblings_parallel_group_completes_before_fatal_judged() {
        let reg = registry_with(vec![
            Arc::new(SlowTool { ms: 20 }),
            Arc::new(FailToolFatal),
            Arc::new(EchoTool),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("c1", "slow", ToolConcurrency::Parallel),
            call("f", "failfatal", ToolConcurrency::Parallel),
            call("c3", "echo", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            fail_strategy: FailStrategy::CancelSiblings,
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        // 并行组 join_all 全完成才判 fatal：slow 兄弟仍正常完成
        assert!(out.results[0].is_ok(), "并行组兄弟应正常完成");
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::ExecutionFailed));
        // 后置顺序项取消，携带真实 id/tool_name
        assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[2].id, "c3");
        assert_eq!(out.results[2].tool_name, "echo");
        assert!(out.fatal.is_some());
        assert_event_contract(&calls, &out.results, &out.events);
    }

    /// 混排用例 3：并行组致命 + 中间夹顺序项 → 中间项取消且事件对齐全
    /// （AA-01 Q01 原始触发路径：calls = [failfatal(P), echo(S), slow(P)]）
    #[tokio::test]
    async fn cancel_siblings_mixed_middle_sequential_cancelled() {
        let reg = registry_with(vec![
            Arc::new(FailToolFatal),
            Arc::new(EchoTool),
            Arc::new(SlowTool { ms: 0 }),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("f", "failfatal", ToolConcurrency::Parallel),
            call("c2", "echo", ToolConcurrency::Sequential),
            call("c3", "slow", ToolConcurrency::Parallel),
        ];
        let opts = ToolBatchOptions {
            fail_strategy: FailStrategy::CancelSiblings,
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        // 中间顺序项 echo：未被执行 → 取消（修复前为空 id 脏数据）
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[1].id, "c2");
        assert_eq!(out.results[1].tool_name, "echo");
        // 并行组兄弟 slow 经 join_all 正常完成
        assert!(out.results[2].is_ok());
        assert!(out.fatal.is_some());
        assert_event_contract(&calls, &out.results, &out.events);
    }

    /// 混排用例 4：审批并行（T09.6/P8）——并行组 join_all 全完成才判
    /// fatal：组内兄弟正常完成，后置顺序项取消且事件对齐全（与无审批
    /// 并行组 `cancel_siblings_parallel_group_completes_before_fatal_judged`
    /// 行为一致——审批不再把并行组退化串行）
    #[tokio::test]
    async fn cancel_siblings_approval_parallel_completes_before_fatal_judged() {
        let reg = registry_with(vec![
            Arc::new(FailToolFatal),
            Arc::new(SlowTool { ms: 0 }),
            Arc::new(EchoTool),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("f", "failfatal", ToolConcurrency::Parallel),
            call("c2", "slow", ToolConcurrency::Parallel),
            call("c3", "echo", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            fail_strategy: FailStrategy::CancelSiblings,
            approval_enabled: true,
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Approved,
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        // 审批并行：并行组 join_all 全完成才判 fatal——slow 兄弟正常完成
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(out.results[1].is_ok());
        assert_eq!(out.results[1].id, "c2");
        assert_eq!(out.results[1].tool_name, "slow");
        // 后置顺序项同样取消
        assert_eq!(out.results[2].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[2].id, "c3");
        assert_eq!(out.results[2].tool_name, "echo");
        assert!(out.fatal.is_some());
        assert_event_contract(&calls, &out.results, &out.events);
    }

    /// 成功路径回归：混排批次全部成功 → 事件序列不破坏
    /// （每个工具一对 ToolStart→ToolEnd，BatchStart 打头、BatchEnd 收尾）
    #[tokio::test]
    async fn success_path_mixed_batch_event_sequence() {
        let reg = registry_with(vec![
            Arc::new(EchoTool),
            Arc::new(SlowTool { ms: 0 }),
        ]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("c1", "echo", ToolConcurrency::Parallel),
            call("c2", "slow", ToolConcurrency::Parallel),
            call("c3", "echo", ToolConcurrency::Sequential),
        ];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results.iter().all(|r| r.is_ok()));
        assert!(out.fatal.is_none());
        assert!(out.results.iter().all(|r| !r.id.is_empty()));
        assert_event_contract(&calls, &out.results, &out.events);
    }

    #[tokio::test]
    async fn continue_drain_strategy() {
        let reg = registry_with(vec![Arc::new(FailTool), Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("f", "fail", ToolConcurrency::Sequential),
            call("c2", "echo", ToolConcurrency::Sequential),
        ];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(out.results[1].is_ok());
        // 未标记 fatalOnError：执行失败非致命
        assert!(out.fatal.is_none());
    }

    #[tokio::test]
    async fn abort_cancels_pending() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 500 }), Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("s", "slow", ToolConcurrency::Sequential),
            call("e", "echo", ToolConcurrency::Sequential),
        ];
        let abort = AbortSignal::new();
        abort.abort();
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), Some(&abort))
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::Cancelled));
    }

    /// Q21（T09.9）：abort-aware 竞速——模拟 60s 长工具 + 中途 abort →
    /// 取消在数百 ms 内生效（不等 `options.timeout` 全长，AA-01 Q21 验收）
    ///
    /// 修复前：abort 只在 timeout 返回后检查，60s 长工具需等满 60s；
    /// 修复后：timeout future 与 abort 监听 future 竞速，abort 触发即
    /// 取消等待并走取消收场。
    #[tokio::test]
    async fn abort_interrupts_long_running_tool_promptly() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 60_000 })]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            timeout: Duration::from_secs(60),
            ..Default::default()
        };
        let abort = AbortSignal::new();
        // 50ms 后触发 abort（长工具仍在执行中）
        let aborter = {
            let abort = abort.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                abort.abort();
            })
        };
        let start = std::time::Instant::now();
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, Some(&abort))
            .await;
        let elapsed = start.elapsed();
        aborter.await.expect("aborter 不应 panic");

        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[0].error_message.as_deref(), Some("aborted"));
        assert!(
            elapsed.as_millis() < 2000,
            "取消应在数百 ms 内生效（不等 60s timeout），实际 {elapsed:?}"
        );
    }

    /// Q21（T09.9）对照：无 abort 时 timeout 语义不回归——超时仍以
    /// tool.timeout 收场（竞速只加速 abort，不缩短正常执行窗口）
    #[tokio::test]
    async fn timeout_still_wins_without_abort() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 60_000 })]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            timeout: Duration::from_millis(80),
            ..Default::default()
        };
        let abort = AbortSignal::new();
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, Some(&abort))
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
        assert!(!abort.is_aborted(), "未触发 abort 的对照场景");
    }

    /// 测试工具：大输出（200 字符文本，验证输出预算截断）
    struct BigOutputTool;
    #[async_trait::async_trait]
    impl Tool for BigOutputTool {
        fn name(&self) -> &str {
            "big"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "big".into(),
                description: "big output".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, _args: Value) -> Result<Value, ToolError> {
            Ok(serde_json::json!({ "text": "a".repeat(200) }))
        }
    }

    /// T06.4.2：output_budget_bytes 从 ToolBatchOptions 透传——超预算输出被
    /// 截断（summarize 语义）；默认 None 不截断（行为不变）
    #[tokio::test]
    async fn output_budget_bytes_truncates_large_output() {
        let reg = registry_with(vec![Arc::new(BigOutputTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "big", ToolConcurrency::Sequential)];
        // 预算 50 字节：截断生效
        let opts = ToolBatchOptions {
            output_budget_bytes: Some(50),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert!(out.results[0].is_ok());
        let truncated = out.results[0]
            .output
            .get("json")
            .and_then(|j| j.get("contextBudget"))
            .and_then(|c| c.get("truncated"))
            .and_then(|v| v.as_bool());
        assert_eq!(truncated, Some(true), "预算内应截断并带 contextBudget 标记");
        // 默认 None：不截断（输出为工具原始返回对象，未被 summarize 改写）
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(
            out.results[0]
                .output
                .get("text")
                .and_then(|t| t.as_str())
                .map(str::len),
            Some(200),
            "默认无预算不截断"
        );
    }

    /// T06.4.4：with_idempotency_opt 开关翻转（Some 注入 / None 移除）
    #[test]
    fn idempotency_opt_toggles_guard() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        assert!(!exec.idempotency_enabled());
        let exec = exec.with_idempotency_opt(Some(Arc::new(
            agent_tools::idempotency::ToolIdempotencyGuard::new(),
        )));
        assert!(exec.idempotency_enabled());
        let exec = exec.with_idempotency_opt(None);
        assert!(!exec.idempotency_enabled());
    }

    /// 测试审批门
    struct MockApproval {
        decision: ApprovalDecision,
    }
    #[async_trait::async_trait]
    impl ApprovalGate for MockApproval {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> ApprovalDecision {
            self.decision.clone()
        }
    }

    /// 记录审批请求顺序的测试门（T09.6：决策逐个按组序发起断言）
    struct RecordingApproval {
        order: Arc<std::sync::Mutex<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl ApprovalGate for RecordingApproval {
        async fn request_approval(
            &self,
            call_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> ApprovalDecision {
            self.order
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(call_id.to_string());
            ApprovalDecision::Approved
        }
    }

    /// 阻塞审批门：等待 release 通知后才返回决策（abort 中断审批测试用）
    struct BlockingApproval {
        release: Arc<tokio::sync::Notify>,
        order: Arc<std::sync::Mutex<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl ApprovalGate for BlockingApproval {
        async fn request_approval(
            &self,
            call_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> ApprovalDecision {
            self.order
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(call_id.to_string());
            self.release.notified().await;
            ApprovalDecision::Approved
        }
    }

    /// 按 call_id 选择性拒绝的测试门（并行组内单项被拒场景）
    struct DenySomeApproval {
        deny: String,
    }
    #[async_trait::async_trait]
    impl ApprovalGate for DenySomeApproval {
        async fn request_approval(
            &self,
            call_id: &str,
            _tool_name: &str,
            _args: &Value,
        ) -> ApprovalDecision {
            if call_id == self.deny {
                ApprovalDecision::Denied {
                    reason: "no".into(),
                }
            } else {
                ApprovalDecision::Approved
            }
        }
    }

    #[tokio::test]
    async fn approval_denied_is_not_fatal() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Denied {
                reason: "no".into(),
            },
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
        assert!(out.fatal.is_none());
        // 事件含 approval-requested
        assert!(out
            .events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
    }

    #[tokio::test]
    async fn approval_approved_executes() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Approved,
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert!(out.results[0].is_ok());
        assert!(out.fatal.is_none());
    }

    #[tokio::test]
    async fn approval_expired_not_fatal() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Expired,
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ApprovalExpired));
        assert!(out.fatal.is_none());
    }

    /// T09.6/P8：审批开启时并行组恢复并行——5×50ms 慢工具批耗时接近单
    /// 工具（旧串行退化 ≈ 5×50ms = 250ms，改后 ≈ max(50ms) + 审批链）
    #[tokio::test]
    async fn approval_parallel_executes_concurrently() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 50 })]);
        let exec = ToolExecutor::new(reg);
        let calls = (0..5)
            .map(|i| call(&format!("p{i}"), "slow", ToolConcurrency::Parallel))
            .collect::<Vec<_>>();
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Approved,
        };
        let start = std::time::Instant::now();
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        let elapsed = start.elapsed();
        assert!(out.results.iter().all(|r| r.is_ok()));
        assert!(
            elapsed.as_millis() < 120,
            "审批并行批耗时应接近单工具（50ms），实际 {elapsed:?}"
        );
    }

    /// T09.6/P8：审批并行组事件顺序与决策顺序——每项保持
    /// tool-start → approval-requested → tool-end；审批逐个按组序发起
    #[tokio::test]
    async fn approval_parallel_event_order_preserved() {
        let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
        let exec = ToolExecutor::new(reg);
        let ids = ["p0", "p1", "p2"];
        let calls = ids
            .iter()
            .map(|id| call(id, "echo", ToolConcurrency::Parallel))
            .collect::<Vec<_>>();
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = Arc::new(RecordingApproval {
            order: Arc::clone(&order),
        });
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        // 审批逐个按组序发起
        assert_eq!(
            *order.lock().unwrap(),
            ids.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
        // 每项事件顺序：tool-start 先于 approval-requested 先于 tool-end
        let start_pos = |id: &str| {
            out.events
                .iter()
                .position(|e| {
                    matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == id)
                })
                .unwrap()
        };
        let approval_pos = |id: &str| {
            out.events
                .iter()
                .position(|e| {
                    matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == id)
                })
                .unwrap()
        };
        let end_pos = |id: &str| {
            out.events
                .iter()
                .position(|e| {
                    matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id)
                })
                .unwrap()
        };
        for id in ids {
            assert!(
                start_pos(id) < approval_pos(id),
                "{id}: tool-start 应先于 approval-requested"
            );
            assert!(
                approval_pos(id) < end_pos(id),
                "{id}: approval-requested 应先于 tool-end"
            );
        }
    }

    /// T09.6/P8：并行组中单项被拒 → 该项 user_denied 不执行，其余项并行执行
    #[tokio::test]
    async fn approval_parallel_denied_skips_execution() {
        let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(SlowTool { ms: 0 })]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("p0", "echo", ToolConcurrency::Parallel),
            call("p1", "echo", ToolConcurrency::Parallel),
            call("p2", "echo", ToolConcurrency::Parallel),
        ];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = Arc::new(DenySomeApproval {
            deny: "p1".to_string(),
        });
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::UserDenied));
        assert!(out.results[0].is_ok());
        assert!(out.results[2].is_ok());
        assert!(out.fatal.is_none());
    }

    /// T09.6/P8：审批等待期间 abort → 已发起审批保留决策，剩余项不再
    /// 发起审批并全部以取消收场（与顺序路径逐项 abort 前置检查一致）
    #[tokio::test]
    async fn approval_parallel_abort_skips_remaining_approvals() {
        let reg = registry_with(vec![Arc::new(SlowTool { ms: 0 })]);
        let exec = ToolExecutor::new(reg);
        let calls = (0..3)
            .map(|i| call(&format!("a{i}"), "slow", ToolConcurrency::Parallel))
            .collect::<Vec<_>>();
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let release = Arc::new(tokio::sync::Notify::new());
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = Arc::new(BlockingApproval {
            release: Arc::clone(&release),
            order: Arc::clone(&order),
        });
        let abort = AbortSignal::new();
        let aborter = {
            let abort = abort.clone();
            let release = Arc::clone(&release);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                abort.abort();
                release.notify_waiters();
            })
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort))
            .await;
        aborter.await.expect("aborter 不应 panic");
        // 仅首个审批被发起（abort 后不再发起剩余审批）
        assert_eq!(order.lock().unwrap().as_slice(), &["a0".to_string()]);
        // 全部以取消收场
        assert!(out
            .results
            .iter()
            .all(|r| r.error_kind == Some(ToolErrorKind::Cancelled)));
        assert!(out
            .results
            .iter()
            .all(|r| r.error_message.as_deref() == Some("aborted")));
    }
}
