//! 域子集类型化命令/事件包装（维度 11 §3.3 清单，R-3 补齐后 13 域；
//! 维度 16 storage_state 注入/导出聚合增补 DOMStorage 域）
//!
//! 覆盖清单：Browser / Target / Page / Runtime / DOM / DOMSnapshot /
//! Accessibility / Network / Input / Emulation / Storage / DOMStorage /
//! SystemInfo / Log。
//! Console 无独立域：控制台面由 Runtime.consoleAPICalled / exceptionThrown /
//! Page.pageError 组合承载（§3.3 Console 能力说明）。
//!
//! 约定：
//! - 命令参数结构实现 `Serialize`，结果结构实现 `Deserialize`，camelCase 字段名；
//! - 事件结构实现 `Deserialize`，由 bus.rs 分类 router 消费；
//! - `names` 模块集中登记本 crate 内部使用的 method 常量（enable 序列/恢复流程）。

/// 内部使用的方法名常量（恢复流程/探测/对话框应答/心跳探针）。
pub mod names;

mod accessibility;
mod browser_target;
mod dom;
mod dom_snapshot;
mod input_emulation;
mod network;
mod page;
mod runtime;
mod storage;
mod system_log;

pub use accessibility::*;
pub use browser_target::*;
pub use dom::*;
pub use dom_snapshot::*;
pub use input_emulation::*;
pub use network::*;
pub use page::*;
pub use runtime::*;
pub use storage::*;
pub use system_log::*;

#[cfg(test)]
mod tests;
