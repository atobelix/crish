//! chat-completions 请求体构建（任务书 B2.6；02-provider-semantics.md §二.6、§五 #1；00 D3）
//!
//! 对齐 `model:provider-openai-chat.ts:33-79`（buildChatCompletionsRequestBody）：
//! `{model, stream, temperature?, top_p?, maxTokens 字段?, reasoning 字段?, messages,
//! tools?, tool_choice?, stream_options:{include_usage:true}}`；compactObject 等价
//! （None 字段一律省略）。endpoint 缺省恒 chat-completions（00 D3：config 已保证，
//! 此处提供 [resolve_endpoint] 兜底）。

use conex_types::message::AgentMessage;
use conex_types::tool::SystemPromptWireMode;
use serde_json::{json, Map, Value};
use std::sync::Arc;

use crate::config::Endpoint;

use super::messages::{to_chat_messages, ChatMessage, ReasoningContentMode};
use super::tools::{to_chat_tool_choice, to_openai_tool, ToolChoice, ToolDefinition};
use super::vendor::{
    infer_thinking_capability, reasoning_effort_object, resolve_thinking_params,
    ReasoningEffort, ReasoningEffortFormat, ReasoningVendor, ThinkingIntensity,
};

/// maxTokens 字段名（对齐 OpenAICompatibleMaxTokensField）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum MaxTokensField {
    MaxTokens,
    MaxCompletionTokens,
    MaxOutputTokens,
}

impl MaxTokensField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MaxTokens => "max_tokens",
            Self::MaxCompletionTokens => "max_completion_tokens",
            Self::MaxOutputTokens => "max_output_tokens",
        }
    }
}

/// chat-completions 请求构建选项（对齐 buildChatCompletionsRequestBody 的 opts）
#[derive(Debug, Clone, Default)]
pub struct ChatCompletionsRequestOptions {
    /// 模型名
    pub model: Option<String>,
    /// 是否流式（缺省 true；stream 非 false 时必带 stream_options.include_usage）
    pub stream: Option<bool>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    /// maxTokens 与字段名成对生效（对齐 maxTokensObject）
    pub max_tokens: Option<u64>,
    pub max_tokens_field: Option<MaxTokensField>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub reasoning_effort_format: Option<ReasoningEffortFormat>,
    /// 思考回传模式（默认 omit，02 §1.4 请求侧）
    pub reasoning_content: Option<ReasoningContentMode>,
    pub tool_choice: Option<ToolChoice>,
    /// 显式 vendor；None/auto 时按 endpoint/format 推断（02 §五 #2）
    pub vendor: Option<ReasoningVendor>,
    /// 01 D5：thinkingIntensity 透传（提供时覆盖 reasoning 字段并注入 vendor 原生参数）
    pub thinking_intensity: Option<ThinkingIntensity>,
}

/// 请求构建上下文（对齐 RequestBuildContext 的 request 字段子集）
///
/// `'a` 为消息借用期（PE-09 T09.3 阶段 1：请求链全链借用——消息为
/// `&'a [Arc<AgentMessage>]`，构建请求体时按 Arc 解引用序列化，
/// 0 深拷贝；wire 逐字节不变）。
#[derive(Debug, Clone)]
pub struct RequestBuildContext<'a> {
    /// 全局 system prompt（非空时前置 system 消息）
    pub system_prompt: Option<String>,
    /// 会话消息（Arc 共享形态）
    pub messages: &'a [Arc<AgentMessage>],
    /// 工具定义（非空时发送 tools + tool_choice）
    pub tools: Vec<ToolDefinition>,
    /// system 提示词接线方式（02 §六.11；默认原生 system 角色）
    pub wire_mode: SystemPromptWireMode,
}

impl Default for RequestBuildContext<'_> {
    fn default() -> Self {
        Self {
            system_prompt: None,
            messages: &[],
            tools: Vec::new(),
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        }
    }
}

/// 00 D3 兜底：endpoint 缺省（或 auto）恒为 chat-completions
pub fn resolve_endpoint(endpoint: Option<Endpoint>) -> Endpoint {
    match endpoint {
        Some(Endpoint::Responses) => Endpoint::Responses,
        _ => Endpoint::ChatCompletions,
    }
}

