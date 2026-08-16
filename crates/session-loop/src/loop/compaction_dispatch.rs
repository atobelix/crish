//! 压缩编排面（C1a 纯结构搬移 · 详案-C1-核心循环瘦身.md C1a 段）
//!
//! 自 `loop/handlers/mod.rs` 平移的压缩触发编排面（原 :270-885）：
//! 预算钳制（[clamp_max_tokens]）/ 上下文估算（[estimate_context]）/
//! 阈值预检（[maybe_compact_preflight]）/ 用户消息边界压缩（
//! [maybe_compact_user_boundary]）/ LLM 摘要守卫（[compact_with_llm_guard]）/
//! 摘要待重试（[maybe_retry_pending_summary]）/ 压缩执行（[apply_compaction]）/
//! 事件辅助（[compression_reason_str] / [policy_tier_for]）。
//!
//! 纪律（对齐 07 §6.3-4「只搬移不改行为」）：逐函数平移，**不改语义 /
//! 函数签名 / 字段名**；`conex-compaction` 算法面（CompactionEngine /
//! Summarizer / CompactionPolicy）不动；协议护栏函数（compaction_shape_ok
//! 等）保留在 handlers/mod.rs 原位，本 mod 经 `super::handlers` 引用；
//! handlers/mod.rs 经 `pub(crate) use` 保留既有调用面（消费点零改动）。
//! LoopState 外围字段收敛（CompactionRuntime / BudgetState 子结构）归
//! C1c（详案 §3.3：先搬移才有「缝的形状」），本轮只搬不拆。
use std::sync::Arc;

use conex_compaction::compaction::StubPolicy;
use conex_compaction::{CompactionEngine, CompactionPlan, EstimateContext};
use conex_types::context::ContextBudget;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageRole};
use conex_types::tool::{
    compaction_block_details, ContextCompressionCacheBoundaryMetadata,
    ContextCompressionPolicyAction, ContextCompressionPolicyMetadata, ContextCompressionPolicyTier,
    ContextCompressionReason, ContextCompressionRecord, ContextCompressionTrigger,
};

use super::handlers::{compaction_shape_ok, new_message_id, streaming, LoopState};

// ── P4 预算层（阶段 2-2/2-3）：估算 + 钳制 ─────────────────────────────

/// 钳制下限：可用输出预算低于该值时不再钳制（把输出压到不可用值只会
/// 制造垃圾重试，保持 requested 并记录，P4 阶段 2-3 下限保护）
pub(crate) const CLAMP_MIN_AVAILABLE: u32 = 256;

/// max_tokens 钳制纯函数（P4 §3.3.2，对齐 pi simple-options.ts:12-19：
/// `clamp = window - estimate - safety`）
///
/// - `estimate` 为上下文占用估算（C9 口径 `input_total`，含缓存读/写）；
/// - 可用预算 = window - estimate - safety；低于 [CLAMP_MIN_AVAILABLE] 时
///   **不钳制只记录**（返回 requested 原值）；
/// - 正常路径 `requested.min(available).max(1)`（MIN_MAX_TOKENS = 1：
///   最小输出不为 0，P4 §3.3.2）。
pub(crate) fn clamp_max_tokens(requested: u32, estimate: u64, budget: &ContextBudget) -> u32 {
    let available = budget
        .context_window
        .saturating_sub(estimate.min(u64::from(u32::MAX)) as u32)
        .saturating_sub(budget.safety_tokens);
    if available < CLAMP_MIN_AVAILABLE {
        tracing::info!(
            requested,
            estimate,
            available,
            context_window = budget.context_window,
            "预算钳制跳过：可用输出预算低于下限（不钳只记录）"
        );
        return requested;
    }
    requested.min(available).max(1)
}

