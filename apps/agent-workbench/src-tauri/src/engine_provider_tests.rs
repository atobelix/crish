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
use std::sync::{Arc, MutexGuard};

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
        ..Default::default()
    }
}

fn call_for(base_url: &str, model: &str, endpoint: Endpoint) -> HttpProviderCall {
    HttpProviderCall::new(reqwest::Client::new(), config(base_url, model, endpoint))
}

/// 进程级 LIVE_CATALOG 为共享静态：与 protocol::live_catalog_tests 共用同一把锁。
/// 夹具安装与消费必须持锁串行；guard 存活覆盖整个测试体。

/// 安装 live yaml 综合夹具（plans/04：协议 / thinking 字典 / compat / headers
/// 全部从 yaml 长出，禁止 URL / 前缀启发式）。返回互斥 guard，调用方必须持有到测试结束。
fn install_live_fixture() -> MutexGuard<'static, ()> {
    let guard = protocol::LIVE_CATALOG_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    protocol::reload_live_catalog_from_yaml_str(
        r#"
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: "https://api.acme.test/v1"
    protocol: "openai/chat"
    compat:
      thinkingFormat: openai
      maxTokensField: max_completion_tokens
    headers:
      x-acme-affinity: "acme-1"
    models:
      - id: acme-think
        thinking:
          High: "high"
  deepseek:
    displayName: DeepSeek
    baseUrl: "https://api.deepseek.com/v1"
    protocol: "openai/chat"
    models:
      - id: deepseek-v4-flash
        thinking:
          High: "high"
          Low: "low"
          Max: "max"
      - id: deepseek-v4
        protocol: "openai/responses"
        thinking:
          High: "high"
  anthropic:
    displayName: Anthropic
    baseUrl: "https://api.anthropic.com"
    protocol: "anthropic/messages"
    compat:
      thinkingFormat: anthropic
    models:
      - id: claude-sonnet-4
        thinking:
          High: "16384"
"#,
    )
    .expect("live 综合夹具必须解析成功");
    guard
}

/// 指向 live 夹具的配置（provider_id = yaml providers 键；base_url 占位——
/// 协议/思考/字段名不依赖 URL）。
fn live_config(provider_id: &str, model: &str) -> EngineProviderConfig {
    EngineProviderConfig {
        base_url: "https://placeholder.invalid".to_string(),
        api_key: "k-test".to_string(),
        model: model.to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        provider_id: Some(provider_id.to_string()),
        ..Default::default()
    }
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
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    })
}

// ── 验收 2：四协议 URL / body / parser 三处同轨 ──────────────────

/// anthropic 轨：URL messages 端点 + body anthropic 形状 + AnthropicParser
#[test]
fn anthropic_rail_three_piece_consistent() {
    let call = call_for(
        "https://api.anthropic.com",
        "claude-sonnet-5",
        Endpoint::ChatCompletions,
    );
    let protocol = WireProtocol::Anthropic;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);

    // URL → messages 端点
    let url = provider_url_for(&call.config, protocol);
    assert!(url.ends_with("/v1/messages"), "URL 落 messages 端点：{url}");

    // body → anthropic 形状（system + messages，非 chat messages 数组形状）
    let body = call.request_body_for_auto(protocol, &request);
    assert_eq!(body["model"], "claude-sonnet-5");
    let system_text = body["system"][0]["text"]
        .as_str()
        .unwrap_or_else(|| body["system"].as_str().unwrap_or_default());
    assert_eq!(system_text, "你是助手。");
    assert_eq!(body["messages"][0]["role"], "user");
    assert!(
        body.get("input").is_none() && body.get("instructions").is_none(),
        "anthropic 轨不得出现 responses 形状字段"
    );

    // parser → AnthropicParser（消费 anthropic 帧）
    let mut parser = http_parser_for_protocol(protocol);
    let frame = SseFrame {
        event: None,
        data: Some(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#
                .to_string(),
        ),
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
    let call = call_for(
        "https://generativelanguage.googleapis.com",
        "gemini-3-6-flash",
        Endpoint::ChatCompletions,
    );
    let protocol = WireProtocol::Gemini;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);

    // URL → streamGenerateContent?alt=sse 端点（流式请求，BC08-1）
    let url = provider_url_for(&call.config, protocol);
    assert!(
        url.contains(":streamGenerateContent?alt=sse"),
        "URL 落 streamGenerateContent?alt=sse 端点：{url}"
    );

    // body → gemini 形状（contents / systemInstruction）
    let body = call.request_body_for_auto(protocol, &request);
    assert_eq!(body["model"], "gemini-3-6-flash");
    assert_eq!(body["contents"][0]["role"], "user");
    assert!(
        body.get("systemInstruction").is_some(),
        "gemini 轨应带 systemInstruction"
    );

    // parser → GeminiParser
    assert!(matches!(
        http_parser_for_protocol(protocol),
        HttpStreamParser::Gemini(_)
    ));
}

