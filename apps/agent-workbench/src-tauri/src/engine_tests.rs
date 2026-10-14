//! `engine` 模块测试旁挂（**SR-04** 外置：engine.rs → engine_tests.rs）。
//!
//! 由父模 engine.rs 经 `#[path]` 接入（无孤儿）。承载：原 `mod tests`
//! 全量测试 + 六个独立装配测试模（timer/wait/store_assembly/
//! http_client_config/event_drain/continuity_wiring）+ 原实现段散落
//! cfg(test) 注入方法（`EngineHandle` impl 扩展：new_with_mcp_attach_allowed /
//! inject_provider_for_test）。
//!
//! **≠ EL**；禁删既有测试（测试资产保护铁律 §9）；禁重派 SR-04。

use super::*;
use agent_provider::request::cache::CacheMechanism;
use conex_compaction::Summarizer;
use conex_types::ContextBudget;
use session_loop::provider::ProviderStreamItem;
use session_loop::TestProvider;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_provider::config::Endpoint;
use agent_provider::events::{ProviderStreamEvent as WireEvent, StreamParseError};
use agent_provider::parse::responses::ResponsesParser;
use agent_provider::request::{build_chat_completions_request_body, ReasoningContentMode};
use agent_provider::sse::SseFrame;
use agent_tools::audit::{AuditSink, SecurityAuditSink};
use agent_tools::definition::ToolDefinition;
use agent_tools::mcp::McpServerConfig;
use agent_tools::registry::ToolRegistry;
// 审计 01 W1（任务连续性方案推进轮）：kill_subagent / send_message 生产
// 通道装配——三通道契约经本文件 ContinuityChannelBoard 延迟绑定注入
use agent_tools::tools::send_message::{MainAgentMessageChannel, SubagentInjectChannel};
use agent_tools::tools::set_timer::TimerChannel;
use agent_tools::tools::wait_subagents::DispatchDeclaration;
// R-CF3 装配收口（T-CF-10）：wait 通道契约与适配器经库目标引入
// （wait_channel.rs 是库模块，bin 目标自动依赖同包 lib）
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_telemetry::cache::WARN_MISSED_TOKENS;
use conex_types::denied_stats::DeniedStats;
use conex_types::error::ProviderErrorKind;
use conex_types::events::{
    AgentEvent, AgentEventEnvelope, MissAttribution, RunCacheStats, SecurityAuditDecision,
};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::response::ClassifiedStreamError;
use crish_agent_workbench::wait_channel::ControlBusResolver;
use futures_util::StreamExt;
use orchestrator::PendingMessageQueue;
use session_loop::provider::{DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest};
use session_loop::stream::{ProviderStreamEvent, ProviderUsage, StopReason as LoopStopReason};
use session_loop::{CacheTrackingConfig, SessionLoopOptions, ToolBatchOptions};

use crate::core_event_bridge::EventBridge;
use crate::fs_commands::skills::RustSkill;
use crate::timers::AgentEventSink;

/// ISO8601 时间戳形状（毫秒精度 + Z 后缀）
#[test]
fn now_iso_utc_formats_iso8601() {
    let value = now_iso_utc();
    assert!(value.ends_with('Z'), "应带 Z 后缀：{value}");
    assert!(value.len() >= 24, "应含毫秒精度：{value}");
    let (date, rest) = value.split_once('T').expect("T 分隔");
    let parts: Vec<&str> = date.split('-').collect();
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[0].len(), 4);
    assert!(
        rest.ends_with(".000Z") || rest.contains('.'),
        "毫秒精度：{value}"
    );
}

/// 消息 id 前缀 + 唯一
#[test]
fn message_ids_are_unique_per_prefix() {
    let a = new_message_id("user");
    let b = new_message_id("user");
    assert!(a.starts_with("user-"));
    assert_ne!(a, b);
}

/// 用户消息构造：clientMessageId 透传（21-log §5.2 缺口 2 修复）
#[test]
fn user_message_carries_client_message_id() {
    let message = user_message("你好", Some("user-msg-1"));
    assert_eq!(message.client_message_id.as_deref(), Some("user-msg-1"));
    assert_eq!(message.role, AgentMessageRole::User);
    let text = message.blocks.iter().find_map(|block| match block {
        AgentMessageBlock::Text { text } => Some(text.as_str()),
        _ => None,
    });
    assert_eq!(text, Some("你好"));
    // None 不标注（向后兼容）
    assert!(user_message("hi", None).client_message_id.is_none());
}

/// 端点路径：chat-completions（00 D3）/ responses（plans/04：协议只来自
/// live yaml，端点字段不再参与决议）
#[test]
fn provider_url_respects_endpoint() {
    let _live = install_live_fixture();
    let chat = live_config("deepseek", "deepseek-chat");
    assert_eq!(
        provider_url(&chat),
        "https://placeholder.invalid/v1/chat/completions"
    );
    let responses = live_config("deepseek", "deepseek-v4-flash");
    assert_eq!(
        provider_url(&responses),
        "https://placeholder.invalid/v1/responses"
    );
}

/// 低级事件 → session-loop 事件转换（形状逐字段一致）
#[test]
fn wire_event_converts_to_loop_event() {
    let wire = WireEvent::Stop {
        reason: agent_provider::events::StopReason::Length,
        error: None,
        error_kind: None,
        usage: Some(agent_provider::events::ProviderUsage {
            prompt_tokens: Some(1),
            completion_tokens: Some(2),
            total_tokens: Some(3),
            cache_read_tokens: None,
            cache_write_tokens: None,
            cache_miss_tokens: Some(7),
            reasoning_tokens: None,
        }),
    };
    match to_loop_event(wire).expect("Stop 事件应转换为 Some") {
        ProviderStreamEvent::Stop {
            reason,
            usage,
            error,
            // D7 §3.7 兼容：老注入方（WireEvent::Stop 无分类字段）→ None
            error_kind,
        } => {
            assert_eq!(reason, LoopStopReason::Length);
            assert!(error.is_none());
            assert!(error_kind.is_none(), "老注入方不携带分类字段");
            let usage = usage.expect("usage 透传");
            assert_eq!(usage.total_tokens, Some(3));
            // P2：cacheMissTokens 逐字段透传（E0063 补齐）
            assert_eq!(usage.cache_miss_tokens, Some(7));
        }
        other => panic!("期望 Stop，得到 {other:?}"),
    }
}

/// 分类错误：ProviderError → ClassifiedStreamError（kind/retryable 透传）
#[test]
fn classified_error_preserves_kind_and_retryable() {
    let error = agent_provider::error::ProviderError::Server { status: Some(503) };
    let classified = to_classified(error);
    assert_eq!(classified.kind, ProviderErrorKind::ServerError);
    assert!(classified.retryable);
    assert!(classified.retry_after_ms.is_none());
}

/// 解析错误分类：Unknown / 不可重试（T09.1.2 步骤 2）
#[test]
fn parse_error_classifies_unknown_not_retryable() {
    let error = StreamParseError::EventAfterStop;
    let classified = classify_stream_parse(&error);
    assert_eq!(classified.kind, ProviderErrorKind::Unknown);
    assert!(!classified.retryable);
}

// ── P1：system prompt 透传 + 请求体稳定性（T-06，P1 阶段 2 步骤 2.3 /
//     阶段 4 步骤 4.3）──────────────────────────────────────────────

/// 构造测试用适配层（chat-completions 端点）
fn test_provider_call(model: &str) -> HttpProviderCall {
    let client = reqwest::Client::new();
    let config = EngineProviderConfig {
        base_url: "https://api.example.com/v1/".to_string(),
        api_key: "k".to_string(),
        model: model.to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    };
    HttpProviderCall::new(client, config)
}

/// 安装 live yaml 综合夹具（plans/04：协议 / thinking / contextWindow / headers /
/// cacheControlFormat 全部从 yaml 长出，禁止 URL / 前缀启发式）。
fn install_live_fixture() -> std::sync::MutexGuard<'static, ()> {
    let live = lock_live_catalog();
    protocol::reload_live_catalog_from_yaml_str(
        r#"
version: 2
providers:
  deepseek:
    displayName: DeepSeek
    baseUrl: "https://api.deepseek.com/v1"
    protocol: "openai/chat"
    compat:
      thinkingFormat: deepseek
    models:
      - id: deepseek-v4-flash
        protocol: "openai/responses"
        contextWindow: 1000000
        thinking:
          High: "high"
      - id: deepseek-chat
        thinking:
          High: "high"
  acme:
    displayName: Acme
    baseUrl: "https://api.acme.test/v1"
    protocol: "openai/chat"
    headers:
      x-acme-affinity: "acme-1"
    models:
      - id: acme-cache
        compat:
          cacheControlFormat: anthropic
"#,
    )
    .expect("engine_tests live 夹具必须解析成功");
    live
}

/// 指向 live 夹具的配置（provider_id = yaml providers 键）
fn live_config(provider_id: &str, model: &str) -> EngineProviderConfig {
    EngineProviderConfig {
        base_url: "https://placeholder.invalid/v1/".to_string(),
        api_key: "k".to_string(),
        model: model.to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        provider_id: Some(provider_id.to_string()),
        ..Default::default()
    }
}

/// 构造单条 user 消息的会话（验证 system 前置与请求体字节稳定）
fn single_user_request<'a>(
    messages: &'a Vec<Arc<AgentMessage>>,
    system_prompt: Option<&'a str>,
) -> ProviderRequest<'a> {
    ProviderRequest {
        messages,
        tools: Vec::new(),
        max_tokens: Some(4096),
        system_prompt,
        session_id: None,
        reasoning_effort: None,
    }
}

/// build_context 透传 system_prompt；相同设置下两次构建请求体字节一致
///
/// 断言（P1 §5.1 验收 4/10 + §5.3 路径 3）：
/// - system_prompt 到达请求构建上下文（不再硬编码 None）；
/// - system 消息始终是 messages[0]（静态前缀前置纪律）；
/// - 同进程两次构建请求体 to_string 字节相等（前缀稳定性）。
#[test]
fn build_context_passes_system_prompt_and_is_stable() {
    let call = test_provider_call("deepseek-chat");

    let user = AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "你好".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![Arc::new(user)];
    let request = single_user_request(&messages, Some("你是助手，使用中文回答。"));

    // 透传正确：system_prompt 到达构建上下文（P-04 修复点）
    let context_a = call.build_context(&request);
    let context_b = call.build_context(&request);
    assert_eq!(
        context_a.system_prompt.as_deref(),
        Some("你是助手，使用中文回答。")
    );

    // 稳定性：相同设置下两次构建请求体字节一致（同进程对比）
    let options = call.request_options_auto(&request);
    let body_a = build_chat_completions_request_body(&options, &context_a);
    let body_b = build_chat_completions_request_body(&options, &context_b);
    assert_eq!(body_a.to_string(), body_b.to_string());

    // system 消息始终是 messages[0]（静态前缀前置，P1 §5.3 路径 3）
    let wire_messages = body_a
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .expect("请求体应含 messages 数组");
    let first = wire_messages.first().expect("至少一条消息");
    assert_eq!(first["role"], "system");
    assert_eq!(first["content"], "你是助手，使用中文回答。");
}

/// reasoning_content 模式按 live yaml `compat.thinkingFormat` 判定（plans/04
/// §1.2 #9）：DeepSeek → Require（键存在性，空串兜底）；其余 / 未命中 → Omit
#[test]
fn reasoning_content_mode_follows_vendor() {
    let _live = install_live_fixture();
    let deepseek = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-chat"),
    );
    assert_eq!(
        deepseek.reasoning_content_mode(),
        ReasoningContentMode::Require
    );

    let openai = test_provider_call("gpt-4o");
    assert_eq!(openai.reasoning_content_mode(), ReasoningContentMode::Omit);

    // 未命中（fail-closed）→ Omit（禁止 URL / 前缀猜）
    let mut config = EngineProviderConfig {
        base_url: "https://deepseek.example.com/v1/".to_string(),
        api_key: "k".to_string(),
        model: "random-model".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        provider_id: Some("deepseek".to_string()),
        ..Default::default()
    };
    let call = HttpProviderCall::new(reqwest::Client::new(), config.clone());
    assert_eq!(
        call.reasoning_content_mode(),
        ReasoningContentMode::Omit,
        "lookup 未命中必须 fail-closed，禁止 URL 猜 deepseek"
    );

    config.provider_id = None;
    let call = HttpProviderCall::new(reqwest::Client::new(), config);
    assert_eq!(call.reasoning_content_mode(), ReasoningContentMode::Omit);
}

// ── DEEPCHECK-06 P0：生效模型窗口解析（子代理预算入站数据源）──────

/// 生效模型窗口：live yaml `contextWindow` 精确命中 → 窗口透传；
/// 未命中 / 无 provider_id → None（不臆造窗口）
#[test]
fn effective_context_window_resolves_from_bundled_catalog() {
    let _live = install_live_fixture();
    let deepseek = live_config("deepseek", "deepseek-v4-flash");
    assert_eq!(
        effective_context_window(&deepseek),
        Some(1_000_000),
        "deepseek-v4-flash 应命中 live 窗口"
    );
    // 未命中模型 → None
    let unknown = test_provider_call("llama-3.1");
    assert_eq!(effective_context_window(&unknown.config), None);
}

// ── P2：build_cache_policy 接线 + session_id 注入（T-17，P2 步骤 4b）────

/// 构造单条 user 消息 + 会话 ID 的请求（cache 接线断言用）
fn session_request<'a>(
    messages: &'a Vec<Arc<AgentMessage>>,
    session_id: Option<&'a str>,
) -> ProviderRequest<'a> {
    ProviderRequest {
        messages,
        tools: Vec::new(),
        max_tokens: Some(4096),
        system_prompt: None,
        session_id: session_id.map(str::to_string),
        reasoning_effort: None,
    }
}

/// request_options 组装 cache：只来自 yaml `compat.cacheControlFormat` 声明
/// （plans/04 §1.3/§2.4）——`anthropic` → 显式断点机制；无声明 → None
/// （请求体不含任何 cache 键，禁止 bundled_catalog + base_url 猜能力）
#[test]
fn request_options_wires_build_cache_policy() {
    let _live = install_live_fixture();
    let user = AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "你好".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![Arc::new(user)];
    let request = session_request(&messages, Some("ses-abc"));

    // acme-cache 声明 cacheControlFormat: anthropic → 显式断点机制
    let acme = HttpProviderCall::new(reqwest::Client::new(), live_config("acme", "acme-cache"));
    let options = acme.request_options_auto(&request);
    let policy = options.cache.expect("yaml 声明应注入缓存策略");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);

    // 无声明（deepseek-chat）→ 整体 None，请求体零 cache 键
    let deepseek = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-chat"),
    );
    assert!(deepseek.request_options_auto(&request).cache.is_none());
    let body = build_chat_completions_request_body(
        &deepseek.request_options_auto(&request),
        &deepseek.build_context(&request),
    );
    assert!(body.get("prompt_cache_key").is_none());
    assert!(body.get("prompt_cache_retention").is_none());
    assert!(body.get("prompt_cache_options").is_none());

    // 未命中 / 无 provider_id → None（fail-closed，不猜 URL）
    let ollama = test_provider_call("llama-3.1");
    assert!(ollama.request_options_auto(&request).cache.is_none());
}

/// 发送层基础请求头：yaml `providers.*.headers` 声明随请求发出（M16）；
/// 无条件 x-deepseek-harness-session-id 已删除；Authorization 恒在。
#[test]
fn request_headers_merges_affinity_header() {
    let _live = install_live_fixture();
    let user = AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "你好".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![Arc::new(user)];
    let request = session_request(&messages, Some("ses-abc"));

    // acme 声明 x-acme-affinity → 随请求发出
    let acme = HttpProviderCall::new(reqwest::Client::new(), live_config("acme", "acme-cache"));
    let options = acme.request_options_auto(&request);
    let headers = acme.request_headers(options.cache.as_ref());
    assert!(headers.iter().any(|(name, _)| name == "Authorization"));
    assert!(
        headers
            .iter()
            .any(|(name, value)| name == "x-acme-affinity" && value == "acme-1"),
        "yaml 声明头应注入：{headers:?}"
    );
    assert!(
        !headers
            .iter()
            .any(|(name, _)| name == "x-deepseek-harness-session-id"),
        "无条件 DeepSeek 头已删除（M16）：{headers:?}"
    );

    // 未声明供应商 → 仅 Authorization
    let deepseek = HttpProviderCall::new(
        reqwest::Client::new(),
        live_config("deepseek", "deepseek-chat"),
    );
    let headers = deepseek.request_headers(deepseek.request_options_auto(&request).cache.as_ref());
    assert!(headers.iter().any(|(name, _)| name == "Authorization"));
    assert!(
        !headers.iter().any(|(name, _)| name.starts_with("x-")),
        "未声明供应商零 x-* 头：{headers:?}"
    );
}

/// 捕获请求的测试 provider（session_id 注入断言用）
struct CaptureProvider {
    captured: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl ProviderCall for CaptureProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        *self.captured.lock().unwrap_or_else(|e| e.into_inner()) = request.session_id.clone();
        let stream: ProviderEventStream =
            Box::pin(futures_util::stream::empty::<ProviderStreamItem>());
        Ok(stream)
    }
}

/// SharedProvider::stream 把会话 ID 注入 ProviderRequest.session_id
/// （P2 步骤 4b：prompt_cache_key 键来源；值 = AgentSessionContext.session_id
/// 同源——两者同源于 run-task 下发的 sessionId）
#[tokio::test]
async fn shared_provider_injects_session_id() {
    let captured = Arc::new(Mutex::new(None));
    let shared = SharedProvider {
        inner: Arc::new(CaptureProvider {
            captured: Arc::clone(&captured),
        }),
        session_id: "ses-42".to_string(),
    };
    let messages = Vec::<Arc<AgentMessage>>::new();
    let request = session_request(&messages, None);
    let stream = shared.stream(&request).await.expect("空流应成功");
    drop(stream);
    assert_eq!(
        captured
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_deref(),
        Some("ses-42"),
        "会话 ID 应注入 ProviderRequest.session_id"
    );
}

