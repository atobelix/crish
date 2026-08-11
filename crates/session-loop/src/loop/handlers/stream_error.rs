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

use std::time::Duration;

use conex_compaction::CompactionEngine;
use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentSessionEvent as E;
use conex_types::tool::{
    ContextCompressionReason, ContextCompressionTrigger, ProviderDiagnostic,
    ProviderDiagnosticPhase,
};

use super::super::end::{EndDecision, ProviderErrorSummary};
use super::super::handlers::{
    apply_compaction, compaction_shape_ok, dispatch, CompactionTriggerInfo, HandlerOutcome,
    LoopState,
};
use super::super::{LoopError, RetryBackoffConfig};
use super::streaming::streaming_aborted;

/// 首次退避基数（D1 §3.1.1，镜像 agent-provider retry.rs:48 /
/// orchestrator recovery.rs:116；测试锁定防漂移）
pub(crate) const RETRY_BACKOFF_BASE_MS: u64 = 750;
/// 单次等待上限（5xx/Timeout/Network 类，镜像 retry.rs:49 / recovery.rs:118）
pub(crate) const RETRY_MAX_DELAY_MS: u64 = 8_000;
/// 429 Retry-After 放行上限（= MAX_RETRY_AFTER_MS，retry.rs:29：5 分钟；
/// 裁决 #3：429 突破 8s 封顶，由预算闸兜底）
pub(crate) const RETRY_RATE_LIMIT_MAX_DELAY_MS: u64 = 5 * 60_000;
/// 总重试预算（镜像 retry.rs:50 / recovery.rs:120；elapsed >= 预算停止，
/// 严格小于——对齐 retry.rs:163-166 withinRetryBudget）
pub(crate) const RETRY_TOTAL_BUDGET_MS: u64 = 60_000;
/// 熔断阈值（D1 §3.2 规则 C1：provider_fail_streak >= 6 即熔断触发，
/// 跳过 run 内重试直接 fatal；01 敲定 裁决 #6）
pub(crate) const PROVIDER_FAIL_THRESHOLD: u32 = 6;

/// 计算本次重试等待（D1 §3.1.2，纯函数可单测；镜像 retry.rs
/// choose_retry_delay_ms + withinRetryBudget）
///
/// 规则（裁决 #3 + 04 §2.2）：
/// - 预算闸：`elapsed >= total_budget` → 返回 None（不再等待，直接 fatal，
///   不消耗重试次数——对齐 retry.rs:163-166 严格小于）；
/// - 指数退避：`base * 2^(attempt-1)`（指数上限 62 防溢出，saturating）；
/// - 429（RateLimit）必须消费 Retry-After：`wait = max(退避, retry_after)`，
///   钳到 `min(5min, 剩余预算)`——突破 8s 封顶（裁决 #3）；
/// - 其余（5xx/Timeout/Network）纯退避，钳到 `min(8s, 剩余预算)`
///   （分类器只对 429 解析 Retry-After，error.rs:248-251 只 429，
///   故非 429 携带 retry_after 时经 8s 上限自然等价于不消费）；
/// - 最终再钳剩余预算（60s 总预算 - 已用墙钟）。
fn retry_delay_ms(
    cfg: &RetryBackoffConfig,
    kind: ProviderErrorKind,
    attempt: u32,
    retry_after_ms: Option<u64>,
    elapsed_ms: u64,
) -> Option<Duration> {
    let base = cfg.base_ms.unwrap_or(RETRY_BACKOFF_BASE_MS);
    let total_budget = cfg.total_budget_ms.unwrap_or(RETRY_TOTAL_BUDGET_MS);
    // 预算闸：elapsed >= 预算 → 不再等待（严格小于，对齐 withinRetryBudget）
    if elapsed_ms >= total_budget {
        return None;
    }
    let remaining = total_budget - elapsed_ms;
    // 指数退避（镜像 retry.rs:107-112：min(max_delay, base * 2^(attempt-1))，
    // 指数上限 62 防溢出）
    let exponent = (attempt.max(1) - 1).min(62);
    let backoff = base.saturating_mul(1u64 << exponent);
    let cap = match kind {
        // 429 放行到 5 分钟（裁决 #3，突破 8s 封顶）
        ProviderErrorKind::RateLimit => RETRY_RATE_LIMIT_MAX_DELAY_MS,
        _ => cfg.max_ms.unwrap_or(RETRY_MAX_DELAY_MS),
    };
    let wait = match retry_after_ms {
        Some(after) => backoff.max(after), // Retry-After 与退避取大（镜像 retry.rs:124-127）
        None => backoff,
    };
    Some(Duration::from_millis(wait.min(cap).min(remaining)))
}

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
        // 瞬态 provider 错误：重试阶梯（01 §2.5 步骤 2；D1：退避 + 预算 +
        // Retry-After + 熔断闸）
        ProviderErrorKind::RateLimit
        | ProviderErrorKind::ServerError
        | ProviderErrorKind::Timeout
        | ProviderErrorKind::Network => transient_retry(state, &classified).await,
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

