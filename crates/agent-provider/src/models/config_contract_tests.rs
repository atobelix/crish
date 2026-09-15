//! 核心配置回归：真实解析、提交归一和序列化往返。

use super::*;
use serde_json::{json, Value};

fn parse(value: serde_json::Value) -> UnifiedModelsConfig {
    UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&value).unwrap()).unwrap()
}

#[test]
fn complete_contract_roundtrip_preserves_every_declared_field() {
    let config = parse(json!({
        "version": 2,
        "activeModel": {"providerId": " Acme ", "modelId": " Model "},
        "providers": {
            " Acme ": {
                "displayName": "供应商甲", "baseUrl": "https://example.invalid/v1",
                "apiKeyRef": "dpapi:00000000-0000-4000-8000-000000000001", "proxyUrl": "socks5://127.0.0.1:1080",
                "headers": {"X-Test": "", "thinkingFormat": "custom-header"},
                "protocol": "openai/chat", "enabled": true, "order": 0,
                "compat": {
                    "thinkingFormat": "qwen", "supportsDeveloperRole": true,
                    "maxTokensField": "max_completion_tokens",
                    "cacheControlFormat": "anthropic", "strictJsonSchema": true
                },
                "models": [{
                    "id": " Model ", "displayName": "", "enabled": true, "order": -1,
                    "contextWindow": 128000, "maxOutputTokens": 8192,
                    "protocol": "openai/responses",
                    "compat": {"supportsDeveloperRole": false, "strictJsonSchema": false},
                    "modalities": {"input": ["text", "image"], "output": []},
                    "thinking": {" low ": " Low Wire ", "X-High": "XHIGH", "None": "0"},
                    "supportsTools": false, "cacheTtl": "30m",
                    "pricing": {
                        "currency": "CNY", "unit": "token",
                        "input": 0, "cacheRead": 0, "cacheWrite": 0.000003,
                        "perImage": 2.5,
                        "tiers": [{"inputTokensAbove": 0, "input": 0, "cacheWrite": 0}]
                    }
                }]
            }
        }
    }));
    let model_ref = config.active_model.as_ref().unwrap();
    assert_eq!(model_ref, &ModelRef::new("Acme", "Model"));
    let (provider, model) = config.find_enabled_model(model_ref).unwrap();
    assert_eq!(provider.order, Some(0));
    assert_eq!(
        provider.proxy_url.as_deref(),
        Some("socks5://127.0.0.1:1080")
    );
    assert_eq!(provider.headers.as_ref().unwrap()["X-Test"], "");
    assert_eq!(model.order, Some(-1));
    assert_eq!(model.display_name.as_deref(), Some(""));
    assert_eq!(model.context_window, Some(128000));
    assert_eq!(model.max_output_tokens, Some(8192));
    assert_eq!(model.supports_tools, Some(false));
    assert_eq!(model.thinking.get_wire_value("Low"), Some(" Low Wire "));
    assert_eq!(model.thinking.get_wire_value("XHigh"), Some("XHIGH"));
    assert_eq!(model.thinking.get_wire_value("Off"), Some("0"));
    let compat = model.effective_compat(provider).unwrap();
    assert_eq!(compat.thinking_format, Some(ThinkingFormat::Qwen));
    assert_eq!(
        compat.cache_control_format,
        Some(CacheControlFormat::Anthropic)
    );
    assert_eq!(
        compat.max_tokens_field,
        Some(MaxTokensField::MaxCompletionTokens)
    );
    assert_eq!(compat.supports_developer_role, Some(false));
    assert_eq!(compat.strict_json_schema, Some(false));
    let pricing = model.pricing.as_ref().unwrap();
    assert_eq!(pricing.unit, PricingUnit::Token);
    assert_eq!(pricing.input, Some(0.0));
    assert_eq!(pricing.output, None);
    assert_eq!(pricing.tiers[0].input, Some(0.0));
    assert_eq!(pricing.tiers[0].output, None);
    let yaml = serde_yaml::to_string(&config).unwrap();
    assert_eq!(UnifiedModelsConfig::from_yaml_str(&yaml).unwrap(), config);
    let json = serde_json::to_value(&config).unwrap();
    assert_eq!(json["activeModel"]["providerId"], "Acme");
    assert!(json["providers"]["Acme"].get("apiKey").is_none());
    assert!(json["providers"]["Acme"]["models"][0]["thinking"]
        .get("X-High")
        .is_none());
}

