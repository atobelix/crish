//! 渲染结果 LRU 缓存：moka + 字节预算，按渲染变体隔离。
//!
//! - `RenderResult` 缓存与代码高亮缓存分离（高亮缓存在 `highlight.rs` 自持）。
//! - chat / document 两个变体各一个缓存实例，避免同一文本在不同变体下命中
//!   错误结果；也保留 `&str` 零拷贝查表。
//! - 字节预算来自 `conex_shared::perf_budget`，moka 的 `max_capacity` 在
//!   设置 weigher 后表示加权总大小上限。

use moka::sync::Cache;
use std::sync::Arc;

use crate::types::{MarkdownVariant, RenderResult};

pub use conex_shared::perf_budget::{
    RUST_MARKDOWN_CACHE_BUDGET_BYTES as CACHE_BUDGET_BYTES,
    RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES as CACHE_ENTRY_MAX_BYTES,
};

/// 渲染缓存：key = 原文, value = Arc<RenderResult>。
pub type RenderCache = Cache<String, Arc<RenderResult>>;

/// 字节估算：UTF-16 风格（len * 2），与 JS LruCache 估算口径一致。
fn estimate_size(key: &str, value: &RenderResult) -> u32 {
    let bytes = (key.len() + value.html.len() + 8) * 2;
    bytes.try_into().unwrap_or(u32::MAX)
}

fn build_byte_budget_cache() -> RenderCache {
    Cache::builder()
        .max_capacity(CACHE_BUDGET_BYTES as u64)
        .weigher(|k: &String, v: &Arc<RenderResult>| -> u32 { estimate_size(k, v) })
        .build()
}

static CHAT_RENDER_CACHE: once_cell::sync::Lazy<RenderCache> =
    once_cell::sync::Lazy::new(build_byte_budget_cache);
static DOCUMENT_RENDER_CACHE: once_cell::sync::Lazy<RenderCache> =
    once_cell::sync::Lazy::new(build_byte_budget_cache);

/// 获取指定变体的全局渲染缓存。
pub fn render_cache_for(variant: MarkdownVariant) -> &'static RenderCache {
    match variant {
        MarkdownVariant::Chat => &CHAT_RENDER_CACHE,
        MarkdownVariant::Document => &DOCUMENT_RENDER_CACHE,
    }
}

/// 借用切片 `&str` 零拷贝查询渲染缓存。
#[inline]
pub fn get_render_cached(
    variant: MarkdownVariant,
    key: &str,
) -> Option<Arc<RenderResult>> {
    render_cache_for(variant).get(key)
}

/// 写入全局渲染缓存（预检查单条目字节预算）。
#[inline]
pub fn insert_render_cached(
    variant: MarkdownVariant,
    key: &str,
    value: Arc<RenderResult>,
) -> bool {
    if entry_within_budget(key, &value) {
        render_cache_for(variant).insert(key.to_string(), value);
        true
    } else {
        false
    }
}

/// 清空两个变体的渲染缓存。
pub fn clear_render_caches() {
    render_cache_for(MarkdownVariant::Chat).invalidate_all();
    render_cache_for(MarkdownVariant::Document).invalidate_all();
}

/// 判断单条目是否在字节预算内（避免插入巨物）。
pub fn entry_within_budget(key: &str, value: &RenderResult) -> bool {
    let bytes = (key.len() + value.html.len() + 8) * 2;
    bytes <= CACHE_ENTRY_MAX_BYTES as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RenderResult;

    fn result(html: &str) -> Arc<RenderResult> {
        Arc::new(RenderResult {
            html: html.to_string(),
            truncated: false,
        })
    }

    #[test]
    fn cache_returns_inserted_value() {
        let cache = render_cache_for(MarkdownVariant::Chat);
        cache.insert("k1".to_string(), result("v1"));
        let got = cache.get("k1");
        assert_eq!(got.map(|v| v.html.clone()).as_deref(), Some("v1"));
    }

    #[test]
    fn variants_are_isolated() {
        let key = "same-text";
        insert_render_cached(MarkdownVariant::Chat, key, result("<p>chat</p>"));
        insert_render_cached(
            MarkdownVariant::Document,
            key,
            result("<p>document</p>"),
        );
        assert_eq!(
            get_render_cached(MarkdownVariant::Chat, key)
                .map(|v| v.html.clone())
                .as_deref(),
            Some("<p>chat</p>")
        );
        assert_eq!(
            get_render_cached(MarkdownVariant::Document, key)
                .map(|v| v.html.clone())
                .as_deref(),
            Some("<p>document</p>")
        );
    }

    #[test]
    fn entry_within_budget_caps_large_entries() {
        assert!(entry_within_budget("k", &result("v")));
        let big = "x".repeat(CACHE_ENTRY_MAX_BYTES as usize);
        assert!(!entry_within_budget("k", &result(&big)));
    }
}
