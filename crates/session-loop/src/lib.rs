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
pub mod cache_tracker;
pub mod checkpoint;
pub mod control;
pub mod hooks;
pub mod hydrate;
pub mod input;
pub mod provider;
pub mod r#loop;
pub mod safe_point;
pub mod state;
pub mod steering;
pub mod stream;
pub mod testing;
pub mod tool_events;
pub mod tool_exec;

pub use agent_tools::permission::{decide, PermissionMode, PermissionVerdict};
pub use approval::ApprovalChannel;
pub use cache_tracker::{CacheMiss, CacheStatsTracker, CacheTrackingConfig};

pub use control::{
    level_for_kind, ControlBus, ControlDrainAction, ControlIntent, ControlIntentInput,
    ControlKind, ControlLevel,
};
pub use hooks::{
    HookAction, HookDispatchOutcome, HookError, HookEvent, HookEventKind, HookFailStrategy,
    HookHandler, HookMode, HookRegisterOptions, HookRegistry,
};
pub use input::{next_batch_seq, AgentInputQueue, InputEnqueueMode, RingBuffer, INPUT_QUEUE_CAPACITY};
pub use provider::{
    DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest, ProviderStreamItem,
    StreamResult, ToolSchema,
};
pub use r#loop::{
    AgentSessionLoop, EndDecision, RecoveryDecision, RecoveryHook, RunOutcome, SessionLoopOptions,
    TurnEndContext, TurnEndHook,
};
pub use safe_point::{AbortSignal, ControlAction, apply_safe_point_control};
pub use state::AgentSessionMachine;
pub use steering::{
    AppliedResult, PendingNudge, PendingNudgeChannel, RecoverySteeringStrategy,
    RecoverySteeringStrategyOptions, SelfTerminationDiagnostic, SteeringAction, SteeringContext,
    SteeringCoordinator, SteeringCoordinatorOptions, SteeringPhase, SteeringReason,
};
pub use stream::{
    ConsumeBuilder, ConsumeResult, ConsumeStopReason, ProviderStreamEvent, ProviderUsage,
    StopReason, consume,
};
pub use testing::{TestProvider, TestTool};
pub use tool_events::{
    ApprovalDecision, ApprovalGate, ClassifiedToolResult, FailStrategy, ToolBatchOptions,
    ToolErrorKind, ToolEvent,
};
pub use tool_exec::{ToolExecCtx, ToolExecutor, ToolBatchOutcome};
