//! run 生产者（每 run 重建 [AgentSessionLoop]——真实接线跨 run 重建语义，
//! PE-09 §4）
//!
//! 自壳层 `engine_build.rs` 下沉。produce 全链：冷缓存预警 → 模型切换检测
//! → 缓存测量装配 → 笔记后端装配 → 上下文注入渲染 → AgentSessionLoop
//! 组装（steering / 控制总线 / abort 信号 / 审批门 / delta 流 / 水合对话）
//! → run 收口事件（cache-stats-updated / cache-waste-alert）。

use std::sync::{Arc, Mutex};

use agent_tools::registry::ToolRegistry;
use conex_types::message::AgentMessage;
use session_loop::provider::ProviderCall;
use session_loop::{
    AbortSignal, AgentSessionLoop, ApprovalGate, CacheTrackingConfig, ControlBus, DeltaSink,
    RecoverySteeringStrategy, RunOutcome, SessionLoopOptions, SteeringCoordinator,
    SteeringCoordinatorOptions, ToolBatchOptions,
};

use crate::context_injection::ContextInjector;
use crate::engine_assembly::{note_backend, unix_millis_now};
use crate::engine_handle::{
    cold_cache_warning_event, model_switched, waste_alert_event, SessionCacheState, SharedProvider,
};

/// run 生产者（每 run 重建 [AgentSessionLoop]）
pub struct SessionLoopProducer {
    /// 会话标识
    session_id: String,
    /// run 标识
    run_id: String,
    /// max-turns 预算
    max_turns: u32,
    /// provider 适配层（Arc 共享，跨 run 复用）
    provider: Arc<dyn ProviderCall>,
    /// 工具注册表
    tool_registry: Arc<ToolRegistry>,
    /// 循环配置（恢复阶梯 / 幂等 / assistant clientMessageId 等）
    options: SessionLoopOptions,
    /// 工具批量执行选项（超时 / 失败策略 / 审批开关）
    tool_options: ToolBatchOptions,
    /// 审批门（permissionMode 非 Full 时注入）
    approval: Option<Arc<dyn ApprovalGate>>,
    /// 实时 delta 转发（T09.1；None = 不启用，收口流 message-delta 兜底）
    delta_sink: Option<Arc<dyn DeltaSink>>,
    /// 预置初始对话（P4 T-30 水合：SessionHistoryCache 缓存 / 前端 history
    /// 水合产物；None = 现状单消息 run，向后兼容）
    initial_conversation: Option<Vec<Arc<AgentMessage>>>,
    /// 本次 run 的用户消息
    user_message: AgentMessage,
    /// 缓存跟踪配置（P5 S5 / T-40：None = 不启用测量，行为与现状一致）
    cache_tracking: Option<CacheTrackingConfig>,
    /// 上一 run 的会话缓存状态（T-40：冷缓存预警 + 模型切换检测数据源）
    cache_session: SessionCacheState,
    /// 上下文注入通道（M1：C10 地基；None = 无注入，options.system_prompt
    /// 原样透传——默认行为与现状一致）
    context_injector: Option<ContextInjector>,
    /// 外部控制总线（30-P1 run 控制面：None = loop 自建实例，现状行为）
    control_bus: Option<Arc<Mutex<ControlBus>>>,
    /// 外部 abort 信号（30-P1：None = loop 自建信号；Some = L3 强停 /
    /// kill_all 经同一信号生效）
    abort_signal: Option<AbortSignal>,
}

impl SessionLoopProducer {
    /// 新建 run 生产者（permissionMode 与 clientMessageId 已由 core_run_task
    /// 归一为循环选项与用户消息）
    #[allow(clippy::too_many_arguments)] // 参数为 run 装配上下文聚合注入（provider/工具注册表/循环选项/批量选项/审批门/delta 流/水合对话/用户消息），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低
    pub fn new(
        session_id: String,
        run_id: String,
        max_turns: u32,
        provider: Arc<dyn ProviderCall>,
        tool_registry: Arc<ToolRegistry>,
        options: SessionLoopOptions,
        tool_options: ToolBatchOptions,
        approval: Option<Arc<dyn ApprovalGate>>,
        delta_sink: Option<Arc<dyn DeltaSink>>,
        initial_conversation: Option<Vec<Arc<AgentMessage>>>,
        user_message: AgentMessage,
    ) -> Self {
        Self {
            session_id,
            run_id,
            max_turns,
            provider,
            tool_registry,
            options,
            tool_options,
            approval,
            delta_sink,
            initial_conversation,
            user_message,
            // P5 S5 / T-40：缓存测量缺省关闭（未配置 = 现状行为）
            cache_tracking: None,
            cache_session: SessionCacheState::default(),
            // M1：注入通道缺省关闭（未装配 = 现状行为，system_prompt 原样透传）
            context_injector: None,
            // 30-P1：run 控制面缺省关闭（未装配 = loop 自建总线/信号，现状行为）
            control_bus: None,
            abort_signal: None,
        }
    }

