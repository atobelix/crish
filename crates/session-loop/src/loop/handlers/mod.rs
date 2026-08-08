//! handler 集公共状态与辅助（B3.4）
//!
//! [LoopState] 是主循环的可变状态载体：状态机 / 输入队列 / 控制总线 /
//! abort 信号 / steering 协调器 / 对话 / 事件累加器 / 恢复阶梯计数。
//! 各 handler 以 `&mut LoopState` 驱动，产出 [HandlerOutcome]（可选收口决策）。
//!
//! [check_control] 是安全点集成的统一入口：每个 handler 起始与
//! stream / tool 批结束调用，把 ControlBus 意图 / AbortSignal 映射为
//! 循环动作（01 §2.10 优先级：force_cancel > cooperative_stop > soft_inject）：
//! - force_cancel / AbortSignal → ABORT 收场（aborted，可立即中断）；
//! - cooperative_stop → 按当前状态 D1 驱动状态机到 done（stopped 收场，
//!   不 abort；preparing-turn / steering-evaluation 为瞬时相位，停止在
//!   下一安全点生效）；
//! - soft_inject / steer / follow_up → 只读消费，消息写入输入队列对应环
//!   （01 §五.5 三环语义：steer → 下一安全点；followUp → 仅 idle promote），
//!   不打断流。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_tools::registry::ToolRegistry;
use conex_compaction::{CompactionEngine, CompactionPlan, EstimateContext, Summarizer};
use conex_types::context::ContextBudget;
use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageRole};
use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};
use conex_types::tool::{
    compaction_block_details, ContextCompressionCacheBoundaryMetadata,
    ContextCompressionPolicyAction, ContextCompressionPolicyMetadata, ContextCompressionPolicyTier,
    ContextCompressionReason, ContextCompressionRecord, ContextCompressionTrigger,
};

use crate::control::ControlBus;
use crate::input::AgentInputQueue;
use crate::safe_point::{apply_safe_point_control, AbortSignal};
use crate::state::AgentSessionMachine;
use crate::steering::{SteeringContext, SteeringCoordinator};

use super::end::EndDecision;
use super::{LoopError, SessionLoopOptions};

pub(crate) mod awaiting_input;
pub(crate) mod executing_tools;
pub(crate) mod no_tool_calls;
pub(crate) mod prepare_turn;
pub(crate) mod steering_evaluation;
pub(crate) mod stream_error;
pub(crate) mod streaming;
pub(crate) mod turn_complete;

/// 消息 id 计数器（同毫秒内多次生成保证唯一）
static MESSAGE_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成唯一消息 id（前缀 + 毫秒时间戳 + 序号）
pub(crate) fn new_message_id(prefix: &str) -> String {
    let n = MESSAGE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", crate::steering::unix_millis())
}

/// 主循环可变状态（各 handler 的共享载体）
pub(crate) struct LoopState {
    /// 会话状态机（B3.1）
    pub(crate) machine: AgentSessionMachine,
    /// 三环输入队列（force / steer / followUp）
    pub(crate) input_queue: AgentInputQueue,
    /// 控制总线（Arc<Mutex>：外部（UI / 测试）可并发入队意图）
    pub(crate) control_bus: Arc<Mutex<ControlBus>>,
    /// abort 信号（L3 强停等价，可 Clone 共享）
    pub(crate) abort_signal: AbortSignal,
    /// steering 协调器（预算 / 计数单一来源，01 §3.3 / D10）
    pub(crate) steering: SteeringCoordinator,
    /// 会话对话消息列表（跨 run 持久；Arc 共享——记录路径 0 深克隆，
    /// PE-09 T09.3.2）
    pub(crate) conversation: Vec<Arc<AgentMessage>>,
    /// 本次 run 的事件累加器（agent-start … agent-end）
    pub(crate) events: Vec<AgentEvent>,
    /// 循环配置（恢复阶梯上限 / 钩子等，由 AgentSessionLoop 注入）
    pub(crate) options: SessionLoopOptions,
    /// 工具注册表（请求构建导出工具定义 + 供 ToolExecutor 使用）
    pub(crate) tool_registry: Arc<ToolRegistry>,
    /// 工具 schema 快照（P1：run 内首次构建后锁定；注册表 run 内不可变，
    /// 工具循环轮次间复用保证请求前缀字节稳定——tools 是请求前缀的一部分，
    /// 每轮重建会随注册序漂移打爆缓存前缀）
    pub(crate) tools_snapshot: Option<Vec<crate::provider::ToolSchema>>,
    /// length 阶梯当前 max_tokens（8192 → 16384 → 32768，01 §2.6 步骤 1）
    pub(crate) max_tokens: u32,
    /// length 阶梯已升级次数（上限 2）
    pub(crate) length_upgrades: u32,
    /// 瞬态错误已重试次数（上限 3，01 §2.5 步骤 2）
    pub(crate) transient_retries: u32,
    /// continue nudge 已用次数（上限 1，01 §2.6 步骤 1）
    pub(crate) continue_nudges: u32,
    /// error 收场时的错误文案（turn-complete 收敛读取）
    pub(crate) terminal_error: Option<String>,
    /// 预算配置（经 SessionLoopOptions 注入，P4 §3.3.2）：None = 不钳制
    /// 不预检（向后兼容现状）；Some = 发请求前估算 + max_tokens 钳制 +
    /// prepare_turn 阈值预检压缩。
    pub(crate) budget: Option<ContextBudget>,
    /// 压缩策略（经 SessionLoopOptions 注入，P4 §3.4.2）：None = 无自动压缩。
    pub(crate) compaction_policy: Option<conex_compaction::CompactionPolicy>,
    /// L2 LLM 摘要器（可选注入，P4 §3.4.4）：None = L1 静态占位符；
    /// C14 摘要请求缓存隔离由实现方保证（本层只透传 trait 对象）。
    pub(crate) summarizer: Option<Arc<dyn Summarizer>>,
    /// 时间戳护栏（epoch ms，P4 §3.4.6）：压缩完成时写入；usage 源消息
    /// 时间戳早于它则该 usage 不再描述当前前缀（压缩插入新前缀消息），
    /// 估算回退启发式（判定在 conex-compaction 引擎内部完成）。
    pub(crate) last_compaction_at: Option<i64>,
    /// 单 run 压缩次数（P4 §3.4.6）：预检触发与溢出触发共用计数，
    /// 上限 max_auto_compactions_per_run（默认 1）；run 起始归零。
    pub(crate) compactions_this_run: u32,
    /// 溢出压缩重试计数（P4 §3.5，上限 1）：T-34 压缩阶梯（ContextLength-
    /// Exceeded / PayloadTooLarge 恢复）消费；本任务只提供字段与归零点。
    pub(crate) compression_retries: u32,
    /// 缓存跟踪器（P5 S2 / T-36）：None = 未配置缓存测量（行为与现状一致）；
    /// 构造 / 复位点 = LoopState 构造 + run() 起始（fresh run，P5 §3.4.5）；
    /// run 内跨 turn 维护签名基线并聚合 RunCacheStats；压缩事件（
    /// [apply_compaction] 单一广播点）触发代数 +1 / 基线作废（C13）。
    pub(crate) cache_tracker: Option<crate::cache_tracker::CacheStatsTracker>,
    /// 摘要后台调度器（T-33，00-plan §6.4）：run 内单飞面——压缩产出
    /// stub 且 Summarizer 注入存在时 spawn 后台退避重试任务；任务不绑定
    /// LoopState 生命周期（tokio::spawn 独立任务，run 收口不摧毁，R-I）；
    /// 跨 run 会话级容器（CoreRunState）由轮次 6 壳层承接。
    pub(crate) summary_dispatch: Arc<crate::r#loop::summary_dispatch::SummaryDispatch>,
    /// 会话级摘要协调器（T-42，00-plan §6.5 R-I）：壳层经注册表装配注入
    /// ——跨 run 单飞 + 全局并发上限 + 任务跨 run 存活（run 收口不摧毁）。
    /// None = 回退 run 级 [Self::summary_dispatch]（轮次 4 语义）。
    pub(crate) summary_coordinator:
        Option<Arc<crate::r#loop::summary_coordinator::SessionSummaryCoordinator>>,
}

