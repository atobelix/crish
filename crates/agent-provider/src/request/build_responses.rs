//! Responses API 请求体构建域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/build.rs 拆出的实现域（门面 build.rs re-export 全部公开符号，对外路径不变）：
//! - Responses 轨请求体构建（[super::build_responses_request_body]：input items /
//!   instructions / max_output_tokens，DEEPCHECK-05 #10）
//! - 会话亲和 HTTP 头提取（[super::affinity_http_headers]：x-grok-conv-id 粘性路由）

use conex_types::tool::SystemPromptWireMode;
use serde_json::{json, Map, Value};

use super::dialect::{self, assemble_thinking_dialect, DialectBuildOptions, ThinkingDialectFormat};
use super::{ChatCompletionsRequestOptions, RequestBuildContext};
use crate::request::cache::CachePolicy;
use crate::request::messages::{
    system_prompt_as_user_prefix, to_responses_input_items, ReasoningContentMode,
};
use crate::request::tools::{to_responses_tool, to_responses_tool_choice, ToolChoice};

/// 构建 Responses API 请求体（DEEPCHECK-05 #10：Responses 轨协议补全；Wave 2 TU-02 全量贯通）
///
/// Responses 轨与 chat 轨的 wire 差异（对齐 OpenAI Responses 协议与 DeepSeek Responses API 官方兼容矩阵）：
/// - `input`（input items 数组，经 [to_responses_input_items] 映射）替代 `messages`；
/// - system prompt → 顶层 `instructions`（Responses 原生首 system 语义；wire_mode=
///   user-prefix 时改写为首条 user input item，保持 [RequestBuildContext] 语义）；
/// - `max_output_tokens` 替代 `max_tokens`（忽略 chat 侧 opts.max_tokens_field）；
/// - tools / tool_choice 走 Responses 原生形状（[to_responses_tool] /
///   [to_responses_tool_choice]，strict:false——02 §二.6:279-313 既有实现）；
/// - **不注入 stream_options**：Responses 终态 `response.completed` 恒携带完整 usage；
/// - **不注入任何 chat 形状缓存字段**：prompt_cache_key / prompt_cache_retention /
///   prompt_cache_options 对 /responses 属无效载荷；
/// - **思考参数注入**：当配置了 `thinking_intensity` 或 `reasoning_effort` 时，向请求体注入 Responses 原生
///   `reasoning: { effort: "..." }` 字段；严禁注入 Chat 专有的 `reasoning_effort` / `messages` 等键。
pub fn build_responses_request_body(
    opts: &ChatCompletionsRequestOptions,
    context: &RequestBuildContext,
) -> Value {
    let mut body = Map::new();

    if let Some(model) = &opts.model {
        body.insert("model".to_string(), json!(model));
    }
    if let Some(stream) = opts.stream {
        body.insert("stream".to_string(), json!(stream));
    }
    if let Some(temperature) = opts.temperature {
        body.insert("temperature".to_string(), json!(temperature));
    }
    if let Some(top_p) = opts.top_p {
        body.insert("top_p".to_string(), json!(top_p));
    }

    // input items（对话消息映射；system_prompt 不进 input——见函数文档）
    let mut input = to_responses_input_items(
        context.messages,
        opts.reasoning_content.unwrap_or(ReasoningContentMode::Omit),
        context.wire_mode,
    );
    // system prompt：NativeSystemRole → 顶层 instructions（Responses 原生首 system）；
    // UserPrefix → 首条 user input item（与 chat 轨 user-prefix 重写同语义）
    if let Some(prompt) = &context.system_prompt {
        if !prompt.trim().is_empty() {
            match context.wire_mode {
                SystemPromptWireMode::NativeSystemRole => {
                    body.insert("instructions".to_string(), json!(prompt));
                }
                SystemPromptWireMode::UserPrefix => {
                    input.insert(
                        0,
                        json!({
                            "type": "message",
                            "role": "user",
                            "content": system_prompt_as_user_prefix(prompt),
                        }),
                    );
                }
            }
        }
    }
    body.insert("input".to_string(), json!(input));

    // max_output_tokens：Responses 原生字段名（opts.max_tokens_field 为 chat 侧字段名）
    if let Some(max_tokens) = opts.max_tokens {
        body.insert("max_output_tokens".to_string(), json!(max_tokens));
    }

    // 思考推理参数组装：Responses API 原生 reasoning 格式 {"reasoning": {"effort": "<wire>"}}
    // 100% 由 assemble_thinking_dialect 正式产出。format 决议（plans/04 §7.3）：
    // openai → OpenAiResponsesNested；deepseek / qwen 显式方言原样；anthropic /
    // gemini / zai 与 responses 协议冲突或无 format → fail-closed 不注入
    // （禁止 `_ => OpenAiResponsesNested` 把 Anthropic/Gemini 折进 nested）。
    let effective_effort: Option<dialect::ReasoningEffort> =
        if let Some(intensity) = opts.thinking_intensity {
            Some(intensity.into())
        } else if let Some(effort) = opts.reasoning_effort {
            match effort {
                crate::request::vendor::ReasoningEffort::Off => Some(dialect::ReasoningEffort::Off),
                crate::request::vendor::ReasoningEffort::Auto => None,
                other => Some(other.into()),
            }
        } else {
            None
        };

    let responses_format = opts.thinking_format.and_then(|tf| match tf {
        crate::models::catalog_types::ThinkingFormat::OpenAi => {
            Some(ThinkingDialectFormat::OpenAiResponsesNested)
        }
        crate::models::catalog_types::ThinkingFormat::DeepSeek => {
            Some(ThinkingDialectFormat::DeepSeekNative)
        }
        crate::models::catalog_types::ThinkingFormat::Qwen => {
            Some(ThinkingDialectFormat::QwenBailianBoolean)
        }
        // Anthropic / Gemini / Zai 方言与 responses 协议冲突 → 不注入思考键
        _ => None,
    });

    if let (Some(effort), Some(format)) = (effective_effort, responses_format) {
        let dialect_opts = DialectBuildOptions {
            effort,
            format,
            max_output_tokens: opts.max_tokens.unwrap_or(64000),
            thinking_map: opts.thinking_map.as_ref(),
        };
        let (thinking_val, _) = assemble_thinking_dialect(&dialect_opts);
        if let Some(val) = thinking_val {
            if let Some(obj) = val.as_object() {
                for (k, v) in obj {
                    body.insert(k.clone(), v.clone());
                }
            }
        }
    }

    if !context.tools.is_empty() {
        body.insert(
            "tools".to_string(),
            json!(context
                .tools
                .iter()
                .map(to_responses_tool)
                .collect::<Vec<_>>()),
        );
        body.insert(
            "tool_choice".to_string(),
            to_responses_tool_choice(opts.tool_choice.as_ref().unwrap_or(&ToolChoice::Auto)),
        );
    }

    Value::Object(body)
}

