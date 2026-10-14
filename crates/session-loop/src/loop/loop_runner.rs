//! 会话运行循环装配面（SR-06c · 拆分 · ≠ EL）：AgentSessionLoop 结构 +
//! 构造/builder 面（new / with_options / with_* 注入 / 观测访问器）；
//! 自 loop/mod.rs 拆出，经父模 re-export（crate::r#loop::AgentSessionLoop
//! 路径不 break）。run 控制面见 loop_exec.rs。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_tools::idempotency::ToolIdempotencyGuard;
use agent_tools::registry::ToolRegistry;

use agent_tools::write_paths::WritePathRegistry;
use conex_types::message::AgentMessage;

use crate::cache_tracker::build_tracker;
use crate::provider::{DeltaSink, ProviderCall};
use crate::steering::{SteeringCoordinator, SteeringCoordinatorOptions};
use crate::tool_events::{ApprovalGate, ToolBatchOptions};
use crate::tool_exec::{ToolExecCtx, ToolExecutor};

use super::handlers;
use super::options::SessionLoopOptions;
/// 会话运行循环（B3.4 主循环）
///
/// 构造后多次调用 [Self::run]：每 run 创建全新状态机（idle → … → done），
/// 对话与输入队列跨 run 持久（nudge / followUp / steer 残留由下一条用户
/// 消息边界消费，01 D8）。
pub struct AgentSessionLoop {
    /// handler 共享状态（含状态机 / 队列 / 总线 / steering / 对话）
    pub(crate) state: handlers::LoopState,
    /// provider 回调（trait 解耦，测试用 TestProvider）
    pub(crate) provider: Box<dyn ProviderCall>,
    /// 工具批量执行器（B3.5）
    pub(crate) tool_executor: ToolExecutor,
    /// 工具执行上下文（runId / sessionId / cwd）
    pub(crate) tool_ctx: ToolExecCtx,
    /// 工具批量执行选项（超时 / 失败策略 / 审批开关）
    pub(crate) tool_options: ToolBatchOptions,
    /// 审批门（B4 编排层注入；None = 不启用审批）
    pub(crate) approval: Option<Arc<dyn ApprovalGate>>,
    /// 流式增量转发（T09.1 实时双轨；None = 不启用实时 delta 发射）
    pub(crate) delta_sink: Option<Arc<dyn DeltaSink>>,
    /// 会话标识（agent-start / 事件共用）
    pub(crate) session_id: String,
    /// 每 run 重建状态机用（max_turns 上限）
    pub(crate) max_turns: u32,
}

