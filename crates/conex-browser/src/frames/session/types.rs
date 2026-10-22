//! 帧流会话类型、配置与统计原子面（自 session.rs 平移）。

use crate::cdp::error::CdpError;
use crate::frames::degrade::{STATIC_CAPTURE_TIMEOUT_DEFAULT, STATIC_POLL_INTERVAL_DEFAULT};
use crate::frames::fps::FpsLevel;
use crate::frames::sink::FRAME_QUEUE_CAPACITY;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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

/// 帧泵共享状态（泵任务与 start/stop/restart 协作面）。
pub(crate) struct PumpShared {
    /// 泵开关（false = 帧直接丢弃，不输出不 ack）。
    pub(crate) running: bool,
    /// 泵代数：每次 start/restart +1，泵感知代数变化时重置 seq/去重表
    /// （旧 sessionId 序列作废，R-9-3）。
    pub(crate) gen: u64,
    /// 帧序号（单调递增，代数重置归零）。
    pub(crate) seq: u64,
    /// 已 ack 的 (session, frame) 去重表（环形上限）。
    pub(crate) acked: VecDeque<(String, u64)>,
}
