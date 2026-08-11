//! run 结束决策收敛（B3.4，对齐 01 §五.2：单一收口类型）
//!
//! 主循环任一 handler 收敛后以 [EndDecision] 统一收口，经
//! [crate::r#loop::AgentSessionLoop::run] 的 converge 步骤产出 [RunOutcome]。
//!
//! 错误收场唯一性（01 §1.6 / §五.2）：`reason = Error` 仅由
//! ERROR / PROVIDER_ERROR 两条路径产生（经本层收敛）；INTERVENTION_REQUIRED
//! 与 STEERING_BUDGET_EXHAUSTED 按裁决（01 D7/D9、00 D6）**不以 error 收场**，
//! 收敛为 stop + 诊断字段（事件照发，供 UI 展示）。
//!
//! D1（cooperative_stop）：协作停止收敛为独立 reason `Stopped`，既不是
//! 错误也不是取消（safe_point 的 [crate::safe_point::ControlAction] 语义）。

use conex_types::error::ProviderErrorKind;
use conex_types::events::RunCacheStats;
use conex_types::message::AgentMessage;
use conex_types::session::AgentEndReason;
use std::sync::Arc;

use super::handlers::LoopState;

/// provider 错误摘要（D1 §3.4：fatal 收场时由 [super::handlers::stream_error::fatal_provider_error]
/// 填充 [super::handlers::LoopState::terminal_provider_error]，converge 时零拷贝移交
/// [RunOutcome::provider_error]；D2 续 run / D3 RunFailureContext 消费，
/// 00 总纲 §6 契约表 D1→D2/D3）
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ProviderErrorSummary {
    /// 分类 13 类（kebab-case，conex-types/error.rs:866-895）
    pub kind: ProviderErrorKind,
    /// 是否可重试（default_retryable 真源，error.rs:899-908）
    pub retryable: bool,
    /// 429 Retry-After（透传；其余分类恒 None）
    pub retry_after_ms: Option<u64>,
    /// run 内实际重试次数（= LoopState.transient_retries，02 D8 双语义中的 run 内面）
    pub retries: u32,
}

/// 单一收口决策（01 §五.2：`{reason, error?}` + 诊断字段）
#[derive(Debug, Clone, PartialEq)]
pub struct EndDecision {
    /// 收场 reason（stop / max-turns / aborted / stopped / error）
    pub reason: AgentEndReason,
    /// error 收场时的错误文案（其余 reason 为 None）
    pub error: Option<String>,
    /// 诊断说明（intervention / steering 预算耗尽等非错误收场的可观测信息，
    /// 01 §五.10；对应 TS 端 runtime-intervention-required 的 message）
    pub diagnostic: Option<String>,
    /// 收场时的轮次（观测字段）
    pub turn_index: u32,
    /// 收场时的工具调用数（观测字段）
    pub tool_call_count: u32,
    /// 收场时的 steering 计数（观测字段，coordinator 单一计数源）
    pub steering_count: usize,
}

impl EndDecision {
    /// 从当前状态快照构建决策（统一填充观测字段）
    pub(crate) fn new(
        reason: AgentEndReason,
        error: Option<String>,
        diagnostic: Option<String>,
        state: &LoopState,
    ) -> Self {
        Self {
            reason,
            error,
            diagnostic,
            turn_index: state.machine.context().turn_index,
            tool_call_count: state.machine.context().tool_call_count,
            steering_count: state.steering.get_steering_count(),
        }
    }

    /// 正常 stop 收场（纯文字回复 / SHOULD_STOP / NO_INPUT / FINISH 等）
    pub(crate) fn stop(state: &LoopState) -> Self {
        Self::new(AgentEndReason::Stop, None, None, state)
    }

    /// stop + 诊断收场（intervention / steering 预算耗尽，D7/D9 裁决）
    pub(crate) fn stop_with_diagnostic(state: &LoopState, diagnostic: impl Into<String>) -> Self {
        Self::new(AgentEndReason::Stop, None, Some(diagnostic.into()), state)
    }

    /// 协作停止收场（D1：独立 reason，不 abort）
    pub(crate) fn stopped(state: &LoopState) -> Self {
        Self::new(AgentEndReason::Stopped, None, None, state)
    }

    /// 用户中止收场（ABORT / L3 force_cancel / AbortSignal）
    pub(crate) fn aborted(state: &LoopState) -> Self {
        Self::new(AgentEndReason::Aborted, None, None, state)
    }

    /// 用户中止收场 + 取消原因透出（T06.4.3 / T06.3 Q02）。
    ///
    /// L3 force_cancel 的 reason 经 diagnostic 字段承载，随
    /// [RunOutcome::diagnostic] 透出——abort 原因不再丢失（原
    /// LoopState.abort_reason 只写不读已删除）。
    pub(crate) fn aborted_with_diagnostic(state: &LoopState, reason: Option<String>) -> Self {
        Self::new(AgentEndReason::Aborted, None, reason, state)
    }

    /// 错误收场（仅 ERROR / PROVIDER_ERROR 两条路径，01 §1.6）
    pub(crate) fn error(state: &LoopState, message: impl Into<String>) -> Self {
        Self::new(AgentEndReason::Error, Some(message.into()), None, state)
    }

    /// max-turns 预算收场（独立 reason，非错误非中止，01 §1.5）
    pub(crate) fn max_turns(state: &LoopState) -> Self {
        Self::new(AgentEndReason::MaxTurns, None, None, state)
    }
}

/// run 结果（run 主循环的产出，01 §2.1：agent-end 含 reason、可选 error；
/// 消息列表为会话最终状态）
#[derive(Debug, Clone, PartialEq)]
pub struct RunOutcome {
    /// 收场 reason
    pub reason: AgentEndReason,
    /// 错误文案（error 收场时）
    pub error: Option<String>,
    /// 诊断说明（非错误收场的可观测信息，01 §五.10）
    pub diagnostic: Option<String>,
    /// 会话最终消息列表（含用户 / 助手 / 工具结果 / steering 注入消息；
    /// Arc 共享形态，PE-09 T09.3.2/3：收口 `mem::take` 零拷贝移交，载荷与
    /// message-start/end 事件共享同一份内存——调用方如需 owned 形态
    /// 逐个 `as_ref().clone()`）
    pub messages: Vec<Arc<AgentMessage>>,
    /// 本次 run 的全部事件（agent-start … agent-end，01 §五.6 序列契约）
    pub events: Vec<conex_types::events::AgentEvent>,
    /// 收场时的轮次
    pub turn_index: u32,
    /// 收场时的工具调用数
    pub tool_call_count: u32,
    /// 收场时的 steering 计数
    pub steering_count: usize,
    /// 缓存统计（P5 S2 / T-36）：tracker.finish() 产物——run 内多 turn usage
    /// 聚合 + 浪费审计累计（missed_tokens）+ 缓存温暖截止（warm_until_ms）；
    /// 未配置缓存测量或无可测 usage 时为 None（缺省 None，向后兼容；
    /// T-40 消费本字段发 cache-stats-updated 事件与落库 runs 表）
    pub cache_stats: Option<RunCacheStats>,
    /// provider 错误摘要（D1 §3.4：fatal 收场时填充；正常 stop / 非
    /// provider 错误收场为 None——熔断计数判定（S2 收口）与 D2/D3 恢复面
    /// 消费，00 总纲 §6 契约表）
    pub provider_error: Option<ProviderErrorSummary>,
}
