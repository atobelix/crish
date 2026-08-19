//! 构建面（SR-04 拆分 · engine.rs → engine_build.rs）
//!
//! 承载（D-03 SR-04 四面之 build 构建）：引擎句柄（[EngineHandle] 结构 +
//! 装配主路径 [EngineHandle::build] + 访问器/重载/注入面）+
//! Cron 调度注册表装配（[assemble_scheduler_registry]，
//! T-CF-09/A5）+ 缓存测量状态与预警事件（[SessionCacheState] /
//! [cold_cache_warning_event] / [waste_alert_event] / [model_switched]，
//! P5 S5/T-40）+ M1 上下文注入通道（[ContextInjector] /
//! [ContextInjection] / 子代理角色约束段）+ run 生产者
//! （[SessionLoopProducer] / [SharedProvider]，每 run 重建
//! [AgentSessionLoop]）。
//! 头钉：SR-04 · 拆分 · ≠ EL（结构拆分，不关任何 EL；仅搬移不改语义）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_provider::models::{cache_ttl_for_provider_model, infer_vendor, CacheTtl};
use agent_tools::audit::AuditSink;
use agent_tools::background::BackgroundTaskManager;
use agent_tools::definition::{ToolDefinition, ToolError};
use agent_tools::mcp::{register_plugin_server, McpClientBridge, McpServerConfig};
use agent_tools::registry::ToolRegistry;
use agent_tools::tools::kill_subagent::SubagentKillChannel;
use agent_tools::tools::send_message::{MainAgentMessageChannel, SubagentInjectChannel};
use agent_tools::tools::set_timer::TimerChannel;
use agent_tools::tools::wait_subagents::SubagentWaitChannel;
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_telemetry::cache::{
    cold_cache_check, is_cold, CacheBaseline, RequestSignature, WARN_MISSED_COST_USD,
    WARN_MISSED_TOKENS,
};
use conex_types::denied_stats::DeniedStats;
use conex_types::events::{AgentEvent, MissAttribution, RunCacheStats};
use conex_types::message::AgentMessage;
use conex_types::response::ClassifiedStreamError;
use orchestrator::PendingMessageQueue;
use session_loop::provider::{DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest};
use session_loop::{
    AbortSignal, AgentSessionLoop, ApprovalGate, CacheTrackingConfig, ControlBus,
    RecoverySteeringStrategy, RunOutcome, SessionLoopOptions, SteeringCoordinator,
    SteeringCoordinatorOptions, ToolBatchOptions,
};

use super::engine_audit::{RoutingAuditSink, WaitDispatchStore};
use super::engine_channels::ContinuityChannelBoard;
use super::engine_provider::{
    build_http_client, bundled_catalog, load_provider_endpoint, now_iso_utc, EngineProviderConfig,
    HttpProviderCall,
};
use crate::fs_commands::skills::RustSkill;
use crate::timers::{
    AgentEventSink, LocalDbTimerStore, MemoryTimerStore, QueuePendingSink, TimerRegistry,
};
use crate::watchdog::{LastWakeupTracker, Watchdog, WatchdogOptions};
use crish_agent_workbench::wait_channel::{
    ControlBusResolver, EventStreamBroadcast, LocalDbWaitStore, MemoryAgentSource, MemoryWaitStore,
    SubagentStatusSource, WaitChannel, WaitStore,
};

/// 毒丸恢复计数（B1-5 观测化：构建面 8 处锁中毒恢复次数——EngineHandle
/// provider / provider_config / ready_reason / cache_sessions 四锁；对齐
/// registry.rs / note_memory.rs 「tracing::error! 成对 + 计数」样板，
/// 零新依赖）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言面；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn build_poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}

/// 引擎句柄（B6.4：provider 生效配置 + 工具注册表 + engineReady）
///
/// - `ready()`：provider 配置三件套（baseUrl/model/apiKey）齐备即可发起
///   调用；加载失败仅降级未就绪（engine.rs:112-125），不 panic；
/// - 工具注册表：内置工具（fs/shell/search/diff，B5.2）注册失败仅告警
///   （工具执行器按 tool.not_found 兜底）；
/// - 跨会话并发安全：provider 只读共享（Mutex<Option<Arc<dyn ProviderCall>>>），
///   std Mutex 不跨 await 持有（AA-02 并发模型注记）。
pub(crate) struct EngineHandle {
    /// 共享 reqwest 客户端（连接池 / TLS 会话跨 run 复用；provider 重载时
    /// 重建适配层但复用同一客户端——AA-02 S-7 连接池语义保持）
    http_client: reqwest::Client,
    /// 生效的 provider 适配层（None = 配置缺失降级未就绪）
    pub(crate) provider: Mutex<Option<Arc<dyn ProviderCall>>>,
    /// 工具注册表（只读共享）
    tool_registry: Arc<ToolRegistry>,
    /// MCP 客户端桥（E5：插件 mcpServers 受管服务器 + 工具并入运行集；
    /// 生命周期随 run 启停由上层驱动——session.start 启动 / session.end
    /// 关闭，见 [Self::register_plugin_mcp_server]）
    mcp_bridge: Arc<McpClientBridge>,
    /// 浏览器会话槽（27 接线方案 S4：browser_* 工具与面板命令共享的
    /// 进程级惰性单例——BrowserManager + 会话槽 + estop 周期；装配失败
    /// 仅降级 not_ready，不阻断引擎构造，见 browser/mod.rs）
    browser_slot: Arc<crate::browser::BrowserSlot>,
    /// 电脑操作槽（维度 1：computer_* 工具与面板命令共享的进程级单例）
    computer_slot: Arc<crate::computer::ComputerSlot>,
    /// engineReady（配置齐备即 true）
    pub(crate) ready: AtomicBool,
    /// 未就绪原因（ready=false 时的诊断文案，PE-04 T04.5 联动）
    pub(crate) ready_reason: Mutex<Option<String>>,
    /// 生效 provider 配置快照（P5 S5 / T-40：缓存测量装配数据源；
    /// None = 未就绪）
    pub(crate) provider_config: Mutex<Option<EngineProviderConfig>>,
    /// 会话级缓存测量状态（T-40：跨 run 冷缓存预警 + 模型切换检测数据源；
    /// 内存态，跨重启由 runs 表 v5 列兜底——warm_until_ms 落库，T-39）
    cache_sessions: Mutex<HashMap<String, SessionCacheState>>,
    /// 定时器注册表（G5 T-CF-06/07：register/cancel/到期 steering 注入/
    /// 早退钩子；TimerChannel 契约实现，经 BuiltinToolConfig.timer_channel
    /// 注入 set_timer / cancel_timer 工具——engine.rs:617 装配处扩展）
    timer_registry: Arc<TimerRegistry>,
    /// 定时器 steering 落点（PendingMessageQueue 适配的底层队列；
    /// 到期条目落在真实队列，R-CF3 idle 续 run 装配收口消费——经
    /// [Self::timer_steering_queue] 访问器被 CoreRunState::new 消费，
    /// 陈旧 allow 已核销）
    timer_steering_queue: Arc<Mutex<PendingMessageQueue>>,
    /// 子代理等待通道（T-CF-10：SubagentWaitChannel 契约实现；经
    /// BuiltinToolConfig.subagent_wait_channel 注入 wait_subagents 工具）
    wait_channel: Arc<dyn SubagentWaitChannel>,
    /// dispatch 声明存储（WaitChannel 落库 / A7 watchdog 读取的共享
    /// 实例；conex-db session_meta 真适配接线见 wait_channel.rs 模块头
    /// 注记——与 TimerStore 同一接线缺口；装配分支（内存/真适配）经
    /// [WaitDispatchStore] 合并面稳定类型化，D4 §8 D-6）
    dispatch_store: Arc<dyn WaitDispatchStore>,
    /// subagent-ended 事件流广播（EventQueue 旁路适配：wait_for_terminal
    /// 的订阅面；经 [Self::terminal_stream] 访问器被 CoreRunState
    /// finalize_subagent_spawner 消费，陈旧 allow 已核销）
    terminal_stream: Arc<EventStreamBroadcast>,
    /// 最近事件唤醒跟踪（watchdog 失联判定数据源；事件收口处已接线：
    /// 壳层 drive_run_loop 事件 emit 循环与子代理终态收口调用
    /// mark_wakeup（R-CF3 核销），任何事件到达即更新）
    last_wakeup: Arc<LastWakeupTracker>,
    /// Cron 调度注册表（T-CF-09 A5 提供；None = 未装配降级，workflow
    /// 命令面经 main.rs（A9）消费——30 方案 P6/P7 后经
    /// [Self::scheduler_registry] 访问器被装配轮消费，allow 已核销）
    scheduler_registry: Option<Arc<crate::sched::SchedulerRegistry>>,
    /// 定时器事件缓冲（T-CF-06 装配产物；P4 drain 转发接线：经
    /// [Self::timer_event_sink] 暴露给 [forward_drained_timer_events] 与
    /// 批 3 main.rs drain 任务周期消费——事件不再终老于缓冲，A10 N-05）
    timer_event_sink: Arc<AgentEventSink>,
    /// cron 事件缓冲（T-CF-09 装配产物；同 timer 的 drain 转发路径——
    /// cron-fired 单臂，conex-types 仅 CronFired 变体，无 cron-cancelled）
    scheduler_event_sink: Arc<crate::sched::SchedEventSink>,
    /// 路由型审计 sink（15-T-6 裁决 D9）：工具级 security-audit 事件经
    /// run 级桥注册表送达前端审计面板（run 启动注册 / 收口注销由
    /// CoreRunState 驱动）；G10 denied 计数共享实例。任务域审计
    /// （10-P3）EventBridge 直发、不经本 sink（30 §9 域隔离）
    audit_sink: Arc<RoutingAuditSink>,
    /// 任务连续性通道板卡（审计 01 W1：kill_subagent / send_message 工具
    /// 三通道 + WaitChannel ControlBusResolver 的延迟绑定面；消费方 =
    /// CoreRunState::finalize_continuity_channels（main.rs 装配面），
    /// 已接线）
    continuity: Arc<ContinuityChannelBoard>,
    // T-D-13 精简：spawner 字段冗余（全仓无读取方，A8 D3）——实际
    // spawner 由 CoreRunState::finalize_subagent_spawner 自管，构造参数
    // 保留经 BuiltinToolConfig.subagent_spawner 注入 run_subagent 工具
}

