use super::*;

#[test]
fn test_unified_models_config_serde_json() {
    let json_data = r#"{
            "version": 2,
            "providers": {
                "deepseek": {
                    "displayName": "DeepSeek",
                    "baseUrl": "https://api.deepseek.com",
                    "apiKeyRef": "env:DEEPSEEK_API_KEY",
                    "protocol": "openai/chat",
                    "compat": {
                        "thinkingFormat": "deepseek",
                        "supportsDeveloperRole": false,
                        "maxTokensField": "max_tokens"
                    },
                    "models": [
                        {
                            "id": "deepseek-v4-pro",
                            "displayName": "DeepSeek V4 Pro",
                            "contextWindow": 1048576,
                            "maxOutputTokens": 384000,
                            "modalities": {
                                "input": ["text", "image"],
                                "output": ["text"]
                            },
                            "thinking": {
                                "Low": "low",
                                "Medium": "medium",
                                "High": "high"
                            },
                            "pricing": {
                                "currency": "CNY",
                                "input": 3.0,
                                "output": 9.0,
                                "cacheRead": 0.1,
                                "cacheWrite": 0.0
                            }
                        }
                    ]
                }
            }
        }"#;

    let config: UnifiedModelsConfig =
        serde_json::from_str(json_data).expect("反序列化 UnifiedModelsConfig 必须成功");
    assert_eq!(config.version, 2);
    assert_eq!(config.providers.len(), 1);

    let provider = config
        .find_provider("deepseek")
        .expect("应能查找到 deepseek");
    assert_eq!(provider.display_name.as_deref(), Some("DeepSeek"));
    assert_eq!(provider.protocol, ProtocolKind::OpenAiChat);
    assert_eq!(
        provider.api_key_ref.as_deref(),
        Some("env:DEEPSEEK_API_KEY")
    );

    let model = provider
        .find_model("deepseek-v4-pro")
        .expect("应能查找到 deepseek-v4-pro");
    assert_eq!(model.display_name.as_deref(), Some("DeepSeek V4 Pro"));
    assert_eq!(model.context_window, Some(1048576));
    assert_eq!(model.max_output_tokens, Some(384000));

    // modalities 一等公民断言
    let modalities = model.modalities.as_ref().expect("modalities 必须存在");
    assert!(modalities.supports_input("text"));
    assert!(modalities.supports_input("image"));
    assert!(!modalities.supports_input("audio"));
    assert!(modalities.supports_output("text"));
    assert!(!modalities.supports_output("image"));
    assert!(model.supports_image_input());

    // 拍平 thinking 验证 (无 levels 包装)
    assert!(model.supports_thinking());
    assert_eq!(
        model.thinking.available_titles(),
        vec!["Low", "Medium", "High"]
    );
    assert_eq!(model.thinking.get_wire_value("Low"), Some("low"));
    assert_eq!(model.thinking.get_wire_value("Medium"), Some("medium"));
    assert_eq!(model.thinking.get_wire_value("High"), Some("high"));
    assert_eq!(model.thinking.get_wire_value("Off"), None);
    assert!(!model.thinking.allows_off()); // 强制思考：无 "Off" 键

    // 四维独立价格验证
    let pricing = model.pricing.as_ref().expect("pricing 必须存在");
    assert_eq!(pricing.currency, CurrencyKind::Cny);
    assert_eq!(pricing.currency.symbol(), "¥");
    assert_eq!(pricing.input, Some(3.0));
    assert_eq!(pricing.output, Some(9.0));
    assert_eq!(pricing.cache_read, Some(0.1));
    assert_eq!(pricing.cache_write, Some(0.0));

    // 唯一算费入口委托引擎（plans/05 §3.1/§3.2）：cache_read 从 prompt 扣减。
    // prompt=1M、cache_read=2M → 输入段 0；output 0.5M×9=4.5；
    // cache_read 2M×0.1=0.2；cache_write 0.1M×0=0 → total 4.7
    let cost = pricing
        .calculate_cost(1_000_000, 500_000, 600_000, 100_000)
        .expect("有单价必须出账");
    assert_eq!(cost.total_micros, 5_460_000);
    assert_eq!(cost.formatted_total, "¥5.4600");
    assert!(!cost.is_free);

    // 协议继承验证
    assert_eq!(model.effective_protocol(provider), ProtocolKind::OpenAiChat);
    assert_eq!(
        config.effective_protocol("deepseek", "deepseek-v4-pro"),
        Some(ProtocolKind::OpenAiChat)
    );

    // 重新序列化测试
    let serialized = serde_json::to_string_pretty(&config).expect("序列化必须成功");
    assert!(serialized.contains("\"displayName\": \"DeepSeek\""));
    assert!(serialized.contains("\"cacheRead\": 0.1"));
    assert!(!serialized.contains("\"levels\""));
}

