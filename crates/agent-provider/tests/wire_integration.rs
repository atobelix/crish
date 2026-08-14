//! R4-A5 跨层集成验证（多模型适配战役 · 轮次 4 · 校验面）
//!
//! 面向既有契约（R3 C6/C7/C12 + R2 T2.1a/b）做 builder ↔ vendor/方言 ↔ 壳层路由的
//! **跨层消费验证**，全部为纯 wire 字节级语义断言（无 IO）：
//! - anthropic 思考档位：档次（vendor 换算）→ `build_anthropic_request_body` →
//!   `thinking:{type:"enabled",budget_tokens}`（启用）/ 无 `thinking` 键（off/省略）；
//! - anthropic-beta 基线头：`anthropic_request_headers` 无 beta 基础三头；显式档位 beta
//!   经 `reasoning_effort_headers`（壳层共享决议）。**代际感知 beta 抑制**（adaptive 新代际
//!   → 无 beta）属 A1 落盘项（依赖标注见报告）；
//! - gemini 思考档位：档次 → `build_gemini_request_body` → `generationConfig
//!   .thinking_level` / 无（off）；
//! - INV-07 交替：连续 assistant → anthropic messages 无相邻 assistant
//!   （`push_alternating` 消费验证）；
//! - 路由跨层：`resolve_wire_protocol` × `bundled_catalog()` 对 anthropic/gemini 的真源决议。

use agent_provider::config::Endpoint;
use agent_provider::models::ModelCatalog;
use agent_provider::request::{
    anthropic_request_headers, build_anthropic_request_body, build_gemini_request_body,
    effort_to_budget_tokens, effort_to_gemini_thinking_level, gemini_request_headers,
    reasoning_effort_headers, resolve_thinking_params, resolve_wire_protocol,
    vendor::{thinking_to_budget_tokens, thinking_to_gemini_thinking_level},
    AnthropicRequestOptions, GeminiRequestOptions, ReasoningEffort, ReasoningVendor,
    RequestBuildContext, ThinkingIntensity, WireProtocol,
};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::SystemPromptWireMode;
use serde_json::Value;
use std::sync::Arc;

// ─────────── 消息构造辅助 ───────────

fn user_msg(text: &str) -> AgentMessage {
    AgentMessage {
        id: "u1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn assistant_msg(id: &str, text: &str) -> AgentMessage {
    AgentMessage {
        id: id.to_string(),
        role: AgentMessageRole::Assistant,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 借用拉长至 'static（模拟壳层 Arc 消息切片驱动 builder）
fn static_slice(messages: Vec<Arc<AgentMessage>>) -> &'static [Arc<AgentMessage>] {
    Box::leak(messages.into_boxed_slice())
}

fn anthropic_body(opts: &AnthropicRequestOptions, messages: Vec<Arc<AgentMessage>>) -> Value {
    let context = RequestBuildContext {
        system_prompt: None,
        messages: static_slice(messages),
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    build_anthropic_request_body(opts, &context)
}

fn gemini_body(opts: &GeminiRequestOptions, messages: Vec<Arc<AgentMessage>>) -> Value {
    let context = RequestBuildContext {
        system_prompt: None,
        messages: static_slice(messages),
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    build_gemini_request_body(opts, &context)
}

fn infer_capability(model: &str) -> agent_provider::request::ThinkingCapability {
    agent_provider::request::infer_thinking_capability(model)
}

// ─────────── 1. anthropic 思考档位链路 ───────────

/// effort 档位 → body `thinking:{type:"enabled",budget_tokens}`，budget 与 vendor 换算同值。
#[test]
fn anthropic_effort_tier_produces_enabled_thinking() {
    for effort in [
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Xhigh,
        ReasoningEffort::Max,
    ] {
        let opts = AnthropicRequestOptions {
            model: Some("claude-sonnet-4-5".to_string()),
            reasoning_effort: Some(effort),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("hi"))]);
        let thinking = body.get("thinking").expect("启用档位必须带 thinking 键");
        assert_eq!(thinking["type"], "enabled");
        assert_eq!(
            thinking["budget_tokens"],
            effort_to_budget_tokens(effort),
            "档位 {effort:?} 的 budget_tokens 必须与 vendor 换算一致"
        );
        let wire = serde_json::to_string(&thinking).unwrap();
        assert!(
            wire.contains("\"budget_tokens\""),
            "wire 必须含 budget_tokens：{wire}"
        );
    }
}

/// thinkingIntensity 透传（01 D5）：档位 → thinking budget_tokens；Off → 无 thinking 键。
#[test]
fn anthropic_intensity_tier_produces_thinking_or_omits_on_off() {
    for intensity in [
        ThinkingIntensity::Minimal,
        ThinkingIntensity::Low,
        ThinkingIntensity::Medium,
        ThinkingIntensity::High,
        ThinkingIntensity::Xhigh,
        ThinkingIntensity::Max,
    ] {
        let opts = AnthropicRequestOptions {
            model: Some("claude-sonnet-4-5".to_string()),
            thinking_intensity: Some(intensity),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("hi"))]);
        let thinking = body
            .get("thinking")
            .expect("启用 intensity 必须带 thinking");
        assert_eq!(thinking["type"], "enabled");
        assert_eq!(
            thinking["budget_tokens"],
            thinking_to_budget_tokens(intensity)
        );
    }
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4-5".to_string()),
        thinking_intensity: Some(ThinkingIntensity::Off),
        ..AnthropicRequestOptions::default()
    };
    let body = anthropic_body(&opts, vec![Arc::new(user_msg("hi"))]);
    assert!(body.get("thinking").is_none(), "Off 不得注入 thinking 键");
}

