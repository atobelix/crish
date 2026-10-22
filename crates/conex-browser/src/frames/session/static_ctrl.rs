//! 静态降级轮询控制器（自 session.rs 平移）。

use super::types::{ScreencastConfig, ScreencastEvent, StatsInner};
use crate::frames::degrade::{static_poll_loop, StaticPollCtx};
use crate::frames::sink::FrameSink;
use crate::BrowserSession;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

/// 静态降级轮询控制器（U-3：screencast 不可用 → 1fps captureScreenshot 轮询）。
/// 活动旗标幂等防重入（enter 已在轮询时直接返回）；任务句柄供退出时 abort。
pub(crate) struct StaticController {
    active: AtomicBool,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    session: Arc<BrowserSession>,
    sink: Arc<FrameSink>,
    stats: Arc<StatsInner>,
    events: broadcast::Sender<ScreencastEvent>,
    config: ScreencastConfig,
}

impl StaticController {
    pub(crate) fn new(
        session: Arc<BrowserSession>,
        sink: Arc<FrameSink>,
        stats: Arc<StatsInner>,
        events: broadcast::Sender<ScreencastEvent>,
        config: ScreencastConfig,
    ) -> Arc<Self> {
        Arc::new(StaticController {
            active: AtomicBool::new(false),
            task: Mutex::new(None),
            session,
            sink,
            stats,
            events,
            config,
        })
    }

    /// 进入降级轮询（幂等：已在轮询中直接返回，防重复进入）。状态机迁移
    /// 由调用方负责（start/restart 路径各自置 Active）。进入点两侧（start
    /// 失败/restart 失败）均保证帧泵 running=false，无需再触碰泵开关。
    pub(crate) fn enter(&self, reason: &str) {
        if self.active.swap(true, Ordering::SeqCst) {
            return;
        }
        let ctx = StaticPollCtx {
            session: self.session.clone(),
            sink: self.sink.clone(),
            stats: self.stats.clone(),
            events: self.events.clone(),
            interval: self.config.static_interval,
            capture_timeout: self.config.static_capture_timeout,
            quality: self.config.quality,
            fallback_width: self.config.max_width.max(0) as u32,
            fallback_height: self.config.max_height.max(0) as u32,
        };
        let task = tokio::spawn(static_poll_loop(ctx));
        *self.task.lock().unwrap_or_else(|p| p.into_inner()) = Some(task);
        // 事件面按需订阅：无订阅者不改变降级本身（降级已生效），仅 debug 留痕
        if let Err(err) = self.events.send(ScreencastEvent::Degraded {
            reason: reason.to_string(),
        }) {
            tracing::debug!("帧流事件无订阅者（丢弃 Degraded）：{err}");
        }
        tracing::warn!("帧流进入静态降级模式（1fps captureScreenshot 轮询）：{reason}");
    }

    /// 退出降级轮询（幂等）：abort 轮询任务 + 清旗标。切回 screencast 泵前
    /// 调用（防双源喂帧）。
    pub(crate) fn exit(&self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap_or_else(|p| p.into_inner()).take() {
            task.abort();
        }
    }

    /// 是否处于降级轮询中。
    pub(crate) fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}
