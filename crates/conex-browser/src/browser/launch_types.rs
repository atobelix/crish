use super::*;

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
pub(super) enum DriverPanicPoint {
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
pub(super) struct ManagedProcess {
    pub(super) child: Option<tokio::process::Child>,
    pub(super) pid: u32,
    pub(super) killer: Box<dyn ProcessTreeKiller>,
}

impl ManagedProcess {
    /// 迁移 child 进后台等待任务，返回 (任务, 剩余句柄)。
    pub(super) fn wait_task(
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
pub(super) struct Inner {
    pub(super) machine: StateMachine,
    pub(super) token: Option<SessionToken>,
    pub(super) profile_dir: Option<PathBuf>,
    pub(super) profile_spec: Option<ProfileSpec>,
    pub(super) backend: Option<BackendResolution>,
    /// 端点仅供维度 11 接续（私有通道），不进事件/日志（§7.3）。
    pub(super) endpoint: Option<CdpEndpoint>,
    pub(super) nav: NavStack,
    pub(super) last_config: Option<LaunchConfig>,
    /// 意图标志（§6.2）：区分「我杀的」与「它崩的」，避免自激重启。
    pub(super) intentional: bool,
    /// 停止模式暂存（stop() 写入，驱动消费）。
    pub(super) pending_stop: Option<bool>,
    pub(super) stop_tx: Option<watch::Sender<bool>>,
    pub(super) driver: Option<tokio::task::JoinHandle<()>>,
    /// M5 测试钩子：驱动内部确定性 panic 注入点（Inner 共享 Arc，触发后自清除，
    /// 见 `maybe_panic_driver`——清除落在共享态上，恢复路径不被污染）。
    #[cfg(test)]
    pub(super) driver_panic_point: Option<DriverPanicPoint>,
    /// M5 测试探针：PostReady 注入时记录的进程 PID（断言兜底杀树用）。
    #[cfg(test)]
    pub(super) panic_probe_pid: Option<u32>,
    pub(super) last_pid: Option<u32>,
    pub(super) last_error: Option<String>,
    pub(super) force_killed: bool,
    pub(super) stop_elapsed_ms: u64,
    /// G-9：优雅停止先发 Browser.close 的发送面（引擎建连后登记；停止路径
    /// 持锁仅取 Arc、锁外 await 发送，B8 纪律不变）。会话断连/结束后由
    /// `clear_session_state` 清空，避免向已死会话重复发送。
    pub(super) close_sender: Option<Arc<dyn BrowserCloseSender>>,
}

impl Inner {
    pub(super) fn new() -> Self {
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
