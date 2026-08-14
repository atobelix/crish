//! snapshotVersion 跟踪器（维度 11 §5.4，R-1 per-tab 修订版）
//!
//! - 版本号**按标签页独立**：`snapshot_version(tab_id) -> u64`，单调递增只增不减
//! - 会话级辅助 `global_epoch`（AtomicU64）：重连/崩溃重启跳变，全部标签版本失效
//! - 推进判定：纯函数 `should_bump`（§5.4 判定清单全表）+ `on_event` 合并窗口实现
//! - 合并窗口：200ms（`VERSION_BUMP_COALESCE`，R-1 撤销 50ms）内任意次 DOM 变更
//!   只推进一次；导航类事件写入时若有 pending 窗口 → 导航语义立即提交并清窗口
//! - 显式推进（R-1）：用户输入注入 / AI 动作执行 → `bump(tab, reason)` 即时 +1
//! - 重连/崩溃重启：全部标签 +1000 + `global_epoch`+1 + 广播 `VersionReset`
//!   （旧版本一律 Stale）；Lagged 自愈（U-2）走同一路径
//! - 校验接口：`validate_snapshot(tab_id, version) -> Result<(), Stale>`
//!   （维度 13/14/15 共用契约）

use crate::cdp::bus::{BrowserEvent, VersionReason};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

/// DOM 变更合并窗口（200ms，R-1 撤销 50ms）。
pub const VERSION_BUMP_COALESCE: Duration = Duration::from_millis(200);
/// 重连/崩溃重启跳变量（全部标签 +1000）。
pub const VERSION_RESET_DELTA: u64 = 1000;

/// 标签页标识（= TargetId）。
pub type TabId = String;

/// 快照过期判定（旧版本 < 当前版本即 Stale；含 epoch 供审计追溯）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stale {
    pub tab_id: TabId,
    /// 调用方持有的版本
    pub expected: u64,
    /// 当前实际版本
    pub current: u64,
    pub epoch: u64,
}

/// 推进规格（`should_bump` 输出；tab 与 session 至少其一）。
#[derive(Debug, Clone)]
pub(crate) struct BumpSpec {
    pub tab: Option<TabId>,
    pub session: Option<String>,
    pub reason: VersionReason,
    /// true = 归入 200ms 合并窗口；false = 即时提交
    pub coalesce: bool,
}

/// 合并窗口条目。
struct PendingBump {
    tab: TabId,
    reason: VersionReason,
    /// 窗口代数：flush 任务醒来时仅提交同代条目（防陈旧任务误提交）
    gen: u64,
}

struct Inner {
    tabs: HashMap<TabId, u64>,
    session_to_tab: HashMap<String, TabId>,
    /// 合并窗口槽位（H2 修复：单槽 → 按 tab 分槽）。
    /// 单槽时同窗口内不同标签的 DOM 变更互相顶替（陈旧 flush 取走新条目后
    /// 丢弃 → 版本推进丢失）；分槽后每标签独立窗口，互不干扰。
    pending: HashMap<TabId, PendingBump>,
}

/// per-tab 版本跟踪器（Arc 共享；锁纪律 B8：全部恢复式，不 panic）。
pub struct VersionTracker {
    inner: Arc<Mutex<Inner>>,
    epoch: Arc<AtomicU64>,
    gen: AtomicU64,
    watch_tx: watch::Sender<HashMap<TabId, u64>>,
    bus_tx: broadcast::Sender<BrowserEvent>,
    coalesce: Duration,
}

impl VersionTracker {
    /// 新建跟踪器（合并窗口可注入，测试用）。
    pub fn new(bus_tx: broadcast::Sender<BrowserEvent>, coalesce: Duration) -> Self {
        VersionTracker {
            inner: Arc::new(Mutex::new(Inner {
                tabs: HashMap::new(),
                session_to_tab: HashMap::new(),
                pending: HashMap::new(),
            })),
            epoch: Arc::new(AtomicU64::new(0)),
            gen: AtomicU64::new(0),
            watch_tx: watch::channel(HashMap::new()).0,
            bus_tx,
            coalesce,
        }
    }