impl AgentSessionLoop {
    /// 新建主循环（默认 steering：**空策略协调器**——C1b 反向依赖移出后
    /// 核心不再内建 RecoverySteeringStrategy 具体策略（不变量 5），具体
    /// 策略由壳层 / 编排层经 [Self::with_steering] 注入；默认恢复阶梯配置
    /// 见 [SessionLoopOptions]）
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
        // C1b（反向依赖移出）：空策略协调器（预算仍为默认 3）——具体策略
        // 由壳层经 with_steering 注入（engine_build.rs SessionLoopProducer
        // produce 装配 RecoverySteeringStrategy；测试自建注入）。
        let steering = SteeringCoordinator::new(Vec::new(), SteeringCoordinatorOptions::default());
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
            // C1b：中间件链（默认空；写前自动备份由壳层注入 options 后
            // 经本处同步）注入执行器——with_options 派生同步会整体替换链
            // （options 同源）
            tool_executor: ToolExecutor::new(tool_registry)
                .with_middleware(options.tool_exec.tool_middleware),
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
                // Round6 / W4-E：笔记后端随 with_options 装配（构造期 None）
                note_backend: None,
                background: None,
                log_root: None,
                compression_store: None,
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
    pub fn with_options(mut self, options: SessionLoopOptions) -> Self {
        // ── 引擎装配块（T-EG-06：互斥 / 配额 / 中间件链 / ESC 判定器）──
        // 工作区根解析链：显式 workspace_root → options.tool_exec.cwd → 当前目录
        // （与 ToolContext.workspace_root 既有回退语义一致，
        // tool_exec.rs:684-690；None 时写工具无互斥基准，回退当前目录）
        let root = self
            .tool_ctx
            .workspace_root
            .clone()
            .or_else(|| options.tool_exec.cwd.clone().map(PathBuf::from))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        // 写路径互斥注册表（I4-M3）：显式注入 → 复用 tool_ctx 既有 →
        // 按根新建（会话级，与工作区根同源——工具执行面与 ESC 判定器
        // 共享同一实例）
        let registry = options
            .assembly
            .write_claims
            .clone()
            .or_else(|| self.tool_ctx.write_claims.clone())
            .unwrap_or_else(|| Arc::new(WritePathRegistry::new(&self.session_id, &root)));
        self.tool_ctx.workspace_root = Some(root);
        self.tool_ctx.write_claims = Some(Arc::clone(&registry));
        // 探索类文档配额上下文（I6-M11 C5）：经 tool_ctx 透传工具执行面；
        // None = 主 agent 不受配额约束（04 C5「主 agent 自身不消耗」）
        self.tool_ctx.explore_docs_quota = options.assembly.explore_docs_quota.clone();
        // T-EG-08 REQ-G01：产出目录解析服务——显式注入 → 自动装配
        //（OutputWorkspace + InMemory store，工作区根同源；会话内幂等，
        // 目录名首次 resolve 冻结；生产持久化后端 F11 由壳层注入）
        let output_dir = options.assembly.output_dir.clone().unwrap_or_else(|| {
            Arc::new(agent_tools::tools::output_dir::OutputWorkspace::new(
                self.tool_ctx.workspace_root.clone().unwrap_or_default(),
                Arc::new(agent_tools::tools::output_dir::InMemoryOutputDirStore::new()),
            ))
        });
        self.tool_ctx.output_dir = Some(output_dir);
        // T-D-14 权限传递层：父 run 归属经 tool_ctx 透传执行器（审批请求
        // 来源判定与裁决者路由依据；None = 主 agent run）
        self.tool_ctx.parent_run_id = options.assembly.parent_run_id.clone();
        // Round6 / W4-E：笔记后端经 tool_ctx 透传工具执行面（None = unwired）
        self.tool_ctx.note_backend = options.assembly.note_backend.clone();
        // 后台任务管理器与日志落盘根透传工具执行面
        self.tool_ctx.background = options.hooks.background.clone();
        self.tool_ctx.log_root = options.hooks.log_root.clone();
        self.tool_ctx.compression_store = options
            .assembly
            .compression_store
            .clone()
            .or_else(|| options.compaction.compression_store.clone());
        if self.delta_sink.is_none() {
            if let Some(live_sink) = &options.hooks.live_sink {
                self.delta_sink = Some(Arc::new(live_sink.clone()) as Arc<dyn DeltaSink>);
            }
        }

        self.state.options = options.clone();
        // 预算/压缩派生状态同步（P4 阶段 2-2/3-2）：LoopState 的
        // budget / compaction_policy / summarizer 与 options 同源，
        // 避免 handler 侧双读不一致（with_options 构造期定，run 内不可变）
        self.state.budget_state.budget = options.assembly.context_budget;
        self.state.compaction.compaction_policy = options.compaction.compaction_policy.clone();
        self.state.compaction.summarizer = options.compaction.summarizer.clone();
        // 会话级摘要协调器派生状态同步（T-42）：与 options 同源（壳层
        // 装配；None = 回退 run 级 dispatch）
        self.state.compaction.summary_coordinator = options.summary.summary_coordinator.clone();
        // E2 F2 层 1（低功耗模式）：低功耗护栏配置派生（两新键）——
        // 装配到 run 级调度器 [SummaryDispatch]（会话级 coordinator 侧
        // 的护栏接线由壳层批次在 SessionSummaryCoordinator 装配，07 §5.4
        // 文件域；本处为 session-loop 内核面的完整默认接线，含测试路径）
        self.state.compaction.summary_dispatch.set_retry_guard(
            crate::r#loop::summary_dispatch::SummaryRetryGuardConfig {
                max_attempts: options.summary.compact_summary_max_attempts,
                retry_window_ms: options.summary.compact_summary_retry_window_ms,
            },
        );
        // 缓存测量派生状态同步（P5 S2 / T-36）：cache_tracker 与 options
        // 同源（构造期定，run 起始再复位）
        self.state.compaction.cache_tracker =
            build_tracker(self.state.options.cache.cache_tracking.as_ref());
        self.tool_ctx.cwd = self.state.options.tool_exec.cwd.clone();
        // 幂等开关派生状态同步（T06.4.4）：true → 注入新守卫；false → 移除
        let idempotency = if options.tool_exec.idempotency_enabled {
            Some(Arc::new(ToolIdempotencyGuard::new()))
        } else {
            None
        };
        // 中间件链 / 插件钩子派生原位同步（SL-COMPAT-18：消除冗余克隆丢弃）
        self.tool_executor
            .set_idempotency_opt(idempotency)
            .set_middleware(options.tool_exec.tool_middleware)
            .set_hooks(options.tool_exec.hooks);
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