/// effort off/auto/None → 无 thinking 键：关闭语义在 wire 层生效。
#[test]
fn anthropic_off_and_auto_omit_thinking_key() {
    for effort in [ReasoningEffort::Off, ReasoningEffort::Auto] {
        let opts = AnthropicRequestOptions {
            model: Some("claude-sonnet-4-5".to_string()),
            reasoning_effort: Some(effort),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("hi"))]);
        assert!(
            body.get("thinking").is_none(),
            "effort {effort:?} 不应注入 thinking"
        );
    }
    let body = anthropic_body(
        &AnthropicRequestOptions {
            model: Some("claude-sonnet-4-5".to_string()),
            ..AnthropicRequestOptions::default()
        },
        vec![Arc::new(user_msg("hi"))],
    );
    assert!(body.get("thinking").is_none(), "无档位不注入 thinking");
}

// ─────────── 2. anthropic-beta 头链路 ───────────

/// 基线头：`anthropic_request_headers` 为稳定无 beta 三头（x-api-key / version / content-type）。
#[test]
fn anthropic_base_headers_have_exactly_three_no_beta() {
    let headers = anthropic_request_headers("sk-test");
    let map: std::collections::BTreeMap<&'static str, &String> =
        headers.iter().map(|(k, v)| (*k, v)).collect();
    assert_eq!(map.len(), 3, "基线头应恰为三个，无 beta");
    assert_eq!(map["x-api-key"], "sk-test");
    assert_eq!(map["anthropic-version"], "2023-06-01");
    assert_eq!(map["content-type"], "application/json");
    assert!(
        !headers.iter().any(|(n, _)| *n == "anthropic-beta"),
        "基线头不得携带 anthropic-beta"
    );
}

/// 显式档位 beta 头：仅非 off/auto 档位经 `reasoning_effort_headers` 返回。
#[test]
fn anthropic_beta_header_for_explicit_effort_only() {
    for effort in [
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::Xhigh,
        ReasoningEffort::Max,
    ] {
        let header = reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(effort));
        assert!(header.is_some(), "档位 {effort:?} 应返回 beta 头");
        assert_eq!(header.unwrap().0, "anthropic-beta");
    }
    for effort in [ReasoningEffort::Off, ReasoningEffort::Auto] {
        assert!(
            reasoning_effort_headers(Some(ReasoningVendor::Anthropic), Some(effort)).is_none(),
            "off/auto 不得返回 beta 头"
        );
    }
    assert!(
        reasoning_effort_headers(Some(ReasoningVendor::Anthropic), None).is_none(),
        "无档位不得返回 beta 头"
    );
}

// ─────────── 3. gemini 思考档位链路 ───────────

/// thinkingIntensity → `generationConfig.thinking_level`，与 vendor 换算同值。
#[test]
fn gemini_intensity_maps_to_generation_config_thinking_level() {
    for intensity in [
        ThinkingIntensity::Minimal,
        ThinkingIntensity::Low,
        ThinkingIntensity::Medium,
        ThinkingIntensity::High,
    ] {
        let opts = GeminiRequestOptions {
            model: Some("gemini-2.5-pro".to_string()),
            thinking_intensity: Some(intensity),
            ..GeminiRequestOptions::default()
        };
        let body = gemini_body(&opts, vec![Arc::new(user_msg("hi"))]);
        let expected = thinking_to_gemini_thinking_level(intensity);
        assert_eq!(
            body["generationConfig"]["thinking_level"], expected,
            "intensity {intensity:?} 必须与 vendor 换算一致"
        );
    }
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::High),
        "high"
    );
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::Medium),
        "medium"
    );
    assert_eq!(
        effort_to_gemini_thinking_level(ReasoningEffort::Minimal),
        "minimal"
    );
}

/// Off → 无 generationConfig.thinking_level（且 wire 不含 thinking_level 键）。
#[test]
fn gemini_off_omits_thinking_level() {
    let opts = GeminiRequestOptions {
        model: Some("gemini-2.5-pro".to_string()),
        thinking_intensity: Some(ThinkingIntensity::Off),
        ..GeminiRequestOptions::default()
    };
    let body = gemini_body(&opts, vec![Arc::new(user_msg("hi"))]);
    if let Some(generation) = body.get("generationConfig").and_then(|v| v.as_object()) {
        assert!(
            !generation.contains_key("thinking_level"),
            "Off 不得含 thinking_level"
        );
    }
    let wire = serde_json::to_string(&body).unwrap();
    assert!(
        !wire.contains("thinking_level"),
        "Off 时 wire 不得含 thinking_level"
    );
}

