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

// SR-03 · 拆分 · ≠ EL：本文件为薄门面，下列导入经子模块 / 测试的
// `use super::*` 消费（Rust 的 unused_imports 只统计本模块直接使用），
// 统一豁免该 lint 保持接线完整。
#![allow(unused_imports)]

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
use agent_tools::definition::ToolError;
use agent_tools::executor::{
    execute_stream_with_output_policy, ExecutorContext, ToolExecutionPolicy,
};
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::middleware::{
    AfterExecuteResult, BeforeExecuteResult, MiddlewareTimeoutConfig, ToolExecutionContext,
    ToolMiddleware,
};
use agent_tools::note_backend::NoteBackendHandle;
use agent_tools::permission::{decide, PermissionMode, PermissionVerdict};
use agent_tools::registry::ToolRegistry;
use agent_tools::revert::RevertPolicy;
use agent_tools::write_paths::WritePathRegistry;
use conex_types::tool::{ToolBatchCall, ToolConcurrency};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
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
    pub output_dir: Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>>,
    /// 笔记后端（Round6 / W4-E：`query_blocks` / `document_outline` /
    /// `document_apply_md` / `send_to_note` 真管线；None = 未接线，工具
    /// 返回 `note_backend_unwired` 占位——允许 Option 透传，结构字段须存在
    /// 且可注入；真实实现见 `conex-note-runtime::StoreNoteBackend`）
    pub note_backend: Option<NoteBackendHandle>,
    /// 后台任务管理器实例（透传给 ToolContext.background）
    pub background: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    /// 会话日志与命令溢出落盘根目录（透传给 ToolContext.log_root）
    pub log_root: Option<PathBuf>,
    /// 压缩块只读存储（BC11-4：search_context / decompress_context 真实读取）
    pub compression_store: Option<Arc<dyn agent_tools::compression_store::CompressionContextStore>>,
    /// 子代理任务类型（task_type：commit / implementation / analysis 等；None = 主 agent 或未指定，BC10-6）
    pub task_type: Option<String>,
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

/// 并行组并发观测（B4 并发上限的 AtomicUsize 计数点）：活跃并行数 + 峰值。
///
/// 实例级挂载于 [ToolExecutor]（`new` 创建，`clone_executor` 共享同一
/// Arc）——测试按执行器隔离断言并发峰值，不受同进程其它并行批测干扰；
/// 生产面亦可用于观测批并行度（非指标系统，计数原语形态对齐 B5）。
#[derive(Debug, Default)]
pub(crate) struct ParallelExecObs {
    /// 当前活跃并行数（进入并行执行段 +1、离开 -1）
    active: AtomicUsize,
    /// 观测峰值（自创建以来）
    peak: AtomicUsize,
}

impl ParallelExecObs {
    /// 进入并行执行段：活跃 +1 并更新峰值，返回本次活跃数
    pub(crate) fn enter(&self) -> usize {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        active
    }

    /// 离开并行执行段：活跃 -1
    pub(crate) fn leave(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }

    /// 当前活跃并行数。
    ///
    /// 当前消费方：`tool_exec_tests.rs` 三测断言批后 `active == 0`
    ///（证明 permit/计数无泄漏）。生产路径只 `enter`/`leave`，不读本方法。
    ///
    /// 接线计划：生产埋点若要暴露瞬时并行度，经本方法读值写入 tracing
    /// 字段（与 `peak` 同源，禁止另开计数器）；接入点同
    /// `ToolExecutor::concurrency_obs`。
    /// 删除条件：测试不再断言 `active` 且生产无读取方时，下轮删本方法
    /// 与 `#[allow]`。
    #[allow(dead_code)]
    pub(crate) fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    /// 并发峰值（自创建以来观测到的最大活跃数）。
    ///
    /// 当前消费方：`tool_exec_tests.rs` 三测断言峰值 ∈ [2, 上限] 或恰为 1
    ///（`max_parallel=1` 串行化）。生产路径只 `enter` 内 `fetch_max`，不读本方法。
    ///
    /// 接线计划：生产埋点若要对齐 B5 做批级峰值观测，经本方法读值；
    /// 接入点优先 `BatchRunner::collect_group_endings` 收口，禁止另开 Atomic。
    /// 删除条件：测试不再断言 `peak` 且生产无读取方时，下轮删本方法
    /// 与 `#[allow]`。
    #[allow(dead_code)]
    pub(crate) fn peak(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}

// SR-03 · 拆分 · ≠ EL：批调度/单工具/裁决/中间件四模拆出，本文件为薄门面
//（barrel）；公开符号 ToolExecCtx / ToolBatchOutcome / ToolExecutor 仍在本
// 文件定义，调用方路径零改动。
#[path = "exec_batch.rs"]
mod exec_batch;
#[path = "exec_middleware.rs"]
mod exec_middleware;
#[path = "exec_single/mod.rs"]
mod exec_single;
#[path = "exec_verdict.rs"]
mod exec_verdict;

// 内部面 re-export：子模块与测试经 `use super::*` 消费（公开 API 不变）
pub(crate) use exec_batch::DEFAULT_MAX_PARALLEL;
pub(crate) use exec_middleware::run_hook_with_timeout;
pub(crate) use exec_verdict::{
    approval_wait, classify_tool_error, denied_message, denied_result, mark_rest_cancelled,
    ApprovalWaitOutcome,
};

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
    /// 并行组并发观测（B4：活跃数 + 峰值计数点；经 clone_executor 共享）
    concurrency_obs: Arc<ParallelExecObs>,
}

#[cfg(test)]
#[path = "tool_exec_tests.rs"]
mod tests;
