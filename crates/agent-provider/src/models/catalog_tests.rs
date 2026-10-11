//! models/catalog.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 catalog.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。

use super::catalog_price::{beijing_minutes_of, parse_date_utc_epoch, window_contains};
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

// ===== T-24：覆盖白名单（with_overrides）=====

/// 白名单字段生效：窗口 / 输出上限 / 价格族 / 最低可缓存前缀 / 能力位，
/// 生效后 version +1
#[test]
fn with_overrides_applies_whitelisted_fields_and_bumps_version() {
    let mut catalog = ModelCatalog::bundled();
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash",
        "contextWindow": 200_000,
        "maxOutputTokens": 16_000,
        "cacheReadPrice": 0.001,
        "promptCacheMinTokens": 512,
        "supportsVision": true,
    })]);
    assert_eq!(rejected, 0, "白名单字段应全部生效");
    assert_eq!(catalog.version(), 1);
    let flash = catalog
        .lookup("deepseek", "deepseek-v4-flash")
        .expect("内置条目必须存在");
    assert_eq!(flash.context_window, Some(200_000));
    assert_eq!(flash.max_output_tokens, Some(16_000));
    assert_eq!(flash.cache_read_price, Some(0.001));
    assert_eq!(flash.prompt_cache_min_tokens, Some(512));
    assert!(flash.supports_vision);
    // 未覆盖字段保持内置真源
    assert_eq!(flash.input_price, Some(0.14));
    assert_eq!(flash.output_price, Some(0.28));
    assert!(flash.supports_prompt_caching);
}

/// 能力位可显式关闭（supportsVision: false），与"键缺失 = 不动"区分
#[test]
fn with_overrides_can_turn_off_capability_bit_explicitly() {
    let mut catalog = ModelCatalog::bundled();
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash",
        "supportsVision": false,
        "supportsResponses": false,
    })]);
    assert_eq!(rejected, 0);
    let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
    assert!(!flash.supports_vision);
    assert!(!flash.supports_responses);
    // 键缺失的能力位不动
    assert!(flash.supports_prompt_caching);
}

/// model 键禁覆盖：身份键指向不存在的条目（借覆盖新增 / 改名）→ 整项拒绝，
/// 版本号与目录不变
#[test]
fn with_overrides_rejects_forbidden_model_key() {
    let mut catalog = ModelCatalog::bundled();
    let version = catalog.version();
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash-9999",
        "contextWindow": 200_000,
    })]);
    assert_eq!(rejected, 1, "model 键禁覆盖：目标不存在必须拒绝");
    assert_eq!(catalog.version(), version, "全部被拒不得 bump");
    // 未被借覆盖新增条目：entries 无该精确键（lookup 的版本后缀兜底命中
    // 的是内置基础条目，不代表覆盖生效）
    assert!(!catalog.entries.contains_key(&ModelCatalogEntry::key(
        "deepseek",
        "deepseek-v4-flash-9999"
    )));
    assert!(catalog
        .lookup("deepseek", "deepseek-v4-flash-9999")
        .is_none());

    // provider 键禁覆盖：与既有条目通道不一致 → 拒绝
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash",
        "provider": "other-channel",
    })]);
    assert_eq!(rejected, 1);
    assert_eq!(
        catalog
            .lookup("deepseek", "deepseek-v4-flash")
            .unwrap()
            .provider,
        "deepseek",
        "provider 不得被覆盖"
    );

    // 缺身份键（无 vendor/model）→ 拒绝
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "contextWindow": 200_000,
    })]);
    assert_eq!(rejected, 1);
}

/// 白名单外字段（mode / currency / cacheType 等）→ 整项拒绝，条目不变
#[test]
fn with_overrides_rejects_non_whitelisted_fields_per_item() {
    let mut catalog = ModelCatalog::bundled();
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash",
        "mode": "responses",
        "contextWindow": 300_000,
    })]);
    assert_eq!(rejected, 1, "白名单外字段必须拒绝该项");
    let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
    assert_eq!(flash.context_window, Some(1_000_000), "被拒项不得部分生效");
    assert_eq!(
        flash.mode.as_deref(),
        Some("both"),
        "白名单外字段不动（内置值保留）"
    );

    // 字段类型错误（窗口为字符串）→ 拒绝
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash",
        "contextWindow": "not-a-number",
    })]);
    assert_eq!(rejected, 1);
}

/// 混合批次：合法项生效（version +1）、非法项拒绝，互不阻塞（失败不阻塞仅记录）
#[test]
fn with_overrides_partial_batch_keeps_applied_items() {
    let mut catalog = ModelCatalog::bundled();
    let rejected = catalog.with_overrides(&[
        serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash",
            "contextWindow": 200_000,
        }),
        serde_json::json!({
            "vendor": "deepseek",
            "model": "deepseek-v4-flash-9999",
            "contextWindow": 200_000,
        }),
    ]);
    assert_eq!(rejected, 1, "仅非法项被拒");
    assert_eq!(catalog.version(), 1, "合法项生效 bump 一次");
    assert_eq!(
        catalog
            .lookup("deepseek", "deepseek-v4-flash")
            .unwrap()
            .context_window,
        Some(200_000)
    );
}

// ===== T-24：扫描合并（upsert_from_scan）=====

