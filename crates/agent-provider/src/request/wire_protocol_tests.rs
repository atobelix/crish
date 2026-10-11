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
        let catalog = fake_catalog(&[(
            crate::models::ModelRef::new("acme", "claude-x").key(),
            entry(Some("anthropic"), false),
        )]);
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
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "gemini-x").key(),
        entry(Some("gemini"), false),
    )]);
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
        let catalog = fake_catalog(&[(
            crate::models::ModelRef::new("acme", "resp-model").key(),
            entry(Some("responses"), false),
        )]);
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
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "both-model").key(),
        entry(Some("both"), false),
    )]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "both-model", Some(Endpoint::Responses)),
        WireProtocol::Responses,
    );
}

/// mode:"both" + endpoint 缺省 / chat → chat（00 D3：未显式指定恒 chat-completions）
#[test]
fn mode_both_without_responses_endpoint_selects_chat() {
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "both-model").key(),
        entry(Some("both"), false),
    )]);
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
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "chat-model").key(),
        entry(Some("chat"), true),
    )]);
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
        (
            crate::models::ModelRef::new("acme", "chat-a").key(),
            entry(Some("chat"), false),
        ),
        (
            crate::models::ModelRef::new("acme", "resp-b").key(),
            entry(Some("responses"), false),
        ),
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
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "capable").key(),
        entry(None, true),
    )]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "capable", Some(Endpoint::Responses)),
        WireProtocol::Responses,
    );
}

/// 无 mode + supports_responses 但 endpoint 非 responses → 不据此强制，chat 兜底
#[test]
fn supports_responses_alone_does_not_force_responses() {
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "capable").key(),
        entry(None, true),
    )]);
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
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "plain").key(),
        entry(None, false),
    )]);
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
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "odd").key(),
        entry(Some("foo"), true),
    )]);
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

// ── 验收断言 4（A6）：点号→横线归一（apiModel 异形体路由到横线目录键）──

/// 点号模型名（`gemini-2.5-pro`）精确命中目录横线键（`gemini-2-5-pro`）
/// → 返回其 mode（Gemini），不落 chat 兜底。
#[test]
fn dotted_model_normalizes_to_hyphen_key_gemini() {
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "gemini-2-5-pro").key(),
        entry(Some("gemini"), false),
    )]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "gemini-2.5-pro", None),
        WireProtocol::Gemini,
        "点号异形体 gemini-2.5-pro 应按横线键 gemini-2-5-pro 命中 mode:gemini",
    );
}

/// 点号模型名命中横线键且 mode=anthropic → Anthropic（归一后沿用 mode 语义）。
#[test]
fn dotted_model_normalizes_for_anthropic_mode() {
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "claude-2-5").key(),
        entry(Some("anthropic"), false),
    )]);
    assert_eq!(
        resolve_wire_protocol(&catalog, "acme", "claude-2.5", None),
        WireProtocol::Anthropic,
        "点号异形体应按横线键命中 mode",
    );
}

/// 点号形态但横线键不存在（目录未收录）→ 落回原兜底语义
/// （全局 endpoint：未知模型 + 非 responses → chat）。
#[test]
fn dotted_model_without_hyphen_key_falls_back_to_chat() {
    let catalog = fake_catalog(&[]);
    for endpoint in [None, Some(Endpoint::ChatCompletions), Some(Endpoint::Auto)] {
        assert_eq!(
            resolve_wire_protocol(&catalog, "acme", "gemini-9.9-pro", endpoint),
            WireProtocol::Chat,
            "点号模型无对应横线键 + endpoint={endpoint:?} 应 chat 兜底（原语义不回归）",
        );
    }
}

/// 横线形态模型名精确命中（无需归一）→ 原行为不受归一引入影响。
#[test]
fn hyphen_model_follows_original_exact_lookup() {
    let catalog = fake_catalog(&[(
        crate::models::ModelRef::new("acme", "gemini-2-5-pro").key(),
        entry(Some("gemini"), false),
    )]);
    assert_eq!(
        resolve_wire_protocol(
            &catalog,
            "acme",
            "gemini-2-5-pro",
            Some(Endpoint::Responses)
        ),
        WireProtocol::Gemini,
        "横线键精确命中 mode，独立于归一路径",
    );
}

// ── TU-01: 三级协议决议与端点 URL 规范化测试 ──

use crate::models::catalog_types::ProtocolKind;