/// Gemini URL 在流式与非流式、带与不带 query 参数下的准确拼装测试（BC08-1）
#[test]
fn gemini_url_streaming_and_non_streaming() {
    let mut stream_cfg = config(
        "https://generativelanguage.googleapis.com",
        "gemini-2.5-pro",
        Endpoint::ChatCompletions,
    );
    stream_cfg.stream = true;
    assert_eq!(
        provider_url_for(&stream_cfg, WireProtocol::Gemini),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
    );

    let mut non_stream_cfg = config(
        "https://generativelanguage.googleapis.com",
        "gemini-2.5-pro",
        Endpoint::ChatCompletions,
    );
    non_stream_cfg.stream = false;
    assert_eq!(
        provider_url_for(&non_stream_cfg, WireProtocol::Gemini),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
    );

    let mut query_cfg = config(
        "https://generativelanguage.googleapis.com/v1beta?proxy=1",
        "gemini-2.5-pro",
        Endpoint::ChatCompletions,
    );
    query_cfg.stream = true;
    assert_eq!(
        provider_url_for(&query_cfg, WireProtocol::Gemini),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?proxy=1&alt=sse"
    );

    query_cfg.stream = false;
    assert_eq!(
        provider_url_for(&query_cfg, WireProtocol::Gemini),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?proxy=1"
    );
}

/// chat / responses 轨：各自的 URL / body / parser（显式协议驱动，回归既有字节语义）
#[test]
fn chat_and_responses_rails_preserved() {
    let chat_call = call_for(
        "https://api.example.com/v1",
        "deepseek-v4",
        Endpoint::ChatCompletions,
    );
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);

    // chat 轨：URL chat/completions + body 含 messages + ChatCompletionsParser
    let chat_url = provider_url_for(&chat_call.config, WireProtocol::Chat);
    assert!(chat_url.ends_with("/chat/completions"));
    let chat_body = chat_call.request_body_for_auto(WireProtocol::Chat, &request);
    assert!(
        chat_body.get("messages").is_some(),
        "chat 轨必须携带 messages"
    );
    assert!(matches!(
        http_parser_for_protocol(WireProtocol::Chat),
        HttpStreamParser::Chat(_)
    ));

    // responses 轨：URL /responses + body input 形状 + ResponsesParser
    let resp_call = call_for(
        "https://api.example.com/v1",
        "deepseek-v4-flash",
        Endpoint::Responses,
    );
    let resp_url = provider_url_for(&resp_call.config, WireProtocol::Responses);
    assert!(resp_url.ends_with("/responses"));
    let resp_body = resp_call.request_body_for_auto(WireProtocol::Responses, &request);
    assert!(
        resp_body.get("input").is_some(),
        "responses 轨 body 为 input 形状"
    );
    assert!(matches!(
        http_parser_for_protocol(WireProtocol::Responses),
        HttpStreamParser::Responses(_)
    ));
}

