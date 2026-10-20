//! 进程管理子模块（维度 10）：BrowserManager 主调度 + 状态机接线
//!
//! 本模块只负责「把浏览器进程可靠地拉起来、管住、收掉」（10 文档 §1 职责边界）；
//! CDP 协议收发由维度 11（cdp/ 子模块）承载，本模块仅提供两个衔接点：
//!
//! 1. `CdpEndpoint`（端口 + WS path）——启动成功后供维度 11 建连（`connect_session` 助手）；
//! 2. `ProcessEvent` 事件流——状态迁移广播（面板与工具层消费）。
//!
//! 模块映射（10 文档 `process/` 布局 ↔ 本目录）：
//!
//! ```text
//! browser/
//! ├── mod.rs         # 状态机 + 主调度（↔ process/mod.rs）
//! ├── state.rs       # BrowserState/StateMachine（§6 迁移表）
//! ├── discover.rs    # 二进制发现与选择（↔ process/discover.rs）
//! ├── cft.rs         # CfT 下载/解压/缓存（↔ process/cft.rs）
//! ├── args.rs        # 启动参数构建（↔ process/args.rs）
//! ├── profile.rs     # profile 目录管理（↔ process/profile.rs）
//! ├── active_port.rs # DevToolsActivePort 轮询/解析（↔ process/active_port.rs）
//! ├── nav_stack.rs   # 导航栈（↔ process/nav_stack.rs）
//! ├── endpoint.rs    # SessionToken + CdpEndpoint 重导出（↔ process/endpoint.rs）
//! ├── events.rs      # ProcessEvent（↔ events.rs）
//! └── platform/      # ProcessTreeKiller / 平台路径表（↔ process/platform/）
//! ```
//!
//! 锁纪律（31-security-baseline B8，评审 21-L2）：`Inner` 使用 std Mutex 且
//! **绝不跨 await 持锁**（持锁区间仅同步状态迁移）；锁中毒恢复式处理，
//! 不 expect/unwrap；端点/令牌只在进程内结构体流转，不进日志/事件（§7.3）。

pub mod active_port;
pub mod args;
pub mod cft;
pub mod discover;
pub mod endpoint;
pub mod events;
pub mod nav_stack;
pub mod platform;
pub mod profile;
pub mod state;

use crate::browser::active_port::{wait_active_port, StderrRing};
use crate::browser::args::{build_args, ArgInputs, EngineMode};
use crate::browser::cft::DownloadOpts;
use crate::browser::discover::{
    resolve_backend, BackendOverride, BackendResolution, CandidateProbe, ResolveOptions,
};
use crate::browser::endpoint::{CdpEndpoint, SessionToken};
use crate::browser::events::ProcessEvent;
use crate::browser::nav_stack::NavStack;
use crate::browser::platform::{new_killer, spawn_command, ProcessTreeKiller};
use crate::browser::profile::{
    browser_root, create_ephemeral, data_root, managed_root, remove_ephemeral,
    remove_stale_active_port, sanitize_profile_name, sessions_root, sweep_orphans, ImportReport,
    LockState,
};
use crate::browser::state::{
    BrowserState, CrashBudget, CrashReason, StateEvent, StateMachine, Transition,
};
use crate::cdp::transport::ExpectedBrowser;
use async_trait::async_trait;
use futures_util::FutureExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot, watch};

/// 孤儿清扫阈值（§4.4：sessions/ 下 mtime 超 24h）。
const ORPHAN_AGE: Duration = Duration::from_secs(24 * 3600);

/// G-9：Browser.close 发送超时上界（浏览器关闭 WS/响应缺失时不等待命令默认
/// 超时；超时即视为发送失败，走既有 wait_or_kill → 杀树兜底）。
const BROWSER_CLOSE_SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// 停止原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// 优雅停止：先发 Browser.close（若有会话）→ wait_or_kill(5s) → 杀树兜底（§6.3）。
    Graceful,
    /// 强制停止：直接杀树（§6.2 第 7 行）。
    Force,
}

/// 驱动内部确定性 panic 注入点（M5 回归专用，仅测试构建可见）。
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DriverPanicPoint {
    /// 启动路径（PortReady 前：状态 Launching，进程未派生）。
    PreReady,
    /// 运行期（PortReady 后、运行 select 前：endpoint/last_pid/stop_tx 全部就绪）。
    PostReady,
}

/// 启动/运行时参数微调（默认对齐 10 文档；测试注入缩短）。
#[derive(Debug, Clone, Copy)]
pub struct LaunchTuning {
    /// DevToolsActivePort 轮询间隔（§5.1：50ms）。
    pub poll_interval: Duration,
    /// 轮询总超时（§5.1：30s）。
    pub poll_timeout: Duration,
    /// 启动失败重试间隔（§5.3：500ms）。
    pub launch_retry_delay: Duration,
    /// 崩溃重启退避（§6.4：500ms）。
    pub crash_backoff: Duration,
    /// 崩溃重启窗口（§6.4：30s）。
    pub crash_window: Duration,
    /// 崩溃重启上限（§6.2：3 次）。
    pub crash_max_restarts: u8,
    /// 优雅停止等待（§6.3：5s，超时杀树）。
    pub wait_or_kill: Duration,
}

impl Default for LaunchTuning {
    fn default() -> Self {
        LaunchTuning {
            poll_interval: Duration::from_millis(50),
            poll_timeout: Duration::from_secs(30),
            launch_retry_delay: Duration::from_millis(500),
            crash_backoff: Duration::from_millis(500),
            crash_window: Duration::from_secs(30),
            crash_max_restarts: 3,
            wait_or_kill: Duration::from_secs(5),
        }
    }
}

/// 启动配置（10 文档 §9）。
#[derive(Debug, Clone)]
pub struct LaunchConfig {
    /// 后端覆盖（Auto = 回退链：CfT → Chrome → Edge）。
    pub backend: BackendOverride,
    /// 用户显式指定可执行文件（§2.4 引导文案「指定可执行文件」的落点；
    /// None = 按回退链解析。测试亦经此注入假浏览器脚本）。
    pub binary_override: Option<PathBuf>,
    /// 会话/受管 profile 规格。
    pub profile: ProfileSpec,
    /// 初始视口（面板尺寸 → --window-size）。
    pub viewport: (u32, u32),
    /// 引擎模式（默认 headless=new）。
    pub mode: EngineMode,
    /// 维度 12/14 追加参数（enable-features 合并 + 红线消毒在 args.rs）。
    pub extra_args: Vec<String>,
    /// 域名门禁启用（维度 17）→ WebRTC 收紧。
    pub restrict_webrtc: bool,
    /// 无 CfT 缓存时是否允许惰性下载（§2.1：仅用户接受时联网）。
    pub allow_cft_download: bool,
}

impl Default for LaunchConfig {
    fn default() -> Self {
        LaunchConfig {
            backend: BackendOverride::Auto,
            binary_override: None,
            profile: ProfileSpec::Ephemeral,
            viewport: (1280, 720),
            mode: EngineMode::HeadlessNew,
            extra_args: Vec::new(),
            restrict_webrtc: false,
            allow_cft_download: false,
        }
    }
}

/// Profile 规格（10 文档 §9 / R-2 分层）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileSpec {
    /// sessions/<uuid>/：临时，会话结束直删（§4.2/§4.4）。
    Ephemeral,
    /// 只读复制 → managed/<profile_name>/（§4.3）；受管用户资产，删除走 trash；
    /// persist 开关存 profile_meta.json（R-2，由维度 16 维护）。
    Imported {
        source_user_data: PathBuf,
        source_profile: String,
        profile_name: String,
    },
}

/// 启动报告（10 文档 §9：**不含 CdpEndpoint**——端点经私有通道交给维度 11）。
#[derive(Debug, Clone)]
pub struct LaunchReport {
    pub backend: BackendResolution,
    pub profile_dir: PathBuf,
    pub state: BrowserState,
}

/// 停止报告（诊断面）。
#[derive(Debug, Clone)]
pub struct StopReport {
    pub state: BrowserState,
    /// 是否走杀树兜底（优雅等待超时/强制停止）。
    pub force_killed: bool,
    /// 耗时（毫秒）。
    pub elapsed_ms: u64,
    /// profile 是否已清理。
    pub profile_removed: bool,
}

/// 状态快照（无端点，§7.3 前端零暴露）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserStatus {
    pub state: BrowserState,
    pub restarts: u8,
    /// 后端摘要（provenance + 版本）。
    pub backend: Option<String>,
    /// 终态错误文本（已脱敏）。
    pub last_error: Option<String>,
    pub nav_tabs: usize,
}

/// 进程管理错误面（10 文档 §9 的 BrowserError，为避免与维度 11 已导出的
/// `cdp::error::BrowserError` 重名，命名为 `ProcessError`——lib.rs 收口时
/// 按本名导出，勿用 BrowserError）。
#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    /// 未找到可用浏览器（全路径诊断清单，供前端 doctor 卡片）。
    #[error("未找到可用浏览器（候选清单见错误载荷）")]
    NoBrowser(Vec<CandidateProbe>),
    /// 浏览器启动后提前退出。
    #[error("浏览器启动后提前退出，exit={exit_code}：{stderr}")]
    LaunchEarlyExit { exit_code: i32, stderr: String },
    /// 等待 DevToolsActivePort 超时。
    #[error("等待 DevToolsActivePort 超时：{0}")]
    LaunchTimeout(String),
    /// profile 被占用。
    #[error("profile 被占用：{0}")]
    ProfileLocked(PathBuf),
    /// 崩溃重启超限（30s 窗口内 N 次）。
    #[error("崩溃重启超限：30s 内 {0} 次")]
    CrashLoopDetected(u8),
    /// 导入 profile 失败。
    #[error("导入 profile 失败：{0}")]
    ImportFailed(String),
    /// 内部错误（锁中毒等恢复式错误返回，B8 纪律）。
    #[error("内部错误：{0}")]
    Internal(String),
}

/// 进程句柄（pid + 杀树器；child 在 wait_task 启动后迁移出）。
struct ManagedProcess {
    child: Option<tokio::process::Child>,
    pid: u32,
    killer: Box<dyn ProcessTreeKiller>,
}

impl ManagedProcess {
    /// 迁移 child 进后台等待任务，返回 (任务, 剩余句柄)。
    fn wait_task(
        mut self,
    ) -> (
        tokio::task::JoinHandle<Option<std::process::ExitStatus>>,
        Self,
    ) {
        let mut child = self
            .child
            .take()
            .expect("ManagedProcess.child 已迁移，禁止重复调用 wait_task");
        let task = tokio::spawn(async move { child.wait().await.ok() });
        (task, self)
    }
}

/// 内部共享状态（std Mutex；持锁区间仅同步操作，绝不跨 await）。
struct Inner {
    machine: StateMachine,
    token: Option<SessionToken>,
    profile_dir: Option<PathBuf>,
    profile_spec: Option<ProfileSpec>,
    backend: Option<BackendResolution>,
    /// 端点仅供维度 11 接续（私有通道），不进事件/日志（§7.3）。
    endpoint: Option<CdpEndpoint>,
    nav: NavStack,
    last_config: Option<LaunchConfig>,
    /// 意图标志（§6.2）：区分「我杀的」与「它崩的」，避免自激重启。
    intentional: bool,
    /// 停止模式暂存（stop() 写入，驱动消费）。
    pending_stop: Option<bool>,
    stop_tx: Option<watch::Sender<bool>>,
    driver: Option<tokio::task::JoinHandle<()>>,
    /// M5 测试钩子：驱动内部确定性 panic 注入点（Inner 共享 Arc，触发后自清除，
    /// 见 `maybe_panic_driver`——清除落在共享态上，恢复路径不被污染）。
    #[cfg(test)]
    driver_panic_point: Option<DriverPanicPoint>,
    /// M5 测试探针：PostReady 注入时记录的进程 PID（断言兜底杀树用）。
    #[cfg(test)]
    panic_probe_pid: Option<u32>,
    last_pid: Option<u32>,
    last_error: Option<String>,
    force_killed: bool,
    stop_elapsed_ms: u64,
    /// G-9：优雅停止先发 Browser.close 的发送面（引擎建连后登记；停止路径
    /// 持锁仅取 Arc、锁外 await 发送，B8 纪律不变）。会话断连/结束后由
    /// `clear_session_state` 清空，避免向已死会话重复发送。
    close_sender: Option<Arc<dyn BrowserCloseSender>>,
}

