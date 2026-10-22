use super::{scalars, tools, tracker};

/// 多 turn 聚合：逐项累加 + 派生占比按聚合值重算 + 样本计数
#[test]
fn record_usage_aggregates_run_stats() {
    let mut t = tracker(0);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 7_000, 1_000, None), 100, 10_100, 1_000)
        .is_none());
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(20_000, 15_000, 2_000, None), 200, 20_200, 2_000)
        .is_none());
    let stats = t.finish();
    assert_eq!(stats.sample_count, 2);
    assert_eq!(stats.prompt_tokens, 30_000);
    assert_eq!(stats.completion_tokens, 300);
    assert_eq!(stats.total_tokens, 30_300);
    assert_eq!(stats.cache_read_tokens, 22_000);
    assert_eq!(stats.cache_write_tokens, 3_000);
    // Included：miss = prompt - read - write（2000 + 3000）
    assert_eq!(stats.cache_miss_tokens, 5_000);
    assert_eq!(stats.hit_ratio, Some(22_000.0 / 30_000.0));
    assert_eq!(stats.missed_tokens, 0);
}

/// 无样本 → 全零统计 + 占比 None（前端隐藏而非显示 0%）
#[test]
fn finish_without_samples_is_all_zero() {
    let stats = tracker(0).finish();
    assert_eq!(stats.sample_count, 0);
    assert_eq!(stats.prompt_tokens, 0);
    assert_eq!(stats.hit_ratio, None);
    assert_eq!(stats.warm_until_ms, None);
}
