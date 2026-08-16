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
use conex_compaction::compaction::StubPolicy;
use conex_compaction::{CompactionEngine, CompactionPlan, EstimateContext, Summarizer};
use conex_types::context::ContextBudget;
use conex_types::error::codes;
use conex_types::events::{AgentEvent, TurnUsage};
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

use super::end::{EndDecision, ProviderErrorSummary};
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

/// 重试等待延迟注入函数（D1 §3.1.2 注入面签名：本次尝试序号、Retry-After
/// 毫秒 → 等待时长；测试注入确定性延迟，零真实等待不依赖 tokio pause）
pub(crate) type RetryDelayFn = Box<dyn Fn(u32, Option<u64>) -> std::time::Duration + Send + Sync>;

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
    /// 瞬态重试预算起点（D1 §3.1.4 R1）：首次瞬态错误时惰性初始化
    /// （[std::option::Option::get_or_insert]）；fresh run 归零（loop/mod.rs
    /// run 起始同批）；预算 = 起点以来墙钟，超 [crate::r#loop::stream_error::RETRY_TOTAL_BUDGET_MS]
    /// 即停止重试（与 [Self::retry_delay] 注入面配合，测试零真实等待）。
    pub(crate) transient_retry_started_at: Option<tokio::time::Instant>,
    /// 重试等待延迟注入点（D1 §3.1.2，测试专用注入面）：Some = 完全替代
    /// 退避计算（签名：本次尝试序号、Retry-After 毫秒 → 等待时长；不做
    /// 预算钳制——注入值即最终等待）；None = 生产路径（[SessionLoopOptions::retry_backoff]
    /// 配置 + [crate::r#loop::stream_error::retry_delay_ms] 纯函数）。
    /// 注入返回 Duration::ZERO 即立即重试（测试驱动零真实等待，不依赖
    /// tokio pause）。生产永远 None。
    pub(crate) retry_delay: Option<RetryDelayFn>,
    /// fatal 收场的 provider 错误摘要（D1 §3.4）：[stream_error::fatal_provider_error]
    /// 填充（kind/retryable/retry_after_ms/retries 四元组），converge 时
    /// `mem::take` 零拷贝移交 [crate::r#loop::RunOutcome::provider_error]；
    /// fresh run 归零。None = 无 provider fatal（正常 stop / 非 provider 错误）。
    pub(crate) terminal_provider_error: Option<ProviderErrorSummary>,
    /// continue nudge 已用次数（上限 1，01 §2.6 步骤 1）
    pub(crate) continue_nudges: u32,
    /// error 收场时的错误文案（turn-complete 收敛读取）
    pub(crate) terminal_error: Option<String>,
    /// 当前已发射 turn-start 的轮次（EV-08 孤儿 turn-start 修复）：TurnStart
    /// 发射（prepare_turn）置 Some、TurnEnd 正常发射（turn_complete）清 None；
    /// 收敛路径未走 turn_complete 时经 [emit_missing_turn_end] 补发闭合——
    /// 「turn 对恒成对」不变量载体。None = 无未闭合 turn。
    pub(crate) current_turn_index: Option<u32>,
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
    /// 单 run 压缩次数（P4 §3.4.6）：预检触发与用户消息边界/分阶段触发
    /// 共用计数，上限 max_auto_compactions_per_run（默认 1）；**溢出阶梯
    /// 绕开本计数**（E2 F2 层 2：溢出自有 compression_retries 防死循环，
    /// 预检不再饿死溢出恢复，DEEPCHECK-11 §7 冲突 1）；run 起始归零。
    pub(crate) compactions_this_run: u32,
    /// 溢出压缩重试计数（P4 §3.5，上限 [SessionLoopOptions::compact_overflow_retries]
    /// 默认 2）：T-34 压缩阶梯（ContextLengthExceeded / PayloadTooLarge
    /// 恢复）消费；**绕开预检共享计数**（E2 F2 层 2：max_auto_compactions_per_run
    /// 仅约束预检/边界/分阶段，溢出自有本计数防死循环）。本任务只提供
    /// 字段与归零点。
    pub(crate) compression_retries: u32,
    /// 溢出压缩因 LLM 摘要不可用而未压缩（E2 F1 L3）：compression_ladder
    /// 在 plan.llm_unavailable 且无豁免时置 true，fatal 文案经
    /// compression_fatal_note 输出「LLM 不可用」附注（显式失败不静默丢语义，
    /// 信息分级约束 C：经 runtime-error 事件呈现，不进对话）；fresh run
    /// 归零（loop/mod.rs run 起始同批）。
    pub(crate) overflow_llm_unavailable: bool,
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
    /// E2 F3：最近一次压缩的摘要待重试快照（用户消息边界被动触发点素材，
    /// 07 方案 §2.4 断言 4）。[apply_compaction] 产出 stub 时记录（与后台
    /// 任务同一入参源）；用户消息边界经 [maybe_retry_pending_summary] 重建
    /// 任务单飞触发——判定「对话中仍存在该块 stub 消息」为待重试。块已被
    /// 替换 / 清理则自然失效。fresh run 不重置（跨 run 待重试语义延续，
    /// 与 summary_coordinator 任务存活语义对齐）。None = 无待重试摘要。
    pub(crate) pending_summary_retry: Option<PendingSummaryRetry>,
    /// 当前轮 usage 槽位（EV-11/D-03：streaming consume 后写入本 turn 六字段
    /// 真值，prepare_turn 新一轮归零，turn_complete 收口注入 TurnEnd.usage；
    /// None = provider 未报告 usage / 本轮未发请求——诚实留空，旧帧兼容）
    pub(crate) turn_usage: Option<TurnUsage>,
    /// Tool-Promise 自愈触发次数计数（RUL-02：上限 2 次，防死循环）
    pub(crate) tool_promise_heals: u32,
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
            options.summary_dispatch.clone().unwrap_or_default(),
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
            tool_promise_heals: 0,
            transient_retries: 0,
            // D1：预算起点空（首次瞬态错误惰性初始化）、延迟注入面空
            //（生产走 retry_backoff 配置）、fatal 摘要空（无 provider fatal）
            transient_retry_started_at: None,
            retry_delay: None,
            terminal_provider_error: None,
            continue_nudges: 0,
            terminal_error: None,
            // EV-08：fresh state 无未闭合 turn（孤儿 turn-start 修复初始位）
            current_turn_index: None,
            budget,
            compaction_policy,
            summarizer,
            // 护栏初始态：时间戳护栏空（无压缩边界）、计数 0（fresh run）
            last_compaction_at: None,
            compactions_this_run: 0,
            compression_retries: 0,
            // E2 F1 L3：溢出 LLM 不可用标记初始 false（无 fatal 前恒为假）
            overflow_llm_unavailable: false,
            cache_tracker,
            summary_dispatch,
            summary_coordinator,
            // E2 F3：无待重试摘要（fresh state）
            pending_summary_retry: None,
            // EV-11（D-03）：当前轮 usage 槽位初始空（provider 未报告前无数据）
            turn_usage: None,
        }
    }

    /// 统一单点事件发射：同时推入持久化事件轨与实时通知轨（保证严格因果序）
    pub(crate) fn emit_event(&mut self, event: AgentEvent) {
        self.events.push(event.clone());
        if let Some(sink) = &self.options.live_sink {
            sink.push_live(event);
        }
    }

    /// 仅推入实时轨（用于 MessageDelta 等非持久化流式事件）
    #[allow(dead_code)]
    pub(crate) fn emit_live_only(&self, event: AgentEvent) {
        if let Some(sink) = &self.options.live_sink {
            sink.push_live(event);
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
    // EV-12 删点：消息出队被消费成为 message-start → 删除待处理输入行
    //（fire-and-forget fail-open；未落库的内部消息 delete 无行可删，
    // 幂等无害——对应「每条用户消息 1 DELETE」）
    if let Some(store) = &state.options.pending_input_store {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let store = Arc::clone(store);
            let id = message.id.clone();
            handle.spawn(async move {
                if let Err(err) = store.delete_pending_input(&id).await {
                    tracing::warn!(
                        target: "session_loop",
                        message_id = %id,
                        error = %err,
                        "待处理输入删除失败（fail-open：不阻断消费）"
                    );
                }
            });
        }
    }
    let session_id = state.machine.context().session_id.clone();
    let message = Arc::new(message);
    state.emit_event(AgentEvent::MessageStart {
        session_id: session_id.clone(),
        message: message.clone(),
    });
    state.conversation.push(message.clone());
    state.emit_event(AgentEvent::MessageEnd {
        session_id,
        message,
        // G4 / 04 §5.2-5：消息带当前轮次上下文（user 消息在 turn-start 前
        // 消费，携带递增前值；assistant 收口在 streaming.rs 递增后，同值
        // turn-start/turn-end）。前端仅对 assistant 消息按 turnIndex 分段。
        turn_index: Some(state.machine.context().turn_index),
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
    if conversation
        .iter()
        .any(|m| m.role == AgentMessageRole::System)
    {
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
    if let Some(idx) = conversation
        .iter()
        .position(|m| m.role != AgentMessageRole::System && !m.id.starts_with("compacted-summary"))
    {
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

/// EV-03（D-03）：steering 计数重置观测点——重置前后计数进
/// steering-evaluated(reset=true) 事件（Delta 可丢）。
///
/// 重置时机（01 §3.3）：工具批全部成功 / length 升级 / 无 tool-call 正常结束。
/// phase 取值：`after-tools`（工具批后）、`length-escalation`（length 阶梯）、
/// `no-tool-calls`（纯文字正常结束）。
pub(crate) fn emit_steering_reset_event(state: &mut LoopState, phase: &str) {
    let before = state.steering.get_steering_count() as u32;
    state.steering.reset();
    let trace = crate::steering::SteeringEvaluationTrace::reset(before);
    state.emit_event(crate::steering::steering_evaluated_event(
        &state.machine.context().session_id,
        phase,
        &trace,
        Some(state.steering.budget_remaining()),
        true,
    ));
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

/// 孤儿 turn-start 兜底补发（EV-08 单点）：当前轮次 turn-start 已发射但
/// 本收敛路径未走 turn_complete 正常发射 turn-end（abort / 强停 /
/// check_control 收敛等）时，补发 turn-end 闭合——保证「turn 对恒成对」
/// 不变量。
///
/// **幂等**：[LoopState::current_turn_index] 为 None 时不发（正常发射已清
/// 位）；补发后清位，多次调用无副作用——各收敛路径挂接与 converge 最终
/// 兜底可并存，互不重复发射。
///
/// 载荷对齐 turn_complete 正常发射（D-03 契约）：turn_index 与 turn-start
/// 一致（取记录值而非 context——避免与已发射 turn-start 显示值漂移）、
/// tool_call_count 取当前批计数、usage 保持 None（EV-13 接线前契约位）。
pub(crate) fn emit_missing_turn_end(state: &mut LoopState) {
    let Some(turn_index) = state.current_turn_index.take() else {
        return;
    };
    let end_event = AgentEvent::TurnEnd {
        session_id: state.machine.context().session_id.clone(),
        turn_index,
        timestamp: crate::steering::now_iso_utc(),
        tool_call_count: state.machine.context().tool_call_count,
        usage: None,
    };
    state.emit_event(end_event);
    tracing::info!(
        turn_index,
        "收敛路径未走 turn-complete：补发 turn-end 闭合孤儿 turn-start（EV-08）"
    );
}

/// 安全点统一检查：handler 起始与 stream / tool 批结束调用。
///
/// 返回 [Some] 表示 run 已可收敛（force_cancel / cooperative_stop），
/// [None] 表示继续（soft_inject 只读消费后消息已落环）。
pub(crate) fn check_control(state: &mut LoopState) -> Result<Option<EndDecision>, LoopError> {
    // AbortSignal 等价 L3 强停，优先于总线内任何意图（01 §2.10）
    let (action, drained) = {
        let mut bus = state.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        let action = apply_safe_point_control(&mut bus, Some(&state.abort_signal));
        // EV-04（D-03）：本次安全点消费的意图轨迹（enqueued 态事件素材）——
        // abort 抢占路径（未 drain，意图原样保留）不取走，下次安全点
        // enqueued→consumed 统一配对发射，不丢轨迹不重复
        let trace = if state.abort_signal.is_aborted() {
            Vec::new()
        } else {
            bus.take_trace()
        };
        (action, trace)
    };
    let Some(action) = action else {
        return Ok(None);
    };
    // EV-04（D-03）：control-intent 两态发射——enqueued 先、consumed 后，
    // intent_id 两态配对（Delta 可丢观测事件；软注入消息本体不入事件，
    // message-start/end 已可见；cooperative_stop 的 reason 经 intent 透出，
    // 不再丢弃）
    let session_id = state.machine.context().session_id.clone();
    for intent in &drained {
        state.events.push(AgentEvent::ControlIntent {
            session_id: session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            kind: intent.kind.as_event_kind().to_string(),
            intent_id: intent.id.clone(),
            source: intent.source.clone(),
            reason: intent.reason.clone(),
            state: "enqueued".to_string(),
        });
    }
    for intent in &drained {
        state.events.push(AgentEvent::ControlIntent {
            session_id: session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            kind: intent.kind.as_event_kind().to_string(),
            intent_id: intent.id.clone(),
            source: intent.source.clone(),
            reason: intent.reason.clone(),
            state: "consumed".to_string(),
        });
    }
    // EV-08：收敛分支统一兜底——check_control 收敛路径（含 turn-complete
    // 起始，turn-end 尚未正常发射）不经 turn_complete，此处单点补发闭合
    // 孤儿 turn-start（current_turn_index 为 None 时幂等无操作）
    emit_missing_turn_end(state);
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

/// 取最后一条 assistant 消息（用于 Tool-Promise 自愈意图检测）
pub(crate) fn last_assistant_message(
    state: &LoopState,
) -> Option<&Arc<conex_types::message::AgentMessage>> {
    state
        .conversation
        .iter()
        .rev()
        .find(|m| m.role == AgentMessageRole::Assistant)
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
            summarizer: Some(Arc::new(StubSummaryGuard)),
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

    /// 合法 Schema V1 JSON 文档（R-G 契约；测试摘要器成功输出面）
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

    /// 恒成功摘要器（测试辅助：LLM 可用面）
    struct StubSummaryGuard;
    impl Summarizer for StubSummaryGuard {
        fn summarize(
            &self,
            _dropped: &[AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            Ok(valid_summary_json("compacted-summary-1-1"))
        }
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

    // ── E2 F3 用户消息边界（hold → compact → append）──────────────

    /// E2 F3：边界触发压缩（trigger=UserMessage）——hold 消息不进压缩
    /// 输入：压缩前后对话尾部 = 用户消息原文（逐字节相等），用户消息
    /// 恒在发送序列尾部、绝不在 dropped_ids（07 方案 §2.4 断言 1/2）
    #[tokio::test]
    async fn user_boundary_compacts_when_over_threshold_and_holds_message() {
        let mut state = test_state(SessionLoopOptions {
            // E2 F1 L1：LLM 摘要强制——注入可用 Summarizer（合法 Schema V1）
            summarizer: Some(Arc::new(StubSummaryGuard)),
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        // 模拟 hold 消息（prepare_turn 步骤 2：dequeue 后未 record_message
        // 即调用本函数——压缩对 hold 消息透明）
        let held = Arc::new(AgentMessage {
            id: "user-hold".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "hold 消息原文".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        });
        // 边界压缩（对话不含 hold 消息）
        assert!(
            maybe_compact_user_boundary(&mut state).await,
            "超阈值必须边界压缩"
        );
        assert_eq!(state.compactions_this_run, 1);
        // append：用户消息入对话尾部
        state.conversation.push(held.clone());
        // 压缩前后对话尾部 = 用户消息原文（逐字节相等）
        assert_eq!(
            state.conversation.last().map(|m| m.text()),
            Some("hold 消息原文".to_string()),
            "用户消息必在发送序列尾部（压缩对 hold 消息透明）"
        );
        // 用户消息绝不在 dropped_ids（100% 保留）——压缩对 hold 消息
        // 透明：用户消息未参与压缩（未入对话），append 后恒在对话尾部
        let record = compression_record(&state).expect("必须携带压缩记录");
        assert!(
            !record
                .compressed_message_ids
                .contains(&"user-hold".to_string()),
            "用户消息绝不在 dropped_ids"
        );
    }

    /// E2 F3：trigger=UserMessage 事件广播（Start.reason / End.record.trigger
    /// / reason 字段），policy 归 proactive（07 方案 §2.4 断言 2）
    #[tokio::test]
    async fn user_boundary_events_carry_usermessage_trigger() {
        let mut state = test_state(SessionLoopOptions {
            summarizer: Some(Arc::new(StubSummaryGuard)),
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(maybe_compact_user_boundary(&mut state).await);
        // Start 事件：reason = "usermessage"
        let start_reason = state
            .events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ContextCompressionStart { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .expect("必须有压缩开始事件");
        assert_eq!(start_reason, "usermessage");
        // End 事件 record：trigger/reason = UserMessage
        let record = compression_record(&state).expect("必须有压缩记录");
        assert_eq!(record.trigger, ContextCompressionTrigger::UserMessage);
        assert_eq!(record.reason, Some(ContextCompressionReason::UserMessage));
        let policy = record.policy.expect("必须携带策略元数据");
        assert_eq!(policy.tier, ContextCompressionPolicyTier::Proactive);
    }

    /// E2 F3：未超阈值 → 不压缩、无事件、不计数（行为与压缩前一致）；
    /// 无预算配置 → 不触发（07 方案 §2.4 断言「未超阈值行为不变」）
    #[tokio::test]
    async fn user_boundary_skips_under_threshold() {
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
        assert!(
            !maybe_compact_user_boundary(&mut state).await,
            "未超阈值不得边界压缩"
        );
        assert_eq!(state.compactions_this_run, 0);
        assert!(state.events.is_empty(), "未触发不得广播任何事件");
        // 无预算配置（默认 options 全 None）→ 不触发
        let mut state = test_state(SessionLoopOptions::default());
        state.conversation = big_conversation();
        assert!(!maybe_compact_user_boundary(&mut state).await);
        assert!(state.events.is_empty());
    }

    /// E2 F3：LLM 摘要不可用（compact_require_llm=true 且无 Summarizer）→
    /// 不压缩、不计数（预检仍可再试）、消息照常发送（边界不阻塞），发
    /// runtime-intervention-required 事件（07 方案 §2.4 断言 2）
    #[tokio::test]
    async fn user_boundary_llm_unavailable_skips_but_sends_message() {
        let mut state = test_state(SessionLoopOptions {
            summarizer: None,
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(
            !maybe_compact_user_boundary(&mut state).await,
            "LLM 摘要不可用 → 不压缩"
        );
        assert_eq!(state.compactions_this_run, 0, "不消耗单 run 计数");
        // 事件面提示（信息分级约束 C：事件呈现，不进对话）
        assert!(
            state
                .events
                .iter()
                .any(|e| matches!(e, AgentEvent::RuntimeInterventionRequired { .. })),
            "LLM 不可用必须发 runtime-intervention-required 事件"
        );
        // 豁免开启（compact_allow_stub_fallback=true）→ 降级 stub 压缩完成
        let mut state = test_state(SessionLoopOptions {
            summarizer: None,
            compact_allow_stub_fallback: true,
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(
            maybe_compact_user_boundary(&mut state).await,
            "豁免开启 → stub 压缩照常执行"
        );
    }

    /// E2 F3：边界压缩与预检共享单 run 计数——边界压缩消耗计数后，同
    /// turn 预检因计数封顶自然跳过；边界未压缩（LLM 不可用）不消耗计数，
    /// 预检可再试（07 方案 §2.1 / E2 §4.3 优先级表）
    #[tokio::test]
    async fn user_boundary_compaction_consumes_shared_run_limit() {
        let mut state = test_state(budgeted_options());
        state.conversation = big_conversation();
        assert!(maybe_compact_user_boundary(&mut state).await);
        assert_eq!(state.compactions_this_run, 1);
        // 同 turn 预检：对话重新膨胀但计数已封顶 → 自然跳过
        state.conversation = big_conversation();
        assert!(
            !maybe_compact_preflight(&mut state).await,
            "边界压缩后预检因计数封顶跳过"
        );
        // 反向：边界未压缩（LLM 不可用）不消耗计数 → 预检可再试
        let mut state = test_state(SessionLoopOptions {
            summarizer: None,
            ..budgeted_options()
        });
        state.conversation = big_conversation();
        assert!(!maybe_compact_user_boundary(&mut state).await);
        assert_eq!(state.compactions_this_run, 0);
        let mut state = test_state(budgeted_options());
        state.conversation = big_conversation();
        assert!(
            maybe_compact_preflight(&mut state).await,
            "边界未压缩不消耗计数 → 预检仍可压缩"
        );
    }

    /// E2 F3：摘要待重试被动触发点（07 方案 §2.4 断言 4）——压缩产出
    /// stub 后（摘要失败），用户消息边界（未超阈值）经
    /// [maybe_retry_pending_summary] 重建任务单飞触发，摘要器被再次调用
    #[tokio::test]
    async fn user_boundary_retries_pending_summary() {
        /// 恒失败摘要器（同步失败 → stub；后台任务重试全部失败 → retired）
        struct AlwaysFailSummarizer {
            calls: Arc<std::sync::Mutex<usize>>,
        }
        impl Summarizer for AlwaysFailSummarizer {
            fn summarize(
                &self,
                _dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                *self.calls.lock().unwrap() += 1;
                Err("摘要持续失败（模拟待重试）".to_string())
            }
        }
        let calls = Arc::new(std::sync::Mutex::new(0usize));
        let state = test_state(SessionLoopOptions {
            summarizer: Some(Arc::new(AlwaysFailSummarizer {
                calls: calls.clone(),
            })),
            // 豁免开启（E2 F1 L3）：同步摘要失败 → 降级 stub（awaiting 块），
            // 供被动摘要重试点消费（F1 强制默认路径下失败不落 stub）
            compact_allow_stub_fallback: true,
            summary_dispatch: Some(crate::r#loop::summary_dispatch::SummaryDispatchConfig {
                backoff_ms: vec![1, 1, 1],
                jitter: 0.0,
                max_wall_ms: 5_000,
                max_attempts: 4,
            }),
            ..budgeted_options()
        });
        // 首轮边界压缩（超阈值）：同步摘要失败 → stub + 待重试快照 +
        // 后台任务登记
        let mut state = state;
        state.conversation = big_conversation();
        assert!(maybe_compact_user_boundary(&mut state).await);
        assert_eq!(*calls.lock().unwrap(), 1, "同步一次摘要尝试");
        assert!(
            state.pending_summary_retry.is_some(),
            "产出 stub 必须记录待重试快照"
        );
        // 等首轮后台任务结束（恒失败 → retired，快退避 1ms×3）
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let after_first = *calls.lock().unwrap();
        assert!(after_first >= 2, "后台退避重试必须已发生：{after_first}");
        // 边界被动触发：对话含 stub（块仍待重试）+ 短消息（未超阈值）
        // → 不压缩但触发补摘要（摘要器调用次数继续增长）
        state.conversation = vec![
            Arc::new(AgentMessage {
                id: "compacted-summary-1-1".to_string(),
                role: AgentMessageRole::Assistant,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "[Compacted(compacted-summary-1-1) 8 条消息 · 摘要见块表]".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            }),
            Arc::new(AgentMessage {
                id: "m8".to_string(),
                role: AgentMessageRole::User,
                created_at: "2026-08-03T10:00:00.000Z".to_string(),
                blocks: vec![AgentMessageBlock::Text {
                    text: "短消息".to_string(),
                }],
                metadata: None,
                client_message_id: None,
                content: None,
            }),
        ];
        assert!(
            !maybe_compact_user_boundary(&mut state).await,
            "未超阈值不压缩"
        );
        assert_eq!(state.compactions_this_run, 1, "被动重试不消耗压缩计数");
        // 等被动重试任务完成（退避 1ms×3 + 调用）
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let total = *calls.lock().unwrap();
        assert!(
            total >= after_first + 1,
            "用户消息边界必须触发被动摘要重试（{after_first} → {total}）"
        );
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
            llm_unavailable: false,
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
            llm_unavailable: false,
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
            state
                .cache_tracker
                .as_ref()
                .unwrap()
                .rebuild_signature()
                .is_some(),
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
                compact_allow_stub_fallback: true,
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
            msg(
                AgentMessageRole::User,
                Some("timeline"),
                "当前时间：2026-08-03 18:00:00\n继续",
            ),
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
            msg(
                AgentMessageRole::System,
                Some("timeline"),
                "时间线注入进 system",
            ),
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
        assert!(!compaction_shape_ok(&[msg(
            "s1",
            AgentMessageRole::Assistant
        )]));
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
        let summarizer = Arc::new(FailsThenSucceeds {
            calls: calls.clone(),
        });
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
            compact_allow_stub_fallback: true,
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
            details
                .get("droppedAtMs")
                .and_then(|v| v.as_i64())
                .is_some(),
            "droppedAtMs 必须为 epoch 毫秒"
        );
        assert_eq!(
            details.get("summaryState"),
            Some(&serde_json::json!("awaiting"))
        );
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
