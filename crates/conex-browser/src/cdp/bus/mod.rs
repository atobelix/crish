//! 事件总线（维度 11 §5：分类 router + typed 通道 + 帧专用通道）
//!
//! - `BrowserEvent`：强类型事件枚举（§5.1 全表，R-3 补 FileChooserOpened）
//! - `classify`：CDP 原始事件 → 强类型事件（未知 method 记 debug 忽略，宽容解析）
//! - `parse_frame`：screencastFrame → 帧块（走专用 mpsc，不进 typed 通道，§5.2）
//! - `BusHandle`：typed broadcast（4096）+ 帧 mpsc（60）；broadcast 发送永不阻塞
//!   （慢消费者 Lagged 自愈，U-2：版本跟踪器重对齐）
//! - `spawn_event_pump`：transport 事件面 → 分类 → bus / 帧通道
//!
//! 订阅时序铁律：先 subscribe 后发送可能产生事件的命令（消除漏事件窗口）。

use std::sync::Arc;

mod classify;
mod pump;
mod types;

pub use classify::classify;
pub use pump::{parse_frame, spawn_event_pump};
pub use types::{
    BrowserEvent, ConsoleLevel, DialogInfo, DomChangeKind, FrameChunk, Ignored, LifecycleKind,
    TabSummary, VersionReason,
};

/// typed 事件通道容量（agent-browser client.rs:115 同款）。
pub const TYPED_CHANNEL_CAPACITY: usize = 4096;
/// 帧流通道容量（仅维度 12 消费；环形覆盖策略由维度 12 定）。
pub const FRAME_CHANNEL_CAPACITY: usize = 60;

/// 事件总线句柄：typed 广播 + 帧 mpsc（§5.2 双通道）。
#[derive(Clone)]
pub struct BusHandle {
    event_tx: tokio::sync::broadcast::Sender<BrowserEvent>,
    frame_tx: tokio::sync::mpsc::Sender<FrameChunk>,
    /// 帧流接收端（独占消费：仅维度 12；take 一次后再次调用返回空通道）
    frame_rx: Arc<std::sync::Mutex<Option<tokio::sync::mpsc::Receiver<FrameChunk>>>>,
}

impl BusHandle {
    /// 新建总线（容量注入，测试用）。
    pub fn new(capacity: usize, frame_capacity: usize) -> Self {
        let (frame_tx, frame_rx) = tokio::sync::mpsc::channel(frame_capacity);
        BusHandle {
            event_tx: tokio::sync::broadcast::channel(capacity).0,
            frame_tx,
            frame_rx: Arc::new(std::sync::Mutex::new(Some(frame_rx))),
        }
    }

    /// 订阅 typed 事件（先订阅后动作，订阅时序铁律）。
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<BrowserEvent> {
        self.event_tx.subscribe()
    }

    /// 订阅帧流（仅维度 12 调用；独占消费——重复调用返回空接收端，
    /// 属调用方错误，调用方应保证唯一消费）。
    pub fn subscribe_frames(&self) -> tokio::sync::mpsc::Receiver<FrameChunk> {
        let mut guard = self.frame_rx.lock().unwrap_or_else(|p| p.into_inner());
        guard.take().unwrap_or_else(|| {
            tracing::warn!("帧流接收端已被消费（重复订阅），返回空通道");
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        })
    }

    /// 发布 typed 事件（broadcast 发送永不阻塞：慢消费者 Lagged 自愈）。
    pub fn publish(&self, event: BrowserEvent) {
        // 无订阅者 = 无消费方（观测面空窗），不构成发布失败，仅 debug 留痕
        if let Err(err) = self.event_tx.send(event) {
            tracing::debug!("事件总线无订阅者（丢弃）：{err}");
        }
    }

    /// 发送帧块（满时丢弃，维度 12 环形覆盖策略兜底）。
    pub fn send_frame(&self, chunk: FrameChunk) {
        // 满/接收端关闭 → 丢帧。丢帧意味着画面降级（用户可见），必须留痕，
        // 但不能阻塞帧管线，故不上抛：维度 12 有 FrameDropped 事件面兜底。
        if let Err(err) = self.frame_tx.try_send(chunk) {
            tracing::debug!("帧块入队失败（丢帧，接收端满或已关闭）：{err}");
        }
    }

    /// typed 发送端（VersionTracker 广播 VersionAdvanced 用）。
    pub fn event_tx(&self) -> tokio::sync::broadcast::Sender<BrowserEvent> {
        self.event_tx.clone()
    }
}

#[cfg(test)]
mod tests;