#[test]
fn test_thinking_with_off_and_protocol_override() {
    let json_data = r#"{
            "id": "gpt-5.6-sol",
            "displayName": "GPT-5.6 Sol",
            "protocol": "openai/responses",
            "contextWindow": 1050000,
            "maxOutputTokens": 128000,
            "thinking": {
                "Off": "off",
                "Low": "low",
                "High": "high"
            }
        }"#;

    let model: ModelSpec = serde_json::from_str(json_data).expect("反序列化 ModelSpec 必须成功");
    assert_eq!(model.protocol, Some(ProtocolKind::OpenAiResponses));
    assert!(model.thinking.allows_off());
    assert_eq!(model.thinking.get_wire_value("Off"), Some("off"));
    assert_eq!(model.thinking.get_wire_value("High"), Some("high"));

    let provider = ProviderSpec {
        display_name: Some("OpenAI".to_string()),
        base_url: Some("https://api.openai.com/v1".to_string()),
        api_key_ref: None,
        headers: None,
        protocol: ProtocolKind::OpenAiChat,
        compat: None,
        models: vec![model.clone()],
        ..Default::default()
    };

    // 模型局部协议覆盖生效
    assert_eq!(
        model.effective_protocol(&provider),
        ProtocolKind::OpenAiResponses
    );
}

/// W9-F-2：`allows_off()` 按别名接受集判定 —— 键 `None`（内核合法同义词）
/// 与 `Off` 等价，均视为允许关闭；无关闭档键 → 强制思考。
#[test]
fn test_allows_off_accepts_none_alias() {
    for (key, allows) in [("None", true), ("Off", true), ("High", false)] {
        let raw = serde_json::json!({"providers": {"p": {"models": [{
            "id": "m", "thinking": {key: "wire"}
        }]}}});
        let config =
            UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&raw).unwrap()).unwrap();
        assert_eq!(
            config.find_model("p", "m").unwrap().thinking.allows_off(),
            allows
        );
    }
}

