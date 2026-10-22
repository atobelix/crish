use async_trait::async_trait;
use tokio::sync::mpsc;

use super::abort::{AbortFlag, ChunkReader};
use super::read::read_sse;
use super::types::{StreamReadOptions, StreamReadOutput};
use crate::sse::frame::{SseFrame, SseParser};

mod reading;
mod timeout_abort;

/// 脚本化块读取器：由无界通道驱动，可模拟任意字节序列 / EOF / 挂起
pub(crate) struct ChannelReader {
    pub(crate) rx: mpsc::UnboundedReceiver<Vec<u8>>,
}

#[async_trait]
impl ChunkReader for ChannelReader {
    type Error = std::io::Error;

    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, Self::Error> {
        Ok(self.rx.recv().await)
    }
}

/// 恒报错的读取器（验证传输错误上抛）
pub(crate) struct ErrorReader;

#[async_trait]
impl ChunkReader for ErrorReader {
    type Error = std::io::Error;

    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, Self::Error> {
        Err(std::io::Error::other("模拟传输故障"))
    }
}

/// 发送全部块后关闭通道（EOF），读取到流结束
pub(crate) async fn collect(input: Vec<Vec<u8>>) -> StreamReadOutput {
    let (tx, rx) = mpsc::unbounded_channel();
    for chunk in input {
        tx.send(chunk).unwrap();
    }
    drop(tx);
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    read_sse(
        &mut reader,
        &mut parser,
        &StreamReadOptions::default(),
        &mut abort,
    )
    .await
    .unwrap()
}

pub(crate) fn data_of(frames: &[SseFrame], index: usize) -> &str {
    frames[index].data.as_deref().unwrap_or("<无 data>")
}
