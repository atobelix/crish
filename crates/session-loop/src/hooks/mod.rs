//! 插件钩子运行时（对齐 packages/shared-types/src/hooks.ts 事件面）
//!
//! 职责：Rust 侧 hook 注册/分派机制——[HookRegistry] 广播事件给注册的
//! handler，失败策略对齐 plugin-sdk 的 `HookFailStrategy` 类型语义
//! （'swallow' | 'log' | 'propagate'）。
//!
//! 事件面（I8-E1 扩展，I7-M13 事件映射表冻结）：
//! - 第一批（6 映射）：session.start / session.end / turn.start / turn.end /
//!   tool.pre / tool.post；
//! - 第二批（8 钩子）：tool.error / context.compact.start / context.compact.end /
//!   error.occurred / model.beforeRequest / model.afterResponse /
//!   subagent.start / subagent.end（model.* 与 subagent.* 只挂钩不补源，
//!   事件源由 02 方案 M14/M7 承接——本注册表提供变体与载荷，发射点
//!   由宿主/编排层接线）。
//!
//! 双模式语义（03 生态插件方案 §2.4 冻结表）：
//! - observe = 广播（现有 dispatch 语义）：handler 失败按注册 failStrategy
//!   处置；Block 控制信号忽略（观察者不拦截执行）；
//! - on = 串行 + 控制信号：Block 在 tool.pre 上阻止执行、在 turn.end 上
//!   建议 stop（其余事件按观察忽略并记录）；handler 失败按 failStrategy 处置。
//!
//! matcher 过滤（§2.5，kimi 借鉴）：tool.pre / tool.post / tool.error 的注册
//! 描述附 `matcher`（工具名正则，默认全量匹配）；dispatch 时对 tool_name
//! 做正则匹配，不匹配的条目跳过；其余事件忽略 matcher；非法正则注册即拒。
//!
//! timeout 竞速窗口（§2.4/§3.5）：注册条目可带 timeout_ms，dispatch 内
//! handler 调用包 `tokio::time::timeout`，超时 = 虚拟失败按 failStrategy
//! 处置；tool.pre 超时固定降级放行（kimi runner.ts:117 语义，守门者不可用
//! 放行优先）。handler 失败（超时/Err）除按策略处置外，统一再广播
//! `error.occurred` 诊断事件（错误事件化，opencode publishPluginError 语义）。
//!
//! 接线决策（docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md +
//! 03 生态插件方案 §2.1 映射表）：
//! - turn.end：`loop/handlers/turn_complete.rs` 步骤 4.5；
//! - tool.pre / tool.post / tool.error：`tool_exec.rs::ToolExecutor::execute_single`
//!   内，与 ToolMiddleware 链共享同一点位；
//! - session.start / session.end / error.occurred / turn.start /
//!   context.compact.*：`loop/mod.rs` run 入口 / converge / apply_recovery /
//!   `loop/handlers/prepare_turn.rs` / `loop/handlers/mod.rs` apply_compaction；
//! - RecoveryHook（F6 冻结签名）**不并入**事件分派：同步裁决语义
//!   （Retry/Skip/Abort）保持原接口。
//!
//! 失败策略语义（propagate 不中断会话）：
//! - tool.pre 的 propagate 失败 → 该工具调用以执行失败结果收场，批继续；
//! - turn.end 的 propagate 失败 → 记录日志后收场流程继续。
//!
//! hook-outcome 观测镜像（D-03 EV-05，2026-08-14 契约窗口）：
//! - dispatch 单点聚合：HookRegistry 可经 [HookRegistry::set_outcome_sink]
//!   接线观测出口，dispatch 出口处每批次发射一次 `AgentEvent::HookOutcome`
//!   （Delta 级，可丢）；未接线 = 无观测事件，dispatch 语义完全不变。
//! - 聚合载荷：hook 种类（event.kind）+ 结果（ok/blocked/failed/timeout，
//!   blocked 带原因）+ 触发 handler 名；turn.end 的 Block（stop 建议）同样
//!   以 outcome=blocked 表达。
//! - model.beforeRequest/afterResponse、subagent.start/end 四变体：本层
//!   「只挂钩不补源」（M14/M7 由宿主/编排层接线）；dispatch 单点对任意
//!   HookEventKind 通用，宿主接线后自动发射 hook-outcome，本层不硬造
//!   生产发射点。

pub mod dispatch;
pub mod registry;
pub mod types;

pub use registry::HookRegistry;
pub use types::*;

#[cfg(test)]
mod tests;
