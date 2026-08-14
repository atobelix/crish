//! request/wire_protocol.rs 测试旁挂（多模型适配战役 R1 T1.6；经 #[path] 接线）
//!
//! 验收断言（fake 目录 + fake vendor/model）：
//! - `mode:"anthropic"` 条目 + 任意 endpoint → Anthropic
//! - `mode:"responses"` → Responses
//! - `mode:"both"` + Endpoint::Responses → Responses
//! - 无 mode + 无 supports_responses → Chat（兜底）
//! - 同 provider 下 chat/responses 两模型各自正确
//! - 未知模型 → 全局 endpoint 语义（chat 兜底）

use super::*;
use crate::config::Endpoint;
use crate::models::{ModelCatalog, ModelCatalogEntry, ModelCatalogFile};
use std::collections::BTreeMap;

/// 构造 fake 目录：给定 `(vendor, model)` 键 → 条目构造器。
/// 条目仅填测试所需字段，其余走 Default（`#[serde(default)]`）。
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
        // entries 为 pub(crate)，同 crate 测试可构造
        entries: file.entries,
        version: 0,
    }
}

fn entry(mode: Option<&str>, supports_responses: bool) -> ModelCatalogEntry {
    ModelCatalogEntry {
        mode: mode.map(str::to_string),
        supports_responses,
        ..Default::default()
    }
}

// ── 验收断言 1：mode 单一真源 ──

/// mode:"anthropic" 条目 + 任意 endpoint → Anthropic（模型级 mode 优先于全局 endpoint）
#[test]
fn mode_anthropic_wins_over_endpoint() {
    for endpoint in [
        None,
        Some(Endpoint::Responses),
        Some(Endpoint::ChatCompletions),
    ] {
        let catalog = fake_catalog(&[("acme::claude-x".into(), entry(Some("anthropic"), false))]);
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "claude-x", endpoint),
            WireProtocol::Anthropic,
            "mode:\"anthropic\" 应恒 Anthropic，不随 endpoint 变化（endpoint={endpoint:?}）",
        );
    }
}

/// mode:"gemini" 条目 → Gemini
#[test]
fn mode_gemini_wins_over_endpoint() {
    let catalog = fake_catalog(&[("acme::gemini-x".into(), entry(Some("gemini"), false))]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "gemini-x", Some(Endpoint::Responses)),
        WireProtocol::Gemini,
        "mode:\"gemini\" 应恒 Gemini，不随 endpoint 变化",
    );
}

/// mode:"responses" 条目 + 任意 endpoint → Responses
#[test]
fn mode_responses_wins_over_endpoint() {
    for endpoint in [
        None,
        Some(Endpoint::ChatCompletions),
        Some(Endpoint::Responses),
    ] {
        let catalog = fake_catalog(&[("acme::resp-model".into(), entry(Some("responses"), false))]);
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "resp-model", endpoint),
            WireProtocol::Responses,
            "mode:\"responses\" 应恒 Responses（endpoint={endpoint:?}）",
        );
    }
}

// ── 验收断言 1b：mode:"both" —— endpoint 倾向 responses → responses，否则 chat ──

/// mode:"both" + Endpoint::Responses → Responses
#[test]
fn mode_both_with_responses_endpoint_selects_responses() {
    let catalog = fake_catalog(&[("acme::both-model".into(), entry(Some("both"), false))]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "both-model", Some(Endpoint::Responses)),
        WireProtocol::Responses,
    );
}

/// mode:"both" + endpoint 缺省 / chat → chat（00 D3：未显式指定恒 chat-completions）
#[test]
fn mode_both_without_responses_endpoint_selects_chat() {
    let catalog = fake_catalog(&[("acme::both-model".into(), entry(Some("both"), false))]);
    for endpoint in [None, Some(Endpoint::ChatCompletions), Some(Endpoint::Auto)] {
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "both-model", endpoint),
            WireProtocol::Chat,
            "mode:\"both\" + endpoint={endpoint:?} 应 chat 兜底",
        );
    }
}

/// mode:"chat" 条目 → Chat
#[test]
fn mode_chat_selects_chat() {
    let catalog = fake_catalog(&[("acme::chat-model".into(), entry(Some("chat"), true))]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "chat-model", Some(Endpoint::Responses)),
        WireProtocol::Chat,
        "mode:\"chat\" 应恒 Chat，support_responses 不覆盖 mode",
    );
}

// ── 验收断言 1c：同一 provider 下 chat / responses 两模型各自正确 ──