#[test]
fn test_resolve_effective_protocol_three_tier_inheritance() {
    // 场景 1: Model.protocol 显式覆盖 Provider.protocol
    assert_eq!(
        resolve_effective_protocol(
            Some(ProtocolKind::OpenAiResponses),
            Some(ProtocolKind::OpenAiChat),
        ),
        ProtocolKind::OpenAiResponses,
        "Model 协议应直接覆盖 Provider 协议"
    );

    assert_eq!(
        resolve_effective_protocol(
            Some(ProtocolKind::AnthropicMessages),
            Some(ProtocolKind::OpenAiChat),
        ),
        ProtocolKind::AnthropicMessages,
        "Model 级 AnthropicMessages 覆盖 Provider 级 OpenAiChat"
    );

    assert_eq!(
        resolve_effective_protocol(
            Some(ProtocolKind::GoogleGenerateContent),
            Some(ProtocolKind::AnthropicMessages),
        ),
        ProtocolKind::GoogleGenerateContent,
        "Model 级 GoogleGenerateContent 覆盖 Provider 级 AnthropicMessages"
    );

    // 场景 2: Model 未配置 (None)，继承 Provider.protocol
    assert_eq!(
        resolve_effective_protocol(None, Some(ProtocolKind::AnthropicMessages)),
        ProtocolKind::AnthropicMessages,
        "Model 缺省时必须严格继承 Provider 协议"
    );

    assert_eq!(
        resolve_effective_protocol(None, Some(ProtocolKind::OpenAiResponses)),
        ProtocolKind::OpenAiResponses,
        "Model 缺省时必须严格继承 Provider 协议"
    );

    assert_eq!(
        resolve_effective_protocol(None, Some(ProtocolKind::GoogleGenerateContent)),
        ProtocolKind::GoogleGenerateContent,
        "Model 缺省时必须严格继承 Provider 协议"
    );

    // 场景 3: Model 与 Provider 均未指定 (None, None)，全局安全兜底 OpenAiChat
    assert_eq!(
        resolve_effective_protocol(None, None),
        ProtocolKind::OpenAiChat,
        "双缺省时必须严格兜底至 ProtocolKind::OpenAiChat"
    );
}

#[test]
fn test_resolve_effective_protocol_from_context() {
    let ctx_override = ProtocolResolutionContext {
        model_protocol: Some("openai/responses"),
        provider_protocol: Some("openai/chat"),
    };
    assert_eq!(
        resolve_effective_protocol_from_context(&ctx_override),
        WireProtocol::Responses
    );

    let ctx_inherit = ProtocolResolutionContext {
        model_protocol: None,
        provider_protocol: Some("anthropic/messages"),
    };
    assert_eq!(
        resolve_effective_protocol_from_context(&ctx_inherit),
        WireProtocol::Anthropic
    );

    let ctx_fallback = ProtocolResolutionContext {
        model_protocol: None,
        provider_protocol: None,
    };
    assert_eq!(
        resolve_effective_protocol_from_context(&ctx_fallback),
        WireProtocol::Chat
    );
}

#[test]
fn test_wire_protocol_protocol_kind_bidirectional_conversion() {
    // ProtocolKind -> WireProtocol
    assert_eq!(
        WireProtocol::from(ProtocolKind::OpenAiChat),
        WireProtocol::Chat
    );
    assert_eq!(
        WireProtocol::from(ProtocolKind::OpenAiResponses),
        WireProtocol::Responses
    );
    assert_eq!(
        WireProtocol::from(ProtocolKind::AnthropicMessages),
        WireProtocol::Anthropic
    );
    assert_eq!(
        WireProtocol::from(ProtocolKind::GoogleGenerateContent),
        WireProtocol::Gemini
    );

    // WireProtocol -> ProtocolKind
    assert_eq!(
        ProtocolKind::from(WireProtocol::Chat),
        ProtocolKind::OpenAiChat
    );
    assert_eq!(
        ProtocolKind::from(WireProtocol::Responses),
        ProtocolKind::OpenAiResponses
    );
    assert_eq!(
        ProtocolKind::from(WireProtocol::Anthropic),
        ProtocolKind::AnthropicMessages
    );
    assert_eq!(
        ProtocolKind::from(WireProtocol::Gemini),
        ProtocolKind::GoogleGenerateContent
    );

    // Helper methods
    assert_eq!(WireProtocol::Chat.protocol_kind(), ProtocolKind::OpenAiChat);
    assert_eq!(
        WireProtocol::from_protocol_kind(ProtocolKind::OpenAiResponses),
        WireProtocol::Responses
    );
    assert_eq!(WireProtocol::Chat.wire_name(), "openai/chat");
    assert_eq!(WireProtocol::Responses.wire_name(), "openai/responses");
    assert_eq!(WireProtocol::Anthropic.wire_name(), "anthropic/messages");
    assert_eq!(WireProtocol::Gemini.wire_name(), "google/generate-content");

    // from_raw_str
    assert_eq!(
        WireProtocol::from_raw_str("openai/chat"),
        Some(WireProtocol::Chat)
    );
    assert_eq!(WireProtocol::from_raw_str("chat"), Some(WireProtocol::Chat));
    assert_eq!(
        WireProtocol::from_raw_str("OPENAI/RESPONSES"),
        Some(WireProtocol::Responses)
    );
    assert_eq!(
        WireProtocol::from_raw_str("anthropic/messages"),
        Some(WireProtocol::Anthropic)
    );
    assert_eq!(
        WireProtocol::from_raw_str("gemini"),
        Some(WireProtocol::Gemini)
    );
    assert_eq!(WireProtocol::from_raw_str("unknown-proto"), None);
}

