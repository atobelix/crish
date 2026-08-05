//! run 主循环（任务书 B3.4，对齐 01 §2.1 / §五.1-10）
//!
//! [AgentSessionLoop] 持有全部运行组件并驱动 8 个 handler：
//! - 状态机（[crate::state::AgentSessionMachine]，B3.1）；
//! - 三环输入队列（[crate::input::AgentInputQueue]，B3.2）；
//! - 控制总线 + 安全点（[crate::control::ControlBus] / [crate::safe_point]，B3.2）；
//! - steering 协调器（[crate::steering::SteeringCoordinator]，B3.3）；
//! - 工具执行器（[crate::tool_exec::ToolExecutor] + [agent_tools::registry::ToolRegistry]，
//!   B3.5）；
//! - 对话（[conex_types::message::AgentMessage] 列表，跨 run 持久）；
//! - provider 回调（[crate::provider::ProviderCall] trait 解耦，不直接依赖
//!   agent-provider；测试用 [crate::testing::TestProvider]）。
//!
//! run() 主循环（01 §2.1）：用户消息入队 → INITIALIZED → agent-start →
//! `while !done` 按当前状态分派 handler；任一 handler 返回 [EndDecision] 即收敛。
//! catch 兜底：handler 抛错 → 恢复钩子裁决（retry/skip/abort，01 §2.1 步骤 4）；
//! abort 类 → aborted，否则 error 收场。
//!
//! 收口决策（01 §五.2）：错误收场仅由 ERROR / PROVIDER_ERROR 产生
//! （INTERVENTION_REQUIRED / STEERING_BUDGET_EXHAUSTED 按 D7/D9 裁决收敛为
//! stop + 诊断）；cooperative_stop → stopped（D1）；max-turns 为独立预算
//! reason（01 §1.5）。

use std::path::PathBuf;
use std::sync::Arc;

use agent_tools::backup::BackupMiddleware;
use agent_tools::context::ExploreDocsQuotaContext;
use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::middleware::ToolMiddleware;
use agent_tools::registry::ToolRegistry;
use agent_tools::write_paths::WritePathRegistry;
use async_trait::async_trait;
use conex_compaction::{CompactionPolicy, Summarizer};
use conex_types::context::ContextBudget;
use conex_types::error::{codes, CrishError};
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S, AgentSessionState};

use crate::cache_tracker::{build_tracker, CacheStatsTracker, CacheTrackingConfig};
use crate::escape_watch::EscapeWatchConfig;
use crate::provider::{DeltaSink, ProviderCall};
use crate::steering::{
    RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
};
use crate::tool_events::{ApprovalGate, ToolBatchOptions};
use crate::tool_exec::{ToolExecCtx, ToolExecutor};
use crate::undeclared_detector::RegistryBackedDetector;

mod end;
mod handlers;

#[cfg(test)]
mod invariants;

pub use end::{EndDecision, RunOutcome};

/// length 阶梯起点（8192 → 16384 → 32768，01 §2.6 步骤 1）
pub const DEFAULT_MAX_TOKENS: u32 = 8192;

/// 循环内部错误（catch 兜底输入；正常路径不触发）
///
/// T06.5.1（AA-01 Q29）：携带结构化 [CrishError]（77 码 + category/retryable），
/// 错误码/可重试性不再在 catch 兜底处丢失；`message` 保持人读文案。
#[derive(Debug, Clone)]
pub(crate) struct LoopError {
    /// 结构化错误（码 / category / retryable / message）
    crish: CrishError,
}

impl LoopError {
    /// 内部错误（状态机不一致等防御性路径）→ runtime.unexpected_state
    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::with_code(codes::RUNTIME_UNEXPECTED_STATE, message)
    }

    /// 显式码构造（T06.5.1：错误码显式选择，不再裸 String 兜底）
    pub(crate) fn with_code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            crish: CrishError::new(code, message),
        }
    }

    /// 结构化错误引用（RecoveryHook::decide 输入，F6）
    pub(crate) fn crish(&self) -> &CrishError {
        &self.crish
    }

    /// 错误文案
    pub(crate) fn message(&self) -> &str {
        &self.crish.message
    }
}

/// lifecycle turn.end 钩子上下文
#[derive(Debug, Clone)]
pub struct TurnEndContext {
    /// 会话标识
    pub session_id: String,
    /// 当前轮次
    pub turn_index: u32,
    /// 当前轮工具调用数
    pub tool_call_count: u32,
}

/// lifecycle turn.end 钩子（01 §2.9 步骤 1：可返回 stop 建议）
///
/// 遗留问题 3：与 shouldStopAfterTurn 合并时以 turn.end 为准，
/// shouldStopAfterTurn 仅作无 turn.end 时的兼容层。
#[async_trait]
pub trait TurnEndHook: Send + Sync {
    /// 返回 true 表示建议 stop（cooperative，不 abort）
    fn on_turn_end(&self, context: &TurnEndContext) -> bool;
}

/// catch 兜底的恢复决策（01 §2.1 步骤 4：hook.onError 裁决 retry/skip/abort）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDecision {
    /// 重试：NO_PROGRESS_CONTINUE 重进 provider 循环（仅 streaming 有效）
    Retry,
    /// 跳过本轮：streaming 下按 NO_TOOL_CALLS 正常收场
    Skip,
    /// 中止：endReason=aborted
    Abort,
}

/// 错误恢复钩子（catch 兜底裁决；缺省：abort 信号 → Abort，否则 error 收场）
///
/// F6 冻结签名（AU-04）：`decide(&CrishError, state)`——恢复钩子基于码分类
/// 裁决而非文本匹配（T06.5.3）。
pub trait RecoveryHook: Send + Sync {
    /// 裁决错误处理方式
    fn decide(&self, error: &CrishError, state: AgentSessionState) -> RecoveryDecision;
}

