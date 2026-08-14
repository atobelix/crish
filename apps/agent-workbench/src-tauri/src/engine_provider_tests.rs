//! engine_provider 多模型适配战役 R3 T3.2 测试旁挂（engine_provider.rs → engine_provider_tests.rs）
//!
//! 覆盖：四协议（chat / responses / anthropic / gemini）URL/body/parser 三处同轨、
//! 思考档位（series 级）消费、INV-07 连续 assistant 交替投影、chat/responses 回归。
//!
//! **纪律**：只消费 agent-provider 公开 API（resolve_wire_protocol / builder / parser）；
//! 测试经显式 [WireProtocol] 驱动各轨 dispatch 的纯决策入口
//! （[engine_provider::provider_url_for] / [request_body_for] / [http_parser_for_protocol]），
//! 证明「同一协议下 URL/body/parser 同轨」。

use super::*;
use std::collections::BTreeMap;
use std::sync::Arc;

use agent_provider::config::Endpoint;
use agent_provider::events::ProviderStreamEvent as WireEvent;
use agent_provider::request::WireProtocol;
use agent_provider::sse::SseFrame;
use conex_types::error::ProviderErrorKind;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use session_loop::provider::{ProviderRequest, ReasoningEffort as LoopEffort};
use session_loop::stream::{ProviderStreamEvent, StopReason as LoopStopReason};

/// 构造测试用配置（可指定 base_url / model / endpoint）
fn config(base_url: &str, model: &str, endpoint: Endpoint) -> EngineProviderConfig {
    EngineProviderConfig {
        base_url: base_url.to_string(),
        api_key: "k-test".to_string(),
        model: model.to_string(),
        endpoint,
        stream: true,
        extra: BTreeMap::new(),
    }
}

fn call_for(base_url: &str, model: &str, endpoint: Endpoint) -> HttpProviderCall {
    HttpProviderCall::new(reqwest::Client::new(), config(base_url, model, endpoint))
}

/// 单条 user 消息会话
fn single_user_request(
    context: &Vec<Arc<AgentMessage>>,
    reasoning_effort: Option<LoopEffort>,
) -> ProviderRequest<'_> {
    ProviderRequest {
        messages: context,
        tools: Vec::new(),
        max_tokens: Some(1024),
        system_prompt: Some("你是助手。"),
        session_id: None,
        reasoning_effort,
    }
}

fn user_msg(text: &str) -> Arc<AgentMessage> {
    Arc::new(AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    })
}

fn assistant_msg(text: &str) -> Arc<AgentMessage> {
    Arc::new(AgentMessage {
        id: format!("assistant-{text}"),
        role: AgentMessageRole::Assistant,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text { text: text.to_string() }],
        metadata: None,
        client_message_id: None,
        content: None,
    })
}

// ── 验收 2：四协议 URL / body / parser 三处同轨 ──────────────────

/// anthropic 轨：URL messages 端点 + body anthropic 形状 + AnthropicParser
#[test]
fn anthropic_rail_three_piece_consistent() {
    let call = call_for("https://api.anthropic.com", "claude-sonnet-5", Endpoint::ChatCompletions);
    let protocol = WireProtocol::Anthropic;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);

    // URL → messages 端点
    let url = provider_url_for(&call.config, protocol);
    assert!(url.ends_with("/v1/messages"), "URL 落 messages 端点：{url}");

    // body → anthropic 形状（system + messages，非 chat messages 数组形状）
    let body = call.request_body_for(protocol, &request);
    assert_eq!(body["model"], "claude-sonnet-5");
    assert_eq!(body["system"], "你是助手。");
    assert_eq!(body["messages"][0]["role"], "user");
    assert!(
        body.get("input").is_none() && body.get("instructions").is_none(),
        "anthropic 轨不得出现 responses 形状字段"
    );

    // parser → AnthropicParser（消费 anthropic 帧）
    let mut parser = http_parser_for_protocol(protocol);
    let frame = SseFrame {
        event: None,
        data: Some(r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#.to_string()),
        id: None,
        retry: None,
    };
    // 不 panic、能委派（anthropic 帧形状被 AnthropicParser 接受）
    let _ = parser.push_frame(&frame).map(|_| ());
    assert!(matches!(parser, HttpStreamParser::Anthropic(_)));
}

