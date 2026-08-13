//! retry.rs 决策域测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 retry.rs `mod tests` 的决策域部分（策略 / 退避 / 决策表 / Retry-After 解析 /
//! 预算耗尽）整段搬入，零删除零合并；测试名与断言形状不变。
//! 日期辅助（civil_from_epoch / imf_fixdate / rfc850 / asctime）随 HTTP-date 测试同迁。

use super::*;
use crate::error::{NetworkSourceKind, ProviderError, StreamErrorKind, TimeoutKind};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