// ── 验收 3：思考档位（series 级）消费 ─────────────────────────────

/// 生效协议由 live yaml 推导（单一真源）：`Model.protocol ≻ Provider.protocol ≻
/// openai/chat`；lookup 未命中 → chat（fail-closed）。URL / 端点字段不参与。
#[test]
fn effective_protocol_keeps_url_body_parser_in_rail() {
    let _fixture = install_live_fixture();
    // responses 配置（deepseek-v4 模型级 protocol openai/responses）
    let resp = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4"),
    );
    assert_eq!(effective_protocol(&resp.config), WireProtocol::Responses);
    // chat 配置（deepseek-v4-flash 继承供应商 openai/chat）
    let chat = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4-flash"),
    );
    assert_eq!(effective_protocol(&chat.config), WireProtocol::Chat);
    // 未命中模型 / 无 provider_id → 保守 chat（fail-closed，禁止 URL 猜）
    let unknown = call_for(
        "https://api.anthropic.com",
        "claude-anything",
        Endpoint::ChatCompletions,
    );
    assert_eq!(effective_protocol(&unknown.config), WireProtocol::Chat);
    // anthropic / gemini 模型级路由 → 对应轨
    let anthropic = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("anthropic", "claude-sonnet-4"),
    );
    assert_eq!(
        effective_protocol(&anthropic.config),
        WireProtocol::Anthropic
    );

    // 显式协议 dispatch 与协议一致：anthropic / gemini 的 URL/body/parser 同轨
    for protocol in [WireProtocol::Anthropic, WireProtocol::Gemini] {
        let url = provider_url_for(&chat.config, protocol);
        let parser = http_parser_for_protocol(protocol);
        let belongs = match protocol {
            WireProtocol::Anthropic => {
                url.ends_with("/v1/messages") && matches!(parser, HttpStreamParser::Anthropic(_))
            }
            WireProtocol::Gemini => {
                url.contains(":streamGenerateContent?alt=sse")
                    && matches!(parser, HttpStreamParser::Gemini(_))
            }
            _ => false,
        };
        assert!(belongs, "协议 {protocol:?} 的 URL 与 parser 应同轨");
    }
}

/// anthropic 轨 + Some(High) → body 含 thinking.budget_tokens（预算来自 yaml
/// 字典数字，禁止魔法刻度）
#[test]
fn thinking_high_on_anthropic_rail_emits_budget_tokens() {
    let _fixture = install_live_fixture();
    let call = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("anthropic", "claude-sonnet-4"),
    );
    let protocol = WireProtocol::Anthropic;
    let messages = vec![user_msg("你好")];
    // max_tokens 放宽到 30000：budget 16384 不被物理上限钳制（单用户请求
    // 默认 1024 会触发 max_cap-4096 钳制）
    let request = ProviderRequest {
        messages: &messages,
        tools: Vec::new(),
        max_tokens: Some(30_000),
        system_prompt: Some("你是助手。"),
        session_id: None,
        reasoning_effort: Some(LoopEffort::High),
    };
    let body = call.request_body_for_auto(protocol, &request);
    assert!(
        body.get("thinking").is_some(),
        "anthropic 轨思考档位应注入 thinking：{body}"
    );
    assert_eq!(body["thinking"]["type"], "enabled");
    let budget = body["thinking"]["budget_tokens"]
        .as_u64()
        .expect("budget_tokens 应为整数");
    assert_eq!(budget, 16384, "预算 = yaml 字典 High 值：{body}");
}

/// chat 轨 + Some(High) → body 含 reasoning_effort 字段（值 = yaml 字典 wire）
#[test]
fn thinking_high_on_chat_rail_emits_reasoning_effort() {
    let _fixture = install_live_fixture();
    let call = HttpProviderCall::new(reqwest::Client::new(), live_config("acme", "acme-think"));
    let protocol = WireProtocol::Chat;
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, Some(LoopEffort::High));
    let body = call.request_body_for_auto(protocol, &request);
    assert_eq!(
        body["reasoning_effort"], "high",
        "chat 轨思考档位应写入 reasoning_effort（字典值）：{body}"
    );
}

