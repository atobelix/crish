//! 核心压缩编排引擎（conex-compaction）
//!
//! 职责划分：本模块承载 `CompactionEngine` 状态、构造与 `AgentMessage` 面压缩
//! 主流程；stub 文本、折叠链代数推导与摘要块生成在 [stub]；紧急二次预检与
//! 压缩预览在 [preflight]。

mod preflight;
mod stub;

use std::sync::Arc;

use conex_types::{AgentMessage, AgentMessageRole};

use crate::cut_point::find_cut_point_inner;
use crate::plan::{
    llm_blocked_plan, noop_plan, truncate_summary, CompactionPlan, CompactionPolicy, StubPolicy,
    Summarizer,
};
use crate::summary_document::{summary_to_markdown, validate_summary_document};
use crate::tokens::{count_agent_message_tokens, count_tokens};

use preflight::apply_emergency_preflight;

pub use preflight::preview_compaction;

/// 压缩引擎：唯一状态为压缩代数。
///
/// 预算、保留策略、摘要预算一律经方法参数（[CompactionPolicy] /
/// `budget_tokens`）传入，引擎自身不持有第二个真源。
#[derive(Default)]
pub struct CompactionEngine {
    /// 压缩代数（None = 从上下文或既有链历史推导）
    generation: Option<u32>,
}

/// 压缩预览：[preview_compaction] 的产出——
/// 「本可压缩的应丢消息 + 既有摘要文本」。供调用方在主压缩方法之前
/// 经 spawn_blocking 异步预计算摘要（session-loop summarize_via_blocking）。
#[derive(Debug, Clone)]
pub struct CompactionPreview {
    /// 本可压缩的应丢消息（值克隆；与主方法 cut 同源）
    pub dropped: Vec<AgentMessage>,
    /// 既有摘要文本（链尾最近一条非空 compacted-summary 文本）
    pub existing: Option<String>,
}

/// 摘要文本决策结果：可用摘要（stub / LLM 文档渲染）或「LLM 不可用」。
enum SummaryResolution {
    /// 摘要可用；`is_llm` 表示是否来自 Schema V1 文档渲染
    Ready { text: String, is_llm: bool },
    /// [StubPolicy::LlmRequired] 下无可用摘要 → 放弃压缩
    LlmUnavailable,
}

impl CompactionEngine {
    /// 无状态构造：预算只经方法参数传入，generation 缺省时按消息链推导。
    pub fn new() -> Self {
        Self::default()
    }

    /// 链式注入 generation（唯一显式设置入口）
    pub fn with_generation(mut self, generation: u32) -> Self {
        self.generation = Some(generation);
        self
    }

