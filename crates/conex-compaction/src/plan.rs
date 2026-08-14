//! 压缩策略、计划模型与 Summarizer trait（conex-compaction）

use std::sync::Arc;

use conex_types::AgentMessage;

use crate::cut_point::{KEEP_RECENT_TOKENS_DEFAULT, MIN_RECENT_TURNS_DEFAULT};
use crate::tokens::{count_agent_message_tokens, count_tokens};

/// 摘要占位符 token 上限默认（P4 §3.4.2）
pub const MAX_SUMMARY_TOKENS_DEFAULT: usize = 1_024;

/// 压缩策略（session-loop 注入 CompactionEngine，P4 §3.4.2）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionPolicy {
    /// 保留最近 N token 原文（默认 20000，对齐 pi keepRecentTokens）
    pub keep_recent_tokens: usize,
    /// 保留最近完整回合数下限（默认 2，对齐 opencode tail_turns）
    pub min_recent_turns: u32,
    /// 摘要占位符 token 上限（默认 1024）
    pub max_summary_tokens: usize,
    /// 合法切割点保护（tool use/result 不拆散，默认 true）
    pub tool_pair_protection: bool,
}

impl Default for CompactionPolicy {
    fn default() -> Self {
        Self {
            keep_recent_tokens: KEEP_RECENT_TOKENS_DEFAULT,
            min_recent_turns: MIN_RECENT_TURNS_DEFAULT,
            max_summary_tokens: MAX_SUMMARY_TOKENS_DEFAULT,
            tool_pair_protection: true,
        }
    }
}

/// 压缩计划（引擎侧决策产出；替代直接返回消息数组——事件字段需要，P4 §3.7）
///
/// 注：`AgentMessage` 未实现 `Eq`（conex-types 仅派生 PartialEq），
/// 本类型不派生 `Eq`，比较语义以 PartialEq 为准。
#[derive(Debug, Clone, PartialEq)]
pub struct CompactionPlan {
    /// 压缩后的消息序列（预算内不动 / 放弃压缩时 = 原序列）
    pub messages: Vec<Arc<AgentMessage>>,
    /// 被压缩（丢弃并进入摘要）的消息 id
    pub dropped_ids: Vec<String>,
    /// 保留的消息 id（system + 保留段；摘要占位符 id 亦计入）
    pub kept_ids: Vec<String>,
    /// 保留段首条消息 id（无压缩发生时 None；ContextCompressionRecord 用）
    pub first_kept_message_id: Option<String>,
    /// 压缩前 token 数（启发式口径）
    pub tokens_before: u64,
    /// 压缩后 token 数（启发式口径）
    pub tokens_after: u64,
    /// 摘要文本（stub 中性句柄或 Schema V1 文档的 md 渲染；未压缩时为空串）
    pub summary: String,
    /// 摘要是否来自 LLM（同步成功且输出为合法 JSON 文档；stub 为 false）
    pub summary_is_llm: bool,
    /// LLM 摘要强制面（E2 F1）：[StubPolicy::LlmRequired] 下无 Summarizer
    /// 或同步摘要失败/输出非法时置 true——对话未压缩（messages = 原序列）
    /// 但 dropped_ids 携带「本可压缩的应丢 id」供上层挂起重试/决策；
    /// 正常压缩 / [StubPolicy::StubAllowed] 降级 stub / noop 时为 false。
    pub llm_unavailable: bool,
    /// 折叠链：压缩前链消息数（原链条数；noop 时为 0）
    pub fold_chain_prev: usize,
    /// 折叠链：压缩后链消息数（含本条；noop 时为 0）
    pub fold_chain_after: usize,
    /// 本条摘要消息在链中的序号（= 链长 + 1；noop 时为 0）
    pub fold_index: usize,
    /// 压缩代数（R-K 单源；本轮引擎侧以 1 占位，V2 由会话代数
    /// SessionContextMeta.last_compaction_generation 注入）
    pub generation: u32,
}

/// LLM 摘要器（可选注入；None = L1 静态占位符，P4 §3.4.4）
///
/// P4 原稿为 `#[async_trait]` 异步接口；本 crate 以同步 trait 落地：
/// 摘要请求的调度（独立前缀域、失败降级 L1、缓存隔离）由实现方
/// （session-loop / 壳层）负责，本 crate 保持纯算法无运行时依赖。
/// `existing` 为既有摘要文本（跨压缩轮次迭代合并，P4 §3.4.3）。
pub trait Summarizer: Send + Sync {
    /// 对丢弃消息生成结构化摘要；Err 时调用方回退 L1 静态占位符
    fn summarize(
        &self,
        dropped: &[AgentMessage],
        existing: Option<&str>,
    ) -> Result<String, String>;
}