/// 合并窗口 / 输出上限 / 能力位；**不覆盖价格族与缓存语义**；version +1
#[test]
fn upsert_from_scan_merges_window_and_caps_but_keeps_prices() {
    let mut catalog = ModelCatalog::bundled();
    let version = catalog.version();
    let scan = vec![ScannedModel {
        model: "deepseek-v4-flash".to_string(),
        vendor: Some("deepseek".to_string()),
        context_window: Some(64_000),
        max_output_tokens: Some(8_000),
        capabilities: Some(ScannedCapabilities {
            tools: Some(false),
            vision: Some(true),
            reasoning: Some(false),
        }),
    }];
    let new_version = catalog.upsert_from_scan("deepseek", &scan);
    assert_eq!(new_version, version + 1, "扫描有变更必须 bump");
    let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
    assert_eq!(flash.context_window, Some(64_000), "运行时窗口覆盖");
    assert_eq!(flash.max_output_tokens, Some(8_000));
    assert!(!flash.supports_function_calling);
    assert!(flash.supports_vision);
    assert!(!flash.supports_reasoning);
    // 价格族不被覆盖（扫描无价格字段）
    assert_eq!(flash.input_price, Some(0.14));
    assert_eq!(flash.cache_read_price, Some(0.0028));
    assert_eq!(flash.output_price, Some(0.28));
    // 缓存语义不被覆盖（扫描无缓存字段）
    assert!(flash.supports_prompt_caching);
    assert_eq!(
        flash.prompt_cache_min_tokens, None,
        "扫描不携带最低缓存前缀"
    );
    assert_eq!(
        catalog.prompt_cache_min_tokens_for("deepseek", "deepseek-v4-flash"),
        1024
    );
}

/// 未收录模型按猜测新建（vendor 缺省回退 provider）；重复合并幂等（不再 bump）
#[test]
fn upsert_from_scan_inserts_unknown_models_and_is_idempotent() {
    let mut catalog = ModelCatalog::bundled();
    let version = catalog.version();
    let scan = vec![ScannedModel {
        model: "gateway-7b".to_string(),
        vendor: None,
        context_window: Some(32_000),
        max_output_tokens: None,
        capabilities: Some(ScannedCapabilities {
            tools: Some(true),
            vision: None,
            reasoning: None,
        }),
    }];
    let new_version = catalog.upsert_from_scan("my-gateway", &scan);
    assert_eq!(new_version, version + 1);
    let entry = catalog.lookup("my-gateway", "gateway-7b").unwrap();
    assert_eq!(entry.model, "gateway-7b");
    assert_eq!(entry.provider, "my-gateway");
    assert_eq!(entry.vendor, "my-gateway", "vendor 缺省回退 provider");
    assert_eq!(entry.context_window, Some(32_000));
    assert!(entry.supports_function_calling);
    assert!(!entry.supports_vision, "能力位未提供 → 保守 false");
    assert_eq!(entry.input_price, None, "扫描无价格字段");
    // 幂等：同样扫描再次合并不产生变更 → 版本不变
    let again = catalog.upsert_from_scan("my-gateway", &scan);
    assert_eq!(again, new_version, "无变更不得重复 bump");
}

/// 空扫描 / 空模型名不产生变更
#[test]
fn upsert_from_scan_empty_or_blank_keeps_version() {
    let mut catalog = ModelCatalog::bundled();
    let version = catalog.version();
    assert_eq!(catalog.upsert_from_scan("p", &[]), version);
    assert_eq!(
        catalog.upsert_from_scan(
            "p",
            &[ScannedModel {
                model: "  ".to_string(),
                ..Default::default()
            }]
        ),
        version
    );
    assert_eq!(catalog.version(), version);
}

// ===== T1.5 / G3-d：models 整体替换双模式（replace_models）=====

/// 声明列表后该路由只服务列表内模型：未点名 deepseek 路由条目被移除、
/// `lookup` 对未点名 deepseek 模型返回 None；其它 provider 路由不受影响；version +1。
#[test]
fn replace_models_narrows_route_to_declared_list() {
    let mut catalog = ModelCatalog::bundled();
    let before = catalog.version();
    // deepseek 内置 2 条（deepseek-v4-flash / deepseek-v4-pro）；声明只保留 flash
    let new_version = catalog
        .replace_models(
            "deepseek",
            &[serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash",
                "contextWindow": 200_000,
            })],
        )
        .expect("合法 models 列表必须生效");
    assert_eq!(new_version, before + 1, "替换必须 bump 版本号");

    // 该路由只服务列表内模型
    let deepseek_keys: Vec<String> = catalog
        .entries
        .iter()
        .filter(|(_, e)| e.provider == "deepseek")
        .map(|(k, _)| k.clone())
        .collect();
    assert_eq!(
        deepseek_keys,
        vec![ModelCatalogEntry::key("deepseek", "deepseek-v4-flash")],
        "路由只服务列表内模型"
    );
    // 未点名模型 lookup 返回 None（无 vendor 默认兜底）
    assert!(
        catalog.lookup("deepseek", "deepseek-v4-pro").is_none(),
        "未点名模型不再服务"
    );
    assert!(
        !catalog
            .entries
            .contains_key(&ModelCatalogEntry::key("deepseek", "deepseek-v4-pro")),
        "未点名旧条目必须被移除"
    );
    // 列表内模型可服务，且白名单字段生效
    let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
    assert_eq!(flash.context_window, Some(200_000));

    // 其它 provider 路由不受影响（未声明全量保留）
    let anthropic_count = catalog
        .entries
        .iter()
        .filter(|(_, e)| e.provider == "anthropic")
        .count();
    assert!(
        anthropic_count > 0,
        "anthropic 路由全量保留，条数 = {anthropic_count}"
    );
}

