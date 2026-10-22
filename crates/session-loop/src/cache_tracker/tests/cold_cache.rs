use super::{scalars, tools, tracker};

/// 冷缓存：warm_until_ms = 最后完成时刻 + TTL；超时后 is_cold /
/// cold_cache_check 命中，resend_estimate = 上次 input_total
#[test]
fn finish_reports_warm_until_and_cold_check() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    // 温暖截止 = 1000 + 60s × 1000 = 61_000
    assert_eq!(t.warm_until_ms(0), Some(61_000));
    assert!(!t.is_cold(61_000), "恰好等于截止仍温暖");
    assert!(t.is_cold(61_001));
    let warning = t.cold_cache_check(61_001).expect("超 TTL 必须预警");
    assert_eq!(warning.ttl_seconds, 60);
    assert_eq!(warning.resend_estimate, 10_000);
    let stats = t.finish();
    assert_eq!(stats.warm_until_ms, Some(61_000));
    // TTL 未知（0）→ 不判定（P3 查询失败不提示）
    let mut t2 = tracker(0);
    t2.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t2
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    assert_eq!(t2.warm_until_ms(0), None);
    assert!(!t2.is_cold(u64::MAX));
    assert!(t2.cold_cache_check(u64::MAX).is_none());
}
