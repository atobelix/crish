//! chat-completions 请求体构建（任务书 B2.6；02-provider-semantics.md §二.6、§五 #1；00 D3）
//!
//! 对齐 `model:provider-openai-chat.ts:33-79`（buildChatCompletionsRequestBody）：
//! `{model, stream, temperature?, top_p?, maxTokens 字段?, reasoning 字段?, messages,
//! tools?, tool_choice?, stream_options:{include_usage:true}}`；compactObject 等价
//! （None 字段一律省略）。endpoint 缺省恒 chat-completions（00 D3：config 已保证，
//! 此处提供 [resolve_endpoint] 兜底）。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 build_chat_tests.rs /
//! build_cache_tests.rs / build_responses_tests.rs，公共测试构造经 build_tests_common.rs）：
//! - [build_chat]：chat-completions 请求体构建域（[build_chat_completions_request_body]）
//! - [build_responses]：Responses API 请求体构建与会话亲和头域
//!   （[build_responses_request_body] / [affinity_http_headers]）

use conex_types::message::AgentMessage;
use conex_types::tool::SystemPromptWireMode;
use std::sync::Arc;

use crate::config::Endpoint;

use super::cache::CachePolicy;
use super::messages::ReasoningContentMode;
use super::tools::{ToolChoice, ToolDefinition};
use super::vendor::{ReasoningEffort, ReasoningVendor, ThinkingIntensity};

#[path = "build_chat.rs"]
mod build_chat;
#[path = "build_responses.rs"]
mod build_responses;
#[path = "vendor/dialect.rs"]
pub mod dialect;

pub use build_chat::build_chat_completions_request_body;
pub use build_responses::{affinity_http_headers, build_responses_request_body};
pub use dialect::{assemble_thinking_dialect, DialectBuildOptions, ThinkingDialectFormat};

#[cfg(test)]
#[path = "build_cache_tests.rs"]
mod cache_tests;
#[cfg(test)]
#[path = "build_chat_tests.rs"]
mod chat_tests;
#[cfg(test)]
#[path = "build_responses_tests.rs"]
mod responses_tests;
#[cfg(test)]
#[path = "build_tests_common.rs"]
mod test_common;

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
    /// 用户在 models.yaml 中为该模型配置的思考拍平映射字典（IndexMap<String, String>）
    pub thinking_map: Option<indexmap::IndexMap<String, String>>,
    /// 显式配置的思考方言组装格式
    pub thinking_format: Option<crate::models::catalog_types::ThinkingFormat>,
    /// 是否支持思考（WireCompat 入参：developer role 判定三要素之一；
    /// 来自出站剖面 `thinking_map` 非空）
    pub supports_reasoning: bool,
    /// 兼容规格（WireCompat 入参：thinking_format / supports_developer_role /
    /// max_tokens_field / cacheControlFormat；模型 ≻ 供应商合并）
    pub compat: Option<crate::models::catalog_types::CompatSpec>,
}

/// Responses API 请求构建选项（对齐 ChatCompletionsRequestOptions 统一契约）
pub type ResponsesRequestOptions = ChatCompletionsRequestOptions;

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
