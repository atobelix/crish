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

use crate::cdp::bus::{BrowserEvent, FrameChunk};
use crate::cdp::domains::names::{
    PAGE_SCREENCAST_FRAME_ACK, PAGE_START_SCREENCAST, PAGE_STOP_SCREENCAST,
};
use crate::cdp::domains::{ScreencastFrameAckParams, StartScreencastParams};
use crate::cdp::error::CdpError;
use crate::cdp::sender::Command;
use crate::BrowserSession;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

use super::degrade::{
    static_poll_loop, StaticPollCtx, STATIC_CAPTURE_TIMEOUT_DEFAULT, STATIC_POLL_INTERVAL_DEFAULT,
};
use super::fps::{FpsController, FpsLevel};
use super::sink::{
    take_receiver, FrameOut, FrameReceiver, FrameReceiverSlot, FrameSink, FRAME_QUEUE_CAPACITY,
};

/// 静止回落窗口（12 文档 §2.5：2s 无输入且无 AI 动作 → 回落 Base）。
pub const IDLE_FALLBACK_TIMEOUT: Duration = Duration::from_secs(2);
/// 重连恢复后自动重启的最大尝试次数。
pub const START_MAX_ATTEMPTS: u32 = 3;
/// 重启失败重试间隔（500ms 起步）。
pub const START_RETRY_DELAY: Duration = Duration::from_millis(500);
/// 帧事件去重记录上限（环形队列，超出丢最旧）。
pub const MAX_ACKED_RECORDS: usize = 128;

/// 帧流会话状态（12 文档 §5.1 面板状态机在 Rust 侧的帧通道投影）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreencastStatus {
    /// 未启动/已停止。
    Idle,
    /// startScreencast 命令在途。
    Starting,
    /// 帧流泵运行中。
    Active,
    /// stopScreencast 命令在途。
    Stopping,
}

/// 帧流会话事件（诊断/状态投影消费）。
#[derive(Debug, Clone)]
pub enum ScreencastEvent {
    /// 状态迁移。
    StatusChanged { status: ScreencastStatus },
    /// 泵出一帧（seq = 帧序号，bytes = JPEG 字节数）。
    FrameSent { seq: u64, bytes: usize },
    /// 背压丢帧（输出槽满，旧帧被替换）。
    FrameDropped { seq: u64, queued: usize },
    /// 重复帧事件被丢弃（防 CDP 重放，§2.1）。
    DuplicateSkipped { seq: u64 },
    /// ack 发送失败（不中断泵，Chrome 侧自行重发语义兜底）。
    AckFailed { seq: u64, message: String },
    /// 重连恢复后自动重启（R-9-3；epoch = global_epoch）。
    Restarted { epoch: u64 },
    /// 启动/重启失败（含重试耗尽）。
    StartFailed { message: String },
    /// 进入静态降级模式（U-3：screencast 不可用 → 1fps captureScreenshot 轮询）。
    Degraded { reason: String },
    /// 停止完成。
    Stopped,
}

/// 帧流统计快照。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScreencastStats {
    /// 从帧通道收到的帧数。
    pub frames_received: u64,
    /// 泵出的帧数（输出槽入队成功）。
    pub frames_sent: u64,
    /// 背压丢帧数（旧帧被替换）。
    pub frames_dropped: u64,
    /// 重复帧事件跳过数。
    pub duplicates_skipped: u64,
    /// 成功发送的 ack 数。
    pub acks_sent: u64,
    /// ack 发送失败数。
    pub ack_failures: u64,
    /// 重连自动重启次数。
    pub restarts: u64,
    /// 静态降级轮询产出的帧数（U-3：captureScreenshot 轮询帧）。
    pub static_frames: u64,
}

/// 帧流会话错误。
#[derive(Debug, thiserror::Error)]
pub enum ScreencastError {
    /// 已在激活态（重复 start / 停止中）。
    #[error("帧流会话已激活（重复 start）")]
    AlreadyActive,
    /// 无活动标签会话（start 前置条件）。
    #[error("无活动标签会话")]
    NoActiveSession,
    /// CDP 命令失败（start/stop/ack）。
    #[error("CDP 命令失败：{0}")]
    Command(CdpError),
}

