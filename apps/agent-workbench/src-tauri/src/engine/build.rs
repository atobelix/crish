//! 壳域装配面（引擎宿主：browser 槽 / computer 槽 / workflow 通道 + 注入）
//!
//! 引擎 crate 域（provider 底座 / 通道板卡 / 定时器 / 调度 / 内置工具）已
//! 下沉 `conex-run`（`conex_run::engine_handle::assemble_engine_core`）；本
//! 模块承载壳层专属装配：
//! - [EngineHost]：浏览器槽 / 电脑操作槽 / workflow 创建通道绑定的宿主
//!   聚合 + 全局注入点（配置源 / runtime 句柄 / 应用数据目录 / 笔记后端）；
//! - [EngineHostHooksImpl]：壳层域工具族注册（browser 后置注册，27 §3
//!   「不进 register_builtin_tools——注册数断言不可扰动」）；
//! - [RunLaunchHooksImpl]：run 装配后置接线（browser estop 复位 + watcher /
//!   computer 停止 watcher——run abort 信号驱动）；
//! - MCP 自动拉起（auto_start 配置；host_paths 依赖留壳）。
//!
//! 依赖方向：壳层（本模块）→ conex-run → 各底层 crate，零反向依赖。

use std::sync::Arc;

use agent_tools::registry::ToolRegistry;
use agent_tools::WorkflowCreationChannel;
use conex_browser_tools::BrowserToolsConfig;
use conex_run::engine_assembly::{
    set_app_data_dir, set_engine_host_hooks, set_note_backend_factory, set_run_launch_hooks,
    set_runtime_handle, EngineHostHooks, RunLaunchHooks,
};
use conex_run::engine_handle::EngineHandle;
use conex_run::engine_provider::set_committed_config_source;

use crate::workflow_ipc::WorkflowCreationChannelBinding;

/// 引擎宿主（browser / computer / workflow 通道 + 引擎句柄聚合）
pub(crate) struct EngineHost {
    /// 引擎句柄（CoreRunState::new 装配后绑定）
    engine: std::sync::Mutex<Option<Arc<EngineHandle>>>,
    /// 浏览器会话槽（27 接线方案 S4：browser_* 工具与面板命令共享的
    /// 进程级惰性单例）
    browser_slot: Arc<crate::browser::BrowserSlot>,
    /// 电脑操作槽（维度 1：computer_* 工具与面板命令共享的进程级单例；
    /// 有库 → session_meta 持久化镜像，无库 → 进程内内存镜像）
    computer_slot: Arc<crate::computer::ComputerSlot>,
    /// create_workflow 工具通道（维度五 / 05 详案 §2.4 路径 A：延迟绑定面）
    workflow_creation_channel: Arc<WorkflowCreationChannelBinding>,
}