/// gemini 轨：URL generateContent 端点 + body gemini 形状 + GeminiParser
#[test]
fn gemini_rail_three_piece_consistent() {
    let call = call_for("https://generativelanguage.googleapis.com", "gemini-3-6-flash", Endpoint::ChatCompletions);
    let protocol = WireProtocol::Gemini;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);

    // URL → generateContent 端点
    let url = provider_url_for(&call.config, protocol);
    assert!(
        url.contains(":generateContent"),
        "URL 落 generateContent 端点：{url}"
    );

    // body → gemini 形状（contents / systemInstruction）
    let body = call.request_body_for(protocol, &request);
    assert_eq!(body["model"], "gemini-3-6-flash");
    assert_eq!(body["contents"][0]["role"], "user");
    assert!(body.get("systemInstruction").is_some(), "gemini 轨应带 systemInstruction");

    // parser → GeminiParser
    assert!(matches!(http_parser_for_protocol(protocol), HttpStreamParser::Gemini(_)));
}

/// chat / responses 轨：各自的 URL / body / parser（显式协议驱动，回归既有字节语义）
#[test]
fn chat_and_responses_rails_preserved() {
    let chat_call = call_for("https://api.example.com/v1", "deepseek-v4", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);

    // chat 轨：URL chat/completions + body 含 messages + ChatCompletionsParser
    let chat_url = provider_url_for(&chat_call.config, WireProtocol::Chat);
    assert!(chat_url.ends_with("/chat/completions"));
    let chat_body = chat_call.request_body_for(WireProtocol::Chat, &request);
    assert!(chat_body.get("messages").is_some(), "chat 轨必须携带 messages");
    assert!(matches!(http_parser_for_protocol(WireProtocol::Chat), HttpStreamParser::Chat(_)));

    // responses 轨：URL /responses + body input 形状 + ResponsesParser
    let resp_call = call_for("https://api.example.com/v1", "deepseek-v4-flash", Endpoint::Responses);
    let resp_url = provider_url_for(&resp_call.config, WireProtocol::Responses);
    assert!(resp_url.ends_with("/responses"));
    let resp_body = resp_call.request_body_for(WireProtocol::Responses, &request);
    assert!(resp_body.get("input").is_some(), "responses 轨 body 为 input 形状");
    assert!(
        matches!(http_parser_for_protocol(WireProtocol::Responses), HttpStreamParser::Responses(_))
    );
}

// ── 验收 3：思考档位（series 级）消费 ─────────────────────────────

/// 生效协议由配置推导（单一真源）：同一配置下 URL/body/parser 同轨。
/// chat/responses 两态经 [effective_protocol] 推导可真跑；anthropic/gemini 为
/// model 级 mode 强路由（catalog mode，测试侧经显式协议 dispatch 断言）。
#[test]
fn effective_protocol_keeps_url_body_parser_in_rail() {
    // responses 配置（deepseek-v4-flash + Responses 端点）：协议推导 + URL + parser 一致
    let resp = call_for("https://api.deepseek.com/v1", "deepseek-v4-flash", Endpoint::Responses);
    assert_eq!(effective_protocol(&resp.config), WireProtocol::Responses);
    // 未收录模型（deepseek-custom + Responses 端点）保守降级 chat（既有语义）
    let unknown = call_for("https://api.deepseek.com/v1", "deepseek-custom", Endpoint::Responses);
    assert_eq!(effective_protocol(&unknown.config), WireProtocol::Chat);

    // chat 配置（deepseek + ChatCompletions 端点）→ chat
    let chat = call_for("https://api.deepseek.com/v1", "deepseek-v4", Endpoint::ChatCompletions);
    assert_eq!(effective_protocol(&chat.config), WireProtocol::Chat);

    // 显式协议 dispatch 与协议一致：anthropic / gemini 的 URL/body/parser 同轨
    for protocol in [WireProtocol::Anthropic, WireProtocol::Gemini] {
        let url = provider_url_for(&chat.config, protocol);
        let parser = http_parser_for_protocol(protocol);
        let belongs = match protocol {
            WireProtocol::Anthropic => url.ends_with("/v1/messages") && matches!(parser, HttpStreamParser::Anthropic(_)),
            WireProtocol::Gemini => url.contains(":generateContent") && matches!(parser, HttpStreamParser::Gemini(_)),
            _ => false,
        };
        assert!(belongs, "协议 {protocol:?} 的 URL 与 parser 应同轨");
    }
}