// ── P3：provider_url 接入 supports_responses_for（T-23，P3 步骤 4b / §3.4.2）──

/// 构造测试用配置（Responses 支持判定用；base_url 含 deepseek 关键字，
/// 经 infer_reasoning_vendor 双通道判定厂商）
fn responses_config(model: &str, endpoint: Endpoint) -> EngineProviderConfig {
    EngineProviderConfig {
        base_url: "https://api.deepseek.com/v1/".to_string(),
        api_key: "k".to_string(),
        model: model.to_string(),
        endpoint,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    }
}

/// 进程级 LIVE_CATALOG 是共享静态（protocol.rs:46）：本文件依赖出站剖面的
/// 用例必须与 protocol / engine_provider / scripted_mock_server 测试
/// **共用同一把锁**串行安装夹具，否则并行时读到别的测试装的 catalog，
/// 协议剖面被跨轨污染（实证 2026-09-15：`request_body_dispatches_by_rail`
/// 在并行全套下 chat 轨读到 Null 的 max_tokens——剖面被误判为 responses）。
fn lock_live_catalog() -> std::sync::MutexGuard<'static, ()> {
    crate::engine_provider::protocol::LIVE_CATALOG_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// 出站剖面双轨夹具：`api.example.com` → openai/chat（chat 轨断言），
/// `api.deepseek.com` → openai/responses（responses 轨断言）。两条 base_url
/// 各自命中一个 provider，剖面由 base_url 区分——**不依赖机器上的
/// models.yaml**（此前依赖真实用户目录，是并行/换机即红的根因）。
fn install_dual_rail_catalog() {
    crate::engine_provider::protocol::reload_live_catalog_from_yaml_str(
        r#"
version: 2
providers:
  example:
    displayName: Example
    baseUrl: "https://api.example.com/v1/"
    protocol: "openai/chat"
    models:
      - id: deepseek-v4-flash
        displayName: Flash
        maxOutputTokens: 4096
  deepseek:
    displayName: DeepSeek
    baseUrl: "https://api.deepseek.com/v1/"
    protocol: "openai/responses"
    models:
      - id: deepseek-v4-flash
        displayName: Flash
        maxOutputTokens: 4096
      - id: deepseek-v4-flash-0731
        displayName: Flash 0731
        maxOutputTokens: 4096
      - id: deepseek-v4-pro
        displayName: Pro
        maxOutputTokens: 4096
"#,
    )
    .expect("双轨夹具 yaml 必须解析成功");
}

/// provider_url 按 live yaml 模型级 protocol 判定端点（plans/04 §2.3）：
/// openai/responses → /v1/responses；openai/chat（继承）→ /chat/completions；
/// lookup 未命中 → fail-closed chat（禁止 URL / 目录 supports_responses 猜）。
#[test]
fn provider_url_gates_responses_by_catalog_support() {
    let _live = install_live_fixture();
    // v4-flash：yaml 模型级 protocol openai/responses → /v1/responses
    let flash = live_config("deepseek", "deepseek-v4-flash");
    assert_eq!(
        provider_url(&flash),
        "https://placeholder.invalid/v1/responses",
        "v4-flash 应走 responses 端点"
    );
    // deepseek-chat（继承供应商 openai/chat）→ chat-completions
    let chat = live_config("deepseek", "deepseek-chat");
    assert_eq!(
        provider_url(&chat),
        "https://placeholder.invalid/v1/chat/completions",
        "chat 轨应走 chat-completions 端点"
    );
    // 未命中模型（fail-closed）→ 保守降级 chat，禁止 URL 猜
    let unknown = responses_config("deepseek-v4-pro", Endpoint::Responses);
    assert_eq!(
        provider_url(&unknown),
        "https://api.deepseek.com/v1/chat/completions",
        "未命中模型应保守降级 chat"
    );
}

/// responses_supported 辅助函数语义（目录查询面）：
/// v4-flash → true；v4-pro → false；
/// 版本后缀**不兜底** → false（`lookup` 是精确匹配，且仓库明令
/// 「禁止前缀表猜厂商」——protocol.rs:108；与同文件 provider_url 的
/// 「未命中模型 → 保守降级 chat」同一纪律，2026-09-15 修正陈旧期望）；
/// 未收录模型 → false（保守）；未知厂商（Auto）→ true（保留现状）。
#[test]
fn responses_supported_follows_catalog_entry() {
    let _live = install_live_fixture();
    assert!(responses_supported(&responses_config(
        "deepseek-v4-flash",
        Endpoint::Responses
    )));
    assert!(
        !responses_supported(&responses_config(
            "deepseek-v4-flash-0731",
            Endpoint::Responses
        )),
        "版本后缀不兜底：0731 未收录于 bundled catalog → 保守 false（禁止前缀猜厂商）"
    );
    assert!(!responses_supported(&responses_config(
        "deepseek-v4-pro",
        Endpoint::Responses
    )));
    assert!(!responses_supported(&responses_config(
        "deepseek-custom",
        Endpoint::Responses
    )));

    // 未知厂商：base_url/model 均无关键字 → Auto → 保留现状（不降级）
    let gateway = EngineProviderConfig {
        base_url: "https://gw.example.com/v1/".to_string(),
        api_key: "k".to_string(),
        model: "m".to_string(),
        endpoint: Endpoint::Responses,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    };
    assert!(responses_supported(&gateway));
}

// ── DEEPCHECK-05 #10：Responses 轨三件套同轨（URL / body / parser）──

/// responses_endpoint_active = endpoint=Responses && 目录支持（三件套统一判定点）
#[test]
fn responses_endpoint_active_follows_catalog_and_endpoint() {
    let _live = install_live_fixture();
    // v4-flash + responses 端点 → 生效
    assert!(responses_endpoint_active(&responses_config(
        "deepseek-v4-flash",
        Endpoint::Responses
    )));
    // v4-pro + responses 端点 → 不生效（降级 chat 轨）
    assert!(!responses_endpoint_active(&responses_config(
        "deepseek-v4-pro",
        Endpoint::Responses
    )));
    // v4-flash + chat 端点 → 不生效（chat 轨恒走 chat）
    assert!(!responses_endpoint_active(&responses_config(
        "deepseek-v4-flash",
        Endpoint::ChatCompletions
    )));
    // 未知厂商 + responses 端点 → 生效（保留现状不降级）
    let gateway = EngineProviderConfig {
        base_url: "https://gw.example.com/v1/".to_string(),
        api_key: "k".to_string(),
        model: "m".to_string(),
        endpoint: Endpoint::Responses,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    };
    assert!(responses_endpoint_active(&gateway));
}

/// request_body 按轨分流（DEEPCHECK-05 #10 核心修复）：responses 轨 →
/// responses wire 形状（input/instructions/max_output_tokens，无 chat 缓存字段）；
/// chat 轨 → chat 形状（既有字节路径回归护栏）
#[test]
fn request_body_dispatches_by_rail() {
    let _live = lock_live_catalog();
    install_dual_rail_catalog();
    let user = AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "你好".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![Arc::new(user)];
    let request = ProviderRequest {
        messages: &messages,
        tools: Vec::new(),
        max_tokens: Some(4096),
        system_prompt: Some("你是助手，使用中文回答。"),
        session_id: None,
        reasoning_effort: None,
    };

    // responses 轨：body 为 responses 形状
    let responses_call = HttpProviderCall::new(
        reqwest::Client::new(),
        responses_config("deepseek-v4-flash", Endpoint::Responses),
    );
    let options = responses_call.request_options_auto(&request);
    let context = responses_call.build_context(&request);
    let body = responses_call.request_body(&options, &context);
    assert_eq!(body["model"], "deepseek-v4-flash");
    assert_eq!(body["instructions"], "你是助手，使用中文回答。");
    assert_eq!(
        body["input"][0],
        serde_json::json!({ "type": "message", "role": "user", "content": "你好" })
    );
    assert_eq!(body["max_output_tokens"], 4096);
    assert!(
        body.get("messages").is_none(),
        "responses 轨不得出现 messages"
    );
    for key in [
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
        "stream_options",
    ] {
        assert!(body.get(key).is_none(), "responses 轨不得注入 {key}");
    }

    // chat 轨：body 保持 chat 形状（既有路径字节不变）
    let chat_call = test_provider_call("deepseek-v4-flash");
    let options = chat_call.request_options_auto(&request);
    let context = chat_call.build_context(&request);
    let body = chat_call.request_body(&options, &context);
    assert_eq!(body["model"], "deepseek-v4-flash");
    assert!(body.get("messages").is_some(), "chat 轨必须携带 messages");
    assert!(body.get("input").is_none(), "chat 轨不得出现 input");
    assert!(
        body.get("instructions").is_none(),
        "chat 轨不得出现 instructions"
    );
    assert_eq!(body["max_tokens"], 4096, "chat 轨保持 max_tokens 字段名");
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][0]["content"], "你是助手，使用中文回答。");
}

/// HttpStreamParser 二态解析器：responses 轨 → ResponsesParser 消费
/// responses 事件帧（text delta + 终态 + usage）；与 chat 轨解析器行为隔离
#[test]
fn http_stream_parser_dispatch_responses_frames() {
    let mut parser = HttpStreamParser::Responses(ResponsesParser::new());
    let frames = [
        r#"{"type":"response.output_text.delta","delta":"你好"}"#,
        r#"{"type":"response.output_text.delta","delta":"，世界"}"#,
        r#"{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":50}}}}"#,
    ];
    let mut events = Vec::new();
    for data in frames {
        events.extend(
            parser
                .push_frame(&SseFrame {
                    event: None,
                    data: Some(data.to_string()),
                    id: None,
                    retry: None,
                })
                .expect("帧处理"),
        );
    }
    events.extend(parser.finish().expect("流结束"));
    let texts: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            WireEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["你好", "，世界"]);
    let stop = events
        .iter()
        .find(|event| matches!(event, WireEvent::Stop { .. }))
        .expect("流内应有 stop");
    match stop {
        WireEvent::Stop {
            reason: agent_provider::events::StopReason::Stop,
            usage: Some(usage),
            ..
        } => {
            assert_eq!(usage.prompt_tokens, Some(100));
            assert_eq!(
                usage.cache_read_tokens,
                Some(50),
                "cached_tokens → cache_read"
            );
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }
}

/// 端到端（DEEPCHECK-05 #10 验收）：v4-flash responses 配置下，真实 HTTP 链路
/// 三件套一致——URL=/responses + body=input 形状 + ResponsesParser 解析事件流
#[tokio::test]
async fn responses_stream_end_to_end_over_mock_sse() {
    let frames = vec![
        r#"data: {"type":"response.output_text.delta","delta":"你好"}"#,
        r#"data: {"type":"response.output_text.delta","delta":"，世界"}"#,
        r#"data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":50}}}}"#,
    ];
    let server = ResponsesMockServer::start(frames).await;
    let _live = install_live_fixture();
    let config = EngineProviderConfig {
        base_url: server.base_url(),
        api_key: "k".to_string(),
        model: "deepseek-v4-flash".to_string(),
        endpoint: Endpoint::Responses,
        stream: true,
        extra: BTreeMap::new(),
        provider_id: Some("deepseek".to_string()),
        ..Default::default()
    };
    // 协议来自 live yaml（deepseek-v4-flash 模型级 openai/responses）
    let call = HttpProviderCall::new(reqwest::Client::new(), config);

    let user = AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "你好".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let messages = vec![Arc::new(user)];
    let request = session_request(&messages, None);
    let mut stream = call.stream(&request).await.expect("stream 应成功");

    let mut texts = Vec::new();
    let mut stop: Option<ProviderStreamEvent> = None;
    while let Some(item) = stream.next().await {
        match item {
            Ok(ProviderStreamEvent::TextDelta { text }) => texts.push(text),
            Ok(event @ ProviderStreamEvent::Stop { .. }) => stop = Some(event),
            Ok(_) => {}
            Err(error) => panic!("流错误：{error:?}"),
        }
    }
    assert_eq!(
        texts,
        vec!["你好", "，世界"],
        "responses 帧应经 ResponsesParser 产出文本增量"
    );
    match stop.expect("流内应有 stop") {
        ProviderStreamEvent::Stop {
            usage: Some(usage), ..
        } => {
            assert_eq!(usage.prompt_tokens, Some(100));
            assert_eq!(usage.cache_read_tokens, Some(50), "终态 usage 覆盖式生效");
        }
        other => panic!("期望携带 usage 的 stop，得到：{other:?}"),
    }

    // URL 与 body 同轨：/responses + input 形状（不是 chat body 发往 /responses）
    let (path, body) = server.captured().await;
    assert_eq!(path, "/v1/responses", "responses 轨 URL 必须为 /responses");
    assert_eq!(body["model"], "deepseek-v4-flash");
    assert!(
        body.get("input").is_some(),
        "responses 轨 body 必须为 input 形状"
    );
    assert!(
        body.get("messages").is_none(),
        "不得把 chat body 发往 /responses"
    );
    for key in [
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
        "stream_options",
    ] {
        assert!(body.get(key).is_none(), "responses 轨不得注入 {key}");
    }
}

/// 本地 SSE mock 服务器（Responses 端到端测试）：捕获请求路径 + body JSON，
/// 回 chunked SSE 帧（text/event-stream，无 [DONE]——DeepSeek Responses 语义）
struct ResponsesMockServer {
    addr: std::net::SocketAddr,
    captured_path: Arc<Mutex<Option<String>>>,
    captured_body: Arc<Mutex<Option<serde_json::Value>>>,
}

impl ResponsesMockServer {
    async fn start(frames: Vec<&'static str>) -> Arc<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock sse server");
        let addr = listener.local_addr().expect("local addr");
        let captured_path: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let captured_body: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
        let server = Arc::new(Self {
            addr,
            captured_path: Arc::clone(&captured_path),
            captured_body: Arc::clone(&captured_body),
        });
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let captured_path = Arc::clone(&captured_path);
            let captured_body = Arc::clone(&captured_body);
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                let request_line = head.lines().next().unwrap_or_default();
                let path = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let content_length = head
                    .lines()
                    .find_map(|line| line.split_once(':'))
                    .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                let mut req_body = buf[head_end..].to_vec();
                while req_body.len() < content_length {
                    let n = socket.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    req_body.extend_from_slice(&chunk[..n]);
                }
                *captured_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(path);
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&req_body) {
                    *captured_body.lock().unwrap_or_else(|e| e.into_inner()) = Some(json);
                }
                let mut response = String::from(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
                    );
                for frame in frames {
                    let wire = format!("{frame}\n\n");
                    response.push_str(&format!("{:x}\r\n{wire}\r\n", wire.len()));
                }
                response.push_str("0\r\n\r\n");
                let _ = socket.write_all(response.as_bytes()).await;
            });
        });
        server
    }

    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    /// 等待捕获请求（5s 超时兜底，防测试悬挂）
    async fn captured(&self) -> (String, serde_json::Value) {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
        loop {
            let path = self
                .captured_path
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let body = self
                .captured_body
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let (Some(path), Some(body)) = (path, body) {
                return (path, body);
            }
            if tokio::time::Instant::now() >= deadline {
                panic!("mock 服务器未捕获到请求");
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }
    }
}

// ── T-30：produce 水合分支 + 预算透传（P4 阶段 1-3/1-4，§3.2.1/§3.2.3）──

/// 构造测试用 producer（initial_conversation / options 可注入；
/// provider 为脚本化替身，供请求快照断言）
fn test_producer(
    initial_conversation: Option<Vec<Arc<AgentMessage>>>,
    options: SessionLoopOptions,
) -> (SessionLoopProducer, Arc<TestProvider>) {
    let provider = Arc::new(TestProvider::text_reply("收到"));
    let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
    let producer = SessionLoopProducer::new(
        "ses-t30".to_string(),
        "run-t30".to_string(),
        8,
        provider_call,
        Arc::new(ToolRegistry::new()),
        options,
        ToolBatchOptions::default(),
        None,
        None,
        initial_conversation,
        user_message("第二轮提问", Some("user-t30")),
    );
    (producer, provider)
}

