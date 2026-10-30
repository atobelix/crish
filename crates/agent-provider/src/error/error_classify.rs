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

/// rate limit 消息字样（:249-255）：rate.?limit|too many requests|rpm|tpm
pub(super) fn detect_rate_limit_message(lower: &str) -> bool {
    lower.contains("ratelimit")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("too many requests")
        || lower.contains("rpm")
        || lower.contains("tpm")
        || lower.contains("requests per minute")
        || lower.contains("tokens per minute")
}

/// 判定是否包含长周期限流/配额锁定的字样（hours/days/tomorrow/minute 等，无法通过短时瞬态重试自愈）
///
/// 全程基于 `&str` 原地切片与单位解析，彻底消除 `.replace(...)` 与 `.collect::<String>()` 堆分配。
pub(super) fn detect_long_rate_limit_lock(lower: &str) -> bool {
    if lower.contains("hour")
        || lower.contains("day")
        || lower.contains("tomorrow")
        || lower.contains("24h")
        || lower.contains("12h")
    {
        return true;
    }
    // 检查锚点后明确跟随的分钟数（原地字节切片提取数字 + parse_wait_unit 精确识别单位）
    for anchor in &["try again in ", "wait ", "retry after ", "retry in "] {
        if let Some(idx) = lower.find(anchor) {
            let slice = &lower[idx + anchor.len()..];
            let num_len = slice.bytes().take_while(|b| b.is_ascii_digit()).count();
            if num_len > 0 {
                if let Ok(mins) = slice[..num_len].parse::<u32>() {
                    let after_num = &slice[num_len..];
                    if matches!(parse_wait_unit(after_num), Some(WaitUnit::Min)) {
                        return mins >= 3;
                    }
                }
            }
        }
    }
    // 若文案包含复数分钟等待字样（"minutes" / "mins" 天然不与速率单位 "per minute" / "per min" 冲突）
    if (lower.contains("minutes") || lower.contains("mins"))
        && (lower.contains("wait") || lower.contains("retry"))
    {
        return true;
    }
    false
}

/// 单位分类结果（用于 extract_seconds_from_text）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitUnit {
    /// 毫秒：不转换
    Ms,
    /// 秒：原值即秒
    Sec,
    /// 分钟：×60
    Min,
}

/// 从数字后的字符串识别等待时长单位（优先长 token，避免 "ms" 被 "m" 吞）。
/// 返回 None 表示「无显式单位」或「未知单位 token」——调用方各自处理。
fn parse_wait_unit(after_num: &str) -> Option<WaitUnit> {
    let rest = after_num.trim_start();
    // 中文单位（若存在）
    if rest.starts_with("毫秒") {
        return Some(WaitUnit::Ms);
    }
    if rest.starts_with("分钟") || rest.starts_with("分") {
        return Some(WaitUnit::Min);
    }
    if rest.starts_with("秒") {
        return Some(WaitUnit::Sec);
    }
    // 英文：优先长 token，再短缩写
    if rest.starts_with("milliseconds") || rest.starts_with("millisecond") {
        return Some(WaitUnit::Ms);
    }
    if rest.starts_with("minutes") || rest.starts_with("minute") {
        return Some(WaitUnit::Min);
    }
    if rest.starts_with("seconds") || rest.starts_with("second") {
        return Some(WaitUnit::Sec);
    }
    if rest.starts_with("ms") {
        return Some(WaitUnit::Ms);
    }
    if rest.starts_with("min") {
        return Some(WaitUnit::Min);
    }
    if rest.starts_with("sec") {
        return Some(WaitUnit::Sec);
    }
    if rest.starts_with('s') {
        return Some(WaitUnit::Sec);
    }
    None
}

/// 判断数字后的剩余串是否为「纯无单位」（空白/标点/句尾），而非未知单位 token。
fn is_bare_after_number(after_num: &str) -> bool {
    let rest = after_num.trim_start();
    rest.is_empty()
        || rest
            .chars()
            .next()
            .map(|c| !(c.is_ascii_alphabetic() || c == '毫' || c == '秒' || c == '分'))
            .unwrap_or(true)
}

