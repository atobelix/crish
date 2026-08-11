//! 工具批处理执行器（任务书 B3.5：executeToolBatch 等价）
//!
//! 行为要点（01 §2.8 / §五.8，05 §2.3）：
//! - 并行/顺序：concurrency=Parallel 的工具并行执行，Sequential/Exclusive 顺序执行；
//! - 未知工具 → tool.not_found；非法入参 → tool.invalid_input（不 panic）；
//! - 超时（ToolBatchOptions.timeout）→ tool.timeout；
//! - abort 置位：已就绪结果返回，未执行项标记 cancelled；
//! - 失败策略：cancel-siblings（致命失败后同批未执行项 cancelled）/ continue-drain；
//! - fatalOnError 判定排除 softDeny/timedOut/cancelled/approval_expired/
//!   user_denied/approval_required；
//! - 审批：approval-requested 事件先于挂起等待发出（防死锁）；
//! - 审批等待（F1-02 修复）：批级审批统一竞速 abort vs 审批门（带超时，
//!   缺省 120s 与编排层兜底对齐）——abort 触发即取消收场，gate 不响应
//!   时超时收敛为 Expired，run 不再无限悬挂；
//! - 审批并行（T09.6/P8）：审批模式并行组不再退化串行——审批逐个 await
//!   （执行模型 A，UX 与事件顺序不变），通过后执行阶段 join_all 并行；
//! - 权限判定（R4 T10）：permission_mode 显式设置时按 dangerous 标记三态
//!   判定（ask 问询 / plan 拒绝写类 / full-access 放行）；requires_approval
//!   错误分类为 ApprovalRequired（不再折叠 SoftDeny），走真实审批——用户
//!   同意后重试执行，拒绝返回明确拒绝结果；ctx.ask 接线 ApprovalChannel；
//! - 单工具执行复用 agent-tools 的 execute_with_output_policy（幂等+输出预算）；
//! - 中间件链 + 插件钩子（ToolMiddleware / HookRegistry，见模块中部「中间件与
//!   审批的优先级语义」）：
//!   - 审批通过（或无需审批）后、工具执行前运行 middleware before_execute 链
//!     （可改输入 / Block 阻止）→ 广播 tool.pre 事件；
//!   - 执行成功后广播 tool.post（成功）→ middleware on_result 链（可改写输出）；
//!     执行失败广播 tool.post（失败）→ middleware on_error 链（仅观察）。
//!
//! ## 中间件与审批的优先级语义（决策记录，详见
//! docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md）
//!
//! **审批优先于中间件**：PermissionVerdict::Deny 直接拒绝、NeedsApproval 走
//! 审批（拒绝/过期不进入中间件链）；中间件 before_execute 的 Block 只拦截
//! 「审批已通过」的调用——中间件无法绕过审批，审批拒绝也不会被中间件吞掉。
//! 顺序：权限判定 → 审批 → middleware before 链 → tool.pre → 执行 →
//! tool.post → middleware on_result/on_error 链。
//!
//! 中间件自身错误语义：
//! - before_execute 返回 Err → 视为阻止执行（与 Block 同语义，文案带中间件名）；
//! - on_result 返回 Err → 记录日志并降级透传原输出（后置钩子错误不改变
//!   已完成的工具执行结果）；
//! - on_error 返回 Err → 记录日志（仅观察，不吞原错误）。
//!
//! 语义来源：01-session-loop-semantics.md §2.8 / §五.8；05-test-mapping.md §2.3

