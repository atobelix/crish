//! 在途请求计数（wait_for NetworkIdle 消费，维度 11 事件总线订阅维护）。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::cdp::bus::BrowserEvent;

/// 在途请求计数（wait_for NetworkIdle 消费，维度 11 事件总线订阅维护）。
pub struct NetworkCounter {
    in_flight: Arc<AtomicUsize>,
    /// 订阅任务句柄（Drop 时 abort 终止——M3：任务不再持有 Arc<Self> 自保活，
    /// 计数 Arc 归零即收尸，杜绝每实例常驻订阅任务泄漏）
    pub(crate) handle: tokio::task::JoinHandle<()>,
}

impl NetworkCounter {
    pub fn new(mut rx: tokio::sync::broadcast::Receiver<BrowserEvent>) -> Arc<Self> {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let task_in_flight = in_flight.clone();
        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(BrowserEvent::NetworkRequest { .. }) => {
                        task_in_flight.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(BrowserEvent::NetworkDone { .. }) => {
                        // fetch_update 在较新 stable 上被 -D warnings 拒绝；
                        // try_update 在当前 stable 仍未稳定。用比较交换保持同一语义。
                        let mut current = task_in_flight.load(Ordering::Relaxed);
                        loop {
                            let next = current.saturating_sub(1);
                            match task_in_flight.compare_exchange_weak(
                                current,
                                next,
                                Ordering::Relaxed,
                                Ordering::Relaxed,
                            ) {
                                Ok(_) => break,
                                Err(observed) => current = observed,
                            }
                        }
                    }
                    // 其余事件与本计数面（网络在途数）无关：显式忽略事件体
                    Ok(_other_event) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Arc::new(NetworkCounter { in_flight, handle })
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::Relaxed)
    }
}

impl Drop for NetworkCounter {
    /// 终止常驻订阅任务（M3：Arc 归零即收尸，任务不得活到总线关闭）。
    fn drop(&mut self) {
        self.handle.abort();
    }
}
