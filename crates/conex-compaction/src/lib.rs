//! 上下文压缩引擎（conex-compaction）
//!
//! 双面结构（P4 阶段 2-1 / 阶段 3-1，T-32）：
//!
//! - **旧 `Message` 面**：`compaction::CompactionEngine::compact(&[Message])`
//!   三字段模型（id/role/content），供 UI 手动压缩工具命令
//!   `core_compact_messages` 使用（core_commands.rs:191-207，IPC 面保留兼容）；
//! - **`AgentMessage` 面**：`estimate_context_tokens` /
//!   `find_cut_point` / `compact_agent_messages` / `should_compact`，基于
//!   `conex_types::message::AgentMessage`（blocks 形态），供 session-loop
//!   预算层与预检触发（T-33）内联消费。旧面标记为"已迁移"：新功能一律在
//!   AgentMessage 面实现，旧面不再演进。
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
pub mod plan;
pub mod recovery;
pub mod summary_document;
pub mod template;
pub mod thresholds;
pub mod tokens;
pub mod tool_output;

pub mod compaction {
    pub use crate::cut_point::*;
    pub use crate::engine::*;
    pub use crate::plan::*;
    pub use crate::thresholds::*;
}

pub use cut_point::{
    enforce_tool_batch_closure, KEEP_RECENT_TOKENS_DEFAULT, MIN_RECENT_TURNS_DEFAULT,
};
pub use engine::CompactionEngine;
pub use plan::{
    CompactionPlan, CompactionPolicy, StubPolicy, Summarizer, MAX_SUMMARY_TOKENS_DEFAULT,
};
pub use template::structured_summary_template;
pub use thresholds::{
    parse_iso8601_epoch_ms, CompactionThresholds, EstimateContext, EstimateSource,
    ThresholdDecision, COMPACT_CRITICAL_RATIO_DEFAULT, COMPACT_THRESHOLD_RATIO_DEFAULT,
    SESSION_META_KEY_COMPACT_CRITICAL_RATIO, SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
    SESSION_META_KEY_COMPACT_THRESHOLD_RATIO,
};
pub use tokens::{
    count_agent_message_tokens, count_tokens, count_tool_output_tokens, IMAGE_TOKEN_COST,
};