/// 未指定思考档位（None）→ 不携带思考参数（行为与既有调用方一致）
#[test]
fn thinking_none_omits_reasoning_params() {
    let chat = call_for(
        "https://api.example.com/v1",
        "gpt-5",
        Endpoint::ChatCompletions,
    );
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);
    let body = chat.request_body_for_auto(WireProtocol::Chat, &request);
    assert!(
        body.get("reasoning_effort").is_none(),
        "None 不携带思考参数"
    );

    let anthropic = call_for(
        "https://api.anthropic.com",
        "claude-sonnet-4",
        Endpoint::ChatCompletions,
    );
    let body2 = anthropic.request_body_for_auto(WireProtocol::Anthropic, &request);
    assert!(
        body2.get("thinking").is_none(),
        "anthropic 轨 None 不注入 thinking"
    );
}

// ── 验收 4：INV-07 连续 assistant 交替投影 ───────────────────────

/// 连续 assistant（[user, assistant, assistant]）→ 两条 assistant 之间插入
/// user 占位，无相邻 assistant（push_alternating 生效）
#[test]
fn inv07_consecutive_assistant_inserts_user_placeholder() {
    let call = call_for(
        "https://api.anthropic.com",
        "claude-sonnet-4",
        Endpoint::ChatCompletions,
    );
    let messages = vec![
        user_msg("提问"),
        assistant_msg("第一段"),
        assistant_msg("第二段"),
    ];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for_auto(WireProtocol::Anthropic, &request);
    let wire = body["messages"]
        .as_array()
        .expect("anthropic 轨 messages 必须为数组");

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
    assert_eq!(wire[2]["role"], "user", "占位消息必须是 user 角色");
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
    let call = call_for(
        "https://api.anthropic.com",
        "claude-sonnet-4",
        Endpoint::ChatCompletions,
    );
    let messages = vec![user_msg("提问"), assistant_msg("回答")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for_auto(WireProtocol::Anthropic, &request);
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

/// 请求头（chat 轨）：yaml `providers.*.headers` 声明的头随请求发出；
/// 无条件全局 DeepSeek 头已删除（M16，plans/04 §2.4）。
#[test]
fn session_head_injected_when_session_id_present() {
    let _fixture = install_live_fixture();
    let messages = vec![user_msg("你好")];

    // acme 声明 x-acme-affinity → 随请求发出（session_id 非空）
    let call = HttpProviderCall::new(reqwest::Client::new(), live_config("acme", "acme-think"));
    let request = request_with_session(&messages, Some("ses-123"));
    let headers = call.request_headers_for_auto(WireProtocol::Chat, &request);
    assert!(
        headers
            .iter()
            .any(|(name, value)| name == "x-acme-affinity" && value == "acme-1"),
        "yaml 声明的亲和头应注入：{headers:?}"
    );
    assert!(
        !headers
            .iter()
            .any(|(name, _)| name == "x-deepseek-harness-session-id"),
        "不得无条件注入 x-deepseek-harness-session-id（M16）：{headers:?}"
    );

    // 未声明供应商（deepseek）→ 零 x-* 追加头（无声明不发）
    let call = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4-flash"),
    );
    let headers = call.request_headers_for_auto(
        WireProtocol::Chat,
        &request_with_session(&messages, Some("ses-123")),
    );
    assert!(
        !headers.iter().any(|(name, _)| name.starts_with("x-")),
        "未声明供应商不得注入任何 x-* 头：{headers:?}"
    );
}

/// yaml 声明头与 Authorization 并存；无条件 DeepSeek 头绝不再出现。
#[test]
fn session_head_coexists_with_grok_affinity_header() {
    let _fixture = install_live_fixture();
    let call = HttpProviderCall::new(reqwest::Client::new(), live_config("acme", "acme-think"));
    let messages = vec![user_msg("你好")];
    let request = request_with_session(&messages, Some("ses-abc"));
    let headers = call.request_headers_for_auto(WireProtocol::Chat, &request);

    // yaml 声明的亲和头注入
    assert!(
        headers.iter().any(|(name, _)| name == "x-acme-affinity"),
        "yaml 声明头必须注入：{headers:?}"
    );
    // 全局 DeepSeek 头绝不再出现
    assert!(
        !headers
            .iter()
            .any(|(name, _)| name == "x-deepseek-harness-session-id"),
        "无条件 DeepSeek 头已删除（M16）：{headers:?}"
    );
    // Authorization 恒在
    assert!(headers.iter().any(|(name, _)| name == "Authorization"));
}

// ── 验收 T3.6：maxTokensField 消费接线（M3 / C5） ─────────────────

/// 会话亲和头与会话亲和头族不进入请求体（不破坏序列化契约）——
/// chat 轨请求体不含任何 x-* 会话头。
#[test]
fn session_heads_never_in_request_body() {
    let call = call_for(
        "https://api.example.com/v1",
        "gpt-5",
        Endpoint::ChatCompletions,
    );
    let messages = vec![user_msg("你好")];
    let request = request_with_session(&messages, Some("ses-123"));
    let body = call.request_body_for_auto(WireProtocol::Chat, &request);
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

/// 无 compat.maxTokensField 声明 → chat 请求体用 `max_tokens`（协议缺省，
/// plans/04 §1.2 #7；禁止 URL / o 系列启发式）。
#[test]
fn max_tokens_field_moonshot_uses_max_tokens() {
    let _fixture = install_live_fixture();
    // deepseek-v4-flash 无 maxTokensField 声明 → 缺省 max_tokens
    let call = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4-flash"),
    );
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for_auto(WireProtocol::Chat, &request);
    assert_eq!(body["max_tokens"], 1024, "缺省写 max_tokens：{body}");
    assert!(
        body.get("max_completion_tokens").is_none(),
        "缺省不得写 max_completion_tokens：{body}"
    );
}

/// yaml `compat.maxTokensField: max_completion_tokens` → chat 请求体用
/// `max_completion_tokens`（只信 yaml 声明，禁止 URL / 模型名猜）。
#[test]
fn max_tokens_field_openai_o_series_uses_max_completion_tokens() {
    let _fixture = install_live_fixture();
    let messages = vec![user_msg("你好")];

    // acme 声明 maxTokensField: max_completion_tokens → 写 max_completion_tokens
    let call = HttpProviderCall::new(reqwest::Client::new(), live_config("acme", "acme-think"));
    let body =
        call.request_body_for_auto(WireProtocol::Chat, &single_user_request(&messages, None));
    assert_eq!(
        body["max_completion_tokens"], 1024,
        "yaml 声明写 max_completion_tokens：{body}"
    );
    assert!(
        body.get("max_tokens").is_none(),
        "yaml 声明后不得写 max_tokens：{body}"
    );

    // 未命中模型 / 无 provider_id → 缺省 max_tokens（fail-closed）
    let unknown = call_for(
        "https://api.openai.com/v1",
        "o4-mini",
        Endpoint::ChatCompletions,
    );
    let body2 =
        unknown.request_body_for_auto(WireProtocol::Chat, &single_user_request(&messages, None));
    assert_eq!(
        body2["max_tokens"], 1024,
        "无 yaml 声明写 max_tokens（禁止 o 系列猜）：{body2}"
    );
}

/// 默认 openai-compatible → chat 请求体用 `max_tokens`（字节兼容）。
#[test]
fn max_tokens_field_default_uses_max_tokens() {
    let call = call_for(
        "https://api.deepseek.com/v1",
        "deepseek-v4-flash",
        Endpoint::ChatCompletions,
    );
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, None);
    let body = call.request_body_for_auto(WireProtocol::Chat, &request);
    assert_eq!(
        body["max_tokens"], 1024,
        "默认 openai-compatible 写 max_tokens：{body}"
    );
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
    match to_loop_event(wire).expect("Stop 事件应转换为 Some") {
        ProviderStreamEvent::Stop {
            reason,
            error_kind,
            error,
            ..
        } => {
            assert_eq!(reason, LoopStopReason::Error);
            assert_eq!(
                error_kind,
                Some(ProviderErrorKind::RateLimit),
                "error_kind 应透传"
            );
            assert_eq!(error.as_deref(), Some("provider 过载"));
        }
        other => panic!("期望 Stop，得到 {other:?}"),
    }
}

