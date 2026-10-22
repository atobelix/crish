use super::*;

// ===== v2 Schema（R3）：serde 往返 / v1 兼容 / 四价查询 =====

/// v2 结构 serde 往返：四价 + currency + 写免费三态 + 1h 档 + 存储费 +
/// tieredPricing + derivation + 能力位齐全
#[test]
fn v2_entry_serde_roundtrip_full_fields() {
    // 用原始字符串而非 json! 宏（59 字段嵌套超过宏递归上限）
    let raw = r#"{
        "id": "glm-5v-turbo",
        "model": "glm-5v-turbo",
        "apiModel": "glm-5v-turbo",
        "provider": "bigmodel",
        "vendor": "glm",
        "mode": "chat",
        "currency": "CNY",
        "unit": "per_1M",
        "contextWindow": 200000,
        "maxOutputTokens": 131072,
        "inputPrice": 5.0,
        "outputPrice": 22.0,
        "cacheReadPrice": 1.2,
        "cacheWritePrice": 0.0,
        "cacheWriteFree": true,
        "storagePricePer1mHour": 0.0,
        "storagePriceFreeUntil": "2026-08-31",
        "reasoningPrice": 22.0,
        "priceStatus": "derived",
        "derivation": {
            "note": "官方仅公布比例",
            "cacheReadFactor": 0.1,
            "cacheWriteFactor": 1.25,
            "implicitCacheReadFactor": 0.2
        },
        "peakPricing2x": false,
        "peakPricingSchedule": {
            "windows": ["09:00-12:00"],
            "tz": "Asia/Shanghai",
            "effectiveFrom": null,
            "note": "待公告"
        },
        "tieredPricing": [
            {
                "minTokens": 32000,
                "maxTokens": null,
                "inputPrice": 7.0,
                "outputPrice": 26.0,
                "cacheReadPrice": 1.8,
                "cacheWritePrice": null
            }
        ],
        "promptCacheMinTokens": 512,
        "cacheType": "auto",
        "cacheMechanism": "similarity",
        "supportsPromptCaching": true,
        "supportsImplicitCaching": true,
        "supportsPromptCacheKey": false,
        "supportsCacheControl": false,
        "breakpointMax": 4,
        "lookbackBlocks": 20,
        "cacheTtl": "5m",
        "cacheTtlOptions": ["5m", "1h"],
        "supportsResponses": true,
        "supportsReasoning": true,
        "supportsReasoningEffort": true,
        "thinkingTiers": ["low", "medium", "xhigh"],
        "supportsVision": true,
        "supportsToolChoice": true,
        "supportsWebSearch": false,
        "supportsAudioInput": false,
        "supportsAudioOutput": false,
        "supportsPdfInput": true,
        "supportsAssistantPrefill": false,
        "supportsComputerUse": false,
        "sourceUrl": "https://open.bigmodel.cn/pricing",
        "dataVerifiedAt": "2026-08-03",
        "dataSource": "official",
        "notes": "测试条目",
        "promoExpiresAt": "2026-08-31",
        "promoReplacesAt": "2026-09-01",
        "retired": false,
        "deprecationDate": null
    }"#;
    let entry: ModelCatalogEntry = serde_json::from_str(raw).expect("v2 全字段条目必须可解析");
    // 标识 / 窗口
    assert_eq!(entry.id.as_deref(), Some("glm-5v-turbo"));
    assert_eq!(entry.api_model.as_deref(), Some("glm-5v-turbo"));
    assert_eq!(entry.currency.as_deref(), Some("CNY"));
    assert_eq!(entry.context_window, Some(200_000));
    assert_eq!(entry.max_output_tokens, Some(131_072));
    // 四价 + 三态（写免费 = 0 + true）
    assert_eq!(entry.input_price, Some(5.0));
    assert_eq!(entry.output_price, Some(22.0));
    assert_eq!(entry.cache_read_price, Some(1.2));
    assert_eq!(entry.cache_write_price, Some(0.0));
    assert!(entry.cache_write_free);
    // 扩展价格：存储费 / 推导 / 峰谷 / 长度分档
    assert_eq!(entry.storage_price_per_1m_hour, Some(0.0));
    assert_eq!(
        entry.storage_price_free_until.as_deref(),
        Some("2026-08-31")
    );
    assert_eq!(entry.price_status.as_deref(), Some("derived"));
    let derivation = entry.derivation.as_ref().expect("derivation 必须存在");
    assert_eq!(derivation.cache_read_factor, Some(0.1));
    assert_eq!(derivation.cache_write_factor, Some(1.25));
    assert_eq!(derivation.implicit_cache_read_factor, Some(0.2));
    let schedule = entry
        .peak_pricing_schedule
        .as_ref()
        .expect("峰谷时段必须存在");
    assert_eq!(schedule.windows, vec!["09:00-12:00".to_string()]);
    let tiers = entry
        .tiered_pricing
        .as_ref()
        .expect("tieredPricing 必须存在");
    assert_eq!(tiers.len(), 1);
    assert_eq!(tiers[0].min_tokens, 32_000);
    assert_eq!(tiers[0].max_tokens, None);
    assert_eq!(tiers[0].input_price, Some(7.0));
    assert_eq!(tiers[0].cache_write_price, None);
    // 缓存语义 / 能力位
    assert_eq!(entry.cache_type.as_deref(), Some("auto"));
    assert!(entry.supports_implicit_caching);
    assert!(entry.supports_prompt_caching);
    assert_eq!(
        entry.cache_ttl_options.as_deref(),
        Some(&["5m".to_string(), "1h".to_string()][..])
    );
    assert_eq!(
        entry.thinking_tiers,
        Some(BTreeMap::from([
            ("low".to_string(), Some("low".to_string())),
            ("medium".to_string(), Some("medium".to_string())),
            ("xhigh".to_string(), Some("xhigh".to_string())),
        ])),
        "旧 Vec 数组形式解析后每档 wire 拼写同规范名（G2 载体向后兼容逐字段不变）"
    );
    // 往返：序列化后重新解析必须一致（含嵌套结构）
    assert!(entry.supports_pdf_input);
    assert_eq!(entry.data_source.as_deref(), Some("official"));
    assert_eq!(entry.promo_expires_at.as_deref(), Some("2026-08-31"));
    // 往返：序列化后重新解析必须一致（含嵌套结构）
    let serialized = serde_json::to_string(&entry).expect("必须可序列化");
    let reparsed: ModelCatalogEntry = serde_json::from_str(&serialized).expect("往返必须可解析");
    assert_eq!(reparsed, entry);
}

