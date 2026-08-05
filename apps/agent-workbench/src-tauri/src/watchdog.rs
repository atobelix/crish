//! 兜底 watchdog（G10 / REQ-C05 验收 2；T-CF-13）
//!
//! 职责（02-CF 方案 §4.3 模式 + REQ-CF-现状分析 §4.5.4 建议 2）：
//! - [Watchdog]：每会话一个 tokio 周期任务（周期 60s，可配），扫描会话
//!   `dispatch_*` 声明（wait_subagents.rs:83-89 键）与活跃定时器表——
//!   存在 dispatch 声明（子代理等待中）且自 `dispatched_at_ms` 起超过
//!   N 分钟（可配，默认 10 分钟对齐 MAX_WAIT_TIMEOUT_MS）无任何事件唤醒
//!   → 构造兜底 steering 条目写入 [PendingMessageQueue]（随 T-CF-11
//!   idle 续 run 注入；run 运行中则经 followUp 环排队，不打断）；
//! - 条目文案对齐 REQ-C05（REQ-agent-engine-capabilities.md:377）：
//!   "您有一个运行中的后台任务 <ID>，已运行 <时长>，请检查状态。"；
//! - group_id = `watchdog-<session>`（replaceOrEnqueue 去重，防重复）；
//! - "无任何事件唤醒"判定：引擎侧维护 [LastWakeupTracker]（EventQueue
//!   消费旁路记录，T-CF-07 的旁路点复用；旁路点不可达时由装配注入源
//!   驱动，见 [LastWakeupTracker] 注记）；超过 N 分钟无事件 → 触发；
//! - 触发一次后重置计时（去重防风暴）——再次失联 N 分钟才再次提醒。
//!
//! 装配（engine.rs `EngineHandle::new` 由 A3 统一收口；本文件只暴露
//! 构造器与 spawn，不直接持有 ControlBus）：
//! - queue = [PendingMessageQueue]（与 TimerRegistry 同队列或独立队列由
//!   A3 定夺；R-CF3 续 run 消费）；
//! - store = [DispatchStore] 适配（session_meta `dispatch_*` 键读取；
//!   默认内存实现 [MemoryDispatchStore]，conex-db 真适配在 R-CF3 接线）；
//! - last_wakeup = [LastWakeupTracker]（A3 在事件消费旁路点调用
//!   `mark_wakeup`；接线前 None = 从未唤醒，视为超时触发）；
//! - active_timer_probe = 活跃定时器计数探测（>0 = AI 已设置定时器等待
//!   机制，抑制兜底——REQ-C05「既没有设置定时器」条件；A3 可在
//!   TimerRegistry 装配点旁维护计数镜像，或经其他同步数据源注入）；
//! - options = [WatchdogOptions]（N 分钟 / 周期 / 时钟均可注入便于测试）。

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_tools::tools::wait_subagents::{DispatchDeclaration, MAX_WAIT_TIMEOUT_MS};
use orchestrator::steering_queue::SteeringInputEntry;
use orchestrator::PendingMessageQueue;

/// 默认失联阈值（分钟）：对齐 wait_subagents 的 MAX_WAIT_TIMEOUT_MS
///（10 分钟硬上限，wait_subagents.rs:75）
pub(crate) const DEFAULT_WATCHDOG_IDLE_MINUTES: u64 = MAX_WAIT_TIMEOUT_MS / 60_000;

/// 周期扫描间隔（默认 60s）
pub(crate) const DEFAULT_WATCHDOG_PERIOD: Duration = Duration::from_secs(60);

/// 当前 epoch 毫秒（watchdog 全域时间基准）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// steering 分组名（group_id = `watchdog-<session>`，replaceOrEnqueue 去重；
/// 对齐 recovery.rs:371-380 与 timers.rs:71-73 的分组模式）
pub(crate) fn steering_group_id(session_id: &str) -> String {
    format!("watchdog-{session_id}")
}

/// 时长格式化（"已运行 <时长>" 文案用）：
/// - ≥ 1 小时 → "X 小时 Y 分钟"；≥ 1 分钟 → "X 分钟"；否则 → "X 秒"
fn format_duration_ms(ms: u64) -> String {
    let total_minutes = ms / 60_000;
    if total_minutes >= 60 {
        format!("{} 小时 {} 分钟", total_minutes / 60, total_minutes % 60)
    } else if total_minutes >= 1 {
        format!("{total_minutes} 分钟")
    } else {
        format!("{} 秒", ms / 1000)
    }
}