/// anthropic 轨 + Some(High) → body 含 thinking.budget_tokens
#[test]
fn thinking_high_on_anthropic_rail_emits_budget_tokens() {
    let call = call_for("https://api.anthropic.com", "claude-sonnet-4", Endpoint::ChatCompletions);
    let protocol = WireProtocol::Anthropic;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, Some(LoopEffort::High));
    let body = call.request_body_for(protocol, &request);
    assert!(
        body.get("thinking").is_some(),
        "anthropic 轨思考档位应注入 thinking：{body}"
    );
    assert_eq!(body["thinking"]["type"], "enabled");
    let budget = body["thinking"]["budget_tokens"].as_u64().expect("budget_tokens 应为整数");
    assert!(budget > 0, "budget_tokens 应 > 0，实际 {budget}");
}

/// chat 轨 + Some(High) → body 含 reasoning_effort 字段
#[test]
fn thinking_high_on_chat_rail_emits_reasoning_effort() {
    let call = call_for("https://api.example.com/v1", "gpt-5", Endpoint::ChatCompletions);
    let protocol = WireProtocol::Chat;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, Some(LoopEffort::High));
    let body = call.request_body_for(protocol, &request);
    assert_eq!(
        body["reasoning_effort"], "high",
        "chat 轨思考档位应写入 reasoning_effort：{body}"
    );
}

/// 未指定思考档位（None）→ 不携带思考参数（行为与既有调用方一致）
#[test]
fn thinking_none_omits_reasoning_params() {
    let chat = call_for("https://api.example.com/v1", "gpt-5", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);
    let body = chat.request_body_for(WireProtocol::Chat, &request);
    assert!(body.get("reasoning_effort").is_none(), "None 不携带思考参数");

    let anthropic = call_for("https://api.anthropic.com", "claude-sonnet-4", Endpoint::ChatCompletions);
    let body2 = anthropic.request_body_for(WireProtocol::Anthropic, &request);
    assert!(body2.get("thinking").is_none(), "anthropic 轨 None 不注入 thinking");
}

// ── 验收 4：INV-07 连续 assistant 交替投影 ───────────────────────

/// 连续 assistant（[user, assistant, assistant]）→ 两条 assistant 之间插入
/// user 占位，无相邻 assistant（push_alternating 生效）
#[test]
fn inv07_consecutive_assistant_inserts_user_placeholder() {
    let call = call_for("https://api.anthropic.com", "claude-sonnet-4", Endpoint::ChatCompletions);
    let messages = vec![user_msg("提问"), assistant_msg("第一段"), assistant_msg("第二段")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for(WireProtocol::Anthropic, &request);
    let wire = body["messages"].as_array().expect("anthropic 轨 messages 必须为数组");

    // 无相邻 assistant
    for window in wire.windows(2) {
        assert!(
            !(window[0]["role"] == "assistant" && window[1]["role"] == "assistant"),
            "存在相邻 assistant 条目（INV-07 违规）"
        );
    }
    // 两条 assistant 之间插入一条 user 占位 → 4 条（user, assistant, user, assistant）
    assert_eq!(wire.len(), 4, "两条连续 assistant 之间须插入 user 占位");
    assert_eq!(wire[0]["role"], "user");
    assert_eq!(wire[1]["role"], "assistant");
    assert_eq!(
        wire[2]["role"], "user",
        "占位消息必须是 user 角色"
    );
    assert_eq!(wire[3]["role"], "assistant");
    assert_eq!(
        wire.iter().filter(|m| m["role"] == "assistant").count(),
        2,
        "两条 assistant 内容保留"
    );
}

/// 正常交替（user → assistant）不插入占位
#[test]
fn inv07_strict_alternation_preserves_user_assistant() {
    let call = call_for("https://api.anthropic.com", "claude-sonnet-4", Endpoint::ChatCompletions);
    let messages = vec![user_msg("提问"), assistant_msg("回答")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for(WireProtocol::Anthropic, &request);
    let wire = body["messages"].as_array().expect("messages 数组");
    assert_eq!(wire.len(), 2);
    assert_eq!(wire[0]["role"], "user");
    assert_eq!(wire[1]["role"], "assistant");
}

/// 构造带 session_id 的请求（T3.5 会话亲和头 seam 测试用）
fn request_with_session<'a>(
    context: &'a [Arc<AgentMessage>],
    session_id: Option<&'a str>,
) -> ProviderRequest<'a> {
    ProviderRequest {
        messages: context,
        tools: Vec::new(),
        max_tokens: Some(1024),
        system_prompt: Some("你是助手。"),
        session_id: session_id.map(str::to_string),
        reasoning_effort: None,
    }
}

