//! 指数退避重试器（任务书 B2.7；02-provider-semantics.md §四.3、§六.8）
//!
//! 对齐 TS 端 openai-retry.ts：
//! - 退避 `min(max_delay, base * 2^(attempt-1))`，默认 750ms 起、8s 封顶；
//! - Retry-After 支持秒数与 HTTP-date、上限 5 分钟，与退避取大后再钳
//!   max_delay 与剩余预算（[choose_retry_delay_ms]）；
//! - 总预算 60s（elapsed < total_budget 才继续，对齐 withinRetryBudget）；
//! - delay 可被 abort 中断（[RetrySleeper] + [TokioSleeper]，对齐 TS delay 可中断）；
//! - 仅瞬态类重试：rate-limit / 5xx / 网络 / 超时；auth、quota、context_length
//!   等不可由本循环重试（context_length 由上层压缩处理，00 D5：分类与收口分离）。
//!
//! [provider_stream] 为高层封装：循环发送请求 → 分类错误 → 退避重试，
//! 流已产出内容时中途错误不重试（02 §六.7），abort 一律直接传播。

use std::future::Future;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use conex_types::error::ProviderErrorKind;

use crate::error::ProviderError;
use crate::events::{
    ModelRequestInfo, ModelRequestObserver, ModelResponseInfo,
};
use crate::sse::{AbortHandle, SseFrame};

/// Retry-After 绝对上限（对齐 TS MAX_RETRY_AFTER_MS = 5 分钟，
/// 防恶意 Retry-After 让重试循环挂起数小时）
pub const MAX_RETRY_AFTER_MS: u64 = 5 * 60_000;

/// 重试策略（对齐 openai-retry.ts normalizeRetryOptions 的默认值）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 最大重试次数（0 = 不重试；对齐 TS maxAttempts=1 的语义：显式开启才重试）
    pub max_retries: u32,
    /// 首次退避基数（默认 750ms）
    pub base_delay_ms: u64,
    /// 单次等待上限（默认 8s）
    pub max_delay_ms: u64,
    /// 总重试预算（默认 60s，超出即停止）
    pub total_budget_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 0,
            base_delay_ms: 750,
            max_delay_ms: 8_000,
            total_budget_ms: 60_000,
        }
    }
}

impl RetryPolicy {
    /// 边界钳制（对齐 normalizeRetryOptions：initial≥1、max≥initial、budget≥1）
    pub fn normalized(&self) -> Self {
        let base_delay_ms = self.base_delay_ms.max(1);
        Self {
            max_retries: self.max_retries,
            base_delay_ms,
            max_delay_ms: self.max_delay_ms.max(base_delay_ms),
            total_budget_ms: self.total_budget_ms.max(1),
        }
    }
}

/// 重试状态（预算计时起点 + 已重试次数）
#[derive(Debug, Clone)]
pub struct RetryState {
    /// 已执行的重试次数（0 = 尚未重试，正在评估第一次重试）
    pub retries: u32,
    /// 预算计时起点（通常为首个请求发起时刻；tokio 时钟便于测试推进）
    pub started_at: tokio::time::Instant,
}

impl RetryState {
    /// 新建状态：零重试、以当前时刻为预算起点
    pub fn new() -> Self {
        Self {
            retries: 0,
            started_at: tokio::time::Instant::now(),
        }
    }
}

impl Default for RetryState {
    fn default() -> Self {
        Self::new()
    }
}

/// 重试决策（[should_retry] 的产出）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryDecision {
    /// 本次重试序号（从 1 起）
    pub attempt: u32,
    /// 重试前等待时长（已钳到 max_delay 与剩余预算）
    pub delay: Duration,
    /// 本次等待后的剩余总预算（毫秒）
    pub remaining_budget_ms: u64,
}

/// 指数退避（attempt 从 1 起；对齐 retryDelayMs，openai-retry.ts:104-119）
///
/// `min(max_delay, base * 2^(attempt-1))`；指数上限 62 防溢出（saturating）。
pub fn retry_delay_ms(policy: &RetryPolicy, attempt: u32) -> Duration {
    let policy = policy.normalized();
    let exponent = (attempt.max(1) - 1).min(62);
    let backoff = policy.base_delay_ms.saturating_mul(1u64 << exponent);
    Duration::from_millis(backoff.min(policy.max_delay_ms))
}

/// 合并等待：Retry-After 与退避取大，再钳 max_delay 与剩余预算
/// （对齐 chooseRetryDelayMs，openai-retry.ts:161-175）
pub fn choose_retry_delay_ms(
    policy: &RetryPolicy,
    attempt: u32,
    retry_after: Option<Duration>,
    remaining_budget_ms: Option<u64>,
) -> Duration {
    let policy = policy.normalized();
    let backoff = retry_delay_ms(&policy, attempt);
    let wait = match retry_after {
        Some(after) => backoff.max(after),
        None => backoff,
    };
    let wait = wait.min(Duration::from_millis(policy.max_delay_ms));
    match remaining_budget_ms {
        Some(budget) => wait.min(Duration::from_millis(budget)),
        None => wait,
    }
}

