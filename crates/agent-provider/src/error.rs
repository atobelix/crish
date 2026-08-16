//! Provider 错误分类（任务书 B2.7；02-provider-semantics.md §四、§六.7）
//!
//! 对齐 TS 端 provider-error-classifier.ts 与 error-classifier.ts（模型 + runtime 双拷贝）：
//! - [ProviderError] 为分类产物枚举，`kind()` 收敛为 conex-types 的
//!   [ProviderErrorKind] 13 类（02 §4.2 分类表 13 行逐行，判定优先级从上到下）；
//! - [classify_provider_error] 是分类管线入口：HTTP 状态码优先，消息模式兜底，
//!   transport 源（连接失败/流中断）按 runtime 行为必须可重试（02 §五 #11）；
//! - 错误码复用 conex-types error.rs 既有 13 类，不重复定义（任务书 B2.7 复用 04 §1.2）。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 error_tests.rs）：
//! - [error_classify]：消息模式检测辅助（error-classifier.ts 各正则的 Rust 形态，
//!   classify_provider_error 的兜底判定面）
//!
//! 错误类型面（ProviderError 与四个来源细分枚举）为错误类型集中面，
//! 消费方按 ProviderError 模式匹配/透传的路径不变，保持本文件单定义。

use std::time::{Duration, SystemTime};

use conex_types::error::{CrishError, ProviderErrorKind};
use thiserror::Error;

use crate::retry::parse_retry_after_ms;
use crate::sse::{SseFrameError, SseReadError};

#[path = "error_classify.rs"]
mod error_classify;

use error_classify::{
    contains_abort_words, detect_auth_message, detect_context_length_exceeded,
    detect_network_message, detect_quota_message, detect_rate_limit_message, detect_server_message,
    detect_timeout_message, is_server_status, looks_like_gateway_challenge,
    looks_like_payload_too_large_message,
};

/// 超时位置（02 §六.2：first-byte 与 idle 超时独立可配；请求级超时来自 reqwest）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutKind {
    /// 等待流首个字节超时
    FirstByte,
    /// 流块间空闲超时
    Idle,
    /// 请求整体超时（reqwest 层 is_timeout）
    Request,
}

/// 网络层错误来源细分（[ProviderError::Network] 携带）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkSourceKind {
    /// 连接失败（DNS / 建连 / TLS 握手）
    Connection,
    /// 流中途中断（连接断开、读取失败、消息模式匹配到的网络字样）
    StreamInterrupted,
}

/// 流协议错误细分（[ProviderError::Stream] 携带）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamErrorKind {
    /// 形似 JSON 的帧解析失败（02 §二.1 invalid-stream）
    MalformedFrame,
    /// 流内出现无法按 UTF-8 解码的字节序列
    InvalidUtf8,
}

/// 传输层/解析层错误源（分类输入之一；02 §五 #11：连接失败/流中断必须可重试）
///
/// 由 HTTP 层从 reqwest 错误与 [SseReadError] 归一而来：
/// - [source_from_reqwest_error]：reqwest 错误 → 超时/连接/中断
/// - [source_from_sse_read_error]：SSE 读取错误 → abort/超时/分帧/传输
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSourceError {
    /// 外部 abort（底层 USER_ABORT，02 §4.2 第 1 行）
    Aborted,
    /// 连接失败（reqwest 层 is_connect）
    Connection,
    /// 流中途中断（读取失败/连接断开）
    StreamInterrupted,
    /// 分帧/解码失败（invalid-stream）
    StreamProtocol(StreamErrorKind),
    /// 显式超时（first-byte / idle / 请求级）
    Timeout(TimeoutKind),
    /// 其他未知传输错误（交给消息模式兜底）
    Other,
}