    /// 启用缓存测量（P5 S5 / T-40）：装配 [CacheTrackingConfig]
    /// （provider / model / TTL；None = 保持现状不测量）。
    pub fn with_cache_tracking(mut self, config: Option<CacheTrackingConfig>) -> Self {
        self.cache_tracking = config;
        self
    }

    /// 注入上一 run 的会话缓存状态（T-40：冷缓存预警 + 模型切换检测
    /// 数据源；EngineHandle::cache_session 产出）
    pub fn with_cache_session(mut self, session: SessionCacheState) -> Self {
        self.cache_session = session;
        self
    }

    /// M1：装配上下文注入通道（[ContextInjector]；None = 无注入，保持
    /// 现状行为）。produce 时把注入段渲染进 system_prompt 面。
    pub fn with_context_injector(mut self, injector: Option<ContextInjector>) -> Self {
        self.context_injector = injector;
        self
    }

    /// 30-P1：装配外部控制总线（run 控制面接线）——produce 在
    /// `with_options` 之后、`run()` 之前注入 loop（builder 顺序契约：
    /// 必须 run() 前，check_control 读字段引用）；壳层 ActiveRun
    /// 与内核共享同一总线，运行中 run 有真实外部终止路径。
    pub fn with_control_bus(mut self, bus: Arc<Mutex<ControlBus>>) -> Self {
        self.control_bus = Some(bus);
        self
    }

    /// 30-P1：装配外部 abort 信号（L3 强停触发面）——produce 在
    /// `with_options` 之后、`run()` 之前注入 loop；壳层 ActiveRun 与
    /// loop 共享同一实例（AbortSignal 克隆共享 [AtomicBool]）。
    pub fn with_abort_signal(mut self, signal: AbortSignal) -> Self {
        self.abort_signal = Some(signal);
        self
    }

