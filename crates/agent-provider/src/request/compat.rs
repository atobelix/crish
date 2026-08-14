//! G5 compat 纯函数面（战役 R1 T1.7；不接适配器，消费接线归 R3 T3.6 / R2 T2.2-T2.3）
//!
//! 对齐 pi-ai `detectCompat` / `useMaxTokens` / `supportsDeveloperRole`
//! 语义（参考 `docs/provider-adapter-campaign/analysis/01-协议与请求构建层对比.md:59-73`；
//! openai-completions.js:1141/1148/1151）：把「按 URL/厂商/模型判定 wire 兼容面」抽成
//! 可单测的纯函数，供下一轮适配层接线消费（T3.6 选 maxTokens 字段、T2.3 接 developer
//! role、T2.2 空 content 序列化）。
//!
//! 纯函数约束：同输入同输出，不依赖全局状态；入参一律 `&str`，内部 `to_ascii_lowercase()`
//! 逐字节确定性，无 IO / 无 RNG / 无时间。
//!
//! SR-06e · 拆分 · ≠ EL：独立新模块 + 测试旁挂 compat_tests.rs。

use super::build::MaxTokensField;

/// 判定是否走「旧式 `max_tokens`」网关轨（对齐 pi-ai `useMaxTokens` 权威语义，
/// `~/.pi-ai/dist/api/openai-completions.js:1141`）：
/// `chutes.ai || isMoonshot || isCloudflareAiGateway || isTogether || isNvidia ||
/// isAntLing → max_tokens`。逐项 URL/vendor pattern 对齐 pi-ai `detectCompat`
/// （openai-completions.js:1119-1125）：
/// - `chutes.ai`（baseUrl）
/// - moonshot：`api.moonshot.`（baseUrl）或 vendor ∈ {moonshotai, moonshotai-cn}
/// - cloudflare-ai-gateway：`gateway.ai.cloudflare.com`（baseUrl）或 vendor == cloudflare-ai-gateway
///   （注意：workers-ai 的 `api.cloudflare.com` 不在 `useMaxTokens`，不算）
/// - together：`api.together.ai` / `api.together.xyz`（baseUrl）或 vendor == together
/// - nvidia：`integrate.api.nvidia.com`（baseUrl）或 vendor == nvidia
/// - ant-ling：`api.ant-ling.com`（baseUrl）或 vendor == ant-ling
///
/// 任一命中 → `true`（`max_tokens`）。
fn is_legacy_max_tokens_gateway(vendor: &str, base_url: &str) -> bool {
    let url = base_url.to_ascii_lowercase();
    let vendor_name = vendor.to_ascii_lowercase();

    // chutes
    if url.contains("chutes.ai") {
        return true;
    }
    // moonshot
    if url.contains("api.moonshot.")
        || vendor_name == "moonshotai"
        || vendor_name == "moonshotai-cn"
        || vendor_name == "moonshot"
    {
        return true;
    }
    // cloudflare-ai-gateway（不含 workers-ai 的 api.cloudflare.com）
    if url.contains("gateway.ai.cloudflare.com") || vendor_name == "cloudflare-ai-gateway" {
        return true;
    }
    // together
    if url.contains("api.together.ai")
        || url.contains("api.together.xyz")
        || vendor_name == "together"
    {
        return true;
    }
    // nvidia
    if url.contains("integrate.api.nvidia.com") || vendor_name == "nvidia" {
        return true;
    }
    // ant-ling
    if url.contains("api.ant-ling.com") || vendor_name == "ant-ling" {
        return true;
    }
    false
}

/// OpenAI o 系列 reasoning 模型前缀（o1/o3/o4/o5）——官方 API 只认
/// `max_completion_tokens`（对齐战役 R3 建议「OpenAI/moonshot 系 → MaxCompletionTokens」）。
fn is_openai_o_series(model: &str) -> bool {
    model == "o1"
        || model == "o3"
        || model == "o4"
        || model == "o5"
        || model.starts_with("o1-")
        || model.starts_with("o3-")
        || model.starts_with("o4-")
        || model.starts_with("o5-")
}

