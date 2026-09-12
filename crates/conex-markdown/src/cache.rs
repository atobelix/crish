//! 全局 LRU 缓存: moka + 字节预算。
//!
//! 被 highlight.rs (代码高亮缓存) 和 renderer.rs (markdown 渲染缓存) 共享。
//! 字符串 UTF-16 字节估算 (len * 2) 与 JS LruCache 估算口径一致。
//!
//! **容量语义（T-D1-C / U-MOKA / D1-E5）**：moka 在设置 `weigher` 后，
//! `max_capacity` 表示**加权总大小上限**（不是条目数）。因此 builder
//! 必须使用 `max_capacity(CACHE_BUDGET_BYTES as u64)`——字节预算唯一语义。
//! 旧路径 `max_capacity(CACHE_MAX_ENTRIES=2048)` + 字节 weigher 会把有效
//! 预算压成 ~2KB 假预算，已删除。

use moka::sync::Cache;
use std::sync::Arc;

// D0/U-BUDGET：字节预算**定义**收敛至 conex-shared::perf_budget（仅 re-export）。
// builder（max_capacity 字节语义 / weigher）由 T-D1-C / U-MOKA 维护，本维不动。
/// 缓存字节预算: 32MB (按 UTF-16 估算,即实际 ~16MB UTF-8)。
///
/// T-D1-C：此常量必须出现在两个 builder 的 `max_capacity` 中
/// （weigher 语义下 = 加权总大小上限）。禁止回退到条目数常量。
pub use conex_shared::perf_budget::{
    RUST_MARKDOWN_CACHE_BUDGET_BYTES as CACHE_BUDGET_BYTES,
    RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES as CACHE_ENTRY_MAX_BYTES,
};

/// 渲染缓存: key = String, value = Arc<String>。
pub type RenderCache = Cache<String, Arc<String>>;

/// 字节估算: UTF-16 风格 (len * 2),与 JS LruCache.estimateSize 一致。
fn estimate_size<K: AsRef<str>, V: AsRef<str>>(key: &K, value: &V) -> u32 {
    let bytes = (key.as_ref().len() + value.as_ref().len()) * 2;
    // 截断到 u32 范围 (4GB),超出的极端情况退化为 u32::MAX
    bytes.try_into().unwrap_or(u32::MAX)
}

/// 构建带字节预算语义的 moka 缓存（weigher 存在时 max_capacity = 权重和上限）。
///
/// T-D1-C：单一构造路径——两个全局缓存共用，杜绝「条目数 + 字节 weigher」
/// 混用回潮。测试可传入更小的 `budget_bytes` 验证驱逐语义。
fn build_byte_budget_cache(budget_bytes: u64) -> Cache<String, Arc<String>> {
    Cache::builder()
        .max_capacity(budget_bytes)
        .weigher(|k: &String, v: &Arc<String>| -> u32 { estimate_size(k, v.as_ref()) })
        .build()
}

/// 全局渲染缓存。
static RENDER_CACHE: once_cell::sync::Lazy<RenderCache> =
    once_cell::sync::Lazy::new(|| build_byte_budget_cache(CACHE_BUDGET_BYTES as u64));

/// 获取全局渲染缓存。
pub fn render_cache() -> &'static RenderCache {
    &RENDER_CACHE
}

/// 高亮缓存（1C-8：与渲染缓存分离）。
///
/// 原先 highlight.rs 与 renderer.rs 共用同一 `RENDER_CACHE`，
/// key 格式不同（高亮 `lang:code` vs 渲染原文）——高亮大量命中会驱逐渲染
/// 缓存条目，反之亦然。分离为独立 moka 实例后两者独立淘汰，互不干扰，命中率提升。
pub type HighlightCache = Cache<String, Arc<String>>;

static HIGHLIGHT_CACHE: once_cell::sync::Lazy<HighlightCache> =
    once_cell::sync::Lazy::new(|| build_byte_budget_cache(CACHE_BUDGET_BYTES as u64));

/// 获取全局高亮缓存（1C-8）。
pub fn highlight_cache() -> &'static HighlightCache {
    &HIGHLIGHT_CACHE
}