#[test]
fn test_build_endpoint_url_anthropic_messages() {
    let p = ProtocolKind::AnthropicMessages;
    // 1. 无 /v1 基础路径
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com"),
        "https://api.anthropic.com/v1/messages"
    );
    // 2. 带尾部斜杠
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com/"),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com///"),
        "https://api.anthropic.com/v1/messages"
    );
    // 3. 已包含 /v1
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com/v1"),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com/v1/"),
        "https://api.anthropic.com/v1/messages"
    );
    // 4. 包含完整 /v1/messages 或 /messages
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com/v1/messages"),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.anthropic.com/v1/messages/"),
        "https://api.anthropic.com/v1/messages"
    );
    assert_eq!(
        build_endpoint_url(p, "https://custom.gateway.internal/messages"),
        "https://custom.gateway.internal/messages"
    );
}

#[test]
fn test_build_endpoint_url_openai_responses() {
    let p = ProtocolKind::OpenAiResponses;
    // 1. 无 /v1 基础路径（自动规范化追加 /v1/responses）
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/"),
        "https://api.openai.com/v1/responses"
    );
    // 2. 已包含 /v1
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1/"),
        "https://api.openai.com/v1/responses"
    );
    // 3. 已包含 /responses
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1/responses"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1/responses/"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.deepseek.com/responses"),
        "https://api.deepseek.com/responses"
    );
}

#[test]
fn test_build_endpoint_url_openai_chat() {
    let p = ProtocolKind::OpenAiChat;
    // 1. 带 /v1 后缀
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1/"),
        "https://api.openai.com/v1/chat/completions"
    );
    // 2. 阿里百炼等兼容网关路径
    assert_eq!(
        build_endpoint_url(p, "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
    assert_eq!(
        build_endpoint_url(p, "https://dashscope.aliyuncs.com/compatible-mode/v1/"),
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
    // 3. DeepSeek / 第三方直出根路径
    assert_eq!(
        build_endpoint_url(p, "https://api.deepseek.com"),
        "https://api.deepseek.com/chat/completions"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.deepseek.com/"),
        "https://api.deepseek.com/chat/completions"
    );
    // 4. 幂等：已包含 /chat/completions
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1/chat/completions"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        build_endpoint_url(p, "https://api.openai.com/v1/chat/completions/"),
        "https://api.openai.com/v1/chat/completions"
    );
    // 5. SenseNova / 商汤日日新裸域名与带 /v1 自动对齐
    assert_eq!(
        build_endpoint_url(p, "https://token.sensenova.cn"),
        "https://token.sensenova.cn/v1/chat/completions"
    );
    assert_eq!(
        build_endpoint_url(p, "https://token.sensenova.cn/"),
        "https://token.sensenova.cn/v1/chat/completions"
    );
    assert_eq!(
        build_endpoint_url(p, "https://token.sensenova.cn/v1"),
        "https://token.sensenova.cn/v1/chat/completions"
    );
    // 6. 绝对无 // 或 /v1/v1
    let url = build_endpoint_url(p, "https://api.openai.com/v1/");
    assert!(!url.contains("//chat"));
    assert!(!url.contains("/v1/v1"));
}

#[test]
fn test_build_endpoint_url_google_generate_content() {
    let p = ProtocolKind::GoogleGenerateContent;
    assert_eq!(
        build_endpoint_url(p, "https://generativelanguage.googleapis.com"),
        "https://generativelanguage.googleapis.com/v1beta"
    );
    assert_eq!(
        build_endpoint_url(p, "https://generativelanguage.googleapis.com/"),
        "https://generativelanguage.googleapis.com/v1beta"
    );
    assert_eq!(
        build_endpoint_url(p, "https://generativelanguage.googleapis.com/v1beta"),
        "https://generativelanguage.googleapis.com/v1beta"
    );
    assert_eq!(
        build_endpoint_url(p, "https://generativelanguage.googleapis.com/v1beta/"),
        "https://generativelanguage.googleapis.com/v1beta"
    );
}

#[test]
fn test_wire_protocol_resolve_endpoint_url_method() {
    assert_eq!(
        WireProtocol::Chat.resolve_endpoint_url("https://api.openai.com/v1"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        WireProtocol::Responses.resolve_endpoint_url("https://api.openai.com/v1"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        WireProtocol::Anthropic.resolve_endpoint_url("https://api.anthropic.com"),
        "https://api.anthropic.com/v1/messages"
    );
    // 测试别名常量的调用
    assert_eq!(
        WireProtocol::OpenAiChat.resolve_endpoint_url("https://api.deepseek.com"),
        "https://api.deepseek.com/chat/completions"
    );
    assert_eq!(
        WireProtocol::OpenAiResponses.resolve_endpoint_url("https://api.openai.com"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        WireProtocol::AnthropicMessages.resolve_endpoint_url("https://api.anthropic.com/v1/"),
        "https://api.anthropic.com/v1/messages"
    );
}
