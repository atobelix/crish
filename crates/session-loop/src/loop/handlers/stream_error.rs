//! handleStreamError（01 §2.5：传输/服务端错误处理阶梯）
//!
//! 错误按分类进入恢复阶梯，**不误伤文字回复**（错误已在 streaming 分类层
//! 与模型输出分离，01 D5/D6）：
//! - 瞬态 provider 错误（02 §4.2 retryable：RateLimit / ServerError /
//!   Timeout / Network）：重试上限 3（默认），provider-diagnostic 事件 +
//!   NO_PROGRESS_CONTINUE（01 §2.5 步骤 2，上限可配置）；
//! - 长度/上下文超限（ContextLengthExceeded）：length 恢复阶梯
//!   8192→16384→32768，上限 2 次升级（01 §2.6 步骤 1 共用）；**阶梯用尽后
//!   接压缩阶梯**（P4 §3.5）——两个维度正交（输出预算 / 输入预算），
//!   都做了才覆盖两类超限；
//! - payload-too-large：**真实压缩阶梯**（P4 §3.5，代替 T06.2.2 删除的
//!   「假恢复」阶梯——请求体不变时重试必败；压缩对话后请求体真实变化，
//!   重试一次是真实恢复）；仍失败才 fatal（诊断含压缩后 token 数）；
//! - 其余（不可重试）：PROVIDER_ERROR + endReason=error（01 §1.6 四事件）。

use conex_compaction::CompactionEngine;
use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentSessionEvent as E;
use conex_types::tool::{
    ContextCompressionReason, ContextCompressionTrigger, ProviderDiagnostic,
    ProviderDiagnosticPhase,
};

use super::super::end::EndDecision;
use super::super::handlers::{
    apply_compaction, compaction_shape_ok, dispatch, CompactionTriggerInfo, HandlerOutcome,
    LoopState,
};
use super::super::LoopError;
use super::streaming::streaming_aborted;

/// 溢出压缩阶梯重试上限（P4 §3.5：压缩 + 重试一次；上限 1 防
/// 「压缩→仍超→再压缩」死循环，对齐 pi `_overflowRecoveryAttempted`，
/// pi-cache-analysis.md:225）
pub(crate) const MAX_OVERFLOW_COMPRESSION_RETRIES: u32 = 1;

/// length 阶梯升级次数上限（01 §2.6 步骤 1：8192→16384→32768，上限 2 次；
/// 配置 [SessionLoopOptions::length_upgrade_limit] 超过本上限按上限计——
/// F2-01：配置放大（如 30）不得让 max_tokens 继续翻倍，19 次后
/// 8192×2^19 溢出 u32::MAX（debug panic / release 回绕成小值退化））
pub(crate) const MAX_LENGTH_UPGRADES: u32 = 2;

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
        // 长度/上下文超限：length 恢复阶梯（8192→16384→32768，上限 2 次）；
        // 用尽后接压缩阶梯（P4 §3.5，输入超限维度——只放大输出预算对
        // 输入超限无效，comparison.md:24）
        ProviderErrorKind::ContextLengthExceeded => length_ladder(state, &classified).await,
        // payload 过大：压缩阶梯（P4 §3.5）——真实压缩 + 重试一次，
        // 代替 T06.2.2 的假恢复（请求体不变时重试必败）与直接 fatal
        ProviderErrorKind::PayloadTooLarge => compression_ladder(state, &classified).await,
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

/// length 恢复阶梯：max_tokens 翻倍升级（8192→16384→32768，上限 2 次）；
/// 用尽后接压缩阶梯（P4 §3.5）——输入超限维度，对齐 pi「溢出 → 压缩 →
/// 重试一次」
async fn length_ladder(state: &mut LoopState, classified: &ClassifiedStreamError) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——已取消不再发起 length 升级重试
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    let limit = state.options.length_upgrade_limit.min(MAX_LENGTH_UPGRADES);
    if state.length_upgrades < limit {
        state.length_upgrades += 1;
        // F2-01：saturating 翻倍（阶梯上限 2 使常规路径封顶 32768；
        // saturating 为防御纵深——内部计数异常时永不溢出回绕）
        state.max_tokens = state.max_tokens.saturating_mul(2);
        // 01 §3.3 ②：length 升级时重置 steering 计数
        state.steering.reset();
        emit_retry_diagnostic(state, classified, state.length_upgrades, limit);
        dispatch(state, E::NoProgressContinue)?;
        return Ok(HandlerOutcome::continue_run());
    }
    // length 阶梯用尽 → 压缩阶梯（P4 §3.5：压缩对话后重试一次，
    // compression_retries 上限 1；仍超限才 fatal）
    compression_ladder(state, classified).await
}