#[test]
fn identity_case_unicode_and_separator_collisions_remain_distinct() {
    let config = parse(json!({"providers": {
        "Acme": {"models": [{"id": "m"}]},
        "acme": {"models": [{"id": "m"}]},
        "a::b": {"models": [{"id": "c"}]},
        "a": {"models": [{"id": "b::c"}]},
        "供应商/甲": {"models": [{"id": "模型/乙"}]}
    }}));
    for (provider, model) in [
        ("Acme", "m"),
        ("acme", "m"),
        ("a::b", "c"),
        ("a", "b::c"),
        ("供应商/甲", "模型/乙"),
    ] {
        assert!(config.find_model(provider, model).is_some());
    }
    assert!(config.find_model("ACME", "m").is_none());
    assert_ne!(
        ModelRef::new("Acme", "m").key(),
        ModelRef::new("acme", "m").key()
    );
    assert_ne!(
        ModelRef::new("a::b", "c").key(),
        ModelRef::new("a", "b::c").key()
    );
    let raw = ModelRef::new(" 引号\" ", " \\模型::尾 ");
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&raw.key()).unwrap(),
        vec!["引号\"", "\\模型::尾"]
    );
    let live = crate::models::LiveModels::from_unified(config).unwrap();
    assert_eq!(live.catalog.lookup("a::b", "c").unwrap().model, "c");
    assert_eq!(live.catalog.lookup("a", "b::c").unwrap().model, "b::c");
    assert!(live.catalog.lookup("", "m").is_none());
    assert!(live.catalog.lookup("*", "m").is_none());
}

#[test]
fn duplicate_and_empty_identities_are_rejected_before_publication() {
    for yaml in [
        "providers: {Acme: {models: []}, ' Acme ': {models: []}}",
        "providers: {Acme: {models: [{id: m}, {id: ' m '}]}}",
        "providers: {' ': {models: []}}",
        "providers: {Acme: {models: [{id: ' '}]}}",
        "providers: {Acme: {models: []}, Acme: {models: []}}",
    ] {
        assert!(UnifiedModelsConfig::from_yaml_str(yaml).is_err(), "{yaml}");
    }
}

#[test]
fn thinking_aliases_normalize_once_without_changing_wire() {
    for (alias, expected) in [
        ("Off", "Off"),
        ("off", "Off"),
        ("None", "Off"),
        ("disabled", "Off"),
        ("minimal", "Minimal"),
        ("Low", "Low"),
        (" medium ", "Medium"),
        ("high", "High"),
        ("XHigh", "XHigh"),
        ("xhigh", "XHigh"),
        ("X-High", "XHigh"),
        ("x-high", "XHigh"),
        ("max", "Max"),
    ] {
        let mut thinking = serde_json::Map::new();
        thinking.insert(alias.to_owned(), json!("  WIRE-值  "));
        let tree =
            parse(json!({"providers": {"p": {"models": [{"id": "m", "thinking": thinking}]}}}));
        let model = tree.find_model("p", "m").unwrap();
        assert_eq!(model.thinking.get_wire_value(expected), Some("  WIRE-值  "));
        assert_eq!(model.thinking.available_titles(), vec![expected]);
    }
    for thinking in [
        json!({"High": "a", "high": "b"}),
        json!({"XHigh": "a", "X-High": "a"}),
        json!({"Ultra": "ultra"}),
        json!({"Xhigh": "xhigh"}),
    ] {
        let raw = json!({"providers": {"p": {"models": [{"id": "m", "thinking": thinking}]}}});
        assert!(UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&raw).unwrap()).is_err());
    }
    assert!(UnifiedModelsConfig::from_yaml_str(
        "providers: {p: {models: [{id: m, thinking: {High: a, High: b}}]}}"
    )
    .is_err());
}

