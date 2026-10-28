//! 引擎句柄（B6.4）：provider 生效配置 + 工具注册表 + engineReady
//!
//! 自壳层 `engine_build.rs` 下沉的 crate 域部分：引擎状态本体、装配主路径、
//! 访问器/重载面与插件 MCP 注册。壳层域对象（浏览器槽 / 电脑操作槽 /
//! workflow 创建通道绑定与 MCP 自动拉起）由壳层 `EngineHost` 承载，经
//! [crate::engine_assembly::EngineHostHooks] 在装配期注入工具注册。
//!
//! - `ready()`：provider 配置三件套（baseUrl/model/apiKey）齐备即可发起
//!   调用；加载失败仅降级未就绪，不 panic；
//! - 工具注册表：内置工具注册失败仅告警（工具执行器按 tool.not_found 兜底）；
//! - 跨会话并发安全：provider 只读共享（Mutex<Option<Arc<dyn ProviderCall>>>），
//!   std Mutex 不跨 await 持有（AA-02 并发模型注记）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_provider::models::{cache_ttl_for_declared_model, CacheTtl};
use agent_tools::definition::{ToolDefinition, ToolError};
use agent_tools::mcp::{register_plugin_server, McpClientBridge, McpServerConfig};
use agent_tools::registry::ToolRegistry;
use agent_tools::tools::kill_subagent::SubagentKillChannel;
use agent_tools::tools::send_message::{MainAgentMessageChannel, SubagentInjectChannel};
use agent_tools::tools::set_timer::TimerChannel;
use agent_tools::tools::subagent::SubagentSpawner;
use agent_tools::tools::wait_subagents::SubagentWaitChannel;
use agent_tools::WorkflowCreationChannel;
use async_trait::async_trait;
use conex_db::LocalDb;
use conex_types::denied_stats::DeniedStats;
use conex_types::events::RunCacheStats;
use conex_types::response::ClassifiedStreamError;
use orchestrator::PendingMessageQueue;
use session_loop::provider::{ProviderCall, ProviderEventStream, ProviderRequest};
use session_loop::CacheTrackingConfig;

use crate::audit::RoutingAuditSink;
use crate::engine_assembly::{assemble_scheduler_registry, host_hooks};
use crate::engine_channels::ContinuityChannelBoard;
use crate::engine_provider::{
    build_http_client, load_provider_endpoint, EngineProviderConfig, HttpProviderCall,
};
use crate::sched::{SchedEventSink, SchedulerRegistry};
use crate::timers::{AgentEventSink, TimerRegistry};
use crate::wait_channel::{
    EventStreamBroadcast, LocalDbWaitStore, MemoryAgentSource, MemoryWaitStore, WaitChannel,
    WaitDispatchStore, WaitStore,
};
use crate::wake_watcher::LastWakeupTracker;

/// 毒丸恢复计数（B1-5 观测化：构建面 8 处锁中毒恢复次数——EngineHandle
/// provider / provider_config / ready_reason / cache_sessions 四锁；对齐
/// registry.rs / note_memory.rs 「tracing::error! 成对 + 计数」样板，
/// 零新依赖）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言面；`test-hooks` 门控——壳层毒化测试
/// 跨 crate 使用；生产构建不暴露）
#[cfg(any(test, feature = "test-hooks"))]
pub fn build_poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
}

