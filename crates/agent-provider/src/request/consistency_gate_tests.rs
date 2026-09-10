//! 描述面 ↔ 请求校验面一致性回归闸（多模型适配战役 轮次 4 · A3）
//!
//! 战役不变式 I4（能力描述与请求校验分离：描述面不隐藏提供方；请求面不支持档位在网络
//! I/O 前拒绝）。本文件是**一致性回归闸**——断言「描述面白名单 / wire 拼写」与「请求面
//! 接受集 / wire 字节」两条路径不互相矛盾，且坏配置不藏提供方、不误伤同 provider 的
//! 其它模型。
//!
//! ## 契约取向（轨A SSOT）
//!
//! 只经公开契约断言，不耦合内部实现：
//! - **C9 描述面**：[describe_model] → [ModelCapability]（`efforts` 白名单 /
//!   `supports_reasoning` / `default_effort` / `wire_protocol`）；
//! - **C1 档位持有**：[ModelCatalogEntry::wire_effort_for] / [ModelCatalog::lookup]；
//! - **请求构建面**：`assemble_thinking_dialect`（出站思考键唯一入口）。
//!
//! 被钉死的核心不变量：
//! - **描述面白名单 ≡ 请求面接受集**：凡 `describe_model().efforts` 出现的规范档位，
//!   请求面必须提供 wire（`wire_effort_for` 有值 / dialect 可按字典装配）;
//!   白名单不出现（隐藏/不支持）的档位，描述面不得当作已支持档位暴露。
//! - **坏配置不藏提供方、不误伤**：同 provider 下 A 模型坏配置 → A 描述保守兜底不抛错，
//!   B 模型描述正常、B 合法档位在请求面正常放行。
//! - **wire 一致性**：描述面 wire 拼写（C1）与请求面实际 wire 字节一致。
//! - **三态分流**：显式档位 / 省略 / off 在描述面与请求面语义一致。

use serde_json::json;
use std::collections::BTreeMap;

use crate::models::{ModelCatalog, ModelCatalogEntry, ModelCatalogFile};
use crate::request::build::dialect::{
    assemble_thinking_dialect, DialectBuildOptions, ReasoningEffort as DialectEffort,
    ThinkingDialectFormat,
};
use crate::request::{describe_model, normalize_reasoning_effort, ModelCapability, ReasoningEffort};

/// 构造 fake 目录：给定 `(vendor::model, 条目)` 对（与 capability_tests 同构只读构造）。
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