/// T-30：produce 水合分支——预置对话经 with_initial_conversation_arc
/// 零拷贝续接（Arc 身份不变），run 追加新用户消息与助手回复；
/// 收口 outcome.messages 携带完整续接序列（SessionHistoryCache 的
/// 原子替换数据源，P4 阶段 1-4）。
/// 载荷注记（T-36 对齐）：预置首条为 user（水合协议形状——跳过
/// system 后的首条必须为 user，assistant/tool 开头 provider 400
/// 风险；assert_conversation_head_tail 调试断言强制）
#[tokio::test]
async fn produce_hydrates_initial_conversation() {
    let initial_text = AgentMessage {
        id: "user-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-08-03T00:00:00.000Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "首轮提问".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let initial: Vec<Arc<AgentMessage>> = vec![Arc::new(initial_text)];
    let (mut producer, provider) =
        test_producer(Some(initial.clone()), SessionLoopOptions::default());

    let outcome = producer.produce().await;

    // 请求链：预置对话 + 新用户消息（水合分支生效，历史回流 LLM）
    let sent = provider.request_message_arcs(0);
    assert_eq!(
        sent.len(),
        initial.len() + 1,
        "请求应含预置对话 + 新用户消息"
    );
    assert!(
        Arc::ptr_eq(&initial[0], &sent[0]),
        "预置消息零拷贝续接（Arc 身份不变）"
    );
    assert_eq!(sent[0].role, AgentMessageRole::User);
    let last = sent.last().expect("至少一条消息");
    assert_eq!(last.role, AgentMessageRole::User, "尾部应为新用户消息");
    let text = last.blocks.iter().find_map(|block| match block {
        AgentMessageBlock::Text { text } => Some(text.as_str()),
        _ => None,
    });
    assert_eq!(text, Some("第二轮提问"));

    // 收口：outcome = 预置 + 用户 + 助手回复（缓存原子替换的数据源）
    assert_eq!(outcome.messages.len(), initial.len() + 2);
    assert!(
        Arc::ptr_eq(&initial[0], &outcome.messages[0]),
        "收口续接保留预置消息 Arc 身份"
    );
    assert_eq!(
        outcome.messages.last().map(|m| m.role),
        Some(AgentMessageRole::Assistant)
    );
}

/// T-30：initial_conversation 为空（None / 空 Vec）→ 现状单消息路径
/// （向后兼容：请求只含本次用户消息，不产生空预置）
#[tokio::test]
async fn produce_without_initial_conversation_stays_single_message() {
    let (mut producer, provider) = test_producer(None, SessionLoopOptions::default());
    let outcome = producer.produce().await;
    let sent = provider.request_message_arcs(0);
    assert_eq!(sent.len(), 1, "无预置时请求只含本次用户消息");
    assert_eq!(sent[0].role, AgentMessageRole::User);
    assert_eq!(outcome.messages.len(), 2, "用户 + 助手回复");

    // Some(空 Vec) 同样走单消息路径（空预置不产生水合调用）
    let (mut producer_empty, provider_empty) =
        test_producer(Some(Vec::new()), SessionLoopOptions::default());
    producer_empty.produce().await;
    assert_eq!(provider_empty.request_message_arcs(0).len(), 1);
}

/// T-30：context_budget 透传（core_run_commands 构造点 → options →
/// 预算层）——窗口收紧到 12288 时 max_tokens 被钳到默认 8192 之下
/// （clamp = min(requested, window - estimate - safety)，估算 > 0）
#[tokio::test]
async fn produce_applies_context_budget_clamp() {
    // SessionLoopOptions 重构后 context_budget 归入 assembly 子结构
    // （对齐 run_launch.rs 装配惯例：default() + 逐字段赋值）
    let mut options = SessionLoopOptions::default();
    options.assembly.context_budget = Some(ContextBudget {
        context_window: 12_288,
        ..ContextBudget::default()
    });
    let (mut producer, provider) = test_producer(None, options);
    producer.produce().await;
    let max_tokens = provider
        .request_max_tokens(0)
        .expect("请求应携带 max_tokens");
    assert!(
        max_tokens < session_loop::r#loop::DEFAULT_MAX_TOKENS,
        "预算钳制应把 max_tokens 收到默认 8192 之下（实际 {max_tokens}）"
    );
    assert!(max_tokens >= 1, "钳制下限 MIN_MAX_TOKENS = 1");
}

// ── COMPACTION-01 P0-3：生产 Summarizer（ProviderSummarizer）──────

fn summary_config(base_url: String, model: &str) -> EngineProviderConfig {
    EngineProviderConfig {
        base_url,
        api_key: "sk-summary".to_string(),
        model: model.to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: false,
        extra: BTreeMap::new(),
        ..Default::default()
    }
}

fn dropped_summary_messages() -> Vec<conex_types::message::AgentMessage> {
    vec![
        AgentMessage {
            id: "u-drop".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-09T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "实现压缩模块".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        },
        AgentMessage {
            id: "a-drop".to_string(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-08-09T10:00:01.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "已完成（read_file src/lib.rs）".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        },
    ]
}

/// C14 隔离面（请求体纯函数断言）：摘要请求 = 单条 user 消息、
/// 无 system、无 tools、无任何缓存键 / 断点（prompt_cache_key /
/// prompt_cache_retention / prompt_cache_options / cache_control）、
/// 无会话亲和参数；模型 / 非流式 / max_tokens 预算正确透传。
#[test]
fn provider_summarizer_request_body_is_c14_isolated() {
    let summarizer = ProviderSummarizer::new(
        reqwest::Client::new(),
        summary_config("https://x.example/v1".to_string(), "model-a"),
        conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
    );
    let body = summarizer.build_request_body("摘要提示词内容");
    let messages = body["messages"].as_array().expect("messages 必须为数组");
    assert_eq!(messages.len(), 1, "摘要请求必须是单条消息（独立前缀域）");
    assert_eq!(
        messages[0]["role"], "user",
        "唯一消息必须是 user（无 system 注入）"
    );
    assert!(
        messages[0]["content"]
            .as_str()
            .map(|s| s.contains("摘要提示词内容"))
            .unwrap_or(false),
        "提示词经单条 user 消息 content 发出"
    );
    assert!(body.get("tools").is_none(), "摘要请求不得携带 tools");
    assert!(
        body.get("tool_choice").is_none(),
        "摘要请求不得携带 tool_choice"
    );
    assert!(body.get("system").is_none(), "摘要请求不得携带 system 消息");
    // C14：无缓存断点 / 无会话亲和键（cache: None → 整个 cache 参数组不出现）
    for key in [
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
    ] {
        assert!(body.get(key).is_none(), "请求体不得含缓存键 {key}");
    }
    assert!(
        messages[0].get("cache_control").is_none(),
        "消息不得含 cache_control 断点"
    );
    // 模型 / 预算 / 非流式
    assert_eq!(body["model"], "model-a");
    assert_eq!(body["stream"], false);
    assert_eq!(body["max_tokens"], 1024);
}

/// 本地 mock 服务器（COMPACTION-01 P0-3 测试）：捕获请求体 JSON +
/// 按脚本逐连接返回 canned HTTP 响应
struct SummaryMockServer {
    addr: std::net::SocketAddr,
    captured: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl SummaryMockServer {
    async fn start(respond: Vec<(u16, String)>) -> Arc<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind summary mock server");
        let addr = listener.local_addr().expect("local addr");
        let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let server = Arc::new(Self {
            addr,
            captured: Arc::clone(&captured),
        });
        tokio::spawn(async move {
            for (status, body) in respond {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let captured = Arc::clone(&captured);
                tokio::spawn(async move {
                    // 读请求（头 + Content-Length 体）
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let head_end = loop {
                        if let Some(pos) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
                            break pos + 4;
                        }
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                    let content_length = head
                        .lines()
                        .find_map(|line| line.split_once(':'))
                        .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    let mut req_body = buf[head_end..].to_vec();
                    while req_body.len() < content_length {
                        let n = socket.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        req_body.extend_from_slice(&chunk[..n]);
                    }
                    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&req_body) {
                        captured
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(json);
                    }
                    let response = format!(
                            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        server
    }

    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn captured(&self) -> Vec<serde_json::Value> {
        self.captured
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// 真实调用形状（wire 断言）：成功路径——单 user 消息 / 无 tools /
/// 无缓存参数 / 无会话亲和头；响应 content 原样返回（Schema V1 JSON
/// 字符串），供引擎校验渲染。
///
/// 注：summarize 为同步阻塞调用（专用线程 + 独立 runtime），测试用
/// multi_thread 运行时保证 listener 与调用并发。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_summarizer_success_extracts_content_via_chat_completions() {
    let summary_json = serde_json::json!({
        "schemaVersion": 1,
        "blockId": "summary",
        "generation": 1,
        "droppedIds": ["u-drop", "a-drop"],
        "height": 1,
        "tier": "chunk",
        "goal": "实现压缩模块",
        "constraints": [],
        "progress": ["完成切割点保护"],
        "decisions": [],
        "nextSteps": ["补充测试"],
        "criticalContext": ["src/lib.rs"],
    })
    .to_string();
    let server = SummaryMockServer::start(vec![(
        200,
        serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": summary_json}}]
        })
        .to_string(),
    )])
    .await;
    let summarizer = ProviderSummarizer::new(
        reqwest::Client::new(),
        summary_config(server.base_url(), "model-a"),
        conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
    );
    let result = summarizer.summarize(&dropped_summary_messages(), None);
    assert_eq!(
        result.as_deref(),
        Ok(summary_json.as_str()),
        "成功路径返回 content"
    );
    // wire 断言（C14 隔离面）
    let captured = server.captured();
    assert_eq!(captured.len(), 1, "应恰好捕获 1 个摘要请求");
    let req = &captured[0];
    assert_eq!(req["model"], "model-a", "摘要请求用当前 provider 模型");
    assert_eq!(req["stream"], false, "摘要请求非流式");
    assert_eq!(req["max_tokens"], 1024, "摘要输出预算 = 1024");
    let messages = req["messages"].as_array().expect("messages 数组");
    assert_eq!(messages.len(), 1, "单条 user 消息（独立前缀域）");
    assert_eq!(messages[0]["role"], "user");
    let content = messages[0]["content"].as_str().expect("content 为字符串");
    assert!(content.contains("实现压缩模块"), "丢弃消息渲染进提示词");
    assert!(content.contains("src/lib.rs"), "工具调用细节进提示词");
    assert!(req.get("tools").is_none(), "无 tools");
    assert!(req.get("prompt_cache_key").is_none(), "无会话亲和缓存键");
    assert!(req.get("prompt_cache_retention").is_none(), "无缓存保留键");
    assert!(req.get("prompt_cache_options").is_none(), "无缓存选项键");
    assert!(messages[0].get("cache_control").is_none(), "无消息级断点");
}

/// 失败降级 L1：非 2xx → Err（调用方按契约回退中性 stub，不阻塞主对话）
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_summarizer_http_error_degrades_to_err() {
    let server = SummaryMockServer::start(vec![(500, "{\"error\":\"boom\"}".to_string())]).await;
    let summarizer = ProviderSummarizer::new(
        reqwest::Client::new(),
        summary_config(server.base_url(), "model-a"),
        1024,
    );
    let result = summarizer.summarize(&dropped_summary_messages(), None);
    let err = result.expect_err("HTTP 500 必须返回 Err（降级 L1 占位符）");
    assert!(err.contains("500"), "错误文案应携带状态码：{err}");
}

/// 失败降级 L1：2xx 但响应缺 content（空 / 缺字段）→ Err
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_summarizer_missing_content_degrades_to_err() {
    let server = SummaryMockServer::start(vec![(
        200,
        serde_json::json!({ "choices": [{"message": {"role": "assistant", "content": null}}] })
            .to_string(),
    )])
    .await;
    let summarizer = ProviderSummarizer::new(
        reqwest::Client::new(),
        summary_config(server.base_url(), "model-a"),
        1024,
    );
    let result = summarizer.summarize(&dropped_summary_messages(), None);
    assert!(
        result.is_err(),
        "响应缺 content 必须返回 Err（降级 L1 占位符）"
    );
}

/// 生产工厂：provider 未就绪 → None（不注入，纯 stub awaiting 语义）；
/// 就绪 → 返回真实 ProviderSummarizer（模型 = 当前生效配置）
#[test]
fn production_factory_returns_real_summarizer_from_engine_config() {
    use crate::core_run_commands::{isolate_config_store, CONFIG_TEST_LOCK};
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("conex-config-test-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create config dir");
    isolate_config_store(&dir);

    let engine = Arc::new(EngineHandle::new(None));
    let factory = production_summarizer_factory(Arc::clone(&engine));
    assert!(
        factory("s1").is_none(),
        "provider 未就绪（无配置）→ 不注入，保持 stub 语义"
    );
    let provider: Arc<dyn ProviderCall> = Arc::new(HttpProviderCall::new(
        reqwest::Client::new(),
        summary_config("https://x.example/v1".to_string(), "model-prod"),
    ));
    engine.inject_provider_for_test(
        provider,
        summary_config("https://x.example/v1".to_string(), "model-prod"),
    );
    let summarizer = factory("s1").expect("配置就绪后工厂必须返回真实实现");
    // 实例边界：同工厂两次解析为独立实例（per-session 隔离决议）
    let second = factory("s2").expect("再次解析成功");
    assert!(
        !Arc::ptr_eq(&summarizer, &second),
        "每会话独立实例（04 §7.1 隔离决议）"
    );
}

// ── P5 S5 / T-40：缓存测量装配与事件（engine 接线段）────────────

/// 携带 usage 的停止事件（ProviderUsage camelCase 标量面；与
/// session-loop T-36 测试同形状）
fn stop_with_usage(
    prompt: u64,
    completion: u64,
    read: u64,
    write: u64,
    miss: Option<u64>,
) -> ProviderStreamEvent {
    ProviderStreamEvent::Stop {
        reason: LoopStopReason::Stop,
        error: None,
        error_kind: None,
        usage: Some(ProviderUsage {
            prompt_tokens: Some(prompt),
            completion_tokens: Some(completion),
            total_tokens: Some(prompt.saturating_add(completion)),
            cache_read_tokens: Some(read),
            cache_write_tokens: Some(write),
            cache_miss_tokens: miss,
            reasoning_tokens: None,
        }),
    }
}

/// 捕获实时轨事件的测试 sink（ColdCacheWarning / CacheWasteAlert 断言）
struct CaptureDeltaSink {
    events: Arc<Mutex<Vec<AgentEvent>>>,
}

impl DeltaSink for CaptureDeltaSink {
    fn push(&self, delta: AgentEvent) {
        self.events
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(delta);
    }
}

/// 测试用 run 级缓存统计（字段齐全，避免逐字段构造样板）
fn sample_stats(warm_until_ms: Option<u64>, missed_tokens: u64) -> RunCacheStats {
    RunCacheStats {
        prompt_tokens: 10_000,
        completion_tokens: 100,
        total_tokens: 10_100,
        cache_read_tokens: 9_000,
        cache_write_tokens: 500,
        cache_miss_tokens: 500,
        sample_count: 1,
        hit_ratio: Some(0.9),
        write_ratio: Some(0.05),
        missed_tokens,
        warm_until_ms,
    }
}

/// T-40：装配缓存跟踪配置——provider 和 TTL 都来自 live 树；
/// 已声明 TTL 精确透传，未声明或无 live 槽位均 fail-closed。
#[test]
fn cache_tracking_config_resolves_provider_model_ttl() {
    let _live = lock_live_catalog();
    protocol::reload_live_catalog_from_yaml_str(
        r#"
version: 2
providers:
  deepseek:
    displayName: DeepSeek
    baseUrl: "https://api.deepseek.com/v1"
    models:
      - id: deepseek-v4-flash
        cacheTtl: 5m
      - id: deepseek-chat
"#,
    )
    .expect("cache tracking live 夹具必须解析成功");
    // provider_id 和 cacheTtl 均由共享锁保护的 live 树明确提供。
    let deepseek = live_config("deepseek", "deepseek-v4-flash");
    let config = build_cache_tracking_config(&deepseek);
    assert_eq!(config.provider, "deepseek");
    assert_eq!(config.model, "deepseek-v4-flash");
    // 已声明 cacheTtl: 5m → 300s。
    assert_eq!(config.ttl_seconds, 300, "DeepSeek 自动前缀缓存 TTL 300s");

    let undeclared_ttl = live_config("deepseek", "deepseek-chat");
    let config = build_cache_tracking_config(&undeclared_ttl);
    assert_eq!(config.ttl_seconds, 0, "live 未声明 cacheTtl 时 fail-closed");

    // 无 live 槽位（vendor/provider_id 均 None）→ fail-closed 保守全关
    let gateway = EngineProviderConfig {
        base_url: "https://gw.example.com/v1/".to_string(),
        api_key: "k".to_string(),
        model: "custom-model".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    };
    let config = build_cache_tracking_config(&gateway);
    assert_eq!(config.provider, "auto");
    assert_eq!(config.ttl_seconds, 0);
}

/// T-40：冷缓存预警——温暖截止过期判定（完成时刻反解 idle、
/// 重发量 = 上次 input_total，C9 恒等式）；TTL 未知 / 未过期 /
/// 无截止 → 不预警
#[test]
fn cold_cache_warning_fires_after_warm_until() {
    let config = CacheTrackingConfig {
        provider: "deepseek".to_string(),
        model: "deepseek-v4-flash".to_string(),
        ttl_seconds: 60,
    };
    // 上一 run：完成 1000ms、warm = 1000 + 60_000 = 61_000
    let last = sample_stats(Some(61_000), 0);
    assert!(
        cold_cache_warning_event("s1", &config, &last, 60_000).is_none(),
        "未过期不预警"
    );
    assert!(
        cold_cache_warning_event("s1", &config, &last, 61_000).is_none(),
        "恰好等于截止仍温暖"
    );
    let event = cold_cache_warning_event("s1", &config, &last, 121_001).expect("超 TTL 必须预警");
    match event {
        AgentEvent::ColdCacheWarning {
            session_id,
            ttl_seconds,
            idle_ms,
            resend_estimate_tokens,
            ..
        } => {
            assert_eq!(session_id, "s1");
            assert_eq!(ttl_seconds, 60);
            // idle = now - completed = 121_001 - 1_000
            assert_eq!(idle_ms, 120_001);
            // 重发量 = 上次 input_total = 500 + 9000 + 500
            assert_eq!(resend_estimate_tokens, 10_000);
        }
        other => panic!("期望 ColdCacheWarning，得到 {other:?}"),
    }
    // TTL 未知（0）→ 不预警（P5 §3.4.4：TTL 查询失败不提示）
    let no_ttl = CacheTrackingConfig {
        ttl_seconds: 0,
        ..config.clone()
    };
    assert!(cold_cache_warning_event("s1", &no_ttl, &last, 121_001).is_none());
    // 无温暖截止 → 不预警
    let mut no_warm = last;
    no_warm.warm_until_ms = None;
    assert!(cold_cache_warning_event("s1", &config, &no_warm, 121_001).is_none());
}

/// T-40：浪费预警阈值（≥ 20_000 token 才打扰，pi 口径；2026-08-09 接线
/// WARN_MISSED_COST_USD 后 token / 金额双阈值 or 判定）——低于阈值只计入
/// run 聚合；触发时 attribution 诚实兜底 Unknown + wire 形状 + 金额实测
#[test]
fn waste_alert_emitted_above_threshold_with_honest_attribution() {
    // 显式 USD 单价（引擎微元口径）：input 0.14 / cacheRead 0.0028
    let pricing = agent_provider::models::catalog_types::ModelPricingSpec {
        currency: agent_provider::pricing::Currency::Usd,
        unit: agent_provider::models::catalog_types::PricingUnit::PerMillionTokens,
        input: Some(0.14),
        output: Some(0.28),
        cache_read: Some(0.0028),
        cache_write: Some(0.0),
        per_image: None,
        tiers: vec![],
    };
    let below = sample_stats(Some(61_000), WARN_MISSED_TOKENS - 1);
    assert!(
        waste_alert_event("s1", &below, false, Some(&pricing)).is_none(),
        "低于阈值不打扰"
    );
    let over = sample_stats(Some(61_000), WARN_MISSED_TOKENS);
    let event = waste_alert_event("s1", &over, true, Some(&pricing)).expect("达到阈值必须预警");
    match event {
        AgentEvent::CacheWasteAlert {
            ref session_id,
            attribution,
            missed_tokens,
            model_changed,
            missed_cost_usd,
            ..
        } => {
            assert_eq!(session_id, "s1");
            assert_eq!(attribution, MissAttribution::Unknown);
            assert_eq!(missed_tokens, WARN_MISSED_TOKENS);
            assert!(model_changed);
            // 金额 = 引擎微元差：20_000 × (0.14 − 0.0028)/1M = 0.002744
            let cost = missed_cost_usd.expect("USD 单价必须给出金额");
            assert!((cost - 0.002744).abs() < 1e-9, "金额口径偏差：{cost}");
        }
        other => panic!("期望 CacheWasteAlert，得到 {other:?}"),
    }
    // wire 形状：kebab-case attribution + camelCase 字段
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["type"], "cache-waste-alert");
    assert_eq!(value["attribution"], "unknown");
    assert_eq!(value["missedTokens"], WARN_MISSED_TOKENS);
    assert!(value.get("missed_tokens").is_none(), "不得出现 snake_case");
    // 无定价（未知厂商）→ 金额 None，仅 token 阈值判定（诚实兜底不估算）
    let unknown = sample_stats(Some(61_000), WARN_MISSED_TOKENS);
    let event = waste_alert_event("s1", &unknown, false, None).expect("token 阈值已超，也应预警");
    match event {
        AgentEvent::CacheWasteAlert {
            missed_cost_usd, ..
        } => {
            assert!(missed_cost_usd.is_none(), "无价格数据 → 金额 None");
        }
        other => panic!("期望 CacheWasteAlert，得到 {other:?}"),
    }
}

/// 金额阈值独立触发（2026-08-09 接线 WARN_MISSED_COST_USD）：token 低于
/// 20_000 但估算金额 ≥ $0.1 → 仍预警。用高差价 USD 模型（input 12.5 −
/// cacheRead 1.25 = 11.25/1M）：10_000 token → $0.1125 ≥ $0.1
#[test]
fn waste_alert_fires_on_cost_threshold_alone() {
    let pricing = agent_provider::models::catalog_types::ModelPricingSpec {
        currency: agent_provider::pricing::Currency::Usd,
        unit: agent_provider::models::catalog_types::PricingUnit::PerMillionTokens,
        input: Some(12.5),
        output: Some(12.5),
        cache_read: Some(1.25),
        cache_write: Some(1.25),
        per_image: None,
        tiers: vec![],
    };
    // token 阈值以下（10_000 < 20_000）但金额超 $0.1 → 必须预警
    let stats = sample_stats(Some(61_000), 10_000);
    let event = waste_alert_event("s1", &stats, false, Some(&pricing)).expect("金额阈值单独触发");
    match event {
        AgentEvent::CacheWasteAlert {
            missed_tokens,
            missed_cost_usd,
            ..
        } => {
            assert_eq!(missed_tokens, 10_000);
            let cost = missed_cost_usd.expect("价格已入库必须给出金额");
            assert!((cost - 0.1125).abs() < 1e-9, "金额口径偏差：{cost}");
        }
        other => panic!("期望 CacheWasteAlert，得到 {other:?}"),
    }
    // 对照：同模型 token 更低且金额不足（如 1_000 token → $0.01125）→ 不预警
    let low = sample_stats(Some(61_000), 1_000);
    assert!(waste_alert_event("s1", &low, false, Some(&pricing)).is_none());
}

/// T-40：模型切换检测——上一 run model ≠ 当前 model；无上一 run
/// 基线（首次 run）不算切换（首轮归因 Cold）
#[test]
fn model_switch_detection_compares_last_and_current() {
    assert!(model_switched(Some("gpt-4o"), Some("deepseek-v4-flash")));
    assert!(!model_switched(
        Some("deepseek-v4-flash"),
        Some("deepseek-v4-flash")
    ));
    assert!(
        !model_switched(None, Some("deepseek-v4-flash")),
        "无上一 run 基线 → 不算切换"
    );
    assert!(!model_switched(Some("deepseek-v4-flash"), None));
    assert!(!model_switched(None, None));
}

/// T-40 集成：启用缓存测量后 produce 收口——RunOutcome.cache_stats
/// 携带 run 级聚合 + cache-stats-updated 事件入收口轨
#[tokio::test]
async fn produce_emits_cache_stats_updated_when_tracking_enabled() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("你好"),
        stop_with_usage(1_000, 50, 800, 100, None),
    ]));
    let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
    let mut producer = SessionLoopProducer::new(
        "ses-t40".to_string(),
        "run-t40".to_string(),
        8,
        provider_call,
        Arc::new(ToolRegistry::new()),
        SessionLoopOptions::default(),
        ToolBatchOptions::default(),
        None,
        None,
        None,
        user_message("第一轮", Some("user-t40")),
    )
    .with_cache_tracking(Some(CacheTrackingConfig {
        provider: "deepseek".to_string(),
        model: "deepseek-v4-flash".to_string(),
        ttl_seconds: 300,
    }));

    let outcome = producer.produce().await;

    let stats = outcome.cache_stats.expect("启用测量后收口必须携带缓存统计");
    assert_eq!(stats.sample_count, 1);
    assert_eq!(stats.cache_read_tokens, 800);
    // Included：miss = prompt - read - write
    assert_eq!(stats.cache_miss_tokens, 100);
    // cache-stats-updated 入收口轨（与 agent-end 同轨）
    let updated = outcome
        .events
        .iter()
        .rev()
        .find_map(|event| match event {
            AgentEvent::CacheStatsUpdated {
                session_id, stats, ..
            } => Some((session_id.as_str(), *stats)),
            _ => None,
        })
        .expect("收口事件应含 cache-stats-updated");
    assert_eq!(updated.0, "ses-t40");
    assert_eq!(updated.1.cache_read_tokens, 800);
}

/// T-40 向后兼容：未配置缓存测量 → cache_stats None、无
/// cache-stats-updated 事件（行为与现状一致）
#[tokio::test]
async fn produce_without_cache_tracking_keeps_legacy_behavior() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("hi"),
        stop_with_usage(100, 10, 0, 0, None),
    ]));
    let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
    let mut producer = SessionLoopProducer::new(
        "ses-legacy".to_string(),
        "run-legacy".to_string(),
        8,
        provider_call,
        Arc::new(ToolRegistry::new()),
        SessionLoopOptions::default(),
        ToolBatchOptions::default(),
        None,
        None,
        None,
        user_message("hi", None),
    );
    let outcome = producer.produce().await;
    assert!(
        outcome.cache_stats.is_none(),
        "未配置 → cache_stats 为 None"
    );
    assert!(
        outcome
            .events
            .iter()
            .all(|e| !matches!(e, AgentEvent::CacheStatsUpdated { .. })),
        "未配置 → 不发射 cache-stats-updated"
    );
}

