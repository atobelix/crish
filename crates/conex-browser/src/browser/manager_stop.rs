use super::*;

impl BrowserManager {
    /// G-9 发送面：优雅停止先经登记的会话发 `Browser.close`（浏览器级命令，
    /// 无 session_id）。发送有界（`BROWSER_CLOSE_SEND_TIMEOUT`）——Browser.close
    /// 发出后浏览器随时关闭 WS，响应未必回；发送失败/超时/无会话一律静默
    /// 降级为既有 wait_or_kill → 杀树兜底，不 panic、不阻塞停止收敛。
    pub(super) async fn send_browser_close_gracefully(&self) {
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
    pub(super) async fn stop_path(
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
    pub(super) async fn finish_stop(&self, start: Instant, force_killed: bool) {
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
    pub(super) async fn cleanup_profile(&self) {
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
    pub(super) async fn abort_during_launch(&self) {
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
    pub(super) async fn on_driver_panic(&self, msg: &str) {
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
    pub(super) fn freeze_nav(&self) {
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
    pub(super) fn clear_session_state(&self) {
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
    pub(super) fn current_report(&self) -> LaunchReport {
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
