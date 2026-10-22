//! 会话缓存跟踪器（P5 S2 / T-36：CacheStatsTracker + RunOutcome.cache_stats）
//!
//! 本模块是 P5 测量层在 session-loop 的接线面。算法真源全部位于
//! `conex-telemetry::cache`（T-35 纯函数模块，叶子约束、协议无关）：
//!
//! - 请求签名 / 基线：`RequestSignature` / `CacheBaseline`（signature.rs）；
//! - 归一化口径：`CacheUsageScalars` → `CacheBreakdownMath`（math.rs，C9 恒等式）；
//! - miss 检测与归因：`MissDetector::detect` + `classify`（miss.rs）；
//! - 冷缓存：`cold_cache_check` / `warm_until` / `is_cold`（cold.rs）。
//!
//! tracker 自身只做状态编排：请求发送前捕获签名 → turn 结束后消费 usage →
//! run 级聚合（[RunCacheStats]，收口移交 `RunOutcome.cache_stats`）→
//! 基线经 [CacheStatsTracker::baseline] 交还调用方（engine 层跨 run 持久化
//! 归 T-40）。
//!
//! 职责边界（P5 §1.3「只测不改」）：只读观测——绝不改变请求字节、绝不触发
//! 重试、绝不干预循环行为。

pub mod eviction;
pub mod hash;
pub mod metrics;
pub mod tracker;
pub mod types;

#[cfg(test)]
mod tests;

pub use self::hash::{build_request_signature, build_request_signature_incremental};
pub(crate) use self::tracker::build_tracker;
pub use self::tracker::CacheStatsTracker;
pub use self::types::{CacheMiss, CacheTrackingConfig};
