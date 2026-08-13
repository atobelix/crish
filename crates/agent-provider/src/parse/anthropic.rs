//! Anthropic Messages SSE 流解析器（任务书 B2.9；02-provider-semantics.md §三.1、§六.6）
//!
//! 事件驱动（帧内含 `type` 字段，对齐 `anthropic-stream-parse.ts:24-208`）：
//! - `message_start` → usage 初始分片（message.usage，input_tokens 等，67-74、283-315）
//! - `content_block_start` → 按 index 注册 tool_use pending；thinking 块跳过
//!   （内容经 thinking_delta 到达，90-92）
//! - `content_block_delta`：`text_delta`→text-delta（105-112）；`thinking_delta`→
//!   thought-delta（不标 redacted，§1.4，114-124）；`input_json_delta`→argumentsText
//!   追加（半 JSON 分片跨帧拼接，126-137）
//! - `content_block_stop` → pending 有 name 则 emit tool-call（142-156）
//! - `message_delta` → stop_reason 覆盖 + usage 分片补全（169-175、363-388）
//! - `message_stop` → 终态（177-180）
//! - 帧级 `error` → 立即 `stop{reason:'error'}` 终止（55-65）
//!
//! stopReason 映射（272-281）：tool_use→tool-call；max_tokens→length；
//! end_turn|stop_sequence|null→stop；refusal→error；其他→stop。
//!
//! 空流保护（198-205）：无任何内容事件且无 message_stop 且无 usage →
//! `stop{error}`；流结束 flush 未 stop 的 pending tool_use（185-196，防御性）。
//!
//! 说明：同角色合并与首条空 user 前置由请求构建层负责（B2.6，任务书明确不在此层），
//! 本层只产出事件序列；message_start 携带的 model 名仅注释记录，model-mismatch
//! 诊断属外层职责（chat/responses 路径同）。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 anthropic_tests.rs /
//! anthropic_tests_usage.rs）：
//! - [anthropic_core]：解析核心（AnthropicParser 状态机：push_frame / finish /
//!   pending tool_use / 空流保护）
//! - [anthropic_map]：消息转换与映射面（stop_reason / usage / 错误帧 / 字段辅助函数）

/// 测试专用接线：旁挂测试（anthropic_tests.rs / anthropic_tests_usage.rs）经
/// `use super::*` 消费以下符号，门面自身不使用（pub(crate) 不扩大对外 API；
/// 非 test 构建下允许 unused）。
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use crate::sse::frame::SseFrame;
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use serde_json::{Map, Value};

#[path = "anthropic_core.rs"]
mod anthropic_core;
#[path = "anthropic_map.rs"]
mod anthropic_map;

pub use anthropic_core::AnthropicParser;
pub use anthropic_map::{
    anthropic_payload_error, anthropic_stop_reason_to_stop, merge_anthropic_usage,
    parse_anthropic_usage,
};

#[cfg(test)]
#[path = "anthropic_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "anthropic_tests_usage.rs"]
mod tests_usage;