    /// 事件驱动推进（由版本驱动任务调用；SessionAttached 登记会话映射）。
    pub fn on_event(&self, event: &BrowserEvent) {
        // 会话 ↔ 标签映射登记（双层路由建立点）
        if let BrowserEvent::SessionAttached { target_id, session } = event {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner
                .session_to_tab
                .insert(session.clone(), target_id.clone());
            return;
        }
        let Some(spec) = should_bump(event) else {
            return;
        };
        // tab 解析优先级：事件自带 tab（TargetDestroyed）→ 会话映射 → 会话兜底
        let tab = spec.tab.clone().or_else(|| {
            spec.session
                .as_ref()
                .map(|s| self.tab_of(s).unwrap_or_else(|| s.clone()))
        });
        let Some(tab) = tab else {
            return;
        };

        if spec.coalesce {
            // —— 合并窗口：同 tab 已有 pending 则合并（不重复计数）；
            //    不同 tab 各占独立槽位（H2：互不顶替）——
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.pending.contains_key(&tab) {
                return;
            }
            let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
            inner.pending.insert(
                tab.clone(),
                PendingBump {
                    tab: tab.clone(),
                    reason: spec.reason,
                    gen,
                },
            );
            self.spawn_flush(tab, gen);
        } else {
            // —— 即时推进：若有同 tab pending 窗口 → 先提交（导航优先于内容合并）；
            //    其他标签的窗口留在各自槽位，不影响——
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(p) = inner.pending.remove(&tab) {
                commit_bump_locked(&mut inner, &self.watch_tx, &self.bus_tx, &p.tab, p.reason);
            }
            commit_bump_locked(&mut inner, &self.watch_tx, &self.bus_tx, &tab, spec.reason);
        }
    }

    /// 显式推进（用户输入注入 / AI 动作执行成功，R-1：即时 +1，无聚合窗）。
    pub fn bump(&self, tab_id: &str, reason: VersionReason) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        commit_bump_locked(&mut inner, &self.watch_tx, &self.bus_tx, tab_id, reason);
    }

    /// 重连恢复 / 崩溃重启：全部标签 +1000 + global_epoch+1 + 广播 VersionReset。
    pub fn reset(&self, reason: VersionReason) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.pending.clear(); // 清全部窗口槽位
        for v in inner.tabs.values_mut() {
            *v += VERSION_RESET_DELTA;
        }
        let epoch = self.epoch.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.watch_tx.send(inner.tabs.clone());
        let _ = self
            .bus_tx
            .send(BrowserEvent::VersionReset { epoch, reason });
    }

    /// 版本跟踪器自身 Lagged 的重对齐（U-2）：全量失效 + epoch 跳变。
    pub fn on_lagged(&self) {
        tracing::warn!("版本跟踪器落后于事件流，触发全量重对齐（VersionReset）");
        self.reset(VersionReason::LaggedResync);
    }

    /// 当前标签版本（未知标签 = 0）。
    pub fn snapshot_version(&self, tab_id: &str) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .tabs
            .get(tab_id)
            .copied()
            .unwrap_or(0)
    }

    /// 校验快照版本（旧版本一律 Stale，含 VersionReset 跳变后的全部旧值）。
    pub fn validate_snapshot(&self, tab_id: &str, version: u64) -> Result<(), Stale> {
        let current = self.snapshot_version(tab_id);
        if version < current {
            Err(Stale {
                tab_id: tab_id.to_string(),
                expected: version,
                current,
                epoch: self.epoch(),
            })
        } else {
            Ok(())
        }
    }

    /// 会话 → 标签映射登记（恢复流程 attach 后由 SessionAttached 事件自动登记；
    /// 本方法供需要预登记的调用方使用）。
    pub fn track_session(&self, session: &str, tab_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .session_to_tab
            .insert(session.to_string(), tab_id.to_string());
    }

    /// 已知标签列表。
    pub fn tab_ids(&self) -> Vec<TabId> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .tabs
            .keys()
            .cloned()
            .collect()
    }

    /// global_epoch（跨标签事件语义）。
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    /// epoch 原子句柄（transport 广播 ConnectionRestored 时读取）。
    pub fn epoch_handle(&self) -> Arc<AtomicU64> {
        self.epoch.clone()
    }

    /// 版本快照 watch 订阅（维度 13 采集任务等消费者）。
    pub fn subscribe_versions(&self) -> watch::Receiver<HashMap<TabId, u64>> {
        self.watch_tx.subscribe()
    }

    fn tab_of(&self, session: &str) -> Option<TabId> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .session_to_tab
            .get(session)
            .cloned()
    }

    /// 启动合并窗口 flush 任务（代数校验防陈旧提交；按 tab 绑定各自槽位）。
    fn spawn_flush(&self, tab: TabId, gen: u64) {
        let inner = self.inner.clone();
        let watch_tx = self.watch_tx.clone();
        let bus_tx = self.bus_tx.clone();
        let coalesce = self.coalesce;
        tokio::spawn(async move {
            tokio::time::sleep(coalesce).await;
            commit_pending(&inner, &watch_tx, &bus_tx, &tab, gen);
        });
    }
}

