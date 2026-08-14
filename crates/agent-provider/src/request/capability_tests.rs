//! request/capability.rs 测试旁挂（多模型适配战役 R2 T2.4；经 #[path] 接线）
//!
//! 验收断言（fake 目录 + fake vendor/model）：
//! - A：模型级 tiers `{"low":"low","medium":"high","high":null}` → efforts=[low,medium]
//!   （high 隐藏不出现）；G6 wire 改名（medium→high）**不影响**白名单（efforts 是规范档位）。
//! - B：模型级未声明 → 回落系列级能力表档位。
//! - C（不藏提供方）：同 provider 下 A 模型坏配置（supports_reasoning=false / tiers 非法空）
//!   → A 保守兜底不抛错；B 模型描述正常。
//! - D：supports_reasoning 多源合并（模型级 / catalog 能力位 / 系列级）。

use crate::config::Endpoint;
use crate::models::{ModelCatalog, ModelCatalogEntry, ModelCatalogFile};
use crate::request::{describe_model, ModelCapability, WireProtocol};
use serde_json::json;
use std::collections::BTreeMap;

/// 构造 fake 目录：给定 `(vendor::model, 条目)` 对。
fn fake_catalog(entries: &[(String, ModelCatalogEntry)]) -> ModelCatalog {
    let mut map = BTreeMap::new();
    for (key, entry) in entries {
        map.insert(key.clone(), entry.clone());
    }
    let file = ModelCatalogFile {
        version: 0,
        schema: "2.0".to_string(),
        updated_at: None,
        entries: map,
    };
    ModelCatalog {
        entries: file.entries,
        version: 0,
    }
}

/// 便捷：构造带 json 反序列化 tiers 的条目（沿用 ModelCatalogEntry 的 serde 解析）。
fn entry_with_tiers(vendor: &str, model: &str, tiers: serde_json::Value) -> ModelCatalogEntry {
    let model_entry = json!({
        "model": model,
        "provider": vendor,
        "vendor": vendor,
        "reasoningEffortTiers": tiers,
    });
    serde_json::from_value(model_entry).expect("条目解析")
}

/// 便捷：模型级 tiers 对象（档位→Some(wire)|None）。
fn tier_obj(pairs: &[(&str, Option<&str>)]) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for (tier, wire) in pairs {
        obj.insert(tier.to_string(), json!(wire));
    }
    serde_json::Value::Object(obj)
}

fn describe(cat: &ModelCatalog, vendor: &str, model: &str) -> ModelCapability {
    describe_model(cat, vendor, model, None)
}

// ── 验收断言 A：模型级 tiers 档位白名单 + G6 wire 改名不影响 ──

#[test]
fn model_level_tiers_whitelist_and_wire_rename_do_not_leak() {
    // `{"low":"low","medium":"high","high":null}`：
    //   low 提供（wire=low）、medium 提供（G6 改名 medium→high）、high 隐藏（None）。
    let tiers = tier_obj(&[
        ("low", Some("low")),
        ("medium", Some("high")),
        ("high", None),
    ]);
    let entry = entry_with_tiers("acme", "acme-model", tiers);
    let cat = fake_catalog(&[("acme::acme-model".to_string(), entry)]);

    let cap = describe(&cat, "acme", "acme-model");
    assert!(cap.supports_reasoning, "模型级档位存在 → 支持 reasoning");
    // 白名单 = 提供档并集（BTreeSet 字典序）：high 隐藏不入集。
    assert_eq!(cap.efforts, vec!["low".to_string(), "medium".to_string()]);
    // wire 拼写改名（medium→"high"）不影响白名单：efforts 是规范档位。
    assert!(!cap.efforts.contains(&"high".to_string()));

    // 派生默认 = efforts 首个（字典序 low）。
    assert_eq!(cap.default_effort.as_deref(), Some("low"));
    assert_eq!(cap.wire_protocol, WireProtocol::Chat);

    // 规范档位检查：既然 medium 的 wire 拼写是 "high"，wire_protocol 不改，
    // 白名单仍用规范名。
    assert_eq!(cap.efforts.iter().filter(|k| *k == "medium").count(), 1);
}