// ── 事件唤醒跟踪（"无任何事件唤醒"判定数据源）──────────────────────

/// 最近事件唤醒时刻跟踪器（引擎侧共享；EventQueue 消费旁路记录，
/// T-CF-07 的旁路点复用）
///
/// 语义：`mark_wakeup` 由装配方在事件消费旁路点调用（任何事件到达即
/// 视为一次唤醒）；`None` = 从未唤醒（视为超时，触发兜底）。
#[derive(Default)]
pub(crate) struct LastWakeupTracker {
    /// 最近唤醒时刻（epoch 毫秒；None = 从未）
    last: Mutex<Option<u64>>,
}

impl LastWakeupTracker {
    /// 新建跟踪器（初始 None = 从未唤醒）
    #[cfg_attr(not(test), allow(dead_code))] // R-CF3：A3 装配接线后移除
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 标记一次事件唤醒（时刻取系统时钟；事件旁路接线点调用）
    #[allow(dead_code)] // R-CF3：A3 事件旁路接线后移除
    pub(crate) fn mark_wakeup(&self) {
        self.mark_wakeup_at(now_ms());
    }

    /// 标记一次事件唤醒（指定时刻；测试与旁路接线共用）
    pub(crate) fn mark_wakeup_at(&self, at_ms: u64) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(at_ms);
    }

    /// 最近唤醒时刻（None = 从未）
    pub(crate) fn last_wakeup_ms(&self) -> Option<u64> {
        *self.last.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── dispatch 声明读取适配（session_meta `dispatch_*` 键）──────────

/// dispatch 声明读取适配（session_meta 键 → 声明列表）
pub(crate) trait DispatchStore: Send + Sync {
    /// 读取本会话的 dispatch 声明（无声明 → 空 Vec；fail-open 不 panic）
    fn load_declarations(&self) -> Vec<DispatchDeclaration>;
}

/// 内存持久化适配（测试 + 引擎默认装配；conex-db session_meta 真适配
/// 在 R-CF3 接线——键形状已冻结为 wait_subagents.rs:83-89 的 dispatch_*，
/// 真适配用 `DispatchDeclaration::from_meta_pairs` 解析）
#[derive(Default)]
pub(crate) struct MemoryDispatchStore {
    /// dispatch 声明列表（本会话；watchdog 每会话一个实例）
    declarations: Mutex<Vec<DispatchDeclaration>>,
}

impl MemoryDispatchStore {
    /// 新建内存存储
    #[cfg_attr(not(test), allow(dead_code))] // R-CF3：wait 通道落库接线后移除
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 写入声明（测试注入与 wait 通道落库共用；幂等覆盖）
    #[allow(dead_code)] // R-CF3：wait 通道落库接线后移除
    pub(crate) fn set_declarations(&self, declarations: Vec<DispatchDeclaration>) {
        *self
            .declarations
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = declarations;
    }
}

impl DispatchStore for MemoryDispatchStore {
    fn load_declarations(&self) -> Vec<DispatchDeclaration> {
        self.declarations.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

// ── Watchdog（兜底唤醒判定与触发）──────────────────────────────────

/// watchdog 配置（N 分钟 / 周期 / 时钟均可注入便于测试）
pub(crate) struct WatchdogOptions {
    /// 失联阈值（分钟；默认 [DEFAULT_WATCHDOG_IDLE_MINUTES] = 10，
    /// 对齐 MAX_WAIT_TIMEOUT_MS；任务书：EngineOptions 或环境变量由
    /// 装配轮定稿，本处为注入点）
    pub idle_minutes: u64,
    /// 周期扫描间隔（默认 [DEFAULT_WATCHDOG_PERIOD] = 60s）
    pub period: Duration,
    /// 时钟源（默认系统时钟；测试注入固定时刻）
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for WatchdogOptions {
    fn default() -> Self {
        Self {
            idle_minutes: DEFAULT_WATCHDOG_IDLE_MINUTES,
            period: DEFAULT_WATCHDOG_PERIOD,
            now: Arc::new(now_ms),
        }
    }
}

/// 兜底 watchdog（每会话一个；[spawn] 为 tokio 周期任务）
pub(crate) struct Watchdog {
    /// 会话标识（steering 分组名来源）
    session_id: String,
    /// steering 条目落点（PendingMessageQueue；R-CF3 续 run 消费）
    queue: Arc<Mutex<PendingMessageQueue>>,
    /// dispatch 声明读取（session_meta 适配）
    store: Arc<dyn DispatchStore>,
    /// 最近事件唤醒时刻（None = 从未唤醒）
    last_wakeup: Arc<LastWakeupTracker>,
    /// 活跃定时器计数探测（>0 = AI 已设置定时器等待，抑制兜底；
    /// 缺省不抑制——A3 装配时注入真实计数）
    active_timer_probe: Arc<dyn Fn() -> usize + Send + Sync>,
    /// 上次触发时刻（epoch 毫秒；触发后重置计时防风暴）
    last_fired_ms: Mutex<Option<u64>>,
    /// 配置（N 分钟 / 周期 / 时钟）
    options: WatchdogOptions,
}

impl Watchdog {
    /// 新建 watchdog（适配器与配置由装配方注入）
    #[allow(dead_code)] // R-CF3：A3 装配接线后移除
    pub(crate) fn new(
        session_id: String,
        queue: Arc<Mutex<PendingMessageQueue>>,
        store: Arc<dyn DispatchStore>,
        last_wakeup: Arc<LastWakeupTracker>,
        active_timer_probe: Arc<dyn Fn() -> usize + Send + Sync>,
        options: WatchdogOptions,
    ) -> Self {
        Self {
            session_id,
            queue,
            store,
            last_wakeup,
            active_timer_probe,
            last_fired_ms: Mutex::new(None),
            options,
        }
    }

    /// 周期扫描一次（[spawn] 的循环体；测试可直接驱动）
    pub(crate) async fn tick(&self) {
        let now_ms = (self.options.now)();
        if let Some(entry) = self.scan(now_ms) {
            tracing::info!(
                target: "watchdog",
                session_id = %self.session_id,
                "兜底唤醒触发：N 分钟无事件唤醒，steering 条目已写入"
            );
            let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
            queue.replace_or_enqueue(entry);
        }
    }

    /// 单次扫描判定（纯同步逻辑，时钟可注入便于测试）：
    /// - 活跃定时器存在 → 抑制（REQ-C05「既没有设置定时器」条件）；
    /// - 无 dispatch 声明 → 不触发；
    /// - idle 基准 = max(最近分发时刻, 最近唤醒, 上次触发)；自基准起
    ///   超过 N 分钟 → 构造兜底条目并记录触发时刻（重置计时）。
    fn scan(&self, now_ms: u64) -> Option<SteeringInputEntry> {
        // 活跃定时器非空 = AI 已设置定时器等待机制（set_timer），不算
        // 「失联」，系统不插嘴（REQ-C05 条件：既没有设置定时器）
        if (self.active_timer_probe)() > 0 {
            return None;
        }
        let declarations = self.store.load_declarations();
        if declarations.is_empty() {
            return None;
        }
        // idle 基准：最近的分发时刻（有新分发 = 有新活动）与最近事件唤醒
        // 取较晚者；触发后以上次触发时刻为基准（去重防风暴）
        let dispatched_at = declarations
            .iter()
            .map(|d| d.dispatched_at_ms)
            .max()
            .unwrap_or(0);
        let last_fired = self
            .last_fired_ms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .unwrap_or(0);
        let idle_since = dispatched_at
            .max(self.last_wakeup.last_wakeup_ms().unwrap_or(0))
            .max(last_fired);
        let threshold_ms = self.options.idle_minutes.saturating_mul(60_000);
        if now_ms.saturating_sub(idle_since) < threshold_ms {
            return None;
        }
        // 触发：取最近一次分发的声明构造条目，并记录触发时刻（重置计时）。
        // declarations 非空已在上方守卫，unwrap 不可达
        let target = declarations
            .iter()
            .max_by_key(|d| d.dispatched_at_ms)?;
        *self
            .last_fired_ms
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(now_ms);
        Some(self.build_steering_entry(target, now_ms))
    }

    /// 构造兜底 steering 条目（对齐 recovery.rs:371-380 的
    /// build_steering_entry 模式：is_steering 受保护位 + 分组去重；
    /// 文案冻结模板见模块头部注记）
    fn build_steering_entry(
        &self,
        declaration: &DispatchDeclaration,
        now_ms: u64,
    ) -> SteeringInputEntry {
        let elapsed_ms = now_ms.saturating_sub(declaration.dispatched_at_ms);
        // 声明必有子代理清单（from_meta_pairs 守卫非空）；防御兜底
        let id_text = if declaration.subagent_ids.is_empty() {
            "<未命名任务>".to_string()
        } else {
            declaration.subagent_ids.join("、")
        };
        let text = format!(
            "您有一个运行中的后台任务 {id_text}，已运行 {}，请检查状态。",
            format_duration_ms(elapsed_ms)
        );
        SteeringInputEntry {
            // 条目 id 带时间戳保证同组替换后仍唯一（对齐 recovery 模式）
            id: format!("watchdog-{}-{now_ms}", self.session_id),
            text,
            attachments: Vec::new(),
            enqueued_at: now_ms,
            group_id: Some(steering_group_id(&self.session_id)),
            is_steering: true,
        }
    }
}

/// spawn 入口（每会话一个 tokio 周期任务；engine.rs 装配由 A3 统一完成，
/// 见任务书装配收口单点纪律）
#[allow(dead_code)] // R-CF3：A3 装配接线后移除
pub(crate) fn spawn(
    runtime: &tokio::runtime::Handle,
    watchdog: Arc<Watchdog>,
) -> tokio::task::JoinHandle<()> {
    let period = watchdog.options.period;
    runtime.spawn(async move {
        let mut interval = tokio::time::interval(period);
        loop {
            interval.tick().await;
            watchdog.tick().await;
        }
    })
}

// ── 测试 ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::tools::wait_subagents::WaitMode;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 测试时钟（Arc 共享：闭包读取 + 测试推进）
    fn test_clock() -> (Arc<AtomicU64>, WatchdogOptions) {
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let shared = Arc::clone(&clock);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> =
            Arc::new(move || shared.load(Ordering::Relaxed));
        let options = WatchdogOptions {
            idle_minutes: 10,
            period: Duration::from_secs(60),
            now,
        };
        (clock, options)
    }

    /// 构造测试 watchdog（内存 store + 无活跃定时器 + 独立队列）
    fn test_watchdog() -> (
        Arc<Watchdog>,
        Arc<Mutex<PendingMessageQueue>>,
        Arc<MemoryDispatchStore>,
        Arc<LastWakeupTracker>,
        Arc<AtomicU64>,
    ) {
        let (clock, options) = test_clock();
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let store = Arc::new(MemoryDispatchStore::new());
        let last_wakeup = Arc::new(LastWakeupTracker::new());
        let watchdog = Arc::new(Watchdog::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::clone(&store) as Arc<dyn DispatchStore>,
            Arc::clone(&last_wakeup),
            Arc::new(|| 0),
            options,
        ));
        (watchdog, queue, store, last_wakeup, clock)
    }

    /// dispatch 声明构造（await-all 模式等待一个子代理）
    fn declaration(subagent_id: &str, dispatched_at_ms: u64) -> DispatchDeclaration {
        DispatchDeclaration {
            mode: WaitMode::AwaitAll,
            wait_ms: None,
            subagent_ids: vec![subagent_id.to_string()],
            dispatched_at_ms,
        }
    }

    /// 队列条目快照（取走全部）
    fn drain_entries(queue: &Arc<Mutex<PendingMessageQueue>>) -> Vec<SteeringInputEntry> {
        queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .dequeue_all()
    }

    // ── T-CF-13 验收断言 ─────────────────────────────────────────

    /// 失联超时：分发于 11 分钟前、从未有事件唤醒 → steering 条目出现，
    /// 文案含任务 ID 与时长，group_id = watchdog-<session>
    #[tokio::test]
    async fn watchdog_fires_after_n_minutes_idle() {
        let (watchdog, queue, store, _, clock) = test_watchdog();
        store.set_declarations(vec![declaration(
            "sa-1",
            clock.load(Ordering::Relaxed) - 11 * 60_000,
        )]);
        watchdog.tick().await;
        let entries = drain_entries(&queue);
        assert_eq!(entries.len(), 1, "失联超过 N 分钟应触发兜底");
        assert_eq!(entries[0].group_id.as_deref(), Some("watchdog-sess-1"));
        assert!(
            entries[0].text.contains("sa-1"),
            "文案应含任务 ID：{}",
            entries[0].text
        );
        assert!(
            entries[0].text.contains("11 分钟"),
            "文案应含时长：{}",
            entries[0].text
        );
        assert!(entries[0].is_steering, "兜底条目应置 is_steering 受保护位");
    }

    /// 最近有事件唤醒（last_wakeup 更新）→ 不触发
    #[tokio::test]
    async fn watchdog_no_fire_when_events_recent() {
        let (watchdog, queue, store, last_wakeup, clock) = test_watchdog();
        let base = clock.load(Ordering::Relaxed);
        store.set_declarations(vec![declaration(
            "sa-1",
            base.saturating_sub(30 * 60_000),
        )]);
        last_wakeup.mark_wakeup_at(base.saturating_sub(60_000));
        watchdog.tick().await;
        assert!(
            drain_entries(&queue).is_empty(),
            "最近有事件唤醒不应触发兜底"
        );
    }

    /// 周期内重复扫描只产生一条（触发后重置计时 + 同组 replace 去重）
    #[tokio::test]
    async fn watchdog_dedup_same_group() {
        let (watchdog, queue, store, _, _) = test_watchdog();
        store.set_declarations(vec![declaration("sa-1", 100_000)]);
        watchdog.tick().await;
        watchdog.tick().await;
        let entries = drain_entries(&queue);
        assert_eq!(entries.len(), 1, "同一失联窗口内重复扫描只应产生一条");
    }

    /// 触发后计时重置：下一周期（60s 后）不重复；再次失联 N 分钟后重新
    /// 触发时同组替换（仍只一条，文案时长更新）
    #[tokio::test]
    async fn watchdog_resets_after_fire() {
        let (watchdog, queue, store, _, clock) = test_watchdog();
        store.set_declarations(vec![declaration("sa-1", 100_000)]);
        // t0 触发（dispatched_at=100_000 → 已运行 15 分钟）
        watchdog.tick().await;
        let first = drain_entries(&queue);
        assert_eq!(first.len(), 1);
        assert!(first[0].text.contains("15 分钟"), "首次触发时长：{}", first[0].text);
        // t0 + 60s：下一周期，未再失联 N 分钟 → 不重复
        clock.fetch_add(60_000, Ordering::Relaxed);
        watchdog.tick().await;
        assert!(
            drain_entries(&queue).is_empty(),
            "触发后 60s 不应重复触发"
        );
        // t0 + 11 分钟：再次失联 N 分钟 → 重新触发（同组替换，仍一条，
        // 时长更新为 26 分钟）
        clock.fetch_add(10 * 60_000, Ordering::Relaxed);
        watchdog.tick().await;
        let second = drain_entries(&queue);
        assert_eq!(second.len(), 1, "再次触发应替换同组条目而非新增");
        assert!(
            second[0].text.contains("26 分钟"),
            "文案时长应随再次触发更新：{}",
            second[0].text
        );
    }

    /// 无 dispatch 声明 → 不触发
    #[tokio::test]
    async fn watchdog_no_fire_without_declaration() {
        let (watchdog, queue, _, _, _) = test_watchdog();
        watchdog.tick().await;
        assert!(drain_entries(&queue).is_empty());
    }

    /// 活跃定时器非空（AI 已设置定时器等待）→ 抑制兜底（REQ-C05 条件）
    #[tokio::test]
    async fn watchdog_no_fire_when_active_timer() {
        let (_clock, options) = test_clock();
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let store = Arc::new(MemoryDispatchStore::new());
        store.set_declarations(vec![declaration("sa-1", 100_000)]);
        let watchdog = Arc::new(Watchdog::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::clone(&store) as Arc<dyn DispatchStore>,
            Arc::new(LastWakeupTracker::new()),
            Arc::new(|| 1), // 活跃定时器 1 个
            options,
        ));
        watchdog.tick().await;
        assert!(
            drain_entries(&queue).is_empty(),
            "存在活跃定时器不应触发兜底"
        );
    }

    /// 从未有事件唤醒（last_wakeup = None）→ 视为超时，触发兜底
    #[tokio::test]
    async fn watchdog_fires_when_never_woken() {
        let (watchdog, queue, store, _, clock) = test_watchdog();
        store.set_declarations(vec![declaration(
            "sa-1",
            clock.load(Ordering::Relaxed) - 10 * 60_000 - 1_000,
        )]);
        watchdog.tick().await;
        assert_eq!(drain_entries(&queue).len(), 1, "从未唤醒应触发兜底");
    }

    /// 时长格式化边界（≥ 1 小时 → 小时 + 分钟；< 1 分钟 → 秒）
    #[test]
    fn duration_format_hour_boundary() {
        assert_eq!(format_duration_ms(90 * 60_000), "1 小时 30 分钟");
        assert_eq!(format_duration_ms(11 * 60_000), "11 分钟");
        assert_eq!(format_duration_ms(45_000), "45 秒");
    }
}
