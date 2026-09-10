//! 引擎装配层门面（SR-04 拆分：provider 装配 / audit 审计 / channels 通道 /
//! build 构建四面落位于同目录子模 + 测试外置 engine_tests.rs）
//!
//! 本文件仅做 mod 接线 + `pub(crate) use ...::*` re-export（公开 API 保持，
//! 调用方路径零改动）；实现与测试见子模：
//! - [engine_provider]：客户端/请求构建 + [HttpProviderCall] 适配层 +
//!   增量流状态机；
//! - [engine_audit]：[RoutingAuditSink] 路由审计 + [WaitDispatchStore] 桥；
//! - [engine_channels]：[ContinuityChannelBoard] 通道板卡 + Summarizer
//!   工厂 + [BufferedRunEventBridge] / [BridgeDeltaSink] 事件桥；
//! - [engine_build]：[EngineHandle] 装配 + [SessionLoopProducer] run 生产者
//!   + 缓存测量 + M1 上下文注入通道；
//! - 测试旁挂 `engine_tests.rs`（`#[path]` 接线，无孤儿）。
//!
//! 模块职责（B6.4 第 3 点：main.rs setup 重写的引擎面）：
//! - [EngineHandle]：provider 生效配置（baseUrl/model/apiKey 三件套，
//!   25-ipc-contract-audit.md:101）+ 工具注册表 + `engineReady`；
//! - [HttpProviderCall]：[session_loop::provider::ProviderCall] 的真实适配层
//!   ——chat-completions 请求体同步构建（返回流前完成序列化，PE-02 §3.1.1），
//!   增量帧流逐帧解析、逐事件产出（T09.1.2 步骤 2，unfold 状态机）；
//! - [SessionLoopProducer]：每 run 重建 [AgentSessionLoop]（PE-09 §4：
//!   真实接线跨 run 重建语义），装配 options / approval / delta_sink；
//! - [BufferedRunEventBridge]：[crate::core_event_bridge::EventBridge] +
//!   [crate::buffer::EventBuffer] 背压组装（入队时序列化，flush 直接发射，
//!   AA-06 P9）；
//! - [BridgeDeltaSink]：T09.1 实时轨 [session_loop::DeltaSink] 桥——信封
//!   `{event, runId: Some, sequence: None}` → 缓冲 → 立即 flush（丢帧由
//!   buffer 的 Delta 类目兜底，message-end 必达）。
//!
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分不关任何 EL；仅搬移不改语义；
//! 生产段 into_inner 已 B1-5 观测化（error! 成对 + 计数；测试段不观测），
//! S2/S3 另行）。

// B1-5 接线修正：子模以 `#[path]` 显式接线（同目录旁挂，对齐
// note_commands.rs 先例）——rustc 2018+ 对非根模块文件只解析
// 目录式子模块路径（`engine/engine_audit.rs`），旁挂文件必须 #[path]
#[path = "engine_audit.rs"]
mod engine_audit;
#[path = "engine_build.rs"]
mod engine_build;
#[path = "engine_channels.rs"]
mod engine_channels;
#[path = "engine_provider.rs"]
pub(crate) mod engine_provider;

#[cfg(test)]
pub(crate) use engine_audit::*;
pub(crate) use engine_build::*;
pub(crate) use engine_channels::*;
pub(crate) use engine_provider::*;

// ── 测试（SR-04 外置；engine_tests.rs 旁挂，`#[path]` 接线，无孤儿）──

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