use crate::approval::ApprovalChannel;
use crate::approval_router::{
    approval_reason_from_args, relay_denied_message, requester_from_context,
};
use crate::hooks::{HookEvent, HookRegistry};
use crate::safe_point::AbortSignal;
use crate::tool_events::{
    ApprovalDecision, ApprovalGate, ApprovalRequester, ClassifiedToolResult, FailStrategy,
    ToolBatchOptions, ToolErrorKind, ToolEvent,
};
use agent_tools::context::{
    AbortToken, AskCallback, ExploreDocsQuotaContext, NoopAskChannel, ToolContext,
};
use agent_tools::note_backend::NoteBackendHandle;
use agent_tools::definition::ToolError;
use agent_tools::executor::{execute_stream_with_output_policy, ExecutorContext, ToolExecutionPolicy};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::write_paths::WritePathRegistry;
use agent_tools::middleware::{
    AfterExecuteResult, BeforeExecuteResult, MiddlewareTimeoutConfig, ToolExecutionContext,
    ToolMiddleware,
};
use agent_tools::permission::{decide, PermissionMode, PermissionVerdict};
use agent_tools::registry::ToolRegistry;
use agent_tools::revert::RevertPolicy;
use agent_tools::streaming::ToolProgress;
use conex_types::tool::{ToolBatchCall, ToolConcurrency, ToolProgressUpdate};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 批处理执行上下文
#[derive(Debug, Clone, Default)]
pub struct ToolExecCtx {
    /// 运行标识
    pub run_id: String,
    /// 会话标识
    pub session_id: String,
    /// 工作目录
    pub cwd: Option<String>,
    /// 父 run 归属（T-D-14 权限传递层）：None = 主 agent run / 无父 run；
    /// Some = 子代理 run 的父 run id（spawner 装配，经 SessionLoopOptions
    /// 透传）——审批请求据此判定来源（子代理 → 裁决者 = 主 agent）
    pub parent_run_id: Option<String>,
    /// 工作区根目录（R3 T9：会话级 ToolContext.workspace_root 来源；
    /// None 时回退 cwd / 当前目录）
    pub workspace_root: Option<PathBuf>,
    /// 写路径互斥注册表（I4-M3：会话级，与 workspace_root 同源——装配
    /// 于 [crate::r#loop::AgentSessionLoop::with_options]，总接线点
    /// T-EG-06；None = 写工具不强制互斥，向后兼容）
    pub write_claims: Option<Arc<WritePathRegistry>>,
    /// 探索类文档配额上下文（I6-M11 C5：含配额 store 实例；None = 不
    /// 检查——主 agent 默认不受配额约束，04 C5「主 agent 自身不消耗」）
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    /// 产出目录解析器（G01：resolve_output_dir 工具后端；None = 未装配，
    /// 工具返回 common.unsupported——与 subagent_spawner 接线模式同款）
    pub output_dir:
        Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>>,
    /// 笔记后端（Round6 / W4-E：`query_blocks` / `document_outline` /
    /// `document_apply_md` / `send_to_note` 真管线；None = 未接线，工具
    /// 返回 `note_backend_unwired` 占位——允许 Option 透传，结构字段须存在
    /// 且可注入；真实实现见 `conex-note-runtime::StoreNoteBackend`）
    pub note_backend: Option<NoteBackendHandle>,
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

/// 批级审批缺省超时（120s，F1-02 修复）：与编排层 approval_router 的
/// APPROVAL_TIMEOUT=120s 超时兜底对齐——审批卡片丢失/事件桥断连时
/// 内核强制收敛（Expired），run 不再无限悬挂。
const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

/// 审批等待结果（F1-02 修复：abort 竞速 / 门决策 / 超时三路收敛）
enum ApprovalWaitOutcome {
    /// abort 竞速命中（不伪造审批事件，按取消收场——对齐
    /// approval.rs:135 语义）
    Cancelled,
    /// 审批门在超时内返回决策（超时 → [ApprovalDecision::Expired]，
    /// 调用方既有 Expired 分支直接复用）
    Decision(ApprovalDecision),
}

/// 审批等待统一竞速封装（F1-02 根因修复）
///
/// 批级审批三个 await 点（顺序路径 / 并行组审批循环 /
/// requires_approval 重试）共用本函数：`tokio::select!{biased}` 竞速
/// abort 等待 vs 审批门（带超时），对齐 approval.rs:131-160 的
/// `wait_aborted` + 竞速兜底 is_aborted 复查模式——abort 触发即打断
/// 审批等待，超时兜底保证 gate 不响应时有限收敛。
///
/// 超时语义：`timeout` 为 None 时用 [DEFAULT_APPROVAL_TIMEOUT]；超时
/// 命中返回 `Expired`（既有 Expired 分支复用：非致命、喂回模型）。
/// 竞速兜底：超时/裁决与 abort 同时就绪时取消优先（L3 强停语义）。
async fn approval_wait(
    gate: &dyn ApprovalGate,
    call_id: &str,
    tool_name: &str,
    input: &Value,
    requester: Option<&ApprovalRequester>,
    abort: Option<&AbortSignal>,
    timeout: Option<Duration>,
) -> ApprovalWaitOutcome {
    let t = timeout.unwrap_or(DEFAULT_APPROVAL_TIMEOUT);
    let wait = gate.request_approval(call_id, tool_name, input, requester);
    let cancelled = async {
        match abort {
            Some(sig) => sig.wait_aborted().await,
            // 无批级信号：取消分支永不就绪（不参与竞速）
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        biased;
        () = cancelled => ApprovalWaitOutcome::Cancelled,
        result = tokio::time::timeout(t, wait) => {
            // 竞速兜底（对齐 approval.rs:139-141）：等待期间 abort 与
            // 裁决/超时同时就绪 → 取消优先（L3 强停语义）
            if abort.map(|s| s.is_aborted()).unwrap_or(false) {
                return ApprovalWaitOutcome::Cancelled;
            }
            match result {
                Ok(decision) => ApprovalWaitOutcome::Decision(decision),
                // 超时：Expired（调用方既有分支复用，非致命）
                Err(_) => ApprovalWaitOutcome::Decision(ApprovalDecision::Expired),
            }
        }
    }
}

/// 工具批处理执行器
pub struct ToolExecutor {
    registry: Arc<ToolRegistry>,
    /// 可选幂等守卫（None 表示禁用幂等）
    idempotency: Option<Arc<ToolIdempotencyGuard>>,
    /// 中间件链（审批通过后、执行前生效；空链 = 不启用）
    middleware: Vec<Arc<dyn ToolMiddleware>>,
    /// 中间件钩子超时竞速配置（E4：06 遗留 :148-152 收口；默认宽松放行
    /// 2000/2000/1000ms，经 [Self::with_middleware_timeouts] 覆盖）
    middleware_timeouts: MiddlewareTimeoutConfig,
    /// 插件钩子注册表（tool.pre / tool.post 广播；None = 不启用）
    hooks: Option<Arc<HookRegistry>>,
    /// C3 回退护栏策略（I3-S6）：git 回退形态 + 面积超阈值 → 需审批
    /// （无论权限模式，full-access 不豁免；审批人 = 用户）。默认启用
    /// （语义估算评估器 + 默认阈值），引擎可经 [Self::with_revert_policy]
    /// 注入 session_meta 覆盖阈值 / 真实 git 面积评估器。
    revert_policy: RevertPolicy,
}

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
        }
    }

    /// 是否启用幂等守卫（测试 / 观测用）
    pub fn idempotency_enabled(&self) -> bool {
        self.idempotency.is_some()
    }

    /// 中间件链名称快照（#[cfg(test)] 观测面：loop 装配测试断言默认链
    /// 生效——T-EG-06 装配后链 = 写前自动备份中间件）
    #[cfg(test)]
    pub fn middleware_names(&self) -> Vec<String> {
        self.middleware
            .iter()
            .map(|m| m.name().to_string())
            .collect()
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
        }
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
                    .execute_one(calls, idx, ctx, approval.clone(), options, abort, &mut events, &mut fatal)
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
                // 中断/权限拒绝项不执行，直接构造结果）
                let exec = self.clone_executor();
                let ctx_own = ctx.clone();
                let options_own = options.clone();
                let approval_own = approval.clone();
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
                                )
                            }
                            _ => match decided {
                                Some(ApprovalDecision::Denied { reason }) => {
                                    ClassifiedToolResult::error(
                                        &call.id,
                                        &call.tool_name,
                                        ToolErrorKind::UserDenied,
                                        denied_message(requesters[pos].is_some(), &reason),
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
                                    )
                                }
                                // 无决策 = abort 中断，与顺序路径 abort 收场一致
                                _ => ClassifiedToolResult::error(
                                    &call.id,
                                    &call.tool_name,
                                    ToolErrorKind::Cancelled,
                                    "aborted",
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
                    futures.push(async move {
                        let (r, extra) = e
                            .execute_single_with_retry(&call, &c, &o, ab.as_ref(), g)
                            .await;
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
    // G2 允许理由（clippy::too_many_arguments）：参数为工具执行上下文聚合
    // 注入（批调用/下标/执行上下文/审批门/批选项/中止信号/事件收集/致命
    // 错误槽），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低。
    #[allow(clippy::too_many_arguments)]
    async fn execute_one(
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

        // R4 T10：权限判定 → 放行 / 拒绝 / 需审批。permission_mode 显式
        // 设置时 dangerous 标记进入判定（ask 问询 / plan 拒绝 / full-access
        // 放行）；未设置时沿用既有语义（approval 开启 → 全批审批）。
        let verdict = self.call_verdict(call, options);
        let r = match (&approval, options.approval_enabled) {
            (Some(gate), true) => match verdict {
                PermissionVerdict::Allow => {
                    let (r, extra) = self
                        .execute_single_with_retry(call, ctx, options, abort, Some(Arc::clone(gate)))
                        .await;
                    events.extend(extra);
                    r
                }
                PermissionVerdict::Deny => denied_result(call, options),
                PermissionVerdict::NeedsApproval => {
                    // 审批：approval-requested 事件先发出，再挂起等待（防死锁）
                    // T-D-14：请求方身份（子代理 run + 理由）随事件与门调用透传
                    let requester = self.approval_requester_for(ctx, &call.input);
                    events.push(ToolEvent::ApprovalRequested {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        args: call.input.clone(),
                        requester: requester.clone(),
                    });
                    // F1-02：竞速 abort vs 审批等待（带超时）——abort 命中
                    // 走取消收场，超时 → Expired 既有分支
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
                            )
                        }
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                            // G-9：超时 → Expired 权威语义落库——审批超时
                            //（APPROVAL_TIMEOUT）在引擎侧收敛为
                            // approval-resolved(expired) 事件进批事件流
                            //（翻译层映射 AgentEvent 随会话流持久化/广播，
                            // 多端过期状态统一；approve/deny 由壳层命令
                            // 路径落事件，避免双发）
                            events.push(ToolEvent::ApprovalResolved {
                                call_id: call.id.clone(),
                                decision: ApprovalDecision::Expired,
                            });
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::ApprovalExpired,
                                "approval expired",
                            )
                        }
                    }
                }
            },
            // 审批未启用 / 无门：plan 模式写类仍拒绝；显式 ask 模式缺审批
            // 基础设施时危险项透传需审批状态（不再 SoftDeny 折叠）
            _ => match verdict {
                PermissionVerdict::Deny => denied_result(call, options),
                PermissionVerdict::NeedsApproval if options.permission_mode.is_some() => {
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::ApprovalRequired,
                        self.revert_refusal_message(call),
                    )
                }
                _ => {
                    let (r, extra) = self
                        .execute_single_with_retry(call, ctx, options, abort, approval.clone())
                        .await;
                    events.extend(extra);
                    r
                }
            },
        };
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
    ///
    /// R4 T10：组装 ToolContext 时接线审批通道（ctx.ask）——有审批门时
    /// [ApprovalChannel]（真实审批请求 + abort 取消），full-access 模式
    /// [NoopAskChannel]（自动放行，T0–T3 语义），其余未接线 None（工具
    /// 自报 tool.requires_approval → 执行器分类 ApprovalRequired 透传）。
    /// 返回（结果, 审批附加事件）。
    async fn execute_single(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        // 未知工具
        let tool = match self.registry.get(&call.tool_name) {
            Some(t) => t,
            None => {
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::NotFound,
                        format!("unknown tool: {}", call.tool_name),
                    ),
                    Vec::new(),
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
        // R3 T9：会话级 ToolContext——workspace_root 优先取显式注入，
        // 其次 cwd，最后当前目录（与既有 BuiltinToolConfig 默认语义对齐）。
        // R4 T10：ask 通道接线（approval 事件记录由通道侧收集，执行后取回
        // 并入批事件流，保持 tool-start → approval-requested → tool-end 顺序）。
        let abort_token = AbortToken::new();
        let mut approval_channel: Option<Arc<ApprovalChannel>> = None;
        // T-D-14：请求方身份（子代理 run + 理由）随审批通道透传——工具内
        // 审批提问（ctx.ask）同样按来源路由；主 agent run = None
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
            abort_token,
            ask,
            workspace_root: ctx
                .workspace_root
                .clone()
                .or_else(|| ctx.cwd.clone().map(PathBuf::from))
                .unwrap_or_else(|| {
                    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                }),
            // I4-M3：写路径互斥注册表——会话级装配（与 workspace_root 同源，
            // 由 AgentSessionLoop::with_options 创建并经 ToolExecCtx 注入；
            // None = 写工具不强制互斥，测试与直连场景向后兼容）
            write_claims: ctx.write_claims.clone(),
            // 写声明持有者：当前 run 标识（M2 子代理执行上下文注入子代理
            // run id；主循环装配为 run 级归属——同 run 内工具再声明不互斥，
            // 跨 run 重叠即冲突）
            write_claim_holder: Some(ctx.run_id.clone()),
            // I6-M11 C5：探索类文档配额上下文（含配额 store 实例，会话级
            // 装配经 ToolExecCtx 透传；None = 不检查——非探索类不受配额
            // 约束，04 C5：主 agent 自身不消耗）
            explore_docs_quota: ctx.explore_docs_quota.clone(),
            // T-EG-08 REQ-G01：产出目录解析服务——经 ToolExecCtx 透传
            //（loop 装配面默认注入 OutputWorkspace；None = 未接线，
            // resolve_output_dir 返回 common.unsupported）
            output_dir: ctx.output_dir.clone(),
            // 后台任务管理器 / 日志落盘根未接线（A1 域新字段占位：None =
            // 无后台任务能力、截断不落盘；真实接线由引擎装配面注入）
            background: None,
            log_root: None,
            // T-40（记忆韧性轮次 5）：压缩块只读访问服务——本轮仅占位
            // None（search_context/decompress_context 返回
            // common.unsupported）；轮次 6 由引擎侧注入
            // CompressionContextStore 实现（conex-db compression_blocks）
            compression_store: None,
            // Round6 / W4-E：笔记后端经 ToolExecCtx 透传（None = unwired 占位；
            // 引擎 / SessionLoopOptions 可注入 conex-note-runtime::StoreNoteBackend）
            note_backend: ctx.note_backend.clone(),
        };
        // ── 中间件链 + 插件钩子（审批已通过，进入执行面；优先级语义
        //    见模块头注：审批优先于中间件，中间件 Block 不绕过审批）──
        let mw_ctx = ToolExecutionContext {
            session_id: Some(ctx.session_id.clone()),
            run_id: Some(ctx.run_id.clone()),
            tool_call_id: Some(call.id.clone()),
            cwd: ctx.cwd.clone(),
        };
        // 1) middleware before_execute 链：可修改入参 / Block 阻止（仅对
        //    「审批已通过」的调用生效；链中任一 Err 视为阻止执行）。
        //    E4：每项包超时竞速窗口（默认 2000ms，中间件可配）——超时视为
        //    Err → Block（守门者报错 = 不放行，06:57）；abort 竞速偏置——
        //    abort 在链执行期间触发 → 本调用取消（超时窗口内可取消）。
        let mut current_input = call.input.clone();
        let mut blocked: Option<String> = None;
        for m in &self.middleware {
            let result = run_hook_with_timeout(
                self.middleware_timeouts.before_execute,
                abort,
                m.before_execute(tool.as_ref(), current_input.clone(), &mw_ctx),
            )
            .await;
            let Some(result) = result else {
                // abort 在中间件 before 链竞速窗口内触发 → 取消收场
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::Cancelled,
                        "aborted",
                    ),
                    Vec::new(),
                );
            };
            match result {
                Ok(Ok(BeforeExecuteResult::Proceed { modified_input })) => {
                    if let Some(v) = modified_input {
                        current_input = v;
                    }
                }
                Ok(Ok(BeforeExecuteResult::Block { reason })) => {
                    blocked = Some(format!("被中间件 {} 阻止：{reason}", m.name()));
                    break;
                }
                Ok(Err(e)) => {
                    blocked = Some(format!("中间件 {} 前置钩子错误：{e}", m.name()));
                    break;
                }
                Err(_elapsed) => {
                    blocked = Some(format!(
                        "中间件 {} 前置钩子超时（{}ms），按阻止处理",
                        m.name(),
                        self.middleware_timeouts.before_execute.as_millis()
                    ));
                    break;
                }
            }
        }
        // 2) tool.pre 事件广播（HookRegistry；handler Block = 阻止执行；
        //    propagate 失败降级为阻止，不中断批执行）
        if blocked.is_none() {
            if let Some(hooks) = &self.hooks {
                let event = HookEvent::ToolPre {
                    session_id: ctx.session_id.clone(),
                    tool_name: call.tool_name.clone(),
                    input: current_input.clone(),
                };
                // I8-E1：HookRegistry::dispatch 已转 async（async_trait +
                // timeout 竞速窗口，03 §2.4/§3.5）；tool.pre 广播 await
                match hooks.dispatch(&event).await {
                    Ok(outcome) => {
                        if let Some(reason) = outcome.blocked {
                            blocked = Some(format!("tool.pre 钩子阻止：{reason}"));
                        }
                    }
                    Err(e) => {
                        blocked = Some(format!("tool.pre 钩子失败（propagate）：{e}"));
                    }
                }
            }
        }
        if let Some(reason) = blocked {
            return (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::ExecutionFailed,
                    reason,
                ),
                Vec::new(),
            );
        }

        let policy = ToolExecutionPolicy {
            // T06.4.2：输出预算从 ToolBatchOptions 透传（None = 不截断，
            // 与 executor.rs 的 summarize 截断语义接通）
            output_budget_bytes: options.output_budget_bytes,
            idempotency: self.idempotency.is_some(),
        };
        let guard = self.idempotency.clone();
        // 执行入参 = 中间件链修改后的最终入参（未经 before 链时与原始入参一致）
        let exec_input = current_input.clone();
        let start = std::time::Instant::now();
        // S1（TOOLS-01 §3.1.5）：流式执行 + 进度出站——Progress 经
        // [tool_progress_update] 映射为 ToolEvent::ToolProgress 入进度缓冲，
        // 执行完成后并入事件链（时序 tool-start → tool-update* → tool-end；
        // ToolUpdate 为展示面不进消息历史，终值仍由 ToolEnd 承载）。Content
        // 阶段 1 不发射（映射返回 None 直接丢弃）；幂等命中路径零 Progress
        //（executor 内早退不回调，D3）；abort/超时路径已入队的进度保留
        //（流被 drop 前已回调，契约「已发 Progress 保留」）。
        let progress_buffer: Arc<Mutex<Vec<ToolEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let progress: Option<Arc<dyn Fn(ToolProgress) + Send + Sync>> = Some(Arc::new({
            let buffer = Arc::clone(&progress_buffer);
            let call_id = call.id.clone();
            move |p: ToolProgress| {
                if let Some(update) = tool_progress_update(&p) {
                    buffer.lock().unwrap().push(ToolEvent::ToolProgress {
                        call_id: call_id.clone(),
                        update,
                    });
                }
            }
        }));
        // 执行体 future：幂等守卫开启时透传守卫（execute_stream_with_output_policy
        // 的幂等去重 + 输出预算语义，T06.4.2/T06.4.4）
        let execute = async {
            if let Some(g) = guard.as_ref() {
                execute_stream_with_output_policy(
                    tool.as_ref(),
                    exec_input.clone(),
                    &tool_ctx,
                    &exec_ctx,
                    Some(g.as_ref()),
                    &policy,
                    progress.clone(),
                )
                .await
            } else {
                execute_stream_with_output_policy(
                    tool.as_ref(),
                    exec_input.clone(),
                    &tool_ctx,
                    &exec_ctx,
                    None,
                    &policy,
                    progress.clone(),
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

        // 审批附加事件（approval-requested 等，执行后取回）
        let recorded = approval_channel
            .as_ref()
            .map(|c| c.take_recorded())
            .unwrap_or_default();
        // S1：进度事件并入事件链（执行 future 已 resolve/drop，缓冲不再
        // 增长）——后续所有返回分支（abort/超时/成功/失败）自动携带已发
        // 进度，保持 tool-start → tool-update* → tool-end 时序与
        // 「abort 后已发 Progress 保留」契约
        let mut recorded = recorded;
        recorded.extend(std::mem::take(&mut *progress_buffer.lock().unwrap()));

        if let Some(sig) = abort {
            if sig.is_aborted() {
                return (
                    ClassifiedToolResult::error(
                        &call.id,
                        &call.tool_name,
                        ToolErrorKind::Cancelled,
                        "aborted",
                    ),
                    recorded,
                );
            }
        }

        match outcome {
            // 竞速获胜：abort 已触发（上方检查兜底），防御性按取消处理
            None => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Cancelled,
                    "aborted",
                ),
                recorded,
            ),
            Some(Err(_elapsed)) => (
                ClassifiedToolResult::error(
                    &call.id,
                    &call.tool_name,
                    ToolErrorKind::Timeout,
                    format!(
                        "tool {} timed out after {:?}",
                        call.tool_name, options.timeout
                    ),
                ),
                recorded,
            ),
            Some(Ok(Ok(tool_result))) => {
                if tool_result.deduplicated {
                    // 幂等去重：未真正执行，跳过 on_result 改写链，仅广播
                    // tool.post（成功，duration=0）保持事件对称
                    if let Some(hooks) = &self.hooks {
                        let _ = hooks
                            .dispatch(&HookEvent::ToolPost {
                                session_id: ctx.session_id.clone(),
                                tool_name: call.tool_name.clone(),
                                output: tool_result.output.clone(),
                                duration_ms: 0,
                                is_error: false,
                            })
                            .await;
                    }
                    (
                        ClassifiedToolResult::ok(&call.id, &call.tool_name, tool_result.output, 0),
                        recorded,
                    )
                } else {
                    // 3) middleware on_result 链：可改写输出；Err/超时记录
                    //    日志并降级透传原输出（后置钩子错误不改变已完成的
                    //    执行结果；E4 超时语义 = 06:58）
                    let mut final_output = tool_result.output;
                    for m in &self.middleware {
                        let result = run_hook_with_timeout(
                            self.middleware_timeouts.on_result,
                            None,
                            m.on_result(
                                tool.as_ref(),
                                &current_input,
                                final_output.clone(),
                                &mw_ctx,
                            ),
                        )
                        .await;
                        match result {
                            Some(Ok(Ok(AfterExecuteResult::Passthrough))) => {}
                            Some(Ok(Ok(AfterExecuteResult::Replace(v)))) => final_output = v,
                            Some(Ok(Err(e))) => {
                                tracing::error!(
                                    middleware = %m.name(),
                                    error = %e,
                                    "中间件 on_result 失败，降级透传原输出"
                                );
                            }
                            Some(Err(_elapsed)) => {
                                tracing::error!(
                                    middleware = %m.name(),
                                    timeout_ms = self.middleware_timeouts.on_result.as_millis(),
                                    "中间件 on_result 超时，降级透传原输出"
                                );
                            }
                            None => {
                                // abort=None 竞速路径不可能返回 None（防御性
                                // 兜底，与降级语义一致：透传原输出）
                                tracing::error!(
                                    middleware = %m.name(),
                                    "中间件 on_result 竞速异常，降级透传原输出"
                                );
                            }
                        }
                    }
                    // 4) tool.post 事件广播（成功；广播中间件改写后的最终输出）
                    if let Some(hooks) = &self.hooks {
                        let _ = hooks
                            .dispatch(&HookEvent::ToolPost {
                                session_id: ctx.session_id.clone(),
                                tool_name: call.tool_name.clone(),
                                output: final_output.clone(),
                                duration_ms,
                                is_error: false,
                            })
                            .await;
                    }
                    (
                        ClassifiedToolResult::ok(
                            &call.id,
                            &call.tool_name,
                            final_output,
                            duration_ms,
                        ),
                        recorded,
                    )
                }
            }
            Some(Ok(Err(err))) => {
                // 5) middleware on_error 链（仅观察；Err/超时记录日志，
                //    不吞原错误；E4 超时语义 = 06:59）
                for m in &self.middleware {
                    let result = run_hook_with_timeout(
                        self.middleware_timeouts.on_error,
                        None,
                        m.on_error(tool.as_ref(), &current_input, &err, &mw_ctx),
                    )
                    .await;
                    match result {
                        Some(Ok(Ok(()))) => {}
                        Some(Ok(Err(e))) => {
                            tracing::error!(
                                middleware = %m.name(),
                                error = %e,
                                "中间件 on_error 失败（仅观察，不吞原错误）"
                            );
                        }
                        Some(Err(_elapsed)) => {
                            tracing::error!(
                                middleware = %m.name(),
                                timeout_ms = self.middleware_timeouts.on_error.as_millis(),
                                "中间件 on_error 超时（仅观察，不吞原错误）"
                            );
                        }
                        None => {
                            // abort=None 竞速路径不可能返回 None（防御性兜底）
                            tracing::error!(
                                middleware = %m.name(),
                                "中间件 on_error 竞速异常（仅观察，不吞原错误）"
                            );
                        }
                    }
                }
                // 6) tool.post 事件广播（失败；output 承载错误文案）。
                //    I8-E1：dispatch 已转 async（async_trait + 竞速窗口）
                if let Some(hooks) = &self.hooks {
                    let _ = hooks
                        .dispatch(&HookEvent::ToolPost {
                            session_id: ctx.session_id.clone(),
                            tool_name: call.tool_name.clone(),
                            output: serde_json::json!(err.to_string()),
                            duration_ms,
                            is_error: true,
                        })
                        .await;
                    // I8-E1：tool.error 追加广播（tool-end isError 分支，M13
                    // 映射第 7 行；on 模式可转 retry 信号——保留 ToolHook.onError
                    // 控制能力；失败吞掉 + 计数，结果保持）
                    let _ = hooks
                        .dispatch(&HookEvent::ToolError {
                            session_id: ctx.session_id.clone(),
                            tool_name: call.tool_name.clone(),
                            error: err.to_string(),
                        })
                        .await;
                }
                let (kind, msg) = classify_tool_error(&err);
                (
                    ClassifiedToolResult::error(&call.id, &call.tool_name, kind, msg),
                    recorded,
                )
            }
        }
    }

    /// 单工具执行 + requires_approval 真实审批（R4 T10）
    ///
    /// 工具返回 tool.requires_approval 时分类为 ApprovalRequired：有审批门
    /// 则发起真实审批请求（approval-requested 先发后等，防死锁），用户
    /// 同意后重试执行该工具调用一次（二次 ApprovalRequired 直接透传，
    /// 防循环）；拒绝返回明确拒绝结果（Denied 语义）；无门时透传需审批
    /// 状态给模型（不再伪装成 SoftDeny 可自行降级）。
    /// 返回（结果, 审批附加事件）。
    async fn execute_single_with_retry(
        &self,
        call: &ToolBatchCall,
        ctx: &ToolExecCtx,
        options: &ToolBatchOptions,
        abort: Option<&crate::safe_point::AbortSignal>,
        approval: Option<Arc<dyn ApprovalGate>>,
    ) -> (ClassifiedToolResult, Vec<ToolEvent>) {
        let (r, extra) = self
            .execute_single(call, ctx, options, abort, approval.clone())
            .await;
        if r.error_kind != Some(ToolErrorKind::ApprovalRequired) {
            return (r, extra);
        }
        // requires_approval：按权限模式裁决（ask → 真实审批；plan → 拒绝；
        // full-access → 自动放行；未设置 → 审批）
        let verdict = match options.permission_mode {
            Some(mode) => decide(false, true, mode),
            None => PermissionVerdict::NeedsApproval,
        };
        match verdict {
            PermissionVerdict::Deny => (denied_result(call, options), extra),
            PermissionVerdict::Allow => {
                // full-access：自动放行，直接重试执行一次
                let (r2, extra2) =
                    self.execute_single(call, ctx, options, abort, approval).await;
                (r2, [extra, extra2].concat())
            }
            PermissionVerdict::NeedsApproval => match approval {
                Some(gate) => {
                    let mut extra = extra;
                    // T-D-14：请求方身份（子代理 run + 理由）随事件与门调用透传
                    let requester = self.approval_requester_for(ctx, &call.input);
                    extra.push(ToolEvent::ApprovalRequested {
                        call_id: call.id.clone(),
                        tool_name: call.tool_name.clone(),
                        args: call.input.clone(),
                        requester: requester.clone(),
                    });
                    // F1-02：竞速 abort vs 审批等待（带超时）——abort 命中
                    // 走取消收场，超时 → Expired 既有分支
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
                            ),
                            extra,
                        ),
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Approved) => {
                            let (r2, extra2) = self
                                .execute_single(call, ctx, options, abort, Some(gate))
                                .await;
                            (r2, [extra, extra2].concat())
                        }
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Denied { reason }) => (
                            ClassifiedToolResult::error(
                                &call.id,
                                &call.tool_name,
                                ToolErrorKind::UserDenied,
                                denied_message(requester.is_some(), &reason),
                            ),
                            extra,
                        ),
                        ApprovalWaitOutcome::Decision(ApprovalDecision::Expired) => {
                            // G-9：超时 → Expired 权威语义落库（requires_approval
                            // 重试路径同顺序路径；事件并入 extra 进批事件流）
                            extra.push(ToolEvent::ApprovalResolved {
                                call_id: call.id.clone(),
                                decision: ApprovalDecision::Expired,
                            });
                            (
                                ClassifiedToolResult::error(
                                    &call.id,
                                    &call.tool_name,
                                    ToolErrorKind::ApprovalExpired,
                                    "approval expired",
                                ),
                                extra,
                            )
                        }
                    }
                }
                // 无审批门：透传需审批状态（不再 SoftDeny 折叠）
                None => (r, extra),
            },
        }
    }

    /// 权限判定（R4 T10）：permission_mode 显式设置时按工具 dangerous
    /// 标记 + 模式三态判定；未设置（None）时沿用既有语义——approval
    /// 开启即视为需审批。
    ///
    /// C3（I3-S6）判定点（C4/S10b 经此挂载，不并写本文件主体）：入参含
    /// 命令文本时先过回退护栏——GitRevertShape 段 + 面积超阈值 →
    /// NeedsApproval（无论权限模式，full-access 不豁免；plan 保持更严
    /// Deny），面积小 → 按既有矩阵。红线语义仍由工具内门禁 100% 拦截
    /// （S2），本层不重复。审批人 = 用户：NeedsApproval 走既有
    /// ApprovalGate 链路等待用户裁决，主 Agent 仅转呈。
    fn call_verdict(&self, call: &ToolBatchCall, options: &ToolBatchOptions) -> PermissionVerdict {
        if let Some(command) = call.input.get("command").and_then(serde_json::Value::as_str) {
            let mode = options.permission_mode.unwrap_or_default();
            if let Some(verdict) = self.revert_policy.gate_verdict_command(command, mode) {
                return verdict;
            }
        }
        match options.permission_mode {
            Some(mode) => {
                let dangerous = self
                    .registry
                    .get(&call.tool_name)
                    .map(|t| t.definition().dangerous)
                    .unwrap_or(false);
                decide(dangerous, false, mode)
            }
            None => PermissionVerdict::NeedsApproval,
        }
    }

    /// 构造审批请求方（T-D-14 权限传递层，任务书第 4 步）：子代理 run
    /// （有父 run 归属）→ Some（`run_id` = 子代理 run id，申请理由从工具
    /// 入参保留键 [crate::approval_router::APPROVAL_REASON_ARG_KEY] 提取）；
    /// 主 agent run（无父 run 归属）→ None（裁决者 = 用户，既有流程不变）。
    fn approval_requester_for(&self, ctx: &ToolExecCtx, args: &Value) -> Option<ApprovalRequester> {
        requester_from_context(
            &ctx.run_id,
            ctx.parent_run_id.as_deref(),
            approval_reason_from_args(args),
        )
    }

    /// C3 兜底拒绝文案：大面积回退 + 审批通道缺失（approval=None）时阈值
    /// 检查仍生效（04 C3 第 2/5 条 + 01 方案 §4 关键关系：安全优先，不做
    /// 无限等待），拒绝结果带面积摘要与替代路径指引；非回退门禁项保持
    /// 既有通用文案。
    fn revert_refusal_message(&self, call: &ToolBatchCall) -> String {
        if let Some(command) = call.input.get("command").and_then(serde_json::Value::as_str) {
            if let Some(msg) = self.revert_policy.refusal_message(command) {
                return msg;
            }
        }
        format!("{} requires approval", call.tool_name)
    }

    /// 克隆执行器（共享 Arc 状态）
    fn clone_executor(&self) -> Self {
        Self {
            registry: self.registry.clone(),
            idempotency: self.idempotency.clone(),
            middleware: self.middleware.clone(),
            middleware_timeouts: self.middleware_timeouts,
            hooks: self.hooks.clone(),
            revert_policy: self.revert_policy.clone(),
        }
    }
}