/// 未声明 replace 的提供方保持原 catalog 全量服务，即"未声明时全量"基线
/// 不受其它路由替换影响。
#[test]
fn replace_models_unlisted_provider_keeps_full_catalog() {
    let mut catalog = ModelCatalog::bundled();
    let before = catalog.version();
    // 只对 deepseek 声明，openai 路由未声明
    catalog
        .replace_models(
            "deepseek",
            &[serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash",
            })],
        )
        .expect("合法替换必须生效");
    assert_eq!(catalog.version(), before + 1);
    // openai 全量保留（内置 35 条）
    let openai_count = catalog
        .entries
        .iter()
        .filter(|(_, e)| e.provider == "openai")
        .count();
    assert_eq!(openai_count, 35, "未声明 replace 的 openai 保持全量");
    // openai 模型仍可服务
    assert!(catalog.lookup("openai", "gpt-4o").is_some());
}

/// 三模式并存互不干扰：replace（整体替换）之后与 upsert_from_scan（逐条扫描合并）、
/// with_overrides（条目覆盖白名单）叠加，各模式语义 preserve，未声明路由不被打乱。
#[test]
fn replace_models_coexists_with_upsert_and_overrides() {
    let mut catalog = ModelCatalog::bundled();
    // 1) replace：deepseek 路由收窄到 flash
    catalog
        .replace_models(
            "deepseek",
            &[serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash",
            })],
        )
        .expect("replace 生效");
    // 2) 对列表内模型再做逐条扫描合并（upsert 模式）：窗口被运行时覆盖
    catalog.upsert_from_scan(
        "deepseek",
        &[ScannedModel {
            model: "deepseek-v4-flash".to_string(),
            vendor: Some("deepseek".to_string()),
            context_window: Some(64_000),
            max_output_tokens: None,
            capabilities: None,
        }],
    );
    // 3) 对列表内模型再做条目覆盖（with_overrides 模式）：价格覆盖
    let rejected = catalog.with_overrides(&[serde_json::json!({
        "vendor": "deepseek",
        "model": "deepseek-v4-flash",
        "cacheReadPrice": 0.0005,
    })]);
    assert_eq!(rejected, 0, "三模式并存：覆盖项应生效");

    // 三模式叠加结果仍只服务列表内模型，且两种"就地"模式都各自生效
    let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
    assert_eq!(flash.context_window, Some(64_000), "upsert 覆盖窗口生效");
    assert_eq!(flash.cache_read_price, Some(0.0005), "覆盖价格生效");
    assert!(
        catalog.lookup("deepseek", "deepseek-v4-pro").is_none(),
        "replace 收窄仍保持"
    );
    // 未参与任何声明的路由保持全量
    assert!(catalog.lookup("qwen", "qwen3-8-max").is_some());
}

/// 白名单纪律：替换项含禁改键 → 拒绝（CatalogError::ForbiddenField），目录零改动。
/// 场景：provider 与路由不一致、白名单外字段、vendor::model 键被其它路由占用、重复声明。
#[test]
fn replace_models_rejects_forbidden_identity_keys_atomically() {
    // (a) provider 与路由参数不一致（禁改 provider 键）
    let mut catalog = ModelCatalog::bundled();
    let version = catalog.version();
    let err = catalog
        .replace_models(
            "deepseek",
            &[serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash",
                "provider": "openai",
            })],
        )
        .unwrap_err();
    let is_provider_forbidden = matches!(&err, CatalogError::ForbiddenField(f) if f == "provider");
    assert!(
        is_provider_forbidden,
        "provider 键与路由不一致必须拒绝，got {err:?}"
    );
    assert_eq!(catalog.version(), version, "整体拒绝不得 bump");
    assert!(
        catalog.lookup("deepseek", "deepseek-v4-pro").is_some(),
        "目录零改动"
    );

    // (b) 白名单外字段（mode）→ 拒绝
    let err = catalog
        .replace_models(
            "deepseek",
            &[serde_json::json!({
                "vendor": "deepseek",
                "model": "deepseek-v4-flash",
                "mode": "responses",
            })],
        )
        .unwrap_err();
    assert!(
        matches!(err, CatalogError::ForbiddenField(..)),
        "白名单外字段必须拒绝，got {err:?}"
    );
    assert_eq!(catalog.version(), version);

    // (c) vendor::model 键已被其它 provider 路由占用（防键冲突 / 禁改 vendor 挪动）
    // openai 内置条目 key = openai::gpt-4o；试图在 deepseek 路由下声明它 → 拒绝
    let err = catalog
        .replace_models(
            "deepseek",
            &[serde_json::json!({
                "vendor": "openai",
                "model": "gpt-4o",
            })],
        )
        .unwrap_err();
    let is_forbidden = matches!(&err, CatalogError::ForbiddenField(..));
    assert!(is_forbidden, "跨路由占用必须拒绝，got {err:?}");
    assert_eq!(catalog.version(), version);

    // (d) 重复声明同一 model 键 → InvalidOverride，整体拒绝
    let err = catalog
        .replace_models(
            "deepseek",
            &[
                serde_json::json!({ "vendor": "deepseek", "model": "deepseek-v4-flash" }),
                serde_json::json!({ "vendor": "deepseek", "model": "deepseek-v4-flash" }),
            ],
        )
        .unwrap_err();
    assert!(
        matches!(err, CatalogError::InvalidOverride(..)),
        "重复模型键必须拒绝，got {err:?}"
    );
    assert_eq!(catalog.version(), version, "整体拒绝不得 bump");

    // (e) 空 provider → InvalidOverride
    let err = catalog.replace_models("   ", &[]).unwrap_err();
    assert!(matches!(err, CatalogError::InvalidOverride(..)));
}