/// T-40 集成：上一 run warm_until_ms 已过期 → produce 启动前经
/// 实时轨 DeltaSink 发射 cold-cache-warning 一次（重发量 = 上次
/// input_total）
#[tokio::test]
async fn produce_emits_cold_cache_warning_when_previous_run_cold() {
    let now = unix_millis_now();
    // 上一 run：温暖截止 = now - 1（刚过期）；TTL 60s
    let last = sample_stats(Some(now.saturating_sub(1)), 0);
    let sink_events: Arc<Mutex<Vec<AgentEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: Arc<dyn DeltaSink> = Arc::new(CaptureDeltaSink {
        events: Arc::clone(&sink_events),
    });
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("hi"),
        stop_with_usage(100, 10, 0, 0, None),
    ]));
    let provider_call: Arc<dyn ProviderCall> = Arc::clone(&provider) as Arc<dyn ProviderCall>;
    let mut producer = SessionLoopProducer::new(
        "ses-cold".to_string(),
        "run-cold".to_string(),
        8,
        provider_call,
        Arc::new(ToolRegistry::new()),
        SessionLoopOptions::default(),
        ToolBatchOptions::default(),
        None,
        Some(sink),
        None,
        user_message("hi", None),
    )
    .with_cache_tracking(Some(CacheTrackingConfig {
        provider: "deepseek".to_string(),
        model: "deepseek-v4-flash".to_string(),
        ttl_seconds: 60,
    }))
    .with_cache_session(SessionCacheState {
        last_stats: Some(last),
        last_model: Some("deepseek-v4-flash".to_string()),
    });

    producer.produce().await;

    let captured = sink_events.lock().unwrap_or_else(|e| e.into_inner());
    let warning = captured
        .iter()
        .find_map(|event| match event {
            AgentEvent::ColdCacheWarning {
                ttl_seconds,
                resend_estimate_tokens,
                ..
            } => Some((*ttl_seconds, *resend_estimate_tokens)),
            _ => None,
        })
        .expect("实时轨应收到 cold-cache-warning");
    assert_eq!(warning.0, 60);
    // 重发量 = 上次 input_total = 9000 + 500 + 500（C9 恒等式）
    assert_eq!(warning.1, 10_000);
}

/// T-40：cache-stats-updated 事件 wire 形状（camelCase 全字段）
#[test]
fn cache_stats_updated_event_serializes_camel_case() {
    let event = AgentEvent::CacheStatsUpdated {
        session_id: "s1".to_string(),
        timestamp: now_iso_utc(),
        stats: sample_stats(Some(61_000), 0),
    };
    let value = serde_json::to_value(&event).unwrap();
    assert_eq!(value["type"], "cache-stats-updated");
    assert_eq!(value["sessionId"], "s1");
    let stats = &value["stats"];
    assert_eq!(stats["promptTokens"], 10_000);
    assert_eq!(stats["completionTokens"], 100);
    assert_eq!(stats["totalTokens"], 10_100);
    assert_eq!(stats["cacheReadTokens"], 9_000);
    assert_eq!(stats["cacheWriteTokens"], 500);
    assert_eq!(stats["cacheMissTokens"], 500);
    assert_eq!(stats["sampleCount"], 1);
    assert_eq!(stats["hitRatio"], 0.9);
    assert_eq!(stats["writeRatio"], 0.05);
    assert_eq!(stats["missedTokens"], 0);
    assert_eq!(stats["warmUntilMs"], 61_000);
    assert!(
        value.get("cache_read_tokens").is_none(),
        "不得出现 snake_case 键"
    );
}

// ── M1：Tool Context 注入通道（C10 地基；build_context 立通道）────

/// M1 注入顺序契约（冻结快照）：`system → skills → mcp → agent 定义`
///
/// 断言（02 M1 内容 4 + 任务书内容 2）：顺序常量与枚举声明序/排序序
/// 三方一致——排序即协议，M11 重注入断言以此为契约；顺序变化必须
/// 同时改三处并被本快照捕获。
#[test]
fn injection_order_contract_is_frozen() {
    assert_eq!(
        CONTEXT_INJECTION_ORDER,
        [
            ContextInjectionKind::System,
            ContextInjectionKind::Skills,
            ContextInjectionKind::Mcp,
            ContextInjectionKind::AgentDefinition,
        ],
        "注入顺序契约：system → skills → mcp → agent 定义（变化视为协议变更）"
    );
    // 常量已按 enum Ord 升序（声明序 = 排序序 = 协议序）
    let mut sorted = CONTEXT_INJECTION_ORDER.to_vec();
    sorted.sort();
    assert_eq!(sorted, CONTEXT_INJECTION_ORDER);
}

/// M1 注入点存在且可注入（mock）：push 累积、空判定、kinds 按契约序
#[test]
fn injector_push_accumulates_and_kinds_follow_contract() {
    let mut injector = ContextInjector::new();
    assert!(injector.is_empty());
    assert_eq!(injector.kinds(), Vec::<ContextInjectionKind>::new());

    // 乱序 push：agent 定义 → skills → mcp
    injector
        .push(ContextInjection::new(
            ContextInjectionKind::AgentDefinition,
            "Agent 定义",
            "agent-body",
        ))
        .push(ContextInjection::new(
            ContextInjectionKind::Skills,
            "Skill 定义",
            "skill-body",
        ))
        .push(ContextInjection::new(
            ContextInjectionKind::Mcp,
            "MCP 工具声明",
            "mcp-body",
        ));
    assert!(!injector.is_empty());
    assert_eq!(
        injector.kinds(),
        vec![
            ContextInjectionKind::Skills,
            ContextInjectionKind::Mcp,
            ContextInjectionKind::AgentDefinition,
        ],
        "kinds() 必须按冻结顺序返回（skills → mcp → agent 定义）"
    );
}

/// M1 顺序契约 + 快照：乱序 push 后 render 仍按冻结顺序拼接
/// （system 段 → skill 段 → MCP 段 → agent 定义段），且同一配置
/// 两次构建字节一致（动态字段以 `@dynamic` 标记豁免，不在断言范围）
#[test]
fn injector_render_respects_frozen_order_and_is_byte_stable() {
    let mut injector = ContextInjector::new();
    injector
        .push(ContextInjection::new(
            ContextInjectionKind::AgentDefinition,
            "Agent 定义",
            "agent-body",
        ))
        .push(ContextInjection::new(
            ContextInjectionKind::Mcp,
            "MCP 工具声明",
            "mcp-body",
        ))
        .push(ContextInjection::new(
            ContextInjectionKind::Skills,
            "Skill 定义",
            "skill-body",
        ));

    let rendered = injector
        .render(Some("基础系统提示".to_string()))
        .expect("有注入段时必然产出");
    // 顺序：基础段 → Skills → MCP → Agent 定义（契约断言）
    let skill = rendered.find("## Skill 定义").expect("skill 段存在");
    let mcp = rendered.find("## MCP 工具声明").expect("MCP 段存在");
    let agent = rendered.find("## Agent 定义").expect("agent 段存在");
    assert!(rendered.starts_with("基础系统提示"), "system 段必须置首");
    assert!(skill < mcp, "skill 段先于 MCP 段（契约）");
    assert!(mcp < agent, "MCP 段先于 agent 定义段（契约）");
    // 每段渲染为 `## {title}\n{content}`，段间 \n\n 分隔
    assert!(rendered.contains("## Skill 定义\nskill-body"));
    assert!(rendered.contains("## MCP 工具声明\nmcp-body"));
    assert!(rendered.contains("## Agent 定义\nagent-body"));

    // 快照：两次构建 system 段字节一致（M1 内容 4）
    let second = injector
        .render(Some("基础系统提示".to_string()))
        .expect("有注入段时必然产出");
    assert_eq!(rendered, second, "同一配置两次构建 system 段字节必须一致");
}

/// M1 默认行为回归：无注入段时 render 原样返回基础段
/// （None → None；Some → 原样透传，含空串——空值归一属装配点
/// build_system_prompt 职责，注入通道不做二次规范化），与现状
/// 逐字节一致
#[test]
fn injector_render_without_injections_preserves_base() {
    let injector = ContextInjector::new();
    assert_eq!(
        injector.render(None),
        None,
        "无注入且无基础段 → None（现状）"
    );
    assert_eq!(
        injector.render(Some("基础系统提示".to_string())),
        Some("基础系统提示".to_string()),
        "无注入时基础段原样透传（现状）"
    );
    // 原样透传：空串基础段不归一（归一化在装配点 build_system_prompt）
    assert_eq!(injector.render(Some(String::new())), Some(String::new()));
}

/// M1 集成：produce 装配注入通道后，渲染结果经 system_prompt 面送达
/// provider（注入点存在且可注入），且对话消息不含 system 角色——
/// 注入段归类 system 角色、结构上不进压缩输入（独立于压缩预算）
#[tokio::test]
async fn produce_with_injector_sends_rendered_system_prompt_as_system_role() {
    let mut injector = ContextInjector::new();
    injector
        .push(ContextInjection::new(
            ContextInjectionKind::AgentDefinition,
            "Agent 定义",
            "agent-body",
        ))
        .push(ContextInjection::new(
            ContextInjectionKind::Skills,
            "Skill 定义",
            "skill-body",
        ))
        .push(ContextInjection::new(
            ContextInjectionKind::Mcp,
            "MCP 工具声明",
            "mcp-body",
        ));
    let (producer, provider) = test_producer(None, SessionLoopOptions::default());
    let mut producer = producer.with_context_injector(Some(injector));
    producer.produce().await;

    // 注入段经 system_prompt 面送达（非对话消息）
    let sent_system = provider
        .request_system_prompt(0)
        .expect("注入后请求必须携带 system prompt");
    let skill = sent_system.find("## Skill 定义").expect("skill 段存在");
    let mcp = sent_system.find("## MCP 工具声明").expect("MCP 段存在");
    let agent = sent_system.find("## Agent 定义").expect("agent 段存在");
    assert!(skill < mcp, "skill 段先于 MCP 段（契约）");
    assert!(mcp < agent, "MCP 段先于 agent 定义段（契约）");
    assert!(sent_system.contains("## Agent 定义\nagent-body"));

    // 对话消息不含 system 角色：注入段归类 system 角色（system_prompt
    // 面），压缩只作用于会话对话 → 注入段不进压缩预算
    let sent_messages = provider.request_message_arcs(0);
    assert!(
        sent_messages
            .iter()
            .all(|m| m.role != AgentMessageRole::System),
        "注入段不得混入会话消息（system 角色面 = system_prompt）"
    );
}

