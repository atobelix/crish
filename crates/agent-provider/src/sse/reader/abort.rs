use async_trait::async_trait;
use tokio::sync::watch;

/// 与 reqwest 解耦的字节块读取接口（02 §六.1）
///
/// 实现方可以是 reqwest bytes_stream 适配器，也可以是 duplex / 本地 TCP /
/// 测试用内存通道——分帧逻辑不感知传输细节。
#[async_trait]
pub trait ChunkReader: Send {
    /// 底层传输错误类型
    type Error: std::error::Error + Send + Sync + 'static;

    /// 读取下一块字节；`Ok(None)` 表示流正常结束（EOF）
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, Self::Error>;
}

/// abort 触发柄（调用方持有；与 [AbortHandle] 成对创建）
#[derive(Debug, Clone)]
pub struct AbortFlag {
    tx: watch::Sender<bool>,
}

/// abort 观察柄（传入 [read_sse]；由 [AbortFlag] 驱动）
#[derive(Debug, Clone)]
pub struct AbortHandle {
    rx: watch::Receiver<bool>,
}

impl AbortFlag {
    /// 创建成对的触发/观察柄（初始未触发）
    pub fn new() -> (Self, AbortHandle) {
        let (tx, rx) = watch::channel(false);
        (Self { tx }, AbortHandle { rx })
    }

    /// 触发 abort（幂等；多次调用无副作用）
    pub fn abort(&self) {
        // 观察柄全部释放后 send 必然失败：abort 已无消费者，属生命周期正常收口，
        // 但保留 debug 证据（禁止静默吞错）。
        if self.tx.send(true).is_err() {
            tracing::debug!("abort 触发时无观察者：AbortHandle 已全部释放");
        }
    }

    /// 是否已触发
    pub fn is_aborted(&self) -> bool {
        *self.tx.borrow()
    }
}

impl AbortHandle {
    /// 是否已触发
    pub fn is_aborted(&self) -> bool {
        *self.rx.borrow()
    }

    /// 等待 abort 触发；触发后立即返回。
    ///
    /// 若发送端（全部 [AbortFlag]）已丢弃，则永远挂起（不会误报 abort）。
    pub async fn wait_abort(&mut self) {
        loop {
            if *self.rx.borrow() {
                return;
            }
            if self.rx.changed().await.is_err() {
                // 发送端已全部丢弃：不会再发生 abort，永久等待
                std::future::pending::<()>().await;
            }
        }
    }
}
