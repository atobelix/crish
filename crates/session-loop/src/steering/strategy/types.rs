//! 策略类型定义与默认常量（对齐 TS recovery-steering-strategy.ts）

use std::sync::Arc;

use conex_types::message::AgentMessage;

use crate::steering::SteeringReason;

use super::heuristics::{detect_recent_tool_error_loop, detect_repeated_tool_call_loop};

/// 最大连续工具错误数（默认 2，对齐 TS recovery-steering-strategy.ts:41）
pub const DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS: usize = 2;
/// 最大重复调用数（默认 3，对齐 TS :42）
pub const DEFAULT_MAX_REPEATED_TOOL_CALLS: usize = 3;
/// 策略层最大纠偏消息数（默认 1，对齐 TS :43；coordinator 预算默认 3 为全局上限）
pub const DEFAULT_MAX_STEERING_MESSAGES: usize = 1;

/// 策略配置（对齐 TS RecoverySteeringStrategyOptions）
#[derive(Debug, Clone, Copy, Default)]
pub struct RecoverySteeringStrategyOptions {
    /// 最大连续工具错误数（默认 [DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS] = 2）
    pub max_consecutive_tool_errors: Option<usize>,
    /// 最大重复调用数（默认 [DEFAULT_MAX_REPEATED_TOOL_CALLS] = 3）
    pub max_repeated_tool_calls: Option<usize>,
    /// 策略层最大纠偏消息数（默认 [DEFAULT_MAX_STEERING_MESSAGES] = 1）
    pub max_steering_messages: Option<usize>,
}

/// 恢复纠偏策略
#[derive(Debug, Clone, Copy)]
pub struct RecoverySteeringStrategy {
    pub(crate) max_consecutive_tool_errors: usize,
    pub(crate) max_repeated_tool_calls: usize,
    pub(crate) max_steering_messages: usize,
}

impl RecoverySteeringStrategy {
    /// 新建策略（选项缺省取默认值）
    pub fn new(options: RecoverySteeringStrategyOptions) -> Self {
        Self {
            max_consecutive_tool_errors: options
                .max_consecutive_tool_errors
                .unwrap_or(DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS),
            max_repeated_tool_calls: options
                .max_repeated_tool_calls
                .unwrap_or(DEFAULT_MAX_REPEATED_TOOL_CALLS),
            max_steering_messages: options
                .max_steering_messages
                .unwrap_or(DEFAULT_MAX_STEERING_MESSAGES),
        }
    }

    /// 从消息列表检测纠偏需求：错误环优先，其次重复调用环
    /// （Arc 共享形态，PE-09 T09.3.2：读字段自动 deref）
    pub fn detect_recovery_need(&self, messages: &[Arc<AgentMessage>]) -> Option<SteeringReason> {
        detect_recent_tool_error_loop(messages, self.max_consecutive_tool_errors)
            .or_else(|| detect_repeated_tool_call_loop(messages, self.max_repeated_tool_calls))
    }
}

impl Default for RecoverySteeringStrategy {
    fn default() -> Self {
        Self::new(RecoverySteeringStrategyOptions::default())
    }
}