/// 估算上下文占用（P4 §3.3.1 双源：usage 优先 + 启发式兜底）。
///
/// - **usage 源**：从对话末尾向前找最近一条仍描述当前前缀的 assistant
///   消息的 `metadata.cacheBreakdown.inputTotal`（C9 归一化口径，I6；
///   Included 系 prompt、Excluded 系 prompt+read+write 已由适配层折算），
///   其后尾随消息按块级启发式补算；
/// - **时间戳护栏**：usage 源消息时间戳早于 `last_compaction_at`（压缩
///   边界）时该 usage 作废回退启发式（判定在 conex-compaction 引擎内部
///   完成，§3.4.6）；
/// - **启发式兜底**：全部消息块级估算 + system / tools 前缀折算
///   （工具 schema 整体 JSON 体积，P4 §3.3.1 源 2）。
pub(crate) fn estimate_context(state: &LoopState) -> EstimateContext {
    let engine = CompactionEngine::new(0);
    engine.estimate_context_tokens(
        &state.conversation,
        tools_prefix_json(state).as_deref(),
        state.options.system_prompt.as_deref(),
        state.last_compaction_at,
    )
}

/// 工具前缀折算输入（P4 §3.3.1 源 2：工具 schema 整体 JSON 体积折算；
/// 快照未构建时返回 None——调用前必须已执行 ensure_tools_snapshot）
fn tools_prefix_json(state: &LoopState) -> Option<String> {
    let tools = state.tools_snapshot.as_deref()?;
    let value: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name.clone(),
                "description": t.description.clone(),
                "input_schema": t.input_schema.clone(),
            })
        })
        .collect();
    serde_json::to_string(&value).ok()
}

// ── P4 压缩层（阶段 3-2/3-3）：预检触发 + 应用 + 事件广播 ─────────────

/// 压缩触发信息（预检阈值 / 溢出恢复共用；T-34 溢出压缩阶梯复用本类型，
/// stream_error.rs 以 trigger=Overflow 调用 [apply_compaction]）
pub(crate) struct CompactionTriggerInfo {
    /// 事件记录触发点（threshold / overflow / …）
    pub(crate) trigger: ContextCompressionTrigger,
    /// 事件记录原因（threshold / overflow / …）
    pub(crate) reason: ContextCompressionReason,
}

/// E2 F3：摘要待重试快照（用户消息边界被动触发点素材）。
///
/// 与后台摘要任务（[SummaryDispatchTask]）同一入参源——[apply_compaction]
/// 产出 stub 时记录；被动触发时若对话中仍存在该块 stub 消息则重建任务
/// 经协调器 / 调度器单飞触发（存活去重由协调器保证，重复触发幂等）。
#[derive(Clone)]
pub(crate) struct PendingSummaryRetry {
    /// 块 id（`compacted-summary-{gen}-{fold}`，与链内摘要消息 id 同名）
    pub(crate) block_id: String,
    /// 压缩代数（R-K 单源）
    pub(crate) generation: u32,
    /// 丢弃消息（与同步尝试同源——重试同一批）
    pub(crate) dropped: Vec<conex_types::message::AgentMessage>,
    /// 既有摘要文本（链尾 stub / md 渲染；与同步尝试同源）
    pub(crate) existing: Option<String>,
    /// 摘要字节预算（max_summary_tokens × 4）
    pub(crate) max_bytes: usize,
}

