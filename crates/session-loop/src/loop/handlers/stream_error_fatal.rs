//! 降级收场面（D1 §3.4：fatal 收场 + 压缩附注 + 分类人读文案）——
//! SR-06c · 拆分 · ≠ EL：自 stream_error.rs 拆出，公共面经父模 re-export。

use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentSessionEvent as E;

use super::super::super::end::{EndDecision, ProviderErrorSummary};
use super::super::{dispatch, HandlerOutcome, LoopState};
use super::super::super::LoopError;
/// 重试/恢复均失败 → PROVIDER_ERROR + endReason=error（01 §1.6 四事件）；
/// D1 §3.4：填充 terminal_provider_error（converge 移交 RunOutcome.provider_error，
/// D2/D3 恢复面消费）
pub(crate) fn fatal_provider_error(
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
    state.terminal_error = Some(format!(
        "provider 错误（{}）：{}{}",
        kind_str(classified.kind),
        classified.message,
        compression_fatal_note(state, classified.kind)
    ));
    // D1 §3.4：fatal 摘要填充（kind/retryable/retry_after_ms/retries 四元组；
    // retries = run 内实际重试次数——瞬态耗尽时 = 已重试数，熔断闸 fatal 时
    // = 0，非瞬态直接 fatal 时 = 0）
    state.terminal_provider_error = Some(ProviderErrorSummary {
        kind: classified.kind,
        retryable: classified.retryable,
        retry_after_ms: classified.retry_after_ms,
        retries: state.transient_retries,
    });
    // runtime-error 观测事件（retryable 只表「可重试」，与收场 reason 正交，01 §五.10）；
    // payload/上下文超限附注压缩阶梯诊断（P4 §3.5：压缩后仍超 = 单条消息
    // 过大或窗口过小；E2 F1 L3：LLM 摘要不可用未压缩；无压缩恢复路径时
    // 保留原说明）
    let compression_note = compression_fatal_note(state, classified.kind);
    state.events.push(AgentEvent::RuntimeError {
        session_id: state.machine.context().session_id.clone(),
        timestamp: crate::steering::now_iso_utc(),
        error: format!("{:?}: {}{}", classified.kind, classified.message, compression_note),
        retryable: Some(classified.retryable),
    });
    // PROVIDER_ERROR：streaming → turn-complete（endReason=error）
    dispatch(state, E::ProviderError)?;
    Ok(HandlerOutcome::end(EndDecision::error(
        state,
        state.terminal_error.clone().unwrap_or_default(),
    )))
}

/// fatal 诊断附注（P4 §3.5 / E2 F1 L3）：压缩阶梯用尽后仍超限时携带压缩后
/// token 数（压缩后仍超 = 单条消息过大或窗口过小）；LLM 摘要不可用未压缩
/// 时携带「LLM 不可用」附注（[LoopState::overflow_llm_unavailable]，E2 F1
/// L3 默认 fatal 的文案面）；未发生压缩时保留「无压缩恢复路径」说明
/// （T06.2.2 语义的缺省表述）。
fn compression_fatal_note(state: &LoopState, kind: ProviderErrorKind) -> String {
    // E2 F1 L3：溢出压缩因 LLM 摘要不可用而未压缩（优先级最高——
    // 未发生压缩，压缩后 token 附注无意义，无压缩恢复路径说明会让用户
    // 误以为压缩路径缺省未配置）
    if state.overflow_llm_unavailable {
        return "；LLM 不可用，溢出未压缩——直接终止（不再重试）".to_string();
    }
    let tokens_after = last_compression_tokens_after(state);
    match kind {
        ProviderErrorKind::PayloadTooLarge => match tokens_after {
            Some(tokens) => format!(
                "；payload 过大且压缩后（{tokens} token）仍超限，直接终止（不再重试）"
            ),
            None => "；payload 过大且无压缩恢复路径，直接终止（不再重试）".to_string(),
        },
        ProviderErrorKind::ContextLengthExceeded => match tokens_after {
            Some(tokens) => format!(
                "；压缩阶梯用尽后仍超限（压缩后 {tokens} token）——单条消息过大或窗口过小"
            ),
            None => String::new(),
        },
        _ => String::new(),
    }
}

/// 取最近一次压缩结束事件的压缩后 token 数（fatal 诊断用；只读事件列表，
/// 压缩发生在 fatal 前的阶梯内——本 run 事件已含 ContextCompressionEnd）
fn last_compression_tokens_after(state: &LoopState) -> Option<u64> {
    state.events.iter().rev().find_map(|e| match e {
        AgentEvent::ContextCompressionEnd { result: Some(record), .. } => {
            Some(record.tokens_after)
        }
        _ => None,
    })
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