/// 摘要 stub 策略（E2 F1：LLM 摘要强制，禁止「纯丢弃式」线性压缩）
///
/// 压缩必须携带 Summarizer；无 Summarizer / 摘要失败时按策略区分：
///
/// - **[StubPolicy::StubAllowed]**：降级中性 stub（现状语义；仅
///   `compact_allow_stub_fallback=true` 豁免路径使用——溢出致命
///   路径的显式豁免，默认关）；
/// - **[StubPolicy::LlmRequired]**：放弃压缩（对话保持原样），
///   [CompactionPlan::llm_unavailable] 置 true、dropped_ids 携带
///   应丢 id——上层按路径决策：预检/边界/manual 等待 LLM 可用
///   （发事件），溢出致命路径默认 fatal（文案含「LLM 不可用」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StubPolicy {
    /// 摘要不可用（无 Summarizer / Err / 非 JSON / 超预算）→ 允许
    /// 中性 stub（现状语义；`compact_allow_stub_fallback` 豁免用）
    StubAllowed,
    /// LLM 摘要强制：摘要不可用 → 不压缩、标记 llm_unavailable
    /// （禁止纯丢弃式，E2 F1 L1/L2/L3）
    LlmRequired,
}

/// 无压缩动作的计划（预算内不动 / 无合法切割点 / 无可丢内容）
pub(crate) fn noop_plan(messages: &[Arc<AgentMessage>]) -> CompactionPlan {
    let tokens: u64 = messages
        .iter()
        .map(|m| count_agent_message_tokens(m) as u64)
        .sum();
    CompactionPlan {
        messages: messages.to_vec(),
        dropped_ids: vec![],
        kept_ids: messages.iter().map(|m| m.id.clone()).collect(),
        first_kept_message_id: None,
        tokens_before: tokens,
        tokens_after: tokens,
        summary: String::new(),
        summary_is_llm: false,
        llm_unavailable: false,
        fold_chain_prev: 0,
        fold_chain_after: 0,
        fold_index: 0,
        generation: 1,
    }
}

/// LLM 摘要不可用 → 放弃压缩的计划（E2 F1：禁止纯丢弃式线性压缩）
///
/// 对话保持原样（messages = 原序列、tokens_after = tokens_before），
/// 但 `dropped_ids` 携带「本可压缩的应丢 id」（非空）——上层据此：
/// 预检/边界/manual 路径等待 LLM 可用（发事件）；溢出致命路径默认
/// fatal（文案含「LLM 不可用」）或豁免后转 [StubPolicy::StubAllowed]
/// 重跑；`llm_unavailable = true` 与「无切割点 noop」（dropped_ids
/// 为空 + llm_unavailable=false）严格区分。
pub(crate) fn llm_blocked_plan(
    messages: &[Arc<AgentMessage>],
    cut: usize,
    dropped_ids: &[String],
    tokens_before: u64,
) -> CompactionPlan {
    CompactionPlan {
        messages: messages.to_vec(),
        dropped_ids: dropped_ids.to_vec(),
        kept_ids: messages.iter().map(|m| m.id.clone()).collect(),
        first_kept_message_id: messages.get(cut).map(|m| m.id.clone()),
        tokens_before,
        tokens_after: tokens_before,
        summary: String::new(),
        summary_is_llm: false,
        llm_unavailable: true,
        fold_chain_prev: 0,
        fold_chain_after: 0,
        fold_index: 0,
        generation: 1,
    }
}

/// L1 静态摘要占位符（旧 Message 面 / 兼容测试仍使用；AgentMessage
/// 面已由 [stub_placeholder] 取代——R-E：旧面保留，新面中性句柄）
pub(crate) fn summary_placeholder(dropped_count: usize) -> String {
    format!("[Compacted {dropped_count} earlier message(s) to fit context window]")
}

/// 中性句柄 stub（T-13；R-C：永不改写；无"生成中/失败"措辞——
/// 文本是压缩时刻状态快照，摘要就绪以块表/工具为准，不误导模型）
///
/// `generation` 入参保留（签名对齐）；代数已编码进 `block_id`
/// （R-B：`compacted-summary-{gen}-{fold}`），正文不重复出现。
pub(crate) fn stub_placeholder(block_id: &str, count: usize, _generation: u32) -> String {
    format!("[Compacted({block_id}) {count} 条消息 · 摘要见块表]")
}

/// 摘要文本按 token 上限钳制（保证 count_tokens(结果) ≤ max_tokens）
///
/// 字符预算 = max_tokens × 4（ASCII 4 字符/token 的保守上界），截断后
/// 再按启发式计数逐档收缩；省略号占 1 token 预算（内容预算先减 1）。
pub(crate) fn truncate_summary(summary: &str, max_tokens: usize) -> String {
    if count_tokens(summary) <= max_tokens {
        return summary.to_string();
    }
    let content_budget = max_tokens.saturating_sub(1);
    let mut truncated: String = summary
        .chars()
        .take(content_budget.saturating_mul(4))
        .collect();
    while count_tokens(&truncated) > content_budget && !truncated.is_empty() {
        truncated.pop();
    }
    if truncated.is_empty() {
        return "…".to_string();
    }
    truncated.push('…');
    truncated
}