impl LoopState {
    /// 新建状态（max_tokens 起点 [crate::r#loop::DEFAULT_MAX_TOKENS]）
    pub(crate) fn new(
        session_id: impl Into<String>,
        max_turns: u32,
        steering: SteeringCoordinator,
        options: SessionLoopOptions,
        tool_registry: Arc<ToolRegistry>,
    ) -> Self {
        // 预算/压缩面（P4 阶段 2-2/3-2）：构造期从 options 派生一次
        // （with_options 覆盖 options 时由 loop/mod.rs 派生状态同步刷新）
        let budget = options.context_budget;
        let compaction_policy = options.compaction_policy.clone();
        let summarizer = options.summarizer.clone();
        // 缓存测量面（P5 S2 / T-36）：构造期从 options 派生一次
        // （with_options / run() 起始由 loop/mod.rs 同步刷新与复位）
        let cache_tracker = crate::cache_tracker::build_tracker(options.cache_tracking.as_ref());
        // 摘要后台调度（T-33）：构造期从 options 派生（None = 生产缺省
        // 退避参数；测试注入快速序列）；run 起始不复位（单飞句柄跨 run
        // 保留——存活任务阻塞新 spawn，会话级单飞语义在 loop 实例内成立）
        let summary_dispatch = Arc::new(crate::r#loop::summary_dispatch::SummaryDispatch::new(
            options
                .summary_dispatch
                .clone()
                .unwrap_or_default(),
        ));
        // 会话级协调器（T-42）：构造期从 options 派生（壳层装配；None =
        // 回退 run 级 dispatch）——协调器由注册表持有，LoopState 只借用
        // Arc 引用，run 收口 drop 后任务仍由注册表支撑存活
        let summary_coordinator = options.summary_coordinator.clone();
        Self {
            machine: AgentSessionMachine::new(session_id, max_turns),
            input_queue: AgentInputQueue::new(),
            control_bus: Arc::new(Mutex::new(ControlBus::new())),
            abort_signal: AbortSignal::new(),
            steering,
            conversation: Vec::new(),
            events: Vec::new(),
            options,
            tool_registry,
            tools_snapshot: None,
            max_tokens: crate::r#loop::DEFAULT_MAX_TOKENS,
            length_upgrades: 0,
            transient_retries: 0,
            continue_nudges: 0,
            terminal_error: None,
            budget,
            compaction_policy,
            summarizer,
            // 护栏初始态：时间戳护栏空（无压缩边界）、计数 0（fresh run）
            last_compaction_at: None,
            compactions_this_run: 0,
            compression_retries: 0,
            cache_tracker,
            summary_dispatch,
            summary_coordinator,
        }
    }
}

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

/// 阈值预检触发（P4 阶段 3-2 / §3.4.1 触发点 1，prepare_turn 步骤 5）。
///
/// 条件（全部满足才压缩）：
///
/// 1. 预算与压缩策略均已配置（None = 向后兼容现状，不预检）；
/// 2. `estimate ≥ window - reserve`（对齐 pi threshold = window - reserve，
///    估算 = [estimate_context] 双源结果，C9 口径）；
/// 3. 本 run 压缩次数未达上限（[SessionLoopOptions::max_auto_compactions_per_run]，
///    单 run 护栏，预检与溢出触发共用计数，§3.4.6）。
///
/// 压缩动作：`compact_agent_messages` 同步执行（保留 system 消息 + 摘要
/// 占位 + 保留段，合法切割点 tool 配对保护）；L2 摘要失败降级 L1 占位符；
/// 无合法切割点（tool 孤儿无法配对 / 保留段覆盖全部消息）时计划为空动作，
/// 不广播事件、不计数。
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
    let plan = engine.compact_agent_messages(
        &state.conversation,
        budget_tokens as usize,
        &policy,
        state.summarizer.as_deref(),
    );
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
            "压缩产物协议形状违规（无 system 且链后首条非 user）→ 跳过压缩（T-36 护栏）"
        );
        return false;
    }
    let info = CompactionTriggerInfo {
        trigger: ContextCompressionTrigger::Threshold,
        reason: ContextCompressionReason::Threshold,
    };
    apply_compaction(state, &plan, &info, Some(u64::from(budget_tokens))).await;
    true
}