/// 帧流配置（§2.1 参数 + 帧率/背压参数，运行时生效面在 app 侧接线）。
#[derive(Debug, Clone)]
pub struct ScreencastConfig {
    /// 帧图格式（默认 jpeg；png 仅作调试备用）。
    pub format: String,
    /// JPEG 质量（默认 70，可调 50-75）。
    pub quality: i32,
    /// 帧图最大宽度（默认 1280）。
    pub max_width: i32,
    /// 帧图最大高度（默认 960）。
    pub max_height: i32,
    /// 每 N 帧发一帧（1 = 每帧都发，节流交给 ack pacing）。
    pub every_nth_frame: i32,
    /// 初始帧率档位。
    pub initial_fps: FpsLevel,
    /// 静止回落窗口（默认 2s）。
    pub idle_timeout: Duration,
    /// 测试注入：固定 ack 持住时长（None = 按档位换算）。
    pub hold_override: Option<Duration>,
    /// ack 命令超时（默认 5s）。
    pub ack_timeout: Duration,
    /// start/stop 命令超时（默认 5s）。
    pub command_timeout: Duration,
    /// 重连重启失败重试间隔。
    pub start_retry_delay: Duration,
    /// 重连重启最大尝试次数。
    pub start_max_attempts: u32,
    /// 帧事件去重记录上限。
    pub max_acked: usize,
    /// 帧输出槽容量（默认 60，对齐帧通道容量）。
    pub frame_queue_capacity: usize,
    /// 静态降级开关（U-3）：screencast start 失败/能力缺失 → 1fps
    /// captureScreenshot 轮询接管（默认开启；关闭则保持旧口径——失败回
    /// Idle + StartFailed）。
    pub static_fallback_enabled: bool,
    /// 降级轮询间隔（默认 1s = 1fps，可配）。
    pub static_interval: Duration,
    /// 降级单次截屏命令超时。
    pub static_capture_timeout: Duration,
}

impl Default for ScreencastConfig {
    fn default() -> Self {
        ScreencastConfig {
            format: "jpeg".to_string(),
            quality: 70,
            max_width: 1280,
            max_height: 960,
            every_nth_frame: 1,
            initial_fps: FpsLevel::Base,
            idle_timeout: IDLE_FALLBACK_TIMEOUT,
            hold_override: None,
            ack_timeout: Duration::from_secs(5),
            command_timeout: Duration::from_secs(5),
            start_retry_delay: START_RETRY_DELAY,
            start_max_attempts: START_MAX_ATTEMPTS,
            max_acked: MAX_ACKED_RECORDS,
            frame_queue_capacity: FRAME_QUEUE_CAPACITY,
            static_fallback_enabled: true,
            static_interval: STATIC_POLL_INTERVAL_DEFAULT,
            static_capture_timeout: STATIC_CAPTURE_TIMEOUT_DEFAULT,
        }
    }
}

/// 静态降级轮询控制器（U-3：screencast 不可用 → 1fps captureScreenshot 轮询）。
/// 活动旗标幂等防重入（enter 已在轮询时直接返回）；任务句柄供退出时 abort。
struct StaticController {
    active: AtomicBool,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    session: Arc<BrowserSession>,
    sink: Arc<FrameSink>,
    stats: Arc<StatsInner>,
    events: broadcast::Sender<ScreencastEvent>,
    config: ScreencastConfig,
}

