//! 定时器注册表（G5/G6 引擎面；T-CF-06 / T-CF-07，REQ-C01/C02）

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_tools::tools::set_timer::{TimerChannel, TimerError};
use async_trait::async_trait;
use conex_types::timer::{TimerCondition, TimerDeclaration, TimerHandle};

use crate::timers::early_exit::{clear_early_exit, fire_timer, panic_message};
use crate::timers::store::TimerStore;
use crate::timers::types::{
    EventSink, MAX_DURATION_SECONDS, PendingSink, TIMER_ID_PREFIX, TimerCancelReason, TimerEvent,
    now_ms, timer_seq,
};

/// 活跃定时器条目（timers 表值）
pub(crate) struct TimerEntry {
    /// 持久化声明（fired / cancelled 状态位）
    pub(crate) declaration: TimerDeclaration,
    /// 到期触发任务（cancel 经 abort 取消）
    pub(crate) task: tokio::task::JoinHandle<()>,
}

/// 定时器注册表（每引擎一个；到期经 PendingMessageQueue 注入，
/// 不直接持有 ControlBus）
pub(crate) struct TimerRegistry {
    /// timer_id → 活跃条目（Arc 供到期任务克隆，任务不自引用注册表）
    pub(crate) timers: Arc<Mutex<HashMap<String, TimerEntry>>>,
    /// sender(task-id/agent-id) → timer_id（Task 条件早退映射；
    /// Any 条件不参与冲突表）
    pub(crate) early_exit: Arc<Mutex<HashMap<String, String>>>,
    /// steering 条目落点（PendingMessageQueue 适配）
    pub(crate) pending: Arc<dyn PendingSink>,
    /// timer-fired / timer-cancelled 事件发射点（EventQueue 适配）
    pub(crate) events: Arc<dyn EventSink>,
    /// session_meta timer_* 键读写（conex-db 适配）
    pub(crate) store: Arc<dyn TimerStore>,
    /// timer-<seq> 原子计数
    pub(crate) seq: AtomicU64,
    /// 全域时间基准（epoch 毫秒；生产 = [now_ms]，测试 = AtomicU64 驱动，
    /// 对齐 watchdog.rs 时钟注入模式——到期判定 / 事件时间戳统一走注入
    /// 基准，消除「注入时钟与 Instant 真实时钟混用」）
    pub(crate) now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl TimerRegistry {
    /// 新建注册表（适配器由装配方注入；时间基准 = 生产实时钟 [now_ms]）
    pub(crate) fn new(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn TimerStore>,
    ) -> Self {
        Self::with_clock(pending, events, store, Arc::new(now_ms))
    }

    /// 新建注册表并注入自定义时间基准（测试面注入 Arc 驱动的
    /// 可推进时钟；生产路径经 [Self::new] 委托本方法走默认实时钟，
    /// 生产 / 测试共用同一实现）
    pub(crate) fn with_clock(
        pending: Arc<dyn PendingSink>,
        events: Arc<dyn EventSink>,
        store: Arc<dyn TimerStore>,
        now: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            timers: Arc::new(Mutex::new(HashMap::new())),
            early_exit: Arc::new(Mutex::new(HashMap::new())),
            pending,
            events,
            store,
            seq: AtomicU64::new(0),
            now,
        }
    }