/// 替换支持新建模型（声明为默认条目）并合并白名单字段；version +1 精确断言（memoize 失效）。
#[test]
fn replace_models_creates_new_models_and_bumps_version_once() {
    let mut catalog = ModelCatalog::bundled();
    let before = catalog.version();
    let new_version = catalog
        .replace_models(
            "deepseek",
            &[
                serde_json::json!({
                    "vendor": "deepseek",
                    "model": "deepseek-v4-flash",
                }),
                serde_json::json!({
                    "vendor": "deepseek",
                    "model": "gateway-new-7b",
                    "contextWindow": 32_000,
                    "maxOutputTokens": 8_000,
                    "cacheReadPrice": 0.001,
                    "supportsVision": true,
                }),
            ],
        )
        .expect("合法列表必须生效");
    assert_eq!(new_version, before + 1, "一次变更只 bump 一次");
    // 列表内 flash 保留（身份沿用）
    let flash = catalog.lookup("deepseek", "deepseek-v4-flash").unwrap();
    assert_eq!(flash.provider, "deepseek");
    // 新建模型：身份 + 白名单覆盖生效，vendor 默认兜底可命中
    let created = catalog.lookup("deepseek", "gateway-new-7b").unwrap();
    assert_eq!(created.provider, "deepseek");
    assert_eq!(created.vendor, "deepseek");
    assert_eq!(created.context_window, Some(32_000));
    assert_eq!(created.max_output_tokens, Some(8_000));
    assert_eq!(created.cache_read_price, Some(0.001));
    assert!(created.supports_vision, "能力位显式 true 生效");
    // 未点名的 old model 移除
    assert!(catalog.lookup("deepseek", "deepseek-v4-pro").is_none());

    // 幂等：相同的 replace 再执行不产生变更 → 版本不变
    let again = catalog
        .replace_models(
            "deepseek",
            &[
                serde_json::json!({
                    "vendor": "deepseek",
                    "model": "deepseek-v4-flash",
                }),
                serde_json::json!({
                    "vendor": "deepseek",
                    "model": "gateway-new-7b",
                    "contextWindow": 32_000,
                    "maxOutputTokens": 8_000,
                    "cacheReadPrice": 0.001,
                    "supportsVision": true,
                }),
            ],
        )
        .expect("重复替换仍合法");
    assert_eq!(again, new_version, "无变更不得重复 bump");
}

/// 全量快照：按键序返回、条目数与内部一致、不泄露内部可变性
#[test]
fn entries_snapshot_returns_sorted_copy() {
    let catalog = ModelCatalog::bundled();
    let snapshot = catalog.entries_snapshot();
    assert_eq!(snapshot.len(), catalog.entries.len());
    let keys: Vec<String> = snapshot
        .iter()
        .map(|e| ModelCatalogEntry::key(&e.vendor, &e.model))
        .collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted, "快照必须按键序");
    let flash = snapshot
        .iter()
        .find(|e| e.model == "deepseek-v4-flash")
        .unwrap();
    assert_eq!(flash.input_price, Some(0.14));
}

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

// ===== DEEPCHECK-05 #8：peakPricing 峰谷消费 =====

/// 基准时刻：2026-01-01 UTC 00:00 = 北京 08:00（epoch 1_767_225_600，
/// Node Date.UTC(2026,0,1)/1000 实测钉死）
const BASE_UTC_2026_01_01: u64 = 1_767_225_600;

/// 峰谷判定：deepseek-v4-flash 北京 9-12 / 14-18（左闭右开）
#[test]
fn peak_pricing_2x_detects_beijing_windows() {
    let catalog = ModelCatalog::bundled();
    // 北京时间当日分钟 → epoch：BASE 为北京 08:00，相对偏移
    // (min + 1440 - 480) % 1440（08:00 偏移 0，跨日取模）
    let at_beijing = |beijing_min: u64| {
        let offset_min = (beijing_min + 960) % 1440;
        catalog.peak_pricing_2x_for(
            "deepseek",
            "deepseek-v4-flash",
            BASE_UTC_2026_01_01 + offset_min * 60,
        )
    };
    // 峰内：09:00（入峰含）~ 11:59
    assert!(at_beijing(9 * 60));
    assert!(at_beijing(10 * 60 + 30));
    assert!(at_beijing(11 * 60 + 59));
    // 出峰：12:00（左闭右开）
    assert!(!at_beijing(12 * 60));
    assert!(!at_beijing(13 * 60));
    // 第二窗口：14:00 入峰 ~ 17:59；18:00 出峰
    assert!(at_beijing(14 * 60));
    assert!(at_beijing(17 * 60 + 59));
    assert!(!at_beijing(18 * 60));
    // 夜间谷（0 点 / 凌晨 2 点）
    assert!(!at_beijing(2 * 60));
    assert!(!at_beijing(0));
    // 08:59 出峰
    assert!(!at_beijing(8 * 60 + 59));
}