    /// 生产一次 run 结果（构造 [AgentSessionLoop] 并运行；每 run 重建）
    ///
    /// T-30 水合分支（P4 §3.2.3 混合路线）：`initial_conversation` 非空时
    /// 以 [AgentSessionLoop::with_initial_conversation_arc] 零拷贝预置对话
    /// （引擎缓存 = 权威增量 / 前端 history = 冷启动兜底），`run()` 追加
    /// 新用户消息；为空时走现状单消息路径（向后兼容）。
    ///
    /// T-40 缓存测量接线（P5 S5，只测不改）：
    /// - run 启动前：冷缓存预警（上一 run warm_until_ms 过期 → 实时轨发
    ///   cold-cache-warning 一次）+ 模型切换检测 + 装配 CacheTrackingConfig；
    /// - run 收口：`cache-stats-updated` 入收口轨（outcome.events →
    ///   drive_outcome → 既有缓冲桥）；`cache-waste-alert` 按阈值经实时轨
    ///   DeltaSink 发出。
    pub async fn produce(&mut self) -> RunOutcome {
        // ── T-40：run 启动前缓存测量装配 ────────────────────────
        // 冷缓存预警（P5 §3.4.4 请求启动路径）：实时轨 DeltaSink 发一次
        self.emit_cold_cache_warning_if_cold();
        // 模型切换检测（P5 §3.4.5）：上一 run model ≠ 当前 model → 记录
        let model_switched = self.detect_model_switch();
        if model_switched {
            tracing::info!(
                target: "engine",
                session_id = %self.session_id,
                previous_model = ?self.cache_session.last_model,
                current_model = ?self.current_model(),
                "缓存测量：检测到模型切换（miss 仍计数，归因 model-switch）"
            );
        }
        // 装配 CacheTrackingConfig（T-36 消费：LoopState 构造 /
        // run 起始 build_tracker 重建 tracker——fresh run 语义）
        self.options.cache.cache_tracking = self.cache_tracking.clone();

        // ── Round7：笔记真管线装配 ──────────────────────────────
        // 笔记后端经壳层注入工厂惰性获取（None = 打开失败 / 测试未安装 →
        // 工具 `note_backend_unwired`）。写入 `SessionLoopOptions.note_backend`
        // → `with_options` 注入 `ToolExecCtx.note_backend` → 工具
        // query_blocks / document_outline / document_apply_md / send_to_note
        // 走 DocSession + store 投影（禁止 mirror 默认读）。
        if self.options.assembly.note_backend.is_none() {
            if let Some(handle) = note_backend() {
                self.options.assembly.note_backend = Some(handle);
            }
        }

        // ── M1：上下文注入通道（C10 地基）────────────────────────
        // 注入段渲染进 system_prompt 面（wire 归类 system 角色）——独立于
        // 压缩预算。无注入段（None / 空注入器）时 render 原样返回 → 与
        // 现状字节一致。
        if let Some(injector) = &self.context_injector {
            self.options.assembly.system_prompt =
                injector.render(self.options.assembly.system_prompt.take());
        }

        let mut session_loop = AgentSessionLoop::new(
            self.session_id.as_str(),
            self.run_id.as_str(),
            self.max_turns,
            Box::new(SharedProvider {
                inner: Arc::clone(&self.provider),
                session_id: self.session_id.clone(),
            }),
            Arc::clone(&self.tool_registry),
        );
        session_loop = session_loop
            .with_options(self.options.clone())
            .with_tool_options(self.tool_options.clone())
            // C1b（统一输入流收敛 · 反向依赖移出）：steering 注入——核心
            // AgentSessionLoop::new() 不内建 RecoverySteeringStrategy
            // （不变量 5），本处为产品唯一 steering 注入点（漏注入 =
            // steering 失效：steering_enabled 默认 true 但策略 Vec 空 →
            // 空响应/预算耗尽不再注入纠偏）。
            .with_steering(SteeringCoordinator::new(
                vec![Box::new(RecoverySteeringStrategy::default())],
                SteeringCoordinatorOptions::default(),
            ));
        // 30-P1：run 控制面装配（with_options 之后、run() 之前——builder
        // 顺序契约）——壳层与 loop 同源：同一控制总线 + 同一 abort 信号
        // 实例（A4-H2 断头路消除：check_control 安全点真实消费外部意图）
        if let Some(bus) = &self.control_bus {
            session_loop = session_loop.with_control_bus(Arc::clone(bus));
        }
        if let Some(signal) = &self.abort_signal {
            session_loop = session_loop.with_abort_signal(signal.clone());
        }
        if let Some(approval) = &self.approval {
            session_loop = session_loop.with_approval(Arc::clone(approval));
        }
        if let Some(delta_sink) = &self.delta_sink {
            session_loop = session_loop.with_delta_sink(Arc::clone(delta_sink));
        }
        // 水合分支：预置对话经 with_initial_conversation_arc 一次性填充
        // （Arc 克隆便宜，0 深拷贝；P1 append-only 不变量：之后 loop 只追加）
        if let Some(initial_conversation) = &self.initial_conversation {
            if !initial_conversation.is_empty() {
                session_loop =
                    session_loop.with_initial_conversation_arc(initial_conversation.clone());
            }
        }
        let mut outcome = session_loop.run(self.user_message.clone()).await;

        // ── T-40：run 收口（P5 S5 §3.2 数据流）─────────────────
        // cache-stats-updated 入收口轨（outcome.events 由 drive_run_loop
        // 统一入队 + 信封注入 runId/sequence 发射）
        if let Some(stats) = &outcome.cache_stats {
            outcome
                .events
                .push(conex_types::events::AgentEvent::CacheStatsUpdated {
                    session_id: self.session_id.clone(),
                    timestamp: crate::engine_provider::now_iso_utc(),
                    stats: *stats,
                });
        }
        // cache-waste-alert（实时轨，P5 §3.4.2 阈值）：run 级累计浪费
        // 超阈值才打扰；金额阈值经 live 单价计算（价格缺失 → None 不估算）
        if let Some(stats) = &outcome.cache_stats {
            let (vendor, model) = self
                .cache_tracking
                .as_ref()
                .map_or(("auto", ""), |c| (c.provider.as_str(), c.model.as_str()));
            // plans/05 §3.6：浪费金额用同一份 live 单价（取价键 = 缓存跟踪
            // provider 串，与 yaml providers 键同值才命中；miss → None）
            let pricing = crate::pricing::live_model_pricing(vendor, model);
            if let Some(alert) =
                waste_alert_event(&self.session_id, stats, model_switched, pricing.as_ref())
            {
                if let Some(sink) = &self.delta_sink {
                    sink.push(alert);
                }
            }
        }
        outcome
    }

    /// 当前模型标识（缓存测量装配 / 模型切换检测用；未启用测量 → None）
    fn current_model(&self) -> Option<&str> {
        self.cache_tracking
            .as_ref()
            .map(|config| config.model.as_str())
    }

    /// 模型切换检测（上一 run model ≠ 当前 model）
    fn detect_model_switch(&self) -> bool {
        model_switched(
            self.cache_session.last_model.as_deref(),
            self.current_model(),
        )
    }

    /// 冷缓存预警（run 启动前；实时轨 DeltaSink 发一次）
    fn emit_cold_cache_warning_if_cold(&self) {
        let Some(sink) = &self.delta_sink else { return };
        let Some(config) = &self.cache_tracking else {
            return;
        };
        let Some(last) = &self.cache_session.last_stats else {
            return;
        };
        if let Some(event) =
            cold_cache_warning_event(&self.session_id, config, last, unix_millis_now())
        {
            sink.push(event);
        }
    }
}