/// 循环配置（恢复阶梯上限 / 钩子；缺省值对齐 01 §2.5-2.6 与 §3.3）
#[derive(Clone)]
pub struct SessionLoopOptions {
    /// 瞬态 provider 错误重试上限（默认 3，01 §2.5 步骤 2）
    pub transient_retry_limit: u32,
    /// length 阶梯升级上限（默认 2：8192→16384→32768）
    pub length_upgrade_limit: u32,
    /// continue nudge 上限（默认 1，01 §2.6 步骤 1）
    pub continue_nudge_limit: u32,
    /// preparing-turn / empty-response 的 steering 评估开关（默认 true，
    /// 01 §2.3 期望语义：干预性 steering 可配置关闭；false 时跳过策略
    /// 评估，empty-response 直接 stop + 诊断收场，见 T06.2.1 接线）
    pub steering_enabled: bool,
    /// lifecycle turn.end 钩子（stop 建议；与 shouldStopAfterTurn 合并时
    /// 以此为准，01 遗留问题 3）
    pub turn_end_hook: Option<Arc<dyn TurnEndHook>>,
    /// shouldStopAfterTurn 兼容层（无 turn_end_hook 时生效；01 遗留问题 3）。
    /// 生产暂无注入方，属「兼容层仅测试/编排注入用」面（T06.4.1 评审标注）
    pub should_stop_after_turn: Option<Arc<dyn TurnEndHook>>,
    /// catch 兜底恢复钩子（缺省：abort 信号 → Abort，否则 error）
    pub recovery_hook: Option<Arc<dyn RecoveryHook>>,
    /// 工具执行工作目录（ToolExecCtx 透传）
    pub cwd: Option<String>,
    /// 本次 run 的 assistant 消息客户端幂等键（03 §5.3-4：message-end 的
    /// clientMessageId 与 run-task 下发值一致，供前端 pickStableMessageId
    /// 命中本地 stream placeholder；None = 不标注，向后兼容）
    pub assistant_client_message_id: Option<String>,
    /// 工具幂等开关（默认 false，行为不变；T06.4.1 Q14 接线）。开启后
    /// AgentSessionLoop 创建 [agent_tools::idempotency::ToolIdempotencyGuard]
    /// 并注入工具执行器——同域（run_id+session_id）同参工具去重，失败不
    /// 记录、成功才落键；跨 run 生效（域与 run/session 绑定）。
    pub idempotency_enabled: bool,
    /// 工具中间件链（[agent_tools::middleware::ToolMiddleware]；审批通过后、
    /// 执行前生效，优先级语义见 tool_exec.rs 模块头注与
    /// docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md）。
    /// with_options 派生同步到工具执行器。
    pub tool_middleware: Vec<Arc<dyn ToolMiddleware>>,
    /// 插件钩子注册表（[crate::hooks::HookRegistry]；turn.end /
    /// tool.pre / tool.post 广播）。with_options 派生同步到工具执行器
    /// （tool.pre / tool.post）与 turn-complete handler（turn.end）。
    pub hooks: Option<Arc<crate::hooks::HookRegistry>>,
    /// 系统提示词（P1 阶段 2：system prompt 主路径透传，B1 四层通路第二层）。
    /// 属于请求静态前缀的一部分，run 内不可变（B3 纪律：构造后整轮复用，
    /// 任何 handler 不得在 run 中途改写）；None = 不发送 system 消息，
    /// 向后兼容。壳层在装配 options 时经 build_system_prompt 规范化后存入。
    pub system_prompt: Option<String>,
    /// 预算配置（P4 阶段 2-2 / §3.3.2）：None = 不启用 max_tokens 钳制与
    /// 预检压缩（向后兼容现状）；Some = 发请求前估算上下文占用
    /// （C9 口径 input_total，usage 优先 + 启发式兜底），max_tokens 钳到
    /// window - estimate - safety。窗口元数据真源为 P3 模型目录
    /// （context_window_for），P3 未接线前由壳层经前端参数注入。
    pub context_budget: Option<ContextBudget>,
    /// 压缩策略（P4 阶段 3-2 / §3.4.2）：None = 无自动压缩（向后兼容现状）；
    /// Some = prepare_turn 阈值预检触发（estimate ≥ window - reserve）时
    /// 同步压缩。字段默认对齐 P4 §3.4.2（keep_recent_tokens 20000 /
    /// min_recent_turns 2 / max_summary_tokens 1024 / tool_pair_protection）。
    pub compaction_policy: Option<CompactionPolicy>,
    /// L2 LLM 摘要器（P4 §3.4.4，可选注入）：None = L1 静态占位符。
    /// C14 摘要请求缓存隔离（独立前缀域、无断点、无会话亲和键）由
    /// 摘要器实现方（壳层）保证——本 trait 边界只接收丢弃消息与既有摘要，
    /// 不携带任何会话/缓存亲和参数；失败降级 L1 占位符不阻塞主对话。
    pub summarizer: Option<Arc<dyn Summarizer>>,
    /// 单 run 自动压缩上限（默认 1，对齐 Reasonix compactStuck 防每轮
    /// 重写前缀，P4 §3.4.6）：预检触发与溢出触发共用计数
    /// （LoopState.compactions_this_run），0 = 禁用自动压缩。
    pub max_auto_compactions_per_run: u32,
    /// 缓存跟踪配置（P5 S2 / T-36）：None = 不构造 CacheStatsTracker
    /// （无缓存测量，行为与现状一致）；Some = run 起始在 LoopState 构造 /
    /// 复位跟踪器（fresh run），run 内跨 turn 维护签名基线并聚合
    /// RunCacheStats（收口移交 RunOutcome.cache_stats）。provider / model /
    /// TTL 由壳层装配（engine 侧 SessionLoopProducer 构造，T-40 接线点；
    /// TTL 走 P3 cache_ttl_for_provider_model 查询，0 = 未知）。
    pub cache_tracking: Option<CacheTrackingConfig>,
    /// 写路径互斥注册表（I4-M3，总接线点 T-EG-06）：装配于
    /// [Self::with_options]——显式注入优先，缺省按工作区根新建（会话级，
    /// 与 workspace_root 同源）；经 tool_ctx 注入工具执行面（写类工具
    /// 声明互斥）。**装配时同时注入逃逸监视判定器**：经
    /// [crate::escape_watch::EscapeWatchConfig::with_detector] 挂载
    /// [crate::undeclared_detector::RegistryBackedDetector]，与工具执行
    /// 共享同一注册表实例（T-ESC-03 交接点，escape_watch.rs:17-24）。
    /// None = 由装配面按工作区根新建（非禁用）。
    pub write_claims: Option<Arc<WritePathRegistry>>,
    /// 探索类文档配额上下文（I6-M11 C5，总接线点 T-EG-06）：经 tool_ctx
    /// 注入工具执行面（read-only 子代理写文档配额检查，配额按会话计数）。
    /// None = 主 agent 不受配额约束（04 C5「主 agent 自身不消耗」；
    /// 子代理 run 的配额上下文由 spawner 装配，本字段承载主循环装配面）。
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    /// 产出目录解析服务（G01，T-EG-08）：resolve_output_dir 工具后端。
    /// None = 装配期按工作区根自动装配 [OutputWorkspace]（InMemory store，
    /// 会话内幂等；生产持久化后端由壳层注入 session_meta store——F11）。
    pub output_dir: Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>>,
    /// 父 run 归属（T-D-14 权限传递层，总接线点 T-EG-06）：经 tool_ctx
    /// 透传工具执行面——审批请求据此判定来源（子代理 run → 裁决者 =
    /// 主 agent；主 agent run → 裁决者 = 用户）。None = 主 agent run /
    /// 无父 run（现状）；子代理 run 的父 run 归属由 spawner（T-D-13）装配。
    pub parent_run_id: Option<String>,
    /// 逃逸监视装配配置（T-ESC-03 P3 装配面）：None = 不启用逃逸监视
    /// （现状行为）。装配上下文透传——壳层 run 起停钩子消费：run 开始
    /// 经 [crate::escape_watch::spawn_escape_watch] 启动监视并 spawn 消费
    /// 任务（聚合 → 审计发射 + 主 agent 注入），run 收口经
    /// [crate::escape_watch::EscapeWatchHandle::shutdown] 停止并 flush 剩余
    /// 事件；LoopState 不消费本字段（消费循环由壳层 spawn，见
    /// REQ-逃逸追踪分析 §3.5.1）。
    pub escape_watch: Option<EscapeWatchConfig>,
}