/// 非峰谷模型 / 未知模型 → false（gpt-5.5 无 peakPricing2x）
#[test]
fn peak_pricing_2x_false_for_others() {
    let catalog = ModelCatalog::bundled();
    assert!(!catalog.peak_pricing_2x_for("openai", "gpt-5.5", BASE_UTC_2026_01_01 + 9 * 3600));
    assert!(!catalog.peak_pricing_2x_for("nobody", "whatever", BASE_UTC_2026_01_01 + 9 * 3600));
}

/// 窗口解析失败 / 越界值 → false（防御坏数据）
#[test]
fn peak_pricing_window_parse_defensive() {
    assert!(!window_contains("09:00-12:00", 8 * 60));
    assert!(window_contains("09:00-12:00", 9 * 60));
    // 非法窗口
    assert!(!window_contains("9:00-12:00", 9 * 60));
    assert!(!window_contains("09:00-12:61", 9 * 60));
    assert!(!window_contains("bogus", 9 * 60));
    assert!(!window_contains("", 9 * 60));
    // 分钟越界判定
    assert_eq!(beijing_minutes_of(BASE_UTC_2026_01_01), 8 * 60);
    assert_eq!(beijing_minutes_of(BASE_UTC_2026_01_01 + 3600), 9 * 60);
}

/// effectiveFrom 未到 → 未生效（构造带 future effectiveFrom 的条目）
#[test]
fn peak_pricing_2x_honors_effective_from() {
    let mut entry = ModelCatalogEntry {
        model: "deepseek-v4-flash".to_string(),
        provider: "deepseek".to_string(),
        vendor: "deepseek".to_string(),
        peak_pricing_2x: true,
        peak_pricing_schedule: Some(PeakPricingSchedule {
            windows: vec!["09:00-12:00".to_string(), "14:00-18:00".to_string()],
            tz: "Asia/Shanghai".to_string(),
            // 2026-09-01 生效：2026-01-01（北京 08:00）远早于生效日 → false
            effective_from: Some("2026-09-01".to_string()),
            note: None,
        }),
        ..Default::default()
    };
    // 生效前：峰时段也不计 2x
    assert!(!peak_pricing_2x_at(&entry, BASE_UTC_2026_01_01 + 9 * 3600));
    // 生效后（北京 2026-09-01 09:00 = UTC 08-31 18:00 后 9h）→ true
    let sep1_utc = parse_date_utc_epoch("2026-09-01").expect("日期可解析") - 28_800;
    assert!(peak_pricing_2x_at(&entry, sep1_utc + 9 * 3600));
    // effectiveFrom 移除（null = 已生效）→ 峰时段 true
    entry.peak_pricing_schedule.as_mut().unwrap().effective_from = None;
    assert!(peak_pricing_2x_at(&entry, BASE_UTC_2026_01_01 + 9 * 3600));
}

/// effectiveFrom 解析与日期算术（2026-09-01 北京 0 点 = UTC 08-31 16:00）
#[test]
fn parse_date_utc_epoch_arithmetic() {
    // 2026-01-01 = 20454 天（Node Date.UTC(2026,0,1)/86400 实测）
    assert_eq!(parse_date_utc_epoch("2026-01-01"), Some(20_454 * 86_400));
    // 2026-09-01 = 2026-01-01 + 243 天（1月31+2月28+3月31+4月30+5月31+6月30+7月31+8月31）
    assert_eq!(
        parse_date_utc_epoch("2026-09-01"),
        Some((20_454 + 243) * 86_400)
    );
    // 非法输入 → None
    assert_eq!(parse_date_utc_epoch("2026-13-01"), None);
    assert_eq!(parse_date_utc_epoch("2026-01-32"), None);
    assert_eq!(parse_date_utc_epoch("2026/01/01"), None);
    assert_eq!(parse_date_utc_epoch("2026-01"), None);
    assert_eq!(parse_date_utc_epoch("bogus"), None);
    // 窗口解析失败不 panic
    assert!(!peak_pricing_2x_at(
        &ModelCatalogEntry {
            model: "x".to_string(),
            provider: "p".to_string(),
            vendor: "v".to_string(),
            peak_pricing_2x: true,
            peak_pricing_schedule: Some(PeakPricingSchedule {
                windows: vec!["bogus".to_string()],
                tz: "Asia/Shanghai".to_string(),
                effective_from: None,
                note: None,
            }),
            ..Default::default()
        },
        BASE_UTC_2026_01_01
    ));
}

// ===== T1.1 (G2)：模型级档位映射载体 =====

