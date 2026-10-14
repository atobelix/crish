//! 增量帧流解析状态机（SR-04 拆分 · engine_provider.rs → engine_provider/stream.rs）
//!
//! 承载 [HttpStreamState] 状态机、[http_stream_next] 逐事件产出、
//! [HttpStreamParser]（四态，定义见 protocol.rs）、分类转换
//! （[to_classified] / [classify_stream_parse] / [to_loop_event]）与全局会话
//! AbortSignal 注册表。
//! 头钉：SR-04 · 拆分 · ≠ EL（结构性搬移，不改语义；仅 HttpStreamParser
//! 态集扩为四态，归属 protocol.rs 定义）。

use std::collections::HashMap;
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{OnceLock, RwLock};

use agent_provider::error::{classify_provider_error, source_from_sse_read_error};
use agent_provider::events::{ProviderStreamEvent as WireEvent, StreamParseError};
use agent_provider::transport::StreamFrameEvent;
use conex_types::error::ProviderErrorKind;
use conex_types::response::ClassifiedStreamError;
use futures_util::{Stream, StreamExt};
use session_loop::stream::{ProviderStreamEvent, ProviderUsage, StopReason as LoopStopReason};

use super::protocol::HttpStreamParser;

/// provider 调用适配层（B6.4：ProviderCall 的真实实现，T09.1 增量流）
///
/// 流式契约（PE-02 §3.1）：流前 Err（传输/HTTP/非 2xx，零事件，进重试）；
/// 流中 Err（已产出内容保留收场）；每流恰好一个 Stop；返回流为 `'static`。
static SESSION_ABORT_REGISTRY: OnceLock<RwLock<HashMap<String, session_loop::AbortSignal>>> =
    OnceLock::new();

fn session_abort_registry() -> &'static RwLock<HashMap<String, session_loop::AbortSignal>> {
    SESSION_ABORT_REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// 注册会话的 AbortSignal（供外部生命周期挂载；测试注入用）
#[cfg(test)]
pub(crate) fn register_session_abort_signal(
    session_id: impl Into<String>,
    signal: session_loop::AbortSignal,
) {
    if let Ok(mut reg) = session_abort_registry().write() {
        reg.insert(session_id.into(), signal);
    }
}

/// 注销会话的 AbortSignal
#[cfg(test)]
pub(crate) fn unregister_session_abort_signal(session_id: &str) {
    if let Ok(mut reg) = session_abort_registry().write() {
        reg.remove(session_id);
    }
}

/// 获取会话的 AbortSignal
pub(crate) fn get_session_abort_signal(session_id: &str) -> Option<session_loop::AbortSignal> {
    session_abort_registry()
        .read()
        .ok()?
        .get(session_id)
        .cloned()
}

/// 增量解析状态机（T09.1：帧流 → 解析器 → 待发事件队列）
pub(crate) struct HttpStreamState {
    /// 底层帧流（帧 / 诊断 / 读取错误；错误后流立即结束）
    pub(crate) frames: Pin<
        Box<
            dyn Stream<
                    Item = Result<
                        StreamFrameEvent,
                        agent_provider::sse::SseReadError<reqwest::Error>,
                    >,
                > + Send,
        >,
    >,
    /// 端点解析器（URL/body 与解析器必须同轨，见 protocol::http_parser_for）
    pub(crate) parser: HttpStreamParser,
    /// 待发事件（一次读取可产出多帧事件，逐条流出）
    pub(crate) pending: VecDeque<ProviderStreamEvent>,
    /// 帧流已收尾（EOF 后 finish 事件已入队 / 错误终止）
    pub(crate) finished: bool,
}

/// 产出下一条流条目（Ok 事件 / Err 已分类错误；None = 流结束）
///
/// 顺序（T09.1.2 步骤 2）：
/// - 帧到达 → `parser.push_frame` → 该帧触发的事件逐条产出；
/// - 诊断条目 → provider-diagnostic 事件；
/// - EOF → `parser.finish()` → 剩余事件（flush pending + 唯一 stop）；
/// - 读取错误 → 分类后以 Err 条目终止流（02 §六.2 绝不静默结束）；
/// - 解析错误 → Unknown / 不可重试分类（保持既有语义）。
pub(crate) async fn http_stream_next(
    state: &mut HttpStreamState,
) -> Option<Result<ProviderStreamEvent, ClassifiedStreamError>> {
    loop {
        // 待发事件优先逐条流出
        if let Some(event) = state.pending.pop_front() {
            return Some(Ok(event));
        }
        if state.finished {
            return None;
        }
        match state.frames.next().await {
            None => match state.parser.finish() {
                Ok(events) => {
                    state
                        .pending
                        .extend(events.into_iter().filter_map(to_loop_event));
                    state.finished = true;
                }
                Err(error) => {
                    state.finished = true;
                    return Some(Err(classify_stream_parse(&error)));
                }
            },
            Some(Ok(StreamFrameEvent::Frame(frame))) => match state.parser.push_frame(&frame) {
                Ok(events) => {
                    state
                        .pending
                        .extend(events.into_iter().filter_map(to_loop_event));
                }
                Err(error) => {
                    state.finished = true;
                    return Some(Err(classify_stream_parse(&error)));
                }
            },
            Some(Ok(StreamFrameEvent::Diagnostic(diagnostic))) => {
                state
                    .pending
                    .push_back(ProviderStreamEvent::ProviderDiagnostic { diagnostic });
            }
            Some(Err(read_error)) => {
                state.finished = true;
                let source = source_from_sse_read_error(&read_error);
                let classified = classify_provider_error(None, None, Some(source), None);
                return Some(Err(to_classified(classified)));
            }
        }
    }
}

