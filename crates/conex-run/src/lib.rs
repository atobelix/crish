//! conex-run —— 运行编排域 crate
//!
//! 自壳层（`apps/agent-workbench/src-tauri`）下沉的 run/workflow 编排域：
//! run 状态机与生命周期（`run/`）、idle 续跑、重试熔断、审批门、历史缓存、
//! 调度器（`sched`）、子代理派生（`subagent_spawner`）、定时器（`timers`）、
//! 事件桥契约（`core_event_bridge` + `buffer`）、任务事件消费、无人值守
//! 唤醒链路（`wake_watcher` + `wakeup_summary`）、provider 执行底座
//! （`engine_provider` + `engine_channels` + `engine_handle`）与统一错误
//! 协议（`core_error`）。
//!
//! 依赖纪律：
//! - 本 crate **零 tauri 依赖**——壳层事件发射经 [core_event_bridge::Emitter]
//!   trait 注入（Tauri 实现留在壳层装配侧）；宿主配置/笔记后端经
//!   [engine_assembly] 注入契约提供；
//! - 依赖方向单向：壳层 → 本 crate → 各底层 crate（conex-types / conex-db /
//!   orchestrator / session-loop / agent-provider / agent-tools），零环；
//! - 壳层专属装配（浏览器 / 电脑操作 / watchdog 等域的接线）留在壳层
//!   `engine_build`，经 [engine_assembly::EngineHostHooks] 注入工具注册。

pub mod agent_mailbox;
pub mod agent_policy;
pub mod audit;
pub mod buffer;
pub mod context_injection;
pub mod core_error;
pub mod core_event_bridge;
pub mod core_query;
pub mod engine_assembly;
pub mod engine_channels;
pub mod engine_handle;
pub mod engine_provider;
pub mod pricing;
pub mod run;
pub mod run_policy;
pub mod run_producer;
pub mod sched;
pub mod status_diagnostics;
pub mod stream_error_retry;
pub mod subagent_spawner;
pub mod task_event_consumer;
pub mod timers;
pub mod wait_channel;
pub mod wake_watcher;
pub mod wakeup_summary;
pub mod workflow;