/// 阈值预检触发（P4 阶段 3-2 / §3.4.1 触发点 1，prepare_turn 步骤 5）。
///
/// 条件（全部满足才压缩）：
///
/// 1. 预算与压缩策略均已配置（None = 向后兼容现状，不预检）；
/// 2. `estimate ≥ window - reserve`（对齐 pi threshold = window - reserve，
///    估算 = [estimate_context] 双源结果，C9 口径）；
/// 3. 本 run 压缩次数未达上限（[SessionLoopOptions::max_auto_compactions_per_run]，
///    单 run 护栏，仅约束预检/边界/分阶段——E2 F2 层 2 后溢出绕开本计数）。
///
/// 压缩动作（LLM 摘要强制 / 切割点 / 形状护栏见 [compact_with_llm_guard]）。
///
/// 模型切换护栏（§3.4.6）依赖壳层注入的生效模型 id（LoopState 无模型
/// 字段，P3 模型目录接线后由壳层在会话级比对），本层预留不实现。
///
/// 返回是否实际发生了压缩（对话被替换 + 事件已广播）。
pub(crate) async fn maybe_compact_preflight(state: &mut LoopState) -> bool {
    let Some(budget) = state.budget else {
        return false;
    };
    let Some(policy) = state.compaction_policy.clone() else {
        return false;
    };
    if state.compactions_this_run >= state.options.max_auto_compactions_per_run {
        return false;
    }
    // 快照锁定（与 streaming 同一入口；预检发生在首次 build_request 之前，
    // 快照必须已构建才能折算 tools 前缀）
    streaming::ensure_tools_snapshot(state);
    let estimate = estimate_context(state);
    let budget_tokens = budget.context_window.saturating_sub(budget.reserve_tokens);
    let engine = CompactionEngine::new(0);
    if !engine.should_compact(estimate.tokens, u64::from(budget_tokens)) {
        return false;
    }
    let info = CompactionTriggerInfo {
        trigger: ContextCompressionTrigger::Threshold,
        reason: ContextCompressionReason::Threshold,
    };
    compact_with_llm_guard(state, budget_tokens, &policy, &info).await
}

/// E2 F3：用户消息边界压缩（hold → compact → append，07 方案 §2.1）。
///
/// prepare_turn 步骤 2 在用户消息 [record_message] **之前**调用——压缩对
/// hold 消息透明：估算（[estimate_context]）不含 hold 消息（更保守、更早
/// 触发），切割点恒在 hold 之前，用户消息 100% 保留、必在发送序列尾部
/// （kept_ids 中绝不在 dropped_ids）。
///
/// 条件（与预检 [maybe_compact_preflight] 同口径，trigger=UserMessage）：
///
/// 1. 预算与压缩策略均已配置（None = 向后兼容现状，不触发）；
/// 2. `estimate ≥ window - reserve` **或存在待重试摘要块**（awaiting/retired
///    stub，07 §2.1 条件 1 OR——被动补摘要，不阻塞发送）；
/// 3. 本 run 压缩次数未达上限（与预检共享单 run 计数——边界压缩后预检
///    因计数封顶自然跳过；边界未压缩不消耗计数，预检可再试；计数封顶
///    只跳过压缩，被动补摘要 [maybe_retry_pending_summary] 不受约束）；
/// 4. LLM 摘要强制（同预检 stub_policy；不可用 → 发
///    runtime-intervention-required 事件，消息照常发送、不消耗计数）。
///
/// 压缩动作：对「不含 hold 消息」的对话 compact_agent_messages
/// （budget = window - reserve）→ [apply_compaction]（trigger=UserMessage，
/// 摘要同步一次 + 失败后台重试）。压缩后（或未压缩时）执行边界被动摘要
/// 重试 [maybe_retry_pending_summary]。
///
/// 返回是否实际发生了压缩（对话被替换 + 事件已广播）。
pub(crate) async fn maybe_compact_user_boundary(state: &mut LoopState) -> bool {
    let Some(budget) = state.budget else {
        return false;
    };
    let Some(policy) = state.compaction_policy.clone() else {
        return false;
    };
    // 快照锁定（与预检同一入口；估算需折算 tools 前缀）
    streaming::ensure_tools_snapshot(state);
    let estimate = estimate_context(state);
    let budget_tokens = budget.context_window.saturating_sub(budget.reserve_tokens);
    let engine = CompactionEngine::new(0);
    let over_threshold = engine.should_compact(estimate.tokens, u64::from(budget_tokens));
    if !over_threshold {
        // 未超阈值 → 不压缩（不消耗计数）；仍执行被动摘要重试
        // （待重试块存在时补摘要，不阻塞发送）
        maybe_retry_pending_summary(state);
        return false;
    }
    if state.compactions_this_run >= state.options.max_auto_compactions_per_run {
        // 计数封顶 → 不压缩（与预检共享单 run 计数，边界压缩后预检自然
        // 跳过）；被动补摘要**不受压缩计数约束**（不压缩对话、不消耗
        // 计数——仅补摘要的被动触发面）
        maybe_retry_pending_summary(state);
        return false;
    }
    let info = CompactionTriggerInfo {
        trigger: ContextCompressionTrigger::UserMessage,
        reason: ContextCompressionReason::UserMessage,
    };
    let compacted = compact_with_llm_guard(state, budget_tokens, &policy, &info).await;
    // 压缩后执行被动摘要重试：压缩成功但摘要同步失败（新 stub 已登记
    // 后台任务，单飞去重）或压缩前存在待重试块 → 补摘要机会点
    maybe_retry_pending_summary(state);
    compacted
}

