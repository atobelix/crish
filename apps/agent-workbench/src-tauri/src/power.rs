//! 进程级防休眠（Keep-Awake）：两级计数守卫 + 专用线程平台唤醒锁。
//!
//! 历史：本模块原为 G11a/PE-03 保留面——平台实现与命令面
//! `workbench_set_keep_awake` 并存，PE-03 裁决「删除注册、实现保留」后
//! `mod power;` 一并摘除，文件成未编译孤儿。2026-11-03 托盘/通知批按
//! 用户裁决复活：**只复活平台实现，命令面不复活**（防休眠是壳内部
//! 行为，由 prefs `keep_awake_during_tasks` 开关 + 事件面计数驱动，
//! 不再暴露前端命令）。
//!
//! # 架构（红线）
//!
//! `SetThreadExecutionState` 的状态归属**调用线程**且随线程退出失效，
//! 因此绝不在命令线程/事件线程直调：进程级 [KeepAwakeGuard] 是唯一
//! 入口，内部 spawn 一条常驻专用线程持有唤醒状态，计数面经 mpsc 向它
//! 投递「当前应保持的唤醒请求」([AwakeRequest])。需求归零时立即以
//! `ES_CONTINUOUS` 清除；进程退出时线程消亡自动失效（另在
//! `RunEvent::Exit` 显式 force_clear 兜底）。
//!
//! # 两级计数口径
//!
//! - **System 级**（底线）：任一 run / 后台工具 / 壳后台任务活跃 →
//!   `ES_SYSTEM_REQUIRED`，系统不睡（屏幕可睡）；
//! - **Display 级**（叠加）：仅电脑操作（computer-use）会话活跃时
//!   追加 `ES_DISPLAY_REQUIRED`，屏幕常亮（桌面自动化需要画面）。
//!
//! Display 活跃蕴含 System（屏幕亮着系统必然不睡）。用户开关
//! `keep_awake_during_tasks` 关闭时请求恒为空（计数照常维护，重新
//! 打开即恢复当前计数对应的请求）。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

/// 防休眠需求级别（喂数方按来源选择）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AwakeKind {
    /// 系统不睡（屏幕可睡）
    System,
    /// 屏幕常亮（蕴含系统不睡）
    Display,
}

/// 平台层实际需要保持的唤醒请求（纯值；由计数 + 开关推导，单测锁定）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AwakeRequest {
    /// 需要 `ES_SYSTEM_REQUIRED`
    pub system: bool,
    /// 需要 `ES_DISPLAY_REQUIRED`
    pub display: bool,
}

impl AwakeRequest {
    /// 无任何唤醒需求（仅 `ES_CONTINUOUS` 基线 = 清除）
    pub const NONE: Self = Self {
        system: false,
        display: false,
    };

    fn from_holds(system: &HashSet<String>, display: &HashSet<String>, enabled: bool) -> Self {
        if !enabled {
            return Self::NONE;
        }
        Self {
            system: !system.is_empty() || !display.is_empty(),
            display: !display.is_empty(),
        }
    }
}

/// 守卫线程消息（请求变更才投递；关闭时兜底清除）
enum GuardMsg {
    Apply(AwakeRequest),
    Shutdown,
}

/// 「进行中工作单元」计数（托盘状态行口径；纯函数——system 持有
/// 集合的**视图**，与防休眠计数同源同账，不另立第二套计数逻辑）：
///
/// - `run:{id}` → 1 个单元；
/// - `task:{id}` → 1 个单元；
/// - `tool:{runId}:{callId}` → 其 run 仍活跃时被该 run 单元涵盖
///   （不重复计）；run 已结束、工具脱离续跑时独立计 1；
/// - `tool:{callId}`（事件无 run 归属）→ 独立计 1。
pub fn count_active_work(system_holds: &HashSet<String>) -> usize {
    let mut run_ids: HashSet<&str> = HashSet::new();
    let mut units = 0usize;
    for key in system_holds {
        if let Some(run_id) = key.strip_prefix("run:") {
            run_ids.insert(run_id);
            units += 1;
        } else if key.starts_with("task:") {
            units += 1;
        }
    }
    for key in system_holds {
        if let Some(rest) = key.strip_prefix("tool:") {
            let covered_by_run = match rest.split_once(':') {
                Some((run_id, _)) => run_ids.contains(run_id),
                None => false,
            };
            if !covered_by_run {
                units += 1;
            }
        }
    }
    units
}

