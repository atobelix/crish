//! 请求构建层（任务书 B2.6；02-provider-semantics.md §二.6、§六.11）
//!
//! - [build]：chat-completions 请求体构建（compactObject 等价、stream 必带 include_usage、
//!   endpoint 缺省恒 chat-completions，00 D3）
//! - [messages]：AgentMessage → wire 消息映射（角色、tool 结果、多模态 contentParts、
//!   system user-prefix 重写；不做 LruMap 缓存，§五.13）
//! - [vendor]：vendor 推断（inferReasoningVendor）、reasoningEffortObject、anthropic-beta 头、
//!   thinkingIntensity 透传适配（01 D5）
//! - [tools]：ToolDefinition → OpenAI tools 格式与 tool_choice

pub mod build;
pub mod messages;
pub mod tools;
pub mod vendor;

pub use build::{
    build_chat_completions_request_body, resolve_endpoint, ChatCompletionsRequestOptions,
    MaxTokensField, RequestBuildContext,
};
pub use messages::{
    stringify_tool_output, system_prompt_as_user_prefix, to_chat_messages, ChatContent,
    ChatContentPart, ChatMessage, ReasoningContentMode,
};
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
