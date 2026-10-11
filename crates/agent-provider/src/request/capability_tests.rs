//! request/capability.rs 测试旁挂（模型能力战役 v2 单源裁决；经 #[path] 接线）
//!
//! 验收断言（fake 目录 + fake vendor/model，单源 = 只读 catalog 条目 thinking_tiers）：
//! - A：条目 thinking_tiers `{"low":"low","medium":"high","high":null}` → efforts=[low,medium]
//!   （high 隐藏不出现）；G6 wire 改名（medium→high）**不影响**白名单（efforts 是规范档位）。
//! - B：条目未声明 thinking_tiers → 空白名单、supports_reasoning=false（**不回落系列级**
//!   ——v2 退役 MODEL_SERIES_CAPABILITIES 猜测表，未收录模型保守默认）。
//! - C（不藏提供方）：同 provider 下 A 模型坏配置（thinking_tiers 空/非法）→ A 保守不支持
//!   不抛错；B 模型描述正常。
//! - D：thinking_format / thinking_budget 由条目单源投影；wire_protocol 仍走 C4 单一真源。

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

/// 便捷：构造带 json 反序列化 thinkingTiers 的条目（沿用 ModelCatalogEntry 的 serde 解析）。
fn entry_with_tiers(vendor: &str, model: &str, tiers: serde_json::Value) -> ModelCatalogEntry {
    let model_entry = json!({
        "model": model,
        "provider": vendor,
        "vendor": vendor,
        "thinkingTiers": tiers,
    });
    serde_json::from_value(model_entry).expect("条目解析")
}

/// 便捷：条目 thinking_tiers 对象（档位→Some(wire)|None）。
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

// ── 验收断言 A：条目 thinking_tiers 档位白名单 + G6 wire 改名不影响 ──

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
    let cat = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "acme-model").key(),
        entry,
    )]);

    let cap = describe(&cat, "acme", "acme-model");
    assert!(cap.supports_reasoning, "条目档位存在 → 支持 reasoning");
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
    let cat = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "acme-model").key(),
        entry,
    )]);

    let cap = describe(&cat, "acme", "acme-model");
    assert_eq!(cap.efforts, vec!["medium".to_string()]);
    assert_eq!(cap.default_effort.as_deref(), Some("medium"));
}

// ── 验收断言 B：条目未声明 thinking_tiers → 保守不支持（v2 单源，无系列兜底）──

#[test]
fn no_model_level_tiers_is_conservative() {
    // v2 单源裁决：不回落系列级猜测表——未声明 thinking_tiers 的条目保守不支持。
    // 即便 catalog 能力位 supports_reasoning=true 也不参与合并（单源 = thinking_tiers）。
    let entry = ModelCatalogEntry {
        model: "deepseek-v4-flash".to_string(),
        provider: "deepseek".to_string(),
        vendor: "deepseek".to_string(),
        supports_reasoning: true,
        ..Default::default()
    };
    let cat = fake_catalog(&[(
        crate::models::ModelRef::new("deepseek", "deepseek-v4-flash").key(),
        entry,
    )]);

    let cap = describe(&cat, "deepseek", "deepseek-v4-flash");
    assert!(!cap.supports_reasoning, "无 thinking_tiers → 保守不支持");
    assert!(cap.efforts.is_empty());
    assert_eq!(cap.default_effort, None);
}

#[test]
fn unknown_model_series_is_conservative() {
    let cat = fake_catalog(&[]);
    let cap = describe(&cat, "acme", "totally-unknown-model");
    // 未知模型（无条目）→ 保守默认：不支持 reasoning、空白名单、无默认。
    assert!(!cap.supports_reasoning);
    assert!(cap.efforts.is_empty());
    assert_eq!(cap.default_effort, None);
}

// ── 验收断言 C：不隐藏提供方（A 坏配置不藏 B）──