/// 溢出压缩阶梯（P4 §3.5，对齐 pi `_overflowRecoveryAttempted` 防死循环）：
/// 压缩对话 + 重试一次（[MAX_OVERFLOW_COMPRESSION_RETRIES] 上限 1）。
///
/// 入口：
/// - [ContextLengthExceeded]：length_ladder 用尽后进入（输入超限维度）；
/// - [PayloadTooLarge]：直接进入（物理载荷超限，压缩是真实恢复——请求体
///   经压缩后真实变化，重试不再是「假恢复」）。
///
/// 触发条件（全部满足才压缩，不满足直接 fatal）：
/// 1. 预算与压缩策略均已配置（None = 向后兼容现状——T06.2.2 的
///    PayloadTooLarge 直接 fatal 语义即此缺省路径）；
/// 2. `compression_retries < 1`（溢出只重试一次，防「压缩→仍超→再压缩」
///    死循环）；
/// 3. 本 run 压缩次数未达上限（[SessionLoopOptions::max_auto_compactions_per_run]，
///    与预检触发共用单 run 护栏，P4 §3.4.6；0 = 禁用自动压缩）。
///
/// 压缩动作复用 [apply_compaction]（trigger/reason=Overflow，事件广播 +
/// 时间戳护栏 + 单 run 计数）；目标预算 = window - reserve（与预检同一
/// 口径）。无合法切割点 / 无可丢内容（plan.dropped_ids 为空）时**不重试**
/// ——请求体未变，重试必再超（对齐 T06.2.2 删除假恢复的裁决）→ 直接 fatal。
async fn compression_ladder(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——已取消不再发起压缩重试
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    // 条件 2：溢出只重试一次（防死循环）
    if state.compression_retries >= MAX_OVERFLOW_COMPRESSION_RETRIES {
        return fatal_provider_error(state, classified);
    }
    // 条件 1：预算与压缩策略缺省（None，向后兼容现状）
    let Some(budget) = state.budget else {
        return fatal_provider_error(state, classified);
    };
    let Some(policy) = state.compaction_policy.clone() else {
        return fatal_provider_error(state, classified);
    };
    // 条件 3：单 run 压缩上限（预检与溢出触发共用计数，§3.4.6）
    if state.compactions_this_run >= state.options.max_auto_compactions_per_run {
        return fatal_provider_error(state, classified);
    }
    // 目标预算 = window - reserve（与预检触发同一口径，P4 §3.4.1 触发点 2）
    let budget_tokens = budget.context_window.saturating_sub(budget.reserve_tokens);
    let engine = CompactionEngine::new(0);
    let plan = engine.compact_agent_messages(
        &state.conversation,
        budget_tokens as usize,
        &policy,
        state.summarizer.as_deref(),
    );
    if plan.dropped_ids.is_empty() {
        // 无合法切割点 / 无可丢内容：不重试（请求体未变，重试必再超）
        return fatal_provider_error(state, classified);
    }
    // T-36 引擎兜底（评审 02 P1-7）：压缩产物的协议形状护栏——无 system
    // 且链后首条非 user → 跳过压缩 + warn（压缩后 wire 首条非 user →
    // provider 400；保持原请求体重试必再超 → 直接 fatal，语义与
    // dropped 为空路径一致）
    if !compaction_shape_ok(&plan.messages) {
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            "溢出压缩产物协议形状违规（无 system 且链后首条非 user）→ 跳过压缩（T-36 护栏）"
        );
        return fatal_provider_error(state, classified);
    }
    // 应用压缩（Overflow 触发；压缩是唯一前缀重写点 I1，事件广播 +
    // 时间戳护栏 + 单 run 计数在 apply_compaction 内完成）
    let info = CompactionTriggerInfo {
        trigger: ContextCompressionTrigger::Overflow,
        reason: ContextCompressionReason::Overflow,
    };
    apply_compaction(state, &plan, &info, Some(u64::from(budget_tokens))).await;
    state.compression_retries += 1;
    // T-35 注入卫生（debug 面）：压缩替换对话后复检——压缩是唯一前缀
    // 重写点，链消息与保留区不得携带时间线注入（注入只允许在对话末尾
    // user 消息）
    crate::r#loop::handlers::assert_timeline_injection_hygiene(&state.conversation);
    // 重试一次：NO_PROGRESS_CONTINUE 重进 provider 循环（对话已替换，
    // 下一次 build_request 携带压缩后序列 = 真实恢复）
    dispatch(state, E::NoProgressContinue)?;
    Ok(HandlerOutcome::continue_run())
}

