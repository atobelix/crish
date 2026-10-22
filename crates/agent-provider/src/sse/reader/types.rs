use std::time::{Duration, Instant};

use conex_types::tool::{ProviderDiagnostic, ProviderDiagnosticPhase};

use crate::sse::frame::{SseFrame, SseFrameError};

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
pub(crate) fn normalize_timeout(timeout: Option<Duration>) -> Option<Duration> {
    timeout.filter(|duration| !duration.is_zero())
}

/// 构造流诊断（sse-first-byte / stream-end 共用字段，对齐 TS 122-137,184-205）
pub(crate) fn stream_diagnostic(
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