/// G2 消费点：从缓存策略提取会话亲和 HTTP 头（x-grok-conv-id 粘性路由）。
///
/// [build_chat_completions_request_body] 只产出请求体（HTTP 头由发送层附加），
/// 故本函数供 http 发送层在发请求前调用——把亲和头合并进基础请求头后再发送。
/// None / 无亲和头 → 空 Vec（零参数，请求行为与现状一致，不新增头）。
pub fn affinity_http_headers(policy: Option<&CachePolicy>) -> Vec<(&'static str, String)> {
    match policy.and_then(|p| p.affinity_header.as_ref()) {
        Some((name, value)) => vec![(*name, value.clone())],
        None => Vec::new(),
    }
}

#[cfg(test)]
mod responses_dialect_wiring_tests {
    use super::*;
    use crate::models::catalog_types::ThinkingFormat;
    use indexmap::IndexMap;

    #[test]
    fn test_responses_dialect_thinking_map_driven() {
        let mut map = IndexMap::new();
        map.insert("Medium".to_string(), "custom-resp-wire".to_string());

        let opts = ChatCompletionsRequestOptions {
            model: Some("gpt-5-responses".to_string()),
            reasoning_effort: Some(crate::request::vendor::ReasoningEffort::Medium),
            thinking_format: Some(ThinkingFormat::OpenAi),
            thinking_map: Some(map),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_responses_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["reasoning"], json!({ "effort": "custom-resp-wire" }));
    }

    #[test]
    fn test_responses_dialect_anthropic_format_conflict_fails_closed() {
        // plans/04 §7.3：anthropic 方言与 responses 协议冲突 → 不注入思考键
        let opts = ChatCompletionsRequestOptions {
            model: Some("gpt-5-responses".to_string()),
            reasoning_effort: Some(crate::request::vendor::ReasoningEffort::High),
            thinking_format: Some(ThinkingFormat::Anthropic),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_responses_request_body(&opts, &RequestBuildContext::default());
        assert!(body.get("reasoning").is_none(), "冲突必须 fail-closed");
    }

    #[test]
    fn test_responses_dialect_deepseek_native() {
        let opts = ChatCompletionsRequestOptions {
            model: Some("deepseek-reasoner".to_string()),
            reasoning_effort: Some(crate::request::vendor::ReasoningEffort::High),
            thinking_format: Some(ThinkingFormat::DeepSeek),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_responses_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
    }
}
