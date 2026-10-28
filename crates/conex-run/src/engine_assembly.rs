//! 引擎装配钩子（crate ⇄ 壳层装配边界）
//!
//! [EngineHandle](crate::engine_handle::EngineHandle) 的 crate 域装配在
//! `engine_handle.rs`；壳层域对象（浏览器槽 / 电脑操作槽的工具族注册、
//! workflow 创建通道绑定、笔记运行时后端）经本模块的注入契约进入装配，
//! 本 crate 不感知壳层类型。

use std::sync::{Arc, OnceLock, RwLock};

use agent_tools::note_backend::NoteBackend;
use agent_tools::registry::ToolRegistry;
use agent_tools::WorkflowCreationChannel;
use conex_db::LocalDb;
use orchestrator::PendingMessageQueue;
use std::sync::Mutex;

use crate::sched::{
    LocalDbSchedStore, MemorySchedStore, QueuePendingSink, SchedEventSink, SchedStore,
    SchedulerRegistry,
};

/// 壳层装配钩子（browser/computer 工具族注册 + workflow 创建通道绑定面）
///
/// 壳层在 [EngineHandle](crate::engine_handle::EngineHandle) 装配前经
/// [set_engine_host_hooks] 注入实现；未注入（测试面）= 跳过壳层工具族
/// 注册、workflow 通道降级 common.unsupported。
pub trait EngineHostHooks: Send + Sync {
    /// 壳层域工具族注册（browser/computer；在内置工具注册后、registry
    /// Arc 化前调用；注册失败仅 warn 降级，对齐内置工具先例）
    fn register_host_tools(&self, registry: &mut ToolRegistry);
    /// create_workflow 工具通道（延迟绑定面；None = 工具降级 unsupported）
    fn workflow_creation_channel(&self) -> Option<Arc<dyn WorkflowCreationChannel>>;
}

static HOST_HOOKS: OnceLock<Arc<dyn EngineHostHooks>> = OnceLock::new();

/// 注入壳层装配钩子（壳层 setup 装配点；重复注入忽略并告警——OnceLock 语义）
pub fn set_engine_host_hooks(hooks: Arc<dyn EngineHostHooks>) {
    if HOST_HOOKS.set(hooks).is_err() {
        tracing::warn!("壳层装配钩子重复注入，忽略（保留首次注入实例）");
    }
}

/// 读取壳层装配钩子（未注入 = None）
pub fn host_hooks() -> Option<&'static Arc<dyn EngineHostHooks>> {
    HOST_HOOKS.get()
}

/// run 装配后置钩子（run 生命周期 ⇄ 壳域资源绑定）
///
/// run_task_impl 装配区在 abort 信号创建后调用 [Self::on_run_assembled]；
/// 壳层实现负责壳域 watcher 接线（browser estop 复位 + watcher /
/// computer 停止 watcher——主 run 装配、子代理 run 跳过 estop 面）。
pub trait RunLaunchHooks: Send + Sync {
    /// run 装配后置接线（session_id = 目标会话；subagent_run = 子代理
    /// run（browser estop 不装配）；abort_signal = run 级强停信号）
    fn on_run_assembled(
        &self,
        session_id: &str,
        subagent_run: bool,
        abort_signal: session_loop::AbortSignal,
    );
}

static RUN_LAUNCH_HOOKS: RwLock<Option<Arc<dyn RunLaunchHooks>>> = RwLock::new(None);

/// 注入 run 装配后置钩子（壳层 setup 装配点；重复注入覆盖）
pub fn set_run_launch_hooks(hooks: Arc<dyn RunLaunchHooks>) {
    if let Ok(mut slot) = RUN_LAUNCH_HOOKS.write() {
        *slot = Some(hooks);
    }
}

/// 读取 run 装配后置钩子（未注入 = None，测试面跳过壳域接线）
pub fn run_launch_hooks() -> Option<Arc<dyn RunLaunchHooks>> {
    RUN_LAUNCH_HOOKS.read().ok().and_then(|slot| slot.clone())
}

/// 笔记运行时后端工厂（壳层惰性打开 workspace.db 的注入面；produce 装配
/// 时调用——None = 打开失败 / 测试未安装 → 工具 `note_backend_unwired`）
pub type NoteBackendFactory = Arc<dyn Fn() -> Option<Arc<dyn NoteBackend>> + Send + Sync>;

static NOTE_BACKEND: RwLock<Option<NoteBackendFactory>> = RwLock::new(None);

/// 注入笔记后端工厂（壳层 setup 装配点；重复注入覆盖——后端随工作区
/// 切换可重开，与 ModelsStore 的 OnceLock 语义不同）
pub fn set_note_backend_factory(factory: NoteBackendFactory) {
    if let Ok(mut slot) = NOTE_BACKEND.write() {
        *slot = Some(factory);
    }
}

