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
//! 装配（engine.rs `EngineHandle::new`）：
//! - pending sink = [QueuePendingSink]（真实 PendingMessageQueue）；
//! - event sink = [AgentEventSink]（缓冲 + 日志；事件面接线 = engine.rs
//!   `forward_drained_timer_events` 周期 drain 转发到 EventBridge，
//!   main.rs drain 任务装配在批 3，30 方案 §4）；
//! - store = [MemoryTimerStore]（conex-db 真适配需要 db 句柄，R-CF3
//!   装配收口接线；session_meta 无前缀枚举接口，真适配需配套
//!   `timer_ids` 索引键——本文件已按 `timer_<id>` 键形状实现内存版）。
//!
//! 早退旁路点（T-CF-07 §3）：orchestrator `EventQueue::push` 与 Tauri
//! 侧事件收口均不在本文件域；钩子以 [TimerRegistry::on_event] 提供，
//! 事件面接线点在 R-CF3 落地（当前由单元测试覆盖语义）。

pub(crate) mod early_exit;
pub(crate) mod registry;
pub(crate) mod store;
pub(crate) mod types;

#[cfg(test)]
mod tests;

pub(crate) use registry::TimerRegistry;
pub(crate) use store::{LocalDbTimerStore, MemoryTimerStore, TimerStore};
pub(crate) use types::{
    AgentEventSink, EventSink, QueuePendingSink, TimerCancelReason, TimerEvent, steering_group_id,
};
