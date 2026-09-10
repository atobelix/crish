//! 请求头组装域（多模型适配战役 R3 T3.2 / G4-b；engine_provider.rs → engine_provider/headers.rs）
//!
//! 按 wire 协议选择请求头集：
//! - chat / responses：Authorization Bearer + 会话亲和头（[affinity_http_headers]）
//!   + yaml `providers.*.headers` 声明头（M16：全局 DeepSeek 头已删，无声明不发）；
//! - anthropic：x-api-key / anthropic-version / content-type
//!   （[anthropic_request_headers]）+ 显式思考档位时 anthropic-beta；
//! - gemini：x-goog-api-key / content-type（[gemini_request_headers]）。
//!
//! G1 遗留 1：亲和头只影响 chat/responses 两轨；anthropic/gemini 轨不带
//! OpenAI 系亲和头族（各自差异化头独立）。

use agent_provider::request::cache::CachePolicy;
use agent_provider::request::{
    anthropic_request_headers, gemini_request_headers, ReasoningEffort, WireProtocol,
};

use super::protocol::catalog_request_profile;
use super::EngineProviderConfig;

/// 按协议组装请求头（URL/body/parser/head 同轨）。
///
/// anthropic 轨携带 [anthropic_request_headers]（x-api-key / anthropic-version /
/// content-type）；显式档位（非 off/auto）时追加 anthropic-beta（对齐 vendor.rs
/// [reasoning_effort_headers] 语义）。gemini 轨携带 [gemini_request_headers]
/// （x-goog-api-key）。chat/responses 轨走 Authorization + 亲和头
/// （[affinity_headers_for]）+ yaml 声明的供应商头（无声明不发 DeepSeek 头，M16）。
pub(crate) fn request_headers_for(
    config: &EngineProviderConfig,
    protocol: WireProtocol,
    policy: Option<&CachePolicy>,
    explicit_effort: Option<ReasoningEffort>,
    _session_id: Option<&str>,
) -> Vec<(String, String)> {
    let owned = |headers: Vec<(&'static str, String)>| {
        headers
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect::<Vec<_>>()
    };
    match protocol {
        WireProtocol::Anthropic => {
            let mut headers = anthropic_request_headers(&config.api_key);
            let mut betas = vec!["prompt-caching-2024-07-25"];
            // 思考激活（显式档位非 off/auto）→ interleaved-thinking beta。
            // 不再走 reasoning_effort_headers（MODEL_SERIES 自适应判定）——
            // 自适应思考由 yaml 字典值 `High: "adaptive"` 经 dialect 表达
            // （plans/04 §2.4：头决策不触 MODEL_SERIES）。
            if explicit_effort
                .is_some_and(|e| !matches!(e, ReasoningEffort::Off | ReasoningEffort::Auto))
            {
                betas.push("interleaved-thinking-2025-05-14");
            }
            headers.push(("anthropic-beta", betas.join(",")));
            owned(headers)
        }
        WireProtocol::Gemini => owned(gemini_request_headers(&config.api_key)),
        WireProtocol::Chat | WireProtocol::Responses => {
            let mut headers = vec![(
                "Authorization".to_string(),
                format!("Bearer {}", config.api_key),
            )];
            for (name, value) in affinity_headers_for(policy) {
                headers.push((name.to_string(), value));
            }
            // M16：yaml providers.*.headers 声明的亲和/遥测头；无声明零追加。
            // 禁止无条件 `x-deepseek-harness-session-id`（plans/04 §2.4）。
            if let Some(declared) = catalog_request_profile(config).headers {
                for (name, value) in declared {
                    headers.push((name, value));
                }
            }
            headers
        }
    }
}

/// 会话亲和头追加（chat/responses 轨；[affinity_http_headers] 产物）。
/// policy = request_options 产出的 `options.cache`（Grok + 会话 ID →
/// x-grok-conv-id 粘性路由头随请求真实发出）；None / 无亲和头 → 零追加头。
pub(crate) fn affinity_headers_for(policy: Option<&CachePolicy>) -> Vec<(&'static str, String)> {
    agent_provider::request::build::affinity_http_headers(policy)
}
