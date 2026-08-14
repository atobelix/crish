//! 无人值守唤醒 watcher（D6-②「AI 休眠后到期事件无消费方」断点补齐；
//! 任务连续性能力集「未停就该一直工作」的调度主干最后一跳）
//!
//! 职责（docs/continuity-repair/dimensions/D6-无人值守唤醒链路.md §3.2）：
//! - [WakeWatcher]：每会话一个 tokio 周期任务（周期 2s，可配），扫描
//!   [PendingMessageQueue] 与活动 run 状态——队列非空且该会话无活动
//!   run 且未超全部护栏 → 经注入的拉起器拉起 idle-resume run
//!   （壳层闭包注入 `spawn_idle_resume_run`，本模块不直接依赖
//!   core_run_commands——判定与拉起解耦，替身可测）；
//! - 判定护栏（对齐 decide_idle_resume 与评审 03 / 02-定夺）：
//!   ① 队列空不拉；② 有活动 run 不拉（拉起前检查；串行守卫由壳层
//!   run_task_impl 兜底拒绝并发双拉，验收 A5）；③ 会话级 user_stopped
//!   标记不拉（用户显式停止永不自动续，跨 run 语义）；④ 空转计数超限
//!   不拉（resume_empty_streak 由收口维护，本模块只读判停，护栏复用）；
//!   ⑤ 距上次拉起 < 最小拉 run 间隔（默认 10s）不拉（抖动护栏）；
//! - 首轮延迟（默认 5s）：防重启后恢复条目 / 定时器补发 / 通知重排与
//!   用户新 run 竞争（selection-03:95）。
//!
//! 与 watchdog.rs 的关系：并存不重叠——watchdog 是「无事件时制造事件」
//! （写队列），watcher 是「有事件时拉起 run」（消费队列）；watchdog
//! 判定含活跃定时器抑制，watcher 无此抑制（定时器到期条目本身就是
//! 唤醒源）。watchdog 写队列 → watcher 拉起 run，可接力但判定互不依赖。
//!
//! 装配（壳层面批次接线，本模块只暴露构造器与 start/stop）：
//! - queue = [PendingMessageQueue]（与 TimerRegistry / watchdog 同一
//!   队列实例，engine.timer_steering_queue()）；
//! - has_active_run = 活动 run 探测（壳层注入：active_runs 锁内扫描
//!   同会话任一 run，core_run_commands.rs:3218-3223 同款语义）；
//! - empty_streak = 空转计数只读接口（壳层注入：读
//!   CoreRunState.resume_empty_streak；计数由收口 decide_idle_resume
//!   维护——W2 按唤醒源区分（定时器/Cron 空注入轮不增不减）与
//!   goal/error 分支计数均在壳层域，本模块只读判停）；
//! - launcher = 拉起器（壳层注入：`spawn_idle_resume_run(state,
//!   session_id, Vec::new())` 包装——注入文本走空 Vec，队列条目由新
//!   run 收口时 decide_idle_resume drain，D6 §8 决策 2 路径①）；
//! - options = [WakeWatcherOptions]（首轮延迟 / 周期 / 最小间隔 /
//!   空转上限 / 时钟均可注入便于测试，对齐 WatchdogOptions 模式）。
//!
//! 生命周期：会话级存活（与 watchdog 每会话任务同语义），run 收口不
//! 销毁——否则 AI 休眠后 watcher 也跟着没了；start 幂等持有（内部
//! 任务槽），stop 供销毁 / 测试面 abort。

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use orchestrator::PendingMessageQueue;

/// 首轮延迟（防重启恢复条目 / 定时器补发 / 通知重排与用户新 run 竞争；
/// 评审 selection-03:95 建议 5s）
pub(crate) const DEFAULT_FIRST_TICK_DELAY: Duration = Duration::from_secs(5);

/// 周期扫描间隔（默认 2s——覆盖定时器 fire 粒度（ms 级）到拉起的延迟）
pub(crate) const DEFAULT_WAKE_PERIOD: Duration = Duration::from_secs(2);

/// 最小拉 run 间隔（防 watcher 抖动反复拉起失败重试风暴；自决 10s，
/// D6 §8 决策 6）
pub(crate) const DEFAULT_MIN_LAUNCH_INTERVAL: Duration = Duration::from_secs(10);

/// 空转护栏上限（对齐 core_run_commands.rs 的
/// IDLE_RESUME_MAX_EMPTY_ROUNDS = 3；超限判停口径一致：> 上限才停）
pub(crate) const DEFAULT_MAX_EMPTY_STREAK: u32 = 3;