/// 写价三态之二：有写价（n>0 + free=false）与未收录（null + free=false）
/// 在 serde 层可区分
#[test]
fn v2_entry_write_price_three_states_serde() {
    let with_price: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "model": "x", "provider": "p", "vendor": "v",
        "cacheWritePrice": 6.25, "cacheWriteFree": false,
    }))
    .expect("有写价条目可解析");
    assert_eq!(with_price.cache_write_price, Some(6.25));
    assert!(!with_price.cache_write_free);

    let not_collected: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "model": "x", "provider": "p", "vendor": "v",
        "cacheWritePrice": null, "cacheWriteFree": false,
        "priceStatus": "unavailable",
    }))
    .expect("未收录条目可解析");
    assert_eq!(not_collected.cache_write_price, None);
    assert!(!not_collected.cache_write_free);
    assert_eq!(not_collected.price_status.as_deref(), Some("unavailable"));
}

/// v1 旧 JSON 兼容解析：v1 特有键（maxInputTokens / longContextThreshold /
/// longContextInputPrice）与 v1 值域（cacheType "automatic"）不炸，且
/// 序列化往返不产生 v1 遗留键
#[test]
fn v1_legacy_json_parses_without_error_and_drops_legacy_fields() {
    let v1 = serde_json::json!({
        "model": "grok-4.5",
        "provider": "grok",
        "vendor": "grok",
        "mode": "both",
        "currency": "USD",
        "unit": "per_1M",
        "contextWindow": 1000000,
        "maxInputTokens": 256000,
        "maxOutputTokens": 32768,
        "inputPrice": 2.0,
        "outputPrice": 8.0,
        "cacheReadPrice": 0.2,
        "cacheWritePrice": 0.0,
        "cacheWriteFree": true,
        "longContextThreshold": 200000,
        "longContextInputPrice": 4.0,
        "promptCacheMinTokens": 1024,
        "cacheType": "automatic",
        "cacheMechanism": "prefix",
        "supportsCacheControl": false,
        "supportsPromptCaching": true,
        "cacheTtl": "5m",
        "supportsResponses": true,
        "supportsReasoning": true,
        "sourceUrl": "https://docs.x.ai/docs/models",
        "dataVerifiedAt": "2026-08-02"
    });
    let entry: ModelCatalogEntry =
        serde_json::from_value(v1).expect("v1 旧 JSON 必须兼容解析（serde default 兜底）");
    assert_eq!(entry.model, "grok-4.5");
    assert_eq!(entry.context_window, Some(1_000_000));
    assert_eq!(entry.max_output_tokens, Some(32_768));
    assert_eq!(entry.cache_write_price, Some(0.0));
    assert!(entry.cache_write_free);
    // v1 值域 cacheType 原样保留（消费侧 behavior.rs 同时匹配 automatic/auto）
    assert_eq!(entry.cache_type.as_deref(), Some("automatic"));
    assert_eq!(entry.cache_ttl.as_deref(), Some("5m"));
    // 序列化往返：v1 遗留键已从结构移除 → 不再出现
    let serialized = serde_json::to_string(&entry).expect("必须可序列化");
    assert!(!serialized.contains("maxInputTokens"));
    assert!(!serialized.contains("longContextThreshold"));
    assert!(!serialized.contains("longContextInputPrice"));
}

