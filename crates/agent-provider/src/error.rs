//! Provider 错误分类（任务书 B2.7；02-provider-semantics.md §四、§六.7）
//!
//! 对齐 TS 端 provider-error-classifier.ts 与 error-classifier.ts（模型 + runtime 双拷贝）：
//! - [ProviderError] 为分类产物枚举，`kind()` 收敛为 conex-types 的
//!   [ProviderErrorKind] 13 类（02 §4.2 分类表 13 行逐行，判定优先级从上到下）；
//! - [classify_provider_error] 是分类管线入口：HTTP 状态码优先，消息模式兜底，
//!   transport 源（连接失败/流中断）按 runtime 行为必须可重试（02 §五 #11）；
//! - 错误码复用 conex-types error.rs 既有 13 类，不重复定义（任务书 B2.7 复用 04 §1.2）。

use std::time::{Duration, SystemTime};

use conex_types::error::{CrishError, ProviderErrorKind};
use thiserror::Error;

use crate::retry::parse_retry_after_ms;
use crate::sse::{SseFrameError, SseReadError};

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
    PayloadTooLarge {
        status: Option<u16>,
    },
    /// 第 3 行：Cloudflare 质询（cf_chl / just a moment 等），不可重试
    #[error("Cloudflare 质询拦截（gateway-challenge）")]
    GatewayChallenge {
        status: Option<u16>,
    },
    /// 第 4 行：HTTP 401/403 或 unauthorized/forbidden/invalid api key，不可重试
    /// （某些网关 403 是 key 无效，与 401 同判为 auth，02 §四）
    #[error("鉴权失败（HTTP {status:?}）")]
    Auth {
        status: Option<u16>,
    },
    /// 第 5 行：HTTP 402 或 insufficient quota/out of credits，不可重试
    #[error("配额耗尽（HTTP {status:?}）")]
    Quota {
        status: Option<u16>,
    },
    /// 第 6 行：HTTP 404/405/415 端点不可用，不可重试
    #[error("端点不可用（HTTP {status:?}）")]
    EndpointUnavailable {
        status: Option<u16>,
    },
    /// 第 7 行：HTTP 400/422 且上下文超长（分类层标记可重试，02 §4.2 第 7 行；
    /// 但重试循环不直接重试——由上层压缩处理，见 retry::should_retry）
    #[error("上下文超长（HTTP {status:?}）")]
    ContextLength {
        status: Option<u16>,
    },
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
    Server {
        status: Option<u16>,
    },
    /// 第 11 行：超时（first-byte / idle / 请求级），可重试
    #[error("请求超时（{kind:?}）")]
    Timeout {
        kind: TimeoutKind,
    },
    /// 第 12 行：传输层错误（连接失败/流中断，02 §五 #11 裁决必须可重试）
    #[error("传输层错误（{source_kind:?}）")]
    Network {
        source_kind: NetworkSourceKind,
    },
    /// 流协议错误（分帧/解码失败，invalid-stream；归 Network 语义可重试）
    #[error("流协议错误（{kind:?}）")]
    Stream {
        kind: StreamErrorKind,
    },
    /// 第 13 行：兜底未知错误，不可重试
    #[error("未知 Provider 错误：{message}")]
    Unknown {
        message: String,
    },
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
    if source == ProviderSourceError::Aborted || lower.contains("aborted") {
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
        return ProviderError::RateLimit { status, retry_after };
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

// ── 消息模式检测（对齐 error-classifier.ts 各正则，02 §4.2 判定依据）──

/// 消息含 abort 字样（:133-138 的 /aborted|cancelled|canceled/）
fn contains_abort_words(lower: &str) -> bool {
    lower.contains("aborted") || lower.contains("cancelled") || lower.contains("canceled")
}

/// 上下文超长检测（:366-370）：/context.*length.*exceed|maximum.*context|too long|context_length_exceeded/
fn detect_context_length_exceeded(lower: &str) -> bool {
    ordered_contains(lower, &["context", "length", "exceed"])
        || lower.contains("maximum context")
        || lower.contains("too long")
        || lower.contains("context_length_exceeded")
}

/// 子串按顺序出现（等价 TS /context.*length.*exceed/ 的宽松匹配）
fn ordered_contains(text: &str, needles: &[&str]) -> bool {
    let mut rest = text;
    for needle in needles {
        match rest.find(needle) {
            Some(index) => rest = &rest[index + needle.len()..],
            None => return false,
        }
    }
    true
}

/// auth 消息字样（:225-235）：unauthorized|forbidden|invalid api key|invalid authentication
fn detect_auth_message(lower: &str) -> bool {
    [
        "unauthorized",
        "forbidden",
        "invalid api key",
        "invalid authentication",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

/// quota 消息字样（:237-247）：insufficient.*(quota|balance|credit)|quota exceeded|out of credits
fn detect_quota_message(lower: &str) -> bool {
    ["quota", "balance", "credit"]
        .iter()
        .any(|word| ordered_contains(lower, &["insufficient", word]))
        || lower.contains("quota exceeded")
        || lower.contains("out of credits")
}

/// rate limit 消息字样（:249-255）：rate.?limit|too many requests
fn detect_rate_limit_message(lower: &str) -> bool {
    lower.contains("ratelimit")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("too many requests")
}

/// payload 过大消息（:372-377）：先排除 4130 系列码（Anthropic 的 "model version 4130"
/// 是服务端错误码而非 HTTP 413），再匹配 payload 过大字样（含裸 "413"）
fn looks_like_payload_too_large_message(lower: &str) -> bool {
    if lower.contains("4130") {
        return false;
    }
    [
        "payload too large",
        "request_too_large",
        "entity too large",
        "request exceeds the maximum size",
        "413",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

/// 5xx 状态码集合（02 §4.2 第 10 行）
fn is_server_status(status: Option<u16>) -> bool {
    matches!(status, Some(500 | 502 | 503 | 504 | 520 | 522 | 523 | 524))
}

/// server 消息字样（:283-293）：\b502\b…|bad gateway|gateway timeout|server error|overloaded|temporarily unavailable
fn detect_server_message(lower: &str) -> bool {
    ["502", "503", "504", "520", "522", "523", "524"]
        .iter()
        .any(|code| contains_word(lower, code))
        || [
            "bad gateway",
            "gateway timeout",
            "server error",
            "overloaded",
            "temporarily unavailable",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// 整词匹配（等价 TS \bword\b；按非字母数字切分）
fn contains_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| token == word)
}

/// timeout 字样（:295-302）：timeout|timed out
fn detect_timeout_message(lower: &str) -> bool {
    lower.contains("timeout") || lower.contains("timed out")
}

/// network 字样（:304-314）：econnreset|enotfound|econnrefused|fetch failed|network|socket hang up
fn detect_network_message(lower: &str) -> bool {
    [
        "econnreset",
        "enotfound",
        "econnrefused",
        "fetch failed",
        "network",
        "socket hang up",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

/// Cloudflare 质询（:390-407 消息部分）：cf_chl|challenge-platform|just a moment|enable javascript
fn looks_like_gateway_challenge(lower: &str) -> bool {
    lower.contains("cf_chl")
        || lower.contains("challenge-platform")
        || lower.contains("just a moment")
        || lower.contains("enable javascript")
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::error::{codes, ProviderErrorKind as Kind};
    use std::time::Duration;

    /// 便捷调用：省略 Retry-After 头参数
    fn classify(
        status: Option<u16>,
        body: Option<&str>,
        source: Option<ProviderSourceError>,
    ) -> ProviderError {
        classify_provider_error(status, body, source, None)
    }

    // ── 02 §4.2 分类表 13 行逐行（验收：每行有测试）──

    /// 第 1 行：abort → Aborted（不可重试）
    #[test]
    fn row1_abort() {
        assert_eq!(
            classify(None, None, Some(ProviderSourceError::Aborted)),
            ProviderError::Aborted
        );
        // abort 优先于状态码（对齐 signal.aborted 最先判定）
        assert_eq!(
            classify(Some(429), None, Some(ProviderSourceError::Aborted)),
            ProviderError::Aborted
        );
        // isAbortError 消息等价：含 "aborted"
        assert_eq!(
            classify(None, Some("The operation was aborted"), None),
            ProviderError::Aborted
        );
        // 消息级 cancelled（状态码检查之后）
        assert_eq!(
            classify(None, Some("request cancelled"), None),
            ProviderError::Aborted
        );
        assert!(
            !classify(None, None, Some(ProviderSourceError::Aborted)).is_retryable()
        );
    }

    /// 第 2 行：HTTP 413 → PayloadTooLarge（不可重试）
    #[test]
    fn row2_payload_too_large_413() {
        let error = classify(Some(413), Some("whatever"), None);
        assert_eq!(error, ProviderError::PayloadTooLarge { status: Some(413) });
        assert!(!error.is_retryable());
    }

    /// 第 3 行：Cloudflare 质询 → GatewayChallenge（不可重试）
    #[test]
    fn row3_gateway_challenge() {
        for body in [
            "cf_chl_opt_xxxx",
            "Just a moment...",
            "challenge-platform",
            "Please enable JavaScript and cookies",
        ] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::GatewayChallenge, "body: {body}");
            assert!(!error.is_retryable(), "body: {body}");
        }
    }

    /// 第 4 行：HTTP 401/403 → Auth（不可重试；403 网关 key 无效同判）
    #[test]
    fn row4_auth() {
        for status in [401, 403] {
            let error = classify(Some(status), None, None);
            assert_eq!(error, ProviderError::Auth { status: Some(status) });
            assert!(!error.is_retryable());
        }
        for body in [
            "unauthorized",
            "forbidden",
            "invalid api key",
            "Invalid authentication credentials",
        ] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::Auth, "body: {body}");
            assert!(!error.is_retryable(), "body: {body}");
        }
    }

    /// 第 5 行：HTTP 402 → Quota（不可重试）
    #[test]
    fn row5_quota() {
        let error = classify(Some(402), None, None);
        assert_eq!(error, ProviderError::Quota { status: Some(402) });
        assert!(!error.is_retryable());
        for body in [
            "insufficient quota",
            "You have insufficient balance",
            "quota exceeded",
            "out of credits",
        ] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::Quota, "body: {body}");
        }
    }

    /// 第 6 行：HTTP 404/405/415 → EndpointUnavailable（不可重试）
    #[test]
    fn row6_endpoint_unavailable() {
        for status in [404, 405, 415] {
            let error = classify(Some(status), None, None);
            assert_eq!(
                error,
                ProviderError::EndpointUnavailable { status: Some(status) }
            );
            assert!(!error.is_retryable());
        }
    }

    /// 第 7 行：HTTP 400/422 上下文超长 → ContextLength（唯一可重试的 4xx）
    #[test]
    fn row7_context_length_exceeded() {
        for status in [400, 422] {
            let error = classify(
                Some(status),
                Some("context_length_exceeded: maximum context length is 128000 tokens"),
                None,
            );
            assert_eq!(error, ProviderError::ContextLength { status: Some(status) });
            assert!(error.is_retryable(), "分类层 context_length 标记可重试");
        }
        // 消息模式兜底（无状态码或非 400/422 状态）
        for body in [
            "Request too long: maximum context length exceeded",
            "This model's maximum context length is 200000 tokens",
            "context length exceeded",
        ] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::ContextLengthExceeded, "body: {body}");
        }
    }

    /// 第 8 行：HTTP 400/422 其余（含 payload too large 消息）→ InvalidRequest（不可重试）
    #[test]
    fn row8_invalid_request() {
        let error = classify(Some(400), Some("invalid parameter"), None);
        assert_eq!(
            error,
            ProviderError::InvalidRequest {
                status: Some(400),
                message: "invalid parameter".into(),
            }
        );
        // payload too large 消息在 400/422 下仍归第 8 行（非 413 状态）
        let error = classify(Some(422), Some("payload too large"), None);
        assert_eq!(error.kind(), Kind::InvalidRequest);
        assert!(!error.is_retryable());
        // 消息模式兜底
        let error = classify(None, Some("payload too large"), None);
        assert_eq!(error.kind(), Kind::InvalidRequest);
        // Anthropic 4130 系列错误码不应误判为 payload（:372-377）
        let error = classify(None, Some("model version 4130"), None);
        assert_eq!(error.kind(), Kind::Unknown);
    }

    /// 第 9 行：HTTP 429 → RateLimit（可重试，携带 Retry-After）
    #[test]
    fn row9_rate_limit() {
        let error = classify_provider_error(Some(429), None, None, Some("30"));
        match error {
            ProviderError::RateLimit {
                status,
                retry_after,
            } => {
                assert_eq!(status, Some(429));
                assert_eq!(retry_after, Some(Duration::from_secs(30)));
            }
            other => panic!("期望 RateLimit，得到 {other:?}"),
        }
        assert!(error.is_retryable());
        // 无 Retry-After 头也可分类
        let error = classify(Some(429), None, None);
        assert_eq!(error, ProviderError::RateLimit {
            status: Some(429),
            retry_after: None,
        });
        // 消息模式兜底
        for body in ["rate limit exceeded", "RateLimitReached", "too many requests"] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::RateLimit, "body: {body}");
        }
    }

    /// 第 10 行：HTTP 5xx 集合 → Server（可重试）
    #[test]
    fn row10_server_error() {
        for status in [500, 502, 503, 504, 520, 522, 523, 524] {
            let error = classify(Some(status), None, None);
            assert_eq!(error, ProviderError::Server { status: Some(status) });
            assert!(error.is_retryable());
        }
    }

    /// 第 10 行消息模式：bad gateway / gateway timeout / server error / 整词状态码
    #[test]
    fn row10_server_error_by_message() {
        for body in [
            "bad gateway",
            "gateway timeout",
            "server error",
            "the server is overloaded",
            "service temporarily unavailable",
            "HTTP 502 from upstream",
            "520 error",
        ] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::ServerError, "body: {body}");
        }
        // 整词边界：5023 不应命中 502
        assert_eq!(classify(None, Some("code 5023"), None).kind(), Kind::Unknown);
    }

    /// 第 11 行：超时 → Timeout（可重试）
    #[test]
    fn row11_timeout() {
        let error = classify(None, Some("request timed out"), None);
        assert_eq!(
            error,
            ProviderError::Timeout {
                kind: TimeoutKind::Request
            }
        );
        assert!(error.is_retryable());
        for kind in [
            TimeoutKind::FirstByte,
            TimeoutKind::Idle,
            TimeoutKind::Request,
        ] {
            let error = classify(None, None, Some(ProviderSourceError::Timeout(kind)));
            assert_eq!(error, ProviderError::Timeout { kind });
        }
    }

    /// 第 12 行：传输层错误（连接失败/流中断）→ Network（02 §五 #11 必须可重试）
    #[test]
    fn row12_network_transport() {
        let error = classify(None, None, Some(ProviderSourceError::Connection));
        assert_eq!(
            error,
            ProviderError::Network {
                source_kind: NetworkSourceKind::Connection
            }
        );
        assert!(error.is_retryable());
        let error = classify(None, None, Some(ProviderSourceError::StreamInterrupted));
        assert_eq!(
            error,
            ProviderError::Network {
                source_kind: NetworkSourceKind::StreamInterrupted
            }
        );
        assert!(error.is_retryable());
        // 消息模式兜底
        for body in [
            "econnreset",
            "ENOTFOUND",
            "econnrefused",
            "fetch failed",
            "network error",
            "socket hang up",
        ] {
            let error = classify(None, Some(body), None);
            assert_eq!(error.kind(), Kind::Network, "body: {body}");
            assert!(error.is_retryable(), "body: {body}");
        }
    }

    /// 第 13 行：兜底 → Unknown（不可重试）
    #[test]
    fn row13_unknown_fallback() {
        let error = classify(Some(418), Some("I am a teapot"), None);
        assert_eq!(
            error,
            ProviderError::Unknown {
                message: "I am a teapot".into()
            }
        );
        assert!(!error.is_retryable());
        assert_eq!(
            classify(None, Some("completely unexpected"), None).kind(),
            Kind::Unknown
        );
        assert_eq!(classify(None, None, None).kind(), Kind::Unknown);
    }

    // ── 判定优先级（02 §4.2：状态码优先，消息模式按 TS 顺序）──

    #[test]
    fn status_wins_over_message_patterns() {
        // 401 优先于 rate limit 消息
        assert_eq!(
            classify(Some(401), Some("rate limit"), None).kind(),
            Kind::Auth
        );
        // 429 优先于 auth 消息
        assert_eq!(
            classify(Some(429), Some("unauthorized"), None).kind(),
            Kind::RateLimit
        );
        // 400/422 优先于 server 消息
        assert_eq!(
            classify(Some(400), Some("server error"), None).kind(),
            Kind::InvalidRequest
        );
        // 413 优先于任意消息
        assert_eq!(
            classify(Some(413), Some("rate limit"), None).kind(),
            Kind::PayloadTooLarge
        );
    }

    #[test]
    fn message_patterns_priority_between_rows() {
        // 消息级 auth 在 5xx 状态判定之前（:225-235 vs :272-293）
        assert_eq!(
            classify(Some(500), Some("unauthorized"), None).kind(),
            Kind::Auth
        );
        // rate limit 消息在 5xx 状态判定之前
        assert_eq!(
            classify(Some(500), Some("rate limit exceeded"), None).kind(),
            Kind::RateLimit
        );
        // context 消息在 auth/server 消息之前
        assert_eq!(
            classify(None, Some("context length exceeded, server error"), None).kind(),
            Kind::ContextLengthExceeded
        );
        // server 消息（bad gateway）在 timeout 消息之前
        assert_eq!(
            classify(None, Some("bad gateway timeout"), None).kind(),
            Kind::ServerError
        );
        // transport 源在 5xx 状态判定之前（runtime:error-classifier.ts:119-131）
        assert_eq!(
            classify(Some(500), None, Some(ProviderSourceError::Connection)).kind(),
            Kind::Network
        );
    }

    // ── 流协议错误与 SSE 读取错误源映射 ──

    /// 流协议错误（invalid-stream）归 Network 语义（可重试）
    #[test]
    fn stream_protocol_errors_classify_as_network() {
        let error = classify(
            None,
            None,
            Some(ProviderSourceError::StreamProtocol(
                StreamErrorKind::MalformedFrame,
            )),
        );
        assert_eq!(
            error,
            ProviderError::Stream {
                kind: StreamErrorKind::MalformedFrame
            }
        );
        assert_eq!(error.kind(), Kind::Network);
        assert!(error.is_retryable());
        let error = classify(
            None,
            None,
            Some(ProviderSourceError::StreamProtocol(StreamErrorKind::InvalidUtf8)),
        );
        assert_eq!(error.kind(), Kind::Network);
    }

    #[derive(Debug, thiserror::Error)]
    #[error("mock 传输错误")]
    struct MockError;

    /// SSE 读取错误 → 分类源（双段超时 / abort / 分帧 / 传输逐项映射）
    #[test]
    fn sse_read_error_source_mapping() {
        assert_eq!(
            source_from_sse_read_error(&SseReadError::<MockError>::Aborted),
            ProviderSourceError::Aborted
        );
        assert_eq!(
            source_from_sse_read_error(&SseReadError::<MockError>::FirstByteTimeout(
                Duration::from_secs(5)
            )),
            ProviderSourceError::Timeout(TimeoutKind::FirstByte)
        );
        assert_eq!(
            source_from_sse_read_error(&SseReadError::<MockError>::IdleTimeout(
                Duration::from_secs(5)
            )),
            ProviderSourceError::Timeout(TimeoutKind::Idle)
        );
        assert_eq!(
            source_from_sse_read_error(&SseReadError::<MockError>::Frame(
                SseFrameError::MalformedSseFrame {
                    raw: "{bad".into()
                }
            )),
            ProviderSourceError::StreamProtocol(StreamErrorKind::MalformedFrame)
        );
        assert_eq!(
            source_from_sse_read_error(&SseReadError::<MockError>::Frame(
                SseFrameError::InvalidUtf8
            )),
            ProviderSourceError::StreamProtocol(StreamErrorKind::InvalidUtf8)
        );
        // 传输错误（非 reqwest）→ 默认流中断
        assert_eq!(
            source_from_sse_read_error(&SseReadError::<MockError>::Transport(MockError)),
            ProviderSourceError::StreamInterrupted
        );
    }

    // ── kind() 收敛、重试矩阵与错误码映射（复用 conex-types 既有 13 类）──

    /// kind() 收敛覆盖全部 13 类（含 Stream 折叠进 Network）
    #[test]
    fn kind_mapping_covers_all_13_classes() {
        let cases = [
            (ProviderError::Aborted, Kind::Aborted),
            (
                ProviderError::PayloadTooLarge { status: None },
                Kind::PayloadTooLarge,
            ),
            (
                ProviderError::GatewayChallenge { status: None },
                Kind::GatewayChallenge,
            ),
            (ProviderError::Auth { status: None }, Kind::Auth),
            (ProviderError::Quota { status: None }, Kind::Quota),
            (
                ProviderError::EndpointUnavailable { status: None },
                Kind::EndpointUnavailable,
            ),
            (
                ProviderError::ContextLength { status: None },
                Kind::ContextLengthExceeded,
            ),
            (
                ProviderError::InvalidRequest {
                    status: None,
                    message: "x".into(),
                },
                Kind::InvalidRequest,
            ),
            (
                ProviderError::RateLimit {
                    status: None,
                    retry_after: None,
                },
                Kind::RateLimit,
            ),
            (ProviderError::Server { status: None }, Kind::ServerError),
            (
                ProviderError::Timeout {
                    kind: TimeoutKind::Request,
                },
                Kind::Timeout,
            ),
            (
                ProviderError::Network {
                    source_kind: NetworkSourceKind::Connection,
                },
                Kind::Network,
            ),
            (
                ProviderError::Stream {
                    kind: StreamErrorKind::MalformedFrame,
                },
                Kind::Network,
            ),
            (
                ProviderError::Unknown {
                    message: "x".into(),
                },
                Kind::Unknown,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.kind(), expected, "{error:?}");
        }
    }

    /// 分类层默认重试矩阵（02 §4.2 默认 retryable；第 7 行 context_length=true）
    #[test]
    fn retryable_matrix_matches_default_retryable() {
        assert!(ProviderError::RateLimit {
            status: None,
            retry_after: None,
        }
        .is_retryable());
        assert!(ProviderError::Server { status: None }.is_retryable());
        assert!(
            ProviderError::Timeout {
                kind: TimeoutKind::Request
            }
            .is_retryable()
        );
        assert!(
            ProviderError::Network {
                source_kind: NetworkSourceKind::Connection
            }
            .is_retryable()
        );
        assert!(ProviderError::ContextLength { status: None }.is_retryable());
        for error in [
            ProviderError::Aborted,
            ProviderError::PayloadTooLarge { status: None },
            ProviderError::GatewayChallenge { status: None },
            ProviderError::Auth { status: None },
            ProviderError::Quota { status: None },
            ProviderError::EndpointUnavailable { status: None },
            ProviderError::InvalidRequest {
                status: None,
                message: "x".into(),
            },
            ProviderError::Unknown {
                message: "x".into(),
            },
        ] {
            assert!(!error.is_retryable(), "{error:?} 应不可重试");
        }
    }

    /// 错误码映射复用 conex-types error.rs 的 provider 域码
    #[test]
    fn to_crish_error_uses_existing_codes() {
        let cases = [
            (ProviderError::Auth { status: Some(401) }, codes::PROVIDER_AUTH),
            (
                ProviderError::RateLimit {
                    status: None,
                    retry_after: None,
                },
                codes::PROVIDER_RATE_LIMIT,
            ),
            (ProviderError::Server { status: None }, codes::PROVIDER_SERVER),
            (
                ProviderError::Timeout {
                    kind: TimeoutKind::Request,
                },
                codes::PROVIDER_TIMEOUT,
            ),
            (
                ProviderError::Network {
                    source_kind: NetworkSourceKind::Connection,
                },
                codes::PROVIDER_NETWORK,
            ),
            (
                ProviderError::ContextLength { status: None },
                codes::CONTEXT_LENGTH_EXCEEDED,
            ),
            (ProviderError::Aborted, codes::PROVIDER_CANCELLED),
        ];
        for (error, expected_code) in cases {
            let crish = error.to_crish_error();
            assert_eq!(crish.code, expected_code, "{error:?}");
            assert_eq!(crish.retryable, error.is_retryable());
        }
    }
}
