//! Responses API SSE 流解析器（任务书 B2.9；02-provider-semantics.md §二.4、§六.6、§六.10）
//!
//! 事件驱动（帧内含 `type` 字段，对齐 `provider-openai-responses.ts:95-236`）：
//! - `response.output_text.delta` → text-delta（151-158）
//! - `response.reasoning_summary_text.delta` / `response.reasoning_text.delta` /
//!   `response.reasoning.delta` → thought-delta{redacted:true}（159-166、373-379，02 §六.10）
//! - `response.output_item.added` / `.done` → 合并 function_call item；`.done` 时若
//!   arguments 已就绪则 emit tool-call（167-184、290-315）
//! - `response.function_call_arguments.delta` → arguments 追加；`.done` → 替换并 emit
//!   tool-call（185-198、317-340）
//! - `response.completed` / `.failed` / `.incomplete` → 终态映射（199-211、381-388）：
//!   status=incomplete→length；failed|cancelled→error；否则 stop
//! - 帧级 `error` 事件 → 立即 `stop{reason:'error'}` 终止（138-150）
//! - usage 覆盖式：任意帧的 `usage` / `response.usage` 都可能携带（133-136；§2.5
//!   同构复用 chat 的 [super::chat::parse_usage]，02 §六.6：OpenAI 覆盖式）
//!
//! 工具调用按 item_id/call_id 分组（key 兜底 `response_call_{n}`），emit 用
//! `emitted` 集合按 call_id/id 去重（357-371）；id 缺失兜底 item_id/key。
//! 无终态事件即流结束 → `stop{reason:'error'}`（invalid-stream，218-229）；
//! `sawToolCall` 时 `stop.reason` 强制为 `tool-call`（232）。
//!
//! 说明：TS 端 parseArguments 解析失败兜底 `{}`（476-486）；本实现复用共享的
//! [super::tool_call::parse_arguments]（`__rawArguments` 兜底，02 §2.3），信息更完整，
//! 与 chat/Anthropic/Gemini 解析器行为一致（有意分歧，注释记录）。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。共享类型（[ResponsesParser] /
//! [ResponsePendingToolCall]）留本文件，实现域拆分如下（测试旁挂 responses_tests.rs）：
//! - [responses_core]：状态机（push_frame / finish / 终态与错误帧映射）
//! - [responses_tool_call]：pending function_call 管理（merge_item / merge_arguments /
//!   find_pending / emit_tool_call）

use std::collections::HashSet;

use crate::events::{ProviderUsage, StopReason, StreamParser};

#[path = "responses_core.rs"]
mod responses_core;
#[path = "responses_tool_call.rs"]
mod responses_tool_call;

pub use responses_core::response_status_to_stop;

/// pending 中的一条 function_call item（对齐 TS ResponsePendingToolCall 29-36）
///
/// TS 端 `itemDone` 字段只写不读，此处省略；`id` 字段仅作 callId 缺失时的兜底，
/// 而兜底链（item_id ?? call_id ?? key）保证 call_id 恒非空，故亦省略（emit 与
/// 去重均只用 call_id）；`argumentsDone` 用于 output_item.done 到达时判断是否
/// 已具备完整参数（172-176）。
#[derive(Debug, Clone)]
struct ResponsePendingToolCall {
    /// Map 分组 key：item_id ?? call_id ?? `response_call_{n}`
    key: String,
    /// item.call_id ?? id ?? key（事件 id 与去重均取此）
    call_id: String,
    /// 工具名（缺失表示尚未捕获到 name）
    name: String,
    /// arguments 文本（delta 追加 / done 替换）
    arguments_text: String,
    /// `response.function_call_arguments.done` 已到达
    arguments_done: bool,
}

/// Responses API 流解析器（SseFrame → ProviderStreamEvent 序列）
#[derive(Debug)]
pub struct ResponsesParser {
    /// 每流恰好一个 stop 的状态机（02 §六.9）
    stream: StreamParser,
    /// 按 item_id/call_id 分组的 pending function_call
    pending: Vec<ResponsePendingToolCall>,
    /// 已 emit 的 call_id/id（去重，357-371）
    emitted: HashSet<String>,
    /// 覆盖式 usage（任意帧都可能携带）
    usage: Option<ProviderUsage>,
    /// 终态映射结果（responseStatusToStop，381-388）
    final_reason: StopReason,
    /// 终态帧的错误文案（responseError，390-395）
    final_error: Option<String>,
    /// 流内已见过工具调用（stop 强制 tool-call，232）
    saw_tool_call: bool,
    /// 已收到终态事件（completed/failed/incomplete）
    saw_terminal: bool,
    /// 已终结（错误帧或 finish 后）
    terminated: bool,
}

impl Default for ResponsesParser {
    fn default() -> Self {
        Self {
            stream: StreamParser::new(),
            pending: Vec::new(),
            emitted: HashSet::new(),
            usage: None,
            final_reason: StopReason::Stop,
            final_error: None,
            saw_tool_call: false,
            saw_terminal: false,
            terminated: false,
        }
    }
}

#[cfg(test)]
#[path = "responses_tests.rs"]
mod tests;
