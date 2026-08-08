//! 上下文压缩引擎（conex-compaction）
//!
//! 双面结构（P4 阶段 2-1 / 阶段 3-1，T-32）：
//!
//! - **旧 `Message` 面**：`compaction::CompactionEngine::compact(&[Message])`
//!   三字段模型（id/role/content），供 UI 手动压缩工具命令
//!   `core_compact_messages` 使用（core_commands.rs:191-207，IPC 面保留兼容）；
//! - **`AgentMessage` 面**（本文件新增）：`estimate_context_tokens` /
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

use conex_types::{AgentMessage, AgentMessageBlock, ToolOutput};

/// AI 摘要通道（M10/C9：五字段模板 + 退化重试护栏 + covers_up_to_turn 载荷）
pub mod ai_summary;

/// 工具输出截断（G8 核销：head + 标记 + tail 计数截断 + 预算水位联动）
pub mod tool_output;

/// 压缩块元数据与块引用行（T-11；可追溯 / 可恢复索引面，00-plan §4.4）
pub mod recovery;

/// 摘要文档 Schema V1 规范面（T-12；校验 / markdown 渲染投影 / 兼容解析）
pub mod summary_document;

/// 工具输出清洗管线（T-14；R1-R6 纯函数，接线在轮次 4 wire 面）
pub mod clean_output;

pub mod compaction {
    use std::collections::HashSet;
    use std::sync::Arc;