/// 共享压缩执行（预检 / 用户消息边界共用；E2 F1 L1 门禁集中面）。
///
/// - **LLM 摘要强制（E2 F1 L1/L3）**：豁免（compact_allow_stub_fallback /
///   !compact_require_llm 任一放行）→ StubAllowed 降级 stub（现状语义）；
///   默认 LlmRequired → 无 Summarizer/摘要失败不落 stub、等待 LLM 可用
///   （不压缩、不计数，发 runtime-intervention-required 事件提示；预算
///   钳制兜底仍在 streaming 面生效）。
/// - **无合法切割点**：dropped_ids 为空 → 放弃压缩（不广播、不计数）。
/// - **协议形状护栏（T-36）**：压缩产物无 system 且链后首条非 user →
///   跳过压缩 + warn。
/// - 通过全部护栏 → [apply_compaction]（唯一前缀重写点 + 计数 + Start/End
///   事件）。
///
/// 返回是否实际发生了压缩。
pub(crate) async fn compact_with_llm_guard(
    state: &mut LoopState,
    budget_tokens: u32,
    policy: &conex_compaction::CompactionPolicy,
    info: &CompactionTriggerInfo,
) -> bool {
    let stub_policy =
        if state.options.compact_allow_stub_fallback || !state.options.compact_require_llm {
            StubPolicy::StubAllowed
        } else {
            StubPolicy::LlmRequired
        };
    let engine = CompactionEngine::new(0);
    let plan = engine.compact_agent_messages_with_stub_policy(
        &state.conversation,
        budget_tokens as usize,
        policy,
        state.summarizer.as_deref(),
        stub_policy,
    );
    if plan.llm_unavailable {
        // E2 F1 L1：Summarizer 缺失 / 摘要失败且 LLM 强制 → 不压缩、等待
        // LLM 可用（不产生 stub、不计数——本路径不消耗单 run 上限，预算
        // 钳制兜底仍在 streaming 面生效）；发 runtime-intervention-required
        // 事件提示（信息分级约束 C：事件面呈现，不进对话、不给 AI）
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            trigger = ?info.trigger,
            "压缩因 LLM 摘要不可用而跳过（等待 LLM 可用；compact_allow_stub_fallback=true 可豁免为 stub）"
        );
        state.events.push(AgentEvent::RuntimeInterventionRequired {
            session_id: state.machine.context().session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            reason: "LLM 摘要不可用，压缩等待 LLM 可用".to_string(),
            choices: vec!["等待 LLM 摘要可用后自动压缩".to_string()],
            message:
                "上下文已超窗但 LLM 摘要不可用——未压缩（禁止纯丢弃式线性压缩），等待 LLM 可用后重试"
                    .to_string(),
        });
        return false;
    }
    if plan.dropped_ids.is_empty() {
        // 放弃压缩（无合法切割点 / 无可丢内容）：不广播、不计数
        return false;
    }
    // T-36 引擎兜底（评审 02 P1-7）：压缩产物的协议形状护栏——无 system
    // 且链后首条非 user → 跳过压缩 + warn（压缩后 wire 首条 = assistant/
    // tool → provider 400 风险；轮次 1 cut<=fold_start 不覆盖本形状）
    if !compaction_shape_ok(&plan.messages) {
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            trigger = ?info.trigger,
            "压缩产物协议形状违规（无 system 且链后首条非 user）→ 跳过压缩（T-36 护栏）"
        );
        return false;
    }
    apply_compaction(state, &plan, info, Some(u64::from(budget_tokens))).await;
    true
}

