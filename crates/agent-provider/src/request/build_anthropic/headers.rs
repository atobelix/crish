//! Anthropic 请求头构造与 beta 特征注入（自 build_anthropic.rs 平移）。

use super::options::AnthropicRequestOptions;
use super::ANTHROPIC_VERSION;
use crate::request::vendor::ReasoningEffort;
use crate::request::ThinkingIntensity;

/// 差异化请求头（anthropic.messages API）：x-api-key / anthropic-version /
///   content-type: application/json
pub fn anthropic_request_headers(api_key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("x-api-key", api_key.to_string()),
        ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ("content-type", "application/json".to_string()),
    ]
}

/// 聚合带 beta 功能标头的 Anthropic 完整请求头
pub fn build_anthropic_headers(
    api_key: &str,
    opts: &AnthropicRequestOptions,
    has_cache: bool,
) -> Vec<(&'static str, String)> {
    let mut headers = anthropic_request_headers(api_key);
    let mut betas = Vec::new();
    if has_cache {
        betas.push("prompt-caching-2024-07-31");
    }
    if opts.thinking_budget.is_some()
        || opts
            .thinking_intensity
            .is_some_and(|i| i != ThinkingIntensity::Off)
        || opts
            .reasoning_effort
            .is_some_and(|e| !matches!(e, ReasoningEffort::Off | ReasoningEffort::Auto))
    {
        betas.push("interleaved-thinking-2025-05-14");
    }
    if opts.max_tokens.is_some_and(|m| m > 4096) {
        betas.push("output-128k-2025-02-19");
    }
    if !betas.is_empty() {
        headers.push(("anthropic-beta", betas.join(",")));
    }
    headers
}