#[test]
fn active_model_clears_on_missing_disabled_and_deleted_without_fallback() {
    let base = json!({"activeModel": {"providerId": "A", "modelId": "m"}, "providers": {
        "A": {"models": [{"id": "m"}]}, "B": {"models": [{"id": "m"}]}
    }});
    assert_eq!(
        parse(base.clone()).active_model,
        Some(ModelRef::new("A", "m"))
    );
    for change in [
        "provider-disabled",
        "model-disabled",
        "model-deleted",
        "provider-deleted",
    ] {
        let mut raw = base.clone();
        match change {
            "provider-disabled" => raw["providers"]["A"]["enabled"] = json!(false),
            "model-disabled" => raw["providers"]["A"]["models"][0]["enabled"] = json!(false),
            "model-deleted" => raw["providers"]["A"]["models"] = json!([]),
            _ => {
                raw["providers"].as_object_mut().unwrap().remove("A");
            }
        }
        let config = parse(raw);
        assert_eq!(config.active_model, None, "{change}");
        assert_eq!(
            serde_json::to_value(config).unwrap()["activeModel"],
            Value::Null
        );
    }
    let cleared =
        parse(json!({"activeModel": null, "providers": {"B": {"models": [{"id": "m"}]}}}));
    assert!(cleared.active_model.is_none());
}

#[test]
fn malformed_candidate_does_not_mutate_the_original_draft() {
    let mut config = parse(json!({"activeModel": {"providerId": "p", "modelId": "m"},
        "providers": {"p": {"models": [{"id": "m"}]}}}));
    config.providers["p"].models.push(ModelSpec {
        id: " m ".into(),
        ..Default::default()
    });
    let before = config.clone();
    assert!(config.normalize_for_commit().is_err());
    assert_eq!(config, before);
}

#[test]
fn unspecified_empty_zero_and_false_keep_their_meanings() {
    let config = parse(json!({"providers": {"p": {"enabled": false, "headers": {},
        "models": [{"id": "m", "enabled": false, "thinking": {}, "modalities": {"input": [], "output": []},
            "contextWindow": 128000, "maxOutputTokens": 8192, "supportsTools": false},
            {"id": "bare"}]}}}));
    let p = &config.providers["p"];
    assert!(!p.enabled);
    assert_eq!(p.headers, Some(IndexMap::new()));
    let declared = &p.models[0];
    assert_eq!(declared.thinking, Some(IndexMap::new()));
    assert!(!declared.enabled);
    let bare = &p.models[1];
    assert!(bare.enabled);
    assert_eq!(bare.thinking, None);
    assert_eq!(bare.modalities, None);
    assert_eq!(bare.context_window, None);
    assert_eq!(bare.max_output_tokens, None);
    assert_eq!(bare.supports_tools, None);
}

#[test]
fn optional_prices_units_and_image_only_roundtrip_without_invented_zero() {
    for unit in ["per_1m_tokens", "token", "per_image"] {
        let config = parse(json!({"providers": {"p": {"models": [{"id": "image",
            "pricing": {"currency": "USD", "unit": unit, "perImage": 0,
                "tiers": [{"inputTokensAbove": 100, "output": 0, "cacheRead": 0.2}]}}]}}}));
        let pricing = config
            .find_model("p", "image")
            .unwrap()
            .pricing
            .as_ref()
            .unwrap();
        assert_eq!(pricing.input, None);
        assert_eq!(pricing.output, None);
        assert_eq!(pricing.per_image, Some(0.0));
        assert_eq!(pricing.tiers[0].input, None);
        assert_eq!(pricing.tiers[0].output, Some(0.0));
        assert_eq!(
            UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&config).unwrap()).unwrap(),
            config
        );
    }
    for rate in ["-1", ".nan", ".inf", "-.inf"] {
        let yaml = format!(
            "providers: {{p: {{models: [{{id: m, pricing: {{currency: USD, input: {rate}}}}}]}}}}"
        );
        assert!(UnifiedModelsConfig::from_yaml_str(&yaml).is_err(), "{rate}");
    }
    assert!(UnifiedModelsConfig::from_yaml_str(
        "providers: {p: {models: [{id: m, pricing: {input: 1}}]}}"
    )
    .is_err());
}