/// 当前 epoch 毫秒（wake_watcher 全域时间基准）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 拉起器（拉 run 的注入接口；生产 = 壳层包装
/// `spawn_idle_resume_run(state, session_id, Vec::new())`，测试 = 替身
/// 计数——避免本模块直接依赖 core_run_commands）
pub(crate) type WakeLauncher =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// watcher 配置（首轮延迟 / 周期 / 最小间隔 / 空转上限 / 时钟均可注入
/// 便于测试，对齐 WatchdogOptions 模式 watchdog.rs:151-171）
pub(crate) struct WakeWatcherOptions {
    /// 首轮延迟（启动后不立即 tick；默认 [DEFAULT_FIRST_TICK_DELAY] = 5s）
    pub first_tick_delay: Duration,
    /// 周期扫描间隔（默认 [DEFAULT_WAKE_PERIOD] = 2s）
    pub period: Duration,
    /// 最小拉 run 间隔（默认 [DEFAULT_MIN_LAUNCH_INTERVAL] = 10s）
    pub min_launch_interval: Duration,
    /// 空转计数判停上限（默认 [DEFAULT_MAX_EMPTY_STREAK] = 3；
    /// 超限 = streak > max 不拉，与 decide_idle_resume 口径一致）
    pub max_empty_streak: u32,
    /// 时钟源（默认系统时钟；测试注入固定时刻）
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for WakeWatcherOptions {
    fn default() -> Self {
        Self {
            first_tick_delay: DEFAULT_FIRST_TICK_DELAY,
            period: DEFAULT_WAKE_PERIOD,
            min_launch_interval: DEFAULT_MIN_LAUNCH_INTERVAL,
            max_empty_streak: DEFAULT_MAX_EMPTY_STREAK,
            now: Arc::new(now_ms),
        }
    }
}

/// 无人值守唤醒 watcher（每会话一个；[Self::start] 为 tokio 周期任务，
/// start 幂等持有 + stop 销毁/测试面 abort）
pub(crate) struct WakeWatcher {
    /// 会话标识（拉起 run 的目标会话）
    session_id: String,
    /// 跨 run steering 队列（与 TimerRegistry / watchdog 同一实例；
    /// 队列非空 = 唤醒源事件已入队，等待消费方）
    queue: Arc<Mutex<PendingMessageQueue>>,
    /// 活动 run 探测（壳层注入：active_runs 锁内扫描；拉起前检查，
    /// 串行守卫拒绝后发者的兜底在壳层 run_task_impl）
    has_active_run: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// 空转计数只读接口（壳层注入：读 resume_empty_streak；计数由收口
    /// 维护——W2 按唤醒源区分计数在壳层域，本模块只读判停）
    empty_streak: Arc<dyn Fn(&str) -> u32 + Send + Sync>,
    /// 拉起器（拉 run；生产 = spawn_idle_resume_run 包装）
    launcher: WakeLauncher,
    /// 会话级用户停止标记（停止时刻；用户显式停止后 watcher 不再拉起，
    /// 用户新 run 由壳层 clear——跨 run 用户停止证据，护栏 2）
    user_stopped: Mutex<Option<u64>>,
    /// 上次拉起时刻（epoch 毫秒；最小拉 run 间隔依据）
    last_launch_ms: Mutex<Option<u64>>,
    /// 周期任务句柄（start 幂等持有 / stop abort）
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 配置（首轮延迟 / 周期 / 最小间隔 / 空转上限 / 时钟）
    options: WakeWatcherOptions,
}

impl WakeWatcher {
    /// 新建 watcher（适配器与配置由壳层装配方注入；每会话一个实例，
    /// 会话出现时 spawn、会话销毁时 stop）
    pub(crate) fn new(
        session_id: String,
        queue: Arc<Mutex<PendingMessageQueue>>,
        has_active_run: Arc<dyn Fn(&str) -> bool + Send + Sync>,
        empty_streak: Arc<dyn Fn(&str) -> u32 + Send + Sync>,
        launcher: WakeLauncher,
        options: WakeWatcherOptions,
    ) -> Self {
        Self {
            session_id,
            queue,
            has_active_run,
            empty_streak,
            launcher,
            user_stopped: Mutex::new(None),
            last_launch_ms: Mutex::new(None),
            task: Mutex::new(None),
            options,
        }
    }

