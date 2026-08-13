//! 最小工具执行器（任务书 B5.3：单工具执行 + 输出策略 + 幂等检查）
//!
//! agent-tools 此前无执行器模块，本任务建立最小执行器供 B3.5 消费：
//! - 单工具执行（Tool trait 直接调用，未做并发/批次调度，留给 B3.5）
//! - 输出预算策略（summarize 截断 + 标记字段）
//! - 幂等检查（ToolIdempotencyGuard：同域同参去重，输出带 deduplicated 标记）
//!
//! 语义来源：05 §2.3 输出预算、05 §5.5 工具幂等（stream-recovery.test.ts:188-229）。
//!
//! SR-06a-4 拆分：本文件为薄门面——类型面 `executor_types`、幂等键面
//! `executor_idem`、执行面 `executor_run`，`#[path]` 显式接线（无孤儿）；
//! 测试整体外置 `executor_tests.rs`（`#[path]` 旁挂，零删除）。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL-01…10 / ≠ 结构债清零）。

#[path = "executor_types.rs"]
mod executor_types;
#[path = "executor_idem.rs"]
mod executor_idem;
#[path = "executor_run.rs"]
mod executor_run;

pub use executor_types::{ExecutorContext, ToolExecutionPolicy, ToolResult};
pub use executor_run::{execute_stream_with_output_policy, execute_with_output_policy};

// 测试旁挂（executor_tests.rs）经 `use super::*` 消费以下符号面，
// 故仅在 cfg(test) 下声明，避免主构建 unused import 告警。
#[cfg(test)]
use crate::definition::ToolError;
#[cfg(test)]
use crate::idempotency::ToolIdempotencyGuard;
#[cfg(test)]
use crate::streaming::ToolProgress;
#[cfg(test)]
use conex_types::error::codes;
#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
#[path = "executor_tests.rs"]
mod tests;