/// 应用压缩计划：替换对话 + 压缩计数 + 时间戳护栏 + 事件广播（§3.4.6）。
///
/// - **对话替换**：压缩是唯一前缀重写点（I1，§3.6）——`plan.messages`
///   已保留 system 消息 + 摘要占位 + 保留段；
/// - **护栏**：`compactions_this_run += 1`（单 run 上限共用计数）；压缩
///   完成后重置 `last_compaction_at = now`（usage 源早于边界作废）；
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
    state.events.push(AgentEvent::ContextCompressionStart {
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
            plan.generation,
            plan.fold_chain_prev
        ))
    } else {
        None
    };
    let summary_state = if plan.summary_is_llm { "committed" } else { "awaiting" };
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
                    if text.is_empty() { None } else { Some(text) }
                })
                .next_back();
            let max_bytes = state
                .compaction_policy
                .as_ref()
                .map(|p| p.max_summary_tokens.saturating_mul(4))
                .unwrap_or(4096);
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
    state.events.push(AgentEvent::ContextCompressionEnd {
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

/// handler 产出：可选收口决策（None = 继续循环）
#[derive(Debug, Clone)]
pub(crate) struct HandlerOutcome {
    pub(crate) end: Option<EndDecision>,
}
impl HandlerOutcome {
    /// 继续循环
    pub(crate) fn continue_run() -> Self {
        Self { end: None }
    }

    /// 收敛 run
    pub(crate) fn end(decision: EndDecision) -> Self {
        Self {
            end: Some(decision),
        }
    }
}

/// 状态机事件分派（未定义转移显式失败，01 §五.1）
pub(crate) fn dispatch(state: &mut LoopState, event: E) -> Result<(), LoopError> {
    state
        .machine
        .dispatch(event)
        // T06.5.1：显式码构造（runtime.transition_failed），TransitionError
        // 上下文保留在 message（不再丢原始结构化信息，AA-01 Q29）
        .map_err(|e| {
            LoopError::with_code(
                codes::RUNTIME_TRANSITION_FAILED,
                format!("状态机转移失败：{e}"),
            )
        })
}

/// 记录一条消息到对话并产出 message-start / message-end 事件对
/// （01 §五.6：每条消息必成对）
///
/// PE-09 T09.3.2：`Arc::new` 一次后对话与事件共享同一份消息内存
/// （0 深克隆；serde 对 `Arc<T>` 按 `T` 序列化，wire 逐字节不变）。
///
/// P1 不变量（append-only）：本函数是会话内 4 个追加点之一（user / steering
/// 消息入队消费路径）——只允许把新消息**追加到对话尾部**；改写 / 重排 /
/// 删除既有消息会破坏请求前缀字节稳定性；压缩是唯一例外（P4 闸门，
/// compaction 是唯一前缀重写点）。
pub(crate) fn record_message(state: &mut LoopState, message: AgentMessage) {
    let session_id = state.machine.context().session_id.clone();
    let message = Arc::new(message);
    state.events.push(AgentEvent::MessageStart {
        session_id: session_id.clone(),
        message: message.clone(),
    });
    state.conversation.push(message.clone());
    state.events.push(AgentEvent::MessageEnd {
        session_id,
        message,
    });
    // T-35 注入卫生（debug 面）：时间线/时间戳注入只允许落在对话末尾
    // user 消息——本函数是 user 消息入队消费的追加点（prepare_turn /
    // awaiting_input 共用），在此统一断言
    assert_timeline_injection_hygiene(&state.conversation);
}

/// 时间线/时间戳注入卫生断言（T-35，00-plan §9 / 评审 02 N8；debug 面）
///
/// 不变量（00-plan §9 注入卫生表）：时间戳/时间线注入只允许出现在
/// 「对话末尾的 user 消息」——绝不进 system 段、绝不改写既有消息、绝不
/// 落在链（compacted-summary 前缀）内、绝不落在保留区中部。
///
/// 识别面：注入消息 metadata 携带 `{kind: "timeline"}` 标记，或正文含
/// 时间戳注入前缀「当前时间：」；两类标记都不存在时本断言为无操作
/// （零开销、向后兼容既有消息形态——现状时间线注入在壳层/前端，内核
/// 只兜底运行期注入面）。
///
/// debug_assert 仅在 debug 构建生效（cargo test / dev）；release 构建
/// 经 `cfg!(debug_assertions)` 分支整体编译剔除（零成本）。
pub(crate) fn assert_timeline_injection_hygiene(conversation: &[Arc<AgentMessage>]) {
    if !cfg!(debug_assertions) {
        return;
    }
    let Some(last) = conversation.last() else {
        return;
    };
    let is_timeline = last
        .metadata
        .as_ref()
        .and_then(|m| m.get("kind").and_then(|v| v.as_str()))
        .is_some_and(|kind| kind == "timeline")
        || last.text().contains("当前时间：");
    if is_timeline {
        debug_assert_eq!(
            last.role,
            AgentMessageRole::User,
            "时间线注入只允许落在对话末尾 user 消息（T-35 注入卫生；注入点越界 → 前缀漂移）"
        );
    }
}

/// 压缩产物协议形状护栏（T-36，评审 02 P1-7 / 00-plan §12 风险 4）
///
/// 规则：**无 system 会话**的链后首条必须为 user——assistant/tool 开头
/// 违反协议形状（DeepSeek/OpenAI 首条 400 风险）；有 system 的会话由
/// system 充当首条，形状天然安全。空/全链会话 → false（无合法可压缩
/// 内容，由调用方跳过压缩）。
///
/// 覆盖说明：轮次 1 的 `cut <= fold_start` 只钳制切割点下界（B2 单调），
/// 不覆盖「tail 首条角色」形状问题——本条护栏在 session-loop 压缩触发
/// 点（预检 / 溢出阶梯）对压缩产物（plan.messages）检查，违规即跳过
/// 压缩 + warn（引擎层保持纯算法不感知 wire 协议形状）。
pub(crate) fn compaction_shape_ok(conversation: &[Arc<AgentMessage>]) -> bool {
    if conversation.iter().any(|m| m.role == AgentMessageRole::System) {
        return true;
    }
    match conversation
        .iter()
        .find(|m| !m.id.starts_with("compacted-summary"))
    {
        None => false,
        Some(first) => first.role == AgentMessageRole::User,
    }
}

/// 水合首尾双约束断言（T-36，00-plan §3.1 / 评审 02 P1-7；debug 面）
///
/// - 首条约束：跳过开头 system + 链消息后，剩余首条必须为 User——
///   assistant/tool 开头违反协议形状（provider 400 风险）；
/// - 尾部约束（**仅含水合链的对话**）：链后保留区必须以 user 收尾
///   （B4 形状 / P4 §3.2.2 水合截断保证）；无链对话不约束尾部——
///   兼容 run outcome 直接续接形态（跨 run 续接以 assistant 收尾）。
///
/// 调用点：`with_initial_conversation[_arc]`（水合/首条消息构造路径）；
/// `hydrate_history` 已按规则 5 截断到末条 user（尾部约束天然满足）。
/// release 构建经 `cfg!(debug_assertions)` 分支整体编译剔除（零成本）。
pub(crate) fn assert_conversation_head_tail(conversation: &[Arc<AgentMessage>]) {
    if !cfg!(debug_assertions) {
        return;
    }
    // 首条约束：跳过 system + 链后的首条必须为 user
    if let Some(idx) = conversation.iter().position(|m| {
        m.role != AgentMessageRole::System && !m.id.starts_with("compacted-summary")
    }) {
        debug_assert_eq!(
            conversation[idx].role,
            AgentMessageRole::User,
            "无 system 会话首条（跳过链后）必须为 user（T-36 首条约束；assistant/tool 开头 provider 400 风险）"
        );
    }
    // 尾部约束（仅链会话）：链后保留区以 user 收尾（B4）
    let has_chain = conversation
        .iter()
        .any(|m| m.id.starts_with("compacted-summary"));
    if has_chain {
        debug_assert_eq!(
            conversation.last().map(|m| m.role),
            Some(AgentMessageRole::User),
            "含水合链的对话必须以 user 收尾（B4 尾部约束，T-36）"
        );
    }
}

/// 构建 steering 评估上下文（计数取 coordinator 单一计数源，01 §3.3 / D10）
pub(crate) fn steering_context(state: &LoopState) -> SteeringContext<'_> {
    SteeringContext {
        messages: &state.conversation,
        turn_index: state.machine.context().turn_index,
        steering_count: state.steering.get_steering_count(),
        tool_call_count: state.machine.context().tool_call_count,
        has_pending_input: state.input_queue.has_runnable_pending(),
    }
}

/// 驱动状态机到 done（cooperative_stop 安全点，D1：不 abort）
///
/// 01 §2.10 覆盖的三态路径：streaming: NO_TOOL_CALLS+SHOULD_STOP；
/// executing-tools: TOOLS_COMPLETE+SHOULD_STOP；turn-complete: SHOULD_STOP。
/// awaiting-input 无输入即 NO_INPUT 收场；preparing-turn / steering-evaluation
/// 为瞬时相位（同步代码），停止在下一安全点（stream 结束 / tool 批后）生效。
fn drive_machine_to_stop(state: &mut LoopState) -> Result<(), LoopError> {
    match state.machine.state() {
        S::Streaming => {
            dispatch(state, E::NoToolCalls)?;
            dispatch(state, E::ShouldStop)?;
        }
        S::ExecutingTools => {
            dispatch(state, E::ToolsComplete)?;
            dispatch(state, E::ShouldStop)?;
        }
        S::TurnComplete => dispatch(state, E::ShouldStop)?,
        S::AwaitingInput => dispatch(state, E::NoInput)?,
        // 瞬时相位：不驱动，下一安全点生效
        S::PreparingTurn | S::SteeringEvaluation => {}
        S::Idle | S::Done => {}
    }
    Ok(())
}

/// 安全点统一检查：handler 起始与 stream / tool 批结束调用。
///
/// 返回 [Some] 表示 run 已可收敛（force_cancel / cooperative_stop），
/// [None] 表示继续（soft_inject 只读消费后消息已落环）。
pub(crate) fn check_control(state: &mut LoopState) -> Result<Option<EndDecision>, LoopError> {
    // AbortSignal 等价 L3 强停，优先于总线内任何意图（01 §2.10）
    let action = {
        let mut bus = state.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        apply_safe_point_control(&mut bus, Some(&state.abort_signal))
    };
    let Some(action) = action else {
        return Ok(None);
    };
    match action {
        crate::safe_point::ControlAction::ForceCancel { reason } => {
            // L3 强停：可立即中断 → ABORT（endReason=aborted；取消原因经
            // aborted_with_diagnostic 透出，T06.3 Q02：不再写 state.abort_reason）
            dispatch(state, E::Abort)?;
            Ok(Some(EndDecision::aborted_with_diagnostic(state, reason)))
        }
        crate::safe_point::ControlAction::CooperativeStop {
            pending_messages, ..
        } => {
            // L2 协作停止：不 abort，D1 驱动状态机到 done（stopped 收场）
            for message in pending_messages {
                state.input_queue.enqueue_steer(message);
            }
            drive_machine_to_stop(state)?;
            Ok(Some(EndDecision::stopped(state)))
        }
        crate::safe_point::ControlAction::SoftInject {
            steer_messages,
            follow_up_messages,
        } => {
            // L1 软注入：只读消费，消息落环（不打断流）
            for message in steer_messages {
                state.input_queue.enqueue_steer(message);
            }
            for message in follow_up_messages {
                state.input_queue.enqueue_follow_up(message);
            }
            Ok(None)
        }
    }
}

/// 取最后一条携带工具调用的 assistant 消息（01 §2.8 步骤 2 的输入）
pub(crate) fn last_assistant_with_tool_calls(
    state: &LoopState,
) -> Option<&Arc<conex_types::message::AgentMessage>> {
    state
        .conversation
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant && m.tool_calls().next().is_some())
}

