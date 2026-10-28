//! 子代理领域核心（纯逻辑，无 I/O）。
//!
//! 设计依据：`docs/subagent-collaboration-redesign/00-总方案…` 与 `01-分维…`。
//!
//! 本 crate 是子代理的**唯一领域真源**：
//! - `task`：任务类型 / 能力档 / 角色 / 状态机；
//! - `guard`：可配的准入策略（深度、嵌套、并发）与祖先链死锁检测；
//! - `policy`：会话级 `AgentPolicy`（主 agent 可调）与通信节奏默认值；
//! - `fault`：统一错误信封与可执行建议动作；
//! - `ports`：宿主实现的最小端口（时钟、策略存储）。
//!
//! 约束：禁止依赖 tokio / 数据库 / Tauri / session-loop；规则必须是可单测的纯函数。

pub mod capability;
pub mod comm;
pub mod fault;
pub mod guard;
pub mod model;
pub mod permission;
pub mod policy;
pub mod ports;
pub mod task;
