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

pub mod ai_summary;
pub mod clean_output;
pub mod cut_point;
pub mod engine;
pub mod estimate;
pub mod plan;
pub mod recovery;
pub mod summary_document;
pub mod template;
pub mod tokens;
pub mod tool_output;

pub mod compaction {
    pub use crate::cut_point::*;
    pub use crate::engine::*;
    pub use crate::plan::*;
}

pub use ai_summary::push_critical_context;
pub use cut_point::{
    enforce_tool_batch_closure, is_within_keep_budget, KEEP_RECENT_TOKENS_DEFAULT,
    MIN_RECENT_TURNS_DEFAULT,
};
pub use engine::{CompactionEngine, CompactionPreview};
pub use estimate::{EstimateContext, EstimateSource};
pub use plan::{
    CompactionPlan, CompactionPolicy, StubPolicy, Summarizer, MAX_SUMMARY_TOKENS_DEFAULT,
    SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
};
pub use template::structured_summary_template;
pub use tokens::{
    count_agent_message_tokens, count_tokens, count_tokens_fast, count_tool_output_tokens,
    IMAGE_TOKEN_COST, MESSAGE_FRAMING_TOKENS, TOOL_CALL_FRAMING_TOKENS,
};