/// 读取笔记后端（工厂惰性调用；未注入 = None）
pub fn note_backend() -> Option<Arc<dyn NoteBackend>> {
    let factory = NOTE_BACKEND.read().ok()?.as_ref()?.clone();
    factory()
}

/// 当前 UTC 毫秒时间戳（epoch ms；冷缓存预警判定用）
pub fn unix_millis_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

// ── 进程级 tokio runtime 句柄槽（原 tauri::async_runtime 的解耦替代）──

static RUNTIME_HANDLE: RwLock<Option<tokio::runtime::Handle>> = RwLock::new(None);

/// 应用数据目录槽（壳层 setup 注入；run 域日志落盘 / workflow 沙箱兜底等
/// 消费——本 crate 不感知宿主目录布局）
static APP_DATA_DIR: RwLock<Option<std::path::PathBuf>> = RwLock::new(None);

/// 注入应用数据目录（壳层 setup 装配点）
pub fn set_app_data_dir(dir: std::path::PathBuf) {
    if let Ok(mut slot) = APP_DATA_DIR.write() {
        *slot = Some(dir);
    }
}

/// 读取应用数据目录（未注入 → Err，调用方走临时目录兜底）
pub fn app_data_dir() -> Result<std::path::PathBuf, String> {
    APP_DATA_DIR
        .read()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| "app_data_dir 未注入".to_string())
}

/// 注入进程级 tokio runtime 句柄（壳层 setup 装配点：run snapshot 退出
/// 落盘、driver 任务等从非 async 线程 spawn/block_on 的场景依赖本句柄；
/// 未注入时 [spawn_here] 回落当前 tokio 上下文）。
pub fn set_runtime_handle(handle: tokio::runtime::Handle) {
    if let Ok(mut slot) = RUNTIME_HANDLE.write() {
        *slot = Some(handle);
    }
}

fn runtime_handle() -> Option<tokio::runtime::Handle> {
    RUNTIME_HANDLE.read().ok().and_then(|slot| slot.clone())
}

/// 在进程 runtime 上 spawn（语义对齐原 `tauri::async_runtime::spawn`：
/// 任意线程可调；句柄未注入且当前无 tokio 上下文 → panic，装配契约违约）
pub fn spawn_here<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handle = runtime_handle().unwrap_or_else(tokio::runtime::Handle::current);
    handle.spawn(future)
}

/// 在进程 runtime 上 block_on（语义对齐原 `tauri::async_runtime::block_on`：
/// 从独立 std::thread 汇入同一 runtime；句柄未注入 → panic，装配契约违约）
pub fn block_on_here<F: std::future::Future>(future: F) -> F::Output {
    let handle = runtime_handle()
        .unwrap_or_else(|| panic!("runtime 句柄未注入（set_runtime_handle 装配契约）"));
    handle.block_on(future)
}

/// T-CF-09：Cron 调度注册表装配（A5 提供 pub 构造器与 restore；已按 A5
/// 落盘签名对齐：pending / events / store / launcher 四适配——pending 落
/// 真实 PendingMessageQueue（与定时器同队列）、events 用 sched 的事件槽、
/// store 用 D6 §3.1 段 2 装配替换：Some(db) → LocalDb 真适配；None →
/// 内存版回退）。
///
/// is_daemon 独立 run 拉起点（DaemonRunLauncher）暂不接线：RunProducer 的
/// prompt 注入适配在 run 域，未接线时 daemon 触发降级为 steering 注入
/// （sched 防丢唤醒语义）。装配失败降级（None 保持 unsupported 语义）。
pub fn assemble_scheduler_registry(
    timer_steering_queue: &Arc<Mutex<PendingMessageQueue>>,
    scheduler_event_sink: Arc<SchedEventSink>,
    db: Option<LocalDb>,
) -> Option<Arc<SchedulerRegistry>> {
    // 装配分支（LocalDb 真适配 / 内存回退）经 dyn SchedStore 收口
    let sched_store: Arc<dyn SchedStore> = match &db {
        Some(db) => Arc::new(LocalDbSchedStore::new(db.clone())),
        None => MemorySchedStore::shared(),
    };
    let registry = Arc::new(SchedulerRegistry::new(
        Arc::new(QueuePendingSink::new(Arc::clone(timer_steering_queue))),
        scheduler_event_sink,
        sched_store,
        None,
    ));
    // 注：启动恢复（restore）统一移至壳层异步生命周期装配点（CRIT-03），
    // 确保与 workflow_state 与真实执行器装配完成后可靠触发，不在本同步
    // 函数内尝试调用。
    Some(registry)
}
