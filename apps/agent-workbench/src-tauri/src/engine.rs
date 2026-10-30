//! 引擎装配层门面（壳域部分）
//!
//! 引擎 crate 域（[EngineHandle] 装配 / provider 底座 / 通道板卡 / 缓冲桥）
//! 已下沉 `conex-run`（`conex_run::engine_handle` / `engine_provider` /
//! `engine_channels` / `run_producer` / `context_injection` / `audit`）。
//! 本文件只做壳域 mod 接线：
//! - [build]：`engine/build.rs`（[EngineHost] 宿主聚合（browser/computer/workflow
//!   通道 + 全局注入）+ [EngineHostHooks]/[RunLaunchHooks] 实现 + MCP 自动拉起）；
//! - 测试子模 `engine/tests.rs`（`#[cfg(test)] mod tests;`，无孤儿）。
//!
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分不关任何 EL；crate 下沉后壳域仅剩
//! 宿主装配面）。

// 目录式子模块（`engine/build.rs`，与目录一致，无 `#[path]`）
pub(crate) mod build;

pub(crate) use build::*;

// ── 测试（SR-04 外置；engine/tests.rs，`#[cfg(test)] mod tests;`，无孤儿）──

#[cfg(test)]
mod tests;
