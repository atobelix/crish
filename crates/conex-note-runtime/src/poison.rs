//! Crate 级锁中毒恢复计数（R-01：每 crate 一份；不改恢复模式）。
//!
//! 各模块 `fetch_add` 调用点不变；计数从「每模块独立」变为「crate 聚合」。

use std::sync::atomic::AtomicU64;
#[cfg(test)]
use std::sync::atomic::Ordering;

/// 毒丸恢复计数（B1-1 观测化：本 crate 全部锁中毒恢复次数；
/// 对齐 registry.rs「tracing::error! 成对 + 计数」样板，零新依赖）
pub(crate) static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言用；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}