impl EngineHost {
    /// 构造宿主并完成全局注入。**必须在 `CoreRunState::new` 之前调用**——
    /// 引擎装配经钩子消费本宿主（browser 工具注册 / workflow 通道）：
    /// - browser/computer 槽与 workflow 通道绑定构造；
    /// - [set_engine_host_hooks] / [set_run_launch_hooks]（工具注册与
    ///   run watcher 接线）；
    /// - [set_committed_config_source] / [set_runtime_handle] /
    ///   [set_app_data_dir] / [set_note_backend_factory]（宿主注入面）。
    pub(crate) fn new(db: Option<conex_db::LocalDb>) -> Self {
        // 34 §5.2 E-1（R-12）：attach 会话级开关值源 = BrowserToolsConfig
        // .mcp_attach_allowed（默认 false = 端点信息零暴露）
        let mcp_attach_allowed = BrowserToolsConfig::default().mcp_attach_allowed;
        let browser_slot = Arc::new(
            crate::browser::BrowserSlot::new().with_mcp_attach_allowed(mcp_attach_allowed),
        );
        let computer_meta: Arc<dyn crate::computer::ComputerMetaStore> = match &db {
            Some(db) => Arc::new(crate::computer::LocalDbComputerMetaStore::new(db.clone())),
            None => Arc::new(crate::computer::MemoryComputerMetaStore::default()),
        };
        let computer_slot = Arc::new(crate::computer::ComputerSlot::from_store(computer_meta));
        let workflow_creation_channel = Arc::new(WorkflowCreationChannelBinding::new());

        set_engine_host_hooks(Arc::new(EngineHostHooksImpl {
            browser_slot: Arc::clone(&browser_slot),
            workflow_creation_channel: Arc::clone(&workflow_creation_channel),
            mcp_attach_allowed,
        }));
        set_run_launch_hooks(Arc::new(RunLaunchHooksImpl {
            browser_slot: Arc::clone(&browser_slot),
            computer_slot: Arc::clone(&computer_slot),
        }));

        // 宿主注入面（配置源 / runtime / 数据目录 / 笔记后端）
        set_committed_config_source(Arc::new(ShellConfigSource));
        let runtime_handle =
            tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() });
        set_runtime_handle(runtime_handle);
        if let Ok(dir) = crate::host_paths::app_dir() {
            set_app_data_dir(dir);
        }
        set_note_backend_factory(Arc::new(crate::note_runtime::try_backend));

        Self {
            engine: std::sync::Mutex::new(None),
            browser_slot,
            computer_slot,
            workflow_creation_channel,
        }
    }

    /// 绑定引擎句柄（CoreRunState::new 装配后调用；MCP 自动拉起等
    /// engine 依赖的宿主面在绑定后可用）
    pub(crate) fn bind_engine(&self, engine: Arc<EngineHandle>) {
        *self.engine.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine);
    }

    /// 浏览器会话槽（面板命令 browser_commands 与浏览器模块消费）
    pub(crate) fn browser_slot(&self) -> Arc<crate::browser::BrowserSlot> {
        Arc::clone(&self.browser_slot)
    }

    /// 电脑操作槽（面板命令消费）
    pub(crate) fn computer_slot(&self) -> Arc<crate::computer::ComputerSlot> {
        Arc::clone(&self.computer_slot)
    }

    /// create_workflow 工具通道绑定（main.rs setup ⑧c bind 生产转正）
    pub(crate) fn workflow_creation_channel(&self) -> Arc<WorkflowCreationChannelBinding> {
        Arc::clone(&self.workflow_creation_channel)
    }

    /// BC11-1 生产环境拉起：从 LocalFileMcpPersistence 加载配置，自动拉起
    /// 标记为 auto_start 的 MCP 服务（bind_engine 后调用）
    pub(crate) fn spawn_mcp_autostart(&self) {
        use agent_tools::mcp::servers::{LocalFileMcpPersistence, McpConfigPersistence};
        let Some(engine) = self
            .engine
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return;
        };
        let bridge = engine.mcp_bridge();
        let registry = engine.tool_registry();
        tauri::async_runtime::spawn(async move {
            let app_dir = match crate::host_paths::app_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    tracing::warn!(target: "engine", "MCP 启动配置读取失败（app_dir 不可用）: {e}");
                    return;
                }
            };
            let persistence = LocalFileMcpPersistence::new(app_dir);
            let configs = match persistence.load().await {
                Ok(configs) => configs,
                Err(e) => {
                    tracing::warn!(target: "engine", "加载 MCP 配置文件失败: {e}");
                    return;
                }
            };
            for config in configs {
                if config.auto_start {
                    tracing::info!(target: "engine", server_id = %config.server_id, "自动拉起 auto_start MCP 服务");
                    if let Err(e) =
                        agent_tools::mcp::register_plugin_server(&bridge, &registry, &config).await
                    {
                        tracing::warn!(target: "engine", server_id = %config.server_id, error = %e, "自动拉起 MCP 服务失败");
                    }
                }
            }
        });
    }
}

/// 壳层域工具族注册 + workflow 通道注入（[EngineHostHooks] 实现）
struct EngineHostHooksImpl {
    browser_slot: Arc<crate::browser::BrowserSlot>,
    workflow_creation_channel: Arc<WorkflowCreationChannelBinding>,
    mcp_attach_allowed: bool,
}

