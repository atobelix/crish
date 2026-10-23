//! wait_subagents 工具与三模式调度等待（I5-M8：C8 三模式等待）
//!
//! 定位（docs/multi-agent-repair/improvement/02-多Agent调度实现方案.md M8；
//! 需求真源 04-Agent功能需求设计.md §2 C8）：
//! - 等待原语工具化（02 Top 7）：主 agent 的等待经工具调用而非引擎阻塞——
//!   wait_subagents 单次返回、主 agent 串起后续行动（yield 语义，pi 借鉴，
//!   ref-analysis 01 B2）；快照返回不重放全量；
//! - 三模式（04 C8 §2.1）：await-all（等全部终态再规划）/ timer（到点返回
//!   未完成列表，未完成任务保持运行）/ parallel-work（立即返回，主 agent
//!   转入并行工作）；
//! - timeout 硬上限 10 分钟（对齐 grok cap，02 §5.4；超限参数报错）；
//! - 事件驱动等待：工具内部异步等待子代理终态事件（subagent-ended 消费点，
//!   优先事件而非轮询）——[wait_for_terminal_events] 原语即该语义载体；
//! - dispatch_* session_meta：调度模式声明持久化（await-all/timer 参数 +
//!   已分发子代理清单），重启后恢复「等待什么」；
//! - G02 完成通知（outputFiles，T-EG-10）：终态载荷附带子代理产出文件
//!   清单（path/summary/bytes，方案 §4.6），来源为 write_claims 持有者
//!   记录（引擎强制，不依赖 AI 自觉）；dispatch_outputs 键承载持久化
//!   副本，旧数据 parse 容错（对齐 explore_quota.rs:70-88）；
//! - 运行中注入（04 C8 §2.2）：wait 期间主 agent 可向子代理注入提示词，
//!   经目标 run 的 L1 steer 环（session-loop control.rs 的
//!   request_subagent_inject，transfer 语义）——注入不打断子代理执行。
//!
//! 接线契约（对齐 I4-M2 subagent.rs）：agent-tools 是叶子 crate，生产代码
//! 不依赖 conex-db / orchestrator——session_meta 持久化与终态事件流接入在
//! 引擎侧实现 [SubagentWaitChannel]，本模块只定义契约、纯逻辑与工具本身。
//! 测试域以 conex-db（dev-dependency）验证 dispatch_* 落库与重启恢复链路。
//!
//! 结构（SR-06a-3 · 拆分 · ≠ EL）：本文件为薄门面，按逻辑域拆 3 个子模：
//! - `wait_defs`：定义与结果聚合域（三模式枚举/常量/dispatch_* 键/状态与
//!   结果类型/产出文件收集（G02）/调度声明/错误/等待通道契约）；
//! - `wait_events`：事件驱动等待域（终态事件信封 [SubagentTerminalEvent] +
//!   [wait_for_terminal_events] 原语）；
//! - `wait_tool`：工具域（[WaitSubagentsTool] + Tool 实现）；
//!
//! 测试外置 `wait_subagents_tests.rs`（`#[path]` 旁挂，无孤儿）；
//! 公开 API 经本文件 `pub use` 保持不 break（tools/mod.rs 注册不变）。
//!
//! 诚实边界：仅结构拆分，等待/收束语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

// ==================== 拆分接线（SR-06a-3 · 结构拆分 · ≠ EL）====================
//
// 本文件为薄门面：全部实现按逻辑域拆入三个子模块（扁平文件必须 #[path]
// 显式接线，吸取 SR-06d 教训）：
//   wait_defs（定义与结果聚合域：类型 / 常量 / 契约 / 产出收集）
//   wait_events（事件驱动等待域：终态事件信封 + 等待原语）
//   wait_tool（工具域：WaitSubagentsTool + Tool 实现）
// 测试整体外置 wait_subagents_tests.rs（#[path] 接线，零删除）。
// 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。
#[path = "wait_defs.rs"]
mod wait_defs;
#[path = "wait_events.rs"]
mod wait_events;
#[path = "wait_tool.rs"]
mod wait_tool;

pub use wait_defs::{
    collect_subagent_output_files, dispatch_outputs_value, parse_dispatch_outputs,
    DispatchDeclaration, SubagentOutput, SubagentWaitChannel, SubagentWaitError,
    SubagentWaitResult, SubagentWaitStatus, WaitMode, DEFAULT_TIMER_WAIT_MS,
    DISPATCH_META_KEY_AGENTS, DISPATCH_META_KEY_DISPATCHED_AT, DISPATCH_META_KEY_MODE,
    DISPATCH_META_KEY_OUTPUTS, DISPATCH_META_KEY_WAIT_MS, MAX_WAIT_TIMEOUT_MS,
};
pub use wait_events::{wait_for_terminal_events, SubagentTerminalEvent};
pub(crate) use wait_tool::WaitSubagentsTool;

// ── 测试（SR-06a-3 外置；`#[path]` 旁挂，无孤儿）───────────────────

#[cfg(test)]
#[path = "wait_subagents_tests/mod.rs"]
mod tests;
