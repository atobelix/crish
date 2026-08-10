//! 帧输出槽（背压丢帧：丢弃旧帧保新帧，维度 12 §2.4 丢帧策略）
//!
//! - `FrameSink`：有界队列 + Notify 唤醒；满时弹出队首（最旧）入队新帧，
//!   `dropped` 计数——画面永远追最新（不重传、不追赶，§2.4）；
//! - `FrameReceiver`：独占消费端（重复订阅返回空接收端，同 BusHandle 契约）；
//! - 容量默认 = `FRAME_CHANNEL_CAPACITY`（维度 11 §5.2 帧通道容量，60）。
//!
//! 消费方为 app 侧接线（P1-B：帧流下行改走 Tauri Channel，U-13 裁决）——
//! 本槽产出 `FrameOut`（seq/width/height + JPEG 原始字节），对 12 文档 §2.2
//! 的定长头 + 负载格式零转换直供。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 帧输出容量默认值（与帧通道容量一致）。
pub const FRAME_QUEUE_CAPACITY: usize = 60;

/// 泵出帧（12 文档 §2.2：seq/width/height + JPEG 原始字节，全部小端直传）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameOut {
    /// 帧序号（前端丢帧统计/诊断用）。
    pub seq: u64,
    /// 帧图宽度 px。
    pub width: u32,
    /// 帧图高度 px。
    pub height: u32,
    /// JPEG 原始字节。
    pub data: Vec<u8>,
}

/// 帧输出槽（生产：帧泵；消费：`FrameReceiver`）。
pub struct FrameSink {
    queue: Mutex<VecDeque<FrameOut>>,
    notify: tokio::sync::Notify,
    /// 丢帧计数（队列满时被替换的旧帧，§2.4 丢帧判据）。
    dropped: AtomicU64,
    /// 关闭标志（会话销毁后消费端 recv 返回 None）。
    closed: AtomicBool,
    capacity: usize,
}

impl FrameSink {
    /// 新建输出槽（容量注入，测试用）。
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(FrameSink {
            queue: Mutex::new(VecDeque::with_capacity(capacity)),
            notify: tokio::sync::Notify::new(),
            dropped: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            capacity,
        })
    }

    /// 入队一帧；满时丢队首（最旧）保新帧并计数（§2.4 丢帧策略）。
    /// 返回被替换的旧帧（None = 未丢帧）。
    pub fn push(&self, frame: FrameOut) -> Option<FrameOut> {
        let mut queue = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        let replaced = if queue.len() >= self.capacity {
            let old = queue.pop_front();
            self.dropped.fetch_add(1, Ordering::Relaxed);
            old
        } else {
            None
        };
        queue.push_back(frame);
        self.notify.notify_waiters();
        replaced
    }

    /// 取队首帧（无则 None）。
    pub fn try_pop(&self) -> Option<FrameOut> {
        self.queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop_front()
    }

    /// 当前积压帧数。
    pub fn len(&self) -> usize {
        self.queue.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    /// 是否无积压。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 是否已关闭（会话销毁）。
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// 关闭：消费端 recv 立即返回 None（会话销毁路径）。
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// 累计丢帧数。
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// 帧输出消费端（独占消费：重复订阅返回空接收端，同 BusHandle 契约）。
pub struct FrameReceiver {
    sink: Arc<FrameSink>,
}

impl FrameReceiver {
    fn new(sink: Arc<FrameSink>) -> Self {
        FrameReceiver { sink }
    }

    /// 取下一帧（空时挂起；会话销毁返回 None）。
    pub async fn recv(&self) -> Option<FrameOut> {
        loop {
            // 先注册唤醒再检查队列（防检查-等待间隙漏唤醒）
            let notified = self.sink.notify.notified();
            if let Some(frame) = self.sink.try_pop() {
                return Some(frame);
            }
            if self.sink.is_closed() {
                return None;
            }
            notified.await;
        }
    }

    /// 限时取帧（测试与面板诊断用；None = 超时或销毁）。
    pub async fn recv_timeout(&self, timeout: Duration) -> Option<FrameOut> {
        tokio::time::timeout(timeout, self.recv())
            .await
            .ok()
            .flatten()
    }

    /// 当前积压帧数。
    pub fn pending(&self) -> usize {
        self.sink.len()
    }
}

/// 独占消费槽：`subscribe_frames` 取走一次，重复调用返回空接收端。
pub(crate) type FrameReceiverSlot = Arc<Mutex<Option<FrameReceiver>>>;

/// 从独占槽取出消费端（重复取返回空接收端，同 BusHandle::subscribe_frames 契约）。
pub(crate) fn take_receiver(slot: &FrameReceiverSlot, sink: Arc<FrameSink>) -> FrameReceiver {
    let mut guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    guard.take().unwrap_or_else(|| {
        tracing::warn!("帧输出消费端已被取走（重复订阅），返回空接收端");
        FrameReceiver::new(sink)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 基础出入队：FIFO 顺序 + 空时 recv_timeout 超时。
    #[tokio::test]
    async fn sink_fifo_push_pop() {
        let sink = FrameSink::new(4);
        let rx = FrameReceiver::new(sink.clone());
        sink.push(FrameOut {
            seq: 1,
            width: 100,
            height: 50,
            data: b"a".to_vec(),
        });
        sink.push(FrameOut {
            seq: 2,
            width: 100,
            height: 50,
            data: b"b".to_vec(),
        });
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(1));
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(2));
        assert!(rx.recv_timeout(Duration::from_millis(20)).await.is_none());
        assert_eq!(sink.dropped(), 0);
    }

    /// 背压丢帧（12 文档 §2.4）：容量 2 满时丢队首保新帧（丢弃旧帧保新帧）。
    #[tokio::test]
    async fn sink_drops_oldest_keeps_newest() {
        let sink = FrameSink::new(2);
        for seq in 1..=5u64 {
            sink.push(FrameOut {
                seq,
                width: 100,
                height: 50,
                data: vec![seq as u8],
            });
        }
        assert_eq!(sink.dropped(), 3, "前 3 帧被替换（丢帧判据）");
        assert_eq!(sink.len(), 2, "队列保持容量上限");
        let rx = FrameReceiver::new(sink.clone());
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(4), "保最新帧");
        assert_eq!(rx.recv().await.map(|f| f.seq), Some(5));
        assert!(rx.recv_timeout(Duration::from_millis(20)).await.is_none());
    }

    /// 关闭语义：会话销毁后消费端立即返回 None。
    #[tokio::test]
    async fn sink_close_ends_stream() {
        let sink = FrameSink::new(4);
        let rx = FrameReceiver::new(sink.clone());
        sink.close();
        assert!(rx.recv().await.is_none(), "关闭后 recv 返回 None");
    }
}
