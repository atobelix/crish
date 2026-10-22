//! 帧流会话（维度 12 §2：ScreencastSession，帧流数据面）
//!
//! - **start**：`Page.startScreencast`（format/quality/maxWidth/maxHeight/
//!   everyNthFrame 可配，§2.1）+ 帧订阅（`subscribe_frames`）+ **ack pacing**
//!   （持住 ack = `1000 / fps`，收到 ack 后 Chrome 才产生下一帧，天然单帧在途）；
//! - **帧率档位**：Base 8fps / Interactive 15fps / Burst 20fps（§2.5），由前端
//!   `input_active` 信号（mark_input/mark_burst）与 AI 动作事件升降档，
//!   静止 2s 回落 Base（fps.rs）；
//! - **恢复**：订阅 `ConnectionRestored`（R-9-3/U-10：11 文档恢复清单第 9 项），
//!   重连成功后以原配置自动重启 startScreencast，旧 sessionId 序列作废
//!   （泵代数重置：seq/去重表清零）；
//! - **状态机**：idle/starting/active/stopping（watch 订阅 + 事件广播）；
//! - **静态降级**（U-3）：screencast start 失败/能力缺失且启用降级 →
//!   1fps `Page.captureScreenshot` 轮询接管（degrade.rs，状态机保持 Active
//!   投影，经 `is_degraded` 感知）；
//! - **背压**：帧输出槽满时丢弃旧帧保新帧（§2.4 丢帧策略，sink.rs）；
//! - **去重**：已 ack 的 (session, frame) 重复事件直接丢弃（防 CDP 重放，§2.1）。
//!
//! 职责边界：帧流传输层不在本模块（U-13 裁决：帧流下行改走 Tauri Channel，
//! app 侧接线）——本模块只实现帧流数据面，产出 `FrameOut` 流供 app 侧
//! 转发进 Tauri Channel；`subscribe_frames` 为帧通道唯一消费者（BusHandle
//! 独占契约），重复订阅属调用方错误。

mod pump;
mod static_ctrl;
mod supervisor;
pub(crate) mod types;

#[cfg(test)]
mod tests;

use types::PumpShared;
pub(crate) use types::StatsInner;
pub use types::{
    ScreencastConfig, ScreencastError, ScreencastEvent, ScreencastStats, ScreencastStatus,
    IDLE_FALLBACK_TIMEOUT, MAX_ACKED_RECORDS, START_MAX_ATTEMPTS, START_RETRY_DELAY,
};

use pump::{pump_loop, PumpContext};
use static_ctrl::StaticController;
use supervisor::{send_start_screencast, send_stop_screencast, supervisor_loop};

use crate::frames::fps::{FpsController, FpsLevel};
use crate::frames::sink::{take_receiver, FrameReceiver, FrameReceiverSlot, FrameSink};
use crate::BrowserSession;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, watch};

/// 帧流会话（帧流数据面唯一入口：启动/停止/恢复/升降档/帧输出）。
pub struct ScreencastSession {
    session: Arc<BrowserSession>,
    config: ScreencastConfig,
    status_tx: watch::Sender<ScreencastStatus>,
    /// 状态 watch 保活接收端：`watch::Sender::send` 在无任何接收者时返回 Err
    /// 且不更新值（tokio 1.x 实测，见 sender.rs CancellationToken 注释）——
    /// 必须自持一个接收端，状态迁移才生效。
    _status_keepalive: watch::Receiver<ScreencastStatus>,
    events: broadcast::Sender<ScreencastEvent>,
    fps: Arc<FpsController>,
    sink: Arc<FrameSink>,
    frame_rx_slot: FrameReceiverSlot,
    pump: Arc<Mutex<PumpShared>>,
    stats: Arc<StatsInner>,
    /// 静态降级轮询控制器（U-3；与监督任务共享，start/stop/restart 协作面）。
    static_ctrl: Arc<StaticController>,
    pump_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    supervisor_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Drop for ScreencastSession {
    /// 收尾（M3）：关闭输出槽 + abort 泵/监督/降级任务——调用方遗漏 shutdown
    /// 时不留常驻任务（任务不持有 Arc<Self> 自保活）。
    fn drop(&mut self) {
        self.static_ctrl.exit(); // 降级轮询先停（防退出后仍喂帧）
        self.sink.close();
        if let Some(t) = self
            .pump_task
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            t.abort();
        }
        if let Some(t) = self
            .supervisor_task
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            t.abort();
        }
    }
}

