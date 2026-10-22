use super::*;

// ── T-16（P2 步骤 4a）：metadata.cacheBreakdown 派生（C9 口径，camelCase）────

/// 构造带 usage 的停止事件（read/write/miss 齐备）
fn stop_with_usage(miss: Option<u64>) -> ProviderStreamEvent {
    ProviderStreamEvent::Stop {
        reason: StopReason::Stop,
        error: None,
        error_kind: None,
        usage: Some(ProviderUsage {
            prompt_tokens: Some(100),
            completion_tokens: Some(20),
            total_tokens: Some(120),
            cache_read_tokens: Some(70),
            cache_write_tokens: Some(10),
            cache_miss_tokens: miss,
            reasoning_tokens: None,
        }),
    }
}

/// T-16：默认口径（Included，consume/ConsumeBuilder::new 缺省）下
/// metadata 派生 cacheBreakdown，键为 camelCase（inputTotal）
#[test]
fn metadata_cache_breakdown_included_default() {
    let result = consume(
        vec![ProviderStreamEvent::text("你好"), stop_with_usage(None)],
        false,
    );
    let breakdown = result
        .metadata
        .get("cacheBreakdown")
        .expect("默认口径（Included）应派生 cacheBreakdown")
        .clone();
    assert_eq!(breakdown["read"], 70);
    assert_eq!(breakdown["write"], 10);
    assert_eq!(
        breakdown["miss"], 20,
        "Included：miss = prompt - read - write"
    );
    assert_eq!(
        breakdown["inputTotal"], 100,
        "Included：inputTotal = prompt"
    );
    // 恒等式（C9）：input_total = miss + read + write
    assert_eq!(
        breakdown["miss"].as_u64().unwrap()
            + breakdown["read"].as_u64().unwrap()
            + breakdown["write"].as_u64().unwrap(),
        breakdown["inputTotal"].as_u64().unwrap()
    );
}

/// T-16：Excluded 口径（适配层显式传入，Anthropic/Gemini 系）下
/// miss = prompt、inputTotal = prompt + read + write
#[test]
fn metadata_cache_breakdown_excluded_via_builder() {
    let mut builder = ConsumeBuilder::new().usage_accounting(CacheAccounting::Excluded);
    builder.push(ProviderStreamEvent::text("你好"));
    builder.push(stop_with_usage(None));
    let result = builder.finish(false);
    let breakdown = result.metadata["cacheBreakdown"].clone();
    assert_eq!(breakdown["miss"], 100, "Excluded：miss = prompt");
    assert_eq!(
        breakdown["inputTotal"], 180,
        "Excluded：inputTotal = prompt + read + write"
    );
    assert_eq!(breakdown["read"], 70);
    assert_eq!(breakdown["write"], 10);
}

/// T-16：DeepSeek 顶层 miss 优先（服务端报告值直接采用，不依赖口径推导）
#[test]
fn metadata_cache_breakdown_deepseek_miss_priority() {
    // 显式 Excluded 也应尊重服务端报告的 miss 值（C9：miss 报告值优先）
    let mut builder = ConsumeBuilder::new().usage_accounting(CacheAccounting::Excluded);
    builder.push(ProviderStreamEvent::text("你好"));
    builder.push(stop_with_usage(Some(15)));
    let result = builder.finish(false);
    let breakdown = result.metadata["cacheBreakdown"].clone();
    assert_eq!(breakdown["miss"], 15, "DeepSeek 顶层 miss 字段优先");
    assert_eq!(breakdown["inputTotal"], 180);
}

/// T-16：prompt 缺失 → 不写 cacheBreakdown（无输入侧数据可派）
#[test]
fn metadata_omits_cache_breakdown_without_prompt() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("你好"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Stop,
                error: None,
                error_kind: None,
                usage: Some(ProviderUsage {
                    completion_tokens: Some(20),
                    ..ProviderUsage::default()
                }),
            },
        ],
        false,
    );
    assert!(
        result.metadata.get("cacheBreakdown").is_none(),
        "prompt 缺失不派生"
    );
    assert!(result.metadata.get("usage").is_some(), "usage 原样保留");
}

/// T-16：无 usage 的 Stop → 不写 cacheBreakdown
#[test]
fn metadata_omits_cache_breakdown_without_usage() {
    let result = consume(
        vec![
            ProviderStreamEvent::text("你好"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        false,
    );
    assert!(result.metadata.get("cacheBreakdown").is_none());
}

/// T-16：CacheBreakdown 序列化形状（camelCase，与 agent-provider 同形）
#[test]
fn cache_breakdown_serializes_camel_case() {
    let breakdown = CacheBreakdown {
        read: 1,
        write: 2,
        miss: 3,
        input_total: 6,
    };
    let value = serde_json::to_value(breakdown).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "read": 1, "write": 2, "miss": 3, "inputTotal": 6 })
    );
    assert!(value.get("input_total").is_none(), "禁止 snake_case 键");
}