    /// 压缩对话（AgentMessage 面；保留策略见 `CompactionPolicy`）
    ///
    /// 流程：
    ///
    /// 1. 预算内不动（`tokens_before <= budget_tokens`，对齐既有
    ///    `cache_hit_rate_optimized` 语义）与空输入：原样返回；
    /// 2. 无合法切割点（tool 孤儿无法配对 / 保留段覆盖全部消息）：
    ///    放弃压缩，原样返回（宁可暂不压缩也不破坏语义，jcode
    ///    safe_compaction_cutoff:289-290）；
    /// 3. 保留尾部：[crate::find_cut_point] 计算保留段；保留段之前的 **system
    ///    消息恒保留**（置于输出头部），**折叠链（compacted-summary
    ///    前缀）恒保留**（B1 冻结：链永不改写/丢失/折叠），
    ///    其余中间段合并为摘要；
    /// 4. 摘要：注入 [Summarizer] 时同步单次尝试（R-F）；成功且输出为
    ///    Schema V1 JSON 文档（[crate::validate_summary_document]）
    ///    时以 markdown 渲染进链（R-G 语源唯一，summary_is_llm=true），
    ///    否则按 [StubPolicy] 决策——[StubPolicy::StubAllowed] 降级中性
    ///    stub（R-C 永不改写，state=awaiting）、[StubPolicy::LlmRequired]
    ///    放弃压缩（E2 F1，llm_unavailable=true）；摘要受
    ///    `max_summary_tokens` 钳制；检测到既有链消息时取**链尾**文本
    ///    作为 `existing` 传入摘要器走迭代合并（P4 §3.4.3）；
    /// 5. 摘要消息以 `assistant` 角色插入 system + 链之后、保留段之前
    ///    （保持"system → 链 → 新摘要 → 保留尾部"的对话形态，B4）；
    ///    id = `compacted-summary-{generation}-{fold_index}`（R-B，
    ///    fold_index = 链长 + 1，B3 只增），metadata 携带
    ///    `{summary: {blockId, state, droppedIds, height, generation}}` 快照。
    ///
    /// `budget_tokens` 为目标预算（window - reserve，由调用方换算）。
    ///
    /// 本签名等价 [Self::compact_agent_messages_with_stub_policy] 的
    /// [StubPolicy::StubAllowed]（现状语义，向后兼容——无 Summarizer /
    /// 摘要失败降级 stub）。
    ///
    /// **兼容 wrapper（测试 / 手动压缩路径）**：内部同步调用 summarizer
    /// （preview + summarize → precomputed）；async run loop 主路径不走本
    /// 方法——经 [preview_compaction] + session-loop
    /// `summarize_via_blocking`（spawn_blocking）预计算后调
    /// [Self::compact_agent_messages_with_stub_policy]（DEL-9：run loop
    /// 无同步 summarize 直调）。
    pub fn compact_agent_messages(
        &self,
        messages: &[Arc<AgentMessage>],
        budget_tokens: usize,
        policy: &CompactionPolicy,
        summarizer: Option<&dyn Summarizer>,
    ) -> CompactionPlan {
        // 同步 preview + summarize（仅本 wrapper / 手动命令路径；run loop 不经此）
        let summarize_precomputed = summarizer.and_then(|s| {
            preview_compaction(messages, policy)
                .map(|preview| s.summarize(&preview.dropped, preview.existing.as_deref()))
        });
        self.compact_agent_messages_with_stub_policy(
            messages,
            budget_tokens,
            policy,
            StubPolicy::StubAllowed,
            summarize_precomputed,
        )
    }

    /// 压缩对话（带 [StubPolicy] 决策面，E2 F1）
    ///
    /// 流程与 [Self::compact_agent_messages] 一致；差异仅在摘要不可用
    /// （无预计算摘要 / Err / 非 JSON / 超预算）时的行为：
    ///
    /// - [StubPolicy::StubAllowed]：降级中性 stub（与旧签名一致）；
    /// - [StubPolicy::LlmRequired]：**放弃压缩**（messages = 原序列），
    ///   [CompactionPlan::llm_unavailable] = true，且 dropped_ids 携带
    ///   「本可压缩的应丢 id」——上层按路径决策（预检等待 / 溢出 fatal /
    ///   豁免 stub），并可用 dropped_ids 发起后台补摘要（F2 层 1）。
    ///
    /// **D10-A / DEL-9**：本方法不再裸调 `summarizer.summarize`——摘要
    /// 结果经 `summarize_precomputed` 注入。async run loop（预检/边界/
    /// 溢出）经 [preview_compaction] + session-loop
    /// `summarize_via_blocking`（spawn_blocking + 墙钟）预计算后传入；
    /// `None` = 无摘要可用（按 stub_policy 决策）。
    pub fn compact_agent_messages_with_stub_policy(
        &self,
        messages: &[Arc<AgentMessage>],
        budget_tokens: usize,
        policy: &CompactionPolicy,
        stub_policy: StubPolicy,
        summarize_precomputed: Option<Result<String, String>>,
    ) -> CompactionPlan {
        let Some(prepared) = prepare_compaction(messages, policy) else {
            return noop_plan(messages);
        };
        let PreparedCompaction {
            tokens_before,
            cut,
            dropped_tokens,
            mut dropped_ids,
        } = prepared;

        // 折叠推导（R-B：id 与链序号同名，fold_index 只增）与摘要生成
        // （R-F / D10-A / E2 F1，语义见 [resolve_summary]）
        let (chain_count, generation, fold_index, block_id) =
            derive_fold_identity(self.generation, messages, cut);

        let (summary, summary_is_llm) = match resolve_summary(
            summarize_precomputed,
            stub_policy,
            &block_id,
            dropped_ids.len(),
            generation,
            policy.max_summary_tokens,
        ) {
            SummaryResolution::Ready { text, is_llm } => (text, is_llm),
            SummaryResolution::LlmUnavailable => {
                return llm_blocked_plan(messages, cut, &dropped_ids, tokens_before);
            }
        };

        let mut result = assemble_compacted_messages(
            messages,
            cut,
            &block_id,
            &summary,
            summary_is_llm,
            &dropped_ids,
            generation,
        );

        // 1C-9：tokens_after 增量推导（避免对 result 做第二次全量遍历）
        let mut tokens_after = derive_tokens_after(tokens_before, dropped_tokens, &summary);

        // 【核心加固 3：追加后紧急二次预检（Emergency Preflight / Fallback
        // Compaction）】若追加新摘要或组装保留段后，总 Token 仍超过预算上限，
        // 强制执行兜底压缩，杜绝 400 错误
        if budget_tokens >= policy.keep_recent_tokens && tokens_after > budget_tokens as u64 {
            tokens_after = apply_emergency_preflight(
                &mut result,
                &mut dropped_ids,
                messages,
                cut,
                budget_tokens,
                policy,
                &block_id,
            );
        }

        finish_plan(PlanParts {
            result,
            dropped_ids,
            summary,
            summary_is_llm,
            tokens_before,
            tokens_after,
            fold_chain_prev: chain_count,
            fold_index,
            generation,
        })
    }
}