impl EngineHandle {
    /// 初始化引擎（加载生效配置 + 内置工具注册；失败仅降级未就绪）。
    ///
    /// T-D-13：spawn 通道未注入（None）——run_subagent 返回
    /// common.unsupported 降级；生产装配走 [Self::new_with_spawner]。
    pub(crate) fn new(background_manager: Option<Arc<dyn BackgroundTaskManager>>) -> Self {
        Self::new_with_spawner(background_manager, None, None)
    }

    /// 初始化引擎并注入子代理 spawn 通道与 LocalDb 连接（T-D-13 生产
    /// 装配点：CoreRunState 创建 spawner 实例后传入，经
    /// BuiltinToolConfig.subagent_spawner 接线 run_subagent 工具；
    /// D6 §3.1 段 2 + D4 §3.8 ② 装配替换：`db: Option<LocalDb>`
    /// （W4 统一签名，CoreRunState::new 经 `store.as_local_db()` 下转
    /// 传入）——Some(db) → timer/sched/wait 三 store 真适配，
    /// None（InMemoryStore 测试替身）→ 内存版回退保测试面）。
    pub(crate) fn new_with_spawner(
        background_manager: Option<Arc<dyn BackgroundTaskManager>>,
        subagent_spawner: Option<Arc<dyn agent_tools::tools::subagent::SubagentSpawner>>,
        db: Option<LocalDb>,
    ) -> Self {
        // 34 §5.2 E-1（R-12）：attach 会话级开关值源 = BrowserToolsConfig
        // .mcp_attach_allowed（默认 false = 端点信息零暴露）；面板开关 →
        // 会话设置的写入面为 TODO（前端浏览器面板开关落盘后经配置读取，
        // 接线点登记见 34-MCPattach验证.md §5.2 E-1），现状 = 配置默认
        // （安全兜底）
        let mcp_attach_allowed =
            conex_browser_tools::BrowserToolsConfig::default().mcp_attach_allowed;
        Self::build(background_manager, subagent_spawner, mcp_attach_allowed, db)
    }

    /// 引擎装配主路径（new / new_with_spawner / 测试注入构造共用；
    /// `mcp_attach_allowed` 由生产入口从 [BrowserToolsConfig] 读取、
    /// 测试入口直接注入；`db` 为 timer/sched/wait 三 store 真适配的
    /// LocalDb 连接（None = 内存版回退））。
    pub(crate) fn build(
        background_manager: Option<Arc<dyn BackgroundTaskManager>>,
        subagent_spawner: Option<Arc<dyn agent_tools::tools::subagent::SubagentSpawner>>,
        mcp_attach_allowed: bool,
        db: Option<LocalDb>,
    ) -> Self {
        let client = Arc::new(build_http_client(None));

        // G5 T-CF-06/07：TimerRegistry 装配（pending sink = 真实
        // PendingMessageQueue、event sink = 缓冲适配、store = D6 §3.1
        // 段 2 装配替换：Some(db) → LocalDb 真适配（`timer_<id>` 键 +
        // `timer_ids` 索引，重启恢复数据面）；None → 内存版回退
        // （InMemoryStore 测试替身，测试面零改动））
        let timer_steering_queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        // P4（30 方案 §4）：事件缓冲实例由引擎持有（经
        // [Self::timer_event_sink] 访问器暴露给 drain 转发 helper 与
        // 批 3 main.rs drain 任务；TimerRegistry 注入同一 Arc——
        // 缓冲 → 转发同实例，不出现第二份无人消费的缓冲）
        let timer_event_sink = Arc::new(AgentEventSink::new());
        // 显式 trait 化（先 clone 出 Arc<AgentEventSink> 再经赋值 unsize
        // 强转——Arc::clone 泛型推断无法经引用反向强转）
        let timer_event_sink_trait: Arc<dyn crate::timers::EventSink> = timer_event_sink.clone();
        // 装配分支（LocalDb 真适配 / 内存回退）经 dyn TimerStore 收口
        let timer_store: Arc<dyn crate::timers::TimerStore> = match &db {
            Some(db) => Arc::new(LocalDbTimerStore::new(db.clone())),
            None => MemoryTimerStore::shared(),
        };
        let timer_registry = Arc::new(TimerRegistry::new(
            Arc::new(QueuePendingSink::new(Arc::clone(&timer_steering_queue))),
            timer_event_sink_trait,
            timer_store,
        ));
        // 启动恢复：扫描已持久化声明，重建未到期定时器 / 补发已到期未
        // 注入（内存 store 下为空集；conex-db 真适配接线后此处即重启
        // 恢复入口——T-CF-06 §4）。try_current 守卫：纯同步构造上下文
        // （无 tokio runtime 的测试/装配路径）跳过，不 panic。
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn({
                let registry = Arc::clone(&timer_registry);
                async move {
                    registry.restore().await;
                }
            });
        } else {
            tracing::debug!(
                target: "engine",
                "TimerRegistry 启动恢复跳过：当前上下文无 tokio runtime"
            );
        }

        // ── T-CF-10：WaitChannel 装配（SubagentWaitChannel 契约实现）──
        // dispatch 声明存储与 A7 watchdog 共享（同一实例双 trait 注入，
        // 桥接 impl 见文件头部「T-CF-10/13 共享适配桥」段）；终态事件流
        // 广播为事件收口旁路点的订阅面（wait 通道不直接持有 EventQueue）。
        // D4 §3.8 ② 装配替换：Some(db) → LocalDbWaitStore 真适配
        // （dispatch_* 五键单声明槽）；None → MemoryWaitStore 内存回退。
        let dispatch_store: Arc<dyn WaitDispatchStore> = match &db {
            Some(db) => Arc::new(LocalDbWaitStore::new(db.clone())),
            None => Arc::new(MemoryWaitStore::new()),
        };
        // 审计 01 W1（任务连续性推进轮）：三通道 + 控制总线解析器延迟绑定
        // 板卡——WaitChannel 的 inject 面（wait_subagents 运行中注入）与
        // BuiltinToolConfig 三通道字段（kill_subagent / send_message 工具）
        // 均注入本板卡；CoreRunState 构造完成后经
        // finalize_continuity_channels（main.rs 装配面）绑定真实现——
        // 未绑定窗口内 resolver 恒 None（inject 返回结构化 InjectFailed）、
        // 通道返回未绑定错误，行为与装配前一致（生产装配毫秒级完成）
        let continuity = Arc::new(ContinuityChannelBoard::new());
        let terminal_stream = Arc::new(EventStreamBroadcast::new());
        let wait_channel = Arc::new(WaitChannel::new(
            Arc::clone(&dispatch_store) as Arc<dyn WaitStore>,
            Arc::new(MemoryAgentSource::new()) as Arc<dyn SubagentStatusSource>,
            Arc::clone(&terminal_stream),
            // 生产缺省 NoopControlBusResolver 由板卡取代（真实解析 = 活动
            // run 注册表；板卡未绑定 = Noop 同语义——恒 None）
            Arc::clone(&continuity) as Arc<dyn ControlBusResolver>,
        ));

        // ── T-CF-13：最近事件唤醒跟踪装配 ──
        // 最近事件唤醒跟踪（事件收口处 mark_wakeup 已接线：壳层事件
        // emit 循环与子代理终态收口驱动，R-CF3 核销）
        let last_wakeup = Arc::new(LastWakeupTracker::new());

        // ── T-CF-09：SchedulerRegistry 装配（A5 提供 pub(crate) 构造器）──
        // 已按 A5 落盘签名对齐（pending/events/store/launcher 四适配；
        // launcher 未接线 → is_daemon 触发降级 steering 注入，防丢唤醒）。
        // P4：事件缓冲实例由引擎持有（同 timer_event_sink 模式，经
        // [Self::scheduler_event_sink] 暴露给 drain 转发路径）
        let scheduler_event_sink = Arc::new(crate::sched::SchedEventSink::new());
        let scheduler_registry = assemble_scheduler_registry(
            &timer_steering_queue,
            Arc::clone(&scheduler_event_sink),
            db.clone(),
        );

        // ── 15-T-6（裁决 D9）：路由型 audit_sink 装配 ──────────────
        // G10 denied 计数实例（引擎级共享；workbench 侧零 DeniedStats
        // 使用点实证——本装配即接线点）+ run 级桥注册表。工具级审计
        // （shell/delete 的 security-audit，现状 NoopAuditSink 静默丢弃）
        // 经 BuiltinToolConfig.audit_sink 注入本 sink，run 启动注册 /
        // 收口注销由 CoreRunState 驱动（core_run_commands.rs run 装配
        // 块）。域隔离：任务域审计（10-P3 TaskAuditAccumulator →
        // EventBridge 直发）不经本 sink（30 §9 最终口径）。
        let audit_sink = Arc::new(RoutingAuditSink::new(Arc::new(DeniedStats::new())));

