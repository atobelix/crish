use crate::events::{merge_usage_shards, CacheAccounting, CacheBreakdown, ProviderUsage};

#[test]
fn usage_serializes_camel_case() {
    let usage = ProviderUsage {
        prompt_tokens: Some(10),
        completion_tokens: None,
        total_tokens: Some(20),
        cache_read_tokens: Some(5),
        cache_write_tokens: None,
        cache_miss_tokens: Some(4),
        reasoning_tokens: Some(8),
    };
    let value = serde_json::to_value(&usage).unwrap();
    assert_eq!(value["promptTokens"], 10);
    assert_eq!(value["totalTokens"], 20);
    assert_eq!(value["cacheReadTokens"], 5);
    assert_eq!(value["cacheMissTokens"], 4);
    assert_eq!(value["reasoningTokens"], 8);
    assert!(value.get("completionTokens").is_none(), "None 字段应省略");
    let back: ProviderUsage = serde_json::from_value(value).unwrap();
    assert_eq!(usage, back);
}

#[test]
fn usage_omits_none_cache_miss_tokens() {
    let usage = ProviderUsage {
        prompt_tokens: Some(10),
        ..ProviderUsage::default()
    };
    let value = serde_json::to_value(&usage).unwrap();
    assert!(
        value.get("cacheMissTokens").is_none(),
        "None 的 cacheMissTokens 应省略"
    );
}

// ---- cache_breakdown：两种口径 + miss 优先值 + 钳 0（P2 §3.3 D、§5.1 测试组） ----

fn usage_with_parts(prompt: Option<u64>, read: Option<u64>, write: Option<u64>) -> ProviderUsage {
    ProviderUsage {
        prompt_tokens: prompt,
        cache_read_tokens: read,
        cache_write_tokens: write,
        ..ProviderUsage::default()
    }
}

#[test]
fn cache_breakdown_included() {
    // Included（OpenAI 系）：miss = prompt - read - write、input_total = prompt
    let usage = usage_with_parts(Some(100), Some(70), Some(10));
    let breakdown = usage.cache_breakdown(CacheAccounting::Included).unwrap();
    assert_eq!(
        breakdown,
        CacheBreakdown {
            read: 70,
            write: 10,
            miss: 20,
            input_total: 100
        }
    );
}

#[test]
fn cache_breakdown_excluded() {
    // Excluded（Anthropic/Gemini 系）：miss = prompt、input_total = prompt + read + write
    let usage = usage_with_parts(Some(100), Some(70), Some(10));
    let breakdown = usage.cache_breakdown(CacheAccounting::Excluded).unwrap();
    assert_eq!(
        breakdown,
        CacheBreakdown {
            read: 70,
            write: 10,
            miss: 100,
            input_total: 180
        }
    );
}

#[test]
fn cache_breakdown_none_read_write_are_zero() {
    // read/write 为 None 按 0 处理：两种口径下 miss/input_total 均等于 prompt
    let usage = usage_with_parts(Some(100), None, None);
    assert_eq!(
        usage.cache_breakdown(CacheAccounting::Included).unwrap(),
        CacheBreakdown {
            read: 0,
            write: 0,
            miss: 100,
            input_total: 100
        }
    );
    assert_eq!(
        usage.cache_breakdown(CacheAccounting::Excluded).unwrap(),
        CacheBreakdown {
            read: 0,
            write: 0,
            miss: 100,
            input_total: 100
        }
    );
}

#[test]
fn cache_breakdown_miss_field_priority() {
    // DeepSeek 顶层 miss 字段优先：直接取服务端报告值，不依赖推导（两种口径一致）
    let usage = ProviderUsage {
        cache_miss_tokens: Some(15),
        ..usage_with_parts(Some(100), Some(70), Some(10))
    };
    assert_eq!(
        usage.cache_breakdown(CacheAccounting::Included).unwrap(),
        CacheBreakdown {
            read: 70,
            write: 10,
            miss: 15,
            input_total: 100
        }
    );
    assert_eq!(
        usage.cache_breakdown(CacheAccounting::Excluded).unwrap(),
        CacheBreakdown {
            read: 70,
            write: 10,
            miss: 15,
            input_total: 180
        }
    );
}