/// 压缩前置计算结果：预算前 token、合法 cut、应丢消息 id 与 token 数。
struct PreparedCompaction {
    /// 压缩前总 token（启发式口径）
    tokens_before: u64,
    /// 保留段起始下标
    cut: usize,
    /// 被丢弃消息的 token 数（`tokens_after` 增量推导用）
    dropped_tokens: u64,
    /// 被丢弃消息 id
    dropped_ids: Vec<String>,
}

/// 前置计算；返回 None = 无压缩动作（空输入 / 无合法切割点 / 无可丢消息）
fn prepare_compaction(
    messages: &[Arc<AgentMessage>],
    policy: &CompactionPolicy,
) -> Option<PreparedCompaction> {
    // 1C-9：入口单次遍历计算 tokens_before；dropped_tokens 在 cut 确定、
    // dropped_arcs 构建后用同一口径补算，避免对 result 再做全量遍历。
    let tokens_before = total_message_tokens(messages);
    if messages.is_empty() {
        return None;
    }

    // 计算保留段起始（tool 配对保护；None = 无合法切割点，放弃压缩）
    let cut = find_cut_point_inner(
        messages,
        policy.keep_recent_tokens,
        policy.min_recent_turns,
        policy.tool_pair_protection,
    )?;

    // 中间段 = 保留段之前的非 system 消息（system 恒保留；链消息永不入
    // dropped——B1 冻结）；可切但无可丢消息（如保留段前仅有 system/链）同样放弃
    let dropped_arcs = collect_dropped_messages(messages, cut);
    if dropped_arcs.is_empty() {
        return None;
    }
    let dropped_tokens = total_message_tokens(&dropped_arcs);
    let dropped_ids = dropped_arcs.iter().map(|m| m.id.clone()).collect();
    Some(PreparedCompaction {
        tokens_before,
        cut,
        dropped_tokens,
        dropped_ids,
    })
}

/// 消息序列的总 token（启发式口径，单次遍历）
fn total_message_tokens(messages: &[Arc<AgentMessage>]) -> u64 {
    messages
        .iter()
        .map(|m| count_agent_message_tokens(m) as u64)
        .sum()
}

/// cut 之前的中间段消息（system 恒保留；折叠链永不丢弃——B1 冻结）
fn collect_dropped_messages(messages: &[Arc<AgentMessage>], cut: usize) -> Vec<Arc<AgentMessage>> {
    messages[..cut]
        .iter()
        .filter(|m| m.role != AgentMessageRole::System && !stub::is_fold_chain_message(m))
        .cloned()
        .collect()
}

