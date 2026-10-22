//! SSE 读取器（任务书 B2.3；02-provider-semantics.md §二.1、§六.1-2）
//!
//! 与 reqwest 解耦的增量读取：first-byte/idle 双段超时、abort 中断挂起 read、
//! sse-first-byte/stream-end 诊断（对齐 TS readSseJson 29-182）。分帧与流控
//! 逻辑全部在本模块，reqwest 侧（transport）只做字节流适配，便于测试。
//!
//! 超时/abort 一律以错误上抛，绝不静默结束（02 §六.2）。

mod abort;
mod read;
mod stream;
mod types;

#[cfg(test)]
mod tests;

pub use self::abort::{AbortFlag, AbortHandle, ChunkReader};
pub use self::read::read_sse;
pub use self::stream::read_sse_stream;
pub use self::types::{
    SseReadError, StreamDiagnosticContext, StreamFrameEvent, StreamFrameItem, StreamReadOptions,
    StreamReadOutput,
};
