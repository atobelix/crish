use super::*;

/// 内置表 serde 全量解析 + 键与条目身份字段一致（防转录漂移）+ 各厂商条目数钉死
///
/// v2 全量转录（2026-08-03 核实）：御十家 151 条（OpenAI 34 / Anthropic 11 /
/// Kimi 4 / GLM 31 / Qwen 23 / Grok 6 / MiniMax 16 / Gemini 22 / DeepSeek 2 /
/// Cursor 2；GLM 双币种 13 条 CNY 与 MiniMax 8 条 USD 以 -cny/-usd 键后缀区分）
#[test]
fn catalog_json_parses_fully_and_keys_match_entries() {
    let catalog = ModelCatalog::bundled();
    assert!(
        catalog.entries.len() >= 100,
        "内置条目数 = {}",
        catalog.entries.len()
    );
    for (key, entry) in &catalog.entries {
        assert_eq!(
            *key,
            ModelCatalogEntry::key(&entry.vendor, &entry.model),
            "键必须与 vendor::model 一致",
        );
        assert!(!entry.model.is_empty(), "{key} 缺 model");
        assert!(!entry.provider.is_empty(), "{key} 缺 provider");
        assert!(!entry.vendor.is_empty(), "{key} 缺 vendor");
        assert!(entry.source_url.is_some(), "{key} 缺 source_url");
        assert!(
            entry.data_verified_at.as_deref() == Some("2026-08-03")
                || entry.data_verified_at.as_deref() == Some("2026-09-09"),
            "{key} 核实日期须为 2026-08-03 或 2026-09-09",
        );
    }
    // 各厂商条目数（转录范围钉死；御十家全量 v2）
    let count = |vendor: &str| {
        catalog
            .entries
            .values()
            .filter(|entry| entry.vendor == vendor)
            .count()
    };
    assert_eq!(count("deepseek"), 2);
    assert_eq!(count("anthropic"), 11);
    assert_eq!(count("openai"), 35);
    assert_eq!(count("kimi"), 4);
    assert_eq!(count("grok"), 7);
    assert_eq!(count("minimax"), 16);
    assert_eq!(count("gemini"), 24);
    assert_eq!(count("glm"), 31);
    assert_eq!(count("qwen"), 24);
    assert_eq!(count("cursor"), 2);
}

/// 精确命中：deepseek-v4-flash 及其关键字段
#[test]
fn lookup_exact_match_hits_bundled_entry() {
    let catalog = ModelCatalog::bundled();
    let flash = catalog
        .lookup("deepseek", "deepseek-v4-flash")
        .expect("内置 deepseek-v4-flash 必须命中");
    assert_eq!(flash.model, "deepseek-v4-flash");
    assert_eq!(flash.vendor, "deepseek");
    assert_eq!(flash.context_window, Some(1_000_000));
    assert_eq!(flash.input_price, Some(0.14));
    assert_eq!(flash.cache_read_price, Some(0.0028));
    assert_eq!(flash.output_price, Some(0.28));
    assert!(flash.supports_prompt_caching);
    assert!(flash.supports_responses);
    assert!(!flash.supports_cache_control);

    // v4-pro：Responses 尚未支持（官方口径 2026 年 8 月初加入）
    let pro = catalog
        .lookup("deepseek", "deepseek-v4-pro")
        .expect("内置 deepseek-v4-pro 必须命中");
    assert_eq!(pro.cache_read_price, Some(0.003625));
    assert!(!pro.supports_responses);
}

/// 版本后缀不同即身份不同，不能套用基础型号的配置
#[test]
fn lookup_strips_version_suffix() {
    let catalog = ModelCatalog::bundled();
    // 保留版本后缀反例资产；新合同禁止把不同型号替换成基础型号。
    assert!(catalog
        .lookup("deepseek", "deepseek-v4-flash-0731")
        .is_none());
    assert!(catalog
        .lookup("deepseek", "deepseek-v4-flash-20250826")
        .is_none());
    assert!(catalog.lookup("deepseek", "deepseek-v4-flash").is_some());
}

/// 未知模型 / 未知 vendor → None
#[test]
fn lookup_unknown_model_and_vendor_yield_none() {
    let catalog = ModelCatalog::bundled();
    assert!(catalog.lookup("deepseek", "unknown-model").is_none());
    assert!(catalog
        .lookup("unknown-vendor", "deepseek-v4-flash")
        .is_none());
    assert!(catalog.lookup("unknown-vendor", "whatever").is_none());
}

