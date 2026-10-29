use super::*;

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