/// 旧 Vec 数组形式（`["low","medium","xhigh"]`）解析 → 映射载体，各档 wire 拼写
/// 同规范名（向后兼容逐字段不变）；缺失/null → None
#[test]
fn t11_legacy_vec_tiers_parse_to_identity_map() {
    // 数组形式
    let entry: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "model": "qwen3-8-max",
        "provider": "dashscope",
        "vendor": "qwen",
        "supportsReasoningEffort": true,
        "thinkingTiers": ["low", "medium", "xhigh"],
    }))
    .expect("旧 Vec 数组形式必须可解析");
    assert_eq!(
        entry.thinking_tiers,
        Some(BTreeMap::from([
            ("low".to_string(), Some("low".to_string())),
            ("medium".to_string(), Some("medium".to_string())),
            ("xhigh".to_string(), Some("xhigh".to_string())),
        ]))
    );
    // 每档 wire 拼写 = 规范名
    assert_eq!(entry.wire_effort_for("low"), Some("low"));
    assert_eq!(entry.wire_effort_for("medium"), Some("medium"));
    assert_eq!(entry.wire_effort_for("xhigh"), Some("xhigh"));
    assert_eq!(
        entry.offered_levels(),
        vec!["low".to_string(), "medium".to_string(), "xhigh".to_string()]
    );

    // null 与缺省 → None
    let null_entry: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "thinkingTiers": null }))
            .expect("null 必须解析为 None");
    assert_eq!(null_entry.thinking_tiers, None);

    // 缺省（default 兜底）→ None
    let default_entry: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "model": "x" })).expect("缺省必须可解析");
    assert_eq!(default_entry.thinking_tiers, None);
}

/// 新映射形式（`{"low":null,"medium":"high"}`）serde roundtrip，含 None 隐藏项
#[test]
fn t11_map_tiers_roundtrip_with_hidden_items() {
    let raw = r#"{
        "model": "glm-5.2",
        "provider": "zai",
        "vendor": "glm",
        "thinkingTiers": {"low": null, "medium": "high", "high": "high", "max": "max", "minimal": null}
    }"#;
    let entry: ModelCatalogEntry = serde_json::from_str(raw).expect("新映射形式必须可解析");
    // v2 单载体：thinking_tiers 为唯一档位源，Some=wire 提供 / None=隐藏
    assert_eq!(
        entry.thinking_tiers,
        Some(BTreeMap::from([
            ("low".to_string(), None),
            ("medium".to_string(), Some("high".to_string())),
            ("high".to_string(), Some("high".to_string())),
            ("max".to_string(), Some("max".to_string())),
            ("minimal".to_string(), None),
        ]))
    );
    // roundtrip：序列化后重新解析必须逐位一致（含 None 隐藏项）
    let serialized = serde_json::to_string(&entry).expect("必须可序列化");
    let reparsed: ModelCatalogEntry =
        serde_json::from_str(&serialized).expect("roundtrip 必须可解析");
    assert_eq!(reparsed, entry);

    // 隐藏档（None）不进入提供档集；提供的档并集字典序。
    // 提供档 = {medium(改名 high), high, max}；隐藏档 minimal/low 不入集。
    assert_eq!(
        entry.offered_levels(),
        vec!["high".to_string(), "max".to_string(), "medium".to_string()]
    );
}

/// 查询辅助 wire_effort_for：改名映射返回改名后 wire；隐藏档（None 值）与未收录档返回 None
///
/// 注意：R4 T4.2「改名 wire」消费正是 `{medium:"high"}` → wire 字节 "high"。
#[test]
fn t11_wire_effort_for_rename_and_hidden() {
    // 改名映射（独立 reasoning_effort_tiers 改名场景）
    let renamed: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "thinkingTiers": {"medium": "high", "low": "low"},
    }))
    .expect("改名映射必须可解析");
    assert_eq!(
        renamed.wire_effort_for("medium"),
        Some("high"),
        "改名映射返回 wire 拼写"
    );
    assert_eq!(
        renamed.wire_effort_for("low"),
        Some("low"),
        "同名档原样返回"
    );
    assert_eq!(renamed.wire_effort_for("high"), None, "未收录档 → None");

    // 隐藏档（None 值）：wire_effort_for 返回 None，offered_levels 不含该档
    let hidden: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        "thinkingTiers": {"minimal": null, "low": null, "high": "high", "max": "max"},
    }))
    .expect("含隐藏档映射必须可解析");
    assert_eq!(
        hidden.wire_effort_for("minimal"),
        None,
        "隐藏档（None 值）→ None"
    );
    assert_eq!(
        hidden.wire_effort_for("low"),
        None,
        "隐藏档（None 值）→ None"
    );
    assert_eq!(
        hidden.wire_effort_for("high"),
        Some("high"),
        "提供档返回 wire"
    );
    assert_eq!(
        hidden.offered_levels(),
        vec!["high".to_string(), "max".to_string()]
    );
}

/// 查询辅助单载体：thinking_tiers 为唯一档位源（v2 单源裁决，无跨字段回落）
#[test]
fn t11_wire_effort_for_single_source() {
    let entry: ModelCatalogEntry = serde_json::from_value(serde_json::json!({
        // 单一载体（v2 单源）：medium 改名 high、low 同名、minimal 隐藏
        "thinkingTiers": {
            "minimal": null,
            "low": "low",
            "medium": "high",
            "high": "high",
            "max": "max",
        },
    }))
    .expect("必须可解析");
    // 改名命中
    assert_eq!(
        entry.wire_effort_for("medium"),
        Some("high"),
        "改名映射返回 wire 拼写"
    );
    assert_eq!(entry.wire_effort_for("low"), Some("low"));
    assert_eq!(entry.wire_effort_for("max"), Some("max"));
    // 隐藏档与未收录档 → None
    assert_eq!(entry.wire_effort_for("minimal"), None);
    assert_eq!(entry.wire_effort_for("bogus"), None, "未收录档 → None");
    // offered_levels 提供档集：low / medium / high / max（隐藏档 minimal 不入集）
    assert_eq!(
        entry.offered_levels(),
        vec![
            "high".to_string(),
            "low".to_string(),
            "max".to_string(),
            "medium".to_string()
        ]
    );
}

