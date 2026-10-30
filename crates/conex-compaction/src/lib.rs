//! 上下文压缩引擎（conex-compaction）
//!
//! 单一 `AgentMessage` 面（CP-01 收敛）：
//! `estimate_context_tokens` / `find_cut_point` / `compact_agent_messages` /
//! `should_compact`，基于 `conex_types::message::AgentMessage`（blocks 形态），
//! 供 session-loop 预算层与预检触发（T-33）内联消费。
//!
//! 核心算法对齐参考实现：
//!
//! - 估算：usage 优先（时间戳护栏，pi estimate.ts:63-87）+ 本地启发式兜底
//!   （ASCII 4 字符/token、CJK 逐字符、图片固定 1600 token，jcode IMAGE_TOKEN_COST）；
//! - 切割点：从尾部倒推累计预算（keepRecentTokens=20000，pi compaction.ts:135）
//!   与合法切割点限制（不拆散 tool use/result 对，jcode safe_compaction_cutoff）；
//!   折叠链（compacted-summary 前缀，紧邻 system）为切割下界（B1/B2，00-plan §4）；
//! - 摘要：中性句柄 stub（T-13，R-C 永不改写）+ 可选 LLM 摘要器（L2 迭代合并，
//!   同步成功且输出为 Schema V1 JSON 文档时以 md 渲染进链，R-G 语源唯一）。
//!
//! 公开面（CP-04）：子模块私有，每个公开符号只有根路径
//! `conex_compaction::X` 一条。

mod ai_summary;
mod cut_point;
mod engine;
mod estimate;
mod plan;
mod recovery;
mod summary_document;
mod template;
mod tokens;
mod tool_output;

pub use ai_summary::{
    build_summarize_prompt, compaction_event_details, covers_up_to_turn_for_dropped,
    is_acceptable_summary, is_degenerate_summary, retry_allowed, summarize_with_guard,
    RetryGuardSummarizer, SummaryOutcome, SummaryRetryPolicy, MIN_SUMMARY_SEED_CHARS_DEFAULT,
    SESSION_META_KEY_COMPACT_SUMMARY_MAX_ATTEMPTS, SESSION_META_KEY_COMPACT_SUMMARY_MIN_CHARS,
    SESSION_META_KEY_COMPACT_SUMMARY_RETRY_INTERVAL_MS,
    SESSION_META_KEY_COMPACT_SUMMARY_WALL_CLOCK_BUDGET_MS, SUMMARY_MAX_ATTEMPTS_DEFAULT,
    SUMMARY_RETRY_INTERVAL_MS_DEFAULT, SUMMARY_WALL_CLOCK_BUDGET_MS_DEFAULT,
};
pub use cut_point::{
    enforce_tool_batch_closure, find_cut_point, is_within_keep_budget, KEEP_RECENT_TOKENS_DEFAULT,
    MIN_RECENT_TURNS_DEFAULT,
};
pub use engine::{preview_compaction, CompactionEngine, CompactionPreview};
pub use estimate::{
    estimate_agent_context, estimate_context_tokens, should_compact, EstimateContext,
    EstimateSource,
};
pub use plan::{
    CompactionPlan, CompactionPolicy, StubPolicy, Summarizer, MAX_SUMMARY_TOKENS_DEFAULT,
    SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
};
pub use recovery::{slot_text, CompactionBlockMeta, SummaryState};
pub use summary_document::{
    summary_to_markdown, validate_summary_document, SummaryDocError, SummaryDocument, SummaryTier,
    SUMMARY_SCHEMA_VERSION,
};
pub use template::structured_summary_template;
pub use tokens::{
    count_agent_message_tokens, count_tokens, count_tokens_fast, count_tool_output_tokens,
    IMAGE_TOKEN_COST, MESSAGE_FRAMING_TOKENS, TOOL_CALL_FRAMING_TOKENS,
};
pub use tool_output::{
    estimate_after_truncation, truncate_tool_output, ToolOutputTruncationLimits,
    ToolOutputTruncationRecord, ToolOutputTruncationResult, SESSION_META_KEY_TOOL_OUTPUT_MAX_BYTES,
    SESSION_META_KEY_TOOL_OUTPUT_MAX_LINES,
};