/// 保留段首条消息 id（system 与折叠链不计入保留段起点；无则 None）
fn first_retained_message_id(messages: &[Arc<AgentMessage>]) -> Option<String> {
    messages
        .iter()
        .find(|m| m.role != AgentMessageRole::System && !stub::is_fold_chain_message(m))
        .map(|m| m.id.clone())
}

/// `tokens_after` 增量推导（1C-9）。
///
/// result = (system + 链) + 新摘要 + messages[cut..]，其中
/// (system+链+messages[cut..]) = messages - dropped_arcs
/// → token = tokens_before - dropped_tokens；再加上新摘要单 Text 块的 token
/// （count_tokens(summary) 与该消息经 count_agent_message_tokens 的结果一致——
/// 单 Text 块路径），避免对 result 做第二次全量遍历。
fn derive_tokens_after(tokens_before: u64, dropped_tokens: u64, summary: &str) -> u64 {
    tokens_before - dropped_tokens + count_tokens(summary) as u64
}

/// 计划收口字段（组装结果 + 摘要决策 + 折叠链快照）
struct PlanParts {
    result: Vec<Arc<AgentMessage>>,
    dropped_ids: Vec<String>,
    summary: String,
    summary_is_llm: bool,
    tokens_before: u64,
    tokens_after: u64,
    fold_chain_prev: usize,
    fold_index: usize,
    generation: u32,
}

/// 计划收口：补 kept_ids / 保留段首条 id 后落地 [CompactionPlan]
fn finish_plan(parts: PlanParts) -> CompactionPlan {
    let kept_ids: Vec<String> = parts.result.iter().map(|m| m.id.clone()).collect();
    let first_kept_message_id = first_retained_message_id(&parts.result);
    CompactionPlan {
        messages: parts.result,
        dropped_ids: parts.dropped_ids,
        kept_ids,
        first_kept_message_id,
        tokens_before: parts.tokens_before,
        tokens_after: parts.tokens_after,
        summary: parts.summary,
        summary_is_llm: parts.summary_is_llm,
        llm_unavailable: false,
        fold_chain_prev: parts.fold_chain_prev,
        fold_chain_after: parts.fold_index,
        fold_index: parts.fold_index,
        generation: parts.generation,
    }
}

/// 折叠推导：链长、代数、fold_index 与新摘要块 id（R-B）。
///
/// fold_index = 链长 + 1（只增）；块 id 与摘要消息 id 同名
/// `compacted-summary-{generation}-{fold_index}`。generation 优先取显式注入，
/// 兜底取链尾既有代数（同代数内只增 fold），默认 1——严格单调自增。
fn derive_fold_identity(
    explicit_generation: Option<u32>,
    messages: &[Arc<AgentMessage>],
    cut: usize,
) -> (usize, u32, usize, String) {
    let chain_count = stub::fold_chain_len(messages, cut);
    let generation = stub::resolve_generation(explicit_generation, messages, cut);
    let fold_index = chain_count + 1;
    let block_id = stub::summary_block_id(generation, fold_index);
    (chain_count, generation, fold_index, block_id)
}

