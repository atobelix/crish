//! Responses API 请求体构建域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/build.rs 拆出的实现域（门面 build.rs re-export 全部公开符号，对外路径不变）：
//! - Responses 轨请求体构建（[super::build_responses_request_body]：input items /
//!   instructions / max_output_tokens，DEEPCHECK-05 #10）
//! - 会话亲和 HTTP 头提取（[super::affinity_http_headers]：x-grok-conv-id 粘性路由）

use conex_types::tool::SystemPromptWireMode;
use serde_json::{json, Map, Value};

use super::{ChatCompletionsRequestOptions, RequestBuildContext};
use crate::request::cache::CachePolicy;
use crate::request::messages::{
    system_prompt_as_user_prefix, to_responses_input_items, ReasoningContentMode,
};
use crate::request::tools::{to_responses_tool, to_responses_tool_choice, ToolChoice};

/// 构建 Responses API 请求体（DEEPCHECK-05 #10：Responses 轨协议补全）
///
/// Responses 轨与 chat 轨的 wire 差异（对齐 DeepSeek Responses API 官方兼容矩阵，
/// api-docs.deepseek.com/guides/responses_api——该 API 为 OpenAI Responses 形状）：
/// - `input`（input items 数组，经 [to_responses_input_items] 映射）替代 `messages`；
/// - system prompt → 顶层 `instructions`（Responses 原生首 system 语义；wire_mode=
///   user-prefix 时改写为首条 user input item，保持 [RequestBuildContext] 语义）；
/// - `max_output_tokens` 替代 `max_tokens`（忽略 chat 侧 opts.max_tokens_field）；
/// - tools / tool_choice 走 Responses 原生形状（[to_responses_tool] /
///   [to_responses_tool_choice]，strict:false——02 §二.6:279-313 既有实现）；
/// - **不注入 stream_options**：DeepSeek 官方不受支持（静默忽略）；Responses 终态
///   `response.completed` 恒携带完整 usage（chat 轨 include_usage 是 chat 语义）；
/// - **不注入任何 chat 形状缓存字段**：prompt_cache_key / prompt_cache_retention /
///   prompt_cache_options 对 /responses 属无效载荷（DEEPCHECK-05 #10 原文判定）；
///   DeepSeek 官方不受支持且缓存自动管理（Context Caching，零参数），OpenAI 系
///   store / background_store 原生缓存语义留待后续阶段（Responses 轨缓存矩阵）；
/// - reasoning_effort / thinking_intensity / vendor：chat 专有注入面，Responses 轨
///   忽略（engine 侧恒 None，无行为差异；未来经 `reasoning:{effort}` 接线）。
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
