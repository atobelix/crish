use super::*;

impl BrowserManager {
    /// profile 准备（§4.2/§4.3）：Ephemeral → sessions/<uuid>/；Imported → 复制到 managed/。
    pub(super) async fn prepare_profile(
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
    pub(super) async fn drive_session(
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
    pub(super) async fn launch_with_retries(
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
    pub(super) async fn launch_once(
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
    pub(super) async fn give_up(
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
}
