//! 核心压缩编排引擎与紧急预检（conex-compaction）

use std::sync::Arc;

use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole, CompactionResult, Message};

use crate::cut_point::find_cut_point_inner;
use crate::plan::{
    llm_blocked_plan, noop_plan, stub_placeholder, summary_placeholder, truncate_summary,
    CompactionPlan, CompactionPolicy, StubPolicy, Summarizer,
};
use crate::thresholds::{
    estimate_with_usage, find_usage_message, usage_occupancy, EstimateContext,
};
use crate::tokens::{count_agent_message_tokens, count_tokens};

pub struct CompactionEngine {
    max_tokens: usize,
    /// 压缩代数（None = 从上下文或既有链历史推导，BC05-3）
    generation: Option<u32>,
}

/// 压缩预览（D10-A）：[CompactionEngine::preview_compaction] 的产出——
/// 「本可压缩的应丢消息 + 既有摘要文本」。供调用方在主压缩方法之前
/// 经 spawn_blocking 异步预计算摘要（session-loop summarize_via_blocking）。
#[derive(Debug, Clone)]
pub struct CompactionPreview {
    /// 本可压缩的应丢消息（值克隆；与主方法 cut 同源）
    pub dropped: Vec<AgentMessage>,
    /// 既有摘要文本（链尾最近一条非空 compacted-summary 文本）
    pub existing: Option<String>,
}

impl CompactionEngine {
    pub fn new(max_tokens: usize) -> Self {
        Self {
            max_tokens,
            generation: None,
        }
    }

    /// 显式接收外部 generation 构造（BC05-3 单源化，消除主键冲突）
    pub fn new_with_generation(max_tokens: usize, generation: u32) -> Self {
        Self {
            max_tokens,
            generation: Some(generation),
        }
    }

    /// 链式注入 generation
    pub fn with_generation(mut self, generation: u32) -> Self {
        self.generation = Some(generation);
        self
    }

    /// 变更当前代数
    pub fn set_generation(&mut self, generation: u32) {
        self.generation = Some(generation);
    }

