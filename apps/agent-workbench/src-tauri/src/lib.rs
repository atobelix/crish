//! crish-agent-workbench 库目标（模块导出集线）
//!
//! 本包为 Tauri 应用（bin 目标 = `src/main.rs`，声明并装配全部模块）；
//! 本库目标承载可独立编译、独立测试的契约实现模块——引擎装配侧经
//! `crish_agent_workbench::<module>` 引用（bin 目标自动依赖同包 lib）。
//!
//! 模块登记（R-CF3 装配收口，T-CF-10）：
//! - [wait_channel]：SubagentWaitChannel 引擎侧实现（dispatch_* 落库 /
//!   session_agents 快照 / subagent-ended 事件流等待 / L1 steer 注入），
//!   引擎装配（engine.rs）只读消费其契约与适配器。
//! - [push]：push-core 推送决策引擎（R3-01，纯函数决策面：push_intent /
//!   去重 / 合并 / 静默 / 节流 + 13 场景登记；无 I/O）。发送与装配
//!   （R3-02 WS 直推 / R3-03 厂商通道）不在本模块。

pub mod push;
pub mod wait_channel;
