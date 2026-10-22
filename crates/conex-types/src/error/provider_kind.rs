use super::codes;
use serde::{Deserialize, Serialize};

// ── ProviderErrorKind 分类（02 §4.2 分类表 13 行逐行对齐）──

/// Provider 错误分类（02-provider-semantics.md §4.2 分类表 13 行，
/// 判定优先级从上到下；shared-types 的 ProviderErrorKind 12 值 +
/// payload-too-large/context-length-exceeded 拆分后为 13 类）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderErrorKind {
    /// 第 1 行：signal.aborted / AbortError，底层 USER_ABORT，不可重试
    Aborted,
    /// 第 2 行：HTTP 413 请求体过大（payload_too_large），不可重试
    PayloadTooLarge,
    /// 第 3 行：Cloudflare 质询（cf-mitigated / cf_chl / "just a moment"），不可重试
    GatewayChallenge,
    /// 第 4 行：HTTP 401/403 或 unauthorized/forbidden/invalid api key，不可重试
    Auth,
    /// 第 5 行：HTTP 402 或 insufficient quota / out of credits，不可重试
    Quota,
    /// 第 6 行：HTTP 404/405/415 端点不可用，不可重试
    EndpointUnavailable,
    /// 第 7 行：HTTP 400/422 且上下文超长（唯一可重试的 4xx）
    ContextLengthExceeded,
    /// 第 8 行：HTTP 400/422 其余（含 payload too large 消息），不可重试
    InvalidRequest,
    /// 第 9 行：HTTP 429 或 rate limit 字样，可重试（携带 retryAfterMs）
    RateLimit,
    /// 第 10 行：HTTP 500/502/503/504/520/522/523/524 等，可重试
    ServerError,
    /// 第 11 行：消息含 timeout/timed out，可重试
    Timeout,
    /// 第 12 行：连接失败/流中断等传输层错误（02 §五.11 裁决必须可重试）
    Network,
    /// 第 13 行：兜底未知错误，不可重试
    Unknown,
}

impl ProviderErrorKind {
    /// 02 §4.2 默认 retryable 矩阵（provider-error-classifier.ts:31-38）
    pub fn default_retryable(self) -> bool {
        matches!(
            self,
            ProviderErrorKind::ContextLengthExceeded
                | ProviderErrorKind::RateLimit
                | ProviderErrorKind::ServerError
                | ProviderErrorKind::Timeout
                | ProviderErrorKind::Network
        )
    }

    /// 映射到 error.rs 既有错误码（对齐 TS migrateErrorCode §3.3）
    pub fn code(self) -> &'static str {
        match self {
            ProviderErrorKind::Aborted => codes::PROVIDER_CANCELLED,
            ProviderErrorKind::PayloadTooLarge => codes::PROVIDER_SCHEMA,
            ProviderErrorKind::GatewayChallenge => codes::PROVIDER_GATEWAY_CHALLENGE,
            ProviderErrorKind::Auth => codes::PROVIDER_AUTH,
            ProviderErrorKind::Quota => codes::PROVIDER_QUOTA,
            ProviderErrorKind::EndpointUnavailable => codes::PROVIDER_ENDPOINT_UNAVAILABLE,
            ProviderErrorKind::ContextLengthExceeded => codes::CONTEXT_LENGTH_EXCEEDED,
            ProviderErrorKind::InvalidRequest => codes::PROVIDER_SCHEMA,
            ProviderErrorKind::RateLimit => codes::PROVIDER_RATE_LIMIT,
            ProviderErrorKind::ServerError => codes::PROVIDER_SERVER,
            ProviderErrorKind::Timeout => codes::PROVIDER_TIMEOUT,
            ProviderErrorKind::Network => codes::PROVIDER_NETWORK,
            ProviderErrorKind::Unknown => codes::PROVIDER_UNKNOWN,
        }
    }
}