/// flush 任务：窗口到期提交（仅提交本任务所属标签槽位的同代条目；
/// H2：先 remove 再校验代次，不匹配放回——陈旧任务不得吞掉新窗口）。
fn commit_pending(
    inner: &Mutex<Inner>,
    watch_tx: &watch::Sender<HashMap<TabId, u64>>,
    bus_tx: &broadcast::Sender<BrowserEvent>,
    tab: &str,
    gen: u64,
) {
    let mut guard = inner.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(p) = guard.pending.remove(tab) {
        if p.gen == gen {
            commit_bump_locked(&mut guard, watch_tx, bus_tx, &p.tab, p.reason);
        } else {
            // 该标签窗口已被更新代次顶替：放回，等新代次任务提交
            guard.pending.insert(tab.to_string(), p);
        }
    }
}

/// 提交推进：原子 +1 → watch send → 广播 VersionAdvanced（§5.4 提交动作）。
fn commit_bump_locked(
    inner: &mut Inner,
    watch_tx: &watch::Sender<HashMap<TabId, u64>>,
    bus_tx: &broadcast::Sender<BrowserEvent>,
    tab_id: &str,
    reason: VersionReason,
) {
    let current = inner.tabs.get(tab_id).copied().unwrap_or(0);
    let to = current + 1;
    inner.tabs.insert(tab_id.to_string(), to);
    let _ = watch_tx.send(inner.tabs.clone());
    let _ = bus_tx.send(BrowserEvent::VersionAdvanced {
        tab_id: tab_id.to_string(),
        from: current,
        to,
        reason,
    });
}

/// 推进判定清单（§5.4 全表；分类 router 之后、跟踪器之前的一道纯函数）。
///
/// 推进：导航即时；DOM 变更/iframe 生命周期/load 归窗口；对话框恒推进；
/// 不推进：console/pageError/network/执行环境/滚动/心跳/连接面（R-1 修订版）。
pub(crate) fn should_bump(event: &BrowserEvent) -> Option<BumpSpec> {
    match event {
        // #1 全量导航：即时 +1
        BrowserEvent::Navigated {
            session,
            main: true,
            ..
        } => Some(BumpSpec {
            tab: None,
            session: Some(session.clone()),
            reason: VersionReason::Navigation,
            coalesce: false,
        }),
        // #10 iframe 导航：内容变更，归入 DOM 窗口
        BrowserEvent::Navigated {
            session,
            main: false,
            ..
        } => Some(BumpSpec {
            tab: None,
            session: Some(session.clone()),
            reason: VersionReason::IframeLifecycle,
            coalesce: true,
        }),
        // #2 SPA pushState/hash：即时 +1
        BrowserEvent::NavigatedWithinDocument { session, .. } => Some(BumpSpec {
            tab: None,
            session: Some(session.clone()),
            reason: VersionReason::SpaNavigation,
            coalesce: false,
        }),
        // #5 首载完成（loadEventFired）：归窗口（重连恢复场景兜底「页面就绪」）
        BrowserEvent::Lifecycle {
            session,
            kind: crate::cdp::bus::LifecycleKind::Load,
            ..
        } => Some(BumpSpec {
            tab: None,
            session: Some(session.clone()),
            reason: VersionReason::IframeLifecycle,
            coalesce: true,
        }),
        // #3 DOM 变更任意子类：合并窗口 +1
        BrowserEvent::DomChanged { session, .. } => Some(BumpSpec {
            tab: None,
            session: Some(session.clone()),
            reason: VersionReason::DomChange,
            coalesce: true,
        }),
        // #4 frameAttached/frameDetached：已归入 DomChanged 子类（合并窗口）
        // #11 对话框出现/关闭：恒推进（即时，宁多勿漏）
        BrowserEvent::DialogOpened(info) => Some(BumpSpec {
            tab: None,
            session: Some(info.session.clone()),
            reason: VersionReason::Dialog,
            coalesce: false,
        }),
        BrowserEvent::DialogClosed { session, .. } => Some(BumpSpec {
            tab: None,
            session: Some(session.clone()),
            reason: VersionReason::Dialog,
            coalesce: false,
        }),
        // #8 活动标签关闭：即时 +1（页面消失即旧快照失效）
        BrowserEvent::TargetDestroyed { target_id } => Some(BumpSpec {
            tab: Some(target_id.clone()),
            session: None,
            reason: VersionReason::TargetDestroyed,
            coalesce: false,
        }),
        // #12/#13/#14/#15 不推进：console/network/滚动（无事件面）/心跳/连接面/执行环境
        BrowserEvent::Console { .. }
        | BrowserEvent::PageError { .. }
        | BrowserEvent::NetworkRequest { .. }
        | BrowserEvent::NetworkDone { .. }
        | BrowserEvent::ConnectionLost { .. }
        | BrowserEvent::Lifecycle {
            kind: crate::cdp::bus::LifecycleKind::DomContent,
            ..
        }
        | BrowserEvent::ConnectionRestored { .. }
        | BrowserEvent::TargetCreated(_)
        | BrowserEvent::TargetInfoChanged(_)
        | BrowserEvent::SessionAttached { .. }
        | BrowserEvent::NavigationStarted { .. }
        | BrowserEvent::WindowOpenRequested { .. }
        | BrowserEvent::TargetsReconciled { .. }
        | BrowserEvent::VersionAdvanced { .. }
        | BrowserEvent::VersionReset { .. }
        | BrowserEvent::FileChooserOpened { .. } => None,
    }
}