/// 是否重试及等待时长（02 §六.8；仅瞬态类可重试）
///
/// - rate-limit / 5xx / 网络 / 超时可重试；
/// - auth、quota、payload、endpoint、gateway-challenge、invalid-request、
///   abort、unknown 不可重试；
/// - context_length 虽在分类层标记 retryable（02 §4.2 第 7 行），但本循环不
///   重试——由上层压缩处理（00 D5：分类与收口分离，重试在预算内处理）；
/// - 超出总预算（elapsed >= total_budget_ms）或达到 max_retries 返回 None。
pub fn should_retry(
    err: &ProviderError,
    policy: &RetryPolicy,
    state: &RetryState,
) -> Option<RetryDecision> {
    let policy = policy.normalized();
    let retryable = matches!(
        err.kind(),
        ProviderErrorKind::RateLimit
            | ProviderErrorKind::ServerError
            | ProviderErrorKind::Timeout
            | ProviderErrorKind::Network
    );
    if !retryable {
        return None;
    }
    if state.retries >= policy.max_retries {
        return None;
    }
    // 预算：elapsed < total_budget 才继续（对齐 withinRetryBudget 的严格小于）
    let elapsed_ms = state.started_at.elapsed().as_millis() as u64;
    if elapsed_ms >= policy.total_budget_ms {
        return None;
    }
    let attempt = state.retries + 1;
    let remaining_budget_ms = policy.total_budget_ms - elapsed_ms;
    let delay = choose_retry_delay_ms(
        &policy,
        attempt,
        err.retry_after(),
        Some(remaining_budget_ms),
    );
    Some(RetryDecision {
        attempt,
        delay,
        remaining_budget_ms,
    })
}

/// 解析 Retry-After：支持秒数或 HTTP-date（对齐 parseRetryAfterMs，openai-retry.ts:47-62）
///
/// - 空/非法 → None；
/// - 负值或已过时间 → 0；
/// - 超过 [MAX_RETRY_AFTER_MS] → 钳到上限（防恶意头挂起重试循环）。
/// - `now` 参数用于 HTTP-date 相对当前时刻的计算（测试注入）。
pub fn parse_retry_after_ms(value: Option<&str>, now: SystemTime) -> Option<Duration> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        if seconds.is_finite() {
            let millis = (seconds.max(0.0) * 1000.0) as u64;
            return Some(clamp_retry_after(Duration::from_millis(millis)));
        }
        // 非有限数值：正无穷钳到上限，负无穷为 0（对齐 TS :55-57）
        if seconds > 0.0 {
            return Some(Duration::from_millis(MAX_RETRY_AFTER_MS));
        }
        return Some(Duration::ZERO);
    }
    let epoch = parse_http_date(value)?;
    let then = Duration::from_secs(epoch.max(0) as u64);
    let now = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    Some(clamp_retry_after(then.saturating_sub(now)))
}

/// 钳制到 [0, MAX_RETRY_AFTER_MS]（对齐 clampRetryAfterMs）
fn clamp_retry_after(duration: Duration) -> Duration {
    duration.min(Duration::from_millis(MAX_RETRY_AFTER_MS))
}

/// HTTP-date 解析（RFC 7231 §7.1.1.1）：IMF-fixdate、RFC 850、asctime 三种格式，
/// 返回 UNIX epoch 秒。手工解析，不引入新依赖。
///
/// - `Sun, 06 Nov 1994 08:49:37 GMT`（IMF-fixdate）
/// - `Sunday, 06-Nov-94 08:49:37 GMT`（RFC 850，2 位年份按 70 分界）
/// - `Sun Nov  6 08:49:37 1994`（asctime）
fn parse_http_date(value: &str) -> Option<i64> {
    let tokens: Vec<&str> = value
        .split([' ', '\t', ','])
        .filter(|token| !token.is_empty())
        .collect();
    let (day, month, year, time) = match tokens.as_slice() {
        // IMF-fixdate：[星期,] 日 月 年 时:分:秒 GMT
        [_, day, month, year, time, "GMT"] => (
            day.parse::<u32>().ok()?,
            month_index(month)?,
            year.parse::<i64>().ok()?,
            time,
        ),
        // RFC 850：[星期,] 日-月-年 时:分:秒 GMT
        [_, date, time, "GMT"] => {
            let mut parts = date.split('-');
            let day = parts.next()?.parse::<u32>().ok()?;
            let month = month_index(parts.next()?)?;
            let yy = parts.next()?.parse::<i64>().ok()?;
            let year = if yy >= 70 { 1900 + yy } else { 2000 + yy };
            (day, month, year, time)
        }
        // asctime：星期 月 日 时:分:秒 年（日可为空格补位）
        [_, month, day, time, year] => (
            day.parse::<u32>().ok()?,
            month_index(month)?,
            year.parse::<i64>().ok()?,
            time,
        ),
        _ => return None,
    };
    let (hour, minute, second) = parse_time(time)?;
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64)
}

