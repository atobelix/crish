//! 重试策略 / 状态 / 决策域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 retry.rs 拆出的实现域（门面 retry.rs re-export 全部公开符号，对外路径不变）：
//! - 重试策略与归一化（[RetryPolicy] / [RetryState] / [RetryDecision]）
//! - 退避与合并等待计算（[retry_delay_ms] / [choose_retry_delay_ms]）
//! - 重试判定（[should_retry]：仅瞬态类可重试，次数/预算上限钳制）
//! - Retry-After 解析（[parse_retry_after_ms]：秒数 / HTTP-date 三种格式）

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use conex_types::error::ProviderErrorKind;

use crate::error::ProviderError;

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
    #[inline]
    pub const fn normalized(&self) -> Self {
        let base_delay_ms = if self.base_delay_ms < 1 {
            1
        } else {
            self.base_delay_ms
        };
        let max_delay_ms = if self.max_delay_ms < base_delay_ms {
            base_delay_ms
        } else {
            self.max_delay_ms
        };
        let total_budget_ms = if self.total_budget_ms < 1 {
            1
        } else {
            self.total_budget_ms
        };
        Self {
            max_retries: self.max_retries,
            base_delay_ms,
            max_delay_ms,
            total_budget_ms,
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

/// 统一判定错误类别是否属于可由传输层退避自愈的 HTTP/RPC 瞬态错误
///
/// - `RateLimit` / `ServerError` / `Timeout` / `Network` 四类瞬态错误返回 `true`；
/// - `ContextLengthExceeded` 虽在分类层标记 retryable，但由上层会话压缩处理，不纳入本退避循环。
#[inline]
pub const fn is_transient_kind(kind: ProviderErrorKind) -> bool {
    matches!(
        kind,
        ProviderErrorKind::RateLimit
            | ProviderErrorKind::ServerError
            | ProviderErrorKind::Timeout
            | ProviderErrorKind::Network
    )
}

/// 统一判定 [ProviderError] 是否属于可重试的 HTTP/RPC 瞬态错误
#[inline]
pub fn is_transient_error(err: &ProviderError) -> bool {
    is_transient_kind(err.kind())
}

#[inline]
const fn compute_normalized_backoff(normalized: &RetryPolicy, attempt: u32) -> Duration {
    let attempt_clamped = if attempt < 1 { 1 } else { attempt };
    let exponent = if attempt_clamped - 1 > 62 {
        62
    } else {
        attempt_clamped - 1
    };
    let backoff = normalized.base_delay_ms.saturating_mul(1u64 << exponent);
    let clamped = if backoff > normalized.max_delay_ms {
        normalized.max_delay_ms
    } else {
        backoff
    };
    Duration::from_millis(clamped)
}

/// 指数退避（attempt 从 1 起；对齐 retryDelayMs，openai-retry.ts:104-119）
///
/// `min(max_delay, base * 2^(attempt-1))`；指数上限 62 防溢出（saturating）。
#[inline]
pub fn retry_delay_ms(policy: &RetryPolicy, attempt: u32) -> Duration {
    let policy = policy.normalized();
    compute_normalized_backoff(&policy, attempt)
}

/// 合并等待：Retry-After 与退避取大，再钳 max_delay 与剩余预算
/// （对齐 chooseRetryDelayMs，openai-retry.ts:161-175）
#[inline]
pub fn choose_retry_delay_ms(
    policy: &RetryPolicy,
    attempt: u32,
    retry_after: Option<Duration>,
    remaining_budget_ms: Option<u64>,
) -> Duration {
    let policy = policy.normalized();
    choose_normalized_retry_delay(&policy, attempt, retry_after, remaining_budget_ms)
}

#[inline]
fn choose_normalized_retry_delay(
    normalized: &RetryPolicy,
    attempt: u32,
    retry_after: Option<Duration>,
    remaining_budget_ms: Option<u64>,
) -> Duration {
    let backoff = compute_normalized_backoff(normalized, attempt);
    let wait = match retry_after {
        Some(after) => backoff.max(after),
        None => backoff,
    };
    let wait = wait.min(Duration::from_millis(normalized.max_delay_ms));
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
    if !is_transient_error(err) {
        return None;
    }
    let policy = policy.normalized();
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
    let delay = choose_normalized_retry_delay(
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
#[inline]
fn clamp_retry_after(duration: Duration) -> Duration {
    duration.min(Duration::from_millis(MAX_RETRY_AFTER_MS))
}

/// HTTP-date 解析（RFC 7231 §7.1.1.1）：IMF-fixdate、RFC 850、asctime 三种格式，
/// 返回 UNIX epoch 秒。栈上定长数组零分配解析，不引入堆 Vec。
///
/// - `Sun, 06 Nov 1994 08:49:37 GMT`（IMF-fixdate）
/// - `Sunday, 06-Nov-94 08:49:37 GMT`（RFC 850，2 位年份按 70 分界）
/// - `Sun Nov  6 08:49:37 1994`（asctime）
fn parse_http_date(value: &str) -> Option<i64> {
    let mut token_buf = [""; 6];
    let mut token_len = 0usize;
    for token in value.split([' ', '\t', ',']).filter(|t| !t.is_empty()) {
        if token_len >= token_buf.len() {
            return None;
        }
        token_buf[token_len] = token;
        token_len += 1;
    }
    let (day, month, year, time) = match &token_buf[..token_len] {
        // IMF-fixdate：[星期,] 日 月 年 时:分:秒 GMT
        [_, day, month, year, time, "GMT"] => (
            day.parse::<u32>().ok()?,
            month_index(month)?,
            year.parse::<i64>().ok()?,
            *time,
        ),
        // RFC 850：[星期,] 日-月-年 时:分:秒 GMT
        [_, date, time, "GMT"] => {
            let mut parts = date.split('-');
            let day = parts.next()?.parse::<u32>().ok()?;
            let month = month_index(parts.next()?)?;
            let yy = parts.next()?.parse::<i64>().ok()?;
            let year = if yy >= 70 { 1900 + yy } else { 2000 + yy };
            (day, month, year, *time)
        }
        // asctime：星期 月 日 时:分:秒 年（日可为空格补位）
        [_, month, day, time, year] => (
            day.parse::<u32>().ok()?,
            month_index(month)?,
            year.parse::<i64>().ok()?,
            *time,
        ),
        _ => return None,
    };
    let (hour, minute, second) = parse_time(time)?;
    // F3-11：year 先钳到合理区间 [1970, 9999] 再算天数——极端年份
    // （provider 可控头部，如 year=i64::MAX）会在 days_from_civil 的
    // `era * 146_097` 与 `days * 86_400` 溢出（debug panic / release
    // 回绕为负）。钳制后远超 1970 的时刻仍远超 5 分钟上限，由
    // clamp_retry_after 收敛；远早于 1970 的时刻视为已过 → 0，语义不变。
    let year = year.clamp(1970, 9999);
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64)
}

/// 月份缩写 → 1-12（零分配 ASCII 忽略大小写匹配）
fn month_index(token: &str) -> Option<u32> {
    const MONTHS: &[&str] = &[
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    MONTHS
        .iter()
        .position(|month| month.eq_ignore_ascii_case(token))
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