/// 生命周期观测事件（BeforeRequest / AfterResponse）→ `to_loop_event` 必须返回
/// `None`（静默跳过，与 agent-provider `consume/mod.rs` 消费语义对齐），严禁 panic。
/// 历史教训：此处曾对观测事件写 `unreachable!`——观测事件与流事件同枚举且可 serde
/// 往返，任何未来接线都会引爆整条流任务。此测试锁定拆雷语义，防回潮。
#[test]
fn lifecycle_observer_events_are_skipped_not_panic() {
    let before = WireEvent::BeforeRequest {
        info: agent_provider::events::ModelRequestInfo {
            url: Some("https://api.example.com/v1/chat/completions".into()),
            model: Some("deepseek-v4".into()),
            max_tokens: Some(4096),
            attempt: 1,
        },
    };
    let after = WireEvent::AfterResponse {
        info: agent_provider::events::ModelResponseInfo {
            status: Some(200),
            ok: true,
            error: None,
            duration_ms: 812,
            usage: None,
        },
    };
    assert!(
        to_loop_event(before).is_none(),
        "BeforeRequest 观测事件应被跳过而非 panic"
    );
    assert!(
        to_loop_event(after).is_none(),
        "AfterResponse 观测事件应被跳过而非 panic"
    );
}

// ── 战役 I4 · R5 B-1：请求面思考档位拒绝接线（网络 I/O 前）──────────