/// 判断单条目是否在字节预算内 (用于预检查,避免插入巨物)。
pub fn entry_within_budget(key: &str, value: &str) -> bool {
    let bytes = (key.len() + value.len()) * 2;
    bytes <= CACHE_ENTRY_MAX_BYTES as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_returns_inserted_value() {
        let cache = render_cache();
        cache.insert("k1".to_string(), Arc::new("v1".to_string()));
        let got = cache.get(&"k1".to_string());
        assert_eq!(got.as_deref().map(|s| s.as_str()), Some("v1"));
    }

    #[test]
    fn entry_within_budget_caps_large_entries() {
        let small_key = "k";
        let small_val = "v";
        assert!(entry_within_budget(small_key, small_val));

        let big_val = "x".repeat(CACHE_ENTRY_MAX_BYTES as usize);
        assert!(!entry_within_budget(small_key, &big_val));
    }

    /// T-D1-C（U-MOKA / N5）：字节预算数量级为 MB 非 KB——
    /// 构造 ≥ 数百 KB 条目集断言仍可多条共存（有效预算不是 ~2KB 假预算）。
    #[test]
    fn multi_kilobyte_entries_coexist_under_byte_budget() {
        // 每条约 200KB 权重（key 100 + value ~100_000 字符 × 2）
        let cache = build_byte_budget_cache(CACHE_BUDGET_BYTES as u64);
        for i in 0..8u32 {
            let key = format!("k{i}");
            let val = "x".repeat(100_000);
            cache.insert(key, Arc::new(val));
        }
        cache.run_pending_tasks();
        // 8 条 × ~200KB ≈ 1.6MB 权重——远超旧假预算 2048，应全部共存
        assert_eq!(
            cache.entry_count(),
            8,
            "数百 KB 级条目集应多条共存（有效预算为 MB 量级）"
        );
        assert!(
            cache.weighted_size() > 1_000_000,
            "weighted_size 应达 MB 量级，而非旧 ~2KB 假预算"
        );
    }

    /// T-D1-C：权重和逼近预算时发生驱逐，weighted_size ≤ 预算。
    #[test]
    fn eviction_keeps_weighted_size_within_budget() {
        // 小预算：400KB（便于单测驱逐，不占 32MB 真实内存）
        let budget: u64 = 400 * 1024;
        let cache = build_byte_budget_cache(budget);
        // 每条约 100KB 权重（key 50 + value 50_000 字符 × 2）
        for i in 0..20u32 {
            let key = format!("evict-{i}");
            let val = "y".repeat(50_000);
            cache.insert(key, Arc::new(val));
        }
        cache.run_pending_tasks();
        // 驱逐后 weighted_size 必须 ≤ 预算（moka 维护权重和上限）
        assert!(
            cache.weighted_size() <= budget,
            "weighted_size ({}) 应 ≤ 预算 ({budget})",
            cache.weighted_size()
        );
        // 条目数应少于插入总数（发生了驱逐）
        assert!(
            cache.entry_count() < 20,
            "超预算插入应触发驱逐，entry_count={}",
            cache.entry_count()
        );
    }

    /// T-D1-C：全局 builder 使用 CACHE_BUDGET_BYTES 字节语义——
    /// 全局缓存能容纳数百 KB 级条目集（负向断言：非 ~2KB 假预算）。
    #[test]
    fn global_cache_uses_byte_budget_semantics() {
        let cache = render_cache();
        // 并行测试可能共享全局缓存——插入后按 key 断言，不断言全局 entry_count
        for i in 0..4u32 {
            let key = format!("global-kb-{i}");
            let val = "z".repeat(100_000);
            cache.insert(key.clone(), Arc::new(val));
            assert!(
                cache.get(&key).is_some(),
                "数百 KB 级条目应可存入全局缓存（字节预算语义）"
            );
        }
        cache.run_pending_tasks();
        assert!(
            cache.weighted_size() > 500_000,
            "全局缓存 weighted_size 应达 MB 量级（非 ~2KB 假预算）"
        );
    }
}