    /// 注册一次性定时器（后台静默运行，不阻塞调用方）。
    ///
    /// 流程（T-CF-06 §1）：校验 durationSeconds（1~86400）→ 冲突约束
    /// （T-CF-07 §1）→ 构造 handle + 声明 → 落 session_meta `timer_*` 键
    /// → 登记 early_exit 映射（Task 条件）→ spawn 到期任务 → 返回 handle。
    pub(crate) async fn register(
        &self,
        duration_seconds: u64,
        prompt: String,
        condition: TimerCondition,
    ) -> Result<TimerHandle, TimerError> {
        // 1. 时长校验（1~86400，与工具 schema 上限一致）
        if duration_seconds == 0 || duration_seconds > MAX_DURATION_SECONDS {
            return Err(TimerError::InvalidDuration);
        }
        // 2. 冲突约束（REQ-C02 / T-CF-07）：Task(sender) 且 early_exit
        //    已存在该 sender 的活跃定时器 → 结构化 Conflict；
        //    Any 条件不参与冲突表（多定时器共享 any 语义无歧义）
        if let TimerCondition::Task(sender) = &condition {
            if let Some(existing) = self
                .early_exit
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(sender)
                .cloned()
            {
                return Err(TimerError::Conflict(format!(
                    "sender {sender} 已存在活跃定时器 {existing}，请先取消或等待其到期"
                )));
            }
        }
        // 3. id 分配与时间基准
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let timer_id = format!("{TIMER_ID_PREFIX}{seq}");
        let now = (self.now)();
        let expires_at_ms = now.saturating_add(duration_seconds * 1000);
        let handle = TimerHandle {
            timer_id: timer_id.clone(),
            expires_at_ms,
            duration_seconds,
            prompt: prompt.clone(),
            condition: condition.clone(),
        };
        // 4. 落库（session_meta `timer_<id>` 键；重启恢复数据源）
        let declaration = TimerDeclaration {
            timer_id: timer_id.clone(),
            created_at_ms: now,
            expires_at_ms,
            prompt: prompt.clone(),
            condition: condition.clone(),
            fired: false,
            cancelled: false,
        };
        self.store.save(&declaration);
        // 5. early_exit 登记（Task 条件；早退查表与冲突查表共用）
        if let TimerCondition::Task(sender) = &condition {
            self.early_exit
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(sender.clone(), timer_id.clone());
        }
        // 6. spawn 到期任务（sleep_until；cancel 经 abort 取消）
        let task = self.spawn_fire_task(declaration.clone());
        self.timers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(timer_id.clone(), TimerEntry { declaration, task });
        tracing::info!(
            target: "timers",
            timer_id = %timer_id,
            expires_at_ms,
            condition = ?condition,
            "定时器已注册"
        );
        Ok(handle)
    }

    /// 显式取消（早退命中或 AI 主动取消）；不存在返回 IdNotFound。
    ///
    /// 流程（T-CF-06 §3）：abort 到期任务 → 声明标 cancelled=true 落库 →
    /// 发射 TimerCancelled（Soft，reason=cancelled）。
    pub(crate) async fn cancel(&self, timer_id: &str) -> Result<bool, TimerError> {
        match self.take_entry(timer_id) {
            None => Err(TimerError::IdNotFound),
            Some(entry) => {
                entry.task.abort();
                let mut declaration = entry.declaration;
                declaration.cancelled = true;
                self.store.save(&declaration);
                self.events.emit(TimerEvent::Cancelled {
                    timer_id: timer_id.to_string(),
                    reason: TimerCancelReason::Cancelled,
                    cancelled_at_ms: (self.now)(),
                });
                tracing::info!(target: "timers", timer_id, "定时器已显式取消");
                Ok(true)
            }
        }
    }

    /// 活跃定时器列表（未到期未取消；idle 待命续 run 判定用）
    pub(crate) async fn list_active(&self) -> Vec<TimerHandle> {
        let timers = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        timers
            .values()
            .filter(|e| !e.declaration.fired && !e.declaration.cancelled)
            .map(|e| TimerHandle {
                timer_id: e.declaration.timer_id.clone(),
                expires_at_ms: e.declaration.expires_at_ms,
                duration_seconds: e
                    .declaration
                    .expires_at_ms
                    .saturating_sub(e.declaration.created_at_ms)
                    / 1000,
                prompt: e.declaration.prompt.clone(),
                condition: e.declaration.condition.clone(),
            })
            .collect()
    }

    /// 活跃定时器计数（针对特定会话或全局；Watchdog 探测待命状态）
    pub(crate) fn active_count_for_session(&self, _session_id: &str) -> usize {
        let timers = self.timers.lock().unwrap_or_else(|e| e.into_inner());
        timers
            .values()
            .filter(|e| !e.declaration.fired && !e.declaration.cancelled)
            .count()
    }

