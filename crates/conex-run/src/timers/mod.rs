//! 定时器注册表（G5/G6 引擎面；T-CF-06 / T-CF-07，REQ-C01/C02）
//!
//! 职责（02-CF 方案 §4.3）：
//! - [TimerRegistry]：注册 / 取消 / 活跃列表 / 重启恢复 / 早退钩子；
//!   到期经 [PendingSink]（PendingMessageQueue 适配）注入 steering 条目，
//!   不直接持有 ControlBus——唤醒走 steering 面而非事件面（§4.7 分工）；
//! - 冲突约束（REQ-C02 / T-CF-07）：`Task(sender)` 条件与 early_exit 表
//!   联动，同一 sender 只允许一个活跃定时器；`Any` 条件不参与冲突表；
//! - 持久化：经 [TimerStore] 适配 conex-db session_meta `timer_*` 键。
//!
//! 冻结契约对齐（§4.1 / §4.2 / §4.7）：
//! - `TimerCondition` / `TimerHandle` / `TimerDeclaration` 来自
//!   conex-types（T-CF-04 产物），`TimerDeclaration::remaining_ms` 辅助
//!   方法由该任务卡实现；
//! - `TimerChannel` / `TimerError` 来自 agent-tools set_timer.rs
//!   （T-CF-05 产物）；
//! - `AgentEvent::TimerFired` / `AgentEvent::TimerCancelled` 事件变体来自
//!   conex-types events.rs（T-CF-04 产物），本文件经内部形状 [TimerEvent]
//!   与 [AgentEventSink] 单点映射，避免散落依赖事件面细节。
//!
//! 装配（`engine_handle.rs::assemble_engine_core`）：
//! - pending sink = [QueuePendingSink]（真实 PendingMessageQueue）；
//! - event sink = [AgentEventSink]（缓冲 + 日志；`engine_channels.rs` 提供
//!   drain 转发到 EventBridge，宿主周期任务在 `main.rs` 装配）；
//! - store = [LocalDbTimerStore]（有 LocalDb 时经 `timer_ids` 索引持久化，
//!   无数据库时使用 [MemoryTimerStore]）。
//!
//! 早退旁路点（T-CF-07 §3）：orchestrator `EventQueue::push` 与 Tauri
//! 侧事件收口均不在本文件域；钩子以 [TimerRegistry::on_event] 提供。

pub mod early_exit;
pub mod registry;
pub mod store;
pub mod types;

#[cfg(test)]
mod tests;

pub use registry::TimerRegistry;
pub use store::{LocalDbTimerStore, MemoryTimerStore, TimerStore};
pub use types::{steering_group_id, TimerCancelReason, TimerEvent};
pub use types::{AgentEventSink, EventSink, QueuePendingSink};