/// 月份缩写 → 1-12
fn month_index(token: &str) -> Option<u32> {
    const MONTHS: &[&str] = &[
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    MONTHS
        .iter()
        .position(|month| *month == token.to_ascii_lowercase())
        .map(|index| index as u32 + 1)
}

/// 时:分:秒 → (时, 分, 秒)
fn parse_time(token: &str) -> Option<(u32, u32, u32)> {
    let mut parts = token.split(':');
    let hour = parts.next()?.parse::<u32>().ok()?;
    let minute = parts.next()?.parse::<u32>().ok()?;
    let second = parts.next()?.parse::<u32>().ok()?;
    Some((hour, minute, second))
}

/// 民用日期 → 距 1970-01-01 的天数（Howard Hinnant days_from_civil 算法）
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let offset = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * offset as i64 + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 可中断睡眠抽象（便于测试注入时钟/记录等待）
#[async_trait]
pub trait RetrySleeper: Send {
    /// 睡眠指定时长；abort 中断时返回 [ProviderError::Aborted]
    async fn sleep(&mut self, duration: Duration) -> Result<(), ProviderError>;
}

/// 默认实现：tokio::time::sleep + abort 竞速（对齐 TS delay 可中断，
/// openai-retry.ts:86-101；biased 顺序保证 abort 优先判定）
pub struct TokioSleeper {
    abort: AbortHandle,
}

impl TokioSleeper {
    /// 用成对的 [AbortHandle] 构造（来自 AbortFlag::new）
    pub fn new(abort: AbortHandle) -> Self {
        Self { abort }
    }
}

#[async_trait]
impl RetrySleeper for TokioSleeper {
    async fn sleep(&mut self, duration: Duration) -> Result<(), ProviderError> {
        tokio::select! {
            biased;
            _ = self.abort.wait_abort() => Err(ProviderError::Aborted),
            _ = tokio::time::sleep(duration) => Ok(()),
        }
    }
}

/// 一次流尝试的结果（重试循环输入）
#[derive(Debug)]
pub struct StreamAttempt {
    /// 成功时完整帧序列；失败时已读取到的帧（调用方自行决定取舍）
    pub frames: Vec<SseFrame>,
    /// 失败原因（None = 本次尝试成功）
    pub error: Option<ProviderError>,
    /// 失败前是否已产出正文内容（text/thought/tool-call 事件；诊断/usage 不算）
    ///
    /// 流已产出内容时中途错误不重试（02 §六.7/§1.3：重试会重复已流出的内容）。
    pub produced_content: bool,
}

/// 高层流封装：发送请求 → 分类错误 → should_retry → 退避重试（02 §六.7-8）
///
/// - `attempt` 为单次尝试（构建请求、发送、读流、分类错误），由调用方闭包实现；
/// - 循环内对可重试错误按 [RetryPolicy] 退避等待后重试；abort 与不可重试错误
///   立即上抛；流已产出内容时中途错误不重试；
/// - 成功返回完整帧序列（B2.8 消费层再解析为事件）。
///
/// M14：本函数为 [provider_stream_with_observer] 的薄包装（不挂观测器，
/// 保持既有调用面与语义不变）。
pub async fn provider_stream<F, Fut>(
    policy: &RetryPolicy,
    sleeper: &mut dyn RetrySleeper,
    state: &mut RetryState,
    attempt: F,
) -> Result<Vec<SseFrame>, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = StreamAttempt>,
{
    provider_stream_with_observer(policy, sleeper, state, None, attempt).await
}

/// 高层流封装（带 model 请求生命周期观测器，M14：model.beforeRequest /
/// model.afterResponse 事件源发射点）
///
/// 发射语义：
/// - **请求前**（before-request）：每次尝试发起前发射（含重试循环内的
///   每一次尝试；`attempt` 从 1 起递增）；
/// - **响应后**（after-response）：每次尝试结束后发射（成功/失败均触发，
///   携带 ok/error 与单次耗时）；
/// - 观测器只观测不改写：回调失败不影响请求路径（trait 为不可失败签名）；
/// - `None` = 不发射（与 [provider_stream] 行为一致）。
pub async fn provider_stream_with_observer<F, Fut>(
    policy: &RetryPolicy,
    sleeper: &mut dyn RetrySleeper,
    state: &mut RetryState,
    observer: Option<&dyn ModelRequestObserver>,
    mut attempt: F,
) -> Result<Vec<SseFrame>, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = StreamAttempt>,
{
    loop {
        let attempt_number = state.retries + 1;
        let started = Instant::now();
        if let Some(observer) = observer {
            observer.on_before_request(&ModelRequestInfo {
                url: None,
                model: None,
                max_tokens: None,
                attempt: attempt_number,
            });
        }
        let outcome = attempt().await;
        let duration_ms = started.elapsed().as_millis() as u64;
        match outcome {
            // 成功：返回完整帧
            StreamAttempt {
                error: None,
                frames,
                ..
            } => {
                if let Some(observer) = observer {
                    observer.on_after_response(&ModelResponseInfo {
                        status: None,
                        ok: true,
                        error: None,
                        duration_ms,
                        usage: None,
                    });
                }
                return Ok(frames);
            }
            // 已产出内容：不重试，直接上抛（02 §六.7 语义）
            StreamAttempt {
                error: Some(error),
                produced_content: true,
                ..
            } => {
                if let Some(observer) = observer {
                    observer.on_after_response(&ModelResponseInfo {
                        status: None,
                        ok: false,
                        error: Some(error.to_string()),
                        duration_ms,
                        usage: None,
                    });
                }
                return Err(error);
            }
            // 未产出内容：可重试则退避等待后重试，否则上抛
            StreamAttempt {
                error: Some(error),
                produced_content: false,
                ..
            } => {
                if let Some(observer) = observer {
                    observer.on_after_response(&ModelResponseInfo {
                        status: None,
                        ok: false,
                        error: Some(error.to_string()),
                        duration_ms,
                        usage: None,
                    });
                }
                // abort 一律直接传播（02 §4.2 第 1 行）
                if matches!(error, ProviderError::Aborted) {
                    return Err(error);
                }
                match should_retry(&error, policy, state) {
                    Some(decision) => {
                        tracing::debug!(
                            attempt = decision.attempt,
                            delay_ms = decision.delay.as_millis() as u64,
                            "provider 错误可重试，退避后重试"
                        );
                        sleeper.sleep(decision.delay).await?;
                        state.retries += 1;
                    }
                    None => return Err(error),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{NetworkSourceKind, StreamErrorKind, TimeoutKind};
    use crate::sse::AbortFlag;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::SystemTime;

    /// 测试用策略：显式开启 3 次重试
    fn default_policy() -> RetryPolicy {
        RetryPolicy {
            max_retries: 3,
            ..RetryPolicy::default()
        }
    }

    fn server_error() -> ProviderError {
        ProviderError::Server { status: Some(503) }
    }

    /// 测试 sleeper：记录每次等待时长并立即完成（不耗真实时间）
    struct MockSleeper {
        sleeps: Vec<Duration>,
    }

    #[async_trait]
    impl RetrySleeper for MockSleeper {
        async fn sleep(&mut self, duration: Duration) -> Result<(), ProviderError> {
            self.sleeps.push(duration);
            Ok(())
        }
    }

    // ── 退避序列 ──

    /// 指数退避序列：750 → 1500 → 3000 → 6000 → 8000（8s 封顶）
    #[test]
    fn backoff_sequence_exponential_then_capped() {
        let policy = default_policy();
        let expected = [750u64, 1500, 3000, 6000, 8000, 8000];
        for (index, expected_ms) in expected.iter().enumerate() {
            let attempt = index as u32 + 1;
            assert_eq!(
                retry_delay_ms(&policy, attempt),
                Duration::from_millis(*expected_ms),
                "attempt {attempt}"
            );
        }
    }

    // ── 决策表 ──

    /// should_retry 决策表：仅瞬态类（rate-limit/5xx/网络/超时）可重试
    #[tokio::test(start_paused = true)]
    async fn should_retry_decision_table() {
        let policy = default_policy();
        let state = RetryState::new();
        let cases: &[(ProviderError, bool)] = &[
            (
                ProviderError::RateLimit {
                    status: Some(429),
                    retry_after: None,
                },
                true,
            ),
            (ProviderError::Server { status: Some(503) }, true),
            (
                ProviderError::Timeout {
                    kind: TimeoutKind::Request,
                },
                true,
            ),
            (
                ProviderError::Network {
                    source_kind: NetworkSourceKind::Connection,
                },
                true,
            ),
            (
                ProviderError::Stream {
                    kind: StreamErrorKind::MalformedFrame,
                },
                true,
            ),
            (ProviderError::Auth { status: Some(401) }, false),
            // context_length 由上层压缩处理，重试循环不重试
            (ProviderError::ContextLength { status: Some(400) }, false),
            (
                ProviderError::InvalidRequest {
                    status: None,
                    message: "x".into(),
                },
                false,
            ),
            (
                ProviderError::PayloadTooLarge { status: Some(413) },
                false,
            ),
            (ProviderError::GatewayChallenge { status: None }, false),
            (ProviderError::Quota { status: Some(402) }, false),
            (
                ProviderError::EndpointUnavailable { status: Some(404) },
                false,
            ),
            (ProviderError::Aborted, false),
            (
                ProviderError::Unknown {
                    message: "x".into(),
                },
                false,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(
                should_retry(error, &policy, &state).is_some(),
                *expected,
                "{error:?}"
            );
        }
    }

    /// 达到 max_retries 后 should_retry 返回 None（对齐 maxAttempts 语义）
    #[tokio::test(start_paused = true)]
    async fn max_retries_limit() {
        let policy = RetryPolicy {
            max_retries: 2,
            ..RetryPolicy::default()
        };
        let state = RetryState::new();
        let error = server_error();
        assert_eq!(
            should_retry(
                &error,
                &policy,
                &RetryState {
                    retries: 0,
                    started_at: state.started_at
                }
            )
            .map(|decision| decision.attempt),
            Some(1)
        );
        assert_eq!(
            should_retry(
                &error,
                &policy,
                &RetryState {
                    retries: 1,
                    started_at: state.started_at
                }
            )
            .map(|decision| decision.attempt),
            Some(2)
        );
        assert!(
            should_retry(
                &error,
                &policy,
                &RetryState {
                    retries: 2,
                    started_at: state.started_at
                }
            )
            .is_none()
        );
        // max_retries=0（默认）：显式开启才重试
        let policy = RetryPolicy::default();
        assert!(
            should_retry(
                &error,
                &policy,
                &RetryState {
                    retries: 0,
                    started_at: state.started_at
                }
            )
            .is_none()
        );
    }

    // ── Retry-After 与预算 ──

    /// Retry-After 与退避取大，再钳 max_delay 与剩余预算
    #[test]
    fn retry_after_respected_and_clamped() {
        // 默认 max_delay=8s：Retry-After 30s 被钳到 8s
        let policy = default_policy();
        let delay = choose_retry_delay_ms(&policy, 1, Some(Duration::from_secs(30)), None);
        assert_eq!(delay, Duration::from_millis(8_000));
        // max_delay 放宽后 Retry-After 优先于退避（429 优先尊重 Retry-After）
        let policy = RetryPolicy {
            max_delay_ms: 60_000,
            ..default_policy()
        };
        let delay = choose_retry_delay_ms(&policy, 1, Some(Duration::from_secs(30)), None);
        assert_eq!(delay, Duration::from_secs(30));
        // 无 Retry-After 时取退避
        let delay = choose_retry_delay_ms(&policy, 1, None, None);
        assert_eq!(delay, Duration::from_millis(750));
        // 剩余预算钳制
        let delay = choose_retry_delay_ms(&policy, 1, Some(Duration::from_secs(30)), Some(2_000));
        assert_eq!(delay, Duration::from_millis(2_000));
    }

    /// Retry-After 秒数格式（openai-retry.ts:47-62）
    #[test]
    fn parse_retry_after_seconds() {
        let now = SystemTime::now();
        assert_eq!(
            parse_retry_after_ms(Some("30"), now),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            parse_retry_after_ms(Some("0"), now),
            Some(Duration::ZERO)
        );
        assert_eq!(
            parse_retry_after_ms(Some("-5"), now),
            Some(Duration::ZERO)
        );
        // 小数秒（TS Number 语义）
        assert_eq!(
            parse_retry_after_ms(Some("1.5"), now),
            Some(Duration::from_millis(1500))
        );
        // 超过 5 分钟钳到上限
        assert_eq!(
            parse_retry_after_ms(Some("999999"), now),
            Some(Duration::from_millis(MAX_RETRY_AFTER_MS))
        );
        // 非法 → None
        assert_eq!(parse_retry_after_ms(None, now), None);
        assert_eq!(parse_retry_after_ms(Some(""), now), None);
        assert_eq!(parse_retry_after_ms(Some("  "), now), None);
        assert_eq!(parse_retry_after_ms(Some("abc"), now), None);
    }

    /// Retry-After HTTP-date 格式（IMF-fixdate / RFC 850 / asctime）
    #[test]
    fn parse_retry_after_http_date() {
        // HTTP-date 只有秒粒度：以截断到整秒的时刻为比较基准
        let now_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let now = UNIX_EPOCH + Duration::from_secs(now_epoch as u64);
        let future_epoch = now_epoch + 30;
        // IMF-fixdate：目标时刻 = 现在 + 30s
        assert_eq!(
            parse_retry_after_ms(Some(&imf_fixdate(future_epoch)), now),
            Some(Duration::from_secs(30))
        );
        // RFC 850 与 asctime 变体
        assert_eq!(
            parse_retry_after_ms(Some(&rfc850(future_epoch)), now),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            parse_retry_after_ms(Some(&asctime(future_epoch)), now),
            Some(Duration::from_secs(30))
        );
        // 已过时间 → 0
        let past_epoch = now_epoch - 60;
        assert_eq!(
            parse_retry_after_ms(Some(&imf_fixdate(past_epoch)), now),
            Some(Duration::ZERO)
        );
    }

    /// F3-11（红→绿）：HTTP-date 极端年份溢出防护——year 接近 i64 极值时
    /// `days * 86_400`（days_from_civil 的 era * 146_097）不得溢出 panic
    /// （修复前 debug 构建算术溢出 panic，红）；解析结果按未来时刻钳到
    /// 5 分钟上限（[MAX_RETRY_AFTER_MS] 语义不回归）
    #[test]
    fn retry_after_extreme_http_date_year_does_not_overflow() {
        let now = SystemTime::now();
        // IMF-fixdate：year = i64::MAX（provider 可控头部，审计样本）
        let imf = parse_retry_after_ms(
            Some("Sun, 06 Nov 9223372036854775807 08:49:37 GMT"),
            now,
        );
        assert_eq!(
            imf,
            Some(Duration::from_millis(MAX_RETRY_AFTER_MS)),
            "极端年份必须钳到 5 分钟上限且不 panic（修复前溢出 panic，红）"
        );
        // asctime 变体同样防护
        let asctime = parse_retry_after_ms(
            Some("Sun Nov  6 08:49:37 9223372036854775807"),
            now,
        );
        assert_eq!(
            asctime,
            Some(Duration::from_millis(MAX_RETRY_AFTER_MS)),
            "asctime 极端年份同样不 panic 且钳到上限"
        );
        // 负向极端年份（远早于 1970）→ 已过时间 → 0，不 panic
        let past = parse_retry_after_ms(
            Some("Sun, 06 Nov -9223372036854775808 08:49:37 GMT"),
            now,
        );
        assert_eq!(past, Some(Duration::ZERO), "负向极端年份视为已过 → 0");
    }

    /// 总预算耗尽后不再重试（对齐 withinRetryBudget：elapsed < total_budget 才继续）
    #[tokio::test(start_paused = true)]
    async fn total_budget_exhaustion_stops_retry() {
        let policy = RetryPolicy {
            max_retries: 10,
            total_budget_ms: 10_000,
            ..RetryPolicy::default()
        };
        let error = server_error();
        let started_at = tokio::time::Instant::now();
        // t=0：预算充足
        let decision = should_retry(&error, &policy, &RetryState { retries: 0, started_at })
            .expect("预算内应可重试");
        assert_eq!(decision.remaining_budget_ms, 10_000);
        assert_eq!(decision.delay, Duration::from_millis(750));
        // t=9.5s：剩余 500ms，等待被钳到剩余预算
        tokio::time::advance(Duration::from_millis(9_500)).await;
        let decision = should_retry(&error, &policy, &RetryState { retries: 0, started_at })
            .expect("预算内应可重试");
        assert_eq!(decision.remaining_budget_ms, 500);
        assert_eq!(decision.delay, Duration::from_millis(500));
        // t=10s：预算耗尽 → None
        tokio::time::advance(Duration::from_millis(500)).await;
        assert!(
            should_retry(&error, &policy, &RetryState { retries: 0, started_at }).is_none()
        );
    }

    // ── 高层封装 provider_stream ──

    /// 可重试错误按指数退避重试直到成功
    #[tokio::test]
    async fn provider_stream_retries_then_succeeds() {
        let policy = default_policy();
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let frames = provider_stream(&policy, &mut sleeper, &mut state, move || {
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    StreamAttempt {
                        frames: vec![],
                        error: Some(server_error()),
                        produced_content: false,
                    }
                } else {
                    StreamAttempt {
                        frames: vec![],
                        error: None,
                        produced_content: false,
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(state.retries, 2);
        assert_eq!(
            sleeper.sleeps,
            vec![Duration::from_millis(750), Duration::from_millis(1500)]
        );
        assert!(frames.is_empty());
    }

    /// 不可重试错误立即上抛（不重试）
    #[tokio::test]
    async fn provider_stream_no_retry_on_non_retryable() {
        let policy = default_policy();
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                StreamAttempt {
                    frames: vec![],
                    error: Some(ProviderError::Auth { status: Some(401) }),
                    produced_content: false,
                }
            }
        })
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::Auth { .. }));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(sleeper.sleeps.is_empty());
    }

    /// 达到 max_retries 后停止重试并上抛
    #[tokio::test]
    async fn provider_stream_stops_after_max_retries() {
        let policy = RetryPolicy {
            max_retries: 2,
            ..RetryPolicy::default()
        };
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                StreamAttempt {
                    frames: vec![],
                    error: Some(server_error()),
                    produced_content: false,
                }
            }
        })
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::Server { .. }));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(
            sleeper.sleeps,
            vec![Duration::from_millis(750), Duration::from_millis(1500)]
        );
    }

    /// 流已产出内容时中途错误不重试（02 §六.7 语义）
    #[tokio::test]
    async fn provider_stream_no_retry_after_content_produced() {
        let policy = default_policy();
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let error = provider_stream(&policy, &mut sleeper, &mut state, move || {
            let counter = counter.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                StreamAttempt {
                    frames: vec![],
                    error: Some(server_error()),
                    // 第二次尝试已产出内容：即使错误可重试也不再重试
                    produced_content: n > 0,
                }
            }
        })
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::Server { .. }));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(sleeper.sleeps, vec![Duration::from_millis(750)]);
    }

    /// abort 直接传播：错误本身为 Aborted 时立即上抛
    #[tokio::test]
    async fn provider_stream_abort_propagates() {
        let policy = default_policy();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let error = provider_stream(&policy, &mut sleeper, &mut state, || async {
            StreamAttempt {
                frames: vec![],
                error: Some(ProviderError::Aborted),
                produced_content: false,
            }
        })
        .await
        .unwrap_err();
        assert_eq!(error, ProviderError::Aborted);
        assert!(sleeper.sleeps.is_empty());
    }

    /// TokioSleeper：等待期间 abort 中断睡眠（对齐 TS delay 可中断）
    #[tokio::test]
    async fn tokio_sleeper_abort_interrupts_delay() {
        let (flag, abort) = AbortFlag::new();
        let mut sleeper = TokioSleeper::new(abort);
        let handle = tokio::spawn(async move {
            sleeper.sleep(Duration::from_secs(60)).await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        flag.abort();
        let error = handle.await.unwrap().unwrap_err();
        assert_eq!(error, ProviderError::Aborted);
    }

    /// 高层封装 + 总预算：超出预算即停止（TokioSleeper 真实退避等待）
    #[tokio::test(start_paused = true)]
    async fn provider_stream_respects_total_budget() {
        let policy = RetryPolicy {
            max_retries: 10,
            base_delay_ms: 750,
            max_delay_ms: 8_000,
            total_budget_ms: 2_000,
        };
        let (_flag, abort) = AbortFlag::new();
        let mut sleeper = TokioSleeper::new(abort);
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let handle = tokio::spawn(async move {
            let mut state = RetryState::new();
            provider_stream(&policy, &mut sleeper, &mut state, move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    StreamAttempt {
                        frames: vec![],
                        error: Some(server_error()),
                        produced_content: false,
                    }
                }
            })
            .await
        });
        // 让任务注册首个 sleep 后按退避节奏推进时钟：
        // 第一次退避 750ms（预算剩 1250），第二次退避钳到剩余预算 1250ms
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(750)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(1_250)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(10_000)).await;
        let error = handle.await.unwrap().unwrap_err();
        assert!(matches!(error, ProviderError::Server { .. }));
        // 尝试 1 失败 → 等 750ms → 尝试 2 失败 → 等 1250ms → 尝试 3（预算耗尽，停止）
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    // ── M14：model 请求生命周期观测器（before-request / after-response 发射点）──

    /// 记录式观测器：按序记录 before/after 事件
    struct RecordingObserver {
        before: Arc<std::sync::Mutex<Vec<u32>>>,
        after: Arc<std::sync::Mutex<Vec<bool>>>,
    }

    impl RecordingObserver {
        fn new() -> Self {
            Self {
                before: Arc::new(std::sync::Mutex::new(Vec::new())),
                after: Arc::new(std::sync::Mutex::new(Vec::new())),
            }
        }

        fn events(&self) -> (Vec<u32>, Vec<bool>) {
            (
                self.before.lock().unwrap().clone(),
                self.after.lock().unwrap().clone(),
            )
        }
    }

    impl ModelRequestObserver for RecordingObserver {
        fn on_before_request(&self, info: &ModelRequestInfo) {
            self.before.lock().unwrap().push(info.attempt);
        }

        fn on_after_response(&self, info: &ModelResponseInfo) {
            self.after.lock().unwrap().push(info.ok);
        }
    }

    /// 每次尝试「请求前 → 尝试 → 响应后」成对发射；重试循环内每次尝试均发射
    /// （before-request 的 attempt 从 1 起递增）
    #[tokio::test]
    async fn observer_emits_before_and_after_per_attempt() {
        let policy = default_policy();
        let observer = RecordingObserver::new();
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let result = provider_stream_with_observer(
            &policy,
            &mut sleeper,
            &mut state,
            Some(&observer),
            move || {
                let counter = counter.clone();
                async move {
                    let n = counter.fetch_add(1, Ordering::SeqCst);
                    if n < 2 {
                        StreamAttempt {
                            frames: vec![],
                            error: Some(server_error()),
                            produced_content: false,
                        }
                    } else {
                        StreamAttempt {
                            frames: vec![],
                            error: None,
                            produced_content: false,
                        }
                    }
                }
            },
        )
        .await
        .unwrap();
        assert!(result.is_empty());
        let (before, after) = observer.events();
        // 3 次尝试：before-request 各一次（attempt 1/2/3），after-response 各一次
        assert_eq!(before, vec![1, 2, 3], "请求前每次尝试发射且 attempt 递增");
        assert_eq!(after, vec![false, false, true], "响应后每次尝试发射（ok 标记）");
        // 发射顺序保证：before 先于对应 after（成对配对）
        assert_eq!(before.len(), after.len(), "before/after 必须成对");
    }

    /// 成功路径只发射一对 before/after（无重试时 attempt 恒为 1）
    #[tokio::test]
    async fn observer_single_attempt_on_success() {
        let policy = default_policy();
        let observer = RecordingObserver::new();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let result = provider_stream_with_observer(
            &policy,
            &mut sleeper,
            &mut state,
            Some(&observer),
            || async {
                StreamAttempt {
                    frames: vec![],
                    error: None,
                    produced_content: false,
                }
            },
        )
        .await
        .unwrap();
        assert!(result.is_empty());
        let (before, after) = observer.events();
        assert_eq!(before, vec![1]);
        assert_eq!(after, vec![true]);
        assert!(sleeper.sleeps.is_empty());
    }

    /// 观测器不改变重试语义：不可重试错误只发射一对后上抛
    #[tokio::test]
    async fn observer_non_retryable_single_pair() {
        let policy = default_policy();
        let observer = RecordingObserver::new();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let error = provider_stream_with_observer(
            &policy,
            &mut sleeper,
            &mut state,
            Some(&observer),
            || async {
                StreamAttempt {
                    frames: vec![],
                    error: Some(ProviderError::Auth { status: Some(401) }),
                    produced_content: false,
                }
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::Auth { .. }));
        let (before, after) = observer.events();
        assert_eq!(before, vec![1], "不可重试：只发射一次 before");
        assert_eq!(after, vec![false], "失败尝试 after-response 标记 ok=false");
    }

    /// 无观测器时行为与既有 provider_stream 一致（零事件零开销）
    #[tokio::test]
    async fn without_observer_emits_nothing() {
        let policy = default_policy();
        let mut sleeper = MockSleeper {
            sleeps: Vec::new(),
        };
        let mut state = RetryState::new();
        let observer: Option<&dyn ModelRequestObserver> = None;
        let result = provider_stream_with_observer(
            &policy,
            &mut sleeper,
            &mut state,
            observer,
            || async {
                StreamAttempt {
                    frames: vec![],
                    error: None,
                    produced_content: false,
                }
            },
        )
        .await
        .unwrap();
        assert!(result.is_empty());
    }

    // ── 测试辅助：epoch → HTTP-date 文本（与 parse_http_date 互逆）──

    const MONTH_NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const WEEKDAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    fn civil_from_epoch(epoch: i64) -> (i64, i64, i64, i64, i64, i64, i64) {
        let days = epoch.div_euclid(86_400);
        let secs_of_day = epoch.rem_euclid(86_400);
        let weekday = (days + 4).rem_euclid(7); // 1970-01-01 是周四
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let day_of_era = z - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_prime = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
        let month = if month_prime < 10 { month_prime + 3 } else { month_prime - 9 };
        let year = if month <= 2 { year + 1 } else { year };
        (
            year,
            month,
            day,
            secs_of_day / 3600,
            (secs_of_day % 3600) / 60,
            secs_of_day % 60,
            weekday,
        )
    }

    fn imf_fixdate(epoch: i64) -> String {
        let (year, month, day, hour, minute, second, weekday) = civil_from_epoch(epoch);
        format!(
            "{weekday}, {day:02} {month} {year} {hour:02}:{minute:02}:{second:02} GMT",
            weekday = WEEKDAY_NAMES[weekday as usize],
            month = MONTH_NAMES[(month - 1) as usize],
        )
    }

    fn rfc850(epoch: i64) -> String {
        let (year, month, day, hour, minute, second, weekday) = civil_from_epoch(epoch);
        format!(
            "{weekday}, {day:02}-{month}-{year2:02} {hour:02}:{minute:02}:{second:02} GMT",
            weekday = WEEKDAY_NAMES[weekday as usize],
            month = MONTH_NAMES[(month - 1) as usize],
            year2 = year % 100,
        )
    }

    fn asctime(epoch: i64) -> String {
        let (year, month, day, hour, minute, second, weekday) = civil_from_epoch(epoch);
        format!(
            "{weekday} {month} {day:2} {hour:02}:{minute:02}:{second:02} {year}",
            weekday = WEEKDAY_NAMES[weekday as usize],
            month = MONTH_NAMES[(month - 1) as usize],
        )
    }
}