// ─────────── 4. INV-07 交替（push_alternating 消费） ───────────

/// 连续 assistant → builder wire 插 user 占位，保证无相邻 assistant（Anthropic 交替铁律）。
#[test]
fn consecutive_assistant_alternative_projection_inv07() {
    let opts = AnthropicRequestOptions {
        model: Some("claude-sonnet-4-5".to_string()),
        ..AnthropicRequestOptions::default()
    };
    let body = anthropic_body(
        &opts,
        vec![
            Arc::new(assistant_msg("a1", "第一段")),
            Arc::new(user_msg("追问")),
            Arc::new(assistant_msg("a2", "第二段")),
            Arc::new(assistant_msg("a3", "第三段")),
        ],
    );
    let messages = body["messages"].as_array().expect("messages 数组");
    let roles: Vec<&str> = messages
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(
        roles,
        vec![
            "user",
            "assistant",
            "user",
            "assistant",
            "user",
            "assistant"
        ]
    );
    for pair in roles.windows(2) {
        assert!(
            !(pair[0] == "assistant" && pair[1] == "assistant"),
            "wire 不得出现连续 assistant：{roles:?}"
        );
    }
}

// ─────────── 5. vendor ↔ builder 跨层换算一致性 ───────────

/// budget / thinking_level 换算源常数值钉死（契约防两端漂移）。
#[test]
fn vendor_budget_and_level_constants_are_stable() {
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Minimal), 128);
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Low), 1024);
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Medium), 2048);
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::High), 4096);
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Xhigh), 8192);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::Medium), 2048);
    assert_eq!(thinking_to_budget_tokens(ThinkingIntensity::High), 4096);
    assert_eq!(
        thinking_to_gemini_thinking_level(ThinkingIntensity::High),
        "high"
    );
    assert_eq!(
        thinking_to_gemini_thinking_level(ThinkingIntensity::Minimal),
        "minimal"
    );
}

/// dialect 层 `resolve_thinking_params`：anthropic 旧代际 → enabled + budget_tokens。
#[test]
fn dialect_resolve_thinking_params_matches_builder_shape() {
    let old_gen = infer_capability("claude-sonnet-4-5");
    let params =
        resolve_thinking_params(&old_gen, ThinkingIntensity::High, Endpoint::ChatCompletions);
    assert_eq!(params["thinking"]["type"], "enabled");
    assert_eq!(params["thinking"]["budget_tokens"], 4096);
    assert!(params.get("thinking").is_some(), "旧代际应为 enabled");
}

/// dialect 层 `resolve_thinking_params`：anthropic 新代际（adaptive）→ display summarized + effort。
#[test]
fn dialect_resolve_thinking_params_adaptive_for_new_gen() {
    let new_gen = infer_capability("claude-sonnet-5");
    let params =
        resolve_thinking_params(&new_gen, ThinkingIntensity::High, Endpoint::ChatCompletions);
    assert_eq!(params["thinking"]["type"], "adaptive");
    assert_eq!(params["thinking"]["display"], "summarized");
    assert_eq!(params["effort"], "high");
    assert!(
        params["thinking"].get("budget_tokens").is_none(),
        "adaptive 形态不得携带 budget_tokens"
    );
}

// ─────────── 6. 路由跨层（C12 四轨 · bundled catalog 真源） ───────────

/// `resolve_wire_protocol` × 内置目录对 anthropic/gemini 的实际路由真源核对。
/// 【依赖 A1/目录数据】当前 catalog mode="chat"（非专轨值），据实记录实际 chat 路由；
/// 目录 mode 演进为专轨值时本断言须同步更新（见跨层结论报告）。
#[test]
fn wire_routing_bundled_catalog_ground_truth() {
    let catalog = ModelCatalog::bundled();
    let claude = resolve_wire_protocol(
        &catalog,
        "anthropic",
        "claude-sonnet-4-5",
        Some(Endpoint::ChatCompletions),
    );
    let gemini = resolve_wire_protocol(
        &catalog,
        "gemini",
        "gemini-2.5-pro",
        Some(Endpoint::ChatCompletions),
    );
    assert_eq!(
        claude,
        WireProtocol::Chat,
        "catalog 当前 mode=chat → claude 路由 chat"
    );
    assert_eq!(
        gemini,
        WireProtocol::Chat,
        "catalog 当前 mode=chat → gemini 路由 chat"
    );
    assert_eq!(WireProtocol::Anthropic.as_str(), "anthropic");
    assert_eq!(WireProtocol::Gemini.as_str(), "gemini");
    assert_eq!(WireProtocol::Chat.as_str(), "chat");
    assert_eq!(WireProtocol::Responses.as_str(), "responses");
}

// ─────────── gemini 头基线 ───────────

#[test]
fn gemini_header_baseline() {
    let headers = gemini_request_headers("sk-gem");
    let names: Vec<&str> = headers.iter().map(|(n, _)| *n).collect();
    assert!(names.contains(&"x-goog-api-key"));
    assert!(names.contains(&"content-type"));
}
