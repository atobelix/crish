//! 导航类工具（8 个，17 §1.2 导航表）
//!
//! 全部导航命令发送前过导航检查点（17 §4.4：navigate/new_tab 校验目标 URL，
//! back/forward/reload 校验当前页 URL + 动作后复核）；`tab_id` 入参语义（P1
//! 多标签，15 文档 §7）：close_tab/switch_tab 统一为**真实 targetId 字符串**
//! （browser_list_tabs 输出，撤销 MVP 序号语义）；new_tab 受 MAX_TABS=8 上限
//! 约束（可配 1-16，超限返回 `tool.browser.tab_limit_exceeded`，U-12 码）。

mod history;
mod tabs;
#[cfg(test)]
mod tests;

pub(crate) use history::{BackTool, ForwardTool, NavigateTool, ReloadTool};
pub(crate) use tabs::{CloseTabTool, ListTabsTool, NewTabTool, SwitchTabTool};
// tabs.rs 的 ListTabsTool 以 `super::page_targets` 调用 tools 层 helper
// （拆分前 navigate.rs 的 super 即 tools），此处引入后该路径原样可用。
use super::page_targets;