impl ScreencastSession {
    /// 新建帧流会话：独占消费帧通道（subscribe_frames）+ 启动泵任务与
    /// 恢复监督任务（订阅时序铁律：监督任务先订阅再等事件）。
    pub fn new(session: Arc<BrowserSession>, config: ScreencastConfig) -> Self {
        let (status_tx, status_rx) = watch::channel(ScreencastStatus::Idle);
        let (events, _) = broadcast::channel(16);
        let fps = FpsController::new(
            config.initial_fps,
            config.idle_timeout,
            config.hold_override,
        );
        let sink = FrameSink::new(config.frame_queue_capacity);
        let frame_rx_slot: FrameReceiverSlot = Arc::new(Mutex::new(None));
        let frames_rx = session.subscribe_frames();
        let pump = Arc::new(Mutex::new(PumpShared {
            running: false,
            gen: 0,
            seq: 0,
            acked: VecDeque::new(),
        }));
        let stats = Arc::new(StatsInner::default());
        let static_ctrl = StaticController::new(
            session.clone(),
            sink.clone(),
            stats.clone(),
            events.clone(),
            config.clone(),
        );

        // —— 泵任务（帧通道 → 输出槽 + ack pacing）——
        let pump_task = tokio::spawn(pump_loop(PumpContext {
            frames_rx,
            shared: pump.clone(),
            sink: sink.clone(),
            fps: fps.clone(),
            stats: stats.clone(),
            session: session.clone(),
            config: config.clone(),
            events: events.clone(),
        }));

        // —— 监督任务（ConnectionRestored → 自动重启，R-9-3）——
        let supervisor_task = tokio::spawn(supervisor_loop(
            session.subscribe(),
            session.clone(),
            config.clone(),
            status_tx.clone(),
            events.clone(),
            pump.clone(),
            stats.clone(),
            static_ctrl.clone(),
        ));

        ScreencastSession {
            session,
            config,
            status_tx,
            _status_keepalive: status_rx,
            events,
            fps,
            sink,
            frame_rx_slot,
            pump,
            stats,
            static_ctrl,
            pump_task: Mutex::new(Some(pump_task)),
            supervisor_task: Mutex::new(Some(supervisor_task)),
        }
    }

    /// 启动帧流：状态 Starting →（能力门）→ startScreencast → Active。
    /// screencast 失败/不可用且启用静态降级（U-3）→ 1fps captureScreenshot
    /// 轮询接管，返回 Ok（帧流保持运行，经 Degraded 事件/is_degraded 感知）；
    /// 未启用降级 → 失败回 Idle + StartFailed。
    pub async fn start(&self) -> Result<(), ScreencastError> {
        if self.status() != ScreencastStatus::Idle {
            return Err(ScreencastError::AlreadyActive);
        }
        self.set_status(ScreencastStatus::Starting);
        // 能力门（probe 面，U-3）：能力探测已运行且明确无 screencast 能力 →
        // 直接进入降级轮询（不尝试 startScreencast）。未探测（None）按可用
        // 处理：发 startScreencast 实测，失败再降级。
        if self.config.static_fallback_enabled
            && self.status() == ScreencastStatus::Starting
            && !self.screencast_capable()
        {
            self.static_ctrl
                .enter("能力探测无 screencast 能力（capability.screencast=false）");
            self.set_status(ScreencastStatus::Active);
            return Ok(());
        }
        match send_start_screencast(&self.session, &self.config).await {
            Ok(()) => {
                // 竞态防护：命令在途期间被 stop 抢断 → 不激活，回退已启动的 screencast
                if self.status() != ScreencastStatus::Starting {
                    send_stop_screencast(&self.session, &self.config).await;
                    return Err(ScreencastError::AlreadyActive);
                }
                let mut shared = self.pump.lock().unwrap_or_else(|p| p.into_inner());
                shared.running = true;
                shared.gen += 1; // 泵感知代数变化：seq/去重表清零
                drop(shared);
                self.set_status(ScreencastStatus::Active);
                Ok(())
            }
            Err(e) => {
                // U-3 降级路径：startScreencast 失败 → 1fps 轮询接管。status
                // 守卫对齐成功路径竞态防护（命令在途期间被 stop 抢断 → 不降级）
                if self.config.static_fallback_enabled
                    && self.status() == ScreencastStatus::Starting
                {
                    self.static_ctrl
                        .enter(&format!("startScreencast 失败：{e}"));
                    self.set_status(ScreencastStatus::Active);
                    return Ok(());
                }
                self.set_status(ScreencastStatus::Idle);
                if let Err(send_err) = self.events.send(ScreencastEvent::StartFailed {
                    message: e.to_string(),
                }) {
                    tracing::debug!("帧流事件无订阅者（丢弃 StartFailed）：{send_err}");
                }
                Err(e)
            }
        }
    }

    /// screencast 能力判定（probe 面）：能力报告已缓存时按 `features.screencast`；
    /// 未探测（None）视为可用（走 startScreencast 实测，失败由降级路径接管）。
    fn screencast_capable(&self) -> bool {
        match self.session.capability() {
            Some(report) => report.features.screencast,
            None => true,
        }
    }

