use std::time::Instant;

use conex_types::tool::ProviderDiagnosticPhase;

use super::abort::{AbortHandle, ChunkReader};
use super::types::{
    normalize_timeout, stream_diagnostic, SseReadError, StreamReadOptions, StreamReadOutput,
};
use crate::sse::frame::{SseFrame, SseParser};

/// 读取完整 SSE 流：逐块读取 → 增量 UTF-8 → 分帧（02 §六.1）
///
/// - first-byte 超时：首个字节到达前；idle 超时：块间间隔（TS readSseJson 85-90）；
/// - abort 通过 select! 竞速取消挂起中的 read 并上抛 [SseReadError::Aborted]；
/// - 首块到达产出 `sse-first-byte` 诊断、流结束产出 `stream-end` 诊断；
/// - 流结束尝试解析末尾残留（02 §二.1:169-179）。
pub async fn read_sse<R>(
    reader: &mut R,
    parser: &mut SseParser,
    options: &StreamReadOptions,
    abort: &mut AbortHandle,
) -> Result<StreamReadOutput, SseReadError<R::Error>>
where
    R: ChunkReader + ?Sized,
{
    let started_at = Instant::now();
    let mut output = StreamReadOutput::default();
    let mut first_byte_pending = true;

    while let Some(bytes) = select_next_chunk(reader, abort, options, first_byte_pending).await? {
        output.chunks += 1;
        output.bytes += bytes.len() as u64;
        if first_byte_pending {
            first_byte_pending = false;
            if let Some(ctx) = &options.diagnostics {
                output.diagnostics.push(stream_diagnostic(
                    ProviderDiagnosticPhase::SseFirstByte,
                    ctx,
                    started_at,
                    output.chunks,
                    output.bytes,
                ));
            }
        }
        let frames = parser.push(&bytes).map_err(SseReadError::Frame)?;
        let done = frames.iter().any(SseFrame::is_done);
        // [DONE] 哨兵帧被消费（对齐 TS：遇 [DONE] 直接 return）
        output
            .frames
            .extend(frames.into_iter().filter(|frame| !frame.is_done()));
        if done {
            break;
        }
    }

    // 流结束：残留 buffer 尝试解析 + stream-end 诊断（02 §二.1:169-179,184-205）
    let final_frames = parser.finish().map_err(SseReadError::Frame)?;
    output.frames.extend(final_frames);
    output.elapsed = started_at.elapsed();
    if let Some(ctx) = &options.diagnostics {
        output.diagnostics.push(stream_diagnostic(
            ProviderDiagnosticPhase::StreamEnd,
            ctx,
            started_at,
            output.chunks,
            output.bytes,
        ));
    }
    Ok(output)
}

/// 单块读取：abort/超时与数据竞速（biased：abort 优先判定）
pub(crate) async fn select_next_chunk<R>(
    reader: &mut R,
    abort: &mut AbortHandle,
    options: &StreamReadOptions,
    first_byte_pending: bool,
) -> Result<Option<Vec<u8>>, SseReadError<R::Error>>
where
    R: ChunkReader + ?Sized,
{
    let timeout = normalize_timeout(if first_byte_pending {
        options.first_byte_timeout
    } else {
        options.idle_timeout
    });

    match timeout {
        Some(duration) => tokio::select! {
            biased;
            _ = abort.wait_abort() => Err(SseReadError::Aborted),
            result = reader.next_chunk() => result.map_err(SseReadError::Transport),
            _ = tokio::time::sleep(duration) => {
                if first_byte_pending {
                    Err(SseReadError::FirstByteTimeout(duration))
                } else {
                    Err(SseReadError::IdleTimeout(duration))
                }
            }
        },
        None => tokio::select! {
            biased;
            _ = abort.wait_abort() => Err(SseReadError::Aborted),
            result = reader.next_chunk() => result.map_err(SseReadError::Transport),
        },
    }
}
