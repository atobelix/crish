//! handleStreamError（01 §2.5：传输/服务端错误处理阶梯）
//!
//! 错误按分类进入恢复阶梯，**不误伤文字回复**（错误已在 streaming 分类层
//! 与模型输出分离，01 D5/D6）：
//! - 瞬态 provider 错误（02 §4.2 retryable：RateLimit / ServerError /
//!   Timeout / Network）：重试上限 3（默认），provider-diagnostic 事件 +
//!   NO_PROGRESS_CONTINUE（01 §2.5 步骤 2，上限可配置）；
//! - 长度/上下文超限（ContextLengthExceeded）：length 恢复阶梯
//!   8192→16384→32768，上限 2 次升级（01 §2.6 步骤 1 共用）；
//! - payload-too-large：**直接 fatal**（T06.2.2 删除假恢复阶梯——请求体与
//!   max_tokens 均不变时重试必然再次 PayloadTooLarge；真实压缩
//!   （scrubImagesOldestFirst）落地时恢复本阶梯）；
//! - 其余（不可重试）：PROVIDER_ERROR + endReason=error（01 §1.6 四事件）。

use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentSessionEvent as E;
use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};

use super::super::end::EndDecision;
use super::super::handlers::{dispatch, HandlerOutcome, LoopState};
use super::super::LoopError;
use super::streaming::streaming_aborted;

/// stream error handler（01 §2.5）
pub(crate) async fn handle(
    state: &mut LoopState,
    classified: ClassifiedStreamError,
) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：重试决策前先查 abort，取消则跳过剩余阶梯直接收场
    // （与 streaming 的 abort 收场路径共享，避免无效请求。AA-01 Q40）
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    tracing::info!(
        kind = ?classified.kind,
        error_code = %classified.kind.code(),
        retryable = classified.retryable,
        "provider 流错误"
    );
    match classified.kind {
        // 瞬态 provider 错误：重试阶梯（01 §2.5 步骤 2）
        ProviderErrorKind::RateLimit
        | ProviderErrorKind::ServerError
        | ProviderErrorKind::Timeout
        | ProviderErrorKind::Network => transient_retry(state, &classified),
        // 长度/上下文超限：length 恢复阶梯（8192→16384→32768，上限 2 次）
        ProviderErrorKind::ContextLengthExceeded => length_ladder(state, &classified),
        // payload 过大：直接 fatal（T06.2.2 / AA-01 Q05——假恢复阶梯已删除：
        // 请求体与 max_tokens 不变时重试必败，白耗请求延迟；真实压缩能力
        // 落地（scrubImagesOldestFirst）时恢复本阶梯）
        ProviderErrorKind::PayloadTooLarge => fatal_provider_error(state, &classified),
        // 其余（Auth / Quota / InvalidRequest / Unknown / Aborted 等）：不可重试
        _ => fatal_provider_error(state, &classified),
    }
}

/// 瞬态重试：上限内 NO_PROGRESS_CONTINUE 重进 provider 循环
fn transient_retry(state: &mut LoopState, classified: &ClassifiedStreamError) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——重试间隙用户取消则跳过剩余阶梯
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    let limit = state.options.transient_retry_limit;
    if state.transient_retries < limit {
        state.transient_retries += 1;
        tracing::info!(attempt = state.transient_retries, limit, "瞬态错误重试");
        emit_retry_diagnostic(state, classified, state.transient_retries, limit);
        dispatch(state, E::NoProgressContinue)?;
        return Ok(HandlerOutcome::continue_run());
    }
    fatal_provider_error(state, classified)
}

/// length 恢复阶梯：max_tokens 翻倍升级（8192→16384→32768，上限 2 次）
fn length_ladder(state: &mut LoopState, classified: &ClassifiedStreamError) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——已取消不再发起 length 升级重试
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    let limit = state.options.length_upgrade_limit;
    if state.length_upgrades < limit {
        state.length_upgrades += 1;
        state.max_tokens *= 2;
        // 01 §3.3 ②：length 升级时重置 steering 计数
        state.steering.reset();
        emit_retry_diagnostic(state, classified, state.length_upgrades, limit);
        dispatch(state, E::NoProgressContinue)?;
        return Ok(HandlerOutcome::continue_run());
    }
    fatal_provider_error(state, classified)
}

