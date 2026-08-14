//! request/compat.rs 纯函数测试旁挂（R1 T1.7；经 #[path] 接线，非直接 mod）。
//!
//! 覆盖战役验收断言（maxTokensField 极性按主控勘误 & pi-ai `useMaxTokens`
//! 权威语义修正，openai-completions.js:1141）：
//! 1. `resolve_max_tokens_field`：moonshot → **MaxTokens**；openai.com / o 系列
//!    → **MaxCompletionTokens**；openai-compatible 默认 → **MaxTokens**。
//! 2. `resolve_developer_role`：openrouter + anthropic 前缀模型 + reasoning → true；
//!    其余（非 reasoning / 非 openrouter / 非前缀模型）→ false。
//! 3. `empty_content_wire_value`：空 content 一律 `""`（非 null）。
//! 4. 纯函数无副作用：同输入同输出、不依赖全局状态。

use super::*;
use crate::request::build::MaxTokensField;

// ── resolve_max_tokens_field ──

#[test]
fn max_tokens_moonshot_url_is_max_tokens() {
    // 主控勘误验收断言：base_url 含 moonshot → MaxTokens（pi-ai useMaxTokens=moonshot → max_tokens）
    assert_eq!(
        resolve_max_tokens_field("", "kimi-k2", "https://api.moonshot.ai/v1"),
        MaxTokensField::MaxTokens
    );
}

#[test]
fn max_tokens_moonshot_vendor_fallback_max_tokens() {
    // vendor 名（moonshotai / moonshotai-cn / moonshot）→ MaxTokens
    for v in ["moonshotai", "moonshotai-cn", "moonshot"] {
        assert_eq!(
            resolve_max_tokens_field(v, "kimi-k2", "https://example.com/v1"),
            MaxTokensField::MaxTokens,
            "moonshot vendor {v} 应判定 MaxTokens"
        );
    }
}

#[test]
fn max_tokens_gateway_via_base_url_is_max_tokens() {
    // 旧式 max_tokens 网关轨（pi-ai useMaxTokens 全集）
    let cases = [
        ("", "qwen", "https://api.together.xyz/v1"),
        ("", "deepseek-v3", "https://integrate.api.nvidia.com/v1"),
        ("", "qwen-max", "https://api.ant-ling.com/v1"),
        ("", "claude-3", "https://gateway.ai.cloudflare.com/v1"),
        ("", "kimi", "https://api.chutes.ai/v1"),
        ("together", "qwen", "https://example.com/v1"),
        ("cloudflare-ai-gateway", "qwen", "https://example.com/v1"),
        ("nvidia", "qwen", "https://example.com/v1"),
        ("ant-ling", "qwen", "https://example.com/v1"),
    ];
    for (vendor, model, url) in cases {
        assert_eq!(
            resolve_max_tokens_field(vendor, model, url),
            MaxTokensField::MaxTokens,
            "网关 {url} / vendor {vendor} 应判定 MaxTokens"
        );
    }
}

#[test]
fn max_tokens_openai_official_is_max_completion_tokens() {
    // 主控勘误验收断言：base_url 含 openai.com（OpenAI 官方）→ MaxCompletionTokens
    assert_eq!(
        resolve_max_tokens_field("openai", "gpt-5", "https://api.openai.com/v1/chat/completions"),
        MaxTokensField::MaxCompletionTokens
    );
}

#[test]
fn max_tokens_openai_o_series_model_is_max_completion_tokens() {
    // o 系列 reasoning 模型 → MaxCompletionTokens（OpenAI 官方 API 要求）
    let o_models = ["o1", "o3", "o4-mini", "o5-preview", "o4"];
    for m in o_models {
        assert_eq!(
            resolve_max_tokens_field("", m, "https://api.openai.com/v1"),
            MaxTokensField::MaxCompletionTokens,
            "o 系列模型 {m} 应判定 MaxCompletionTokens"
        );
    }
}

#[test]
fn max_tokens_openai_compatible_defaults_to_max_tokens() {
    // 主控勘误验收断言：openai-compatible 默认 → MaxTokens（保持 Conex 既有字节）
    assert_eq!(
        resolve_max_tokens_field(
            "openai-compatible",
            "llama-3",
            "https://localhost:11434/v1/chat/completions"
        ),
        MaxTokensField::MaxTokens
    );
}

