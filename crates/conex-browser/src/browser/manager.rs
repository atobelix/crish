use super::*;

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
    pub(super) data_root: PathBuf,
    pub(super) tuning: LaunchTuning,
    pub(super) events: broadcast::Sender<ProcessEvent>,
    pub(super) inner: Arc<Mutex<Inner>>,
    /// 启动临界区互斥（评审 H6）：`start()` 的「already_running 检查」与
    /// 「状态置位」之间含多个 await 点（孤儿清扫/后端解析/建 profile），
    /// 并发 start() 必须串行化——检查与置位在同一临界区内原子完成，
    /// 第二个调用方在置位后看到非 Stopped 直接走幂等分支，杜绝双启进程。
    pub(super) start_lock: Arc<tokio::sync::Mutex<()>>,
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
    pub(super) fn budget(&self) -> CrashBudget {
        CrashBudget {
            window: self.tuning.crash_window,
            max_restarts: self.tuning.crash_max_restarts,
        }
    }

    /// 测试钩子：注入驱动内部确定性 panic（M5 回归专用；注入点写入共享 Inner，
    /// 触发后自清除——`maybe_panic_driver` 在共享态上清除，恢复路径不被污染）。
    /// 仅 Windows 驱动回归用例调用；Linux/macOS 测试构建下保留 API 但不使用。
    #[cfg(test)]
    #[allow(dead_code)]
    pub(super) fn inject_driver_panic(&self, point: DriverPanicPoint) {
        self.lock().driver_panic_point = Some(point);
    }

    /// 测试钩子执行点：到达注入点时确定性 panic（触发后自清除）。
    #[cfg(test)]
    pub(super) fn maybe_panic_driver(&self, point: DriverPanicPoint) {
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
    pub(super) fn emit(&self, event: ProcessEvent) {
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
                        tracing::debug!(
                            "停止信号无接收者（驱动已退出），由 pending_stop 兜底：{err}"
                        );
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
                        tracing::warn!(
                            "停止时清理临时 profile 失败（登记孤儿，下次启动清扫）：{e}"
                        );
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

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // 锁纪律（B8）：中毒恢复数据继续使用，不 panic
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 事件发射前快照（restarts + backend）：
    /// 避免在 emit 结构体字面量内多次 `self.lock()`——临时守卫会存活到整个
    /// 语句结束，二次加锁即自死锁（std Mutex 不可重入）。
    pub(super) fn emit_snapshot(&self) -> (u8, Option<BackendResolution>) {
        let g = self.lock();
        (g.machine.restarts(), g.backend.clone())
    }
}