// ── T-33 单测（P4 阶段 2-2/2-3/2-4、阶段 3-2/3-3）：钳制/预检/护栏/事件 ──

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use conex_compaction::{CompactionPlan, EstimateSource, Summarizer};
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};

    use super::*;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };

    /// 构造测试 LoopState（默认 options；测试内按需覆盖）
    fn test_state(options: SessionLoopOptions) -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        LoopState::new("s1", 16, steering, options, Arc::new(ToolRegistry::new()))
    }

    /// 带预算/策略的最小配置（窗口 1 万、阈值 = window - reserve = 8000）
    fn budgeted_options() -> SessionLoopOptions {
        SessionLoopOptions {
            context_budget: Some(ContextBudget {
                context_window: 10_000,
                reserve_tokens: 2_000,
                safety_tokens: 100,
            }),
            compaction_policy: Some(conex_compaction::CompactionPolicy {
                keep_recent_tokens: 2_000,
                min_recent_turns: 1,
                ..Default::default()
            }),
            max_auto_compactions_per_run: 1,
            ..Default::default()
        }
    }

    /// 超阈值对话：10 条消息 × 5000 字（CJK 逐字符 ≈ 5000 token）≈ 5 万 token
    fn big_conversation() -> Vec<Arc<AgentMessage>> {
        (0..10)
            .map(|i| {
                Arc::new(AgentMessage {
                    id: format!("m{i}"),
                    role: if i % 2 == 0 {
                        AgentMessageRole::User
                    } else {
                        AgentMessageRole::Assistant
                    },
                    created_at: "2026-08-03T10:00:00.000Z".to_string(),
                    blocks: vec![AgentMessageBlock::Text {
                        text: "字".repeat(5_000),
                    }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                })
            })
            .collect()
    }

    /// 从事件列表取压缩记录（断言辅助）
    fn compression_record(state: &LoopState) -> Option<ContextCompressionRecord> {
        state.events.iter().find_map(|e| match e {
            AgentEvent::ContextCompressionEnd {
                result: Some(record),
                ..
            } => Some(record.clone()),
            _ => None,
        })
    }

    /// 钳制数学（P4 §3.3.2 窗口边缘 / 下限不钳 / MIN 1）
    #[test]
    fn clamp_max_tokens_window_edge_and_floor() {
        let budget = ContextBudget {
            context_window: 64_000,
            reserve_tokens: 16_384,
            safety_tokens: 4_096,
        };
        // 窗口边缘：估算贴近窗口 → 可用预算 = 64k - 60k - 4k = 0 低于下限 →
        // 不钳制（保持 requested，只记录）
        assert_eq!(clamp_max_tokens(8192, 60_000, &budget), 8192);
        // 正常钳制：可用预算 4904 ≥ 下限 → min(8192, 4904)
        assert_eq!(clamp_max_tokens(8192, 55_000, &budget), 4904);
        // 可用预算恰好等于下限 256 → 仍钳制
        assert_eq!(clamp_max_tokens(8192, 64_000 - 4_096 - 256, &budget), 256);
        // MIN 1：requested 为 0 时钳到 1（最小输出不为 0）
        assert_eq!(clamp_max_tokens(0, 55_000, &budget), 1);
        // 估算为 0：可用预算 = window - safety，requested 更小 → 原值
        assert_eq!(clamp_max_tokens(8192, 0, &budget), 8192);
    }

    /// 时间戳护栏：usage 源消息时间戳早于 last_compaction_at → usage 作废
    /// 回退启发式（§3.3.1 / §3.4.6；C9 口径 inputTotal 消费）
    #[test]
    fn estimate_invalidates_usage_before_compaction_boundary() {
        let mut state = test_state(SessionLoopOptions::default());
        // assistant 消息携带 usage（cacheBreakdown.inputTotal = 900，C9 口径）
        state.conversation = vec![Arc::new(AgentMessage {
            id: "a1".to_string(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "回复".to_string(),
            }],
            metadata: Some(serde_json::json!({
                "stopReason": "stop",
                "usage": { "promptTokens": 900 },
                "cacheBreakdown": { "inputTotal": 900, "read": 0, "write": 0, "miss": 900 },
            })),
            client_message_id: None,
            content: None,
        })];
        // 无压缩边界 → usage 生效（Usage 源，tokens = inputTotal + 尾随补算 0）
        let estimate = estimate_context(&state);
        assert_eq!(estimate.source, EstimateSource::Usage);
        assert_eq!(estimate.tokens, 900);
        assert_eq!(estimate.usage_message_id.as_deref(), Some("a1"));
        // 压缩边界晚于消息时间戳 → usage 作废 → 启发式兜底
        state.last_compaction_at = Some(i64::MAX);
        let estimate = estimate_context(&state);
        assert_eq!(estimate.source, EstimateSource::Heuristic);
        assert_eq!(estimate.usage_message_id, None);
    }

    /// 预检触发：超阈值 → 压缩一次 + 事件成对 + 护栏置位；
    /// 单 run 上限：对话再次膨胀后第二次预检被挡下（§3.4.6 防重触发）
    #[tokio::test]
    async fn preflight_compacts_once_and_guard_blocks_second() {
        let mut state = test_state(budgeted_options());
        state.conversation = big_conversation();
        assert!(
            maybe_compact_preflight(&mut state).await,
            "超阈值必须触发预检压缩"
        );
        // 护栏：压缩计数 + 时间戳护栏重置
        assert_eq!(state.compactions_this_run, 1);
        assert!(
            state.last_compaction_at.is_some(),
            "压缩后时间戳护栏必须重置"
        );
        // 事件成对广播
        let starts = state
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ContextCompressionStart { .. }))
            .count();
        let ends = state
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ContextCompressionEnd { .. }))
            .count();
        assert_eq!(starts, 1);
        assert_eq!(ends, 1);
        // 对话替换：摘要占位 + 保留段（system 保持——本对话无 system）
        assert!(
            state
                .conversation
                .iter()
                .any(|m| m.id.starts_with("compacted-summary")),
            "压缩后对话必须含摘要占位消息"
        );
        assert!(state.conversation.len() < 10, "压缩后消息数必须减少");
        // 第二次预检：对话重新膨胀到超阈值，但单 run 上限挡下（不重触发）
        state.conversation = big_conversation();
        assert!(
            !maybe_compact_preflight(&mut state).await,
            "同 run 内第二次超阈值不得再压缩（单 run 上限护栏）"
        );
        assert_eq!(state.compactions_this_run, 1);
        assert_eq!(
            state
                .events
                .iter()
                .filter(|e| matches!(e, AgentEvent::ContextCompressionEnd { .. }))
                .count(),
            1,
            "事件也必须只有一对"
        );
    }

    /// 可配置上限：max_auto_compactions_per_run = 2 → 同 run 最多压缩 2 次
    #[tokio::test]
    async fn preflight_respects_configured_run_limit() {
        let mut state = test_state(SessionLoopOptions {
            max_auto_compactions_per_run: 2,
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(maybe_compact_preflight(&mut state).await);
        state.conversation = big_conversation();
        assert!(maybe_compact_preflight(&mut state).await);
        assert_eq!(state.compactions_this_run, 2);
        state.conversation = big_conversation();
        assert!(!maybe_compact_preflight(&mut state).await, "上限 2 已用尽");
    }

    /// 不触发：无预算配置（None，向后兼容现状）/ 估算低于阈值
    #[tokio::test]
    async fn preflight_skipped_under_threshold_and_without_config() {
        // 无预算配置 → 不预检（默认 options 全 None）
        let mut state = test_state(SessionLoopOptions::default());
        state.conversation = big_conversation();
        assert!(!maybe_compact_preflight(&mut state).await);
        // 预算配置但估算低于阈值 → 不压缩、无事件
        let mut state = test_state(budgeted_options());
        state.conversation = vec![Arc::new(AgentMessage {
            id: "m0".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "短消息".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        })];
        assert!(!maybe_compact_preflight(&mut state).await);
        assert_eq!(state.compactions_this_run, 0);
        assert!(state.events.is_empty(), "未触发不得广播任何事件");
    }

    /// 事件载荷：ContextCompressionEnd.record 字段 = CompactionPlan 字段
    /// （trigger/reason/policy/tokens/ids/summary/threshold，§3.4.6）
    #[tokio::test]
    async fn compaction_end_event_carries_plan_fields() {
        let mut state = test_state(budgeted_options());
        let msgs = big_conversation();
        let plan = CompactionPlan {
            messages: msgs,
            dropped_ids: vec!["m0".to_string(), "m1".to_string()],
            kept_ids: vec![
                "compacted-summary-2".to_string(),
                "m8".to_string(),
                "m9".to_string(),
            ],
            first_kept_message_id: Some("m8".to_string()),
            tokens_before: 10_000,
            tokens_after: 2_100,
            summary: "[Compacted 2 earlier message(s) to fit context window]".to_string(),
            summary_is_llm: false,
            fold_chain_prev: 0,
            fold_chain_after: 0,
            fold_index: 0,
            generation: 1,
        };
        let info = CompactionTriggerInfo {
            trigger: ContextCompressionTrigger::Threshold,
            reason: ContextCompressionReason::Threshold,
        };
        apply_compaction(&mut state, &plan, &info, Some(8_000)).await;

        // 对话替换 + 护栏
        assert_eq!(state.conversation, plan.messages, "压缩结果必须替换对话");
        assert_eq!(state.compactions_this_run, 1);
        assert!(state.last_compaction_at.is_some());
        // Start 事件：reason + tokens_before
        let (start_reason, start_tokens) = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ContextCompressionStart {
                    reason,
                    tokens_before,
                    ..
                } => Some((reason.clone(), *tokens_before)),
                _ => None,
            })
            .expect("必须有压缩开始事件");
        assert_eq!(start_reason, "threshold");
        assert_eq!(start_tokens, 10_000);
        // End 事件载荷 = CompactionPlan 字段
        let (aborted, error) = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ContextCompressionEnd { aborted, error, .. } => {
                    Some((*aborted, error.clone()))
                }
                _ => None,
            })
            .expect("必须有压缩结束事件");
        assert!(!aborted);
        assert!(error.is_none());
        let record = compression_record(&state).expect("End 事件必须携带 record");
        assert_eq!(record.trigger, ContextCompressionTrigger::Threshold);
        assert_eq!(record.reason, Some(ContextCompressionReason::Threshold));
        assert_eq!(record.compressed_message_ids, plan.dropped_ids);
        assert_eq!(record.kept_message_ids, plan.kept_ids);
        assert_eq!(record.first_kept_message_id, plan.first_kept_message_id);
        assert_eq!(record.tokens_before, plan.tokens_before);
        assert_eq!(record.tokens_after, plan.tokens_after);
        assert_eq!(record.threshold_tokens, Some(8_000));
        assert_eq!(record.summary, plan.summary);
        let policy = record.policy.expect("必须携带策略元数据");
        assert_eq!(policy.tier, ContextCompressionPolicyTier::Proactive);
        assert_eq!(policy.action, ContextCompressionPolicyAction::Compact);
    }

    /// T-36：压缩事件（apply_compaction 单一广播点）触发 tracker 代数 +1 /
    /// 基线作废（C13）；压缩后首轮 usage 无基线 → 不计 miss（新内容非重放）
    #[tokio::test]
    async fn compaction_resets_cache_tracker_baseline_via_real_path() {
        use conex_telemetry::cache::{CacheAccountingKind, CacheUsageScalars};
        let mut state = test_state(SessionLoopOptions {
            cache_tracking: Some(crate::cache_tracker::CacheTrackingConfig {
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                ttl_seconds: 60,
            }),
            ..budgeted_options()
        });
        let usage = |prompt: u64, read: u64, write: u64| CacheUsageScalars {
            prompt,
            read,
            write,
            miss: None,
            accounting: CacheAccountingKind::Included,
        };
        // 首轮：捕获签名 + 消费 usage（read > 0 → reported_cache 粘性置位）
        state
            .cache_tracker
            .as_mut()
            .unwrap()
            .capture_signature(Some("sys"), &[], &[]);
        assert!(
            state
                .cache_tracker
                .as_mut()
                .unwrap()
                .record_usage(usage(10_000, 8_000, 500), 100, 10_100, 1_000)
                .is_none(),
            "首轮无基线 → 不计 miss"
        );
        assert!(
            state.cache_tracker.as_ref().unwrap().baseline().is_some(),
            "首轮后基线必须建立"
        );
        // 压缩（apply_compaction 是预检与溢出两路径的单一广播点）
        let plan = CompactionPlan {
            messages: big_conversation(),
            dropped_ids: vec!["m0".to_string()],
            kept_ids: vec!["m9".to_string()],
            first_kept_message_id: Some("m9".to_string()),
            tokens_before: 50_000,
            tokens_after: 5_000,
            summary: "[Compacted 1 earlier message(s)]".to_string(),
            summary_is_llm: false,
            fold_chain_prev: 0,
            fold_chain_after: 0,
            fold_index: 0,
            generation: 1,
        };
        let info = CompactionTriggerInfo {
            trigger: ContextCompressionTrigger::Threshold,
            reason: ContextCompressionReason::Threshold,
        };
        apply_compaction(&mut state, &plan, &info, Some(8_000)).await;
        // C13：基线作废
        assert!(
            state.cache_tracker.as_ref().unwrap().baseline().is_none(),
            "压缩后基线必须作废"
        );
        // T-31：压缩后重建签名已捕获（capture_post_compaction 接线）——
        // 与压缩后对话同输入投影（system=None、tools 空、messages=对话）
        let post_compaction = state.conversation.clone();
        assert!(
            state.cache_tracker.as_ref().unwrap().rebuild_signature().is_some(),
            "apply_compaction 必须捕获压缩后重建签名（T-31）"
        );
        // 压缩后首轮：重建签名与捕获签名同输入 → Identical（追加区豁免）；
        // 无基线 → detect 不计 miss
        state
            .cache_tracker
            .as_mut()
            .unwrap()
            .capture_signature(None, &[], &post_compaction);
        assert!(
            state
                .cache_tracker
                .as_mut()
                .unwrap()
                .record_usage(usage(5_000, 0, 0), 50, 5_050, 2_000)
                .is_none(),
            "压缩后无基线 → 不计 miss（重建签名与捕获签名一致 → 正常路径）"
        );
    }

    /// 摘要隔离（C14）：摘要器只收到丢弃消息（trait 边界不携带会话/
    /// 缓存亲和参数——无缓存键断言）；Err → 降级 stub（R-G 新契约：
    /// 合法 Schema V1 JSON 才进链，其余一律中性 stub），压缩仍完成
    // G2 允许理由（clippy::type_complexity）：测试局部嵌套类型
    // （RecordingSummarizer 回调签名含 Arc<Mutex<Vec<(Vec<String>,
    // Option<String>)>>>），类型由被测接口依赖链自然形成，定义别名可缓解
    // 但改动扩散大、豁免面小。
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn summarizer_receives_dropped_only_and_err_falls_back_to_l1() {
        /// 合法 Schema V1 JSON 文档（R-G 契约：非 JSON 一律降级 stub）
        fn valid_summary_json(block_id: &str) -> String {
            serde_json::json!({
                "schemaVersion": 1,
                "blockId": block_id,
                "generation": 1,
                "droppedIds": [],
                "height": 1,
                "tier": "chunk",
                "goal": "修复构建流程",
                "constraints": [],
                "progress": ["已定位编译错误"],
                "decisions": [],
                "nextSteps": ["运行全量测试"],
                "criticalContext": ["cargo build --workspace"],
            })
            .to_string()
        }
        struct RecordingSummarizer {
            calls: Arc<Mutex<Vec<(Vec<String>, Option<String>)>>>,
            fail: bool,
        }
        impl Summarizer for RecordingSummarizer {
            fn summarize(
                &self,
                dropped: &[AgentMessage],
                existing: Option<&str>,
            ) -> Result<String, String> {
                self.calls.lock().unwrap().push((
                    dropped.iter().map(|m| m.id.clone()).collect(),
                    existing.map(str::to_string),
                ));
                if self.fail {
                    Err("摘要请求失败（模拟 L2 降级）".to_string())
                } else {
                    Ok(valid_summary_json("compacted-summary-1-1"))
                }
            }
        }

        // 成功路径：摘要器收到全部丢弃消息（C14：独立前缀域——不携带任何
        // session_id / 缓存键 / 工具 / system 参数，隔离由 trait 边界保证）
        let calls = Arc::new(Mutex::new(Vec::new()));
        let summarizer = Arc::new(RecordingSummarizer {
            calls: calls.clone(),
            fail: false,
        });
        let mut state = test_state(SessionLoopOptions {
            summarizer: Some(summarizer.clone()),
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(
            maybe_compact_preflight(&mut state).await,
            "L2 摘要路径压缩必须完成"
        );
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded.len(), 1, "摘要器只调用一次");
        let (dropped_ids, existing) = &recorded[0];
        assert!(existing.is_none(), "首次压缩无既有摘要");
        assert_eq!(dropped_ids.len(), 8, "丢弃 8 条消息全部交给摘要器");
        assert!(
            dropped_ids.iter().all(|id| id.starts_with('m')),
            "摘要器只收到消息 id"
        );
        // 事件载荷摘要 = Schema V1 JSON 文档的 md 渲染（R-G 语源唯一：
        // 链文本 = 文档的确定性渲染投影）
        let summary = compression_record(&state)
            .map(|r| r.summary)
            .expect("必须有记录");
        assert!(
            summary.contains("## Goal") && summary.contains("修复构建流程"),
            "事件摘要 = JSON 文档的 markdown 渲染：{summary}"
        );
        assert!(
            !summary.starts_with("[Compacted"),
            "同步成功路径不得降级 stub：{summary}"
        );

        // 失败路径：Err → 降级中性 stub（R-C：永不改写；§3.4.4 不阻塞主对话）
        let fail_state = {
            let mut state = test_state(SessionLoopOptions {
                summarizer: Some(Arc::new(RecordingSummarizer {
                    calls: Arc::new(Mutex::new(Vec::new())),
                    fail: true,
                })),
                ..budgeted_options()
            });
            state.conversation = big_conversation();
            assert!(
                maybe_compact_preflight(&mut state).await,
                "摘要失败也必须完成压缩"
            );
            state
        };
        let summary = compression_record(&fail_state)
            .map(|r| r.summary)
            .expect("必须有记录");
        assert!(
            summary.starts_with("[Compacted(") && summary.contains("摘要见块表"),
            "失败降级中性 stub（R-G 契约，非 JSON/Err 一律 stub）：{summary}"
        );
    }

    /// T-35 注入卫生（正例）：时间线标记落在对话末尾 user 消息 → 通过
    #[test]
    fn timeline_injection_at_tail_user_passes_hygiene() {
        fn msg(role: AgentMessageRole, kind: Option<&str>, text: &str) -> Arc<AgentMessage> {
            Arc::new(AgentMessage {
                id: "m".to_string(),
                role,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: text.to_string(),
                }],
                metadata: kind.map(|k| serde_json::json!({ "kind": k })),
                client_message_id: None,
                content: None,
            })
        }
        // 时间线注入 = 对话末尾 user 消息（合法形态）
        let conv = vec![
            msg(AgentMessageRole::User, None, "之前的对话"),
            msg(AgentMessageRole::Assistant, None, "回复"),
            msg(AgentMessageRole::User, Some("timeline"), "当前时间：2026-08-03 18:00:00\n继续"),
        ];
        assert_timeline_injection_hygiene(&conv);
    }

    /// T-35 注入卫生（反例）：时间线标记出现在对话末尾但角色非 user →
    /// debug 断言拒绝（注入点越界 = 前缀漂移源）
    #[test]
    #[should_panic(expected = "时间线注入只允许")]
    fn timeline_marker_on_non_user_tail_rejected() {
        fn msg(role: AgentMessageRole, kind: Option<&str>, text: &str) -> Arc<AgentMessage> {
            Arc::new(AgentMessage {
                id: "m".to_string(),
                role,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: text.to_string(),
                }],
                metadata: kind.map(|k| serde_json::json!({ "kind": k })),
                client_message_id: None,
                content: None,
            })
        }
        // 时间线标记落在对话末尾 system 角色（越界注入）→ 拒绝
        let conv = vec![
            msg(AgentMessageRole::User, None, "对话"),
            msg(AgentMessageRole::System, Some("timeline"), "时间线注入进 system"),
        ];
        assert_timeline_injection_hygiene(&conv);
    }

    /// T-36 协议形状护栏（纯函数三态）：有 system → 恒放行；
    /// 无 system + 链后首条 user → 放行；无 system + 链后首条 assistant /
    /// tool / 全链 → 拒绝
    #[test]
    fn compaction_shape_guard_classifies_shapes() {
        fn msg(id: &str, role: AgentMessageRole) -> Arc<AgentMessage> {
            Arc::new(AgentMessage {
                id: id.to_string(),
                role,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "字".repeat(100),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            })
        }
        // 有 system → 放行（wire 首条 = system，形状安全）
        assert!(compaction_shape_ok(&[
            msg("sys", AgentMessageRole::System),
            msg("compacted-summary-1-1", AgentMessageRole::Assistant), // 链
            msg("a1", AgentMessageRole::Assistant),
        ]));
        // 无 system + 链后首条 user → 放行
        assert!(compaction_shape_ok(&[
            msg("compacted-summary-1-1", AgentMessageRole::Assistant), // 链
            msg("u1", AgentMessageRole::User),
            msg("a1", AgentMessageRole::Assistant),
        ]));
        // 无 system + 链后首条 assistant → 拒绝（wire 首条 = assistant，
        // provider 400 风险，评审 02 P1-7）
        assert!(!compaction_shape_ok(&[
            msg("compacted-summary-1-1", AgentMessageRole::Assistant), // 链
            msg("a1", AgentMessageRole::Assistant),
            msg("u1", AgentMessageRole::User),
        ]));
        // 无 system + 无链 + 首条 assistant → 拒绝
        assert!(!compaction_shape_ok(&[
            msg("a1", AgentMessageRole::Assistant),
            msg("u1", AgentMessageRole::User),
        ]));
        // 无 system + 无链 + 首条 tool → 拒绝
        assert!(!compaction_shape_ok(&[
            msg("t1", AgentMessageRole::Tool),
            msg("u1", AgentMessageRole::User),
        ]));
        // 空 / 全链 → 拒绝（无可压缩内容，调用方跳过压缩）
        assert!(!compaction_shape_ok(&[]));
        assert!(!compaction_shape_ok(&[msg("s1", AgentMessageRole::Assistant)]));
    }

    /// T-36 引擎兜底（预检路径）：无 system 会话中压缩产物链后首条为
    /// assistant → 跳过压缩 + 不广播事件 + 不计数（护栏防 provider 400）
    ///
    /// 构造：user(500) assistant(5000) user(500) assistant(5000) user(500)
    /// ——尾部倒推 keep_recent_tokens=2000 在 assistant(3) 处越过预算，
    /// min_recent_turns=1 已被 idx4 user 满足 → cut 停在 assistant(3) →
    /// 压缩产物 [链][assistant][user] 形状违规 → 护栏拦下。
    #[tokio::test]
    async fn compaction_shape_guard_skips_assistant_head_without_system() {
        let mut state = test_state(budgeted_options());
        let sizes = [500usize, 5_000, 500, 5_000, 500];
        state.conversation = sizes
            .iter()
            .enumerate()
            .map(|(i, &n)| {
                Arc::new(AgentMessage {
                    id: format!("m{i}"),
                    role: if i % 2 == 0 {
                        AgentMessageRole::User
                    } else {
                        AgentMessageRole::Assistant
                    },
                    created_at: "2026-08-03T10:00:00.000Z".to_string(),
                    blocks: vec![AgentMessageBlock::Text {
                        text: "字".repeat(n),
                    }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                })
            })
            .collect();
        assert!(
            !maybe_compact_preflight(&mut state).await,
            "压缩产物协议形状违规（无 system 且链后首条非 user）→ 必须跳过压缩"
        );
        assert_eq!(state.compactions_this_run, 0, "护栏拦下不得计数");
        assert!(
            state
                .events
                .iter()
                .all(|e| !matches!(e, AgentEvent::ContextCompressionEnd { .. })),
            "护栏拦下不得广播压缩事件"
        );
    }

    /// T-31/T-32 织入集成（真实预检压缩 stub 路径）：
    /// 1) record.details 含 camelCase 五键（blockId/generation/prevBlockId/
    ///    droppedAtMs/summaryState）；
    /// 2) record.cache_boundary 非 None 且 stable_prefix_hash 非空
    ///    （system+链签名，T-31）；
    /// 3) tracker.rebuild_signature 已捕获（capture_post_compaction 接线）；
    /// 4) 后台退避任务经单飞 spawn——重试时摘要器收到与同步尝试同源的
    ///    丢弃消息（dropped_for_retry 对话替换前捕获）
    #[tokio::test]
    async fn compaction_wires_block_details_boundary_and_background_retry() {
        use std::sync::Mutex;
        /// 首次同步失败（降级 stub）→ 后台重试成功；记录每次收到的
        /// 丢弃消息 id 清单（验证重试与同步同源）
        struct FailsThenSucceeds {
            calls: Arc<Mutex<Vec<Vec<String>>>>,
        }
        impl Summarizer for FailsThenSucceeds {
            fn summarize(
                &self,
                dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                let ids: Vec<String> = dropped.iter().map(|m| m.id.clone()).collect();
                let mut calls = self.calls.lock().unwrap();
                calls.push(ids);
                if calls.len() == 1 {
                    return Err("首次同步失败（模拟 L2 降级）".to_string());
                }
                Ok(serde_json::json!({
                    "schemaVersion": 1,
                    "blockId": "compacted-summary-1-1",
                    "generation": 1,
                    "droppedIds": [],
                    "height": 1,
                    "tier": "chunk",
                    "goal": "后台重试成功",
                    "constraints": [],
                    "progress": [],
                    "decisions": [],
                    "nextSteps": [],
                    "criticalContext": [],
                })
                .to_string())
            }
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let summarizer = Arc::new(FailsThenSucceeds { calls: calls.clone() });
        let mut state = test_state(SessionLoopOptions {
            summarizer: Some(summarizer.clone()),
            // 快速退避注入（单飞任务 1ms 后即重试，测试等 300ms 收口）
            summary_dispatch: Some(crate::r#loop::summary_dispatch::SummaryDispatchConfig {
                backoff_ms: vec![1, 1, 1],
                jitter: 0.0,
                max_wall_ms: 5_000,
                max_attempts: 4,
            }),
            cache_tracking: Some(crate::cache_tracker::CacheTrackingConfig {
                provider: "deepseek".into(),
                model: "deepseek-v4-flash".into(),
                ttl_seconds: 60,
            }),
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(
            maybe_compact_preflight(&mut state).await,
            "stub 路径压缩必须完成"
        );
        // 1) details camelCase 五键（T-17 载荷 + T-31 织入）
        let record = compression_record(&state).expect("必须有压缩记录");
        let details = record.details.as_ref().expect("details 必须织入（T-31）");
        assert_eq!(
            details.get("blockId"),
            Some(&serde_json::json!("compacted-summary-1-1")),
            "blockId 必须为 R-B 格式 compacted-summary-gen-fold"
        );
        assert_eq!(details.get("generation"), Some(&serde_json::json!(1)));
        assert_eq!(
            details.get("prevBlockId"),
            Some(&serde_json::Value::Null),
            "首块 prevBlockId = None（fold_chain_prev=0）"
        );
        assert!(
            details.get("droppedAtMs").and_then(|v| v.as_i64()).is_some(),
            "droppedAtMs 必须为 epoch 毫秒"
        );
        assert_eq!(details.get("summaryState"), Some(&serde_json::json!("awaiting")));
        // 2) cache_boundary 非 None + stable_prefix_hash（system+链签名）
        let boundary = record
            .cache_boundary
            .as_ref()
            .expect("cache_boundary 必须填充（T-31）");
        assert_eq!(boundary.kind, "context-compression-cache-boundary");
        assert_eq!(boundary.version, 1);
        assert!(
            !boundary.stable_prefix_hash.is_empty(),
            "stable_prefix_hash = system+链哈希（稳定前缀身份）"
        );
        // 3) rebuild_signature 已捕获（capture_post_compaction 接线）
        assert!(
            state
                .cache_tracker
                .as_ref()
                .expect("已配置 tracker")
                .rebuild_signature()
                .is_some(),
            "压缩后重建签名必须已捕获（T-31）"
        );
        // 4) 后台单飞任务 spawn 且重试收到同源丢弃消息（T-32）
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let recorded = calls.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2, "同步 1 次 + 后台退避重试 1 次");
        assert_eq!(
            recorded[1], recorded[0],
            "后台重试必须收到与同步尝试同源的丢弃消息（dropped_for_retry 对话替换前捕获）"
        );
        assert_eq!(recorded[0].len(), 8, "丢弃 8 条消息全部进入重试任务");
    }
}