/// 瞬态重试（D1 §3.1：async 退避 + Retry-After + 60s 预算 + abort 竞速 +
/// 熔断闸；01 §2.5 步骤 2 的 NO_PROGRESS_CONTINUE 重进 provider 循环）
///
/// 决策顺序（Q40 + D1 规则汇总 R1-R6）：
/// 1. abort 复查（Q40，每级决策前）；
/// 2. 熔断闸（规则 C1）：`provider_fail_streak >= 阈值` → 跳过 run 内重试
///    直接 fatal（熔断期不烧 run 内配额，selection-01 分歧 9 采纳 04 闸面）；
/// 3. 次数上限内：预算起点惰性初始化 → 计算等待 → abort 竞速 sleep
///    （biased，abort 优先）→ sleep 后复查 abort → 计数 +1 → 发诊断 →
///    NO_PROGRESS_CONTINUE；
/// 4. 预算耗尽 / 次数用尽 → fatal_provider_error（不消耗次数）。
async fn transient_retry(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——重试间隙用户取消则跳过剩余阶梯
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    // ── 熔断闸（D1 §3.2 规则 C1）：streak ≥ 阈值 → 跳过 run 内重试直接 fatal ──
    // （壳层读 session_meta 键 provider_fail_streak 注入；None = 未配置熔断
    // 不启用，向后兼容现状）
    if state
        .options
        .provider_fail_streak
        .is_some_and(|s| s >= PROVIDER_FAIL_THRESHOLD)
    {
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            streak = ?state.options.provider_fail_streak,
            threshold = PROVIDER_FAIL_THRESHOLD,
            "熔断触发：跳过 run 内重试直接 fatal（观测面 runtime-error，熔断计数由壳层收口维护）"
        );
        return fatal_provider_error(state, classified);
    }
    let limit = state.options.transient_retry_limit;
    if state.transient_retries < limit {
        // 预算起点惰性初始化（规则 R1：首次瞬态错误时；fresh run 归零，
        // loop/mod.rs run 起始同批）
        let started_at = *state
            .transient_retry_started_at
            .get_or_insert_with(tokio::time::Instant::now);
        let elapsed_ms = started_at.elapsed().as_millis() as u64;
        let attempt = state.transient_retries + 1;
        // 等待计算：注入延迟面（测试专用）→ 退避配置（生产）→ None 配置 =
        // 现状立即重试（规则 R6，向后兼容）
        let delay = match &state.retry_delay {
            Some(f) => f(attempt, classified.retry_after_ms),
            None => match state.options.retry_backoff {
                Some(cfg) => match retry_delay_ms(&cfg, classified.kind, attempt, classified.retry_after_ms, elapsed_ms) {
                    Some(d) => d,
                    // 预算耗尽（规则 R3/R4）：不进重试直接 fatal，不消耗次数
                    None => return fatal_provider_error(state, classified),
                },
                // retry_backoff = None：现状立即重试（无退避、无预算、无 sleep）
                None => Duration::ZERO,
            },
        };
        if !delay.is_zero() {
            // abort 竞速 sleep（规则 R5：abort 优先，biased；语义对齐
            // retry.rs TokioSleeper retry.rs:316-323）——abort 不消耗计数、
            // 不发诊断（零通知零噪声）
            tokio::select! {
                biased;
                _ = state.abort_signal.wait_aborted() => return streaming_aborted(state),
                _ = tokio::time::sleep(delay) => {}
            }
            // sleep 后复查 abort（竞速窗口收口）
            if state.abort_signal.is_aborted() {
                return streaming_aborted(state);
            }
        }
        state.transient_retries += 1;
        tracing::info!(attempt = state.transient_retries, limit, delay_ms = delay.as_millis(), "瞬态错误重试");
        // 重试诊断（D1 §3.1.5，用户约束 A/C）：phase=Retry 事件兼作临时
        // 通知数据源（前端老虎机滚动 1/N→N/N）；不进对话上下文、AI 不可见
        emit_retry_diagnostic(state, classified, state.transient_retries, limit, delay, classified.retry_after_ms);
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
        // length 阶梯无退避等待（立即升级重进 provider 循环，delay=0）
        emit_retry_diagnostic(state, classified, state.length_upgrades, limit, Duration::ZERO, None);
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

/// 重试诊断事件（provider-diagnostic，phase=Retry；D1 §3.1.5 扩展：
/// 载荷附本次实际等待与 Retry-After 透传——临时通知数据源，前端老虎机
/// 滚动展示重连进度（如 1/6→2/6）；不进对话上下文、AI 不可见，约束 A/C）
///
/// 字段承载（D1 D8 动态决策）：ProviderDiagnostic 无 delay_ms 字段且
/// 文件域冻结（不扩 conex-types），经既有 `elapsed_ms` 字段承载本次实际
/// 等待时长（phase=Retry 语义下为 delay_ms；全仓无既有消费方冲突）；
/// `retry_after_ms` 直接透传（既有字段）。
fn emit_retry_diagnostic(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
    attempt: u32,
    max_attempts: u32,
    delay: Duration,
    retry_after_ms: Option<u64>,
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
            // D1：本次实际等待时长（delay_ms 语义，经既有 elapsed_ms 承载）
            elapsed_ms: Some(delay.as_millis() as u64),
            retry_after_ms,
            ..ProviderDiagnostic::default()
        },
    });
}

