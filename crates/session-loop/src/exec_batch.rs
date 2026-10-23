//! 批调度面（SR-03 拆分 · ≠ EL）：ToolExecutor builder 装配面 + execute_batch
//!
//! 批次调度（分组 / 并行组审批逐个 await / join_all 并行执行（B4：信号量
//! 并发上限 + 计数点）/ 取消收尾）与执行器装配面（new / with_* builder
//! 按需克隆/共享引用）随本模落位；
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

    /// 原位设置幂等守卫：Some=启用幂等守卫，None=移除守卫（零克隆）。
    pub fn set_idempotency_opt(&mut self, guard: Option<Arc<ToolIdempotencyGuard>>) -> &mut Self {
        self.idempotency = guard;
        self
    }

    /// 链式配置幂等守卫：Some=启用幂等守卫，None=移除守卫（零克隆）。
    ///
    /// AgentSessionLoop::with_options 派生状态同步用（T06.4.4：开关翻转时
    /// 不必重建执行器，直接替换守卫槽位）。
    pub fn with_idempotency_opt(mut self, guard: Option<Arc<ToolIdempotencyGuard>>) -> Self {
        self.idempotency = guard;
        self
    }

    /// 是否启用幂等守卫（测试 / 观测用）
    pub fn idempotency_enabled(&self) -> bool {
        self.idempotency.is_some()
    }

    /// 原位替换中间件链（空链 = 不启用，零克隆）。
    pub fn set_middleware(&mut self, middleware: Vec<Arc<dyn ToolMiddleware>>) -> &mut Self {
        self.middleware = middleware;
        self
    }

    /// 注入中间件链（替换现有链；空链 = 不启用，零克隆）。
    ///
    /// 链在审批通过（或无需审批）后、工具执行前运行 before_execute，
    /// 执行后运行 on_result / on_error（优先级语义见模块头注）。
    pub fn with_middleware(mut self, middleware: Vec<Arc<dyn ToolMiddleware>>) -> Self {
        self.middleware = middleware;
        self
    }

    /// 原位覆盖中间件钩子超时配置（零克隆）。
    pub fn set_middleware_timeouts(&mut self, timeouts: MiddlewareTimeoutConfig) -> &mut Self {
        self.middleware_timeouts = timeouts;
        self
    }

    /// 覆盖中间件钩子超时配置（E4：06 遗留 :148-152 收口；默认宽松放行
    /// 2000/2000/1000ms）。语义对齐 06「中间件自身错误语义」表：
    /// before_execute 超时 → Block；on_result 超时 → 降级透传原输出；
    /// on_error 超时 → 仅日志。
    pub fn with_middleware_timeouts(mut self, timeouts: MiddlewareTimeoutConfig) -> Self {
        self.middleware_timeouts = timeouts;
        self
    }

    /// 原位设置插件钩子注册表（Some = 启用 tool.pre/tool.post/tool.error 广播；None = 移除，零克隆）。
    pub fn set_hooks(&mut self, hooks: Option<Arc<HookRegistry>>) -> &mut Self {
        self.hooks = hooks;
        self
    }

    /// 注入插件钩子注册表（Some = 启用 tool.pre/tool.post/tool.error 广播；
    /// None = 移除）。跨批共享同一注册表实例即可多批广播。
    pub fn with_hooks(mut self, hooks: Option<Arc<HookRegistry>>) -> Self {
        self.hooks = hooks;
        self
    }

    /// 原位设置 C3 回退护栏策略（零克隆）。
    pub fn set_revert_policy(&mut self, policy: RevertPolicy) -> &mut Self {
        self.revert_policy = policy;
        self
    }

    /// 注入 C3 回退护栏策略（I3-S6）：替换阈值（session_meta 运行时覆盖，
    /// 04 Q1：同键覆盖默认值）/ 面积评估器（真实 git 接线 / 测试注入）。
    /// 默认策略始终生效（语义估算 + 默认阈值 10 文件 / 300 行 / 24 小时）。
    pub fn with_revert_policy(mut self, policy: RevertPolicy) -> Self {
        self.revert_policy = policy;
        self
    }
}

