//! 瞬态重试恢复面（D1 §3.1：退避 + Retry-After + 60s 预算 + abort 竞速 +
//! 熔断闸）——SR-06c · 拆分 · ≠ EL：自 stream_error.rs 拆出，公共面经
//! 父模 re-export（stream_error::* 路径不 break）。

use std::time::Duration;

use conex_types::error::ProviderErrorKind;
use conex_types::events::AgentEvent;
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentSessionEvent as E;
use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};

use super::super::super::{LoopError, RetryBackoffConfig};
use super::super::streaming::streaming_aborted;
use super::super::{dispatch, HandlerOutcome, LoopState};
use super::fatal::fatal_provider_error;
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
pub(crate) fn retry_delay_ms(
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
pub(crate) async fn transient_retry(
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
        .options.retry.provider_fail_streak
        .is_some_and(|s| s >= PROVIDER_FAIL_THRESHOLD)
    {
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            streak = ?state.options.retry.provider_fail_streak,
            threshold = PROVIDER_FAIL_THRESHOLD,
            "熔断触发：跳过 run 内重试直接 fatal（观测面 runtime-error，熔断计数由壳层收口维护）"
        );
        return fatal_provider_error(state, classified);
    }
    let limit = state.options.retry.transient_retry_limit;
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
            None => match state.options.retry.retry_backoff {
                Some(cfg) => match retry_delay_ms(
                    &cfg,
                    classified.kind,
                    attempt,
                    classified.retry_after_ms,
                    elapsed_ms,
                ) {
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
        tracing::info!(
            attempt = state.transient_retries,
            limit,
            delay_ms = delay.as_millis(),
            "瞬态错误重试"
        );
        // 重试诊断（D1 §3.1.5，用户约束 A/C）：phase=Retry 事件兼作临时
        // 通知数据源（前端老虎机滚动 1/N→N/N）；不进对话上下文、AI 不可见
        emit_retry_diagnostic(
            state,
            classified,
            state.transient_retries,
            limit,
            delay,
            classified.retry_after_ms,
        );
        dispatch(state, E::NoProgressContinue)?;
        return Ok(HandlerOutcome::continue_run());
    }
    fatal_provider_error(state, classified)
}

/// 重试诊断事件（provider-diagnostic，phase=Retry；D1 §3.1.5 扩展：
/// 载荷附本次实际等待与 Retry-After 透传——临时通知数据源，前端老虎机
/// 滚动展示重连进度（如 1/6→2/6）；不进对话上下文、AI 不可见，约束 A/C）
///
/// 字段承载（D1 D8 动态决策）：ProviderDiagnostic 无 delay_ms 字段且
/// 文件域冻结（不扩 conex-types），经既有 `elapsed_ms` 字段承载本次实际
/// 等待时长（phase=Retry 语义下为 delay_ms；全仓无既有消费方冲突）；
/// `retry_after_ms` 直接透传（既有字段）。
pub(crate) fn emit_retry_diagnostic(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
    attempt: u32,
    max_attempts: u32,
    delay: Duration,
    retry_after_ms: Option<u64>,
) {
    let session_id = state.machine.context().session_id.clone();
    state.emit_event(AgentEvent::ProviderDiagnostic {
        session_id,
        timestamp: conex_shared::time::now_iso_utc(),
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

/// length 阶梯升级诊断（EV-03 / D-03：provider-diagnostic 扩展
/// kind=length-escalation，复用同族不加新类型）
///
/// 载荷：`reason` 携带 kind=length-escalation 标识 + maxTokens 升级前后值；
/// `attempt`/`max_attempts` 对齐 [emit_retry_diagnostic] 的 phase=Retry
/// 先例（attempt = 本次升级序号）。发射点：no_tool_calls.rs（stopReason=
/// Length 的 max_tokens 翻倍路径）与 length_ladder（ContextLengthExceeded
/// 阶梯，经同一函数）。
pub(crate) fn emit_length_escalation_diagnostic(
    state: &mut LoopState,
    attempt: u32,
    max_attempts: u32,
    max_tokens_before: u32,
    max_tokens_after: u32,
) {
    let session_id = state.machine.context().session_id.clone();
    state.emit_event(AgentEvent::ProviderDiagnostic {
        session_id,
        timestamp: conex_shared::time::now_iso_utc(),
        diagnostic: ProviderDiagnostic {
            phase: ProviderDiagnosticPhase::Retry,
            attempt: Some(attempt),
            max_attempts: Some(max_attempts),
            reason: Some(format!(
                "length-escalation: maxTokens {max_tokens_before}→{max_tokens_after}"
            )),
            ..ProviderDiagnostic::default()
        },
    });
}

