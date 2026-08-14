//! 请求头组装域（多模型适配战役 R3 T3.2 / G4-b；engine_provider.rs → engine_provider/headers.rs）
//!
//! 按 wire 协议选择请求头集：
//! - chat / responses：Authorization Bearer + 会话亲和头（[affinity_http_headers]）；
//! - anthropic：x-api-key / anthropic-version / content-type
//!   （[anthropic_request_headers]）+ 显式思考档位时 anthropic-beta；
//! - gemini：x-goog-api-key / content-type（[gemini_request_headers]）。
//!
//! G1 遗留 1：亲和头只影响 chat/responses 两轨；anthropic/gemini 轨不带
//! OpenAI 系亲和头族（各自差异化头独立）。

use agent_provider::request::cache::CachePolicy;
use agent_provider::request::{anthropic_request_headers, gemini_request_headers, reasoning_effort_headers, ReasoningEffort, ReasoningVendor, WireProtocol};

use super::EngineProviderConfig;

/// 按协议组装请求头（URL/body/parser/head 同轨）。
///
/// anthropic 轨携带 [anthropic_request_headers]（x-api-key / anthropic-version /
/// content-type）；显式档位（非 off/auto）时追加 anthropic-beta（对齐 vendor.rs
/// [reasoning_effort_headers] 语义）。gemini 轨携带 [gemini_request_headers]
/// （x-goog-api-key）。chat/responses 轨走 Authorization + 亲和头
/// （[affinity_headers_for]）× 会话亲和头族（[session_affinity_headers]，
/// G1-e T3.5 seam）。
pub(crate) fn request_headers_for(
    config: &EngineProviderConfig,
    protocol: WireProtocol,
    policy: Option<&CachePolicy>,
    explicit_effort: Option<ReasoningEffort>,
    session_id: Option<&str>,
) -> Vec<(&'static str, String)> {
    match protocol {
        WireProtocol::Anthropic => {
            let mut headers = anthropic_request_headers(&config.api_key);
            if let Some(header) =
                reasoning_effort_headers(Some(ReasoningVendor::Anthropic), explicit_effort)
            {
                headers.push((header.0, header.1.to_string()));
            }
            headers
        }
        WireProtocol::Gemini => gemini_request_headers(&config.api_key),
        WireProtocol::Chat | WireProtocol::Responses => {
            let mut headers = vec![("Authorization", format!("Bearer {}", config.api_key))];
            headers.extend(affinity_headers_for(policy));
            headers.extend(session_affinity_headers(session_id));
            headers
        }
    }
}

/// 会话亲和头族（G1-e / T3.5 seam）。
///
/// `session_id` 非空时注入会话亲和头（cache 亲和头另行保留，见
/// [affinity_headers_for]）；`session_id` 为空（None / 空白）→ 不注入
/// （对齐 DSH adapter.ts:289-291 的 `options.sessionId !== undefined` 守卫）。
/// 注入进基本请求头（HTTP 发送层），**不进入请求体**——不破坏
/// [build_chat_completions_request_body] 序列化契约。
///
/// seam 语义（seam 可扩展点 = 本函数）：当前 chat/responses 轨注入通用
/// 会话头 `x-deepseek-harness-session-id`（对齐 DSH 会话亲和 + 遥测头族）；
/// 未来提供方会话亲和 K=V 族经本函数决议替换/扩族（对齐 04:189 的
/// 「不同提供方需要不同会话亲和表达」）。K=V 集由提供方决议，非硬编码单头。
pub(crate) fn session_affinity_headers(
    session_id: Option<&str>,
) -> Vec<(&'static str, String)> {
    match session_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sid) => vec![("x-deepseek-harness-session-id", sid.to_string())],
        None => Vec::new(),
    }
}

/// 会话亲和头追加（chat/responses 轨；[affinity_http_headers] 产物）。
/// policy = request_options 产出的 `options.cache`（Grok + 会话 ID →
/// x-grok-conv-id 粘性路由头随请求真实发出）；None / 无亲和头 → 零追加头。
pub(crate) fn affinity_headers_for(policy: Option<&CachePolicy>) -> Vec<(&'static str, String)> {
    agent_provider::request::build::affinity_http_headers(policy)
}