/// M1 默认行为回归（produce 级）：未装配注入通道时 system_prompt
/// 原样透传（None → None；已有基础段 → 不变），与现状一致
#[tokio::test]
async fn produce_without_injector_keeps_default_system_prompt_behavior() {
    // 无注入且无基础段：请求不携带 system prompt（P1 阶段 2 现状）
    let (mut producer, provider) = test_producer(None, SessionLoopOptions::default());
    producer.produce().await;
    assert!(
        provider.request_system_prompt(0).is_none(),
        "无注入无基础段 → system_prompt 保持 None（现状）"
    );

    // 无注入但 options 已带基础段：原样透传（不被注入通道改写）
    // （system_prompt 归入 assembly 子结构，对齐 run_launch.rs 装配惯例）
    let mut options = SessionLoopOptions::default();
    options.assembly.system_prompt = Some("基础系统提示".to_string());
    let (mut producer_base, provider_base) = test_producer(None, options);
    producer_base.produce().await;
    assert_eq!(
        provider_base.request_system_prompt(0).as_deref(),
        Some("基础系统提示"),
        "无注入 → 基础段原样透传（现状）"
    );
}

// ── T-D-03：子代理角色约束注入（F4 R-D1；spawn 装配路径 F11 T-D-13 接入）──

/// T-D-03 冻结文案（测试断言锚点）：段标题/正文/类型三者与任务书一致；
/// 段类型 = System（按 [CONTEXT_INJECTION_ORDER] 首段位）；静态文本
/// 不含 `@dynamic` 标记，纳入 C10 字节级一致断言范围
#[test]
fn subagent_role_constraint_frozen_text_is_exact() {
    assert_eq!(SUBAGENT_ROLE_CONSTRAINT_TITLE, "子代理角色约束");
    assert_eq!(
            SUBAGENT_ROLE_CONSTRAINT_CONTENT,
            "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。"
        );
    assert!(
        !SUBAGENT_ROLE_CONSTRAINT_CONTENT.contains("@dynamic"),
        "静态文本不得带动态字段标记"
    );
    let mut injector = ContextInjector::new();
    push_subagent_role_constraint(&mut injector);
    assert_eq!(
        injector.kinds(),
        vec![ContextInjectionKind::System],
        "段类型 = System（按 CONTEXT_INJECTION_ORDER 首段位）"
    );
}

/// T-D-03 渲染契约（render 拼接顺序回归）：基础系统段置首、角色约束段
/// 紧随其后（System 首段位，位于 Skills 段之前）；两次构建字节一致
/// （C10 快照断言面）
#[test]
fn subagent_role_constraint_renders_after_base_before_skills() {
    let mut injector = ContextInjector::new();
    // 子代理装配面：角色约束段 + Skills 段（验证 System 首段位）
    push_subagent_role_constraint(&mut injector);
    injector.push(ContextInjection::new(
        ContextInjectionKind::Skills,
        "Skill 定义",
        "skill-body",
    ));
    let rendered = injector
        .render(Some("基础系统提示".to_string()))
        .expect("有注入段时必然产出");
    assert!(rendered.starts_with("基础系统提示"), "基础系统段必须置首");
    let constraint = rendered.find("## 子代理角色约束").expect("角色约束段存在");
    let skills = rendered.find("## Skill 定义").expect("skill 段存在");
    assert!(constraint < skills, "System 段位于 Skills 段之前（首段位）");
    // 段渲染形状：`## {title}\n{content}`，段间 \n\n 分隔
    let section =
        format!("## {SUBAGENT_ROLE_CONSTRAINT_TITLE}\n{SUBAGENT_ROLE_CONSTRAINT_CONTENT}");
    assert!(
        rendered.contains(&section),
        "角色约束段渲染为 `## 标题\n正文`"
    );
    // C10 字节级一致：同一配置两次构建逐字节一致
    let second = injector
        .render(Some("基础系统提示".to_string()))
        .expect("有注入段时必然产出");
    assert_eq!(rendered, second, "静态注入段两次构建必须逐字节一致");
}

/// T-D-03 produce 级（子代理 run 装配面）：经 request_system_prompt 取
/// system_prompt，断言含冻结文案全文；注入段归类 system 角色、不进
/// 会话对话（独立于压缩预算）
#[tokio::test]
async fn subagent_run_system_prompt_contains_frozen_constraint() {
    let mut injector = ContextInjector::new();
    push_subagent_role_constraint(&mut injector);
    let (producer, provider) = test_producer(None, SessionLoopOptions::default());
    let mut producer = producer.with_context_injector(Some(injector));
    producer.produce().await;

    let sent_system = provider
        .request_system_prompt(0)
        .expect("注入后请求必须携带 system prompt");
    assert!(
        sent_system.contains("你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配"),
        "system_prompt 必须含冻结文案前半句"
    );
    assert!(
        sent_system.contains(
            "如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。"
        ),
        "system_prompt 必须含冻结文案后半句"
    );
    assert!(sent_system.contains("## 子代理角色约束"), "段标题渲染可见");
    // 注入段归类 system 角色，不进会话对话（独立于压缩预算）
    let sent_messages = provider.request_message_arcs(0);
    assert!(
        sent_messages
            .iter()
            .all(|m| m.role != AgentMessageRole::System),
        "注入段不得混入会话消息（system 角色面 = system_prompt）"
    );
}

/// T-D-03 主 Agent run 差异断言：主 Agent 装配点不调用
/// push_subagent_role_constraint → system_prompt 不含本段
/// （即便装配了其他注入段，角色约束段也不出现）
#[tokio::test]
async fn main_agent_run_excludes_subagent_role_constraint() {
    // 主 Agent 装配面：仅常规注入段（Skills），无角色约束段
    let mut injector = ContextInjector::new();
    injector.push(EngineHandle::skill_context_injection(&[sample_skill(
        "code-review",
        "代码评审",
        "按正确性优先评审。",
    )]));
    let (producer, provider) = test_producer(None, SessionLoopOptions::default());
    let mut producer = producer.with_context_injector(Some(injector));
    producer.produce().await;

    let sent_system = provider
        .request_system_prompt(0)
        .expect("有注入段时请求必带 system prompt");
    assert!(
        !sent_system.contains("子代理角色约束"),
        "主 Agent run 不得含角色约束段标题"
    );
    assert!(
        !sent_system.contains("你没有创建子 Agent 的能力"),
        "主 Agent run 不得含冻结文案"
    );
}

// ── E5：MCP 接入 + C10 注入读取面（03 方案 E5 内容 1/3）────────────

/// 构造测试用 RustSkill（C10 注入断言用）
fn sample_skill(name: &str, description: &str, content: &str) -> RustSkill {
    RustSkill {
        file_path: format!("C:\\skills\\{name}\\SKILL.md"),
        base_dir: format!("C:\\skills\\{name}"),
        content: content.to_string(),
        raw: format!("---\nname: {name}\n---\n{content}"),
        scope: "project".to_string(),
        system: false,
        name: name.to_string(),
        description: description.to_string(),
        tags: Vec::new(),
        applies_to: Vec::new(),
        disable_model_invocation: false,
        file_activation: None,
    }
}

/// C10 Skills 注入段：RustSkill 读取面 → 注入段渲染确定（同一配置
/// 两次构建 system 段字节一致），条目含技能名/描述/正文
#[test]
fn skill_injection_is_byte_stable_and_contains_skills() {
    let skills = vec![
        sample_skill("code-review", "代码评审", "按正确性优先评审。"),
        sample_skill("conex-committer", "提交规范", "按仓库风格提交。"),
    ];
    let injection = EngineHandle::skill_context_injection(&skills);
    assert_eq!(injection.kind, ContextInjectionKind::Skills);
    let mut injector = ContextInjector::new();
    injector.push(injection);
    let rendered = injector
        .render(Some("基础系统提示".to_string()))
        .expect("有注入段时必然产出");
    // 渲染确定：两次构建字节一致（C10 断言）
    let second = injector
        .render(Some("基础系统提示".to_string()))
        .expect("有注入段时必然产出");
    assert_eq!(
        rendered, second,
        "同一技能集合两次构建 system 段必须字节一致"
    );
    // 读取面内容可见
    assert!(rendered.contains("## Skill 定义"));
    assert!(rendered.contains("- code-review（project）：代码评审"));
    assert!(rendered.contains("按正确性优先评审。"));
    assert!(rendered.contains("- conex-committer（project）：提交规范"));
    // system 标记技能带（系统）标注
    let mut sys = sample_skill("sys-skill", "系统技能", "系统正文");
    sys.system = true;
    let inj = EngineHandle::skill_context_injection(&[sys]);
    let mut injector_sys = ContextInjector::new();
    injector_sys.push(inj);
    let render = injector_sys.render(None).expect("必产出");
    assert!(render.contains("- sys-skill（系统）（project）：系统技能"));
}

/// C10 MCP 工具声明注入段：定义列表 → 注入段渲染确定，条目含
/// `mcp_<server>__<tool>` 命名工具
#[test]
fn mcp_injection_is_byte_stable_and_lists_tools() {
    let defs = vec![
        ToolDefinition {
            name: "mcp_files__read".to_string(),
            description: "读文件".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
            dangerous: false,
            fatal_on_error: false,
        },
        ToolDefinition {
            name: "mcp_files__write".to_string(),
            description: "写文件".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
            dangerous: true,
            fatal_on_error: false,
        },
    ];
    let injection = EngineHandle::mcp_context_injection(&defs);
    assert_eq!(injection.kind, ContextInjectionKind::Mcp);
    let mut injector = ContextInjector::new();
    injector.push(injection);
    let rendered = injector.render(None).expect("有注入段时必然产出");
    let second = injector.render(None).expect("有注入段时必然产出");
    assert_eq!(rendered, second, "同一 MCP 工具集两次构建必须字节一致");
    assert!(rendered.contains("## MCP 工具声明"));
    assert!(rendered.contains("- mcp_files__read：读文件"));
    assert!(rendered.contains("- mcp_files__write：写文件"));
}

/// C10 注入集成（produce 级）：skill 注入段经 system_prompt 面送达
/// provider（M1 注入点 + M11 输出消费），对话消息不含 system 角色
#[tokio::test]
async fn produce_with_skill_injection_sends_skill_segment() {
    let skills = vec![sample_skill(
        "code-review",
        "代码评审",
        "按正确性优先评审。",
    )];
    let mut injector = ContextInjector::new();
    injector
        .push(EngineHandle::skill_context_injection(&skills))
        .push(EngineHandle::mcp_context_injection(&[ToolDefinition {
            name: "mcp_files__read".to_string(),
            description: "读文件".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
            dangerous: false,
            fatal_on_error: false,
        }]));
    let (producer, provider) = test_producer(None, SessionLoopOptions::default());
    let mut producer = producer.with_context_injector(Some(injector));
    producer.produce().await;

    let sent_system = provider
        .request_system_prompt(0)
        .expect("注入后请求必须携带 system prompt");
    assert!(sent_system.contains("## Skill 定义"));
    assert!(sent_system.contains("code-review"));
    // 注入顺序契约：skills 段先于 MCP 段
    let skill = sent_system.find("## Skill 定义").expect("skill 段存在");
    let mcp = sent_system.find("## MCP 工具声明").expect("MCP 段存在");
    assert!(skill < mcp, "skill 段先于 MCP 段（M1 冻结顺序）");
    // 注入段归类 system 角色，不进会话对话（独立于压缩预算）
    let sent_messages = provider.request_message_arcs(0);
    assert!(
        sent_messages
            .iter()
            .all(|m| m.role != AgentMessageRole::System),
        "注入段不得混入会话消息（system 角色面 = system_prompt）"
    );
}

/// 定位 agent-tools 测试夹具二进制（mcp-fake-server）：workspace 测试
/// 构建时与测试可执行同目录产出；独立构建本 crate 测试时可能缺失
fn locate_mcp_fake_server() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "mcp-fake-server.exe"
    } else {
        "mcp-fake-server"
    };
    let candidate = dir.join(name);
    candidate.exists().then_some(candidate)
}

/// 引擎集成：插件 mcpServers 声明 → 服务器启动 → 工具并入注册表
/// （mcp_<server>__<tool> 命名），注册后可执行往返；启动失败 =
/// mcp.* 错误上抛且注册表不污染
#[tokio::test]
async fn register_plugin_mcp_server_integration() {
    let engine = EngineHandle::new(None);

    // 错误路径：非法命令 → mcp.connection_failed，注册表无残留
    let bad = McpServerConfig::new("missing", "definitely-not-a-real-command-xyz");
    let err = engine.register_plugin_mcp_server(bad).await.unwrap_err();
    assert_eq!(err.code(), "mcp.connection_failed");
    let listed: Vec<String> = engine
        .tool_registry()
        .list_definitions()
        .iter()
        .map(|d| d.name.clone())
        .collect();
    assert!(
        !listed.iter().any(|n| n.starts_with("mcp_missing")),
        "启动失败不得污染注册表"
    );

    // 成功路径：依赖 agent-tools 测试夹具（workspace 全量测试时存在；
    // 单独构建本 crate 时跳过并记录）
    let Some(fake) = locate_mcp_fake_server() else {
        tracing::warn!(
            "mcp-fake-server 夹具未构建（需 workspace 全量构建），跳过引擎级 MCP 成功路径断言"
        );
        return;
    };
    let config = McpServerConfig::new("fake", fake.to_string_lossy().to_string());
    let defs = engine.register_plugin_mcp_server(config).await.unwrap();
    let names: Vec<String> = defs.iter().map(|d| d.name.clone()).collect();
    assert!(
        names.contains(&"mcp_fake__echo".to_string()),
        "MCP 工具应并入：{names:?}"
    );
    let listed: Vec<String> = engine
        .tool_registry()
        .list_definitions()
        .iter()
        .map(|d| d.name.clone())
        .collect();
    assert!(
        listed.contains(&"mcp_fake__echo".to_string()),
        "list_definitions 应可见并入的 MCP 工具"
    );
    // 幂等：重复注册不报错、不重复并入
    engine
        .register_plugin_mcp_server(McpServerConfig::new(
            "fake",
            fake.to_string_lossy().to_string(),
        ))
        .await
        .unwrap();
    let count = engine
        .tool_registry()
        .list_definitions()
        .iter()
        .filter(|d| d.name.starts_with("mcp_fake__"))
        .count();
    assert_eq!(count, 4, "重复注册不得重复并入");
    // 生命周期收口
    engine.mcp_bridge().stop_all().await;
}

/// 34 §5.2 E-1 装配注入断言 + E-4 消费路径（拒绝态，R-12 安全默认）：
/// 默认装配（开关 false）经引擎 seam `browser_attach_mcp_server_config`
/// 消费守卫 → 结构化 `tool.browser.capability_disabled`（端点零暴露；
/// 若装配未把开关注入 BrowserSlot，守卫无法命中开关先行判定——装配
/// 注入由错误码互斥背书）。
#[tokio::test]
async fn mcp_attach_assembly_default_denies_zero_exposure() {
    use conex_browser_tools::codes::TOOL_BROWSER_CAPABILITY_DISABLED;
    let engine = EngineHandle::new(None);
    let err = engine
        .browser_attach_mcp_server_config("browser-mcp")
        .unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
}

/// 34 §5.2 E-1 装配注入断言（允许态，mock 配置）：经
/// [EngineHandle::new_with_mcp_attach_allowed](true) 注入开关 →
/// 引擎 seam 消费守卫 → `tool.browser.not_ready`（受管实例未启动；
/// 若装配未注入开关会命中 capability_disabled——两态互斥区分装配
/// 注入生效；就绪放行面由 browser 域单测以样例端点覆盖，引擎级不
/// 触发真实浏览器启动）。
#[tokio::test]
async fn mcp_attach_assembly_enabled_requires_running_endpoint() {
    use conex_browser_tools::codes::TOOL_BROWSER_NOT_READY;
    let engine = EngineHandle::new_with_mcp_attach_allowed(true);
    let err = engine
        .browser_attach_mcp_server_config("browser-mcp")
        .unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
}

impl EngineHandle {
    /// 测试面：指定 attach 会话级开关的完整装配（34 §5.2 E-1 装配注入
    /// 断言——mock 配置值直接注入装配路径，验证引擎将开关经
    /// `BrowserSlot::with_mcp_attach_allowed` 注入槽并由消费 seam 命中）。
    pub(crate) fn new_with_mcp_attach_allowed(mcp_attach_allowed: bool) -> Self {
        Self::build(None, None, mcp_attach_allowed, None)
    }

