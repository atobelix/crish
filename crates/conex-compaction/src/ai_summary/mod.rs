//! AI 压缩摘要通道（M10 / C9：AI 摘要生成 + 退化重试护栏）
//!
//! conex-compaction 保持纯算法、无运行时依赖（既有 crate 定位，P4 §3.4.4）：
//!
//! - **摘要提示词**：把被丢弃消息渲染为模型输入，提示输出 **Schema V1
//!   JSON 文档**（12 required 字段，[crate::summary_document]）；
//!   存在既有摘要时传入做迭代合并（P4 §3.4.3 / 02 Top 9
//!   「Previous Summary + New Conversation」）；
//! - **退化重试护栏**：空/过短摘要（< 500 字符，对齐 grok
//!   MIN_SUMMARY_SEED_CHARS）视为瞬态，至多重试 N 次（默认 3 次、
//!   3s 间隔、wall-clock 预算兜底）后仍失败才降级回退占位符
//!   （02 Top 3；降级语义由调用方经 [crate::compaction::Summarizer]
//!   的 Err 路径落到既有 `[Compacted N...]` 占位符，不阻塞 run）；
//! - **covers_up_to_turn 落库载荷**：压缩覆盖到哪一轮（被丢弃段内
//!   用户回合数），随 [compaction_event_details] 产出事件 details
//!   载荷（02 Top 9，M11 拼接注入消费）。
//!
//! provider 调用通道：真实模型调用由调用方（session-loop 壳层）实现
//! [crate::compaction::Summarizer] 注入（经 agent-provider 通道，
//! Q5 暂定引擎内部调用、独立小预算；生产实现 ProviderSummarizer 直接
//! 消费 [build_summarize_prompt]）；本模块只提供重试护栏与模板协议。

mod details;
mod guard;
mod prompt;

pub use details::{compaction_event_details, covers_up_to_turn_for_dropped};
pub use guard::{
    retry_allowed, summarize_with_guard, RetryGuardSummarizer, SummaryOutcome, SummaryRetryPolicy,
};
pub use prompt::{
    build_summarize_prompt, is_acceptable_summary, is_degenerate_summary, push_critical_context,
};

// ── 默认值与 session_meta 键（配置面 Q1：默认值在配置面、覆盖走
//    session_meta；键命名空间 compact_*，04 §3.5）──

/// 摘要总尝试次数默认（对齐 grok max_attempts=3）
pub const SUMMARY_MAX_ATTEMPTS_DEFAULT: u32 = 3;
/// 摘要重试间隔默认（3s）
pub const SUMMARY_RETRY_INTERVAL_MS_DEFAULT: u64 = 3_000;
/// 退化摘要字符下限默认（对齐 grok MIN_SUMMARY_SEED_CHARS=500）
pub const MIN_SUMMARY_SEED_CHARS_DEFAULT: usize = 500;
/// 摘要 wall-clock 预算默认（300s，对齐 grok wall_clock_budget_secs=300）
pub const SUMMARY_WALL_CLOCK_BUDGET_MS_DEFAULT: u64 = 300_000;

/// session_meta 键：摘要总尝试次数
pub const SESSION_META_KEY_COMPACT_SUMMARY_MAX_ATTEMPTS: &str = "compact_summary_max_attempts";
/// session_meta 键：摘要重试间隔（毫秒）
pub const SESSION_META_KEY_COMPACT_SUMMARY_RETRY_INTERVAL_MS: &str =
    "compact_summary_retry_interval_ms";
/// session_meta 键：退化摘要字符下限
pub const SESSION_META_KEY_COMPACT_SUMMARY_MIN_CHARS: &str = "compact_summary_min_chars";
/// session_meta 键：摘要 wall-clock 预算（毫秒）
pub const SESSION_META_KEY_COMPACT_SUMMARY_WALL_CLOCK_BUDGET_MS: &str =
    "compact_summary_wall_clock_budget_ms";

#[cfg(test)]
mod tests;