    /// 重启恢复（T-CF-06 §4）：扫描已持久化声明，
    /// - fired=false && cancelled=false 且未到期 → 按 remaining_ms 重建
    ///   sleep（重登记 early_exit 映射）；
    /// - 已到期未注入 → 补发到期流程（防丢）。
    pub(crate) async fn restore(&self) {
        let now = (self.now)();
        for declaration in self.store.load_all() {
            // 已终态（fired / cancelled）声明跳过——防重启重复注入
            if declaration.fired || declaration.cancelled {
                continue;
            }
            // 序号推进（恢复的 id 防新注册撞号）
            if let Some(seq) = timer_seq(&declaration.timer_id) {
                self.seq.fetch_max(seq + 1, Ordering::SeqCst);
            }
            if declaration.expires_at_ms <= now {
                // 已到期未注入 → 补发（重启窗口期间到期的定时器）
                tracing::info!(
                    target: "timers",
                    timer_id = %declaration.timer_id,
                    "重启恢复：已到期未注入，补发到期流程"
                );
                fire_timer(
                    &self.timers,
                    &self.early_exit,
                    &self.pending,
                    &self.events,
                    &self.store,
                    &self.now,
                    &declaration,
                );
                continue;
            }
            // 未到期 → 重建 sleep（remaining_ms 由 T-CF-04 辅助方法提供）
            let remaining = declaration.remaining_ms(now);
            let handle = TimerHandle {
                timer_id: declaration.timer_id.clone(),
                expires_at_ms: declaration.expires_at_ms,
                duration_seconds: declaration
                    .expires_at_ms
                    .saturating_sub(declaration.created_at_ms)
                    / 1000,
                prompt: declaration.prompt.clone(),
                condition: declaration.condition.clone(),
            };
            let task = self.spawn_fire_task(declaration.clone());
            // Task 条件重登记 early_exit 映射（早退语义跨重启保持）
            if let TimerCondition::Task(sender) = &declaration.condition {
                self.early_exit
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(sender.clone(), declaration.timer_id.clone());
            }
            self.timers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    declaration.timer_id.clone(),
                    TimerEntry { declaration, task },
                );
            tracing::info!(
                target: "timers",
                timer_id = %handle.timer_id,
                remaining_ms = remaining,
                "重启恢复：未到期定时器已重建 sleep"
            );
        }
    }

    /// 从 timers 表移除并清理 early_exit 映射（取消/早退/到期的公共收口）
    pub(crate) fn take_entry(&self, timer_id: &str) -> Option<TimerEntry> {
        let entry = self
            .timers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(timer_id)?;
        clear_early_exit(&self.early_exit, timer_id);
        Some(entry)
    }

    /// 到期触发任务：10ms 粒度轮询时间基准，`now() >= expires_at_ms`
    /// 即 fire（同步 fire + catch_unwind 兜底，记日志不炸引擎——tokio
    /// 任务 panic 由 JoinError 捕获，双保险）。
    ///
    /// 轮询取代单次 sleep_until：统一生产 / 测试一条路径（注入时钟下
    /// sleep_until 按 Instant 真实时钟等待会与注入时钟失配），生产最小
    /// 注册时长 1s，10ms 抖动语义等价；cancel 仍经 abort 取消。
    ///
    /// 任务克隆注册表的组件 Arc（timers / early_exit / pending / events /
    /// store / now），不自引用注册表本体——避免「注册表 → 条目 → 任务 →
    /// 注册表」的循环引用。
    fn spawn_fire_task(&self, declaration: TimerDeclaration) -> tokio::task::JoinHandle<()> {
        let timers = Arc::clone(&self.timers);
        let early_exit = Arc::clone(&self.early_exit);
        let pending = Arc::clone(&self.pending);
        let events = Arc::clone(&self.events);
        let store = Arc::clone(&self.store);
        let now = Arc::clone(&self.now);
        let expires_at_ms = declaration.expires_at_ms;
        tokio::spawn(async move {
            // 10ms 粒度轮询：now() >= expires_at_ms 即 fire（interval 首拍
            // 立即检查——未到期不 fire，随后每 10ms 一检）
            let mut interval = tokio::time::interval(Duration::from_millis(10));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            while now() < expires_at_ms {
                interval.tick().await;
            }
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
                fire_timer(
                    &timers,
                    &early_exit,
                    &pending,
                    &events,
                    &store,
                    &now,
                    &declaration,
                );
            }));
            if let Err(panic) = outcome {
                tracing::error!(
                    target: "timers",
                    timer_id = %declaration.timer_id,
                    panic = %panic_message(panic.as_ref()),
                    "定时器到期任务 panic（已兜底，不炸引擎）"
                );
            }
        })
    }
}

impl std::fmt::Debug for TimerRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimerRegistry")
            .field("seq", &self.seq.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

/// TimerChannel 契约实现（T-CF-05 冻结签名；经 BuiltinToolConfig
/// timer_channel 注入 set_timer / cancel_timer 工具）
#[async_trait]
impl TimerChannel for TimerRegistry {
    async fn register(
        &self,
        duration_seconds: u64,
        prompt: String,
        condition: TimerCondition,
    ) -> Result<TimerHandle, TimerError> {
        TimerRegistry::register(self, duration_seconds, prompt, condition).await
    }

    async fn cancel(&self, timer_id: &str) -> Result<bool, TimerError> {
        TimerRegistry::cancel(self, timer_id).await
    }

    async fn list_active(&self) -> Result<Vec<TimerHandle>, TimerError> {
        Ok(TimerRegistry::list_active(self).await)
    }
}
