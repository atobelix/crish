//! 消息模式检测域（SR-06e · 拆分 · ≠ EL）
//!
//! 自 error.rs 拆出的实现域：error-classifier.ts 各正则的 Rust 形态，
//! 全部为 [super::classify_provider_error] 的消息模式兜底判定面
//! （02 §4.2 判定依据）。门面（error.rs）以 `use` 引为本模块私有辅助，
//! 不构成对外公开 API；对外路径不变。

/// 消息含 abort 字样（:133-138 的 /aborted|cancelled|canceled/）
pub(super) fn contains_abort_words(lower: &str) -> bool {
    lower.contains("aborted") || lower.contains("cancelled") || lower.contains("canceled")
}

/// 上下文超长检测（:366-370）：/context.*length.*exceed|maximum.*context|too long|context_length_exceeded/
pub(super) fn detect_context_length_exceeded(lower: &str) -> bool {
    ordered_contains(lower, &["context", "length", "exceed"])
        || lower.contains("maximum context")
        || lower.contains("too long")
        || lower.contains("context_length_exceeded")
}

/// 子串按顺序出现（等价 TS /context.*length.*exceed/ 的宽松匹配）
pub(super) fn ordered_contains(text: &str, needles: &[&str]) -> bool {
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
pub(super) fn detect_auth_message(lower: &str) -> bool {
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
pub(super) fn detect_quota_message(lower: &str) -> bool {
    ["quota", "balance", "credit"]
        .iter()
        .any(|word| ordered_contains(lower, &["insufficient", word]))
        || lower.contains("quota exceeded")
        || lower.contains("out of credits")
}

/// rate limit 消息字样（:249-255）：rate.?limit|too many requests
pub(super) fn detect_rate_limit_message(lower: &str) -> bool {
    lower.contains("ratelimit")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("too many requests")
}

/// payload 过大消息（:372-377）：先排除 4130 系列码（Anthropic 的 "model version 4130"
/// 是服务端错误码而非 HTTP 413），再匹配 payload 过大字样（含裸 "413"）
pub(super) fn looks_like_payload_too_large_message(lower: &str) -> bool {
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
pub(super) fn is_server_status(status: Option<u16>) -> bool {
    matches!(status, Some(500 | 502 | 503 | 504 | 520 | 522 | 523 | 524))
}

/// server 消息字样（:283-293）：\b502\b…|bad gateway|gateway timeout|server error|overloaded|temporarily unavailable
pub(super) fn detect_server_message(lower: &str) -> bool {
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
pub(super) fn contains_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|token| token == word)
}

/// timeout 字样（:295-302）：timeout|timed out
pub(super) fn detect_timeout_message(lower: &str) -> bool {
    lower.contains("timeout") || lower.contains("timed out")
}

/// network 字样（:304-314）：econnreset|enotfound|econnrefused|fetch failed|network|socket hang up
pub(super) fn detect_network_message(lower: &str) -> bool {
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
pub(super) fn looks_like_gateway_challenge(lower: &str) -> bool {
    lower.contains("cf_chl")
        || lower.contains("challenge-platform")
        || lower.contains("just a moment")
        || lower.contains("enable javascript")
}