impl Default for SessionLoopOptions {
    fn default() -> Self {
        Self {
            transient_retry_limit: 3,
            length_upgrade_limit: 2,
            continue_nudge_limit: 1,
            steering_enabled: true,
            turn_end_hook: None,
            should_stop_after_turn: None,
            recovery_hook: None,
            cwd: None,
            assistant_client_message_id: None,
            idempotency_enabled: false,
            // T-EG-06（总接线点）：默认中间件链 = 写前自动备份（S10b）——
            // BackupMiddleware::with_defaults(None)，trash_root=None 执行期
            // 回退工作区 `.crish-trash`（与删除工具兜底同源）。壳层装配
            // 时可在 options 侧整体替换（如 core_run_commands.rs）。
            tool_middleware: vec![Arc::new(BackupMiddleware::with_defaults(None))
                as Arc<dyn ToolMiddleware>],
            hooks: None,
            system_prompt: None,
            // P4 阶段 2-2/3-2：预算与压缩配置全部缺省 None/1——未配置即现状
            // 行为（不钳制、不预检、无自动压缩，向后兼容）
            context_budget: None,
            compaction_policy: None,
            summarizer: None,
            max_auto_compactions_per_run: 1,
            // P5 S2 / T-36：缓存测量缺省关闭（未配置即现状行为）
            cache_tracking: None,
            // T-EG-06：注册表与配额上下文缺省 None——with_options 装配块
            // 负责按工作区根新建注册表并注入 ESC 判定器；配额 None =
            // 主 agent 不受配额约束（04 C5「主 agent 自身不消耗」）
            write_claims: None,
            explore_docs_quota: None,
            // T-EG-08：产出目录解析器缺省 None——with_options 装配块自动
            // 装配 OutputWorkspace（InMemory store，工作区根同源）
            output_dir: None,
            // T-D-14：父 run 归属缺省 None = 主 agent run（审批裁决者 =
            // 用户，现状行为；子代理 spawner 装配时显式注入）
            parent_run_id: None,
            // T-ESC-03：逃逸监视缺省关闭（未配置即现状行为）
            escape_watch: None,
        }
    }
}

/// 会话运行循环（B3.4 主循环）
///
/// 构造后多次调用 [Self::run]：每 run 创建全新状态机（idle → … → done），
/// 对话与输入队列跨 run 持久（nudge / followUp / steer 残留由下一条用户
/// 消息边界消费，01 D8）。
pub struct AgentSessionLoop {
    /// handler 共享状态（含状态机 / 队列 / 总线 / steering / 对话）
    state: handlers::LoopState,
    /// provider 回调（trait 解耦，测试用 TestProvider）
    provider: Box<dyn ProviderCall>,
    /// 工具批量执行器（B3.5）
    tool_executor: ToolExecutor,
    /// 工具执行上下文（runId / sessionId / cwd）
    tool_ctx: ToolExecCtx,
    /// 工具批量执行选项（超时 / 失败策略 / 审批开关）
    tool_options: ToolBatchOptions,
    /// 审批门（B4 编排层注入；None = 不启用审批）
    approval: Option<Arc<dyn ApprovalGate>>,
    /// 流式增量转发（T09.1 实时双轨；None = 不启用实时 delta 发射）
    delta_sink: Option<Arc<dyn DeltaSink>>,
    /// 会话标识（agent-start / 事件共用）
    session_id: String,
    /// 每 run 重建状态机用（max_turns 上限）
    max_turns: u32,
}

impl AgentSessionLoop {
    /// 新建主循环（默认 steering：RecoverySteeringStrategy + 默认预算；
    /// 默认恢复阶梯配置见 [SessionLoopOptions]）
    pub fn new(
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        max_turns: u32,
        provider: Box<dyn ProviderCall>,
        tool_registry: Arc<ToolRegistry>,
    ) -> Self {
        let session_id = session_id.into();
        let run_id = run_id.into();
        let options = SessionLoopOptions::default();
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let state = handlers::LoopState::new(
            session_id.clone(),
            max_turns,
            steering,
            options.clone(),
            tool_registry.clone(),
        );
        Self {
            state,
            provider,
            // T-EG-06：默认中间件链（写前自动备份）经 with_middleware 注入
            // 执行器——with_options 派生同步会整体替换链（options 同源）
            tool_executor: ToolExecutor::new(tool_registry)
                .with_middleware(options.tool_middleware.clone()),
            tool_ctx: ToolExecCtx {
                run_id,
                session_id: session_id.clone(),
                cwd: None,
                workspace_root: None,
            // I4-M3 / I6-M11 C5：写路径注册表与配额上下文装配在
            // with_options（总接线点 T-EG-06），构造期保持 None
            // （未装配 = 写工具不强制互斥 / 不检查配额，向后兼容）
            write_claims: None,
            explore_docs_quota: None,
            // T-D-14：父 run 归属随 with_options 装配（构造期 None =
            // 主 agent run，审批裁决者 = 用户，现状行为）
            parent_run_id: None,
            // T-EG-08：产出目录解析器随 with_options 装配（构造期 None）
            output_dir: None,
        },
            tool_options: ToolBatchOptions::default(),
            approval: None,
            delta_sink: None,
            session_id,
            max_turns,
        }
    }

