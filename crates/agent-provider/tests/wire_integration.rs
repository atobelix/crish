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
use agent_provider::models::catalog_types::{
    default_protocol, ModelSpec, ProtocolKind, ProviderSpec, ThinkingFormat,
};
use agent_provider::models::ModelCatalog;
use agent_provider::request::wire_protocol::{
    build_endpoint_url, resolve_effective_protocol, resolve_effective_protocol_from_context,
    ProtocolResolutionContext,
};
use agent_provider::request::{
    anthropic_request_headers, build_anthropic_request_body, build_chat_completions_request_body,
    build_gemini_request_body, effort_to_budget_tokens, effort_to_gemini_thinking_level,
    gemini_request_headers, resolve_wire_protocol,
    vendor::{thinking_to_budget_tokens, thinking_to_gemini_thinking_level},
    AnthropicRequestOptions, ChatCompletionsRequestOptions, GeminiRequestOptions, ReasoningEffort,
    ReasoningVendor, RequestBuildContext, ThinkingIntensity, WireProtocol,
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

fn chat_body(opts: &ChatCompletionsRequestOptions, messages: Vec<Arc<AgentMessage>>) -> Value {
    let context = RequestBuildContext {
        system_prompt: None,
        messages: static_slice(messages),
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    build_chat_completions_request_body(opts, &context)
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
        let mut thinking_map = indexmap::IndexMap::new();
        let effort_key = match effort {
            ReasoningEffort::Minimal => "Minimal",
            ReasoningEffort::Low => "Low",
            ReasoningEffort::Medium => "Medium",
            ReasoningEffort::High => "High",
            ReasoningEffort::Xhigh => "X-High",
            ReasoningEffort::Max => "Max",
            _ => "Medium",
        };
        thinking_map.insert(effort_key.to_string(), effort_to_budget_tokens(effort).to_string());
        let opts = AnthropicRequestOptions {
            model: Some("claude-sonnet-4-5".to_string()),
            reasoning_effort: Some(effort),
            thinking_format: Some(ThinkingFormat::Anthropic),
            thinking_map: Some(thinking_map),
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
        let mut thinking_map = indexmap::IndexMap::new();
        let key = match intensity {
            ThinkingIntensity::Minimal => "Minimal",
            ThinkingIntensity::Low => "Low",
            ThinkingIntensity::Medium => "Medium",
            ThinkingIntensity::High => "High",
            ThinkingIntensity::Xhigh => "X-High",
            ThinkingIntensity::Max => "Max",
            _ => "Medium",
        };
        thinking_map.insert(key.to_string(), thinking_to_budget_tokens(intensity).to_string());
        let opts = AnthropicRequestOptions {
            model: Some("claude-sonnet-4-5".to_string()),
            thinking_intensity: Some(intensity),
            thinking_format: Some(ThinkingFormat::Anthropic),
            thinking_map: Some(thinking_map),
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
        thinking_format: Some(ThinkingFormat::Anthropic),
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

// ─────────── 3. gemini 思考档位链路 ───────────

/// thinkingIntensity → `generationConfig.thinkingConfig.thinkingLevel`，与 vendor 换算同值。
#[test]
fn gemini_intensity_maps_to_generation_config_thinking_level() {
    for intensity in [
        ThinkingIntensity::Minimal,
        ThinkingIntensity::Low,
        ThinkingIntensity::Medium,
        ThinkingIntensity::High,
    ] {
        let expected = thinking_to_gemini_thinking_level(intensity);
        let mut thinking_map = indexmap::IndexMap::new();
        let key = match intensity {
            ThinkingIntensity::Minimal => "Minimal",
            ThinkingIntensity::Low => "Low",
            ThinkingIntensity::Medium => "Medium",
            ThinkingIntensity::High => "High",
            ThinkingIntensity::Xhigh => "X-High",
            ThinkingIntensity::Max => "Max",
            _ => "Medium",
        };
        thinking_map.insert(key.to_string(), expected.to_string());
        let opts = GeminiRequestOptions {
            model: Some("gemini-2.5-pro".to_string()),
            thinking_intensity: Some(intensity),
            thinking_format: Some(ThinkingFormat::Gemini),
            thinking_map: Some(thinking_map),
            ..GeminiRequestOptions::default()
        };
        let body = gemini_body(&opts, vec![Arc::new(user_msg("hi"))]);
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingLevel"], expected,
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
    assert_eq!(effort_to_budget_tokens(ReasoningEffort::Minimal), 1024);
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

// ─────────── 6. 路由跨层（C12 四轨 · bundled catalog 真源） ───────────

/// `resolve_wire_protocol` × 内置目录对 anthropic/gemini 的实际路由真源核对。
/// 【依赖 A1/A6 目录数据】目录 mode 已补录为专轨值（anthropic→"anthropic"、
/// gemini→"gemini"），模型级 mode 优先于全局 endpoint：claude/gemini 条目
/// 即使显式 ChatCompletions 端点也路由到对应专轨协议（见跨层结论报告 A6）。
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
        "gemini-2-5-pro",
        Some(Endpoint::ChatCompletions),
    );
    assert_eq!(
        claude,
        WireProtocol::Anthropic,
        "catalog mode=\"anthropic\" → claude 路由 Anthropic（mode 优先于 endpoint）"
    );
    assert_eq!(
        gemini,
        WireProtocol::Gemini,
        "catalog mode=\"gemini\" → gemini 路由 Gemini（mode 优先于 endpoint）"
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

// ─────────── 7. 2026 真实模型请求体校验 ───────────

/// OpenAI Chat (`gpt-5.6-sol` / `o3`): `reasoning_effort` 为纯英文字符串 `"low"`/`"medium"`/`"high"`，断言其为 String。
#[test]
fn openai_chat_2026_wire_payload_reasoning_effort_string() {
    for model_name in ["gpt-5.6-sol", "o3"] {
        for (effort, expected_str) in [
            (ReasoningEffort::Low, "low"),
            (ReasoningEffort::Medium, "medium"),
            (ReasoningEffort::High, "high"),
        ] {
            let mut map = indexmap::IndexMap::new();
            map.insert("Low".to_string(), "low".to_string());
            map.insert("Medium".to_string(), "medium".to_string());
            map.insert("High".to_string(), "high".to_string());
            let opts = ChatCompletionsRequestOptions {
                model: Some(model_name.to_string()),
                reasoning_effort: Some(effort),
                vendor: Some(ReasoningVendor::Openai),
                thinking_format: Some(ThinkingFormat::OpenAi),
                thinking_map: Some(map),
                ..ChatCompletionsRequestOptions::default()
            };
            let body = chat_body(&opts, vec![Arc::new(user_msg("Explain quantum computing"))]);
            let reasoning = body
                .get("reasoning_effort")
                .unwrap_or_else(|| panic!("{model_name} 必须包含 reasoning_effort 字段"));

            // 严格断言：必须是纯英文字符串，严禁数字（杜绝 400 Bad Request）
            assert!(
                reasoning.is_string(),
                "{model_name} 的 reasoning_effort 必须为 String 类型，当前为: {reasoning:?}"
            );
            assert!(
                !reasoning.is_number(),
                "{model_name} 的 reasoning_effort 严禁序列化为数字（杜绝网关 400 错误）"
            );
            assert!(
                !reasoning.is_object(),
                "{model_name} Chat Completions 协议中 reasoning_effort 严禁为对象结构"
            );
            assert_eq!(
                reasoning.as_str().unwrap(),
                expected_str,
                "{model_name} reasoning_effort 字符串值不匹配"
            );
        }
    }
}

/// Anthropic Messages (`claude-5`): `thinking.budget_tokens` >= 1024，且请求体 `max_tokens` 大于预算（安全余量 +4096）。
#[test]
fn anthropic_messages_2026_claude5_budget_and_max_tokens_clamp() {
    // 场景 A: 显式指定标准预算 1024
    {
        let mut map = indexmap::IndexMap::new();
        map.insert("Medium".to_string(), "1024".to_string());
        let opts = AnthropicRequestOptions {
            model: Some("claude-5".to_string()),
            reasoning_effort: Some(ReasoningEffort::Medium),
            thinking_format: Some(ThinkingFormat::Anthropic),
            thinking_map: Some(map),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("Refactor this code"))]);
        let thinking = body.get("thinking").expect("claude-5 必须包含 thinking 键");
        assert_eq!(thinking["type"], "enabled");
        let budget = thinking["budget_tokens"]
            .as_u64()
            .expect("budget 必须为 u64");
        assert!(budget >= 1024, "thinking.budget_tokens 必须 >= 1024");
        let max_tokens = body["max_tokens"].as_u64().expect("max_tokens 必须为 u64");
        assert!(
            max_tokens > budget,
            "max_tokens ({max_tokens}) 必须严格大于 budget_tokens ({budget})"
        );
        assert!(
            max_tokens >= budget + 4096,
            "max_tokens 必须预留安全输出余量 (+4096): max_tokens={max_tokens}, budget={budget}"
        );
    }

    // 场景 B: 配置高预算 8192 且用户传入过小的 max_tokens (2048) -> 自动安全抬升至 >= 12288
    {
        let mut map = indexmap::IndexMap::new();
        map.insert("High".to_string(), "8192".to_string());
        let opts = AnthropicRequestOptions {
            model: Some("claude-5".to_string()),
            reasoning_effort: Some(ReasoningEffort::High),
            max_tokens: Some(2048),
            thinking_format: Some(ThinkingFormat::Anthropic),
            thinking_map: Some(map),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("Deep research"))]);
        let thinking = body.get("thinking").expect("必须包含 thinking 键");
        let budget = thinking["budget_tokens"].as_u64().unwrap();
        assert_eq!(budget, 8192);
        let max_tokens = body["max_tokens"].as_u64().unwrap();
        assert!(
            max_tokens >= 8192 + 4096,
            "请求体 max_tokens 必须自动安全抬升至至少 12288 (budget + 4096)，实际为 {max_tokens}"
        );
        assert!(max_tokens > budget);
    }

    // 场景 C: 传入非法低预算 (< 1024，如 500) -> 强制下限钳制至 >= 1024 并安全预留
    {
        let mut map = indexmap::IndexMap::new();
        map.insert("Low".to_string(), "500".to_string());
        let opts = AnthropicRequestOptions {
            model: Some("claude-5".to_string()),
            reasoning_effort: Some(ReasoningEffort::Low),
            max_tokens: Some(1000),
            thinking_format: Some(ThinkingFormat::Anthropic),
            thinking_map: Some(map),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("Quick answer"))]);
        let thinking = body.get("thinking").expect("必须包含 thinking 键");
        let budget = thinking["budget_tokens"].as_u64().unwrap();
        assert!(
            budget >= 1024,
            "低于 1024 的思考预算必须被强制钳制到 1024 下限，实际为 {budget}"
        );
        let max_tokens = body["max_tokens"].as_u64().unwrap();
        assert!(
            max_tokens >= 1024 + 4096,
            "max_tokens 必须依据钳制后预算安全抬升至至少 5120，实际为 {max_tokens}"
        );
        assert!(max_tokens > budget);
    }

    // 场景 D: 通过 reasoning_effort: High 驱动
    {
        let mut map = indexmap::IndexMap::new();
        map.insert("High".to_string(), "4096".to_string());
        let opts = AnthropicRequestOptions {
            model: Some("claude-5".to_string()),
            reasoning_effort: Some(ReasoningEffort::High),
            thinking_format: Some(ThinkingFormat::Anthropic),
            thinking_map: Some(map),
            ..AnthropicRequestOptions::default()
        };
        let body = anthropic_body(&opts, vec![Arc::new(user_msg("Analyze architecture"))]);
        let thinking = body.get("thinking").expect("High 档位必须生成 thinking 键");
        let budget = thinking["budget_tokens"].as_u64().unwrap();
        assert!(budget >= 1024);
        let max_tokens = body["max_tokens"].as_u64().unwrap();
        assert!(max_tokens >= budget + 4096);
        assert!(max_tokens > budget);
    }
}

/// 阿里百炼 (`qwen-3.8-max`): 顶层 `enable_thinking: true`——经生产 builder（assemble_thinking_dialect）。
#[test]
fn ali_bailian_qwen38_wire_payload_top_level_enable_thinking() {
    // 1. 生产 chat builder：thinking_format=Qwen + thinking_map → enable_thinking 布尔方言
    let mut map = indexmap::IndexMap::new();
    map.insert("High".to_string(), "true".to_string());
    let opts = ChatCompletionsRequestOptions {
        model: Some("qwen-3.8-max".to_string()),
        reasoning_effort: Some(ReasoningEffort::High),
        thinking_format: Some(ThinkingFormat::Qwen),
        thinking_map: Some(map),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = chat_body(&opts, vec![Arc::new(user_msg("hi"))]);
    assert_eq!(
        body["enable_thinking"], true,
        "阿里百炼开启思考必须输出顶层 enable_thinking: true"
    );
    assert!(
        body.get("reasoning_effort").is_none(),
        "阿里百炼严禁携带 OpenAI reasoning_effort 字段"
    );

    // 2. 关闭思考：Off → enable_thinking: false
    let opts_off = ChatCompletionsRequestOptions {
        model: Some("qwen-3.8-max".to_string()),
        reasoning_effort: Some(ReasoningEffort::Off),
        thinking_format: Some(ThinkingFormat::Qwen),
        thinking_map: None,
        ..ChatCompletionsRequestOptions::default()
    };
    let body_off = chat_body(&opts_off, vec![Arc::new(user_msg("hi"))]);
    assert_eq!(
        body_off["enable_thinking"], false,
        "阿里百炼关闭思考时输出 enable_thinking: false"
    );
    assert!(body_off.get("reasoning_effort").is_none());
}

/// DeepSeek (`deepseek-v4-pro`): `thinking: {"type": "enabled"}`——经生产 builder。
#[test]
fn deepseek_v4_pro_wire_payload_thinking_enabled_and_disabled() {
    // 1. 思考开启：DeepSeekNative 方言 → thinking:{type:"enabled"}
    let opts_on = ChatCompletionsRequestOptions {
        model: Some("deepseek-v4-pro".to_string()),
        reasoning_effort: Some(ReasoningEffort::Medium),
        thinking_format: Some(ThinkingFormat::DeepSeek),
        thinking_map: None,
        ..ChatCompletionsRequestOptions::default()
    };
    let body_on = chat_body(&opts_on, vec![Arc::new(user_msg("hi"))]);
    assert_eq!(
        body_on["thinking"]["type"], "enabled",
        "DeepSeek 思考开启必须输出 thinking:{{type:\"enabled\"}}"
    );
    assert!(body_on.get("reasoning_effort").is_none());

    // 2. 思考关闭 (Off)：必须显式输出 disabled（严禁带 reasoning_effort）
    let opts_off = ChatCompletionsRequestOptions {
        model: Some("deepseek-v4-pro".to_string()),
        reasoning_effort: Some(ReasoningEffort::Off),
        thinking_format: Some(ThinkingFormat::DeepSeek),
        thinking_map: None,
        ..ChatCompletionsRequestOptions::default()
    };
    let body_off = chat_body(&opts_off, vec![Arc::new(user_msg("hi"))]);
    assert_eq!(
        body_off["thinking"]["type"], "disabled",
        "DeepSeek 思考关闭时必须输出 thinking:{{type:\"disabled\"}}"
    );
    assert!(
        body_off.get("reasoning_effort").is_none(),
        "DeepSeek 思考关闭时不得携带 reasoning_effort 键"
    );
}

// ─────────── 8. 协议决议真实性 (Model.protocol > Provider.protocol > "openai/chat") ───────────

/// 验证三级单向绝对决议公式：EffectiveProtocol = Model.protocol ≻ Provider.protocol ≻ "openai/chat"
#[test]
fn protocol_resolution_three_tier_truth() {
    // 1. Model 显式覆盖 Provider: Model > Provider
    assert_eq!(
        resolve_effective_protocol(
            Some(ProtocolKind::OpenAiResponses),
            Some(ProtocolKind::OpenAiChat),
        ),
        ProtocolKind::OpenAiResponses,
        "Model 级声明 (responses) 必须压倒 Provider 级协议 (chat)"
    );

    assert_eq!(
        resolve_effective_protocol(
            Some(ProtocolKind::AnthropicMessages),
            Some(ProtocolKind::OpenAiResponses),
        ),
        ProtocolKind::AnthropicMessages,
        "Model 级声明 (anthropic) 必须压倒 Provider 级协议 (responses)"
    );

    assert_eq!(
        resolve_effective_protocol(
            Some(ProtocolKind::GoogleGenerateContent),
            Some(ProtocolKind::OpenAiChat),
        ),
        ProtocolKind::GoogleGenerateContent,
        "Model 级声明 (google) 必须压倒 Provider 级协议 (chat)"
    );

    // 2. Model 未指定时继承 Provider: Model(None) -> Provider
    assert_eq!(
        resolve_effective_protocol(None, Some(ProtocolKind::AnthropicMessages)),
        ProtocolKind::AnthropicMessages,
        "Model 未指定时必须如实继承 Provider.protocol (anthropic)"
    );

    assert_eq!(
        resolve_effective_protocol(None, Some(ProtocolKind::OpenAiResponses)),
        ProtocolKind::OpenAiResponses,
        "Model 未指定时必须如实继承 Provider.protocol (responses)"
    );

    // 3. Model 与 Provider 均未指定时兜底: None -> None -> "openai/chat"
    assert_eq!(
        resolve_effective_protocol(None, None),
        ProtocolKind::OpenAiChat,
        "完全无配置时安全兜底至 openai/chat"
    );

    assert_eq!(
        resolve_effective_protocol(None, Some(default_protocol())),
        ProtocolKind::OpenAiChat,
        "Provider 默认协议亦为 openai/chat"
    );

    // 4. ModelSpec 与 ProviderSpec 对象层面的有效协议决议真实性
    let provider_chat = ProviderSpec {
        display_name: Some("OpenAI Gateway".to_string()),
        base_url: Some("https://api.openai.com/v1".to_string()),
        api_key: None,
        headers: None,
        protocol: ProtocolKind::OpenAiChat,
        compat: None,
        models: vec![],
    };

    let model_responses = ModelSpec {
        id: "gpt-5.6-sol".to_string(),
        display_name: Some("GPT-5.6 Sol".to_string()),
        context_window: Some(1050000),
        max_output_tokens: Some(128000),
        protocol: Some(ProtocolKind::OpenAiResponses),
        modalities: None,
        thinking: None,
        pricing: None,
        compat: None,
    };

    let model_inherit = ModelSpec {
        id: "gpt-4o".to_string(),
        display_name: Some("GPT-4o".to_string()),
        context_window: Some(128000),
        max_output_tokens: Some(4096),
        protocol: None,
        modalities: None,
        thinking: None,
        pricing: None,
        compat: None,
    };

    assert_eq!(
        model_responses.effective_protocol(&provider_chat),
        ProtocolKind::OpenAiResponses,
        "gpt-5.6-sol 在 provider 默认为 chat 时通过局部覆盖决议为 responses"
    );
    assert_eq!(
        model_inherit.effective_protocol(&provider_chat),
        ProtocolKind::OpenAiChat,
        "gpt-4o 未配置 protocol 时继承 provider 默认的 chat 协议"
    );

    // 5. 基于字符串上下文的三级决议包装测试 (resolve_effective_protocol_from_context)
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

    // 非法字符串安全回退至上一层或兜底
    let ctx_invalid_model = ProtocolResolutionContext {
        model_protocol: Some("unknown/alien-protocol"),
        provider_protocol: Some("openai/responses"),
    };
    assert_eq!(
        resolve_effective_protocol_from_context(&ctx_invalid_model),
        WireProtocol::Responses
    );

    let ctx_both_invalid = ProtocolResolutionContext {
        model_protocol: Some("unknown/alien"),
        provider_protocol: Some("unknown/alien"),
    };
    assert_eq!(
        resolve_effective_protocol_from_context(&ctx_both_invalid),
        WireProtocol::Chat
    );
}

// ─────────── 9. URL 拼装断言 (去除尾部斜杠、/v1 不重复拼接) ───────────

/// 规范化端点 URL 拼装算法断言：去除尾部斜杠、杜绝 `/v1/v1` 或 `//` 重复拼接
#[test]
fn endpoint_url_assembly_no_trailing_slash_no_v1_duplication() {
    let test_cases = [
        // 场景 1: OpenAI Chat 标准路径拼装
        (
            "https://api.openai.com/v1",
            ProtocolKind::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
        ),
        (
            "https://api.openai.com/v1/",
            ProtocolKind::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
        ),
        (
            "https://api.openai.com/v1///",
            ProtocolKind::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
        ),
        (
            "https://api.openai.com/v1/chat/completions",
            ProtocolKind::OpenAiChat,
            "https://api.openai.com/v1/chat/completions",
        ),
        (
            "https://dashscope.aliyuncs.com/compatible-mode/v1/",
            ProtocolKind::OpenAiChat,
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        ),
        (
            "https://openrouter.ai/api/v1/",
            ProtocolKind::OpenAiChat,
            "https://openrouter.ai/api/v1/chat/completions",
        ),
        (
            "https://api.deepseek.com",
            ProtocolKind::OpenAiChat,
            "https://api.deepseek.com/chat/completions",
        ),
        // 场景 2: OpenAI Responses 原生路径拼装 (/responses)
        (
            "https://api.openai.com/v1",
            ProtocolKind::OpenAiResponses,
            "https://api.openai.com/v1/responses",
        ),
        (
            "https://api.openai.com/v1/",
            ProtocolKind::OpenAiResponses,
            "https://api.openai.com/v1/responses",
        ),
        (
            "https://api.openai.com",
            ProtocolKind::OpenAiResponses,
            "https://api.openai.com/v1/responses",
        ),
        (
            "https://api.openai.com/v1/responses",
            ProtocolKind::OpenAiResponses,
            "https://api.openai.com/v1/responses",
        ),
        // 场景 3: Anthropic Messages 原生路径拼装 (/v1/messages)
        (
            "https://api.anthropic.com",
            ProtocolKind::AnthropicMessages,
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "https://api.anthropic.com/",
            ProtocolKind::AnthropicMessages,
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "https://api.anthropic.com/v1",
            ProtocolKind::AnthropicMessages,
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "https://api.anthropic.com/v1/",
            ProtocolKind::AnthropicMessages,
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "https://api.anthropic.com/v1/messages",
            ProtocolKind::AnthropicMessages,
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "https://api.anthropic.com/messages",
            ProtocolKind::AnthropicMessages,
            "https://api.anthropic.com/messages",
        ),
        // 场景 4: Google GenerateContent
        (
            "https://generativelanguage.googleapis.com",
            ProtocolKind::GoogleGenerateContent,
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        (
            "https://generativelanguage.googleapis.com/",
            ProtocolKind::GoogleGenerateContent,
            "https://generativelanguage.googleapis.com/v1beta",
        ),
        (
            "https://generativelanguage.googleapis.com/v1beta",
            ProtocolKind::GoogleGenerateContent,
            "https://generativelanguage.googleapis.com/v1beta",
        ),
    ];

    for (base_url, protocol, expected_url) in test_cases {
        let actual_url = build_endpoint_url(protocol, base_url);
        assert_eq!(
            actual_url, expected_url,
            "拼装失败 (protocol: {protocol:?}, base_url: {base_url})"
        );

        // 也通过 WireProtocol::resolve_endpoint_url 检验同轨一致性
        let wire_proto = WireProtocol::from(protocol);
        assert_eq!(
            wire_proto.resolve_endpoint_url(base_url),
            expected_url,
            "WireProtocol::resolve_endpoint_url 与 build_endpoint_url 不一致"
        );

        // 刚性结构断言
        assert!(
            !actual_url.ends_with('/'),
            "规范化 URL 绝对不能以斜杠结尾: {actual_url}"
        );
        assert!(
            !actual_url.contains("/v1/v1"),
            "规范化 URL 绝对不能包含重复的 /v1/v1: {actual_url}"
        );
        // 确保除去协议头的 '://' 之后，路径内不包含双斜杠 '//'
        let path_part = actual_url.split("://").nth(1).unwrap_or(&actual_url);
        assert!(
            !path_part.contains("//"),
            "规范化 URL 路径内部绝对不能出现双斜杠 '//': {actual_url}"
        );
    }
}