// payload 恢复阶梯已删除（T06.2.2 / AA-01 Q05）：原实现只递增计数后
// NO_PROGRESS_CONTINUE 重进 provider 循环——请求体与 max_tokens 完全不变，
// 第二次必然再次 PayloadTooLarge，属「假恢复」。现由 handle() 对
// PayloadTooLarge 直接走 fatal_provider_error；未来落地真实压缩
// （scrubImagesOldestFirst / 消息裁剪）后恢复本阶梯。

/// 重试诊断事件（provider-diagnostic，phase=retry）
fn emit_retry_diagnostic(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
    attempt: u32,
    max_attempts: u32,
) {
    let session_id = state.machine.context().session_id.clone();
    state.events.push(AgentEvent::ProviderDiagnostic {
        session_id,
        timestamp: crate::steering::now_iso_utc(),
        diagnostic: ProviderDiagnostic {
            phase: ProviderDiagnosticPhase::Retry,
            attempt: Some(attempt),
            max_attempts: Some(max_attempts),
            reason: Some(format!("{:?}", classified.kind)),
            error_kind: Some(classified.kind),
            retryable: Some(classified.retryable),
            ..ProviderDiagnostic::default()
        },
    });
}

/// 重试/恢复均失败 → PROVIDER_ERROR + endReason=error（01 §1.6 四事件）
fn fatal_provider_error(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
) -> Result<HandlerOutcome, LoopError> {
    // 错误日志（T04.3-3）：provider 流错误按类型化错误码记录
    // （ProviderErrorKind.code() → 77 码；run span 内携带会话/运行上下文）
    tracing::error!(
        target: "provider",
        event = "provider_error",
        error_kind = ?classified.kind,
        error_code = %classified.kind.code(),
        retryable = classified.retryable,
        error = %classified.message,
        "provider 错误收场（重试/恢复均失败）"
    );
    state.terminal_error = Some(format!("provider 错误（{}）：{}", kind_str(classified.kind), classified.message));
    // runtime-error 观测事件（retryable 只表「可重试」，与收场 reason 正交，01 §五.10）；
    // payload-too-large 附注「无压缩恢复路径直接终止」（T06.2.2，假恢复阶梯已删除）
    let payload_note = if classified.kind == ProviderErrorKind::PayloadTooLarge {
        "；payload 过大且无压缩恢复路径，直接终止（不再重试）"
    } else {
        ""
    };
    state.events.push(AgentEvent::RuntimeError {
        session_id: state.machine.context().session_id.clone(),
        timestamp: crate::steering::now_iso_utc(),
        error: format!("{:?}: {}{}", classified.kind, classified.message, payload_note),
        retryable: Some(classified.retryable),
    });
    // PROVIDER_ERROR：streaming → turn-complete（endReason=error）
    dispatch(state, E::ProviderError)?;
    Ok(HandlerOutcome::end(EndDecision::error(
        state,
        state.terminal_error.clone().unwrap_or_default(),
    )))
}