impl StaticController {
    fn new(
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
    fn enter(&self, reason: &str) {
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
    fn exit(&self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap_or_else(|p| p.into_inner()).take() {
            task.abort();
        }
    }

    /// 是否处于降级轮询中。
    fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
}

/// 帧泵共享状态（泵任务与 start/stop/restart 协作面）。
struct PumpShared {
    /// 泵开关（false = 帧直接丢弃，不输出不 ack）。
    running: bool,
    /// 泵代数：每次 start/restart +1，泵感知代数变化时重置 seq/去重表
    /// （旧 sessionId 序列作废，R-9-3）。
    gen: u64,
    /// 帧序号（单调递增，代数重置归零）。
    seq: u64,
    /// 已 ack 的 (session, frame) 去重表（环形上限）。
    acked: VecDeque<(String, u64)>,
}

/// 统计原子面（泵/监督/降级轮询任务与查询方共享）。
/// `pub(crate)`：degrade.rs 轮询循环消费计数（add_static_frame/add_dropped）。
pub(crate) struct StatsInner {
    pub(crate) frames_received: AtomicU64,
    pub(crate) frames_sent: AtomicU64,
    pub(crate) frames_dropped: AtomicU64,
    pub(crate) duplicates_skipped: AtomicU64,
    pub(crate) acks_sent: AtomicU64,
    pub(crate) ack_failures: AtomicU64,
    pub(crate) restarts: AtomicU64,
    pub(crate) static_frames: AtomicU64,
}

impl StatsInner {
    /// 静态降级帧计数（degrade.rs 轮询循环消费，U-3）。
    pub(crate) fn add_static_frame(&self) {
        self.static_frames.fetch_add(1, Ordering::Relaxed);
    }

    /// 背压丢帧计数（degrade.rs 轮询循环消费，语义同帧泵 §2.4）。
    pub(crate) fn add_dropped(&self) {
        self.frames_dropped.fetch_add(1, Ordering::Relaxed);
    }
}

impl Default for StatsInner {
    fn default() -> Self {
        StatsInner {
            frames_received: AtomicU64::new(0),
            frames_sent: AtomicU64::new(0),
            frames_dropped: AtomicU64::new(0),
            duplicates_skipped: AtomicU64::new(0),
            acks_sent: AtomicU64::new(0),
            ack_failures: AtomicU64::new(0),
            restarts: AtomicU64::new(0),
            static_frames: AtomicU64::new(0),
        }
    }
}

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
            frames_received: self.stats.frames_received.load(Ordering::Relaxed),
            frames_sent: self.stats.frames_sent.load(Ordering::Relaxed),
            frames_dropped: self.stats.frames_dropped.load(Ordering::Relaxed),
            duplicates_skipped: self.stats.duplicates_skipped.load(Ordering::Relaxed),
            acks_sent: self.stats.acks_sent.load(Ordering::Relaxed),
            ack_failures: self.stats.ack_failures.load(Ordering::Relaxed),
            restarts: self.stats.restarts.load(Ordering::Relaxed),
            static_frames: self.stats.static_frames.load(Ordering::Relaxed),
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

/// 帧泵上下文（泵任务入参聚合，避免超长参数表）。
struct PumpContext {
    frames_rx: tokio::sync::mpsc::Receiver<FrameChunk>,
    shared: Arc<Mutex<PumpShared>>,
    sink: Arc<FrameSink>,
    fps: Arc<FpsController>,
    stats: Arc<StatsInner>,
    session: Arc<BrowserSession>,
    config: ScreencastConfig,
    events: broadcast::Sender<ScreencastEvent>,
}

/// 帧泵主循环：帧通道 → 泵出一帧 → 持住 ack（档位换算）→ ack。
/// 泵任务常驻（跨 start/stop/restart 存活），由代数与 running 开关协作。
async fn pump_loop(mut ctx: PumpContext) {
    let mut gen = 0u64;
    while let Some(chunk) = ctx.frames_rx.recv().await {
        ctx.stats.frames_received.fetch_add(1, Ordering::Relaxed);
        let (running, cur_gen) = {
            let shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
            (shared.running, shared.gen)
        };
        if !running {
            continue; // 停止期帧直接丢弃（不输出不 ack）
        }
        if cur_gen != gen {
            // 代数变化（start/restart）：seq 与去重表清零（旧 sessionId 序列作废）
            gen = cur_gen;
            let mut shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
            shared.seq = 0;
            shared.acked.clear();
        }
        pump_one(&mut ctx, chunk).await;
    }
}

/// 单帧处理：去重 → 输出（丢旧保新）→ 持住 ack → 发送 ack。
async fn pump_one(ctx: &mut PumpContext, chunk: FrameChunk) {
    let seq = {
        let mut shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
        shared.seq += 1;
        shared.seq
    };

    // 去重（防 CDP 重放，§2.1）：已 ack 的 (session, frame) 重复事件直接丢弃
    {
        let shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
        if shared
            .acked
            .iter()
            .any(|(s, f)| s == &chunk.session && *f == chunk.frame)
        {
            ctx.stats.duplicates_skipped.fetch_add(1, Ordering::Relaxed);
            if let Err(err) = ctx.events.send(ScreencastEvent::DuplicateSkipped { seq }) {
                tracing::debug!("帧流事件无订阅者（丢弃 DuplicateSkipped）：{err}");
            }
            return;
        }
    }

    // 输出：背压丢帧（满时丢队首保新帧，§2.4）
    let frame = FrameOut {
        seq,
        width: chunk.device_width,
        height: chunk.device_height,
        data: chunk.data.clone(),
    };
    if let Some(replaced) = ctx.sink.push(frame) {
        ctx.stats.frames_dropped.fetch_add(1, Ordering::Relaxed);
        if let Err(err) = ctx.events.send(ScreencastEvent::FrameDropped {
            seq: replaced.seq,
            queued: ctx.sink.len(),
        }) {
            tracing::debug!("帧流事件无订阅者（丢弃 FrameDropped）：{err}");
        }
    }
    ctx.stats.frames_sent.fetch_add(1, Ordering::Relaxed);
    if let Err(err) = ctx.events.send(ScreencastEvent::FrameSent {
        seq,
        bytes: chunk.data.len(),
    }) {
        tracing::debug!("帧流事件无订阅者（丢弃 FrameSent）：{err}");
    }

    // ack pacing：持住当前档位换算时长（§2.1：Chrome 收到 ack 后才产生下一帧）
    tokio::time::sleep(ctx.fps.hold()).await;

    // 发送 ack（短超时；失败记事件不中断泵——连接恢复后由重启路径接管）。
    // P1-A 遗留 1/2：params.sessionId 必须用帧内 ack_session（真实 Chrome 严格
    // 校验，用信封 session 会停滞帧流）；命令路由保持信封 session。
    let ack = Command::new(PAGE_SCREENCAST_FRAME_ACK)
        .params(ScreencastFrameAckParams {
            session_id: chunk.ack_session.clone(),
        })
        .with_session(&chunk.session)
        .with_timeout(ctx.config.ack_timeout);
    match ctx.session.send::<serde_json::Value>(ack).await {
        Ok(ack_reply) => {
            // ack 响应体（通常空对象）仅证明命令成功，不入统计；trace 留痕
            tracing::trace!("screencastFrameAck 响应：{ack_reply}");
            ctx.stats.acks_sent.fetch_add(1, Ordering::Relaxed);
            let mut shared = ctx.shared.lock().unwrap_or_else(|p| p.into_inner());
            shared.acked.push_back((chunk.session, chunk.frame));
            while shared.acked.len() > ctx.config.max_acked {
                shared.acked.pop_front();
            }
        }
        Err(e) => {
            ctx.stats.ack_failures.fetch_add(1, Ordering::Relaxed);
            if let Err(err) = ctx.events.send(ScreencastEvent::AckFailed {
                seq,
                message: e.to_string(),
            }) {
                tracing::debug!("帧流事件无订阅者（丢弃 AckFailed）：{err}");
            }
        }
    }
}

/// 监督循环：ConnectionRestored（R-9-3）→ 激活态自动重启帧流。
async fn supervisor_loop(
    mut bus_rx: broadcast::Receiver<BrowserEvent>,
    session: Arc<BrowserSession>,
    config: ScreencastConfig,
    status_tx: watch::Sender<ScreencastStatus>,
    events: broadcast::Sender<ScreencastEvent>,
    pump: Arc<Mutex<PumpShared>>,
    stats: Arc<StatsInner>,
    static_ctrl: Arc<StaticController>,
) {
    while let Ok(ev) = bus_rx.recv().await {
        if let BrowserEvent::ConnectionRestored { epoch, .. } = ev {
            // 仅激活态需要重启（空闲/停止中不重启；降级模式投影 Active 同样覆盖）
            if *status_tx.borrow() != ScreencastStatus::Active {
                continue;
            }
            restart_screencast(
                &session,
                &config,
                &status_tx,
                &events,
                &pump,
                &stats,
                &static_ctrl,
                epoch,
            )
            .await;
        }
    }
}

/// 重连自动重启：Starting → 重试 startScreencast → Active（失败回 Idle，
/// 启用静态降级则保持 1fps 轮询——U-3）。
async fn restart_screencast(
    session: &Arc<BrowserSession>,
    config: &ScreencastConfig,
    status_tx: &watch::Sender<ScreencastStatus>,
    events: &broadcast::Sender<ScreencastEvent>,
    pump: &Arc<Mutex<PumpShared>>,
    stats: &Arc<StatsInner>,
    static_ctrl: &Arc<StaticController>,
    epoch: u64,
) {
    // 重启期状态/事件投递：无观察者不改变重启主流程（状态已由 status_tx 持有），
    // 故仅 debug 留痕，不上抛（重启结果由 result 分支决定）。
    if let Err(err) = status_tx.send(ScreencastStatus::Starting) {
        tracing::debug!("帧流状态无订阅者（丢弃 Starting）：{err}");
    }
    let mut result = Err(ScreencastError::NoActiveSession);
    for attempt in 1..=config.start_max_attempts {
        // 用户 stop 抢断 → 放弃重启（状态已被停止路径改写）
        if *status_tx.borrow() != ScreencastStatus::Starting {
            return;
        }
        result = send_start_screencast(session, config).await;
        if result.is_ok() {
            break;
        }
        if let Err(e) = result.as_ref() {
            tracing::warn!(
                "帧流重启失败（attempt={attempt}/{}）：{}",
                config.start_max_attempts,
                e
            );
        }
        tokio::time::sleep(config.start_retry_delay).await;
    }
    match result {
        Ok(()) => {
            if *status_tx.borrow() != ScreencastStatus::Starting {
                // 停止在命令在途期间抢断：回退刚启动的 screencast
                send_stop_screencast(session, config).await;
                return;
            }
            static_ctrl.exit(); // 切回 screencast 泵：先停降级轮询（防双源喂帧）
            let mut shared = pump.lock().unwrap_or_else(|p| p.into_inner());
            shared.running = true;
            shared.gen += 1; // 泵代数重置：旧 sessionId 序列作废
            drop(shared);
            stats.restarts.fetch_add(1, Ordering::Relaxed);
            if let Err(err) = status_tx.send(ScreencastStatus::Active) {
                tracing::debug!("帧流状态无订阅者（丢弃 Active）：{err}");
            }
            if let Err(err) = events.send(ScreencastEvent::Restarted { epoch }) {
                tracing::debug!("帧流事件无订阅者（丢弃 Restarted）：{err}");
            }
            tracing::info!("帧流已按原配置重启（epoch={epoch}）");
        }
        Err(e) => {
            pump.lock().unwrap_or_else(|p| p.into_inner()).running = false;
            // U-3 降级：重启失败且启用静态降级 → 保持 1fps 轮询（跨重连持续
            // 供帧——恢复条件取舍：保持降级直到显式 stop/start 重试，或下一次
            // 重连重启成功时切回；不自动反复探测 screencast 可用性）
            if config.static_fallback_enabled && *status_tx.borrow() == ScreencastStatus::Starting {
                static_ctrl.enter(&format!("startScreencast 重启失败：{e}"));
                if let Err(err) = status_tx.send(ScreencastStatus::Active) {
                    tracing::debug!("帧流状态无订阅者（丢弃 Active）：{err}");
                }
            } else {
                if let Err(err) = status_tx.send(ScreencastStatus::Idle) {
                    tracing::debug!("帧流状态无订阅者（丢弃 Idle）：{err}");
                }
                if let Err(err) = events.send(ScreencastEvent::StartFailed {
                    message: e.to_string(),
                }) {
                    tracing::debug!("帧流事件无订阅者（丢弃 StartFailed）：{err}");
                }
            }
            tracing::warn!("帧流重启失败（重试耗尽），转入降级/Idle：{e}");
        }
    }
}

/// 发送 startScreencast（当前活动标签会话；恢复期无会话 → NoActiveSession）。
async fn send_start_screencast(
    session: &BrowserSession,
    config: &ScreencastConfig,
) -> Result<(), ScreencastError> {
    let sref = session
        .current_session()
        .map_err(|_| ScreencastError::NoActiveSession)?;
    let params = StartScreencastParams {
        format: Some(config.format.clone()),
        quality: Some(config.quality),
        max_width: Some(config.max_width),
        max_height: Some(config.max_height),
        every_nth_frame: Some(config.every_nth_frame),
    };
    session
        .send::<serde_json::Value>(
            Command::new(PAGE_START_SCREENCAST)
                .params(params)
                .with_session(&sref.session)
                .with_timeout(config.command_timeout),
        )
        .await
        .map_err(ScreencastError::Command)?;
    Ok(())
}

/// 发送 stopScreencast（best-effort：无会话/失败均不阻断清理）。
async fn send_stop_screencast(session: &BrowserSession, config: &ScreencastConfig) {
    if let Ok(sref) = session.current_session() {
        // best-effort 停止（不阻断清理）：命令失败仅告警留痕，否则「帧流已停」
        // 与「浏览器侧仍在推帧」无从区分。
        if let Err(e) = session
            .send::<serde_json::Value>(
                Command::new(PAGE_STOP_SCREENCAST)
                    .params(json!({}))
                    .with_session(&sref.session)
                    .with_timeout(config.command_timeout),
            )
            .await
        {
            tracing::warn!("stopScreencast 发送失败（best-effort，忽略）：{e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::bus::VersionReason;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, IdKey,
    };
    use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
    use async_trait::async_trait;
    use base64::Engine;
    use serde_json::Value;
    use std::sync::atomic::AtomicBool;

    /// 放行策略钩子（会话面测试用，同 lib.rs 测试）。
    struct AllowHooks {
        stop: Arc<AtomicBool>,
        token: CancellationToken,
    }

    impl AllowHooks {
        fn new() -> Self {
            AllowHooks {
                stop: Arc::new(AtomicBool::new(false)),
                token: CancellationToken::new(),
            }
        }
    }

    #[async_trait]
    impl crate::cdp::sender::CommandPolicyHooks for AllowHooks {
        async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
            None
        }
        async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
            Ok(())
        }
        fn audit(&self, _event: BrowserAuditEvent) {}
        fn emergency_stop(&self) -> Arc<AtomicBool> {
            self.stop.clone()
        }
        fn abort_token(&self) -> CancellationToken {
            self.token.clone()
        }
    }

    /// 会话恢复所需 mock 自动应答全表（同 ops.rs 测试）。
    fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
        vec![
            (
                "Browser.getVersion",
                MockReply::Ok(json!({
                    "protocolVersion": "1.3",
                    "product": "Chrome/151.0.7922.72",
                    "revision": "@abc",
                    "userAgent": "ua",
                    "jsVersion": "13.1.71"
                })),
            ),
            ("Target.setDiscoverTargets", MockReply::Ok(json!({}))),
            (
                "Target.getTargets",
                MockReply::Ok(json!({
                    "targetInfos": [
                        { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                    ]
                })),
            ),
            (
                "Target.attachToTarget",
                MockReply::Ok(json!({ "sessionId": "S1" })),
            ),
            ("Page.enable", MockReply::Ok(json!({}))),
            ("Page.setLifecycleEventsEnabled", MockReply::Ok(json!({}))),
            ("Runtime.enable", MockReply::Ok(json!({}))),
            ("DOM.enable", MockReply::Ok(json!({}))),
            ("Network.enable", MockReply::Ok(json!({}))),
            ("Runtime.runIfWaitingForDebugger", MockReply::Ok(json!({}))),
            (
                "Runtime.evaluate",
                MockReply::Ok(json!({ "result": { "value": 1 } })),
            ),
            ("Page.setWindowOpenHandler", MockReply::Ok(json!({}))),
        ]
    }

    /// 组装：mock 会话 + screencast 三命令自动应答 + 活动标签就绪。
    async fn setup() -> (MockServer, Arc<BrowserSession>) {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        mock.set_auto_reply("Page.startScreencast", MockReply::Ok(json!({})));
        mock.set_auto_reply("Page.stopScreencast", MockReply::Ok(json!({})));
        mock.set_auto_reply("Page.screencastFrameAck", MockReply::Ok(json!({})));

        let session = Arc::new(
            BrowserSession::connect(
                CdpEndpoint {
                    port: mock.addr.port(),
                    ws_path: "/devtools/browser/frames-test".to_string(),
                },
                ExpectedBrowser::default(),
                Arc::new(AllowHooks::new()),
            )
            .await
            .expect("会话建连失败"),
        );
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1",
                "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" },
                "waitingForDebugger": false,
            }),
            None,
        );
        // 事件链路无定时器（事件泵/活动跟踪纯事件驱动）：yield 轮询即可
        // （兼容虚拟时钟测试环境，不依赖真实 sleep）
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while session.current_session().is_err() {
            assert!(std::time::Instant::now() < deadline, "活动标签未就绪");
            tokio::task::yield_now().await;
        }
        (mock, session)
    }

    /// 注入一帧（envelope session S1；params.sessionId 同值，与 bus 测试口径一致）。
    fn inject_frame(mock: &MockServer, frame: u64) {
        let data = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
        mock.send_event(
            "Page.screencastFrame",
            json!({
                "data": data,
                "metadata": {
                    "pageScaleFactor": 1.0,
                    "deviceWidth": 1280,
                    "deviceHeight": 720,
                    "timestamp": 1.0
                },
                "sessionId": "S1",
                "frameNumber": frame
            }),
            Some("S1"),
        );
    }

    /// 验收 E1/E13（帧泵）：start → Active；注入帧 → 输出 + 每帧一 ack；
    /// stop → 清理（后续帧丢弃，不输出不 ack）。
    #[tokio::test]
    async fn frames_start_ack_pacing_each_frame_once_stop_cleans() {
        let (mut mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                ..Default::default()
            },
        );
        let rx = frames.subscribe_frames();

        assert_eq!(frames.status(), ScreencastStatus::Idle);
        frames.start().await.expect("启动失败");
        assert_eq!(frames.status(), ScreencastStatus::Active);

        // 注入 3 帧 → 泵出 3 帧（seq 1..3，宽高/字节透传）+ 每帧恰一 ack
        for frame in 1..=3u64 {
            inject_frame(&mock, frame);
        }
        for seq in 1..=3u64 {
            let out = rx
                .recv_timeout(Duration::from_secs(1))
                .await
                .unwrap_or_else(|| panic!("缺帧 seq={seq}"));
            assert_eq!(out.seq, seq);
            assert_eq!(out.width, 1280);
            assert_eq!(out.height, 720);
            assert_eq!(out.data, b"fake-jpeg-bytes");
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().acks_sent < 3 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let stats = frames.stats();
        assert_eq!(stats.frames_sent, 3);
        assert_eq!(stats.acks_sent, 3, "每帧恰一 ack");
        assert_eq!(stats.frames_dropped, 0);
        assert_eq!(stats.duplicates_skipped, 0);

        // ack 参数（sessionId 为帧会话标识）逐条断言
        for _ in 0..3 {
            let ack = mock.expect_command("Page.screencastFrameAck").await;
            assert_eq!(ack["params"]["sessionId"], "S1");
        }

        // stop → 清理：后续帧直接丢弃（不输出不 ack）
        frames.stop().await;
        assert_eq!(frames.status(), ScreencastStatus::Idle);
        frames.stop().await; // 幂等
        assert_eq!(frames.status(), ScreencastStatus::Idle);
        inject_frame(&mock, 99);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(frames.stats().frames_sent, 3, "停止后不再输出");
        assert_eq!(frames.stats().acks_sent, 3, "停止后不再 ack");
        assert!(rx.recv_timeout(Duration::from_millis(20)).await.is_none());

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// 背压丢帧（§2.4）：输出槽容量 2，注入 5 帧 → 丢旧保新（保 4/5 帧）。
    #[tokio::test]
    async fn frames_backpressure_drops_oldest_keeps_newest() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                frame_queue_capacity: 2,
                ..Default::default()
            },
        );
        frames.start().await.expect("启动失败");

        // 不消费输出槽：泵 5 帧 → 队列只保留最新 2 帧
        for frame in 1..=5u64 {
            inject_frame(&mock, frame);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().frames_received < 5 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let stats = frames.stats();
        assert_eq!(stats.frames_received, 5);
        assert_eq!(stats.frames_dropped, 3, "前 3 帧被替换（丢帧判据）");

        let rx = frames.subscribe_frames();
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(4), "保最新帧");
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(5));
        assert!(rx.recv_timeout(Duration::from_millis(20)).await.is_none());

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// 去重（§2.1）：同 (session, frame) 重复事件只 ack 一次。
    #[tokio::test]
    async fn frames_duplicate_event_acked_once() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                ..Default::default()
            },
        );
        let _rx = frames.subscribe_frames();
        frames.start().await.expect("启动失败");

        inject_frame(&mock, 42);
        inject_frame(&mock, 42); // 重放同帧（防 CDP 重放）
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().acks_sent < 1 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let stats = frames.stats();
        assert_eq!(stats.frames_sent, 1, "重复帧不重复输出");
        assert_eq!(stats.acks_sent, 1, "重复帧不重复 ack");
        assert_eq!(stats.duplicates_skipped, 1, "重复事件计数");
        // 后续新帧不受影响
        inject_frame(&mock, 43);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().acks_sent < 2 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(frames.stats().acks_sent, 2);

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// ack 会话标识（P1-A 遗留 1/2）：params.sessionId 独立于信封时，ack 的
    /// params.sessionId 取帧内值（真实 Chrome 严格校验 ack 会话）；命令路由
    /// 仍为信封会话。
    #[tokio::test]
    async fn frames_ack_uses_params_session_id() {
        let (mut mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                ..Default::default()
            },
        );
        let _rx = frames.subscribe_frames();
        frames.start().await.expect("启动失败");

        // params.sessionId = "ACK-S2" ≠ 信封 "S1"
        let data = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
        mock.send_event(
            "Page.screencastFrame",
            json!({
                "data": data,
                "metadata": {
                    "pageScaleFactor": 1.0,
                    "deviceWidth": 1280,
                    "deviceHeight": 720,
                    "timestamp": 1.0
                },
                "sessionId": "ACK-S2",
                "frameNumber": 1
            }),
            Some("S1"),
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().acks_sent < 1 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(frames.stats().acks_sent, 1);
        let ack = mock.expect_command("Page.screencastFrameAck").await;
        assert_eq!(
            ack["params"]["sessionId"], "ACK-S2",
            "ack 会话取 params.sessionId（修复前会错用信封 S1）"
        );
        assert_eq!(ack["sessionId"], "S1", "命令路由仍为信封会话");

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// 等待 ack 计数达标（真实时钟轮询，2s 上限）。
    async fn wait_acks(frames: &ScreencastSession, target: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while frames.stats().acks_sent < target && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            frames.stats().acks_sent >= target,
            "等待 ack 超时（目标 {target}，实际 {}）",
            frames.stats().acks_sent
        );
    }

    /// 升降档（§2.5）：Base 档 ack 持住 ≈125ms；mark_input 升 Interactive 后
    /// 持住显著缩短（67ms vs 125ms 相对断言，真实时钟下仅做下界/相对断言
    /// 保证确定性）；静止 2s 回落 Base。档位换算精确值见 fps.rs 单测。
    #[tokio::test]
    async fn frames_fps_level_switching_ack_timing() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(session.clone(), ScreencastConfig::default());
        frames.start().await.expect("启动失败");
        assert_eq!(frames.fps_level(), FpsLevel::Base);

        // Base 档：注入帧 → 泵出 + ack 持住 ≥125ms（真实 sleep 下界断言）
        inject_frame(&mock, 1);
        let t0 = std::time::Instant::now();
        let rx = frames.subscribe_frames();
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(1));
        wait_acks(&frames, 1).await;
        let base_elapsed = t0.elapsed();
        assert!(
            base_elapsed >= Duration::from_millis(120),
            "Base 档 ack 持住应 ≥125ms（实际 {base_elapsed:?}）"
        );

        // 升 Interactive（前端 input_active 信号）：ack 持住显著缩短
        frames.mark_input();
        assert_eq!(frames.fps_level(), FpsLevel::Interactive);
        inject_frame(&mock, 2);
        let t1 = std::time::Instant::now();
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(2));
        wait_acks(&frames, 2).await;
        let interactive_elapsed = t1.elapsed();
        assert!(
            interactive_elapsed < base_elapsed,
            "Interactive 档持住应短于 Base 档（{interactive_elapsed:?} vs {base_elapsed:?}）"
        );

        // 升 Burst（拖拽/连续滚动）：进一步缩短
        frames.mark_burst();
        assert_eq!(frames.fps_level(), FpsLevel::Burst);
        inject_frame(&mock, 3);
        let t2 = std::time::Instant::now();
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(3));
        wait_acks(&frames, 3).await;
        assert!(
            t2.elapsed() < interactive_elapsed,
            "Burst 档持住应短于 Interactive 档（{:?} vs {interactive_elapsed:?}）",
            t2.elapsed()
        );

        // 静止回落：2s 无信号 → Base（轮询等待，确定性成立）
        let t3 = std::time::Instant::now();
        while frames.fps_level() != FpsLevel::Base && t3.elapsed() < Duration::from_secs(4) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            frames.fps_level(),
            FpsLevel::Base,
            "静止 2s 回落 Base（§2.5）"
        );

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// 状态机（§5 投影）：重复 start 拒绝；start 命令失败 → 回 Idle + StartFailed
    /// （显式关闭静态降级保留旧口径——U-3 降级路径见下方静态降级测试组）。
    #[tokio::test]
    async fn frames_state_machine_start_failures() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                static_fallback_enabled: false,
                ..Default::default()
            },
        );
        frames.start().await.expect("启动失败");
        assert!(matches!(
            frames.start().await,
            Err(ScreencastError::AlreadyActive)
        ));
        frames.stop().await;
        assert_eq!(frames.status(), ScreencastStatus::Idle);

        // startScreencast 命令失败 → Idle + StartFailed 事件
        mock.set_auto_reply(
            "Page.startScreencast",
            MockReply::Error {
                code: -32000,
                message: "screencast not supported".to_string(),
            },
        );
        let mut events = frames.subscribe_events();
        assert!(frames.start().await.is_err());
        assert_eq!(frames.status(), ScreencastStatus::Idle, "失败回 Idle");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        loop {
            if let Ok(ScreencastEvent::StartFailed { .. }) = events.try_recv() {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "应广播 StartFailed");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// 恢复重启（R-9-3）：断线重连 → ConnectionRestored → 自动重启
    /// （重新 startScreencast + 泵代数重置，旧序列作废）+ Restarted 事件。
    #[tokio::test]
    async fn frames_restart_after_connection_restored() {
        let (mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                start_retry_delay: Duration::ZERO,
                ..Default::default()
            },
        );
        let rx = frames.subscribe_frames();
        let mut events = frames.subscribe_events();
        frames.start().await.expect("启动失败");

        // 断线前：一帧正常泵出（seq=1），且 ack 已完成（断线不能吞在途 ack）
        inject_frame(&mock, 1);
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(1));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().acks_sent < 1 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(frames.stats().acks_sent, 1, "断线前 ack 应完成");

        // 断线 → 重连（退避 1s）→ ConnectionRestored → 自动重启
        mock.close_connection();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        let mut saw_restarted = false;
        while !saw_restarted {
            if let Ok(ScreencastEvent::Restarted { .. }) = events.try_recv() {
                saw_restarted = true;
            } else {
                assert!(tokio::time::Instant::now() < deadline, "等待自动重启超时");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        assert!(saw_restarted);
        assert_eq!(
            frames.status(),
            ScreencastStatus::Active,
            "重启后保持 Active"
        );
        assert_eq!(frames.stats().restarts, 1);
        assert_eq!(mock.connection_count(), 2, "断线才重连");

        // 重启后：新帧序列 seq 从 1 重新起算（旧 sessionId 序列作废）
        inject_frame(&mock, 100);
        assert_eq!(
            rx.recv().await.map(|f| f.seq),
            Some(1),
            "泵代数重置：seq 归零重计"
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while frames.stats().acks_sent < 2 && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(frames.stats().acks_sent, 2, "重启后 ack 继续");

        frames.shutdown().await;
        session.shutdown().await;
    }

    /// 事件面：订阅方收到状态迁移（Idle → Starting → Active）。
    #[tokio::test]
    async fn frames_status_events_broadcast() {
        let (_mock, session) = setup().await;
        let frames = ScreencastSession::new(
            session.clone(),
            ScreencastConfig {
                hold_override: Some(Duration::ZERO),
                ..Default::default()
            },
        );
        let status_rx = frames.subscribe_status();
        assert_eq!(*status_rx.borrow(), ScreencastStatus::Idle);
        frames.start().await.expect("启动失败");
        assert_eq!(*status_rx.borrow(), ScreencastStatus::Active);
        frames.stop().await;
        assert_eq!(*status_rx.borrow(), ScreencastStatus::Idle);

        // 版本面不因帧流推进（帧不 bump；验证无副作用）
        assert_eq!(session.snapshot_version(&"T1".to_string()), 0);
        session.bump(&"T1".to_string(), VersionReason::InputInjected);
        assert_eq!(session.snapshot_version(&"T1".to_string()), 1);

        frames.shutdown().await;
        session.shutdown().await;
    }
}