#[test]
fn model_level_tiers_hidden_tier_is_absent() {
    // 仅提供 medium，high/low 全隐藏（None）——描述面未覆盖档位不出现。
    let tiers = tier_obj(&[
        ("low", None),
        ("medium", Some("medium")),
        ("high", None),
        ("max", None),
    ]);
    let entry = entry_with_tiers("acme", "acme-model", tiers);
    let cat = fake_catalog(&[("acme::acme-model".to_string(), entry)]);

    let cap = describe(&cat, "acme", "acme-model");
    assert_eq!(cap.efforts, vec!["medium".to_string()]);
    assert_eq!(cap.default_effort.as_deref(), Some("medium"));
}

// ── 验收断言 B：模型级未声明 → 系列级能力表兜底 ──

#[test]
fn no_model_level_tiers_falls_back_to_series_capability() {
    // deepseek-v4-flash 无模型级 tiers → 系列级 DEEPSEEK_REASONING = [low,medium,high]。
    // catalog 能力位 supports_reasoning=true（对齐内置表口径）→ 无粗粒度门控拦截。
    let entry = ModelCatalogEntry {
        model: "deepseek-v4-flash".to_string(),
        provider: "deepseek".to_string(),
        vendor: "deepseek".to_string(),
        supports_reasoning: true,
        ..Default::default()
    };
    let cat = fake_catalog(&[("deepseek::deepseek-v4-flash".to_string(), entry)]);

    let cap = describe(&cat, "deepseek", "deepseek-v4-flash");
    assert!(cap.supports_reasoning);
    // series.level 顺序 = LEVELS_NO_MINIMAL = [low, medium, high]。
    assert_eq!(
        cap.efforts,
        vec!["low".to_string(), "medium".to_string(), "high".to_string()]
    );
    assert_eq!(cap.default_effort.as_deref(), Some("low"));

    // anthropic 新代际 adaptive：系列 ANTHROPIC_ADAPTIVE = [low,medium,high,xhigh,max]。
    let cap_claude = describe(&cat, "acme", "claude-opus-4-7");
    assert!(cap_claude.supports_reasoning);
    assert_eq!(
        cap_claude.efforts,
        vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "xhigh".to_string(),
            "max".to_string()
        ]
    );
}

#[test]
fn unknown_model_series_falls_back_to_no_thinking() {
    let cat = fake_catalog(&[]);
    let cap = describe(&cat, "acme", "totally-unknown-model");
    // 未知模型 → 系列 NO_THINKING：不支持 reasoning、空白名单、无默认。
    assert!(!cap.supports_reasoning);
    assert!(cap.efforts.is_empty());
    assert_eq!(cap.default_effort, None);
}

// ── 验收断言 C：不隐藏提供方（A 坏配置不藏 B）──

#[test]
fn bad_config_model_a_does_not_hide_model_b_same_provider() {
    // A：supports_reasoning=false（坏配置）+ tiers 声明非法/空 → 保守兜底，不抛错。
    let tiers_empty = tier_obj(&[]); // 空 tiers（解析归一为 None → offered_levels 空）
    let bad_a = entry_with_tiers("acme", "model-a", tiers_empty);
    let mut bad_a = bad_a;
    bad_a.supports_reasoning = false; // 显式坏配置：能力位关
                                      // B：同 provider 下正常模型，合法 tiers。
    let tiers_b = tier_obj(&[("low", Some("low")), ("medium", Some("medium"))]);
    let good_b = entry_with_tiers("acme", "model-b", tiers_b);

    let cat = fake_catalog(&[
        ("acme::model-a".to_string(), bad_a),
        ("acme::model-b".to_string(), good_b),
    ]);

    // A 描述：保守兜底（series {low,medium,high} ∧ coarse_gate false）→ 不支持，不 panic。
    let cap_a = describe(&cat, "acme", "model-a");
    assert!(!cap_a.supports_reasoning, "A 坏配置 → 保守不支持");
    assert_eq!(cap_a.default_effort, None);

    // B 描述：完全正常，不被 A 的坏配置隐藏（不藏提供方核心断言）。
    let cap_b = describe(&cat, "acme", "model-b");
    assert!(cap_b.supports_reasoning, "B 不受 A 坏配置影响");
    assert_eq!(cap_b.efforts, vec!["low".to_string(), "medium".to_string()]);
    assert_eq!(cap_b.default_effort.as_deref(), Some("low"));
}

