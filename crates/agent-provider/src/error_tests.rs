//! error.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 自 error.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。

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
    assert!(!classify(None, None, Some(ProviderSourceError::Aborted)).is_retryable());
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
        assert_eq!(
            error,
            ProviderError::Auth {
                status: Some(status)
            }
        );
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
            ProviderError::EndpointUnavailable {
                status: Some(status)
            }
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
        assert_eq!(
            error,
            ProviderError::ContextLength {
                status: Some(status)
            }
        );
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
    // 整词 413：命中；"4130" / "1413" 等子串不误伤
    assert!(
        looks_like_payload_too_large_message("error code 413 found"),
        "整词 413 应命中"
    );
    assert!(
        !looks_like_payload_too_large_message("model version 4130"),
        "4130 不得命中裸 413"
    );
    assert!(
        !looks_like_payload_too_large_message("ticket 1413"),
        "1413 中的 413 不得命中"
    );
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
    assert_eq!(
        error,
        ProviderError::RateLimit {
            status: Some(429),
            retry_after: None,
        }
    );
    // 消息模式兜底
    for body in [
        "rate limit exceeded",
        "RateLimitReached",
        "too many requests",
        "requests per minute exceeded (RPM limit)",
    ] {
        let error = classify(None, Some(body), None);
        assert_eq!(error.kind(), Kind::RateLimit, "body: {body}");
    }

    // 短周期 RPM 错误提取秒数（自愈可重试）
    let error = classify(
        None,
        Some("Rate limit reached. Please try again in 5.5s."),
        None,
    );
    assert_eq!(error.kind(), Kind::RateLimit);
    assert_eq!(error.retry_after(), Some(Duration::from_millis(5500)));

    // 单位感知提取：minutes 必须 ×60，ms 不转换
    assert_eq!(
        extract_seconds_from_text("wait 5 minutes"),
        Some(5 * 60 * 1000),
        "5 minutes 必须换算为 300000ms"
    );
    assert_eq!(
        extract_seconds_from_text("retry after 2 min"),
        Some(2 * 60 * 1000),
        "2 min 必须换算为 120000ms"
    );
    assert_eq!(
        extract_seconds_from_text("try again in 500ms"),
        Some(500),
        "500 ms 不得被误转成 500s"
    );
    assert_eq!(
        extract_seconds_from_text("wait 150 milliseconds"),
        Some(150),
        "150 milliseconds 原值即毫秒"
    );
    assert_eq!(
        extract_seconds_from_text("wait 3 s"),
        Some(3000),
        "显式秒单位与裸数字同语义"
    );
    // 纯数字无单位 → 历史契约「视为秒」（已钉死）
    assert_eq!(
        extract_seconds_from_text("please retry in 5"),
        Some(5000),
        "无单位数字保留「视为秒」契约"
    );
    // 未知单位 token → 不猜测（避免 "5 hours" 变成 5 秒）
    assert_eq!(extract_seconds_from_text("wait 5 hours"), None);

    // 长周期锁定（hours / days / tomorrow / 超过3分钟）快速判定为 Quota，直接打回
    for long_lock_body in [
        "Rate limit exceeded. Try again in 2 hours.",
        "Daily limit reached. Resets tomorrow.",
        "Usage limit exceeded. Please wait 15 minutes.",
        "24h quota reached.",
    ] {
        let error = classify(Some(429), Some(long_lock_body), None);
        assert_eq!(
            error.kind(),
            Kind::Quota,
            "long lock should fast-fail as Quota: {long_lock_body}"
        );
        assert!(!error.is_retryable());
    }
}

/// 第 10 行：HTTP 5xx 集合 → Server（可重试）
#[test]
fn row10_server_error() {
    for status in [500, 502, 503, 504, 520, 522, 523, 524] {
        let error = classify(Some(status), None, None);
        assert_eq!(
            error,
            ProviderError::Server {
                status: Some(status)
            }
        );
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
    assert_eq!(
        classify(None, Some("code 5023"), None).kind(),
        Kind::Unknown
    );
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
    // "network" 改为整词匹配：纯 "network" 命中，"internetwork" 等不误伤
    assert_eq!(
        classify(None, Some("network"), None).kind(),
        Kind::Network,
        "整词 network 应命中"
    );
    assert_eq!(
        classify(None, Some("internetwork stack"), None).kind(),
        Kind::Unknown,
        "internetwork 中的 network 子串不得命中"
    );
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
        Some(ProviderSourceError::StreamProtocol(
            StreamErrorKind::InvalidUtf8,
        )),
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
            SseFrameError::MalformedSseFrame { raw: "{bad".into() }
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
    assert!(ProviderError::Timeout {
        kind: TimeoutKind::Request
    }
    .is_retryable());
    assert!(ProviderError::Network {
        source_kind: NetworkSourceKind::Connection
    }
    .is_retryable());
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
        (
            ProviderError::Auth { status: Some(401) },
            codes::PROVIDER_AUTH,
        ),
        (
            ProviderError::RateLimit {
                status: None,
                retry_after: None,
            },
            codes::PROVIDER_RATE_LIMIT,
        ),
        (
            ProviderError::Server { status: None },
            codes::PROVIDER_SERVER,
        ),
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

// ── RequestBuildError（导线层 Fail-Closed 守门错误，详案 02 §4.3）──

/// UnpairedToolCalls：孤儿 ID 访问器、协议标识与 Display 语义（会话循环
/// 「补齐后重试」路径依赖这些字段做逐 ID 对账）
#[test]
fn request_build_error_unpaired_tool_calls_shape() {
    let err = RequestBuildError::UnpairedToolCalls {
        protocol: "anthropic",
        orphan_ids: vec!["call_a".to_string(), "call_b".to_string()],
    };
    assert_eq!(err.orphan_ids(), ["call_a", "call_b"]);
    assert_eq!(err.protocol(), Some("anthropic"));
    let display = err.to_string();
    assert!(
        display.contains("anthropic"),
        "Display 应含协议轨：{display}"
    );
    assert!(display.contains("call_a"), "Display 应含孤儿 ID：{display}");
    assert!(display.contains("call_b"), "Display 应含孤儿 ID：{display}");
}

/// Other 变体：orphan_ids 返回空切片、protocol 返回 None（非成对性错误）
#[test]
fn request_build_error_other_has_no_orphans() {
    let err = RequestBuildError::Other("构造失败".to_string());
    assert!(err.orphan_ids().is_empty());
    assert_eq!(err.protocol(), None);
    assert!(err.to_string().contains("构造失败"));
}