/// 空数组 / 空对象 → None（无提供档位），与"空 = 未提供"语义一致
#[test]
fn t11_empty_tier_map_is_none() {
    let empty_arr: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "thinkingTiers": [] }))
            .expect("空数组必须可解析");
    assert_eq!(empty_arr.thinking_tiers, None, "空数组 → None");
    let empty_obj: ModelCatalogEntry =
        serde_json::from_value(serde_json::json!({ "thinkingTiers": {} }))
            .expect("空对象必须可解析");
    assert_eq!(empty_obj.thinking_tiers, None, "空对象 → None");
    assert!(empty_obj.offered_levels().is_empty());
}

/// 默认空白目录（无任何供应商）与多级安全降级断言
#[test]
fn empty_catalog_has_no_entries_and_lookups_gracefully_degrade() {
    let cat = ModelCatalog::empty();
    assert_eq!(cat.version(), 0);
    assert!(cat.entries.is_empty());
    assert_eq!(cat.lookup("deepseek", "deepseek-v4-flash"), None);
    assert_eq!(
        cat.context_window_for("deepseek", "deepseek-v4-flash"),
        None
    );
    assert_eq!(cat.max_output_for("deepseek", "deepseek-v4-flash"), None);
    assert_eq!(cat.input_price_for("deepseek", "deepseek-v4-flash"), None);
    assert!(!cat.supports_prompt_caching_for("deepseek", "deepseek-v4-flash"));
    assert!(!cat.supports_responses_for("deepseek", "deepseek-v4-flash"));
}

/// 解析纯净的 version: 2, providers: {} 初始态
#[test]
fn yaml_empty_providers_parses_to_empty_catalog() {
    let cat =
        ModelCatalog::from_yaml_str("version: 2\nproviders: {}\n").expect("解析空供应商必须成功");
    assert!(cat.entries.is_empty());
    assert_eq!(cat.version(), 1);

    let empty_yaml = ModelCatalog::from_yaml_str("").expect("空字符串内容必须安全解析");
    assert!(empty_yaml.entries.is_empty());
}

/// 解析 v2 树状结构并正确构建运行时模型目录条目
#[test]
fn yaml_v2_tree_populates_entries_and_capabilities() {
    let yaml = r#"
version: 2
providers:
  deepseek:
    displayName: "DeepSeek"
    baseUrl: "https://api.deepseek.com"
    protocol: "openai/chat"
    models:
      - id: "deepseek-v4-pro"
        displayName: "DeepSeek V4 Pro"
        contextWindow: 1048576
        maxOutputTokens: 8192
        thinking:
          Low: "low"
          High: "high"
        pricing:
          currency: "USD"
          input: 0.14
          output: 0.28
          cacheRead: 0.014
          cacheWrite: 0.14
        modalities:
          input: [text, image]
          output: [text]
"#;
    let cat = ModelCatalog::from_yaml_str(yaml).expect("v2 树状 YAML 必须解析成功");
    assert_eq!(cat.entries.len(), 1);

    let entry = cat
        .lookup("deepseek", "deepseek-v4-pro")
        .expect("必须命中条目");
    assert_eq!(entry.model, "deepseek-v4-pro");
    assert_eq!(entry.vendor, "deepseek");
    assert_eq!(entry.context_window, Some(1048576));
    assert_eq!(entry.max_output_tokens, Some(8192));
    assert_eq!(entry.input_price, Some(0.14));
    assert_eq!(entry.output_price, Some(0.28));
    assert_eq!(entry.cache_read_price, Some(0.014));
    assert_eq!(entry.cache_write_price, Some(0.14));
    assert!(entry.supports_reasoning);
    assert!(entry.supports_vision);
    assert_eq!(
        entry.input_modalities.as_deref(),
        Some(&["text".to_string(), "image".to_string()][..])
    );
    assert_eq!(entry.wire_effort_for("High"), Some("high"));
    assert!(
        entry
            .thinking_tiers
            .as_ref()
            .is_some_and(|m| m.contains_key("Low") && !m.contains_key("low")),
        "thinking_tiers 必须保留 TitleCase 键"
    );
}

/// 轨G P2 钉死：yaml 树投影把 vendor 折叠为 provider_id（通道即厂商折叠语义）。
/// 若未来恢复独立 vendor 字段，本测试必须同步改（禁止单点解折叠）。
#[test]
fn yaml_projection_folds_vendor_into_provider_id() {
    let yaml = r#"
version: 2
providers:
  dashscope:
    protocol: openai/chat
    models:
      - id: qwen-max
        contextWindow: 32768
"#;
    let cat = ModelCatalog::from_yaml_str(yaml).expect("yaml");
    let entry = cat.lookup("dashscope", "qwen-max").expect("entry");
    assert_eq!(entry.provider, "dashscope");
    assert_eq!(
        entry.vendor, "dashscope",
        "yaml 投影折叠语义：vendor 恒等于 provider_id"
    );
    assert_eq!(entry.id, Some(ModelRef::new("dashscope", "qwen-max").key()));
    assert_eq!(
        ModelCatalogEntry::key(&entry.vendor, &entry.model),
        ModelRef::new("dashscope", "qwen-max").key(),
        "catalog key 与身份键同源（JSON 二元组，无分隔符碰撞）"
    );
}