    /// 注入 steering 协调器（C1b 反向依赖移出注入缝）：[Self::new] 默认
    /// 空策略协调器——具体策略（如 RecoverySteeringStrategy）由壳层装配面
    /// （engine_build.rs SessionLoopProducer::produce）与测试自建注入，
    /// 核心构造函数不再认知具体策略实例（不变量 5）。
    ///
    /// 必须 `run()` 前调用（LoopState.steering 构造期定，run 内不可变）；
    /// 未调用时保持空策略协调器（无 steering 纠偏，向后兼容测试路径）。
    pub fn with_steering(mut self, steering: SteeringCoordinator) -> Self {
        self.state.steering = steering;
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

    /// 注入实时事件通知通道（Live Track 实时双轨事件发射，sequence=None）。
    pub fn with_live_sink(mut self, sink: Arc<dyn crate::provider::LiveEventSink>) -> Self {
        self.state.options.hooks.live_sink = Some(Arc::clone(&sink));
        self.delta_sink = Some(Arc::new(sink) as Arc<dyn DeltaSink>);
        self
    }

    /// 预置初始对话（测试续接 / 未来会话恢复用，PE-09 T09.3.3）。
    ///
    /// 真实接线每 run 重建 [AgentSessionLoop]（engine.rs SessionLoopProducer），
    /// 对话由 store 水合承担，无需本方法；测试路径复用同一 loop 多次
    /// `run()` 时，因收口已 `mem::take` 清空对话（R4 行为变化登记），可用
    /// 上一轮 [RunOutcome::messages] 续接下一轮（owned 便捷形态，内部包 Arc）。
    pub fn with_initial_conversation(mut self, messages: Vec<AgentMessage>) -> Self {
        let conversation: Vec<Arc<AgentMessage>> = messages.into_iter().map(Arc::new).collect();
        // T-36 首尾双约束（debug 面）：水合/首条消息构造路径的协议形状
        // 断言——无 system 时首条必须为 user；含水合链时必须以 user 收尾
        crate::r#loop::handlers::assert_conversation_head_tail(&conversation);
        self.state.conversation = conversation;
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
        // T-36 首尾双约束（debug 面）：水合/首条消息构造路径的协议形状
        // 断言（与 with_initial_conversation 同口径；测试续接以 assistant
        // 收尾的无链对话不触发尾部约束）
        crate::r#loop::handlers::assert_conversation_head_tail(&messages);
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

    /// 注入外部控制总线（30-P1 run 控制面接线）：替换 [LoopState] 自建
    /// 实例——壳层（ActiveRun）与内核共享同一总线，core_run_control 的
    /// L1/L2/L3 意图经本总线在安全点被真实消费（运行中 run 有外部终止
    /// 路径，A4-H2 断头路消除）。
    ///
    /// 必须 `run()` 前调用（check_control 读字段引用，run 内不可变）；
    /// 未调用时保持自建实例（现状行为向后兼容）。
    pub fn with_control_bus(mut self, bus: Arc<Mutex<crate::control::ControlBus>>) -> Self {
        tracing::debug!(
            target: "session_loop",
            "外部控制总线注入（替换 LoopState 自建实例）"
        );
        self.state.control_bus = bus;
        self
    }

    /// 注入外部 abort 信号（30-P1）：壳层 ActiveRun 与 loop 共享同一
    /// 实例（AbortSignal 内部共享 [AtomicBool]，克隆即同一触发面——
    /// safe_point.rs:369 测试已证克隆共享语义）。
    ///
    /// 必须 `run()` 前调用；未调用时保持自建信号（现状行为向后兼容）。
    pub fn with_abort_signal(mut self, signal: crate::safe_point::AbortSignal) -> Self {
        tracing::debug!(
            target: "session_loop",
            "外部 abort 信号注入（与壳层共享同一触发面）"
        );
        self.state.abort_signal = signal;
        self
    }

    /// 当前对话（只读，测试 / 观测用；Arc 共享形态，PE-09 T09.3.2）
    pub fn conversation(&self) -> &[Arc<AgentMessage>] {
        &self.state.conversation
    }

    /// 输入队列（只读，测试 / 观测用）
    pub fn input_queue(&self) -> &crate::input::AgentInputQueue {
        &self.state.input_queue
    }

    /// EV-12 输入留痕写点（fail-open 落库）。
    ///
    /// 经 [SessionLoopOptions::pending_input_store] 注入的持久化面把用户
    /// 消息写入 `pending_inputs` 表（INSERT OR REPLACE 幂等，id = 消息
    /// id，run_id = 当前 run）；fire-and-forget（tokio spawn）不阻断入队
    /// 路径；DB 失败仅 warn（恢复语义 fail-open——未落库输入由当前
    /// 会话运行兜底，崩溃恢复语义允许丢失，不假装可回放）。无注入面
    /// 或无 runtime 上下文时零开销跳过（向后兼容）。
    pub(crate) fn spawn_pending_input_save(&self, message: &AgentMessage) {
        let Some(store) = &self.state.options.assembly.pending_input_store else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let store = Arc::clone(store);
        let id = message.id.clone();
        let session_id = self.session_id.clone();
        let run_id = self.tool_ctx.run_id.clone();
        let payload = serde_json::to_string(message).unwrap_or_default();
        handle.spawn(async move {
            if let Err(err) = store
                .save_pending_input(&id, &session_id, Some(&run_id), &payload)
                .await
            {
                tracing::warn!(
                    target: "session_loop",
                    message_id = %id,
                    error = %err,
                    "待处理输入落库失败（fail-open：不阻断入队）"
                );
            }
        });
    }

    /// 向输入队列排入一条消息（测试 / 编排层注入用）。
    ///
    /// EV-12 输入留痕：入队即落库（save_pending_input，fail-open）——
    /// 与 run 起始用户消息写点（loop_exec.rs run()）共同构成「每条用户
    /// 消息 1 INSERT」；消费删点见 record_message（handlers/mod.rs）。
    pub fn enqueue_input(&mut self, message: AgentMessage, mode: crate::input::InputEnqueueMode) {
        let snapshot = message.clone();
        self.state.input_queue.enqueue(message, mode);
        self.spawn_pending_input_save(&snapshot);
    }

    /// 注入待处理输入持久化面（EV-12 输入留痕）。
    ///
    /// 实现方 = orchestrator 的 `Store` 适配（LocalDbStore / InMemoryStore，
    /// persist.rs）；未注入（None）时 enqueue 不落库，行为与现状一致。
    /// 必须 `run()` 前调用（options 构造期定，run 内不可变）。
    pub fn with_pending_input_store(
        mut self,
        store: Arc<dyn crate::input::PendingInputStore>,
    ) -> Self {
        self.state.options.assembly.pending_input_store = Some(store);
        self
    }
}
