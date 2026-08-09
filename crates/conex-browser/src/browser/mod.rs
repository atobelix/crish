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
use crate::browser::discover::{resolve_backend, BackendOverride, BackendResolution, CandidateProbe, ResolveOptions};
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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot, watch};

/// 孤儿清扫阈值（§4.4：sessions/ 下 mtime 超 24h）。
const ORPHAN_AGE: Duration = Duration::from_secs(24 * 3600);

/// 停止原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// 优雅停止：Browser.close → wait_or_kill(5s) → 杀树兜底（§6.3）。
    Graceful,
    /// 强制停止：直接杀树（§6.2 第 7 行）。
    Force,
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
    fn wait_task(mut self) -> (tokio::task::JoinHandle<Option<std::process::ExitStatus>>, Self) {
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
    last_pid: Option<u32>,
    last_error: Option<String>,
    force_killed: bool,
    stop_elapsed_ms: u64,
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
            last_pid: None,
            last_error: None,
            force_killed: false,
            stop_elapsed_ms: 0,
        }
    }
}

/// 浏览器进程管理器（会话单例，幂等 start；§4.5 引擎内互斥）。
#[derive(Clone)]
pub struct BrowserManager {
    data_root: PathBuf,
    tuning: LaunchTuning,
    events: broadcast::Sender<ProcessEvent>,
    inner: Arc<Mutex<Inner>>,
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
        }
    }

    /// 崩溃预算（窗口/上限来自 tuning）。
    fn budget(&self) -> CrashBudget {
        CrashBudget {
            window: self.tuning.crash_window,
            max_restarts: self.tuning.crash_max_restarts,
        }
    }

    /// 事件订阅（面板/工具层）。
    pub fn subscribe(&self) -> broadcast::Receiver<ProcessEvent> {
        self.events.subscribe()
    }

    /// 事件广播（send 失败即无订阅者，忽略）。
    fn emit(&self, event: ProcessEvent) {
        let _ = self.events.send(event);
    }

    /// 启动（§2/§5/§6.2）：幂等——非 Stopped 直接返回当前快照报告（§4.5）。
    pub async fn start(&self, config: LaunchConfig) -> Result<LaunchReport, ProcessError> {
        let already_running = {
            let g = self.lock();
            !matches!(g.machine.state(), BrowserState::Stopped)
        };
        if already_running {
            return Ok(self.current_report());
        }
        // 孤儿清扫（§4.4：启动时 best-effort）
        let sessions = sessions_root(&self.data_root);
        let _ = sweep_orphans(&sessions, ORPHAN_AGE);
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
        let (profile_dir, token) = self.prepare_profile(&config)?;
        // 3. 状态机入 Launching + 派发驱动任务
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
                mgr.drive_session(config, first_tx).await;
            }));
        }
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
        let driver = {
            let mut g = self.lock();
            if g.driver.is_none() {
                // 无驱动（从未启动/已收敛）：仅清理遗留 profile（崩溃放弃后的残留）
                if let (Some(dir), Some(spec)) = (g.profile_dir.clone(), g.profile_spec.clone()) {
                    if matches!(spec, ProfileSpec::Ephemeral) {
                        let _ = remove_ephemeral(&dir);
                    }
                }
                g.profile_dir = None;
                g.profile_spec = None;
                g.endpoint = None;
                return Ok(StopReport {
                    state: BrowserState::Stopped,
                    force_killed: false,
                    elapsed_ms: 0,
                    profile_removed: true,
                });
            }
            g.intentional = true;
            g.pending_stop = Some(matches!(reason, StopReason::Graceful));
            if let Some(tx) = &g.stop_tx {
                let _ = tx.send(true);
            }
            g.driver.take()
        };
        if let Some(task) = driver {
            let _ = task.await;
        }
        let g = self.lock();
        Ok(StopReport {
            state: g.machine.state(),
            force_killed: g.force_killed,
            elapsed_ms: g.stop_elapsed_ms,
            profile_removed: g.profile_dir.is_none(),
        })
    }

    /// 手动重启入口（崩溃重启由驱动自动完成；本入口供引擎显式触发：
    /// Crashed → 驱动退避中无需干预；Stopped → 用最近配置重新启动）。
    pub async fn restart(&self, _reason: CrashReason) -> Result<(), ProcessError> {
        let config = {
            let g = self.lock();
            match g.machine.state() {
                BrowserState::Crashed { .. } => return Ok(()),
                BrowserState::Stopped => g.last_config.clone(),
                _ => {
                    return Err(ProcessError::Internal(
                        "浏览器运行中，无需重启".to_string(),
                    ))
                }
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
    fn prepare_profile(
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
                                let _ = std::fs::remove_file(dest.join("SingletonLock"));
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
                    )?;
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
        let mut first_tx = Some(first_tx);
        // 导航栈恢复（崩溃重启保留 nav_stack.json 落盘，U-7）
        let profile_dir = self.lock().profile_dir.clone();
        if let Some(dir) = profile_dir {
            if let Ok(Some(nav)) = NavStack::load(&dir.join(crate::browser::profile::NAV_STACK_FILE))
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
                let _ = tx.send(Ok(self.current_report()));
            }
            // —— 运行期：等退出或停止意图 ——
            let (mut wait_task, mut process) = process.wait_task();
            let (stop_tx, mut stop_rx) = watch::channel(false);
            self.lock().stop_tx = Some(stop_tx);
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
                        g.machine.on(
                            StateEvent::RestartTick,
                            Instant::now(),
                            &self.budget(),
                        );
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
                        g.machine.on(
                            StateEvent::LaunchFailed,
                            Instant::now(),
                            &self.budget(),
                        )
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
                                return Err(ProcessError::Internal(
                                    "启动中被停止".to_string(),
                                ));
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
        // attach 失败已内部降级 taskkill（不阻断启动）
        let _ = killer.attach(&mut child);
        let pid = child.id().unwrap_or(0);
        tracing::debug!("浏览器进程已派生（backend={} pid={pid}）", backend.summary());
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
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let line = line.trim_end().to_string();
                            if !line.is_empty() {
                                ring.lock().await.push(line);
                            }
                        }
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
                let _ = killer.kill_tree();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
                Err(ProcessError::LaunchEarlyExit { exit_code, stderr })
            }
            crate::browser::active_port::WaitOutcome::Timeout { stderr } => {
                let _ = killer.kill_tree();
                let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
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
        self.cleanup_profile();
        {
            let mut g = self.lock();
            g.last_error = Some(err_text.clone());
        }
        if let Some(tx) = first_tx.take() {
            let _ = tx.send(Err(err));
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

    /// 停止收尾（§6.3：优雅 → wait_or_kill；超时/强制 → 杀树）+ 清理 profile。
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
            g.machine
                .on(StateEvent::Stop { graceful }, Instant::now(), &self.budget())
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
                    // 优雅路径（§6.3）：MVP 不连 CDP 发 Browser.close（遗留：M1 会话
                    // 接入后在此先 Browser.close 再等退出）；wait_or_kill(5s)
                    exited = tokio::select! {
                        _ = &mut *wait_task => true,
                        _ = tokio::time::sleep(self.tuning.wait_or_kill) => false,
                    };
                    if !exited {
                        let _ = process.killer.kill_tree();
                        force_killed = true;
                    }
                } else {
                    // 强制路径：直接杀树（§6.2 第 7 行）
                    let _ = process.killer.kill_tree();
                    force_killed = true;
                }
                // 收尸（杀树后进程必然退出；wait_task 分支已取走输出时**禁止重复 poll**
                // ——tokio JoinHandle 二次完成 poll 直接 panic「polled after completion」，
                // 联调 E5 根因：真实浏览器 Browser.close 自然退出走 wait_task 分支，
                // 再次 poll 已完成的句柄导致驱动任务崩溃、状态卡在 Stopping）
                if !exited {
                    let _ = tokio::time::timeout(Duration::from_secs(2), &mut *wait_task).await;
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
        self.cleanup_profile();
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
    fn cleanup_profile(&self) {
        let (dir, spec) = {
            let g = self.lock();
            (g.profile_dir.clone(), g.profile_spec.clone())
        };
        match (&dir, &spec) {
            (Some(dir), Some(ProfileSpec::Ephemeral)) => {
                if let Err(e) = remove_ephemeral(dir) {
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
            g.machine
                .on(StateEvent::Stop { graceful: true }, Instant::now(), &self.budget());
        }
        self.cleanup_profile();
        let (restarts, backend) = self.emit_snapshot();
        self.emit(ProcessEvent::StateChanged {
            state: BrowserState::Stopped,
            restarts,
            backend,
            error: Some("启动中被停止".to_string()),
        });
        self.clear_session_state();
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
    fn drop(&mut self) {
        if let Ok(g) = self.inner.try_lock() {
            if let Some(pid) = g.last_pid {
                new_killer().kill_sync(pid);
            }
        }
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

#[cfg(test)]
mod tests {
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
                return None; // .bat 假浏览器参数解析不兼容空格路径，跳过
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
        assert!(matches!(states[2], BrowserState::Launching { attempt: 1 }), "{states:?}");
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
        assert!(profile_dir.exists(), "崩溃放弃保留导航栈数据（§6.2），停止时才清理");
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
        assert!(managed.exists(), "受管 profile 停止后保留（删除经 trash，维度 16）");
        // trash 清理验证（模拟维度 16 流程）
        let trash = h.dir.path().join("trash");
        crate::browser::profile::trash_managed(&managed, &trash).expect("入回收站");
        assert!(!managed.exists());
    }
}