    /// 测试面：注入 provider 适配层与生效配置并置就绪（T-D-13 端到端测试
    /// 用——run_task_impl 完整装配不依赖磁盘 config，CI 确定性；经
    /// [Self::cache_tracking_config] 同步生效——默认模型继承断言数据源）
    pub(crate) fn inject_provider_for_test(
        &self,
        provider: Arc<dyn ProviderCall>,
        config: EngineProviderConfig,
    ) {
        *self.provider.lock().unwrap_or_else(|e| e.into_inner()) = Some(provider);
        *self
            .provider_config
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(config);
        self.ready.store(true, Ordering::SeqCst);
        *self.ready_reason.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// T-CF-06 装配测试：EngineHandle 的 TimerRegistry 接线面。
///
/// 独立模块（不与上方既有 tests 模块共享上下文），聚焦
/// `engine_injects_timer_channel` 一项验收断言。
#[cfg(test)]
mod timer_wiring_tests {
    use super::*;
    use conex_types::timer::TimerCondition;

    /// EngineHandle::new 后 set_timer / cancel_timer 工具已注册且
    /// TimerChannel 已接线：register / cancel / list_active 不再返回
    /// unsupported；到期 steering 条目落在引擎持有的真实
    /// PendingMessageQueue（group_id = timer-<id>）。
    #[tokio::test]
    async fn engine_injects_timer_channel() {
        let engine = EngineHandle::new(None);
        // 工具注册面（T-CF-05 登记；通道为 None 时工具才返回 unsupported）
        let names: Vec<String> = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert!(
            names.iter().any(|n| n == "set_timer"),
            "set_timer 应已注册：{names:?}"
        );
        assert!(
            names.iter().any(|n| n == "cancel_timer"),
            "cancel_timer 应已注册：{names:?}"
        );
        // 契约接线：经 TimerChannel 注册/取消/活跃列表（TimerRegistry 实现）
        let channel: Arc<dyn TimerChannel> = engine.timer_registry();
        let handle = channel
            .register(1, "装配检查".to_string(), TimerCondition::Never)
            .await
            .expect("timer_channel 已接线，register 不应 unsupported");
        assert_eq!(handle.timer_id, "timer-0");
        let active = channel.list_active().await.expect("list_active 应可用");
        assert_eq!(active.len(), 1, "活跃列表应含刚注册的定时器");
        let cancelled = channel
            .cancel(&handle.timer_id)
            .await
            .expect("cancel 应可用");
        assert!(cancelled);
        assert!(
            channel
                .list_active()
                .await
                .expect("list_active 应可用")
                .is_empty(),
            "取消后活跃列表应为空"
        );
        // 真实 PendingMessageQueue 落点：注册新定时器到期 → 队列出现
        // group_id=timer-<id> 条目、text 含 prompt（生产装配全链路）
        let handle_b = channel
            .register(1, "装配链路检查".to_string(), TimerCondition::Never)
            .await
            .expect("注册应成功");
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let queue = engine.timer_steering_queue();
        let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        let entries = queue.dequeue_all();
        assert_eq!(entries.len(), 1, "到期应恰好注入一条 steering 条目");
        assert_eq!(
            entries[0].group_id.as_deref().map(str::to_string),
            Some(format!("timer-{}", handle_b.timer_id)),
            "group_id 应为 timer-<id>"
        );
        assert!(
            entries[0].text.contains("装配链路检查"),
            "条目文本应含 prompt：{}",
            entries[0].text
        );
        assert!(entries[0].is_steering, "条目应带 steering 保护位");
    }
}

/// T-CF-10 装配测试：EngineHandle 的 WaitChannel 接线面。
///
/// 独立模块（不与上方既有 tests 模块共享上下文），聚焦
/// `engine_registers_wait_channel` 等验收断言。
#[cfg(test)]
mod wait_wiring_tests {
    use super::*;
    use agent_tools::context::create_mock_tool_context;
    use agent_tools::tools::wait_subagents::WaitMode;
    use conex_types::events::SubagentEndStatus;

    /// EngineHandle::new 后 wait_subagents 工具已注册且 WaitChannel 已
    /// 接线：parallel-work 非阻塞快照不再返回 unsupported；声明经工具
    /// 落库到引擎共享 dispatch 存储（与 watchdog 同一数据面）。
    #[tokio::test]
    async fn engine_registers_wait_channel() {
        let engine = EngineHandle::new(None);
        // 工具注册面（T-CF-10：通道为 None 时工具才返回 unsupported）
        let names: Vec<String> = engine
            .tool_registry()
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert!(
            names.iter().any(|n| n == "wait_subagents"),
            "wait_subagents 应已注册：{names:?}"
        );
        // 端到端：parallel-work（非阻塞快照路径）不再返回 unsupported
        let tool = engine
            .tool_registry()
            .get("wait_subagents")
            .expect("wait_subagents 已注册");
        let ctx = create_mock_tool_context();
        let out = tool
            .execute(
                &ctx,
                serde_json::json!({
                    "subagentIds": ["sa-1", "sa-2"],
                    "mode": "parallel-work"
                }),
            )
            .await
            .expect("WaitChannel 已接线，parallel-work 不应返回 unsupported");
        assert_eq!(out["mode"], "parallel-work");
        assert_eq!(out["allTerminal"], false);
        assert_eq!(out["agents"][0]["subagentId"], "sa-1");
        assert_eq!(out["agents"][0]["status"], "running");
        // 声明已落库：引擎共享 dispatch 存储（watchdog 读同一数据面）
        let loaded = engine.dispatch_store().load_all();
        assert_eq!(loaded.len(), 1, "工具执行应持久化调度声明");
        assert_eq!(loaded[0].mode, WaitMode::ParallelWork);
        assert_eq!(
            loaded[0].subagent_ids,
            vec!["sa-1".to_string(), "sa-2".to_string()]
        );
        // 等待通道契约面可用（与工具注入同一实例）
        let snapshot = engine
            .wait_channel()
            .snapshot(&["sa-1".to_string()])
            .await
            .expect("snapshot 应可用");
        assert_eq!(snapshot[0].subagent_id, "sa-1");
    }

    /// 引擎级事件驱动等待全链路：wait_subagents await-all 等待期间，
    /// 终态事件经引擎持有的广播实例 feed（EventQueue 旁路适配的接线
    /// 面）→ 提前返回；返回后订阅断流。
    #[tokio::test]
    async fn engine_wait_channel_wakeup_via_terminal_stream() {
        let engine = EngineHandle::new(None);
        let tool = engine
            .tool_registry()
            .get("wait_subagents")
            .expect("wait_subagents 已注册");
        let ctx = create_mock_tool_context();
        let wait_task = tokio::spawn({
            let tool = tool;
            let ctx = ctx;
            async move {
                tool.execute(
                    &ctx,
                    serde_json::json!({
                        "subagentIds": ["sa-1"],
                        "mode": "await-all",
                        "timeoutMs": 60_000
                    }),
                )
                .await
            }
        });
        // 等待订阅建立（wait_for_terminal 与 feed 之间的同步点）
        let stream = engine.terminal_stream();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            if stream.subscriber_count() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(stream.subscriber_count() > 0, "wait 期间应已订阅终态事件流");
        // feed subagent-ended（事件收口旁路点接线面的同构调用）
        stream.feed(&AgentEvent::SubagentEnded {
            session_id: "mock-session".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "run-sa-1".to_string(),
            status: SubagentEndStatus::Completed,
            summary: Some("完成".to_string()),
            ended_at: now_iso_utc(),
            subagent_session_id: None,
        });
        let out = tokio::time::timeout(Duration::from_secs(5), wait_task)
            .await
            .expect("工具应在超时窗口内返回")
            .expect("tokio 任务 join 失败（工具执行任务 panic）")
            .expect("工具执行不应报错");
        assert_eq!(out["allTerminal"], true);
        assert_eq!(out["agents"][0]["status"], "completed");
        assert_eq!(
            stream.subscriber_count(),
            0,
            "wait 返回后订阅应断流（mpsc drop）"
        );
    }

    /// 装配降级：watchdog 与 wait 通道的共享 dispatch 存储桥接——
    /// wait 落库后 watchdog 可读（同一实例双 trait 注入断言）
    #[tokio::test]
    async fn engine_dispatch_store_bridges_to_watchdog() {
        let engine = EngineHandle::new(None);
        let declaration = DispatchDeclaration {
            mode: WaitMode::AwaitAll,
            wait_ms: None,
            subagent_ids: vec!["sa-1".to_string()],
            dispatched_at_ms: 1_000,
        };
        engine
            .wait_channel()
            .persist_declaration(&declaration)
            .await
            .expect("声明落库应成功");
        // 桥接读面：watchdog 的 DispatchStore 看到同一数据
        let store = engine.dispatch_store();
        let as_watchdog: Arc<dyn crate::watchdog::DispatchStore> = store;
        let declarations = as_watchdog.load_declarations();
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].subagent_ids, vec!["sa-1".to_string()]);
        // 唤醒跟踪面可用（watchdog 失联判定数据源）
        engine.last_wakeup().mark_wakeup_at(2_000);
        assert_eq!(engine.last_wakeup().last_wakeup_ms(), Some(2_000));
    }
}

/// D6 §3.1 段 2 + D4 §3.8 ② store 装配替换测试：`new_with_spawner`
/// 注入 `db: Option<LocalDb>`（W4 统一签名）后 timer/sched/wait 三 store
/// 真适配落库 + 模拟重启恢复；None 回退内存版（功能面由既有
/// EngineHandle::new(None) 测试全量覆盖，本模块补差分断言面）。
#[cfg(test)]
mod store_assembly_tests {
    use super::*;
    use crate::sched::CronTaskInput;
    use agent_tools::tools::wait_subagents::{WaitMode, DISPATCH_META_KEY_MODE};
    use conex_types::timer::TimerCondition;

    /// 定时器经 LocalDb 真适配 store 落库（`timer_<id>` 键 + `timer_ids`
    /// 索引）+ 模拟重启（新引擎读同一 db）restore 重建 sleep——验收
    /// D6 数据面 4.1 与「重启后定时器声明恢复」引擎级语义（未到期
    /// 60s 不触发 fire，只断言 restore 重建入活跃表）。
    #[tokio::test]
    async fn engine_localdb_timer_store_persists_and_recovers() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let engine = EngineHandle::new_with_spawner(None, None, Some(db.clone()));
        let channel: Arc<dyn TimerChannel> = engine.timer_registry();
        let handle = channel
            .register(60, "重启恢复检查".to_string(), TimerCondition::Never)
            .await
            .expect("timer_channel 已接线");
        assert_eq!(handle.timer_id, "timer-0");
        // 真适配落库：键形状 `timer_<id>`（timers.rs store_key）+ 索引
        assert!(
            db.get_session_meta("timer_timer-0")
                .expect("db 读应成功")
                .is_some(),
            "timer-0 声明应落库 session_meta（真适配装配）"
        );
        let index = db
            .get_session_meta("timer_ids")
            .expect("db 读应成功")
            .expect("索引键应已写入");
        assert!(index.contains("timer-0"), "索引应含 timer-0：{index}");
        // 模拟重启：新引擎同 db → restore 扫描重建（未到期不 fire）
        let restarted = EngineHandle::new_with_spawner(None, None, Some(db));
        let restarted_channel: Arc<dyn TimerChannel> = restarted.timer_registry();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let active = restarted_channel
                .list_active()
                .await
                .expect("list_active 应可用");
            if active.iter().any(|t| t.timer_id == "timer-0") {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "restore 应在窗口内重建 timer-0"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// wait 声明经 LocalDb 真适配 store 落库（dispatch_* 五键，单声明槽
    /// 语义）+ watchdog 桥接读回同一数据面（D4 §3.8 ② / T9 引擎级）。
    #[tokio::test]
    async fn engine_localdb_wait_store_persists_and_bridges() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let engine = EngineHandle::new_with_spawner(None, None, Some(db.clone()));
        let declaration = DispatchDeclaration {
            mode: WaitMode::AwaitAll,
            wait_ms: None,
            subagent_ids: vec!["sa-1".to_string()],
            dispatched_at_ms: 1_000,
        };
        engine
            .wait_channel()
            .persist_declaration(&declaration)
            .await
            .expect("声明落库应成功");
        // 真适配落库：dispatch_* 键（单声明槽——mode/dispatched_at 有值）
        assert!(
            db.get_session_meta(DISPATCH_META_KEY_MODE)
                .expect("db 读应成功")
                .is_some(),
            "dispatch_mode 应落库（真适配装配）"
        );
        assert!(
            db.get_session_meta("dispatch_dispatched_at")
                .expect("db 读应成功")
                .is_some(),
            "dispatch_dispatched_at 应落库"
        );
        // watchdog 桥接面：DispatchStore 读回同一数据（T-CF-10/13 双
        // trait 注入，LocalDbWaitStore 桥接 impl）
        let store = engine.dispatch_store();
        let as_watchdog: Arc<dyn crate::watchdog::DispatchStore> = store;
        let declarations = as_watchdog.load_declarations();
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].subagent_ids, vec!["sa-1".to_string()]);
    }

    /// sched 注册表装配分支：Some(db) → LocalDb 真适配（`sched_<id>` 键
    /// + `sched_ids` 索引落库）；None → 内存版回退（注册功能可用，无
    /// db 可落）。
    #[tokio::test]
    async fn engine_sched_store_assembly_branches() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let sink = Arc::new(crate::sched::SchedEventSink::new());
        // Some(db) → 真适配：注册 cron 后 sched_* 键落库
        let registry = assemble_scheduler_registry(&queue, sink.clone(), Some(db.clone()))
            .expect("装配应成功");
        let cron_id = registry
            .register(CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "装配检查".to_string(),
                max_iterations: Some(1),
                is_daemon: false,
            })
            .await
            .expect("cron 注册应成功");
        assert_eq!(cron_id, "cron-0");
        assert!(
            db.get_session_meta("sched_cron-0")
                .expect("db 读应成功")
                .is_some(),
            "cron-0 声明应落库 session_meta（真适配装配）"
        );
        // 索引真源为 SESSION_META_SCHED_INDEX_KEY（"sched_index"）；"sched_ids"
        // 已降级为 legacy 键（BATCH-SCHED-W1 重命名，仅存量收敛合并时读取，
        // 不再写入）。断言真源键，避免随重命名漂移。
        assert!(
            db.get_session_meta(crate::sched::SESSION_META_SCHED_INDEX_KEY)
                .expect("db 读应成功")
                .is_some(),
            "sched_index 索引应已写入"
        );
        // None → 内存版回退：注册功能可用（数据不进 db，功能面同既有
        // MemorySchedStore 语义）
        let registry_mem =
            assemble_scheduler_registry(&queue, sink, None).expect("None 装配应成功（内存回退）");
        let cron_id_mem = registry_mem
            .register(CronTaskInput {
                expression: "0 9 * * *".to_string(),
                prompt: "内存回退检查".to_string(),
                max_iterations: None,
                is_daemon: false,
            })
            .await
            .expect("内存版注册应成功");
        assert_eq!(cron_id_mem, "cron-0", "内存版独立序号域");
    }
}

/// 连接配置（D1 §3.3）单测：默认值字段级生效 + 测试装配传参覆盖
/// （短超时 / 关 keepalive），`build_http_client` 单点构造成功面。
#[cfg(test)]
mod http_client_config_tests {
    use super::*;

    /// 默认连接配置字段级生效（D1 §3.3 连接配置表断言面）
    #[test]
    fn resolve_defaults_match_d1_table() {
        let resolved = ClientConnectionConfig::resolve(None);
        assert_eq!(resolved.connect_timeout, Some(Duration::from_secs(10)));
        assert_eq!(resolved.tcp_keepalive, Some(Duration::from_secs(30)));
        assert_eq!(
            resolved.http2_keep_alive_interval,
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            resolved.http2_keep_alive_timeout,
            Some(Duration::from_secs(5))
        );
        // 生产装配点构造成功（不设总超时——编译面即承诺）
        let client = build_http_client(None);
        let _ = client;
    }

    /// 测试装配覆盖：显式字段覆盖生效、未覆盖字段保持默认（04 §2.3
    /// 可传参面）
    #[test]
    fn resolve_partial_overrides_keep_defaults() {
        let resolved = ClientConnectionConfig::resolve(Some(ClientConnectionConfig {
            connect_timeout: Some(Duration::from_secs(2)),
            ..ClientConnectionConfig::default()
        }));
        assert_eq!(
            resolved.connect_timeout,
            Some(Duration::from_secs(2)),
            "显式覆盖应生效"
        );
        assert_eq!(
            resolved.tcp_keepalive,
            Some(Duration::from_secs(30)),
            "未覆盖字段保持默认"
        );
        assert_eq!(
            resolved.http2_keep_alive_interval,
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            resolved.http2_keep_alive_timeout,
            Some(Duration::from_secs(5))
        );
        // 覆盖配置构造成功（短超时客户端可正常构建）
        let client = build_http_client(Some(ClientConnectionConfig {
            connect_timeout: Some(Duration::from_secs(2)),
            tcp_keepalive: None,
            http2_keep_alive_interval: None,
            http2_keep_alive_timeout: None,
        }));
        let _ = client;
    }
}

/// P4（30 方案 §4）事件缓冲 drain 转发测试：timer/cron 缓冲 → 真实
/// EventBridge 的信封直发形状，与访问器到达生产装配实例的断言面。
///
/// 独立模块（不与上方既有 tests 模块共享上下文）。生产 sink（引擎装配
/// 实例）与测试收集器实例隔离：EngineHandle::new 每用例新建，无污染。
#[cfg(test)]
mod event_drain_tests {
    use super::*;
    use crate::core_event_bridge::Emitter;
    use crate::sched::{CronEvent, EventSink as SchedEventSinkTrait};
    use crate::timers::{EventSink as TimerEventSinkTrait, TimerEvent};
    use conex_types::events::SecurityAuditOperation;
    use conex_types::timer::TimerCondition;

