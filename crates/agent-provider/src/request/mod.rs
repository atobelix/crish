//! 请求构建层（任务书 B2.6；02-provider-semantics.md §二.6、§六.11）
//!
//! - [build]：chat-completions 请求体构建（compactObject 等价、stream 必带 include_usage、
//!   endpoint 缺省恒 chat-completions，00 D3）
//! - [messages]：AgentMessage → wire 消息映射（角色、tool 结果、多模态 contentParts、
//!   system user-prefix 重写；不做 LruMap 缓存，§五.13）
//! - [vendor]：vendor 推断（inferReasoningVendor）、reasoningEffortObject、anthropic-beta 头、
//!   thinkingIntensity 透传适配（01 D5）
//! - [schema]：JSON Schema 规范化（canonicalize_schema / canonical_json_string，
//!   前缀稳定性基础，规则真源 P6 §3.1 R2）
//! - [tools]：ToolDefinition → OpenAI tools 格式与 tool_choice
//! - [cache]：缓存参数载体与键派生（CacheRetention/TtlBucket/CacheControl/CacheKey/
//!   CacheMechanism/CacheCapability，P2 §3.1；断点分配与 wire 注入 T-13b）

pub mod build;
pub mod cache;
pub mod messages;
pub mod schema;
pub mod tools;
pub mod vendor;

// DeepSeek 请求体不变量测试钉死（T-22，P3 步骤 4；只读既有源码，只挂测试）
#[cfg(test)]
mod deepseek_invariants;

pub use build::{
    build_chat_completions_request_body, build_responses_request_body, build_system_prompt,
    resolve_endpoint, ChatCompletionsRequestOptions, MaxTokensField, RequestBuildContext,
};
pub use cache::{
    CacheCapability, CacheControl, CacheKey, CacheMechanism, CacheRetention, TtlBucket,
    OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
};
pub use messages::{
    stringify_tool_output, system_prompt_as_user_prefix, to_chat_messages,
    to_responses_input_items, ChatContent, ChatContentPart, ChatMessage, ReasoningContentMode,
};
pub use schema::{canonical_json_string, canonicalize_schema};
pub use tools::{
    default_input_schema, to_chat_tool_choice, to_openai_tool, to_responses_tool,
    to_responses_tool_choice, ToolChoice, ToolDefinition,
};
pub use vendor::{
    effort_to_budget_tokens, effort_to_gemini_thinking_level, infer_reasoning_vendor,
    infer_thinking_capability, normalize_reasoning_effort, normalize_thinking_intensity,
    reasoning_effort_headers, reasoning_effort_object, resolve_thinking_params,
    ReasoningEffort, ReasoningEffortFormat, ReasoningFormat, ReasoningVendor,
    ThinkingCapability, ThinkingIntensity, NO_THINKING,
};