/// Provider 错误（分类产物；02 §4.2 分类表 13 行 + 流协议错误）
///
/// 判定优先级与 TS ErrorClassifier.classify 完全一致（状态码 → transport 源 →
/// 消息模式兜底）；`kind()` 把全部变体收敛为 [ProviderErrorKind] 13 类，
/// 错误码映射复用 conex-types（不重复定义）。
#[derive(Debug, Clone, PartialEq, Error)]
pub enum ProviderError {
    /// 第 1 行：signal.aborted / AbortError（底层 USER_ABORT），不可重试
    #[error("请求已被用户取消（abort）")]
    Aborted,
    /// 第 2 行：HTTP 413 请求体过大（payload_too_large），不可重试
    #[error("请求体过大（HTTP {status:?}）")]
    PayloadTooLarge { status: Option<u16> },
    /// 第 3 行：Cloudflare 质询（cf_chl / just a moment 等），不可重试
    #[error("Cloudflare 质询拦截（gateway-challenge）")]
    GatewayChallenge { status: Option<u16> },
    /// 第 4 行：HTTP 401/403 或 unauthorized/forbidden/invalid api key，不可重试
    /// （某些网关 403 是 key 无效，与 401 同判为 auth，02 §四）
    #[error("鉴权失败（HTTP {status:?}）")]
    Auth { status: Option<u16> },
    /// 第 5 行：HTTP 402 或 insufficient quota/out of credits，不可重试
    #[error("配额耗尽（HTTP {status:?}）")]
    Quota { status: Option<u16> },
    /// 第 6 行：HTTP 404/405/415 端点不可用，不可重试
    #[error("端点不可用（HTTP {status:?}）")]
    EndpointUnavailable { status: Option<u16> },
    /// 第 7 行：HTTP 400/422 且上下文超长（分类层标记可重试，02 §4.2 第 7 行；
    /// 但重试循环不直接重试——由上层压缩处理，见 retry::should_retry）
    #[error("上下文超长（HTTP {status:?}）")]
    ContextLength { status: Option<u16> },
    /// 第 8 行：HTTP 400/422 其余（含 payload too large 消息），不可重试
    #[error("非法请求：{message}")]
    InvalidRequest {
        status: Option<u16>,
        message: String,
    },
    /// 第 9 行：HTTP 429 或 rate limit 字样，可重试（携带 Retry-After）
    #[error("限流（HTTP {status:?}）")]
    RateLimit {
        status: Option<u16>,
        /// Retry-After（秒数或 HTTP-date 解析，上限 5 分钟，02 §4.3）
        retry_after: Option<Duration>,
    },
    /// 第 10 行：HTTP 500/502/503/504/520/522/523/524 等，可重试
    #[error("服务端错误（HTTP {status:?}）")]
    Server { status: Option<u16> },
    /// 第 11 行：超时（first-byte / idle / 请求级），可重试
    #[error("请求超时（{kind:?}）")]
    Timeout { kind: TimeoutKind },
    /// 第 12 行：传输层错误（连接失败/流中断，02 §五 #11 裁决必须可重试）
    #[error("传输层错误（{source_kind:?}）")]
    Network { source_kind: NetworkSourceKind },
    /// 流协议错误（分帧/解码失败，invalid-stream；归 Network 语义可重试）
    #[error("流协议错误（{kind:?}）")]
    Stream { kind: StreamErrorKind },
    /// 第 13 行：兜底未知错误，不可重试
    #[error("未知 Provider 错误：{message}")]
    Unknown { message: String },
}

impl ProviderError {
    /// 收敛为 conex-types 的 13 类（02 §4.2 分类表逐行）
    pub fn kind(&self) -> ProviderErrorKind {
        match self {
            ProviderError::Aborted => ProviderErrorKind::Aborted,
            ProviderError::PayloadTooLarge { .. } => ProviderErrorKind::PayloadTooLarge,
            ProviderError::GatewayChallenge { .. } => ProviderErrorKind::GatewayChallenge,
            ProviderError::Auth { .. } => ProviderErrorKind::Auth,
            ProviderError::Quota { .. } => ProviderErrorKind::Quota,
            ProviderError::EndpointUnavailable { .. } => ProviderErrorKind::EndpointUnavailable,
            ProviderError::ContextLength { .. } => ProviderErrorKind::ContextLengthExceeded,
            ProviderError::InvalidRequest { .. } => ProviderErrorKind::InvalidRequest,
            ProviderError::RateLimit { .. } => ProviderErrorKind::RateLimit,
            ProviderError::Server { .. } => ProviderErrorKind::ServerError,
            ProviderError::Timeout { .. } => ProviderErrorKind::Timeout,
            ProviderError::Network { .. } | ProviderError::Stream { .. } => {
                ProviderErrorKind::Network
            }
            ProviderError::Unknown { .. } => ProviderErrorKind::Unknown,
        }
    }

