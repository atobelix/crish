//! run/run_snapshot.rs（SR-02 · 拆分 · ≠ EL）
//!
//! 经 run/mod.rs 聚合接线；顶层符号 pub(crate) 化供兄弟模与门面 re-export。
use super::*;
impl CoreRunState {
    /// D6 §3.3：重启恢复条目生成（断点 3 消费端；run_restore 成功路径
    /// 调用）。对 [RestoreOutcome::interrupted] 逐条生成 steering 条目
    /// （group_id = `restore-<run_id>`，is_steering 受保护——容量挤占时
    /// 普通消息先被挤掉）：
    /// - **主 run**（非 sub-sess-* 会话）→ 恢复条目入队（watcher 首轮
    ///   延迟窗口后 / 下次收口消费），注入「上次被重启打断，请继续」
    ///   自动续跑（A3）；
    /// - **子代理 run**（sub-sess-* 前缀分流）→ 只通知主 agent 不自动
    ///   fork（裁决 #20：自动重派违反「所有子 Agent 由主 Agent 分配」
    ///   红线）；父归属经 session_agents 行 parent_session_id 解析
    ///   （D6 §8 决策 3），查不到 → 跳过通知仅日志（run-interrupted
    ///   事件已留痕）。
    ///
    /// 不消费 recover_episodes 预算（W8：唤醒源枚举为前瞻设计，预算仅
    /// error-retry 域消费；风暴防制靠合并上限 + watcher 延迟）。
    pub(crate) async fn enqueue_restore_entries(&self, outcome: &RestoreOutcome) {
        let subagent_records: Vec<&orchestrator::restore::InterruptedRun> = outcome
            .interrupted
            .iter()
            .filter(|record| record.session_id.starts_with(SUBAGENT_SESSION_PREFIX))
            .collect();
        let parents = if subagent_records.is_empty() {
            HashMap::new()
        } else {
            let run_ids: Vec<String> = subagent_records
                .iter()
                .map(|record| record.run_id.clone())
                .collect();
            let candidate_sessions: Vec<String> = outcome
                .sessions
                .iter()
                .map(|session| session.session_id.clone())
                .collect();
            self.resolve_subagent_parents(&run_ids, &candidate_sessions)
                .await
        };
        let mut queue = self.pending_queue.lock().unwrap_or_else(|e| e.into_inner());
        for record in &outcome.interrupted {
            let now = now_ms_internal();
            // 目标会话为语义注记（队列为全局共享面，无会话字段——消费
            // 方按 group_id/条目文本承载归属语义，T06.3 Q15）
            let (_target_session, text) = if record.session_id.starts_with(SUBAGENT_SESSION_PREFIX)
            {
                match parents.get(&record.run_id) {
                    Some(parent) => (
                        parent.clone(),
                        format!(
                            "子代理 run {} 在重启时被中断（{}），请决策：重派 / 接管 / 放弃",
                            record.run_id,
                            orchestrator::restore::INTERRUPTED_ERROR,
                        ),
                    ),
                    None => {
                        tracing::warn!(
                            target: "restore",
                            run_id = %record.run_id,
                            session_id = %record.session_id,
                            "子代理 interrupted 父归属查不到（跳过通知；run-interrupted 事件已留痕）"
                        );
                        continue;
                    }
                }
            } else {
                (
                    record.session_id.clone(),
                    RESTORE_MAIN_INJECT_TEXT.to_string(),
                )
            };
            // 分组去重（replace_or_enqueue：同 run 不重复堆积——重启
            // 双恢复场景仅 1 条）；带时间戳 id 保证同组替换后仍唯一
            queue.replace_or_enqueue(orchestrator::steering_queue::SteeringInputEntry {
                id: format!("{RESTORE_GROUP_PREFIX}{}-{now}", record.run_id),
                text,
                attachments: Vec::new(),
                enqueued_at: now,
                group_id: Some(format!("{RESTORE_GROUP_PREFIX}{}", record.run_id)),
                is_steering: true,
            });
        }
    }

