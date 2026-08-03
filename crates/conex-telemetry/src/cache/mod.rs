//! 缓存计量与浪费审计纯函数模块（P5 S1 / T-35）。
//!
//! 本模块是 `conex-telemetry` 的新子模块，严格遵守叶子约束：
//!
//! - 只依赖 std，不依赖 agent-provider / session-loop 等上层 crate；
//! - 所有输入均为标量（`u64` / `i64` / `&RequestSignature` 等），协议无关；
//!   engine / session-loop 负责把 `ProviderUsage` 等产物映射为标量再喂给本模块。
//!
//! 口径真源（C9）：P2 的 `cache_breakdown`
//! （`crates/agent-provider/src/events.rs:93-106`）——恒等式
//! `input_total = miss + read + write`；Included 系 `input_total = prompt`，
//! Excluded 系 `input_total = prompt + read + write`。本模块只做纯函数复刻，
//! 供遥测侧独立消费，禁止在别处"各算各的"。
//!
//! 设计来源：
//!
//! - miss 检测：pi `detectMiss = min(prev, cur) - cacheRead` + 1024 噪声地板
//!   （pi-cache-analysis.md:269-278）；
//! - 断裂判定：Claude Code 两阶段 `cacheRead 下降 >5% 且 >2000 token`
//!   （claude-code-cache-analysis.md:395-410）；
//! - 归因分类：jcode `KvCacheMissReason` 收缩为 8 类
//!   （jcode-cache-analysis.md:102-117）；
//! - 冷缓存预警：jcode TTL 表 + 空闲检测 + 预估重发量
//!   （jcode-cache-analysis.md:138-149）。

pub mod cold;
pub mod math;
pub mod miss;
pub mod signature;

pub use cold::{cold_cache_check, is_cold, warm_until, ColdCacheWarning};
pub use math::{CacheAccountingKind, CacheBreakdownMath, CacheUsageScalars};
pub use miss::{
    classify, MissDetector, MissReason, BREAK_MIN_TOKENS, BREAK_PCT,
    LOW_HIT_RATIO_PCT, NOISE_FLOOR_TOKENS, WARN_MISSED_COST_USD, WARN_MISSED_TOKENS,
};
pub use signature::{CacheBaseline, RequestSignature};