// payload 假恢复阶梯已在 T06.2.2 / AA-01 Q05 删除：原实现只递增计数后
// NO_PROGRESS_CONTINUE 重进 provider 循环——请求体与 max_tokens 完全不变，
// 第二次必然再次 PayloadTooLarge，属「假恢复」。P4 §3.5（T-34）以**真实
// 压缩阶梯**恢复：压缩对话（请求体真实变化）后重试一次，受
// [MAX_OVERFLOW_COMPRESSION_RETRIES] 约束——不恢复旧的计数式假恢复。

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
    // payload/上下文超限附注压缩阶梯诊断（P4 §3.5：压缩后仍超 = 单条消息
    // 过大或窗口过小；无压缩恢复路径时保留原说明）
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

/// fatal 诊断附注（P4 §3.5）：压缩阶梯用尽后仍超限时携带压缩后 token 数
/// （压缩后仍超 = 单条消息过大或窗口过小）；未发生压缩时保留「无压缩恢复
/// 路径」说明（T06.2.2 语义的缺省表述）。
fn compression_fatal_note(state: &LoopState, kind: ProviderErrorKind) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::handlers::LoopState;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use crate::r#loop::{DEFAULT_MAX_TOKENS, SessionLoopOptions};
    use agent_tools::registry::ToolRegistry;
    use conex_compaction::CompactionPolicy;
    use conex_types::context::ContextBudget;
    use conex_types::error::ProviderErrorKind;
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use conex_types::response::ClassifiedStreamError;
    use conex_types::session::{AgentEndReason as R, AgentSessionEvent as E, AgentSessionState as S};
    use conex_types::tool::{ContextCompressionReason, ContextCompressionTrigger};
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

    /// 带预算/压缩策略的溢出恢复状态（窗口 1 万、阈值 = window - reserve
    /// = 8000；压缩策略 keep_recent_tokens 2000 / min_recent_turns 1，与
    /// handlers/mod.rs 单测同构）；对话 = 10 条 × 5000 字（≈ 5 万 token），
    /// 远超阈值且保留段之外有大量可丢内容
    fn budgeted_state() -> LoopState {
        let mut state = streaming_state();
        let options = SessionLoopOptions {
            context_budget: Some(ContextBudget {
                context_window: 10_000,
                reserve_tokens: 2_000,
                safety_tokens: 100,
            }),
            compaction_policy: Some(CompactionPolicy {
                keep_recent_tokens: 2_000,
                min_recent_turns: 1,
                ..Default::default()
            }),
            max_auto_compactions_per_run: 1,
            ..Default::default()
        };
        // LoopState 构造期从 options 派生 budget/policy——测试内直接改
        // options 需同步派生字段（生产路径经 with_options 派生）
        state.options = options.clone();
        state.budget = options.context_budget;
        state.compaction_policy = options.compaction_policy.clone();
        state.conversation = big_conversation();
        state
    }

    /// 超阈值对话：10 条消息 × 5000 字（CJK 逐字符 ≈ 5000 token）≈ 5 万 token
    fn big_conversation() -> Vec<Arc<AgentMessage>> {
        (0..10)
            .map(|i| {
                Arc::new(AgentMessage {
                    id: format!("m{i}"),
                    role: if i % 2 == 0 {
                        AgentMessageRole::User
                    } else {
                        AgentMessageRole::Assistant
                    },
                    created_at: "2026-08-03T10:00:00.000Z".to_string(),
                    blocks: vec![AgentMessageBlock::Text { text: "字".repeat(5_000) }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                })
            })
            .collect()
    }

    fn transient_error(kind: ProviderErrorKind) -> ClassifiedStreamError {
        ClassifiedStreamError {
            kind,
            message: format!("{kind:?} 模拟错误"),
            retryable: kind.default_retryable(),
            retry_after_ms: None,
        }
    }

    /// 模拟 NO_PROGRESS_CONTINUE 后循环重进 streaming（生产路径由
    /// prepare_turn::handle 步骤 6 的 TURN_PREPARED 转移完成；
    /// 测试驱动多次 handle 调用前必须回到 Streaming 状态）
    fn re_enter_streaming(state: &mut LoopState) {
        state.machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(state.machine.state(), S::Streaming);
    }

    /// 从事件列表取最近一次压缩记录（断言辅助）
    fn compression_record(state: &LoopState) -> Option<conex_types::tool::ContextCompressionRecord> {
        state.events.iter().rev().find_map(|e| match e {
            AgentEvent::ContextCompressionEnd { result: Some(record), .. } => Some(record.clone()),
            _ => None,
        })
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
        .await
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

    // ── T-34：溢出压缩阶梯（P4 §3.5）──

    /// PayloadTooLarge：压缩 + 重试一次（不再直接 fatal）——Overflow 触发
    /// 事件成对广播、对话替换（摘要占位 + 保留段）、护栏置位
    #[tokio::test]
    async fn payload_too_large_compresses_and_retries_once() {
        let mut state = budgeted_state();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        // 压缩后重试：不 fatal、继续 run（NO_PROGRESS_CONTINUE 重进准备）
        assert!(outcome.end.is_none(), "压缩后必须重试而非 fatal");
        assert_eq!(state.machine.state(), S::PreparingTurn);
        // 护栏：溢出重试计数 + 单 run 压缩计数 + 时间戳护栏
        assert_eq!(state.compression_retries, 1, "溢出压缩重试计数 = 1");
        assert_eq!(state.compactions_this_run, 1);
        assert!(state.last_compaction_at.is_some(), "压缩后时间戳护栏必须重置");
        // 事件：Overflow 触发成对广播
        let record = compression_record(&state).expect("必须广播压缩结束事件");
        assert_eq!(record.trigger, ContextCompressionTrigger::Overflow);
        assert_eq!(record.reason, Some(ContextCompressionReason::Overflow));
        let starts = state
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ContextCompressionStart { .. }))
            .count();
        assert_eq!(starts, 1);
        // 对话替换：摘要占位 + 保留段（压缩是唯一前缀重写点）
        assert!(
            state.conversation.iter().any(|m| m.id.starts_with("compacted-summary")),
            "压缩后对话必须含摘要占位消息"
        );
        assert!(state.conversation.len() < 10, "压缩后消息数必须减少");
    }

    /// PayloadTooLarge 压缩后重试仍超限 → fatal（压缩阶梯上限 1，
    /// 防「压缩→仍超→再压缩」死循环）；fatal 诊断含压缩后 token 数
    #[tokio::test]
    async fn payload_too_large_still_over_after_retry_goes_fatal() {
        let mut state = budgeted_state();
        // 第一次：压缩 + 重试
        handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert_eq!(state.compression_retries, 1);
        // 重试后循环重进 streaming（生产路径 prepare_turn TURN_PREPARED）
        re_enter_streaming(&mut state);
        // 第二次（重试后仍 PayloadTooLarge）：fatal，不再压缩
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "压缩后仍超限必须 fatal");
        assert_eq!(state.compression_retries, 1, "重试上限 1 不可再超");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.machine.state(), S::TurnComplete);
        // 诊断含压缩后 token 数（P4 §3.5：压缩后仍超 = 单条消息过大或窗口过小）
        let runtime_error = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("fatal 必须发 runtime-error 事件");
        assert!(
            runtime_error.contains("压缩后") && runtime_error.contains("仍超限"),
            "fatal 诊断应含压缩后 token 数：{runtime_error}"
        );
    }

    /// ContextLengthExceeded：length 阶梯（8192→16384→32768，上限 2 次）
    /// 用尽后接压缩阶梯——压缩 + 重试一次，仍超限才 fatal（P4 §3.5 验收：
    /// 第三次直接 fatal 前，压缩只发生一次、compression_retries ≤ 1）
    #[tokio::test]
    async fn context_length_uses_length_ladder_then_compresses_then_fatals() {
        let mut state = budgeted_state();
        // 第一次：length 升级（1/2）
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.length_upgrades, 1);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 2);
        // 升级后重进 streaming（生产路径 prepare_turn TURN_PREPARED）
        re_enter_streaming(&mut state);
        // 第二次：length 升级（2/2）
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o2.end.is_none());
        assert_eq!(state.length_upgrades, 2);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 4);
        re_enter_streaming(&mut state);
        // 第三次：length 用尽 → 压缩阶梯（输入超限维度）→ 压缩 + 重试
        let o3 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o3.end.is_none(), "length 用尽后必须走压缩阶梯而非 fatal");
        assert_eq!(state.compression_retries, 1);
        assert_eq!(state.compactions_this_run, 1);
        let record = compression_record(&state).expect("压缩阶梯必须广播结束事件");
        assert_eq!(record.trigger, ContextCompressionTrigger::Overflow);
        // 压缩重试后循环重进 streaming
        re_enter_streaming(&mut state);
        // 第四次：压缩后仍超限 → fatal（压缩阶梯上限 1，不再次压缩）
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.compression_retries, 1, "compression_retries ≤ 1");
        assert_eq!(state.compactions_this_run, 1, "不得再次压缩");
    }

    /// 缺省配置（无预算 / 无压缩策略）：PayloadTooLarge 保持「直接 fatal」
    /// 语义（向后兼容现状；T06.2.2 的无压缩恢复路径说明保留）
    #[tokio::test]
    async fn payload_too_large_without_config_goes_fatal() {
        let mut state = streaming_state();
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.compression_retries, 0, "缺省配置不消耗压缩重试计数");
        let runtime_error = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::RuntimeError { error, .. } => Some(error.clone()),
                _ => None,
            })
            .expect("fatal 必须发 runtime-error 事件");
        assert!(
            runtime_error.contains("无压缩恢复路径"),
            "缺省配置诊断应保留无压缩恢复路径说明：{runtime_error}"
        );
    }

    /// 无可丢内容（对话在预算内 → 压缩为 noop）：不重试直接 fatal
    /// （请求体未变，重试必再超——对齐 T06.2.2 删除假恢复的裁决）
    #[tokio::test]
    async fn noop_compaction_does_not_fake_retry() {
        let mut state = budgeted_state();
        state.conversation = vec![Arc::new(AgentMessage {
            id: "m0".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text { text: "短消息".to_string() }],
            metadata: None,
            client_message_id: None,
            content: None,
        })];
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "无可丢内容不得假恢复（直接 fatal）");
        assert_eq!(state.compression_retries, 0, "noop 压缩不消耗重试计数");
        assert_eq!(state.compactions_this_run, 0);
        assert!(
            state.events.iter().all(|e| !matches!(e, AgentEvent::ContextCompressionEnd { .. })),
            "noop 压缩不得广播压缩事件"
        );
    }

    /// 单 run 压缩上限护栏：预检已用掉本 run 唯一一次压缩 →
    /// PayloadTooLarge 不再压缩，直接 fatal（预检与溢出触发共用计数，§3.4.6）
    #[tokio::test]
    async fn overflow_compaction_respects_run_limit() {
        let mut state = budgeted_state();
        state.compactions_this_run = 1; // 模拟预检已压缩
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_some(), "单 run 上限用尽后溢出不再压缩");
        assert_eq!(state.compression_retries, 0);
    }

    /// F2-01（红→绿）：length 阶梯配置放大溢出防护——length_upgrade_limit
    /// 配置为 30 时有效上限仍为 2 次（8192→16384→32768，01 §2.6 上限 2），
    /// 第三次 ContextLengthExceeded 不得继续翻倍（修复前按配置 30 翻倍：
    /// 第 3 次升级 max_tokens=65536 且无收场，红；19 次后 8192×2^19 溢出
    /// u32::MAX——debug panic / release 回绕成小值退化）
    #[tokio::test]
    async fn length_ladder_caps_upgrades_even_with_huge_limit() {
        let mut state = streaming_state();
        state.options.length_upgrade_limit = 30;
        // 第一次：升级（1/2）
        let o1 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.length_upgrades, 1);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 2);
        re_enter_streaming(&mut state);
        // 第二次：升级（2/2）
        let o2 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(o2.end.is_none());
        assert_eq!(state.length_upgrades, 2);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 4);
        re_enter_streaming(&mut state);
        // 第三次：配置 30 也按阶梯上限 2 计——不再翻倍（进入压缩阶梯，
        // 无预算配置 → fatal 收场）
        let o3 = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(
            o3.end.is_some(),
            "length_upgrade_limit=30 不得触发第 3 次 length 升级（阶梯上限 2，红）"
        );
        assert_eq!(state.length_upgrades, 2, "升级计数必须停在 2");
        assert_eq!(
            state.max_tokens,
            DEFAULT_MAX_TOKENS * 4,
            "max_tokens 不得超出 32768 阶梯上限"
        );
    }

    /// F2-01 防御性饱和（绿锚点）：即便绕过上限（内部计数异常），
    /// max_tokens 翻倍也永不溢出——saturating_mul 保语义
    #[tokio::test]
    async fn max_tokens_doubling_saturates_never_overflow() {
        let mut state = streaming_state();
        state.max_tokens = u32::MAX - 1;
        state.options.length_upgrade_limit = 1;
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::ContextLengthExceeded))
            .await
            .unwrap();
        assert!(outcome.end.is_none());
        assert_eq!(state.max_tokens, u32::MAX, "saturating_mul 后必须饱和保持");
    }

    /// I4 补充（C14）：溢出压缩阶梯同样经 Summarizer trait 边界——
    /// 摘要器只收到丢弃消息（无 session_id / 无缓存键 / 无 tools / 无
    /// system 参数；trait 签名即隔离保证），Schema V1 JSON 文档的 md
    /// 渲染进入事件载荷（R-G 新契约：非 JSON 输出一律降级 stub）
    // G2 允许理由（clippy::type_complexity）：测试局部嵌套类型
    // （RecordingSummarizer 回调签名含 Arc<Mutex<Vec<(Vec<String>,
    // Option<String>)>>>），类型由被测接口依赖链自然形成，定义别名可缓解
    // 但改动扩散大、豁免面小。
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn overflow_compaction_uses_summarizer_without_affinity() {
        use std::sync::Mutex;
        struct RecordingSummarizer {
            calls: Arc<Mutex<Vec<(Vec<String>, Option<String>)>>>,
        }
        impl conex_compaction::Summarizer for RecordingSummarizer {
            fn summarize(
                &self,
                dropped: &[AgentMessage],
                existing: Option<&str>,
            ) -> Result<String, String> {
                self.calls.lock().unwrap().push((
                    dropped.iter().map(|m| m.id.clone()).collect(),
                    existing.map(str::to_string),
                ));
                // 合法 Schema V1 JSON 文档（R-G 契约）
                Ok(serde_json::json!({
                    "schemaVersion": 1,
                    "blockId": "compacted-summary-1-1",
                    "generation": 1,
                    "droppedIds": [],
                    "height": 1,
                    "tier": "chunk",
                    "goal": "溢出恢复",
                    "constraints": [],
                    "progress": ["已压缩上下文"],
                    "decisions": [],
                    "nextSteps": ["重试请求"],
                    "criticalContext": ["context length exceeded"],
                })
                .to_string())
            }
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let summarizer = Arc::new(RecordingSummarizer { calls: calls.clone() });
        let mut state = budgeted_state();
        state.summarizer = Some(summarizer.clone());
        let outcome = handle(&mut state, transient_error(ProviderErrorKind::PayloadTooLarge))
            .await
            .unwrap();
        assert!(outcome.end.is_none(), "L2 摘要路径压缩必须完成并重试");
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "摘要器只调用一次");
        let (dropped_ids, existing) = &recorded[0];
        assert!(existing.is_none(), "首次压缩无既有摘要");
        assert!(!dropped_ids.is_empty(), "摘要器收到被丢弃消息");
        assert!(
            dropped_ids.iter().all(|id| id.starts_with('m')),
            "摘要器只收到消息 id（无会话/缓存亲和参数）"
        );
        // 事件载荷摘要 = Schema V1 JSON 文档的 md 渲染（R-G 语源唯一）
        let summary = compression_record(&state)
            .map(|r| r.summary)
            .expect("必须有记录");
        assert!(
            summary.contains("## Goal") && summary.contains("溢出恢复"),
            "事件摘要 = JSON 文档的 markdown 渲染：{summary}"
        );
        assert!(
            !summary.starts_with("[Compacted"),
            "同步成功路径不得降级 stub：{summary}"
        );
    }
}