#[test]
fn credential_references_do_not_alias_case_sensitive_providers() {
    let config = parse(json!({"providers": {
        "Acme": {"apiKeyRef": "dpapi:00000000-0000-4000-8000-000000000002", "models": []},
        "acme": {"apiKeyRef": "dpapi:00000000-0000-4000-8000-000000000003", "models": []},
        "供应商": {"apiKeyRef": "env:EXPLICIT_KEY", "models": []}
    }}));
    assert_ne!(
        config.providers["Acme"].api_key_ref,
        config.providers["acme"].api_key_ref
    );
    for reference in [
        "dpapi:Acme",
        "dpapi:../secret",
        "dpapi:供应商",
        "env:",
        "env:1KEY",
        "raw-secret",
    ] {
        let raw = json!({"providers": {"p": {"apiKeyRef": reference, "models": []}}});
        let err =
            UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&raw).unwrap()).unwrap_err();
        assert!(!err.contains("raw-secret"), "错误信息不得暴露字面凭据");
    }
}

#[test]
fn canonical_parser_rejects_unknown_fields_and_historical_shapes() {
    for raw in [
        json!({"unknown": 1}),
        json!({"providers": {"p": {"apiKey": "secret", "models": []}}}),
        json!({"providers": {"p": {"models": [{"id": "m", "contextLength": 42}]}}}),
        json!({"providers": {"p": {"models": [{"id": "m", "capabilities": {"tools": true}}]}}}),
        json!({"providers": {"p": {"models": [{"id": "m", "pricing": {"currency": "USD", "inputPerMTok": 1}}]}}}),
        json!({"providers": {"p": {"models": [], "compat": {"unknown": false}}}}),
    ] {
        assert!(UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&raw).unwrap()).is_err());
    }
}

#[test]
fn positive_window_stream_and_disabled_cache_contract() {
    for field in ["contextWindow", "maxOutputTokens"] {
        for invalid in [json!(0), json!(-1), json!(1.5)] {
            let mut model = json!({"id": "m"});
            model[field] = invalid;
            let raw = json!({"providers": {"p": {"models": [model]}}});
            assert!(
                UnifiedModelsConfig::from_yaml_str(&serde_yaml::to_string(&raw).unwrap()).is_err()
            );
        }
    }
    let tree = parse(json!({"providers": {"p": {
        "stream": false, "compat": {"cacheControlFormat": "anthropic"},
        "models": [{"id": "m", "compat": {"cacheControlFormat": "disabled"}}]
    }, "default": {"models": []}}}));
    assert!(!tree.providers["p"].stream);
    assert!(tree.providers["default"].stream);
    assert_eq!(
        tree.providers["p"].models[0]
            .effective_compat(&tree.providers["p"])
            .unwrap()
            .cache_control_format,
        Some(CacheControlFormat::Disabled)
    );
}

#[test]
fn credential_reference_is_one_uuid_or_explicit_environment_parser() {
    use crate::models::CredentialRef;
    let reference = CredentialRef::parse("dpapi:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE").unwrap();
    assert_eq!(
        reference.canonical(),
        "dpapi:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
    assert_eq!(
        CredentialRef::parse("env:EXACT_KEY").unwrap(),
        CredentialRef::Env("EXACT_KEY".into())
    );
    for invalid in [
        "dpapi:Acme",
        "dpapi:slot-a",
        "dpapi:../key",
        "env:$NAME",
        "env:1NAME",
        "key",
    ] {
        assert!(CredentialRef::parse(invalid).is_err());
    }
}
