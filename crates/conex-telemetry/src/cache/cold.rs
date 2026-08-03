//! 冷缓存预警判定（纯函数）。
//!
//! 对齐 jcode 模式：TTL 路由表 + 空闲检测 + 预估重发量
//! （jcode-cache-analysis.md:138-149）。Rust 侧不做后台轮询——冷缓存提示
//! 由前端 tick 驱动（`warm_until_ms` 落 run 快照），本模块只提供纯函数。

use crate::cache::signature::CacheBaseline;

/// 冷缓存预警载荷。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColdCacheWarning {
    /// 该供应商/模型的缓存 TTL（秒）
    pub ttl_seconds: u64,
    /// 距离上次请求完成的空闲时长（毫秒）
    pub idle_ms: u64,
    /// 预估重发 token = 上次请求 input_total（jcode 取 baseline.input_tokens）
    pub resend_estimate: u64,
}

/// 缓存温暖截止时刻（毫秒时间戳）：`now_ms + ttl_secs × 1000`。
///
/// 饱和运算防溢出；返回 `i64` 以便上层以可空字段（DB 列 / 快照字段）存放。
pub fn warm_until(now_ms: u64, ttl_secs: u64) -> i64 {
    let warm = now_ms.saturating_add(ttl_secs.saturating_mul(1000));
    i64::try_from(warm).unwrap_or(i64::MAX)
}

/// 缓存是否已冷：`now_ms` 已**超过**温暖截止时刻（严格大于，与
/// [`cold_cache_check`] 的 `idle > ttl` 口径一致；恰好等于截止时刻仍视为温暖）。
pub fn is_cold(now_ms: u64, warm_until_ms: i64) -> bool {
    (now_ms as i128) > (warm_until_ms as i128)
}

/// 冷缓存预警判定：idle 严格超过 TTL 才预警。
///
/// - 无基线 → None（首轮无缓存可冷）；
/// - `idle <= ttl × 1000` → None（缓存仍温暖）；
/// - `ttl_seconds == 0`（TTL 未知）本函数不特殊处理——按调用方约定，
///   TTL 查询失败（未知厂商）时不应调用本函数（P5 §3.4.4）；
/// - 命中 → resend_estimate = 上次请求 input_total（对齐 jcode app.rs:1827）。
pub fn cold_cache_check(
    baseline: Option<&CacheBaseline>,
    now_ms: u64,
    ttl_seconds: u64,
) -> Option<ColdCacheWarning> {
    let b = baseline?;
    let idle = now_ms.saturating_sub(b.completed_at_ms);
    (idle > ttl_seconds.saturating_mul(1000)).then_some(ColdCacheWarning {
        ttl_seconds,
        idle_ms: idle,
        resend_estimate: b.input_total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::signature::RequestSignature;

    fn baseline(completed_at_ms: u64, input_total: u64) -> CacheBaseline {
        CacheBaseline {
            signature: RequestSignature::default(),
            input_total,
            provider: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            completed_at_ms,
            generation: 0,
        }
    }

    #[test]
    fn warm_until_adds_ttl_seconds() {
        assert_eq!(warm_until(1_000, 60), 61_000);
        assert_eq!(warm_until(0, 5), 5_000);
    }

    #[test]
    fn warm_until_saturates_without_panicking() {
        // 极大值输入不 panic，饱和到 i64::MAX
        assert_eq!(warm_until(u64::MAX, u64::MAX), i64::MAX);
    }

    #[test]
    fn is_cold_boundary_is_strict() {
        let warm = warm_until(10_000, 60); // 70_000
        assert!(!is_cold(10_000, warm)); // 未到截止
        assert!(!is_cold(69_999, warm));
        assert!(!is_cold(70_000, warm)); // 恰好等于截止 → 仍温暖（严格大于）
        assert!(is_cold(70_001, warm)); // 超过 1ms → 已冷
    }

    #[test]
    fn is_cold_negative_warm_until_is_cold() {
        // warm_until_ms 异常为负（历史脏数据）→ 视为已冷
        assert!(is_cold(0, -1));
    }

    #[test]
    fn cold_cache_check_no_baseline_returns_none() {
        assert_eq!(cold_cache_check(None, 1_000_000, 60), None);
    }

    #[test]
    fn cold_cache_check_within_ttl_returns_none() {
        // idle = 60_000 恰好等于 TTL → 不预警（严格大于）
        let b = baseline(0, 12_000);
        assert_eq!(cold_cache_check(Some(&b), 60_000, 60), None);
    }

    #[test]
    fn cold_cache_check_over_ttl_warns_with_resend_estimate() {
        let b = baseline(1_000, 12_000);
        let warning = cold_cache_check(Some(&b), 62_000, 60).expect("应产生预警");
        assert_eq!(warning.ttl_seconds, 60);
        assert_eq!(warning.idle_ms, 61_000);
        // 预估重发量 = 上次请求 input_total
        assert_eq!(warning.resend_estimate, 12_000);
    }

    #[test]
    fn cold_cache_check_idle_zero_never_warns() {
        let b = baseline(1_000, 12_000);
        assert_eq!(cold_cache_check(Some(&b), 1_000, 60), None);
    }
}