impl EngineHostHooks for EngineHostHooksImpl {
    fn register_host_tools(&self, registry: &mut ToolRegistry) {
        // ── 27 方案 S4：browser_* 工具族注册（浏览器会话槽接线）──────
        // LazySessionOps 实现 SessionOps 经 BrowserToolsConfig.session_ops
        // 注入 23 个 browser_* 工具（维度 17 §1.1 后置注册）。数据根解析
        // 失败 → 降级槽（全操作 not_ready），注册照常进行；注册失败仅
        // warn 降级（27 §5 风险预案：仅缺 browser_*，模型侧 tool.not_found
        // / not_ready 兜底）。
        let browser_ops: Arc<dyn conex_browser_tools::session::SessionOps> = Arc::new(
            crate::browser::LazySessionOps::new(Arc::clone(&self.browser_slot)),
        );
        if let Err(error) = conex_browser_tools::register_browser_tools(
            registry,
            conex_browser_tools::BrowserToolsConfig {
                session_ops: Some(browser_ops),
                gate: Some(self.browser_slot.gate()),
                // 与槽同一值源（register 不消费该字段，仅随会话级配置携带，
                // 34 §5.1：引擎侧会话装配是消费面）
                mcp_attach_allowed: self.mcp_attach_allowed,
                ..BrowserToolsConfig::default()
            },
        ) {
            tracing::warn!(
                target: "engine",
                error = %error,
                "browser_* 工具注册失败（工具按 tool.not_found 兜底）"
            );
        }
    }

    fn workflow_creation_channel(&self) -> Option<Arc<dyn WorkflowCreationChannel>> {
        Some(Arc::clone(&self.workflow_creation_channel) as Arc<dyn WorkflowCreationChannel>)
    }
}

/// run 装配后置钩子（[RunLaunchHooks] 实现：壳域 watcher 接线）
struct RunLaunchHooksImpl {
    browser_slot: Arc<crate::browser::BrowserSlot>,
    computer_slot: Arc<crate::computer::ComputerSlot>,
}

impl RunLaunchHooks for RunLaunchHooksImpl {
    fn on_run_assembled(
        &self,
        _session_id: &str,
        subagent_run: bool,
        abort_signal: session_loop::AbortSignal,
    ) {
        // 31 评审 F2 / 30 评审 H-2：estop 桥**仅主 run 装配**——子代理 run
        // 被 cancel_estop 置位会让主 run 剩余 browser_* 命令整段失效且无
        // 复位点；browser_* 工具已从子代理注册面剔除（27 §3 F1）。
        if !subagent_run {
            self.browser_slot.reset_estop();
            crate::browser::spawn_browser_estop_watcher(
                Arc::clone(&self.browser_slot),
                abort_signal.clone(),
            );
        }
        // 维度 1 收敛：电脑操作停止 watcher（对齐 browser 线先例）——
        // run 级 abort_signal 触发 → ComputerSlot::on_run_stopped 释放互斥门
        // + 关闭开启态 + 落盘（普通停止语义，不置急停旗）。
        crate::computer::spawn_computer_stop_watcher(Arc::clone(&self.computer_slot), abort_signal);
    }
}

/// 壳层已提交配置源（conex_run::engine_provider::CommittedConfigSource 的
/// 宿主实现：经 ModelsStore 单例读取）
///
/// `pub(crate)`：壳层测试夹具（config_test_support）在直接构造
/// `EngineHandle` 的测试里需注入同一实现，语义等同生产 EngineHost::new。
pub(crate) struct ShellConfigSource;

impl conex_run::engine_provider::CommittedConfigSource for ShellConfigSource {
    fn committed_snapshot(
        &self,
    ) -> Result<Arc<agent_provider::model_store::CommittedModels>, String> {
        crate::config::models_store()
            .and_then(|store| store.committed())
            .map_err(|error| error.message)
    }

    fn resolve_active_model(
        &self,
    ) -> Result<Option<agent_provider::model_store::ResolvedModelConfig>, String> {
        crate::config::resolve_active_model().map_err(|error| error.message)
    }
}