/// 从错误文本中尝试提取短时重试等待时长（毫秒）。
///
/// 策略：
/// 1. 在 "try again in " / "retry after " / "wait " / "retry in " / "after " 锚点后取数字（原地 `&str` 切片零分配）；
/// 2. 优先按显式单位换算：ms 不转换，s 不转换，min ×60（再 ×1000 转 ms）；
/// 3. 纯数字无单位 → 保留历史契约「视为秒」（已由单测钉死）；
/// 4. 有未知单位 token → 不猜测，返回 None（避免 "5 hours" 被当成 5 秒）。
pub(super) fn extract_seconds_from_text(lower: &str) -> Option<u64> {
    for anchor in &[
        "try again in ",
        "retry after ",
        "wait ",
        "retry in ",
        "after ",
    ] {
        if let Some(idx) = lower.find(anchor) {
            let slice = &lower[idx + anchor.len()..];
            let num_len = slice
                .bytes()
                .take_while(|b| b.is_ascii_digit() || *b == b'.')
                .count();
            if num_len == 0 {
                continue;
            }
            if let Ok(n) = slice[..num_len].parse::<f64>() {
                if n > 0.0 {
                    let after_num = &slice[num_len..];
                    // 转换为毫秒（上限 300_000 ms = 300 s）
                    let ms: f64 = match parse_wait_unit(after_num) {
                        Some(WaitUnit::Ms) => n,
                        Some(WaitUnit::Sec) => n * 1000.0,
                        Some(WaitUnit::Min) => n * 60.0 * 1000.0,
                        None => {
                            // 无显式单位 → 视为秒；未知单位 token → 不猜测，返回 None
                            if is_bare_after_number(after_num) {
                                n * 1000.0
                            } else {
                                continue;
                            }
                        }
                    };
                    if ms > 0.0 && ms <= 300_000.0 {
                        return Some(ms as u64);
                    }
                }
            }
        }
    }
    None
}

/// payload 过大消息（:372-377）：先排除 4130 系列码（Anthropic 的 "model version 4130"
/// 是服务端错误码而非 HTTP 413），再匹配 payload 过大字样（含整词 "413"，不匹配 "4130" 等）
pub(super) fn looks_like_payload_too_large_message(lower: &str) -> bool {
    if lower.contains("4130") {
        return false;
    }
    [
        "payload too large",
        "request_too_large",
        "entity too large",
        "request exceeds the maximum size",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        || contains_word(lower, "413")
}

/// 5xx 状态码集合（覆盖全部 500..=599，含 529 Overloaded 及 Cloudflare 52x 错误）
#[inline]
pub(super) const fn is_server_status(status: Option<u16>) -> bool {
    matches!(status, Some(500..=599))
}

/// 服务端错误响应体摘要（≤200 字符，去首尾空白）：随 [crate::error::ProviderError::Server]
/// 的 body_hint 透传上游原因——「该模型无可用上游」等服务端语义直达用户，
/// 而非裸状态码；空响应体返回 None（不拼尾部提示）
pub(super) fn server_body_hint(body_text: &str) -> Option<String> {
    let trimmed = body_text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(200).collect())
}

/// server 消息字样（:283-293）：统一覆盖 HTTP 5xx 状态码整词与 HTTP/RPC 服务端瞬态文案
pub(super) fn detect_server_message(lower: &str) -> bool {
    [
        "502", "503", "504", "520", "521", "522", "523", "524", "529",
    ]
    .iter()
    .any(|code| contains_word(lower, code))
        || [
            "bad gateway",
            "gateway timeout",
            "server error",
            "internal server error",
            "service unavailable",
            "overloaded",
            "temporarily unavailable",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// 整词匹配（等价 TS `\bword\b`）：基于子串查找 + ASCII 词边界字节判定，避免全串切分迭代
pub(super) fn contains_word(text: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let bytes = text.as_bytes();
    let mut start = 0;
    while let Some(rel) = text[start..].find(word) {
        let idx = start + rel;
        let end = idx + word.len();
        let prev_ok = idx == 0 || !bytes[idx - 1].is_ascii_alphanumeric();
        let next_ok = end == bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if prev_ok && next_ok {
            return true;
        }
        start = idx + 1;
    }
    false
}

/// timeout 字样（:295-302）：统一覆盖 HTTP 与 RPC/gRPC 超时文案（timeout / timed out / deadline exceeded）
pub(super) fn detect_timeout_message(lower: &str) -> bool {
    lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("deadline exceeded")
        || lower.contains("deadline_exceeded")
}

/// network 字样（:304-314）：统一覆盖 HTTP/RPC 传输层瞬态断连字样与整词 "network"
/// （"network" 保持整词匹配，避免 "internetwork" / "networking123" 等误伤）
pub(super) fn detect_network_message(lower: &str) -> bool {
    [
        "econnreset",
        "enotfound",
        "econnrefused",
        "etimedout",
        "epipe",
        "fetch failed",
        "socket hang up",
        "connection reset",
        "connection refused",
        "connection closed",
        "broken pipe",
        "unexpected eof",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        || contains_word(lower, "network")
}

/// Cloudflare 质询（:390-407 消息部分）：cf_chl|challenge-platform|just a moment|enable javascript
pub(super) fn looks_like_gateway_challenge(lower: &str) -> bool {
    lower.contains("cf_chl")
        || lower.contains("challenge-platform")
        || lower.contains("just a moment")
        || lower.contains("enable javascript")
}
