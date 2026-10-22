//! Anthropic Messages API 请求体构建域（多模型适配战役 R2 T2.1a / G7-a）
//!
//! 独立于 chat/responses 两轨的第三协议请求体（对齐 pi-ai
//! `@earendil-works/pi-ai/dist/api/anthropic-messages.js` buildParams 的形状语义，
//! 不共享 chat 轨的 tool_calls 数组形状——Anthropic 用 content 块数组承载
//! `tool_use` / `tool_result` / `text` / `thinking`）。
//!
//! 请求体形状（anthropic.messages API）：
//! ```json
//! {
//!   "model": "claude-...",
//!   "system": "<string>",
//!   "messages": [
//!     { "role": "user", "content": [ {"type":"text","text":"..."} ] },
//!     { "role": "assistant", "content": [
//!         {"type":"text","text":"..."},
//!         {"type":"thinking","thinking":"..."},
//!         {"type":"tool_use","id":"...","name":"...","input":{...}}
//!     ]},
//!     { "role": "user", "content": [
//!         {"type":"tool_result","tool_use_id":"...","content":"..."}
//!     ]}
//!   ],
//!   "max_tokens": 2048,
//!   "tools": [ {"name":"...","description":"...","input_schema":{...}} ],
//!   "thinking": { "type":"enabled", "budget_tokens": 2048 }
//! }
//! ```
//!
//! 差异化请求头：[anthropic_request_headers]（x-api-key / anthropic-version /
//!   content-type: application/json）。
//!
//! 复用基建：thinking 预算经 [super::vendor::effort_to_budget_tokens] /
//! [super::vendor::thinking_to_budget_tokens] 换算；消息块消毒复用
//! [super::messages::sanitize_tool_call_id] 与 T-34 清洗
//! [conex_compaction::clean_output::clean_output]；input_schema 复用
//! [super::schema::canonicalize_schema]。

mod body;
mod headers;
pub(crate) mod messages;
pub(crate) mod options;
mod pairing;

#[cfg(test)]
use super::{
    messages::WIRE_CONTINUATION_NOTE, tools::ToolChoice, vendor::ReasoningEffort,
    RequestBuildContext, ThinkingIntensity,
};
#[cfg(test)]
use crate::error::RequestBuildError;
#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
#[path = "../build_anthropic_tests.rs"]
mod tests;

/// anthropic.messages 接口显式版本头
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

pub use body::build_anthropic_request_body;
pub use headers::{anthropic_request_headers, build_anthropic_headers};
pub use options::{
    default_anthropic_max_tokens, AnthropicRequestOptions, DEFAULT_ANTHROPIC_MAX_OUTPUT,
};
pub use pairing::{
    detect_anthropic_unpaired_tool_calls, validate_anthropic_pairing_from_context,
    validate_anthropic_tool_pairing,
};