/// v2 文件级包装 ModelCatalogFile serde 往返（version / schema / updatedAt / entries）
#[test]
fn v2_file_wrapper_serde_roundtrip() {
    let file = ModelCatalogFile {
        version: 0,
        schema: "2.0".to_string(),
        updated_at: Some("2026-08-03".to_string()),
        entries: BTreeMap::from([(
            ModelCatalogEntry::key("acme", "x"),
            ModelCatalogEntry {
                model: "x".to_string(),
                provider: "acme".to_string(),
                vendor: "acme".to_string(),
                currency: Some("USD".to_string()),
                ..Default::default()
            },
        )]),
    };
    let serialized = serde_json::to_string(&file).expect("文件包装必须可序列化");
    let reparsed: ModelCatalogFile =
        serde_json::from_str(&serialized).expect("文件包装必须可反序列化");
    assert_eq!(reparsed, file);
    assert_eq!(reparsed.schema, "2.0");
    assert_eq!(reparsed.entries.len(), 1);
}

/// v2 四价查询：内置 v1 数据命中（Anthropic 双档写价兜底）与未知模型
/// None/保守 false 语义
#[test]
fn v2_price_queries_hit_bundled_and_default_to_none_or_false() {
    let catalog = ModelCatalog::bundled();
    // 基础四价命中
    assert_eq!(
        catalog.input_price_for("deepseek", "deepseek-v4-flash"),
        Some(0.14)
    );
    assert_eq!(
        catalog.output_price_for("deepseek", "deepseek-v4-flash"),
        Some(0.28)
    );
    assert_eq!(
        catalog.cache_read_price_for("deepseek", "deepseek-v4-flash"),
        Some(0.0028)
    );
    // 写价：DeepSeek 显式 0 + free；Anthropic 无通用写价 → 兜底 5m 档
    assert_eq!(
        catalog.cache_write_price_for("deepseek", "deepseek-v4-flash"),
        Some(0.0)
    );
    assert!(catalog.cache_write_free_for("deepseek", "deepseek-v4-flash"));
    assert_eq!(
        catalog.cache_write_price_for("anthropic", "claude-fable-5"),
        Some(12.5)
    );
    assert_eq!(
        catalog.cache_write_price_5m_for("anthropic", "claude-fable-5"),
        Some(12.5)
    );
    assert_eq!(
        catalog.cache_write_price_1h_for("anthropic", "claude-fable-5"),
        Some(20.0)
    );
    // 币种 / 存储费 / 价格形态（v2 全量转录后 priceStatus 显式 official）
    assert_eq!(catalog.currency_for("kimi", "kimi-k3"), Some("CNY"));
    assert_eq!(
        catalog.currency_for("anthropic", "claude-sonnet-5"),
        Some("USD")
    );
    assert_eq!(
        catalog.storage_price_per_1m_hour_for("gemini", "gemini-3-1-pro-preview"),
        Some(4.5)
    );
    assert_eq!(
        catalog.price_status_for("deepseek", "deepseek-v4-flash"),
        Some("official")
    );
    // 未知模型：价格 None、币种 None、写免费保守 false
    assert_eq!(catalog.input_price_for("nobody", "whatever"), None);
    assert_eq!(catalog.cache_write_price_for("nobody", "whatever"), None);
    assert_eq!(catalog.currency_for("nobody", "whatever"), None);
    assert!(!catalog.cache_write_free_for("nobody", "whatever"));
    // 非写免费模型（有写价 n>0）显式 false
    assert!(!catalog.cache_write_free_for("qwen", "qwen3-max"));
}

// ===== DEEPCHECK-05 #8：tieredPricing 分档消费 =====