#[test]
fn max_tokens_o_series_via_gateway_is_max_tokens() {
    // o 系列模型经旧式网关轨：pi-ai useMaxTokens 以 baseUrl 为准（网关优先）
    assert_eq!(
        resolve_max_tokens_field("", "o4-mini", "https://api.chutes.ai/v1"),
        MaxTokensField::MaxTokens
    );
}

#[test]
fn max_tokens_case_insensitive() {
    assert_eq!(
        resolve_max_tokens_field("", "kimi", "https://API.Moonshot.ai/v1"),
        MaxTokensField::MaxTokens
    );
    assert_eq!(
        resolve_max_tokens_field("", "gpt-5", "https://API.Openai.com/v1"),
        MaxTokensField::MaxCompletionTokens
    );
}

#[test]
fn max_tokens_cloudflare_workers_not_gateway_defaults_max_tokens() {
    // workers-ai 的 api.cloudflare.com 不属 useMaxTokens → 走默认 max_tokens
    assert_eq!(
        resolve_max_tokens_field("", "qwen", "https://api.cloudflare.com/client/v4"),
        MaxTokensField::MaxTokens
    );
}

#[test]
fn max_tokens_unknown_provider_defaults_max_tokens() {
    assert_eq!(
        resolve_max_tokens_field("", "llama-3", "https://anthropic-based.example.com/v1"),
        MaxTokensField::MaxTokens
    );
}

// ── resolve_developer_role ──

#[test]
fn developer_role_openrouter_anthropic_reasoning_true() {
    // 验收断言：openrouter + anthropic 前缀模型 + reasoning → developer role true
    assert!(resolve_developer_role(
        "openrouter",
        "anthropic/claude-sonnet-4",
        "https://openrouter.ai/api/v1",
        true
    ));
}

#[test]
fn developer_role_openrouter_openai_reasoning_true() {
    assert!(resolve_developer_role(
        "openrouter",
        "openai/gpt-5",
        "https://openrouter.ai/api/v1",
        true
    ));
}

#[test]
fn developer_role_non_reasoning_is_system() {
    // 验收断言：其余 → false（非 reasoning 恒定 false）
    assert!(!resolve_developer_role(
        "openrouter",
        "anthropic/claude-sonnet-4",
        "https://openrouter.ai/api/v1",
        false
    ));
}

#[test]
fn developer_role_non_openrouter_is_system() {
    assert!(!resolve_developer_role(
        "anthropic",
        "claude-sonnet-4",
        "https://api.anthropic.com/v1",
        true
    ));
}

#[test]
fn developer_role_non_prefix_model_is_system() {
    assert!(!resolve_developer_role(
        "openrouter",
        "meta-llama/llama-3-70b",
        "https://openrouter.ai/api/v1",
        true
    ));
}

#[test]
fn developer_role_case_insensitive() {
    assert!(resolve_developer_role(
        "openrouter",
        "Anthropic/Claude-Sonnet-4",
        "https://OPENROUTER.ai/api/v1",
        true
    ));
    // vendor 名也可触发 openrouter
    assert!(resolve_developer_role(
        "OpenRouter",
        "anthropic/claude-sonnet-4",
        "https://example.com/v1",
        true
    ));
}

// ── empty_content_wire_value ──

#[test]
fn empty_content_wire_value_is_empty_string_not_null() {
    // 空 content 序列化 → ""（非 null）
    for role in ["assistant", "system", "user", "tool"] {
        assert_eq!(empty_content_wire_value(role), "");
    }
}

// ── 纯函数无副作用断言 ──

#[test]
fn pure_functions_deterministic_same_input_same_output() {
    // 重复调用同输入 → 同输出，无状态累积
    for _ in 0..5 {
        assert_eq!(
            resolve_max_tokens_field("", "kimi-k2", "https://api.moonshot.ai/v1"),
            MaxTokensField::MaxTokens
        );
        assert_eq!(
            resolve_max_tokens_field("openai", "gpt-5", "https://api.openai.com/v1"),
            MaxTokensField::MaxCompletionTokens
        );
        assert_eq!(
            resolve_max_tokens_field("openai-compatible", "llama-3", "https://localhost/v1"),
            MaxTokensField::MaxTokens
        );
        assert!(resolve_developer_role(
            "openrouter",
            "anthropic/claude-sonnet-4",
            "https://openrouter.ai/api/v1",
            true
        ));
        assert!(!resolve_developer_role(
            "anthropic",
            "claude-sonnet-4",
            "https://api.anthropic.com/v1",
            true
        ));
        assert_eq!(empty_content_wire_value("assistant"), "");
    }
}
