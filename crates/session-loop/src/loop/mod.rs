//! run 主循环（任务书 B3.4，对齐 01 §2.1 / §五.1-10）
//!
//! [AgentSessionLoop] 持有全部运行组件并驱动 8 个 handler：
//! - 状态机（[crate::state::AgentSessionMachine]，B3.1）；
//! - 三环输入队列（[crate::input::AgentInputQueue]，B3.2）；
//! - 控制总线 + 安全点（[crate::control::ControlBus] / [crate::safe_point]，B3.2）；
//! - steering 协调器（[crate::steering::SteeringCoordinator]，B3.3）；
//! - 工具执行器（[crate::tool_exec::ToolExecutor] + [agent_tools::registry::ToolRegistry]，
//!   B3.5）；
//! - 对话（[conex_types::message::AgentMessage] 列表，跨 run 持久）；
//! - provider 回调（[crate::provider::ProviderCall] trait 解耦，不直接依赖
//!   agent-provider；测试用 [crate::testing::TestProvider]）。
//!
//! run() 主循环（01 §2.1）：用户消息入队 → INITIALIZED → agent-start →
//! `while !done` 按当前状态分派 handler；任一 handler 返回 [EndDecision] 即收敛。
//! catch 兜底：handler 抛错 → 恢复钩子裁决（retry/skip/abort，01 §2.1 步骤 4）；
//! abort 类 → aborted，否则 error 收场。
//!
//! 收口决策（01 §五.2）：错误收场仅由 ERROR / PROVIDER_ERROR 产生
//! （INTERVENTION_REQUIRED / STEERING_BUDGET_EXHAUSTED 按 D7/D9 裁决收敛为
//! stop + 诊断）；cooperative_stop → stopped（D1）；max-turns 为独立预算
//! reason（01 §1.5）。
//!
//! SR-06c · 拆分 · ≠ EL：本文件为门面——模块接线 + 公共面 re-export +
//! 循环错误/恢复契约（LoopError / TurnEndContext / TurnEndHook /
//! RecoveryDecision / RecoveryHook）+ 常量；配置面
//! （[SessionLoopOptions] / [RetryBackoffConfig]）→ loop_options.rs；
//! 装配面（[AgentSessionLoop] 结构 + builder）→ loop_runner.rs；
//! run 控制面 → loop_exec.rs；测试旁挂 loop_tests.rs（`#[path]` 接线，
//! 无孤儿；crate::r#loop::* 路径不 break）。

/// 压缩编排面（C1a：预算钳制/估算/预检/边界/溢出触发 + LLM 守卫 +
/// apply_compaction，自 handlers/mod.rs 纯结构搬移；handlers 经
/// `pub(crate) use` 保留既有调用面）。
mod compaction_dispatch;
mod end;
mod handlers;
/// 分阶段总结（E2 F5）独立面：里程碑判定 + Schema 构造 + checkpoint
/// 载荷转换 + 终结摘要素材继承链 + 配置解析辅助。pub 导出——壳层
/// （core_run_commands.rs 触发/注入点）后续批次接线消费。
pub mod stage_summary;
/// 会话级摘要协调器（T-42，00-plan §6.5 R-I）：跨 run 单飞容器 +
/// 全局并发上限；注册表由壳层 CoreRunState 持有（与 SessionHistoryCache
/// 同生命周期）。pub 导出——壳层装配面（T-43/T-44）消费。
pub mod summary_coordinator;
/// 摘要后台调度（T-33，轮次 4）：run 内单飞面。pub 导出——会话级协调器
/// （T-42）与壳层回调接线（orchestrator 块表推进）消费同一任务类型面。
pub mod summary_dispatch;

#[path = "loop_exec.rs"]
mod exec;
#[path = "loop_options.rs"]
mod options;
#[path = "loop_runner.rs"]
mod runner;

#[cfg(test)]
mod invariants;

use async_trait::async_trait;
use conex_types::error::{codes, CrishError};
use conex_types::session::AgentSessionState;