    /// Compact messages to fit within max_tokens budget.
    /// Strategy: keep system messages and recent messages intact;
    /// when over budget, merge oldest non-system messages into a summary placeholder.
    ///
    /// 【迁移标记】旧 `Message` 三字段面（P4 §1.2：保留原面兼容
    /// `core_compact_messages` IPC 工具命令）；压缩主路径已迁移至
    /// AgentMessage 面（[Self::compact_agent_messages]），本方法不再演进。
    pub fn compact(&self, messages: &[Message]) -> CompactionResult {
        if messages.is_empty() {
            return CompactionResult {
                messages: vec![],
                tokens_consumed: 0,
                cache_hit_rate_optimized: false,
            };
        }

        // Pre-compute token counts once (#5: avoid repeated count_tokens calls)
        let token_counts: Vec<usize> = messages.iter().map(|m| count_tokens(&m.content)).collect();

        let total_tokens: usize = token_counts.iter().sum();

        // Under budget: no compaction needed
        if total_tokens <= self.max_tokens {
            return CompactionResult {
                messages: messages.to_vec(),
                tokens_consumed: total_tokens,
                cache_hit_rate_optimized: true,
            };
        }

        // Over budget: compact oldest non-system messages
        let mut result_messages: Vec<Message> = Vec::new();
        let mut tokens_used: usize = 0;

        // Partition indices into system vs non-system
        let system_indices: Vec<usize> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == "system")
            .map(|(i, _)| i)
            .collect();
        let non_system_indices: Vec<usize> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role != "system")
            .map(|(i, _)| i)
            .collect();

        // Always keep system messages
        for &idx in &system_indices {
            tokens_used += token_counts[idx];
            result_messages.push(messages[idx].clone());
        }

        // Reserve budget for recent messages (keep at least last 2 non-system messages)
        let keep_recent = non_system_indices.len().min(2);
        let recent_start = non_system_indices.len().saturating_sub(keep_recent);

        // Calculate tokens for recent messages
        let recent_tokens: usize = non_system_indices[recent_start..]
            .iter()
            .map(|&idx| token_counts[idx])
            .sum();

        // Budget available for middle messages
        let budget_for_middle = self
            .max_tokens
            .saturating_sub(tokens_used)
            .saturating_sub(recent_tokens);

        // Try to fit middle messages from newest to oldest
        // (#6: use continue instead of break to skip large messages and fit smaller ones)
        let middle_indices = &non_system_indices[..recent_start];
        let mut middle_kept: Vec<usize> = Vec::new();
        let mut middle_tokens: usize = 0;

        for &idx in middle_indices.iter().rev() {
            let msg_tokens = token_counts[idx];
            if middle_tokens + msg_tokens <= budget_for_middle {
                middle_kept.push(idx);
                middle_tokens += msg_tokens;
            }
            // continue: skip this message but try older (possibly shorter) ones
        }
        middle_kept.reverse();

        // If we dropped some middle messages, add a summary placeholder
        let dropped_count = middle_indices.len() - middle_kept.len();
        if dropped_count > 0 {
            let summary = summary_placeholder(dropped_count);
            let summary_tokens = count_tokens(&summary);
            result_messages.push(Message {
                id: format!("compacted-summary-{dropped_count}"),
                role: "assistant".to_string(),
                content: summary,
                images: None,
            });
            tokens_used += summary_tokens;
        }

        // Add kept middle messages
        for &idx in &middle_kept {
            tokens_used += token_counts[idx];
            result_messages.push(messages[idx].clone());
        }

        // Add recent messages
        for &idx in &non_system_indices[recent_start..] {
            tokens_used += token_counts[idx];
            result_messages.push(messages[idx].clone());
        }

        CompactionResult {
            messages: result_messages,
            tokens_consumed: tokens_used,
            cache_hit_rate_optimized: false,
        }
    }

    /// 对话级估算（AgentMessage 面；usage 优先 + 时间戳护栏 + 启发式兜底）
    ///
    /// 双源策略（P4 §3.3.1，对齐 pi estimate.ts）：
    ///
    /// - **源 1：usage 优先**：从尾部向前找最近一条仍描述当前前缀的
    ///   usage 消息，上下文占用取 `metadata.cacheBreakdown.inputTotal`
    ///   （P2/C9 归一化口径，I6；Included 系 prompt、Excluded 系
    ///   prompt+read+write 已由适配层折算）；cacheBreakdown 缺失时回退
    ///   `metadata.usage.promptTokens`（Included 语义）。排除 aborted /
    ///   error 回合与零 usage 消息；**时间戳护栏**：消息时间戳早于
    ///   `last_compaction_at`（压缩边界）时 usage 不再描述当前前缀，作废
    ///   回退启发式（对齐 pi `usageAppliesToPrefix`）。usage 覆盖其后缀
    ///   之前的前缀（含 system/tools），其后的尾随消息按块级启发式补算；
    /// - **源 2：本地启发式兜底**（无 usage / usage 作废 / 冷启动）：
    ///   全部消息逐块估算 + `tools`（工具 schema 整体 JSON 体积）与
    ///   `system`（system prompt 文本）前缀折算（按 P1 透传后的实际字节）。
    ///
    /// `tokens` 为 u64 上下文占用（含缓存读/写，I6 口径）。
    pub fn estimate_context_tokens(
        &self,
        messages: &[Arc<AgentMessage>],
        tools: Option<&str>,
        system: Option<&str>,
        last_compaction_at: Option<i64>,
    ) -> EstimateContext {
        let usage = find_usage_message(messages, last_compaction_at);
        estimate_with_usage(messages, tools, system, usage)
    }

    /// 对话级估算（P4 §3.7 签名兼容入口）
    ///
    /// 调用方（session-loop）已按时间戳护栏定位 usage 消息 id 时传入；
    /// 该消息存在且带可解析 usage 时以其为准，否则纯启发式。
    /// 不带 tools/system 前缀参数（usage 实测已含此前缀；启发式路径按
    /// 0 前缀估算）。
    pub fn estimate_agent_context(
        &self,
        messages: &[Arc<AgentMessage>],
        usage_message_id: Option<&str>,
    ) -> EstimateContext {
        let usage = usage_message_id
            .and_then(|id| messages.iter().position(|m| m.id == id))
            .and_then(|idx| usage_occupancy(&messages[idx]).map(|occupancy| (idx, occupancy)));
        estimate_with_usage(messages, None, None, usage)
    }

    /// 计算合法切割点：返回保留段起始索引（None = 放弃压缩）
    ///
    /// 策略（P4 §3.4.2，对齐 pi findCutPoint / jcode safe_compaction_cutoff）：
    ///
    /// 1. **尾部倒推预算**：从末尾向前累计 token 至 `keep_recent_tokens`，
    ///    累计达标处的消息纳入保留段；扫描区间自折叠链后起算（链 token
    ///    不计入预算，T-02）；
    /// 2. **完整回合下限**：保留段内 user 消息数不得少于 `min_recent_turns`
    ///    （不足时向前扩展保留段；回合 = 一个 user 消息及其后的
    ///    assistant/tool 消息组）；
    /// 3. **合法切割点（tool 配对保护）**：保留段内每个 `ToolResult` 必须
    ///    能在保留段内找到对应 `ToolCall`；存在孤儿 id 时向前扩展保留段
    ///    直到全部配对；仍无法配对（数据异常）或保留段覆盖全部消息
    ///    （无可丢内容）时返回 None——宁可暂不压缩也不破坏语义。
    ///
    /// **折叠链下界（T-01~T-05）**：切割点恒 `> fold_start`（system 段后
    /// 首个非链下标）——链消息（compacted-summary 前缀）永不进保留区/丢弃区
    /// （B1 冻结、B2 单调），cut ≤ fold_start 一律 None。
    pub fn find_cut_point(
        &self,
        messages: &[Arc<AgentMessage>],
        keep_recent_tokens: usize,
        min_recent_turns: u32,
    ) -> Option<usize> {
        find_cut_point_inner(messages, keep_recent_tokens, min_recent_turns, true)
    }

    /// 压缩对话（AgentMessage 面；保留策略见 P4 §3.4.2）
    ///
    /// 流程：
    ///
    /// 1. 预算内不动（`tokens_before <= budget_tokens`，对齐既有
    ///    `cache_hit_rate_optimized` 语义）与空输入：原样返回；
    /// 2. 无合法切割点（tool 孤儿无法配对 / 保留段覆盖全部消息）：
    ///    放弃压缩，原样返回（宁可暂不压缩也不破坏语义，jcode
    ///    safe_compaction_cutoff:289-290）；
    /// 3. 保留尾部：[find_cut_point] 计算保留段；保留段之前的 **system
    ///    消息恒保留**（置于输出头部），**折叠链（compacted-summary
    ///    前缀，T-06/T-08）恒保留**（B1 冻结：链永不改写/丢失/折叠），
    ///    其余中间段合并为摘要；
    /// 4. 摘要：注入 [Summarizer] 时同步单次尝试（R-F）；成功且输出为
    ///    Schema V1 JSON 文档（[crate::summary_document::validate_summary_document]）
    ///    时以 markdown 渲染进链（R-G 语源唯一，summary_is_llm=true），
    ///    否则按 [StubPolicy] 决策——[StubPolicy::StubAllowed] 降级中性
    ///    stub（R-C 永不改写，state=awaiting）、[StubPolicy::LlmRequired]
    ///    放弃压缩（E2 F1，llm_unavailable=true）；摘要受
    ///    `max_summary_tokens` 钳制；检测到既有链消息时取**链尾**文本
    ///    （T-07）作为 `existing` 传入摘要器走迭代合并（P4 §3.4.3）；
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
    /// 方法——经 [Self::preview_compaction] + session-loop
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
            self.preview_compaction(messages, policy)
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
    /// 溢出）经 [Self::preview_compaction] + session-loop
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
        // 1C-9：入口单次遍历计算 tokens_before，同时按 cut 边界预累加
        // dropped_tokens（被丢弃消息的 token 数），供后续 tokens_after 增量
        // 推导，避免对 result 再做一次全量 count_agent_message_tokens 遍历。
        // 此处 cut 尚未确定，先全量累加 tokens_before；dropped_tokens 在 cut
        // 确定、dropped_arcs 构建后用同一遍历口径补算（见下方）。
        let tokens_before: u64 = messages
            .iter()
            .map(|m| count_agent_message_tokens(m) as u64)
            .sum();

        if messages.is_empty() {
            return noop_plan(messages);
        }

        // 计算保留段起始（tool 配对保护；None = 无合法切割点，放弃压缩）
        let Some(cut) = find_cut_point_inner(
            messages,
            policy.keep_recent_tokens,
            policy.min_recent_turns,
            policy.tool_pair_protection,
        ) else {
            return noop_plan(messages);
        };

        // 中间段 = 保留段之前的非 system 消息（system 恒保留；
        // T-06：链消息（compacted-summary 前缀）永不入 dropped——B1 冻结）
        let dropped_arcs: Vec<Arc<AgentMessage>> = messages[..cut]
            .iter()
            .filter(|m| {
                m.role != AgentMessageRole::System && !m.id.starts_with("compacted-summary")
            })
            .cloned()
            .collect();
        if dropped_arcs.is_empty() {
            // 可切但无可丢消息（如保留段前仅有 system/链）：无意义，放弃压缩
            return noop_plan(messages);
        }
        // 1C-9：dropped_tokens 在构建 dropped_arcs 后单次遍历累加（与
        // tokens_before 同一口径），供 tokens_after 增量推导复用。
        let dropped_tokens: u64 = dropped_arcs
            .iter()
            .map(|m| count_agent_message_tokens(m) as u64)
            .sum();
        let mut dropped_ids: Vec<String> = dropped_arcs.iter().map(|m| m.id.clone()).collect();

        // （existing 摘要文本提取已随摘要调用移至 preview_compaction——
        // 本方法只消费 summarize_precomputed，不再计算 existing；DEL-9）

        // T-09：折叠推导——fold_index = 链长 + 1（B3 只增）；块 id 与
        // 摘要消息 id 同名（R-B：`compacted-summary-{gen}-{fold}`）；
        // 彻底根除 BC05-3：拔除硬编码 generation = 1；
        // 优先使用 CompactionEngine 显式接收的 generation，
        // 兜底从 messages 切割点前的既有摘要链中提取最大代数并 +1，确保严格单调自增
        let chain_count = messages[..cut]
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .count();
        let generation: u32 = self.generation.unwrap_or_else(|| {
            // 未显式注入时：沿用链中最新既有摘要块的 generation（同 generation 内只增 fold），或默认为 1
            messages[..cut]
                .iter()
                .filter(|m| m.id.starts_with("compacted-summary"))
                .filter_map(|m| {
                    let parts: Vec<&str> = m.id.split('-').collect();
                    if parts.len() >= 4 {
                        parts[2].parse::<u32>().ok()
                    } else {
                        None
                    }
                })
                .next_back()
                .unwrap_or(1)
        });
        let fold_index = chain_count + 1;
        let block_id = format!("compacted-summary-{generation}-{fold_index}");

        // 摘要生成（T-13 / D10-A）：R-F 语义 = 「阻塞池内单次尝试 + 墙钟」；
        // 摘要结果经 summarize_precomputed 注入（run loop 预检/边界/溢出经
        // summarize_via_blocking spawn_blocking 预计算；本方法不再裸调
        // summarizer.summarize——DEL-9）。成功且输出为 Schema V1 JSON 文档
        // → md 渲染进链（summary_is_llm=true，state=committed）；其余
        // （非 JSON / 超预算 / Err / 无注入）按 [StubPolicy] 决策：
        // StubAllowed → 中性 stub（R-C 永不改写，state=awaiting；
        // 原文不保留，保守语义）；LlmRequired → 放弃压缩（E2 F1，
        // llm_unavailable=true，禁止纯丢弃式线性压缩）
        let stub = || {
            truncate_summary(
                &stub_placeholder(&block_id, dropped_ids.len(), generation),
                policy.max_summary_tokens,
            )
        };
        let (summary, summary_is_llm, llm_unavailable) = if let Some(summary_result) =
            summarize_precomputed
        {
            match summary_result {
                Ok(text) => {
                    // 字节预算 = max_summary_tokens × 4（ASCII 4 字符/token、
                    // CJK 3 字节/字符 ≤ 4 字节/token 的保守上界）
                    match crate::summary_document::validate_summary_document(
                        &text,
                        policy.max_summary_tokens.saturating_mul(4),
                    ) {
                        Ok(doc) => (
                            truncate_summary(
                                &crate::summary_document::summary_to_markdown(&doc),
                                policy.max_summary_tokens,
                            ),
                            true,
                            false,
                        ),
                        Err(_) if stub_policy == StubPolicy::LlmRequired => {
                            return llm_blocked_plan(messages, cut, &dropped_ids, tokens_before);
                        }
                        Err(_) => (stub(), false, false),
                    }
                }
                Err(_) if stub_policy == StubPolicy::LlmRequired => {
                    return llm_blocked_plan(messages, cut, &dropped_ids, tokens_before);
                }
                Err(_) => (stub(), false, false),
            }
        } else {
            // 无预计算摘要（E2 F1 L1）：LlmRequired 下不产生
            // stub——放弃压缩等待 LLM 可用；StubAllowed 下保持现状
            if stub_policy == StubPolicy::LlmRequired {
                return llm_blocked_plan(messages, cut, &dropped_ids, tokens_before);
            }
            (stub(), false, false)
        };

        // 组装：system + 链全查（按原始顺序）+ 新摘要 + 保留段（T-08）
        let mut result: Vec<Arc<AgentMessage>> = messages[..cut]
            .iter()
            .filter(|m| m.role == AgentMessageRole::System || m.id.starts_with("compacted-summary"))
            .cloned()
            .collect();
        result.push(Arc::new(AgentMessage {
            id: block_id.clone(),
            role: AgentMessageRole::Assistant,
            // 时间戳沿用对话末条消息：护栏按"晚于压缩边界"语义不会被作废
            created_at: messages
                .last()
                .map(|m| m.created_at.clone())
                .unwrap_or_default(),
            blocks: vec![AgentMessageBlock::Text {
                text: summary.clone(),
            }],
            // metadata 快照（机器可读优先；正文只放人读线索；R-C：
            // stub 永驻 awaiting——摘要就绪以块表为准，不误导模型）
            metadata: Some(serde_json::json!({
                "isCompactedSummary": true,
                "summary": {
                    "blockId": block_id,
                    "state": if summary_is_llm { "committed" } else { "awaiting" },
                    "droppedIds": &dropped_ids,
                    "height": 1,
                    "generation": generation,
                }
            })),
            client_message_id: None,
            // 正文兜底字段（前端 content 回退，emit 时建议填充）
            content: Some(summary.clone()),
        }));
        result.extend_from_slice(&messages[cut..]);

        // 1C-9：tokens_after 增量推导。
        // result = (system + 链) + 新摘要 + messages[cut..]，其中 (system+链+messages[cut..])
        // = messages - dropped_arcs → token = tokens_before - dropped_tokens。
        // 加上新摘要单 Text 块的 token（count_tokens(&summary) 与该消息经
        // count_agent_message_tokens 的结果一致——单 Text 块路径），避免对
        // result 做第二次全量 count_agent_message_tokens 遍历。
        let summary_tokens: u64 = count_tokens(&summary) as u64;
        let mut tokens_after: u64 = tokens_before - dropped_tokens + summary_tokens;

        // 【核心加固 3：追加后紧急二次预检（Emergency Preflight / Fallback Compaction）】
        // 若追加新摘要或组装保留段后，总 Token 仍超过预算上限，强制执行兜底压缩，杜绝 400 错误
        if budget_tokens >= policy.keep_recent_tokens && tokens_after > budget_tokens as u64 {
            tokens_after = Self::apply_emergency_preflight(
                &mut result,
                &mut dropped_ids,
                messages,
                cut,
                budget_tokens,
                policy,
                &block_id,
            );
        }

        let kept_ids: Vec<String> = result.iter().map(|m| m.id.clone()).collect();
        let first_kept_id = result
            .iter()
            .find(|m| m.role != AgentMessageRole::System && !m.id.starts_with("compacted-summary"))
            .map(|m| m.id.clone());

        CompactionPlan {
            messages: result,
            dropped_ids,
            kept_ids,
            first_kept_message_id: first_kept_id,
            tokens_before,
            tokens_after,
            summary,
            summary_is_llm,
            llm_unavailable,
            fold_chain_prev: chain_count,
            fold_chain_after: fold_index,
            fold_index,
            generation,
        }
    }

    /// 紧急二次预检与兜底压缩逻辑（Emergency Preflight）
    ///
    /// 当追加新摘要或历史保留段后，总 Token 仍超过预算上限时触发：
    /// 1. 尝试更紧凑的截断点（放宽 min_recent_turns 下限至 1 或 0），丢弃更多历史；
    /// 2. 若依然超预算（如单条巨型工具输出），对保留段中的超大 ToolResult 实施紧急截断，
    ///    保证最终输出严格收敛于预算之内。
    fn apply_emergency_preflight(
        result: &mut Vec<Arc<AgentMessage>>,
        dropped_ids: &mut Vec<String>,
        original_messages: &[Arc<AgentMessage>],
        initial_cut: usize,
        budget_tokens: usize,
        policy: &CompactionPolicy,
        block_id: &str,
    ) -> u64 {
        let summary_pos = result.iter().position(|m| m.id == *block_id).unwrap_or(0);

        // 前缀（System + 历史链 + 新摘要）Token 占用
        let header_tokens: usize = result[..=summary_pos]
            .iter()
            .map(|m| count_agent_message_tokens(m))
            .sum();

        let tail_budget = budget_tokens.saturating_sub(header_tokens);

        // 阶段 1：尝试更紧凑的切割点
        let tighter_cut = find_cut_point_inner(
            original_messages,
            tail_budget,
            1,
            policy.tool_pair_protection,
        )
        .or_else(|| {
            find_cut_point_inner(
                original_messages,
                tail_budget,
                0,
                policy.tool_pair_protection,
            )
        });

        if let Some(ecut) = tighter_cut {
            if ecut > initial_cut {
                // 纳入新丢弃的消息 id
                for msg in &original_messages[initial_cut..ecut] {
                    if msg.role != AgentMessageRole::System
                        && !msg.id.starts_with("compacted-summary")
                        && !dropped_ids.contains(&msg.id)
                    {
                        dropped_ids.push(msg.id.clone());
                    }
                }
                // 重建保留段
                result.truncate(summary_pos + 1);
                result.extend_from_slice(&original_messages[ecut..]);
            }
        }

        let mut current_tokens: u64 = result
            .iter()
            .map(|m| count_agent_message_tokens(m) as u64)
            .sum();

        if current_tokens <= budget_tokens as u64 {
            return current_tokens;
        }

        // 阶段 2：若仍超预算，对保留段中的超大工具输出执行紧急截断
        let non_header_start = summary_pos + 1;
        if non_header_start < result.len() {
            let retained_count = result.len() - non_header_start;
            let per_msg_budget_bytes =
                (budget_tokens.saturating_sub(header_tokens) * 4) / retained_count.max(1);
            let emergency_limits = crate::tool_output::ToolOutputTruncationLimits {
                max_lines: 50,
                max_bytes: per_msg_budget_bytes.clamp(256, 4096),
            };

            for msg in &mut result[non_header_start..] {
                let mut modified_blocks = Vec::new();
                let mut changed = false;
                for block in &msg.blocks {
                    match block {
                        AgentMessageBlock::ToolResult {
                            tool_call_id,
                            tool_name,
                            output,
                            is_error,
                        } => {
                            let mut new_output = output.clone();
                            if let Some(ref text) = output.text {
                                let trunc_res = crate::tool_output::truncate_tool_output(
                                    text,
                                    &emergency_limits,
                                );
                                if trunc_res.truncated {
                                    new_output.text = Some(trunc_res.text);
                                    changed = true;
                                }
                            }
                            modified_blocks.push(AgentMessageBlock::ToolResult {
                                tool_call_id: tool_call_id.clone(),
                                tool_name: tool_name.clone(),
                                output: new_output,
                                is_error: *is_error,
                            });
                        }
                        other => modified_blocks.push(other.clone()),
                    }
                }
                if changed {
                    *msg = Arc::new(AgentMessage {
                        id: msg.id.clone(),
                        role: msg.role,
                        created_at: msg.created_at.clone(),
                        blocks: modified_blocks,
                        metadata: msg.metadata.clone(),
                        client_message_id: msg.client_message_id.clone(),
                        content: msg.content.clone(),
                    });
                }
            }
        }

        current_tokens = result
            .iter()
            .map(|m| count_agent_message_tokens(m) as u64)
            .sum();

        current_tokens
    }

    /// 紧急二次预检（Emergency Preflight）：
    /// 在追加消息或会话后，若当前对话总估算仍超预算，强制执行兜底压缩。
    ///
    /// 兼容 wrapper：内部同步 preview + summarize（仅本方法 / 测试路径；
    /// run loop 主路径不经此——经 preview + summarize_via_blocking 预计算）。
    pub fn emergency_preflight(
        &self,
        messages: &[Arc<AgentMessage>],
        budget_tokens: usize,
        policy: &CompactionPolicy,
        summarizer: Option<&dyn Summarizer>,
    ) -> CompactionPlan {
        let summarize_precomputed = summarizer.and_then(|s| {
            self.preview_compaction(messages, policy)
                .map(|preview| s.summarize(&preview.dropped, preview.existing.as_deref()))
        });
        let mut plan = self.compact_agent_messages_with_stub_policy(
            messages,
            budget_tokens,
            policy,
            StubPolicy::StubAllowed,
            summarize_precomputed,
        );
        if plan.tokens_after > budget_tokens as u64 && !plan.messages.is_empty() {
            let block_id = format!(
                "compacted-summary-{}-{}",
                plan.generation,
                plan.fold_index.max(1)
            );
            let new_tokens = Self::apply_emergency_preflight(
                &mut plan.messages,
                &mut plan.dropped_ids,
                messages,
                0,
                budget_tokens,
                policy,
                &block_id,
            );
            plan.tokens_after = new_tokens;
            plan.kept_ids = plan.messages.iter().map(|m| m.id.clone()).collect();
            plan.first_kept_message_id = plan
                .messages
                .iter()
                .find(|m| {
                    m.role != AgentMessageRole::System && !m.id.starts_with("compacted-summary")
                })
                .map(|m| m.id.clone());
        }
        plan
    }

    /// 压缩预览（D10-A）：返回「本可压缩的应丢消息 + 既有摘要文本」，
    /// 供调用方在调用 [Self::compact_agent_messages_with_stub_policy]
    /// **之前**经 spawn_blocking 异步预计算摘要（summarize_via_blocking）。
    ///
    /// cut 计算与主方法同源（同一纯逻辑），返回 Some 当且仅当主方法
    /// 会进入摘要分支（有合法切割点且有可丢消息）；None = 无压缩动作
    /// （主方法将 noop）。`dropped` 为值克隆（Summarizer trait 借
    /// `&[AgentMessage]`）；克隆成本远低于摘要网络往返，可接受。
    pub fn preview_compaction(
        &self,
        messages: &[Arc<AgentMessage>],
        policy: &CompactionPolicy,
    ) -> Option<CompactionPreview> {
        if messages.is_empty() {
            return None;
        }
        let cut = find_cut_point_inner(
            messages,
            policy.keep_recent_tokens,
            policy.min_recent_turns,
            policy.tool_pair_protection,
        )?;
        let dropped_arcs: Vec<Arc<AgentMessage>> = messages[..cut]
            .iter()
            .filter(|m| {
                m.role != AgentMessageRole::System && !m.id.starts_with("compacted-summary")
            })
            .cloned()
            .collect();
        if dropped_arcs.is_empty() {
            return None;
        }
        let existing = messages[..cut]
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .filter_map(|m| {
                let text = m.text();
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            })
            .next_back();
        let dropped: Vec<AgentMessage> = dropped_arcs.iter().map(|m| (**m).clone()).collect();
        Some(CompactionPreview { dropped, existing })
    }

    /// 阈值判定单点：`estimate >= budget_tokens`（T-33 预检触发用，
    /// P4 §3.4.1 阈值 = window - reserve，budget_tokens 由调用方换算）
    pub fn should_compact(&self, estimate: u64, budget_tokens: u64) -> bool {
        estimate >= budget_tokens
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole};

    #[test]
    fn test_explicit_generation_generates_correct_block_id() {
        let engine = CompactionEngine::new(0).with_generation(3);
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