/// 便捷：构造带模型级档位→wire 映射载体的条目（沿用 ModelCatalogEntry serde 三形解析）。
fn entry_with_tiers(
    vendor: &str,
    model: &str,
    tiers: serde_json::Value,
    supports_reasoning: bool,
) -> ModelCatalogEntry {
    let value = json!({
        "model": model,
        "provider": vendor,
        "vendor": vendor,
        "supportsReasoning": supports_reasoning,
        "thinkingTiers": tiers,
    });
    serde_json::from_value(value).expect("条目解析")
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

/// 该档位在请求面是否可发（C1 档位→wire 拼写已定义 = 请求面接受）。
fn request_accepts(cat: &ModelCatalog, vendor: &str, model: &str, level: &str) -> bool {
    cat.lookup(vendor, model)
        .is_some_and(|entry| entry.wire_effort_for(level).is_some())
}

/// 用 dialect 装配 OpenAI 标量方言的 wire 字节（请求构建面真符号）。
fn dialect_openai_wire(effort: DialectEffort, map_wire: &str) -> Option<serde_json::Value> {
    let mut map = indexmap::IndexMap::new();
    map.insert(effort.to_title_case().to_string(), map_wire.to_string());
    let opts = DialectBuildOptions {
        effort,
        format: ThinkingDialectFormat::OpenAiEffort,
        max_output_tokens: 65536,
        thinking_map: Some(&map),
    };
    assemble_thinking_dialect(&opts).0
}

// ── 验收断言 1：描述面白名单 ↔ 请求面接受集一致 ──

#[test]
fn efforts_whitelist_equals_request_accept_set() {
    // 模型级 tiers：low 提供 / medium 提供（G6 改名 medium→high）/ high 隐藏。
    let tiers = tier_obj(&[
        ("low", Some("low")),
        ("medium", Some("high")),
        ("high", None),
        ("max", None),
    ]);
    let entry = entry_with_tiers("acme", "acme-model", tiers, true);
    let cat = fake_catalog(&[("acme::acme-model".to_string(), entry)]);
    let cap = describe(&cat, "acme", "acme-model");

    // 描述面白名单 = 提供档并集（hidden 不入集）。
    assert_eq!(cap.efforts, vec!["low".to_string(), "medium".to_string()]);

    // 一致性核心：凡描述面白名单出现的档位，请求面必须接受（wire 已定义，可发）。
    for level in &cap.efforts {
        assert!(
            request_accepts(&cat, "acme", "acme-model", level),
            "描述面白名单档位 {level} 必须在请求面可发"
        );
    }

    // 反向：描述面白名单不出现的档位（high/max 被隐藏），请求面不得作为已支持档接受。
    for level in ["high", "max"] {
        assert!(
            !cap.efforts.contains(&level.to_string()),
            "隐藏档 {level} 不应出现在描述面白名单"
        );
        assert!(
            !request_accepts(&cat, "acme", "acme-model", level),
            "隐藏档 {level} 在请求面应无 wire（不属接受集）"
        );
    }
}

#[test]
fn bundled_models_whitelist_is_self_consistent() {
    // 真实内置目录（catalog.json 随 A2 档位数据落盘）：结构不变量——对每个支持
    // reasoning 的目标模型，描述面白名单档位都可在请求面取得 wire（描述↔请求不矛盾）。
    let cat = ModelCatalog::bundled();

    for (vendor, model) in [
        ("deepseek", "deepseek-v4-flash"),
        ("glm", "glm-5-2"),
        ("qwen", "qwen3-8-max"),
    ] {
        let cap = describe(&cat, vendor, model);
        for level in &cap.efforts {
            assert!(
                request_accepts(&cat, vendor, model, level),
                "[{vendor}/{model}] 描述面白名单档位 {level} 必须在请求面可发"
            );
        }
        for level in &cap.efforts {
            assert!(
                ["low", "medium", "high", "xhigh", "max", "minimal"].contains(&level.as_str()),
                "[{vendor}/{model}] 白名单含非法档位名 {level}"
            );
        }
    }
}

// ── 验收断言 2：坏配置不藏提供方 ↔ 请求面不因坏配置误伤 ──

#[test]
fn bad_config_does_not_hide_provider_nor_misfire_sibling_request() {
    // A：坏配置（supports_reasoning=false + tiers 空声明）→ 描述保守兜底不抛错。
    // B：同 provider 正常模型，合法 tiers。
    let bad_a = {
        let mut e = entry_with_tiers("acme", "model-a", tier_obj(&[]), false);
        e.supports_reasoning_effort = false;
        e
    };
    let good_b = entry_with_tiers(
        "acme",
        "model-b",
        tier_obj(&[("low", Some("low")), ("medium", Some("medium"))]),
        true,
    );
    let cat = fake_catalog(&[
        ("acme::model-a".to_string(), bad_a),
        ("acme::model-b".to_string(), good_b),
    ]);

    // A 描述：保守兜底 → 不支持（不 panic，坏配置暴露在被执行处而非描述处）。
    let cap_a = describe(&cat, "acme", "model-a");
    assert!(!cap_a.supports_reasoning, "A 坏配置 → 描述保守不支持");
    assert_eq!(cap_a.default_effort, None);

    // B 描述正常，且 B 合法档位在请求面正常放行（request side 不因 A 的坏配置误伤）。
    let cap_b = describe(&cat, "acme", "model-b");
    assert!(cap_b.supports_reasoning, "B 不受 A 坏配置影响");
    assert_eq!(cap_b.efforts, vec!["low".to_string(), "medium".to_string()]);
    assert_eq!(cap_b.default_effort.as_deref(), Some("low"));

    for level in ["low", "medium"] {
        assert!(request_accepts(&cat, "acme", "model-b", level));
        // B 合法档位在请求面可正常生成 wire 字节（不因 A 坏配置被误伤）。
        let wire = normalize_reasoning_effort(match level {
            "low" => ReasoningEffort::Low,
            _ => ReasoningEffort::Medium,
        });
        assert_eq!(wire, Some(level));
    }
}

// ── 验收断言 3：wire 一致性（描述面 wire 拼写 ↔ 请求面 wire 字节，经 dialect）──

#[test]
fn wire_spelling_consistency_describe_vs_request_dialect() {
    // 改名模型（glm-5.2 类，T4.2/G6）：{"medium":"high"} 等 wire 改名。
    // 描述面经 C1 wire_effort_for 返回改名后的 wire；请求面经 dialect 按字典 value 发出。
    let tiers = tier_obj(&[
        ("low", Some("low")),
        ("medium", Some("high")),
        ("high", Some("higher")),
    ]);
    let entry = entry_with_tiers("glm", "glm-x", tiers, true);
    let cat = fake_catalog(&[("glm::glm-x".to_string(), entry)]);

    // C1 档位→wire：medium 的规范名经改名映射为 "high"。
    let entry = cat.lookup("glm", "glm-x").expect("lookup");
    assert_eq!(entry.wire_effort_for("medium"), Some("high"));

    // 描述面：medium 是已提供档位。
    let cap = describe(&cat, "glm", "glm-x");
    assert!(
        cap.efforts.iter().any(|k| k == "medium"),
        "medium 在描述白名单"
    );

    // 请求面实际发出的 wire 字节：dialect 按字典 value 装配（High key → "higher"）。
    let body = dialect_openai_wire(DialectEffort::High, "higher");
    assert_eq!(body, Some(json!({ "reasoning_effort": "higher" })));

    // 改名一致：描述面 wire_effort_for("medium")=="high" 与 dialect 字典 value 同源。
    let renamed = dialect_openai_wire(DialectEffort::Medium, entry.wire_effort_for("medium").unwrap());
    assert_eq!(renamed, Some(json!({ "reasoning_effort": "high" })));
}

#[test]
fn wire_spelling_consistency_multivendor_via_dialect() {
    // 各 vendor 下同一 canonical effort=high 的实际 wire 字节（dialect OpenAiEffort）。
    // DeepSeek/GLM/Qwen/Kimi 均走 reasoning_effort 标量方言。
    for map_wire in ["high", "HIGH-custom"] {
        let body = dialect_openai_wire(DialectEffort::High, map_wire)
            .expect("high 档按字典必发 wire");
        assert_eq!(body, json!({ "reasoning_effort": map_wire }));
    }
}

// ── 验收断言 4：三态分流（显式档位 / 省略 / off 语义一致）──

#[test]
fn three_state_flow_explicit_omitted_off_consistent() {
    // 请求面三态（dialect）：
    // - 显式有效档位（字典命中）→ 发 wire 字节；
    // - 字典 miss（fail-closed）→ 不发送任何 reasoning 参数；
    // - off → OpenAiEffort 不发送（关闭思考）。

    let cat = fake_catalog(&[(
        "deepseek::deepseek-v4-flash".to_string(),
        entry_with_tiers(
            "deepseek",
            "deepseek-v4-flash",
            tier_obj(&[
                ("low", Some("low")),
                ("medium", Some("medium")),
                ("high", Some("high")),
            ]),
            true,
        ),
    )]);

    // 显式档位：medium 在描述白名单，且请求面可发。
    let cap = describe(&cat, "deepseek", "deepseek-v4-flash");
    assert!(cap.efforts.contains(&"medium".to_string()));
    let wire = normalize_reasoning_effort(ReasoningEffort::Medium);
    assert_eq!(wire, Some("medium"));
    let body = dialect_openai_wire(DialectEffort::Medium, "medium");
    assert_eq!(body, Some(json!({ "reasoning_effort": "medium" })));

    // 字典 miss（fail-closed）：不发送任何 reasoning 参数。
    let mut empty_map = indexmap::IndexMap::new();
    empty_map.insert("Low".to_string(), "low".to_string());
    let miss = assemble_thinking_dialect(&DialectBuildOptions {
        effort: DialectEffort::Medium,
        format: ThinkingDialectFormat::OpenAiEffort,
        max_output_tokens: 65536,
        thinking_map: Some(&empty_map),
    });
    assert_eq!(miss.0, None, "字典 miss → fail-closed 不注入");

    // off：关闭思考 → OpenAiEffort 不发送（归一化把 off 映射为 None）。
    let off = dialect_openai_wire(DialectEffort::Off, "off");
    assert_eq!(off, None, "off → 不发送 reasoning_effort");
    assert_eq!(normalize_reasoning_effort(ReasoningEffort::Off), None);

    // 描述面一致：三态分流可辨——省略/off 不发，显式才发。default_effort 为派生默认。
    assert_eq!(
        cap.default_effort.as_deref(),
        cap.efforts.first().map(String::as_str)
    );
}