#[test]
fn illegal_tiers_declaration_falls_back_not_throw() {
    // A：声明了 tiers 但仅隐藏档（全 None）→ offered_levels 空 → 系列级兜底（不抛错）。
    // 模型名 deepseek-v4-*（系列 DEEPSEEK_REASONING = [low,medium,high]）为兜底源。
    let tiers_hidden_all = tier_obj(&[("low", None), ("medium", None), ("high", None)]);
    let entry_a = entry_with_tiers("deepseek", "deepseek-v4-bad", tiers_hidden_all);
    let mut entry_a = entry_a;
    entry_a.supports_reasoning = true; // 能力位对齐内置表：仅 tiers 声明非法（全隐藏）
    let cat = fake_catalog(&[("deepseek::deepseek-v4-bad".to_string(), entry_a)]);

    // 系列级 deepseek 兜底（即便模型级声明了但全隐藏）：不 panic。
    let cap_a = describe(&cat, "deepseek", "deepseek-v4-bad");
    // model-level offered_levels 空 → series.supported ∧ (无显式 false 门控) → true，
    // 白名单 = 系列级 [low,medium,high]。
    assert!(cap_a.supports_reasoning);
    assert_eq!(
        cap_a.efforts,
        vec!["low".to_string(), "medium".to_string(), "high".to_string()]
    );
}

// ── 验收断言 D：supports_reasoning 多源合并 ──

#[test]
fn catalog_supports_reasoning_coarse_gate_respected() {
    // claude-3-5 类：supports_reasoning=false + 系列 NO_THINKING → 保守不支持（不隐藏）。
    let entry = ModelCatalogEntry {
        model: "claude-3-5-sonnet".to_string(),
        provider: "acme".to_string(),
        vendor: "acme".to_string(),
        supports_reasoning: false,
        supports_reasoning_effort: false,
        mode: Some("chat".to_string()),
        ..Default::default()
    };
    let cat = fake_catalog(&[("acme::claude-3-5-sonnet".to_string(), entry)]);
    let cap = describe(&cat, "acme", "claude-3-5-sonnet");
    assert!(!cap.supports_reasoning);
    assert!(cap.efforts.is_empty());
}

#[test]
fn series_adaptive_status_qualifies_as_supported() {
    // anthropic 新代际（series adaptive）+ 无模型级 tiers → supports_reasoning=true。
    let entry = ModelCatalogEntry {
        model: "claude-sonnet-5".to_string(),
        provider: "acme".to_string(),
        vendor: "acme".to_string(),
        supports_reasoning: true,
        mode: Some("anthropic".to_string()),
        ..Default::default()
    };
    let cat = fake_catalog(&[("acme::claude-sonnet-5".to_string(), entry)]);
    let cap = describe(&cat, "acme", "claude-sonnet-5");
    assert!(cap.supports_reasoning);
    assert!(cap.efforts.contains(&"xhigh".to_string()));
}

// ── wire_protocol 联动（C4 复用）──

#[test]
fn describe_uses_resolved_wire_protocol() {
    // mode:"anthropic" + 无 endpoint → Anthropic（复用 C4 单一真源）。
    let entry = ModelCatalogEntry {
        model: "claude-opus-4".to_string(),
        provider: "acme".to_string(),
        vendor: "acme".to_string(),
        mode: Some("anthropic".to_string()),
        ..Default::default()
    };
    let cat = fake_catalog(&[("acme::claude-opus-4".to_string(), entry)]);
    let cap = describe(&cat, "acme", "claude-opus-4");
    assert_eq!(cap.wire_protocol, WireProtocol::Anthropic);

    // 显式 Responses + supports_responses → Responses。
    let entry2 = ModelCatalogEntry {
        model: "gpt-5".to_string(),
        provider: "acme".to_string(),
        vendor: "acme".to_string(),
        supports_responses: true,
        ..Default::default()
    };
    let cat2 = fake_catalog(&[("acme::gpt-5".to_string(), entry2)]);
    let cap2 = describe_model(&cat2, "acme", "gpt-5", Some(Endpoint::Responses));
    assert_eq!(cap2.wire_protocol, WireProtocol::Responses);
}
