//! crish-agent-workbench 库目标（模块导出集线）
//!
//! 本包为 Tauri 应用（bin 目标 = `src/main.rs`，声明并装配全部模块）；
//! 本库目标承载可独立编译、独立测试的契约实现模块——引擎装配侧经
//! `crish_agent_workbench::<module>` 引用（bin 目标自动依赖同包 lib）。
//!
//! 模块登记（R-CF3 装配收口，T-CF-10）：
//! - [push]：push-core 推送决策引擎（R3-01，纯函数决策面：push_intent /
//!   去重 / 合并 / 静默 / 节流 + 13 场景登记；无 I/O）。发送与装配
//!   （R3-02 WS 直推 / R3-03 厂商通道）不在本模块。
//!
//! 注：wait_channel 与 core_event_bridge 原住本库，已随运行编排域下沉
//! `conex-run` crate（事件发射契约经 conex_run::core_event_bridge::Emitter
//! 注入，Tauri 实现在壳层 tauri_emitter.rs）；lib 目标经 Cargo 依赖
//! `conex-run` 直接消费。

pub mod multi_device;
pub mod push;
pub mod server;