    /// 分类层可重试性（02 §4.2 默认矩阵；第 7 行 context_length 标记可重试）
    pub fn is_retryable(&self) -> bool {
        self.kind().default_retryable()
    }

    /// Retry-After（仅 rate-limit 携带）
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            ProviderError::RateLimit { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    /// 映射为 conex-types 的 CrishError（复用 error.rs 既有 provider 域码）
    pub fn to_crish_error(&self) -> CrishError {
        CrishError::new(self.kind().code(), self.to_string())
    }
}

/// 分类管线（02 §4.2 表 13 行，判定优先级从上到下；对齐 TS ErrorClassifier.classify）
///
/// 参数：
/// - `status`：HTTP 状态码（无则 None）；
/// - `body_text`：响应体/错误消息原文（消息模式兜底）；
/// - `source`：传输层/解析层错误源（[ProviderSourceError]，无则 Other）；
/// - `retry_after_header`：响应 Retry-After 头原文（秒数或 HTTP-date），仅 429 分类时解析。
///
/// 优先级顺序（runtime:error-classifier.ts:119-131 位置与模型消息模式顺序一致）：
/// abort → 413 → Cloudflare → 401/403 → 402 → 404/405/415 → 400/422 → 429 →
/// transport 源 → 消息模式（aborted/context/auth/quota/rate-limit/payload/
/// 5xx 状态/5xx 字样/timeout/network）→ 兜底 unknown。
pub fn classify_provider_error(
    status: Option<u16>,
    body_text: Option<&str>,
    source: Option<ProviderSourceError>,
    retry_after_header: Option<&str>,
) -> ProviderError {
    let message = body_text.unwrap_or("");
    let lower = message.to_ascii_lowercase();
    let source = source.unwrap_or(ProviderSourceError::Other);

    // 1. abort（signal.aborted / isAbortError 等价，error-classifier.ts:119-126）
    if source == ProviderSourceError::Aborted {
        return ProviderError::Aborted;
    }
    // 2. HTTP 413 → payload_too_large（:128-136）
    if status == Some(413) {
        return ProviderError::PayloadTooLarge { status };
    }
    // 3. Cloudflare 质询（:138-145）
    if looks_like_gateway_challenge(&lower) {
        return ProviderError::GatewayChallenge { status };
    }
    // 4. HTTP 401/403 → auth（:147-153；403 网关 key 无效同判）
    if matches!(status, Some(401) | Some(403)) {
        return ProviderError::Auth { status };
    }
    // 5. HTTP 402 → quota（:155-161）
    if status == Some(402) {
        return ProviderError::Quota { status };
    }
    // 6. HTTP 404/405/415 → endpoint_unavailable（:163-169）
    if matches!(status, Some(404) | Some(405) | Some(415)) {
        return ProviderError::EndpointUnavailable { status };
    }
    // 7. HTTP 400/422 → context_length_exceeded（唯一可重试 4xx）或其余非法请求
    if matches!(status, Some(400) | Some(422)) {
        if detect_context_length_exceeded(&lower) {
            return ProviderError::ContextLength { status };
        }
        return ProviderError::InvalidRequest {
            status,
            message: message.to_owned(),
        };
    }
    // 8. HTTP 429 → rate-limit + Retry-After（:192-199）
    if status == Some(429) {
        let retry_after = parse_retry_after_ms(retry_after_header, SystemTime::now());
        return ProviderError::RateLimit {
            status,
            retry_after,
        };
    }
    // 9. transport 源（runtime:error-classifier.ts:119-131；02 §五 #11 必须可重试）
    match source {
        ProviderSourceError::Connection => {
            return ProviderError::Network {
                source_kind: NetworkSourceKind::Connection,
            };
        }
        ProviderSourceError::StreamInterrupted => {
            return ProviderError::Network {
                source_kind: NetworkSourceKind::StreamInterrupted,
            };
        }
        ProviderSourceError::Timeout(kind) => return ProviderError::Timeout { kind },
        ProviderSourceError::StreamProtocol(kind) => return ProviderError::Stream { kind },
        ProviderSourceError::Aborted => unreachable!("abort 已在第 1 步拦截"),
        ProviderSourceError::Other => {}
    }
    // 10-19. 消息模式兜底（error-classifier.ts:205-314 顺序）
    if contains_abort_words(&lower) {
        return ProviderError::Aborted;
    }
    if detect_context_length_exceeded(&lower) {
        return ProviderError::ContextLength { status };
    }
    if detect_auth_message(&lower) {
        return ProviderError::Auth { status };
    }
    if detect_quota_message(&lower) {
        return ProviderError::Quota { status };
    }
    if detect_rate_limit_message(&lower) {
        return ProviderError::RateLimit {
            status,
            retry_after: None,
        };
    }
    if looks_like_payload_too_large_message(&lower) {
        return ProviderError::InvalidRequest {
            status,
            message: message.to_owned(),
        };
    }
    if is_server_status(status) {
        return ProviderError::Server { status };
    }
    if detect_server_message(&lower) {
        return ProviderError::Server { status };
    }
    if detect_timeout_message(&lower) {
        return ProviderError::Timeout {
            kind: TimeoutKind::Request,
        };
    }
    if detect_network_message(&lower) {
        return ProviderError::Network {
            source_kind: NetworkSourceKind::StreamInterrupted,
        };
    }
    // 13. 兜底 unknown（:316-320）
    ProviderError::Unknown {
        message: message.to_owned(),
    }
}

/// 把 SSE 读取错误归一为分类输入源（02 §六.7：流中途错误也走同一分类管线）
pub fn source_from_sse_read_error<E: std::error::Error + Send + Sync + 'static>(
    error: &SseReadError<E>,
) -> ProviderSourceError {
    match error {
        SseReadError::Aborted => ProviderSourceError::Aborted,
        SseReadError::Frame(frame) => ProviderSourceError::from(frame),
        SseReadError::FirstByteTimeout(_) => ProviderSourceError::Timeout(TimeoutKind::FirstByte),
        SseReadError::IdleTimeout(_) => ProviderSourceError::Timeout(TimeoutKind::Idle),
        SseReadError::Transport(inner) => transport_error_kind(inner),
    }
}