impl Inner {
    fn new() -> Self {
        Inner {
            machine: StateMachine::new(),
            token: None,
            profile_dir: None,
            profile_spec: None,
            backend: None,
            endpoint: None,
            nav: NavStack::new(),
            last_config: None,
            intentional: false,
            pending_stop: None,
            stop_tx: None,
            driver: None,
            #[cfg(test)]
            driver_panic_point: None,
            #[cfg(test)]
            panic_probe_pid: None,
            last_pid: None,
            last_error: None,
            force_killed: false,
            stop_elapsed_ms: 0,
            close_sender: None,
        }
    }
}

/// G-9：优雅停止先发 `Browser.close` 的发送面抽象（浏览器级命令，无 session_id）。
/// 生产实现 = `BrowserSession`（引擎建连后经 `register_session` 登记）；
/// 测试注入记录/可控假发送器。发送失败一律不 panic，直接走既有兜底。
#[async_trait]
pub trait BrowserCloseSender: Send + Sync {
    /// 发送 `Browser.close`（等待有界：发送阶段自带超时兜底，返回错误不阻断）。
    async fn send_browser_close(&self) -> Result<(), crate::cdp::error::CdpError>;
}

#[async_trait]
impl BrowserCloseSender for crate::BrowserSession {
    async fn send_browser_close(&self) -> Result<(), crate::cdp::error::CdpError> {
        self.send_browser::<serde_json::Value>(
            crate::cdp::domains::names::BROWSER_CLOSE,
            serde_json::Value::Null,
        )
        .await
        .map(|_| ())
    }
}

/// 浏览器进程管理器（会话单例，幂等 start；§4.5 引擎内互斥）。
#[derive(Clone)]
pub struct BrowserManager {
    data_root: PathBuf,
    tuning: LaunchTuning,
    events: broadcast::Sender<ProcessEvent>,
    inner: Arc<Mutex<Inner>>,
    /// 启动临界区互斥（评审 H6）：`start()` 的「already_running 检查」与
    /// 「状态置位」之间含多个 await 点（孤儿清扫/后端解析/建 profile），
    /// 并发 start() 必须串行化——检查与置位在同一临界区内原子完成，
    /// 第二个调用方在置位后看到非 Stopped 直接走幂等分支，杜绝双启进程。
    start_lock: Arc<tokio::sync::Mutex<()>>,
}

impl BrowserManager {
    /// 新建管理器（指定数据根；测试用临时根，生产用 `with_default_data_root`）。
    pub fn new(data_root: impl Into<PathBuf>) -> Self {
        Self::with_tuning(data_root, LaunchTuning::default())
    }

    /// 平台默认数据根。
    pub fn with_default_data_root() -> Result<Self, ProcessError> {
        Ok(Self::new(data_root()?))
    }

    /// 带微调参数（测试用；生产一律 Default）。
    pub fn with_tuning(data_root: impl Into<PathBuf>, tuning: LaunchTuning) -> Self {
        let (events, _) = broadcast::channel(128);
        BrowserManager {
            data_root: data_root.into(),
            tuning,
            events,
            inner: Arc::new(Mutex::new(Inner::new())),
            start_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// 崩溃预算（窗口/上限来自 tuning）。
    fn budget(&self) -> CrashBudget {
        CrashBudget {
            window: self.tuning.crash_window,
            max_restarts: self.tuning.crash_max_restarts,
        }
    }

    /// 测试钩子：注入驱动内部确定性 panic（M5 回归专用；注入点写入共享 Inner，
    /// 触发后自清除——`maybe_panic_driver` 在共享态上清除，恢复路径不被污染）。
    #[cfg(test)]
    fn inject_driver_panic(&self, point: DriverPanicPoint) {
        self.lock().driver_panic_point = Some(point);
    }

    /// 测试钩子执行点：到达注入点时确定性 panic（触发后自清除）。
    #[cfg(test)]
    fn maybe_panic_driver(&self, point: DriverPanicPoint) {
        let (fire, probe) = {
            let mut g = self.lock();
            if g.driver_panic_point == Some(point) {
                g.driver_panic_point = None;
                (true, g.last_pid)
            } else {
                (false, None)
            }
        };
        if fire {
            // 探针：panic 前把当前进程 PID 落盘（测试断言兜底杀树用；触发后
            // 状态机/句柄清理会抹掉 last_pid，probe 独立保留）
            if let Some(pid) = probe {
                self.lock().panic_probe_pid = Some(pid);
            }
            panic!("M5 测试注入：驱动任务 panic（{point:?}）");
        }
    }

    /// 事件订阅（面板/工具层）。
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.events.subscribe()
    }

    /// 事件广播：`send` 仅在无订阅者时失败——事件面是 best-effort 观测通道，
    /// 无人订阅不代表本次操作失败，故只记 debug 不向上传播（上抛会污染所有调用点）。
    fn emit(&self, event: ProcessEvent) {
        if let Err(err) = self.events.send(event) {
            tracing::debug!("进程事件无订阅者，丢弃：{err}");
        }
    }

    /// 启动（§2/§5/§6.2）：幂等——非 Stopped 直接返回当前快照报告（§4.5）。
    ///
    /// 评审 H6（29-评审-代码质量与安全）：旧实现的 already_running 检查与状态
    /// 置位之间隔着 `sweep_orphans`/`resolve_backend(...).await`/`prepare_profile`
    /// 等非原子窗口，两个并发 start() 可各自通过检查 → 双启浏览器进程、双建
    /// profile、第二个驱动句柄覆盖第一个。现实现：整个「检查-置位」临界区由
    /// `start_lock` 互斥串行化——状态置位完成后释放，此后并发 start() 看到
    /// 非 Stopped 直接返回当前报告（幂等语义不变，等待首启结果不阻塞）。
    pub async fn start(&self, config: LaunchConfig) -> Result<LaunchReport, ProcessError> {
        let critical = self.start_lock.lock().await;
        let already_running = {
            let g = self.lock();
            !matches!(g.machine.state(), BrowserState::Stopped)
        };
        if already_running {
            return Ok(self.current_report());
        }
        // 孤儿清扫（§4.4：启动时 best-effort，清扫结果只作诊断）
        // sweep_orphans 内部对每个目录失败已逐项容错，返回值为「已删除目录」；
        // 此处不能上抛（清扫失败不得阻断启动），故仅记录数量。
        let sessions = sessions_root(&self.data_root);
        let swept = sweep_orphans(&sessions, ORPHAN_AGE);
        if !swept.is_empty() {
            tracing::debug!("启动前清扫孤儿会话目录：{} 个", swept.len());
        }
        // 1. 解析二进制（§2.1 回退链）
        let backend = resolve_backend(
            &self.data_root,
            config.backend,
            &ResolveOptions {
                allow_cft_download: config.allow_cft_download,
                download: DownloadOpts::default(),
            },
        )
        .await?;
        // 2. 建 profile 目录（§4）
        let (profile_dir, token) = self.prepare_profile(&config).await?;
        // 3. 状态机入 Launching + 派发驱动任务（临界区尾：状态置位即释放互斥）
        let (first_tx, first_rx) = oneshot::channel();
        {
            let mut g = self.lock();
            let t = g
                .machine
                .on(StateEvent::Start, Instant::now(), &self.budget());
            debug_assert!(matches!(t, Transition::SpawnBrowser { .. }));
            g.token = Some(token);
            g.profile_dir = Some(profile_dir.clone());
            g.profile_spec = Some(config.profile.clone());
            g.backend = Some(backend.clone());
            g.last_config = Some(config.clone());
            g.intentional = false;
            g.pending_stop = None;
            g.last_error = None;
            g.force_killed = false;
            let mgr = self.clone();
            g.driver = Some(tokio::spawn(async move {
                // M5 加固（评审 29 §M5）：驱动任务外包 catch_unwind——驱动内部
                // 任何 panic（expect 断言/运行时内部/测试钩子）都不得让管理器
                // 卡死。旧实现：panic 后状态冻结在非 Stopped、driver 句柄残留、
                // stop() 等到的只是已 panic 任务并报告错误状态、后续 start()
                // 幂等分支永久返回陈旧报告。现实现：panic 时回调 on_driver_panic
                // （终态收敛 + 进程杀树兜底 + 终态事件广播 + 清句柄释放等待方），
                // stop()/start() 均收敛，后续可重新启动（可恢复性）。
                let result = std::panic::AssertUnwindSafe(mgr.drive_session(config, first_tx))
                    .catch_unwind()
                    .await;
                if let Err(payload) = result {
                    let msg = panic_message(&payload);
                    tracing::error!("会话驱动任务 panic（M5 兜底收敛）：{msg}");
                    mgr.on_driver_panic(&msg).await;
                }
            }));
        }
        drop(critical);
        self.emit(ProcessEvent::StateChanged {
            state: BrowserState::Launching { attempt: 1 },
            restarts: 0,
            backend: Some(backend),
            error: None,
        });
        // 4. 等首启结果（超时按 tuning 放大）
        let first_timeout = self
            .tuning
            .poll_timeout
            .saturating_mul(3)
            .saturating_add(self.tuning.launch_retry_delay.saturating_mul(3))
            .saturating_add(Duration::from_secs(10));
        match tokio::time::timeout(first_timeout, first_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ProcessError::Internal("会话驱动任务异常退出".to_string())),
            Err(_) => Err(ProcessError::Internal("等待首启结果超时".to_string())),
        }
    }

    /// 停止（§6.2/§6.3）：意图置位 → 通知驱动 → 等驱动收尾。
    pub async fn stop(&self, reason: StopReason) -> Result<StopReport, ProcessError> {
        // 第一步：守卫内做状态转移与收尾收集（守卫在块尾释放；await 一律
        // 在守卫作用域之外——MutexGuard 跨 await 非 Send，tokio::spawn 亦不
        // 可用（调用方断言 stop 返回时清理已完成，异步派发有竞态））
        enum StopStep {
            NoDriver {
                leftover: Option<std::path::PathBuf>,
            },
            WaitDriver(Option<tokio::task::JoinHandle<()>>),
        }
        let step = {
            let mut g = self.lock();
            if g.driver.is_none() {
                // 无驱动（从未启动/已收敛）：仅清理遗留 profile（崩溃放弃后的残留）
                let leftover = match (g.profile_dir.clone(), g.profile_spec.clone()) {
                    (Some(dir), Some(ProfileSpec::Ephemeral)) => Some(dir),
                    _ => None,
                };
                g.profile_dir = None;
                g.profile_spec = None;
                g.endpoint = None;
                StopStep::NoDriver { leftover }
            } else {
                g.intentional = true;
                g.pending_stop = Some(matches!(reason, StopReason::Graceful));
                if let Some(tx) = &g.stop_tx {
                    // 接收端已释放 = 驱动任务已退出，停止意图由 pending_stop 兜住；
                    // 该失败不构成停止失败（下方仍会 await 驱动句柄收敛）。
                    if let Err(err) = tx.send(true) {
                        tracing::debug!("停止信号无接收者（驱动已退出），由 pending_stop 兜底：{err}");
                    }
                }
                StopStep::WaitDriver(g.driver.take())
            }
        };
        match step {
            StopStep::NoDriver { leftover } => {
                if let Some(dir) = leftover {
                    // 清理失败不影响停止收敛：目录由下次启动的孤儿清扫接管
                    if let Err(e) = remove_ephemeral(&dir).await {
                        tracing::warn!("停止时清理临时 profile 失败（登记孤儿，下次启动清扫）：{e}");
                    }
                }
                Ok(StopReport {
                    state: BrowserState::Stopped,
                    force_killed: false,
                    elapsed_ms: 0,
                    profile_removed: true,
                })
            }
            StopStep::WaitDriver(driver) => {
                if let Some(task) = driver {
                    // JoinError 只可能是驱动任务 panic/取消；此后必须继续收敛状态，
                    // 故不能上抛，但必须留痕（否则「停止成功」而驱动实际崩了）。
                    if let Err(e) = task.await {
                        tracing::warn!("等待驱动任务收敛失败（继续按当前状态返回）：{e}");
                    }
                }
                let g = self.lock();
                Ok(StopReport {
                    state: g.machine.state(),
                    force_killed: g.force_killed,
                    elapsed_ms: g.stop_elapsed_ms,
                    profile_removed: g.profile_dir.is_none(),
                })
            }
        }
    }