// ── 验收 T3.5：会话亲和头族 seam（G1-e） ─────────────────────────

/// 请求头（chat 轨）在 session_id 非空时注入会话亲和头；为空不注入。
/// 断言经真实 `request_headers_for`（thread request.session_id）。
#[test]
fn session_head_injected_when_session_id_present() {
    let call = call_for("https://api.example.com/v1", "gpt-5", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];

    // 非空 session_id → 注入 x-deepseek-harness-session-id
    let request = request_with_session(&messages, Some("ses-123"));
    let headers = call.request_headers_for(WireProtocol::Chat, &request);
    assert!(
        headers
            .iter()
            .any(|(name, value)| *name == "x-deepseek-harness-session-id" && value == "ses-123"),
        "session_id 非空应注入会话亲和头：{headers:?}"
    );

    // None → 不注入（对齐 options.sessionId !== undefined 守卫）
    let request = request_with_session(&messages, None);
    let headers = call.request_headers_for(WireProtocol::Chat, &request);
    assert!(
        !headers
            .iter()
            .any(|(name, _)| *name == "x-deepseek-harness-session-id"),
        "session_id 为空不得注入会话亲和头：{headers:?}"
    );

    // 空白串也视为不注入（trim 守卫）
    let request = request_with_session(&messages, Some("   "));
    let headers = call.request_headers_for(WireProtocol::Chat, &request);
    assert!(
        !headers
            .iter()
            .any(|(name, _)| *name == "x-deepseek-harness-session-id"),
        "空白 session_id 不得注入会话亲和头"
    );
}

/// 既有亲和头（Grok → x-grok-conv-id）与会话亲和头族可并存（seam 不破坏既有）。
#[test]
fn session_head_coexists_with_grok_affinity_header() {
    // Grok 由 model 前缀推断（catalog 真源；base_url 占位 api.example.com）
    let call = call_for("https://api.example.com/v1", "grok-4.5", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];
    let request = request_with_session(&messages, Some("ses-abc"));
    let headers = call.request_headers_for(WireProtocol::Chat, &request);

    // 会话亲和头族注入
    assert!(
        headers
            .iter()
            .any(|(name, value)| *name == "x-deepseek-harness-session-id" && value == "ses-abc"),
        "Grok 轨应注入会话亲和头"
    );
    // 既有 x-grok-conv-id 保留（cache 亲和头）
    assert!(
        headers.iter().any(|(name, _)| *name == "x-grok-conv-id"),
        "Grok 既有 x-grok-conv-id 必须保留：{headers:?}"
    );
    // Authorization 恒在
    assert!(headers.iter().any(|(name, _)| *name == "Authorization"));
}

// ── 验收 T3.6：maxTokensField 消费接线（M3 / C5） ─────────────────

