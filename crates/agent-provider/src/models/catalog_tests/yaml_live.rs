use super::*;

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