/// 请求面校验白名单 = live yaml thinking 字典 TitleCase 键（plans/04 §1.4）：
/// deepseek-v4-flash 夹具提供 High/Low/Max → 合法档位放行，medium 越白名单拒绝。
#[test]
fn describe_model_whitelist_for_deepseek_v4_flash_is_narrow() {
    let _fixture = install_live_fixture();
    let call = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4-flash"),
    );
    let profile = protocol::catalog_request_profile(&call.config);
    assert!(profile.supports_reasoning, "夹具字典非空 → 支持 reasoning");
    assert_eq!(
        profile
            .thinking_map
            .as_ref()
            .map(|m| m.keys().cloned().collect::<Vec<_>>()),
        Some(vec![
            "High".to_string(),
            "Low".to_string(),
            "Max".to_string()
        ])
    );

    // 合法档位放行；越白名单档位（medium）拒绝。
    assert!(
        thinking::validate_reasoning_effort(&profile, Some(LoopEffort::High)).is_ok(),
        "high 在字典白名单应放行"
    );
    assert!(
        thinking::validate_reasoning_effort(&profile, Some(LoopEffort::Low)).is_ok(),
        "low 在字典白名单应放行"
    );
    let rejected = thinking::validate_reasoning_effort(&profile, Some(LoopEffort::Medium));
    match rejected {
        Err(err) => {
            assert_eq!(
                err.kind,
                ProviderErrorKind::InvalidRequest,
                "越白名单 → 分类错误"
            );
            assert!(
                err.message.contains("UNSUPPORTED_REASONING_EFFORT"),
                "文案携带语义标签：{}",
                err.message
            );
            // W9-F-3：拒绝文案必须列出该模型可用档位集合（归一规范拼写，词表序）。
            assert!(
                err.message.contains("Low / High / Max"),
                "文案必须列出可用档位集合（词表序 Low / High / Max）：{}",
                err.message
            );
        }
        Ok(()) => panic!("medium 不在字典白名单，应拒绝"),
    }
}