/// 会话亲和头与会话亲和头族不进入请求体（不破坏序列化契约）——
/// chat 轨请求体不含任何 x-* 会话头。
#[test]
fn session_heads_never_in_request_body() {
    let call = call_for("https://api.example.com/v1", "gpt-5", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];
    let request = request_with_session(&messages, Some("ses-123"));
    let body = call.request_body_for(WireProtocol::Chat, &request);
    let keys: Vec<&str> = body
        .as_object()
        .expect("body 为对象")
        .keys()
        .map(String::as_str)
        .collect();
    assert!(
        !keys.iter().any(|k| k.starts_with("x-")),
        "会话亲和头不得进入请求体：{body}"
    );
}

/// moonshot 配置 → chat 请求体用 `max_tokens` 字段（C5 旧式网关轨）。
#[test]
fn max_tokens_field_moonshot_uses_max_tokens() {
    let call = call_for("https://api.moonshot.cn/v1", "kimi-k2", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for(WireProtocol::Chat, &request);
    assert_eq!(body["max_tokens"], 1024, "moonshot 写 max_tokens：{body}");
    assert!(
        body.get("max_completion_tokens").is_none(),
        "moonshot 不得写 max_completion_tokens：{body}"
    );
}

/// openai.com / o 系列模型 → chat 请求体用 `max_completion_tokens` 字段。
#[test]
fn max_tokens_field_openai_o_series_uses_max_completion_tokens() {
    let messages = vec![user_msg("你好")];

    // 官方 openai.com baseUrl
    let official = call_for(
        "https://api.openai.com/v1",
        "gpt-5",
        Endpoint::ChatCompletions,
    );
    let body = official.request_body_for(WireProtocol::Chat, &single_user_request(&messages, None));
    assert_eq!(body["max_completion_tokens"], 1024, "openai.com 写 max_completion_tokens：{body}");
    assert!(
        body.get("max_tokens").is_none(),
        "official 不得写 max_tokens：{body}"
    );

    // o 系列模型名（baseUrl 占位非 openai.com）
    let o_series = call_for("https://api.example.com/v1", "o4-mini", Endpoint::ChatCompletions);
    let body2 = o_series.request_body_for(WireProtocol::Chat, &single_user_request(&messages, None));
    assert_eq!(body2["max_completion_tokens"], 1024, "o 系列写 max_completion_tokens：{body2}");
    assert!(
        body2.get("max_tokens").is_none(),
        "o 系列不得写 max_tokens：{body2}"
    );
}

/// 默认 openai-compatible（deepseek 等）→ chat 请求体用 `max_tokens`（字节兼容）。
#[test]
fn max_tokens_field_default_uses_max_tokens() {
    let call = call_for("https://api.deepseek.com/v1", "deepseek-v4-flash", Endpoint::ChatCompletions);
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for(WireProtocol::Chat, &request);
    assert_eq!(body["max_tokens"], 1024, "默认 openai-compatible 写 max_tokens：{body}");
    assert!(
        body.get("max_completion_tokens").is_none(),
        "默认轨不得写 max_completion_tokens：{body}"
    );
}

// ── 验收 T3.2 遗留：Stop.error_kind 透传 ──────────────────────────

/// 携带 error_kind 的 Stop 事件 → to_loop_event 后 session-loop 侧
/// error_kind 透传（agent-provider 与 session-loop 同用 conex_types
/// ::error::ProviderErrorKind，直接类型透传，无 13 类字面映射）。
#[test]
fn stop_error_kind_passes_through_to_loop_event() {
    let wire = WireEvent::Stop {
        reason: agent_provider::events::StopReason::Error,
        error: Some("provider 过载".to_string()),
        error_kind: Some(ProviderErrorKind::RateLimit),
        usage: None,
    };
    match to_loop_event(wire) {
        ProviderStreamEvent::Stop {
            reason,
            error_kind,
            error,
            ..
        } => {
            assert_eq!(reason, LoopStopReason::Error);
            assert_eq!(error_kind, Some(ProviderErrorKind::RateLimit), "error_kind 应透传");
            assert_eq!(error.as_deref(), Some("provider 过载"));
        }
        other => panic!("期望 Stop，得到 {other:?}"),
    }
}
