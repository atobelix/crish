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

use super::cache::{
    apply_cache_controls, allocate_breakpoints, retention_wire_value, BreakpointPlan,
    CacheMechanism, CachePolicy,
};
use super::messages::{
    system_prompt_as_user_prefix, to_chat_messages, to_responses_input_items, ChatMessage,
    ReasoningContentMode,
};
use super::tools::{
    to_cache_aware_tool, to_chat_tool_choice, to_responses_tool, to_responses_tool_choice,
    ToolChoice, ToolDefinition,
};
use super::vendor::{
    infer_thinking_capability, reasoning_effort_object, resolve_thinking_params,
    ReasoningEffort, ReasoningEffortFormat, ReasoningVendor, ThinkingIntensity,
};

/// maxTokens 字段名（对齐 OpenAICompatibleMaxTokensField）
// G2 允许理由（clippy::enum_variant_names）：变体名按协议源命名对齐
// （max_tokens / max_completion_tokens / max_output_tokens 为第三方协议
// 字段名，不可缩写）。
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
    /// 统一缓存策略（P2 步骤 3 / T-15：None = 完全不参与缓存，请求体不含任何
    /// cache 键——compactObject 等价，无缓存配置时请求字节与现状逐字节一致；
    /// DeepSeek 等自动缓存厂商由 build_cache_policy 归 None，整个参数组不出现）
    pub cache: Option<CachePolicy>,
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