/// 引擎句柄（B6.4：provider 生效配置 + 工具注册表 + engineReady）
pub struct EngineHandle {
    /// 共享 reqwest 客户端（连接池 / TLS 会话跨 run 复用；provider 重载时
    /// 重建适配层但复用同一客户端——AA-02 S-7 连接池语义保持）
    http_client: reqwest::Client,
    /// 生效的 provider 适配层（None = 配置缺失降级未就绪）
    pub provider: Mutex<Option<Arc<dyn ProviderCall>>>,
    /// 工具注册表（只读共享）
    tool_registry: Arc<ToolRegistry>,
    /// MCP 客户端桥（E5：插件 mcpServers 受管服务器 + 工具并入运行集；
    /// 生命周期随 run 启停由上层驱动——session.start 启动 / session.end
    /// 关闭，见 [Self::register_plugin_mcp_server]）
    mcp_bridge: Arc<McpClientBridge>,
    /// engineReady（配置齐备即 true）
    pub ready: AtomicBool,
    /// 未就绪原因（ready=false 时的诊断文案，PE-04 T04.5 联动）
    pub ready_reason: Mutex<Option<String>>,
    /// 生效 provider 配置快照（P5 S5 / T-40：缓存测量装配数据源；
    /// None = 未就绪）
    pub provider_config: Mutex<Option<EngineProviderConfig>>,
    /// 模型覆盖 provider 缓存（model → provider；运行中切换复用连接池）
    provider_overrides: Mutex<HashMap<String, Arc<dyn ProviderCall>>>,
    /// 会话级缓存测量状态（T-40：跨 run 冷缓存预警 + 模型切换检测数据源；
    /// 内存态，跨重启由 runs 表 v5 列兜底——warm_until_ms 落库，T-39）
    cache_sessions: Mutex<HashMap<String, SessionCacheState>>,
    /// 定时器注册表（G5 T-CF-06/07：register/cancel/到期 steering 注入/
    /// 早退钩子；TimerChannel 契约实现，经 BuiltinToolConfig.timer_channel
    /// 注入 set_timer / cancel_timer 工具）
    timer_registry: Arc<TimerRegistry>,
    /// 定时器 steering 落点（PendingMessageQueue 适配的底层队列；
    /// 到期条目落在真实队列，R-CF3 idle 续 run 装配收口消费）
    timer_steering_queue: Arc<Mutex<PendingMessageQueue>>,
    /// 子代理等待通道（T-CF-10：SubagentWaitChannel 契约实现；经
    /// BuiltinToolConfig.subagent_wait_channel 注入 wait_subagents 工具）
    wait_channel: Arc<dyn SubagentWaitChannel>,
    /// dispatch 声明存储（WaitChannel 落库 / watchdog 读取的共享实例；
    /// 装配分支（内存/真适配）经 [WaitDispatchStore] 合并面稳定类型化，
    /// D4 §8 D-6）
    dispatch_store: Arc<dyn WaitDispatchStore>,
    /// subagent-ended 事件流广播（EventQueue 旁路适配：wait_for_terminal
    /// 的订阅面）
    terminal_stream: Arc<EventStreamBroadcast>,
    /// 最近事件唤醒跟踪（watchdog 失联判定数据源；事件收口处已接线：
    /// 事件 emit 循环与子代理终态收口调用 mark_wakeup，任何事件到达即更新）
    last_wakeup: Arc<LastWakeupTracker>,
    /// Cron 调度注册表（T-CF-09 A5 提供；None = 未装配降级，workflow
    /// 命令面经装配轮消费）
    scheduler_registry: Option<Arc<SchedulerRegistry>>,
    /// 定时器事件缓冲（T-CF-06 装配产物；P4 drain 转发接线）
    timer_event_sink: Arc<AgentEventSink>,
    /// cron 事件缓冲（T-CF-09 装配产物；同 timer 的 drain 转发路径——
    /// cron-fired 单臂，conex-types 仅 CronFired 变体，无 cron-cancelled）
    scheduler_event_sink: Arc<SchedEventSink>,
    /// 路由型审计 sink（15-T-6 裁决 D9）：工具级 security-audit 事件经
    /// run 级桥注册表送达前端审计面板（run 启动注册 / 收口注销由
    /// CoreRunState 驱动）；G10 denied 计数共享实例
    audit_sink: Arc<RoutingAuditSink>,
    /// 任务连续性通道板卡（审计 01 W1：kill_subagent / send_message 工具
    /// 三通道 + WaitChannel ControlBusResolver 的延迟绑定面）
    continuity: Arc<ContinuityChannelBoard>,
    /// 会话级子代理策略服务（configure_agents 的落地实现；None = 无 DB 测试路径）
    agent_policy: Option<Arc<crate::agent_policy::AgentPolicyService>>,
}

impl EngineHandle {
    /// 初始化引擎（加载生效配置 + 内置工具注册；失败仅降级未就绪）。
    ///
    /// spawn 通道未注入（None）——run_subagent 返回 common.unsupported 降级；
    /// 生产装配走 [Self::new_with_spawner]。
    pub fn new(
        background_manager: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    ) -> Self {
        Self::new_with_spawner(background_manager, None, None)
    }

    /// 初始化引擎并注入子代理 spawn 通道与 LocalDb 连接（生产装配点：
    /// CoreRunState 创建 spawner 实例后传入；D6 §3.1 段 2 + D4 §3.8 ②
    /// 装配替换：`db: Option<LocalDb>`（W4 统一签名，CoreRunState::new 经
    /// `store.as_local_db()` 下转传入）——Some(db) → timer/sched/wait 三
    /// store 真适配，None（InMemoryStore 测试替身）→ 内存版回退保测试面）。
    pub fn new_with_spawner(
        background_manager: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
        subagent_spawner: Option<Arc<dyn SubagentSpawner>>,
        db: Option<LocalDb>,
    ) -> Self {
        let client = build_http_client(None);
        let core = assemble_engine_core(EngineAssemblyConfig {
            background_manager,
            subagent_spawner,
            db,
            workflow_creation_channel: host_hooks()
                .and_then(|hooks| hooks.workflow_creation_channel()),
        });
        Self::from_core(core, client)
    }

