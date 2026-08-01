//! SSE 层（任务书 B2.3；02-provider-semantics.md §二.1、§六.1-2）
//!
//! - [frame]：增量字节流 → [SseFrame]（`\n\n`/`\r\n\r\n` 边界、`data:` 行聚合、
//!   `[DONE]` 哨兵、keep-alive 跳过、残留 buffer、跨 chunk UTF-8 增量解码）
//! - [reader]：与 reqwest 解耦的流读取（first-byte/idle 双段超时、abort 中断
//!   挂起 read、sse-first-byte/stream-end 诊断），reqwest 侧仅做适配

pub mod frame;
pub mod reader;

pub use frame::{SseFrame, SseFrameError, SseParser};
pub use reader::{
    read_sse, read_sse_stream, AbortFlag, AbortHandle, ChunkReader, SseReadError,
    StreamDiagnosticContext, StreamFrameEvent, StreamReadOptions, StreamReadOutput,
};