#[derive(Default)]
struct GuardInner {
    system_holds: HashSet<String>,
    display_holds: HashSet<String>,
    /// 已投递给守卫线程的最新请求（去重：不变不重发）
    last_sent: AwakeRequest,
    /// 已通知监听者的最新工作单元数（去重：不变不回调）
    last_work_count: usize,
}

/// 进程级防休眠守卫（计数面 + 开关面 → 专用线程平台状态）
///
/// 持有键语义：同一 `(kind, key)` 重复 acquire 幂等（集合语义），
/// release 不存在的键为空操作——喂数方无需自维护账本，终态事件
/// 即使先于起始事件到达也不会把计数打成负数。
pub struct KeepAwakeGuard {
    inner: Mutex<GuardInner>,
    enabled: AtomicBool,
    tx: mpsc::Sender<GuardMsg>,
    /// 工作单元数变化监听（托盘计数刷新；壳 setup 注入，单向通知）
    count_listener: Mutex<Option<Arc<dyn Fn(usize) + Send + Sync>>>,
}

impl KeepAwakeGuard {
    /// 构造并 spawn 常驻守卫线程（进程内单例，经 Tauri State 托管）
    pub fn new() -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<GuardMsg>();
        // 线程 spawn 失败（系统资源枯竭）时降级为无线程守卫：计数面
        // 照常工作、平台状态不保持——不因防休眠拖垮主进程启动。
        if let Err(error) = std::thread::Builder::new()
            .name("crish-keep-awake".to_string())
            .spawn(move || guard_thread(rx))
        {
            tracing::error!(
                target: "power",
                error = %error,
                "防休眠守卫线程 spawn 失败（防休眠不生效，不阻断启动）"
            );
        }
        Arc::new(Self {
            inner: Mutex::new(GuardInner::default()),
            enabled: AtomicBool::new(true),
            tx,
            count_listener: Mutex::new(None),
        })
    }

    /// 注册工作单元数变化监听（覆盖注册；计数不变不回调，回调在
    /// 锁外执行——监听者可安全回读守卫/其他状态）
    pub fn set_count_listener(&self, listener: Arc<dyn Fn(usize) + Send + Sync>) {
        *self
            .count_listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(listener);
    }

    /// 当前「进行中工作单元」数（[count_active_work] 口径；托盘计数
    /// 的唯一数据源——与唤醒持有同账读取）
    pub fn active_work_count(&self) -> usize {
        count_active_work(&self.lock_inner().system_holds)
    }

    /// 计数变化时通知监听者（acquire/release/force_clear 后调用；
    /// display 级持有不影响工作单元数，天然不触发）
    fn notify_work_count_changed(&self) {
        let listener = self
            .count_listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let Some(listener) = listener else {
            return;
        };
        let count = {
            let mut inner = self.lock_inner();
            let count = count_active_work(&inner.system_holds);
            if count == inner.last_work_count {
                return;
            }
            inner.last_work_count = count;
            count
        };
        listener(count);
    }

    /// 登记一份唤醒持有（key = 来源唯一键，如 `run:{runId}`）
    pub fn acquire(&self, kind: AwakeKind, key: &str) {
        {
            let mut inner = self.lock_inner();
            match kind {
                AwakeKind::System => {
                    inner.system_holds.insert(key.to_string());
                }
                AwakeKind::Display => {
                    inner.display_holds.insert(key.to_string());
                }
            }
        }
        self.push_current();
        self.notify_work_count_changed();
    }

    /// 释放一份唤醒持有（键不存在 = 空操作）
    pub fn release(&self, kind: AwakeKind, key: &str) {
        {
            let mut inner = self.lock_inner();
            match kind {
                AwakeKind::System => {
                    inner.system_holds.remove(key);
                }
                AwakeKind::Display => {
                    inner.display_holds.remove(key);
                }
            }
        }
        self.push_current();
        self.notify_work_count_changed();
    }

    /// 用户开关（prefs `keep_awake_during_tasks`）：关 → 立即清除平台
    /// 状态（计数保留）；开 → 按当前计数恢复请求
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        self.push_current();
    }

    /// 无条件清除全部持有并投递清除请求（RunEvent::Exit 兜底）
    pub fn force_clear(&self) {
        {
            let mut inner = self.lock_inner();
            inner.system_holds.clear();
            inner.display_holds.clear();
        }
        self.push_current();
        self.notify_work_count_changed();
    }

    /// 当前应保持的唤醒请求（计数 + 开关的纯推导；诊断/测试面）
    pub fn current_request(&self) -> AwakeRequest {
        let inner = self.lock_inner();
        AwakeRequest::from_holds(
            &inner.system_holds,
            &inner.display_holds,
            self.enabled.load(Ordering::SeqCst),
        )
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, GuardInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 请求变更时才向守卫线程投递（高频计数抖动不打扰平台调用）
    fn push_current(&self) {
        let request = self.current_request();
        let changed = {
            let mut inner = self.lock_inner();
            if inner.last_sent == request {
                false
            } else {
                inner.last_sent = request;
                true
            }
        };
        if changed {
            // 通道断开（线程已死）时静默：防休眠失效不影响主流程
            let _ = self.tx.send(GuardMsg::Apply(request));
        }
    }
}