    /// D6 §8 决策 3：子代理 run → 父会话解析（session_agents 行
    /// subagent_run_id 反查——行按父会话 id 落库，subagent_spawner.rs:296
    /// row_for；候选会话 = 恢复会话全集）。F2-27：同步 SQLite 读经
    /// spawn_blocking 执行，tokio worker 不直调。
    pub(crate) async fn resolve_subagent_parents(
        &self,
        run_ids: &[String],
        candidate_sessions: &[String],
    ) -> HashMap<String, String> {
        let Some(db) = self.local_db() else {
            return HashMap::new();
        };
        let targets: Vec<String> = run_ids.to_vec();
        let sessions: Vec<String> = candidate_sessions.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut parents = HashMap::new();
            for session in &sessions {
                match db.load_session_agents(session) {
                    Ok(agents) => {
                        for agent in agents {
                            if targets
                                .iter()
                                .any(|target| target == &agent.subagent_run_id)
                            {
                                parents.insert(agent.subagent_run_id, agent.parent_session_id);
                            }
                        }
                    }
                    Err(error) => tracing::warn!(
                        target: "restore",
                        session_id = %session,
                        error = %error,
                        "恢复条目父归属扫描读取失败（跳过该会话）"
                    ),
                }
            }
            parents
        })
        .await
        .unwrap_or_default()
    }
}