    /// 手动重启入口（崩溃重启由驱动自动完成；本入口供引擎显式触发：
    /// Crashed → 驱动退避中无需干预；Stopped → 用最近配置重新启动）。
    pub async fn restart(&self, _reason: CrashReason) -> Result<(), ProcessError> {
        let config = {
            let g = self.lock();
            match g.machine.state() {
                BrowserState::Crashed { .. } => return Ok(()),
                BrowserState::Stopped => g.last_config.clone(),
                _ => return Err(ProcessError::Internal("浏览器运行中，无需重启".to_string())),
            }
        };
        if let Some(config) = config {
            self.start(config).await.map(|_| ())
        } else {
            Err(ProcessError::Internal("无最近启动配置可重启".to_string()))
        }
    }

    /// 状态快照（无端点）。
    pub fn status(&self) -> BrowserStatus {
        let g = self.lock();
        BrowserStatus {
            state: g.machine.state(),
            restarts: g.machine.restarts(),
            backend: g.backend.as_ref().map(|b| b.summary()),
            last_error: g.last_error.clone(),
            nav_tabs: g.nav.tabs.len(),
        }
    }

    /// 导航栈（维度 11/15 读取）。
    pub fn nav_stack(&self) -> NavStack {
        self.lock().nav.clone()
    }

    /// 导航栈回写（维度 11 事件驱动；变更后异步落盘 best-effort）。
    pub fn set_nav(&self, nav: NavStack) {
        let (dir, tabs, active) = {
            let mut g = self.lock();
            g.nav = nav.clone();
            (g.profile_dir.clone(), nav.tabs, nav.active)
        };
        if let Some(dir) = dir {
            let path = dir.join(crate::browser::profile::NAV_STACK_FILE);
            let json = serde_json::to_string(&NavStack {
                tabs: tabs.clone(),
                active,
            })
            .unwrap_or_default();
            tokio::spawn(async move {
                if let Err(e) = tokio::fs::write(&path, json).await {
                    tracing::warn!("导航栈落盘失败（忽略）：{e}");
                }
            });
        }
        self.emit(ProcessEvent::NavStackChanged { tabs, active });
    }

    /// 端点私有通道（维度 11 接续专用；绝不出现在事件/日志/status）。
    pub fn endpoint(&self) -> Option<CdpEndpoint> {
        self.lock().endpoint.clone()
    }

    /// 对维度 11 的建连助手：`CdpEndpoint` + 身份校验预期 → BrowserSession。
    /// `policy` 由引擎侧注入（conex-browser-tools）。
    pub async fn connect_session(
        endpoint: CdpEndpoint,
        expected: ExpectedBrowser,
        policy: Arc<dyn crate::cdp::sender::CommandPolicyHooks>,
    ) -> Result<crate::BrowserSession, crate::cdp::error::BrowserError> {
        crate::BrowserSession::connect(endpoint, expected, policy).await
    }

    /// 登记真实会话（G-9 便捷入口）：`Arc<BrowserSession>` → 内部关闭发送面。
    /// 引擎建连成功后调用；优雅停止将先经它发 `Browser.close`（浏览器级，
    /// 无 session_id）。会话结束/断连后由停止收尾自动清空，无需手动清理。
    pub fn register_session(&self, session: Arc<crate::BrowserSession>) {
        self.register_close_sender(session);
    }

    /// 登记关闭发送面（G-9）：自定义发送实现注入点（生产用 `register_session`，
    /// 测试注入记录/可控假发送器）。
    pub fn register_close_sender(&self, sender: Arc<dyn BrowserCloseSender>) {
        self.lock().close_sender = Some(sender);
    }

    /// 清空关闭发送面（会话断连/结束后显式清理；停止收尾亦会自动清空）。
    pub fn clear_close_sender(&self) {
        self.lock().close_sender = None;
    }

    // ---------- 内部 ----------

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // 锁纪律（B8）：中毒恢复数据继续使用，不 panic
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 事件发射前快照（restarts + backend）：
    /// 避免在 emit 结构体字面量内多次 `self.lock()`——临时守卫会存活到整个
    /// 语句结束，二次加锁即自死锁（std Mutex 不可重入）。
    fn emit_snapshot(&self) -> (u8, Option<BackendResolution>) {
        let g = self.lock();
        (g.machine.restarts(), g.backend.clone())
    }

    /// profile 准备（§4.2/§4.3）：Ephemeral → sessions/<uuid>/；Imported → 复制到 managed/。
    async fn prepare_profile(
        &self,
        config: &LaunchConfig,
    ) -> Result<(PathBuf, SessionToken), ProcessError> {
        let root = browser_root(&self.data_root);
        match &config.profile {
            ProfileSpec::Ephemeral => {
                let token = SessionToken::new();
                let dir = create_ephemeral(&root, &token)?;
                Ok((dir, token))
            }
            ProfileSpec::Imported {
                source_user_data,
                source_profile,
                profile_name,
            } => {
                let name = sanitize_profile_name(profile_name);
                let dest = managed_root(&root).join(&name);
                let token = SessionToken::new();
                if dest.exists() {
                    // 已存在：复用（用户资产；锁检测兜底 §4.5）
                    match crate::browser::profile::detect_singleton_lock(&dest) {
                        LockState::Alive { pid } => {
                            return Err(ProcessError::ProfileLocked(PathBuf::from(format!(
                                "受管 profile 已被 PID {pid} 占用"
                            ))));
                        }
                        LockState::Stale { .. } => {
                            // stale 锁自愈（§4.5）：崩溃残留的自家运行期标记直删
                            #[allow(clippy::disallowed_methods)]
                            {
                                // stale 锁自愈为 best-effort：删不掉时浏览器启动会
                                // 自行报 ProfileLocked，故不上抛，但必须留痕。
                                if let Err(e) = std::fs::remove_file(dest.join("SingletonLock")) {
                                    tracing::warn!(
                                        "stale SingletonLock 清理失败（启动可能报占用）：{e}"
                                    );
                                }
                            }
                        }
                        LockState::Absent => {}
                    }
                } else {
                    // 首次：只读复制（§4.3）
                    let report: ImportReport = crate::browser::profile::import_copy(
                        source_user_data,
                        source_profile,
                        &dest,
                        false,
                    )
                    .await?;
                    tracing::info!(
                        "导入 profile 完成：copied={} skipped={} → {}",
                        report.copied,
                        report.skipped,
                        dest.display()
                    );
                }
                Ok((dest, token))
            }
        }
    }

    /// 会话驱动（唯一常驻任务）：启动 → 运行 → 崩溃自愈/停止收敛。
    async fn drive_session(
        &self,
        config: LaunchConfig,
        first_tx: oneshot::Sender<Result<LaunchReport, ProcessError>>,
    ) {
        // M5 测试钩子：启动路径注入确定性 panic（回归用例驱动；触发后自清除，
        // 见 maybe_panic_driver——清除落在共享 Inner 上，恢复路径不受污染）。
        #[cfg(test)]
        self.maybe_panic_driver(DriverPanicPoint::PreReady);
        let mut first_tx = Some(first_tx);
        // 导航栈恢复（崩溃重启保留 nav_stack.json 落盘，U-7）
        let profile_dir = self.lock().profile_dir.clone();
        if let Some(dir) = profile_dir {
            if let Ok(Some(nav)) =
                NavStack::load(&dir.join(crate::browser::profile::NAV_STACK_FILE))
            {
                self.lock().nav = nav;
            }
        }
        loop {
            // —— 启动（含 3 次重试，§5.3）——
            let launch = self.launch_with_retries(&config).await;
            let (process, endpoint) = match launch {
                Ok(v) => v,
                Err(e) => {
                    // GiveUp 或启动中被停止
                    let stopped = self.lock().pending_stop.is_some();
                    if stopped {
                        self.abort_during_launch().await;
                    } else {
                        self.give_up(e, &mut first_tx).await;
                    }
                    break;
                }
            };
            // —— 就绪（§6.2 第 2 行）——
            {
                let mut g = self.lock();
                g.machine
                    .on(StateEvent::PortReady, Instant::now(), &self.budget());
                g.endpoint = Some(endpoint);
                g.last_pid = Some(process.pid);
                g.last_error = None;
            }
            let (restarts, backend) = self.emit_snapshot();
            self.emit(ProcessEvent::StateChanged {
                state: BrowserState::Running,
                restarts,
                backend,
                error: None,
            });
            if let Some(tx) = first_tx.take() {
                // 等待方可能已超时放弃（start 的 first_timeout）：会话仍继续运行，
                // 丢弃首启报告不影响浏览器；留痕便于诊断「start 报超时但实际已就绪」。
                if tx.send(Ok(self.current_report())).is_err() {
                    tracing::warn!("首启结果无人接收（等待方已放弃，会话继续运行）");
                }
            }
            // —— 运行期：等退出或停止意图 ——
            let (mut wait_task, mut process) = process.wait_task();
            let (stop_tx, mut stop_rx) = watch::channel(false);
            self.lock().stop_tx = Some(stop_tx);
            // 停止信号竞态窗口（回归：F6 Drop 杀树测试暴露）：stop() 若落在
            // 「上一轮 select 结束（进程退出）→ 本轮新 stop_tx 挂接」之间的
            // relaunch 窗口（崩溃退避/重试/启动轮询），watch 信号发往旧通道
            // （无接收者）即丢失——pending_stop 是持久信号，此处复查兜住；
            // 复查与 select 之间无 await 且新 stop_tx 已挂接，该窗口内到达的
            // stop() 经新 stop_rx 的 watch 语义在 select 建立时立即可见。
            if self.lock().pending_stop.is_some() {
                self.stop_path(&mut wait_task, &mut process, false).await;
                break;
            }
            // M5 测试钩子：运行期注入确定性 panic（回归用例驱动；此刻 endpoint/
            // last_pid/stop_tx/wait_task 全部就绪——panic 后必须全部清理、孤儿
            // 进程必须兜底杀树、等待方必须释放）。
            #[cfg(test)]
            self.maybe_panic_driver(DriverPanicPoint::PostReady);
            let exit_status = tokio::select! {
                status = &mut wait_task => {
                    // 进程退出（可能是我杀的，也可能是它崩的）
                    let exited = status.ok().flatten();
                    if self.lock().intentional {
                        self.stop_path(&mut wait_task, &mut process, true).await;
                        break;
                    }
                    Some(exited.map(|s| classify_exit(&s)).unwrap_or(CrashReason::Unknown))
                }
                _ = stop_rx.changed() => {
                    // 停止意图（stop() 已置 intentional + pending_stop）
                    self.stop_path(&mut wait_task, &mut process, false).await;
                    break;
                }
            };
            // —— 崩溃路径（§6.4）——
            let reason = exit_status.expect("两个分支均已收敛，此处必有退出原因");
            let transition = {
                let mut g = self.lock();
                g.machine.on(
                    StateEvent::CrashDetected { reason },
                    Instant::now(),
                    &self.budget(),
                )
            };
            match transition {
                Transition::CrashAbort { restarts } => {
                    // 30s 窗口内超限 → 终态（保留导航栈数据，§6.2）
                    let nav_tabs = self.lock().nav.tabs.len();
                    self.freeze_nav();
                    self.emit(ProcessEvent::CrashRestarting {
                        restarts,
                        reason,
                        nav_tabs,
                    });
                    let (_r, backend) = self.emit_snapshot();
                    self.lock().last_error =
                        Some(ProcessError::CrashLoopDetected(restarts).to_string());
                    self.emit(ProcessEvent::StateChanged {
                        state: BrowserState::Stopped,
                        restarts,
                        backend,
                        error: Some(ProcessError::CrashLoopDetected(restarts).to_string()),
                    });
                    self.clear_session_state();
                    break;
                }
                Transition::CrashEnter { restarts } => {
                    // 冻结导航栈 + 广播 + 退避后重启（复用 profile，§6.4 第 3 步）
                    let nav_tabs = self.lock().nav.tabs.len();
                    self.freeze_nav();
                    self.emit(ProcessEvent::CrashRestarting {
                        restarts,
                        reason,
                        nav_tabs,
                    });
                    // 退避窗口内可被停止意图打断
                    let interrupted = tokio::select! {
                        _ = tokio::time::sleep(self.tuning.crash_backoff) => false,
                        _ = stop_rx.changed() => true,
                    };
                    if interrupted {
                        self.stop_path(&mut wait_task, &mut process, false).await;
                        break;
                    }
                    {
                        let mut g = self.lock();
                        g.machine
                            .on(StateEvent::RestartTick, Instant::now(), &self.budget());
                    }
                    let (_r, backend) = self.emit_snapshot();
                    self.emit(ProcessEvent::StateChanged {
                        state: BrowserState::Launching { attempt: 1 },
                        restarts,
                        backend,
                        error: None,
                    });
                    // continue：复用同 profile 重启（仅删 stale DevToolsActivePort）
                }
                other => {
                    tracing::warn!("意外迁移（忽略）：{other:?}");
                    break;
                }
            }
        }
    }

