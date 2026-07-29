//! 全局 LRU 缓存: moka + 字节预算。
//!
//! 被 highlight.rs (代码高亮缓存) 和 renderer.rs (markdown 渲染缓存) 共享。
//! 字符串 UTF-16 字节估算 (len * 2) 与 JS LruCache 估算口径一致。

use moka::sync::Cache;
use std::sync::Arc;

/// 缓存条目数上限。
pub const CACHE_MAX_ENTRIES: u64 = 2048;

/// 缓存字节预算: 32MB (按 UTF-16 估算,即实际 ~16MB UTF-8)。
pub const CACHE_BUDGET_BYTES: u32 = 32 * 1024 * 1024;

/// 单条目字节上限: 超过则不缓存,避免一条巨物独占预算。
pub const CACHE_ENTRY_MAX_BYTES: u32 = 1024 * 1024;

/// 渲染缓存: key = String, value = Arc<String>。
pub type RenderCache = Cache<String, Arc<String>>;

/// 字节估算: UTF-16 风格 (len * 2),与 JS LruCache.estimateSize 一致。
fn estimate_size<K: AsRef<str>, V: AsRef<str>>(key: &K, value: &V) -> u32 {
    let bytes = (key.as_ref().len() + value.as_ref().len()) * 2;
    // 截断到 u32 范围 (4GB),超出的极端情况退化为 u32::MAX
    bytes.try_into().unwrap_or(u32::MAX)
}

/// 全局渲染缓存。
static RENDER_CACHE: once_cell::sync::Lazy<RenderCache> = once_cell::sync::Lazy::new(|| {
    Cache::builder()
        .max_capacity(CACHE_MAX_ENTRIES)
        .weigher(|k: &String, v: &Arc<String>| -> u32 {
            estimate_size(k, v.as_ref())
        })
        .build()
});

/// 获取全局渲染缓存。
pub fn render_cache() -> &'static RenderCache {
    &RENDER_CACHE
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
}
