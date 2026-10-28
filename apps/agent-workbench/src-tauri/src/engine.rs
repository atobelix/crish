//! 引擎装配层门面（壳域部分）
//!
//! 引擎 crate 域（[EngineHandle] 装配 / provider 底座 / 通道板卡 / 缓冲桥）
//! 已下沉 `conex-run`（`conex_run::engine_handle` / `engine_provider` /
//! `engine_channels` / `run_producer` / `context_injection` / `audit`）。
//! 本文件只做壳域 mod 接线：
//! - [engine_build]：[EngineHost] 宿主聚合（browser/computer/workflow 通道
//!   + 全局注入）+ [EngineHostHooks]/[RunLaunchHooks] 实现 + MCP 自动拉起；
//! - 测试旁挂 `engine_tests.rs`（`#[path]` 接线，无孤儿）。
//!
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分不关任何 EL；crate 下沉后壳域仅剩
//! 宿主装配面）。

// B1-5 接线修正：子模以 `#[path]` 显式接线（同目录旁挂，对齐
// note_commands.rs 先例）——rustc 2018+ 对非根模块文件只解析
// 目录式子模块路径（`engine/engine_audit.rs`），旁挂文件必须 #[path]
#[path = "engine_build.rs"]
pub(crate) mod engine_build;

pub(crate) use engine_build::*;

// ── 测试（SR-04 外置；engine_tests.rs 旁挂，`#[path]` 接线，无孤儿）──

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