#[test]
fn cache_breakdown_clamps_negative_miss() {
    // 推导结果为负时钳 0：prompt=10、read=15 → Included miss = 0
    let usage = usage_with_parts(Some(10), Some(15), Some(5));
    assert_eq!(
        usage.cache_breakdown(CacheAccounting::Included).unwrap(),
        CacheBreakdown {
            read: 15,
            write: 5,
            miss: 0,
            input_total: 10
        }
    );
}

#[test]
fn cache_breakdown_requires_prompt() {
    // prompt 缺失时无输入侧数据可派 → None
    let usage = usage_with_parts(None, Some(70), Some(10));
    assert_eq!(usage.cache_breakdown(CacheAccounting::Included), None);
    assert_eq!(usage.cache_breakdown(CacheAccounting::Excluded), None);
}

// ---- merge_usage_shards：max 语义 + 后到优先 + total 重算（P2 §3.3 D、§5.1 测试组） ----

#[test]
fn merge_usage_shards_input_max_not_overridden_by_zero() {
    // 输入侧取 max：next 传 0 不覆盖 prev 的 100；read/write 同理防 0 覆盖
    let prev = usage_with_parts(Some(100), Some(50), Some(20));
    let next = usage_with_parts(Some(0), Some(60), Some(0));
    let merged = merge_usage_shards(&prev, &next);
    assert_eq!(
        merged.prompt_tokens,
        Some(100),
        "next 传 0 不应覆盖 prev 的 100"
    );
    assert_eq!(merged.cache_read_tokens, Some(60), "read 取较大值");
    assert_eq!(merged.cache_write_tokens, Some(20), "write 取较大值");
}

#[test]
fn merge_usage_shards_input_fallback_and_miss_max() {
    // next 缺失时回退 prev；cache_miss_tokens 与输入侧同取 max
    let prev = ProviderUsage {
        cache_miss_tokens: Some(30),
        ..usage_with_parts(Some(100), Some(50), None)
    };
    let next = usage_with_parts(None, None, Some(0));
    let merged = merge_usage_shards(&prev, &next);
    assert_eq!(merged.prompt_tokens, Some(100));
    assert_eq!(merged.cache_read_tokens, Some(50));
    assert_eq!(merged.cache_write_tokens, Some(0));
    assert_eq!(merged.cache_miss_tokens, Some(30), "miss 取较大值");

    let next_lower = usage_with_parts(Some(80), None, None);
    assert_eq!(
        merge_usage_shards(&prev, &next_lower).prompt_tokens,
        Some(100)
    );
}

#[test]
fn merge_usage_shards_completion_last_wins() {
    // completion 侧后到优先：next 存在时取 next，缺失回退 prev
    let mut prev = usage_with_parts(Some(100), None, None);
    prev.completion_tokens = Some(5);
    let mut next = usage_with_parts(Some(0), None, None);
    next.completion_tokens = Some(8);
    let merged = merge_usage_shards(&prev, &next);
    assert_eq!(merged.completion_tokens, Some(8), "completion 后到优先");

    let next_none = usage_with_parts(Some(90), None, None);
    assert_eq!(
        merge_usage_shards(&prev, &next_none).completion_tokens,
        Some(5),
        "next 缺失时回退 prev"
    );
}

#[test]
fn merge_usage_shards_total_recompute() {
    // total 恒由合并后 prompt+completion 重算，忽略分片显式 total
    let mut prev = usage_with_parts(Some(100), None, None);
    prev.completion_tokens = Some(5);
    prev.total_tokens = Some(105);
    let mut next = usage_with_parts(Some(0), None, None);
    next.completion_tokens = Some(10);
    next.total_tokens = Some(10);
    let merged = merge_usage_shards(&prev, &next);
    assert_eq!(merged.total_tokens, Some(110), "total 重算 = 100 + 10");
}

#[test]
fn merge_usage_shards_total_fallback_to_explicit() {
    // prompt/completion 均缺失时回退显式 total（next 优先，其次 prev）
    let mut prev = usage_with_parts(None, Some(50), None);
    prev.total_tokens = Some(7);
    let mut next = usage_with_parts(None, Some(60), None);
    next.total_tokens = Some(9);
    assert_eq!(merge_usage_shards(&prev, &next).total_tokens, Some(9));
    assert_eq!(
        merge_usage_shards(&next, &prev).total_tokens,
        Some(7),
        "prev 的显式 total 兜底"
    );
}
