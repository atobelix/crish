//! 缓存运行统计指标与冷缓存预警（P5 §3.4.4 / §3.4.5）

use conex_telemetry::cache::{cold_cache_check, is_cold, warm_until, ColdCacheWarning};
use conex_types::events::RunCacheStats;

use super::tracker::CacheStatsTracker;

impl CacheStatsTracker {
    /// 冷缓存预警判定（请求启动路径，P5 §3.4.4）：无基线 / 未超 TTL /
    /// TTL 未知（调用方传 0 时按 ttl_seconds == 0 不判定——P5 约定 TTL
    /// 查询失败不提示，见函数注释）→ None
    ///
    /// 口径登记（2026-08-09 遥测零消费清理，DEEPCHECK-05 #5）：本方法是
    /// **run 内**路径（消费当前 run 的基线），生产侧冷缓存预警现由 engine
    /// 跨 run 路径承担——engine 已统一直接消费 telemetry 纯函数
    /// [`cold_cache_check`] / [`is_cold`]（engine.rs `cold_cache_warning_event`），
    /// 本方法与之一体（同一纯函数底座），待跨 run 基线续接（session-loop
    /// 侧）接线后成为 run 启动路径消费点。
    pub fn cold_cache_check(&self, now_ms: u64) -> Option<ColdCacheWarning> {
        if self.ttl_seconds == 0 {
            return None;
        }
        cold_cache_check(self.baseline.as_ref(), now_ms, self.ttl_seconds)
    }

    /// 缓存温暖截止时刻（毫秒时间戳）：**最后一次完成时刻 + ttl × 1000**；
    /// 无基线或 TTL 未知（0）→ None（与 [Self::finish] 的 warm_until_ms 口径一致，
    /// 截止锚定基线而非查询时刻，避免同一缓存条目到期时间随询问时间漂移）。
    pub fn warm_until_ms(&self, _now_ms: u64) -> Option<i64> {
        self.baseline.as_ref().and_then(|b| {
            (self.ttl_seconds > 0).then(|| warm_until(b.completed_at_ms, self.ttl_seconds))
        })
    }

    /// 当前是否已冷（`now` 超过温暖截止；无基线 / TTL 未知 → false）
    pub fn is_cold(&self, now_ms: u64) -> bool {
        self.warm_until_ms(now_ms)
            .is_some_and(|warm| is_cold(now_ms, warm))
    }

    /// run 收口：产出 run 级缓存统计（`RunOutcome.cache_stats` 载荷；
    /// 无任何 usage 样本时全零 + 占比 None——前端隐藏而非显示 0%）
    pub fn finish(self) -> RunCacheStats {
        let stats = self.run_stats.unwrap_or_default();
        RunCacheStats {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            total_tokens: self.total_tokens,
            cache_read_tokens: stats.read,
            cache_write_tokens: stats.write,
            cache_miss_tokens: stats.miss,
            sample_count: self.sample_count,
            hit_ratio: stats.hit_ratio,
            write_ratio: stats.write_ratio,
            missed_tokens: self.missed_tokens,
            warm_until_ms: self
                .baseline
                .as_ref()
                .and_then(|b| {
                    (self.ttl_seconds > 0).then(|| {
                        u64::try_from(warm_until(b.completed_at_ms, self.ttl_seconds)).ok()
                    })
                })
                .flatten(),
        }
    }
}
