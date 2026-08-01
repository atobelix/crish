//! SSE 读取器（任务书 B2.3；02-provider-semantics.md §二.1、§六.1-2）
//!
//! 与 reqwest 解耦的增量读取：first-byte/idle 双段超时、abort 中断挂起 read、
//! sse-first-byte/stream-end 诊断（对齐 TS readSseJson 29-182）。分帧与流控
//! 逻辑全部在本模块，reqwest 侧（transport）只做字节流适配，便于测试。
//!
//! 超时/abort 一律以错误上抛，绝不静默结束（02 §六.2）。

use std::collections::VecDeque;
use std::pin::Pin;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};
use futures_util::Stream;
use futures_util::stream::unfold as stream_unfold;
use tokio::sync::watch;

use super::frame::{SseFrame, SseFrameError, SseParser};

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
        let _ = self.tx.send(true);
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

/// sse-first-byte/stream-end 诊断的公共上下文（对齐 TS SseDiagnosticsOptions 子集）
#[derive(Debug, Clone, Default)]
pub struct StreamDiagnosticContext {
    /// provider 标识
    pub provider_id: Option<String>,
    /// 端点标识
    pub endpoint: Option<String>,
    /// 请求 URL
    pub url: Option<String>,
    /// 当前尝试次数
    pub attempt: Option<u32>,
    /// 最大尝试次数
    pub max_attempts: Option<u32>,
}

/// 读取选项（02 §六.2：first-byte 与 idle 超时独立可配）
#[derive(Debug, Clone, Default)]
pub struct StreamReadOptions {
    /// 首个字节到达前超时（None 或零时长 = 不设限，对齐 normalizeStreamTimeoutMs）
    pub first_byte_timeout: Option<Duration>,
    /// 块间空闲超时（None 或零时长 = 不设限）
    pub idle_timeout: Option<Duration>,
    /// 诊断上下文；Some 时产出 sse-first-byte/stream-end 诊断，None 不产出
    pub diagnostics: Option<StreamDiagnosticContext>,
}

/// 读取结果
#[derive(Debug, Default)]
pub struct StreamReadOutput {
    /// 已分帧的帧（`[DONE]` 哨兵帧已被消费，不包含在结果中）
    pub frames: Vec<SseFrame>,
    /// sse-first-byte / stream-end 诊断
    pub diagnostics: Vec<ProviderDiagnostic>,
    /// 已读块数
    pub chunks: u64,
    /// 已读字节数
    pub bytes: u64,
    /// 自开始读到流结束的耗时
    pub elapsed: Duration,
}