#[test]
fn bad_config_model_a_does_not_hide_model_b_same_provider() {
    // A：thinking_tiers 声明非法/空（全部隐藏档归一为 None → offered_levels 空）→ 保守不支持。
    let tiers_empty = tier_obj(&[("low", None), ("medium", None)]);
    let bad_a = entry_with_tiers("acme", "model-a", tiers_empty);
    // B：同 provider 下正常模型，合法 tiers。
    let tiers_b = tier_obj(&[("low", Some("low")), ("medium", Some("medium"))]);
    let good_b = entry_with_tiers("acme", "model-b", tiers_b);

    let cat = fake_catalog(&[
        (crate::models::ModelRef::new("acme", "model-a").key(), bad_a),
        (
            crate::models::ModelRef::new("acme", "model-b").key(),
            good_b,
        ),
    ]);

    // A 描述：全隐藏 → 空白名单 → 保守不支持，不 panic。
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
fn illegal_tiers_declaration_is_conservative_not_throw() {
    // A：声明了 tiers 但仅隐藏档（全 None）→ offered_levels 空 → 保守不支持（v2 单源，
    // 不回落系列级——旧「能力位对齐内置表」参与合并的口径随猜测表一并退役）。
    let tiers_hidden_all = tier_obj(&[("low", None), ("medium", None), ("high", None)]);
    let entry_a = entry_with_tiers("deepseek", "deepseek-v4-bad", tiers_hidden_all);
    let mut entry_a = entry_a;
    entry_a.supports_reasoning = true; // 能力位不再参与单源合并，仅验证不 panic
    let cat = fake_catalog(&[(
        crate::models::ModelRef::new("deepseek", "deepseek-v4-bad").key(),
        entry_a,
    )]);

    let cap_a = describe(&cat, "deepseek", "deepseek-v4-bad");
    assert!(
        !cap_a.supports_reasoning,
        "全隐藏档 → 保守不支持（无系列兜底）"
    );
    assert!(cap_a.efforts.is_empty());
}

// ── 验收断言 D：thinking_format / budget 单源投影 + wire_protocol C4 ──

#[test]
fn thinking_format_and_budget_projected_from_entry() {
    let entry_json = json!({
        "model": "claude-sonnet-5",
        "provider": "acme",
        "vendor": "acme",
        "thinkingTiers": {"low": "low", "medium": "medium", "high": "high"},
        "thinkingFormat": "thinking_budget",
        "thinkingBudgetDefault": 4096,
        "thinkingBudgetMax": 32768,
    });
    let entry: ModelCatalogEntry = serde_json::from_value(entry_json).expect("条目解析");
    let cat = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "claude-sonnet-5").key(),
        entry,
    )]);

    let cap = describe(&cat, "acme", "claude-sonnet-5");
    assert!(cap.supports_reasoning);
    assert_eq!(cap.thinking_format.as_deref(), Some("thinking_budget"));
    assert_eq!(cap.thinking_budget_default, Some(4096));
    assert_eq!(cap.thinking_budget_max, Some(32768));
    // 未声明 format/budget → None（协议 builder 按缺省映射）
    let entry2 = entry_with_tiers("acme", "plain-model", tier_obj(&[("low", Some("low"))]));
    let cat2 = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "plain-model").key(),
        entry2,
    )]);
    let cap2 = describe(&cat2, "acme", "plain-model");
    assert_eq!(cap2.thinking_format, None);
    assert_eq!(cap2.thinking_budget_default, None);
}

// ── wire_protocol 联动（C4 复用，与单源能力无关）──

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
    let cat = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "claude-opus-4").key(),
        entry,
    )]);
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
    let cat2 = fake_catalog(&[(crate::models::ModelRef::new("acme", "gpt-5").key(), entry2)]);
    let cap2 = describe_model(&cat2, "acme", "gpt-5", Some(Endpoint::Responses));
    assert_eq!(cap2.wire_protocol, WireProtocol::Responses);
}