/// 版本驱动任务：typed 事件 → 推进；ConnectionRestored → VersionReset（R-1 跳变）；
/// Lagged → 全量重对齐（U-2）。
pub fn spawn_version_driver(
    mut rx: broadcast::Receiver<BrowserEvent>,
    tracker: Arc<VersionTracker>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if matches!(event, BrowserEvent::ConnectionRestored { .. }) {
                        tracker.reset(VersionReason::Reconnected);
                    } else {
                        tracker.on_event(&event);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => tracker.on_lagged(),
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::bus::{BusHandle, ConsoleLevel, DomChangeKind, LifecycleKind};

    fn test_tracker(coalesce: Duration) -> (Arc<VersionTracker>, BusHandle) {
        let bus = BusHandle::new(64, 4);
        (Arc::new(VersionTracker::new(bus.event_tx(), coalesce)), bus)
    }

    fn console_event() -> BrowserEvent {
        BrowserEvent::Console {
            session: "s1".to_string(),
            level: ConsoleLevel::Log,
            text: "hello".to_string(),
            url: None,
            line: None,
        }
    }

    fn nav_event(session: &str, main: bool) -> BrowserEvent {
        BrowserEvent::Navigated {
            session: session.to_string(),
            frame: "F1".to_string(),
            url: "https://e.com".to_string(),
            main,
        }
    }

    fn dom_event(session: &str) -> BrowserEvent {
        BrowserEvent::DomChanged {
            session: session.to_string(),
            kind: DomChangeKind::CharacterDataModified,
        }
    }

    /// 验收 9.1-15：frameNavigated 主 frame → 即时 +1 且 VersionAdvanced 广播
    /// （per-tab，带 tab_id）
    #[tokio::test]
    async fn version_nav_bumps_immediately() {
        let (tracker, bus) = test_tracker(VERSION_BUMP_COALESCE);
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");

        tracker.on_event(&nav_event("s1", true));

        assert_eq!(tracker.snapshot_version("tab-1"), 1, "主导航应即时 +1");
        let got = rx.recv().await.expect("应广播 VersionAdvanced");
        assert_eq!(
            got,
            BrowserEvent::VersionAdvanced {
                tab_id: "tab-1".to_string(),
                from: 0,
                to: 1,
                reason: VersionReason::Navigation,
            }
        );
    }

    /// 验收 9.1-16：200ms 窗口内 50 次 DomChanged → 仅 +1
    #[tokio::test]
    async fn version_dom_storm_merged() {
        let (tracker, bus) = test_tracker(Duration::from_millis(200));
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");

        for _ in 0..50 {
            tracker.on_event(&dom_event("s1"));
        }
        // 窗口未到期：版本不变（pending 合并中）
        assert_eq!(tracker.snapshot_version("tab-1"), 0, "窗口期内不得提交");

        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(tracker.snapshot_version("tab-1"), 1, "窗口合并应仅推进一次");

        // 仅一次 VersionAdvanced（窗口期内任意次 DOM 变更只推进一次）
        let mut advanced = 0;
        loop {
            match rx.try_recv() {
                Ok(BrowserEvent::VersionAdvanced { .. }) => advanced += 1,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        assert_eq!(advanced, 1, "50 次变更只允许 1 次版本推进");
    }

    /// 验收 9.1-17：窗口内导航事件 → 导航语义即时提交（先清窗口再导航）
    #[tokio::test]
    async fn version_nav_preempts_window() {
        let (tracker, bus) = test_tracker(Duration::from_millis(500));
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");

        tracker.on_event(&dom_event("s1")); // 开窗口
        assert_eq!(tracker.snapshot_version("tab-1"), 0);
        tracker.on_event(&nav_event("s1", true)); // 导航抢占：窗口立即提交 + 导航 +1

        // 导航返回前（窗口远未到期）版本应已 = 2（1 次窗口提交 + 1 次导航）
        assert_eq!(
            tracker.snapshot_version("tab-1"),
            2,
            "导航应优先提交并清窗口"
        );

        // 两个 VersionAdvanced 都应已广播（无需等窗口到期）
        let mut advanced = 0;
        for _ in 0..2 {
            match rx.try_recv() {
                Ok(BrowserEvent::VersionAdvanced { .. }) => advanced += 1,
                other => panic!("应收到 VersionAdvanced，实际 {other:?}"),
            }
        }
        assert_eq!(advanced, 2);

        // 窗口到期后不得重复提交
        tokio::time::sleep(Duration::from_millis(550)).await;
        assert_eq!(
            tracker.snapshot_version("tab-1"),
            2,
            "窗口已清，不得重复提交"
        );
    }

    /// 验收 9.1-18：console/network/滚动/心跳 → 版本不变
    #[tokio::test]
    async fn version_console_not_bump() {
        let (tracker, _bus) = test_tracker(VERSION_BUMP_COALESCE);
        tracker.track_session("s1", "tab-1");

        tracker.on_event(&console_event());
        tracker.on_event(&BrowserEvent::PageError {
            session: "s1".to_string(),
            text: "err".to_string(),
            url: None,
            line: None,
        });
        tracker.on_event(&BrowserEvent::NetworkRequest {
            request_id: "r1".to_string(),
            url: "https://e.com".to_string(),
            method: "GET".to_string(),
            status: None,
        });
        tracker.on_event(&BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
            size: None,
        });
        tracker.on_event(&BrowserEvent::Lifecycle {
            session: "s1".to_string(),
            frame: String::new(),
            kind: LifecycleKind::DomContent,
        });
        tracker.on_event(&BrowserEvent::ConnectionLost { attempt: 1 });
        tracker.on_event(&BrowserEvent::TargetInfoChanged(
            crate::cdp::domains::TargetInfo {
                target_id: "tab-1".to_string(),
                target_type: "page".to_string(),
                title: "t".to_string(),
                url: "u".to_string(),
                attached: None,
                browser_context_id: None,
                opener_id: None,
            },
        ));

        // 滚动不推进（R-1 撤销滚动 bump）：无滚动事件面，窗口内也不得推进
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            tracker.snapshot_version("tab-1"),
            0,
            "console/network/生命周期/连接面一律不推进"
        );
        assert_eq!(tracker.epoch(), 0);
    }

    /// 验收 9.1-19：用户输入注入 / AI 动作 bump → 即时 +1；DialogOpened/Closed →
    /// 恒推进（撤销滚动 bump 回归，R-1）
    #[tokio::test]
    async fn version_inject_and_dialog_bump() {
        let (tracker, bus) = test_tracker(VERSION_BUMP_COALESCE);
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");

        // 显式推进：输入注入 / AI 动作（即时，无聚合窗）
        tracker.bump("tab-1", VersionReason::InputInjected);
        tracker.bump("tab-1", VersionReason::ActionDone);
        assert_eq!(tracker.snapshot_version("tab-1"), 2);

        // 对话框出现/关闭：恒推进（宁多勿漏）
        tracker.on_event(&BrowserEvent::DialogOpened(crate::cdp::bus::DialogInfo {
            session: "s1".to_string(),
            dialog_type: "alert".to_string(),
            message: "hi".to_string(),
            url: "https://e.com".to_string(),
            default_prompt: None,
        }));
        assert_eq!(tracker.snapshot_version("tab-1"), 3, "DialogOpened 恒推进");
        tracker.on_event(&BrowserEvent::DialogClosed {
            session: "s1".to_string(),
            accepted: true,
        });
        assert_eq!(tracker.snapshot_version("tab-1"), 4, "DialogClosed 恒推进");

        // 对话框推进无需等待窗口（即时提交）：按序消费 3 个 VersionAdvanced，
        // 最后一个应是 DialogOpened 的推进（from 2 → to 3）
        let _ = rx.recv().await.expect("应广播 VersionAdvanced"); // InputInjected 0→1
        let _ = rx.recv().await.expect("应广播 VersionAdvanced"); // ActionDone 1→2
        let got = rx.recv().await.expect("应广播 VersionAdvanced"); // DialogOpened 2→3
        assert_eq!(
            got,
            BrowserEvent::VersionAdvanced {
                tab_id: "tab-1".to_string(),
                from: 2,
                to: 3,
                reason: VersionReason::Dialog,
            }
        );
    }

    /// validate_snapshot 语义（旧版本 Stale；VersionReset 后全部旧值作废）。
    #[tokio::test]
    async fn version_validate_and_reset() {
        let (tracker, bus) = test_tracker(VERSION_BUMP_COALESCE);
        let mut rx = bus.subscribe();

        tracker.bump("tab-1", VersionReason::ActionDone);
        assert!(tracker.validate_snapshot("tab-1", 1).is_ok());
        assert!(
            tracker.validate_snapshot("tab-1", 0).is_err(),
            "旧版本应 Stale"
        );
        // 先消费 bump 的 VersionAdvanced
        let _ = rx.recv().await.expect("应广播 VersionAdvanced");

        tracker.reset(VersionReason::Reconnected);
        assert_eq!(tracker.snapshot_version("tab-1"), 1001);
        assert_eq!(tracker.epoch(), 1);
        assert!(tracker.validate_snapshot("tab-1", 1).is_err());
        assert!(tracker.validate_snapshot("tab-1", 1001).is_ok());

        let got = rx.recv().await.expect("应广播 VersionReset");
        assert_eq!(
            got,
            BrowserEvent::VersionReset {
                epoch: 1,
                reason: VersionReason::Reconnected,
            }
        );
    }

    // ---------- 多标签/多会话并发隔离（评审 P2 补强） ----------

    /// per-tab 版本互不污染：显式 bump 只推进目标标签，其余标签版本为零。
    #[tokio::test]
    async fn version_bump_per_tab_no_pollution() {
        let (tracker, bus) = test_tracker(VERSION_BUMP_COALESCE);
        let mut rx = bus.subscribe();
        tracker.bump("tab-1", VersionReason::InputInjected);
        tracker.bump("tab-1", VersionReason::InputInjected);
        tracker.bump("tab-1", VersionReason::ActionDone);
        tracker.bump("tab-2", VersionReason::ActionDone);
        tracker.bump("tab-2", VersionReason::InputInjected);
        // 计数严格按标签独立
        assert_eq!(tracker.snapshot_version("tab-1"), 3);
        assert_eq!(tracker.snapshot_version("tab-2"), 2);
        assert_eq!(
            tracker.snapshot_version("tab-未出现"),
            0,
            "未出现标签不得有版本"
        );
        // 广播的 VersionAdvanced 必须携带各自 tab_id（跨标签不串号）
        let mut advanced = 0;
        for _ in 0..5 {
            match rx.recv().await {
                Ok(BrowserEvent::VersionAdvanced { tab_id, .. }) => {
                    assert!(
                        tab_id == "tab-1" || tab_id == "tab-2",
                        "tab_id 必须正确：{tab_id}"
                    );
                    advanced += 1;
                }
                other => panic!("应收到 VersionAdvanced：{other:?}"),
            }
        }
        assert_eq!(advanced, 5);
    }

    /// 会话 → 标签路由隔离：不同会话映射不同标签时，事件驱动推进互不干扰
    /// （导航即时面 + 对话框恒推进面 + 顺序 DOM 窗口面）。
    #[tokio::test]
    async fn version_session_isolation_between_tabs() {
        let (tracker, bus) = test_tracker(Duration::from_millis(50));
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");
        tracker.track_session("s2", "tab-2");

        // 导航（即时面）：s1 推进两次、s2 一次 → 各自计数
        tracker.on_event(&nav_event("s1", true));
        tracker.on_event(&nav_event("s1", true));
        tracker.on_event(&nav_event("s2", true));
        assert_eq!(tracker.snapshot_version("tab-1"), 2, "s1 导航只推 tab-1");
        assert_eq!(tracker.snapshot_version("tab-2"), 1, "s2 导航只推 tab-2");

        // 对话框会话隔离（恒推进即时面）：s1 的 dialog 不碰 tab-2
        tracker.on_event(&BrowserEvent::DialogOpened(crate::cdp::bus::DialogInfo {
            session: "s1".to_string(),
            dialog_type: "alert".to_string(),
            message: "hi".to_string(),
            url: "https://e.com".to_string(),
            default_prompt: None,
        }));
        tracker.on_event(&BrowserEvent::DialogClosed {
            session: "s1".to_string(),
            accepted: true,
        });
        assert_eq!(tracker.snapshot_version("tab-1"), 4);
        assert_eq!(
            tracker.snapshot_version("tab-2"),
            1,
            "s1 对话框不得污染 tab-2"
        );

        // 顺序 DOM 窗口：窗口各自闭合后，两标签各推进一次（跨标签互不合并）
        tracker.on_event(&dom_event("s1"));
        tokio::time::sleep(Duration::from_millis(80)).await;
        tracker.on_event(&dom_event("s2"));
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(tracker.snapshot_version("tab-1"), 5, "s1 DOM 窗口独立提交");
        assert_eq!(tracker.snapshot_version("tab-2"), 2, "s2 DOM 窗口独立提交");

        // 消费广播（确保无乱入的跨标签推进事件）
        let mut advanced = 0;
        for _ in 0..7 {
            match rx.recv().await {
                Ok(BrowserEvent::VersionAdvanced { .. }) => advanced += 1,
                other => panic!("应收到 VersionAdvanced：{other:?}"),
            }
        }
        assert_eq!(advanced, 7, "推进广播总数与版本总量一致（无泄漏推进）");
    }

    /// TargetDestroyed 跨标签推进：关闭 tab-2 只推进 tab-2，不影响 tab-1。
    #[tokio::test]
    async fn version_target_destroyed_cross_tab() {
        let (tracker, _bus) = test_tracker(VERSION_BUMP_COALESCE);
        tracker.bump("tab-1", VersionReason::InputInjected);
        tracker.on_event(&BrowserEvent::TargetDestroyed {
            target_id: "tab-2".to_string(),
        });
        assert_eq!(
            tracker.snapshot_version("tab-1"),
            1,
            "tab-2 关闭不得推进 tab-1"
        );
        assert_eq!(tracker.snapshot_version("tab-2"), 1, "tab-2 关闭即时 +1");
        // 再关 tab-1 → 各自 +1（独立计数链）
        tracker.on_event(&BrowserEvent::TargetDestroyed {
            target_id: "tab-1".to_string(),
        });
        assert_eq!(tracker.snapshot_version("tab-1"), 2);
        assert_eq!(tracker.snapshot_version("tab-2"), 1);
    }

    /// 同标签多会话（主 frame + iframe 双会话路由到同一标签）：
    /// 会话层各自驱动、标签层版本同向累计。
    #[tokio::test]
    async fn version_same_tab_multi_session_accumulates() {
        let (tracker, _bus) = test_tracker(Duration::from_millis(50));
        tracker.track_session("s-main", "tab-1");
        tracker.track_session("s-iframe", "tab-1");

        // iframe 导航（归窗口）→ 提交后落在 tab-1
        tracker.on_event(&nav_event("s-iframe", false));
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            tracker.snapshot_version("tab-1"),
            1,
            "iframe 会话导航累计到同一标签"
        );
        // 主 frame 导航（即时面）→ 同一标签再 +1
        tracker.on_event(&nav_event("s-main", true));
        assert_eq!(tracker.snapshot_version("tab-1"), 2);
        assert_eq!(
            tracker.snapshot_version("tab-2"),
            0,
            "未登记会话不得产生版本"
        );
    }

    /// validate_snapshot 的 per-tab 独立性：一标签的推进不使另一标签的合法版本失效。
    #[tokio::test]
    async fn version_validate_is_per_tab() {
        let (tracker, _bus) = test_tracker(VERSION_BUMP_COALESCE);
        tracker.bump("tab-1", VersionReason::ActionDone);
        tracker.bump("tab-1", VersionReason::ActionDone);
        tracker.bump("tab-2", VersionReason::ActionDone);
        // tab-1 当前 2：其旧版本 1 失效、自身 2 有效
        assert!(tracker.validate_snapshot("tab-1", 2).is_ok());
        assert!(tracker.validate_snapshot("tab-1", 1).is_err());
        // tab-2 当前 1：tab-1 的推进不影响它
        assert!(
            tracker.validate_snapshot("tab-2", 1).is_ok(),
            "tab-1 推进不得失效 tab-2"
        );
        assert!(tracker.validate_snapshot("tab-2", 0).is_err());
    }

    // ---------- H2 回归（合并窗口 per-tab 分槽，评审 29-H2 + F3 同源补强） ----------

    /// H2 主回归：同一 200ms 窗口内两个标签先后 DOM 变更 → 窗口到期后**各自 +1**。
    /// 修复前 pending 为单槽：tab-2 的变更顶替 tab-1 的 pending，且陈旧 flush
    /// 取走新条目后直接丢弃 → tab-1 推进永久丢失。
    #[tokio::test]
    async fn version_dual_tab_window_both_advance() {
        let (tracker, bus) = test_tracker(Duration::from_millis(50));
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");
        tracker.track_session("s2", "tab-2");

        tracker.on_event(&dom_event("s1")); // tab-1 开窗口
        tracker.on_event(&dom_event("s2")); // tab-2 开窗口（分槽，不得顶替 tab-1）
        assert_eq!(tracker.snapshot_version("tab-1"), 0, "窗口期内不得提交");
        assert_eq!(tracker.snapshot_version("tab-2"), 0, "窗口期内不得提交");

        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(tracker.snapshot_version("tab-1"), 1, "tab-1 窗口独立提交");
        assert_eq!(
            tracker.snapshot_version("tab-2"),
            1,
            "tab-2 窗口独立提交（H2：不得被吞掉）"
        );

        // 恰好两个 VersionAdvanced，各自携带正确的 tab_id
        let mut advanced = 0;
        for _ in 0..2 {
            match rx.recv().await {
                Ok(BrowserEvent::VersionAdvanced { tab_id, .. }) => {
                    assert!(
                        tab_id == "tab-1" || tab_id == "tab-2",
                        "tab_id 必须正确：{tab_id}"
                    );
                    advanced += 1;
                }
                other => panic!("应收到 VersionAdvanced：{other:?}"),
            }
        }
        assert_eq!(advanced, 2, "双标签各推进一次，不得丢失/重复");
    }

    /// H2 次级回归：同标签窗口被导航抢占后重开新窗口——陈旧 flush 醒来时
    /// 不得吞掉新窗口条目（修复前：取走 gen 不匹配条目后直接丢弃）。
    #[tokio::test]
    async fn version_stale_flush_does_not_consume_new_window() {
        let (tracker, bus) = test_tracker(Duration::from_millis(30));
        let mut rx = bus.subscribe();
        tracker.track_session("s1", "tab-1");

        tracker.on_event(&dom_event("s1")); // 窗口1（gen=1，flush1 启动）
        tracker.on_event(&nav_event("s1", true)); // 导航抢占：窗口1 提交 + 导航 +1 → v=2
        assert_eq!(tracker.snapshot_version("tab-1"), 2);
        tracker.on_event(&dom_event("s1")); // 新窗口2（gen=2，flush2 启动）

        // flush1（陈旧）与 flush2 都已醒来：新窗口必须由 flush2 提交
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            tracker.snapshot_version("tab-1"),
            3,
            "陈旧 flush 不得吞掉新窗口（H2）"
        );

        // 恰好 3 次推进（窗口1 + 导航 + 窗口2），无多余提交
        let mut advanced = 0;
        for _ in 0..3 {
            match rx.recv().await {
                Ok(BrowserEvent::VersionAdvanced { .. }) => advanced += 1,
                other => panic!("应收到 VersionAdvanced：{other:?}"),
            }
        }
        assert_eq!(advanced, 3);
    }
}