/// system prompt 稳定构造（P1 B1：单点规范化——trim + 空值归一；空 → None）
///
/// 前端 guidance 拼接（ConnectionLifecycle 的 base+"\n\n"+guidance）改为
/// 入站前完成（P1 B2），Rust 侧只负责 trim 与空值归一，保证同一配置下
/// 字节确定。
pub fn build_system_prompt(system_prompt: Option<String>) -> Option<String> {
    let trimmed = system_prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    Some(trimmed)
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
    // 消除 budgetDifficulty 语义混淆；"effort" 为 G7 自适应思考的顶层档位字段，
    // 一并清除防止 legacy 注入残留）
    if let Some(intensity) = opts.thinking_intensity {
        let capability = infer_thinking_capability(opts.model.as_deref().unwrap_or(""));
        let params = resolve_thinking_params(&capability, intensity, Endpoint::ChatCompletions);
        for key in ["reasoning_effort", "reasoning", "thinking", "generation_config", "effort"] {
            body.remove(key);
        }
        merge_object(&mut body, &params);
    }

    // ── P2 步骤 3（T-15）：缓存顶层字段注入（compactObject：None 一律省略）──
    // 三字段：prompt_cache_key（会话亲和键，OpenAI 系）/ prompt_cache_retention
    // （OpenAI 官方值域 in_memory/24h，仅 Key 机制发 wire——Auto 机制 retention
    // 恒 Short 为内部档位，P2 §3.4 矩阵 Auto 行不发）/ prompt_cache_options
    // （GPT-5.6+ none 档显式化 {"mode":"explicit"}）；DeepSeek 等由
    // build_cache_policy 归 None，整个 cache 参数组不出现。
    // G2 注记：policy.affinity_header（x-grok-conv-id 会话亲和头）属 HTTP 头，
    // 不进请求体——由发送层经 [affinity_http_headers] 合并进基础请求头
    // （基础头 + 亲和头合并，P2 §3.3 注记；Grok 粘性路由，vendor-cache-mechanisms.md:121）
    if let Some(policy) = &opts.cache {
        if let Some(key) = &policy.cache_key {
            body.insert("prompt_cache_key".to_string(), json!(&key.0));
        }
        if policy.mechanism == CacheMechanism::Key {
            if let Some(retention) = retention_wire_value(policy.retention) {
                body.insert("prompt_cache_retention".to_string(), json!(retention));
            }
        }
        if let Some(options) = &policy.prompt_cache_options {
            body.insert(
                "prompt_cache_options".to_string(),
                json!({ "mode": options.mode.as_str() }),
            );
        }
    }

    // messages：先映射既有 wire 消息（to_chat_messages 保持纯函数），
    // 再 post-pass 施加断点（P2 §3.1.3：纯后处理，与映射解耦；plan 全 false
    // → 请求字节与未施加时完全一致）
    let mut wire = to_chat_messages(
        context.system_prompt.as_deref(),
        context.messages,
        opts.reasoning_content.unwrap_or(ReasoningContentMode::Omit),
        context.wire_mode,
    );
    // Explicit 机制断点：policy.breakpoints 为 Some（机制启用位，cache.rs
    // T-13b 产出）时，按请求形态（tools 数 / system / messages 锚点存在性）
    // 经 allocate_breakpoints 落地具体锚点（P2 §3.1.2：层级 tools→system→
    // messages，超限丢尾不报错）；锚点存在性判定与 apply_cache_controls 内部
    // 查找逻辑保持一致（system 回退首条 user / messages 回退最后 user/tool）
    let mut breakpoint_plan = BreakpointPlan::default();
    if let Some(policy) = &opts.cache {
        if policy.breakpoints.is_some() {
            breakpoint_plan = allocate_breakpoints(
                context.tools.len(),
                wire.iter().any(|m| m.role == "system" || m.role == "user"),
                wire.iter().any(|m| m.role == "user" || m.role == "tool"),
            );
            // chat-completions 兼容端点走 part 级断点（supports_message_cache_control
            // = false；消息级断点是 Anthropic 原生端点"顶层自动模式"载体，本线路不用）
            apply_cache_controls(&mut wire, &breakpoint_plan, policy.ttl, false);
        }
    }
    body.insert(
        "messages".to_string(),
        json!(wire.iter().map(ChatMessage::to_value).collect::<Vec<_>>()),
    );

    if !context.tools.is_empty() {
        // tools 级断点：plan.tools 为真时在**最后一个工具**附加 cache_control
        // （tools 层级锚点；to_cache_aware_tool 经 cache_control_for_ttl 映射，
        // 与消息级共用 TTL 桶 → 断点值转换，避免双实现漂移）
        let last_ttl = if breakpoint_plan.tools {
            opts.cache.as_ref().map(|policy| policy.ttl)
        } else {
            None
        };
        body.insert(
            "tools".to_string(),
            json!(context
                .tools
                .iter()
                .enumerate()
                .map(|(index, tool)| {
                    to_cache_aware_tool(
                        tool,
                        if index + 1 == context.tools.len() { last_ttl } else { None },
                    )
                })
                .collect::<Vec<_>>()),
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
    use crate::request::cache::{
        CacheKey, CacheRetention, PromptCacheMode, PromptCacheOptions, TtlBucket,
    };
    use crate::request::schema::canonical_json_string;

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

    // ── system prompt 单点规范化（P1 B1）──

    #[test]
    fn build_system_prompt_trims_whitespace() {
        assert_eq!(
            build_system_prompt(Some("  你好，世界  \n\t".to_string())),
            Some("你好，世界".to_string())
        );
        assert_eq!(
            build_system_prompt(Some("  全局提示 \n ".to_string())),
            Some("全局提示".to_string())
        );
        // 内部空白保留（只做首尾 trim）
        assert_eq!(
            build_system_prompt(Some(" a  b ".to_string())),
            Some("a  b".to_string())
        );
    }

    #[test]
    fn build_system_prompt_empty_or_whitespace_normalizes_to_none() {
        assert_eq!(build_system_prompt(Some(String::new())), None);
        assert_eq!(build_system_prompt(Some("   ".to_string())), None);
        assert_eq!(build_system_prompt(Some("\n\t  \n".to_string())), None);
    }

    #[test]
    fn build_system_prompt_none_passes_through() {
        assert_eq!(build_system_prompt(None), None);
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

    // ── G7：Anthropic 自适应思考（Opus 4.7+ / Sonnet 5+）──

    #[test]
    fn adaptive_anthropic_thinking_intensity_injects_adaptive_shape() {
        // G7：新代际 thinkingIntensity → thinking{type:adaptive,display:summarized} + effort
        let opts = ChatCompletionsRequestOptions {
            thinking_intensity: Some(ThinkingIntensity::High),
            model: Some("claude-opus-4-7".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(
            body["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(body["effort"], "high");
        assert!(
            body["thinking"].get("budget_tokens").is_none(),
            "adaptive 形态不带 budget_tokens"
        );

        let opts = ChatCompletionsRequestOptions {
            thinking_intensity: Some(ThinkingIntensity::Max),
            model: Some("claude-sonnet-5".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(
            body["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(body["effort"], "max");
    }

    #[test]
    fn adaptive_anthropic_legacy_effort_injects_adaptive_shape() {
        // 新代际 + 显式 anthropic vendor：adaptive + display summarized + effort
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::Xhigh),
            vendor: Some(ReasoningVendor::Anthropic),
            model: Some("claude-opus-4-7".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(
            body["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(body["effort"], "xhigh");
        assert!(
            body["thinking"].get("budget_tokens").is_none(),
            "adaptive 形态不带 budget_tokens"
        );

        // 旧代际行为不变：enabled+budget_tokens、无顶层 effort
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            vendor: Some(ReasoningVendor::Anthropic),
            model: Some("claude-opus-4-6".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["thinking"], json!({ "type": "enabled", "budget_tokens": 4096 }));
        assert!(body.get("effort").is_none(), "旧代际不注入顶层 effort");
    }

    #[test]
    fn adaptive_legacy_effort_cleared_by_thinking_intensity() {
        // thinkingIntensity 覆盖时，legacy 注入的顶层 effort 必须被清除
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::Max),
            vendor: Some(ReasoningVendor::Anthropic),
            thinking_intensity: Some(ThinkingIntensity::Medium),
            model: Some("claude-opus-4-7".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(
            body["thinking"],
            json!({ "type": "adaptive", "display": "summarized" })
        );
        assert_eq!(body["effort"], "medium", "thinkingIntensity 覆盖后 effort 应为新档位");
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

    // ── P2 步骤 3（T-15）：缓存参数注入 ──

    /// 便捷构造缓存策略（prompt_cache_options 恒 None，需要时单独构造）
    fn cache_policy(
        mechanism: CacheMechanism,
        cache_key: Option<&str>,
        retention: CacheRetention,
        ttl: TtlBucket,
        breakpoints: Option<BreakpointPlan>,
    ) -> CachePolicy {
        CachePolicy {
            mechanism,
            retention,
            ttl,
            breakpoints,
            cache_key: cache_key.map(|k| CacheKey(k.to_string())),
            prompt_cache_options: None,
            affinity_header: None,
        }
    }

    /// 固定输入（system + user + 单工具），供无缓存回归断言复用
    fn baseline_context<'a>(messages: &'a [Arc<AgentMessage>]) -> RequestBuildContext<'a> {
        RequestBuildContext {
            system_prompt: Some("系统提示".to_string()),
            messages,
            tools: vec![tool("read_file")],
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        }
    }

    #[test]
    fn cache_none_keeps_baseline_bytes() {
        // 无缓存配置（cache: None）：请求字节与 P2 前逐字节一致（关键回归护栏，
        // P2 §5.3：无缓存配置请求字节与 P2 前一致；compactObject 兜底）
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = baseline_context(&messages);
        let body = build_chat_completions_request_body(&base_opts(), &context);
        assert_eq!(
            body,
            json!({
                "model": "gpt-4o",
                "messages": [
                    { "content": "系统提示", "role": "system" },
                    { "content": "你好", "role": "user" },
                ],
                "tools": [{
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "description": "工具 read_file",
                        "parameters": { "type": "object" },
                    },
                }],
                "tool_choice": "auto",
                "stream_options": { "include_usage": true },
            })
        );
        // 字节级钉死（canonical 序列化 = 键码点序；BTreeMap 字典序同构）
        assert_eq!(
            canonical_json_string(&body),
            r#"{"messages":[{"content":"系统提示","role":"system"},{"content":"你好","role":"user"}],"model":"gpt-4o","stream_options":{"include_usage":true},"tool_choice":"auto","tools":[{"function":{"description":"工具 read_file","name":"read_file","parameters":{"type":"object"}},"type":"function"}]}"#
        );
    }

    #[test]
    fn cache_injects_prompt_cache_key_and_retention() {
        // Key 机制（OpenAI/Grok）：prompt_cache_key + prompt_cache_retention 顶层注入
        let opts = ChatCompletionsRequestOptions {
            cache: Some(cache_policy(
                CacheMechanism::Key,
                Some("ses-abc"),
                CacheRetention::Short,
                TtlBucket::FiveMinutes,
                None,
            )),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["prompt_cache_key"], "ses-abc");
        assert_eq!(body["prompt_cache_retention"], "in_memory");
        assert!(body.get("prompt_cache_options").is_none(), "默认不发 options");

        // retention=Long → wire 值 "24h"
        let opts = ChatCompletionsRequestOptions {
            cache: Some(cache_policy(
                CacheMechanism::Key,
                Some("ses-abc"),
                CacheRetention::Long,
                TtlBucket::OneHour,
                None,
            )),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["prompt_cache_retention"], "24h");
        assert_eq!(body["prompt_cache_key"], "ses-abc");
    }

    #[test]
    fn cache_injects_prompt_cache_options() {
        // GPT-5.6+ none 档：prompt_cache_options={"mode":"explicit"}（"none 也须被
        // 尊重"，pi openai-responses.ts:278-285）；无键、无 retention
        let mut policy = cache_policy(
            CacheMechanism::Key,
            None,
            CacheRetention::None,
            TtlBucket::FiveMinutes,
            None,
        );
        policy.prompt_cache_options =
            Some(PromptCacheOptions { mode: PromptCacheMode::Explicit });
        let opts = ChatCompletionsRequestOptions { cache: Some(policy), ..base_opts() };
        let body = build_chat_completions_request_body(&opts, &RequestBuildContext::default());
        assert_eq!(body["prompt_cache_options"], json!({ "mode": "explicit" }));
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("prompt_cache_retention").is_none(), "none 档不发 retention");
    }

    #[test]
    fn cache_none_omits_all_cache_keys() {
        // DeepSeek 语义（build_cache_policy → None）与显式 None 同：请求体不含
        // 任何 cache 键——顶层三字段、消息断点、工具断点全部省略
        // （P2 §5.1 DeepSeek 省略；对齐 deepseek-reasonix-cache-analysis.md:111-112）
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = baseline_context(&messages);
        let opts = ChatCompletionsRequestOptions { cache: None, ..base_opts() };
        let body = build_chat_completions_request_body(&opts, &context);
        for key in ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] {
            assert!(body.get(key).is_none(), "cache=None 不得注入 {key}");
        }
        let wire_messages = body["messages"].as_array().expect("messages 数组");
        for message in wire_messages {
            assert!(message.get("cache_control").is_none(), "消息不得携带断点");
        }
        assert_eq!(wire_messages[1]["content"], "你好", "无断点 → content 保持 string 形态");
        let tools = body["tools"].as_array().expect("tools 数组");
        for tool in tools {
            assert!(tool.get("cache_control").is_none(), "工具不得附加断点");
        }
    }

    #[test]
    fn cache_auto_zero_params_keeps_bytes_identical() {
        // Auto 机制（Kimi/Gemini 隐式）产出零参数 policy：无键/断点/options，
        // retention 恒 Short 为内部档位不发 wire——请求字节与 cache=None 完全
        // 一致（P2 §5.1：plan 全 false → 请求字节与未施加时完全一致）
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = baseline_context(&messages);
        let opts_without = base_opts();
        let opts_with = ChatCompletionsRequestOptions {
            cache: Some(cache_policy(
                CacheMechanism::Auto,
                None,
                CacheRetention::Short,
                TtlBucket::FiveMinutes,
                None,
            )),
            ..base_opts()
        };
        let body_without = build_chat_completions_request_body(&opts_without, &context);
        let body_with = build_chat_completions_request_body(&opts_with, &context);
        assert_eq!(
            serde_json::to_string(&body_with).expect("序列化"),
            serde_json::to_string(&body_without).expect("序列化"),
            "Auto 零参数 policy 不得改变请求字节"
        );
    }

    #[test]
    fn explicit_breakpoints_placed_on_wire_messages_and_last_tool() {
        // Explicit 机制（MiniMax M2.x / Anthropic 语义）：policy.breakpoints=Some
        // （启用位）→ post-pass 在首条 system 消息与最后 user 消息末块落 part 级
        // 断点（锚点落在 wire 消息上）；plan.tools → 最后一个工具附加
        // cache_control，其余工具不附加
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let mut context = baseline_context(&messages);
        context.tools = vec![tool("read_file"), tool("search")];
        let opts = ChatCompletionsRequestOptions {
            cache: Some(cache_policy(
                CacheMechanism::Explicit,
                None,
                CacheRetention::Short,
                TtlBucket::FiveMinutes,
                Some(BreakpointPlan::default()),
            )),
            ..base_opts()
        };
        let body = build_chat_completions_request_body(&opts, &context);
        // system 锚点：首条 system 消息改写为 parts 形态挂断点
        let wire_messages = body["messages"].as_array().expect("messages 数组");
        assert_eq!(wire_messages[0]["role"], "system");
        assert_eq!(
            wire_messages[0]["content"][0]["cache_control"],
            json!({ "type": "ephemeral" })
        );
        // messages 锚点：最后 user 消息改写为 parts 形态挂断点
        assert_eq!(wire_messages[1]["role"], "user");
        assert_eq!(
            wire_messages[1]["content"][0]["cache_control"],
            json!({ "type": "ephemeral" })
        );
        // Explicit 机制不发顶层键
        for key in ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] {
            assert!(body.get(key).is_none(), "Explicit 机制不得注入 {key}");
        }
        // tools 级：仅最后一个工具附加（tools 层级锚点）
        let tools = body["tools"].as_array().expect("tools 数组");
        assert_eq!(tools.len(), 2);
        assert!(tools[0].get("cache_control").is_none(), "非最后工具不附加");
        assert_eq!(tools[1]["cache_control"], json!({ "type": "ephemeral" }));
        assert_eq!(tools[1]["function"]["name"], "search");
    }

    #[test]
    fn affinity_http_headers_consumes_policy_header() {
        // G2 消费点：policy.affinity_header → HTTP 头列表（发送层基础头 + 亲和头
        // 合并用）；无亲和头 / None policy → 空 Vec（不新增任何头）
        let mut policy = cache_policy(
            CacheMechanism::Key,
            Some("ses-grok"),
            CacheRetention::Short,
            TtlBucket::FiveMinutes,
            None,
        );
        policy.affinity_header = Some(("x-grok-conv-id", "ses-grok".to_string()));
        assert_eq!(
            affinity_http_headers(Some(&policy)),
            vec![("x-grok-conv-id", "ses-grok".to_string())]
        );
        let plain = cache_policy(
            CacheMechanism::Key,
            Some("ses-1"),
            CacheRetention::Short,
            TtlBucket::FiveMinutes,
            None,
        );
        assert_eq!(affinity_http_headers(Some(&plain)), Vec::new());
        assert_eq!(affinity_http_headers(None), Vec::new());
        // 亲和头不影响请求体字节（HTTP 头不在 body 内，回归护栏）
        let body = build_chat_completions_request_body(
            &ChatCompletionsRequestOptions { cache: Some(policy), ..base_opts() },
            &RequestBuildContext::default(),
        );
        assert!(body.get("x-grok-conv-id").is_none(), "请求体不得携带 HTTP 头");
    }

    // ── Responses 轨请求体（DEEPCHECK-05 #10：input/instructions/max_output_tokens）──

    #[test]
    fn responses_body_shape_with_all_fields() {
        let opts = ChatCompletionsRequestOptions {
            model: Some("deepseek-v4-flash".to_string()),
            stream: Some(true),
            temperature: Some(0.7),
            top_p: Some(0.9),
            max_tokens: Some(2048),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            ..ChatCompletionsRequestOptions::default()
        };
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = RequestBuildContext {
            system_prompt: Some("系统提示".to_string()),
            messages: &messages,
            tools: vec![tool("read_file")],
            wire_mode: SystemPromptWireMode::NativeSystemRole,
        };
        let body = build_responses_request_body(&opts, &context);
        assert_eq!(body["model"], "deepseek-v4-flash");
        assert_eq!(body["stream"], true);
        assert_eq!(body["temperature"], 0.7);
        assert_eq!(body["top_p"], 0.9);
        // system prompt → 顶层 instructions（Responses 原生首 system）
        assert_eq!(body["instructions"], "系统提示");
        // input items：user 消息（无 system item——instructions 已承载）
        assert_eq!(
            body["input"][0],
            json!({ "type": "message", "role": "user", "content": "你好" })
        );
        assert_eq!(body["input"].as_array().expect("input 数组").len(), 1);
        // max_output_tokens（Responses 原生字段名，忽略 chat 侧 max_tokens_field）
        assert_eq!(body["max_output_tokens"], 2048);
        assert!(
            body.get("max_tokens").is_none(),
            "Responses 轨不得出现 max_tokens"
        );
        // tools / tool_choice → Responses 原生形状（strict:false）
        assert_eq!(
            body["tools"][0],
            json!({
                "type": "function",
                "name": "read_file",
                "description": "工具 read_file",
                "parameters": { "type": "object" },
                "strict": false,
            })
        );
        assert_eq!(body["tool_choice"], "auto");
        // 不出现 chat 专有键（messages / stream_options / 缓存字段）
        for key in [
            "messages",
            "stream_options",
            "prompt_cache_key",
            "prompt_cache_retention",
            "prompt_cache_options",
        ] {
            assert!(body.get(key).is_none(), "Responses 轨不得注入 {key}");
        }
    }

    #[test]
    fn responses_body_tool_loop_items() {
        // 工具循环：assistant（文本 + 工具调用）→ tool 结果 → function_call 与
        // function_call_output items（DeepSeek Responses 官方矩阵形状）
        let assistant = AgentMessage {
            id: "a1".to_string(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            blocks: vec![
                text_block("我来查"),
                AgentMessageBlock::ToolCall(conex_types::message::ToolCallBlock {
                    id: "call_1".to_string(),
                    tool_name: "read_file".to_string(),
                    input: json!({ "path": "/a" }),
                }),
            ],
            metadata: None,
            client_message_id: None,
            content: None,
        };
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
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(assistant), Arc::new(tool_result)];
        let context = RequestBuildContext {
            messages: &messages,
            ..RequestBuildContext::default()
        };
        let body = build_responses_request_body(&base_opts(), &context);
        let input = body["input"].as_array().expect("input 数组");
        assert_eq!(input.len(), 3);
        assert_eq!(
            input[0],
            json!({ "type": "message", "role": "assistant", "content": "我来查" })
        );
        assert_eq!(
            input[1],
            json!({
                "type": "function_call",
                "call_id": "call_1",
                "name": "read_file",
                "arguments": r#"{"path":"/a"}"#,
            })
        );
        assert_eq!(
            input[2],
            json!({
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "文件内容",
            })
        );
    }

    #[test]
    fn responses_body_user_prefix_system_prompt() {
        // wire_mode=user-prefix：system_prompt 改写为首条 user input item（无 instructions）
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = RequestBuildContext {
            system_prompt: Some("全局提示".to_string()),
            messages: &messages,
            tools: Vec::new(),
            wire_mode: SystemPromptWireMode::UserPrefix,
        };
        let body = build_responses_request_body(&base_opts(), &context);
        assert!(body.get("instructions").is_none(), "UserPrefix 模式不得发 instructions");
        assert_eq!(body["input"][0]["type"], "message");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(
            body["input"][0]["content"],
            "System instructions for this run:\n\n全局提示"
        );
        assert_eq!(body["input"][1]["content"], "你好");
    }

    #[test]
    fn responses_body_cache_policy_never_injected() {
        // 即使 Key 机制 policy（GPT-5.x + 会话 ID）存在，Responses 轨也不得注入
        // chat 形状缓存字段（对 /responses 属无效载荷，DEEPCHECK-05 #10）；
        // DeepSeek 自动缓存零参数（官方矩阵 prompt_cache_* 不受支持）
        let opts = ChatCompletionsRequestOptions {
            cache: Some(cache_policy(
                CacheMechanism::Key,
                Some("ses-abc"),
                CacheRetention::Short,
                TtlBucket::FiveMinutes,
                None,
            )),
            ..base_opts()
        };
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = RequestBuildContext {
            messages: &messages,
            ..RequestBuildContext::default()
        };
        let body = build_responses_request_body(&opts, &context);
        for key in ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"] {
            assert!(body.get(key).is_none(), "Responses 轨不得注入 {key}");
        }
        for item in body["input"].as_array().expect("input 数组") {
            assert!(item.get("cache_control").is_none(), "input item 不得携带断点");
        }
    }

    #[test]
    fn responses_body_omits_chat_specific_fields() {
        // reasoning_effort / thinking_intensity：chat 专有注入面，Responses 轨忽略
        let opts = ChatCompletionsRequestOptions {
            reasoning_effort: Some(ReasoningEffort::High),
            thinking_intensity: Some(ThinkingIntensity::Medium),
            model: Some("claude-opus-4-7".to_string()),
            ..ChatCompletionsRequestOptions::default()
        };
        let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_message("你好"))];
        let context = RequestBuildContext {
            messages: &messages,
            ..RequestBuildContext::default()
        };
        let body = build_responses_request_body(&opts, &context);
        for key in ["reasoning_effort", "thinking", "effort", "generation_config", "stream_options"] {
            assert!(body.get(key).is_none(), "Responses 轨不得注入 chat 专有字段 {key}");
        }
    }
}