/// TitleCase thinking + modalities.input 含 image；禁止小写归一、禁止 bool modalities 生产投影
#[test]
fn from_yaml_str_keeps_titlecase_thinking_and_input_modalities() {
    let yaml = r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: https://example.invalid/v1
    protocol: openai/chat
    apiKeyRef: env:ACME_API_KEY
    compat:
      thinkingFormat: gemini
    models:
      - id: acme-think
        displayName: Acme Think
        contextWindow: 128000
        thinking:
          Low: low
          High: high
        modalities:
          input: [text, image]
          output: [text]
        pricing:
          currency: USD
          input: 10
          output: 2
          cacheRead: 0.25
          cacheWrite: 0.2
      - id: acme-bare
"#;
    let live = LiveModels::from_yaml_str(yaml).expect("v2 yaml 必须同时得到树与投影");
    let spec = live
        .find("acme", "acme-think")
        .expect("find(acme, acme-think)");
    assert_eq!(
        spec.thinking
            .as_ref()
            .and_then(|m| m.get("Low"))
            .map(String::as_str),
        Some("low")
    );
    assert!(spec
        .thinking
        .as_ref()
        .is_some_and(|m| !m.contains_key("low")));
    assert!(spec
        .modalities
        .as_ref()
        .is_some_and(|m| m.input.iter().any(|x| x == "image")));

    let entry = live.catalog.lookup("acme", "acme-think").expect("投影条目");
    assert!(entry
        .thinking_tiers
        .as_ref()
        .is_some_and(|m| m.contains_key("Low") && !m.contains_key("low")));
    assert_eq!(entry.wire_effort_for("Low"), Some("low"));
    assert!(entry
        .input_modalities
        .as_ref()
        .is_some_and(|m| m.iter().any(|x| x == "image")));
    assert!(entry.supports_vision);
    assert_eq!(entry.thinking_format.as_deref(), Some("gemini"));
    assert_eq!(entry.protocol.as_deref(), Some("openai/chat"));
    assert!(entry.mode.is_none(), "协议字面量不得塞进 mode");
    assert_eq!(entry.input_price, Some(10.0));
    assert_eq!(entry.cache_read_price, Some(0.25));
    assert_ne!(
        entry.cache_read_price,
        Some(entry.input_price.unwrap() * 0.1),
        "禁止用 input 折扣填 cacheRead"
    );

    let bare = live.find("acme", "acme-bare").expect("bare");
    assert_eq!(bare.context_window, None, "缺省窗口不得发明 128000");
    assert_eq!(bare.display_name, None);
    let bare_entry = live.catalog.lookup("acme", "acme-bare").expect("bare 投影");
    assert_eq!(bare_entry.context_window, None);
    assert!(!bare_entry.supports_vision);
}

/// 损坏 yaml 必须 Err，不得 Ok(empty) 冒充合法空配置
#[test]
fn from_yaml_str_damaged_yaml_is_err_not_empty_ok() {
    let err = ModelCatalog::from_yaml_str("{{{not yaml").expect_err("损坏 yaml 不得变成 Ok");
    assert!(!err.is_empty());
    assert!(LiveModels::from_yaml_str("providers: [").is_err());
    assert!(ModelCatalog::from_yaml_str("models:\n  - model: x\n    vendor: y\n").is_err());

    let empty = ModelCatalog::from_yaml_str("").expect("空白是诚实空目录");
    assert!(empty.entries.is_empty());
}

/// 文件缺失态 vs 首次坏文件态：同一空 tree 必须靠 parse_error 区分
#[test]
fn live_models_parse_failed_is_not_honest_empty() {
    let empty = LiveModels::empty();
    assert!(empty.parse_error.is_none(), "文件缺失是诚实空树");
    assert!(empty.tree.providers.is_empty());

    let failed = LiveModels::parse_failed("解析 models.yaml 语法失败: bad");
    assert_eq!(
        failed.parse_error.as_deref(),
        Some("解析 models.yaml 语法失败: bad")
    );
    assert!(
        failed.tree.providers.is_empty(),
        "错误态 tree 为空，但不得当成用户清空"
    );
    assert!(failed.find("acme", "acme-think").is_none());
}

/// 缺 displayName / baseUrl 的合法 yaml：live 必须能解析（与 IPC 同构）
#[test]
fn live_models_parses_yaml_missing_provider_display_name() {
    let yaml = r#"
version: 2
providers:
  acme:
    models:
      - id: acme-think
        thinking:
          Low: low
        modalities:
          input: [text, image]
          output: [text]
"#;
    let live = LiveModels::from_yaml_str(yaml).expect("缺 displayName 必须能解析");
    assert!(live.parse_error.is_none());
    let provider = live.tree.find_provider("acme").expect("acme");
    assert_eq!(provider.display_name, None);
    assert_eq!(provider.base_url, None);
    let spec = live.find("acme", "acme-think").expect("find");
    assert_eq!(
        spec.thinking
            .as_ref()
            .and_then(|m| m.get("Low"))
            .map(String::as_str),
        Some("low")
    );
}

/// 布尔 modalities 不再是生产投影形状：{image:true} 不得变成 supports_vision
#[test]
fn yaml_boolean_modalities_are_not_production_projection() {
    let yaml = r#"
version: 2
providers:
  x:
    displayName: X
    baseUrl: https://example.invalid
    models:
      - id: m
        modalities:
          image: true
"#;
    assert!(
        ModelCatalog::from_yaml_str(yaml).is_err(),
        "未知模态字段不能静默丢失"
    );
}