impl CoreRunState {
    /// T08.6 启动接线：restore + seed + 立即快照（main.rs 在
    /// `app.manage(CoreRunState)` 之前 run_in_runtime 执行）
    ///
    /// 失败路径：restore 返回 Err → tracing error + 诊断记录
    /// （restore.state=failed），**不阻塞启动**——run 命令照常可用
    /// （事件序列锚点由 [Self::base_sequence_for] 懒计算兜底）。
    pub async fn run_restore(self: &Arc<Self>) -> Option<RestoreOutcome> {
        self.restore_started.store(true, Ordering::SeqCst);
        match RestoreManager::new()
            .restore(self.store.as_ref(), self.snapshots.as_ref())
            .await
        {
            Ok(outcome) => {
                // 1. 序列号预热（审计事件已落库口径，T08.8）
                self.seed_sequences(&outcome).await;
                // 2. 会话树注册表水合（快照会话 ∪ run 派生会话）
                self.sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .extend(outcome.sessions.clone());
                // 3. 门禁放行（必须在 seed 之后：新 run 的 base 从预热值续接）
                self.restore_ready.store(true, Ordering::SeqCst);
                // 4. 恢复成功后立即保存快照（restore.rs 文档：
                //    「After successful restore (full or incremental)」）
                self.save_snapshot_now().await;
                // 恢复结果入状态域（restore_status 数据源，F2 冻结形状）
                self.restore_failed.store(false, Ordering::SeqCst);
                let mode = match outcome.mode {
                    RestoreMode::FullReplay => "full-replay",
                    RestoreMode::SnapshotIncremental => "snapshot-incremental",
                };
                *self.restore_mode.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(mode.to_string());
                *self.restore_note.lock().unwrap_or_else(|e| e.into_inner()) =
                    outcome.snapshot_note.clone();
                *self
                    .interrupted_count
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = outcome.interrupted.len();
                *self
                    .restore_last_sequence
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(outcome.last_sequence);
                // D3 §3.3：逐会话重建会话树 + 构造协调器 + 重排 pending
                // 通知（树先于 coordinator 插入——coordinator_for 从
                // session_trees 取树；from_session_record 失败 → 降级空树，
                // fail-open：阶梯 1/2/4 照常、阶梯 3 fork 结构化拒绝，
                // recovery.rs:1066-1070）
                for record in &outcome.sessions {
                    let tree =
                        SessionTree::from_session_record(record.clone()).unwrap_or_else(|e| {
                            tracing::warn!(
                                target: "restore",
                                session_id = %record.session_id,
                                error = %e,
                                "会话树重建失败（降级空树：阶梯 1/2/4 照常，fork 结构化拒绝）"
                            );
                            SessionTree::new(&record.session_id)
                        });
                    self.session_trees
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(record.session_id.clone(), Arc::new(Mutex::new(tree)));
                    // coordinator 惰性构造（new 自动恢复预算/forks/通知/
                    // needs_user，recovery.rs:855-863）
                    if let Some(coord) = self.coordinator_for(&record.session_id) {
                        let reinsert_res = {
                            let mut c = coord.lock().await;
                            c.restore_steering_notifications()
                        };
                        match reinsert_res {
                            Ok(reinserted) => {
                                tracing::info!(
                                    target: "restore",
                                    session_id = %record.session_id,
                                    reinserted,
                                    "恢复阶梯 2 通知重排完成（pending 条目重新入队）"
                                );
                            }
                            Err(error) => {
                                tracing::warn!(
                                    target: "restore",
                                    session_id = %record.session_id,
                                    error = %error,
                                    "恢复阶梯 2 通知重排失败（重启后该通知仅落库，主 agent 可见性降级）"
                                );
                            }
                        }
                    }
                }
                // D6-③：重启恢复条目生成（interrupted → restore-<run_id>
                // steering 条目；主 run 自动续跑，子代理只通知不自动 fork）
                self.enqueue_restore_entries(&outcome).await;
                // D6 §3.2 spawn 点 1：恢复后对恢复会话 spawn watcher——
                // 恢复条目 / 定时器补发 / 通知重排需要消费方（每会话
                // 幂等持有；子代理会话不 spawn——无 watcher 拉起语义）
                for record in &outcome.sessions {
                    if !record.session_id.starts_with(SUBAGENT_SESSION_PREFIX) {
                        self.ensure_wake_watcher(&record.session_id);
                    }
                }
                tracing::info!(
                    target: "restore",
                    mode = ?outcome.mode,
                    interrupted = outcome.interrupted.len(),
                    last_sequence = outcome.last_sequence,
                    snapshot_generation = outcome.snapshot_generation,
                    "重启恢复完成"
                );
                Some(outcome)
            }
            Err(error) => {
                tracing::error!(
                    target: "restore",
                    error = %error,
                    "重启恢复失败（不阻塞启动，懒计算兜底）"
                );
                self.diagnostics
                    .record("restore", false, Some(error.to_string()));
                self.restore_failed.store(true, Ordering::SeqCst);
                *self.restore_note.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(error.to_string());
                // 门禁放行：run 命令照常可用（懒计算兜底序列锚点）
                self.restore_ready.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    /// T08.6 触发点 A/B/C 共用：保存快照（generation 续接；P16 失败显式标记）
    ///
    /// T3.5 D5（F2-11）：互斥入口——三触发（终态收口 / 周期 loop / 退出
    /// 钩子）全部汇入本函数；tokio Mutex 守卫跨 await 持有（build 内 store
    /// 查询与落盘均在锁内），generation 读-改-写原子化：任意时刻至多一路
    /// 在写，杜绝同进程并发交叉写（R2 §4：修复前两路同读 G 同写 G+1 +
    /// tmp 同名交叉写可致快照损坏）。std Mutex 锁不跨 await 持有（AA-02），
    /// 快照互斥必须用 tokio Mutex。
    pub async fn save_snapshot_now(&self) {
        let _guard = self.snapshot_mutex.lock().await;
        match self.build_and_save_snapshot().await {
            Ok(generation) => {
                self.snapshot_generation.store(generation, Ordering::SeqCst);
                *self
                    .snapshot_last_error
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;
                *self
                    .snapshot_written_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or_default(),
                );
                tracing::info!(target: "restore", generation, "快照已保存");
            }
            Err(error) => {
                tracing::error!(target: "restore", error = %error, "快照保存失败（P16 显式标记）");
                *self
                    .snapshot_last_error
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = Some(error);
            }
        }
    }

    /// 组装并保存快照（内容：会话树注册表 + 全部 runs + 逐会话 pending +
    /// last_sequence = 全会话事件 max + 逐会话锚点；快照只是近似一致，
    /// 增量重放以锚点补足）。
    ///
    /// PERSIST-02 P1-2 门禁：restore 未完成或失败时**禁止覆盖既有快照
    /// 文件**——注册表仅在 run_restore 成功路径水合（sessions.extend），
    /// 未水合时本函数会保存「0 会话 + 全部 runs + last_sequence=0」的
    /// 半水合快照覆盖主快照，下次恢复全走派生路径（branches 空、
    /// meta None），会话树分支历史永久丢失。restore 成功后立即保存
    /// （run_restore 先置 restore_ready 再调本函数）不受影响。
    pub(crate) async fn build_and_save_snapshot(&self) -> Result<u64, String> {
        if !self.restore_ready.load(Ordering::SeqCst) {
            return Err("restore 未完成，跳过快照保存（防半水合快照覆盖主快照）".to_string());
        }
        if self.restore_failed.load(Ordering::SeqCst) {
            return Err("restore 失败，跳过快照保存（保留既有快照文件）".to_string());
        }
        let runs = self.store.query_runs().await.map_err(|e| e.to_string())?;
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let mut pending = Vec::new();
        let mut last_sequence = 0u64;
        // PERSIST-02 P1-1：逐会话锚点（session_id → 该会话事件 max）。
        // 事件序列为会话内独立，恢复按会话自身锚点取增量，全局 max 作
        // 会话级 base 会永久跳过落后会话的快照后事件（多会话粘性错误）。
        let mut session_last_sequence: HashMap<String, u64> = HashMap::new();
        for session in &sessions {
            let events = self
                .store
                .query_events(&session.session_id, 0, None)
                .await
                .map_err(|e| e.to_string())?;
            let session_max = events.iter().map(|e| e.sequence).max().unwrap_or(0);
            last_sequence = last_sequence.max(session_max);
            session_last_sequence.insert(session.session_id.clone(), session_max);
            pending.extend(
                self.store
                    .load_pending_inputs(&session.session_id)
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }
        let generation = self.snapshot_generation.load(Ordering::SeqCst) + 1;
        let snapshot = StateSnapshot::build(
            generation,
            last_sequence,
            sessions,
            runs,
            pending,
            session_last_sequence,
        );
        self.snapshots
            .save_snapshot(&snapshot)
            .map_err(|e| e.to_string())?;
        Ok(generation)
    }

    /// T08.6 触发点 B：周期快照（默认 60s，`snapshot_interval_ms` 可配；
    /// 仅在存在活动 run 时保存，避免空转写）。幂等（重复调用不重复启动）。
    pub fn spawn_snapshot_loop(self: &Arc<Self>) {
        if self.snapshot_loop_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let interval_ms = *this
                .snapshot_interval_ms
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let mut interval = tokio::time::interval(Duration::from_millis(interval_ms.max(1_000)));
            interval.tick().await; // 首拍立即触发（interval 首拍即完成），跳过
            loop {
                interval.tick().await;
                let has_active = this
                    .active_runs
                    .lock()
                    .map(|runs| !runs.is_empty())
                    .unwrap_or(false);
                if has_active {
                    this.save_snapshot_now().await;
                }
            }
        });
    }

    /// T08.6 触发点 C：优雅退出钩子（main.rs `RunEvent::Exit` 调用；
    /// 阻塞语义——同步事件回调内完成快照保存）
    pub fn save_snapshot_blocking(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tauri::async_runtime::block_on(async move { this.save_snapshot_now().await });
    }
}