pub use end::{EndDecision, RunOutcome};
pub use options::{RetryBackoffConfig, SessionLoopOptions};
pub use runner::AgentSessionLoop;

/// length 阶梯起点（8192 → 16384 → 32768，01 §2.6 步骤 1）
pub const DEFAULT_MAX_TOKENS: u32 = 8192;

/// 循环内部错误（catch 兜底输入；正常路径不触发）
///
/// T06.5.1（AA-01 Q29）：携带结构化 [CrishError]（77 码 + category/retryable），
/// 错误码/可重试性不再在 catch 兜底处丢失；`message` 保持人读文案。
#[derive(Debug, Clone)]
pub(crate) struct LoopError {
    /// 结构化错误（码 / category / retryable / message）
    crish: Box<CrishError>,
}

impl LoopError {
    /// 内部错误（状态机不一致等防御性路径）→ runtime.unexpected_state
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::with_code(codes::RUNTIME_UNEXPECTED_STATE, message)
    }

    /// 显式码构造（T06.5.1：错误码显式选择，不再裸 String 兜底）
    pub(crate) fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            crish: Box::new(CrishError::new(code, message)),
        }
    }

    /// 结构化错误引用（RecoveryHook::decide 输入，F6）
    pub(crate) fn crish(&self) -> &CrishError {
        &self.crish
    }

    /// 错误文案
    pub(crate) fn message(&self) -> &str {
        &self.crish.message
    }
}

/// lifecycle turn.end 钩子上下文
#[derive(Debug, Clone)]
pub struct TurnEndContext {
    /// 会话标识
    pub session_id: String,
    /// 当前轮次
    pub turn_index: u32,
    /// 当前轮工具调用数
    pub tool_call_count: u32,
}

/// lifecycle turn.end 钩子（01 §2.9 步骤 1：可返回 stop 建议）
///
/// 遗留问题 3：与 shouldStopAfterTurn 合并时以 turn.end 为准，
/// shouldStopAfterTurn 仅作无 turn.end 时的兼容层。
#[async_trait]
pub trait TurnEndHook: Send + Sync {
    /// 返回 true 表示建议 stop（cooperative，不 abort）
    fn on_turn_end(&self, context: &TurnEndContext) -> bool;
}

/// catch 兜底的恢复决策（01 §2.1 步骤 4：hook.onError 裁决 retry/skip/abort）
///
/// 缺省（无 hook 且未 abort）为 [RecoveryDecision::Fatal]——内部错误一律
/// error 收场，不得静默降级（F1-01）；`Skip`/`Retry` 仅允许恢复钩子显式
/// 裁决返回。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// 重试：NO_PROGRESS_CONTINUE 重进 provider 循环（仅 streaming 有效；
    /// 仅恢复钩子显式裁决）
    Retry,
    /// 跳过本轮：streaming 下按 NO_TOOL_CALLS 正常收场（仅恢复钩子显式
    /// 裁决——缺省不得走此路径，否则内部错误被静默降级，F1-01）
    Skip,
    /// 中止：endReason=aborted
    Abort,
    /// 致命：不经状态分派，直接 error 收场（缺省决策——不可恢复内部
    /// 错误必须暴露给用户，不派发 NO_TOOL_CALLS 降级为 stop 收场，F1-01）
    Fatal,
}

/// 错误恢复钩子（catch 兜底裁决；缺省：abort 信号 → Abort，否则 error 收场）
///
/// F6 冻结签名（AU-04）：`decide(&CrishError, state)`——恢复钩子基于码分类
/// 裁决而非文本匹配（T06.5.3）。
pub trait RecoveryHook: Send + Sync {
    /// 裁决错误处理方式
    fn decide(&self, error: &CrishError, state: AgentSessionState) -> RecoveryDecision;
}

#[cfg(test)]
mod tests {
    // 测试旁挂分两段（crate-size 门禁对 src 内每个文件限 600 行，故用
    // include! 合成单一 tests 模块——测试路径 loop::tests::* 不 break）
    include!("loop_tests.rs");
    include!("loop_tests_exec.rs");
}