        // 内置工具注册（B5.2：fs / shell / search / diff；F1 R-AB1：
        // BuiltinToolConfig 注入后台任务管理器，经 ToolContext.background
        // 透传给 shell 工具——adopt 通道就位；G5 T-CF-05/06：timer_channel
        // 注入 TimerRegistry 契约，set_timer / cancel_timer 工具消费；
        // T-CF-10：subagent_wait_channel 注入 WaitChannel 契约，
        // wait_subagents 工具消费）
        let mut registry = ToolRegistry::new();
        let config = agent_tools::tools::BuiltinToolConfig {
            background_manager,
            timer_channel: Some(Arc::clone(&timer_registry) as Arc<dyn TimerChannel>),
            // 装配收口（T-CF-10）：BuiltinToolConfig 全字段显式注入后改走
            // register_builtin_tools_with_config（现状默认注册处）；未装配
            // 字段保持 Default（None 语义，工具返回 common.unsupported 降级）
            subagent_wait_channel: Some(Arc::clone(&wait_channel) as Arc<dyn SubagentWaitChannel>),
            // T-D-13：子代理 spawn 通道注入（None = run_subagent 返回
            // common.unsupported；生产装配点 = CoreRunState 构造 spawner 后
            // 经 new_with_spawner 传入）
            subagent_spawner: subagent_spawner.clone(),
            // 审计 01 W1（任务连续性推进轮）：kill_subagent / send_message
            // 三通道注入板卡（延迟绑定——真实现经 finalize_continuity_channels
            // 绑定；未绑定 = 通道返回结构化未绑定错误，行为与装配前一致）
            subagent_kill_channel: Some(Arc::clone(&continuity) as Arc<dyn SubagentKillChannel>),
            subagent_inject_channel: Some(Arc::clone(&continuity) as Arc<dyn SubagentInjectChannel>),
            main_agent_message_channel: Some(
                Arc::clone(&continuity) as Arc<dyn MainAgentMessageChannel>
            ),
            // 15-T-6（裁决 D9）：路由型审计 sink 注入（shell/delete 工具
            // security-audit 发射点接线；现状 None = NoopAuditSink 静默
            // 丢弃，接线后经 run 桥到达前端审计面板）
            audit_sink: Some(Arc::clone(&audit_sink) as AuditSink),
            ..agent_tools::tools::BuiltinToolConfig::default()
        };
        if let Err(error) =
            agent_tools::tools::register_builtin_tools_with_config(&mut registry, config)
        {
            tracing::warn!(
                target: "engine",
                error = %error,
                "内置工具注册失败（工具按 tool.not_found 兜底）"
            );
        }
        // ── 27 方案 S4：browser_* 工具族注册（浏览器会话槽接线）──────
        // 进程级惰性单例：BrowserSlot 持有 BrowserManager（惰性启动）与
        // 会话槽；LazySessionOps 实现 SessionOps 经 BrowserToolsConfig
        // .session_ops 注入 23 个 browser_* 工具（维度 17 §1.1 后置注册，
        // **不进** register_builtin_tools——注册数断言不可扰动，17 §1.1）。
        // 门禁注入槽内同一 MvpDomainGate 实例（动作执行器与导航检查点
        // 单点真源）。数据根解析失败 → 降级槽（全操作 not_ready），注册
        // 照常进行；注册失败仅 warn 降级（对齐内置工具先例，27 §5 风险
        // 预案：仅缺 browser_*，模型侧 tool.not_found / not_ready 兜底）。
        // 34 §5.2 E-1（R-12）：attach 会话级开关装配——将
        // mcp_attach_allowed（来自 BrowserToolsConfig 会话级配置，默认
        // false = 端点信息零暴露）注入 BrowserSlot
        // （with_mcp_attach_allowed）；面板开关 → 会话设置的写入面 TODO
        // 见 [Self::new_with_spawner] 值源注释（现状 = 配置默认，安全兜底）。
        let browser_slot = Arc::new(
            crate::browser::BrowserSlot::new().with_mcp_attach_allowed(mcp_attach_allowed),
        );
        let browser_ops: Arc<dyn conex_browser_tools::session::SessionOps> = Arc::new(
            crate::browser::LazySessionOps::new(Arc::clone(&browser_slot)),
        );
        if let Err(error) = conex_browser_tools::register_browser_tools(
            &mut registry,
            conex_browser_tools::BrowserToolsConfig {
                session_ops: Some(browser_ops),
                gate: Some(browser_slot.gate()),
                // 与槽同一值源（register 不消费该字段，仅随会话级配置携带，
                // 34 §5.1：引擎侧会话装配是消费面）
                mcp_attach_allowed,
                ..conex_browser_tools::BrowserToolsConfig::default()
            },
        ) {
            tracing::warn!(
                target: "engine",
                error = %error,
                "browser_* 工具注册失败（工具按 tool.not_found 兜底）"
            );
        }
        let computer_slot = Arc::new(crate::computer::ComputerSlot::from_store(Arc::new(crate::computer::LocalDbComputerMetaStore::new(db.clone().expect("LocalDb for computer_slot")))));
        let tool_registry = Arc::new(registry);
        // E5：MCP 客户端桥初始化（stdio 服务器管理 + 工具适配；插件
        // mcpServers 经 register_plugin_mcp_server 注册为受管服务器）
        let mcp_bridge = Arc::new(McpClientBridge::new());

        // provider 生效配置加载（三件套齐备才就绪）
        let (provider, ready, ready_reason, provider_config) = match load_provider_endpoint() {
            Some(config) => {
                let provider: Arc<dyn ProviderCall> =
                    Arc::new(HttpProviderCall::new((*client).clone(), config.clone()));
                (Some(provider), true, None, Some(config))
            }
            None => {
                tracing::warn!(
                    target: "engine",
                    "engine not ready: provider 配置缺失（baseUrl/model/apiKey 三件套）"
                );
                (
                    None,
                    false,
                    Some("provider 配置缺失（baseUrl/model/apiKey）".to_string()),
                    None,
                )
            }
        };