/// 分类 → 人读文案（诊断用）
fn kind_str(kind: ProviderErrorKind) -> &'static str {
    match kind {
        ProviderErrorKind::Aborted => "aborted",
        ProviderErrorKind::PayloadTooLarge => "payload-too-large",
        ProviderErrorKind::GatewayChallenge => "gateway-challenge",
        ProviderErrorKind::Auth => "auth",
        ProviderErrorKind::Quota => "quota",
        ProviderErrorKind::EndpointUnavailable => "endpoint-unavailable",
        ProviderErrorKind::ContextLengthExceeded => "context-length-exceeded",
        ProviderErrorKind::InvalidRequest => "invalid-request",
        ProviderErrorKind::RateLimit => "rate-limit",
        ProviderErrorKind::ServerError => "server-error",
        ProviderErrorKind::Timeout => "timeout",
        ProviderErrorKind::Network => "network",
        ProviderErrorKind::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::handlers::LoopState;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use crate::r#loop::SessionLoopOptions;
    use agent_tools::registry::ToolRegistry;
    use conex_types::error::ProviderErrorKind;
    use conex_types::response::ClassifiedStreamError;
    use conex_types::session::{AgentEndReason as R, AgentSessionEvent as E, AgentSessionState as S};
    use std::sync::Arc;

    /// 构造处于 streaming 状态的 LoopState（供重试阶梯单测驱动）
    fn streaming_state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let mut state = LoopState::new(
            "sess-1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        );
        state.machine.dispatch(E::Initialized).unwrap();
        state.machine.dispatch(E::InputReady).unwrap();
        state.machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(state.machine.state(), S::Streaming);
        state
    }

    fn transient_error(kind: ProviderErrorKind) -> ClassifiedStreamError {
        ClassifiedStreamError {
            kind,
            message: format!("{kind:?} 模拟错误"),
            retryable: kind.default_retryable(),
            retry_after_ms: None,
        }
    }

    /// Q40（T09.9）：重试阶梯入口 abort → 跳过剩余阶梯直接收场——
    /// 不消耗重试计数、不发重试诊断、不派发 NO_PROGRESS_CONTINUE
    #[tokio::test]
    async fn abort_at_ladder_entry_skips_retry_and_closes_out() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::RateLimit))
            .await
            .unwrap();
        // 不重试：重试计数零消耗、无 retry 诊断事件
        assert_eq!(state.transient_retries, 0, "abort 后不得消耗重试计数");
        assert_eq!(state.length_upgrades, 0, "abort 后不得消耗 length 计数");
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "abort 后不得发重试诊断"
        );
        // 收场共享 streaming 的 abort 决策路径：aborted 收场
        assert!(outcome.end.is_some(), "应直接收场而非继续 run");
        assert_eq!(state.machine.state(), S::TurnComplete);
        assert_eq!(state.machine.context().end_reason, R::Aborted);
    }

    /// Q40（T09.9）：瞬态重试每级决策前查 abort——梯级内 abort 同样直接收场
    #[tokio::test]
    async fn abort_at_transient_level_skips_remaining_ladder() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = transient_retry(&mut state, &transient_error(ProviderErrorKind::ServerError))
            .expect("瞬态重试为同步决策");
        assert_eq!(state.transient_retries, 0, "梯级内 abort 不消耗计数");
        assert!(outcome.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted);
    }

    /// Q40（T09.9）：length 恢复阶梯每级决策前查 abort——已取消不再升级重试
    #[tokio::test]
    async fn abort_at_length_level_skips_upgrade() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = length_ladder(
            &mut state,
            &transient_error(ProviderErrorKind::ContextLengthExceeded),
        )
        .expect("length 阶梯为同步决策");
        assert_eq!(state.length_upgrades, 0, "abort 后不升级 max_tokens");
        assert_eq!(state.max_tokens, crate::r#loop::DEFAULT_MAX_TOKENS);
        assert!(outcome.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted);
    }

    /// 对照：未 abort 时阶梯照常派发 NO_PROGRESS_CONTINUE（行为不回归）
    #[tokio::test]
    async fn retry_ladder_still_dispatches_without_abort() {
        let mut state = streaming_state();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::RateLimit))
            .await
            .unwrap();
        assert!(outcome.end.is_none(), "未 abort 应继续 run");
        assert_eq!(state.transient_retries, 1, "重试计数递增");
        assert_eq!(state.machine.state(), S::PreparingTurn, "NO_PROGRESS_CONTINUE 重进准备");
        // 重试诊断事件照发
        assert!(
            state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "重试诊断照发"
        );
    }
}