#[test]
fn test_provider_find_model_trims_but_is_case_sensitive() {
    let model: ModelSpec =
        serde_json::from_str(r#"{"id":"acme-think"}"#).expect("反序列化 ModelSpec 必须成功");
    let provider = ProviderSpec {
        display_name: Some("Acme".to_string()),
        base_url: Some("https://acme.invalid/v1".to_string()),
        api_key_ref: None,
        headers: None,
        protocol: ProtocolKind::OpenAiChat,
        compat: None,
        models: vec![model],
        ..Default::default()
    };
    assert!(provider.find_model("acme-think").is_some(), "精确命中");
    assert!(
        provider.find_model("  acme-think  ").is_some(),
        "首尾空白必须 trim 后命中"
    );
    assert!(
        provider.find_model("ACME-THINK").is_none(),
        "大小写变体不命中（W10：不做 lowercase）"
    );
}

#[test]
fn test_google_protocol_alias() {
    let direct: ProtocolKind = serde_json::from_str(r#""google/generate-content""#).unwrap();
    assert_eq!(direct, ProtocolKind::GoogleGenerateContent);
    assert!(serde_json::from_str::<ProtocolKind>(r#""google/interactions""#).is_err());
    let raw =
        serde_json::json!({"providers": {"p": {"protocol": "google/interactions", "models": []}}});
    let migrated = crate::migration::ConfigMigrationManager::migrate_legacy_value(&raw).unwrap();
    assert_eq!(
        migrated["providers"]["p"]["protocol"],
        "google/generate-content"
    );
    assert_eq!(
        serde_json::to_string(&direct).unwrap(),
        "\"google/generate-content\""
    );
}

#[test]
fn test_unified_models_config_from_yaml_titlecase_thinking_and_optional_windows() {
    let yaml = r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: https://example.invalid/v1
    protocol: openai/chat
    apiKeyRef: env:ACME_API_KEY
    headers:
      X-Test: "1"
    compat:
      thinkingFormat: gemini
    models:
      - id: acme-think
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
"#;
    let config =
        UnifiedModelsConfig::from_yaml_str(yaml).expect("v2 yaml 必须进入 UnifiedModelsConfig");
    let provider = config.find_provider("acme").expect("acme");
    assert_eq!(
        provider
            .headers
            .as_ref()
            .and_then(|h| h.get("X-Test"))
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(
        provider.compat.as_ref().and_then(|c| c.thinking_format),
        Some(ThinkingFormat::Gemini)
    );

    let model = config.find_model("acme", "acme-think").expect("acme-think");
    assert_eq!(model.display_name, None, "缺省 displayName 不得发明占位");
    assert_eq!(model.context_window, None, "缺省窗口不得发明 128000");
    assert_eq!(model.max_output_tokens, None);
    assert_eq!(
        model
            .thinking
            .as_ref()
            .and_then(|m| m.get("Low"))
            .map(String::as_str),
        Some("low")
    );
    assert!(model
        .thinking
        .as_ref()
        .is_some_and(|m| m.contains_key("Low")));
    assert!(
        model
            .thinking
            .as_ref()
            .is_some_and(|m| !m.contains_key("low")),
        "禁止把 TitleCase 键小写归一"
    );
    assert!(model.supports_image_input());
    let pricing = model.pricing.as_ref().expect("pricing");
    assert_eq!(pricing.input, Some(10.0));
    assert_eq!(pricing.cache_read, Some(0.25));
    assert_ne!(pricing.cache_read, pricing.input.map(|rate| rate * 0.1));
}

#[test]
fn test_from_yaml_str_damaged_is_err_not_empty() {
    let err = UnifiedModelsConfig::from_yaml_str("{{{not yaml")
        .expect_err("损坏 yaml 不得变成 Ok(empty)");
    assert!(err.contains("语法失败") || err.contains("解析"));

    let v1 = UnifiedModelsConfig::from_yaml_str("models:\n  - model: x\n    vendor: y\n")
        .expect_err("v1 扁平不得冒充合法空 providers");
    assert!(v1.contains("v1"));

    let empty = UnifiedModelsConfig::from_yaml_str("").expect("空白是诚实空树");
    assert!(empty.providers.is_empty());
    let nullish = UnifiedModelsConfig::from_yaml_str("null").expect("null 是诚实空树");
    assert!(nullish.providers.is_empty());
    let comments = UnifiedModelsConfig::from_yaml_str("# 仅注释\n").expect("仅注释是诚实空树");
    assert!(comments.providers.is_empty());
}

#[test]
fn test_from_yaml_str_missing_display_name_and_base_url_parses() {
    let yaml = r#"
version: 2
providers:
  acme:
    protocol: openai/chat
    models:
      - id: acme-think
        thinking:
          Low: low
"#;
    let config = UnifiedModelsConfig::from_yaml_str(yaml)
        .expect("缺 displayName / baseUrl 的合法 yaml 必须能解析");
    let provider = config.find_provider("acme").expect("acme");
    assert_eq!(provider.display_name, None);
    assert_eq!(provider.base_url, None);
    let model = config.find_model("acme", "acme-think").expect("acme-think");
    assert_eq!(
        model
            .thinking
            .as_ref()
            .and_then(|m| m.get("Low"))
            .map(String::as_str),
        Some("low")
    );
}

#[test]
fn test_from_yaml_str_normalizes_legacy_keys_once() {
    let yaml = r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: https://example.invalid/v1
    protocol: google/interactions
    compat:
      thinkingFormat: google
    models:
      - id: acme-think
        contextLength: 128000
        compat:
          thinkingFormat: qwen_enable_thinking
        pricing:
          currency: USD
          inputPerMTok: 1
          output_per_m_tok: 2
          cacheReadPerMTok: 0.1
          cacheWritePerMTok: 0.2
          per_image_cost: 3
"#;
    assert!(
        UnifiedModelsConfig::from_yaml_str(yaml).is_err(),
        "旧字段不进入规范运行树"
    );
    let raw: serde_json::Value = serde_yaml::from_str(yaml).unwrap();
    let migrated = crate::migration::ConfigMigrationManager::migrate_legacy_value(&raw).unwrap();
    let config =
        UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&migrated).unwrap()).unwrap();
    let provider = config.find_provider("acme").expect("acme");
    assert_eq!(provider.protocol, ProtocolKind::GoogleGenerateContent);
    assert_eq!(
        provider.compat.as_ref().and_then(|c| c.thinking_format),
        Some(ThinkingFormat::Gemini)
    );
    let model = config.find_model("acme", "acme-think").expect("acme-think");
    assert_eq!(model.context_window, Some(128000));
    assert_eq!(
        model.compat.as_ref().and_then(|c| c.thinking_format),
        Some(ThinkingFormat::Qwen)
    );
    let pricing = model.pricing.as_ref().expect("pricing");
    assert_eq!(pricing.input, Some(1.0));
    assert_eq!(pricing.output, Some(2.0));
    assert_eq!(pricing.cache_read, Some(0.1));
    assert_eq!(pricing.cache_write, Some(0.2));
    assert_eq!(pricing.per_image, Some(3.0));

    let written = serde_yaml::to_string(&config).expect("写出");
    assert!(written.contains("contextWindow"));
    assert!(!written.contains("contextLength"));
    assert!(written.contains("cacheRead"));
    assert!(!written.contains("inputPerMTok"));
    assert!(!written.contains("per_image_cost"));
    assert!(written.contains("google/generate-content"));
    assert!(!written.contains("google/interactions"));
    assert!(written.contains("gemini"));
    assert!(written.contains("qwen"));
    assert!(!written.contains("qwen_enable_thinking"));
}

#[test]
fn test_normalize_yaml_aliases_scoped_not_global() {
    let raw = serde_json::json!({"providers": {"p": {
        "headers": {"inputPerMTok": "999", "contextLength": "header-value"},
        "models": [{"id": "m", "contextLength": 128000,
            "pricing": {"currency": "USD", "inputPerMTok": 1.5}}]
    }}});
    let migrated = crate::migration::ConfigMigrationManager::migrate_legacy_value(&raw).unwrap();
    let provider = &migrated["providers"]["p"];
    assert_eq!(provider["headers"]["inputPerMTok"], "999");
    assert_eq!(provider["headers"]["contextLength"], "header-value");
    assert_eq!(provider["models"][0]["contextWindow"], 128000);
    assert_eq!(
        provider["models"][0]["pricing"]["input"].as_f64(),
        Some(1.5)
    );
    assert!(provider["models"][0]["pricing"]
        .get("inputPerMTok")
        .is_none());
}

#[test]
fn test_normalize_yaml_thinking_format_only_in_compat() {
    let raw = serde_json::json!({"providers": {"p": {
        "compat": {"thinkingFormat": "google"},
        "headers": {"thinkingFormat": "google"}, "models": []
    }}});
    let migrated = crate::migration::ConfigMigrationManager::migrate_legacy_value(&raw).unwrap();
    assert_eq!(
        migrated["providers"]["p"]["compat"]["thinkingFormat"],
        "gemini"
    );
    assert_eq!(
        migrated["providers"]["p"]["headers"]["thinkingFormat"],
        "google"
    );
}

#[test]
fn test_from_yaml_str_rejects_duplicate_model_ids() {
    let yaml = r#"
version: 2
providers:
  acme:
    models:
      - id: a
      - id: a
"#;
    let err = UnifiedModelsConfig::from_yaml_str(yaml).expect_err("重复 model id 必须失败");
    assert!(err.contains("重复"));
}

#[test]
fn test_model_ref_new_normalized_key() {
    let r = ModelRef::new("deepseek", "deepseek-v4-pro");
    assert_eq!(r.provider_id, "deepseek");
    assert_eq!(r.model_id, "deepseek-v4-pro");
    // 归一化仅去首尾空白，Rust 索引保留大小写
    assert_eq!(r.normalized(), r);
    assert_eq!(r.normalized().key(), r.key());
    assert_eq!(
        r.key(),
        serde_json::json!(["deepseek", "deepseek-v4-pro"]).to_string()
    );

    // Into<String> 两段均生效
    let owned = ModelRef::new(String::from("acme"), String::from("acme-think"));
    assert_eq!(
        owned.key(),
        serde_json::json!(["acme", "acme-think"]).to_string()
    );
}

#[test]
fn test_model_ref_same_model_id_across_providers_key_differs() {
    // 两供应商同名模型：key() 必须不相等，杜绝跨厂商串味（INV-1）
    let a = ModelRef::new("provider-a", "gpt-4o");
    let b = ModelRef::new("provider-b", "gpt-4o");
    assert_eq!(a.model_id, b.model_id);
    assert_ne!(a, b);
    assert_ne!(a.key(), b.key());
    assert_eq!(
        a.key(),
        serde_json::json!(["provider-a", "gpt-4o"]).to_string()
    );
    assert_eq!(
        b.key(),
        serde_json::json!(["provider-b", "gpt-4o"]).to_string()
    );
}

#[test]
fn test_model_ref_normalized_aligns_with_live_index() {
    use crate::models::LiveModels;

    let yaml = r#"
version: 2
providers:
  acme:
    models:
      - id: acme-think
"#;
    let live = LiveModels::from_yaml_str(yaml).expect("v2 yaml 必须解析成功");

    // ① 命中路径：ModelRef::key() 与既有索引键（ModelCatalogEntry::key = vendor::model）同形
    let exact = ModelRef::new("acme", "acme-think");
    let n = exact.normalized();
    assert!(
        live.catalog.entries.contains_key(&exact.key()),
        "ModelRef::key() 必须与 ModelCatalog 索引键同形"
    );
    assert!(
        live.find(&n.provider_id, &n.model_id).is_some(),
        "精确二元组必须命中 LiveModels::find"
    );

    // ② 对齐验证：索引按大小写精确匹配，normalized() 仅去首尾空白。
    //    构造带大小写/空白的输入 → 归一化后仍保留原样 → 不命中（若此处命中，说明
    //    归一化被擅自 lowercase/trim，与索引规则不一致）。
    let variant = ModelRef::new(" ACME ", "Acme-Think").normalized();
    assert_eq!(
        variant.key(),
        serde_json::json!(["ACME", "Acme-Think"]).to_string()
    );
    assert!(
        live.find(&variant.provider_id, &variant.model_id).is_none(),
        "Rust 索引为原样精确匹配；归一化仅 trim，不能 lowercase"
    );
}
