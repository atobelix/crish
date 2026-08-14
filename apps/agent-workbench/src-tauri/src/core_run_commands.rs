//! run 生命周期命令桥（B6.1：core_run_task / core_run_control /
//! core_cancel_run / core_approve_tool / core_deny_tool）
//!
//! 本模块同时承载：
//! - [CoreRunState]：进程内核心运行状态（store / 引擎 / 事件桥 / 活动 run
//!   注册表 / 恢复门禁 / 快照状态，B6.4）；
//! - [drive_run_loop]：run 驱动循环——`produce`（[RunProducer] trait）→
//!   [orchestrator::events::drive_outcome] → 事件 emit（信封 runId/sequence
//!   注入；T09.1 后收口 message-delta 跳过不双发）→ cursor 发布 → 终态
//!   退出；错误路径 [finalize_failed]；退出后快照（T08.6 触发点 A）；
//! - [ApprovalGateImpl]：审批门（approval-requested 先发后等防死锁，
//!   01 §五.8；I-02 / PE-12 T12.3：待审批集合校验）；
//! - 快照三触发（PE-08 T08.6）：终态保存（[CoreRunState::save_snapshot_now]）/
//!   周期任务（[CoreRunState::spawn_snapshot_loop]，默认 60s 可配）/
//!   退出钩子（[CoreRunState::save_snapshot_blocking]，main.rs `RunEvent::Exit`）；
//!   restore 在 app.manage(CoreRunState) 之前经 run_in_runtime 执行
//!   （[CoreRunState::run_restore]）；run_task 门禁 restore_ready（Q24 竞态）。
//!
//! 错误协议：命令返回 [crate::core_error::CoreError]（`{kind, detail}`，
//! 03 §5.3-5 IPC 面唯一协议；R2 的 core_error.rs 已接线，run/store 错误
//! 经 `map_run_err` / `map_store_err` 无损映射，77 码经 `core_error_code`
//! 显式映射——见 PE-03 §2.4.2 映射表）。
//!
//! 结构（SR-02 · 拆分 · ≠ EL）：本文件为薄门面 barrel——实现按 6 域切分
//! 至 `run/` 目录 9 模（run_core / run_snapshot / run_launch / run_retry /
//! run_approval / run_history / run_resume / run_idle / run_commands），
//! 经 `run/mod.rs` 聚合 re-export 保持全部 crate 内引用路径不 break；
//! CoreRunState 单定义持有于 run_core.rs。测试仍旁挂本文件
//! （core_run_commands_tests.rs，`super::` 引用面不变）。

#[path = "run/mod.rs"]
mod run;

// ── 域实现聚合（run/ 目录 9 模；保持既有 crate 内引用路径不 break）──
// 经 run/mod.rs glob re-export：全部顶层符号（pub(crate) 化）+ 外部 use
// 面 + 顶层常量；门面以下引用保持 `crate::core_run_commands::*` 可解析。
pub(crate) use run::*;

// ── 测试（SR-01 · 测外置 · 旁挂 core_run_commands_tests.rs · ≠ EL）──

#[cfg(test)]
#[path = "core_run_commands_tests.rs"]
mod tests;

/// 跨模块测试面 re-export（engine_tests.rs 等经
/// `crate::core_run_commands::{CONFIG_TEST_LOCK, isolate_config_store}`
/// 引用；定义在旁挂测试文件，此处 re-export 保持既有路径不 break）
#[cfg(test)]
pub(crate) use tests::{CONFIG_TEST_LOCK, isolate_config_store};