    /// 启动周期任务（幂等：已启动则返回 false 不重复 spawn；首轮延迟
    /// [WakeWatcherOptions::first_tick_delay] 后开始 tick 循环）。
    /// 返回 true = 本次为首次启动。
    pub(crate) fn start(self: &Arc<Self>, runtime: &tokio::runtime::Handle) -> bool {
        let mut slot = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return false;
        }
        let watcher = Arc::clone(self);
        let first_tick_delay = self.options.first_tick_delay;
        let period = self.options.period;
        let handle = runtime.spawn(async move {
            tokio::time::sleep(first_tick_delay).await;
            let mut interval = tokio::time::interval(period);
            loop {
                interval.tick().await;
                watcher.tick().await;
            }
        });
        *slot = Some(handle);
        true
    }

    /// 停止周期任务（abort 循环；返回 true = 有任务被停止）。
    /// 进程退出随 runtime 销毁无需显式关停，本接口供销毁 / 测试面使用。
    pub(crate) fn stop(self: &Arc<Self>) -> bool {
        let mut slot = self.task.lock().unwrap_or_else(|e| e.into_inner());
        match slot.take() {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    /// 周期任务是否运行中（start 幂等 / stop 生效的观测面）
    #[cfg(test)]
    pub(crate) fn is_running(&self) -> bool {
        self.task
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 标记用户显式停止（测试与调试入口）
    #[cfg(test)]
    pub(crate) fn set_user_stopped(&self) {
        self.set_user_stopped_at(now_ms());
    }

    /// 标记用户显式停止（指定时刻；测试与壳层接线共用）
    pub(crate) fn set_user_stopped_at(&self, at_ms: u64) {
        *self.user_stopped.lock().unwrap_or_else(|e| e.into_inner()) = Some(at_ms);
    }

    /// 清除用户停止标记（壳层用户新 run 装配成功后调用；清除后 watcher
    /// 恢复自动拉起语义）
    pub(crate) fn clear_user_stopped(&self) {
        *self.user_stopped.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// 用户停止标记是否存在（会话级；测试与壳层查询面共用）
    pub(crate) fn is_user_stopped(&self) -> bool {
        self.user_stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 单次判定（纯同步逻辑，时钟可注入便于测试；对齐 D6 §3.2 tick
    /// 判定步骤 1-5）：
    /// 1. 队列空 → 不拉；2. 该会话有活动 run → 不拉（拉起前检查）；
    /// 3. user_stopped 标记存在 → 不拉；4. 空转计数超限（> max）→ 不拉；
    /// 5. 距上次拉起 < 最小间隔 → 不拉。全部通过 → 拉。
    fn should_launch(&self, now_ms: u64) -> bool {
        // 1. 队列空 → 不拉（锁内读，不跨 await——AA-02 并发模型，
        //    对齐 decide_idle_resume 的 queue_pending 判定）
        let queue_pending = self
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .has_pending();
        if !queue_pending {
            return false;
        }
        // 2. 该会话有活动 run → 不拉（拉起前检查；与收口判定并发双拉
        //    时由壳层 run_task_impl 串行守卫拒绝后发者——验收 A5，
        //    本模块不重复实现串行守卫）
        if (self.has_active_run)(&self.session_id) {
            return false;
        }
        // 3. 会话级 user_stopped 标记存在 → 不拉（用户显式停止过，
        //    直到用户新 run 清除——护栏 2「用户显式停止永不自动续」
        //    跨 run 语义）
        if self.is_user_stopped() {
            return false;
        }
        // 4. 空转计数已超限（> max_empty_streak）→ 不拉（空转护栏复用；
        //    计数由收口 decide_idle_resume 维护，watcher 只读判停）
        if (self.empty_streak)(&self.session_id) > self.options.max_empty_streak {
            return false;
        }
        // 5. 距上次拉起 < 最小拉 run 间隔 → 不拉（抖动护栏：
        //    拉起失败仅告警不重试的语义下防重试风暴）
        let last = self
            .last_launch_ms
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(last) = *last {
            if now_ms.saturating_sub(last) < self.options.min_launch_interval.as_millis() as u64 {
                return false;
            }
        }
        true
    }

    /// 周期扫描一次（[Self::start] 的循环体；测试可直接驱动）：
    /// 判定通过 → 调拉起器拉起 idle-resume run 并记录拉起时刻
    /// （拉起器内部失败仅告警——失败也记录间隔，防重试风暴）。
    pub(crate) async fn tick(&self) {
        let now = (self.options.now)();
        if !self.should_launch(now) {
            return;
        }
        tracing::info!(
            target: "wake_watcher",
            session_id = %self.session_id,
            "唤醒拉起：队列非空且无活动 run，拉起 idle-resume run（并发双拉由壳层串行守卫拒绝后发者）"
        );
        (self.launcher)(self.session_id.clone()).await;
        *self
            .last_launch_ms
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(now);
    }
}

// ── 测试 ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use orchestrator::steering_queue::SteeringInputEntry;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};

    /// 测试时钟（Arc 共享：闭包读取 + 测试推进）
    fn test_clock() -> (Arc<AtomicU64>, WakeWatcherOptions) {
        let clock = Arc::new(AtomicU64::new(1_000_000));
        let shared = Arc::clone(&clock);
        let now: Arc<dyn Fn() -> u64 + Send + Sync> =
            Arc::new(move || shared.load(Ordering::Relaxed));
        let options = WakeWatcherOptions {
            first_tick_delay: Duration::from_millis(0),
            period: Duration::from_millis(20),
            // 最小拉 run 间隔 10s（生产缺省语义；接续链 2 修正：原 10ms
            // 与 watcher_min_launch_interval 的 5s/11s 时钟推进自相矛盾——
            // 5000ms ≥ 10ms 恒放行，间隔内断言数学上不可能成立）
            min_launch_interval: Duration::from_secs(10),
            max_empty_streak: 3,
            now,
        };
        (clock, options)
    }

    /// 测试拉起器替身（计数；验证拉起次数与目标会话）
    fn test_launcher(launches: &Arc<AtomicUsize>) -> WakeLauncher {
        let counter = Arc::clone(launches);
        Arc::new(move |session_id: String| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                let _ = session_id;
                counter.fetch_add(1, Ordering::SeqCst);
            })
        })
    }

    /// 构造测试 watcher（独立队列 + 替身探测 + 替身拉起器）
    fn test_watcher() -> (
        Arc<WakeWatcher>,
        Arc<Mutex<PendingMessageQueue>>,
        Arc<AtomicU64>,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
        Arc<AtomicU32>,
    ) {
        let (clock, options) = test_clock();
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let launches = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicBool::new(false));
        let active_probe = Arc::clone(&active);
        let has_active_run: Arc<dyn Fn(&str) -> bool + Send + Sync> =
            Arc::new(move |_| active_probe.load(Ordering::SeqCst));
        let streak = Arc::new(AtomicU32::new(0));
        let streak_probe = Arc::clone(&streak);
        let empty_streak: Arc<dyn Fn(&str) -> u32 + Send + Sync> =
            Arc::new(move |_| streak_probe.load(Ordering::SeqCst));
        let watcher = Arc::new(WakeWatcher::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            has_active_run,
            empty_streak,
            test_launcher(&launches),
            options,
        ));
        (watcher, queue, clock, launches, active, streak)
    }

    /// 测试条目入队（steering 条目，对齐唤醒源条目形态）
    fn enqueue_entry(queue: &Arc<Mutex<PendingMessageQueue>>) {
        queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enqueue(SteeringInputEntry::steering(
                "wake-1",
                "定时器 <t-1> 已到期",
                1_000_000,
            ));
    }

    // ── tick 判定 ────────────────────────────────────────────────

    /// 队列非空 + 无活动 run → 拉起器被调（验收 A1 判定面）
    #[tokio::test]
    async fn watcher_launches_when_queue_nonempty_idle() {
        let (watcher, queue, _, launches, _, _) = test_watcher();
        enqueue_entry(&queue);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 1, "队列非空应拉起");
    }

    /// 队列空 → 不拉起
    #[tokio::test]
    async fn watcher_no_launch_when_queue_empty() {
        let (watcher, _, _, launches, _, _) = test_watcher();
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 0, "队列空不应拉起");
    }

    /// 同会话有活动 run → 不拉起（防重入拉起前检查；串行守卫兜底在壳层）
    #[tokio::test]
    async fn watcher_no_launch_when_active_run() {
        let (watcher, queue, _, launches, active, _) = test_watcher();
        enqueue_entry(&queue);
        active.store(true, Ordering::SeqCst);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 0, "有活动 run 不应拉起");
        active.store(false, Ordering::SeqCst);
        watcher.tick().await;
        assert_eq!(
            launches.load(Ordering::SeqCst),
            1,
            "活动 run 消失后恢复拉起"
        );
    }

    /// user_stopped 标记存在 → 不拉起；用户新 run 清除后恢复
    #[tokio::test]
    async fn watcher_no_launch_after_user_stopped() {
        let (watcher, queue, _, launches, _, _) = test_watcher();
        enqueue_entry(&queue);
        watcher.set_user_stopped();
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 0, "用户停止后不应拉起");
        watcher.clear_user_stopped();
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 1, "清除后恢复拉起");
    }

    /// 空转计数超限（> max_empty_streak）→ 不拉起；不超限（== max）放行
    /// （判停口径与 decide_idle_resume 的 `> IDLE_RESUME_MAX_EMPTY_ROUNDS`
    /// 一致）
    #[tokio::test]
    async fn watcher_no_launch_when_streak_exhausted() {
        let (watcher, queue, _, launches, _, streak) = test_watcher();
        enqueue_entry(&queue);
        streak.store(4, Ordering::SeqCst);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 0, "超限不应拉起");
        streak.store(3, Ordering::SeqCst);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 1, "== 上限不超限，放行");
    }

    /// 空转上限可配（max_empty_streak 注入生效）
    #[tokio::test]
    async fn watcher_max_empty_streak_configurable() {
        let (_clock, mut options) = test_clock();
        options.max_empty_streak = 5;
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let launches = Arc::new(AtomicUsize::new(0));
        let streak = Arc::new(AtomicU32::new(4));
        let streak_probe = Arc::clone(&streak);
        let empty_streak: Arc<dyn Fn(&str) -> u32 + Send + Sync> =
            Arc::new(move |_| streak_probe.load(Ordering::SeqCst));
        let watcher = Arc::new(WakeWatcher::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::new(|_| false),
            empty_streak,
            test_launcher(&launches),
            options,
        ));
        enqueue_entry(&queue);
        watcher.tick().await;
        assert_eq!(
            launches.load(Ordering::SeqCst),
            1,
            "streak=4 < max=5 应放行"
        );
    }

    /// 最小拉 run 间隔：上次拉起 < min_launch_interval → 跳过；到达后放行
    #[tokio::test]
    async fn watcher_min_launch_interval() {
        let (watcher, queue, clock, launches, _, _) = test_watcher();
        enqueue_entry(&queue);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 1, "首次拉起");
        // 5s 后：< 10s 最小间隔 → 跳过
        clock.fetch_add(5_000, Ordering::Relaxed);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 1, "间隔内不应重复拉起");
        // 再 6s（累计 11s）：≥ 10s → 放行
        clock.fetch_add(6_000, Ordering::Relaxed);
        watcher.tick().await;
        assert_eq!(launches.load(Ordering::SeqCst), 2, "间隔到达后放行");
    }

    // ── 周期任务（spawn 层）───────────────────────────────────────

    /// 首轮延迟：start 后延迟窗口内不拉起，延迟过后拉起
    #[tokio::test]
    async fn watcher_first_tick_delay_defers_launch() {
        let (_clock, mut options) = test_clock();
        options.first_tick_delay = Duration::from_millis(100);
        options.period = Duration::from_millis(10);
        options.min_launch_interval = Duration::from_millis(0);
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let launches = Arc::new(AtomicUsize::new(0));
        let watcher = Arc::new(WakeWatcher::new(
            "sess-1".to_string(),
            Arc::clone(&queue),
            Arc::new(|_| false),
            Arc::new(|_| 0),
            test_launcher(&launches),
            options,
        ));
        enqueue_entry(&queue);
        let runtime = tokio::runtime::Handle::current();
        assert!(watcher.start(&runtime), "首次启动");
        // 首轮延迟 100ms 内：不应拉起
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(launches.load(Ordering::SeqCst), 0, "首轮延迟内不应拉起");
        // 延迟过后：周期扫描拉起
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert!(launches.load(Ordering::SeqCst) >= 1, "首轮延迟后应拉起");
        assert!(watcher.stop(), "停止周期任务");
    }

    /// start 幂等：重复启动返回 false 不重复 spawn；stop 后任务停止、
    /// 可再次启动
    #[tokio::test]
    async fn watcher_start_idempotent_and_stop() {
        let (watcher, _, _, _, _, _) = test_watcher();
        let runtime = tokio::runtime::Handle::current();
        assert!(watcher.start(&runtime), "首次启动");
        assert!(!watcher.start(&runtime), "幂等：重复启动返回 false");
        assert!(watcher.is_running(), "启动后运行中");
        assert!(watcher.stop(), "停止返回 true");
        assert!(!watcher.is_running(), "停止后不再运行");
        assert!(!watcher.stop(), "重复停止返回 false");
        assert!(watcher.start(&runtime), "停止后可再启动");
        watcher.set_user_stopped();
        assert!(watcher.is_user_stopped());
        watcher.clear_user_stopped();
        assert!(!watcher.is_user_stopped());
        watcher.stop();
    }
}