/// 构建 chat-completions 请求体（compactObject 等价：None 字段一律省略，02 §二.6:132）
pub fn build_chat_completions_request_body(
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
    if let (Some(field), Some(value)) = (opts.max_tokens_field, opts.max_tokens) {
        body.insert(field.as_str().to_string(), json!(value));
    }

    // reasoning 字段（vendor 分支；02 §五 #2）
    if let Some(reasoning) = reasoning_effort_object(
        Endpoint::ChatCompletions,
        opts.model.as_deref().unwrap_or(""),
        opts.reasoning_effort,
        opts.reasoning_effort_format,
        opts.vendor,
    ) {
        merge_object(&mut body, &reasoning);
    }

    // 01 D5：per-request thinkingIntensity 优先注入，清除 legacy reasoning 字段
    // （对齐 `model:provider-openai-class.ts:551-585`：统一模块注入/覆盖/清空，
    // 消除 budgetDifficulty 语义混淆）
    if let Some(intensity) = opts.thinking_intensity {
        let capability = infer_thinking_capability(opts.model.as_deref().unwrap_or(""));
        let params = resolve_thinking_params(&capability, intensity, Endpoint::ChatCompletions);
        for key in ["reasoning_effort", "reasoning", "thinking", "generation_config"] {
            body.remove(key);
        }
        merge_object(&mut body, &params);
    }

    body.insert(
        "messages".to_string(),
        json!(to_chat_messages(
            context.system_prompt.as_deref(),
            context.messages,
            opts.reasoning_content.unwrap_or(ReasoningContentMode::Omit),
            context.wire_mode,
        )
        .iter()
        .map(ChatMessage::to_value)
        .collect::<Vec<_>>()),
    );

    if !context.tools.is_empty() {
        body.insert(
            "tools".to_string(),
            json!(context.tools.iter().map(to_openai_tool).collect::<Vec<_>>()),
        );
        body.insert(
            "tool_choice".to_string(),
            to_chat_tool_choice(opts.tool_choice.as_ref().unwrap_or(&ToolChoice::Auto)),
        );
    }

    // stream 非 false 时必带 include_usage（02 §二.6:132；`model:provider-openai-chat.ts:77`）
    if opts.stream != Some(false) {
        body.insert("stream_options".to_string(), json!({ "include_usage": true }));
    }

    Value::Object(body)
}

