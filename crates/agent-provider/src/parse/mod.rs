//! 流解析层（任务书 B2.5、B2.9；02-provider-semantics.md §二.2-2.5、§三、§六.3-6）
//!
//! - [chat]：chat-completions SSE 帧处理（错误帧 → usage 覆盖 → text/thought delta →
//!   tool_calls → finish_reason 覆盖的顺序，仅无 choice 跳过；兼容位置全探测；
//!   RU-06/08/09）
//! - [tool_call]：tool_call 增量收集（index 分组、id/name 覆盖、arguments 追加、
//!   parseArguments 兜底）
//! - [responses]（B2.9）：Responses API SSE（output_text.delta / reasoning_*.delta /
//!   output_item.added|done / function_call_arguments.delta|done / completed|failed|
//!   incomplete 终态映射；sawToolCall 强制 tool-call；usage 覆盖式，02 §二.4、§六.6）
//! - [azure_responses]（T5.1 G7-b）：Azure OpenAI Responses 先例——与 openai responses
//!   wire 同构（pi-ai 同用 processResponsesStream），100% 委托响应内核并登记差异契约
//! - [anthropic]（B2.9）：Anthropic Messages 事件驱动（message_start usage 初始 /
//!   content_block_delta text|thinking|input_json / message_delta stop_reason + usage
//!   分片补全 / message_stop；空流保护；02 §三.1、§六.6）——SR-06e 已拆门面：
//!   解析核心 anthropic_core / 映射面 anthropic_map（测试旁挂 anthropic_tests*）
//! - [gemini]（B2.9）：Gemini 帧式（candidates[].parts text|thought|functionCall /
//!   finishReason 映射 / blockReason 阻断 / usageMetadata 逐帧合并；空流保护；
//!   02 §三.2、§六.6）——SR-06e 已拆门面：解析核心 gemini_core /
//!   映射面 gemini_map（测试旁挂 gemini_tests*）

pub mod anthropic;
pub mod azure_responses;
pub mod chat;
pub mod gemini;
pub mod responses;
pub mod tool_call;

pub use anthropic::{
    anthropic_payload_error, anthropic_stop_reason_to_stop, merge_anthropic_usage,
    parse_anthropic_usage, AnthropicParser,
};
pub use azure_responses::AzureResponsesParser;
pub use chat::{finish_reason_to_stop, parse_usage, ChatCompletionsParser};
pub use gemini::{
    gemini_finish_reason_to_stop, merge_gemini_usage, normalize_function_args, parse_gemini_usage,
    GeminiParser,
};
pub use responses::{response_status_to_stop, ResponsesParser};
pub use tool_call::{
    parse_arguments, parse_full_tool_call, ToolCall, ToolCallCollector, ToolCallFlush,
};