    /// 启动重试循环（§5.3：最多 3 次，间隔 launch_retry_delay）。
    async fn launch_with_retries(
        &self,
        config: &LaunchConfig,
    ) -> Result<(ManagedProcess, CdpEndpoint), ProcessError> {
        loop {
            match self.launch_once(config).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    let transition = {
                        let mut g = self.lock();
                        g.machine
                            .on(StateEvent::LaunchFailed, Instant::now(), &self.budget())
                    };
                    match transition {
                        Transition::RetryLaunch { attempt } => {
                            let (restarts, backend) = self.emit_snapshot();
                            self.emit(ProcessEvent::StateChanged {
                                state: BrowserState::Launching { attempt },
                                restarts,
                                backend,
                                error: None,
                            });
                            tokio::time::sleep(self.tuning.launch_retry_delay).await;
                            // 重试间隔内可被停止意图打断
                            if self.lock().pending_stop.is_some() {
                                return Err(ProcessError::Internal("启动中被停止".to_string()));
                            }
                        }
                        Transition::GiveUp => return Err(e),
                        other => {
                            tracing::warn!("意外迁移（忽略）：{other:?}");
                            return Err(e);
                        }
                    }
                }
            }
        }
    }

    /// 单次启动（§5.1 全流程）。
    /// 豁免 clippy 子进程禁令：本模块即浏览器进程的**注册面**——spawn 后立即
    /// 登记 pid（Inner.last_pid）+ Job Object 挂接 + 生命周期全托管（崩溃自愈/
    /// 停止杀树/Drop 兜底），进程不脱离会话存活，满足禁令「未 enroll 子进程
    /// 脱离会话存活」的反向要求；同豁免面参考 agent-workbench process/git。
    #[allow(clippy::disallowed_methods)]
    async fn launch_once(
        &self,
        config: &LaunchConfig,
    ) -> Result<(ManagedProcess, CdpEndpoint), ProcessError> {
        let (backend, profile_dir) = {
            let g = self.lock();
            (
                g.backend.clone().expect("start 前已解析后端"),
                g.profile_dir.clone().expect("start 前已建 profile"),
            )
        };
        // 1. 删 stale DevToolsActivePort（§5.1 第 1 步，S0-02 实测陷阱）
        remove_stale_active_port(&profile_dir);
        // 1b. 可执行文件：用户显式指定优先，否则用回退链解析结果
        let binary = config
            .binary_override
            .clone()
            .unwrap_or_else(|| backend.backend.binary().to_path_buf());
        if !binary.is_file() {
            return Err(ProcessError::LaunchEarlyExit {
                exit_code: -1,
                stderr: format!("指定的可执行文件不存在：{}", binary.display()),
            });
        }
        // 2. 构建参数 + spawn（stdout 丢弃、stderr 管道保留）
        let imported = matches!(config.profile, ProfileSpec::Imported { .. });
        let adaptive = crate::browser::args::env_adaptive_flags();
        let args = build_args(&ArgInputs {
            user_data_dir: &profile_dir,
            viewport: config.viewport,
            mode: config.mode,
            imported_profile: imported,
            restrict_webrtc: config.restrict_webrtc,
            extra_args: &config.extra_args,
            adaptive: &adaptive,
        });
        let mut cmd = spawn_command(&binary);
        cmd.args(&args);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| ProcessError::LaunchEarlyExit {
            exit_code: -1,
            stderr: format!("spawn 失败：{e}"),
        })?;
        let mut killer = new_killer();
        // attach 失败已内部降级 taskkill（不阻断启动）；此处仅留痕，便于诊断
        // 「杀树走 taskkill 而非 Job Object」的现场（Windows /unix 语义见 platform）。
        if let Err(e) = killer.attach(&mut child) {
            tracing::warn!("进程树终结器挂接失败（杀树降级 taskkill）：{e}");
        }
        let pid = child.id().unwrap_or(0);
        tracing::debug!(
            "浏览器进程已派生（backend={} pid={pid}）",
            backend.summary()
        );
        // 3. stderr 环形缓冲（后台读取，失败路径诊断）
        let stderr = Arc::new(tokio::sync::Mutex::new(StderrRing::new(20)));
        if let Some(mut pipe) = child.stderr.take() {
            let ring = stderr.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut reader = tokio::io::BufReader::new(&mut pipe);
                let mut line = String::new();
                loop {
                    line.clear();
                    // 读取字节数：0 = EOF；>0 = 已读入一行（含换行，供环形缓冲诊断）；
                    // 错误 = 管道异常（仅诊断价值，记 debug 后终止读取，不影响浏览器）。
                    let read = reader.read_line(&mut line).await;
                    let bytes = match read {
                        Ok(n) => n,
                        Err(err) => {
                            tracing::debug!("浏览器 stderr 读取中断（诊断面降级）：{err}");
                            break;
                        }
                    };
                    if bytes == 0 {
                        break;
                    }
                    let line = line.trim_end().to_string();
                    if !line.is_empty() {
                        ring.lock().await.push(line);
                    }
                }
            });
        }
        // 4. 轮询 DevToolsActivePort（§5.1：50ms/30s，提前退出检测）
        let settings = crate::browser::active_port::PollSettings {
            interval: self.tuning.poll_interval,
            timeout: self.tuning.poll_timeout,
        };
        let outcome = wait_active_port(&profile_dir, Some(&mut child), &stderr, &settings).await;
        match outcome {
            crate::browser::active_port::WaitOutcome::Endpoint(ep) => {
                let process = ManagedProcess {
                    child: Some(child),
                    pid,
                    killer,
                };
                Ok((process, ep))
            }
            crate::browser::active_port::WaitOutcome::EarlyExit { exit_code, stderr } => {
                kill_tree_and_reap(&mut killer, &mut child, "启动早期退出").await;
                Err(ProcessError::LaunchEarlyExit { exit_code, stderr })
            }
            crate::browser::active_port::WaitOutcome::Timeout { stderr } => {
                kill_tree_and_reap(&mut killer, &mut child, "启动超时").await;
                Err(ProcessError::LaunchTimeout(stderr))
            }
        }
    }

    /// 启动失败终态（GiveUp）：清理本次 profile（§4.4 启动失败行）+ 终态事件。
    async fn give_up(
        &self,
        err: ProcessError,
        first_tx: &mut Option<oneshot::Sender<Result<LaunchReport, ProcessError>>>,
    ) {
        let err_text = err.to_string();
        self.cleanup_profile().await;
        {
            let mut g = self.lock();
            g.last_error = Some(err_text.clone());
        }
        if let Some(tx) = first_tx.take() {
            // 等待方已放弃时 send 失败：放弃本身即「启动失败」，无需再传播，
            // 但留痕以免与「未收到任何结果」混淆。
            if tx.send(Err(err)).is_err() {
                tracing::warn!("首启失败结果无人接收（等待方已放弃）");
            }
        }
        let (restarts, backend) = self.emit_snapshot();
        self.emit(ProcessEvent::StateChanged {
            state: BrowserState::Stopped,
            restarts,
            backend,
            error: Some(err_text),
        });
        self.clear_session_state();
    }

    /// G-9 发送面：优雅停止先经登记的会话发 `Browser.close`（浏览器级命令，
    /// 无 session_id）。发送有界（`BROWSER_CLOSE_SEND_TIMEOUT`）——Browser.close
    /// 发出后浏览器随时关闭 WS，响应未必回；发送失败/超时/无会话一律静默
    /// 降级为既有 wait_or_kill → 杀树兜底，不 panic、不阻塞停止收敛。
    async fn send_browser_close_gracefully(&self) {
        let sender = {
            let g = self.lock();
            g.close_sender.clone()
        };
        if let Some(sender) = sender {
            let sent =
                tokio::time::timeout(BROWSER_CLOSE_SEND_TIMEOUT, sender.send_browser_close()).await;
            match sent {
                Ok(Ok(())) => tracing::debug!("优雅停止：Browser.close 已发送"),
                Ok(Err(e)) => {
                    tracing::warn!("优雅停止：Browser.close 发送失败（走既有兜底）：{e}")
                }
                Err(_) => tracing::warn!("优雅停止：Browser.close 发送超时（走既有兜底）"),
            }
        }
    }

    /// 停止收尾（§6.3：优雅 → 先 Browser.close 再 wait_or_kill；超时/强制 → 杀树）+ 清理 profile。
    async fn stop_path(
        &self,
        wait_task: &mut tokio::task::JoinHandle<Option<std::process::ExitStatus>>,
        process: &mut ManagedProcess,
        already_exited: bool,
    ) {
        let start = Instant::now();
        let graceful = self.lock().pending_stop.take().unwrap_or(true);
        let transition = {
            let mut g = self.lock();
            g.machine.on(
                StateEvent::Stop { graceful },
                Instant::now(),
                &self.budget(),
            )
        };
        let mut force_killed = false;
        match transition {
            Transition::BeginGracefulStop | Transition::BeginForceStop => {
                let (restarts, backend) = self.emit_snapshot();
                self.emit(ProcessEvent::StateChanged {
                    state: BrowserState::Stopping { graceful },
                    restarts,
                    backend,
                    error: None,
                });
                let mut exited = already_exited;
                if already_exited {
                    // 进程已自行退出（如 Browser.close 生效）
                } else if graceful {
                    // 优雅路径（§6.3，G-9）：先经会话发 Browser.close（浏览器级，
                    // 无 session_id）→ 等自然退出；发送失败/无会话 → 既有
                    // wait_or_kill(5s) → 杀树兜底语义不变
                    self.send_browser_close_gracefully().await;
                    exited = tokio::select! {
                        _ = &mut *wait_task => true,
                        _ = tokio::time::sleep(self.tuning.wait_or_kill) => false,
                    };
                    if !exited {
                        kill_tree_logged(process.killer.as_mut(), "优雅停止超时");
                        force_killed = true;
                    }
                } else {
                    // 强制路径：直接杀树（§6.2 第 7 行）
                    kill_tree_logged(process.killer.as_mut(), "强制停止");
                    force_killed = true;
                }
                // 收尸（杀树后进程必然退出；wait_task 分支已取走输出时**禁止重复 poll**
                // ——tokio JoinHandle 二次完成 poll 直接 panic「polled after completion」，
                // 联调 E5 根因：真实浏览器 Browser.close 自然退出走 wait_task 分支，
                // 再次 poll 已完成的句柄导致驱动任务崩溃、状态卡在 Stopping）
                if !exited {
                    match tokio::time::timeout(Duration::from_secs(2), &mut *wait_task).await {
                        Ok(Ok(_status)) => {} // 已被杀树回收：退出码不影响停止收敛
                        Ok(Err(e)) => tracing::warn!("停止收尸：驱动任务异常：{e}"),
                        Err(_) => tracing::warn!("停止收尸超时：2s 内进程未退出（已杀树）"),
                    }
                }
            }
            Transition::StoppedClean => {
                // 启动中/崩溃窗口内取消：无进程需处理（launch_once 已清残留）
            }
            other => {
                tracing::warn!("停止迁移意外：{other:?}");
            }
        }
        self.finish_stop(start, force_killed).await;
    }

    /// 停止完成态：机器收敛 Stopped + 清理 profile + 终态事件。
    async fn finish_stop(&self, start: Instant, force_killed: bool) {
        {
            let mut g = self.lock();
            g.machine
                .on(StateEvent::StopExited, Instant::now(), &self.budget());
        }
        self.cleanup_profile().await;
        let elapsed = start.elapsed().as_millis() as u64;
        let (restarts, backend) = self.emit_snapshot();
        {
            let mut g = self.lock();
            g.force_killed = force_killed;
            g.stop_elapsed_ms = elapsed;
        }
        self.emit(ProcessEvent::StateChanged {
            state: BrowserState::Stopped,
            restarts,
            backend,
            error: None,
        });
        self.clear_session_state();
    }

    /// 清理 profile（§4.4：临时直删；受管保留——用户资产删除由维度 16 经 trash 发起）。
    async fn cleanup_profile(&self) {
        let (dir, spec) = {
            let g = self.lock();
            (g.profile_dir.clone(), g.profile_spec.clone())
        };
        match (&dir, &spec) {
            (Some(dir), Some(ProfileSpec::Ephemeral)) => {
                if let Err(e) = remove_ephemeral(dir).await {
                    tracing::warn!("临时 profile 清理失败（登记孤儿，下次启动清扫）：{e}");
                } else {
                    let mut g = self.lock();
                    g.profile_dir = None;
                    g.profile_spec = None;
                }
            }
            (Some(dir), _) => {
                tracing::debug!("受管 profile 保留（用户资产）：{}", dir.display());
            }
            _ => {}
        }
    }

    /// 启动中被停止（无进程可杀）：机器收敛 + 清理 profile + 终态事件。
    async fn abort_during_launch(&self) {
        {
            let mut g = self.lock();
            g.machine.on(
                StateEvent::Stop { graceful: true },
                Instant::now(),
                &self.budget(),
            );
        }
        self.cleanup_profile().await;
        let (restarts, backend) = self.emit_snapshot();
        self.emit(ProcessEvent::StateChanged {
            state: BrowserState::Stopped,
            restarts,
            backend,
            error: Some("启动中被停止".to_string()),
        });
        self.clear_session_state();
    }

    /// M5 兜底（评审 29 §M5）：驱动任务 panic 回调——任意状态下驱动崩溃都
    /// 不得让管理器卡死。本回调自身必须零 panic（二次 panic 会让任务再次
    /// 崩溃、状态再次卡死），执行序：
    /// 1. 进程杀树兜底：驱动栈上的 ManagedProcess/killer 已随 unwind 丢弃
    ///    （JobTreeKiller 无 Drop 实现，KILL_ON_JOB_CLOSE 不会触发——孤儿
    ///    进程只能按 Inner.last_pid 终结；kill_sync 对不存在 PID 幂等）；
    /// 2. 状态机事件驱动收敛 Stopped（复用 §6.2 迁移表，不绕过语义）：
    ///    Running→Stop(force)→Stopping→StopExited；Launching/Crashed→Stop
    ///    直接 StoppedClean；Stopping→StopExited；循环防御非法迁移死循环；
    /// 3. 清理 profile + 清会话残留（endpoint/stop_tx/driver 句柄）；
    /// 4. 终态错误记录 + 广播 StateChanged（error 带 panic 原因）——等待方
    ///    （stop()、start() 的 first_rx）随之释放，后续 start() 幂等检查看到
    ///    Stopped，可重新启动。
    async fn on_driver_panic(&self, msg: &str) {
        // 1. 进程杀树兜底（Job 句柄已随 unwind 丢失，KILL_ON_JOB_CLOSE 不触发）
        if let Some(pid) = self.lock().last_pid {
            new_killer().kill_sync(pid);
        }
        // 2. 状态机收敛（全部状态已覆盖，最多 2 轮；Invalid 兜底退出防死循环）
        {
            let mut g = self.lock();
            for _ in 0..4 {
                let event = match g.machine.state() {
                    BrowserState::Stopped => break,
                    BrowserState::Stopping { .. } => StateEvent::StopExited,
                    BrowserState::Running => StateEvent::Stop { graceful: false },
                    BrowserState::Launching { .. } | BrowserState::Crashed { .. } => {
                        StateEvent::Stop { graceful: true }
                    }
                };
                let transition = g.machine.on(event, Instant::now(), &self.budget());
                if matches!(transition, Transition::Invalid { .. }) {
                    tracing::error!("M5 兜底收敛异常迁移（忽略）：{transition:?}");
                    break;
                }
            }
            g.pending_stop = None;
            g.intentional = false;
        }
        // 3. 清理 profile + 会话残留（顺序在广播前：事件到达即一切已就绪）
        self.cleanup_profile().await;
        self.clear_session_state();
        // 4. 终态错误记录 + 事件广播（reason=panic）
        let err_text = format!("会话驱动异常终止（驱动 panic：{msg}）");
        {
            let mut g = self.lock();
            g.last_error = Some(err_text.clone());
        }
        let (restarts, backend) = self.emit_snapshot();
        self.emit(ProcessEvent::StateChanged {
            state: BrowserState::Stopped,
            restarts,
            backend,
            error: Some(err_text),
        });
    }

    /// 崩溃瞬间冻结导航栈（内存 + 落盘，§6.4）。
    fn freeze_nav(&self) {
        let (dir, nav) = {
            let g = self.lock();
            (g.profile_dir.clone(), g.nav.clone())
        };
        if let Some(dir) = dir {
            let path = dir.join(crate::browser::profile::NAV_STACK_FILE);
            let json = nav.to_json().unwrap_or_default();
            tokio::spawn(async move {
                if let Err(e) = tokio::fs::write(&path, json).await {
                    tracing::warn!("导航栈冻结落盘失败（仅 warning）：{e}");
                }
            });
        }
    }

    /// 会话收尾：清端点/驱动引用（保留 nav/backend 供 status 展示）。
    fn clear_session_state(&self) {
        let mut g = self.lock();
        g.endpoint = None;
        g.stop_tx = None;
        g.driver = None;
        g.last_pid = None;
        g.intentional = false;
        // G-9：会话句柄随会话结束清空（避免向已死会话重复发 Browser.close）
        g.close_sender = None;
    }

    /// 当前报告快照。
    fn current_report(&self) -> LaunchReport {
        let g = self.lock();
        LaunchReport {
            backend: g.backend.clone().expect("驱动任务内后端必已解析"),
            profile_dir: g.profile_dir.clone().unwrap_or_default(),
            state: g.machine.state(),
        }
    }
}