/// E2 F3：用户消息边界被动摘要重试（07 §2.4 断言 4；F2 层 1 低功耗模式
/// 的被动触发点，卡 A 提供触发面）。
///
/// 判定：存在待重试快照（最近一次压缩产出 stub）&& 对话中仍存在该块
/// stub 消息（块未升级替换 / 清理）&& Summarizer 可用 → 重建
/// [SummaryDispatchTask] 经会话级协调器（try_trigger：单飞 + 全局 ≤2，
/// summary_coordinator.rs:40 不变）或 run 级 dispatch（try_spawn）触发。
///
/// 不阻塞发送、不消耗压缩计数；存活任务去重由协调器 / 调度器保证——
/// 重复触发幂等（摘要成功升级 committed 由后台任务回调面完成）。
fn maybe_retry_pending_summary(state: &mut LoopState) {
    let Some(pending) = state.pending_summary_retry.clone() else {
        return;
    };
    // 块已不在对话（摘要成功替换 / 清理）→ 不再待重试
    if !state.conversation.iter().any(|m| m.id == pending.block_id) {
        return;
    }
    let Some(summarizer) = state.summarizer.clone() else {
        return;
    };
    let task = crate::r#loop::summary_dispatch::SummaryDispatchTask {
        session_id: state.machine.context().session_id.clone(),
        block_id: pending.block_id,
        generation: pending.generation,
        dropped: pending.dropped,
        existing: pending.existing,
        max_bytes: pending.max_bytes,
        summarizer,
    };
    match &state.summary_coordinator {
        // 会话级协调器（壳层注入）：跨 run 单飞 + 全局并发 ≤2 + 任务跨
        // run 存活；默认回调（落 compression_blocks 表）随协调器携带
        Some(coordinator) => {
            coordinator.try_trigger(task, None);
        }
        // run 级 dispatch（未注入会话级容器时）：run 内单飞
        None => {
            state.summary_dispatch.try_spawn(task, None);
        }
    }
}

