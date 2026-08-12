//! 帧流会话模块（维度 12 §2：帧流数据面，P1-A）
//!
//! - `session`：`ScreencastSession`（start/stop/恢复重启/状态机/帧输出流；
//!   U-3 静态降级集成面）；
//! - `degrade`：静态帧降级源（U-3：screencast 不可用 → 1fps captureScreenshot
//!   轮询 + JPEG SOF 尺寸解析）；
//! - `fps`：帧率档位（Base 8fps / Interactive 15fps / Burst 20fps）与升降档控制器；
//! - `sink`：帧输出槽（背压丢帧：丢弃旧帧保新帧）。
//!
//! 职责边界（U-13 裁决）：帧流传输层（Tauri Channel）由 app 侧接线（P1-B），
//! 本模块只产出帧数据面（`FrameOut` 流）。

mod degrade;
mod fps;
mod session;
mod sink;

pub use fps::{FpsController, FpsLevel};
pub use session::{
    ScreencastConfig, ScreencastError, ScreencastEvent, ScreencastSession, ScreencastStats,
    ScreencastStatus, IDLE_FALLBACK_TIMEOUT, MAX_ACKED_RECORDS, START_MAX_ATTEMPTS,
    START_RETRY_DELAY,
};
pub use sink::{FrameOut, FrameReceiver, FrameSink, FRAME_QUEUE_CAPACITY};