/// 重试/恢复均失败 → PROVIDER_ERROR + endReason=error（01 §1.6 四事件）；
/// D1 §3.4：填充 terminal_provider_error（converge 移交 RunOutcome.provider_error，
/// D2/D3 恢复面消费）
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
    use crate::r#loop::{DEFAULT_MAX_TOKENS, RetryBackoffConfig, SessionLoopOptions};
    use agent_tools::registry::ToolRegistry;
    use conex_compaction::CompactionPolicy;
    use conex_test_utils::clock::TimePauseGuard;
    use conex_types::context::ContextBudget;
    use conex_types::error::ProviderErrorKind;
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use conex_types::response::ClassifiedStreamError;
    use conex_types::session::{AgentEndReason as R, AgentSessionEvent as E, AgentSessionState as S};
    use conex_types::tool::{ContextCompressionReason, ContextCompressionTrigger};
    use futures::poll;
    use std::sync::Arc;
    use std::time::Duration;

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

    /// D1：开启默认退避配置（750/8000/60000）的 streaming 状态
    /// （[SessionLoopOptions::retry_backoff] = Some(默认)——生产退避语义的
    /// 单测驱动面；None = 现状立即重试由既有测试覆盖）
    fn backoff_state() -> LoopState {
        let mut state = streaming_state();
        state.options.retry_backoff = Some(RetryBackoffConfig::default());
        state
    }

    /// D1：429 + Retry-After 的已分类错误（裁决 #3 主场景）
    fn rate_limit_error(retry_after_ms: u64) -> ClassifiedStreamError {
        ClassifiedStreamError {
            kind: ProviderErrorKind::RateLimit,
            message: "429 限流".to_string(),
            retryable: true,
            retry_after_ms: Some(retry_after_ms),
        }
    }

    /// 从事件列表取最近一次重试诊断（断言辅助）
    fn retry_diagnostic(state: &LoopState) -> Option<conex_types::tool::ProviderDiagnostic> {
        state.events.iter().rev().find_map(|e| match e {
            AgentEvent::ProviderDiagnostic { diagnostic, .. } => Some(diagnostic.clone()),
            _ => None,
        })
    }

    // ── D1 退避/预算/Retry-After/abort 竞速/熔断闸（维度 D1 §5.1 T1-T8）──

    /// D1 T6：retry_delay_ms 纯函数决策表——退避序列 750/1500/3000、
    /// 429 放行 5min、5xx 钳 8s、Retry-After 取大、预算耗尽 None、
    /// 指数上限 62 防溢出（镜像 retry.rs:503-514 期望值防漂移）
    #[test]
    fn retry_delay_ms_decision_table() {
        let cfg = RetryBackoffConfig::default();
        // 退避序列：ServerError 无 Retry-After → 750/1500/3000/6000/8000（8s 封顶）
        let expected = [750u64, 1500, 3000, 6000, 8000, 8000];
        for (index, expected_ms) in expected.iter().enumerate() {
            let attempt = index as u32 + 1;
            let delay = retry_delay_ms(
                &cfg,
                ProviderErrorKind::ServerError,
                attempt,
                None,
                0,
            )
            .expect("预算充足必须返回等待");
            assert_eq!(
                delay,
                Duration::from_millis(*expected_ms),
                "attempt {attempt} 退避序列"
            );
        }
        // 429：Retry-After 30s → 等待 = max(750, 30000) = 30s（不被 8s 钳制，裁决 #3）
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(30_000), 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(30_000), "429+Retry-After 取大");
        // 429 无 Retry-After：纯退避 750
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(750));
        // 429 上限 5min：大退避指数下被钳制——60s 总预算下剩余钳制
        // （min(5min, 60s 剩余) = 60s，预算闸兜底）
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 13, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(
            delay,
            Duration::from_millis(60_000),
            "60s 总预算下 429 被剩余预算钳制（预算闸兜底 5min 放行）"
        );
        // 5xx 上限 8s：大指数下被 8s 钳制
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::ServerError, 13, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(8_000), "5xx 钳到 8s 上限");
        // Retry-After 超 5min：钳到 min(5min, 剩余预算)（60s 预算下 = 60s）
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(10 * 60_000), 0)
            .expect("预算充足必须返回等待");
        assert_eq!(
            delay,
            Duration::from_millis(60_000),
            "Retry-After 不得突破 5min 上限（预算闸下先钳 60s）"
        );
        // 429 5min 上限可观测面：放大预算（>5min）后 429 钳到 5min 而非
        // 继续放大（裁决 #3 字面：429 突破 8s 封顶放行到 5min）
        let big_budget = RetryBackoffConfig {
            base_ms: None,
            max_ms: None,
            total_budget_ms: Some(400_000),
        };
        let delay = retry_delay_ms(&big_budget, ProviderErrorKind::RateLimit, 13, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(
            delay,
            Duration::from_millis(5 * 60_000),
            "429 钳到 5min 上限（预算放大后可观测）"
        );
        // 预算钳制：elapsed 40s（剩余 20s）+ Retry-After 30s → 钳到 20s
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(30_000), 40_000)
            .expect("预算未耗尽必须返回等待");
        assert_eq!(delay, Duration::from_millis(20_000), "剩余预算钳制");
        // 预算耗尽：elapsed >= 60s → None（严格小于，对齐 retry.rs:163-166）
        assert!(retry_delay_ms(&cfg, ProviderErrorKind::ServerError, 1, None, 60_000).is_none());
        assert!(retry_delay_ms(&cfg, ProviderErrorKind::RateLimit, 1, Some(30_000), 60_000).is_none());
        // 指数上限 62 防溢出：attempt 63 → exponent 62 → saturating 不 panic
        let delay = retry_delay_ms(&cfg, ProviderErrorKind::ServerError, 63, None, 0)
            .expect("预算充足必须返回等待");
        assert_eq!(delay, Duration::from_millis(8_000), "指数上限 62 后仍钳 8s");
        // 自定义配置生效：base=100 → 退避 100/200/400；budget=1000 → 预算钳制
        let custom = RetryBackoffConfig {
            base_ms: Some(100),
            max_ms: Some(500),
            total_budget_ms: Some(1_000),
        };
        assert_eq!(
            retry_delay_ms(&custom, ProviderErrorKind::ServerError, 1, None, 0).unwrap(),
            Duration::from_millis(100)
        );
        assert_eq!(
            retry_delay_ms(&custom, ProviderErrorKind::ServerError, 4, None, 0).unwrap(),
            Duration::from_millis(500),
            "自定义 max 钳制"
        );
        assert_eq!(
            retry_delay_ms(&custom, ProviderErrorKind::ServerError, 1, None, 950).unwrap(),
            Duration::from_millis(50),
            "自定义预算剩余钳制"
        );
        assert!(retry_delay_ms(&custom, ProviderErrorKind::ServerError, 1, None, 1_000).is_none());
    }

    /// D1 T1（A1）：退避序列 750/1500/3000（虚拟时钟驱动，零真实等待）——
    /// ServerError 无 Retry-After；每次 handle 间的墙钟推进 = 750/1500/3000；
    /// 诊断事件 elapsed_ms 与等待一致（镜像 retry.rs:503-514 期望值）
    #[tokio::test]
    async fn backoff_sequence_750_1500_3000_virtual_clock() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 第 1 次：等待 750ms（推进 749ms 不完成，第 750ms 完成）
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending(), "首 poll 后应进入退避 sleep");
        tokio::time::advance(Duration::from_millis(749)).await;
        assert!(poll!(fut.as_mut()).is_pending(), "749ms 未到 750ms 不得重试");
        tokio::time::advance(Duration::from_millis(1)).await;
        let o1 = fut.await.unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.transient_retries, 1);
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(750)),
            "第 1 次诊断等待 = 750ms"
        );
        re_enter_streaming(&mut state);
        // 第 2 次：等待 1500ms
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(1_499)).await;
        assert!(poll!(fut.as_mut()).is_pending(), "1499ms 未到 1500ms 不得重试");
        tokio::time::advance(Duration::from_millis(1)).await;
        let o2 = fut.await.unwrap();
        assert!(o2.end.is_none());
        assert_eq!(state.transient_retries, 2);
        assert_eq!(retry_diagnostic(&state).map(|d| d.elapsed_ms), Some(Some(1_500)));
        re_enter_streaming(&mut state);
        // 第 3 次：等待 3000ms
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(2_999)).await;
        assert!(poll!(fut.as_mut()).is_pending(), "2999ms 未到 3000ms 不得重试");
        tokio::time::advance(Duration::from_millis(1)).await;
        let o3 = fut.await.unwrap();
        assert!(o3.end.is_none());
        assert_eq!(state.transient_retries, 3);
        assert_eq!(retry_diagnostic(&state).map(|d| d.elapsed_ms), Some(Some(3_000)));
        re_enter_streaming(&mut state);
        // 第 4 次：次数用尽（limit=3）→ fatal，不进入退避
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.transient_retries, 3);
        // provider_error 摘要：retries = 3
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::ServerError);
        assert!(p.retryable);
        assert_eq!(p.retries, 3);
    }

    /// D1 T2（A2）：mock 429 + Retry-After=30s → 等待 ≥30s（不被 8s 钳制）——
    /// advance(29s) 断言不重试（无 NO_PROGRESS_CONTINUE），advance(1s) 后重试；
    /// 等待 = max(750, 30000) = 30s（裁决 #3）
    #[tokio::test]
    async fn rate_limit_retry_after_waits_at_least_30s() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        let mut fut = Box::pin(handle(&mut state, rate_limit_error(30_000)));
        assert!(poll!(fut.as_mut()).is_pending(), "首 poll 后应进入 Retry-After sleep");
        // 29s：不得重试（30s 未到；若被 8s 钳制此处已完成，红）
        tokio::time::advance(Duration::from_millis(29_000)).await;
        assert!(
            poll!(fut.as_mut()).is_pending(),
            "429+Retry-After=30s 不得被 8s 钳制（29s 时不得重试）"
        );
        // 第 30s：重试发生
        tokio::time::advance(Duration::from_millis(1_000)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_none(), "30s 后必须重试而非 fatal");
        assert_eq!(state.transient_retries, 1);
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(30_000)),
            "诊断等待 = 30s"
        );
        assert_eq!(
            retry_diagnostic(&state).and_then(|d| d.retry_after_ms),
            Some(30_000),
            "诊断透传 Retry-After"
        );
    }

    /// D1 T3（A3）：429 重试的等待被预算钳制——第一次等 30s、第二次钳到
    /// 剩余 30s、第三次前预算耗尽（elapsed >= 60s）→ 不进重试直接 fatal
    /// （endReason=Error，不消耗次数；04 §4.1「不无限尊重服务端再来一次」）
    #[tokio::test]
    async fn rate_limit_budget_clamp_exhausts_before_third_retry() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 第一次：等 30s（累计 0→30s）
        let mut fut = Box::pin(handle(&mut state, rate_limit_error(30_000)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(30_000)).await;
        let o1 = fut.await.unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.transient_retries, 1);
        re_enter_streaming(&mut state);
        // 第二次：elapsed=30s → 剩余 30s → 等待钳到 min(30000, 30000)=30s
        let mut fut = Box::pin(handle(&mut state, rate_limit_error(30_000)));
        assert!(poll!(fut.as_mut()).is_pending());
        tokio::time::advance(Duration::from_millis(30_000)).await;
        let o2 = fut.await.unwrap();
        assert!(o2.end.is_none(), "剩余预算 30s 内第二次重试必须发生");
        assert_eq!(state.transient_retries, 2);
        re_enter_streaming(&mut state);
        // 第三次：elapsed=60s >= 预算 → retry_delay_ms 返回 None → 直接 fatal
        // （不消耗次数，严格小于对齐 retry.rs:163-166）
        let o3 = handle(&mut state, rate_limit_error(30_000)).await.unwrap();
        assert!(o3.end.is_some(), "预算耗尽必须 fatal");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.transient_retries, 2, "预算耗尽不消耗重试次数");
    }

    /// D1 T4（A4）：abort 竞速——sleep 中 abort → 立即 aborted 收场、
    /// 不消耗重试计数、无 retry 诊断（规则 R5，零通知零噪声；biased 优先）
    #[tokio::test]
    async fn abort_during_backoff_sleep_closes_aborted_without_consuming_retry() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 预克隆信号（未来持有 &mut state 期间经共享句柄触发 abort）
        let signal = state.abort_signal.clone();
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending(), "必须已进入退避 sleep");
        // sleep 中 abort（竞速窗口）
        signal.abort();
        tokio::time::advance(Duration::from_millis(1)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_some(), "abort 必须立即收场");
        assert_eq!(state.machine.context().end_reason, R::Aborted);
        assert_eq!(state.transient_retries, 0, "abort 不消耗重试计数");
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "abort 竞速收场不发诊断"
        );
    }

    /// D1 规则 R5 补充：sleep 完成后 abort 竞速窗口收口——sleep 结束瞬间
    /// abort 已触发 → 复查后仍 aborted 收场（不重试）
    #[tokio::test]
    async fn abort_after_sleep_completion_race_window_closes_aborted() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        let signal = state.abort_signal.clone();
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending());
        // 推进到 sleep 完成点同时 abort：biased select 以 sleep 分支返回 →
        // sleep 后复查 abort 兜住竞速窗口（Q40 纪律）
        tokio::time::advance(Duration::from_millis(750)).await;
        signal.abort();
        tokio::time::advance(Duration::from_millis(1)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted);
        assert_eq!(state.transient_retries, 0, "竞速窗口收口不消耗计数");
    }

    /// D1 注入面：可注入延迟函数驱动序列（attempt 1/2/3 + Retry-After 透传），
    /// 零真实等待不依赖 tokio pause——测试直接驱动（任务书注入点要求）
    // G2 允许理由（clippy::type_complexity）：测试局部记录类型
    // Arc<Mutex<Vec<(u32, Option<u64>)>>>，由注入面签名自然形成
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn injected_delay_drives_retry_sequence_without_clock_pause() {
        use std::sync::Mutex;
        let mut state = backoff_state();
        let calls: Arc<Mutex<Vec<(u32, Option<u64>)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_handle = calls.clone();
        state.retry_delay = Some(Box::new(move |attempt, retry_after| {
            calls_handle.lock().unwrap().push((attempt, retry_after));
            Duration::ZERO
        }));
        for i in 0..3 {
            let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
                .await
                .unwrap();
            assert!(o.end.is_none(), "第 {} 次重试应继续 run", i + 1);
            re_enter_streaming(&mut state);
        }
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded, vec![(1, None), (2, None), (3, None)], "注入面收到 attempt 序列");
        // 第 4 次：次数用尽 → fatal
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(calls.lock().unwrap().len(), 3, "fatal 不再查询延迟");
    }

    /// D1 注入面（429）：注入函数收到 Retry-After 透传（test-only 注入面
    /// 不经预算钳制——注入值即最终等待）
    // G2 允许理由（clippy::type_complexity）：同 injected_delay_drives 记录类型
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn injected_delay_receives_retry_after_passthrough() {
        use std::sync::Mutex;
        let mut state = backoff_state();
        let calls: Arc<Mutex<Vec<(u32, Option<u64>)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_handle = calls.clone();
        state.retry_delay = Some(Box::new(move |attempt, retry_after| {
            calls_handle.lock().unwrap().push((attempt, retry_after));
            Duration::from_millis(30_000)
        }));
        let o = handle(&mut state, rate_limit_error(30_000)).await.unwrap();
        assert!(o.end.is_none());
        assert_eq!(
            calls.lock().unwrap().clone(),
            vec![(1, Some(30_000))],
            "注入面收到 attempt=1 与 Retry-After 透传"
        );
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(30_000)),
            "诊断等待 = 注入值 30s"
        );
    }

    /// D1 R6：retry_backoff=None（缺省）→ 现状立即重试（无退避、无 sleep、
    /// 无预算闸——向后兼容；诊断 elapsed_ms=0）
    #[tokio::test]
    async fn default_no_backoff_retries_immediately() {
        let mut state = streaming_state(); // retry_backoff = None（缺省）
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_none());
        assert_eq!(state.transient_retries, 1);
        assert_eq!(
            retry_diagnostic(&state).map(|d| d.elapsed_ms),
            Some(Some(0)),
            "无退避配置等待 = 0"
        );
        assert!(
            state.transient_retry_started_at.is_some(),
            "预算起点照常惰性初始化"
        );
    }

    /// D1 T5（A5）：熔断闸——streak=Some(6) ≥ 阈值 → 注入瞬态错误直接 fatal
    /// （endReason=Error、transient_retries=0、发 runtime-error 事件、
    /// 无 retry 诊断；熔断期不烧 run 内配额）
    #[tokio::test]
    async fn circuit_breaker_trips_at_six_streak_fatals_without_retry() {
        let mut state = backoff_state();
        state.options.provider_fail_streak = Some(6);
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_some(), "熔断命中必须直接 fatal");
        assert_eq!(state.machine.context().end_reason, R::Error);
        assert_eq!(state.transient_retries, 0, "熔断期不消耗 run 内重试配额");
        assert!(
            state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::RuntimeError { .. })),
            "熔断 fatal 必须发 runtime-error 观测事件"
        );
        assert!(
            !state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::ProviderDiagnostic { .. })),
            "熔断 fatal 不发重试诊断"
        );
        // provider_error 摘要照常填充（retries=0）
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::ServerError);
        assert_eq!(p.retries, 0);
    }

    /// D1 T5（A5）：streak=Some(5) < 阈值 → 正常重试（闸只卡 ≥ 阈值）
    #[tokio::test]
    async fn circuit_breaker_below_threshold_still_retries() {
        let mut state = backoff_state();
        state.options.provider_fail_streak = Some(5);
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_none(), "streak=5 未达阈值必须正常重试");
        assert_eq!(state.transient_retries, 1);
    }

    /// D1 T5（A5）：streak=None（缺省）→ 现状行为（熔断不启用，向后兼容）
    #[tokio::test]
    async fn circuit_breaker_disabled_by_default_still_retries() {
        let mut state = backoff_state();
        assert!(state.options.provider_fail_streak.is_none());
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_none());
        assert_eq!(state.transient_retries, 1);
    }

    /// D1 Q40 顺序保持：abort 检查先于熔断闸——熔断命中且已 abort → aborted
    /// 收场（非 fatal；既有 abort 优先级不被熔断覆盖）
    #[tokio::test]
    async fn abort_check_precedes_circuit_breaker_gate() {
        let mut state = streaming_state();
        state.options.provider_fail_streak = Some(6);
        state.abort_signal.abort();
        let o = handle(&mut state, transient_error(ProviderErrorKind::ServerError))
            .await
            .unwrap();
        assert!(o.end.is_some());
        assert_eq!(state.machine.context().end_reason, R::Aborted, "abort 优先于熔断");
        assert_eq!(state.transient_retries, 0);
    }

    /// D1 T7（A7）：3 次瞬态重试耗尽 → terminal_provider_error =
    /// Some{kind: Network, retryable: true, retries: 3}（fatal 填充面）
    #[tokio::test]
    async fn provider_error_summary_filled_after_transient_exhaustion() {
        let mut state = backoff_state();
        state.retry_delay = Some(Box::new(|_, _| Duration::ZERO));
        for _ in 0..3 {
            let o = handle(&mut state, transient_error(ProviderErrorKind::Network))
                .await
                .unwrap();
            assert!(o.end.is_none());
            re_enter_streaming(&mut state);
        }
        let o4 = handle(&mut state, transient_error(ProviderErrorKind::Network))
            .await
            .unwrap();
        assert!(o4.end.is_some());
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::Network);
        assert!(p.retryable);
        assert_eq!(p.retry_after_ms, None);
        assert_eq!(p.retries, 3, "retries = run 内实际重试次数");
    }

    /// D1 T7（A7）：非瞬态 fatal（Auth）→ Some{kind: Auth, retryable: false,
    /// retries: 0}（02 W1 验收②）
    #[tokio::test]
    async fn provider_error_summary_filled_on_auth_fatal() {
        let mut state = streaming_state();
        let o = handle(&mut state, transient_error(ProviderErrorKind::Auth))
            .await
            .unwrap();
        assert!(o.end.is_some());
        let p = state.terminal_provider_error.as_ref().expect("fatal 必须填充摘要");
        assert_eq!(p.kind, ProviderErrorKind::Auth);
        assert!(!p.retryable);
        assert_eq!(p.retries, 0, "非瞬态直接 fatal 无重试");
    }

    /// D1 A9（R7/R9 前缀不变性）：退避 sleep 期间与重试后对话零改动——
    /// 无消息产出、无 commit、无 message-start/end 事件（前缀不变性是
    /// provider 前缀缓存命中的前提，约束 B；sleep 期间未来暂停轮询，
    /// 无代码路径可写对话——结构保证，测试锁定重试全程零对话改动）
    #[tokio::test]
    async fn backoff_sleep_keeps_conversation_prefix_untouched() {
        let _time = TimePauseGuard::new();
        let mut state = backoff_state();
        // 预置已 commit 消息（前缀基线快照）
        state.conversation.push(Arc::new(AgentMessage {
            id: "m0".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text { text: "已提交前缀".to_string() }],
            metadata: None,
            client_message_id: None,
            content: None,
        }));
        let snapshot: Vec<Arc<AgentMessage>> = state.conversation.clone();
        let mut fut = Box::pin(handle(&mut state, transient_error(ProviderErrorKind::ServerError)));
        assert!(poll!(fut.as_mut()).is_pending(), "必须已进入退避 sleep");
        // 推进退避：sleep 期间未来不被轮询（结构上零对话改动）
        tokio::time::advance(Duration::from_millis(750)).await;
        let o = fut.await.unwrap();
        assert!(o.end.is_none());
        // 重试全程（含退避 sleep 期间）：对话零改动（长度不变 + Arc 身份
        // 一致 = 零 commit）、除重试诊断外无任何事件（无 message-start/end）
        assert_eq!(state.conversation.len(), snapshot.len(), "重试路径不得产生消息");
        assert!(
            state
                .conversation
                .iter()
                .zip(&snapshot)
                .all(|(a, b)| Arc::ptr_eq(a, b)),
            "重试路径消息 Arc 身份不得变化（零 commit，前缀字节级一致 R7）"
        );
        assert!(
            state.events.iter().all(|e| matches!(
                e,
                AgentEvent::ProviderDiagnostic { .. }
            )),
            "重试路径只允许重试诊断事件（不得注入对话/消息事件）"
        );
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
    /// （D1 §3.1.6：transient_retry 改 async，调用点加 .await）
    #[tokio::test]
    async fn abort_at_transient_level_skips_remaining_ladder() {
        let mut state = streaming_state();
        state.abort_signal.abort();
        let outcome = transient_retry(&mut state, &transient_error(ProviderErrorKind::ServerError))
            .await
            .expect("瞬态重试决策");
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