/// 解析 maxTokens 字段名（纯函数；判定表见函数体）。
///
/// 判定规则（按序，命中即返回，不再走后续项）：
/// 1. 网关命中 [is_legacy_max_tokens_gateway]（chutes/moonshot/cloudflare-ai-gateway/
///    together/nvidia/ant-ling，对齐 pi-ai `useMaxTokens`）→ [MaxTokensField::MaxTokens]；
/// 2. `base_url` 为 OpenAI 官方（含 `openai.com`）或 `model` 为 o 系列前缀
///    （o1-/o3-/o4-/o5-，含裸 o1..o5）→ [MaxTokensField::MaxCompletionTokens]；
/// 3. 其余（openai-compatible 等默认轨）→ [MaxTokensField::MaxTokens]
///    （保持 Conex 既有 `max_tokens` 字节兼容，主线不引入全量回归）。
///
/// 契约登记（供 R3 T3.6 消费）：moonshot/…类网关 → `max_tokens`；OpenAI 官方
/// 或 o 系列模型 → `max_completion_tokens`；默认 openai-compatible → `max_tokens`。
/// 判定为纯 URL/名子串，无状态，同输入同输出。
#[allow(clippy::string_lit_as_bytes)]
pub fn resolve_max_tokens_field(vendor: &str, model: &str, base_url: &str) -> MaxTokensField {
    let model_name = model.to_ascii_lowercase();
    let url = base_url.to_ascii_lowercase();

    // 1. 旧式 `max_tokens` 网关轨（pi-ai useMaxTokens 权威语义）
    if is_legacy_max_tokens_gateway(vendor, base_url) {
        return MaxTokensField::MaxTokens;
    }

    // 2. OpenAI 官方 / o 系列 reasoning 模型 → `max_completion_tokens`
    if url.contains("openai.com") || is_openai_o_series(&model_name) {
        return MaxTokensField::MaxCompletionTokens;
    }

    // 3. 默认 openai-compatible → `max_tokens`
    MaxTokensField::MaxTokens
}

/// 判定 system 消息是否序列化为 `role:"developer"`（纯函数）。
///
/// 对齐 pi-ai `supportsDeveloperRole`（openai-completions.js:1148）的
/// OpenRouter 开发者角色模型分支：仅当同时满足三者才为 `true`——
/// * 模型支持 reasoning（`supports_reasoning == true`）；
/// * 路由经 OpenRouter（`base_url` 或 `vendor` 名含 "openrouter"）；
/// * 模型带 anthropic/openai 前缀（`anthropic/*` 或 `openai/*`）。
///
/// 契约登记（供 R2 T2.3 消费）：openrouter + anthropic/openai 前缀模型 + reasoning
/// → 序列化 `role:"developer"`；其余（默认，含非 reasoning 模型）→ `role:"system"`。
///
/// 说明：不接受独立的「compat 允许位」——OpenRouter 的 anthropic/openai 前缀
/// 模型即为 compat 允许分支；如需更宽的 allow 面，由消费层在调用前自行并入，
/// 本函数保持最小判定。
#[allow(clippy::nonminimal_bool)]
pub fn resolve_developer_role(
    vendor: &str,
    model: &str,
    base_url: &str,
    supports_reasoning: bool,
) -> bool {
    if !supports_reasoning {
        return false;
    }
    let url = base_url.to_ascii_lowercase();
    let vendor_name = vendor.to_ascii_lowercase();
    let is_openrouter = url.contains("openrouter") || vendor_name.contains("openrouter");
    if !is_openrouter {
        return false;
    }
    let model_name = model.to_ascii_lowercase();
    model_name.starts_with("anthropic/") || model_name.starts_with("openai/")
}

/// 空 content 的 wire 序列化值（纯函数；M8 wire 字节契约）。
///
/// 空文本一律写 `""` 而非 `null`（对齐 DSH serialize.ts:95「Text-less turns send ""
/// — NEVER null」、pi-ai openai-completions.js:836-839）。对携带 content 字段的
/// 任意 role 恒定返回 `""`；`role` 入参预留给 T2.2 未来按 role 区分「发空串 vs
/// 省略 content 键」的策略，当前无区分需求时同输入同输出恒为 `""`。
///
/// 契约登记（供 R2 T2.2 消费）：空 assistant/system 文本 content 序列化 →
/// `""`（非 `null`）。
#[allow(clippy::needless_lifetimes)]
pub fn empty_content_wire_value(role: &str) -> &'static str {
    let _ = role;
    ""
}

#[cfg(test)]
#[path = "compat_tests.rs"]
mod tests;