/// 中间件钩子超时竞速助手（E4：06 遗留 :148-152 收口）
///
/// - 无 abort 信号：`tokio::time::timeout(timeout, fut)`；
/// - 有 abort 信号：竞速**偏置 abort**（`biased`，先触发先生效）——
///   abort 触发返回 None，调用方按取消收场（超时窗口内可取消）；
/// - 超时返回 `Err(Elapsed)`，由调用方按 06「中间件自身错误语义」表
///   处置（before_execute → Block；on_result → 降级透传；on_error → 日志）。
async fn run_hook_with_timeout<T>(
    timeout: Duration,
    abort: Option<&crate::safe_point::AbortSignal>,
    fut: impl std::future::Future<Output = T>,
) -> Option<Result<T, tokio::time::error::Elapsed>> {
    match abort {
        Some(sig) => tokio::select! {
            biased;
            _ = sig.wait_aborted() => None,
            result = tokio::time::timeout(timeout, fut) => Some(result),
        },
        None => Some(tokio::time::timeout(timeout, fut).await),
    }
}

/// S1 出站映射：ToolProgress → ToolProgressUpdate（TOOLS-01 §3.1.5）
///
/// - `Text` → `text` 承载 + `metadata.kind = "tool-progress"`；
/// - `Custom` → `json` 承载 + `metadata.kind = subkind`（与前端预留的
///   `metadata.kind === 'tool-args-delta'` 消费面同槽位扩展）；
/// - `Content` → 阶段 1 仅类型定义，返回 None（不发射，`content-blocks`
///   kind 字面量预留）。
fn tool_progress_update(p: &ToolProgress) -> Option<ToolProgressUpdate> {
    match p {
        ToolProgress::Text { text } => Some(ToolProgressUpdate {
            text: Some(text.clone()),
            json: None,
            metadata: Some(serde_json::json!({ "kind": "tool-progress" })),
        }),
        ToolProgress::Custom { subkind, payload } => Some(ToolProgressUpdate {
            text: None,
            json: Some(payload.clone()),
            metadata: Some(serde_json::json!({ "kind": subkind })),
        }),
        ToolProgress::Content { .. } => None,
    }
}