/// 同 provider 双模型（一个 chat、一个 responses）互不影响路由
#[test]
fn same_provider_two_models_resolve_independently() {
    let catalog = fake_catalog(&[
        ("acme::chat-a".into(), entry(Some("chat"), false)),
        ("acme::resp-b".into(), entry(Some("responses"), false)),
    ]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "chat-a", Some(Endpoint::Responses)),
        WireProtocol::Chat,
        "chat 模型不因同 provider 有 responses 模型或全局 endpoint 而误路由",
    );
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "resp-b", Some(Endpoint::ChatCompletions)),
        WireProtocol::Responses,
        "responses 模型不因全局 endpoint 为 chat 而降级",
    );
}

// ── 验收断言 2：supports_responses 能力位（mode 缺失时的向前兼容路由）──

/// 无 mode + supports_responses + endpoint responses → Responses（能力位叠加 endpoint 倾向）
#[test]
fn supports_responses_with_endpoint_responses_selects_responses() {
    let catalog = fake_catalog(&[("acme::capable".into(), entry(None, true))]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "capable", Some(Endpoint::Responses)),
        WireProtocol::Responses,
    );
}

/// 无 mode + supports_responses 但 endpoint 非 responses → 不据此强制，chat 兜底
#[test]
fn supports_responses_alone_does_not_force_responses() {
    let catalog = fake_catalog(&[("acme::capable".into(), entry(None, true))]);
    for endpoint in [None, Some(Endpoint::ChatCompletions), Some(Endpoint::Auto)] {
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "capable", endpoint),
            WireProtocol::Chat,
            "supports_responses 是允许位而非路由键，endpoint={endpoint:?} 应 chat",
        );
    }
}

// ── 验收断言 2b：无 mode + 无 supports_responses → Chat（兜底）──

/// 已知模型但 mode/supports_responses 均缺省 → Chat 兜底
#[test]
fn known_model_without_mode_and_capability_falls_back_to_chat() {
    let catalog = fake_catalog(&[("acme::plain".into(), entry(None, false))]);
    for endpoint in [None, Some(Endpoint::ChatCompletions), Some(Endpoint::Auto)] {
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "plain", endpoint),
            WireProtocol::Chat,
            "无 mode + 无 supports_responses 应 chat 兜底（endpoint={endpoint:?}）",
        );
    }
}

// ── 验收断言 3：未知模型 → 全局 endpoint 语义（chat 兜底）──

/// 目录未收录模型：endpoint 缺省 / auto → chat 兜底；显式 responses → 尊重全局 endpoint
#[test]
fn unknown_model_follows_global_endpoint_semantics() {
    let catalog = fake_catalog(&[]);
    for endpoint in [None, Some(Endpoint::ChatCompletions), Some(Endpoint::Auto)] {
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "no-such-model", endpoint),
            WireProtocol::Chat,
            "未知模型 + endpoint={endpoint:?} 应 chat 兜底（全局 endpoint 语义）",
        );
    }
    // 显式 responses：全局 endpoint 语义——用户显式要求 responses 且目录无信息可覆盖
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "no-such-model", Some(Endpoint::Responses)),
        WireProtocol::Responses,
        "未知模型 + 显式 Endpoint::Responses → 尊重全局 endpoint",
    );
}

/// 未识别 mode 值（脏数据 "foo"）不被误路由到 anthropic/gemini：mode 无关值不引入
/// 任何协议偏好，照常落到后继优先级（此处 supports_responses 允许位 + endpoint 无
/// responses 倾向 → chat 兜底）。
#[test]
fn unrecognized_mode_falls_back_to_chat() {
    let catalog = fake_catalog(&[("acme::odd".into(), entry(Some("foo"), true))]);
    for endpoint in [None, Some(Endpoint::ChatCompletions), Some(Endpoint::Auto)] {
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "odd", endpoint),
            WireProtocol::Chat,
            "未识别 mode 不应路由到 anthropic/gemini/responses，chat 兜底（endpoint={endpoint:?}）",
        );
    }
    // 未识别 mode + 显式 responses：mode 无关值不遮挡合法的 supports_responses 允许位与
    // 全局 endpoint 语义（`supports_responses && endpoint==Responses` → Responses）
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "odd", Some(Endpoint::Responses)),
        WireProtocol::Responses,
        "未识别 mode 落到 supports_responses+endpoint 规则，允许位 + responses 倾向 → Responses",
    );
}

// ── WireProtocol::as_str 稳定字面量（契约登记锚）──
#[test]
fn wire_protocol_as_str_is_stable() {
    assert_eq!(WireProtocol::Chat.as_str(), "chat");
    assert_eq!(WireProtocol::Responses.as_str(), "responses");
    assert_eq!(WireProtocol::Anthropic.as_str(), "anthropic");
    assert_eq!(WireProtocol::Gemini.as_str(), "gemini");
}