    /// 由装配组件束 + 客户端组装引擎句柄（壳层装配路径：壳层域工具族经
    /// [crate::engine_assembly::EngineHostHooks] 注册后组装；registry 经
    /// 组件束携带并在此 Arc 化）。
    pub fn from_core(core: EngineCore, http_client: reqwest::Client) -> Self {
        Self {
            http_client,
            provider: Mutex::new(core.provider),
            tool_registry: Arc::new(core.registry),
            mcp_bridge: core.mcp_bridge,
            ready: AtomicBool::new(core.ready),
            ready_reason: Mutex::new(core.ready_reason),
            provider_config: Mutex::new(core.provider_config),
            provider_overrides: Mutex::new(HashMap::new()),
            cache_sessions: Mutex::new(HashMap::new()),
            timer_registry: core.timer_registry,
            timer_steering_queue: core.timer_steering_queue,
            wait_channel: core.wait_channel,
            dispatch_store: core.dispatch_store,
            terminal_stream: core.terminal_stream,
            last_wakeup: core.last_wakeup,
            scheduler_registry: core.scheduler_registry,
            timer_event_sink: core.timer_event_sink,
            scheduler_event_sink: core.scheduler_event_sink,
            audit_sink: core.audit_sink,
            continuity: core.continuity,
            agent_policy: core.agent_policy,
        }
    }

    /// engineReady（provider 配置齐备即可发起调用）
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// 未就绪原因（ready=false 时的诊断文案）
    pub fn ready_reason(&self) -> Option<String> {
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
    pub fn provider(&self) -> Option<Arc<dyn ProviderCall>> {
        self.provider
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(
                    target: "engine",
                    "EngineHandle provider 锁中毒，按恢复模式继续：{e}"
                );
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
    }

    /// 会话级子代理策略服务（configure_agents / run 启动装载共用；None = 无 DB）
    pub fn agent_policy_service(&self) -> Option<Arc<crate::agent_policy::AgentPolicyService>> {
        self.agent_policy.clone()
    }

    /// 按模型覆盖解析 provider（None / 与当前一致 → 当前 provider）。
    ///
    /// 以当前生效配置为模板，仅替换 model；按模型缓存复用（同一连接池）。
    pub fn provider_for_model_override(
        &self,
        model: Option<&str>,
    ) -> Option<Arc<dyn ProviderCall>> {
        let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) else {
            return self.provider();
        };
        {
            let cache = self
                .provider_overrides
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(provider) = cache.get(model) {
                return Some(Arc::clone(provider));
            }
        }
        let mut config = self.provider_config()?;
        if config.model == model {
            return self.provider();
        }
        config.model = model.to_string();
        let provider: Arc<dyn ProviderCall> =
            Arc::new(HttpProviderCall::new(self.http_client.clone(), config));
        self.provider_overrides
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(model.to_string(), Arc::clone(&provider));
        Some(provider)
    }

    /// 共享 reqwest 客户端克隆（ProviderSummarizer 复用连接池——AA-02 S-7）
    pub fn http_client(&self) -> reqwest::Client {
        self.http_client.clone()
    }