/// 分类错误 → 已分类流错误（02 §4.2 分类表产物）
pub(crate) fn to_classified(
    provider_error: agent_provider::error::ProviderError,
) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: provider_error.kind(),
        message: provider_error.to_string(),
        retryable: provider_error.is_retryable(),
        retry_after_ms: provider_error.retry_after().map(|d| d.as_millis() as u64),
    }
}

/// 解析错误分类：Unknown / 不可重试（T09.1.2 步骤 2，语义保持）。
pub(crate) fn classify_stream_parse(_error: &StreamParseError) -> ClassifiedStreamError {
    ClassifiedStreamError {
        kind: ProviderErrorKind::Unknown,
        message: _error.to_string(),
        retryable: false,
        retry_after_ms: None,
    }
}

/// agent-provider 低级事件 → session-loop 消费事件（形状一致，逐字段转换；
/// session-loop 不直接依赖 agent-provider，B3.4 第 5 点）。
///
/// 返回 `None` 表示该事件不进入会话循环（当前仅生命周期观测事件），
/// 调用方以 `filter_map` 消费——严禁对未知变体 panic（历史教训：
/// 此处曾对观测事件写 `unreachable!`，属跨任务 panic 地雷，已裁决拆除，
/// 与 agent-provider `consume/mod.rs` 的静默跳过语义对齐）。
///
/// T3.3（G1-c）兼容注记：agent-provider `WireEvent::Stop` 当前无 `error_kind`
/// 分类字段（events.rs 升级在波 1 并行契约侧排期）。若并行 Agent 已完成字段
/// 升级，此处补 `error_kind` 透传；否则恒 None，只标 providerError 不伪造
/// （与 session-loop stream.rs 向后兼容语义一致）。
pub(crate) fn to_loop_event(event: WireEvent) -> Option<ProviderStreamEvent> {
    match event {
        WireEvent::TextDelta { text } => Some(ProviderStreamEvent::TextDelta { text }),
        WireEvent::ThoughtDelta { text, redacted } => {
            Some(ProviderStreamEvent::ThoughtDelta { text, redacted })
        }
        WireEvent::ToolCall {
            id,
            tool_name,
            input,
        } => Some(ProviderStreamEvent::ToolCall {
            id,
            tool_name,
            input,
        }),
        WireEvent::ProviderDiagnostic { diagnostic } => {
            Some(ProviderStreamEvent::ProviderDiagnostic { diagnostic })
        }
        // M14：model 请求生命周期观测事件（before-request / after-response）——
        // 消费面在 agent-provider 请求层观测器，不进入会话循环事件流；静默跳过。
        WireEvent::BeforeRequest { .. } | WireEvent::AfterResponse { .. } => {
            tracing::debug!(target: "provider", "model 请求生命周期观测事件不进入会话循环");
            None
        }
        WireEvent::Stop {
            reason,
            error,
            error_kind,
            usage,
        } => Some(ProviderStreamEvent::Stop {
            reason: match reason {
                agent_provider::events::StopReason::Stop => LoopStopReason::Stop,
                agent_provider::events::StopReason::ToolCall => LoopStopReason::ToolCall,
                agent_provider::events::StopReason::Length => LoopStopReason::Length,
                agent_provider::events::StopReason::Error => LoopStopReason::Error,
            },
            error,
            error_kind,
            usage: usage.map(|usage| ProviderUsage {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                cache_read_tokens: usage.cache_read_tokens,
                cache_write_tokens: usage.cache_write_tokens,
                cache_miss_tokens: usage.cache_miss_tokens,
                reasoning_tokens: usage.reasoning_tokens,
            }),
        }),
    }
}
