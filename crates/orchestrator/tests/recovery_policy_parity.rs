//! recovery_policy 镜像对账（Q10 问题12）：与 agent-provider::retry 同期望值防漂移
//! 镜像源 = `crates/agent-provider/src/retry.rs`（RetryPolicy::default + should_retry 分类 / 退避）
//! 对账文件：`crates/orchestrator/src/recovery_policy.rs` + `crates/orchestrator/src/recovery.rs` 常量
//! 本测试锁定与 retry.rs 同期望值，防止双源漂移；变更 retry.rs 默认值时须同步同步本文件与 recovery_policy.rs。

use conex_types::error::ProviderErrorKind;
use orchestrator::recovery::{
    backoff_delay_ms, is_transient_kind, RecoveryRetryPolicy, RECOVERY_BASE_DELAY_MS,
    RECOVERY_MAX_DELAY_MS, RECOVERY_TOTAL_BUDGET_MS,
};
use std::time::Duration;

/// 镜像默认值：与 `agent-provider/src/retry_decision.rs:32-40` RetryPolicy::default 一致
/// base 750ms / max 8000ms / total 60000ms / max_retries 0
#[test]
fn defaults_match_retry_policy() {
    assert_eq!(RECOVERY_BASE_DELAY_MS, 750, "base_delay 镜像值应与 retry.rs 750 一致");
    assert_eq!(RECOVERY_MAX_DELAY_MS, 8_000, "max_delay 镜像值应与 retry.rs 8000 一致");
    assert_eq!(
        RECOVERY_TOTAL_BUDGET_MS, 60_000,
        "total_budget 镜像值应与 retry.rs 60000 一致"
    );
    let policy = RecoveryRetryPolicy::default();
    assert_eq!(policy.base_delay_ms, RECOVERY_BASE_DELAY_MS);
    assert_eq!(policy.max_delay_ms, RECOVERY_MAX_DELAY_MS);
    assert_eq!(policy.total_budget_ms, RECOVERY_TOTAL_BUDGET_MS);
    assert_eq!(policy.max_retries, 0, "max_retries 镜像 retry.rs 默认 0（显式开启才重试）");
}

/// 退避序列：镜像 retry.rs `retry_delay_ms`（base * 2^(attempt-1) 钳 max_delay）
#[test]
fn backoff_sequence_matches_retry() {
    let policy = RecoveryRetryPolicy::default();
    // attempt 1..4：750 → 1500 → 3000 → 6000；attempt 5 起钳 8000
    assert_eq!(backoff_delay_ms(&policy, 1), Duration::from_millis(750));
    assert_eq!(backoff_delay_ms(&policy, 2), Duration::from_millis(1_500));
    assert_eq!(backoff_delay_ms(&policy, 3), Duration::from_millis(3_000));
    assert_eq!(backoff_delay_ms(&policy, 4), Duration::from_millis(6_000));
    assert_eq!(backoff_delay_ms(&policy, 5), Duration::from_millis(8_000));
    assert_eq!(backoff_delay_ms(&policy, 6), Duration::from_millis(8_000));
    // 指数上限 62 防溢出，仍钳 max_delay
    assert_eq!(backoff_delay_ms(&policy, 100), Duration::from_millis(8_000));
}

/// 瞬态分类：镜像 retry.rs `should_retry` 可重试集（rate-limit / 5xx / 网络 / 超时）
#[test]
fn transient_classification_matches_retry() {
    // 可重试
    assert!(is_transient_kind(ProviderErrorKind::RateLimit));
    assert!(is_transient_kind(ProviderErrorKind::ServerError));
    assert!(is_transient_kind(ProviderErrorKind::Timeout));
    assert!(is_transient_kind(ProviderErrorKind::Network));
    // 不可重试（auth、quota、context_length、payload 等由上层处理，不走重试）
    assert!(!is_transient_kind(ProviderErrorKind::Auth));
    assert!(!is_transient_kind(ProviderErrorKind::Quota));
    assert!(!is_transient_kind(ProviderErrorKind::ContextLengthExceeded));
    assert!(!is_transient_kind(ProviderErrorKind::Unknown));
    // abort 亦不可重试（与 retry.rs 一致）
    assert!(!is_transient_kind(ProviderErrorKind::Aborted));
}
