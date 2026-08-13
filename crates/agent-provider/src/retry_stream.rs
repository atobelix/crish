//! 可中断睡眠与高层流封装域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 retry.rs 拆出的实现域（门面 retry.rs re-export 全部公开符号，对外路径不变）：
//! - 可中断睡眠抽象（[RetrySleeper] / [TokioSleeper]，abort 竞速中断）
//! - 一次流尝试结果载体（[StreamAttempt]）
//! - 高层流封装（[provider_stream] / [provider_stream_with_observer]）

use std::future::Future;
use std::time::{Duration, Instant};

use async_trait::async_trait;

use crate::error::ProviderError;
use crate::events::{ModelRequestInfo, ModelRequestObserver, ModelResponseInfo};
use crate::sse::{AbortHandle, SseFrame};

use super::retry_decision::{should_retry, RetryPolicy, RetryState};

/// 可中断睡眠抽象（便于测试注入时钟/记录等待）
#[async_trait]
pub trait RetrySleeper: Send {
    /// 睡眠指定时长；abort 中断时返回 [ProviderError::Aborted]
    async fn sleep(&mut self, duration: Duration) -> Result<(), ProviderError>;
}

/// 默认实现：tokio::time::sleep + abort 竞速（对齐 TS delay 可中断，
/// openai-retry.ts:86-101；biased 顺序保证 abort 优先判定）
pub struct TokioSleeper {
    abort: AbortHandle,
}

impl TokioSleeper {
    /// 用成对的 [AbortHandle] 构造（来自 AbortFlag::new）
    pub fn new(abort: AbortHandle) -> Self {
        Self { abort }
    }
}

#[async_trait]
impl RetrySleeper for TokioSleeper {
    async fn sleep(&mut self, duration: Duration) -> Result<(), ProviderError> {
        tokio::select! {
            biased;
            _ = self.abort.wait_abort() => Err(ProviderError::Aborted),
            _ = tokio::time::sleep(duration) => Ok(()),
        }
    }
}

/// 一次流尝试的结果（重试循环输入）
#[derive(Debug)]
pub struct StreamAttempt {
    /// 成功时完整帧序列；失败时已读取到的帧（调用方自行决定取舍）
    pub frames: Vec<SseFrame>,
    /// 失败原因（None = 本次尝试成功）
    pub error: Option<ProviderError>,
    /// 失败前是否已产出正文内容（text/thought/tool-call 事件；诊断/usage 不算）
    ///
    /// 流已产出内容时中途错误不重试（02 §六.7/§1.3：重试会重复已流出的内容）。
    pub produced_content: bool,
}

/// 高层流封装：发送请求 → 分类错误 → should_retry → 退避重试（02 §六.7-8）
///
/// - `attempt` 为单次尝试（构建请求、发送、读流、分类错误），由调用方闭包实现；
/// - 循环内对可重试错误按 [RetryPolicy] 退避等待后重试；abort 与不可重试错误
///   立即上抛；流已产出内容时中途错误不重试；
/// - 成功返回完整帧序列（B2.8 消费层再解析为事件）。
///
/// M14：本函数为 [provider_stream_with_observer] 的薄包装（不挂观测器，
/// 保持既有调用面与语义不变）。
pub async fn provider_stream<F, Fut>(
    policy: &RetryPolicy,
    sleeper: &mut dyn RetrySleeper,
    state: &mut RetryState,
    attempt: F,
) -> Result<Vec<SseFrame>, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = StreamAttempt>,
{
    provider_stream_with_observer(policy, sleeper, state, None, attempt).await
}

/// 高层流封装（带 model 请求生命周期观测器，M14：model.beforeRequest /
/// model.afterResponse 事件源发射点）
///
/// 发射语义：
/// - **请求前**（before-request）：每次尝试发起前发射（含重试循环内的
///   每一次尝试；`attempt` 从 1 起递增）；
/// - **响应后**（after-response）：每次尝试结束后发射（成功/失败均触发，
///   携带 ok/error 与单次耗时）；
/// - 观测器只观测不改写：回调失败不影响请求路径（trait 为不可失败签名）；
/// - `None` = 不发射（与 [provider_stream] 行为一致）。
pub async fn provider_stream_with_observer<F, Fut>(
    policy: &RetryPolicy,
    sleeper: &mut dyn RetrySleeper,
    state: &mut RetryState,
    observer: Option<&dyn ModelRequestObserver>,
    mut attempt: F,
) -> Result<Vec<SseFrame>, ProviderError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = StreamAttempt>,
{
    loop {
        let attempt_number = state.retries + 1;
        let started = Instant::now();
        if let Some(observer) = observer {
            observer.on_before_request(&ModelRequestInfo {
                url: None,
                model: None,
                max_tokens: None,
                attempt: attempt_number,
            });
        }
        let outcome = attempt().await;
        let duration_ms = started.elapsed().as_millis() as u64;
        match outcome {
            // 成功：返回完整帧
            StreamAttempt {
                error: None,
                frames,
                ..
            } => {
                if let Some(observer) = observer {
                    observer.on_after_response(&ModelResponseInfo {
                        status: None,
                        ok: true,
                        error: None,
                        duration_ms,
                        usage: None,
                    });
                }
                return Ok(frames);
            }
            // 已产出内容：不重试，直接上抛（02 §六.7 语义）
            StreamAttempt {
                error: Some(error),
                produced_content: true,
                ..
            } => {
                if let Some(observer) = observer {
                    observer.on_after_response(&ModelResponseInfo {
                        status: None,
                        ok: false,
                        error: Some(error.to_string()),
                        duration_ms,
                        usage: None,
                    });
                }
                return Err(error);
            }
            // 未产出内容：可重试则退避等待后重试，否则上抛
            StreamAttempt {
                error: Some(error),
                produced_content: false,
                ..
            } => {
                if let Some(observer) = observer {
                    observer.on_after_response(&ModelResponseInfo {
                        status: None,
                        ok: false,
                        error: Some(error.to_string()),
                        duration_ms,
                        usage: None,
                    });
                }
                // abort 一律直接传播（02 §4.2 第 1 行）
                if matches!(error, ProviderError::Aborted) {
                    return Err(error);
                }
                match should_retry(&error, policy, state) {
                    Some(decision) => {
                        tracing::debug!(
                            attempt = decision.attempt,
                            delay_ms = decision.delay.as_millis() as u64,
                            "provider 错误可重试，退避后重试"
                        );
                        sleeper.sleep(decision.delay).await?;
                        state.retries += 1;
                    }
                    None => return Err(error),
                }
            }
        }
    }
}