impl Drop for KeepAwakeGuard {
    fn drop(&mut self) {
        let _ = self.tx.send(GuardMsg::Shutdown);
    }
}

/// 守卫线程主体：独占平台唤醒状态；收到请求即应用，关机/断开时清除
fn guard_thread(rx: mpsc::Receiver<GuardMsg>) {
    let mut current = AwakeRequest::NONE;
    while let Ok(msg) = rx.recv() {
        match msg {
            GuardMsg::Apply(request) => {
                if request != current {
                    if let Err(error) = platform::apply(request) {
                        tracing::warn!(
                            target: "power",
                            error = %error,
                            "平台唤醒状态应用失败"
                        );
                    } else {
                        tracing::debug!(
                            target: "power",
                            system = request.system,
                            display = request.display,
                            "防休眠唤醒状态已更新"
                        );
                    }
                    current = request;
                }
            }
            GuardMsg::Shutdown => break,
        }
    }
    // 线程退出前兜底清除（状态本随线程消亡，显式清一次保语义完整）
    if current != AwakeRequest::NONE {
        let _ = platform::apply(AwakeRequest::NONE);
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::AwakeRequest;

    // 豁免 unsafe_code：SetThreadExecutionState 是 Windows FFI 调用，
    // 仅传入布尔型 flags 常量组合，无指针参数、无内存所有权转移
    // （SAFETY：返回值 0 表示失败，已显式检查；状态归属调用线程，
    // 本函数只由守卫专用线程调用，见模块头红线）。
    #[allow(unsafe_code)]
    pub fn apply(request: AwakeRequest) -> Result<(), String> {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };
        let mut flags = ES_CONTINUOUS;
        if request.system {
            flags |= ES_SYSTEM_REQUIRED;
        }
        if request.display {
            flags |= ES_DISPLAY_REQUIRED;
        }
        let ret = unsafe { SetThreadExecutionState(flags) };
        if ret == 0 {
            Err("SetThreadExecutionState failed".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::AwakeRequest;

    pub fn apply(_request: AwakeRequest) -> Result<(), String> {
        // TODO: 使用 IOKit IOPMAssertionCreateWithName 实现（计数与线程
        // 模型已就绪，平台应用层待补；当前 macOS 不保持唤醒）
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::AwakeRequest;

    pub fn apply(_request: AwakeRequest) -> Result<(), String> {
        // TODO: 使用 DBus Inhibit / systemd-inhibit 实现（同 macOS 注记）
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_counting_and_idempotent_acquire() {
        let guard = KeepAwakeGuard::new();
        assert_eq!(guard.current_request(), AwakeRequest::NONE);

        guard.acquire(AwakeKind::System, "run:a");
        guard.acquire(AwakeKind::System, "run:b");
        // 同键重复 acquire 幂等（集合语义，不叠加计数）
        guard.acquire(AwakeKind::System, "run:a");
        assert_eq!(
            guard.current_request(),
            AwakeRequest {
                system: true,
                display: false
            }
        );

        guard.release(AwakeKind::System, "run:a");
        assert!(
            guard.current_request().system,
            "仍有 run:b 持有，系统唤醒应保持"
        );
        guard.release(AwakeKind::System, "run:b");
        assert_eq!(guard.current_request(), AwakeRequest::NONE);
        // 释放不存在的键为空操作（终态先于起始到达不打负计数）
        guard.release(AwakeKind::System, "run:b");
        assert_eq!(guard.current_request(), AwakeRequest::NONE);
    }

    #[test]
    fn display_hold_implies_system_request() {
        let guard = KeepAwakeGuard::new();
        guard.acquire(AwakeKind::Display, "computer-session");
        assert_eq!(
            guard.current_request(),
            AwakeRequest {
                system: true,
                display: true
            },
            "屏幕常亮必须蕴含系统不睡"
        );
        guard.release(AwakeKind::Display, "computer-session");
        assert_eq!(guard.current_request(), AwakeRequest::NONE);
    }

    #[test]
    fn two_levels_release_independently() {
        let guard = KeepAwakeGuard::new();
        guard.acquire(AwakeKind::System, "task:t1");
        guard.acquire(AwakeKind::Display, "computer-session");
        guard.release(AwakeKind::Display, "computer-session");
        assert_eq!(
            guard.current_request(),
            AwakeRequest {
                system: true,
                display: false
            },
            "Display 释放后 System 底线仍在"
        );
        guard.release(AwakeKind::System, "task:t1");
        assert_eq!(guard.current_request(), AwakeRequest::NONE);
    }

    #[test]
    fn disabled_suppresses_request_and_reenable_restores() {
        let guard = KeepAwakeGuard::new();
        guard.acquire(AwakeKind::System, "run:a");
        guard.set_enabled(false);
        assert_eq!(
            guard.current_request(),
            AwakeRequest::NONE,
            "开关关闭时请求恒为空（平台状态清除）"
        );
        guard.set_enabled(true);
        assert!(
            guard.current_request().system,
            "重新打开应按现存计数恢复请求"
        );
    }

    #[test]
    fn force_clear_releases_everything() {
        let guard = KeepAwakeGuard::new();
        guard.acquire(AwakeKind::System, "run:a");
        guard.acquire(AwakeKind::Display, "computer-session");
        guard.force_clear();
        assert_eq!(guard.current_request(), AwakeRequest::NONE);
    }

    #[test]
    fn active_work_count_classifies_holds() {
        let guard = KeepAwakeGuard::new();
        assert_eq!(guard.active_work_count(), 0);

        guard.acquire(AwakeKind::System, "run:a");
        guard.acquire(AwakeKind::System, "run:b");
        guard.acquire(AwakeKind::System, "task:t1");
        assert_eq!(guard.active_work_count(), 3, "两 run + 一 task");

        // run 内的后台工具被 run 单元涵盖，不重复计
        guard.acquire(AwakeKind::System, "tool:a:call-1");
        assert_eq!(guard.active_work_count(), 3);
        // run 结束后工具脱离续跑 → 独立计 1（总数不变，构成变化）
        guard.release(AwakeKind::System, "run:a");
        assert_eq!(guard.active_work_count(), 3, "run:b + task + 脱离工具");
        guard.release(AwakeKind::System, "tool:a:call-1");
        assert_eq!(guard.active_work_count(), 2);

        // 无 run 归属的工具独立计；display 持有不计工作单元
        guard.acquire(AwakeKind::System, "tool:call-x");
        guard.acquire(AwakeKind::Display, "computer-session");
        assert_eq!(guard.active_work_count(), 3);
    }

    #[test]
    fn count_listener_fires_only_on_change() {
        use std::sync::atomic::AtomicUsize;
        let guard = KeepAwakeGuard::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let last_seen = Arc::new(Mutex::new(usize::MAX));
        {
            let calls = Arc::clone(&calls);
            let last_seen = Arc::clone(&last_seen);
            guard.set_count_listener(Arc::new(move |count| {
                calls.fetch_add(1, Ordering::SeqCst);
                *last_seen.lock().unwrap() = count;
            }));
        }
        guard.acquire(AwakeKind::System, "run:a");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(*last_seen.lock().unwrap(), 1);
        // 同 run 的工具涵盖不改总数 → 不回调
        guard.acquire(AwakeKind::System, "tool:a:call-1");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // display 持有不影响工作数 → 不回调
        guard.acquire(AwakeKind::Display, "computer-session");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        guard.release(AwakeKind::System, "run:a");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "工具脱离续跑，总数仍 1");
        guard.release(AwakeKind::System, "tool:a:call-1");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(*last_seen.lock().unwrap(), 0);
    }

    /// 守卫线程往返烟测：acquire/release/drop 不 panic、不死锁
    /// （Windows 上会真实调用 SetThreadExecutionState——状态归属测试
    /// 线程 spawn 的守卫线程，随其退出自动失效，无残留）
    #[test]
    fn guard_thread_roundtrip_smoke() {
        let guard = KeepAwakeGuard::new();
        guard.acquire(AwakeKind::System, "run:smoke");
        guard.acquire(AwakeKind::Display, "computer-session");
        guard.force_clear();
        drop(guard);
    }
}