    /// 停止帧流：stopScreencast（best-effort）+ 泵关闭 + Idle（幂等）。
    pub async fn stop(&self) {
        match self.status() {
            ScreencastStatus::Idle | ScreencastStatus::Stopping => return, // 幂等/已在停止
            _ => {}
        }
        self.set_status(ScreencastStatus::Stopping);
        send_stop_screencast(&self.session, &self.config).await;
        self.static_ctrl.exit(); // 降级轮询先停（防 stop 期间续推帧）
        self.pump.lock().unwrap_or_else(|p| p.into_inner()).running = false;
        self.set_status(ScreencastStatus::Idle);
        if let Err(err) = self.events.send(ScreencastEvent::Stopped) {
            tracing::debug!("帧流事件无订阅者（丢弃 Stopped）：{err}");
        }
    }

    /// 收尾（面板关闭路径）：停止 + 终止泵/监督任务 + 关闭输出槽。
    pub async fn shutdown(&self) {
        self.stop().await;
        self.sink.close();
        if let Some(t) = self
            .pump_task
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            t.abort();
        }
        if let Some(t) = self
            .supervisor_task
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            t.abort();
        }
    }

    // —— 状态面 ——

    /// 当前状态。
    pub fn status(&self) -> ScreencastStatus {
        *self.status_tx.borrow()
    }

    /// 是否处于静态降级模式（U-3：screencast 不可用 → 1fps captureScreenshot
    /// 轮询）。状态机投影仍为 Active（帧流运行中），本旗标供诊断/接线感知
    /// 降级（切回 screencast 或停止后为 false）。
    pub fn is_degraded(&self) -> bool {
        self.static_ctrl.is_active()
    }

    /// 订阅状态变化（watch）。
    pub fn subscribe_status(&self) -> watch::Receiver<ScreencastStatus> {
        self.status_tx.subscribe()
    }

    /// 订阅会话事件（诊断/状态投影）。
    pub fn subscribe_events(&self) -> broadcast::Receiver<ScreencastEvent> {
        self.events.subscribe()
    }

    /// 帧输出流（唯一消费端；app 侧接线 → Tauri Channel，U-13）。
    pub fn subscribe_frames(&self) -> FrameReceiver {
        take_receiver(&self.frame_rx_slot, self.sink.clone())
    }

    /// 统计快照。
    pub fn stats(&self) -> ScreencastStats {
        ScreencastStats {
            frames_received: self
                .stats
                .frames_received
                .load(std::sync::atomic::Ordering::Relaxed),
            frames_sent: self
                .stats
                .frames_sent
                .load(std::sync::atomic::Ordering::Relaxed),
            frames_dropped: self
                .stats
                .frames_dropped
                .load(std::sync::atomic::Ordering::Relaxed),
            duplicates_skipped: self
                .stats
                .duplicates_skipped
                .load(std::sync::atomic::Ordering::Relaxed),
            acks_sent: self
                .stats
                .acks_sent
                .load(std::sync::atomic::Ordering::Relaxed),
            ack_failures: self
                .stats
                .ack_failures
                .load(std::sync::atomic::Ordering::Relaxed),
            restarts: self
                .stats
                .restarts
                .load(std::sync::atomic::Ordering::Relaxed),
            static_frames: self
                .stats
                .static_frames
                .load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    // —— 帧率档位（12 文档 §2.5：前端 input_active 信号 / AI 动作事件驱动）——

    /// 显式设档（Interactive/Burst 视为活动信号并重置静止计时；Base 为显式回落）。
    pub fn set_fps_level(&self, level: FpsLevel) {
        match level {
            FpsLevel::Base => self.fps.set_level(FpsLevel::Base),
            other => self.fps.mark_activity(other),
        }
    }

    /// 用户交互信号（input_active）：升 Interactive + 重置静止计时。
    pub fn mark_input(&self) {
        self.fps.mark_activity(FpsLevel::Interactive);
    }

    /// 拖拽 / 连续滚动信号：升 Burst + 重置静止计时。
    pub fn mark_burst(&self) {
        self.fps.mark_activity(FpsLevel::Burst);
    }

    /// 当前档位（诊断/测试）。
    pub fn fps_level(&self) -> FpsLevel {
        self.fps.current()
    }

    fn set_status(&self, status: ScreencastStatus) {
        // 状态为唯一真源（读侧经 status()/borrow()）：投递失败只说明无观察者，
        // 状态本身已落库，故不上抛；debug 留痕便于排查面板不同步。
        if let Err(err) = self.status_tx.send(status) {
            tracing::debug!("帧流状态无订阅者（丢弃 Status）：{err}");
        }
        if let Err(err) = self.events.send(ScreencastEvent::StatusChanged { status }) {
            tracing::debug!("帧流事件无订阅者（丢弃 StatusChanged）：{err}");
        }
    }
}