impl Drop for BrowserManager {
    /// Drop 兜底（§6.2）：同步杀树（不依赖 async 运行时）。
    ///
    /// 评审 F6（31-评审-接线与集成）：旧实现 `try_lock` 失败即静默跳过杀树，
    /// 应用退出时浏览器进程泄漏。锁纪律（B8）保证 std Mutex 持锁区间仅同步
    /// 操作（微秒级），`try_lock` 失败仅发生在极端竞争短窗——短窗重试仍失败
    /// 则 spawn 阻塞兜底线程收尸（锁释放后立即 kill_sync），绝不放任泄漏。
    /// 评审 F1 加固：两条路径均在**锁内仅取 pid**、释放锁后再 kill_sync——
    /// kill_sync 含子进程调用（taskkill）与 2s 回收等待，不得持锁执行
    /// （极端下 taskkill 挂起会冻结全管理器/驱动）。
    fn drop(&mut self) {
        let kill = |pid: u32| {
            new_killer().kill_sync(pid);
        };
        if let Ok(g) = self.inner.try_lock() {
            if let Some(pid) = g.last_pid {
                drop(g);
                kill(pid);
            }
            return;
        }
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            // 锁纪律 B8：持锁区间仅同步操作（取 pid），杀树在锁外执行
            let pid = inner.lock().unwrap_or_else(|p| p.into_inner()).last_pid;
            if let Some(pid) = pid {
                kill(pid);
            }
        });
    }
}

/// 退出状态 → 崩溃原因分类（§6.5：0 视为 Unknown / 21 profile 冲突 / 其他常规崩溃）。
fn classify_exit(status: &std::process::ExitStatus) -> CrashReason {
    match status.code() {
        Some(0) => CrashReason::Unknown,
        Some(21) => CrashReason::ProcessExit(21),
        Some(other) => CrashReason::ProcessExit(other),
        None => CrashReason::Unknown,
    }
}

/// 提取 panic 载荷文本（&str / String / 其他载荷 → 兜底描述；M5 诊断面）。
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "未知 panic 载荷".to_string()
    }
}

/// 杀进程树（失败仅告警）：杀树是停止/启动失败路径的最后兜底，失败不能改变
/// 停止语义（状态机仍须收敛），但必须留痕——否则「停止成功」而进程仍存活将
/// 无从诊断（platform::ProcessTreeKiller::kill_tree 契约要求调用方记 warning）。
fn kill_tree_logged(killer: &mut dyn crate::browser::platform::ProcessTreeKiller, scene: &str) {
    if let Err(e) = killer.kill_tree() {
        tracing::warn!("杀进程树失败（{scene}）：{e}");
    }
}

