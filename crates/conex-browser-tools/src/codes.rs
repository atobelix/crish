//! browser_* 工具错误码（维度 17 §1.3 码表 + 22 裁决 U-12 补登）
//!
//! 码表权威：17 文档 §1.3（`tool.browser.*` 域）与 22 裁决 U-12（`tab_limit_exceeded`）。
//! 本 crate 常量先行，**conex-types 码表登记为遗留接线项**（由主控登记进
//! `crates/conex-types/src/error.rs` 的 codes 模块与错误注册表，本 crate 不触碰
//! 其他文件）；未接线面（`unwired`）为本 crate 内部 MVP 边界专用语义。

/// 恢复期浏览器不可用（进程启动中/崩溃重启未完成时的工具层 gating，R-9-2）。
pub const TOOL_BROWSER_NOT_READY: &str = "tool.browser.not_ready";
/// 域名门禁拦截（白名单外/黑名单/IP 保留段/scheme 门禁，17 §4）。
pub const TOOL_BROWSER_GATE_BLOCKED: &str = "tool.browser.gate_blocked";
/// 默认拒绝面未开启（evaluate/upload/clipboard 能力位，17 §2.3 红线语义）。
pub const TOOL_BROWSER_CAPABILITY_DISABLED: &str = "tool.browser.capability_disabled";
/// 快照版本失效（版本推进/VersionReset 后作废，模型应重快照，D-5）。
pub const TOOL_BROWSER_STALE_SNAPSHOT: &str = "tool.browser.stale_snapshot";
/// 元素过期（快照索引在当前快照中不存在）。
pub const TOOL_BROWSER_NODE_GONE: &str = "tool.browser.node_gone";
/// 急停/取消（全局急停或会话级中止令牌触发，17 §6.4）。
pub const TOOL_BROWSER_CANCELLED: &str = "tool.browser.cancelled";
/// evaluate 白名单拒绝（17 §3；MVP 未注册 browser_evaluate，P1 落地后使用）。
pub const TOOL_BROWSER_EVAL_FORBIDDEN: &str = "tool.browser.eval_forbidden";
/// 标签数量超限（MAX_TABS 裁决，15 文档；U-12 统一登记于 17 码表）。
pub const TOOL_BROWSER_TAB_LIMIT_EXCEEDED: &str = "tool.browser.tab_limit_exceeded";
/// MVP 边界未接线面（evaluate 调用、select_option 的 label/index 定位等，P1 落地）。
pub const TOOL_BROWSER_UNWIRED: &str = "tool.browser.unwired";
