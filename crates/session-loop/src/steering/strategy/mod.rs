//! RecoverySteeringStrategy（对齐 TS recovery-steering-strategy.ts）
//!
//! 唯一活跃策略：phases = `after-tools` / `empty-response`（01 §3.1）。
//!
//! - empty-response（D7）：`steering_count >= maxSteeringMessages`（默认 1）
//!   时返回 `intervention-required`——预算内重试注入，耗尽后 intervention
//!   事件照发但不以 error 收场（收场语义由 coordinator/主循环保证）；
//! - after-tools：扫描消息列表检测连续工具错误环
//!   （[detect_recent_tool_error_loop]，连续错误 ≥ maxConsecutiveToolErrors=2）
//!   与重复调用环（[detect_repeated_tool_call_loop]，重复 ≥
//!   maxRepeatedToolCalls=3）→ 预算内 `inject-message`、耗尽
//!   `intervention-required`。
//!
//! 检测函数语义对齐 TS runtime-helpers.ts：自消息尾部向前扫描，
//! 遇 user 消息停止；错误环检测中最近一条非失败的 tool-result 即判定无环。
//!
//! PE-09 T09.3.2：策略消费的对话消息为 Arc 共享形态（`&[Arc<AgentMessage>]`），
//! 读字段自动 deref，行为不变。

pub(crate) mod engine;
pub(crate) mod heuristics;
pub(crate) mod types;

#[cfg(test)]
mod tests;

pub use heuristics::{
    detect_recent_tool_error_loop, detect_repeated_tool_call_loop, ToolPromiseDetector,
};
pub use types::{
    RecoverySteeringStrategy, RecoverySteeringStrategyOptions,
    DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS, DEFAULT_MAX_REPEATED_TOOL_CALLS,
    DEFAULT_MAX_STEERING_MESSAGES,
};