/// 应用压缩计划：替换对话 + 压缩计数 + 时间戳护栏 + 事件广播（§3.4.6）。
///
/// - **对话替换**：压缩是唯一前缀重写点（I1，§3.6）——`plan.messages`
///   已保留 system 消息 + 摘要占位 + 保留段；
/// - **护栏**：`compactions_this_run += 1`（单 run 上限计数，仅约束预检/
///   边界/分阶段触发；溢出阶梯绕开，E2 F2 层 2）；压缩完成后重置
///   `last_compaction_at = now`（usage 源早于边界作废）；
/// - **事件**：`ContextCompressionStart`（tokens_before + 触发原因）→
///   替换对话 → `ContextCompressionEnd`（record 载荷 = CompactionPlan
///   字段，trigger/reason/policy/tokens/ids/summary/threshold）；
/// - **插件钩子**（I8-E1 第二批）：context.compact.start 在压缩动作前、
///   context.compact.end 在压缩收场后广播（同事件点位、同载荷语义）。
pub(crate) async fn apply_compaction(
    state: &mut LoopState,
    plan: &CompactionPlan,
    info: &CompactionTriggerInfo,
    threshold_tokens: Option<u64>,
) {
    let session_id = state.machine.context().session_id.clone();
    // I8-E1：context.compact.start 钩子广播（压缩域处理起点；trigger ←
    // reason、tokens_before ← tokensBefore；observe 默认，失败吞掉 + 计数）
    if let Some(hooks) = &state.options.hooks {
        let _ = hooks
            .dispatch(&crate::hooks::HookEvent::ContextCompactStart {
                session_id: session_id.clone(),
                trigger: compression_reason_str(info.reason).to_string(),
                tokens_before: plan.tokens_before,
            })
            .await;
    }
    // 时间戳护栏边界（epoch ms；与 usage 源消息时间戳同精度）
    let boundary_ms = crate::steering::unix_millis() as i64;
    // 摘要后台重试的丢弃消息（**对话替换前**捕获——plan 只携带 dropped
    // id，消息正文须取自压缩前对话，与同步尝试同源；T-32 任务入参）
    let dropped_for_retry: Vec<conex_types::message::AgentMessage> = plan
        .dropped_ids
        .iter()
        .filter_map(|id| {
            state
                .conversation
                .iter()
                .find(|m| &m.id == id)
                .map(|m| (**m).clone())
        })
        .collect();
    tracing::info!(
        tokens_before = plan.tokens_before,
        tokens_after = plan.tokens_after,
        dropped = plan.dropped_ids.len(),
        kept = plan.kept_ids.len(),
        "上下文压缩完成"
    );
    // Start 事件（压缩开始：触发原因 + 压缩前 token）
    state.emit_event(AgentEvent::ContextCompressionStart {
        session_id: session_id.clone(),
        timestamp: crate::steering::now_iso_utc(),
        reason: compression_reason_str(info.reason).to_string(),
        tokens_before: plan.tokens_before,
    });
    // 对话替换（压缩是唯一前缀重写点；plan 已保留 system 消息）
    state.conversation = plan.messages.clone();
    // 护栏：单 run 压缩计数 + 时间戳护栏重置（§3.4.6）
    state.compactions_this_run += 1;
    state.last_compaction_at = Some(boundary_ms);
    // 缓存审计基线重置（P5 S2 / T-36，C13）：压缩是唯一前缀重写点——
    // tracker 代数 +1、签名基线作废（压缩后是新内容非重放，不计 miss；
    // jcode KvCacheBaseline 双保险 / pi prev=undefined）。
    // T-31（00-plan §5.1 / 评审 02 P0-5、§3.3）追加两件事：
    // 1) R-K 单源：apply_external_generation(plan.generation) 用引擎/会话
    //    代数校准 tracker 内部自增（V2 由 SessionContextMeta 注入引擎）；
    // 2) capture_post_compaction：对话替换后捕获「压缩后真实请求前缀」
    //    预测签名（system + tools + 链全查 + tail 原文），供压缩后首请求
    //    前缀比对（record_usage 消费，T-29 追加区豁免）。
    if let Some(tracker) = &mut state.cache_tracker {
        tracker.on_compaction();
        tracker.apply_external_generation(plan.generation);
        let system = plan
            .messages
            .iter()
            .find(|m| m.role == AgentMessageRole::System)
            .map(|m| m.text());
        let tools: &[crate::provider::ToolSchema] =
            state.tools_snapshot.as_deref().unwrap_or_default();
        tracker.capture_post_compaction(system.as_deref(), tools, &plan.messages);
    }
    // T-31 块元数据推导（R-B：块 id = `compacted-summary-{gen}-{fold}`，
    // 与链内摘要消息 id 同名；prevBlockId = 链尾块——fold_chain_prev 为
    // 0（无既有链）时 None）
    let block_id = if plan.fold_index > 0 {
        format!("compacted-summary-{}-{}", plan.generation, plan.fold_index)
    } else {
        // 手动构造计划（测试/外围触发）无 fold 语义：回退取链内末条摘要
        // 消息 id；仍无 → 空串（正常路径不可达）
        plan.messages
            .iter()
            .rev()
            .find(|m| m.id.starts_with("compacted-summary"))
            .map(|m| m.id.clone())
            .unwrap_or_default()
    };
    let prev_block_id = if plan.fold_chain_prev > 0 {
        Some(format!(
            "compacted-summary-{}-{}",
            plan.generation, plan.fold_chain_prev
        ))
    } else {
        None
    };
    let summary_state = if plan.summary_is_llm {
        "committed"
    } else {
        "awaiting"
    };
    // 压缩后签名（system + 链哈希；链 = 链消息的投影签名——稳定前缀
    // 身份，评审 02 §3.1「链是前缀内的稳定区段」）
    let boundary_hash = {
        let system = plan
            .messages
            .iter()
            .find(|m| m.role == AgentMessageRole::System)
            .map(|m| m.text());
        let chain: Vec<Arc<AgentMessage>> = plan
            .messages
            .iter()
            .filter(|m| m.id.starts_with("compacted-summary"))
            .cloned()
            .collect();
        let sig = crate::cache_tracker::build_request_signature(system.as_deref(), &[], &chain);
        format!("{:016x}-{:016x}", sig.system_hash, sig.messages_hash)
    };
    // T-32 摘要后台触发登记（00-plan §6.4）：同步已失败（stub 产出）且
    // Summarizer 注入存在 → 登记后台退避重试任务（单飞；任务结果经回调
    // 移交壳层写库，V1 未接线回调时只落日志——见 summary_dispatch.rs
    // 架构决策）。丢弃消息已在对话替换前捕获（dropped_for_retry），
    // existing 取链尾文本（与同步尝试同源）。
    if !plan.summary_is_llm && !block_id.is_empty() && !dropped_for_retry.is_empty() {
        if let Some(summarizer) = &state.summarizer {
            let existing = plan
                .messages
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
            let max_bytes = state
                .compaction_policy
                .as_ref()
                .map(|p| p.max_summary_tokens.saturating_mul(4))
                .unwrap_or(4096);
            // E2 F3：记录摘要待重试快照（用户消息边界被动触发点素材，
            // 07 方案 §2.4 断言 4）——与后台任务同一入参源
            // （dropped/existing/max_bytes），边界触发经
            // [maybe_retry_pending_summary] 重建任务单飞续试
            state.pending_summary_retry = Some(PendingSummaryRetry {
                block_id: block_id.clone(),
                generation: plan.generation,
                dropped: dropped_for_retry.clone(),
                existing: existing.clone(),
                max_bytes,
            });
            let spawned = match &state.summary_coordinator {
                // T-42：会话级协调器（壳层注入）——跨 run 单飞 + 全局
                // 并发上限 + 任务跨 run 存活；默认回调（壳层装配：落
                // compression_blocks 表）随协调器携带
                Some(coordinator) => coordinator.try_trigger(
                    crate::r#loop::summary_dispatch::SummaryDispatchTask {
                        session_id: session_id.clone(),
                        block_id: block_id.clone(),
                        generation: plan.generation,
                        dropped: dropped_for_retry,
                        existing,
                        max_bytes,
                        summarizer: summarizer.clone(),
                    },
                    None,
                ),
                // 轮次 4 兜底：run 级 dispatch（未注入会话级容器时）
                None => state.summary_dispatch.try_spawn(
                    crate::r#loop::summary_dispatch::SummaryDispatchTask {
                        session_id: session_id.clone(),
                        block_id: block_id.clone(),
                        generation: plan.generation,
                        dropped: dropped_for_retry,
                        existing,
                        max_bytes,
                        summarizer: summarizer.clone(),
                    },
                    None,
                ),
            };
            if spawned {
                tracing::info!(
                    block_id = %block_id,
                    generation = plan.generation,
                    "摘要同步失败 → 后台退避重试任务已登记（单飞）"
                );
            }
        }
    }
    // End 事件（record 载荷 = CompactionPlan 字段，供 P5 消费展示；
    // cache_boundary / details 为 T-31 块元数据织入面——R-H：字段级
    // 扩展不新增事件类型）
    let record = ContextCompressionRecord {
        id: new_message_id("compaction"),
        trigger: info.trigger,
        reason: Some(info.reason),
        policy: Some(ContextCompressionPolicyMetadata {
            tier: policy_tier_for(info.trigger),
            action: ContextCompressionPolicyAction::Compact,
            forced: false,
            threshold_exceeded: true,
            provider_retry: false,
        }),
        summary: plan.summary.clone(),
        first_kept_message_id: plan.first_kept_message_id.clone(),
        compressed_message_ids: plan.dropped_ids.clone(),
        kept_message_ids: plan.kept_ids.clone(),
        tokens_before: plan.tokens_before,
        tokens_after: plan.tokens_after,
        threshold_tokens,
        created_at: crate::steering::now_iso_utc(),
        handoff: None,
        // 缓存边界（对齐 ContextCompressionCacheBoundaryMetadata；
        // structured_summary_* 为 V2 结构化摘要缓存域预留）
        cache_boundary: Some(ContextCompressionCacheBoundaryMetadata {
            kind: "context-compression-cache-boundary".to_string(),
            version: 1,
            stable_prefix_hash: boundary_hash,
            cache_key: String::new(),
            structured_summary_cache_key: String::new(),
            structured_summary_stable_hash: String::new(),
            invalidates: Vec::new(),
            invalidation_reason: info.reason,
            compressed_message_ids: plan.dropped_ids.clone(),
            kept_message_ids: plan.kept_ids.clone(),
            first_kept_message_id: plan.first_kept_message_id.clone(),
        }),
        // 块元数据 details（camelCase 五键；T-17 载荷构造 + T-31 织入）
        details: Some(compaction_block_details(
            &block_id,
            plan.generation,
            prev_block_id.as_deref(),
            boundary_ms,
            summary_state,
        )),
    };
    let compaction_id = record.id.clone();
    state.emit_event(AgentEvent::ContextCompressionEnd {
        session_id: session_id.clone(),
        timestamp: crate::steering::now_iso_utc(),
        result: Some(record),
        aborted: false,
        error: None,
    });
    // I8-E1：context.compact.end 钩子广播（压缩域收场；诊断字段全保留——
    // aborted / keptMessageCount / compactionId；observe 默认，失败吞掉）
    if let Some(hooks) = &state.options.hooks {
        let _ = hooks
            .dispatch(&crate::hooks::HookEvent::ContextCompactEnd {
                session_id,
                aborted: false,
                kept_message_count: plan.kept_ids.len() as u32,
                compaction_id,
            })
            .await;
    }
}

/// 触发点 → 事件原因文案（ContextCompressionStart.reason 字符串）
fn compression_reason_str(reason: ContextCompressionReason) -> &'static str {
    match reason {
        ContextCompressionReason::Manual => "manual",
        ContextCompressionReason::UserMessage => "usermessage",
        ContextCompressionReason::Stage => "stage",
        ContextCompressionReason::Threshold => "threshold",
        ContextCompressionReason::Overflow => "overflow",
        ContextCompressionReason::Idle => "idle",
        ContextCompressionReason::Incomplete => "incomplete",
        ContextCompressionReason::Handoff => "handoff",
    }
}

/// 触发点 → 策略层（P4 §3.4.6：预检属主动式 proactive、溢出属恢复式
/// recovery；其余触发点保守归 proactive）
fn policy_tier_for(trigger: ContextCompressionTrigger) -> ContextCompressionPolicyTier {
    match trigger {
        ContextCompressionTrigger::Overflow => ContextCompressionPolicyTier::Recovery,
        _ => ContextCompressionPolicyTier::Proactive,
    }
}