/// 把对象字段并入请求体（空对象不产生任何字段）
fn merge_object(body: &mut Map<String, Value>, extra: &Value) {
    if let Some(obj) = extra.as_object() {
        for (key, value) in obj {
            body.insert(key.clone(), value.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::message::{AgentMessageBlock, AgentMessageRole};
    use conex_types::tool::ToolOutput;

    fn text_block(text: &str) -> AgentMessageBlock {
        AgentMessageBlock::Text {
            text: text.to_string(),
        }
    }

    fn user_message(text: &str) -> AgentMessage {
        AgentMessage {
            id: "m1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            blocks: vec![text_block(text)],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("工具 {name}"),
            input_schema: json!({ "type": "object" }),
        }
    }

    fn base_opts() -> ChatCompletionsRequestOptions {
        ChatCompletionsRequestOptions {
            model: Some("gpt-4o".to_string()),
            ..ChatCompletionsRequestOptions::default()
        }
    }

    // ── 请求体构建与 compactObject ──

    #[test]
    fn body_shape_with_all_fields() {
        let opts = ChatCompletionsRequestOptions {
            model: Some("gpt-4o".to_string()),
            stream: Some(true),
            temperature: Some(0.7),
            top_p: Some(0.9),
            max_tokens: Some(2048),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            reasoning_effort: Some(ReasoningEffort::Low),
            ..ChatCompletionsRequestOptions::default()
        };
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = RequestBuildContext {
            system_prompt: Some("系统提示".to_string()),
            messages: &messages,
            tools: vec![tool("read_file")],
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        };
        let body = build_chat_completions_request_body(&opts, &context);
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], true);
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["max_tokens"], 2048);
        assert_eq!(body["reasoning_effort"], "low");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "你好");
        assert_eq!(body["tools"][0]["function"]["name"], "read_file");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
    }

    #[test]
    fn compact_object_omits_none_fields() {
        let body = build_chat_completions_request_body(&base_opts(), &RequestBuildContext::default());
        for key in ["temperature", "top_p", "max_tokens", "reasoning_effort", "tools", "tool_choice", "stream"] {
            assert!(
                body.get(key).is_none(),
                "None 字段 {key} 不应出现在请求体中：{body}"
            );
        }
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["messages"], json!([]));
        assert_eq!(body["stream_options"], json!({ "include_usage": true }));
    }

    #[test]
    fn stream_false_omits_stream_options() {
        let opts = ChatCompletionsRequestOptions {
            stream: Some(false),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["stream"], false);
        assert!(body.get("stream_options").is_none(), "非流式不带 include_usage");
    }

    #[test]
    fn max_tokens_field_name_is_respected() {
        for (field, wire_name) in [
            (MaxTokensField::MaxTokens, "max_tokens"),
            (MaxTokensField::MaxCompletionTokens, "max_completion_tokens"),
            (MaxTokensField::MaxOutputTokens, "max_output_tokens"),
        ] {
            let opts = ChatCompletionsRequestOptions {
                max_tokens: Some(100),
                max_tokens_field: Some(field),
                ..base_opts()
            };
            let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
            assert_eq!(body[wire_name], 100, "字段名 {wire_name}");
        }
    }

    #[test]
    fn tools_absent_when_tool_list_empty() {
        let body = build_chat_completions_request_body(&base_opts(), &RequestBuildContext::default());
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn tool_choice_explicit_function() {
        let context = RequestBuildContext {
            tools: vec![tool("read_file")],
            ..RequestBuildContext::default()
        };
        let opts = ChatCompletionsRequestOptions {
            tool_choice: Some(ToolChoice::Function { name: "read_file".to_string() }),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &context);
        assert_eq!(
            body["tool_choice"],
            json!({ "type": "function", "function": { "name": "read_file" } })
        );
    }

    // ── reasoning 字段与 thinking 透传 ──

    #[test]
    fn reasoning_effort_vendor_auto_injects_reasoning_effort() {
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["reasoning_effort"], "high");
    }

    #[test]
    fn thinking_intensity_overrides_legacy_reasoning_fields() {
        // 01 D5：thinkingIntensity 提供时清除 legacy 字段并注入 vendor 原生参数
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            thinking_intensity: Some(ThinkingIntensity::Medium),
            model: Some("deepseek-reasoner".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        // legacy reasoning_effort=high 被 thinkingIntensity 清除后重新注入 medium
        assert_eq!(body["reasoning_effort"], "medium", "deepseek → reasoning_effort");

        let opts = ChatCompletionsRequestOptions {
            thinking_intensity: Some(ThinkingIntensity::High),
            model: Some("claude-sonnet-4".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(
            body["thinking"],
            json!({ "type": "enabled", "budget_tokens": 4096 })
        );

        let opts = ChatCompletionsRequestOptions {
            thinking_intensity: Some(ThinkingIntensity::Xhigh),
            model: Some("gemini-2.5-flash".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["generation_config"], json!({ "thinking_level": "high" }));
    }

    #[test]
    fn thinking_intensity_off_clears_reasoning_fields() {
        // off 语义：清除 legacy 字段且不注入任何思考参数（对齐 provider-openai-class 覆盖/清空）
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            thinking_intensity: Some(ThinkingIntensity::Off),
            model: Some("deepseek-reasoner".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn thinking_intensity_unsupported_model_injects_nothing() {
        let opts = ChatCompletionsRequestOptions {
            thinking_intensity: Some(ThinkingIntensity::High),
            model: Some("gpt-4o".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn vendor_anthropic_effort_injects_thinking_budget() {
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            vendor: Some(ReasoningVendor::Anthropic),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(
            body["thinking"],
            json!({ "type": "enabled", "budget_tokens": 4096 })
        );
    }

    #[test]
    fn wire_mode_user_prefix_is_honored() {
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = RequestBuildContext {
            system_prompt: Some("全局提示".to_string()),
            messages: &messages,
            tools: Vec::new(),
            wire_mode: SystemPromptWireMode::UserPrefix,
        };
        let body = build_chat_completions_request_body(&base_opts(), &context);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(
            body["messages"][0]["content"],
            "System instructions for this run:\n\n全局提示"
        );
    }

    // ── endpoint 兜底（00 D3）──

    #[test]
    fn resolve_endpoint_defaults_to_chat_completions() {
        assert_eq!(resolve_endpoint(None), Endpoint::ChatCompletions);
        assert_eq!(resolve_endpoint(Some(Endpoint::Auto)), Endpoint::ChatCompletions);
        assert_eq!(resolve_endpoint(Some(Endpoint::ChatCompletions)), Endpoint::ChatCompletions);
        assert_eq!(resolve_endpoint(Some(Endpoint::Responses)), Endpoint::Responses);
    }

    #[test]
    fn build_with_tool_result_message() {
        let tool_result = AgentMessage {
            id: "t1".to_string(),
            role: AgentMessageRole::Tool,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            blocks: vec![AgentMessageBlock::ToolResult {
                tool_call_id: "call_1".to_string(),
                tool_name: "read_file".to_string(),
                output: ToolOutput::text("文件内容"),
                is_error: false,
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };
        let messages: Vec<Arc<AgentMessage>> =
            vec![Arc::new(user_message("查一下")), Arc::new(tool_result)];
        let context = RequestBuildContext {
            messages: &messages,
            ..RequestBuildContext::default()
        };
        let body = build_chat_completions_request_body(&base_opts(), &context);
        let messages = body["messages"].as_array().expect("messages 数组");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "call_1");
        assert_eq!(messages[1]["content"], "文件内容");
    }
}
