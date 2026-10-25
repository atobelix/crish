//! steering 子系统（B3.3，对齐 01 第三章 + 第四章 D2/D3/D7/D8/D9/D10）
//!
//! 组件：
//! - [SteeringCoordinator]：预算与计数的**唯一**持有者（01 §3.3 单一计数源，
//!   D10）。`maxSteeringBudget`（默认 3）为单一配置源；`apply` 执行
//!   `inject-message` 是唯一的计数增量点；`evaluate` 中 inject-message
//!   超预算即跳过，`intervention-required` / `emit-diagnostic` 不受预算限制。
//! - [strategy]：[RecoverySteeringStrategy]——唯一活跃策略，
//!   phases = `after-tools` / `empty-response`（01 §3.1）。
//! - [nudge]：nudge 文本生成 + steering/诊断注入消息构建（当前 run 纠偏）；
//!   跨 run「下一条用户消息」规范载体为 orchestrator `PendingMessageQueue`
//!   （决策 9 已删 nudge 独立半成品通道，见详案 I1-α）。
//! - [diagnostics]：自终止诊断（D4：非 error 语义，字段结构保留）。
//!
//! 裁决落点（01 第四章，本子系统承担部分；其余由 B3.4 主循环挂接）：
//! - **D2**：tool-promise 机制删除；`promisedToolsWithoutCall` 计数删除，
//!   仅 [diagnostics::SelfTerminationDiagnostic] 保留字段结构。
//! - **D3**：预注入短路保留——`evaluate` 前若输入队列有可运行输入
//!   （`has_pending_input`），调用方（B3.4）应跳过策略评估，避免重复注入。
//! - **D7**：empty-response 预算内重试注入；预算耗尽返回
//!   `intervention-required`（事件照发），但不以 error 收场。
//! - **D8**：当前 run 不注入跨 run nudge；「下一条用户消息」一律经
//!   orchestrator `PendingMessageQueue`（决策 9：nudge 独立通道已删除）。
//! - **D9**：预算耗尽禁止 `inject-message`（`evaluate` 超预算跳过）；
//!   run 以 stop 收场由 B3.4 保证——本子系统 [AppliedResult] 无 error 语义。
//! - **D10**：删除机器上下文 `steeringCount` 死检查；预算/计数只在
//!   coordinator，单一配置源（coordinator 预算默认 3、策略层
//!   `maxSteeringMessages` 默认 1）。

mod diagnostics;
mod nudge;
pub(crate) mod strategy;

mod coordinator;
mod events;
mod types;

pub use strategy::ToolPromiseDetector;

use conex_types::message::AgentMessageMetadataKind;

/// 全局最大纠偏注入数（对齐 TS coordinator 默认 3，steering-coordinator.ts:50）
pub const DEFAULT_MAX_STEERING_BUDGET: usize = 3;

/// metadata.kind 枚举 → wire 字符串（I1-α④ 枚举化消费侧）
///
/// T1a 枚举（conex-types 只读）只定义枚举位 + serde kebab-case 序列化；
/// 「替换为 as_str()」按详案归属 I1 实现。conex-types 只读域不可加
/// inherent impl（孤儿规则），以本自由函数承载 wire 映射——**值由枚举
/// serde 序列化派生（单一来源，registry_drift 已锁定），不重复声明
/// 魔法字符串**；消费侧（产出/断言）统一走本函数。
pub fn metadata_kind_wire(kind: AgentMessageMetadataKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// intervention-required 的默认附带消息（对齐 TS 默认文案）
pub(crate) const DEFAULT_INTERVENTION_MESSAGE: &str =
    "The agent did not recover after runtime steering.";

pub use coordinator::SteeringCoordinator;
pub(crate) use events::{iso_from_epoch_ms, steering_evaluated_event};
pub(crate) use types::SteeringEvaluationTrace;
pub use types::{
    AppliedResult, SteeringAction, SteeringContext, SteeringCoordinatorOptions, SteeringPhase,
    SteeringReason, SteeringStrategy,
};

pub use diagnostics::SelfTerminationDiagnostic;
pub use nudge::{build_steering_message, runtime_steering_text};
pub use strategy::{
    detect_recent_tool_error_loop, detect_repeated_tool_call_loop, RecoverySteeringStrategy,
    RecoverySteeringStrategyOptions, DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
    DEFAULT_MAX_REPEATED_TOOL_CALLS, DEFAULT_MAX_STEERING_MESSAGES,
};

#[cfg(test)]
mod tests;

/// 测试共享构造器（仅测试编译目标）
#[cfg(test)]
pub(crate) mod testutil;