    /// 覆盖循环配置（恢复阶梯上限 / 钩子 / steering 开关 / 幂等开关）。
    ///
    /// 派生状态同步（T06.4.4）：`cwd` → 工具执行上下文 `tool_ctx.cwd`；
    /// `idempotency_enabled` → 重建工具执行器（开启时创建幂等守卫并注入，
    /// 关闭时移除守卫）；`tool_middleware` / `hooks` → 同步到工具执行器。
    ///
    /// T-EG-06 引擎装配块（总接线点）：写路径注册表（互斥）按工作区根
    /// 解析链装配进 tool_ctx，同一注册表实例注入逃逸监视判定器；配额
    /// 上下文透传 tool_ctx。四线装配（write_paths / quota / middleware /
    /// ESC 判定器）在本方法一次完成。
    ///
    /// 顺序约束（Rust builder 语义，Option 字段构造期定）：`with_options` /
    /// `with_tool_options` / `with_approval` 必须在 `run()` 之前调用。
    pub fn with_options(mut self, mut options: SessionLoopOptions) -> Self {
        // ── 引擎装配块（T-EG-06：互斥 / 配额 / 中间件链 / ESC 判定器）──
        // 工作区根解析链：显式 workspace_root → options.cwd → 当前目录
        // （与 ToolContext.workspace_root 既有回退语义一致，
        // tool_exec.rs:684-690；None 时写工具无互斥基准，回退当前目录）
        let root = self
            .tool_ctx
            .workspace_root
            .clone()
            .or_else(|| options.cwd.clone().map(PathBuf::from))
            .unwrap_or_else(|| {
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
            });
        // 写路径互斥注册表（I4-M3）：显式注入 → 复用 tool_ctx 既有 →
        // 按根新建（会话级，与工作区根同源——工具执行面与 ESC 判定器
        // 共享同一实例）
        let registry = options
            .write_claims
            .clone()
            .or_else(|| self.tool_ctx.write_claims.clone())
            .unwrap_or_else(|| Arc::new(WritePathRegistry::new(&self.session_id, &root)));
        self.tool_ctx.workspace_root = Some(root);
        self.tool_ctx.write_claims = Some(Arc::clone(&registry));
        // 逃逸监视判定器注入（T-ESC-03 交接点）：装配后形态 = detector
        // 已挂载 RegistryBackedDetector——run 内工具写路径声明即视为已
        // 声明覆盖（审计静默跳过），声明释放后恢复未声明上报
        if let Some(config) = options.escape_watch.take() {
            options.escape_watch = Some(config.with_detector(Arc::new(
                RegistryBackedDetector::new(Arc::clone(&registry)),
            )));
        }
        // 探索类文档配额上下文（I6-M11 C5）：经 tool_ctx 透传工具执行面；
        // None = 主 agent 不受配额约束（04 C5「主 agent 自身不消耗」）
        self.tool_ctx.explore_docs_quota = options.explore_docs_quota.clone();
        // T-EG-08 REQ-G01：产出目录解析服务——显式注入 → 自动装配
        //（OutputWorkspace + InMemory store，工作区根同源；会话内幂等，
        // 目录名首次 resolve 冻结；生产持久化后端 F11 由壳层注入）
        let output_dir = options
            .output_dir
            .clone()
            .unwrap_or_else(|| {
                Arc::new(agent_tools::tools::output_dir::OutputWorkspace::new(
                    self.tool_ctx.workspace_root.clone().unwrap_or_default(),
                    Arc::new(agent_tools::tools::output_dir::InMemoryOutputDirStore::new()),
                ))
            });
        self.tool_ctx.output_dir = Some(output_dir);
        // T-D-14 权限传递层：父 run 归属经 tool_ctx 透传执行器（审批请求
        // 来源判定与裁决者路由依据；None = 主 agent run）
        self.tool_ctx.parent_run_id = options.parent_run_id.clone();

        self.state.options = options.clone();
        // 预算/压缩派生状态同步（P4 阶段 2-2/3-2）：LoopState 的
        // budget / compaction_policy / summarizer 与 options 同源，
        // 避免 handler 侧双读不一致（with_options 构造期定，run 内不可变）
        self.state.budget = options.context_budget;
        self.state.compaction_policy = options.compaction_policy.clone();
        self.state.summarizer = options.summarizer.clone();
        // 缓存测量派生状态同步（P5 S2 / T-36）：cache_tracker 与 options
        // 同源（构造期定，run 起始再复位）
        self.state.cache_tracker = build_tracker(self.state.options.cache_tracking.as_ref());
        self.tool_ctx.cwd = self.state.options.cwd.clone();
        // 幂等开关派生状态同步（T06.4.4）：true → 注入新守卫；false → 移除
        let idempotency = if options.idempotency_enabled {
            Some(Arc::new(ToolIdempotencyGuard::new()))
        } else {
            None
        };
        self.tool_executor = self.tool_executor.with_idempotency_opt(idempotency);
        // 中间件链 / 插件钩子派生同步（中间件与审批的优先级语义见
        // tool_exec.rs 模块头注）
        self.tool_executor = self
            .tool_executor
            .with_middleware(options.tool_middleware.clone());
        self.tool_executor = self.tool_executor.with_hooks(options.hooks.clone());
        self
    }

    /// 覆盖工具批量执行选项
    pub fn with_tool_options(mut self, options: ToolBatchOptions) -> Self {
        self.tool_options = options;
        self
    }

    /// 注入审批门（approval_enabled 时生效）
    pub fn with_approval(mut self, gate: Arc<dyn ApprovalGate>) -> Self {
        self.approval = Some(gate);
        self
    }

    /// 注入流式增量转发（T09.1 实时双轨：delta 实时发射，sequence=None）。
    ///
    /// 仿 [Self::with_approval] 的 Arc 形态：可跨 run 复用（每 run 重建
    /// [AgentSessionLoop] 的生产路径同一 sink 实例多次注入）。
    /// None（缺省）= 不启用实时 delta 发射（收口流 message-delta 只承担
    /// 序列/持久化记账）。
    pub fn with_delta_sink(mut self, sink: Arc<dyn DeltaSink>) -> Self {
        self.delta_sink = Some(sink);
        self
    }

    /// 预置初始对话（测试续接 / 未来会话恢复用，PE-09 T09.3.3）。
    ///
    /// 真实接线每 run 重建 [AgentSessionLoop]（engine.rs SessionLoopProducer），
    /// 对话由 store 水合承担，无需本方法；测试路径复用同一 loop 多次
    /// `run()` 时，因收口已 `mem::take` 清空对话（R4 行为变化登记），可用
    /// 上一轮 [RunOutcome::messages] 续接下一轮（owned 便捷形态，内部包 Arc）。
    pub fn with_initial_conversation(mut self, messages: Vec<AgentMessage>) -> Self {
        self.state.conversation = messages.into_iter().map(Arc::new).collect();
        self
    }

    /// 预置初始对话的**零拷贝**形态：直接接收 [RunOutcome::messages]
    /// （`Vec<Arc<AgentMessage>>`），续接不产生任何深拷贝。
    ///
    /// P1 不变量（append-only）：本函数是会话内 4 个追加点之一（水合入口，
    /// P4 历史回流消费）——只在 `run()` 之前调用一次、一次生效，之后对话
    /// 只增不改；改写既有消息破坏请求前缀字节稳定性；压缩是唯一例外
    /// （P4 闸门）。
    pub fn with_initial_conversation_arc(mut self, messages: Vec<Arc<AgentMessage>>) -> Self {
        self.state.conversation = messages;
        self
    }

    /// 共享 abort 信号克隆（外部 L3 强停入口，等价 force_cancel）
    pub fn abort_signal(&self) -> crate::safe_point::AbortSignal {
        self.state.abort_signal.clone()
    }

    /// 控制总线共享句柄（外部入队 L1/L2/L3 意图）
    pub fn control_bus(&self) -> Arc<std::sync::Mutex<crate::control::ControlBus>> {
        self.state.control_bus.clone()
    }

    /// 逃逸监视装配配置（T-ESC-03 §3.5.1：壳层 run 起停钩子消费）。
    ///
    /// 返回**装配后形态**：经 [Self::with_options] 装配块完成判定器注入
    /// （detector = [RegistryBackedDetector]，与工具执行共享同一注册表
    /// 实例）；壳层在 spawn 监视消费任务（[crate::escape_watch::spawn_escape_watch]）
    /// 前读取本配置。
    pub fn escape_watch_config(&self) -> Option<EscapeWatchConfig> {
        self.state.options.escape_watch.clone()
    }

