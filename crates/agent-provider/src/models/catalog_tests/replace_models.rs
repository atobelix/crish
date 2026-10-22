use super::*;

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
