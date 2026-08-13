//! Gemini streamGenerateContent SSE 流解析器（任务书 B2.9；02-provider-semantics.md §三.2、§六.6）
//!
//! 帧式解析（对齐 `gemini-stream-parse.ts:18-188`）：
//! - 每帧 `candidates[].content.parts[]`：`part.thought===true` 且带 text →
//!   thought-delta（96-104）；`part.text` → text-delta（106-110）；
//!   `functionCall` / `function_call` → 完整工具调用一次性产出（112-138，
//!   缺 name 丢弃；id 缺失兜底 `gemini_fc_{n}`）
//! - `candidate.finishReason` → 映射（141-154、305-336）：STOP|END_TURN→stop；
//!   MAX_TOKENS→length；SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII|
//!   IMAGE_SAFETY|MALFORMED_FUNCTION_CALL|OTHER→error（带 `Gemini finishReason: X` 文案）；
//!   未指定且有工具调用→tool-call
//! - 有工具调用且 reason 为 stop 时强制 tool-call（158-160）
//! - `promptFeedback.blockReason` 且无 candidates → `stop{error}`（60-71、398-414）
//! - `usageMetadata` 每帧合并（73-76、456-479；02 §六.6：Gemini 逐帧合并）
//! - 顶层 `error` 对象 → 立即 `stop{reason:'error'}`（48-58）
//!
//! 空流保护（162-169）：无内容事件且无终态帧且无 usage → `stop{error}`。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 gemini_tests.rs /
//! gemini_tests_usage.rs）：
//! - [gemini_core]：解析核心（GeminiParser 状态机：push_frame / finish / 空流保护）
//! - [gemini_map]：消息转换与映射面（finishReason / usage / 错误帧 / 阻断 / 工具参数归一化）

/// 测试专用接线：旁挂测试（gemini_tests.rs / gemini_tests_usage.rs）经
/// `use super::*` 消费以下符号，门面自身不使用（pub(crate) 不扩大对外 API；
/// 非 test 构建下允许 unused）。
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use crate::sse::frame::SseFrame;
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use serde_json::Value;

#[path = "gemini_core.rs"]
mod gemini_core;
#[path = "gemini_map.rs"]
mod gemini_map;

pub use gemini_core::GeminiParser;
pub use gemini_map::{
    gemini_finish_reason_to_stop, merge_gemini_usage, normalize_function_args, parse_gemini_usage,
};

#[cfg(test)]
#[path = "gemini_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "gemini_tests_usage.rs"]
mod tests_usage;