    /// 重建 provider 适配层并原子交换（F4 F1-01 修复：`config_profile_apply`
    /// / `config_update` 写 store 成功后调用，下一次 run 立即使用新凭据——
    /// key/baseUrl/model 热更新）。重建失败（三件套缺失，如 apiKey 清空）→
    /// provider=None + ready=false + ready_reason 文案，与构造时降级语义一致。
    pub fn reload_provider(&self) {
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
            tracing::error!(target: "engine", "EngineHandle provider 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = provider;
        *self.provider_config.lock().unwrap_or_else(|e| {
            tracing::error!(target: "engine", "EngineHandle provider_config 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = provider_config;
        self.ready.store(ready, Ordering::SeqCst);
        *self.ready_reason.lock().unwrap_or_else(|e| {
            tracing::error!(target: "engine", "EngineHandle ready_reason 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        }) = ready_reason;
    }

    /// 工具注册表（只读共享）
    pub fn tool_registry(&self) -> Arc<ToolRegistry> {
        Arc::clone(&self.tool_registry)
    }

    /// MCP 客户端桥（E5；上层 run 启停驱动用——session.start 启动 /
    /// session.end `stop_all` 关闭）
    pub fn mcp_bridge(&self) -> Arc<McpClientBridge> {
        Arc::clone(&self.mcp_bridge)
    }

    /// 定时器注册表（T-CF-06 装配产物）
    pub fn timer_registry(&self) -> Arc<TimerRegistry> {
        Arc::clone(&self.timer_registry)
    }

    /// 路由型审计 sink（15-T-6 装配产物；消费方 = CoreRunState run
    /// 启动注册 / 收口注销）
    pub fn audit_sink(&self) -> Arc<RoutingAuditSink> {
        Arc::clone(&self.audit_sink)
    }

    /// 定时器 steering 队列（到期条目落点；R-CF3 idle 续 run 消费）
    pub fn timer_steering_queue(&self) -> Arc<Mutex<PendingMessageQueue>> {
        Arc::clone(&self.timer_steering_queue)
    }

    /// 子代理等待通道（T-CF-10 装配产物；与注入 wait_subagents 工具的是
    /// 同一实例）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费；生产经工具注册表消费
    pub fn wait_channel(&self) -> Arc<dyn SubagentWaitChannel> {
        Arc::clone(&self.wait_channel)
    }

    /// dispatch 声明存储（T-CF-10/13 共享实例；返回类型经 [WaitDispatchStore]
    /// 合并面稳定——装配分支（内存/真适配）不漂移，D4 §8 D-6）
    #[cfg_attr(not(test), allow(dead_code))] // 测试断言面消费
    pub fn dispatch_store(&self) -> Arc<dyn WaitDispatchStore> {
        Arc::clone(&self.dispatch_store)
    }

    /// 终态事件流广播（T-CF-10：事件收口旁路点 feed 接线用）
    pub fn terminal_stream(&self) -> Arc<EventStreamBroadcast> {
        Arc::clone(&self.terminal_stream)
    }

    /// 任务连续性通道板卡（审计 01 W1 延迟绑定面；消费方 =
    /// CoreRunState::finalize_continuity_channels）
    pub fn continuity(&self) -> Arc<ContinuityChannelBoard> {
        Arc::clone(&self.continuity)
    }

    /// 最近事件唤醒跟踪（T-CF-13：事件收口处 mark_wakeup 接线）
    pub fn last_wakeup(&self) -> Arc<LastWakeupTracker> {
        Arc::clone(&self.last_wakeup)
    }

    /// Cron 调度注册表（T-CF-09 装配产物；None = 未装配降级）
    pub fn scheduler_registry(&self) -> Option<Arc<SchedulerRegistry>> {
        self.scheduler_registry.clone()
    }

    /// 定时器事件缓冲（T-CF-06 装配产物；P4 drain 转发路径的入口）
    pub fn timer_event_sink(&self) -> Arc<AgentEventSink> {
        Arc::clone(&self.timer_event_sink)
    }

    /// cron 事件缓冲（T-CF-09 装配产物；drain 转发路径同 timer）
    pub fn scheduler_event_sink(&self) -> Arc<SchedEventSink> {
        Arc::clone(&self.scheduler_event_sink)
    }

    /// 注册插件 MCP server（E5 内容 1）：PluginMcpDeclaration（stdio
    /// command/args/env）→ 受管服务器（spawn + 握手 + 枚举）→ 工具并入
    /// ToolRegistry 运行集。启动失败 → mcp.* 错误上抛；服务器生命周期随
    /// run 启停由上层驱动。
    pub async fn register_plugin_mcp_server(
        &self,
        config: McpServerConfig,
    ) -> Result<Vec<ToolDefinition>, ToolError> {
        register_plugin_server(&self.mcp_bridge, &self.tool_registry, &config).await
    }

    /// 生效 provider 配置（缓存测量装配数据源；None = 未就绪）
    pub fn provider_config(&self) -> Option<EngineProviderConfig> {
        self.provider_config
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "engine", "EngineHandle provider_config 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .clone()
    }

    /// 解析缓存跟踪配置（P5 S5 / T-40）：provider / model 取生效配置、
    /// TTL 走唯一来源（用户 yaml `cacheTtl`）——未声明 / 无 TTL 数据 →
    /// ttl_seconds = 0（不追踪缓存，fail-closed）。
    pub fn cache_tracking_config(&self) -> Option<CacheTrackingConfig> {
        let config = self.provider_config()?;
        Some(build_cache_tracking_config(&config))
    }

    /// 会话缓存测量状态（上一 run 快照；core_run_task 装配 producer 时注入）
    pub fn cache_session(&self, session_id: &str) -> SessionCacheState {
        self.cache_sessions
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "engine", "EngineHandle cache_sessions 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 收口写回会话缓存状态（drive_run_loop 在 produce 后调用）
    pub fn update_cache_session(&self, session_id: &str, stats: &RunCacheStats, model: &str) {
        let mut sessions = self.cache_sessions.lock().unwrap_or_else(|e| {
            tracing::error!(target: "engine", "EngineHandle cache_sessions 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let state = sessions.entry(session_id.to_string()).or_default();
        state.last_stats = Some(*stats);
        state.last_model = Some(model.to_string());
    }

    /// T-CF-13：事件收口旁路点唤醒标记（watchdog 失联判定数据源更新）
    pub fn mark_wakeup(&self) {
        self.last_wakeup.mark_wakeup();
    }

    /// 测试面：注入 provider 适配层与生效配置并置就绪（run_task_impl 完整
    /// 装配不依赖磁盘 config，CI 确定性；经 [Self::cache_tracking_config]
    /// 同步生效——默认模型继承断言数据源）。`test-hooks` 门控；生产构建不暴露。
    #[cfg(any(test, feature = "test-hooks"))]
    pub fn inject_provider_for_test(
        &self,
        provider: Arc<dyn ProviderCall>,
        config: EngineProviderConfig,
    ) {
        *self.provider.lock().unwrap_or_else(|e| e.into_inner()) = Some(provider);
        *self
            .provider_config
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(config);
        self.ready.store(true, Ordering::SeqCst);
        *self.ready_reason.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Default for EngineHandle {
    fn default() -> Self {
        Self::new(None)
    }
}

// ── 引擎装配（crate 域；壳层域工具族经 EngineHostHooks 注入）────────

/// 引擎装配入参（生产装配点与测试构造共用）
pub struct EngineAssemblyConfig {
    /// 后台任务管理器（工具 adopt 通道；None = 引擎无后台任务通道）
    pub background_manager: Option<Arc<dyn agent_tools::background::BackgroundTaskManager>>,
    /// 子代理 spawn 通道（run_subagent 工具；None = common.unsupported 降级）
    pub subagent_spawner: Option<Arc<dyn SubagentSpawner>>,
    /// LocalDb 连接（timer/sched/wait 三 store 真适配；None = 内存回退）
    pub db: Option<LocalDb>,
    /// create_workflow 工具通道（延迟绑定面；None = common.unsupported 降级）
    pub workflow_creation_channel: Option<Arc<dyn WorkflowCreationChannel>>,
}

/// 引擎装配组件束（crate 域装配产物；壳层组装 [EngineHandle] 前可对
/// `registry` 继续注册壳层域工具族——browser/computer）
pub struct EngineCore {
    /// 工具注册表（未 Arc 化；组装前可继续注册）
    pub registry: ToolRegistry,
    pub provider: Option<Arc<dyn ProviderCall>>,
    pub ready: bool,
    pub ready_reason: Option<String>,
    pub provider_config: Option<EngineProviderConfig>,
    pub mcp_bridge: Arc<McpClientBridge>,
    pub timer_registry: Arc<TimerRegistry>,
    pub timer_steering_queue: Arc<Mutex<PendingMessageQueue>>,
    pub wait_channel: Arc<dyn SubagentWaitChannel>,
    pub dispatch_store: Arc<dyn WaitDispatchStore>,
    pub terminal_stream: Arc<EventStreamBroadcast>,
    pub last_wakeup: Arc<LastWakeupTracker>,
    pub scheduler_registry: Option<Arc<SchedulerRegistry>>,
    pub timer_event_sink: Arc<AgentEventSink>,
    pub scheduler_event_sink: Arc<SchedEventSink>,
    pub audit_sink: Arc<RoutingAuditSink>,
    pub continuity: Arc<ContinuityChannelBoard>,
    /// 会话级策略服务（None = 无 LocalDb）
    pub agent_policy: Option<Arc<crate::agent_policy::AgentPolicyService>>,
}

/// 引擎装配主路径（crate 域：timer / wait / continuity / scheduler /
/// audit / 内置工具注册 / MCP 桥 / provider 加载；壳层域工具族经
/// [EngineHostHooks] 在内置工具注册后注入）。
pub fn assemble_engine_core(config: EngineAssemblyConfig) -> EngineCore {
    let EngineAssemblyConfig {
        background_manager,
        subagent_spawner,
        db,
        workflow_creation_channel,
    } = config;

    // G5 T-CF-06/07：TimerRegistry 装配（pending sink = 真实
    // PendingMessageQueue、event sink = 缓冲适配、store = D6 §3.1 段 2
    // 装配替换：Some(db) → LocalDb 真适配；None → 内存版回退）
    let timer_steering_queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    // P4（30 方案 §4）：事件缓冲实例由引擎持有（TimerRegistry 注入同一
    // Arc——缓冲 → 转发同实例，不出现第二份无人消费的缓冲）
    let timer_event_sink = Arc::new(AgentEventSink::new());
    // 显式 trait 化（先 clone 出 Arc<AgentEventSink> 再经赋值 unsize 强转
    // ——Arc::clone 泛型推断无法经引用反向强转）
    let timer_event_sink_trait: Arc<dyn crate::timers::EventSink> = timer_event_sink.clone();
    // 装配分支（LocalDb 真适配 / 内存回退）经 dyn TimerStore 收口
    let timer_store: Arc<dyn crate::timers::TimerStore> = match &db {
        Some(db) => Arc::new(crate::timers::LocalDbTimerStore::new(db.clone())),
        None => crate::timers::MemoryTimerStore::shared(),
    };
    let timer_registry = Arc::new(TimerRegistry::new(
        Arc::new(crate::timers::QueuePendingSink::new(Arc::clone(
            &timer_steering_queue,
        ))),
        timer_event_sink_trait,
        timer_store,
    ));
    // 启动恢复：扫描已持久化声明，重建未到期定时器 / 补发已到期未注入
    // （内存 store 下为空集）。try_current 守卫：纯同步构造上下文（无
    // tokio runtime 的测试/装配路径）跳过，不 panic。
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
    // dispatch 声明存储与 watchdog 共享（同一实例双 trait 注入）；终态
    // 事件流广播为事件收口旁路点的订阅面。
    let dispatch_store: Arc<dyn WaitDispatchStore> = match &db {
        Some(db) => Arc::new(LocalDbWaitStore::new(db.clone())),
        None => Arc::new(MemoryWaitStore::new()),
    };
    // 审计 01 W1（任务连续性推进轮）：三通道 + 控制总线解析器延迟绑定
    // 板卡——真实现经 finalize_continuity_channels 绑定；未绑定窗口内
    // resolver 恒 None（inject 返回结构化 InjectFailed），行为与装配前一致
    let continuity = Arc::new(ContinuityChannelBoard::new());
    let terminal_stream = Arc::new(EventStreamBroadcast::new());
    let wait_channel = Arc::new(WaitChannel::new(
        Arc::clone(&dispatch_store) as Arc<dyn WaitStore>,
        Arc::new(MemoryAgentSource::new()) as Arc<dyn crate::wait_channel::SubagentStatusSource>,
        Arc::clone(&terminal_stream),
        // 生产缺省由板卡取代（真实解析 = 活动 run 注册表）；板卡未绑定 =
        // Noop 同语义——恒 None
        Arc::clone(&continuity) as Arc<dyn crate::wait_channel::ControlBusResolver>,
    ));

    // ── T-CF-13：最近事件唤醒跟踪装配 ──
    let last_wakeup = Arc::new(LastWakeupTracker::new());

    // ── T-CF-09：SchedulerRegistry 装配（pending/events/store/launcher
    // 四适配；launcher 未接线 → is_daemon 触发降级 steering 注入）──
    let scheduler_event_sink = Arc::new(SchedEventSink::new());
    let scheduler_registry = assemble_scheduler_registry(
        &timer_steering_queue,
        Arc::clone(&scheduler_event_sink),
        db.clone(),
    );

    // ── 15-T-6（裁决 D9）：路由型 audit_sink 装配 ──
    // G10 denied 计数实例（引擎级共享）+ run 级桥注册表
    let audit_sink = Arc::new(RoutingAuditSink::new(Arc::new(DeniedStats::new())));

    // 会话级子代理策略服务（configure_agents）：LocalDb 持久化 + spawner 同步
    let agent_policy = db.as_ref().map(|db| {
        Arc::new(crate::agent_policy::AgentPolicyService::new(
            db.clone(),
            subagent_spawner.clone(),
        ))
    });

    // 子代理邮箱（report/ask/request）：投递到主 agent followUp/steer 环
    let agent_mailbox = Arc::new(crate::agent_mailbox::AgentMailbox::new(
        Arc::clone(&continuity) as Arc<dyn MainAgentMessageChannel>,
        agent_policy.clone(),
    ));
    if let Some(spawner) = subagent_spawner.as_ref() {
        spawner.set_child_registrar(
            Arc::clone(&agent_mailbox)
                as Arc<dyn agent_tools::tools::subagent_report::ChildAgentRegistrar>,
        );
    }

    // 内置工具注册（B5.2：fs / shell / search / diff；F1 R-AB1：后台管理器
    // 经 ToolContext.background 透传；G5 T-CF-05/06：timer_channel 注入；
    // T-CF-10：subagent_wait_channel 注入；审计 01 W1：三通道板卡注入）
    let mut registry = ToolRegistry::new();
    let builtin_config = agent_tools::tools::BuiltinToolConfig {
        background_manager,
        timer_channel: Some(Arc::clone(&timer_registry) as Arc<dyn TimerChannel>),
        subagent_wait_channel: Some(Arc::clone(&wait_channel) as Arc<dyn SubagentWaitChannel>),
        subagent_spawner: subagent_spawner.clone(),
        subagent_kill_channel: Some(Arc::clone(&continuity) as Arc<dyn SubagentKillChannel>),
        subagent_inject_channel: Some(Arc::clone(&continuity) as Arc<dyn SubagentInjectChannel>),
        workflow_creation_channel,
        main_agent_message_channel: Some(
            Arc::clone(&continuity) as Arc<dyn MainAgentMessageChannel>
        ),
        agent_policy_channel: agent_policy.as_ref().map(|service| {
            Arc::clone(service)
                as Arc<dyn agent_tools::tools::configure_agents::AgentPolicyChannel>
        }),
        subagent_report_channel: Some(Arc::clone(&agent_mailbox)
            as Arc<dyn agent_tools::tools::subagent_report::SubagentReportChannel>),
        subagent_capability_channel: Some(
            Arc::clone(&continuity)
                as Arc<dyn agent_tools::tools::grant_capability::SubagentCapabilityGrantChannel>,
        ),
        child_agent_registrar: Some(Arc::clone(&agent_mailbox)
            as Arc<dyn agent_tools::tools::subagent_report::ChildAgentRegistrar>),
        subagent_model_channel: Some(
            Arc::clone(&continuity)
                as Arc<dyn agent_tools::tools::switch_agent_model::SubagentModelChannel>,
        ),
        audit_sink: Some(Arc::clone(&audit_sink) as agent_tools::audit::AuditSink),
        ..agent_tools::tools::BuiltinToolConfig::default()
    };
    if let Err(error) =
        agent_tools::tools::register_builtin_tools_with_config(&mut registry, builtin_config)
    {
        tracing::warn!(
            target: "engine",
            error = %error,
            "内置工具注册失败（工具按 tool.not_found 兜底）"
        );
    }
    // 壳层域工具族注册（browser/computer；装配钩子未注入 = 测试面跳过）
    if let Some(hooks) = host_hooks() {
        hooks.register_host_tools(&mut registry);
    }

    // E5：MCP 客户端桥初始化（stdio 服务器管理 + 工具适配；插件
    // mcpServers 经 register_plugin_mcp_server 注册为受管服务器）
    let mcp_bridge = Arc::new(McpClientBridge::new());

    // provider 生效配置加载（三件套齐备才就绪）
    let (provider, ready, ready_reason, provider_config) = match load_provider_endpoint() {
        Some(config) => {
            let provider: Arc<dyn ProviderCall> = Arc::new(HttpProviderCall::new(
                build_http_client(None),
                config.clone(),
            ));
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

    EngineCore {
        registry,
        provider,
        ready,
        ready_reason,
        provider_config,
        mcp_bridge,
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
        agent_policy,
    }
}

// ── P5 S5 / T-40：缓存测量引擎侧装配 ──────────────────────────────

/// 会话级缓存测量状态（engine 层跨 run 维护；T-40）
///
/// 跨 run 持久化边界（对齐 cache_tracker.rs 模块注释）：本状态只保留
/// **可观测标量**（warm_until_ms / input_total / model），不保留请求签名
/// 哈希——签名基线在 loop 内每 run 重建（T-36 现状）；冷缓存预警 =
/// 上一 run warm_until_ms 过期判定；模型切换 = 上一 run model ≠ 当前 model。
#[derive(Debug, Clone, Default)]
pub struct SessionCacheState {
    /// 最近一次 run 的缓存统计（warm_until_ms 过期判定 + 重发量估算）
    pub last_stats: Option<RunCacheStats>,
    /// 最近一次 run 的模型标识（模型切换检测）
    pub last_model: Option<String>,
}

/// 装配缓存跟踪配置（T-40 / plans/03 §2.2）：provider / model 取生效配置，
/// TTL 走**唯一来源**——用户 yaml `cacheTtl` 声明（live 树投影）。
///
/// TTL 决议（裁决 N7：字典不得替用户决定 TTL）：provider 位 = `config.vendor`
/// ≻ `config.provider_id`；TTL = [cache_ttl_for_declared_model]；未收录 /
/// 未声明 → `ttl_seconds = 0` = **不追踪缓存**（fail-closed）。
pub fn build_cache_tracking_config(config: &EngineProviderConfig) -> CacheTrackingConfig {
    let vendor = config.vendor.as_deref().or(config.provider_id.as_deref());
    let live = crate::engine_provider::protocol::live_catalog();
    let ttl_seconds = vendor
        .and_then(|vendor_str| {
            cache_ttl_for_declared_model(&live.catalog, vendor_str, &config.model)
        })
        .map(CacheTtl::seconds)
        .unwrap_or(0);
    CacheTrackingConfig {
        provider: vendor.unwrap_or("auto").to_string(),
        model: config.model.clone(),
        ttl_seconds,
    }
}

/// 冷缓存预警事件（P5 §3.4.4 请求启动路径，辅助路径）：上一 run 温暖截止
/// 已过期 → Some。统一消费 conex-telemetry::cache 纯函数底座，不再自实现
/// 过期判定口径。
pub fn cold_cache_warning_event(
    session_id: &str,
    config: &CacheTrackingConfig,
    last: &RunCacheStats,
    now_ms: u64,
) -> Option<conex_types::events::AgentEvent> {
    use conex_telemetry_shim::*;
    if config.ttl_seconds == 0 {
        return None;
    }
    let warm_until_ms = last.warm_until_ms?;
    let warm_until_i64 = i64::try_from(warm_until_ms).unwrap_or(i64::MAX);
    if !is_cold(now_ms, warm_until_i64) {
        return None;
    }
    let completed_at_ms = warm_until_ms.saturating_sub(config.ttl_seconds.saturating_mul(1000));
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
        conex_types::events::AgentEvent::ColdCacheWarning {
            session_id: session_id.to_string(),
            timestamp: crate::engine_provider::now_iso_utc(),
            ttl_seconds: warning.ttl_seconds,
            idle_ms: warning.idle_ms,
            resend_estimate_tokens: warning.resend_estimate,
        }
    })
}

/// conex-telemetry 缓存底座（模块内 use 收口）
mod conex_telemetry_shim {
    pub use conex_telemetry::cache::{cold_cache_check, is_cold, CacheBaseline, RequestSignature};
}

/// 缓存浪费预警事件（P5 §3.4.2 阈值）：`missed_tokens ≥ 20_000` **或**
/// `missed_cost ≥ $0.1` 才打扰。浪费金额只来自 **live yaml 单价 × 引擎微元**
/// （禁止 `bundled_catalog` 取价）；事件字段 `missed_cost_usd` 仅当币种为
/// USD 时填充（CNY → None，不撒谎）。
pub fn waste_alert_event(
    session_id: &str,
    stats: &RunCacheStats,
    model_changed: bool,
    pricing: Option<&agent_provider::models::catalog_types::ModelPricingSpec>,
) -> Option<conex_types::events::AgentEvent> {
    use conex_telemetry::cache::{WARN_MISSED_COST_USD, WARN_MISSED_TOKENS};
    let missed_cost_usd = pricing.and_then(|p| {
        if p.currency != agent_provider::pricing::Currency::Usd {
            return None;
        }
        let input_rate = p.input?;
        let input_micros = agent_provider::pricing::PricingEngine::tokens_to_micros(
            stats.missed_tokens,
            input_rate,
        );
        let read_micros = agent_provider::pricing::PricingEngine::tokens_to_micros(
            stats.missed_tokens,
            p.cache_read.unwrap_or(0.0),
        );
        Some(input_micros.saturating_sub(read_micros) as f64 / 1_000_000.0)
    });
    let over_token_threshold = stats.missed_tokens >= WARN_MISSED_TOKENS;
    let over_cost_threshold = missed_cost_usd.is_some_and(|c| c >= WARN_MISSED_COST_USD);
    if !over_token_threshold && !over_cost_threshold {
        return None;
    }
    Some(conex_types::events::AgentEvent::CacheWasteAlert {
        session_id: session_id.to_string(),
        timestamp: crate::engine_provider::now_iso_utc(),
        attribution: conex_types::events::MissAttribution::Unknown,
        missed_tokens: stats.missed_tokens,
        idle_ms: 0,
        model_changed,
        missed_cost_usd,
    })
}

/// 模型切换检测（P5 §3.4.5）：上一 run model ≠ 当前 model → true；
/// 无上一 run 基线（首次 run）→ false（首轮归因 Cold，不算切换）。
pub fn model_switched(last: Option<&str>, current: Option<&str>) -> bool {
    match (last, current) {
        (Some(last), Some(current)) => last != current,
        _ => false,
    }
}

/// 运行中可切换模型的 provider 委托壳（每次调用前解析 `ModelCell`）
pub struct SwitchingProvider {
    engine: Arc<EngineHandle>,
    model: Arc<conex_agents::model::ModelCell>,
    fallback: Arc<dyn ProviderCall>,
}

impl SwitchingProvider {
    pub fn new(
        engine: Arc<EngineHandle>,
        model: Arc<conex_agents::model::ModelCell>,
        fallback: Arc<dyn ProviderCall>,
    ) -> Self {
        Self {
            engine,
            model,
            fallback,
        }
    }
}

#[async_trait]
impl ProviderCall for SwitchingProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let provider = self
            .engine
            .provider_for_model_override(self.model.get().as_deref())
            .unwrap_or_else(|| Arc::clone(&self.fallback));
        provider.stream(request).await
    }
}

// SharedProvider（Arc 包装的 ProviderCall；session_id 注入源）
/// Arc 包装的 ProviderCall（[AgentSessionLoop] 按 `Box<dyn ProviderCall>`
/// 接收；生产者跨 run 共享 provider，需经本包装再装箱）
pub struct SharedProvider {
    /// 真实 provider 适配层（共享复用，跨 run 不重建）
    pub inner: Arc<dyn ProviderCall>,
    /// 会话 ID（ProviderRequest.session_id 的注入源；值与循环内
    /// AgentSessionContext.session_id 一致）
    pub session_id: String,
}

#[async_trait]
impl ProviderCall for SharedProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        // P2 步骤 4b：把会话 ID 注入 ProviderRequest.session_id（prompt_cache_key
        // 的键来源；会话内所有请求共享同键）。请求为不可变借用，克隆后改写。
        let mut request = request.clone();
        request.session_id = Some(self.session_id.clone());
        self.inner.stream(&request).await
    }
}
