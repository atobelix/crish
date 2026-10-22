use std::collections::VecDeque;
use std::pin::Pin;
use std::time::Instant;

use conex_types::tool::ProviderDiagnosticPhase;
use futures_util::stream::unfold as stream_unfold;
use futures_util::Stream;

use super::abort::{AbortHandle, ChunkReader};
use super::read::select_next_chunk;
use super::types::{
    stream_diagnostic, SseReadError, StreamFrameEvent, StreamFrameItem, StreamReadOptions,
};
use crate::sse::frame::{SseFrame, SseParser};

/// 增量流读取状态（[read_sse_stream] 的 unfold 状态机）
struct FrameStreamState<R>
where
    R: ChunkReader,
{
    reader: R,
    parser: SseParser,
    options: StreamReadOptions,
    abort: AbortHandle,
    started_at: Instant,
    /// 已读块数 / 字节数（诊断字段）
    chunks: u64,
    bytes: u64,
    /// 首块尚未到达（first-byte 超时窗口内）
    first_byte_pending: bool,
    /// 待发条目（一次读取可产出诊断 + 多帧，逐条流出不缓存）
    pending: VecDeque<Result<StreamFrameEvent, SseReadError<R::Error>>>,
    /// 流已收尾（EOF / [DONE] / 错误后）
    done: bool,
}

/// 增量读取 SSE 流（T09.1 真增量形态：逐块读取 → 逐帧/诊断异步产出）
///
/// 与 [read_sse] 共享同一套超时 / abort / 诊断语义（[select_next_chunk] +
/// [stream_diagnostic]），区别是**边读边产出**而非收完才返回：
/// - 每块字节到达即分帧，完整帧立即成为流条目（首帧到达即产出首帧，
///   不等流结束）；
/// - 首块到达产出 `sse-first-byte` 诊断、流结束（EOF 或 `[DONE]`）产出
///   `stream-end` 诊断，按发生顺序逐条流出；
/// - 读取错误（超时 / abort / 传输 / 分帧）以 `Err` 条目终止流，之后流
///   立即结束（对齐 02 §六.2：绝不静默结束）。
///
/// 调用方取消 = drop 流（读取 future 随流丢弃，无残留任务）。
pub fn read_sse_stream<R>(
    reader: R,
    options: StreamReadOptions,
    abort: AbortHandle,
) -> Pin<Box<dyn Stream<Item = StreamFrameItem<R::Error>> + Send>>
where
    R: ChunkReader + Send + 'static,
{
    let started_at = Instant::now();
    let state = FrameStreamState {
        reader,
        parser: SseParser::new(),
        options,
        abort,
        started_at,
        chunks: 0,
        bytes: 0,
        first_byte_pending: true,
        pending: VecDeque::new(),
        done: false,
    };
    Box::pin(stream_unfold(state, |mut state| async move {
        loop {
            // 1. 待发条目优先逐条流出（一次读取可产出诊断 + 多帧）
            if let Some(item) = state.pending.pop_front() {
                return Some((item, state));
            }
            // 2. 已收尾：无待发条目即流结束
            if state.done {
                return None;
            }
            match select_next_chunk(
                &mut state.reader,
                &mut state.abort,
                &state.options,
                state.first_byte_pending,
            )
            .await
            {
                // 读取错误：Err 条目终止流（之后立即结束）
                Err(err) => {
                    state.done = true;
                    return Some((Err(err), state));
                }
                // EOF：解析末尾残留帧 + stream-end 诊断
                Ok(None) => {
                    state.done = true;
                    match state.parser.finish() {
                        Ok(frames) => {
                            for frame in frames {
                                state.pending.push_back(Ok(StreamFrameEvent::Frame(frame)));
                            }
                            if let Some(ctx) = &state.options.diagnostics {
                                state.pending.push_back(Ok(StreamFrameEvent::Diagnostic(
                                    stream_diagnostic(
                                        ProviderDiagnosticPhase::StreamEnd,
                                        ctx,
                                        state.started_at,
                                        state.chunks,
                                        state.bytes,
                                    ),
                                )));
                            }
                        }
                        Err(err) => return Some((Err(SseReadError::Frame(err)), state)),
                    }
                }
                Ok(Some(bytes)) => {
                    state.chunks += 1;
                    state.bytes += bytes.len() as u64;
                    // 首块到达：产出 sse-first-byte 诊断（02 §六.1）
                    if state.first_byte_pending {
                        state.first_byte_pending = false;
                        if let Some(ctx) = &state.options.diagnostics {
                            state.pending.push_back(Ok(StreamFrameEvent::Diagnostic(
                                stream_diagnostic(
                                    ProviderDiagnosticPhase::SseFirstByte,
                                    ctx,
                                    state.started_at,
                                    state.chunks,
                                    state.bytes,
                                ),
                            )));
                        }
                    }
                    match state.parser.push(&bytes) {
                        // 分帧失败：Err 条目终止流
                        Err(err) => {
                            state.done = true;
                            return Some((Err(SseReadError::Frame(err)), state));
                        }
                        Ok(frames) => {
                            let done = frames.iter().any(SseFrame::is_done);
                            // [DONE] 哨兵被消费（对齐 TS：遇 [DONE] 立即 return）
                            for frame in frames {
                                if !frame.is_done() {
                                    state.pending.push_back(Ok(StreamFrameEvent::Frame(frame)));
                                }
                            }
                            if done {
                                state.done = true;
                                // [DONE] 路径同样产出 stream-end 诊断
                                if let Some(ctx) = &state.options.diagnostics {
                                    state.pending.push_back(Ok(StreamFrameEvent::Diagnostic(
                                        stream_diagnostic(
                                            ProviderDiagnosticPhase::StreamEnd,
                                            ctx,
                                            state.started_at,
                                            state.chunks,
                                            state.bytes,
                                        ),
                                    )));
                                }
                            }
                        }
                    }
                }
            }
        }
    }))
}