    use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole, CompactionResult, Message};

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
                keep_recent_tokens: super::KEEP_RECENT_TOKENS_DEFAULT,
                min_recent_turns: super::MIN_RECENT_TURNS_DEFAULT,
                max_summary_tokens: super::MAX_SUMMARY_TOKENS_DEFAULT,
                tool_pair_protection: true,
            }
        }
    }

    /// 双阈值判定结果（M10/C9：85% 常规线 + 95% 临界线，02 Top 4）
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum ThresholdDecision {
        /// 预算内（无需压缩）
        UnderBudget,
        /// 常规线（默认 85% 预算水位线）：触发 AI 摘要（后台预压缩，
        /// grok 两遍借鉴——常规线优先走 [super::ai_summary] 通道生成
        /// 结构化摘要，失败降级占位符）
        Regular,
        /// 临界线（默认 95%）：同步硬压缩（走确定性占位符路径，
        /// 不依赖 AI，保 API 调用不失败，对齐 jcode CRITICAL_THRESHOLD）
        Critical,
    }

    /// 双阈值配置（可配；session_meta 键
    /// `compact_threshold_ratio` / `compact_critical_ratio`，
    /// 04 §3.5 键命名空间 compact_*）
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct CompactionThresholds {
        /// 常规线水位（默认 0.85）
        pub regular_ratio: f64,
        /// 临界线水位（默认 0.95；≥ 常规线）
        pub critical_ratio: f64,
    }

    impl Default for CompactionThresholds {
        fn default() -> Self {
            Self {
                regular_ratio: super::COMPACT_THRESHOLD_RATIO_DEFAULT,
                critical_ratio: super::COMPACT_CRITICAL_RATIO_DEFAULT,
            }
        }
    }

    impl CompactionThresholds {
        /// 边界钳制：常规线 ∈ (0, 1]、临界线 ∈ [常规线, 1]
        pub fn normalized(&self) -> Self {
            let regular = self.regular_ratio.clamp(0.0, 1.0);
            let regular = if regular == 0.0 { 1.0 } else { regular };
            Self {
                regular_ratio: regular,
                critical_ratio: self.critical_ratio.clamp(regular, 1.0),
            }
        }

        /// 水位判定单点：`estimate / window` 与双阈值比较（window = 0 时
        /// 保守判临界——无法估算即按最紧防线处理）
        pub fn classify(&self, estimate: u64, window: u64) -> ThresholdDecision {
            if window == 0 {
                return ThresholdDecision::Critical;
            }
            let thresholds = self.normalized();
            let ratio = estimate as f64 / window as f64;
            if ratio >= thresholds.critical_ratio {
                ThresholdDecision::Critical
            } else if ratio >= thresholds.regular_ratio {
                ThresholdDecision::Regular
            } else {
                ThresholdDecision::UnderBudget
            }
        }
    }

    /// 估算来源（usage 实测优先 / 本地启发式兜底，P4 §3.3.1）
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum EstimateSource {
        /// usage 实测（服务端口径，含缓存）
        Usage,
        /// 本地启发式兜底（无 usage / usage 作废 / 冷启动）
        Heuristic,
    }

    /// 上下文占用估算结果（双源统一输出，P4 §3.3.1）
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct EstimateContext {
        /// 估算的上下文占用（含缓存读/写；I6 口径）
        pub tokens: u64,
        /// 估算来源（usage 实测 / 本地启发式）
        pub source: EstimateSource,
        /// usage 来源消息 id（本地兜底时为 None；供事件填充与护栏判定）
        pub usage_message_id: Option<String>,
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

    pub struct CompactionEngine {
        max_tokens: usize,
    }

    /// 折叠链起始下标（T-01；B1 冻结 / B2 单调下界）
    ///
    /// 链 = 紧邻 system 段之后的连续 `compacted-summary` 前缀消息段；
    /// 返回链段之后的首个下标。无 system 时从开头直接跳过链消息；
    /// 链为空时返回 system 段长度。链消息永不进保留区/丢弃区，
    /// 故切割点恒须 `> fold_start`。
    fn fold_start_of(messages: &[Arc<AgentMessage>]) -> usize {
        let mut idx = 0;
        while idx < messages.len() && messages[idx].role == AgentMessageRole::System {
            idx += 1;
        }
        while idx < messages.len() && messages[idx].id.starts_with("compacted-summary") {
            idx += 1;
        }
        idx
    }

    /// 无压缩动作的计划（预算内不动 / 无合法切割点 / 无可丢内容）
    fn noop_plan(messages: &[Arc<AgentMessage>]) -> CompactionPlan {
        let tokens: u64 = messages
            .iter()
            .map(|m| super::count_agent_message_tokens(m) as u64)
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
            fold_chain_prev: 0,
            fold_chain_after: 0,
            fold_index: 0,
            generation: 1,
        }
    }

    impl CompactionEngine {
        pub fn new(max_tokens: usize) -> Self {
            Self { max_tokens }
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
            let token_counts: Vec<usize> = messages
                .iter()
                .map(|m| super::count_tokens(&m.content))
                .collect();

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
            let system_indices: Vec<usize> = messages.iter().enumerate()
                .filter(|(_, m)| m.role == "system")
                .map(|(i, _)| i)
                .collect();
            let non_system_indices: Vec<usize> = messages.iter().enumerate()
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
            let budget_for_middle = self.max_tokens
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
                let summary_tokens = super::count_tokens(&summary);
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
            let usage = usage_message_id.and_then(|id| {
                messages.iter().position(|m| m.id == id)
            }).and_then(|idx| {
                usage_occupancy(&messages[idx]).map(|occupancy| (idx, occupancy))
            });
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
            self.find_cut_point_inner(messages, keep_recent_tokens, min_recent_turns, true)
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
        ///    Schema V1 JSON 文档（[super::summary_document::validate_summary_document]）
        ///    时以 markdown 渲染进链（R-G 语源唯一，summary_is_llm=true），
        ///    否则（非 JSON / 超预算 / 失败 / 无注入）降级中性 stub
        ///    （R-C 永不改写，state=awaiting）；摘要受 `max_summary_tokens`
        ///    钳制；检测到既有链消息时取**链尾**文本（T-07）作为 `existing`
        ///    传入摘要器走迭代合并（P4 §3.4.3）；
        /// 5. 摘要消息以 `assistant` 角色插入 system + 链之后、保留段之前
        ///    （保持"system → 链 → 新摘要 → 保留尾部"的对话形态，B4）；
        ///    id = `compacted-summary-{generation}-{fold_index}`（R-B，
        ///    fold_index = 链长 + 1，B3 只增），metadata 携带
        ///    `{summary: {blockId, state, droppedIds, height, generation}}` 快照。
        ///
        /// `budget_tokens` 为目标预算（window - reserve，由调用方换算）。
        pub fn compact_agent_messages(
            &self,
            messages: &[Arc<AgentMessage>],
            budget_tokens: usize,
            policy: &CompactionPolicy,
            summarizer: Option<&dyn Summarizer>,
        ) -> CompactionPlan {
            let tokens_before: u64 = messages
                .iter()
                .map(|m| super::count_agent_message_tokens(m) as u64)
                .sum();

            // 预算内不动 / 空输入：原样返回
            if messages.is_empty() || tokens_before <= budget_tokens as u64 {
                return noop_plan(messages);
            }

            // 计算保留段起始（tool 配对保护；None = 无合法切割点，放弃压缩）
            let Some(cut) = self.find_cut_point_inner(
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
            let dropped_ids: Vec<String> = dropped_arcs.iter().map(|m| m.id.clone()).collect();

            // 迭代合并：T-07 取链尾最后一条非空摘要文本（stub 或 md 渲染
            // 皆可）作为 existing 传入摘要器（R-G：链文本 = 该块文档的
            // md 渲染 / stub 中性文本；existing 由调用方按表优先仲裁）
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

            // T-09：折叠推导——fold_index = 链长 + 1（B3 只增）；块 id 与
            // 摘要消息 id 同名（R-B：`compacted-summary-{gen}-{fold}`）；
            // generation 本轮以 1 占位（R-K：V2 由会话代数
            // SessionContextMeta.last_compaction_generation 注入）
            let chain_count = messages[..cut]
                .iter()
                .filter(|m| m.id.starts_with("compacted-summary"))
                .count();
            let generation: u32 = 1;
            let fold_index = chain_count + 1;
            let block_id = format!("compacted-summary-{generation}-{fold_index}");

            // 摘要生成（T-13）：同步单次尝试（R-F）；成功且输出为 Schema V1
            // JSON 文档 → md 渲染进链（summary_is_llm=true，state=committed）；
            // 其余（非 JSON / 超预算 / Err / 无注入）→ 中性 stub
            // （R-C 永不改写，state=awaiting；原文不保留，保守语义）
            let dropped_slice: Vec<AgentMessage> = dropped_arcs.iter().map(|m| (**m).clone()).collect();
            let stub = || {
                truncate_summary(
                    &stub_placeholder(&block_id, dropped_ids.len(), generation),
                    policy.max_summary_tokens,
                )
            };
            let (summary, summary_is_llm) = if let Some(summarizer) = summarizer {
                match summarizer.summarize(&dropped_slice, existing.as_deref()) {
                    Ok(text) => {
                        // 字节预算 = max_summary_tokens × 4（ASCII 4 字符/token、
                        // CJK 3 字节/字符 ≤ 4 字节/token 的保守上界）
                        match super::summary_document::validate_summary_document(
                            &text,
                            policy.max_summary_tokens.saturating_mul(4),
                        ) {
                            Ok(doc) => (
                                truncate_summary(
                                    &super::summary_document::summary_to_markdown(&doc),
                                    policy.max_summary_tokens,
                                ),
                                true,
                            ),
                            Err(_) => (stub(), false),
                        }
                    }
                    Err(_) => (stub(), false),
                }
            } else {
                (stub(), false)
            };

            // 组装：system + 链全查（按原始顺序）+ 新摘要 + 保留段（T-08）
            let mut result: Vec<Arc<AgentMessage>> = messages[..cut]
                .iter()
                .filter(|m| {
                    m.role == AgentMessageRole::System || m.id.starts_with("compacted-summary")
                })
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
                blocks: vec![AgentMessageBlock::Text { text: summary.clone() }],
                // metadata 快照（机器可读优先；正文只放人读线索；R-C：
                // stub 永驻 awaiting——摘要就绪以块表为准，不误导模型）
                metadata: Some(serde_json::json!({
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

            let tokens_after: u64 = result
                .iter()
                .map(|m| super::count_agent_message_tokens(m) as u64)
                .sum();
            let kept_ids: Vec<String> = result.iter().map(|m| m.id.clone()).collect();

            CompactionPlan {
                messages: result,
                dropped_ids,
                kept_ids,
                first_kept_message_id: messages.get(cut).map(|m| m.id.clone()),
                tokens_before,
                tokens_after,
                summary,
                summary_is_llm,
                fold_chain_prev: chain_count,
                fold_chain_after: fold_index,
                fold_index,
                generation,
            }
        }

        /// 阈值判定单点：`estimate >= budget_tokens`（T-33 预检触发用，
        /// P4 §3.4.1 阈值 = window - reserve，budget_tokens 由调用方换算）
        pub fn should_compact(&self, estimate: u64, budget_tokens: u64) -> bool {
            estimate >= budget_tokens
        }

        /// 切割点核心（`tool_pair_protection` 由调用方按策略控制；
        /// 公开入口 [Self::find_cut_point] 恒开启保护）
        ///
        /// 折叠链钳制（00-plan §4.2 T-01~T-05，B1/B2 不变量）：
        /// 链消息（compacted-summary 前缀，紧邻 system 之后）永不进保留区，
        /// 切割点下界 = `fold_start`（链段之后首个下标）；budget 扫描区间
        /// 为 `[fold_start, len)`，min_recent_turns 与 tool 配对回扫同样
        /// 以 fold_start 为下界——cut ≤ fold_start 一律放弃压缩。
        fn find_cut_point_inner(
            &self,
            messages: &[Arc<AgentMessage>],
            keep_recent_tokens: usize,
            min_recent_turns: u32,
            tool_pair_protection: bool,
        ) -> Option<usize> {
            if messages.is_empty() {
                return None;
            }
            // T-01：折叠链起始（system 段后首个非链下标）
            let fold_start = fold_start_of(messages);
            let counts: Vec<usize> = messages
                .iter()
                .map(|m| super::count_agent_message_tokens(m))
                .collect();

            // 1) 尾部倒推累计预算（达标处的消息纳入保留段；T-02：
            //    扫描区间 [fold_start, len)——链 token 不计入预算）
            let mut cut = messages.len();
            let mut acc = 0usize;
            for i in (fold_start..messages.len()).rev() {
                acc += counts[i];
                if acc >= keep_recent_tokens {
                    cut = i;
                    break;
                }
            }
            // 全部消息未达预算 → 保留全部；无可丢内容（cut 落在链上/链前）
            // → 放弃压缩（T-03：`cut == 0` 改为 `cut <= fold_start`）
            if cut == messages.len() {
                cut = 0;
            }
            if cut <= fold_start {
                return None;
            }

            // 2) min_recent_turns：保留段内完整回合（user 消息）下限
            if min_recent_turns > 0 {
                let mut user_count = messages[cut..]
                    .iter()
                    .filter(|m| m.role == AgentMessageRole::User)
                    .count();
                while user_count < min_recent_turns as usize && cut > fold_start {
                    cut -= 1;
                    if messages[cut].role == AgentMessageRole::User {
                        user_count += 1;
                    }
                }
                if cut <= fold_start {
                    return None;
                }
            }

            // 3) 合法切割点（tool 配对保护）：保留段内每个 ToolResult 必须有
            //    对应 ToolCall；孤儿 id 时向前扩展保留段直到配对。
            //    T-04/T-05：回扫区间下界 = fold_start——孤儿 call 位于链内
            //    （fold_start 处）视为数据异常，保守放弃压缩（链永不进保留区）
            if tool_pair_protection {
                loop {
                    let mut calls: HashSet<&str> = HashSet::new();
                    let mut orphans: Vec<&str> = Vec::new();
                    for message in &messages[cut..] {
                        for block in &message.blocks {
                            match block {
                                AgentMessageBlock::ToolCall(call) => {
                                    calls.insert(call.id.as_str());
                                }
                                AgentMessageBlock::ToolResult { tool_call_id, .. } => {
                                    if !calls.contains(tool_call_id.as_str()) {
                                        orphans.push(tool_call_id.as_str());
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    if orphans.is_empty() {
                        break;
                    }
                    // 向前找最靠近保留段的含孤儿 id 的 ToolCall 消息并纳入保留段
                    let mut needed: Option<usize> = None;
                    for j in (fold_start..cut).rev() {
                        if messages[j].tool_calls().any(|c| orphans.contains(&c.id.as_str())) {
                            needed = Some(j);
                            break;
                        }
                    }
                    match needed {
                        Some(j) if j > fold_start => cut = j,
                        // 孤儿 call 位于链内 / 缺失：数据异常 → 放弃压缩
                        _ => return None,
                    }
                }
                // 扩展后保留段覆盖链尾全部内容 → 无可丢内容，放弃压缩
                if cut <= fold_start {
                    return None;
                }
            }

            Some(cut)
        }
    }

    /// 从尾部向前找最近一条 usage 仍描述当前前缀的消息（P4 §3.3.1）
    ///
    /// 返回 `(消息索引, 归一化输入占用)`。判定规则：
    ///
    /// - 仅取 `metadata.cacheBreakdown.inputTotal`（C9 归一化口径，I6）；
    ///   cacheBreakdown 缺失时回退 `metadata.usage.promptTokens`
    ///   （Included 语义，无 cacheBreakdown 的合成数据兜底）；
    /// - 排除 aborted / error 回合与零 usage（对齐 pi estimate.ts:76-78）；
    /// - **时间戳护栏**：`last_compaction_at` 存在时，消息时间戳早于边界
    ///   则该 usage 不再描述当前前缀（压缩插入了新的前缀消息），整体作废
    ///   回退启发式（对齐 pi `usageAppliesToPrefix`）；时间戳无法解析时
    ///   保守作废（宁可低估护栏能力也不误信旧 usage）。
    fn find_usage_message(
        messages: &[Arc<AgentMessage>],
        last_compaction_at: Option<i64>,
    ) -> Option<(usize, u64)> {
        for (i, message) in messages.iter().enumerate().rev() {
            let Some(occupancy) = usage_occupancy(message) else {
                continue;
            };
            if occupancy == 0 {
                continue;
            }
            // 排除 aborted / error 回合（该回合 usage 不代表可用前缀）
            if let Some(metadata) = &message.metadata {
                if metadata
                    .get("aborted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    continue;
                }
                if metadata.get("stopReason").and_then(|v| v.as_str()) == Some("error") {
                    continue;
                }
            }
            // 时间戳护栏：早于压缩边界 → 旧 usage 全部作废，回退启发式
            if let Some(boundary) = last_compaction_at {
                match parse_iso8601_epoch_ms(&message.created_at) {
                    Some(t) if t < boundary => return None,
                    Some(_) => {}
                    None => return None,
                }
            }
            return Some((i, occupancy));
        }
        None
    }

    /// 从消息 metadata 取归一化输入占用（I6 口径）
    ///
    /// 优先级：`cacheBreakdown.inputTotal`（P2/C9 归一化，Included 系 prompt、
    /// Excluded 系 prompt+read+write 均已折算）> `usage.promptTokens`
    /// （Included 语义兜底）。返回 None = 该消息无可用 usage。
    fn usage_occupancy(message: &AgentMessage) -> Option<u64> {
        let metadata = message.metadata.as_ref()?;
        if let Some(breakdown) = metadata.get("cacheBreakdown") {
            if let Some(total) = breakdown.get("inputTotal").and_then(|v| v.as_u64()) {
                return Some(total);
            }
        }
        let usage = metadata.get("usage")?;
        usage.get("promptTokens").and_then(|v| v.as_u64())
    }

    /// 估算核心：给定可用 usage（None = 纯启发式），
    /// usage 覆盖其前缀（含 system/tools，服务端实测口径），其后的
    /// 尾随消息按块级启发式补算；纯启发式路径把 tools/system 前缀计入。
    fn estimate_with_usage(
        messages: &[Arc<AgentMessage>],
        tools: Option<&str>,
        system: Option<&str>,
        usage: Option<(usize, u64)>,
    ) -> EstimateContext {
        match usage {
            Some((idx, occupancy)) => {
                let tail_tokens: u64 = messages[idx + 1..]
                    .iter()
                    .map(|m| super::count_agent_message_tokens(m) as u64)
                    .sum();
                EstimateContext {
                    tokens: occupancy.saturating_add(tail_tokens),
                    source: EstimateSource::Usage,
                    usage_message_id: Some(messages[idx].id.clone()),
                }
            }
            None => {
                let mut tokens: u64 = messages
                    .iter()
                    .map(|m| super::count_agent_message_tokens(m) as u64)
                    .sum();
                // system/tools 前缀仅在启发式路径计入（usage 实测值已含此前缀）
                if let Some(system) = system {
                    tokens = tokens.saturating_add(super::count_tokens(system) as u64);
                }
                if let Some(tools) = tools {
                    tokens = tokens.saturating_add(super::count_tokens(tools) as u64);
                }
                EstimateContext {
                    tokens,
                    source: EstimateSource::Heuristic,
                    usage_message_id: None,
                }
            }
        }
    }

    /// L1 静态摘要占位符（旧 Message 面 / 兼容测试仍使用；AgentMessage
    /// 面已由 [stub_placeholder] 取代——R-E：旧面保留，新面中性句柄）
    fn summary_placeholder(dropped_count: usize) -> String {
        format!("[Compacted {dropped_count} earlier message(s) to fit context window]")
    }

    /// 中性句柄 stub（T-13；R-C：永不改写；无"生成中/失败"措辞——
    /// 文本是压缩时刻状态快照，摘要就绪以块表/工具为准，不误导模型）
    ///
    /// `generation` 入参保留（签名对齐）；代数已编码进 `block_id`
    /// （R-B：`compacted-summary-{gen}-{fold}`），正文不重复出现。
    fn stub_placeholder(block_id: &str, count: usize, _generation: u32) -> String {
        format!("[Compacted({block_id}) {count} 条消息 · 摘要见块表]")
    }

    /// 摘要文本按 token 上限钳制（保证 count_tokens(结果) ≤ max_tokens）
    ///
    /// 字符预算 = max_tokens × 4（ASCII 4 字符/token 的保守上界），截断后
    /// 再按启发式计数逐档收缩；省略号占 1 token 预算（内容预算先减 1）。
    fn truncate_summary(summary: &str, max_tokens: usize) -> String {
        if super::count_tokens(summary) <= max_tokens {
            return summary.to_string();
        }
        let content_budget = max_tokens.saturating_sub(1);
        let mut truncated: String = summary
            .chars()
            .take(content_budget.saturating_mul(4))
            .collect();
        while super::count_tokens(&truncated) > content_budget && !truncated.is_empty() {
            truncated.pop();
        }
        if truncated.is_empty() {
            return "…".to_string();
        }
        truncated.push('…');
        truncated
    }

    /// ISO8601 时间戳 → epoch 毫秒（无 chrono 依赖的手工解析）
    ///
    /// 期望形态：`YYYY-MM-DDTHH:MM:SS[.mmm]Z`（UTC，`now_iso_utc` 产出
    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`）；小数秒缺省按 0 处理；仅接受 Z 结尾
    /// （带时区偏移的形态视为不可解析）。解析失败返回 None。
    pub(crate) fn parse_iso8601_epoch_ms(value: &str) -> Option<i64> {
        let bytes = value.as_bytes();
        if bytes.len() < 20 {
            return None;
        }
        if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
            return None;
        }
        if bytes[13] != b':' || bytes[16] != b':' {
            return None;
        }
        let num = |start: usize, len: usize| -> Option<i64> {
            value.get(start..start + len)?.parse().ok()
        };
        let year = num(0, 4)?;
        let month = num(5, 2)?;
        let day = num(8, 2)?;
        let hour = num(11, 2)?;
        let minute = num(14, 2)?;
        let second = num(17, 2)?;
        // 小数秒（可选；now_iso_utc 恒 3 位）
        let mut millis = 0i64;
        let mut idx = 19;
        if idx < bytes.len() && bytes[idx] == b'.' {
            idx += 1;
            let start = idx;
            while idx < bytes.len() && bytes[idx].is_ascii_digit() {
                idx += 1;
            }
            if idx == start {
                return None;
            }
            let fraction = &value[start..idx];
            // 不足 3 位补零、超 3 位截断（毫秒精度）
            let mut padded = String::with_capacity(3);
            padded.push_str(fraction);
            while padded.len() < 3 {
                padded.push('0');
            }
            padded.truncate(3);
            millis = padded.parse().ok()?;
        }
        if idx >= bytes.len() || bytes[idx] != b'Z' {
            return None;
        }
        // 基本范围校验（护栏判定用；不做逐月天数精确校验）
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        if hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        let days = days_from_civil(year, month as u32, day as u32)?;
        Some(
            (days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis,
        )
    }

    /// 公历日期 → 1970-01-01 起天数（Howard Hinnant civil-from-days 逆运算）
    fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
        if month == 0 || day == 0 {
            return None;
        }
        let year = if month <= 2 { year - 1 } else { year };
        let era = (if year >= 0 { year } else { year - 399 }) / 400;
        let year_of_era = year - era * 400;
        let day_of_year: i64 =
            (153 * i64::from(if month > 2 { month - 3 } else { month + 9 }) + 2) / 5
                + i64::from(day)
                - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        Some(era * 146_097 + day_of_era - 719_468)
    }
}

/// 保留最近 token 预算默认（对齐 pi keepRecentTokens=20000，P4 §3.4.2）
pub const KEEP_RECENT_TOKENS_DEFAULT: usize = 20_000;
/// 保留最近完整回合数下限默认（对齐 opencode tail_turns=2，P4 §3.4.2）
pub const MIN_RECENT_TURNS_DEFAULT: u32 = 2;
/// 摘要占位符 token 上限默认（P4 §3.4.2）
pub const MAX_SUMMARY_TOKENS_DEFAULT: usize = 1_024;
/// 常规线水位默认（85%，02 Top 4 / 04 C9 触发条件）
pub const COMPACT_THRESHOLD_RATIO_DEFAULT: f64 = 0.85;
/// 临界线水位默认（95%，02 Top 4：同步硬压缩防线）
pub const COMPACT_CRITICAL_RATIO_DEFAULT: f64 = 0.95;
/// session_meta 键：常规线水位（Q1 裁决：默认值配置面、覆盖走 session_meta）
pub const SESSION_META_KEY_COMPACT_THRESHOLD_RATIO: &str = "compact_threshold_ratio";
/// session_meta 键：临界线水位
pub const SESSION_META_KEY_COMPACT_CRITICAL_RATIO: &str = "compact_critical_ratio";
/// session_meta 键：摘要产出 token 上限（04 C9 第 2 条，默认 1500 由
/// 调用方换算进 CompactionPolicy.max_summary_tokens）
pub const SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS: &str = "compact_summary_max_tokens";
/// 图片固定 token 计价（对齐 jcode IMAGE_TOKEN_COST=1600，P4 §3.3.1：
/// base64 按 len/4 计数会高估真实上下文约 100 倍，必须固定计价；
/// AgentMessage 当前无图片块，此常量供未来图片块 / 旧面迁移使用）
pub const IMAGE_TOKEN_COST: usize = 1_600;

/// Estimate token count using a tiktoken-inspired heuristic.
/// Approximation: ~4 characters per token for English text,
/// with adjustments for whitespace, punctuation, and CJK characters.
pub fn count_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    let mut tokens: usize = 0;
    let mut word_chars: usize = 0;

    for ch in text.chars() {
        if ch.is_ascii() {
            if ch.is_whitespace() || ch.is_ascii_punctuation() {
                // 约 4 字符折 1 token（向上取整）
                if word_chars > 0 {
                    tokens += word_chars.div_ceil(4);
                    word_chars = 0;
                }
                // Separator is its own token
                tokens += 1;
            } else {
                word_chars += 1;
            }
        } else {
            // CJK 等非 ASCII 字符：约 1-2 token/字符
            // 先刷出待结算的 ASCII 单词字符
            if word_chars > 0 {
                tokens += word_chars.div_ceil(4);
                word_chars = 0;
            }
            tokens += 1; // each non-ASCII char ≈ 1 token
        }
    }

    // 刷新剩余单词字符（向上取整）
    if word_chars > 0 {
        tokens += word_chars.div_ceil(4);
    }

    // Minimum 1 token for non-empty text
    tokens.max(1)
}

/// 单条 AgentMessage 的块级 token 估算（对齐 `to_chat_messages`
/// 序列化形态，P4 §3.3.1）
///
/// - `Text` / `Thought` → [count_tokens] 正文；
/// - `ToolCall` → 工具名 + 入参 JSON 折算（对齐 pi estimateMessageTokens
///   的 name + arguments，pi-cache-analysis.md:82）；
/// - `ToolResult` → 工具名 + 输出折算（text / json / artifacts 三通道，
///   与 wire 序列化口径一致）。
pub fn count_agent_message_tokens(message: &AgentMessage) -> usize {
    message
        .blocks
        .iter()
        .map(|block| match block {
            AgentMessageBlock::Text { text } => count_tokens(text),
            AgentMessageBlock::Thought { text, .. } => count_tokens(text),
            AgentMessageBlock::ToolCall(call) => {
                count_tokens(&call.tool_name) + count_tokens(&call.input.to_string())
            }
            AgentMessageBlock::ToolResult {
                tool_name,
                output,
                ..
            } => count_tokens(tool_name) + count_tool_output_tokens(output),
        })
        .sum()
}

/// 工具输出折算（text / json / artifacts 三通道字符折算）
pub fn count_tool_output_tokens(output: &ToolOutput) -> usize {
    let mut tokens = 0usize;
    if let Some(text) = &output.text {
        tokens += count_tokens(text);
    }
    if let Some(json) = &output.json {
        tokens += count_tokens(&json.to_string());
    }
    if let Some(artifacts) = &output.artifacts {
        for artifact in artifacts {
            tokens += count_tokens(&artifact.title);
            if let Some(uri) = &artifact.uri {
                tokens += count_tokens(uri);
            }
            if let Some(text) = &artifact.text {
                tokens += count_tokens(text);
            }
            if let Some(metadata) = &artifact.metadata {
                tokens += count_tokens(&metadata.to_string());
            }
        }
    }
    tokens
}

/// 结构化摘要模板（P4 §3.4.3）：Goal / Constraints / Progress / Key
/// Decisions / Next Steps / Critical Context 六节，无内容节写 `(none)`。
///
/// L2 摘要实现方（session-loop / 壳层注入的 [Summarizer]）以本模板为输出
/// 格式基准；L1 静态路径使用 [compaction] 内部的简洁占位符（既有模板）。
pub fn structured_summary_template(dropped: &[AgentMessage], existing: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(existing) = existing {
        out.push_str(existing);
        out.push_str("\n\n");
    }
    for section in [
        "Goal",
        "Constraints",
        "Progress",
        "Key Decisions",
        "Next Steps",
        "Critical Context",
    ] {
        out.push_str("## ");
        out.push_str(section);
        out.push_str("\n(none)\n\n");
    }
    out.push_str(&format!(
        "## 来源\n本次压缩丢弃 {} 条消息（详见压缩事件 droppedIds）",
        dropped.len()
    ));
    out
}

pub use compaction::{
    CompactionEngine, CompactionPlan, CompactionPolicy, CompactionThresholds, EstimateContext,
    EstimateSource, Summarizer, ThresholdDecision,
};

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conex_types::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock, ToolOutput};

    use super::compaction::{
        CompactionEngine, CompactionPolicy, EstimateSource, Summarizer,
    };
    use super::{
        count_agent_message_tokens, count_tokens, structured_summary_template,
        MIN_RECENT_TURNS_DEFAULT,
    };

    // ── 测试构造工具 ──

    fn text_block(text: &str) -> AgentMessageBlock {
        AgentMessageBlock::Text {
            text: text.to_string(),
        }
    }

    fn thought_block(text: &str) -> AgentMessageBlock {
        AgentMessageBlock::Thought {
            text: text.to_string(),
            redacted: None,
        }
    }

    fn tool_call_block(id: &str, tool_name: &str, input: serde_json::Value) -> AgentMessageBlock {
        AgentMessageBlock::ToolCall(ToolCallBlock {
            id: id.to_string(),
            tool_name: tool_name.to_string(),
            input,
        })
    }

    fn tool_result_block(id: &str, tool_name: &str, output: &str) -> AgentMessageBlock {
        AgentMessageBlock::ToolResult {
            tool_call_id: id.to_string(),
            tool_name: tool_name.to_string(),
            output: ToolOutput::text(output),
            is_error: false,
        }
    }

    fn amsg(
        id: &str,
        role: AgentMessageRole,
        created_at: &str,
        blocks: Vec<AgentMessageBlock>,
        metadata: Option<serde_json::Value>,
    ) -> Arc<AgentMessage> {
        Arc::new(AgentMessage {
            id: id.to_string(),
            role,
            created_at: created_at.to_string(),
            blocks,
            metadata,
            client_message_id: None,
            content: None,
        })
    }

    /// 带 usage 的 assistant 消息（cacheBreakdown.inputTotal = input_total）
    fn usage_msg(
        id: &str,
        created_at: &str,
        input_total: u64,
        text: &str,
    ) -> Arc<AgentMessage> {
        amsg(
            id,
            AgentMessageRole::Assistant,
            created_at,
            vec![text_block(text)],
            Some(serde_json::json!({
                "stopReason": "stop",
                "usage": {
                    "promptTokens": input_total,
                    "completionTokens": 10,
                    "totalTokens": input_total + 10,
                    "cacheReadTokens": 0,
                    "cacheWriteTokens": 0,
                },
                "cacheBreakdown": {
                    "read": 0,
                    "write": 0,
                    "miss": input_total,
                    "inputTotal": input_total,
                },
            })),
        )
    }

    /// 既有 Message 面测试（原样保留，验证兼容）
    use conex_types::Message;

    fn msg(id: &str, role: &str, content: &str) -> Message {
        Message {
            id: id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            images: None,
        }
    }

    #[test]
    fn count_tokens_empty() {
        assert_eq!(count_tokens(""), 0);
    }

    #[test]
    fn count_tokens_simple_word() {
        // "hello" = 5 chars → ~1-2 tokens
        let tokens = count_tokens("hello");
        assert!((1..=3).contains(&tokens));
    }

    #[test]
    fn count_tokens_sentence() {
        // A sentence with spaces and punctuation
        let tokens = count_tokens("Hello, world! This is a test.");
        assert!(tokens >= 5); // at least word count
        assert!(tokens <= 20); // reasonable upper bound
    }

    #[test]
    fn count_tokens_cjk() {
        // CJK characters should each be ~1 token
        let tokens = count_tokens("你好世界");
        assert!(tokens >= 4);
    }

    #[test]
    fn count_tokens_long_text() {
        let text = "word ".repeat(100);
        let tokens = count_tokens(&text);
        // ~100 words * ~1.5 tokens/word ≈ 150 tokens
        assert!(tokens >= 100);
        assert!(tokens <= 300);
    }

    #[test]
    fn compact_empty_messages() {
        let engine = CompactionEngine::new(1000);
        let result = engine.compact(&[]);
        assert!(result.messages.is_empty());
        assert_eq!(result.tokens_consumed, 0);
    }

    #[test]
    fn compact_under_budget_no_change() {
        let engine = CompactionEngine::new(10000);
        let messages = vec![
            msg("1", "system", "You are helpful."),
            msg("2", "user", "Hello"),
            msg("3", "assistant", "Hi there!"),
        ];
        let result = engine.compact(&messages);
        assert_eq!(result.messages.len(), 3);
        assert!(result.cache_hit_rate_optimized);
    }

    #[test]
    fn compact_over_budget_compresses_oldest() {
        let engine = CompactionEngine::new(20);
        let messages = vec![
            msg("1", "system", "System prompt"),
            msg("2", "user", "First message with quite a lot of content that takes many tokens to represent"),
            msg("3", "assistant", "First response with quite a lot of content that takes many tokens to represent"),
            msg("4", "user", "Second message with substantial content for testing purposes"),
            msg("5", "assistant", "Second response with substantial content for testing purposes"),
            msg("6", "user", "Latest question"),
            msg("7", "assistant", "Latest answer"),
        ];
        let result = engine.compact(&messages);

        // Should have fewer messages than input
        assert!(result.messages.len() < messages.len());
        // System message should be preserved
        assert!(result.messages.iter().any(|m| m.role == "system"));
        // Recent messages should be preserved
        assert!(result.messages.iter().any(|m| m.content == "Latest question"));
        assert!(result.messages.iter().any(|m| m.content == "Latest answer"));
        // Should have a compaction summary
        assert!(result.messages.iter().any(|m| m.content.contains("Compacted")));
    }

    #[test]
    fn compact_preserves_system_messages() {
        let engine = CompactionEngine::new(30);
        let messages = vec![
            msg("s1", "system", "System A"),
            msg("s2", "system", "System B"),
            msg("u1", "user", "A very long user message that exceeds the budget significantly"),
            msg("a1", "assistant", "A very long assistant response"),
            msg("u2", "user", "Recent"),
        ];
        let result = engine.compact(&messages);
        let system_count = result.messages.iter().filter(|m| m.role == "system").count();
        assert_eq!(system_count, 2);
    }

    #[test]
    fn compact_single_message_over_budget() {
        let engine = CompactionEngine::new(5);
        let messages = vec![
            msg("1", "user", "This is a very long message that far exceeds the token budget"),
        ];
        let result = engine.compact(&messages);
        // Should still return something (the recent message is kept)
        assert!(!result.messages.is_empty());
    }

    // ── AgentMessage 面：估算 ──

    #[test]
    fn estimate_heuristic_mixed_ascii_cjk() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg(
                "m1",
                AgentMessageRole::User,
                "2026-08-03T10:00:00.000Z",
                vec![text_block("你好世界 hello world")],
                None,
            ),
            amsg(
                "m2",
                AgentMessageRole::Assistant,
                "2026-08-03T10:00:01.000Z",
                vec![thought_block("思考过程"), text_block("Response text")],
                None,
            ),
        ];
        let expected = count_agent_message_tokens(&messages[0]) + count_agent_message_tokens(&messages[1]);
        let result = engine.estimate_context_tokens(&messages, None, None, None);
        assert_eq!(result.source, EstimateSource::Heuristic);
        assert_eq!(result.tokens, expected as u64);
        assert_eq!(result.usage_message_id, None);
        // CJK 逐字符计价在块级估算中生效（ASCII 4 字符/token 为对照基线）
        assert!(count_tokens("你好世界") >= 4);
        assert!(count_tokens("abcd") <= 2);
    }

    #[test]
    fn estimate_tools_system_counted_in_heuristic_only() {
        let engine = CompactionEngine::new(0);
        let messages = vec![amsg(
            "m1",
            AgentMessageRole::User,
            "2026-08-03T10:00:00.000Z",
            vec![text_block("hi")],
            None,
        )];
        let tools = r#"[{"type":"function","function":{"name":"read_file"}}]"#;
        let system = "You are a helpful assistant.";
        let heuristic = engine.estimate_context_tokens(&messages, Some(tools), Some(system), None);
        assert_eq!(heuristic.source, EstimateSource::Heuristic);
        assert_eq!(
            heuristic.tokens,
            (count_agent_message_tokens(&messages[0])
                + count_tokens(tools)
                + count_tokens(system)) as u64
        );
    }

    #[test]
    fn estimate_usage_priority_and_tail_heuristic() {
        let engine = CompactionEngine::new(0);
        // usage 消息在前，其后有一条尾随消息（须启发式补算）
        let messages = vec![
            usage_msg("a1", "2026-08-03T10:00:00.000Z", 800, "first response"),
            amsg(
                "u2",
                AgentMessageRole::User,
                "2026-08-03T10:00:01.000Z",
                vec![text_block("tail message")],
                None,
            ),
        ];
        let result = engine.estimate_context_tokens(&messages, None, None, None);
        assert_eq!(result.source, EstimateSource::Usage);
        assert_eq!(result.usage_message_id.as_deref(), Some("a1"));
        assert_eq!(
            result.tokens,
            800 + count_agent_message_tokens(&messages[1]) as u64
        );
    }

    #[test]
    fn estimate_usage_ignores_aborted_and_zero_usage() {
        let engine = CompactionEngine::new(0);
        // 最近的 assistant 是 aborted 回合 → 跳过，用更早的 usage 消息
        let messages = vec![
            usage_msg("a1", "2026-08-03T10:00:00.000Z", 500, "first"),
            amsg(
                "a2",
                AgentMessageRole::Assistant,
                "2026-08-03T10:00:01.000Z",
                vec![text_block("aborted")],
                Some(serde_json::json!({
                    "aborted": true,
                    "usage": { "promptTokens": 900 },
                    "cacheBreakdown": { "inputTotal": 900, "read": 0, "write": 0, "miss": 900 },
                })),
            ),
        ];
        let result = engine.estimate_context_tokens(&messages, None, None, None);
        assert_eq!(result.source, EstimateSource::Usage);
        assert_eq!(result.usage_message_id.as_deref(), Some("a1"));
        // usage 覆盖 a1 之前的前缀；a2（aborted 回合）作为尾随消息按启发式补算
        assert_eq!(
            result.tokens,
            500 + count_agent_message_tokens(&messages[1]) as u64
        );

        // 零 usage（inputTotal = 0）→ 跳过，纯启发式
        let messages = vec![amsg(
            "a3",
            AgentMessageRole::Assistant,
            "2026-08-03T10:00:02.000Z",
            vec![text_block("zero usage")],
            Some(serde_json::json!({
                "stopReason": "stop",
                "usage": { "promptTokens": 0 },
                "cacheBreakdown": { "inputTotal": 0, "read": 0, "write": 0, "miss": 0 },
            })),
        )];
        let result = engine.estimate_context_tokens(&messages, None, None, None);
        assert_eq!(result.source, EstimateSource::Heuristic);
        assert_eq!(
            result.tokens,
            count_agent_message_tokens(&messages[0]) as u64
        );
    }

    #[test]
    fn estimate_timestamp_guard_invalidates_stale_usage() {
        let engine = CompactionEngine::new(0);
        // 压缩边界 = 10:00:01.500；最近的 usage 消息早于边界 → 作废回退启发式
        let messages = vec![usage_msg("a1", "2026-08-03T10:00:00.000Z", 800, "old")];
        let boundary = parse_ms("2026-08-03T10:00:01.500Z");
        let result = engine.estimate_context_tokens(&messages, None, None, Some(boundary));
        assert_eq!(result.source, EstimateSource::Heuristic);
        assert_eq!(result.usage_message_id, None);
        assert_eq!(result.tokens, count_agent_message_tokens(&messages[0]) as u64);

        // 边界在 usage 消息之前 → usage 仍描述当前前缀，可用
        let result = engine.estimate_context_tokens(
            &messages,
            None,
            None,
            Some(parse_ms("2026-08-03T09:59:59.500Z")),
        );
        assert_eq!(result.source, EstimateSource::Usage);
        assert_eq!(result.tokens, 800);
    }

    #[test]
    fn estimate_agent_context_p4_compat_entry() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            usage_msg("a1", "2026-08-03T10:00:00.000Z", 300, "resp"),
            amsg(
                "u2",
                AgentMessageRole::User,
                "2026-08-03T10:00:01.000Z",
                vec![text_block("tail")],
                None,
            ),
        ];
        // 调用方已定位 usage 消息 id → 以其为准
        let result = engine.estimate_agent_context(&messages, Some("a1"));
        assert_eq!(result.source, EstimateSource::Usage);
        assert_eq!(result.tokens, 300 + count_agent_message_tokens(&messages[1]) as u64);
        // id 未命中 → 纯启发式
        let result = engine.estimate_agent_context(&messages, Some("missing"));
        assert_eq!(result.source, EstimateSource::Heuristic);
    }

    #[test]
    fn estimate_empty_messages() {
        let engine = CompactionEngine::new(0);
        let result = engine.estimate_context_tokens(&[], None, None, None);
        assert_eq!(result.tokens, 0);
        assert_eq!(result.source, EstimateSource::Heuristic);
        assert_eq!(result.usage_message_id, None);

        // 空消息 + tools/system → 仅前缀折算
        let tools = "tools-json";
        let system = "system-prompt";
        let result = engine.estimate_context_tokens(&[], Some(tools), Some(system), None);
        assert_eq!(
            result.tokens,
            (count_tokens(tools) + count_tokens(system)) as u64
        );
    }

    #[test]
    fn parse_iso8601_timestamp() {
        use super::compaction::parse_iso8601_epoch_ms;
        // now_iso_utc 形态（3 位毫秒；2026-08-03T12:00:00Z = 1785758400000）
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00.000Z"),
            Some(1_785_758_400_000i64)
        );
        // 无小数秒
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00Z"),
            Some(1_785_758_400_000i64)
        );
        // 带小数秒（毫秒取前 3 位）
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T12:00:00.999Z"),
            Some(1_785_758_400_999i64)
        );
        // 非法形态 → None
        assert_eq!(parse_iso8601_epoch_ms(""), None);
        assert_eq!(parse_iso8601_epoch_ms("2026-08-03 12:00:00Z"), None);
        assert_eq!(parse_iso8601_epoch_ms("2026-13-03T12:00:00Z"), None);
        assert_eq!(parse_iso8601_epoch_ms("2026-08-03T12:00:00+08:00"), None);
    }

    fn parse_ms(value: &str) -> i64 {
        super::compaction::parse_iso8601_epoch_ms(value).expect("测试时间戳可解析")
    }

    // ── AgentMessage 面：切割点 ──

    #[test]
    fn cut_point_accumulates_from_tail_to_budget() {
        let engine = CompactionEngine::new(0);
        // 中间两条长消息 + 尾部两条短消息；keep 预算恰好覆盖尾部两条
        let messages = vec![
            amsg("m1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"x".repeat(200))], None),
            amsg("m2", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block(&"y".repeat(200))], None),
            amsg("m3", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block("recent user")], None),
            amsg("m4", AgentMessageRole::Assistant, "2026-08-03T10:00:03.000Z", vec![text_block("recent asst")], None),
        ];
        // 预算 = 尾部两条的 token 和 → 倒推累计恰好在 m3 达标 → 切割点 = 2
        let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
        let cut = engine.find_cut_point(&messages, keep, 1).expect("应存在切割点");
        assert_eq!(cut, 2);
    }

    #[test]
    fn cut_point_min_recent_turns_extends_backward() {
        let engine = CompactionEngine::new(0);
        // 预算切割点落在 m3（assistant）→ 保留段仅 1 个 user 回合；
        // min_recent_turns=2 → 向前扩展到 m2（user）凑满 2 个回合
        let messages = vec![
            amsg("m1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"a".repeat(100))], None),
            amsg("m2", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block("u2")], None),
            amsg("m3", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block("a2")], None),
            amsg("m4", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("u3")], None),
            amsg("m5", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("a3")], None),
        ];
        let keep = count_agent_message_tokens(&messages[2])
            + count_agent_message_tokens(&messages[3])
            + count_agent_message_tokens(&messages[4]);
        let cut = engine.find_cut_point(&messages, keep, 2).expect("应存在切割点");
        assert_eq!(cut, 1);
    }

    #[test]
    fn cut_point_never_splits_tool_pair() {
        let engine = CompactionEngine::new(0);
        // m2 是 tool-call（id=t1），m3 是 tool-result(t1)；预算切割点落在
        // m3（保留段含 result 无 call）→ 向前扩展到 m2
        let messages = vec![
            amsg("m1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"a".repeat(200))], None),
            amsg("m2", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![tool_call_block("t1", "read_file", serde_json::json!({"path": "/tmp/x"}))], None),
            amsg("m3", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![tool_result_block("t1", "read_file", "file content")], None),
            amsg("m4", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("u2")], None),
            amsg("m5", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("a2")], None),
        ];
        let keep = count_agent_message_tokens(&messages[2])
            + count_agent_message_tokens(&messages[3])
            + count_agent_message_tokens(&messages[4]);
        let cut = engine.find_cut_point(&messages, keep, 1).expect("应存在切割点");
        // 预算落在 m3，但 m3 含孤儿 result(t1) → 扩展到 m2（call 所在）
        assert_eq!(cut, 1);
    }

    #[test]
    fn cut_point_abandons_on_unfixable_orphan() {
        let engine = CompactionEngine::new(0);
        // 保留段含 result(t1) 但全对话无对应 call → 数据异常，放弃压缩
        let messages = vec![
            amsg("m1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"a".repeat(200))], None),
            amsg("m2", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block("u1")], None),
            amsg("m3", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![tool_result_block("t1", "read_file", "orphan result")], None),
            amsg("m4", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("u2")], None),
            amsg("m5", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("a2")], None),
        ];
        let keep = count_agent_message_tokens(&messages[2])
            + count_agent_message_tokens(&messages[3])
            + count_agent_message_tokens(&messages[4]);
        let cut = engine.find_cut_point(&messages, keep, 0);
        assert_eq!(cut, None);
    }

    #[test]
    fn cut_point_none_on_empty_or_all_retained() {
        let engine = CompactionEngine::new(0);
        assert_eq!(engine.find_cut_point(&[], 100, 2), None);
        // 全部消息未达预算 → 无可丢内容
        let messages = vec![
            amsg("m1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block("short")], None),
            amsg("m2", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block("short")], None),
        ];
        assert_eq!(engine.find_cut_point(&messages, 10_000, 1), None);
    }

    // ── AgentMessage 面：压缩 ──

    #[test]
    fn compact_empty_input() {
        let engine = CompactionEngine::new(0);
        let plan = engine.compact_agent_messages(&[], 100, &CompactionPolicy::default(), None);
        assert!(plan.messages.is_empty());
        assert_eq!(plan.tokens_before, 0);
        assert_eq!(plan.tokens_after, 0);
        assert!(plan.dropped_ids.is_empty());
        assert!(plan.summary.is_empty());
    }

    #[test]
    fn compact_under_budget_returns_original() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system")], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block("hello")], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block("hi")], None),
        ];
        let plan = engine.compact_agent_messages(&messages, 10_000, &CompactionPolicy::default(), None);
        assert_eq!(plan.messages.len(), messages.len());
        assert_eq!(
            plan.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["s1", "u1", "a1"]
        );
        assert!(plan.dropped_ids.is_empty());
        assert!(plan.summary.is_empty());
        assert_eq!(plan.tokens_before, plan.tokens_after);
    }

    #[test]
    fn compact_keeps_system_and_recent_with_placeholder() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system prompt")], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block(&"long user one".repeat(50))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block(&"long asst one".repeat(50))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("recent user")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("recent asst")], None),
        ];
        // keep 预算恰好覆盖尾部两条（u2/a2）→ 切割点 = 3
        let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 30, &policy, None);
        // 输出 = system + 摘要 stub（id = compacted-summary-{gen}-{fold}）+ 保留段（u2/a2）
        assert_eq!(
            plan.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["s1", "compacted-summary-1-1", "u2", "a2"]
        );
        // stub 格式（T-13 中性句柄：块 id + 丢弃数，无"生成中"措辞）
        assert_eq!(
            plan.summary,
            "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]"
        );
        assert!(!plan.summary.contains("生成中"), "stub 不得含「生成中」措辞（R-C）");
        assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
        assert_eq!(plan.first_kept_message_id.as_deref(), Some("u2"));
        // kept_ids = system + 摘要 stub + 保留段
        assert_eq!(plan.kept_ids, vec!["s1", "compacted-summary-1-1", "u2", "a2"]);
        // 压缩后 token 显著下降且 stub 计入
        assert!(plan.tokens_after < plan.tokens_before);
        assert!(!plan.summary_is_llm);
    }

    #[test]
    fn compact_placeholder_uses_dropped_count() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"m".repeat(300))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block(&"m".repeat(300))], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block(&"m".repeat(300))], None),
            amsg("u3", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("keep")], None),
            amsg("a3", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("keep")], None),
        ];
        // keep 恰好覆盖尾部两条 → 切割点 = 3，丢弃 u1/a1/a2 共 3 条
        let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
        // stub 携带丢弃数（块 id 与 dropped 数解耦，R-B：不再以数量为 id）
        assert_eq!(
            plan.summary,
            "[Compacted(compacted-summary-1-1) 3 条消息 · 摘要见块表]"
        );
        assert_eq!(plan.dropped_ids, vec!["u1", "a1", "a2"]);
    }

    #[test]
    fn compact_tool_pair_not_split() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"long question".repeat(50))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![tool_call_block("t1", "read_file", serde_json::json!({"path": "/tmp/x"}))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![tool_result_block("t1", "read_file", "file content")], None),
            amsg("u3", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("next")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("answer")], None),
        ];
        // 预算切割点落在 u2（含 result）→ 向前扩展到 a1（含 call），
        // tool use/result 对一起保留；仅 u1 被压缩
        let keep = count_agent_message_tokens(&messages[2])
            + count_agent_message_tokens(&messages[3])
            + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 40, &policy, None);
        let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"a1"), "tool-call 消息须保留");
        assert!(ids.contains(&"u2"), "tool-result 消息须保留");
        assert_eq!(plan.dropped_ids, vec!["u1"]);
        assert_eq!(plan.first_kept_message_id.as_deref(), Some("a1"));
    }

    #[test]
    fn compact_abandons_when_orphan_unfixable() {
        let engine = CompactionEngine::new(0);
        // 保留段含孤儿 result(t1) 且全对话无对应 call → 放弃压缩，原样返回
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![tool_result_block("t1", "read_file", "orphan")], None),
            amsg("u3", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:03.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages[1])
            + count_agent_message_tokens(&messages[2])
            + count_agent_message_tokens(&messages[3]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 0,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
        assert_eq!(
            plan.messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["u1", "u2", "u3", "a2"],
            "放弃压缩：原序列原样返回"
        );
        assert!(plan.dropped_ids.is_empty());
        assert!(plan.summary.is_empty());
    }

    #[test]
    fn compact_tool_pair_protection_can_be_disabled() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"long question".repeat(50))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![tool_call_block("t1", "read_file", serde_json::json!({"path": "/tmp/x"}))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![tool_result_block("t1", "read_file", "file content")], None),
            amsg("u3", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("next")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("answer")], None),
        ];
        let keep = count_agent_message_tokens(&messages[2])
            + count_agent_message_tokens(&messages[3])
            + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            tool_pair_protection: false,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 40, &policy, None);
        // 保护关闭：切割点不向前扩展，call 被压缩、result 留在保留段
        assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
        assert!(plan.messages.iter().any(|m| m.id == "u2"));
    }

    #[test]
    fn compact_uses_summarizer_and_iterative_merge() {
        let engine = CompactionEngine::new(0);
        // 已存在旧摘要消息（compacted-summary 前缀）在链内 → 链尾文本进 existing
        let messages = vec![
            amsg("compacted-summary-1", AgentMessageRole::Assistant, "2026-08-03T10:00:00.000Z", vec![text_block("OLD SUMMARY")], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block(&"long user".repeat(60))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block(&"long asst".repeat(60))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("keep")], None),
        ];
        struct RecordingSummarizer;
        impl Summarizer for RecordingSummarizer {
            fn summarize(
                &self,
                dropped: &[AgentMessage],
                existing: Option<&str>,
            ) -> Result<String, String> {
                assert_eq!(existing, Some("OLD SUMMARY"), "迭代合并须携带链尾既有摘要");
                assert_eq!(dropped.len(), 2, "链消息不进入摘要器（T-06）");
                Ok(summary_doc_json("合并 2 条丢弃消息"))
            }
        }
        // keep 恰好覆盖尾部两条 → 切割点 = 3，丢弃 u1/a1（链在折叠链中保留）
        let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(
            &messages,
            5,
            &policy,
            Some(&RecordingSummarizer),
        );
        // LLM 成功 + 合法 JSON 文档 → md 渲染进链（R-G 场景 A）
        assert!(plan.summary_is_llm);
        assert!(plan.summary.contains("## Goal"), "md 渲染进链：{}", plan.summary);
        assert!(plan.summary.contains("合并 2 条丢弃消息"));
        // 链全查 + 新摘要（T-08）：fold = 链长 + 1 = 2
        let chain_ids: Vec<&str> = plan
            .messages
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(
            chain_ids,
            vec!["compacted-summary-1", "compacted-summary-1-2"],
            "既有链全保留 + 新摘要追加（T-08）"
        );
        // metadata 快照：LLM 成功 → committed
        let new_msg = plan
            .messages
            .iter()
            .find(|m| m.id == "compacted-summary-1-2")
            .expect("新摘要消息在场");
        assert_eq!(new_msg.metadata.as_ref().unwrap()["summary"]["state"], "committed");
        // 折叠字段
        assert_eq!(plan.fold_chain_prev, 1);
        assert_eq!(plan.fold_chain_after, 2);
        assert_eq!(plan.fold_index, 2);
        assert_eq!(plan.generation, 1);
        assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
    }

    #[test]
    fn compact_summarizer_error_falls_back_to_stub() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:03.000Z", vec![text_block("keep")], None),
        ];
        struct FailingSummarizer;
        impl Summarizer for FailingSummarizer {
            fn summarize(
                &self,
                _dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                Err("provider error".to_string())
            }
        }
        let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(
            &messages,
            5,
            &policy,
            Some(&FailingSummarizer),
        );
        // 失败降级中性 stub（T-13：R-C 永不改写；摘要失败不阻塞主对话）
        assert!(!plan.summary_is_llm);
        assert_eq!(
            plan.summary,
            "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]"
        );
        // metadata 快照：awaiting
        let summary_msg = plan
            .messages
            .iter()
            .find(|m| m.id.starts_with("compacted-summary"))
            .expect("stub 消息须入对话");
        assert_eq!(summary_msg.metadata.as_ref().unwrap()["summary"]["state"], "awaiting");
    }

    #[test]
    fn compact_summary_capped_by_max_summary_tokens() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:00.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:03.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            max_summary_tokens: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
        // 1 token 预算 → 占位符被截断为省略号（内容预算 0，返回 "…"）
        assert_eq!(plan.summary, "…");
        assert!(count_tokens(&plan.summary) <= 1);
    }

    #[test]
    fn compact_system_messages_always_kept() {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system")], None),
            amsg("s2", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("steering transient")], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("keep")], None),
        ];
        let policy = CompactionPolicy {
            keep_recent_tokens: 10,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
        // 两条 system 消息全部保留且在序列最前
        assert_eq!(plan.messages[0].id, "s1");
        assert_eq!(plan.messages[1].id, "s2");
        assert_eq!(plan.messages[1].role, AgentMessageRole::System);
        assert!(plan.messages.iter().filter(|m| m.role == AgentMessageRole::System).count() == 2);
    }

    #[test]
    fn should_compact_threshold() {
        let engine = CompactionEngine::new(0);
        assert!(!engine.should_compact(999, 1000));
        assert!(engine.should_compact(1000, 1000));
        assert!(engine.should_compact(1001, 1000));
        // 阈值 = window - reserve（T-33 换算后传入）
        let budget = 64_000u64 - 16_384u64;
        assert!(engine.should_compact(budget, budget));
    }

    #[test]
    fn structured_summary_template_sections() {
        let template = structured_summary_template(&[], None);
        for section in [
            "## Goal",
            "## Constraints",
            "## Progress",
            "## Key Decisions",
            "## Next Steps",
            "## Critical Context",
        ] {
            assert!(template.contains(section), "模板须含 {section} 节");
        }
        // 迭代合并：既有摘要前置
        let merged = structured_summary_template(&[], Some("OLD"));
        assert!(merged.starts_with("OLD"));
        // 无内容节写 (none)
        assert!(template.contains("(none)"));
    }

    #[test]
    fn default_policy_matches_plan_constants() {
        let policy = CompactionPolicy::default();
        assert_eq!(policy.keep_recent_tokens, 20_000);
        assert_eq!(policy.min_recent_turns, MIN_RECENT_TURNS_DEFAULT);
        assert_eq!(policy.max_summary_tokens, 1_024);
        assert!(policy.tool_pair_protection);
    }

    // ── M10/C9：双阈值（85% 常规线 + 95% 临界线）──

    #[test]
    fn threshold_classification_regular_and_critical() {
        use super::compaction::{CompactionThresholds, ThresholdDecision};
        let thresholds = CompactionThresholds::default();
        let window = 100_000u64;
        // 预算内
        assert_eq!(thresholds.classify(0, window), ThresholdDecision::UnderBudget);
        assert_eq!(thresholds.classify(84_999, window), ThresholdDecision::UnderBudget);
        // 常规线：85% ≤ 占比 < 95%
        assert_eq!(thresholds.classify(85_000, window), ThresholdDecision::Regular);
        assert_eq!(thresholds.classify(94_999, window), ThresholdDecision::Regular);
        // 临界线：≥ 95%
        assert_eq!(thresholds.classify(95_000, window), ThresholdDecision::Critical);
        assert_eq!(thresholds.classify(100_000, window), ThresholdDecision::Critical);
        assert_eq!(thresholds.classify(200_000, window), ThresholdDecision::Critical);
        // window = 0 保守判临界
        assert_eq!(thresholds.classify(1, 0), ThresholdDecision::Critical);
    }

    #[test]
    fn threshold_configurable_ratios_change_decision() {
        use super::compaction::{CompactionThresholds, ThresholdDecision};
        let window = 100_000u64;
        // 70% / 90% 自定义双阈值
        let custom = CompactionThresholds {
            regular_ratio: 0.70,
            critical_ratio: 0.90,
        };
        assert_eq!(custom.classify(60_000, window), ThresholdDecision::UnderBudget);
        assert_eq!(custom.classify(80_000, window), ThresholdDecision::Regular);
        assert_eq!(custom.classify(95_000, window), ThresholdDecision::Critical);
        // 默认阈值下 80% 是常规线触发；改阈值键（配置化）后行为变化
        assert_eq!(
            CompactionThresholds::default().classify(80_000, window),
            ThresholdDecision::UnderBudget
        );
        // 钳制：临界线低于常规线 → 钳到常规线
        let clamped = CompactionThresholds {
            regular_ratio: 0.85,
            critical_ratio: 0.5,
        };
        assert_eq!(clamped.normalized().critical_ratio, 0.85);
    }

    /// 临界线 = 同步硬压缩：走确定性占位符路径（无 AI 摘要器），
    /// 保 API 调用不失败（02 Top 4 / 04 C9）
    #[test]
    fn critical_line_hard_compression_deterministic_placeholder() {
        use super::compaction::{CompactionThresholds, ThresholdDecision};
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-04T10:00:00.000Z", vec![text_block("system")], None),
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:01.000Z", vec![text_block(&"长".repeat(200))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:02.000Z", vec![text_block(&"长".repeat(200))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-04T10:00:03.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-04T10:00:04.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        // 95% 临界线触发
        let window = 1_000u64;
        let estimate = 960u64;
        assert_eq!(
            CompactionThresholds::default().classify(estimate, window),
            ThresholdDecision::Critical
        );
        // 临界线路径 = 确定性压缩（summarizer=None → 中性 stub，不依赖 AI）
        let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
        assert!(!plan.summary_is_llm);
        assert_eq!(
            plan.summary,
            "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]"
        );
        assert!(plan.tokens_after < plan.tokens_before);
    }

    /// 常规线 = AI 摘要路径：mock 摘要器（provider 通道）产出 Schema V1
    /// JSON 文档 → md 渲染进链（R-G 场景 A）；被压缩段落不删除
    /// （原消息仍在 dropped_ids 可查）
    #[test]
    fn regular_line_ai_summary_document_into_conversation() {
        use super::compaction::{CompactionThresholds, ThresholdDecision};
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:00.000Z", vec![text_block(&"长".repeat(200))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:01.000Z", vec![text_block(&"长".repeat(200))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-04T10:00:02.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-04T10:00:03.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages[2]) + count_agent_message_tokens(&messages[3]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        // 常规线触发
        assert_eq!(
            CompactionThresholds::default().classify(900, 1_000),
            ThresholdDecision::Regular
        );
        struct AiSummarizer;
        impl Summarizer for AiSummarizer {
            fn summarize(
                &self,
                _dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                Ok(summary_doc_json("压缩升级"))
            }
        }
        let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&AiSummarizer));
        // AI 摘要标志 + Schema V1 文档 md 渲染进链
        assert!(plan.summary_is_llm);
        assert!(plan.summary.contains("## Goal"));
        assert!(plan.summary.contains("压缩升级"));
        // 压缩文档入对话（摘要消息在保留段前）
        let summary_msg = plan
            .messages
            .iter()
            .find(|m| m.id.starts_with("compacted-summary"))
            .expect("摘要消息须入对话");
        assert_eq!(summary_msg.text(), plan.summary);
        // metadata 快照：LLM 成功 → committed
        assert_eq!(summary_msg.metadata.as_ref().unwrap()["summary"]["state"], "committed");
        // 被压缩段落可查（不删除数据：dropped_ids 保留原消息 id）
        assert_eq!(plan.dropped_ids, vec!["u1", "a1"]);
        assert!(plan.tokens_after < plan.tokens_before);
    }

    /// system 永不压缩（AI 摘要路径复验）：system 消息不进入丢弃列表、
    /// 不进摘要文本、恒在输出最前（04 C9 第 5 条 + M1 注入段保留语义）
    #[test]
    fn system_never_compressed_on_ai_path() {
        let engine = CompactionEngine::new(0);
        let injected = "## Agent 定义\nagent-body";
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-04T10:00:00.000Z", vec![text_block(injected)], None),
            amsg("u1", AgentMessageRole::User, "2026-08-04T10:00:01.000Z", vec![text_block(&"长".repeat(200))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-04T10:00:02.000Z", vec![text_block(&"长".repeat(200))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-04T10:00:03.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-04T10:00:04.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages[3]) + count_agent_message_tokens(&messages[4]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        struct AiSummarizer;
        impl Summarizer for AiSummarizer {
            fn summarize(
                &self,
                _dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                Ok(summary_doc_json("x"))
            }
        }
        let plan = engine.compact_agent_messages(&messages, 5, &policy, Some(&AiSummarizer));
        assert_eq!(plan.messages[0].id, "s1", "system 恒在输出最前");
        assert_eq!(plan.messages[0].text(), injected, "注入段字节原样保留");
        assert!(!plan.dropped_ids.iter().any(|id| id == "s1"));
        assert!(!plan.summary.contains("## Agent 定义"));
    }

    #[test]
    fn threshold_defaults_matched() {
        use super::compaction::CompactionThresholds;
        let thresholds = CompactionThresholds::default();
        assert_eq!(thresholds.regular_ratio, super::COMPACT_THRESHOLD_RATIO_DEFAULT);
        assert_eq!(thresholds.critical_ratio, super::COMPACT_CRITICAL_RATIO_DEFAULT);
        assert_eq!(super::COMPACT_THRESHOLD_RATIO_DEFAULT, 0.85);
        assert_eq!(super::COMPACT_CRITICAL_RATIO_DEFAULT, 0.95);
    }

    // ── 折叠链（00-plan §4：B1-B4 不变量钉死；T-01~T-10 / T-13）──

    /// Schema V1 合法摘要文档（Summarizer 成功路径返回；R-G 场景 A）
    fn summary_doc_json(goal: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "blockId": "unused",
            "generation": 1,
            "droppedIds": [],
            "height": 1,
            "tier": "chunk",
            "goal": goal,
            "constraints": [],
            "progress": [],
            "decisions": [],
            "nextSteps": [],
            "criticalContext": "",
        })
        .to_string()
    }

    /// 首压会话（system + 两个长回合；尾部 u2/a2 恰好可作保留段）
    fn first_compaction_fixture() -> (CompactionEngine, Vec<Arc<AgentMessage>>) {
        let engine = CompactionEngine::new(0);
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system prompt")], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:01.000Z", vec![text_block(&"long user one".repeat(50))], None),
            amsg("a1", AgentMessageRole::Assistant, "2026-08-03T10:00:02.000Z", vec![text_block(&"long asst one".repeat(50))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block("recent user")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:04.000Z", vec![text_block("recent asst")], None),
        ];
        (engine, messages)
    }

    /// 预算策略：保留尾部两条的 token 量（切割点 = len - 2）
    fn tail_keep_policy(conversation: &[Arc<AgentMessage>], turns: u32) -> CompactionPolicy {
        let len = conversation.len();
        let keep = count_agent_message_tokens(&conversation[len - 2])
            + count_agent_message_tokens(&conversation[len - 1]);
        CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: turns,
            ..CompactionPolicy::default()
        }
    }

    /// 追加一个长回合（保证二次压缩超预算）
    fn push_long_turn(conversation: &mut Vec<Arc<AgentMessage>>, id: &str) {
        conversation.push(amsg(
            &format!("u{id}"),
            AgentMessageRole::User,
            "2026-08-03T11:00:00.000Z",
            vec![text_block(&"long appended user".repeat(50))],
            None,
        ));
        conversation.push(amsg(
            &format!("a{id}"),
            AgentMessageRole::Assistant,
            "2026-08-03T11:00:01.000Z",
            vec![text_block(&"long appended asst".repeat(50))],
            None,
        ));
    }

    /// B1 冻结（测试 1）：二次压缩后链消息逐字节相同（id/正文/metadata）
    #[test]
    fn fold_chain_is_frozen_across_compactions() {
        let (engine, messages) = first_compaction_fixture();
        let policy = tail_keep_policy(&messages, 1);
        let first = engine.compact_agent_messages(&messages, 30, &policy, None);
        let chain_msg = first
            .messages
            .iter()
            .find(|m| m.id.starts_with("compacted-summary"))
            .expect("首压必须产出链消息");
        let chain_bytes = serde_json::to_string(&**chain_msg).expect("链消息可序列化");
        // 追加新回合 → 二次压缩
        let mut conversation = first.messages.clone();
        push_long_turn(&mut conversation, "3");
        let policy = tail_keep_policy(&conversation, 1);
        let second = engine.compact_agent_messages(&conversation, 30, &policy, None);
        // 链只增：2 条链消息，id 随 fold 递增
        let chain_ids: Vec<&str> = second
            .messages
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(chain_ids, vec!["compacted-summary-1-1", "compacted-summary-1-2"]);
        // B1：旧链消息逐字节相同（序列化全量 = wire 面字节语义）
        let preserved = second
            .messages
            .iter()
            .find(|m| m.id == chain_msg.id)
            .expect("旧链消息必须保留");
        assert_eq!(
            serde_json::to_string(&**preserved).expect("链消息可序列化"),
            chain_bytes,
            "B1 冻结：链消息逐字节相同"
        );
        // 形状：system → 链全查 → 新摘要 → 保留段
        assert_eq!(second.messages[0].id, "s1");
        assert_eq!(second.first_kept_message_id.as_deref(), Some("u3"));
        // 二次压缩丢弃的只是链尾新增区（u2/a2），链不动
        assert_eq!(second.dropped_ids, vec!["u2", "a2"]);
    }

    /// B2 单调（测试 2）：多轮压缩 first_kept 单调前进，cut 永不越过链尾
    #[test]
    fn cut_never_below_fold_start() {
        let (engine, messages) = first_compaction_fixture();
        let mut conversation = messages;
        let mut prev_first_kept: Option<String> = None;
        for round in 0..3 {
            let policy = tail_keep_policy(&conversation, 1);
            let plan = engine.compact_agent_messages(&conversation, 30, &policy, None);
            let Some(first_kept) = &plan.first_kept_message_id else {
                panic!("第 {round} 轮压缩必须产生切割点");
            };
            if let Some(prev) = &prev_first_kept {
                let prev_idx = conversation
                    .iter()
                    .position(|m| m.id == *prev)
                    .expect("旧保留点仍在对话");
                let new_idx = conversation
                    .iter()
                    .position(|m| m.id == *first_kept)
                    .expect("新保留点在对话");
                assert!(
                    new_idx >= prev_idx,
                    "B2 单调：cut 不后退（{prev} @ {prev_idx} → {first_kept} @ {new_idx}）"
                );
            }
            prev_first_kept = Some(first_kept.clone());
            // 保留点恒位于链后（链 = system 后连续 compacted-summary 段）
            let chain_count = plan
                .messages
                .iter()
                .filter(|m| m.id.starts_with("compacted-summary"))
                .count();
            let fk_idx = plan
                .messages
                .iter()
                .position(|m| m.id == *first_kept)
                .expect("first_kept 在结果中");
            assert!(fk_idx >= chain_count, "first_kept 必须位于链后");
            // 追加新回合进入下一轮
            conversation = plan.messages.clone();
            push_long_turn(&mut conversation, &round.to_string());
        }
    }

    /// B2 预算扫描自链后起算（测试 3）：链 token 不计入预算扫描，
    /// 链永不进保留区（切割点恒 > fold_start）
    #[test]
    fn budget_scan_starts_after_chain() {
        let engine = CompactionEngine::new(0);
        // 链消息本身远超预算 → 切割点仍必须落在链后（fold_start = 2）
        let messages = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system")], None),
            amsg("compacted-summary-1-1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block(&"chain token".repeat(4000))], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block(&"long".repeat(200))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![text_block(&"long".repeat(200))], None),
        ];
        let policy = CompactionPolicy {
            keep_recent_tokens: 10,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages, 5, &policy, None);
        assert_eq!(plan.first_kept_message_id.as_deref(), Some("u2"));
        assert_eq!(plan.dropped_ids, vec!["u1"], "链永不入 dropped");
        // 链 + system 原样保留在头部，新摘要接在链尾
        let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["s1", "compacted-summary-1-1", "compacted-summary-1-2", "u2"]);
    }

    /// B2 tool 配对回扫钳制到链（测试 4）：孤儿 call 位于链内 → 保守放弃；
    /// 链后正常回扫仍生效且链不进保留区
    #[test]
    fn tool_pair_protection_clamps_to_chain() {
        let engine = CompactionEngine::new(0);
        // 场景 A：孤儿 result(t1) 的 call 位于链内（fold_start 处）→ 放弃压缩
        let messages_a = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system")], None),
            amsg("compacted-summary-1-1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![tool_call_block("t1", "read_file", serde_json::json!({}))], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![tool_result_block("t1", "read_file", "orphan")], None),
            amsg("u3", AgentMessageRole::User, "2026-08-03T10:00:04.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:05.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages_a[3])
            + count_agent_message_tokens(&messages_a[4])
            + count_agent_message_tokens(&messages_a[5]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages_a, 5, &policy, None);
        assert!(plan.dropped_ids.is_empty(), "孤儿 call 在链内 → 保守放弃压缩");
        assert_eq!(plan.messages.len(), messages_a.len(), "原样返回");
        // 场景 B：call 位于链后（u1）→ 回扫正常扩展，链不进保留区
        let messages_b = vec![
            amsg("s1", AgentMessageRole::System, "2026-08-03T10:00:00.000Z", vec![text_block("system")], None),
            amsg("compacted-summary-1-1", AgentMessageRole::Assistant, "2026-08-03T10:00:01.000Z", vec![text_block("chain stub")], None),
            amsg("u0", AgentMessageRole::User, "2026-08-03T10:00:02.000Z", vec![text_block(&"long".repeat(100))], None),
            amsg("u1", AgentMessageRole::User, "2026-08-03T10:00:03.000Z", vec![tool_call_block("t1", "read_file", serde_json::json!({}))], None),
            amsg("u2", AgentMessageRole::User, "2026-08-03T10:00:04.000Z", vec![tool_result_block("t1", "read_file", "result")], None),
            amsg("u3", AgentMessageRole::User, "2026-08-03T10:00:05.000Z", vec![text_block("keep")], None),
            amsg("a2", AgentMessageRole::Assistant, "2026-08-03T10:00:06.000Z", vec![text_block("keep")], None),
        ];
        let keep = count_agent_message_tokens(&messages_b[4])
            + count_agent_message_tokens(&messages_b[5])
            + count_agent_message_tokens(&messages_b[6]);
        let policy = CompactionPolicy {
            keep_recent_tokens: keep,
            min_recent_turns: 1,
            ..CompactionPolicy::default()
        };
        let plan = engine.compact_agent_messages(&messages_b, 5, &policy, None);
        assert_eq!(plan.dropped_ids, vec!["u0"], "仅 u0 被丢弃");
        let ids: Vec<&str> = plan.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["s1", "compacted-summary-1-1", "compacted-summary-1-2", "u1", "u2", "u3", "a2"],
            "链恒在头部，tool 对一起保留，新摘要接链尾"
        );
        assert_eq!(plan.first_kept_message_id.as_deref(), Some("u1"));
    }

    /// B3 只增（测试 5）：摘要 id 随 fold 递增且 generation 段格式正确
    #[test]
    fn summary_ids_increase_with_fold() {
        let (engine, messages) = first_compaction_fixture();
        let mut conversation = messages;
        for round in 1..=3 {
            let policy = tail_keep_policy(&conversation, 1);
            let plan = engine.compact_agent_messages(&conversation, 30, &policy, None);
            // 折叠字段与链长一致
            assert_eq!(plan.fold_chain_prev, round - 1);
            assert_eq!(plan.fold_chain_after, round);
            assert_eq!(plan.fold_index, round);
            assert_eq!(plan.generation, 1, "本轮引擎侧占位代数");
            // 新链消息 id = compacted-summary-{generation}-{fold_index}（R-B）
            let new_summary = plan
                .messages
                .iter()
                .rfind(|m| m.id.starts_with("compacted-summary"))
                .expect("链须新增一条");
            assert_eq!(new_summary.id, format!("compacted-summary-1-{round}"));
            assert_eq!(
                plan.messages
                    .iter()
                    .filter(|m| m.id.starts_with("compacted-summary"))
                    .count(),
                round,
                "链只增（B3）"
            );
            // 进入下一轮
            conversation = plan.messages.clone();
            push_long_turn(&mut conversation, &round.to_string());
        }
    }

    /// B1（测试 6）：链消息永不进 dropped_ids（T-06）
    #[test]
    fn chain_never_in_dropped_ids() {
        let (engine, messages) = first_compaction_fixture();
        let policy = tail_keep_policy(&messages, 1);
        let first = engine.compact_agent_messages(&messages, 30, &policy, None);
        assert!(
            first.dropped_ids.iter().all(|id| !id.starts_with("compacted-summary")),
            "首压 dropped 不得含链消息"
        );
        // 二次压缩：链作为前缀存在
        let mut conversation = first.messages.clone();
        push_long_turn(&mut conversation, "3");
        let policy = tail_keep_policy(&conversation, 1);
        let second = engine.compact_agent_messages(&conversation, 30, &policy, None);
        assert!(
            second.dropped_ids.iter().all(|id| !id.starts_with("compacted-summary")),
            "二次压缩 dropped 不得含链消息"
        );
        assert_eq!(second.dropped_ids, vec!["u2", "a2"]);
        assert_eq!(
            second.messages.iter().filter(|m| m.id.starts_with("compacted-summary")).count(),
            2,
            "链全保留"
        );
    }

    /// T-13 stub 确定性 + 中性（测试 9）：同输入同输出；无"生成中"措辞；
    /// metadata awaiting 快照；预算截断确定性
    #[test]
    fn stub_is_deterministic_and_neutral() {
        let (engine, messages) = first_compaction_fixture();
        let policy = tail_keep_policy(&messages, 1);
        let first = engine.compact_agent_messages(&messages, 30, &policy, None);
        let second = engine.compact_agent_messages(&messages, 30, &policy, None);
        assert_eq!(first.summary, second.summary, "stub 确定性：同输入同输出");
        let stub = &first.summary;
        assert!(stub.starts_with("[Compacted("), "stub 前缀：{stub}");
        assert!(!stub.contains("生成中"), "中性措辞：无「生成中」");
        assert!(!stub.contains("generating"), "中性措辞：无 generating");
        assert!(!stub.contains("失败"), "中性措辞：无失败");
        // metadata 快照（机器可读优先，R-C：awaiting 永驻）
        let summary_msg = first
            .messages
            .iter()
            .find(|m| m.id.starts_with("compacted-summary"))
            .expect("stub 消息须入对话");
        let meta = summary_msg.metadata.as_ref().expect("stub 消息须带 metadata 快照");
        assert_eq!(meta["summary"]["blockId"], "compacted-summary-1-1");
        assert_eq!(meta["summary"]["state"], "awaiting");
        assert_eq!(meta["summary"]["height"], 1);
        assert_eq!(meta["summary"]["generation"], 1);
        assert_eq!(meta["summary"]["droppedIds"], serde_json::json!(["u1", "a1"]));
        // 预算截断仍确定性（max_summary_tokens=1 → 省略号）
        let tiny = CompactionPolicy {
            max_summary_tokens: 1,
            ..policy
        };
        let plan = engine.compact_agent_messages(&messages, 30, &tiny, None);
        assert_eq!(plan.summary, "…");
        assert_eq!(
            plan.summary,
            engine.compact_agent_messages(&messages, 30, &tiny, None).summary,
            "截断后依然确定性"
        );
    }
}