        Self {
            http_client: (*client).clone(),
            provider: Mutex::new(provider),
            tool_registry,
            mcp_bridge,
            browser_slot,
            computer_slot,
            ready: AtomicBool::new(ready),
            ready_reason: Mutex::new(ready_reason),
            provider_config: Mutex::new(provider_config),
            cache_sessions: Mutex::new(HashMap::new()),
            timer_registry,
            timer_steering_queue,
            wait_channel,
            dispatch_store,
            terminal_stream,
            last_wakeup,
            scheduler_registry,
            timer_event_sink,
            scheduler_event_sink,
            audit_sink,
            continuity,
        }
    }

    /// engineReady（provider 配置齐备即可发起调用）
    pub(crate) fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// 未就绪原因（ready=false 时的诊断文案）
    pub(crate) fn ready_reason(&self) -> Option<String> {
        self.ready_reason
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "EngineHandle ready_reason 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
    }

    /// 生效的 provider 适配层（None = 未就绪）
    pub(crate) fn provider(&self) -> Option<Arc<dyn ProviderCall>> {
        self.provider
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "EngineHandle provider 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
    }

    /// 共享 reqwest 客户端克隆（ProviderSummarizer 复用连接池——AA-02 S-7；
    /// provider 重载重建适配层但复用同一客户端，摘要面同源）
    pub(crate) fn http_client(&self) -> reqwest::Client {
        self.http_client.clone()
    }

    /// 重建 provider 适配层并原子交换（F4 F1-01 修复，PS-04 T4.3 接线点：
    /// `config_profile_apply` / `config_update` 写 store 成功后调用，下一次
    /// run 立即使用新凭据——key/baseUrl/model 热更新）。
    ///
    /// 根因注记：`HttpProviderCall` 持有构造时 `EngineProviderConfig` 快照
    /// （:285-291），旧实现只在引擎构造时加载一次（:927-945），运行期改配置
    /// 后 `provider()` 取回的仍是旧适配层（F4 F1-01）。本方法从 store 重新
    /// `load_provider_endpoint()` → 重建适配层（复用共享连接池客户端）→ Mutex
    /// 短临界区原子交换 provider + provider_config + ready/ready_reason；
    /// 全程无 await（模式对齐 `inject_provider_for_test` :975-985）。
    /// 重建失败（三件套缺失，如 apiKey 清空）→ provider=None + ready=false +
    /// ready_reason 文案，与构造时降级语义一致。
    pub(crate) fn reload_provider(&self) {
        let (provider, ready, ready_reason, provider_config) = match load_provider_endpoint() {
            Some(config) => {
                let provider: Arc<dyn ProviderCall> = Arc::new(HttpProviderCall::new(
                    self.http_client.clone(),
                    config.clone(),
                ));
                (Some(provider), true, None, Some(config))
            }
            None => {
                tracing::warn!(
                    target: "engine",
                    "engine not ready: provider 配置缺失（baseUrl/model/apiKey 三件套，apply 后重载）"
                );
                (
                    None,
                    false,
                    Some("provider 配置缺失（baseUrl/model/apiKey）".to_string()),
                    None,
                )
            }
        };
        *self.provider.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "EngineHandle provider 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = provider;
        *self.provider_config.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "EngineHandle provider_config 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = provider_config;
        self.ready.store(ready, Ordering::SeqCst);
        *self.ready_reason.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "EngineHandle ready_reason 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = ready_reason;
    }

    /// 工具注册表（只读共享）
    pub(crate) fn tool_registry(&self) -> Arc<ToolRegistry> {
        Arc::clone(&self.tool_registry)
    }

    /// MCP 客户端桥（E5；上层 run 启停驱动用——session.start 启动 /
    /// session.end `stop_all` 关闭）
    #[allow(dead_code)] // E5 接线：core_run_commands 装配 run 启停时消费
    pub(crate) fn mcp_bridge(&self) -> Arc<McpClientBridge> {
        Arc::clone(&self.mcp_bridge)
    }

    /// 浏览器会话槽（27 方案 S4/S5/S6：run 装配 abort 桥（S5）、面板命令
    /// browser_commands（S6）与浏览器模块消费；进程级单例）
    pub(crate) fn browser_slot(&self) -> Arc<crate::browser::BrowserSlot> {
        Arc::clone(&self.browser_slot)
    }

    /// 电脑操作槽（维度 1：run 装配 abort 桥、面板命令；进程级单例）
    pub(crate) fn computer_slot(&self) -> Arc<crate::computer::ComputerSlot> {
        Arc::clone(&self.computer_slot)
    }

    /// 定时器注册表（T-CF-06 装配产物；TimerChannel 契约经
    /// BuiltinToolConfig.timer_channel 注入工具注册；消费方 =
    /// CoreRunState::new 装配 timer_has_active 判定器，已接线）
    pub(crate) fn timer_registry(&self) -> Arc<TimerRegistry> {
        Arc::clone(&self.timer_registry)
    }

    /// 路由型审计 sink（15-T-6 装配产物；消费方 = CoreRunState run
    /// 启动注册 / 收口注销，已接线）
    pub(crate) fn audit_sink(&self) -> Arc<RoutingAuditSink> {
        Arc::clone(&self.audit_sink)
    }

    /// 定时器 steering 队列（到期条目落点；R-CF3 idle 续 run 消费——
    /// CoreRunState::new 经本访问器取共享队列，已接线）
    pub(crate) fn timer_steering_queue(&self) -> Arc<Mutex<PendingMessageQueue>> {
        Arc::clone(&self.timer_steering_queue)
    }

    /// 子代理等待通道（T-CF-10 装配产物；SubagentWaitChannel 契约面，
    /// 与注入 wait_subagents 工具的是同一实例）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费；生产经工具注册表消费
    pub(crate) fn wait_channel(&self) -> Arc<dyn SubagentWaitChannel> {
        Arc::clone(&self.wait_channel)
    }

    /// dispatch 声明存储（T-CF-10/13 共享实例；wait 落库 / watchdog 读取
    /// / 测试断言读面；返回类型经 [WaitDispatchStore] 合并面稳定——
    /// 装配分支（内存/真适配）不漂移，D4 §8 D-6）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费
    pub(crate) fn dispatch_store(&self) -> Arc<dyn WaitDispatchStore> {
        Arc::clone(&self.dispatch_store)
    }

    /// 终态事件流广播（T-CF-10：事件收口旁路点 feed 接线用——任何
    /// subagent-ended 事件到达即灌入广播，wait 订阅者同步消费；消费方 =
    /// CoreRunState finalize_subagent_spawner，已接线）
    pub(crate) fn terminal_stream(&self) -> Arc<EventStreamBroadcast> {
        Arc::clone(&self.terminal_stream)
    }

    /// 任务连续性通道板卡（审计 01 W1：kill_subagent / send_message 工具
    /// 三通道 + WaitChannel ControlBusResolver 的延迟绑定面；消费方 =
    /// CoreRunState::finalize_continuity_channels（main.rs 装配面，
    /// 与 finalize_subagent_spawner 同批），已接线）
    pub(crate) fn continuity(&self) -> Arc<ContinuityChannelBoard> {
        Arc::clone(&self.continuity)
    }

    /// 最近事件唤醒跟踪（T-CF-13：事件收口处 mark_wakeup 接线消费方 =
    /// core_run_commands drive_run_loop 事件 emit 循环与子代理终态收口，
    /// 已接线）
    pub(crate) fn last_wakeup(&self) -> Arc<LastWakeupTracker> {
        Arc::clone(&self.last_wakeup)
    }

    /// 为会话动态创建 Watchdog 实例（SESS-01 消除全局空串单例）
    #[allow(dead_code)]
    pub(crate) fn create_session_watchdog(&self, session_id: &str) -> Arc<Watchdog> {
        let sid = session_id.to_string();
        let tr = Arc::clone(&self.timer_registry);
        let sid_for_probe = sid.clone();
        Arc::new(Watchdog::new(
            sid,
            Arc::clone(&self.timer_steering_queue),
            Arc::clone(&self.dispatch_store) as Arc<dyn crate::watchdog::DispatchStore>,
            Arc::clone(&self.last_wakeup),
            Arc::new(move || tr.active_count_for_session(&sid_for_probe)),
            WatchdogOptions::default(),
        ))
    }

    /// Cron 调度注册表（T-CF-09 装配产物；None = 未装配降级；
    /// 消费方：CoreRunState::new（P7 cron_has_enabled 判定器装配）+
    /// main.rs 装配轮（P6 WorkflowBackend::set_registry），已接线）
    pub(crate) fn scheduler_registry(&self) -> Option<Arc<crate::sched::SchedulerRegistry>> {
        self.scheduler_registry.clone()
    }

    /// 定时器事件缓冲（T-CF-06 装配产物；P4 drain 转发路径的入口——
    /// [forward_drained_timer_events] 与本测试面消费，main.rs
    /// drain 任务经本访问器周期取走缓冲转发到 EventBridge，已接线）
    pub(crate) fn timer_event_sink(&self) -> Arc<crate::timers::AgentEventSink> {
        Arc::clone(&self.timer_event_sink)
    }

    /// cron 事件缓冲（T-CF-09 装配产物；drain 转发路径同 timer——
    /// cron-fired 单臂，conex-types 仅 CronFired 变体，cancel 走
    /// 数据面 + steering 面，无 cron-cancelled 发射目标；main.rs
    /// drain 任务经本访问器消费，已接线）
    pub(crate) fn scheduler_event_sink(&self) -> Arc<crate::sched::SchedEventSink> {
        Arc::clone(&self.scheduler_event_sink)
    }

    /// 注册插件 MCP server（E5 内容 1）：PluginMcpDeclaration（stdio
    /// command/args/env）→ 受管服务器（spawn + 握手 + 枚举）→ 工具并入
    /// ToolRegistry 运行集（`mcp_<server>__<tool>` 命名，供
    /// `list_definitions` 消费——与 E4 on_definition 共享构建点）。
    ///
    /// E2 统一门面登记（统一输入流收敛 · 扩展门面详案 §1①）：本方法是
    /// **插件 MCP 接入的唯一生产装配入口方法**（canonical 出口，底层经
    /// `agent_tools::mcp::register_plugin_server`）——**已登记**，不属
    /// 未接线悬挂。生产装配链接线点 = run/ 装配区用户声明 mcpServers
    /// 注册处（E-4 收口项，本批不存在；R8 该装配区归 T5 独占域，
    /// 接线后移除本 allow——详见详案 E2 §1① 评估框）。测试消费实证：
    /// engine_tests.rs:2263 `register_plugin_mcp_server_integration`
    /// （启动失败不污染注册表 / 成功并入 / 幂等三重断言）。
    ///
    /// 启动失败 → mcp.* 错误上抛（调用方承接为插件级错误进
    /// runtime-error，不阻塞 run）；服务器生命周期随 run 启停由上层
    /// 驱动（本方法只注册并入，启停经 [Self::mcp_bridge]）。
    #[cfg_attr(not(test), allow(dead_code))] // E2 已登记：canonical 出口（见上），生产装配链接线点 = run/ 装配区（E-4 收口项，T5 独占域接线后移除）
    pub(crate) async fn register_plugin_mcp_server(
        &self,
        config: McpServerConfig,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        register_plugin_server(&self.mcp_bridge, &self.tool_registry, &config).await
    }

    /// 34 §5.2 E-1/E-4（R-12）：attach 型浏览器类 MCP server 的启动配置
    /// 注入（`--browserUrl` 附加受管实例 CDP 端点）。
    ///
    /// 消费路径（E-1/E-2 守卫 + 平台分派，实现见
    /// [crate::browser::mcp_attach]）：
    /// - `browser_slot.mcp_attach_endpoint()` 守卫取端点——开关关闭
    ///   （默认）→ `tool.browser.capability_disabled`（端点信息零暴露，
    ///   任何进程状态下不返回）；开关开启但受管实例未就绪 →
    ///   `tool.browser.not_ready`；开关开启且就绪 → 注入形态载荷
    ///   `http://127.0.0.1:<port>`；
    /// - 就绪时经 `mcp_attach::mcp_attach_server_config` 构建
    ///   `McpServerConfig`（Windows `cmd /c npx` 分派 + 官方包名
    ///   `chrome-devtools-mcp` + `--browserUrl`，34 §4.1/§4.2）。
    ///
    /// 接线点登记（E2 统一门面 · 详案 E2 §1① 评估框）：插件 mcpServers
    /// 装配点（run/ 装配区用户声明 server 处，本批不存在；R8 该装配区
    /// 归 T5 独占域）识别 chrome-devtools-mcp 族 server 后调用本方法，
    /// 把返回值经 [Self::register_plugin_mcp_server] 注册——**已登记**
    /// 不属未接线悬挂，接线后移除本 allow；E-3 只读能力集
    /// （R-12 核心拦截面，MCP 自身不拒绝求值）为引擎侧 CDP 会话面
    /// 独立接线项，登记见 34-MCPattach验证.md §5.2。
    #[cfg_attr(not(test), allow(dead_code))] // E2 已登记：E-4 装配面（同上），T5 独占域接线后移除
    pub(crate) fn browser_attach_mcp_server_config(
        &self,
        server_id: &str,
    ) -> Result<McpServerConfig, ToolError> {
        let endpoint = self.browser_slot.mcp_attach_endpoint()?;
        Ok(crate::browser::mcp_attach::mcp_attach_server_config(
            server_id,
            &endpoint.browser_url,
            cfg!(windows),
        ))
    }

    // ── E5 内容 3：C10 注入读取面（skills.rs RustSkill → 注入段）──────

    /// C10 Skills 注入段：RustSkill 扫描结果 → `## Skill 定义` 注入段。
    ///
    /// 每次上下文构建重新读取（不与会话历史共享压缩预算——注入段经
    /// [ContextInjector::render] 汇入 system_prompt 面，压缩只作用于
    /// 会话对话）；渲染确定：同一技能集合两次构建字节一致（C10 字节级
    /// 一致断言）。技能条目格式：
    /// `- <name>（系统）（<scope>）：<description>\n<content>`
    #[allow(dead_code)] // E5 接线：core_run_commands 装配 ContextInjector 时消费
    pub(crate) fn skill_context_injection(skills: &[RustSkill]) -> ContextInjection {
        let content = skills
            .iter()
            .map(|skill| {
                format!(
                    "- {}{}（{}）：{}\n{}",
                    skill.name(),
                    if skill.is_system() {
                        "（系统）"
                    } else {
                        ""
                    },
                    skill.scope(),
                    skill.description(),
                    skill.content()
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        ContextInjection::new(ContextInjectionKind::Skills, "Skill 定义", content)
    }

    /// C10 MCP 工具声明注入段：已并入注册表的 MCP 工具定义 →
    /// `## MCP 工具声明` 注入段（与 E4 on_definition 共享
    /// `list_definitions` 构建点；渲染确定，可字节级断言）。
    #[allow(dead_code)] // E5 接线：core_run_commands 装配 ContextInjector 时消费
    pub(crate) fn mcp_context_injection(defs: &[ToolDefinition]) -> ContextInjection {
        let content = defs
            .iter()
            .map(|def| format!("- {}：{}", def.name, def.description))
            .collect::<Vec<_>>()
            .join("\n");
        ContextInjection::new(ContextInjectionKind::Mcp, "MCP 工具声明", content)
    }

    // ── P5 S5 / T-40：缓存测量装配（轮末合并接线点）──────────────

    /// 生效 provider 配置（缓存测量装配数据源；None = 未就绪）。
    /// 注：core_run_commands 装配 SessionLoopProducer 时经
    /// [Self::cache_tracking_config] 消费本值——T-40 轮末合并接线。
    #[allow(dead_code)] // T-40 轮末合并接线：core_run_commands 装配 producer 时消费（A8 §1.2 登记面），接线后移除
    pub(crate) fn provider_config(&self) -> Option<EngineProviderConfig> {
        self.provider_config
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "EngineHandle provider_config 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
    }

    /// 解析缓存跟踪配置（P5 S5 / T-40）：provider / model 取生效配置、
    /// TTL 走 P3 `cache_ttl_for_provider_model` 路由表（T-21）——未知厂商 /
    /// 无 TTL 数据 → ttl_seconds = 0（P5 §3.4.4「TTL 查询失败不提示」，
    /// 不阻塞其他功能）。
    #[allow(dead_code)] // T-40 轮末合并：core_run_task 装配 producer 时消费
    pub(crate) fn cache_tracking_config(&self) -> Option<CacheTrackingConfig> {
        let config = self.provider_config()?;
        Some(build_cache_tracking_config(&config))
    }

    /// 会话缓存测量状态（上一 run 快照；core_run_task 装配 producer 时
    /// 经 [SessionLoopProducer::with_cache_session] 注入，T-40）
    #[allow(dead_code)] // T-40 轮末合并接线
    pub(crate) fn cache_session(&self, session_id: &str) -> SessionCacheState {
        self.cache_sessions
            .lock()
            .unwrap_or_else(|e| {
                // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
                tracing::error!(
                    target: "engine",
                    "EngineHandle cache_sessions 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 收口写回会话缓存状态（drive_run_loop 在 produce 后调用，
    /// T-40 轮末合并接线；供下一 run 冷缓存预警 / 模型切换检测）
    #[allow(dead_code)] // T-40 轮末合并接线：drive_run_loop 收口写回会话缓存状态（A8 §1.2 登记面），接线后移除
    pub(crate) fn update_cache_session(
        &self,
        session_id: &str,
        stats: &RunCacheStats,
        model: &str,
    ) {
        let mut sessions = self.cache_sessions.lock().unwrap_or_else(|e| {
            // B1-5 观测化：锁中毒恢复，不 panic 且可继续（恢复语义不变）
            tracing::error!(
                target: "engine",
                "EngineHandle cache_sessions 锁中毒，按恢复模式继续：{e}"
            );
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let state = sessions.entry(session_id.to_string()).or_default();
        state.last_stats = Some(*stats);
        state.last_model = Some(model.to_string());
    }
}
impl Default for EngineHandle {
    fn default() -> Self {
        Self::new(None)
    }
}
/// T-CF-09：Cron 调度注册表装配（A5 提供 pub(crate) 构造器与 restore；
/// 已按 A5 落盘签名对齐：pending / events / store / launcher 四适配——
/// pending 落真实 PendingMessageQueue（与定时器同队列）、events 用 sched
/// 的事件槽（缓冲 + 日志，EventBridge 真适配后续轮）、store 用 D6 §3.1
/// 段 2 装配替换：Some(db) → LocalDb 真适配（`sched_<id>` 键 + `sched_ids`
/// 索引）；None → 内存版回退）。
///
/// is_daemon 独立 run 拉起点（[crate::sched::DaemonRunLauncher]）暂不
/// 接线：RunProducer 的 prompt 注入适配在 A8 域（T-CF-11 core_run_commands），
/// 未接线时 daemon 触发降级为 steering 注入（sched.rs 防丢唤醒语义）。
///
/// 装配失败降级（None 保持 unsupported 语义，不阻塞引擎启动）。
/// event sink 由引擎持有（P4：缓冲实例经 [EngineHandle::scheduler_event_sink]
/// 暴露，drain 转发路径与 TimerRegistry 侧同模式）。
pub(crate) fn assemble_scheduler_registry(
    timer_steering_queue: &Arc<Mutex<PendingMessageQueue>>,
    scheduler_event_sink: Arc<crate::sched::SchedEventSink>,
    db: Option<LocalDb>,
) -> Option<Arc<crate::sched::SchedulerRegistry>> {
    // 装配分支（LocalDb 真适配 / 内存回退）经 dyn SchedStore 收口
    let sched_store: Arc<dyn crate::sched::SchedStore> = match &db {
        Some(db) => Arc::new(crate::sched::LocalDbSchedStore::new(db.clone())),
        None => crate::sched::MemorySchedStore::shared(),
    };
    let registry = Arc::new(crate::sched::SchedulerRegistry::new(
        Arc::new(crate::sched::QueuePendingSink::new(Arc::clone(
            timer_steering_queue,
        ))),
        scheduler_event_sink,
        sched_store,
        None,
    ));
    // 启动恢复：扫描已持久化声明重建 cron sleep（与 TimerRegistry::restore
    // 同模式；try_current 守卫：纯同步构造上下文跳过，不 panic）
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
        let registry = Arc::clone(&registry);
        runtime.spawn(async move {
            registry.restore().await;
        });
    } else {
        tracing::debug!(
            target: "engine",
            "SchedulerRegistry 启动恢复跳过：当前上下文无 tokio runtime"
        );
    }
    Some(registry)
}
// ── P5 S5 / T-40：缓存测量引擎侧装配 ──────────────────────────────

/// 会话级缓存测量状态（engine 层跨 run 维护；T-40）
///
/// 跨 run 持久化边界（对齐 cache_tracker.rs 模块注释「基线经
/// [CacheStatsTracker::baseline] 交还调用方（engine 层跨 run 持久化归
/// T-40）」）：
/// - 本状态只保留**可观测标量**（warm_until_ms / input_total / model），
///   不保留请求签名哈希——签名基线在 loop 内每 run 重建（T-36 现状），
///   跨 run 签名续接（detect 的 min(prev,cur) 基线）属 session-loop 侧
///   待接线项，见轮末汇总物声明；本层不做假签名；
/// - 冷缓存预警 = 上一 run warm_until_ms 过期判定（与前端 tick 路径同
///   口径，P5 §3.4.4）；模型切换 = 上一 run model ≠ 当前 model
///   （P5 §3.4.5 归因数据源）。
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionCacheState {
    /// 最近一次 run 的缓存统计（warm_until_ms 过期判定 + 重发量估算）
    pub last_stats: Option<RunCacheStats>,
    /// 最近一次 run 的模型标识（模型切换检测）
    pub last_model: Option<String>,
}

/// 装配缓存跟踪配置（T-40：provider / model 取生效配置、TTL 走 P3
/// `cache_ttl_for_provider_model` 路由表，T-21）；未知厂商 / 无 TTL 数据
/// → ttl_seconds = 0（P5 §3.4.4「TTL 查询失败不提示」，不阻塞其他功能）。
pub(crate) fn build_cache_tracking_config(config: &EngineProviderConfig) -> CacheTrackingConfig {
    let vendor = infer_vendor(&config.base_url, &config.model);
    let ttl_seconds = cache_ttl_for_provider_model(Some(bundled_catalog()), vendor, &config.model)
        .map(CacheTtl::seconds)
        .unwrap_or(0);
    CacheTrackingConfig {
        provider: vendor.as_str().to_string(),
        model: config.model.clone(),
        ttl_seconds,
    }
}

/// 当前 UTC 毫秒时间戳（epoch ms；冷缓存预警判定用）
pub(crate) fn unix_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 冷缓存预警事件（P5 §3.4.4 请求启动路径，辅助路径）：上一 run 温暖截止
/// 已过期 → Some。
///
/// 实现说明（2026-08-09 零消费清理，DEEPCHECK-05 #5）：本函数统一消费
/// `conex-telemetry::cache` 纯函数底座（[`cold_cache_check`] / [`is_cold`]，
/// cold.rs），不再自实现"过期判定 + idle 反解 + 重发量累加"口径——跨 run
/// 数据面只有 `RunCacheStats.warm_until_ms`（= 完成时刻 + TTL × 1000，
/// tracker.finish 口径），因此先按 `warm = completed_at + ttl × 1000` 反解
/// 出完成时刻、以 C9 恒等式（miss + read + write）重建 input_total，构造
/// 临时 [CacheBaseline] 后交由纯函数判定；TTL 未知（0）或无温暖截止 →
/// None（P5 §3.4.4 不提示）。
pub(crate) fn cold_cache_warning_event(
    session_id: &str,
    config: &CacheTrackingConfig,
    last: &RunCacheStats,
    now_ms: u64,
) -> Option<AgentEvent> {
    if config.ttl_seconds == 0 {
        return None;
    }
    let warm_until_ms = last.warm_until_ms?;
    let warm_until_i64 = i64::try_from(warm_until_ms).unwrap_or(i64::MAX);
    if !is_cold(now_ms, warm_until_i64) {
        // 尚未过期（恰好等于截止仍温暖，cold.rs is_cold 严格大于口径）
        return None;
    }
    // 完成时刻 = 温暖截止 - TTL（warm = completed_at + ttl × 1000 反解）
    let completed_at_ms = warm_until_ms.saturating_sub(config.ttl_seconds.saturating_mul(1000));
    // 预估重发量 = 上次请求 input_total（C9 恒等式：miss + read + write）
    let input_total = last
        .cache_miss_tokens
        .saturating_add(last.cache_read_tokens)
        .saturating_add(last.cache_write_tokens);
    let baseline = CacheBaseline {
        signature: RequestSignature::default(),
        input_total,
        read: last.cache_read_tokens,
        provider: config.provider.clone(),
        model: config.model.clone(),
        completed_at_ms,
        generation: 0,
    };
    cold_cache_check(Some(&baseline), now_ms, config.ttl_seconds).map(|warning| {
        AgentEvent::ColdCacheWarning {
            session_id: session_id.to_string(),
            timestamp: now_iso_utc(),
            ttl_seconds: warning.ttl_seconds,
            idle_ms: warning.idle_ms,
            resend_estimate_tokens: warning.resend_estimate,
        }
    })
}

/// 缓存浪费预警事件（P5 §3.4.2 阈值：`missed_tokens ≥ 20_000` **或**
/// `missed_cost ≥ $0.1` 才打扰——`WARN_MISSED_COST_USD` 与 token 阈值
/// 并列为触发条件，pi interactive-mode.ts:3499 口径）。
///
/// 实现说明：
/// - 浪费金额 `missed_cost_usd = missed_tokens × (inputPrice - cacheReadPrice) / 1M`
///   （pi cache-stats.ts:73-89 口径），价格取 bundled_catalog 基础四价
///   （2026-08-09 接线：P3 价格已入库，DEEPCHECK-05 #5 消除"数据齐备但
///   零消费"；tieredPricing 长档匹配归演进项 P1，不在此计算）；
/// - 价格缺失（未知厂商 / 未收录模型）或 input ≤ cacheRead → 金额 None，
///   仅 token 阈值判定（诚实兜底，不估算）；
/// - run 级聚合无法还原逐 miss 归因与空闲时长 → attribution Unknown /
///   idle_ms 0（诚实兜底，宁缺勿误报——浪费量本身是实测值非估算）；
///   逐 miss 归因的 in-loop 发射（streaming.rs `consume_cache_usage` 处）
///   见轮末汇总物声明，合并后本函数降级为兜底路径。
pub(crate) fn waste_alert_event(
    session_id: &str,
    stats: &RunCacheStats,
    model_changed: bool,
    vendor: &str,
    model: &str,
) -> Option<AgentEvent> {
    let catalog = bundled_catalog();
    let input_price = catalog.input_price_for(vendor, model);
    let cache_read_price = catalog.cache_read_price_for(vendor, model);
    let missed_cost_usd = match (input_price, cache_read_price) {
        (Some(input), Some(read)) if input > read => {
            Some(stats.missed_tokens as f64 * (input - read) / 1_000_000.0)
        }
        _ => None,
    };
    let over_token_threshold = stats.missed_tokens >= WARN_MISSED_TOKENS;
    let over_cost_threshold = missed_cost_usd.map_or(false, |c| c >= WARN_MISSED_COST_USD);
    if !over_token_threshold && !over_cost_threshold {
        return None;
    }
    Some(AgentEvent::CacheWasteAlert {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        attribution: MissAttribution::Unknown,
        missed_tokens: stats.missed_tokens,
        idle_ms: 0,
        model_changed,
        missed_cost_usd,
    })
}

/// 模型切换检测（P5 §3.4.5）：上一 run model ≠ 当前 model → true；
/// 无上一 run 基线（首次 run）→ false（首轮归因 Cold，不算切换）。
pub(crate) fn model_switched(last: Option<&str>, current: Option<&str>) -> bool {
    match (last, current) {
        (Some(last), Some(current)) => last != current,
        _ => false,
    }
}
// ── M1：Tool Context 注入通道（C10 地基；build_context 立通道）──────

/// 注入段类型（注入顺序契约：M11 重注入断言以此为准；顺序变化视为协议变更）
///
/// 冻结顺序（调度者 I4-M1 指令，文档化于
/// `docs/multi-agent-repair/improvement/02-多Agent调度实现方案.md` M1）：
///
/// `system → skills → mcp → agent 定义`：
/// - [ContextInjectionKind::System]：系统提示词基础段（run-task 下发的
///   systemPrompt），先于一切注入段；
/// - [ContextInjectionKind::Skills]：skill 定义；
/// - [ContextInjectionKind::Mcp]：MCP 工具声明；
/// - [ContextInjectionKind::AgentDefinition]：agent 定义。
///
/// 注：04 文档 C10 第 4 条原稿顺序为「agent 定义 → skill → MCP」，
/// 本次按 I4-M1 调度指令落盘为「skills → mcp → agent 定义」（偏差见
/// M1 轮报告；enum 声明序 = 排序序 = 协议序，三者一致由快照断言锁定）。
///
/// 非测试构建静音：M1 只立通道，生产消费面仅 [ContextInjector::render]
/// （produce 装配）；变体/构造面由 M4（started_at）/M5（检查点摘要）/
/// M11（系统上下文重注入）与测试消费，轮末接线后移除 allow。
#[allow(dead_code)] // M1/M4/M5/M11 挂载消费（本域测试先行断言，A8 §1.2 登记面），接线后移除
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum ContextInjectionKind {
    /// 系统提示词基础段（systemPrompt；先于一切）
    System,
    /// skill 定义段
    Skills,
    /// MCP 工具声明段
    Mcp,
    /// agent 定义段
    AgentDefinition,
}

/// 注入顺序常量（冻结契约；[ContextInjector::render] 按此顺序拼接，
/// 与 [ContextInjectionKind] 声明序/排序序一致——排序即协议，
/// M11 重注入断言以此为契约）。
#[allow(dead_code)] // M11 重注入断言消费（本域测试先行断言，见轮末接线）
pub(crate) const CONTEXT_INJECTION_ORDER: [ContextInjectionKind; 4] = [
    ContextInjectionKind::System,
    ContextInjectionKind::Skills,
    ContextInjectionKind::Mcp,
    ContextInjectionKind::AgentDefinition,
];

/// 一段注入内容（M1：只承载「类型 + 标题 + 正文」，不持有任何业务逻辑；
/// M4（started_at）/ M5（检查点摘要）/ M11（配额凭证 + 系统上下文重注入）
/// 只读经 [ContextInjector::push] 挂载）。
///
/// 动态字段（时间戳类）必须显式标记 `@dynamic`（M1 约定 2：C2 的
/// started_at、恢复注入的检查点摘要）——带 `@dynamic` 的内容不在
/// C10 字节级一致断言范围内。
#[derive(Debug, Clone)]
pub(crate) struct ContextInjection {
    /// 注入段类型（决定拼接顺序）
    pub kind: ContextInjectionKind,
    /// 节标题（渲染为 `## {title}`）
    pub title: String,
    /// 正文
    pub content: String,
}

impl ContextInjection {
    /// 新建注入段
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言，见轮末接线）
    pub(crate) fn new(
        kind: ContextInjectionKind,
        title: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            title: title.into(),
            content: content.into(),
        }
    }
}

/// ContextInjector 装配点（M1：build_context 立通道；C10/C2/C1/C5 全部
/// 提示词层能力的统一入口）
///
/// - **注入顺序冻结**：注入段按 [CONTEXT_INJECTION_ORDER] 顺序拼接——
///   构造方乱序 [Self::push] 也会在 [Self::render] 时按契约顺序重排
///   （同类型保持 push 序，sort 稳定）；
/// - **独立于压缩预算**：注入段经 [Self::render] 汇入 `system_prompt`
///   面（wire 上归类 system 角色），压缩只作用于会话对话
///   （conex-compaction system 保留语义：system 消息恒保留、system_prompt
///   字段不在压缩输入内）——注入段结构上不进压缩预算；
/// - **默认行为不变**：无注入段时 [Self::render] 原样返回基础段
///   （None → None），与现状逐字节一致；
/// - 不持有业务逻辑：挂载点 = 只读注入项注册表（M1 内容 3）。
#[derive(Debug, Clone)]
pub(crate) struct ContextInjector {
    injections: Vec<ContextInjection>,
    /// C10 禁用开关（M11）：false = 渲染时忽略全部注入段
    enabled: bool,
}

impl Default for ContextInjector {
    /// 默认：无注入段 + 注入启用（C10 默认开）
    fn default() -> Self {
        Self {
            injections: Vec::new(),
            enabled: true,
        }
    }
}

impl ContextInjector {
    /// 新建空注入器（无注入段 = 默认行为）
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言，见轮末接线）
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 是否启用注入（默认开；C10 禁用开关）
    #[allow(dead_code)] // M11 消费（本域测试先行断言，A8 §1.2 登记面），接线后移除
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// 追加注入段（render 时按冻结顺序重排；同类型保持追加序）
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言，见轮末接线）
    pub(crate) fn push(&mut self, injection: ContextInjection) -> &mut Self {
        self.injections.push(injection);
        self
    }

    /// 是否无任何注入段
    #[allow(dead_code)] // M11 消费（本域测试先行断言，见轮末接线）
    pub(crate) fn is_empty(&self) -> bool {
        self.injections.is_empty()
    }

    /// 注入段类型序列（按冻结顺序；顺序契约断言入口，M11 复用）
    #[allow(dead_code)] // M11 重注入断言消费（本域测试先行断言，见轮末接线）
    pub(crate) fn kinds(&self) -> Vec<ContextInjectionKind> {
        let mut kinds: Vec<ContextInjectionKind> = self
            .injections
            .iter()
            .map(|injection| injection.kind)
            .collect();
        kinds.sort();
        kinds
    }

    /// 拼接基础系统段与注入段（M1 内容 1：先系统段、再 skill 段、再
    /// MCP 段、再 agent 定义段）：
    ///
    /// - 无注入段 → 基础段原样返回（None → None，默认行为与现状一致）；
    /// - 有注入段 → 基础段（System 段）置首，其后按冻结顺序逐段拼接，
    ///   每段渲染为 `## {title}\n{content}`，段间 `\n\n` 分隔；
    /// - 输出确定（同一配置两次构建字节一致，可快照断言；
    ///   `@dynamic` 字段不在一致性范围）。
    pub(crate) fn render(&self, base: Option<String>) -> Option<String> {
        if self.injections.is_empty() || !self.enabled {
            return base;
        }
        let mut ordered = self.injections.clone();
        ordered.sort_by_key(|injection| injection.kind);
        let mut parts: Vec<String> = Vec::new();
        if let Some(base) = base.filter(|text| !text.is_empty()) {
            parts.push(base);
        }
        for injection in ordered {
            if !parts.is_empty() {
                parts.push("\n\n".to_string());
            }
            parts.push(format!("## {}\n{}", injection.title, injection.content));
        }
        Some(parts.concat())
    }

    /// C10 字节级一致断言（M11）：两次渲染（如压缩前后重建）非动态段
    /// 必须逐字节一致；`@dynamic` 标记段（时间戳类）豁免。
    /// 返回：非动态段的字节级指纹（FNV-1a 64），可用于跨构建比对。
    #[allow(dead_code)] // M11 重注入断言消费（轮末接线后移除）
    pub(crate) fn static_fingerprint(&self) -> u64 {
        let mut ordered = self.injections.clone();
        ordered.sort_by_key(|injection| injection.kind);
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for injection in ordered {
            if injection.content.contains("@dynamic") {
                continue;
            }
            for byte in injection.title.bytes().chain(injection.content.bytes()) {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x1000_0000_01b3);
            }
        }
        hash
    }

    /// C10 禁用开关（M11）：关 = 渲染时忽略全部注入段（仅基础段透传）。
    #[allow(dead_code)] // M12 联测接线消费（重注入开关接线后移除）
    pub(crate) fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// C10 注入上限（M11）：注入段总体积上限（字节），超限按优先级截断
    /// （核心段保留、扩展段截断），绝不整体丢弃。
    /// 返回截断后的注入段数（日志/审计用）。
    #[allow(dead_code)] // M12 联测接线消费（注入上限配置接线后移除）
    pub(crate) fn truncate_to_budget(&mut self, budget_bytes: usize) -> usize {
        if self.enabled {
            self.injections.retain(|injection| {
                // 动态段（@dynamic）不参与体积预算（时间戳类极小，保留）
                !injection.content.contains("@dynamic")
            });
        }
        let mut retained = Vec::new();
        let mut used = 0usize;
        let mut dropped = 0usize;
        let mut ordered = std::mem::take(&mut self.injections);
        ordered.sort_by_key(|injection| injection.kind);
        for injection in ordered {
            let size = injection.title.len() + injection.content.len() + 8;
            if used + size > budget_bytes {
                dropped += 1;
                continue;
            }
            used += size;
            retained.push(injection);
        }
        self.injections = retained;
        dropped
    }
}

// ── T-D-03：子代理角色约束注入段（F4 R-D1；spawn 装配路径 F11 T-D-13 接入）──

/// 子代理角色约束注入段标题（T-D-03 冻结文案：测试断言锚点；
/// [ContextInjector::render] 渲染为 `## 子代理角色约束`）
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费（本文件测试先行断言）
pub(crate) const SUBAGENT_ROLE_CONSTRAINT_TITLE: &str = "子代理角色约束";

/// 子代理角色约束注入段正文（T-D-03 冻结文案：测试断言全文匹配）。
///
/// 静态文本，不含 `@dynamic` 字段，纳入 C10 字节级一致断言范围；冻结
/// 文案如需调整，必须同步更新测试断言与 T-D-02 的结构化错误文案
/// （两者表述一致，防模型混淆）。
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费（本文件测试先行断言）
pub(crate) const SUBAGENT_ROLE_CONSTRAINT_CONTENT: &str =
    "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。\
     如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。";

/// T-D-03：向 [ContextInjector] 追加「子代理角色约束」注入段（System 段）。
///
/// 仅**子代理 run** 的装配路径调用本函数（主 Agent run 的装配点不调用）
/// ——这是「主 Agent run 不含本段」测试断言的关键差异点。
///
/// 与 C2 started_at 注入同通道同机制（`subagent_inject.rs:13-16` 挂载
/// 先例）：[ContextInjection] 是只读注册项，静态文本经
/// [ContextInjector::push] 挂载；System 按 [CONTEXT_INJECTION_ORDER]
/// 在首段位（位于基础系统段之后、Skills 段之前），与其他 System 注入段
/// 保持 push 序（[ContextInjector::render] 稳定排序语义）。
///
/// 当前生产 spawn 装配路径未落定（T-D-13 在 F11/R-D3）——本函数即
/// T-D-13 的接入约定：T-D-13 启动子代理 run、装配 ContextInjector 时
/// 调用 `push_subagent_role_constraint(&mut injector)` 挂载本段。
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费（本文件测试先行断言）
pub(crate) fn push_subagent_role_constraint(injector: &mut ContextInjector) {
    injector.push(ContextInjection::new(
        ContextInjectionKind::System,
        SUBAGENT_ROLE_CONSTRAINT_TITLE,
        SUBAGENT_ROLE_CONSTRAINT_CONTENT,
    ));
}
// ── SessionLoopProducer ───────────────────────────────────────────

/// Arc 包装的 ProviderCall（[AgentSessionLoop] 按 `Box<dyn ProviderCall>`
/// 接收；生产者跨 run 共享 provider，需经本包装再装箱）
pub(crate) struct SharedProvider {
    /// 真实 provider 适配层（共享复用，跨 run 不重建）
    pub(crate) inner: Arc<dyn ProviderCall>,
    /// 会话 ID（P2 步骤 4b：ProviderRequest.session_id 的注入源；值与循环内
    /// AgentSessionContext.session_id 一致——两者同源于 run-task 下发的
    /// sessionId）
    pub(crate) session_id: String,
}

#[async_trait]
impl ProviderCall for SharedProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        // P2 步骤 4b：把会话 ID 注入 ProviderRequest.session_id（prompt_cache_key
        // 的键来源；会话内所有请求共享同键，同轮工具循环 + 跨轮，P2 §3.3 B）。
        // 请求为不可变借用，克隆后改写：messages/system_prompt 仍是借用复制
        // （0 深拷贝），仅 session_id 属主字符串每轮克隆一次（量级与
        // build_request 的工具 schema to_vec 相当，可忽略）。适配层
        // request_options 据此派生缓存键（Key 机制厂商）。
        let mut request = request.clone();
        request.session_id = Some(self.session_id.clone());
        self.inner.stream(&request).await
    }
}
/// run 生产者（engine.rs:436-462；每 run 重建 [AgentSessionLoop]——真实接线
/// 跨 run 重建语义，PE-09 §4）
pub(crate) struct SessionLoopProducer {
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
    /// 审批门（permissionMode 非 full-access 时注入）
    approval: Option<Arc<dyn ApprovalGate>>,
    /// 实时 delta 转发（T09.1；None = 不启用，收口流 message-delta 兜底）
    delta_sink: Option<Arc<dyn DeltaSink>>,
    /// 预置初始对话（P4 T-30 水合：SessionHistoryCache 缓存 / 前端 history
    /// 水合产物；None = 现状单消息 run，向后兼容）
    initial_conversation: Option<Vec<Arc<AgentMessage>>>,
    /// 本次 run 的用户消息
    user_message: AgentMessage,
    /// 缓存跟踪配置（P5 S5 / T-40：None = 不启用测量，行为与现状一致；
    /// Some = produce 装配进 SessionLoopOptions，LoopState 构造 tracker）
    cache_tracking: Option<CacheTrackingConfig>,
    /// 上一 run 的会话缓存状态（T-40：冷缓存预警 + 模型切换检测数据源；
    /// 由 EngineHandle 按会话维护，core_run_task 装配时经
    /// [Self::with_cache_session] 注入）
    cache_session: SessionCacheState,
    /// 上下文注入通道（M1：C10 地基；None = 无注入，options.system_prompt
    /// 原样透传——默认行为与现状一致。注入段经 [ContextInjector::render]
    /// 汇入 system_prompt 面，独立于压缩预算）
    context_injector: Option<ContextInjector>,
    /// 外部控制总线（30-P1 run 控制面：None = loop 自建实例，现状行为；
    /// Some = produce 装配时经 with_control_bus 注入——壳层 ActiveRun
    /// 与内核共享同一总线，运行中 run 有真实外部终止路径）
    control_bus: Option<Arc<Mutex<ControlBus>>>,
    /// 外部 abort 信号（30-P1：None = loop 自建信号；Some = produce 装配
    /// 时经 with_abort_signal 注入——壳层 ActiveRun 与内核共享同一触发面，
    /// L3 强停 / kill_all 经同一信号生效）
    abort_signal: Option<AbortSignal>,
}

impl SessionLoopProducer {
    /// 新建 run 生产者（permissionMode 与 clientMessageId 已由 core_run_task
    /// 归一为循环选项与用户消息）
    #[allow(clippy::too_many_arguments)] // 参数为 run 装配上下文聚合注入（provider/工具注册表/循环选项/批量选项/审批门/delta 流/水合对话/用户消息），各参数来源独立，收缩将退化为全局态或拆分 struct 而收益低
    pub(crate) fn new(
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
    #[allow(dead_code)] // T-40 轮末合并：core_run_task 装配 producer 时调用
    pub(crate) fn with_cache_tracking(mut self, config: Option<CacheTrackingConfig>) -> Self {
        self.cache_tracking = config;
        self
    }

    /// 注入上一 run 的会话缓存状态（T-40：冷缓存预警 + 模型切换检测
    /// 数据源；EngineHandle::cache_session 产出）
    #[allow(dead_code)] // T-40 轮末合并：core_run_task 装配 producer 时调用
    pub(crate) fn with_cache_session(mut self, session: SessionCacheState) -> Self {
        self.cache_session = session;
        self
    }

    /// M1：装配上下文注入通道（[ContextInjector]；None = 无注入，保持
    /// 现状行为）。produce 时把注入段渲染进 system_prompt 面——注入段
    /// 归类 system 角色，独立于压缩预算（压缩只作用于会话对话）。
    #[allow(dead_code)] // M4/M5/M11 经此挂载（本文件测试先行断言）
    pub(crate) fn with_context_injector(mut self, injector: Option<ContextInjector>) -> Self {
        self.context_injector = injector;
        self
    }

    /// 30-P1：装配外部控制总线（run 控制面接线）——produce 在
    /// `with_options` 之后、`run()` 之前注入 loop（builder 顺序契约：
    /// 必须 run() 前，check_control 读字段引用）；壳层 ActiveRun 与
    /// loop 共享同一实例，core_run_control 的 L1/L2/L3 意图真实可达。
    pub(crate) fn with_control_bus(mut self, bus: Arc<Mutex<ControlBus>>) -> Self {
        self.control_bus = Some(bus);
        self
    }

    /// 30-P1：装配外部 abort 信号（L3 强停触发面）——produce 在
    /// `with_options` 之后、`run()` 之前注入 loop；壳层 ActiveRun 与
    /// loop 共享同一实例（AbortSignal 克隆共享 [AtomicBool]）。
    pub(crate) fn with_abort_signal(mut self, signal: AbortSignal) -> Self {
        self.abort_signal = Some(signal);
        self
    }

    /// 生产一次 run 结果（构造 [AgentSessionLoop] 并运行；每 run 重建）
    ///
    /// T-30 水合分支（P4 §3.2.3 混合路线）：`initial_conversation` 非空时
    /// 以 [AgentSessionLoop::with_initial_conversation_arc] 零拷贝预置对话
    /// （引擎缓存 = 权威增量 / 前端 history = 冷启动兜底，P4 阶段 1-3），
    /// `run()` 追加新用户消息——历史回流 LLM 是跨轮前缀缓存命中的基础；
    /// 为空时走现状单消息路径（向后兼容）。
    ///
    /// T-40 缓存测量接线（P5 S5，只测不改）：
    /// - run 启动前：冷缓存预警（上一 run warm_until_ms 过期 → 实时轨发
    ///   cold-cache-warning 一次）+ 模型切换检测（记录，in-loop 归因接线
    ///   见轮末汇总物声明）+ 装配 CacheTrackingConfig（LoopState 构造
    ///   tracker，T-36 capture_signature / record_usage / finish 已在
    ///   loop 内接线）；
    /// - run 收口：`cache-stats-updated` 入收口轨（outcome.events →
    ///   drive_outcome → 既有缓冲桥，与 ContextCompressionStart/End 同轨）；
    ///   `cache-waste-alert` 按阈值经实时轨 DeltaSink 发出。
    pub(crate) async fn produce(&mut self) -> RunOutcome {
        // ── T-40：run 启动前缓存测量装配 ────────────────────────
        // 冷缓存预警（P5 §3.4.4 请求启动路径）：实时轨 DeltaSink 发一次
        // （此时前端 tick 未必在看该会话；空闲期提示由前端 warmUntilMs
        // tick 驱动，T-48）
        self.emit_cold_cache_warning_if_cold();
        // 模型切换检测（P5 §3.4.5）：上一 run model ≠ 当前 model → 记录
        // （tracker.on_model_switch 的 in-loop 接线见轮末汇总物声明——
        // engine 无法触达 LoopState.cache_tracker，会话级跨 run 信号经
        // CacheTrackingConfig 透传由合并轮实现）
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

        // ── Round7：笔记真管线装配（原 R6 挂点 → 真注入）────────────────
        // `note_runtime::try_backend()` = 进程级
        // `NoteRuntime::open(app_dir()/workspace.db)` 的 `Arc<dyn NoteBackend>`。
        // 写入 `SessionLoopOptions.note_backend` → `with_options` 注入
        // `ToolExecCtx.note_backend` → `ToolContext.note_backend`。
        // 工具 query_blocks / document_outline / document_apply_md /
        // send_to_note 走 DocSession + store 投影（禁止 mirror 默认读）。
        // None = 打开失败 / 测试未 install → 工具 `note_backend_unwired`。
        if self.options.assembly.note_backend.is_none() {
            if let Some(handle) = crate::note_runtime::try_backend() {
                self.options.assembly.note_backend = Some(handle);
            }
        }

        // ── M1：上下文注入通道（C10 地基；build_context 立通道）────
        // 注入段渲染进 system_prompt 面（wire 归类 system 角色）——独立于
        // 压缩预算：压缩只作用于会话对话（conex-compaction system 保留
        // 语义），注入段结构上不进压缩输入。无注入段（None / 空注入器）
        // 时 render 原样返回 → 与现状字节一致。
        if let Some(injector) = &self.context_injector {
            self.options.assembly.system_prompt = injector.render(self.options.assembly.system_prompt.take());
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
            // C1b（统一输入流收敛 · 反向依赖移出）：steering 壳层注入——
            // 核心 AgentSessionLoop::new() 不再内建 RecoverySteeringStrategy
            // （不变量 5），本处为产品唯一 steering 注入点（安全缺口修复：
            // 此前壳层完全未装配 steering）。漏注入 = steering 失效
            // （steering_enabled 默认 true 但策略 Vec 空 → 空响应/预算耗尽
            // 不再注入纠偏），验收见详案 C1b §5.3。
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
        // cache-stats-updated 入收口轨（复用既有事件桥——outcome.events
        // 由 drive_run_loop 统一入队 + 信封注入 runId/sequence 发射，
        // 与 ContextCompressionStart/End 同一发射方式；P5 §3.1.3
        // 「run 收口经收口轨发一次」）
        if let Some(stats) = &outcome.cache_stats {
            outcome.events.push(AgentEvent::CacheStatsUpdated {
                session_id: self.session_id.clone(),
                timestamp: now_iso_utc(),
                stats: *stats,
            });
        }
        // cache-waste-alert（实时轨，P5 §3.4.2 阈值）：run 级累计浪费
        // 超阈值才打扰（低于阈值只计入 run 聚合）；归因在 run 级聚合不可
        // 还原 → Unknown（诚实兜底，逐 miss 归因发射见轮末汇总物声明）；
        // 金额阈值经 bundled_catalog 四价计算（价格缺失 → None 不估算）
        if let Some(stats) = &outcome.cache_stats {
            let (vendor, model) = self
                .cache_tracking
                .as_ref()
                .map_or(("auto", ""), |c| (c.provider.as_str(), c.model.as_str()));
            if let Some(alert) =
                waste_alert_event(&self.session_id, stats, model_switched, vendor, model)
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