/// 工具错误 → 分类
///
/// R4 T10：`tool.requires_approval` 不再落入软拒绝分类，归类为
/// [ToolErrorKind::ApprovalRequired]——真实审批状态透传（有审批门时
/// [ToolExecutor::execute_single_with_retry] 发起真实审批并重试）；
/// tool.soft_deny 已无工具产生，落到 execution_failed（枚举保留兼容）。
fn classify_tool_error(err: &ToolError) -> (ToolErrorKind, String) {    let code = err.code();
    let message = err.to_string();
    let kind = match code {
        "tool.not_found" => ToolErrorKind::NotFound,
        "tool.invalid_input" => ToolErrorKind::InvalidInput,
        "tool.requires_approval" => ToolErrorKind::ApprovalRequired,
        "tool.user_denied" => ToolErrorKind::UserDenied,
        "tool.approval_expired" => ToolErrorKind::ApprovalExpired,
        "tool.cancelled" => ToolErrorKind::Cancelled,
        _ => ToolErrorKind::ExecutionFailed,
    };
    (kind, message)
}

/// permission 拒绝结果（plan 模式写类工具 / 越界命令拒绝，Denied 语义）
fn denied_result(call: &ToolBatchCall, options: &ToolBatchOptions) -> ClassifiedToolResult {
    let mode = options
        .permission_mode
        .unwrap_or(PermissionMode::Ask)
        .as_engine_str();
    ClassifiedToolResult::error(
        &call.id,
        &call.tool_name,
        ToolErrorKind::UserDenied,
        format!("permission denied by {mode} mode: {}", call.tool_name),
    )
}