    /// 当前对话（只读，测试 / 观测用；Arc 共享形态，PE-09 T09.3.2）
    pub fn conversation(&self) -> &[Arc<AgentMessage>] {
        &self.state.conversation
    }

    /// 输入队列（只读，测试 / 观测用）
    pub fn input_queue(&self) -> &crate::input::AgentInputQueue {
        &self.state.input_queue
    }

    /// 向输入队列排入一条消息（测试 / 编排层注入用）
    pub fn enqueue_input(&mut self, message: AgentMessage, mode: crate::input::InputEnqueueMode) {
        self.state.input_queue.enqueue(message, mode);
    }

    /// 运行一次 run（01 §2.1：入队 → INITIALIZED → agent-start →
    /// while(!done) 分派 → agent-end 收敛）
    ///
    /// 可观测性（PE-04 T04.2）：整个 run 生命周期处于 `run` span 内，
    /// 携带 session_id / run_id 字段，供日志关联。
    pub async fn run(&mut self, input: AgentMessage) -> RunOutcome {
        let run_span = tracing::info_span!(
            "session_loop.run",
            session_id = %self.session_id,
            run_id = %input.id,
        );
        let _enter = run_span.enter();
        tracing::info!(message_len = input.blocks.len(), "run 启动");
        // 每 run 全新状态机（会话 / 对话 / 输入队列跨 run 持久）
        self.state.machine = crate::state::AgentSessionMachine::new(
            self.session_id.clone(),
            self.max_turns,
        );
        // 恢复阶梯计数归零（fresh run）
        self.state.length_upgrades = 0;
        self.state.transient_retries = 0;
        self.state.continue_nudges = 0;
        self.state.terminal_error = None;
        self.state.events.clear();
        // 压缩护栏归零（fresh run，P4 §3.4.6 / §3.5）：
        // - compactions_this_run：单 run 压缩上限计数（预检与溢出触发共用）；
        // - compression_retries：溢出压缩重试计数（上限 1）——stream_error.rs
        //   压缩阶梯（ContextLengthExceeded 用尽后 / PayloadTooLarge）消费。
        //   归零语义 T-34（第四波）确认闭合：每 run 起始清零，压缩 + 重试
        //   一次后不可再超（防「压缩→仍超→再压缩」死循环）。
        // last_compaction_at 不在此归零（跨 run 时间戳护栏，压缩边界持续
        // 有效；跨重启由 orchestrator SessionContextMeta 持久化恢复，T-34）
        self.state.compactions_this_run = 0;
        self.state.compression_retries = 0;
        // 缓存跟踪器复位（fresh run，P5 S2 / T-36 / §3.4.5「每 run 重建」语义）：
        // run 内跨 turn 基线在 tracker 内部维护；跨 run 基线持久化由 engine
        // 层负责（T-40，经 CacheStatsTracker::baseline 移交）——本层只保证
        // 每 run 从干净状态开始（压缩代数归 0、签名基线作废、聚合清零）。
        self.state.cache_tracker = build_tracker(self.state.options.cache_tracking.as_ref());

        // 用户消息入队（force 环）→ INITIALIZED → agent-start（01 §2.1）
        self.state.input_queue.enqueue_force(input);
        if let Err(err) = handlers::dispatch(&mut self.state, E::Initialized) {
            return self.converge(EndDecision::error(&self.state, err.message())).await;
        }
        self.state.events.push(AgentEvent::AgentStart {
            session_id: self.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
        });
        // I8-E1 第一批：session.start 钩子广播（run 启动处；载荷最小子集
        // sessionId；observe 观察者失败不阻塞 run 启动——dispatch 内部
        // 已按 failStrategy 处置 + 错误事件化）
        if let Some(hooks) = &self.state.options.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::SessionStart {
                    session_id: self.session_id.clone(),
                })
                .await;
        }

        // while(!done) 按当前状态分派 handler（01 §2.1）
        while !self.state.machine.is_done() {
            let outcome = self.dispatch_once().await;
            match outcome {
                Ok(handler_outcome) => {
                    if let Some(end) = handler_outcome.end {
                        return self.converge(end).await;
                    }
                }
                Err(err) => {
                    // catch 兜底（01 §2.1 步骤 4）：恢复钩子裁决 retry/skip/abort
                    let decision = self.recovery_decision(&err);
                    if let Some(end) = self.apply_recovery(decision, &err).await {
                        return self.converge(end).await;
                    }
                }
            }
        }
        // 状态机已到 done 但未收敛（防御性）：按机器 endReason 收场
        let reason = self.state.machine.context().end_reason;
        self.converge(EndDecision::new(
            reason,
            self.state.terminal_error.clone(),
            None,
            &self.state,
        ))
        .await
    }

    /// 单次分派（按当前状态路由到对应 handler）
    async fn dispatch_once(&mut self) -> Result<handlers::HandlerOutcome, LoopError> {
        match self.state.machine.state() {
            S::AwaitingInput => handlers::awaiting_input::handle(&mut self.state).await,
            S::PreparingTurn => handlers::prepare_turn::handle(&mut self.state).await,
            S::Streaming => {
                handlers::streaming::handle(
                    &mut self.state,
                    self.provider.as_ref(),
                    self.delta_sink.as_deref(),
                )
                .await
            }
            S::SteeringEvaluation => handlers::steering_evaluation::handle(&mut self.state).await,
            S::ExecutingTools => {
                // T09.6/P8（AU-04 F9）：Arc 克隆传递（Arc 克隆便宜），
                // 供并行组内各 future 共享审批门
                let approval = self.approval.clone();
                handlers::executing_tools::handle(
                    &mut self.state,
                    &self.tool_executor,
                    &self.tool_ctx,
                    &self.tool_options,
                    approval,
                )
                .await
            }
            S::TurnComplete => handlers::turn_complete::handle(&mut self.state).await,
            // idle（run 前）/ done（循环条件已排除）：防御性收敛
            S::Idle | S::Done => Err(LoopError::internal(format!(
                "不可分派状态：{:?}",
                self.state.machine.state()
            ))),
        }
    }

    /// catch 兜底决策（01 §2.1 步骤 4：abort/cancel 类 → Abort；
    /// 其余走 recovery hook）
    fn recovery_decision(&self, err: &LoopError) -> RecoveryDecision {
        if self.state.abort_signal.is_aborted() {
            return RecoveryDecision::Abort;
        }
        if let Some(hook) = &self.state.options.recovery_hook {
            // F6：传结构化错误（码分类裁决）
            return hook.decide(err.crish(), self.state.machine.state());
        }
        // 缺省：不可恢复内部错误 → error 收场（经 apply_recovery 的 Fatal 分支）
        RecoveryDecision::Skip
    }

    /// 应用恢复决策；返回 Some 表示 run 已收敛
    async fn apply_recovery(
        &mut self,
        decision: RecoveryDecision,
        err: &LoopError,
    ) -> Option<EndDecision> {
        // 错误日志（T04.3-3）：catch 兜底错误按类型化错误码记录（Q29 消费侧；
        // 位于 run span 内，session_id/run_id 由 span 字段携带；retryable
        // 只表「可重试」，与收场正交）
        tracing::error!(
            target: "run",
            event = "runtime_error",
            error_code = %err.crish().code,
            retryable = decision == RecoveryDecision::Retry,
            "run 循环错误（catch 兜底）"
        );
        // 观测事件（runtime-error：retryable 只表「可重试」，与收场正交）
        self.state.events.push(AgentEvent::RuntimeError {
            session_id: self.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            error: err.message().to_string(),
            retryable: Some(decision == RecoveryDecision::Retry),
        });
        // I8-E1 第二批：error.occurred 钩子广播（引擎错误分类处——runtime-error
        // 事件同点位；observe 默认，失败吞掉 + 计数，收场流程继续）
        if let Some(hooks) = &self.state.options.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::ErrorOccurred {
                    session_id: self.session_id.clone(),
                    error: err.message().to_string(),
                    retryable: decision == RecoveryDecision::Retry,
                })
                .await;
        }
        match decision {
            RecoveryDecision::Retry => {
                // 仅 streaming 下可 NO_PROGRESS_CONTINUE 重进 provider 循环；
                // 其余状态按 error 收场（防御）
                if self.state.machine.state() == S::Streaming
                    && handlers::dispatch(&mut self.state, E::NoProgressContinue).is_ok()
                {
                    return None;
                }
                Some(EndDecision::error(&self.state, err.message()))
            }
            RecoveryDecision::Skip => {
                // skip 走 dispatchErrorRecovery（状态 → 继续事件映射）：
                // streaming → NO_TOOL_CALLS 正常收场该轮；其余按 error 收场
                if self.state.machine.state() == S::Streaming
                    && handlers::dispatch(&mut self.state, E::NoToolCalls).is_ok()
                {
                    return None;
                }
                Some(EndDecision::error(&self.state, err.message()))
            }
            RecoveryDecision::Abort => {
                // abort：按当前状态 ABORT（streaming/executing-tools → turn-complete，
                // 内容保留；其余 → done）
                if handlers::dispatch(&mut self.state, E::Abort).is_ok() {
                    // 若推进到 turn-complete 则交回主循环收敛（内容保留），
                    // 否则直接 aborted 收场
                    if self.state.machine.state() != S::TurnComplete {
                        return Some(EndDecision::aborted(&self.state));
                    }
                    return None;
                }
                Some(EndDecision::aborted(&self.state))
            }
        }
    }

    /// 收口：agent-end 事件 + RunOutcome（01 §2.1：reason 必填、error 可选）
    ///
    /// PE-09 T09.3.3：对话经 `mem::take` 零拷贝移交 [RunOutcome]（不再
    /// 每 run 收口全量克隆，O(n) → O(1)）；行为变化面 R4 已登记——converge
    /// 后 `state.conversation` 清空，真实接线每 run 重建 loop 无影响，
    /// 测试路径经 [Self::with_initial_conversation] 续接。
    async fn converge(&mut self, decision: EndDecision) -> RunOutcome {
        let reason = decision.reason;
        let error = decision.error.clone();
        let diagnostic = decision.diagnostic.clone();
        self.state.events.push(AgentEvent::AgentEnd {
            session_id: self.session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            reason,
            error: error.clone(),
        });
        // I8-E1 第一批：session.end 钩子广播（run 收场终态；observe 默认，
        // 失败吞掉 + 计数，收场流程继续——03 §2.4 表）
        if let Some(hooks) = &self.state.options.hooks {
            let _ = hooks
                .dispatch(&crate::hooks::HookEvent::SessionEnd {
                    session_id: self.session_id.clone(),
                })
                .await;
        }
        tracing::info!(end_reason = ?reason, has_error = error.is_some(), "run 收场");
        RunOutcome {
            reason,
            error,
            diagnostic,
            messages: std::mem::take(&mut self.state.conversation),
            events: std::mem::take(&mut self.state.events),
            turn_index: decision.turn_index,
            tool_call_count: decision.tool_call_count,
            steering_count: decision.steering_count,
            // 缓存统计收口（P5 S2 / T-36）：tracker.finish() 产出 run 级聚合；
            // 未配置 / 无样本 → None（缺省向后兼容，T-40 落库与事件消费）
            cache_stats: self
                .state
                .cache_tracker
                .take()
                .map(CacheStatsTracker::finish),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::{AgentMessageBlock, AgentMessageRole};
    use crate::testing::TestProvider;

    fn registry() -> Arc<ToolRegistry> {
        Arc::new(ToolRegistry::new())
    }

    /// T06.4.4：构造器默认值断言——SessionLoopOptions 缺省与字段一致
    /// （删 2 增 1 后：无 payload_recovery_limit / compression_hook，
    /// 新增 idempotency_enabled=false 默认关闭）
    #[test]
    fn default_options_match_documented_defaults() {
        let options = SessionLoopOptions::default();
        assert_eq!(options.transient_retry_limit, 3);
        assert_eq!(options.length_upgrade_limit, 2);
        assert_eq!(options.continue_nudge_limit, 1);
        assert!(options.steering_enabled, "steering 默认启用（行为不变）");
        assert!(!options.idempotency_enabled, "幂等默认关闭（Q14 接线默认行为不变）");
        assert!(options.turn_end_hook.is_none());
        assert!(options.should_stop_after_turn.is_none());
        assert!(options.recovery_hook.is_none());
        assert!(options.cwd.is_none());
        assert!(options.assistant_client_message_id.is_none());
        assert!(
            options.system_prompt.is_none(),
            "system_prompt 默认不发送（P1 阶段 2 透传字段）"
        );
        // P4 阶段 2-2/3-2：预算与压缩配置缺省全部关闭（未配置即现状）
        assert!(
            options.context_budget.is_none(),
            "context_budget 缺省 None = 不钳制不预检（向后兼容）"
        );
        assert!(
            options.compaction_policy.is_none(),
            "compaction_policy 缺省 None = 无自动压缩（向后兼容）"
        );
        assert!(options.summarizer.is_none(), "summarizer 缺省 None = L1 静态占位符");
        assert_eq!(
            options.max_auto_compactions_per_run, 1,
            "单 run 自动压缩上限默认 1（P4 §3.4.6）"
        );
        assert!(
            options.cache_tracking.is_none(),
            "cache_tracking 缺省 None = 不启用缓存测量（T-36 向后兼容）"
        );
        // T-EG-06：默认中间件链 = 写前自动备份（S10b，1 项名为 backup；
        // trash_root=None 执行期回退工作区 .crish-trash）
        assert_eq!(options.tool_middleware.len(), 1, "默认链恰 1 项");
        assert_eq!(
            options.tool_middleware[0].name(),
            "backup",
            "默认链 = 写前自动备份中间件"
        );
        // T-EG-06：注册表与配额缺省 None（装配发生在 with_options 装配块：
        // 注册表按工作区根新建并注入 ESC 判定器；配额 None = 主 agent
        // 不受约束）
        assert!(
            options.write_claims.is_none(),
            "write_claims 缺省 None = 由 with_options 按根新建"
        );
        assert!(
            options.explore_docs_quota.is_none(),
            "explore_docs_quota 缺省 None = 主 agent 不受配额约束"
        );
    }

    /// T06.4.4：with_options 派生状态同步——cwd 联动到工具执行上下文
    #[test]
    fn with_options_syncs_cwd_to_tool_ctx() {
        let provider = TestProvider::text_reply("hi");
        let loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        let loop_ = loop_.with_options(SessionLoopOptions {
            cwd: Some("C:\\work".into()),
            ..Default::default()
        });
        assert_eq!(loop_.tool_ctx.cwd.as_deref(), Some("C:\\work"));
    }

    /// T06.4.4：with_options 派生状态同步——idempotency_enabled 开关联动
    /// 工具执行器（true 注入守卫 / false 移除）
    #[test]
    fn with_options_syncs_idempotency_guard() {
        let provider = TestProvider::text_reply("hi");
        let loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        // 开启：注入守卫
        let loop_ = loop_.with_options(SessionLoopOptions {
            idempotency_enabled: true,
            ..Default::default()
        });
        assert!(loop_.tool_executor.idempotency_enabled());
        // 关闭：守卫移除
        let loop_ = loop_.with_options(SessionLoopOptions::default());
        assert!(!loop_.tool_executor.idempotency_enabled());
    }

    /// F6 / T06.5.3：RecoveryHook::decide 接收结构化 CrishError——
    /// 钩子基于码分类裁决而非文本匹配（错误码跨层保留，AA-01 Q29）
    #[test]
    fn recovery_hook_receives_crish_error_code() {
        use conex_types::error::codes;
        use std::sync::Mutex;

        struct CodeCapturingHook {
            received: Arc<Mutex<Option<String>>>,
        }
        impl RecoveryHook for CodeCapturingHook {
            fn decide(
                &self,
                error: &CrishError,
                _state: AgentSessionState,
            ) -> RecoveryDecision {
                *self
                    .received
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(error.code.clone());
                RecoveryDecision::Skip
            }
        }

        let provider = TestProvider::text_reply("hi");
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        let received = Arc::new(Mutex::new(None));
        let hook = CodeCapturingHook {
            received: Arc::clone(&received),
        };
        loop_ = loop_.with_options(SessionLoopOptions {
            recovery_hook: Some(Arc::new(hook)),
            ..Default::default()
        });

        // 显式码构造的 LoopError → decide 收到 &CrishError（码 + 可重试性）
        let err = LoopError::with_code(codes::TOOL_EXECUTION_FAILED, "工具执行失败");
        let decision = loop_.recovery_decision(&err);
        assert_eq!(decision, RecoveryDecision::Skip);
        let received_code = received
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .expect("decide 必须收到结构化错误");
        assert_eq!(received_code, codes::TOOL_EXECUTION_FAILED);
    }

    /// 构造用户消息（run 输入）
    fn user_input(text: &str) -> AgentMessage {
        AgentMessage {
            id: format!("user-{text}"),
            role: AgentMessageRole::User,
            created_at: "2026-01-01T00:00:00Z".into(),
            blocks: vec![AgentMessageBlock::Text { text: text.into() }],
            metadata: None,
            client_message_id: None,
            content: None,
        }
    }

    /// 携带 usage 的停止事件（ProviderUsage camelCase 标量面，T-36 消费面）
    fn stop_with_usage(
        prompt: u64,
        completion: u64,
        read: u64,
        write: u64,
        miss: Option<u64>,
    ) -> crate::stream::ProviderStreamEvent {
        crate::stream::ProviderStreamEvent::Stop {
            reason: crate::stream::StopReason::Stop,
            error: None,
            usage: Some(crate::stream::ProviderUsage {
                prompt_tokens: Some(prompt),
                completion_tokens: Some(completion),
                total_tokens: Some(prompt.saturating_add(completion)),
                cache_read_tokens: Some(read),
                cache_write_tokens: Some(write),
                cache_miss_tokens: miss,
                reasoning_tokens: None,
            }),
        }
    }

    /// T-36：run 收口携带缓存统计（usage → RunCacheStats 聚合）；
    /// 未配置 cache_tracking 时缺省 None（向后兼容）
    #[tokio::test]
    async fn run_outcome_carries_cache_stats_and_defaults_to_none() {
        use crate::cache_tracker::CacheTrackingConfig;
        // 配置跟踪器：单轮 usage（Included 口径）→ RunCacheStats 聚合
        let provider = TestProvider::new(vec![
            crate::stream::ProviderStreamEvent::text("你好"),
            stop_with_usage(1_000, 50, 800, 100, None),
        ]);
        let mut loop_ = AgentSessionLoop::new("s1", "r1", 16, Box::new(provider), registry());
        loop_ = loop_.with_options(SessionLoopOptions {
            cache_tracking: Some(CacheTrackingConfig {
                provider: "deepseek".to_string(),
                model: "deepseek-v4-flash".to_string(),
                ttl_seconds: 60,
            }),
            ..Default::default()
        });
        let outcome = loop_.run(user_input("你好")).await;
        let stats = outcome.cache_stats.expect("配置后收口必须携带缓存统计");
        assert_eq!(stats.sample_count, 1);
        assert_eq!(stats.prompt_tokens, 1_000);
        assert_eq!(stats.completion_tokens, 50);
        assert_eq!(stats.total_tokens, 1_050);
        assert_eq!(stats.cache_read_tokens, 800);
        assert_eq!(stats.cache_write_tokens, 100);
        // Included：miss = prompt - read - write
        assert_eq!(stats.cache_miss_tokens, 100);
        assert_eq!(stats.hit_ratio, Some(0.8));
        assert_eq!(stats.missed_tokens, 0, "首轮无基线 → 不计 miss");
        assert!(stats.warm_until_ms.is_some(), "TTL 已知 → 温暖截止可计算");

        // 未配置 → None（向后兼容，行为与现状一致）
        let provider2 = TestProvider::new(vec![
            crate::stream::ProviderStreamEvent::text("hi"),
            stop_with_usage(100, 10, 0, 0, None),
        ]);
        let mut loop2 = AgentSessionLoop::new("s1", "r2", 16, Box::new(provider2), registry());
        let outcome2 = loop2.run(user_input("hi")).await;
        assert!(outcome2.cache_stats.is_none(), "未配置缓存测量 → cache_stats 为 None");
    }

    // ── T-EG-06：引擎装配冒烟（互斥 / 配额 / 中间件链 / ESC 判定器）──

    /// 装配探针工具：记录工具执行面见到的装配状态（注册表 / 配额 /
    /// 持有者 / 写路径声明结果），供 smoke 测试断言 with_options 装配块
    /// 的四线接线是否真实生效
    #[derive(Debug, Default)]
    struct AssemblyProbeTool {
        observed: Arc<std::sync::Mutex<AssemblyProbeRecord>>,
    }

    /// 探针观测记录（执行面装配状态快照）
    #[derive(Debug, Default, Clone)]
    struct AssemblyProbeRecord {
        /// 写路径互斥注册表是否已注入
        write_claims_some: bool,
        /// 配额上下文是否已注入
        quota_some: bool,
        /// 写声明持有者（应为当前 run 标识）
        holder: Option<String>,
        /// 执行面声明写路径是否成功
        claim_ok: bool,
    }

    impl AssemblyProbeTool {
        /// 取观测记录（测试断言）
        fn observed(&self) -> AssemblyProbeRecord {
            self.observed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone()
        }
    }

    #[async_trait]
    impl agent_tools::definition::Tool for AssemblyProbeTool {
        fn name(&self) -> &str {
            "assembly_probe"
        }

        fn definition(&self) -> &agent_tools::definition::ToolDefinition {
            static DEF: std::sync::OnceLock<agent_tools::definition::ToolDefinition> =
                std::sync::OnceLock::new();
            DEF.get_or_init(|| agent_tools::definition::ToolDefinition {
                name: "assembly_probe".to_string(),
                description: "装配冒烟探针".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            })
        }

        async fn execute(
            &self,
            ctx: &agent_tools::context::ToolContext,
            _args: serde_json::Value,
        ) -> Result<serde_json::Value, agent_tools::definition::ToolError> {
            // 执行面声明写路径（守卫为临时值，随 execute 结束释放——
            // run 后注册表无残留即证明 guard 无泄漏）
            let claim_ok = match &ctx.write_claims {
                Some(reg) => {
                    let holder = ctx
                        .write_claim_holder
                        .clone()
                        .unwrap_or_else(|| ctx.session_id.clone());
                    reg.claim_one(holder, "probe.txt", agent_tools::write_paths::ClaimMode::Write)
                        .is_ok()
                }
                None => false,
            };
            *self.observed.lock().unwrap_or_else(|e| e.into_inner()) = AssemblyProbeRecord {
                write_claims_some: ctx.write_claims.is_some(),
                quota_some: ctx.explore_docs_quota.is_some(),
                holder: ctx.write_claim_holder.clone(),
                claim_ok,
            };
            Ok(serde_json::json!({"probe": true}))
        }
    }

    /// T-EG-06 装配冒烟：with_options 装配块四线接线全链路生效——
    /// 注册表（互斥）/ 配额 / 默认中间件链 / ESC 判定器注入；run 后
    /// 守卫无泄漏；判定器与工具执行共享同一注册表实例
    #[tokio::test]
    async fn assembly_smoke_wires_registry_quota_middleware_and_detector() {
        use agent_tools::audit::{AuditSink, RecordingAuditSink};
        use agent_tools::context::ExploreDocsQuotaContext;
        use agent_tools::explore_quota::InMemoryExploreDocsQuotaStore;
        use conex_fs::watch::{ChangeKind, FileChangeEvent};
        use conex_test_utils::TempWorkspace;
        use conex_types::session::AgentEndReason;
        use crate::stream::{ProviderStreamEvent, StopReason};

        let ws = TempWorkspace::new("eg06_assembly_smoke");
        // 探针工具注册进注册表（run 内工具调用走执行面）
        let probe = Arc::new(AssemblyProbeTool::default());
        let mut reg = ToolRegistry::new();
        reg.register(Arc::clone(&probe) as Arc<dyn agent_tools::definition::Tool>)
            .expect("注册探针工具");
        // 两轮脚本：第 1 轮工具调用（探针），第 2 轮文字收尾
        let provider = TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::tool_call(
                    Some("call_probe".into()),
                    "assembly_probe",
                    serde_json::json!({}),
                ),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("装配完成"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ]);

        let sink = Arc::new(RecordingAuditSink::new());
        let quota_store = Arc::new(InMemoryExploreDocsQuotaStore::new());
        let mut loop_ =
            AgentSessionLoop::new("s1", "run-eg06", 16, Box::new(provider), Arc::new(reg));
        loop_ = loop_.with_options(SessionLoopOptions {
            cwd: Some(ws.path_str()),
            // 配额上下文（内存 store 后端）：主循环装配面透传 tool_ctx
            explore_docs_quota: Some(ExploreDocsQuotaContext {
                session_id: "s1".to_string(),
                run_id: "run-eg06".to_string(),
                granted: true,
                quota: 1,
                store: Some(
                    Arc::clone(&quota_store)
                        as Arc<dyn agent_tools::explore_quota::ExploreDocsQuotaStore>,
                ),
            }),
            // ESC 装配配置：with_options 装配块注入判定器（与注册表同实例）
            escape_watch: Some(EscapeWatchConfig::new(
                ws.path(),
                "s1",
                "run-eg06",
                Arc::clone(&sink) as AuditSink,
            )),
            ..Default::default()
        });

        let outcome = loop_.run(user_input("装配冒烟")).await;
        assert_eq!(outcome.reason, AgentEndReason::Stop, "装配冒烟 run 应正常收场");
        assert!(outcome.error.is_none());

        // 1) 工具执行面装配可见（注册表 / 配额 / 持有者 / 声明成功）
        let record = probe.observed();
        assert!(record.write_claims_some, "执行面必须看到注册表");
        assert!(record.quota_some, "执行面必须看到配额上下文");
        assert_eq!(
            record.holder.as_deref(),
            Some("run-eg06"),
            "写声明持有者 = 当前 run 标识"
        );
        assert!(record.claim_ok, "执行面声明写路径必须成功");

        // 2) 注册表无泄漏：run 后活跃声明为空（探针声明随执行结束释放）
        let registry = loop_
            .tool_ctx
            .write_claims
            .clone()
            .expect("装配后注册表必须存在");
        assert!(
            registry.active_claims().is_empty(),
            "run 后不得残留活跃声明（guard 无泄漏）"
        );

        // 3) 中间件链生效：默认链 = 写前自动备份（backup）
        assert_eq!(
            loop_.tool_executor.middleware_names(),
            vec!["backup".to_string()],
            "默认中间件链 = 备份中间件"
        );

        // 4) ESC 判定器：装配后注入；与工具执行共享同一注册表实例——
        // 同注册表声明后 is_declared 命中，释放后不命中
        let esc = loop_
            .escape_watch_config()
            .expect("装配后 ESC 配置必须存在");
        let detector = esc
            .detector
            .clone()
            .expect("装配后必须注入判定器");
        let event = FileChangeEvent {
            path: ws.path().join("probe.txt"),
            kind: ChangeKind::Created,
            from: None,
            occurred_at_ms: 1,
        };
        let guard = registry
            .claim_one("test", "probe.txt", agent_tools::write_paths::ClaimMode::Write)
            .expect("手动声明成功");
        assert!(detector.is_declared(&event), "已声明路径必须命中判定器");
        drop(guard);
        assert!(!detector.is_declared(&event), "声明释放后不得命中判定器");
    }
}