/// 读取错误（02 §六.2：超时/abort 以错误上抛而非静默结束）
#[derive(Debug, thiserror::Error)]
pub enum SseReadError<E: std::error::Error + Send + Sync + 'static> {
    /// 底层传输读取失败
    #[error("传输层读取失败: {0}")]
    Transport(#[source] E),
    /// 分帧失败（无效 UTF-8 / 形似 JSON 的损坏帧）
    #[error("分帧失败: {0}")]
    Frame(#[from] SseFrameError),
    /// 流被外部 abort 中断（02 §六.2：abort 必须能中断挂起 read）
    #[error("流已被外部取消（abort）")]
    Aborted,
    /// first-byte 超时
    #[error("等待流首个字节超时（限 {0:?}）")]
    FirstByteTimeout(Duration),
    /// idle 超时
    #[error("流空闲超时（{0:?} 内无新数据）")]
    IdleTimeout(Duration),
}

/// 归一化超时：零时长视为无超时（对齐 TS normalizeStreamTimeoutMs，02 §二.1:211-217）
fn normalize_timeout(timeout: Option<Duration>) -> Option<Duration> {
    timeout.filter(|duration| !duration.is_zero())
}

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
async fn select_next_chunk<R>(
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

/// 构造流诊断（sse-first-byte / stream-end 共用字段，对齐 TS 122-137,184-205）
fn stream_diagnostic(
    phase: ProviderDiagnosticPhase,
    ctx: &StreamDiagnosticContext,
    started_at: Instant,
    chunks: u64,
    bytes: u64,
) -> ProviderDiagnostic {
    ProviderDiagnostic {
        phase,
        provider_id: ctx.provider_id.clone(),
        endpoint: ctx.endpoint.clone(),
        url: ctx.url.clone(),
        attempt: ctx.attempt,
        max_attempts: ctx.max_attempts,
        elapsed_ms: Some(started_at.elapsed().as_millis() as u64),
        chunks: Some(chunks),
        bytes: Some(bytes),
        ..ProviderDiagnostic::default()
    }
}

/// 增量流条目（[read_sse_stream] 的产出：帧或诊断）
///
/// 说明：与 AgentEvent / ProviderStreamEvent 同理由显式允许大变体——
/// [ProviderDiagnostic] 携带完整观测字段，事件按值短暂传递是主用途。
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum StreamFrameEvent {
    /// 已分帧的帧（`[DONE]` 哨兵帧被消费，不产出）
    Frame(SseFrame),
    /// sse-first-byte / stream-end 诊断（配置了 diagnostics 时产出）
    Diagnostic(ProviderDiagnostic),
}

/// 增量流条目结果别名（帧/诊断 or 读取错误；错误后流立即结束）
pub type StreamFrameItem<E> = Result<StreamFrameEvent, SseReadError<E>>;

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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// 脚本化块读取器：由无界通道驱动，可模拟任意字节序列 / EOF / 挂起
    struct ChannelReader {
        rx: mpsc::UnboundedReceiver<Vec<u8>>,
    }

    #[async_trait]
    impl ChunkReader for ChannelReader {
        type Error = std::io::Error;

        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, Self::Error> {
            Ok(self.rx.recv().await)
        }
    }

    /// 恒报错的读取器（验证传输错误上抛）
    struct ErrorReader;

    #[async_trait]
    impl ChunkReader for ErrorReader {
        type Error = std::io::Error;

        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, Self::Error> {
            Err(std::io::Error::other("模拟传输故障"))
        }
    }

    /// 发送全部块后关闭通道（EOF），读取到流结束
    async fn collect(input: Vec<Vec<u8>>) -> StreamReadOutput {
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

    fn data_of(frames: &[SseFrame], index: usize) -> &str {
        frames[index].data.as_deref().unwrap_or("<无 data>")
    }

    #[tokio::test]
    async fn reads_frames_across_chunks_with_utf8_split() {
        // "data: {\"msg\":\"中\"}\n\n" 拆成 4 块（含 中 的三字节跨块）
        let input = vec![
            b"data: {\"msg\":\"".to_vec(),
            vec![0xE4, 0xB8],
            vec![0xAD],
            b"\"}\n\n".to_vec(),
        ];
        let output = collect(input).await;
        assert_eq!(output.frames.len(), 1);
        assert_eq!(data_of(&output.frames, 0), "{\"msg\":\"中\"}");
        assert_eq!(output.chunks, 4);
        assert!(output.bytes > 0);
    }

    #[tokio::test]
    async fn emits_first_byte_and_stream_end_diagnostics() {
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
        drop(tx);
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            diagnostics: Some(StreamDiagnosticContext {
                provider_id: Some("test-provider".into()),
                url: Some("http://example.test/stream".into()),
                attempt: Some(1),
                max_attempts: Some(3),
                ..StreamDiagnosticContext::default()
            }),
            ..StreamReadOptions::default()
        };
        let output = read_sse(&mut reader, &mut parser, &options, &mut abort)
            .await
            .unwrap();

        assert_eq!(output.diagnostics.len(), 2);
        assert_eq!(
            output.diagnostics[0].phase,
            ProviderDiagnosticPhase::SseFirstByte
        );
        assert_eq!(
            output.diagnostics[0].provider_id.as_deref(),
            Some("test-provider")
        );
        assert_eq!(
            output.diagnostics[0].url.as_deref(),
            Some("http://example.test/stream")
        );
        assert_eq!(output.diagnostics[0].attempt, Some(1));
        assert_eq!(output.diagnostics[0].max_attempts, Some(3));
        assert_eq!(output.diagnostics[0].chunks, Some(1));
        assert!(output.diagnostics[0].elapsed_ms.is_some());
        assert_eq!(
            output.diagnostics[1].phase,
            ProviderDiagnosticPhase::StreamEnd
        );
    }

    #[tokio::test]
    async fn no_diagnostics_when_disabled() {
        let output = collect(vec![b"data: {\"a\":1}\n\n".to_vec()]).await;
        assert!(output.diagnostics.is_empty());
    }

    #[tokio::test]
    async fn first_byte_timeout_raises_error() {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let _keep_open = tx; // 不关闭通道 → 读取挂起直到超时
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::from_millis(50)),
            ..StreamReadOptions::default()
        };
        let error = read_sse(&mut reader, &mut parser, &options, &mut abort)
            .await
            .unwrap_err();
        assert!(
            matches!(error, SseReadError::FirstByteTimeout(_)),
            "应上抛超时而非静默结束"
        );
    }

    #[tokio::test]
    async fn idle_timeout_raises_error_after_first_chunk() {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
        let _keep_open = tx;
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            idle_timeout: Some(Duration::from_millis(50)),
            ..StreamReadOptions::default()
        };
        let error = read_sse(&mut reader, &mut parser, &options, &mut abort)
            .await
            .unwrap_err();
        assert!(
            matches!(error, SseReadError::IdleTimeout(_)),
            "首块之后空闲应上抛 idle 超时"
        );
    }

    #[tokio::test]
    async fn abort_interrupts_pending_read() {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let _keep_open = tx;
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions::default();
        let handle =
            tokio::spawn(
                async move { read_sse(&mut reader, &mut parser, &options, &mut abort).await },
            );
        tokio::time::sleep(Duration::from_millis(50)).await;
        flag.abort();
        let error = handle.await.unwrap().unwrap_err();
        assert!(
            matches!(error, SseReadError::Aborted),
            "abort 应中断挂起 read 并以错误上抛"
        );
    }

    #[tokio::test]
    async fn abort_before_start_returns_aborted() {
        let (flag, mut abort) = AbortFlag::new();
        flag.abort();
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        drop(tx);
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let error = read_sse(
            &mut reader,
            &mut parser,
            &StreamReadOptions::default(),
            &mut abort,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, SseReadError::Aborted));
    }

    #[tokio::test]
    async fn abort_wins_over_ready_data() {
        // 数据与 abort 同时就绪时，abort 优先（biased 顺序）
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
        let _keep_open = tx;
        let (flag, mut abort) = AbortFlag::new();
        flag.abort();
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let error = read_sse(
            &mut reader,
            &mut parser,
            &StreamReadOptions::default(),
            &mut abort,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, SseReadError::Aborted));
    }

    #[tokio::test]
    async fn transport_error_propagates() {
        let mut reader = ErrorReader;
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let error = read_sse(
            &mut reader,
            &mut parser,
            &StreamReadOptions::default(),
            &mut abort,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, SseReadError::Transport(_)));
    }

    #[tokio::test]
    async fn done_sentinel_terminates_and_drops_rest() {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tx.send(b"data: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\":2}\n\n".to_vec())
            .unwrap();
        drop(tx);
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            diagnostics: Some(StreamDiagnosticContext::default()),
            ..StreamReadOptions::default()
        };
        let output = read_sse(&mut reader, &mut parser, &options, &mut abort)
            .await
            .unwrap();
        assert_eq!(
            output.frames.len(),
            1,
            "[DONE] 哨兵帧不产出，其后的帧被丢弃"
        );
        assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
        assert!(parser.is_done());
        assert_eq!(
            output.diagnostics.len(),
            2,
            "[DONE] 路径同样产出 stream-end 诊断"
        );
    }

    #[tokio::test]
    async fn trailing_frame_without_separator_parsed_at_eof() {
        let output = collect(vec![b"data: {\"a\":1}".to_vec()]).await;
        assert_eq!(output.frames.len(), 1);
        assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
    }

    #[tokio::test]
    async fn malformed_json_frame_raises_frame_error() {
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tx.send(b"data: {bad\n\n".to_vec()).unwrap();
        drop(tx);
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let error = read_sse(
            &mut reader,
            &mut parser,
            &StreamReadOptions::default(),
            &mut abort,
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            SseReadError::Frame(SseFrameError::MalformedSseFrame { .. })
        ));
    }

    #[tokio::test]
    async fn zero_timeout_is_treated_as_no_timeout() {
        // 对齐 normalizeStreamTimeoutMs：≤0 视为无超时
        let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
        drop(tx);
        let mut reader = ChannelReader { rx };
        let mut parser = SseParser::new();
        let (_flag, mut abort) = AbortFlag::new();
        let options = StreamReadOptions {
            first_byte_timeout: Some(Duration::ZERO),
            idle_timeout: Some(Duration::ZERO),
            ..StreamReadOptions::default()
        };
        let output = read_sse(&mut reader, &mut parser, &options, &mut abort)
            .await
            .unwrap();
        assert_eq!(output.frames.len(), 1);
    }

    #[tokio::test]
    async fn keepalive_stream_does_not_break() {
        let output = collect(vec![b": ping\n\ndata: {\"a\":1}\n\n: pong\n\n".to_vec()]).await;
        assert_eq!(output.frames.len(), 1, "keep-alive 注释不炸流");
        assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
    }
}