/// 审批拒绝文案（T-D-14）：子代理申请被拒（`subagent_request = true`）→
/// 含「主 agent 拒绝」与「回报主 agent」指引（对齐 explore_quota 先例）；
/// 主 agent run 拒绝 → 既有「user denied: …」文案（零回归）。
fn denied_message(subagent_request: bool, reason: &str) -> String {
    if subagent_request {
        relay_denied_message(reason)
    } else {
        format!("user denied: {reason}")
    }
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
    use crate::hooks::{HookAction, HookError, HookEventKind, HookFailStrategy, HookHandler, HookRegistry};
    use crate::safe_point::AbortSignal;
    use agent_tools::context::ToolContext;
    use agent_tools::definition::{Tool, ToolDefinition};
    use agent_tools::middleware::ToolExecutionContext;
    use agent_tools::permission::PermissionMode;
    use agent_tools::registry::ToolRegistry;
    use agent_tools::streaming::{ContentBlock, ToolProgress, ToolStream, ToolStreamItem};
    use async_trait::async_trait;
    use serde_json::Value;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
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
        async fn execute(
            &self,
            _ctx: &ToolContext,
            args: Value,
        ) -> Result<Value, ToolError> {
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
        async fn execute(
            &self,
            _ctx: &ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
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
        async fn execute(
            &self,
            _ctx: &ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
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
        async fn execute(
            &self,
            _ctx: &ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            Err(ToolError::execution_failed("failfatal", "boom"))
        }
    }

    /// S1 流式测试工具：execute_stream 推送 Text/Custom/Content 进度 + 终值
    ///（验证 execute_stream_with_output_policy 进度回调与事件接线）
    struct StreamTool {
        text_chunks: Vec<String>,
        custom: Option<(String, Value)>,
        with_content: bool,
    }
    #[async_trait::async_trait]
    impl Tool for StreamTool {
        fn name(&self) -> &str {
            "stream"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "stream".into(),
                description: "streaming tool".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(
            &self,
            _ctx: &ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            // 流式路径不调用 execute（与 execute_stream_with_output_policy
            // 消费 execute_stream 一致）
            Err(ToolError::execution_failed("stream", "execute 不应被调用"))
        }
        async fn execute_stream(&self, _ctx: &ToolContext, _args: Value) -> ToolStream {
            let mut items = Vec::new();
            for t in &self.text_chunks {
                items.push(ToolStreamItem::Progress(ToolProgress::Text { text: t.clone() }));
            }
            if let Some((subkind, payload)) = &self.custom {
                items.push(ToolStreamItem::Progress(ToolProgress::Custom {
                    subkind: subkind.clone(),
                    payload: payload.clone(),
                }));
            }
            if self.with_content {
                items.push(ToolStreamItem::Progress(ToolProgress::Content {
                    blocks: vec![ContentBlock {
                        kind: "image".into(),
                        data: serde_json::json!({}),
                    }],
                }));
            }
            items.push(ToolStreamItem::Terminal(Ok(serde_json::json!({ "final": true }))));
            Box::pin(futures::stream::iter(items))
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
            ..Default::default()
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

    /// S1 出站映射纯函数（TOOLS-01 §3.1.5）：Text/Custom/Content 三形态
    #[test]
    fn progress_update_mapping_shapes() {
        // Text → text 承载 + metadata.kind = tool-progress
        let u = tool_progress_update(&ToolProgress::Text { text: "hi".into() }).unwrap();
        assert_eq!(u.text.as_deref(), Some("hi"));
        assert!(u.json.is_none());
        assert_eq!(u.metadata.as_ref().unwrap()["kind"], "tool-progress");
        // Custom → json 承载 + metadata.kind = subkind（tool-args-delta 同槽位）
        let u = tool_progress_update(&ToolProgress::Custom {
            subkind: "tool-args-delta".into(),
            payload: serde_json::json!({ "a": 1 }),
        })
        .unwrap();
        assert!(u.text.is_none());
        assert_eq!(u.json.as_ref().unwrap()["a"], 1);
        assert_eq!(u.metadata.as_ref().unwrap()["kind"], "tool-args-delta");
        // Content → 阶段 1 不发射（返回 None）
        assert!(tool_progress_update(&ToolProgress::Content { blocks: vec![] }).is_none());
    }

    /// S1 事件链路集成：流式工具进度 → ToolEvent::ToolProgress 入事件链，
    /// 时序 tool-start → tool-update* → tool-end（Content 不发射）
    #[tokio::test]
    async fn streaming_progress_events_between_start_and_end() {
        let reg = registry_with(vec![Arc::new(StreamTool {
            text_chunks: vec!["第一块".into(), "第二块".into()],
            custom: Some(("phase".into(), serde_json::json!({ "step": 1 }))),
            with_content: true,
        })]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "stream", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok());
        assert_eq!(out.results[0].output["final"], true);
        // 事件序列：BatchStart → ToolStart → ToolProgress×3（2 Text + 1
        // Custom；Content 不发射）→ ToolEnd → BatchEnd
        let kinds: Vec<&str> = out
            .events
            .iter()
            .map(|e| match e {
                ToolEvent::BatchStart { .. } => "batch-start",
                ToolEvent::ToolStart { .. } => "tool-start",
                ToolEvent::ToolProgress { .. } => "tool-progress",
                ToolEvent::ToolEnd { .. } => "tool-end",
                ToolEvent::BatchEnd { .. } => "batch-end",
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "batch-start",
                "tool-start",
                "tool-progress",
                "tool-progress",
                "tool-progress",
                "tool-end",
                "batch-end"
            ],
            "时序契约：tool-start → tool-update* → tool-end"
        );
        // 进度载荷形状：Text 两帧 + Custom 一帧，全部携带 call_id
        let updates: Vec<&ToolProgressUpdate> = out
            .events
            .iter()
            .filter_map(|e| match e {
                ToolEvent::ToolProgress { update, .. } => Some(update),
                _ => None,
            })
            .collect();
        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0].text.as_deref(), Some("第一块"));
        assert_eq!(updates[0].metadata.as_ref().unwrap()["kind"], "tool-progress");
        assert_eq!(updates[1].text.as_deref(), Some("第二块"));
        assert!(updates[1].json.is_none());
        assert_eq!(updates[2].json.as_ref().unwrap()["step"], 1);
        assert_eq!(updates[2].metadata.as_ref().unwrap()["kind"], "phase");
        for e in &out.events {
            if let ToolEvent::ToolProgress { call_id, .. } = e {
                assert_eq!(call_id, "c1", "进度事件携带工具调用 id");
            }
        }
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
        async fn execute(
            &self,
            _ctx: &ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
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
            _requester: Option<&ApprovalRequester>,
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
            _requester: Option<&ApprovalRequester>,
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
            _requester: Option<&ApprovalRequester>,
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
            _requester: Option<&ApprovalRequester>,
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

    /// 按序返回决策的测试门（T10：批级审批通过 → 重试审批拒绝场景）
    struct SequenceApproval {
        decisions: std::sync::Mutex<VecDeque<ApprovalDecision>>,
    }

    impl SequenceApproval {
        fn new(decisions: Vec<ApprovalDecision>) -> Self {
            Self {
                decisions: std::sync::Mutex::new(VecDeque::from(decisions)),
            }
        }
    }

    #[async_trait::async_trait]
    impl ApprovalGate for SequenceApproval {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
            _requester: Option<&ApprovalRequester>,
        ) -> ApprovalDecision {
            self.decisions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_front()
                .unwrap_or(ApprovalDecision::Approved)
        }
    }

    /// 挂起审批门：永不返回决策（模拟审批卡片丢失 / 事件桥断连——
    /// 只模拟「审批不响应」，超时/abort 收敛必须由内核 select!/timeout
    /// 真实完成，PS-04 T4.2 防作弊条款 2）
    struct PendingApproval;

    #[async_trait::async_trait]
    impl ApprovalGate for PendingApproval {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
            _requester: Option<&ApprovalRequester>,
        ) -> ApprovalDecision {
            std::future::pending().await
        }
    }

    /// 前 hang_after 次问询返回 Approved，之后挂起（requires_approval
    /// 重试审批挂起测试用：批级审批先通过，重试审批不响应）
    struct HangAfterApprovals {
        hang_after: usize,
        consulted: AtomicUsize,
    }

    impl HangAfterApprovals {
        fn new(hang_after: usize) -> Self {
            Self {
                hang_after,
                consulted: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl ApprovalGate for HangAfterApprovals {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
            _requester: Option<&ApprovalRequester>,
        ) -> ApprovalDecision {
            let n = self.consulted.fetch_add(1, Ordering::SeqCst);
            if n < self.hang_after {
                ApprovalDecision::Approved
            } else {
                std::future::pending().await
            }
        }
    }

    /// 记录请求方身份的测试门（T-D-14：断言子代理请求透传 requester）
    struct RequesterRecordingApproval {
        decision: ApprovalDecision,
        received: Arc<std::sync::Mutex<Option<ApprovalRequester>>>,
    }
    #[async_trait::async_trait]
    impl ApprovalGate for RequesterRecordingApproval {
        async fn request_approval(
            &self,
            _call_id: &str,
            _tool_name: &str,
            _args: &Value,
            requester: Option<&ApprovalRequester>,
        ) -> ApprovalDecision {
            *self.received.lock().unwrap() = requester.cloned();
            self.decision.clone()
        }
    }

    /// 测试工具：恒返回 tool.requires_approval（T10 ApprovalRequired 分类）
    struct AlwaysRequiresApprovalTool;

    #[async_trait::async_trait]
    impl Tool for AlwaysRequiresApprovalTool {
        fn name(&self) -> &str {
            "always_approval"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "always_approval".into(),
                description: "always requires approval".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: true,
                fatal_on_error: false,
            })
        }
        async fn execute(
            &self,
            _ctx: &ToolContext,
            _args: Value,
        ) -> Result<Value, ToolError> {
            Err(ToolError::new(
                "tool.requires_approval",
                "command requires approval",
            ))
        }
    }

    /// 测试工具：首调返回 tool.requires_approval，次调成功
    /// （T10：用户同意后重试执行该工具调用）
    #[derive(Clone)]
    struct ApprovalOnceTool {
        calls: Arc<AtomicUsize>,
    }

    impl ApprovalOnceTool {
        fn new() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl Tool for ApprovalOnceTool {
        fn name(&self) -> &str {
            "approval_once"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "approval_once".into(),
                description: "first call requires approval".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: true,
                fatal_on_error: false,
            })
        }
        async fn execute(
            &self,
            _ctx: &ToolContext,
            args: Value,
        ) -> Result<Value, ToolError> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(ToolError::new(
                    "tool.requires_approval",
                    "command requires approval",
                ))
            } else {
                Ok(args)
            }
        }
    }

    /// 测试工具：dangerous 标记且执行成功（T10 权限判定消费 dangerous）
    struct DangerousTool;

    #[async_trait::async_trait]
    impl Tool for DangerousTool {
        fn name(&self) -> &str {
            "dangerous_tool"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "dangerous_tool".into(),
                description: "dangerous but succeeds".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: true,
                fatal_on_error: false,
            })
        }
        async fn execute(
            &self,
            _ctx: &ToolContext,
            args: Value,
        ) -> Result<Value, ToolError> {
            Ok(args)
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

    // ── F1-02（PS-04 T4.2）：批级审批挂起红测试 ──
    // 缺陷：三个 `gate.request_approval(...).await` 裸挂起（顺序路径 /
    // 并行组审批循环 / requires_approval 重试），abort 信号在审批等待
    // 期间无法打断 run，run 无限悬挂（F1-02）。

    /// T4.2-R3（红，顺序路径 abort 竞速）：审批门挂起不返回 + abort 置位
    /// → 批执行必须**立即**收敛为取消（不等待 gate）。修复前裸挂起，
    /// abort 无法打断，外层 tokio timeout 触发（红）
    #[tokio::test]
    async fn approval_hang_sequential_abort_race_converges() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = Arc::new(PendingApproval);
        let abort = AbortSignal::new();
        // 50ms 后触发 abort（审批仍挂起中）
        let aborter = {
            let abort = abort.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                abort.abort();
            })
        };
        let start = std::time::Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
        )
        .await
        .expect("审批挂起必须被 abort 竞速收敛（不得悬挂）");
        let elapsed = start.elapsed();
        aborter.await.expect("aborter 不应 panic");
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(out.results[0].error_message.as_deref(), Some("aborted"));
        assert!(
            elapsed.as_millis() < 1000,
            "abort 竞速应在数百 ms 内生效（不等 gate 不响应窗口），实际 {elapsed:?}"
        );
    }

    /// T4.2-R3（红，并行组 abort 竞速）：并行组审批循环挂起 + abort →
    /// 全组有限时间收敛为取消（不悬挂），approval-requested 全组先发
    /// 事件顺序契约保持
    #[tokio::test]
    async fn approval_hang_parallel_group_abort_race_converges() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("p0", "echo", ToolConcurrency::Parallel),
            call("p1", "echo", ToolConcurrency::Parallel),
        ];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = Arc::new(PendingApproval);
        let abort = AbortSignal::new();
        let aborter = {
            let abort = abort.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                abort.abort();
            })
        };
        let start = std::time::Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
        )
        .await
        .expect("并行组审批挂起必须被 abort 竞速收敛（不得悬挂）");
        let elapsed = start.elapsed();
        aborter.await.expect("aborter 不应 panic");
        // 全部以取消收场（无决策 = abort 中断，复用既有取消路径）
        assert!(out
            .results
            .iter()
            .all(|r| r.error_kind == Some(ToolErrorKind::Cancelled)));
        assert!(
            elapsed.as_millis() < 1000,
            "并行组 abort 竞速应在数百 ms 内收敛，实际 {elapsed:?}"
        );
        // approval-requested 全组先发契约保持（等待前已全部广播）
        let approvals = out
            .events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
            .count();
        assert!(approvals >= 1, "审批请求事件应先于等待发出");
    }

    /// T4.2-R4（红，requires_approval 重试路径 abort 竞速）：批级审批
    /// 通过 → 工具返回 ApprovalRequired → 重试审批挂起 + abort → 有限
    /// 时间收敛为取消（修复前 :1140 裸挂起，红）
    #[tokio::test]
    async fn requires_approval_retry_hang_abort_race_converges() {
        let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        // 首次问询（批级审批）通过，重试审批挂起
        let gate = Arc::new(HangAfterApprovals::new(1));
        let abort = AbortSignal::new();
        let aborter = {
            let abort = abort.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                abort.abort();
            })
        };
        let start = std::time::Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, Some(&abort)),
        )
        .await
        .expect("重试审批挂起必须被 abort 竞速收敛（不得悬挂）");
        let elapsed = start.elapsed();
        aborter.await.expect("aborter 不应 panic");
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
        assert!(
            elapsed.as_millis() < 1000,
            "重试审批 abort 竞速应在数百 ms 内收敛，实际 {elapsed:?}"
        );
    }

    /// T4.2-R1（绿，顺序路径超时）：审批门挂起不返回 + 测试注入短超时
    /// → 批执行在超时内收敛为 Expired（内核 timeout 真实收敛，外层
    /// tokio timeout 不触发）
    #[tokio::test]
    async fn approval_wait_times_out_when_gate_hangs() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            approval_timeout: Some(Duration::from_millis(50)),
            ..Default::default()
        };
        let gate = Arc::new(PendingApproval);
        let start = std::time::Instant::now();
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
        )
        .await
        .expect("审批挂起必须被超时收敛（不得悬挂）");
        let elapsed = start.elapsed();
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalExpired),
            "超时应复用 Expired 分支"
        );
        assert!(
            elapsed.as_millis() < 1000,
            "超时应在内核审批超时附近收敛，实际 {elapsed:?}"
        );
        // 非致命：喂回模型继续
        assert!(out.fatal.is_none());
        // G-9：超时 → Expired 权威语义落库——approval-resolved(expired)
        // 事件进批事件流，顺序契约：
        // approval-requested → approval-resolved → tool-end
        let req = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1"))
            .expect("应有 approval-requested");
        let resolved = out
            .events
            .iter()
            .position(|e| {
                matches!(e, ToolEvent::ApprovalResolved { call_id, decision }
                    if call_id == "c1" && *decision == ApprovalDecision::Expired)
            })
            .expect("超时应收敛为 approval-resolved(expired) 落库");
        let end = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == "c1"))
            .expect("应有 tool-end");
        assert!(
            req < resolved && resolved < end,
            "approval-resolved(expired) 应位于 approval-requested 与 tool-end 之间"
        );
    }

    /// T4.2-R2（绿，并行组超时）：审批门挂起 + 短超时 → 全组收敛为
    /// Expired，无悬挂；approval-requested 全组先发事件顺序契约保持
    #[tokio::test]
    async fn approval_wait_parallel_group_timeout_converges() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("p0", "echo", ToolConcurrency::Parallel),
            call("p1", "echo", ToolConcurrency::Parallel),
        ];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            approval_timeout: Some(Duration::from_millis(50)),
            ..Default::default()
        };
        let gate = Arc::new(PendingApproval);
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
        )
        .await
        .expect("并行组审批挂起必须被超时收敛（不得悬挂）");
        assert!(out
            .results
            .iter()
            .all(|r| r.error_kind == Some(ToolErrorKind::ApprovalExpired)));
        // approval-requested 全组先发契约保持（等待前已全部广播）
        let approvals = out
            .events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
            .count();
        assert_eq!(approvals, 2, "全组审批请求应先于等待发出");
        assert!(out.fatal.is_none());
        // G-9：超时 → Expired 权威语义落库——每项一条
        // approval-resolved(expired)，位于本项 approval-requested 与
        // tool-end 之间
        let resolved = out
            .events
            .iter()
            .filter(|e| {
                matches!(e, ToolEvent::ApprovalResolved { decision: ApprovalDecision::Expired, .. })
            })
            .count();
        assert_eq!(
            resolved, 2,
            "并行组超时每项都应落一条 approval-resolved(expired)"
        );
        for id in ["p0", "p1"] {
            let req = out
                .events
                .iter()
                .position(|e| {
                    matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == id)
                })
                .unwrap_or_else(|| panic!("{id} 应有 approval-requested"));
            let res = out
                .events
                .iter()
                .position(|e| {
                    matches!(e, ToolEvent::ApprovalResolved { call_id, decision }
                        if call_id == id && *decision == ApprovalDecision::Expired)
                })
                .unwrap_or_else(|| panic!("{id} 应有 approval-resolved(expired)"));
            let end = out
                .events
                .iter()
                .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == id))
                .unwrap_or_else(|| panic!("{id} 应有 tool-end"));
            assert!(
                req < res && res < end,
                "{id} 的 approval-resolved(expired) 应位于 approval-requested 与 tool-end 之间"
            );
        }
    }

    /// T4.2-R4（绿，requires_approval 重试路径超时）：批级审批通过 →
    /// 工具返回 ApprovalRequired → 重试审批挂起 + 短超时 → ApprovalExpired
    /// 收敛（:1140 点位不再裸挂起）
    #[tokio::test]
    async fn requires_approval_retry_hang_times_out() {
        let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            approval_timeout: Some(Duration::from_millis(50)),
            ..Default::default()
        };
        // 首次问询（批级审批）通过，重试审批挂起
        let gate = Arc::new(HangAfterApprovals::new(1));
        let out = tokio::time::timeout(
            Duration::from_secs(2),
            exec.execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None),
        )
        .await
        .expect("重试审批挂起必须被超时收敛（不得悬挂）");
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalExpired),
            "重试审批超时应收敛为 ApprovalExpired：{:?}",
            out.results[0]
        );
        assert!(out.fatal.is_none());
        // G-9：超时 → Expired 权威语义落库——requires_approval 重试路径
        // 同样落 approval-resolved(expired)（首次问询通过不落 resolved，
        // 只有超时决策落；本路径事件仅一条）
        let resolved = out
            .events
            .iter()
            .filter(|e| {
                matches!(e, ToolEvent::ApprovalResolved { decision: ApprovalDecision::Expired, .. })
            })
            .count();
        assert_eq!(
            resolved, 1,
            "重试审批超时应落一条 approval-resolved(expired)"
        );
    }

    // ── R4 T10：真实审批事件（requires_approval / dangerous / permissionMode）──

    /// T10 回归：tool.requires_approval 不再落入软拒绝分类，归类为
    /// ApprovalRequired 透传审批状态（无审批门时）
    #[tokio::test]
    async fn requires_approval_is_not_soft_deny_without_gate() {
        let reg = registry_with(vec![Arc::new(AlwaysRequiresApprovalTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalRequired),
            "requires_approval 应分类为 ApprovalRequired"
        );
        assert_ne!(
            out.results[0].error_kind,
            Some(ToolErrorKind::SoftDeny),
            "不再折叠为 SoftDeny"
        );
        assert_eq!(
            out.results[0].error_kind.map(|k| k.error_code()),
            Some("tool.requires_approval")
        );
        // 审批/控制类错误永不致命
        assert!(out.fatal.is_none());
    }

    /// T10：requires_approval 产生真实审批请求（走 gate），用户同意后
    /// 重试执行该工具调用
    #[tokio::test]
    async fn requires_approval_approved_then_retries_execution() {
        let tool = ApprovalOnceTool::new();
        let reg = registry_with(vec![Arc::new(tool.clone())]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "approval_once", ToolConcurrency::Sequential)];
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
        // 批级审批通过 → 工具首调 requires_approval → ApprovalRequired →
        // 真实审批（gate 再次问询）→ 用户同意 → 重试执行成功
        assert!(out.results[0].is_ok(), "重试后应成功：{:?}", out.results[0]);
        assert_eq!(tool.call_count(), 2, "工具应被重试执行（共 2 次）");
        // 两次审批请求均产生 approval-requested 事件（批级 + 重试）
        let approvals = out
            .events
            .iter()
            .filter(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
            .count();
        assert_eq!(approvals, 2);
        assert!(out.fatal.is_none());
    }

    /// T10：requires_approval 重试审批被拒绝 → 明确拒绝结果（Denied 语义）
    #[tokio::test]
    async fn requires_approval_denied_returns_user_denied() {
        let tool = AlwaysRequiresApprovalTool;
        let reg = registry_with(vec![Arc::new(tool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        // 批级审批通过（首问），重试审批拒绝（次问）
        let gate = SequenceApproval::new(vec![
            ApprovalDecision::Approved,
            ApprovalDecision::Denied {
                reason: "no".into(),
            },
        ]);
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
        assert!(out.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("user denied: no"));
        // 拒绝非致命（喂回模型，Denied 语义）
        assert!(out.fatal.is_none());
    }

    /// T10：requires_approval 重试审批过期 → ApprovalExpired
    #[tokio::test]
    async fn requires_approval_expired_returns_approval_expired() {
        let tool = AlwaysRequiresApprovalTool;
        let reg = registry_with(vec![Arc::new(tool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "always_approval", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            ..Default::default()
        };
        let gate = SequenceApproval::new(vec![
            ApprovalDecision::Approved,
            ApprovalDecision::Expired,
        ]);
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalExpired)
        );
    }

    /// T10 消费 dangerous：ask 模式仅危险工具进审批，安全工具直接执行
    #[tokio::test]
    async fn permission_ask_mode_routes_only_dangerous_to_approval() {
        let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("c1", "dangerous_tool", ToolConcurrency::Parallel),
            call("c2", "echo", ToolConcurrency::Parallel),
        ];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = Arc::new(RecordingApproval {
            order: Arc::clone(&order),
        });
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        // 仅 dangerous 项发起审批；echo 直接执行
        assert_eq!(*order.lock().unwrap(), vec!["c1".to_string()]);
        assert!(out.results.iter().all(|r| r.is_ok()));
        // approval-requested 事件仅对应危险项
        let approvals: Vec<&str> = out
            .events
            .iter()
            .filter_map(|e| match e {
                ToolEvent::ApprovalRequested { call_id, .. } => Some(call_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(approvals, vec!["c1"]);
    }

    /// T10 消费 dangerous：ask 模式危险项被用户拒绝 → UserDenied 不执行
    #[tokio::test]
    async fn permission_ask_mode_denied_dangerous_skips_execution() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
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
    }

    /// T10 消费 dangerous：plan 模式写类（dangerous）工具拒绝且不弹窗
    #[tokio::test]
    async fn permission_plan_mode_denies_dangerous_tools() {
        let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("c1", "dangerous_tool", ToolConcurrency::Sequential),
            call("c2", "echo", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Plan),
            ..Default::default()
        };
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = Arc::new(RecordingApproval {
            order: Arc::clone(&order),
        });
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        // plan 模式：写类工具直接拒绝（Denied 语义），安全工具放行
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
        assert!(out.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("permission denied"));
        assert!(out.results[1].is_ok());
        // 不发起任何审批（不弹窗）
        assert!(
            order.lock().unwrap().is_empty(),
            "plan 模式不应发起审批"
        );
        assert!(!out
            .events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
        assert!(out.fatal.is_none());
    }

    /// T10 消费 dangerous：plan 模式并行组——写类拒绝、安全项并行执行
    #[tokio::test]
    async fn permission_plan_parallel_denies_dangerous_runs_safe() {
        let reg = registry_with(vec![Arc::new(DangerousTool), Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![
            call("c1", "dangerous_tool", ToolConcurrency::Parallel),
            call("c2", "echo", ToolConcurrency::Parallel),
            call("c3", "echo", ToolConcurrency::Sequential),
        ];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Plan),
            ..Default::default()
        };
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = Arc::new(RecordingApproval {
            order: Arc::clone(&order),
        });
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
        assert!(out.results[1].is_ok());
        assert!(out.results[2].is_ok());
        assert!(order.lock().unwrap().is_empty());
        assert!(out.fatal.is_none());
    }

    /// T10 消费 dangerous：full-access 模式危险工具直接放行（无审批）
    #[tokio::test]
    async fn permission_full_access_allows_dangerous_tools() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: false,
            permission_mode: Some(PermissionMode::FullAccess),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert!(out.results[0].is_ok(), "full-access 放行危险工具");
        assert!(!out
            .events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
    }

    /// T10：显式 ask 模式但无审批门 → 危险项透传需审批状态（不静默执行）
    #[tokio::test]
    async fn permission_ask_without_gate_passes_through_approval_required() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: false,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalRequired),
            "无审批基础设施时不应静默执行危险工具"
        );
    }

    // ── W4-B：笔记写工具经 session-loop 审批矩阵接线 ──────────────────

    /// W4-B：plan 模式拒绝真实 `document_apply_md`（不弹窗、不执行 backend）
    #[tokio::test]
    async fn w4b_plan_mode_denies_document_apply_md() {
        use agent_tools::register_builtin_tools;
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).expect("register builtins");
        let exec = ToolExecutor::new(Arc::new(reg));
        let calls = vec![ToolBatchCall {
            id: "c-note-write".into(),
            tool_name: "document_apply_md".into(),
            summary: "note write".into(),
            input: serde_json::json!({ "doc_id": "d", "markdown": "x" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
        }];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Plan),
            ..Default::default()
        };
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let gate = Arc::new(RecordingApproval {
            order: Arc::clone(&order),
        });
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::UserDenied),
            "plan 必须拒绝笔记写：{:?}",
            out.results[0]
        );
        assert!(out.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("permission denied"));
        assert!(
            order.lock().unwrap().is_empty(),
            "plan 不得弹审批窗"
        );
        assert!(out.fatal.is_none());
    }

    /// W4-B：plan 模式放行笔记只读 `query_blocks`（safe 边界）
    #[tokio::test]
    async fn w4b_plan_mode_allows_query_blocks_safe() {
        use agent_tools::register_builtin_tools;
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).expect("register builtins");
        let exec = ToolExecutor::new(Arc::new(reg));
        let calls = vec![ToolBatchCall {
            id: "c-note-read".into(),
            tool_name: "query_blocks".into(),
            summary: "note read".into(),
            input: serde_json::json!({ "doc_id": "d" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
        }];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Plan),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        // plan 下只读应执行（未接线 backend → ok=false unwired，非 user_denied）
        assert!(
            out.results[0].error_kind.is_none(),
            "plan 不得拒 safe 读：{:?}",
            out.results[0]
        );
        let out_val = &out.results[0].output;
        assert_eq!(out_val["ok"], false);
        assert_eq!(out_val["reason"], "note_backend_unwired");
    }

    /// W4-B：ask 模式 + 用户拒绝 → document_apply_md 得 user_denied
    #[tokio::test]
    async fn w4b_ask_mode_denied_document_apply_md_user_denied() {
        use agent_tools::register_builtin_tools;
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).expect("register builtins");
        let exec = ToolExecutor::new(Arc::new(reg));
        let calls = vec![ToolBatchCall {
            id: "c-note-deny".into(),
            tool_name: "document_apply_md".into(),
            summary: "note write denied".into(),
            input: serde_json::json!({ "doc_id": "d", "markdown": "blocked" }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
        }];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Denied {
                reason: "user said no notes".into(),
            },
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::UserDenied),
            "ask 拒绝 → user_denied：{:?}",
            out.results[0]
        );
        assert!(out.results[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("user said no notes")
            || out.results[0]
                .error_message
                .as_deref()
                .unwrap_or_default()
                .contains("user denied"));
        assert!(out.fatal.is_none());
    }

    /// T10 集成：dangerous shell 工具经权限判定进入审批（Approved 后执行），
    /// ApprovalChannel 的审批事件进入批事件流
    #[tokio::test]
    async fn permission_ask_mode_approval_channel_events_in_batch_stream() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Approved,
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert!(out.results[0].is_ok());
        // 事件顺序契约：tool-start → approval-requested → tool-end
        let start = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolStart { call_id, .. } if call_id == "c1"))
            .unwrap();
        let approval = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ApprovalRequested { call_id, .. } if call_id == "c1"))
            .unwrap();
        let end = out
            .events
            .iter()
            .position(|e| matches!(e, ToolEvent::ToolEnd { call_id, .. } if call_id == "c1"))
            .unwrap();
        assert!(start < approval && approval < end, "审批事件顺序契约被破坏");
    }

    // ── I3-S6：C3 大面积回退审批（判定点集成，04 C3 验收 1/3/5 对齐）──

    /// 固定面积评估器（测试注入）
    #[derive(Debug)]
    struct FixedAreaAssessor(agent_tools::revert::RevertArea);

    impl agent_tools::revert::RevertAssessor for FixedAreaAssessor {
        fn assess(
            &self,
            _target: &agent_tools::revert::RevertTarget,
        ) -> agent_tools::revert::RevertArea {
            self.0.clone()
        }
    }

    fn revert_policy(area: agent_tools::revert::RevertArea) -> agent_tools::revert::RevertPolicy {
        agent_tools::revert::RevertPolicy::default().with_assessor(Arc::new(FixedAreaAssessor(area)))
    }

    fn large_area() -> agent_tools::revert::RevertArea {
        agent_tools::revert::RevertArea {
            file_count: Some(25),
            line_count: Some(1200),
            cross_directory: true,
            ref_age_seconds: Some(36 * 3600),
        }
    }

    fn small_area() -> agent_tools::revert::RevertArea {
        agent_tools::revert::RevertArea {
            file_count: Some(2),
            line_count: Some(40),
            cross_directory: false,
            ref_age_seconds: Some(3600),
        }
    }

    /// 携带命令文本入参的工具调用（C3 判定点从 input.command 取命令）
    fn command_call(id: &str, name: &str, command: &str) -> ToolBatchCall {
        ToolBatchCall {
            id: id.into(),
            tool_name: name.into(),
            summary: format!("call {name}"),
            input: serde_json::json!({ "command": command }),
            category: conex_types::tool::ToolCategory::Internal,
            concurrency: ToolConcurrency::Sequential,
        }
    }

    /// C3 验收 5 + full-access 不豁免：full-access 下大面积回退且无审批门 →
    /// 阈值检查仍生效（CommandPolicy 兜底：结构化拒绝，不做无限等待），
    /// 工具不执行、run 非致命
    #[tokio::test]
    async fn full_access_large_revert_refused_without_gate() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
        let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
        let opts = ToolBatchOptions {
            approval_enabled: false,
            permission_mode: Some(PermissionMode::FullAccess),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalRequired),
            "full-access 下大面积回退不得静默执行"
        );
        let msg = out.results[0].error_message.as_deref().unwrap_or_default();
        assert!(msg.contains("大面积 git 回退需用户审批"), "拒绝文案：{msg}");
        assert!(msg.contains("缩小回退范围或改用单文件修复"), "指引：{msg}");
        assert!(msg.contains("full-access 不豁免"), "不豁免声明：{msg}");
        // 工具未执行：EchoTool 若执行必成功（is_ok），拒绝态即证明未执行
        assert!(out.fatal.is_none(), "拒绝不是引擎故障");
    }

    /// C3 验收 1：ask 模式大面积回退产生审批请求（approval-requested 事件），
    /// 审批人 = 用户（门裁决）；Denied → 结构化拒绝、工具不执行
    #[tokio::test]
    async fn ask_large_revert_denied_after_approval_request() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
        let calls = vec![command_call("c1", "echo", "git reset --hard HEAD~30")];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
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
        assert!(out
            .events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })),
            "审批请求必须真实发出（用户裁决入口）"
        );
        assert!(out.fatal.is_none(), "拒绝不崩溃、run 状态正常");
    }

    /// C3 验收 1 通过路径：用户批准后大面积回退才执行
    #[tokio::test]
    async fn ask_large_revert_approved_then_executes() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
        let calls = vec![command_call("c1", "echo", "git checkout abc1234")];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let gate = MockApproval {
            decision: ApprovalDecision::Approved,
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert!(out.results[0].is_ok(), "用户批准后才执行");
    }

    /// C3 验收 3：面积低于全部阈值 → full-access 放行（零打扰，无审批事件）
    #[tokio::test]
    async fn full_access_small_revert_executes_without_approval() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(small_area()));
        let calls = vec![command_call("c1", "echo", "git restore --source=HEAD~1 src/main.rs")];
        let opts = ToolBatchOptions {
            approval_enabled: false,
            permission_mode: Some(PermissionMode::FullAccess),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert!(out.results[0].is_ok(), "小面积回退零打扰");
        assert!(!out
            .events
            .iter()
            .any(|e| matches!(e, ToolEvent::ApprovalRequested { .. })));
    }

    /// 分支切换（非回退形态）不被 C3 门禁拦截：full-access 直接执行
    #[tokio::test]
    async fn checkout_branch_switch_not_gated() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
        let calls = vec![command_call("c1", "echo", "git checkout main")];
        let opts = ToolBatchOptions {
            approval_enabled: false,
            permission_mode: Some(PermissionMode::FullAccess),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert!(out.results[0].is_ok(), "分支切换不是回退，C3 不拦截");
    }

    /// 无命令文本入参（非命令类工具）不受 C3 门禁影响（既有语义不变）
    #[tokio::test]
    async fn non_command_input_not_gated() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_revert_policy(revert_policy(large_area()));
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: false,
            permission_mode: Some(PermissionMode::FullAccess),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &opts, None)
            .await;
        assert!(out.results[0].is_ok(), "非命令入参按既有矩阵放行");
    }

    // ── 中间件链 + 插件钩子接线（ToolMiddleware 真实扩展点 + HookRegistry）──
    // 优先级语义：审批优先于中间件（拒绝/过期不进入中间件链）；中间件
    // Block 只拦截「审批已通过」的调用（详见模块头注与决策文档）。

    /// 计数工具：每次执行自增并原样返回入参（验证中间件/钩子修改与阻止）
    struct CountingEchoTool {
        calls: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl Tool for CountingEchoTool {
        fn name(&self) -> &str {
            "countecho"
        }
        fn definition(&self) -> &ToolDefinition {
            static DEF: std::sync::OnceLock<ToolDefinition> = std::sync::OnceLock::new();
            DEF.get_or_init(|| ToolDefinition {
                name: "countecho".into(),
                description: "count then echo".into(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }
        async fn execute(&self, _ctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(args)
        }
    }

    /// 修改入参的中间件：为 {"v": "x"} 追加后缀（验证 before 链可改输入）
    struct PrefixMiddleware {
        name: String,
        suffix: String,
    }
    #[async_trait]
    impl ToolMiddleware for PrefixMiddleware {
        fn name(&self) -> &str {
            &self.name
        }
        async fn before_execute(
            &self,
            _tool: &dyn Tool,
            mut input: Value,
            _ctx: &ToolExecutionContext,
        ) -> Result<BeforeExecuteResult, ToolError> {
            if let Some(v) = input.get_mut("v") {
                if let Some(s) = v.as_str() {
                    *v = Value::String(format!("{s}{}", self.suffix));
                }
            }
            Ok(BeforeExecuteResult::Proceed {
                modified_input: Some(input),
            })
        }
    }

    /// 按入参 block 标记阻止执行的中间件
    struct BlockingMiddleware {
        name: String,
    }
    #[async_trait]
    impl ToolMiddleware for BlockingMiddleware {
        fn name(&self) -> &str {
            &self.name
        }
        async fn before_execute(
            &self,
            _tool: &dyn Tool,
            input: Value,
            _ctx: &ToolExecutionContext,
        ) -> Result<BeforeExecuteResult, ToolError> {
            if input.get("block").and_then(Value::as_bool) == Some(true) {
                Ok(BeforeExecuteResult::Block {
                    reason: "策略拦截".into(),
                })
            } else {
                Ok(BeforeExecuteResult::Proceed {
                    modified_input: None,
                })
            }
        }
    }

    /// 替换输出的中间件（验证 on_result 改写）
    struct ReplaceMiddleware {
        name: String,
        replacement: Value,
    }
    #[async_trait]
    impl ToolMiddleware for ReplaceMiddleware {
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
            Ok(AfterExecuteResult::Replace(self.replacement.clone()))
        }
    }

    /// 恒失败的 on_result 中间件（验证降级透传）
    struct FailingAfterMiddleware {
        name: String,
    }
    #[async_trait]
    impl ToolMiddleware for FailingAfterMiddleware {
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
            Err(ToolError::execution_failed("failing-after", "after boom"))
        }
    }

    /// 记录 on_error 调用的中间件（验证失败观察）
    struct ErrorSpyMiddleware {
        name: String,
        seen: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait]
    impl ToolMiddleware for ErrorSpyMiddleware {
        fn name(&self) -> &str {
            &self.name
        }
        async fn on_error(
            &self,
            _tool: &dyn Tool,
            _input: &Value,
            error: &ToolError,
            _ctx: &ToolExecutionContext,
        ) -> Result<(), ToolError> {
            self.seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(error.to_string());
            Ok(())
        }
    }

    /// 计数 before_execute 调用的中间件（审批优先级验证用）
    struct CallCounterMiddleware {
        name: String,
        calls: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl ToolMiddleware for CallCounterMiddleware {
        fn name(&self) -> &str {
            &self.name
        }
        async fn before_execute(
            &self,
            _tool: &dyn Tool,
            _input: Value,
            _ctx: &ToolExecutionContext,
        ) -> Result<BeforeExecuteResult, ToolError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(BeforeExecuteResult::Proceed {
                modified_input: None,
            })
        }
    }

    /// 插件钩子测试替身：记录 tool.post 事件（tool_name, is_error）
    struct SpyHook {
        name: String,
        posts: Arc<Mutex<Vec<(String, bool)>>>,
        action: Option<HookAction>,
        err: Option<HookError>,
    }

    impl SpyHook {
        fn observing(name: &str) -> Self {
            Self {
                name: name.to_string(),
                posts: Arc::new(Mutex::new(Vec::new())),
                action: None,
                err: None,
            }
        }

        fn blocking(name: &str) -> Self {
            Self {
                name: name.to_string(),
                posts: Arc::new(Mutex::new(Vec::new())),
                action: Some(HookAction::Block {
                    reason: "钩子拦截".into(),
                }),
                err: None,
            }
        }

        fn failing(name: &str) -> Self {
            Self {
                name: name.to_string(),
                posts: Arc::new(Mutex::new(Vec::new())),
                action: None,
                err: Some(HookError::new("hook boom")),
            }
        }

        fn posts(&self) -> Vec<(String, bool)> {
            self.posts.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    #[async_trait::async_trait]
    impl HookHandler for SpyHook {
        fn name(&self) -> &str {
            &self.name
        }
        async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
            if let HookEvent::ToolPost {
                tool_name,
                is_error,
                ..
            } = event
            {
                self.posts
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((tool_name.clone(), *is_error));
            }
            if let Some(err) = &self.err {
                return Err(err.clone());
            }
            Ok(self.action.clone().unwrap_or(HookAction::Continue))
        }
    }

    fn block_call(id: &str, name: &str) -> ToolBatchCall {
        let mut c = call(id, name, ToolConcurrency::Sequential);
        c.input = serde_json::json!({ "v": id, "block": true });
        c
    }

    #[tokio::test]
    async fn middleware_before_chain_modifies_input() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(PrefixMiddleware {
            name: "prefix".into(),
            suffix: "-mw".into(),
        })]);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok());
        // EchoTool 原样返回入参 → 中间件修改后的入参可见
        assert_eq!(
            out.results[0].output.get("v"),
            Some(&Value::String("c1-mw".into())),
            "before 链应修改入参"
        );
    }

    #[tokio::test]
    async fn middleware_before_block_prevents_execution() {
        let tool = Arc::new(CountingEchoTool {
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
        let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(BlockingMiddleware {
            name: "blocker".into(),
        })]);
        let calls = vec![block_call("c1", "countecho")];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        let r = &out.results[0];
        assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(
            r.error_message.as_deref().unwrap_or_default().contains("被中间件 blocker 阻止"),
            "阻止文案应携带中间件名：{:?}",
            r.error_message
        );
        assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "被阻止的工具不应执行");
    }

    #[tokio::test]
    async fn middleware_on_result_replace_output() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(ReplaceMiddleware {
            name: "replacer".into(),
            replacement: serde_json::json!({ "wrapped": true }),
        })]);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(out.results[0].output, serde_json::json!({ "wrapped": true }));
    }

    #[tokio::test]
    async fn middleware_on_error_observes_failure() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let reg = registry_with(vec![Arc::new(FailTool)]);
        let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(ErrorSpyMiddleware {
            name: "spy".into(),
            seen: Arc::clone(&seen),
        })]);
        let calls = vec![call("c1", "fail", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        let msgs = seen.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].contains("boom"));
    }

    #[tokio::test]
    async fn middleware_on_result_error_degrades_to_passthrough() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(
            FailingAfterMiddleware {
                name: "failing".into(),
            },
        )]);
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        // 后置钩子错误：记录日志并降级透传原输出（不改变已完成的执行结果）
        assert!(out.results[0].is_ok(), "on_result 失败应降级透传原输出");
        assert_eq!(out.results[0].output, serde_json::json!({ "v": "c1" }));
    }

    #[tokio::test]
    async fn middleware_empty_chain_is_noop() {
        let reg = registry_with(vec![Arc::new(EchoTool)]);
        let exec = ToolExecutor::new(reg).with_middleware(Vec::new());
        let calls = vec![call("c1", "echo", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok());
        assert_eq!(out.results[0].output, serde_json::json!({ "v": "c1" }));
    }

    /// 审批优先于中间件：拒绝时不进入中间件链，通过后中间件参与执行
    #[tokio::test]
    async fn middleware_runs_after_approval_gate() {
        let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };

        // 审批拒绝：中间件 before_execute 不被调用（审批优先语义）
        let counter = Arc::new(AtomicUsize::new(0));
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg).with_middleware(vec![Arc::new(
            CallCounterMiddleware {
                name: "counter".into(),
                calls: Arc::clone(&counter),
            },
        )]);
        let gate = MockApproval {
            decision: ApprovalDecision::Denied {
                reason: "no".into(),
            },
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate)), &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
        assert_eq!(counter.load(Ordering::SeqCst), 0, "审批拒绝时中间件不参与");

        // 审批通过：中间件进入执行面
        let counter2 = Arc::new(AtomicUsize::new(0));
        let reg2 = registry_with(vec![Arc::new(DangerousTool)]);
        let exec2 = ToolExecutor::new(reg2).with_middleware(vec![Arc::new(
            CallCounterMiddleware {
                name: "counter".into(),
                calls: Arc::clone(&counter2),
            },
        )]);
        let gate2 = MockApproval {
            decision: ApprovalDecision::Approved,
        };
        let out2 = exec2
            .execute_batch(&calls, &exec_ctx(), Some(Arc::new(gate2)), &opts, None)
            .await;
        assert!(out2.results[0].is_ok());
        assert_eq!(counter2.load(Ordering::SeqCst), 1, "审批通过后中间件参与执行");
    }

    #[tokio::test]
    async fn hook_tool_pre_block_prevents_execution() {
        let tool = Arc::new(CountingEchoTool {
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
        let registry = HookRegistry::new();
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Swallow,
            Arc::new(SpyHook::blocking("blocker")) as Arc<dyn HookHandler>,
        );
        let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
        let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        let r = &out.results[0];
        assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(
            r.error_message.as_deref().unwrap_or_default().contains("tool.pre 钩子阻止"),
            "tool.pre 阻止文案：{:?}",
            r.error_message
        );
        assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "tool.pre 阻止时工具不执行");
    }

    #[tokio::test]
    async fn hook_tool_post_receives_success_and_failure() {
        let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(FailTool)]);
        let registry = HookRegistry::new();
        let spy = Arc::new(SpyHook::observing("spy"));
        registry.register(
            HookEventKind::ToolPost,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
        );
        let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
        let calls = vec![
            call("c1", "echo", ToolConcurrency::Sequential),
            call("c2", "fail", ToolConcurrency::Sequential),
        ];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok());
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert_eq!(
            spy.posts(),
            vec![
                ("echo".to_string(), false),
                ("fail".to_string(), true),
            ],
            "tool.post 应广播成功与失败事件（含 is_error 标记）"
        );
    }

    #[tokio::test]
    async fn hook_tool_pre_propagate_failure_blocks_tool() {
        let tool = Arc::new(CountingEchoTool {
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let reg = registry_with(vec![Arc::clone(&tool) as Arc<dyn Tool>]);
        let registry = HookRegistry::new();
        registry.register(
            HookEventKind::ToolPre,
            HookFailStrategy::Propagate,
            Arc::new(SpyHook::failing("fail")) as Arc<dyn HookHandler>,
        );
        let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
        let calls = vec![call("c1", "countecho", ToolConcurrency::Sequential)];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        let r = &out.results[0];
        assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(
            r.error_message.as_deref().unwrap_or_default().contains("propagate"),
            "propagate 失败应降级为阻止（批继续）：{:?}",
            r.error_message
        );
        assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "propagate 失败时工具不执行");
    }

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
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        let r = &out.results[0];
        assert_eq!(r.error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(
            r.error_message.as_deref().unwrap_or_default().contains("slow"),
            "超时阻止文案应携带中间件名：{:?}",
            r.error_message
        );
        assert!(
            r.error_message.as_deref().unwrap_or_default().contains("超时"),
            "超时阻止文案应标注超时：{:?}",
            r.error_message
        );
        assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "超时阻止时工具不应执行");
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
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok(), "on_result 超时应降级透传原输出");
        assert_eq!(out.results[0].output, serde_json::json!({ "v": "c1" }));
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
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        // 工具失败结果原样保持（on_error 超时只影响观察链，不改变结果）
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::ExecutionFailed));
        assert!(out.results[0].error_message.as_deref().unwrap_or_default().contains("boom"));
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
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok(), "默认超时下快中间件正常放行");
        assert_eq!(out.results[0].output.get("v"), Some(&Value::String("c1-ok".into())));
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
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), Some(&sig))
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Cancelled));
        assert_eq!(tool.calls.load(Ordering::SeqCst), 0, "abort 取消后工具不应执行");
    }

    // ── tool.error 广播（E1 第二批承接；tool-end isError 分支）────────

    /// 插件钩子测试替身（tool.error 版）：记录 (tool_name, error 文案)
    struct ToolErrorSpyHook {
        name: String,
        errors: Arc<Mutex<Vec<(String, String)>>>,
    }

    #[async_trait::async_trait]
    impl HookHandler for ToolErrorSpyHook {
        fn name(&self) -> &str {
            &self.name
        }
        async fn handle(&self, event: &HookEvent) -> Result<HookAction, HookError> {
            if let HookEvent::ToolError { tool_name, error, .. } = event {
                self.errors
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((tool_name.clone(), error.clone()));
            }
            Ok(HookAction::Continue)
        }
    }

    /// tool.error 广播：工具执行失败（isError 分支）追加广播，
    /// 成功不广播；载荷携带错误文案
    #[tokio::test]
    async fn hook_tool_error_broadcasts_on_failure_only() {
        let reg = registry_with(vec![Arc::new(EchoTool), Arc::new(FailTool)]);
        let registry = HookRegistry::new();
        let spy = Arc::new(ToolErrorSpyHook {
            name: "error-spy".into(),
            errors: Arc::new(Mutex::new(Vec::new())),
        });
        registry.register_observe(
            HookEventKind::ToolError,
            HookFailStrategy::Swallow,
            Arc::clone(&spy) as Arc<dyn HookHandler>,
        );
        let exec = ToolExecutor::new(reg).with_hooks(Some(Arc::new(registry)));
        let calls = vec![
            call("c1", "echo", ToolConcurrency::Sequential),
            call("c2", "fail", ToolConcurrency::Sequential),
        ];
        let out = exec
            .execute_batch(&calls, &exec_ctx(), None, &ToolBatchOptions::default(), None)
            .await;
        assert!(out.results[0].is_ok());
        assert_eq!(out.results[1].error_kind, Some(ToolErrorKind::ExecutionFailed));
        let errors = spy.errors.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            errors.as_slice(),
            &[(
                "fail".to_string(),
                "[tool.execution_failed] 工具 fail 执行失败：boom".to_string()
            )],
            "tool.error 只广播失败调用（携带错误文案）"
        );
    }

    // ── T-D-14 权限传递层：子代理审批链路 ──

    /// 子代理上下文（有父 run 归属）+ 危险工具入参（含申请理由保留键）
    fn subagent_ctx() -> ToolExecCtx {
        ToolExecCtx {
            run_id: "run-sub-1".into(),
            session_id: "sess-1".into(),
            parent_run_id: Some("run-main".into()),
            ..Default::default()
        }
    }

    /// 申请→主 agent 放行链路：子代理 run 内工具触发 NeedsApproval →
    /// gate 收到 requester（run_id = 子代理 run id + reason）→ 主 agent
    /// 裁决 Approved → 工具执行成功、approval-requested 事件携带请求方
    #[tokio::test]
    async fn subagent_approval_flow_reaches_gate_with_requester_and_executes() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let received = Arc::new(std::sync::Mutex::new(None));
        let gate = Arc::new(RequesterRecordingApproval {
            decision: ApprovalDecision::Approved,
            received: Arc::clone(&received),
        });
        let calls = vec![ToolBatchCall {
            id: "c1".into(),
            tool_name: "dangerous_tool".into(),
            summary: "子代理越界写".into(),
            input: serde_json::json!({
                "path": "outside.md",
                "approval_reason": "需要写入默认范围外的报告目录",
            }),
            category: conex_types::tool::ToolCategory::Filesystem,
            concurrency: ToolConcurrency::Sequential,
        }];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
            .await;
        // 工具执行成功（主 agent 放行）
        assert!(out.results[0].is_ok(), "结果: {:?}", out.results[0]);
        assert!(out.fatal.is_none());
        // gate 收到 requester：run_id = 子代理 run id + reason
        let requester = received.lock().unwrap().clone().expect("gate 必收到 requester");
        assert_eq!(requester.run_id, "run-sub-1", "requester.run_id 应为子代理 run id");
        assert_eq!(
            requester.reason.as_deref(),
            Some("需要写入默认范围外的报告目录"),
            "requester.reason 应透传申请理由"
        );
        // approval-requested 事件齐全且携带请求方
        let requested = out
            .events
            .iter()
            .find(|e| matches!(e, ToolEvent::ApprovalRequested { .. }))
            .expect("应有 approval-requested 事件");
        match requested {
            ToolEvent::ApprovalRequested { requester, .. } => {
                assert_eq!(
                    requester.as_ref().map(|r| r.run_id.as_str()),
                    Some("run-sub-1")
                );
                assert_eq!(
                    requester.as_ref().and_then(|r| r.reason.as_deref()),
                    Some("需要写入默认范围外的报告目录")
                );
            }
            _ => unreachable!(),
        }
    }

    /// 拒绝路径：主 agent 裁决 Denied → 子代理收到 UserDenied，错误文案
    /// 含「主 agent 拒绝」与「回报主 agent」指引（对齐 explore_quota 断言面）
    #[tokio::test]
    async fn subagent_denied_carries_relay_guidance() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let gate = Arc::new(RequesterRecordingApproval {
            decision: ApprovalDecision::Denied {
                reason: "写入范围超出默认集".into(),
            },
            received: Arc::new(std::sync::Mutex::new(None)),
        });
        let calls = vec![ToolBatchCall {
            id: "c1".into(),
            tool_name: "dangerous_tool".into(),
            summary: "子代理越界写".into(),
            input: serde_json::json!({ "path": "outside.md", "approval_reason": "需要越界写入" }),
            category: conex_types::tool::ToolCategory::Filesystem,
            concurrency: ToolConcurrency::Sequential,
        }];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
            .await;
        assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::UserDenied));
        let message = out.results[0].error_message.as_deref().unwrap_or("");
        assert!(message.contains("主 agent 拒绝"), "message: {message}");
        assert!(message.contains("回报主 agent"), "message: {message}");
        assert!(message.contains("写入范围超出默认集"), "message: {message}");
        // 拒绝非致命（run 不中断）
        assert!(out.fatal.is_none());
    }

    /// 不回归：主 agent run（无父 run）审批 requester=None → 既有
    /// 「user denied: …」文案（UI 流程零回归）
    #[tokio::test]
    async fn main_agent_approval_requester_none_and_legacy_denied_text() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let received = Arc::new(std::sync::Mutex::new(None));
        let gate = Arc::new(RequesterRecordingApproval {
            decision: ApprovalDecision::Denied {
                reason: "no".into(),
            },
            received: Arc::clone(&received),
        });
        let calls = vec![call("c1", "dangerous_tool", ToolConcurrency::Sequential)];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &exec_ctx(), Some(gate), &opts, None)
            .await;
        // gate 收到 requester = None（主 agent run 不携带子代理身份）
        assert!(
            received.lock().unwrap().is_none(),
            "主 agent run 审批 requester 应为 None"
        );
        // 既有拒绝文案不变（无「回报主 agent」注入）
        let message = out.results[0].error_message.as_deref().unwrap_or("");
        assert_eq!(message, "user denied: no");
        assert!(!message.contains("回报主 agent"), "message: {message}");
    }

    /// 超时：主 agent 不裁决 → Expired → 子代理 run 不中断（非致命）、
    /// 工具返回 approval_expired
    #[tokio::test]
    async fn subagent_approval_expired_does_not_interrupt_run() {
        let reg = registry_with(vec![Arc::new(DangerousTool)]);
        let exec = ToolExecutor::new(reg);
        let gate = Arc::new(RequesterRecordingApproval {
            decision: ApprovalDecision::Expired,
            received: Arc::new(std::sync::Mutex::new(None)),
        });
        let calls = vec![ToolBatchCall {
            id: "c1".into(),
            tool_name: "dangerous_tool".into(),
            summary: "子代理越界写".into(),
            input: serde_json::json!({ "path": "outside.md", "approval_reason": "需要越界写入" }),
            category: conex_types::tool::ToolCategory::Filesystem,
            concurrency: ToolConcurrency::Sequential,
        }];
        let opts = ToolBatchOptions {
            approval_enabled: true,
            permission_mode: Some(PermissionMode::Ask),
            ..Default::default()
        };
        let out = exec
            .execute_batch(&calls, &subagent_ctx(), Some(gate), &opts, None)
            .await;
        assert_eq!(
            out.results[0].error_kind,
            Some(ToolErrorKind::ApprovalExpired),
            "超时 → 工具返回 approval_expired"
        );
        assert!(
            out.fatal.is_none(),
            "approval_expired 非致命：子代理 run 不中断"
        );
    }
}