impl From<&SseFrameError> for ProviderSourceError {
    fn from(error: &SseFrameError) -> Self {
        match error {
            SseFrameError::MalformedSseFrame { .. } => {
                ProviderSourceError::StreamProtocol(StreamErrorKind::MalformedFrame)
            }
            SseFrameError::InvalidUtf8 => {
                ProviderSourceError::StreamProtocol(StreamErrorKind::InvalidUtf8)
            }
            // F3 #5：超限帧与损坏帧同属协议错误（fail-closed 终止流）
            SseFrameError::FrameTooLarge(_) => {
                ProviderSourceError::StreamProtocol(StreamErrorKind::MalformedFrame)
            }
        }
    }
}

/// reqwest 错误 → 分类源（is_timeout/is_connect 优先，其余按流中断处理）
pub fn source_from_reqwest_error(error: &reqwest::Error) -> ProviderSourceError {
    if error.is_timeout() {
        ProviderSourceError::Timeout(TimeoutKind::Request)
    } else if error.is_connect() {
        ProviderSourceError::Connection
    } else {
        ProviderSourceError::StreamInterrupted
    }
}

/// 通用传输错误识别：reqwest 错误按语义细分，其余默认流中断
fn transport_error_kind<E: std::error::Error + Send + Sync + 'static>(
    error: &E,
) -> ProviderSourceError {
    let dyn_error: &(dyn std::error::Error + 'static) = error;
    if let Some(reqwest_error) = dyn_error.downcast_ref::<reqwest::Error>() {
        return source_from_reqwest_error(reqwest_error);
    }
    ProviderSourceError::StreamInterrupted
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod tests;
