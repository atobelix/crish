//! 批调度面（SR-03 拆分 · ≠ EL）：ToolExecutor builder 装配面 + execute_batch
//!
//! 批次调度（分组 / 并行组审批逐个 await / join_all 并行执行（B4：信号量
//! 并发上限 + 计数点）/ 取消收尾）与执行器装配面（new / with_* builder /
//! clone_executor）随本模落位；
//! 单工具执行面在 `exec_single`，权限/裁决/审批等待面在 `exec_verdict`，
//! 中间件与钩子面在 `exec_middleware`。语义与拆分前逐行一致（只搬移不改行为）。

use super::*;
use crate::input::next_batch_seq;
use tokio::sync::Semaphore;

/// 并行组默认最大并发数（B4 并发上限）：`ToolBatchOptions.max_parallel`
/// 未设置（None）时生效。超出的项排队等待 permit，不拒绝、不砍批。
pub(crate) const DEFAULT_MAX_PARALLEL: usize = 4;

impl ToolExecutor {
    /// 新建执行器
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            idempotency: None,
            middleware: Vec::new(),
            middleware_timeouts: MiddlewareTimeoutConfig::default(),
            hooks: None,
            revert_policy: RevertPolicy::default(),
            concurrency_obs: Arc::new(ParallelExecObs::default()),
        }
    }

    /// 启用幂等守卫
    pub fn with_idempotency(mut self, guard: Arc<ToolIdempotencyGuard>) -> Self {
        self.idempotency = Some(guard);
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
            middleware: self.middleware,
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks,
            revert_policy: self.revert_policy,
            concurrency_obs: self.concurrency_obs,
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
            middleware: self.middleware,
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks,
            revert_policy: self.revert_policy,
            concurrency_obs: self.concurrency_obs,
        }
    }

    /// 是否启用幂等守卫（测试 / 观测用）
    pub fn idempotency_enabled(&self) -> bool {
        self.idempotency.is_some()
    }

    /// 注入中间件链（替换现有链；空链 = 不启用）。
    ///
    /// 链在审批通过（或无需审批）后、工具执行前运行 before_execute，
    /// 执行后运行 on_result / on_error（优先级语义见模块头注）。
    pub fn with_middleware(mut self, middleware: Vec<Arc<dyn ToolMiddleware>>) -> Self {
        self.middleware = middleware;
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
            middleware: self.middleware,
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks,
            revert_policy: self.revert_policy,
            concurrency_obs: self.concurrency_obs,
        }
    }

    /// 覆盖中间件钩子超时配置（E4：06 遗留 :148-152 收口；默认宽松放行
    /// 2000/2000/1000ms）。语义对齐 06「中间件自身错误语义」表：
    /// before_execute 超时 → Block；on_result 超时 → 降级透传原输出；
    /// on_error 超时 → 仅日志。
    pub fn with_middleware_timeouts(mut self, timeouts: MiddlewareTimeoutConfig) -> Self {
        self.middleware_timeouts = timeouts;
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
            middleware: self.middleware,
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks,
            revert_policy: self.revert_policy,
            concurrency_obs: self.concurrency_obs,
        }
    }

    /// 注入插件钩子注册表（Some = 启用 tool.pre/tool.post/tool.error 广播；
    /// None = 移除）。跨批共享同一注册表实例即可多批广播。
    pub fn with_hooks(mut self, hooks: Option<Arc<HookRegistry>>) -> Self {
        self.hooks = hooks;
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
            middleware: self.middleware,
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks,
            revert_policy: self.revert_policy,
            concurrency_obs: self.concurrency_obs,
        }
    }

    /// 注入 C3 回退护栏策略（I3-S6）：替换阈值（session_meta 运行时覆盖，
    /// 04 Q1：同键覆盖默认值）/ 面积评估器（真实 git 接线 / 测试注入）。
    /// 默认策略始终生效（语义估算 + 默认阈值 10 文件 / 300 行 / 24 小时）。
    pub fn with_revert_policy(mut self, policy: RevertPolicy) -> Self {
        self.revert_policy = policy;
        Self {
            registry: self.registry,
            idempotency: self.idempotency,
            middleware: self.middleware,
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks,
            revert_policy: self.revert_policy,
            concurrency_obs: self.concurrency_obs,
        }
    }
}

