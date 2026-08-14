//! session-loop crate（B3：状态机 + 输入队列 + 控制总线 + 安全点 + steering +
//! 主循环）
//!
//! 本 crate 承载会话运行循环的内核部分（B3.1-B3.5）：
//! - `state`：AgentSessionMachine——持有当前状态与上下文，转移表逐行穷举，
//!   未定义转移显式失败（01 §五.1）。转移表本体复用 conex-types 的
//!   `apply_transition`（B1.2 产出，01 §1.4 全表实现），本层负责状态保持、
//!   上下文 effect 应用与收场语义。
//! - `input`：AgentInputQueue 等价——三环输入队列（force/steer/followUp，
//!   容量 1000，覆盖最旧），对齐 pi 的 steer/followUp 分环（01 §五.5）。
//! - `control`：ControlBus——L0-L3 控制意图队列，drain 聚合优先级
//!   force_cancel > cooperative_stop > soft_inject（01 §2.10）。
//! - `hydrate`：历史水合映射（P4 阶段 1-2 / §3.2.3，T-28）——`HistoryMessage`
//!   纯映射为 `Vec<Arc<AgentMessage>>`，供壳层 `with_initial_conversation_arc`
//!   冷启动水合接线（T-29/T-30）。
//! - `safe_point`：applySafePointControl——安全点检查，把控制总线意图
//!   映射为循环动作（force_cancel 可立即中断；cooperative_stop 等安全点；
//!   soft_inject 只读消费不打断流）。
//! - `steering`：steering 子系统（B3.3）——SteeringCoordinator（预算/计数
//!   单一来源，01 §3.3 / D10）、RecoverySteeringStrategy（after-tools /
//!   empty-response，D2/D7/D9）、nudge 注入通道（D8：run 内不注入，排入
//!   下一条用户消息）、自终止诊断（D4）。
//! - `stream` / `provider`：provider 消费契约（B3.4 第 5 点）——ProviderCall
//!   trait 解耦（不直接依赖 agent-provider），本地等价流事件与消费聚合层。
//! - `r#loop`：run 主循环（B3.4）——AgentSessionLoop + 8 个 handler +
//!   收口决策（end.rs）+ 安全点集成。
//! - `tool_events` / `tool_exec`：工具批处理执行器（B3.5）。
//! - `approval`：审批通道（R4 T10）——ToolContext.ask 的真实接线，把工具内
//!   审批提问接到 ApprovalGate（approval-requested + 等待裁决 + abort 取消）。
//! - `testing`：TestProvider / TestTool 测试替身（B3.6 先行落地）。
//!
//! 语义来源：01-session-loop-semantics.md §1-§五；TS 对照：
//! packages/agent-core/src/state-machine/agent-session.ts、
//! agent-input-queue.ts、control/control-bus.ts、session-loop/control-check.ts、
//! steering/、runtime-components/。

pub mod approval;
pub mod approval_router;
pub mod cache_tracker;
pub mod checkpoint;
pub mod control;
pub mod escape_watch;
pub mod hooks;
pub mod hydrate;
pub mod input;
pub mod r#loop;
pub mod provider;
pub mod safe_point;
pub mod state;
pub mod steering;
pub mod stream;
pub mod testing;
pub mod tool_events;
pub mod tool_exec;
pub mod undeclared_detector;

pub use agent_tools::permission::{decide, PermissionMode, PermissionVerdict};
pub use approval::ApprovalChannel;
pub use approval_router::{
    approval_reason_from_args, arbiter_metadata, classify_source, relay_denied_message,
    requester_from_context, route_approval, route_approval_guarded, ApprovalSource, Arbiter,
    APPROVAL_REASON_ARG_KEY, ARBITER_WIRE_MAIN_AGENT, ARBITER_WIRE_USER,
};
pub use cache_tracker::{CacheMiss, CacheStatsTracker, CacheTrackingConfig};

pub use control::{
    level_for_kind, ControlBus, ControlDrainAction, ControlIntent, ControlIntentInput, ControlKind,
    ControlLevel,
};
pub use escape_watch::{
    build_escape_injection_text, escape_exclude_paths, spawn_escape_watch,
    spawn_escape_watch_consumer, EscapeAggregator, EscapeWatchConfig, EscapeWatchHandle,
    EscapeWatchInjector,
};
pub use hooks::{
    HookAction, HookDispatchOutcome, HookError, HookEvent, HookEventKind, HookFailStrategy,
    HookHandler, HookMode, HookRegisterOptions, HookRegistry,
};
pub use input::{
    input_overwrite_count, next_batch_seq, AgentInputQueue, InputEnqueueMode, PendingInputStore,
    RingBuffer, INPUT_QUEUE_CAPACITY,
};
pub use provider::{
    DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest, ProviderStreamItem,
    ReasoningEffort, ToolSchema,
};
pub use r#loop::{
    AgentSessionLoop, EndDecision, RecoveryDecision, RecoveryHook, RunOutcome, SessionLoopOptions,
    TurnEndContext, TurnEndHook,
};
// T-33/T-42：摘要后台调度类型面（run 级 dispatch + 会话级协调器/注册表 +
// 配置面键）——壳层装配（T-43/T-44）与 orchestrator 回调落库消费
pub use r#loop::summary_coordinator::{
    SessionSummaryCoordinator, SessionSummaryCoordinatorRegistry, MAX_CONCURRENT_SUMMARY_TASKS,
};
pub use r#loop::summary_dispatch::{
    summary_l1_placeholder, SummaryBackgroundSink, SummaryBackgroundSinkRef, SummaryDispatch,
    SummaryDispatchConfig, SummaryDispatchOutcome, SummaryDispatchTask, SummaryOutcomeCallback,
    SummaryRetryGate, SummaryRetryGuardConfig, DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
    DEFAULT_RETRY_GUARD_WINDOW_MS, LOOP_SUMMARY_MAX_WALL_MS, MAX_SUMMARY_ATTEMPTS,
    META_KEY_SUMMARY_BACKOFF_MS, META_KEY_SUMMARY_L1_PLACEHOLDER, META_KEY_SUMMARY_MAX_ATTEMPTS,
    META_KEY_SUMMARY_RETRY_WINDOW_MS, META_KEY_SUMMARY_WALL_MS, SUMMARY_BACKOFF_MS,
    SUMMARY_JITTER_RATIO,
};
pub use safe_point::{apply_safe_point_control, AbortSignal, ControlAction};
pub use state::AgentSessionMachine;
pub use steering::{
    AppliedResult, PendingNudge, PendingNudgeChannel, RecoverySteeringStrategy,
    RecoverySteeringStrategyOptions, SelfTerminationDiagnostic, SteeringAction, SteeringContext,
    SteeringCoordinator, SteeringCoordinatorOptions, SteeringPhase, SteeringReason,
};
pub use stream::{
    consume, ConsumeBuilder, ConsumeResult, ConsumeStopReason, ProviderStreamEvent, ProviderUsage,
    StopReason,
};
pub use testing::{TestProvider, TestTool};
pub use tool_events::{
    ApprovalDecision, ApprovalGate, ApprovalRequester, ClassifiedToolResult, FailStrategy,
    ToolBatchOptions, ToolErrorKind, ToolEvent,
};
pub use tool_exec::{ToolBatchOutcome, ToolExecCtx, ToolExecutor};
pub use undeclared_detector::{RegistryBackedDetector, UndeclaredWriteDetector};