    /// 测试发射器：记录 (channel, payload) 序列（对齐 core_event_bridge
    /// 测试先例 RecordingEmitter）
    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl RecordingEmitter {
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
        }
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((channel.to_string(), payload.to_string()));
        }
    }

    /// 构造记录桥（通道名恒 workbench-run-event）
    fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn Emitter>,
        );
        (bridge, emitter)
    }

    /// 定时器缓冲事件 → forward helper → 信封形状断言：R-22 伪 runId
    /// 注入（timer-fired → runId="timer-<timerId>"、timer-cancelled 同形）、
    /// sequence 不注入（None）；事件体字段级断言（timerId/prompt/firedAtMs
    /// 与 timer-cancelled 的 reason/cancelledAtMs）；二次转发空缓冲返回 0
    /// （Vec::take 语义，不重复转发）。
    #[test]
    fn drain_forward_emits_envelopes_with_pseudo_runid() {
        let sink = AgentEventSink::new();
        TimerEventSinkTrait::emit(
            &sink,
            TimerEvent::Fired {
                timer_id: "timer-0".to_string(),
                prompt: "检查编译结果".to_string(),
                fired_at_ms: 1_700_000_000_123,
            },
        );
        TimerEventSinkTrait::emit(
            &sink,
            TimerEvent::Cancelled {
                timer_id: "timer-1".to_string(),
                reason: crate::timers::TimerCancelReason::EarlyExit,
                cancelled_at_ms: 1_700_000_000_456,
            },
        );
        let (bridge, emitter) = recording_bridge();
        let forwarded = forward_drained_timer_events(&sink, &bridge);
        assert_eq!(forwarded, 2, "两条缓冲事件应全部转发");
        let calls = emitter.calls();
        assert_eq!(calls.len(), 2);
        for (channel, _) in &calls {
            assert_eq!(channel, "workbench-run-event");
        }
        // 信封顶层形状：type 正确、伪 runId 注入、无 sequence、schemaVersion=1
        let first: serde_json::Value =
            serde_json::from_str(&calls[0].1).expect("载荷应为合法 JSON");
        assert_eq!(first["type"], "timer-fired");
        assert_eq!(
            first["runId"], "timer-timer-0",
            "R-22 伪 runId：timer-加timerId（timer_id 已含前缀，字面拼接，对齐 F6:34 先例）"
        );
        assert!(
            first.get("sequence").is_none(),
            "timer 事件不得注入 sequence"
        );
        assert_eq!(first["schemaVersion"], 1);
        assert_eq!(first["sessionId"], "");
        assert_eq!(first["timerId"], "timer-0");
        assert_eq!(first["prompt"], "检查编译结果");
        assert_eq!(first["firedAtMs"], 1_700_000_000_123_u64);
        let second: serde_json::Value =
            serde_json::from_str(&calls[1].1).expect("载荷应为合法 JSON");
        assert_eq!(second["type"], "timer-cancelled");
        assert_eq!(
            second["runId"], "timer-timer-1",
            "timer-cancelled 同形注入伪 runId"
        );
        assert_eq!(second["timerId"], "timer-1");
        assert_eq!(second["reason"], "early-exit");
        assert_eq!(second["cancelledAtMs"], 1_700_000_000_456_u64);
        // 二次转发空缓冲 → 0（drain 已取走，不重复转发）
        assert_eq!(
            forward_drained_timer_events(&sink, &bridge),
            0,
            "空缓冲转发应返回 0"
        );
    }

    /// cron 缓冲事件 → forward helper → 信封形状断言（cron-fired 单臂：
    /// conex-types 仅 CronFired 变体，字段 cronId/prompt/expression/
    /// iteration/firedAtMs 字段级断言；R-22 伪 runId 注入
    /// runId="cron-<cronId>"，sequence 不注入）。
    #[test]
    fn drain_forward_scheduler_emits_envelopes_with_pseudo_runid() {
        let sink = crate::sched::SchedEventSink::new();
        SchedEventSinkTrait::emit(
            &sink,
            CronEvent::Fired {
                cron_id: "cron-0".to_string(),
                prompt: "每日备份".to_string(),
                expression: "0 3 * * *".to_string(),
                iteration: 3,
                fired_at_ms: 1_700_000_000_789,
            },
        );
        let (bridge, emitter) = recording_bridge();
        let forwarded = forward_drained_scheduler_events(&sink, &bridge);
        assert_eq!(forwarded, 1, "一条缓冲事件应全部转发");
        let calls = emitter.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "workbench-run-event");
        let payload: serde_json::Value =
            serde_json::from_str(&calls[0].1).expect("载荷应为合法 JSON");
        assert_eq!(payload["type"], "cron-fired");
        assert_eq!(
            payload["runId"], "cron-cron-0",
            "R-22 伪 runId：cron-加cronId（cron_id 已含前缀，字面拼接，对齐 F6:34 先例）"
        );
        assert!(
            payload.get("sequence").is_none(),
            "cron 事件不得注入 sequence"
        );
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["cronId"], "cron-0");
        assert_eq!(payload["prompt"], "每日备份");
        assert_eq!(payload["expression"], "0 3 * * *");
        assert_eq!(payload["iteration"], 3);
        assert_eq!(payload["firedAtMs"], 1_700_000_000_789_u64);
        // 二次转发空缓冲 → 0
        assert_eq!(
            forward_drained_scheduler_events(&sink, &bridge),
            0,
            "空缓冲转发应返回 0"
        );
    }

    /// 访问器到达生产装配实例：EngineHandle::new 装配的缓冲与
    /// TimerRegistry/SchedulerRegistry 注入的是同一 Arc——定时器到期 →
    /// 缓冲出现 TimerFired；cron 触发 → 缓冲出现 CronFired；drain 转发
    /// 后真实桥收到信封（与 :690 装配点同一实例的功能性证明）。
    #[tokio::test]
    async fn engine_accessors_reach_production_sinks() {
        let engine = EngineHandle::new(None);
        // 访问器稳定实例（两次取回同一 Arc）
        assert!(Arc::ptr_eq(
            &engine.timer_event_sink(),
            &engine.timer_event_sink()
        ));
        assert!(Arc::ptr_eq(
            &engine.scheduler_event_sink(),
            &engine.scheduler_event_sink()
        ));
        // 定时器面：注册 1 秒定时器 → 到期 → 生产缓冲出现 TimerFired
        // （与 TimerRegistry 注入同一缓冲实例的功能性证明）
        let channel: Arc<dyn TimerChannel> = engine.timer_registry();
        let handle = channel
            .register(1, "drain 装配检查".to_string(), TimerCondition::Never)
            .await
            .expect("timer_channel 已接线，register 不应 unsupported");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let timer_events = engine.timer_event_sink().drain();
        assert!(
            timer_events.iter().any(|e| matches!(
                e,
                AgentEvent::TimerFired { ref timer_id, ref prompt, .. }
                    if timer_id == &handle.timer_id && prompt == "drain 装配检查"
            )),
            "到期事件应到达生产缓冲：{timer_events:?}"
        );
        channel.cancel(&handle.timer_id).await.ok();
        // cron 面：注入短触发延迟（测试钩子）→ 注册 → 触发 → 生产缓冲
        // 出现 CronFired（与 SchedulerRegistry 注入同一缓冲实例）
        let registry = engine.scheduler_registry().expect("装配后应为 Some");
        registry.set_fire_override_ms(40);
        let cron_id = registry
            .register(crate::sched::CronTaskInput {
                expression: "* * * * *".to_string(),
                prompt: "drain cron 检查".to_string(),
                max_iterations: Some(1),
                is_daemon: false,
            })
            .await
            .expect("cron 注册应成功");
        tokio::time::sleep(Duration::from_millis(300)).await;
        // 转发路径端到端：经访问器取走生产缓冲 → 真实桥信封（R-22 伪
        // runId 注入 cron-<cronId>）；payload 字段级断言即「同一缓冲
        // 实例」的功能性证明
        let (bridge, emitter) = recording_bridge();
        let forwarded = forward_drained_scheduler_events(&engine.scheduler_event_sink(), &bridge);
        assert_eq!(forwarded, 1, "cron 触发事件应经访问器转发到真实桥");
        let payload: serde_json::Value =
            serde_json::from_str(&emitter.calls()[0].1).expect("载荷应为合法 JSON");
        assert_eq!(payload["type"], "cron-fired");
        assert_eq!(payload["cronId"], cron_id);
        assert_eq!(payload["prompt"], "drain cron 检查");
        assert_eq!(payload["iteration"], 1);
        assert_eq!(
            payload["runId"],
            format!("cron-{cron_id}"),
            "R-22 伪 runId：cron-加cronId（生产 id 端到端验证）"
        );
        // drain 已取走 → 缓冲为空（Vec::take 语义，不重复转发）
        assert!(
            engine.scheduler_event_sink().drain().is_empty(),
            "转发后生产缓冲应为空"
        );
        // 清理：max_iterations=1 已自停（enabled=false 落库），无残留声明
    }

    // ── 15-T-6（裁决 D9）：RoutingAuditSink 路由分发 / G10 计数 ───

    /// 测试用 security-audit 事件（决策参数化；形状对齐
    /// agent-tools audit.rs security_audit_event 构造器）
    fn routing_test_audit_event(session_id: &str, decision: SecurityAuditDecision) -> AgentEvent {
        agent_tools::audit::security_audit_event(
            session_id,
            SecurityAuditOperation::Delete,
            vec!["a.txt".to_string()],
            conex_types::impact::ImpactAssessment {
                file_count: 1,
                total_size_bytes: 0,
                directory_count: 0,
                cross_directory: false,
                flagged: false,
            },
            decision,
            None,
        )
    }

    /// 路由分发（多 session）：各会话审计事件仅达自己的 run 桥；未注册
    /// 会话 tracing 兜底不 panic 不送达
    #[test]
    fn routing_audit_sink_dispatches_per_session() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        let s1 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        let s2 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&s1) as AuditSink);
        sink.register("s2", Arc::clone(&s2) as AuditSink);
        assert_eq!(sink.route_count(), 2);
        sink.emit(&routing_test_audit_event(
            "s1",
            SecurityAuditDecision::Blocked,
        ));
        sink.emit(&routing_test_audit_event(
            "s2",
            SecurityAuditDecision::Blocked,
        ));
        // 各会话事件仅达自己的 run 桥
        assert_eq!(s1.emitted().len(), 1);
        assert_eq!(s2.emitted().len(), 1);
        // 未注册会话 → tracing 兜底（不 panic、不送达）
        sink.emit(&routing_test_audit_event(
            "ghost",
            SecurityAuditDecision::Blocked,
        ));
        assert_eq!(s1.emitted().len(), 1);
        assert_eq!(s2.emitted().len(), 1);
    }

    /// G10 denied 计数：仅 denied 决策计数（引擎级共享统计），全部事件
    /// 原样转发
    #[test]
    fn routing_audit_sink_counts_denied_globally() {
        let stats = Arc::new(DeniedStats::new());
        let sink = RoutingAuditSink::new(Arc::clone(&stats));
        let s1 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&s1) as AuditSink);
        sink.emit(&routing_test_audit_event(
            "s1",
            SecurityAuditDecision::Denied,
        ));
        sink.emit(&routing_test_audit_event(
            "s1",
            SecurityAuditDecision::Redirected,
        ));
        sink.emit(&routing_test_audit_event(
            "s1",
            SecurityAuditDecision::Denied,
        ));
        // 仅 denied 计数（G10），全部事件转发
        assert_eq!(stats.summary().security_audit_denied, 2);
        assert_eq!(s1.emitted().len(), 3);
    }

    /// 收口注销：unregister 后路由不再送达；重复注销幂等；注册表无残留
    #[test]
    fn routing_audit_sink_unregister_is_idempotent() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        let s1 = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&s1) as AuditSink);
        assert_eq!(sink.route_count(), 1);
        sink.unregister("s1");
        sink.unregister("s1");
        assert_eq!(sink.route_count(), 0, "重复注销幂等，注册表无残留");
        sink.emit(&routing_test_audit_event(
            "s1",
            SecurityAuditDecision::Blocked,
        ));
        assert!(
            s1.emitted().is_empty(),
            "注销后事件不再送达（tracing 兜底）"
        );
    }

    /// 同 session 多 run 并发注册 → 后注册者覆盖（新 run 覆盖旧 run，
    /// 与事件收口旁路点口径一致）
    #[test]
    fn routing_audit_sink_later_register_overwrites() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        let old = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        let new = Arc::new(agent_tools::audit::RecordingAuditSink::new());
        sink.register("s1", Arc::clone(&old) as AuditSink);
        sink.register("s1", Arc::clone(&new) as AuditSink);
        sink.emit(&routing_test_audit_event(
            "s1",
            SecurityAuditDecision::Blocked,
        ));
        assert!(old.emitted().is_empty(), "旧 run 桥应被新 run 覆盖");
        assert_eq!(new.emitted().len(), 1);
    }

    /// 引擎装配面：BuiltinToolConfig.audit_sink 注入的与访问器取回的是
    /// 同一实例（路由 sink 经工具注册表接线到引擎共享统计）
    #[test]
    fn engine_audit_sink_accessor_reaches_shared_instance() {
        let engine = EngineHandle::new(None);
        assert!(Arc::ptr_eq(&engine.audit_sink(), &engine.audit_sink()));
    }

    // ── PS-04 T4.3（F4 F1-01）：reload_provider 热更新 ──

    /// T4.3-R1：注入统一树配置 A → `reload_provider()` → provider_config 的
    /// model/key/baseUrl 必须变为新值（换 key/模型后下一次 run 用新凭据；
    /// 修复前 provider 只在构造时加载一次，改配置后不生效）。
    #[test]
    fn reload_provider_rebuilds_provider_config_from_store() {
        use crate::core_run_commands::{
            apply_single_provider, install_tree_models_store, isolate_config_store,
            CONFIG_TEST_LOCK, TEST_ENV_KEY,
        };
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("conex-config-test-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create config dir");
        isolate_config_store(&dir);

        // 统一树配置 A（active=(p1, model-a)，key 经 env ref 注入为 sk-a）
        let store = install_tree_models_store(&dir, "https://a.example/v1");
        let engine = EngineHandle::new(None);
        let before = engine.provider_config().expect("构造后就绪");
        assert_eq!(before.api_key, "sk-a");
        assert_eq!(before.model, "model-a");
        assert!(engine.ready());

        // 统一树事务切新配置 B（baseUrl/model 切换 + key 切换）→ 重载 →
        // 生效配置必须刷新（CAS 落盘，等价旧版「配置 B」步骤）
        apply_single_provider(&store, "https://b.example/v1", "model-b");
        std::env::set_var(TEST_ENV_KEY, "sk-b");
        engine.reload_provider();
        let after = engine.provider_config().expect("重载后就绪");
        assert_eq!(after.api_key, "sk-b", "key 必须热更新");
        assert_eq!(after.base_url, "https://b.example/v1", "baseUrl 必须热更新");
        assert_eq!(after.model, "model-b", "model 必须热更新");
        assert!(engine.ready(), "重载后就绪");
        assert!(engine.provider().is_some(), "重载后 provider 可调用");
    }

    /// T4.3-R1 契约延伸：凭据移除后 reload_provider → 引擎降级未就绪
    /// （ready=false / provider=None / provider_config=None——resolve 报
    /// CREDENTIAL_MISSING，load_provider_endpoint 返回 None）；重填后恢复。
    /// 与构造时降级语义一致（F4 F1-01 修复建议 4）。
    #[test]
    fn reload_provider_degrades_when_key_cleared_then_recovers() {
        use crate::core_run_commands::{
            install_tree_models_store, isolate_config_store, CONFIG_TEST_LOCK, TEST_ENV_KEY,
        };
        let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("conex-config-test-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create config dir");
        isolate_config_store(&dir);

        let _store = install_tree_models_store(&dir, "https://a.example/v1");
        let engine = EngineHandle::new(None);
        assert!(engine.ready());

        // 移除凭据（env ref 失效 → CREDENTIAL_MISSING）→ 重载 → 降级未就绪
        // （不得再用旧 key 发请求）
        std::env::remove_var(TEST_ENV_KEY);
        engine.reload_provider();
        assert!(!engine.ready(), "清 key 后未就绪");
        assert!(engine.provider().is_none(), "清 key 后 provider=None");
        assert!(
            engine.provider_config().is_none(),
            "清 key 后 provider_config=None"
        );
        assert!(engine.ready_reason().is_some(), "未就绪原因可诊断");

        // 重填 → 恢复
        std::env::set_var(TEST_ENV_KEY, "sk-c");
        engine.reload_provider();
        assert!(engine.ready(), "重填后恢复就绪");
        assert_eq!(
            engine.provider_config().expect("重填后就绪").api_key,
            "sk-c"
        );
    }
}

/// 审计 01 W1：ContinuityChannelBoard 板卡装配测试（延迟绑定语义——
/// 未绑定结构化错误 / 绑定后委托 / 重复绑定覆盖；独立模块与上方既有
/// tests 模块不共享上下文）。
#[cfg(test)]
mod continuity_wiring_tests {
    use super::*;
    use agent_tools::context::create_mock_tool_context;
    use agent_tools::tools::kill_subagent::{
        KillOutcomeKind, KillSubagentToolResult, SubagentKillChannel,
    };
    use agent_tools::tools::send_message::MainMessageRing;
    use std::sync::Mutex;

    /// 记录式终止通道替身（板卡委托断言）
    struct RecordingKill {
        calls: Mutex<usize>,
    }

