//! tool_exec 测试集合（SR-03 · 拆分 · ≠ EL：tool_exec.rs 测试旁挂解耦）
//!
//! 原 `tool_exec_tests.rs` 3717 行超限单体文件按领域物理拆分为 11 个子模块，
//! 单文件严格 <= 480 行，81 个既有用例及全部断言 100% 严格守恒。

pub(super) mod approval_fixture;
pub(super) mod fixture;
pub(super) mod middleware;

mod approval;
mod approval_hang;
mod budget;
mod concurrency;
mod hooks;
mod lifecycle;
mod middleware_timeout;
mod permission;
mod revert;
mod single_exec;