/// W10：身份键精确匹配 + 首尾 trim（不做 lowercase）——与 TS 侧 lookup 对称。
#[test]
fn lookup_trims_whitespace_but_is_case_sensitive() {
    let catalog = ModelCatalog::bundled();
    // 首尾空白变体 → trim 后精确命中同一内置条目
    let padded = catalog
        .lookup("  deepseek  ", "  deepseek-v4-flash  ")
        .expect("首尾空白必须 trim 后命中");
    assert_eq!(padded.model, "deepseek-v4-flash");
    assert_eq!(padded.vendor, "deepseek");
    // 大小写变体 → 不命中（不做 lowercase）
    assert!(
        catalog.lookup("DeepSeek", "deepseek-v4-flash").is_none(),
        "vendor 大小写变体不得命中"
    );
    assert!(
        catalog.lookup("deepseek", "DeepSeek-V4-Flash").is_none(),
        "model 大小写变体不得命中"
    );
}

/// W10 / INV-12：`find_model` 身份键精确匹配 + 首尾 trim（不做 lowercase）——
/// 与 TS 侧 `selectModel('Acme','XHigh-Model')` 对称。
#[test]
fn find_model_trims_whitespace_but_is_case_sensitive() {
    // ① ProviderSpec::find_model：modelId 侧
    let model: ModelSpec = serde_json::from_str(r#"{"id":"XHigh-Model"}"#).expect("ModelSpec");
    let provider = ProviderSpec {
        models: vec![model],
        ..Default::default()
    };
    assert!(provider.find_model("XHigh-Model").is_some(), "精确命中");
    assert!(
        provider.find_model("  XHigh-Model  ").is_some(),
        "首尾空白 trim 后命中"
    );
    assert!(
        provider.find_model("xhigh-model").is_none(),
        "小写变体不命中（不做 lowercase）"
    );
    assert!(
        provider.find_model("XHIGH-MODEL").is_none(),
        "大写变体不命中（不做 lowercase）"
    );

    // ② UnifiedModelsConfig::find_model：providerId + modelId 双侧
    let yaml = "version: 2\nproviders:\n  Acme:\n    protocol: openai/chat\n    models:\n      - id: XHigh-Model\n";
    let config = UnifiedModelsConfig::from_yaml_str(yaml).expect("v2 yaml");
    assert!(
        config.find_model("Acme", "XHigh-Model").is_some(),
        "精确命中"
    );
    assert!(
        config.find_model("  Acme  ", "  XHigh-Model  ").is_some(),
        "双侧首尾空白 trim 后命中"
    );
    assert!(
        config.find_model("acme", "XHigh-Model").is_none(),
        "providerId 小写变体不命中"
    );
    assert!(
        config.find_model("ACME", "XHigh-Model").is_none(),
        "providerId 大写变体不命中"
    );
}

/// 星号条目不再充当供应商默认值，未知型号必须未命中
#[test]
fn lookup_falls_back_to_vendor_default_entry() {
    let mut entries = BTreeMap::new();
    entries.insert(
        ModelCatalogEntry::key("acme", "*"),
        ModelCatalogEntry {
            model: "*".to_owned(),
            provider: "acme".to_owned(),
            vendor: "acme".to_owned(),
            ..Default::default()
        },
    );
    let catalog = ModelCatalog {
        entries,
        version: 0,
    };
    assert!(catalog.lookup("acme", "anything-at-all").is_none());
    assert!(
        catalog.lookup("acme", "*").is_some(),
        "星号只能作为精确型号被读取"
    );
    // 未配置 vendor 默认条目的厂商 → None
    assert!(catalog.lookup("other", "anything-at-all").is_none());
}

/// 精确条目优先于 vendor 默认条目
#[test]
fn lookup_prefers_exact_over_vendor_default() {
    let mut entries = BTreeMap::new();
    entries.insert(
        ModelCatalogEntry::key("acme", "*"),
        ModelCatalogEntry {
            model: "*".to_owned(),
            provider: "acme".to_owned(),
            vendor: "acme".to_owned(),
            ..Default::default()
        },
    );
    entries.insert(
        ModelCatalogEntry::key("acme", "special"),
        ModelCatalogEntry {
            model: "special".to_owned(),
            provider: "acme".to_owned(),
            vendor: "acme".to_owned(),
            ..Default::default()
        },
    );
    let catalog = ModelCatalog {
        entries,
        version: 0,
    };
    assert_eq!(catalog.lookup("acme", "special").unwrap().model, "special");
}

/// A3 P2-10：必填非 Option 字段全部有 Default，缺字段条目可解析
#[test]
fn entry_with_missing_fields_parses_with_defaults() {
    let minimal = r#"{"model":"x","provider":"p","vendor":"v"}"#;
    let entry: ModelCatalogEntry = serde_json::from_str(minimal).expect("缺字段条目必须可解析");
    assert_eq!(entry.model, "x");
    assert_eq!(entry.context_window, None);
    assert_eq!(entry.prompt_cache_min_tokens, None);
    assert_eq!(entry.source_url, None);
    assert_eq!(entry.mode, None);
    assert!(!entry.supports_prompt_caching);
    assert!(!entry.supports_cache_control);
    assert!(!entry.supports_responses);
    assert!(!entry.supports_reasoning_effort);
    // 空对象同样可解析（全部字段走 Default）
    let empty: ModelCatalogEntry = serde_json::from_str("{}").expect("空对象必须可解析");
    assert_eq!(empty.model, "");
    assert!(!empty.supports_prompt_caching);
}

/// 便捷查询：窗口/输出上限/最低可缓存前缀/缓存资格/Responses 支持/版本号
#[test]
fn convenience_queries_respect_catalog_and_defaults() {
    let catalog = ModelCatalog::bundled();
    // 窗口与输出上限
    assert_eq!(
        catalog.context_window_for("deepseek", "deepseek-v4-flash"),
        Some(1_000_000)
    );
    assert_eq!(
        catalog.max_output_for("anthropic", "claude-haiku-4-5"),
        Some(64_000)
    );
    // Gemini 3.x 窗口 v2 已补录（master list §8.1 口径 1,048,576）
    assert_eq!(
        catalog.context_window_for("gemini", "gemini-3-6-flash"),
        Some(1_048_576)
    );
    // 最低可缓存前缀：收录值命中；未收录/未知模型回退 1024
    assert_eq!(catalog.prompt_cache_min_tokens_for("kimi", "kimi-k3"), 256);
    assert_eq!(
        catalog.prompt_cache_min_tokens_for("deepseek", "deepseek-v4-flash"),
        1024
    );
    assert_eq!(
        catalog.prompt_cache_min_tokens_for("nobody", "whatever"),
        1024
    );
    // 缓存资格：内置开启；未知模型保守关闭
    assert!(catalog.supports_prompt_caching_for("anthropic", "claude-sonnet-4-5"));
    assert!(!catalog.supports_prompt_caching_for("nobody", "whatever"));
    // Responses：v4-flash 支持、v4-pro 不支持、未知不支持
    assert!(catalog.supports_responses_for("deepseek", "deepseek-v4-flash"));
    assert!(!catalog.supports_responses_for("deepseek", "deepseek-v4-pro"));
    assert!(!catalog.supports_responses_for("nobody", "whatever"));
    // 币种转录：Kimi 为 CNY、Anthropic 为 USD
    assert_eq!(
        catalog
            .lookup("kimi", "kimi-k3")
            .unwrap()
            .currency
            .as_deref(),
        Some("CNY")
    );
    assert_eq!(
        catalog
            .lookup("anthropic", "claude-sonnet-5")
            .unwrap()
            .currency
            .as_deref(),
        Some("USD")
    );
    // 内置表版本号从 0 起（T-24 覆盖/合并时 bump）
    assert_eq!(catalog.version(), 0);
}

/// Sonnet 5 促销价转录钉死（00-catalog §1.1：8/31 前 $2/$10；9/1 起涨价
/// $3/$15 属 P5 定价模块日期区间切换，00-catalog §12.3 刷新清单）
#[test]
fn sonnet5_transcribes_promo_price() {
    let catalog = ModelCatalog::bundled();
    let sonnet5 = catalog
        .lookup("anthropic", "claude-sonnet-5")
        .expect("内置 claude-sonnet-5 必须命中");
    assert_eq!(sonnet5.input_price, Some(2.0));
    assert_eq!(sonnet5.cache_read_price, Some(0.2));
    assert_eq!(sonnet5.output_price, Some(10.0));
    assert_eq!(sonnet5.prompt_cache_min_tokens, Some(1024));
}
