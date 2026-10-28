//! 子代理派发与生命周期管理模块
//!
//! 提供面向生产环境的子代理派发器 `SubagentSpawnerImpl`，集成深度/兄弟/并发递归守卫、
//! `session_agents` 数据库落库、子代理生命周期与终态事件分发。

pub mod capacity;
pub mod lifecycle;
pub mod spawn;
pub mod spawner;
pub mod terminal;
pub mod tracking;
pub mod types;

#[cfg(test)]
mod tests;

pub use spawner::SubagentSpawnerImpl;
pub use types::{SubagentRunConfig, SubagentRunLauncher};
