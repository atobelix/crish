//! Cron 调度注册表实现（SchedulerRegistry；T-CF-09 / Phase 1 & Phase 2）

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use conex_types::cron::{parse_cron, CronSchedule};
use conex_types::CoreError;

use super::entry::{fire_delay_ms, spawn_fire_task, CronEntry};
use super::store::SchedStore;
use super::types::{
    cron_seq, now_ms, CronTask, CronTaskInput, CronTaskStatus, CronTaskUpdatePatch,
    DaemonRunLauncher, EventSink, PendingSink, ScheduledTaskLauncher, SchedulerError,
    CRON_ID_PREFIX,
};

/// 注册表组件集合
#[derive(Clone)]
pub(crate) struct SchedulerComponents {
    /// cron_id → 活跃条目（Arc 供触发任务克隆）
    pub(crate) tasks: Arc<Mutex<HashMap<String, CronEntry>>>,
    /// steering 条目落点（PendingMessageQueue 适配）
    pub(crate) pending: Arc<dyn PendingSink>,
    /// cron-fired 事件发射点（EventQueue 适配）
    pub(crate) events: Arc<dyn EventSink>,
    /// session_meta sched_* 键读写（conex-db 适配）
    pub(crate) store: Arc<dyn SchedStore>,
    /// is_daemon 独立 run 拉起点（None = 未接线，daemon 降级 steering）
    pub(crate) launcher: Option<Arc<dyn DaemonRunLauncher>>,
    /// 生产级定时任务真实执行启动器（Phase 2；None = 回退存量 launcher / steering）
    pub(crate) scheduled_launcher: Arc<Mutex<Option<Arc<dyn ScheduledTaskLauncher>>>>,
    /// 暂停开关（pauseAutomation 落点）
    pub(crate) pause: Arc<Mutex<Option<u64>>>,
    /// 测试钩子：固定短触发延迟
    #[cfg(test)]
    pub(crate) fire_override: Arc<Mutex<Option<u64>>>,
}

/// Cron 调度注册表
pub(crate) struct SchedulerRegistry {
    /// 组件集合（触发任务克隆用）
    pub(crate) components: SchedulerComponents,
    /// cron-<seq> 原子计数
    seq: AtomicU64,
    /// 启动恢复幂等守卫：防重入锁，确保 restore().await 幂等
    restored: Arc<AtomicBool>,
}