/// 摘要文本决策（R-F / D10-A / E2 F1）
///
/// 有预计算摘要且为 Schema V1 JSON 文档 → md 渲染（is_llm=true）；其余
/// （非 JSON / 超预算 / Err / 无注入）按 [StubPolicy] 决策：StubAllowed →
/// 中性 stub（R-C 永不改写，state=awaiting；原文不保留，保守语义）；
/// LlmRequired → [SummaryResolution::LlmUnavailable]（禁止纯丢弃式线性压缩）。
fn resolve_summary(
    summarize_precomputed: Option<Result<String, String>>,
    stub_policy: StubPolicy,
    block_id: &str,
    dropped_count: usize,
    generation: u32,
    max_summary_tokens: usize,
) -> SummaryResolution {
    // 惰性生成：仅在实际需要降级 stub 时才格式化 + 钳制
    let stub = || stub::stub_summary(block_id, dropped_count, generation, max_summary_tokens);
    let Some(summary_result) = summarize_precomputed else {
        // 无预计算摘要（E2 F1 L1）：LlmRequired 下不产生 stub——放弃压缩等待
        // LLM 可用；StubAllowed 下保持现状
        return match stub_policy {
            StubPolicy::LlmRequired => SummaryResolution::LlmUnavailable,
            StubPolicy::StubAllowed => SummaryResolution::Ready {
                text: stub(),
                is_llm: false,
            },
        };
    };
    match summary_result {
        Ok(text) => {
            // 字节预算 = max_summary_tokens × 4（ASCII 4 字符/token、
            // CJK 3 字节/字符 ≤ 4 字节/token 的保守上界）
            match validate_summary_document(&text, max_summary_tokens.saturating_mul(4)) {
                Ok(doc) => SummaryResolution::Ready {
                    text: truncate_summary(&summary_to_markdown(&doc), max_summary_tokens),
                    is_llm: true,
                },
                Err(_) => match stub_policy {
                    StubPolicy::LlmRequired => SummaryResolution::LlmUnavailable,
                    StubPolicy::StubAllowed => SummaryResolution::Ready {
                        text: stub(),
                        is_llm: false,
                    },
                },
            }
        }
        Err(_) => match stub_policy {
            StubPolicy::LlmRequired => SummaryResolution::LlmUnavailable,
            StubPolicy::StubAllowed => SummaryResolution::Ready {
                text: stub(),
                is_llm: false,
            },
        },
    }
}

/// 组装压缩后序列：system + 链全查（按原始顺序）+ 新摘要 + 保留段
fn assemble_compacted_messages(
    messages: &[Arc<AgentMessage>],
    cut: usize,
    block_id: &str,
    summary: &str,
    summary_is_llm: bool,
    dropped_ids: &[String],
    generation: u32,
) -> Vec<Arc<AgentMessage>> {
    let mut result: Vec<Arc<AgentMessage>> = messages[..cut]
        .iter()
        .filter(|m| m.role == AgentMessageRole::System || stub::is_fold_chain_message(m))
        .cloned()
        .collect();
    // 时间戳沿用对话末条消息：护栏按"晚于压缩边界"语义不会被作废
    let created_at = messages
        .last()
        .map(|m| m.created_at.clone())
        .unwrap_or_default();
    result.push(Arc::new(stub::build_summary_message(
        block_id,
        summary,
        summary_is_llm,
        dropped_ids,
        generation,
        created_at,
    )));
    result.extend_from_slice(&messages[cut..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole};

    #[test]
    fn test_explicit_generation_generates_correct_block_id() {
        let engine = CompactionEngine::new().with_generation(3);
        let messages = vec![
            Arc::new(AgentMessage {
                id: "u1".to_string(),
                role: AgentMessageRole::User,
                created_at: String::new(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "hello world 1".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: Some("hello world 1".to_string()),
            }),
            Arc::new(AgentMessage {
                id: "a1".to_string(),
                role: AgentMessageRole::Assistant,
                created_at: String::new(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "answer 1".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: Some("answer 1".to_string()),
            }),
            Arc::new(AgentMessage {
                id: "u2".to_string(),
                role: AgentMessageRole::User,
                created_at: String::new(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "hello world 2".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: Some("hello world 2".to_string()),
            }),
            Arc::new(AgentMessage {
                id: "a2".to_string(),
                role: AgentMessageRole::Assistant,
                created_at: String::new(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "answer 2".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: Some("answer 2".to_string()),
            }),
        ];
        let policy = CompactionPolicy {
            keep_recent_tokens: 5,
            min_recent_turns: 1,
            ..Default::default()
        };
        let plan = engine.compact_agent_messages_with_stub_policy(
            &messages,
            10,
            &policy,
            StubPolicy::StubAllowed,
            None,
        );
        assert_eq!(plan.generation, 3);
        assert_eq!(plan.fold_index, 1);
        let summary_msg = plan
            .messages
            .iter()
            .find(|m| m.id.starts_with("compacted-summary"))
            .expect("should have summary message");
        assert_eq!(summary_msg.id, "compacted-summary-3-1");
        assert_eq!(
            summary_msg.metadata.as_ref().unwrap()["isCompactedSummary"],
            true
        );
        assert_eq!(
            summary_msg.metadata.as_ref().unwrap()["summary"]["generation"],
            3
        );
    }
}