/// 启动失败路径收尸：杀树 + 有界等待进程退出（2s，超时仅告警——调用方已
/// 决定返回启动错误，收尸结果不改变结论，但超时说明进程可能残留）。
async fn kill_tree_and_reap(
    killer: &mut Box<dyn crate::browser::platform::ProcessTreeKiller>,
    child: &mut tokio::process::Child,
    scene: &str,
) {
    kill_tree_logged(killer.as_mut(), scene);
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(Ok(_status)) => {}
        Ok(Err(e)) => tracing::warn!("收尸读取退出状态失败（{scene}）：{e}"),
        Err(_) => tracing::warn!("收尸超时（{scene}）：2s 内进程未退出，可能残留"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 事件面零端点：StateChanged Debug 不含端口/路径片段（§7.3 回归）。
    #[test]
    fn endpoint_never_in_events() {
        let ev = ProcessEvent::StateChanged {
            state: BrowserState::Running,
            restarts: 0,
            backend: Some(BackendResolution {
                backend: crate::browser::discover::Backend::SystemChrome {
                    path: PathBuf::from("C:\\secret\\chrome.exe"),
                },
                probes: vec![],
            }),
            error: None,
        };
        let debug = format!("{ev:?}");
        assert!(!debug.contains("38689"));
        assert!(!debug.contains("/devtools/"));
        assert!(!debug.contains("secret"));
        // status 也不含端点
        let status = BrowserStatus {
            state: BrowserState::Running,
            restarts: 0,
            backend: Some("SystemChrome".into()),
            last_error: None,
            nav_tabs: 1,
        };
        assert!(!format!("{status:?}").contains("ws://"));
    }

    // —— G-9：优雅停止先发 Browser.close（发送面单元测试，跨平台可跑）——

    /// G-9 测试假发送器：记录调用序列 + 可控副作用——`exit_flag` 写入 close
    /// 标志文件（触发假浏览器脚本自然退出）、`fail` 注入发送失败。
    #[derive(Clone, Default)]
    struct RecordingClose {
        calls: Arc<Mutex<Vec<&'static str>>>,
        exit_flag: Option<PathBuf>,
        fail: bool,
    }

    impl RecordingClose {
        fn recorded(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap_or_else(|p| p.into_inner()).clone()
        }
    }

    #[async_trait]
    impl BrowserCloseSender for RecordingClose {
        async fn send_browser_close(&self) -> Result<(), crate::cdp::error::CdpError> {
            self.calls
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(crate::cdp::domains::names::BROWSER_CLOSE);
            if let Some(flag) = &self.exit_flag {
                let _ = tokio::fs::write(flag, "close").await;
            }
            if self.fail {
                return Err(crate::cdp::error::CdpError::Internal {
                    method: Some(crate::cdp::domains::names::BROWSER_CLOSE.to_string()),
                    message: "测试注入：发送失败".to_string(),
                });
            }
            Ok(())
        }
    }

    /// G-9：登记发送面后，优雅停止的发送步骤发出 `Browser.close`（命令序列）。
    #[tokio::test]
    async fn graceful_close_sender_emits_browser_close() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mgr = BrowserManager::new(dir.path());
        let recorder = Arc::new(RecordingClose::default());
        mgr.register_close_sender(recorder.clone());
        mgr.send_browser_close_gracefully().await;
        assert_eq!(
            recorder.recorded(),
            vec![crate::cdp::domains::names::BROWSER_CLOSE],
            "优雅停止必须先发 Browser.close"
        );
    }

    /// G-9：无会话登记 → 发送步骤直接返回（既有兜底语义，不 panic）。
    #[tokio::test]
    async fn graceful_close_sender_absent_is_noop() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mgr = BrowserManager::new(dir.path());
        mgr.send_browser_close_gracefully().await;
    }

    /// G-9：发送失败（无连接/拒绝）→ 静默容忍，不 panic、不阻塞停止收敛。
    #[tokio::test]
    async fn graceful_close_sender_failure_tolerated() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mgr = BrowserManager::new(dir.path());
        let recorder = Arc::new(RecordingClose {
            fail: true,
            ..Default::default()
        });
        mgr.register_close_sender(recorder.clone());
        mgr.send_browser_close_gracefully().await;
        assert_eq!(
            recorder.recorded(),
            vec![crate::cdp::domains::names::BROWSER_CLOSE]
        );
    }

    /// G-9：登记 → 清空 → 不再发送（会话结束路径不向已死会话重复发送）。
    #[tokio::test]
    async fn close_sender_register_clear_cycle() {
        let dir = tempfile::tempdir().expect("临时目录");
        let mgr = BrowserManager::new(dir.path());
        let recorder = Arc::new(RecordingClose::default());
        mgr.register_close_sender(recorder.clone());
        mgr.clear_close_sender();
        mgr.send_browser_close_gracefully().await;
        assert!(
            recorder.recorded().is_empty(),
            "清空后不得再发 Browser.close"
        );
    }

    /// 假浏览器 .bat harness 生命周期测试（32 评审 P1-1 修复）：
    /// 全部用例依赖 `.bat`/cmd 语义假浏览器脚本（写 DevToolsActivePort、
    /// `ping -n 2` 计时循环），ubuntu 中层 CI（`cargo test --workspace`）的
    /// unix spawn 直接 exec 无 shebang 文件必失败——整组 `#[cfg(windows)]`
    /// 门控（ubuntu 不编译不收集）。与 platform/windows.rs 已门控的
    /// `job_kill_tree_terminates`（杀树原语层，windows.rs:284-286）不重复：
    /// 本组覆盖 BrowserManager 生命周期调度面（start/stop/崩溃自愈/双启竞态）。
    #[cfg(windows)]
    mod harness {
        use super::*;
        use crate::browser::profile::browser_root;

        /// 快速 tuning（测试用）。
        fn fast_tuning() -> LaunchTuning {
            LaunchTuning {
                poll_interval: Duration::from_millis(20),
                poll_timeout: Duration::from_secs(3),
                launch_retry_delay: Duration::from_millis(30),
                crash_backoff: Duration::from_millis(60),
                crash_window: Duration::from_secs(30),
                crash_max_restarts: 3,
                wait_or_kill: Duration::from_millis(300),
            }
        }

        /// 测试数据根 + 管理器（含空格路径守卫：.bat 假浏览器参数解析不兼容空格）。
        struct Harness {
            dir: tempfile::TempDir,
            manager: BrowserManager,
        }

        impl Harness {
            fn new() -> Option<Self> {
                let dir = tempfile::tempdir().expect("临时目录");
                if dir.path().to_string_lossy().contains(' ') {
                    // 32 评审 F6（P2-7）：%TEMP% 含空格（如用户名含空格）时 .bat 假
                    // 浏览器参数解析不兼容——显式报告跳过原因，避免覆盖静默丢失
                    eprintln!(
                        "跳过 .bat harness 测试：临时目录路径含空格（{}）",
                        dir.path().display()
                    );
                    return None;
                }
                Some(Harness {
                    manager: BrowserManager::with_tuning(dir.path().to_path_buf(), fast_tuning()),
                    dir,
                })
            }

            /// 放置 CfT 缓存假二进制（仅满足 discover 命中，实际 spawn 走 binary_override）。
            fn fake_cft_binary(&self) {
                let root = browser_root(self.dir.path());
                let dir = root.join("browsers").join("chrome-151.0.7922.77");
                std::fs::create_dir_all(&dir).expect("缓存目录");
                let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
                let bin = dir.join(rel);
                std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
                std::fs::write(bin, b"placeholder").expect("写入假二进制占位");
            }

            /// 写入假浏览器 .bat 脚本（spawn 经 LaunchConfig.binary_override 注入）。
            fn fake_browser(&self, script: &str) -> PathBuf {
                let p = self.dir.path().join("fake-browser.bat");
                std::fs::write(&p, script).expect("写入假浏览器脚本");
                p
            }

            /// 标准测试配置：CfT 缓存（discover 命中）+ 假浏览器脚本（spawn 注入）。
            fn config(&self, script: &str) -> LaunchConfig {
                self.fake_cft_binary();
                LaunchConfig {
                    binary_override: Some(self.fake_browser(script)),
                    ..Default::default()
                }
            }
        }

        /// 假浏览器脚本：写 DevToolsActivePort 后常驻（正常启动）。
        /// 注意：Rust 传给 cmd 的参数带引号（`"--user-data-dir=C:\..."` 单 token），
        /// 手动调用时可能不带引号（`=` 被 for 拆成两 token）；`%%~a` 去引号 +
        /// 双形态解析（前缀匹配 / NEXT 取下一 token）兜底两种传参。
        fn script_ok() -> String {
            "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         :loop\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         goto loop\r\n"
                .to_string()
        }

        /// 假浏览器脚本：写端口后约 1s 崩溃退出（退出码 1）。
        fn script_crash() -> String {
            "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         exit /b 1\r\n"
                .to_string()
        }

        /// 假浏览器脚本：立即退出（提前退出诊断）。
        fn script_early_exit() -> String {
            "@echo off\r\nexit /b 7\r\n".to_string()
        }

        /// 事件流采集：订阅并收集指定数量的 StateChanged 状态序列。
        async fn collect_states(
            rx: &mut broadcast::Receiver<ProcessEvent>,
            count: usize,
        ) -> Vec<BrowserState> {
            let mut out = Vec::new();
            let deadline = std::time::Instant::now() + Duration::from_secs(25);
            while out.len() < count {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                let ev = tokio::time::timeout(remaining, rx.recv())
                    .await
                    .expect("等待事件超时")
                    .expect("通道关闭");
                if let ProcessEvent::StateChanged { state, .. } = ev {
                    out.push(state);
                }
            }
            out
        }

        /// 完整生命周期：Stopped→Launching→Running→Stopping→Stopped（事件序断言）。
        #[tokio::test]
        async fn full_cycle_transitions() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let mut rx = mgr.subscribe();
            let report = mgr.start(cfg).await.expect("启动");
            assert!(matches!(report.state, BrowserState::Running));
            assert!(report.profile_dir.exists());
            let states = collect_states(&mut rx, 2).await;
            assert!(matches!(states[0], BrowserState::Launching { attempt: 1 }));
            assert!(matches!(states[1], BrowserState::Running));
            // 端点私有通道可用（不进报告/事件）
            let ep = mgr.endpoint().expect("端点应就绪");
            assert_eq!(ep.port, 38689);
            // 停止
            let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert!(!report.profile_dir.exists(), "会话结束直删 profile");
            let tail = collect_states(&mut rx, 2).await;
            assert!(matches!(tail[0], BrowserState::Stopping { graceful: true }));
            assert!(matches!(tail[1], BrowserState::Stopped));
        }

        /// 启动重试耗尽 → GiveUp + LaunchEarlyExit（§6.2 第 4 行 + §6.5 诊断）。
        #[tokio::test]
        async fn launch_retry_then_fail() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_early_exit());
            let mgr = h.manager.clone();
            let mut rx = mgr.subscribe();
            let err = mgr.start(cfg).await.expect_err("3 次重试后必须失败");
            match err {
                ProcessError::LaunchEarlyExit { exit_code: 7, .. } => {}
                other => panic!("应为 LaunchEarlyExit(7)，实际：{other:?}"),
            }
            // 事件序：Launching{1} → Launching{2} → Launching{3} → Stopped
            let states = collect_states(&mut rx, 4).await;
            assert!(matches!(states[0], BrowserState::Launching { attempt: 1 }));
            assert!(matches!(states[1], BrowserState::Launching { attempt: 2 }));
            assert!(matches!(states[2], BrowserState::Launching { attempt: 3 }));
            assert!(matches!(states[3], BrowserState::Stopped));
            assert_eq!(mgr.status().state, BrowserState::Stopped);
        }

        /// 崩溃自愈：Running → 崩溃 → 重启 → Running（NavStack 保留，profile 未删）。
        #[tokio::test]
        async fn crash_restart_preserves_nav() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_crash());
            let mgr = h.manager.clone();
            let mut rx = mgr.subscribe();
            let report = mgr.start(cfg).await.expect("启动");
            let profile_dir = report.profile_dir.clone();
            // 注入导航栈（模拟维度 11 回写）
            let mut nav = NavStack::new();
            nav.push(url::Url::parse("https://a.example").unwrap(), false);
            nav.push(url::Url::parse("https://b.example").unwrap(), true);
            nav.set_active(1);
            mgr.set_nav(nav.clone());
            // 事件序：Launching{1} → Running → Launching{1}(重启) → Running(restarts=1)
            let states = collect_states(&mut rx, 4).await;
            assert!(
                matches!(states[2], BrowserState::Launching { attempt: 1 }),
                "{states:?}"
            );
            assert!(matches!(states[3], BrowserState::Running), "{states:?}");
            // 重启后导航栈保留（U-7：快照由本模块保留，恢复编排归维度 15）
            assert_eq!(mgr.nav_stack(), nav, "崩溃重启必须保留导航栈");
            assert_eq!(mgr.status().restarts, 1);
            assert!(profile_dir.exists(), "崩溃重启复用 profile，不删除");
            // 停止收尾
            mgr.stop(StopReason::Force).await.expect("停止");
            assert!(!profile_dir.exists(), "停止后直删");
        }

        /// 崩溃循环：30s 窗口内 3 次重启上限 → CrashLoopDetected 终态（保留 profile）。
        #[tokio::test]
        async fn crash_loop_aborts_after_3() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_crash());
            let mgr = h.manager.clone();
            let mut rx = mgr.subscribe();
            let report = mgr.start(cfg).await.expect("启动");
            let profile_dir = report.profile_dir.clone();
            // 等终态：4 次崩溃 → CrashAbort → Stopped + CrashLoopDetected
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                let ev = tokio::time::timeout(remaining, rx.recv())
                    .await
                    .expect("等待终态超时")
                    .expect("通道关闭");
                if let ProcessEvent::StateChanged {
                    state: BrowserState::Stopped,
                    error: Some(e),
                    ..
                } = ev
                {
                    assert!(e.contains("崩溃重启超限"), "{e}");
                    break;
                }
            }
            assert_eq!(mgr.status().state, BrowserState::Stopped);
            assert!(
                profile_dir.exists(),
                "崩溃放弃保留导航栈数据（§6.2），停止时才清理"
            );
            // 停止（清理遗留 profile）
            mgr.stop(StopReason::Graceful).await.expect("停止");
            assert!(!profile_dir.exists(), "停止后清理");
        }

        /// 假浏览器脚本：写 DevToolsActivePort 后约 1s 自行退出（退出码 0）。
        /// 用于回归：优雅停止窗口内进程自然退出（wait_task 分支先到）。
        fn script_self_exit() -> String {
            "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         exit /b 0\r\n"
                .to_string()
        }

        /// 假浏览器脚本：写 DevToolsActivePort 后循环检查 close 标志文件，出现
        /// 即退出（退出码 0）。G-9 回归：Browser.close 发送后进程自然退出的
        /// 可观测路径（.bat 轮询粒度 ~1s，等待窗口须大于一轮轮询）。
        fn script_close_exit() -> String {
            "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         :loop\r\n\
         if exist \"!PROFILE!\\close-flag\" exit /b 0\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         goto loop\r\n"
                .to_string()
        }

        /// 回归（联调 E5 根因）：优雅停止窗口内进程**自行退出**（wait_task 分支先到）
        /// 时不得二次 poll 已完成的 JoinHandle——tokio 对已完成句柄的再次 poll 直接
        /// panic「JoinHandle polled after completion」，旧实现导致驱动任务崩溃、
        /// 状态卡在 Stopping。wait_or_kill 放大到 5s 确保 wait_task（~1s）先到。
        #[tokio::test]
        async fn graceful_stop_waits_natural_exit_without_double_poll() {
            let Some(h) = Harness::new() else { return };
            let root = tempfile::tempdir().expect("临时目录");
            // CfT 缓存假二进制（discover 命中，root 与管理器同源）
            let cache_dir = root.path().join("browsers").join("chrome-151.0.7922.77");
            std::fs::create_dir_all(&cache_dir).expect("缓存目录");
            let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
            let bin = cache_dir.join(rel);
            std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
            std::fs::write(bin, b"placeholder").expect("写入占位");
            let tuning = LaunchTuning {
                wait_or_kill: Duration::from_secs(5),
                ..fast_tuning()
            };
            let mgr = BrowserManager::with_tuning(root.path().to_path_buf(), tuning);
            let cfg = LaunchConfig {
                binary_override: Some(h.fake_browser(&script_self_exit())),
                ..Default::default()
            };
            let report = mgr.start(cfg).await.expect("启动");
            // 立即优雅停止：进程在 wait_or_kill(5s) 窗口内自行退出（~1s）
            let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
            assert!(
                matches!(stop.state, BrowserState::Stopped),
                "进程自然退出后应收敛 Stopped（不得卡 Stopping）：{:?}",
                stop.state
            );
            assert!(!stop.force_killed, "自然退出不应走杀树兜底");
            assert!(!report.profile_dir.exists(), "停止后直删");
        }

        /// 优雅停止超时 → 杀树（wait_or_kill 注入 300ms；§6.3 第 2 步）。
        #[tokio::test]
        async fn graceful_stop_timeout_force_kills() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let report = mgr.start(cfg).await.expect("启动");
            let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
            // 假浏览器永不退出 → wait_or_kill 超时 → 杀树兜底
            assert!(stop.force_killed, "优雅等待超时必须走杀树：{stop:?}");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert!(stop.profile_removed);
            assert!(!report.profile_dir.exists(), "停止后直删");
        }

        // —— G-9：优雅停止先发 Browser.close 的完整停止路径（.bat harness）——

        /// G-9：Graceful 停止先发 `Browser.close` → 假浏览器收到标志后自然退出 →
        /// 不杀树。wait_or_kill 放大到 5s：.bat 轮询粒度 ~1s，等待窗口须覆盖
        /// 一轮以上轮询。
        #[tokio::test]
        async fn graceful_stop_sends_close_then_natural_exit() {
            let Some(h) = Harness::new() else { return };
            let root = tempfile::tempdir().expect("临时目录");
            // CfT 缓存假二进制（discover 命中，root 与管理器同源）
            let cache_dir = root.path().join("browsers").join("chrome-151.0.7922.77");
            std::fs::create_dir_all(&cache_dir).expect("缓存目录");
            let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
            let bin = cache_dir.join(rel);
            std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
            std::fs::write(bin, b"placeholder").expect("写入占位");
            let tuning = LaunchTuning {
                wait_or_kill: Duration::from_secs(5),
                ..fast_tuning()
            };
            let mgr = BrowserManager::with_tuning(root.path().to_path_buf(), tuning);
            let cfg = LaunchConfig {
                binary_override: Some(h.fake_browser(&script_close_exit())),
                ..Default::default()
            };
            let report = mgr.start(cfg).await.expect("启动");
            // 登记发送面：发送 Browser.close 时写 close 标志（触发假浏览器自然退出）
            let recorder = Arc::new(RecordingClose {
                exit_flag: Some(report.profile_dir.join("close-flag")),
                ..Default::default()
            });
            mgr.register_close_sender(recorder.clone());
            let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
            assert_eq!(
                recorder.recorded(),
                vec![crate::cdp::domains::names::BROWSER_CLOSE],
                "Graceful 停止必须先发 Browser.close"
            );
            assert!(
                matches!(stop.state, BrowserState::Stopped),
                "自然退出后应收敛 Stopped：{:?}",
                stop.state
            );
            assert!(!stop.force_killed, "Browser.close 后自然退出不应杀树");
            assert!(!report.profile_dir.exists(), "停止后直删");
        }

        /// G-9：`Browser.close` 发出后进程不退出 → wait_or_kill 超时仍杀树兜底。
        #[tokio::test]
        async fn graceful_stop_close_timeout_still_force_kills() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_close_exit());
            let mgr = h.manager.clone();
            let report = mgr.start(cfg).await.expect("启动");
            // 只记录不写标志：close 发出后假浏览器仍常驻 → 超时杀树
            let recorder = Arc::new(RecordingClose::default());
            mgr.register_close_sender(recorder.clone());
            let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
            assert_eq!(
                recorder.recorded(),
                vec![crate::cdp::domains::names::BROWSER_CLOSE],
                "必须先发 Browser.close 再进入等待窗口"
            );
            assert!(stop.force_killed, "close 后超时仍须杀树兜底：{stop:?}");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert!(!report.profile_dir.exists(), "停止后直删");
        }

        /// G-9：无会话登记 → 保持既有语义——不发 Browser.close，wait_or_kill
        /// 超时杀树（graceful_stop_timeout_force_kills 的无会话显式化）。
        #[tokio::test]
        async fn graceful_stop_no_session_falls_back_to_kill() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let report = mgr.start(cfg).await.expect("启动");
            let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
            assert!(stop.force_killed, "无会话：wait_or_kill 超时杀树：{stop:?}");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert!(!report.profile_dir.exists(), "停止后直删");
        }

        /// G-9：`Browser.close` 发送失败（无连接/拒绝）→ 不 panic，直接走既有
        /// wait_or_kill 超时杀树兜底。
        #[tokio::test]
        async fn graceful_stop_close_send_failure_falls_back() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let report = mgr.start(cfg).await.expect("启动");
            let recorder = Arc::new(RecordingClose {
                fail: true,
                ..Default::default()
            });
            mgr.register_close_sender(recorder.clone());
            let stop = mgr
                .stop(StopReason::Graceful)
                .await
                .expect("发送失败不得 panic/挂死");
            assert_eq!(
                recorder.recorded(),
                vec![crate::cdp::domains::names::BROWSER_CLOSE]
            );
            assert!(stop.force_killed, "发送失败走既有超时杀树兜底：{stop:?}");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert!(!report.profile_dir.exists(), "停止后直删");
        }

        /// G-9：强制停止不发 `Browser.close`（直接杀树语义不变）。
        #[tokio::test]
        async fn force_stop_does_not_send_browser_close() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let _ = mgr.start(cfg).await.expect("启动");
            let recorder = Arc::new(RecordingClose::default());
            mgr.register_close_sender(recorder.clone());
            let stop = mgr.stop(StopReason::Force).await.expect("停止");
            assert!(stop.force_killed);
            assert!(
                recorder.recorded().is_empty(),
                "强制停止不得发 Browser.close"
            );
        }

        /// start 幂等（§4.5）：Running 中重复 start 返回当前快照，不重复 spawn。
        #[tokio::test]
        async fn start_idempotent() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let first = mgr.start(cfg.clone()).await.expect("首次启动");
            let second = mgr.start(cfg).await.expect("幂等启动");
            assert_eq!(second.profile_dir, first.profile_dir);
            assert!(matches!(second.state, BrowserState::Running));
            mgr.stop(StopReason::Force).await.expect("停止");
        }

        /// 停止报告与状态一致性。
        #[tokio::test]
        async fn stop_report_consistent() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let _ = mgr.start(cfg).await.expect("启动");
            let stop = mgr.stop(StopReason::Force).await.expect("停止");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert_eq!(mgr.status().state, BrowserState::Stopped);
        }

        /// 受管 profile：启动后停止不删除（用户资产保留；删除经 trash，维度 16）。
        #[tokio::test]
        async fn managed_profile_kept_on_stop() {
            let Some(h) = Harness::new() else { return };
            // 源 profile fixture
            let src_root = h.dir.path().join("src-user-data");
            std::fs::create_dir_all(src_root.join("Default")).expect("目录");
            std::fs::write(src_root.join("Local State"), b"{}").expect("写入");
            std::fs::write(src_root.join("Default").join("Preferences"), b"pref").expect("写入");
            let cfg = LaunchConfig {
                profile: ProfileSpec::Imported {
                    source_user_data: src_root,
                    source_profile: "Default".to_string(),
                    profile_name: "我的Profile".to_string(),
                },
                binary_override: Some(h.fake_browser(&script_ok())),
                ..Default::default()
            };
            h.fake_cft_binary();
            let mgr = h.manager.clone();
            let report = mgr.start(cfg).await.expect("启动");
            assert!(report.profile_dir.exists());
            assert!(report.profile_dir.join("Preferences").is_file());
            let managed = report.profile_dir.clone();
            let stop = mgr.stop(StopReason::Force).await.expect("停止");
            assert!(!stop.profile_removed, "受管 profile 不随会话直删");
            assert!(
                managed.exists(),
                "受管 profile 停止后保留（删除经 trash，维度 16）"
            );
            // trash 清理验证（模拟维度 16 流程）
            let trash = h.dir.path().join("trash");
            crate::browser::profile::trash_managed(&managed, &trash).expect("入回收站");
            assert!(!managed.exists());
        }

        /// 评审 F1 加固（32 评审 F1 高 flake 清单）：进程存活探测以「PID + 创建
        /// 时间 + 退出码」三因子判定——taskkill 成功后进程对象可能因句柄未关而
        /// 短暂存留（OpenProcess 仍可成功），退出码区分「仍在运行（STILL_ACTIVE）」
        /// 与「已终止待回收」；创建时间排除 PID 复用误判（驱动自愈不断派生新进程）。
        #[allow(unsafe_code)]
        fn process_creation_time(pid: u32) -> Option<u64> {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            // SAFETY：OpenProcess/GetProcessTimes/CloseHandle 标准 API；句柄用完
            // 即关；取不到（进程已消失/权限拒绝）一律返回 None，错误路径不 panic
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return None;
                }
                let mut created = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
                let mut exit = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
                let mut kernel = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
                let mut user = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
                let ok =
                    GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0;
                CloseHandle(handle);
                if !ok {
                    return None;
                }
                Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
            }
        }

        /// 进程状态探测：None = 进程对象已消失；Some(StillRunning) = 正在运行；
        /// Some(Terminated(code)) = 已终止但对象未回收（句柄存留）。
        #[allow(unsafe_code)]
        fn process_state(pid: u32) -> Option<Result<u32, ()>> {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            // SAFETY：标准 API；句柄用完即关；错误路径不 panic
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return None;
                }
                let mut code: u32 = 0;
                let ok = GetExitCodeProcess(handle, &mut code) != 0;
                CloseHandle(handle);
                if !ok {
                    return None;
                }
                if code == 259 {
                    Some(Err(())) // STILL_ACTIVE
                } else {
                    Some(Ok(code))
                }
            }
        }

        /// 评审 F6 回归（31-评审-接线与集成）：Drop 时 inner 锁被其他线程持有
        /// （try_lock 失败短窗）——旧实现静默跳过杀树导致浏览器进程泄漏；现实现
        /// spawn 阻塞兜底线程收尸（锁释放后立即 kill_sync）。预占锁后 Drop 管理器，
        /// 释放锁 → 兜底线程收尸 → 进程必须终结。
        ///
        /// 评审 F1 加固：并行 harness 负载下（驱动崩溃自愈持续派生新进程，Windows
        /// PID 分配器复用模式下新进程可能复用刚释放的 PID）纯 PID 存活探测会把
        /// 复用进程误判为原进程仍存活（窗口放大反而提高误判率）——改用「创建
        /// 时间 + 退出码」三因子判定：创建时间不一致 = PID 已复用（原进程已死）；
        /// GetExitCodeProcess 区分 STILL_ACTIVE（仍在运行）与已终止待回收对象。
        #[tokio::test]
        async fn drop_kills_via_fallback_when_inner_locked() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            let _ = mgr.start(cfg).await.expect("启动");
            let pid = mgr
                .inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .last_pid
                .expect("启动后必有 pid");
            // 记录原进程创建时间（PID 复用判定基准）
            let creation = process_creation_time(pid).expect("启动后进程必存在");
            // 预占锁：模拟极端竞争窗口（其他线程持锁期间 Drop 发生）
            let held = Arc::clone(&mgr.inner);
            let guard = held.lock().unwrap_or_else(|p| p.into_inner());
            drop(mgr); // try_lock 失败 → spawn 兜底线程
            drop(guard); // 释放锁 → 兜底线程收尸
                         // 轮询等待进程终结（kill_sync 内部已带 2s 回收等待；轮询兜底调度竞态；
                         // 窗口 25s：并行 harness 负载下 taskkill 排队可致单点等待超时，32 评审
                         // F1/F2 窗口放大建议）。判定：仅当「创建时间一致且 STILL_ACTIVE」
                         // 才视为原进程仍在——排除 PID 复用与已终止对象存留两种误判。
            let deadline = std::time::Instant::now() + Duration::from_secs(25);
            while std::time::Instant::now() < deadline {
                let alive = process_creation_time(pid).is_some_and(|t| t == creation)
                    && process_state(pid) == Some(Err(()));
                if !alive {
                    // 收尾：显式停止（driver 可能已把被杀判定为崩溃并重启新进程，
                    // stop(Force) 置意图让驱动收敛，防测试残留僵尸进程）
                    let _ = h.manager.stop(StopReason::Force).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            panic!("Drop 兜底杀树未生效（PID {pid} 仍存活）");
        }

        /// 回归（F6 修复暴露的停止信号竞态）：崩溃自愈的 relaunch 窗口内调用
        /// stop() 必须收敛——旧实现 watch 信号发往无接收者的旧通道即丢失（驱动
        /// 处于退避/重启/启动轮询中，新 stop_rx 未挂接），驱动永不收敛、
        /// stop() 永久挂死（drop_kills 测试实测 90s+）；现实现 PortReady 后
        /// 复查 pending_stop，stop() 有界返回（本用例任意交错时序均收敛，
        /// 未修复实现下 10s 超时即失败）。
        #[tokio::test]
        async fn stop_during_crash_relaunch_converges() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_crash());
            let mgr = h.manager.clone();
            let mut rx = mgr.subscribe();
            let _ = mgr.start(cfg).await.expect("启动");
            // 等首个 CrashRestarting 事件（崩溃已检测，驱动进入退避/重启窗口）
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                let ev = tokio::time::timeout(remaining, rx.recv())
                    .await
                    .expect("等待崩溃事件超时")
                    .expect("通道关闭");
                if matches!(ev, ProcessEvent::CrashRestarting { .. }) {
                    break;
                }
            }
            // 略过退避（60ms），让 stop() 落在 launch_with_retries 的 relaunch 窗口
            tokio::time::sleep(Duration::from_millis(150)).await;
            // 修复语义：stop() 有界收敛（旧实现此窗口内停止信号丢失 → 永久挂死）
            let stop = tokio::time::timeout(Duration::from_secs(10), mgr.stop(StopReason::Force))
                .await
                .expect("stop() 必须在 relaunch 窗口内有界收敛（停止信号不得丢失）")
                .expect("停止失败");
            assert!(matches!(stop.state, BrowserState::Stopped));
            assert_eq!(mgr.status().state, BrowserState::Stopped);
        }

        /// 等待终态事件（Stopped + error 含 "panic"；M5 回归共用，事件等待替代
        /// 裸 sleep——事件由 on_driver_panic 在全部收敛动作完成后广播，收到即
        /// 一切就绪，无竞态）。
        async fn wait_terminal_panic_event(rx: &mut broadcast::Receiver<ProcessEvent>) -> String {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let ev = rx.recv().await.expect("通道关闭");
                    if let ProcessEvent::StateChanged {
                        state: BrowserState::Stopped,
                        error: Some(e),
                        ..
                    } = ev
                    {
                        return e;
                    }
                }
            })
            .await
            .expect("等待终态事件超时（驱动 panic 未广播终态）")
        }

        /// M5 回归（评审 29 §M5）：驱动任务**启动路径** panic（PreReady 注入）。
        /// 旧实现：panic 后状态卡死非 Stopped、driver 句柄残留、stop() 报告错误
        /// 状态、后续 start() 幂等分支永久返回陈旧报告。新实现（catch_unwind
        /// 外包）：状态可达终态 Stopped、终态事件已广播（error 带 panic 原因）、
        /// stop() 有界收敛（10s 超时上限，旧实现此场景 stop() 挂死）、后续
        /// start() 可重新启动（可恢复性）。
        #[tokio::test]
        async fn driver_panic_before_ready_converges_and_recovers() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            mgr.inject_driver_panic(DriverPanicPoint::PreReady);
            let mut rx = mgr.subscribe();
            // first_tx 随 panic unwind 丢弃 → 通道断开 → start() 返回内部错误
            let err = mgr
                .start(cfg.clone())
                .await
                .expect_err("驱动 panic 后 start() 必须返回错误");
            assert!(matches!(err, ProcessError::Internal(_)), "{err:?}");
            // 终态事件已广播（reason=panic）
            let terminal = wait_terminal_panic_event(&mut rx).await;
            assert!(
                terminal.contains("panic"),
                "终态事件必须带 panic 原因：{terminal}"
            );
            // 状态可达终态
            assert_eq!(mgr.status().state, BrowserState::Stopped);
            // stop() 有界收敛（驱动句柄已清，不得永久 await）
            let stop = tokio::time::timeout(Duration::from_secs(10), mgr.stop(StopReason::Force))
                .await
                .expect("stop() 必须在驱动 panic 后有界收敛（不得永久 await）")
                .expect("停止失败");
            assert!(matches!(stop.state, BrowserState::Stopped));
            // 可恢复性：panic 收敛后重新启动成功
            let report = mgr.start(cfg).await.expect("驱动 panic 后必须可重新启动");
            assert!(matches!(report.state, BrowserState::Running));
            mgr.stop(StopReason::Force).await.expect("停止");
        }

        /// M5 回归（评审 29 §M5）：驱动任务**运行期** panic（PostReady 注入）。
        /// 此刻浏览器进程已派生（假浏览器常驻）、endpoint/last_pid/stop_tx 全部
        /// 就绪：panic 后必须 ① 兜底杀树（驱动栈 killer 已随 unwind 丢失，按
        /// last_pid 终结，防孤儿进程泄漏）② 端点/句柄清理 ③ 终态收敛 + 广播
        /// ④ 可重新启动。进程终结判定复用 F1 三因子（创建时间 + STILL_ACTIVE），
        /// 排除并行负载下 PID 复用误判；进程对象已回收（创建时间不可见）视为
        /// 已终结。
        #[tokio::test]
        async fn driver_panic_after_ready_converges_and_kills() {
            let Some(h) = Harness::new() else { return };
            let cfg = h.config(&script_ok());
            let mgr = h.manager.clone();
            mgr.inject_driver_panic(DriverPanicPoint::PostReady);
            let mut rx = mgr.subscribe();
            // first_tx 先于注入点送达 → start() 正常返回 Running
            let report = mgr
                .start(cfg.clone())
                .await
                .expect("启动（注入点在首启报告送达之后）");
            assert!(matches!(report.state, BrowserState::Running));
            // 终态事件已广播（处理器先杀树→收敛→清残留→再广播，事件到达即就绪）
            let terminal = wait_terminal_panic_event(&mut rx).await;
            assert!(
                terminal.contains("panic"),
                "终态事件必须带 panic 原因：{terminal}"
            );
            // 注入点记录的进程 PID（panic 前落盘，事件到达后读取无竞态）
            let pid = mgr
                .inner
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .panic_probe_pid
                .expect("PostReady 注入必须记录进程 PID");
            // 兜底杀树生效：进程不得仍存活（F1 三因子；已回收视为已终结）
            let creation = process_creation_time(pid);
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let alive = creation.is_some_and(|t| process_creation_time(pid) == Some(t))
                    && process_state(pid) == Some(Err(()));
                if !alive {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "驱动 panic 兜底杀树未生效（PID {pid} 仍存活）"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            // 状态可达终态 + 会话残留清理
            assert_eq!(mgr.status().state, BrowserState::Stopped);
            assert!(
                mgr.endpoint().is_none(),
                "panic 后端点必须清空（私有通道不残留）"
            );
            // stop() 有界收敛（驱动句柄已清，不得永久 await）
            let stop = tokio::time::timeout(Duration::from_secs(10), mgr.stop(StopReason::Force))
                .await
                .expect("stop() 必须在驱动 panic 后有界收敛（不得永久 await）")
                .expect("停止失败");
            assert!(matches!(stop.state, BrowserState::Stopped));
            // 可恢复性：panic 收敛后重新启动成功
            let report2 = mgr.start(cfg).await.expect("驱动 panic 后必须可重新启动");
            assert!(matches!(report2.state, BrowserState::Running));
            mgr.stop(StopReason::Force).await.expect("停止");
        }

        /// 评审 H6 回归（29-评审-代码质量与安全）：并发 start() 只启动一个浏览器
        /// 进程。假浏览器脚本每次被 spawn 向 profile 内追加一行计数（spawn 次数
        /// 可证）；双启竞态（旧实现无临界区互斥）下两个 start() 各自建 profile、
        /// 各自 spawn 驱动 → 计数 2 且 profile 目录不一致，本用例必失败。
        #[tokio::test]
        async fn concurrent_start_spawns_single_process() {
            let Some(h) = Harness::new() else { return };
            let script = "\
@echo off\r\n\
setlocal enabledelayedexpansion\r\n\
set PROFILE=\r\n\
set NEXT=0\r\n\
for %%a in (%*) do (\r\n\
\x20 set \"A=%%~a\"\r\n\
\x20 if \"!NEXT!\"==\"1\" (\r\n\
\x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
\x20\x20 set \"NEXT=0\"\r\n\
\x20 )\r\n\
\x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
\x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
)\r\n\
if not defined PROFILE exit /b 9\r\n\
> \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
>> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
>> \"!PROFILE!\\spawn-count.txt\" echo 1\r\n\
:loop\r\n\
ping -n 2 127.0.0.1 >nul\r\n\
goto loop\r\n";
            let cfg = h.config(script);
            let mgr = h.manager.clone();
            // 两个 start() 并发（tokio::join! 同帧启动，强制竞争临界区）
            let (a, b) = tokio::join!(mgr.start(cfg.clone()), mgr.start(cfg));
            let a = a.expect("并发启动 A 应成功");
            let b = b.expect("并发启动 B 应成功（幂等分支返回当前报告）");
            assert!(
                matches!(
                    b.state,
                    BrowserState::Running | BrowserState::Launching { .. }
                ),
                "幂等报告状态应为运行中/启动中：{:?}",
                b.state
            );
            assert_eq!(
                a.profile_dir, b.profile_dir,
                "并发 start 只允许建一个 profile（双启会各建各的目录）"
            );
            // 计数文件写入晚于 DevToolsActivePort（.bat 顺序写），wait_active_port
            // 在端口文件可见后即返回——并行负载下 .bat 可能被调度打断，计数文件
            // 尚不可读；A3 模式：轮询等待就绪，替代单点断言。
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let count = loop {
                match std::fs::read_to_string(a.profile_dir.join("spawn-count.txt")) {
                    Ok(s) => break s.lines().count(),
                    Err(_) => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "spawn-count.txt 未就绪（启动是否成功？）"
                        );
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                }
            };
            assert_eq!(
                count, 1,
                "并发 start 只允许启动一个浏览器进程（计数 {count}）"
            );
            mgr.stop(StopReason::Force).await.expect("停止");
        }
    } // mod harness（`#[cfg(windows)]` 门控，32 评审 P1-1）
}