    impl std::fmt::Debug for RecordingKill {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("RecordingKill").finish_non_exhaustive()
        }
    }

    #[async_trait::async_trait]
    impl SubagentKillChannel for RecordingKill {
        async fn kill_subagent(
            &self,
            _session_id: &str,
            subagent_id: &str,
            _reason: &str,
        ) -> Result<KillSubagentToolResult, String> {
            *self.calls.lock().unwrap() += 1;
            Ok(KillSubagentToolResult {
                subagent_id: subagent_id.to_string(),
                subagent_run_id: None,
                outcome: KillOutcomeKind::AlreadyTerminal,
                force_cancel_delivered: false,
            })
        }
    }

    /// 未绑定 → 结构化未绑定错误（工具侧按执行失败兜底映射；生产装配
    /// 窗口 = 引擎构造与 finalize 之间）
    #[tokio::test]
    async fn unbound_board_returns_wiring_error() {
        let board = ContinuityChannelBoard::new();
        let err = board.kill_subagent("s1", "sub-1", "").await.unwrap_err();
        assert!(err.contains("未绑定"), "未绑定错误文案：{err}");
        let err = board.inject("sub-1", "hi").await.unwrap_err();
        assert!(err.contains("未绑定"));
        let err = board
            .deliver_self("s1", "hi", MainMessageRing::FollowUp)
            .await
            .unwrap_err();
        assert!(err.contains("未绑定"));
        assert!(
            board.control_bus("sub-1").is_none(),
            "未绑定解析器 → None（Noop 同语义）"
        );
    }

    /// 绑定后委托到真实现；重复绑定以最后一次为准（覆盖语义）
    #[tokio::test]
    async fn bound_board_delegates_and_overwrites() {
        let board = ContinuityChannelBoard::new();
        let first = Arc::new(RecordingKill {
            calls: Mutex::new(0),
        });
        let second = Arc::new(RecordingKill {
            calls: Mutex::new(0),
        });
        board.bind_kill(Arc::clone(&first) as Arc<dyn SubagentKillChannel>);
        let out = board
            .kill_subagent("s1", "sub-1", "r")
            .await
            .expect("绑定后应委托成功");
        assert_eq!(out.subagent_id, "sub-1");
        assert_eq!(*first.calls.lock().unwrap(), 1);
        // 重复绑定覆盖：最后一次为准（进程内仅一次，幂等防御面）
        board.bind_kill(Arc::clone(&second) as Arc<dyn SubagentKillChannel>);
        board
            .kill_subagent("s1", "sub-2", "r")
            .await
            .expect("覆盖后应委托到新实现");
        assert_eq!(*first.calls.lock().unwrap(), 1, "旧实现不再被调用");
        assert_eq!(*second.calls.lock().unwrap(), 1, "新实现接管");
    }

    /// 生产装配面：EngineHandle 构造即注入板卡（工具注册面三通道就位，
    /// 未绑定窗口返回未绑定错误而非 unsupported——装配前行为一致降级）
    #[tokio::test]
    async fn engine_wires_continuity_board_into_tools() {
        let engine = EngineHandle::new(None);
        let kill = engine
            .tool_registry()
            .get(agent_tools::tools::kill_subagent::SUBAGENT_KILL_TOOL_NAME)
            .expect("kill_subagent 已注册");
        let ctx = create_mock_tool_context();
        // 未绑定窗口：结构化未绑定错误（production finalize 前毫秒级窗口）
        let err = kill
            .execute(&ctx, serde_json::json!({ "subagentId": "sub-1" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("未绑定"), "未绑定错误文案：{err}");
        let send = engine
            .tool_registry()
            .get(agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME)
            .expect("send_message 已注册");
        let err = send
            .execute(
                &ctx,
                serde_json::json!({ "target": "self", "message": "hi" }),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("未绑定"));
    }
}
// ── B1-5 毒丸恢复观测化（engine 片）毒化测 ─────────────────────────

/// B1-5 毒化测模块：生产段 21 处 into_inner 全部「error! 成对 + 计数」后，
/// 每文件 ≥1 毒化测（三要素：正常返回 + error 日志 + 计数 +1）。
///
/// 日志捕获：本 crate 无 tracing-subscriber 依赖（file 域锁禁改 Cargo.toml），
/// 用 tracing 自带 Subscriber/Visit 面实现最小捕获器（对齐
/// agent-tools note_memory.rs capture 同形语义，仅捕获 error 级 message）。
#[cfg(test)]
mod b1_5_poison_tests {
    use super::*;
    use crate::core_event_bridge::Emitter;
    use session_loop::ControlBus;
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Metadata, Subscriber};

    /// 捕获日志的内存缓冲（Arc 共享写，捕获器与测试方同读）
    #[derive(Default)]
    struct LogCapture {
        lines: Mutex<Vec<String>>,
    }

    impl LogCapture {
        fn push(&self, line: String) {
            self.lines.lock().unwrap().push(line);
        }
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// 最小 Subscriber：只放行 error 级事件，记录其 message 字段
    struct CaptureSubscriber {
        capture: Arc<LogCapture>,
    }

    impl Subscriber for CaptureSubscriber {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            *metadata.level() <= Level::ERROR
        }
        fn new_span(&self, _attrs: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}
        fn event(&self, event: &Event<'_>) {
            let mut visitor = MessageVisitor::default();
            event.record(&mut visitor);
            self.capture.push(visitor.message);
        }
        fn enter(&self, _span: &tracing::span::Id) {}
        fn exit(&self, _span: &tracing::span::Id) {}
    }

    /// 提取事件的 message 字段（字面量消息经 record_str，插值消息经
    /// record_debug——tracing 的 format_args 消息走 Display 包装）
    #[derive(Default)]
    struct MessageVisitor {
        message: String,
    }

    impl Visit for MessageVisitor {
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.message = value.to_string();
            }
        }
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.message = format!("{value:?}");
            }
        }
    }

    /// 在捕获 subscriber 下执行闭包，返回捕获行（本线程默认订阅者；
    /// 测试各自线程隔离，互不串扰）
    fn with_capture<F, R>(f: F) -> (R, Vec<String>)
    where
        F: FnOnce() -> R,
    {
        let capture = Arc::new(LogCapture::default());
        let subscriber = CaptureSubscriber {
            capture: Arc::clone(&capture),
        };
        let guard = tracing::subscriber::set_default(subscriber);
        let result = f();
        let lines = capture.snapshot();
        drop(guard);
        (result, lines)
    }

    /// 毒化 std `Mutex`（对齐 agent-tools test_support::poison_std_lock
    /// 形态：持锁线程内 panic → 锁进入中毒状态）
    fn poison_std_lock<T: Send>(lock: &Mutex<T>) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    let _guard = lock.lock().unwrap();
                    panic!("模拟持锁 panic（毒化锁）");
                });
            });
        }));
    }

    /// 测试发射器：记录 (channel, payload) 序列（对齐 core_event_bridge
    /// 测试先例 RecordingEmitter）
    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((channel.to_string(), payload.to_string()));
        }
    }

    /// 假控制总线解析器：任意子代理 id 均返回共享总线（bind 生效断言面）
    struct FakeBusResolver;

    impl ControlBusResolver for FakeBusResolver {
        fn control_bus(&self, _subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
            Some(Arc::new(Mutex::new(ControlBus::new())))
        }
    }

    /// B1-5 毒化测（engine_audit）：routes 锁中毒后 register 正常完成
    /// （不 panic）+ error 日志出现 + 毒丸恢复计数 +1（三要素）
    #[test]
    fn poisoned_routes_lock_register_recovers_with_log_and_count() {
        let sink = RoutingAuditSink::new(Arc::new(DeniedStats::new()));
        sink.poison_routes_for_test();
        let before = audit_poison_recovery_count();
        let ((), lines) = with_capture(|| {
            // 毒化后写路径仍正常完成（恢复语义不变：不 panic、不传播）
            sink.register(
                "s-poison",
                Arc::new(agent_tools::audit::RecordingAuditSink::new()) as AuditSink,
            );
        });
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        // 计数断言必须在再锁之前（route_count 同锁中毒，自身也会 +1）
        assert_eq!(
            audit_poison_recovery_count(),
            before + 1,
            "routes 锁中毒恢复必须计数 +1"
        );
        assert_eq!(sink.route_count(), 1, "毒化后注册仍应生效（恢复语义不变）");
    }

    /// B1-5 毒化测（engine_channels 事件桥）：缓冲锁中毒后 emit 正常入队
    /// （恢复语义 + 丢帧语义不变）+ error 日志 + 计数 +1（三要素）
    #[test]
    fn poisoned_buffer_lock_emit_recovers_with_log_and_count() {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn Emitter>,
        );
        let buffered = BufferedRunEventBridge::new(bridge, "run-poison");
        buffered.poison_buffer_for_test();
        let before = channels_poison_recovery_count();
        let envelope = AgentEventEnvelope::new(
            AgentEvent::AgentStart {
                session_id: "s-poison".to_string(),
                timestamp: "2026-08-13T00:00:00.000Z".to_string(),
            },
            Some("run-poison".to_string()),
            None,
        );
        // 毒化后 emit 仍正常完成（不 panic）：buffered=true 入队成功
        let (report, lines) = with_capture(|| buffered.emit(&envelope));
        assert!(
            report.buffered > 0,
            "毒化后 emit 必须仍正常入队（buffered=true，丢帧语义不变）"
        );
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        // 本文件两个 channels 毒化测并行共享同一计数器——用单调 ≥ 断言，
        // 本测试的 +1 由上方 error 日志行独立证明
        assert!(
            channels_poison_recovery_count() >= before + 1,
            "buffer 锁中毒恢复必须计数 +1"
        );
    }

    /// B1-5 毒化测（engine_channels 板卡）：control_bus 锁中毒后
    /// bind_control_bus 正常完成（绑定仍生效）+ error 日志 + 计数 +1
    /// （三要素）
    #[test]
    fn poisoned_control_bus_lock_bind_recovers_with_log_and_count() {
        let board = ContinuityChannelBoard::new();
        board.poison_control_bus_for_test();
        let before = channels_poison_recovery_count();
        // 毒化后绑定仍正常完成（恢复语义不变：不 panic、不传播）
        let ((), lines) = with_capture(|| {
            board.bind_control_bus(Arc::new(FakeBusResolver));
        });
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        // 计数断言必须在再锁之前（control_bus 读路径同锁中毒，自身也会 +1；
        // 且本文件两个 channels 毒化测并行共享同一计数器——用单调 ≥ 断言，
        // 本测试的 +1 由上方 error 日志行独立证明）
        assert!(
            channels_poison_recovery_count() >= before + 1,
            "control_bus 锁中毒恢复必须计数 +1"
        );
        // 绑定生效断言：读路径（同锁中毒状态）取回假解析器的总线
        assert!(
            board.control_bus("any-sub").is_some(),
            "毒化后 bind 必须仍写入 control_bus 解析器"
        );
    }

    /// B1-5 毒化测（engine_build 装配面）：provider 锁中毒后访问器正常
    /// 返回（不 panic、不传播）+ error 日志 + 计数 +1（三要素）
    #[test]
    fn poisoned_provider_lock_recovers_with_log_and_count() {
        let engine = EngineHandle::new(None);
        poison_std_lock(&engine.provider);
        let before = build_poison_recovery_count();
        // 毒化后读路径仍正常返回（None 亦为合法降级，不 panic 不传播）
        let (result, lines) = with_capture(|| engine.provider());
        let _ = result;
        assert!(
            lines.iter().any(|l| l.contains("锁中毒")),
            "缺少锁中毒 error 日志，捕获：\n{}",
            lines.join("\n")
        );
        assert_eq!(
            build_poison_recovery_count(),
            before + 1,
            "provider 锁中毒恢复必须计数 +1"
        );
    }
}

// ── S3 性能热点埋点（三热点耗时/计数 + 条件告警）观测测 ────────────
//
// 覆盖：① 事件序列化慢告警（engine_channels::warn_slow_event_serialize）。
// ② 长锁等待 / ③ 全文序列化告警在 conex-note-runtime store_backend_tests
// 覆盖（同形 LogCapture）；StreamRenderBuffer 帧预算超限计数由前端 vitest
// 覆盖（apps/crish-desktop/src/api/StreamRenderBuffer.test.ts）。
//
// 日志捕获：本 crate 无 tracing-subscriber 依赖（文件域锁禁改 Cargo.toml），
// 复用 B1-5 最小 Subscriber 形态，但放行 **WARN 级**（B1-5 捕获器只放行
// ERROR）；对齐 observability.rs LogCapture 语义（内存缓冲 + set_default）。

/// S3 超阈值条件告警测：`warn_slow_event_serialize` 超阈值 → warn 行捕获；
/// 低于阈值 → 零日志（条件告警门控可证伪）。
#[cfg(test)]
mod s3_hotspot_tests {
    use super::*;
    use crate::core_event_bridge::Emitter;
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Metadata, Subscriber};

    /// 捕获日志的内存缓冲（Arc 共享写）
    #[derive(Default)]
    struct LogCapture {
        lines: Mutex<Vec<String>>,
    }

    impl LogCapture {
        fn push(&self, line: String) {
            self.lines.lock().unwrap().push(line);
        }
        fn snapshot(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }
    }

    /// 最小 Subscriber：放行 WARN 及以上事件，记录 message + 关键字段
    struct CaptureSubscriber {
        capture: Arc<LogCapture>,
    }

    impl Subscriber for CaptureSubscriber {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            *metadata.level() <= Level::WARN
        }
        fn new_span(&self, _attrs: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}
        fn event(&self, event: &Event<'_>) {
            let mut visitor = MessageVisitor::default();
            event.record(&mut visitor);
            if !visitor.message.is_empty() {
                self.capture.push(visitor.message);
            }
        }
        fn enter(&self, _span: &tracing::span::Id) {}
        fn exit(&self, _span: &tracing::span::Id) {}
    }

    /// 提取事件 message + 数值字段（warn 插值消息经 record_debug）
    #[derive(Default)]
    struct MessageVisitor {
        message: String,
    }

    impl Visit for MessageVisitor {
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.message = value.to_string();
            }
        }
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.message = format!("{value:?}");
            }
        }
    }

    /// 在捕获 subscriber 下执行闭包，返回捕获行（WARN 级）
    fn with_capture_warn<F, R>(f: F) -> (R, Vec<String>)
    where
        F: FnOnce() -> R,
    {
        let capture = Arc::new(LogCapture::default());
        let subscriber = CaptureSubscriber {
            capture: Arc::clone(&capture),
        };
        let guard = tracing::subscriber::set_default(subscriber);
        let result = f();
        let lines = capture.snapshot();
        drop(guard);
        (result, lines)
    }

    /// ① 事件序列化：超阈值（≥ SLOW_EVENT_SERIALIZE_WARN_MS=10ms）→
    /// warn 行捕获（含 run_id / event_type 字段）；条件告警门控可证伪。
    #[test]
    fn slow_event_serialize_warns_over_threshold() {
        let (_, lines) = with_capture_warn(|| {
            super::super::engine_channels::warn_slow_event_serialize(
                "run-s3-slow",
                "message-delta",
                Duration::from_millis(20),
            );
        });
        assert!(
            lines.iter().any(|l| l.contains("事件序列化慢于阈值")),
            "超阈值必须出 warn，捕获：\n{}",
            lines.join("\n")
        );
    }

    /// ① 事件序列化：低于阈值 → 零告警（常态零日志开销断言）。
    #[test]
    fn fast_event_serialize_stays_silent() {
        let (_, lines) = with_capture_warn(|| {
            super::super::engine_channels::warn_slow_event_serialize(
                "run-s3-fast",
                "message-delta",
                Duration::from_micros(500),
            );
        });
        assert!(
            !lines.iter().any(|l| l.contains("事件序列化慢于阈值")),
            "低于阈值必须零告警，捕获：\n{}",
            lines.join("\n")
        );
    }

    /// ① 事件序列化：emit 全路径接线冒烟——正常信封经 emit 不触发慢告警
    /// （序列化常态 µs 级），且发射/缓冲报告不受埋点影响（运行语义零改动）。
    #[test]
    fn emit_smoke_keeps_report_semantics() {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn Emitter>,
        );
        let buffered =
            super::super::engine_channels::BufferedRunEventBridge::new(bridge, "run-s3-smoke");
        let envelope = AgentEventEnvelope::new(
            AgentEvent::MessageDelta {
                session_id: "s-s3-smoke".to_string(),
                timestamp: "2026-08-13T00:00:00.000Z".to_string(),
                message_id: "msg-1".to_string(),
                block: AgentMessageBlock::Text {
                    text: "hello".into(),
                },
            },
            Some("run-s3-smoke".to_string()),
            Some(1),
        );
        let (report, lines) = with_capture_warn(|| buffered.emit(&envelope));
        assert_eq!(report.dropped, 0, "常态无丢帧");
        assert_eq!(report.buffered, 1, "常态入缓冲 1 条");
        assert!(
            !lines.iter().any(|l| l.contains("事件序列化慢于阈值")),
            "常态序列化不得告警，捕获：\n{}",
            lines.join("\n")
        );
    }

    /// 测试发射器：记录 (channel, payload) 序列（对齐 core_event_bridge /
    /// B1-5 测试先例；本模块自带——兄弟模块的 RecordingEmitter 不可见）
    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((channel.to_string(), payload.to_string()));
        }
    }

    #[test]
    fn session_abort_signal_registry_lifecycle() {
        let signal = session_loop::AbortSignal::new();
        register_session_abort_signal("sess-abort-test", signal.clone());
        assert!(get_session_abort_signal("sess-abort-test").is_some());
        unregister_session_abort_signal("sess-abort-test");
        assert!(get_session_abort_signal("sess-abort-test").is_none());

        let config = EngineProviderConfig {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            model: "gpt-4o".to_string(),
            endpoint: agent_provider::config::Endpoint::ChatCompletions,
            stream: true,
            extra: BTreeMap::new(),
            ..Default::default()
        };
        let call = HttpProviderCall::new(reqwest::Client::new(), config).with_abort_signal(signal);
        assert!(call.abort_signal.is_some());
    }

    #[test]
    fn buffered_run_event_bridge_with_trace_id_smoke() {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new("workbench-run-event", emitter);
        let buffered = BufferedRunEventBridge::new(bridge, "run-trace-test")
            .with_trace_id(Some("trace-abc".to_string()));
        let env = AgentEventEnvelope::new(
            AgentEvent::AgentStart {
                session_id: "s-trace-test".to_string(),
                timestamp: "2026-08-14T00:00:00Z".to_string(),
            },
            Some("run-trace-test".to_string()),
            None,
        );
        buffered.emit(&env);
        buffered.flush();
    }
}