/// 档位命中：半开区间 [min, max) 边界（qwen3-max 32K/128K 双档：
/// [0,32K) 基础档 / [32K,128K) / [128K,∞)）
#[test]
fn tiered_tier_for_hits_half_open_ranges() {
    let catalog = ModelCatalog::bundled();
    // 首档（基础四价）：32K 以下无档命中
    assert!(catalog
        .tiered_tier_for("qwen", "qwen3-max", 31_999)
        .is_none());
    // 档 1：[32K, 128K)
    let tier1 = catalog
        .tiered_tier_for("qwen", "qwen3-max", 32_000)
        .expect("32K 必须命中档 1");
    assert_eq!(tier1.min_tokens, 32_000);
    assert_eq!(tier1.max_tokens, Some(128_000));
    assert!(catalog
        .tiered_tier_for("qwen", "qwen3-max", 127_999)
        .is_some());
    // 档 2：[128K, ∞) 无上界
    let tier2 = catalog
        .tiered_tier_for("qwen", "qwen3-max", 128_000)
        .expect("128K 必须命中档 2");
    assert_eq!(tier2.max_tokens, None);
    assert!(catalog
        .tiered_tier_for("qwen", "qwen3-max", 1_000_000)
        .is_some());
}

/// 分档四价：档内覆盖价生效，未覆盖字段沿用基础价（Gemini ≥200K 2x 档）
#[test]
fn tiered_price_queries_apply_tier_overrides() {
    let catalog = ModelCatalog::bundled();
    // Gemini 3.1 pro preview：基础 2.0/12.0/0.2；≥200K 档 4.0/18.0/0.4
    let (vendor, model) = ("gemini", "gemini-3-1-pro-preview");
    assert_eq!(catalog.input_price_for(vendor, model), Some(2.0));
    assert_eq!(
        catalog.input_price_for_tokens(vendor, model, 199_999),
        Some(2.0),
        "200K 前仍为基础档"
    );
    assert_eq!(
        catalog.input_price_for_tokens(vendor, model, 200_000),
        Some(4.0),
        "200K 起进入 2x 档"
    );
    assert_eq!(
        catalog.output_price_for_tokens(vendor, model, 200_000),
        Some(18.0)
    );
    assert_eq!(
        catalog.cache_read_price_for_tokens(vendor, model, 200_000),
        Some(0.4)
    );
    // 长上下文判定：≥200K 为长上下文档（无上界档）
    assert!(!catalog.is_long_context_for(vendor, model, 199_999));
    assert!(catalog.is_long_context_for(vendor, model, 200_000));
    // 档内未覆盖字段沿用基础价：gemini 档无 cacheWritePrice 覆盖
    assert_eq!(
        catalog.cache_write_price_for_tokens(vendor, model, 200_000),
        Some(0.0)
    );
}

/// 分档写价：档内 cacheWritePrice 覆盖（qwen3-max 档 3 覆盖写价 8.75）
#[test]
fn tiered_write_price_tier_override() {
    let catalog = ModelCatalog::bundled();
    // qwen3-max 基础写价 3.125；档 [128K,∞) 覆盖 8.75
    assert_eq!(
        catalog.cache_write_price_for("qwen", "qwen3-max"),
        Some(3.125)
    );
    assert_eq!(
        catalog.cache_write_price_for_tokens("qwen", "qwen3-max", 31_999),
        Some(3.125),
        "基础档沿用基础写价"
    );
    assert_eq!(
        catalog.cache_write_price_for_tokens("qwen", "qwen3-max", 200_000),
        Some(8.75)
    );
}

/// 无档模型：分档查询恒回退基础四价（deepseek-v4-flash 无 tieredPricing）
#[test]
fn tiered_queries_fallback_to_base_prices_when_no_tiers() {
    let catalog = ModelCatalog::bundled();
    let (vendor, model) = ("deepseek", "deepseek-v4-flash");
    assert_eq!(
        catalog.input_price_for_tokens(vendor, model, 1_000_000),
        Some(0.14)
    );
    assert_eq!(
        catalog.output_price_for_tokens(vendor, model, 1_000_000),
        Some(0.28)
    );
    assert_eq!(
        catalog.cache_read_price_for_tokens(vendor, model, 1_000_000),
        Some(0.0028)
    );
    assert!(!catalog.is_long_context_for(vendor, model, 1_000_000));
    // 未知模型 → None / false
    assert_eq!(
        catalog.input_price_for_tokens("nobody", "whatever", 10),
        None
    );
    assert!(!catalog.is_long_context_for("nobody", "whatever", 10));
}