impl ToolExecutor {
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
        let mut results: Vec<Option<ClassifiedToolResult>> = calls.iter().map(|_| None).collect();
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
                    .execute_one(
                        calls,
                        idx,
                        ctx,
                        approval.clone(),
                        options,
                        abort,
                        &mut events,
                        &mut fatal,
                    )
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
                        // EV-09（D-03）：工具开始时刻打点（翻译层回填 timestamp）
                        occurred_at_ms: Some(crate::steering::unix_millis() as u64),
                    });
                }

                // 审批逐个发起：approval-requested 事件全组先发（防死锁
                // 硬契约，01 §五.8），再逐个等待决策；abort 中断后不再
                // 发起剩余审批（与顺序路径逐项 abort 前置检查一致）。
                // R4 T10：permission_mode 显式设置时仅「需审批」项发起
                //（dangerous → ask 问询 / plan 拒绝 / full-access 放行）；
                // 未设置时沿用既有语义（approval_enabled → 全批审批）。
                let mut approvals: Vec<Option<ApprovalDecision>> = vec![None; group.len()];
                // T-D-14：并行组逐项请求方身份（拒绝文案按来源分支：
                // 子代理申请被拒 → 含「主 agent 拒绝 / 回报主 agent」指引）
                let mut requesters: Vec<Option<ApprovalRequester>> = vec![None; group.len()];
                let approval_active = options.approval_enabled && approval.is_some();
                if approval_active {
                    if let Some(gate) = approval.as_deref() {
                        let mut needs: Vec<usize> = Vec::new();
                        for (pos, &idx) in group.iter().enumerate() {
                            let call = &calls[idx];
                            if self.call_verdict(call, options) == PermissionVerdict::NeedsApproval
                            {
                                needs.push(pos);
                                let requester = self.approval_requester_for(ctx, &call.input);
                                requesters[pos] = requester.clone();
                                events.push(ToolEvent::ApprovalRequested {
                                    call_id: call.id.clone(),
                                    tool_name: call.tool_name.clone(),
                                    args: call.input.clone(),
                                    // T-D-14：子代理 run 携带请求方身份（理由
                                    // 从入参保留键提取；主 agent run = None）
                                    requester,
                                });
                            }
                        }
                        for &pos in &needs {
                            if let Some(sig) = abort {
                                if sig.is_aborted() {
                                    break;
                                }
                            }
                            let idx = group[pos];
                            let call = &calls[idx];
                            let requester = requesters[pos].as_ref();
                            // F1-02：竞速 abort vs 审批等待（带超时）——
                            // abort 命中 → 中断剩余审批（全部按取消收场，
                            // 复用既有「无决策 = abort 中断」分支）
                            match approval_wait(
                                gate,
                                &call.id,
                                &call.tool_name,
                                &call.input,
                                requester,
                                abort,
                                options.approval_timeout,
                            )
                            .await
                            {
                                ApprovalWaitOutcome::Cancelled => break,
                                ApprovalWaitOutcome::Decision(decision) => {
                                    approvals[pos] = Some(decision);
                                    // 竞速兜底（对齐 approval.rs:139-141）：
                                    // 裁决到达时 abort 已触发 → 按取消收场，
                                    // 不再发起剩余审批
                                    if abort.map(|s| s.is_aborted()).unwrap_or(false) {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                // 执行阶段：已批准项 join_all 并行执行（拒绝/过期/abort
                // 中断/权限拒绝项不执行，直接构造结果）。
                // B4 并发上限：轻量信号量（默认 4 / max_parallel 可配）——
                // acquire_owned 排队不拒绝（FIFO 等待 permit），permit
                // 覆盖单工具执行全程，future drop（含 abort 收场）自动
                // 释放；并发计数点（AtomicUsize active/peak）随执行器
                // 实例观测。禁滑动窗口/熔断器（反过度设计红线）。
                let exec = self.clone_executor();
                let ctx_own = ctx.clone();
                let options_own = options.clone();
                let approval_own = approval.clone();
                let max_parallel = options.max_parallel.unwrap_or(DEFAULT_MAX_PARALLEL).max(1);
                let semaphore = Arc::new(Semaphore::new(max_parallel));
                let obs = Arc::clone(&exec.concurrency_obs);
                let mut futures = Vec::new();
                let mut executed: Vec<Option<(ClassifiedToolResult, Vec<ToolEvent>)>> =
                    vec![None; group.len()];
                for (pos, &idx) in group.iter().enumerate() {
                    let call = &calls[idx];
                    let verdict = self.call_verdict(call, options);
                    let decided = approvals.get(pos).and_then(Option::as_ref);
                    // 审批未启用/未注入门 → 全部执行；有决策 → 仅通过执行；
                    // 无决策（abort 中断，未发起审批）→ 按取消收场；
                    // 权限拒绝（plan 模式写类）→ 直接拒绝结果；
                    // 显式模式无门（ask 模式缺审批基础设施）→ 透传需审批状态
                    let should_execute = match (verdict, approval_active) {
                        (PermissionVerdict::Deny, _) => false,
                        (PermissionVerdict::NeedsApproval, true) => {
                            matches!(decided, Some(ApprovalDecision::Approved))
                        }
                        (PermissionVerdict::NeedsApproval, false) => {
                            options.permission_mode.is_none()
                        }
                        _ => true,
                    };
                    if !should_execute {
                        let call = &calls[idx];
                        let r = match verdict {
                            PermissionVerdict::Deny => denied_result(call, options),
                            PermissionVerdict::NeedsApproval
                                if !approval_active && options.permission_mode.is_some() =>
                            {
                                ClassifiedToolResult::error(
                                    &call.id,
                                    &call.tool_name,
                                    ToolErrorKind::ApprovalRequired,
                                    self.revert_refusal_message(call),
                                    0,
                                )
                            }
                            _ => match decided {
                                Some(ApprovalDecision::Denied { reason }) => {
                                    ClassifiedToolResult::error(
                                        &call.id,
                                        &call.tool_name,
                                        ToolErrorKind::UserDenied,
                                        denied_message(requesters[pos].is_some(), &reason),
                                        0,
                                    )
                                }
                                Some(ApprovalDecision::Expired) => {
                                    // G-9：超时 → Expired 权威语义落库（并行组
                                    // 路径同顺序路径；approval-resolved 位于
                                    // 本项 approval-requested 与 tool-end 之间）
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
                                // 无决策 = abort 中断，与顺序路径 abort 收场一致
                                _ => ClassifiedToolResult::error(
                                    &call.id,
                                    &call.tool_name,
                                    ToolErrorKind::Cancelled,
                                    "aborted",
                                    0,
                                ),
                            },
                        };
                        executed[pos] = Some((r, Vec::new()));
                        continue;
                    }
                    let call = calls[idx].clone();
                    let e = exec.clone_executor();
                    let c = ctx_own.clone();
                    let o = options_own.clone();
                    let ab = abort.cloned();
                    let g = approval_own.clone();
                    let s = Arc::clone(&semaphore);
                    let obs = Arc::clone(&obs);
                    futures.push(async move {
                        // 信号量排队获取（不拒绝；`ok()` 仅在信号量被关闭时
                        // 为 None——本批内永不关闭，防御性兜底照常执行）
                        let permit = s.acquire_owned().await.ok();
                        let _active = obs.enter();
                        let (r, extra) = e
                            .execute_single_with_retry(&call, &c, &o, ab.as_ref(), g)
                            .await;
                        obs.leave();
                        drop(permit);
                        (pos, r, extra)
                    });
                }
                let finished = futures::future::join_all(futures).await;
                for (pos, r, extra) in finished {
                    executed[pos] = Some((r, extra));
                }

                // 按组序收 tool-end（每项 tool-start → approval-requested →
                // tool-end 顺序保持；审批附加事件先于本项 tool-end 落位）
                for (pos, &idx) in group.iter().enumerate() {
                    let call = &calls[idx];
                    let (r, extra) = executed[pos].take().unwrap_or_else(|| {
                        // 防御性兜底：正常路径不应缺失（与批尾兜底语义一致）
                        (
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::Cancelled,
                                "cancelled",
                                0,
                            ),
                            Vec::new(),
                        )
                    });
                    events.extend(extra);
                    events.push(ToolEvent::ToolEnd {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        is_error: r.error_kind.is_some(),
                        duration_ms: r.duration_ms,
                        output: r.output.clone(),
                        error_code: r.error_kind.map(|k| k.error_code().to_string()),
                        error_message: r.error_message.clone(),
                        // EV-09（D-03）：原子要素透传（attempt/dedup/实际入参/打点）
                        attempt: Some(r.attempt),
                        deduplicated: Some(r.deduplicated),
                        executed_input: r.executed_input.clone(),
                        occurred_at_ms: r.occurred_at_ms,
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
            .map(|r| {
                r.unwrap_or_else(|| {
                    ClassifiedToolResult::error("", "", ToolErrorKind::Cancelled, "cancelled", 0)
                })
            })
            .collect();

        ToolBatchOutcome {
            results,
            events,
            fatal,
        }
    }
}

impl ToolExecutor {
    /// 克隆执行器（共享 Arc 状态）
    fn clone_executor(&self) -> Self {
        Self {
            registry: self.registry.clone(),
            idempotency: self.idempotency.clone(),
            middleware: self.middleware.clone(),
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks.clone(),
            revert_policy: self.revert_policy.clone(),
            concurrency_obs: Arc::clone(&self.concurrency_obs),
        }
    }

    /// 并行组并发观测句柄（B4）：活跃数 / 峰值计数点——测试断言与观测消费
    ///
    /// 当前消费者 = 本 crate 并行批测断言（并发峰值 ≤ 上限）；S3 埋点
    /// 消费为后续切片，届时移除 allow
    #[allow(dead_code)]
    pub(crate) fn concurrency_obs(&self) -> &Arc<ParallelExecObs> {
        &self.concurrency_obs
    }
}
