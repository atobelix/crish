//! Cron 调度注册表（G9 调度面；T-CF-09，REQ-C03）
//!
//! 职责（02-CF 方案 §4.4 / T-CF-09 / Scheduled Tasks Revamp Phase 1）：
//! - [SchedulerRegistry]：注册 / 暂停 / 恢复 / 就地更新 / 取消 / 重启恢复 / 触发执行；
//!   每次触发经 [PendingSink]（PendingMessageQueue 适配）注入 steering
//!   条目（group_id = `cron-<id>`，replaceOrEnqueue 去重），或经
//!   [DaemonRunLauncher] 拉起独立 run（is_daemon 双路径，§4.4 冻结语义）；
//! - MaxIterations：`fired_count >= max_iterations` → 停止并清除
//!   （status=Completed 落库 + 移除 sleep），触发一次「cron 已完成」通知；
//! - 持久化：经 [SchedStore] 适配 conex-db session_meta `sched_*` 键
//!   （键形状 `sched_<cron_id>`，与 timers.rs `timer_*` 键同构）；
//! - 重启恢复：扫描 `sched_*` 键，Active 且未达上限 → 按 next_fire_at_ms
//!   重建 sleep；Paused → 加载内存表不建 sleep；已过期未触发 → 先入 tasks 表消除真空期，再异步补发一次。
//!
//! 冻结契约对齐（§4.4 / §4.7 / §4.8）：
//! - `parse_cron` / `CronSchedule::next_fire_after` 来自 conex-types cron
//!   模块（T-CF-08 冻结签名，A4 域）；
//! - `AgentEvent::CronFired` 事件变体来自 conex-types events.rs
//!   （T-CF-08 登记，字段：sessionId/cronId/prompt/expression/iteration/
//!   firedAtMs），本文件经内部形状 [CronEvent] 与 [EventSink] 单点映射，
//!   避免散落依赖事件面细节；
//! - 唤醒摘要（T-CF-12 冻结模板 §4.8）：Cron 触发文本按
//!   「<prompt>（cron <id> 第 N 次触发）」模板拼接。

pub mod entry;
pub mod registry;
pub mod store;
pub mod types;

#[cfg(test)]
mod tests;

#[cfg(test)]
pub use self::types::SESSION_META_SCHED_INDEX_KEY;

pub use self::registry::SchedulerRegistry;
pub use self::store::{LocalDbSchedStore, MemorySchedStore, SchedStore};
pub use self::types::*;