impl SchedulerRegistry {
    /// 新建注册表（初始化时通过 store.load_all() 提取最大序列号初始化 seq，关闭冷启动撞号竞态）
    pub(crate) fn new(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn SchedStore>,
        launcher: Option<Arc<dyn DaemonRunLauncher>>,
    ) -> Self {
        let mut max_seq = 0u64;
        for task in store.load_all() {
            if let Some(seq) = cron_seq(&task.cron_id) {
                max_seq = max_seq.max(seq + 1);
            }
        }
        Self {
            components: SchedulerComponents {
                tasks: Arc::new(Mutex::new(HashMap::new())),
                pending,
                events,
                store,
                launcher,
                scheduled_launcher: Arc::new(Mutex::new(None)),
                pause: Arc::new(Mutex::new(None)),
                #[cfg(test)]
                fire_override: Arc::new(Mutex::new(None)),
            },
            seq: AtomicU64::new(max_seq),
            restored: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 注入生产级定时任务真实执行启动器（Phase 2 CRIT-03：必须在 restore().await 之前完成注入）
    pub(crate) fn set_launcher(&self, launcher: Arc<dyn ScheduledTaskLauncher>) {
        *self
            .components
            .scheduled_launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(launcher);
    }

    /// 清除指定任务的失效目标会话绑定（INT-04 僵尸会话自愈同步用）
    pub(crate) fn clear_target_session_id(&self, cron_id: &str) {
        if let Some(entry) = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner()).get_mut(cron_id) {
            entry.task.target_session_id = None;
        }
        self.components.store.clear_target_session_id(cron_id);
    }

    /// 注册 cron 任务（T-CF-09 内容 1）
    pub(crate) async fn register(&self, input: CronTaskInput) -> Result<String, SchedulerError> {
        let schedule: CronSchedule = parse_cron(&input.expression)
            .map_err(|error| SchedulerError::InvalidExpression(format!("{error:?}")))?;
        let now = now_ms();
        let next_fire_at_ms = schedule
            .next_fire_after(now)
            .ok_or_else(|| SchedulerError::NoNextFire(input.expression.clone()))?;

        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let cron_id = format!("{CRON_ID_PREFIX}{seq}");

        let task = CronTask {
            cron_id: cron_id.clone(),
            expression: input.expression,
            prompt: input.prompt,
            max_iterations: input.max_iterations,
            is_daemon: input.is_daemon,
            next_fire_at_ms,
            fired_count: 0,
            status: CronTaskStatus::Active,
            enabled: true,
            target_session_id: None,
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.components.store.save(&task);

        let delay = fire_delay_ms(&self.components, next_fire_at_ms);
        let generation = 1;
        let handle = spawn_fire_task(self.components.clone(), task.clone(), delay, generation);
        self.components.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(
            cron_id.clone(),
            CronEntry {
                task,
                status: CronTaskStatus::Active,
                generation,
                sleep_task: Some(handle),
            },
        );
        tracing::info!(target: "sched", cron_id = %cron_id, next_fire_at_ms, "cron 任务已注册");
        Ok(cron_id)
    }

    /// 暂停指定 cron 任务（严格遵循 AA-02 锁规约：精确 abort 对应 sleep_task，置空 sleep_task，generation += 1，status 置为 Paused，写库持久化）
    pub(crate) async fn pause_task(&self, cron_id: &str) -> Result<(), CoreError> {
        let task_to_save: CronTask;

        {
            let mut tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let entry = tasks.get_mut(cron_id).ok_or_else(|| CoreError::NotFound(format!("cron 任务 {cron_id} 不存在")))?;

            if entry.status == CronTaskStatus::Paused {
                return Err(CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于暂停态")));
            }
            if matches!(entry.status, CronTaskStatus::Completed | CronTaskStatus::Cancelled) {
                return Err(CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于终态 ({:?})", entry.status)));
            }

            if let Some(handle) = entry.sleep_task.take() {
                handle.abort();
            }

            entry.generation += 1;
            entry.status = CronTaskStatus::Paused;
            entry.task.set_status(CronTaskStatus::Paused);
            task_to_save = entry.task.clone();
        }

        self.components.store.save(&task_to_save);
        tracing::info!(target: "sched", cron_id, "cron 任务已暂停（协程已中止，status=Paused 已落库）");

        Ok(())
    }

    /// 恢复指定 cron 任务（重算 next_fire_after，generation += 1，spawn 新 sleep 协程，status 置为 Active，写库持久化）
    pub(crate) async fn resume_task(&self, cron_id: &str) -> Result<(), CoreError> {
        let now = now_ms();
        let task_to_save: CronTask;
        let delay_ms: u64;

        {
            let mut tasks = self.components.tasks.lock().unwrap_or_else(|e| e.into_inner());
            let entry = tasks.get_mut(cron_id).ok_or_else(|| CoreError::NotFound(format!("cron 任务 {cron_id} 不存在")))?;

            if entry.status == CronTaskStatus::Active {
                return Err(CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于活跃态")));
            }
            if matches!(entry.status, CronTaskStatus::Completed | CronTaskStatus::Cancelled) {
                return Err(CoreError::invalid_input(format!("cron 任务 {cron_id} 已处于终态 ({:?})", entry.status)));
            }

            let schedule = parse_cron(&entry.task.expression)
                .map_err(|e| CoreError::invalid_input(format!("cron 表达式非法：{e:?}")))?;
            let next = schedule.next_fire_after(now).ok_or_else(|| {
                CoreError::invalid_input(format!("cron 表达式 {} 无未来触发时刻", entry.task.expression))
            })?;

            entry.task.next_fire_at_ms = next;
            entry.status = CronTaskStatus::Active;
            entry.task.set_status(CronTaskStatus::Active);
            entry.generation += 1;

            delay_ms = fire_delay_ms(&self.components, next);
            task_to_save = entry.task.clone();

            let handle = spawn_fire_task(self.components.clone(), entry.task.clone(), delay_ms, entry.generation);
            if let Some(old_h) = entry.sleep_task.replace(handle) {
                old_h.abort();
            }
        }

        self.components.store.save(&task_to_save);
        tracing::info!(target: "sched", cron_id, delay_ms, "cron 任务已恢复（未来时刻已重算，status=Active 已落库）");

        Ok(())
    }

    /// 原地就地更新 cron 任务（严守 CRIT-01 代际-协程物理绑定铁律）
    pub(crate) async fn update_task(
        &self,
        cron_id: &str,
        patch: CronTaskUpdatePatch,
    ) -> Result<(), CoreError> {
        let now = now_ms();
        let task_to_save: CronTask;

        {
            let mut tasks = self
                .components
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let entry = tasks
                .get_mut(cron_id)
                .ok_or_else(|| CoreError::NotFound(format!("cron 任务 {cron_id} 不存在")))?;

            if matches!(
                entry.status,
                CronTaskStatus::Completed | CronTaskStatus::Cancelled
            ) {
                return Err(CoreError::invalid_input(format!(
                    "cron 任务 {cron_id} 已处于终态 ({:?})，不可修改",
                    entry.status
                )));
            }

            let mut schedule_changed = false;

            // 1. 表达式变更与校验
            if let Some(new_expr) = patch.expression {
                let trimmed = new_expr.trim().to_string();
                if trimmed != entry.task.expression {
                    let schedule = parse_cron(&trimmed)
                        .map_err(|e| CoreError::invalid_input(format!("cron 表达式非法：{e:?}")))?;
                    let next = schedule.next_fire_after(now).ok_or_else(|| {
                        CoreError::invalid_input(format!("cron 表达式 {trimmed} 无未来触发时刻"))
                    })?;

                    entry.task.expression = trimmed;
                    entry.task.next_fire_at_ms = next;
                    schedule_changed = true;
                }
            }

            // 2. 提示词变更（原地更新，绝不杀协程，绝不推进代际！）
            if let Some(new_prompt) = patch.prompt {
                let trimmed = new_prompt.trim().to_string();
                if !trimmed.is_empty() {
                    entry.task.prompt = trimmed;
                }
            }

            // 3. 最大执行次数变更
            if let Some(new_max) = patch.max_iterations {
                entry.task.max_iterations = new_max;
            }

            // 4. 守护模式与会话绑定变更
            if let Some(is_daemon) = patch.is_daemon {
                entry.task.is_daemon = is_daemon;
            }
            if let Some(target_sid) = patch.target_session_id {
                entry.task.target_session_id = target_sid;
            }

            entry.task.updated_at_ms = now;

            // 5. 【CRIT-01 核心实现】：仅当 schedule 表达式改变且任务为 Active 时，才 abort 旧协程、generation += 1 并拉起新协程！
            // 若仅修改 prompt、is_daemon、target_session_id 等静态参数，严禁推进 generation！就地更新 entry 字段，保留原倒计时协程！
            if schedule_changed && entry.status == CronTaskStatus::Active {
                entry.generation += 1;
                if let Some(old_h) = entry.sleep_task.take() {
                    old_h.abort();
                }
                let delay = fire_delay_ms(&self.components, entry.task.next_fire_at_ms);
                let new_h = spawn_fire_task(
                    self.components.clone(),
                    entry.task.clone(),
                    delay,
                    entry.generation,
                );
                entry.sleep_task = Some(new_h);
                tracing::info!(target: "sched", cron_id, delay, "cron 调度表达式已热重载并重启协程");
            }

            task_to_save = entry.task.clone();
        }

        // 6. 锁外执行落盘
        self.components.store.save(&task_to_save);
        tracing::info!(target: "sched", cron_id, "cron 任务已就地热更新");

        Ok(())
    }

    /// 取消 / 删除 cron 任务：abort 协程，从 tasks 活跃表移除，标记 Cancelled
    pub(crate) async fn cancel(&self, cron_id: &str) -> Result<bool, SchedulerError> {
        let Some(mut entry) = self
            .components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(cron_id)
        else {
            return Err(SchedulerError::IdNotFound);
        };
        if let Some(h) = entry.sleep_task.take() {
            h.abort();
        }
        entry.generation += 1;
        entry.status = CronTaskStatus::Cancelled;
        entry.task.set_status(CronTaskStatus::Cancelled);
        let task = entry.task;
        self.components.store.save(&task);
        tracing::info!(
            target: "sched",
            cron_id,
            "cron 任务已取消（status=Cancelled 已落库）"
        );
        Ok(true)
    }

    /// 重启恢复（T-CF-09 内容 6 / Phase 1）：
    /// - 增加 restored 防重入锁，确保 restore().await 幂等；
    /// - 终态跳过；
    /// - Paused 任务加载进 tasks 内存表（sleep_task: None）；
    /// - 对离线过期需补发的任务，先将其插入 tasks 内存表（sleep_task: None），再异步派发补发协程，消除幽灵真空期；
    /// - 未到期任务按 next_fire_at_ms 重建 sleep。
    pub(crate) async fn restore(&self) {
        if self
            .restored
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            tracing::warn!(target: "sched", "SchedulerRegistry::restore 已被执行过，跳过重复调用");
            return;
        }

        let now = now_ms();
        for task in self.components.store.load_all() {
            // 序号推进（恢复的 id 防新注册撞号）
            if let Some(seq) = cron_seq(&task.cron_id) {
                self.seq.fetch_max(seq + 1, Ordering::SeqCst);
            }
            // 终态跳过：已完成或已取消
            if matches!(
                task.status,
                CronTaskStatus::Completed | CronTaskStatus::Cancelled
            ) {
                continue;
            }
            if let Some(max) = task.max_iterations {
                if task.fired_count >= max {
                    continue;
                }
            }
            // Paused 任务：加载进 tasks 内存表，不启动协程
            if task.status == CronTaskStatus::Paused {
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    "重启恢复：加载已暂停任务（不启动协程）"
                );
                self.components
                    .tasks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task,
                            status: CronTaskStatus::Paused,
                            generation: 1,
                            sleep_task: None,
                        },
                    );
                continue;
            }

            if task.next_fire_at_ms <= now {
                // 已过期未触发：先插入 tasks 内存表消除真空期，再异步派发补发协程
                tracing::info!(
                    target: "sched",
                    cron_id = %task.cron_id,
                    "重启恢复：已过期未触发，先入 tasks 表消除真空期，再异步补发"
                );
                let generation = 1;
                self.components
                    .tasks
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        task.cron_id.clone(),
                        CronEntry {
                            task: task.clone(),
                            status: CronTaskStatus::Active,
                            generation,
                            sleep_task: None,
                        },
                    );
                let comp = self.components.clone();
                let task_clone = task.clone();
                tokio::spawn(async move {
                    super::entry::fire_cron(comp, task_clone, false, generation).await;
                });
                continue;
            }

            // 未到期 → 按 next_fire_at_ms 重建 sleep
            let delay = fire_delay_ms(&self.components, task.next_fire_at_ms);
            tracing::info!(
                target: "sched",
                cron_id = %task.cron_id,
                delay_ms = delay,
                "重启恢复：未到期 cron 已重建 sleep"
            );
            let generation = 1;
            let handle = spawn_fire_task(self.components.clone(), task.clone(), delay, generation);
            self.components
                .tasks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    task.cron_id.clone(),
                    CronEntry {
                        task,
                        status: CronTaskStatus::Active,
                        generation,
                        sleep_task: Some(handle),
                    },
                );
        }
    }

    /// 活跃判定（表内存在 Active 态任务即活跃；Paused / Completed / Cancelled 均为非活跃）
    pub(crate) fn has_active(&self) -> bool {
        self.components
            .tasks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|entry| entry.status.is_active())
    }

    /// 全量快照（命令面 list-workflows 用；含已停止任务）
    pub(crate) fn snapshot(&self) -> Vec<CronTask> {
        self.components.store.load_all()
    }

    /// 测试钩子：注入固定短触发延迟（毫秒），免等分钟级真实触发
    #[cfg(test)]
    pub(crate) fn set_fire_override_ms(&self, ms: u64) {
        *self
            .components
            .fire_override
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(ms);
    }

    /// 暂停定时自动执行（R2-12c C31 pauseAutomation；F6 §8.2 全局内存态防抖开关）
    pub(crate) fn pause_for(&self, duration_sec: u64) -> u64 {
        let paused_until = now_ms().saturating_add(duration_sec.saturating_mul(1000));
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(paused_until);
        tracing::info!(
            target: "sched",
            duration_sec,
            paused_until,
            "定时自动执行已临时暂停（内存态，重启不恢复）"
        );
        paused_until
    }

    /// 当前暂停截止时刻（测试断言消费）
    #[cfg(test)]
    pub(crate) fn pause_deadline(&self) -> Option<u64> {
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 测试钩子：直接设置暂停截止时刻
    #[cfg(test)]
    pub(crate) fn set_paused_until_ms_for_test(&self, until: Option<u64>) {
        *self
            .components
            .pause
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = until;
    }
}

impl std::fmt::Debug for SchedulerRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SchedulerRegistry")
            .field("seq", &self.seq.load(Ordering::SeqCst))
            .field("restored", &self.restored.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}
