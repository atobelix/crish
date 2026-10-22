//! 动作执行与定位重试（维度 14）—— 原语层模块入口
//!
//! 职责边界（14 §1.1）：本模块只定义**执行原语层**；工具注册、审批接线、审计出站
//! 由维度 17（工具集与权限）负责，本模块在接口处标注对接点。
//!
//! ## 执行流水线（§2.2，T-8）
//! 顺序以本维度为准：**门禁 → 版本 → abort → 定位 → 派发 → 后置导航复核 → 审计**。
//! 令牌获取在工具层入口（协同层经 ToolContext，早于执行流水线，T-8），本流水线内
//! 的 abort 检查是**检查**而非获取；审计由维度 17 工具层 run_browser_action 第⑥步
//! 发射（M-4：本模块不自定义审计事件）。
//!
//! ## 重试状态机（§5，R-8/R-9/T-10）
//! VersionInvalid/NodeStale 等重试性错误计入 3 次总上限（MAX_ATTEMPTS，R-8）；
//! Aborted（用户接管吊销）与 ConnectionLost 的恢复后重试不计入额度；NodeStale
//! 3 次耗尽 → 「节点定位失败」升级提示（`ActionError::escalate`，T-10，升级接口点
//! 在维度 17 §2.2 审批链）。单动作总预算 `ACTION_TOTAL_TIMEOUT=120s`（T-9，含
//! 重试/等待/分块延迟，自 execute 起算，超时返回失败不再发起新一轮重试）。
//!
//! ## 安全面（R-5/R-6/R-7）
//! - 门禁：本模块只定义 `DomainGate` trait 引用（gate.rs），结构与匹配语义以维度
//!   17 §4 为唯一权威实现；未接线时返回「未接线」结构化错误（UnwiredGate）；
//! - wait_for 文本匹配：固定代码模板 + 参数 JSON 序列化注入（wait.rs，永不经字符串
//!   拼接进代码文本，R-5）；
//! - evaluate：仅接口引用维度 17 §3（evaluate.rs），MVP 返回「未接线」错误（R-6）。
//!
//! ## 测试面
//! CDP 交互经 `PageOps` trait 抽象（ops.rs），真实浏览器实现 `BrowserPageOps` 与
//! 确定性 mock（mocks.rs，cfg(test)）共用同一执行器；重试/超时/竞态全部 mock 测试，
//! 真实浏览器 e2e 留待联调（10 文档验收口径）。

pub mod evaluate;
pub mod gate;
pub mod keyboard;
pub mod locate;
pub mod ops;
pub mod pointer;
pub mod retry;
pub mod upload;
pub mod wait;

#[cfg(test)]
pub(crate) mod mocks;

pub use evaluate::EvaluateRequest;
pub use gate::{DomainGate, GateDenial};
pub use keyboard::KeySpec;
pub use locate::{Located, ResolvedPoint, ViewportSize};
pub use ops::{Delay, PageOps, TokioDelay};
pub use retry::{ActionOutcome, RetryDecision, RetryPolicy, RetryState, RetryStrategy};
pub use wait::{WaitCondition, WaitOptions};

use crate::cdp::version::TabId;
use std::time::Duration;

mod executor;
mod executor_retry;
mod primitives;
mod types;
mod validate;

pub use executor::ActionExecutor;
pub use types::{
    ActionError, ActionErrorKind, ActionOptions, ActionRequest, ActionSuccess, ElementMeta,
    ElementRef, MouseButton, PathBufLike, Primitive, ScrollDir, SnapshotStore,
};

/// 重试总上限（§5.3，R-8：VersionInvalid/NodeStale 等计入 3 次总上限）。
pub const MAX_ATTEMPTS: u32 = 3;
/// 单动作总预算（T-9：含全部重试、等待与分块延迟，自 execute 起算）。
pub const ACTION_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
/// type 分块大小（§4.1，50 字符/块）。
pub const TYPE_CHUNK_SIZE: usize = 50;
/// type 块间节流（§4.1，12ms）。
pub const TYPE_CHUNK_DELAY_MS: u64 = 12;
/// type 单次输入字符上限（参数校验护栏）。
pub const MAX_TYPE_CHARS: usize = 65_536;
/// NotInteractive 等待可见轮询上限（§5.1：首次 wait_for ≤2s）。
pub const NOT_INTERACTIVE_WAIT_MS: u32 = 2_000;
/// 导航竞态/目标关闭延迟（§5.4，300ms）。
pub const RETRY_DELAY_MS: u64 = 300;
/// ConnectionLost 恢复等待上限（R-9，维度 10 崩溃重启窗口）。
pub const CONNECTION_WAIT: Duration = Duration::from_secs(30);
/// 文件选择器事件等待上限（§9.1 4b，≤3s）。
pub const FILE_CHOOSER_WAIT: Duration = Duration::from_secs(3);
/// 滚动容器重取 box 循环上限（§3.2，最多 2 次后仍失败 → NotInteractive）。
pub const SCROLL_RETRIES: u32 = 2;

#[cfg(test)]
mod tests;