/// 显式档位超出 yaml 字典白名单 → `stream()` 返回流前 `Err`（分类错误），
/// **HTTP 请求未发出**（base_url 指向必然连接失败的端口；若校验未提前 return，
/// 此处会得到 reqwest 连接错误而非我们的 InvalidRequest）。
#[tokio::test]
async fn out_of_whitelist_effort_rejected_before_http() {
    let _fixture = install_live_fixture();
    // 夹具字典 High/Low/Max + 越档 medium + 死端口 URL：
    // 错误必须在请求发送前由拒绝校验返回，证明网络 I/O 未发生。
    let config = EngineProviderConfig {
        base_url: "http://127.0.0.1:1".to_string(),
        api_key: "k-test".to_string(),
        model: "deepseek-v4-flash".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        provider_id: Some("deepseek".to_string()),
        ..Default::default()
    };
    let call = HttpProviderCall::new(reqwest::Client::new(), config);
    let messages = vec![user_msg("你好")];
    let request = single_user_request(&messages, Some(LoopEffort::Medium));

    let err = match call.stream(&request).await {
        Ok(_) => panic!("越白名单显式档位必须在流前被拒绝"),
        Err(err) => err,
    };
    assert_eq!(
        err.kind,
        ProviderErrorKind::InvalidRequest,
        "拒绝应为分类错误（且是校验返回而非 HTTP 连接错误）：{err:?}"
    );
    assert!(
        err.message.contains("UNSUPPORTED_REASONING_EFFORT"),
        "拒绝文案携带语义标签：{}",
        err.message
    );
}

/// 省略思考档位（None）→ `stream()` 不拒绝、正常发起；请求体不携带思考参数
/// （省略即不发送，保留提供方默认）。
#[test]
fn omitted_effort_passes_validation_and_omits_thinking_param() {
    let _fixture = install_live_fixture();
    let call = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4-flash"),
    );
    let profile = protocol::catalog_request_profile(&call.config);
    // 校验面：省略（None）→ Ok（放行到构建/HTTP，不发送思考参数）。
    assert!(
        thinking::validate_reasoning_effort(&profile, None).is_ok(),
        "省略档位不应被拒绝"
    );
    // 请求体：None → 不写入 reasoning_effort（省略即不发送思考参数）。
    let messages = vec![user_msg("你好")];
    let body =
        call.request_body_for_auto(WireProtocol::Chat, &single_user_request(&messages, None));
    assert!(
        body.get("reasoning_effort").is_none(),
        "省略档位不应发送思考参数：{body}"
    );
}

/// 合法显式档位 → 校验放行，请求体写入对应思考参数（白名单内直发不降级）。
#[test]
fn in_whitelist_effort_passes_and_emits_reasoning_param() {
    let _fixture = install_live_fixture();
    let call = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-v4-flash"),
    );
    let profile = protocol::catalog_request_profile(&call.config);
    // 校验面：high 在 yaml 字典白名单 → 放行。
    assert!(
        thinking::validate_reasoning_effort(&profile, Some(LoopEffort::High)).is_ok(),
        "字典白名单内档位应放行"
    );
    // 请求体：high → reasoning_effort:"high"（字典值直发，不降级）。
    let messages = vec![user_msg("你好")];
    let body = call.request_body_for_auto(
        WireProtocol::Chat,
        &single_user_request(&messages, Some(LoopEffort::High)),
    );
    assert_eq!(
        body["reasoning_effort"], "high",
        "字典内 high 档应写入 reasoning_effort：{body}"
    );
}