impl ToolExecutor {
    /// 执行一批工具调用
    ///
    /// 返回结果顺序与入参一致；`abort` 置位时返回已就绪结果，其余标记 cancelled。
    /// C1d：并发编排面（分组 / 审批逐个 await / 信号量并发 / 取消 / 事件序列）
    /// 已拆入 [BatchPlanner]（分组）+ [BatchRunner]（逐组执行），本函数仅保留
    /// 批级编排骨架，语义与拆分前逐行一致。
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

        // 分组编排（BatchPlanner：Parallel 组可并行；Sequential/Exclusive 顺序）
        let sequence = BatchPlanner::plan(calls);

        // 逐组执行（BatchRunner：审批逐个 await + 并行执行（B4 信号量并发
        // 上限）+ 取消收尾 / 事件序列）
        let runner = BatchRunner {
            executor: self,
            calls,
            ctx,
            approval,
            options,
            abort,
        };
        runner
            .run(sequence, &mut events, &mut results, &mut fatal)
            .await;

        events.push(ToolEvent::BatchEnd { batch_id });

        // 防御性兜底：正常路径下（含取消路径）全部结果应有值；
        // debug 构建断言暴露遗漏路径，生产保持降级容错（不回退 panic）。
        // Tier-1（02 §3.1.3 DEL-04）：缺失项绑定 calls[i] 真值 id/tool_name，
        // 彻底消除 ("","") 空串伪造（空串 id 无法与任何调用配对）。
        debug_assert!(results.iter().all(Option::is_some));
        let results = results
            .into_iter()
            .enumerate()
            .map(|(i, r)| {
                r.unwrap_or_else(|| {
                    let call = &calls[i];
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::Cancelled,
                        "cancelled: execution aborted or skipped",
                        0,
                    )
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

/// 批次分组计划（C1d 拆段：纯结构搬移，语义与 [ToolExecutor::execute_batch]
/// 原地分组一致）：返回按执行顺序排列的组序列——Parallel 组（可并行）先行，
/// 随后 Sequential/Exclusive 项各成单元素组依次执行（保持工具间依赖顺序）。
struct BatchPlanner;

impl BatchPlanner {
    /// 分组（Parallel 组可并行；Sequential/Exclusive 顺序执行）+ 顺序项
    /// 夹在并行组之后执行（保持工具间依赖顺序：并行组先发，随后顺序项依次）
    fn plan(calls: &[ToolBatchCall]) -> Vec<Vec<usize>> {
        let mut parallel_group: Vec<usize> = Vec::new();
        let mut order: Vec<usize> = Vec::new();
        for (i, call) in calls.iter().enumerate() {
            match call.concurrency {
                ToolConcurrency::Parallel => parallel_group.push(i),
                _ => order.push(i),
            }
        }
        let mut sequence: Vec<Vec<usize>> = Vec::new();
        if !parallel_group.is_empty() {
            sequence.push(parallel_group);
        }
        for i in order {
            sequence.push(vec![i]);
        }
        sequence
    }
}

/// 批次执行器（C1d 拆段：审批 / 并发 / 取消 / 事件序列编排面；语义与
/// [ToolExecutor::execute_batch] 原地逐行一致）。审批仍走外部 [ApprovalGate]，
/// 本结构只编排等待 / 竞速 / 收尾，不改变审批语义。
struct BatchRunner<'a> {
    executor: &'a ToolExecutor,
    calls: &'a [ToolBatchCall],
    ctx: &'a ToolExecCtx,
    approval: Option<Arc<dyn ApprovalGate>>,
    options: &'a ToolBatchOptions,
    abort: Option<&'a crate::safe_point::AbortSignal>,
}

impl BatchRunner<'_> {
    /// 逐组执行序列：单元素组走顺序路径；组大小 >1 走并行组路径。
    /// fatal 且 fail_strategy=CancelSiblings 时取消剩余兄弟并提前收尾。
    async fn run(
        &self,
        sequence: Vec<Vec<usize>>,
        events: &mut Vec<ToolEvent>,
        results: &mut [Option<ClassifiedToolResult>],
        fatal: &mut Option<String>,
    ) {
        'outer: for group in sequence {
            if group.len() == 1 {
                self.run_single(group[0], events, results, fatal).await;
            } else {
                self.run_parallel(&group, events, results, fatal).await;
            }
            // fatal 且 CancelSiblings 语义：取消剩余兄弟并提前收尾
            if fatal.is_some() && self.options.fail_strategy == FailStrategy::CancelSiblings {
                mark_rest_cancelled(self.calls, results, events);
                break 'outer;
            }
        }
    }

    /// 顺序路径单元素组执行（execute_one 内在 abort 前置检查 + 审批等待）
    async fn run_single(
        &self,
        idx: usize,
        events: &mut Vec<ToolEvent>,
        results: &mut [Option<ClassifiedToolResult>],
        fatal: &mut Option<String>,
    ) {
        let r = self
            .executor
            .execute_one(
                self.calls,
                idx,
                self.ctx,
                self.approval.clone(),
                self.options,
                self.abort,
                events,
                fatal,
            )
            .await;
        results[idx] = Some(r);
    }

    /// 并行组路径（T09.6/P8：审批模式恢复并行，不再退化串行）：
    /// 事件顺序契约（tool_events.rs 头注）每项保持 tool-start →
    /// approval-requested → tool-end；执行模型 A（AU-04 F9）：审批逐个 await
    /// （UX 与事件顺序不变），通过后执行阶段 join_all 并行（批延迟 =
    /// max(工具耗时) + 审批链）。拆为四个职责单一子段：组起始事件 →
    /// 审批等待 → 并行执行 → 按组序收 tool-end。
    async fn run_parallel(
        &self,
        group: &[usize],
        events: &mut Vec<ToolEvent>,
        results: &mut [Option<ClassifiedToolResult>],
        fatal: &mut Option<String>,
    ) {
        self.emit_group_starts(group, events);
        let approval_active = self.options.approval_enabled && self.approval.is_some();
        let (approvals, requesters) = self.collect_approvals(group, approval_active, events).await;
        let executed = self
            .execute_group(group, &approvals, &requesters, approval_active, events)
            .await;
        self.collect_group_endings(group, executed, events, results, fatal);
    }

    /// 并行组起始事件（每个成员 tool-start 打点）
    fn emit_group_starts(&self, group: &[usize], events: &mut Vec<ToolEvent>) {
        // EV-09（D-03）：工具开始时刻打点（翻译层回填 timestamp；同组批量起始单次采样）
        let occurred_at_ms = Some(conex_shared::time::unix_millis() as u64);
        for &idx in group {
            let call = &self.calls[idx];
            events.push(ToolEvent::ToolStart {
                call_id: call.id.clone(),
                tool_name: call.tool_name.clone(),
                input: call.input.clone(),
                category: call.category,
                concurrency: call.concurrency,
                summary: call.summary.clone(),
                occurred_at_ms,
            });
        }
    }

    /// 审批逐个发起：approval-requested 事件全组先发（防死锁硬契约，
    /// 01 §五.8），再逐个等待决策；abort 中断后不再发起剩余审批（与顺序
    /// 路径逐项 abort 前置检查一致）。R4 T10：permission_mode 显式设置时仅
    /// 「需审批」项发起（dangerous → ask 问询 / plan 拒绝 / full-access 放行）；
    /// 未设置时沿用既有语义（approval_enabled → 全批审批）。
    async fn collect_approvals(
        &self,
        group: &[usize],
        approval_active: bool,
        events: &mut Vec<ToolEvent>,
    ) -> (
        Vec<Option<ApprovalDecision>>,
        Vec<Option<ApprovalRequester>>,
    ) {
        let mut approvals: Vec<Option<ApprovalDecision>> = vec![None; group.len()];
        // T-D-14：并行组逐项请求方身份（拒绝文案按来源分支：
        // 子代理申请被拒 → 含「主 agent 拒绝 / 回报主 agent」指引）
        let mut requesters: Vec<Option<ApprovalRequester>> = vec![None; group.len()];
        if approval_active {
            if let Some(gate) = self.approval.as_deref() {
                let mut needs: Vec<usize> = Vec::new();
                for (pos, &idx) in group.iter().enumerate() {
                    let call = &self.calls[idx];
                    if self.executor.call_verdict(call, self.options)
                        == PermissionVerdict::NeedsApproval
                    {
                        needs.push(pos);
                        let requester = self.executor.approval_requester_for(self.ctx, &call.input);
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
                    if let Some(sig) = self.abort {
                        if sig.is_aborted() {
                            break;
                        }
                    }
                    let idx = group[pos];
                    let call = &self.calls[idx];
                    let requester = requesters[pos].as_ref();
                    // F1-02：竞速 abort vs 审批等待（带超时）——abort 命中 →
                    // 中断剩余审批（全部按取消收场，复用既有「无决策 = abort
                    // 中断」分支）
                    match approval_wait(
                        gate,
                        &call.id,
                        &call.tool_name,
                        &call.input,
                        requester,
                        self.abort,
                        self.options.approval_timeout,
                    )
                    .await
                    {
                        ApprovalWaitOutcome::Cancelled => break,
                        ApprovalWaitOutcome::Decision(decision) => {
                            approvals[pos] = Some(decision);
                            // 竞速兜底（对齐 approval.rs:139-141）：裁决到达时
                            // abort 已触发 → 按取消收场，不再发起剩余审批
                            if self.abort.map(|s| s.is_aborted()).unwrap_or(false) {
                                break;
                            }
                        }
                    }
                }
            }
        }
        (approvals, requesters)
    }

    /// 执行阶段：已批准项 join_all 并行执行（拒绝/过期/abort 中断/权限拒绝
    /// 项不执行，直接构造结果）。B4 并发上限：轻量信号量（默认 4 /
    /// max_parallel 可配）——acquire 排队不拒绝（FIFO 等待 permit），
    /// permit 覆盖单工具执行全程，future drop（含 abort 收场）自动释放；
    /// 并发计数点（AtomicUsize active/peak）随执行器实例观测。禁滑动窗口 /
    /// 熔断器（反过度设计红线）。
    async fn execute_group(
        &self,
        group: &[usize],
        approvals: &[Option<ApprovalDecision>],
        requesters: &[Option<ApprovalRequester>],
        approval_active: bool,
        events: &mut Vec<ToolEvent>,
    ) -> Vec<Option<(ClassifiedToolResult, Vec<ToolEvent>)>> {
        // I5 / SL-COMPAT-18 共享引用收敛：BatchRunner 全程传递 `&ToolExecutor` / `&ToolBatchCall` /
        // `&ToolExecCtx` / `&ToolBatchOptions` / `Option<&AbortSignal>` / `&Semaphore` 引用，
        // 消除每批 N 次 `ToolBatchCall`（含大体积 `input: Value`）与上下文深克隆。
        let exec = self.executor;
        let ctx = self.ctx;
        let options = self.options;
        let abort = self.abort;
        let max_parallel = self
            .options
            .max_parallel
            .unwrap_or(DEFAULT_MAX_PARALLEL)
            .max(1);
        let semaphore = Semaphore::new(max_parallel);
        let sem_ref = &semaphore;
        let obs = &exec.concurrency_obs;
        let mut futures = Vec::with_capacity(group.len());
        let mut executed: Vec<Option<(ClassifiedToolResult, Vec<ToolEvent>)>> =
            vec![None; group.len()];
        for (pos, &idx) in group.iter().enumerate() {
            let call = &self.calls[idx];
            let verdict = self.executor.call_verdict(call, self.options);
            let decided = approvals.get(pos).and_then(Option::as_ref);
            // 审批未启用/未注入门 → 全部执行；有决策 → 仅通过执行；
            // 无决策（abort 中断，未发起审批）→ 按取消收场；
            // 权限拒绝（plan 模式写类）→ 直接拒绝结果；
            // 无门需审批项（A3 fail-closed）→ 拒绝，不透传执行
            let should_execute = match (verdict, approval_active) {
                (PermissionVerdict::Deny, _) => false,
                (PermissionVerdict::NeedsApproval, true) => {
                    matches!(decided, Some(ApprovalDecision::Approved))
                }
                // A3 fail-closed（P1 权限归一）：审批未启用/无门时需审批项
                // 一律不透传执行（不再按 mode=None 直通执行）
                (PermissionVerdict::NeedsApproval, false) => false,
                _ => true,
            };
            if !should_execute {
                let r = match verdict {
                    PermissionVerdict::Deny => {
                        denied_result(call, self.options, Some(&self.executor.registry))
                    }
                    // A3 fail-closed（P1 权限归一）：无审批基础设施 → 需审批
                    // 项拒绝（ApprovalRequired，不透传执行）
                    PermissionVerdict::NeedsApproval if !approval_active => {
                        ClassifiedToolResult::error(
                            &call.id,
                            &call.tool_name,
                            ToolErrorKind::ApprovalRequired,
                            self.executor.revert_refusal_message(call),
                            0,
                        )
                    }
                    _ => match decided {
                        Some(ApprovalDecision::Denied { reason }) => ClassifiedToolResult::error(
                            &call.id,
                            &call.tool_name,
                            ToolErrorKind::UserDenied,
                            denied_message(requesters[pos].is_some(), reason),
                            0,
                        ),
                        Some(ApprovalDecision::Expired) => {
                            // G-9：超时 → Expired 权威语义落库（并行组路径同
                            // 顺序路径；approval-resolved 位于本项
                            // approval-requested 与 tool-end 之间）
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
            let g = self.approval.clone();
            futures.push(async move {
                // 信号量排队获取（不拒绝；`ok()` 仅在信号量被关闭时为 None——
                // 本批内永不关闭，防御性兜底照常执行）
                let permit = sem_ref.acquire().await.ok();
                let _active = obs.enter();
                let (r, extra) = exec
                    .execute_single_with_retry(call, ctx, options, abort, g)
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
        executed
    }

    /// 按组序收 tool-end（每项 tool-start → approval-requested → tool-end
    /// 顺序保持；审批附加事件先于本项 tool-end 落位）、登记结果与致命判定
    fn collect_group_endings(
        &self,
        group: &[usize],
        mut executed: Vec<Option<(ClassifiedToolResult, Vec<ToolEvent>)>>,
        events: &mut Vec<ToolEvent>,
        results: &mut [Option<ClassifiedToolResult>],
        fatal: &mut Option<String>,
    ) {
        for (pos, &idx) in group.iter().enumerate() {
            let call = &self.calls[idx];
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
            if self.executor.result_is_fatal(call, &r) {
                *fatal = Some(
                    r.error_message
                        .clone()
                        .unwrap_or_else(|| "tool failed".into()),
                );
            }
            results[idx] = Some(r);
        }
    }
}

impl ToolExecutor {
    /// 并行组并发观测句柄（B4）：活跃数 / 峰值计数点。
    ///
    /// 当前消费方：`tool_exec_tests.rs` 并行批测
    ///（`parallel_group_concurrency_peak_bounded_by_default` /
    /// `parallel_group_max_parallel_one_serializes` /
    /// `parallel_group_max_parallel_four_caps_peak`）断言峰值 ≤ 上限、
    /// 批后 `active == 0`。生产路径只经字段 `concurrency_obs` 做
    /// `enter`/`leave`，不读本访问器，故 `dead_code` 仅对非 test 编译成立。
    ///
    /// 接线计划：若批级观测要对齐 B5 计数原语打 tracing 字段（peak/active），
    /// 经本访问器读取，接入点优先 `BatchRunner::collect_group_endings`
    /// 或 `ToolBatchOutcome` 附加观测；禁止另开 Atomic 计数器。
    /// 删除条件：上述三测不再读本句柄，且 `collect_group_endings` /
    /// `ToolBatchOutcome` 仍无生产读取方时，下轮删除本方法与 `#[allow]`。
    #[allow(dead_code)]
    pub(crate) fn concurrency_obs(&self) -> &Arc<ParallelExecObs> {
        &self.concurrency_obs
    }
}
