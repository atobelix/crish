//! Formatting helpers for error reporting and log truncation.
//!
//! These helpers are shared by the panic/crash path and by callers that need
//! to render `std::error::Error` chains in a single line.

use std::error::Error;

/// Render an error and its full `source()` chain on one line.
///
/// The top-level error comes first, followed by each cause joined by
/// `": caused by: "`. For example, a three-level chain produces:
///
/// ```text
/// top message: caused by: mid message: caused by: root message
/// ```
///
/// Cycles are not possible with the standard `Error::source` contract (each
/// call must return a strictly narrower cause), so the walk terminates without
/// a visited-set guard.
pub fn format_error_chain(e: &dyn Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(e.to_string());

    let mut current = e.source();
    while let Some(cause) = current {
        parts.push(cause.to_string());
        current = cause.source();
    }

    parts.join(": caused by: ")
}

/// Truncate `s` to at most `max_len` bytes, appending `"..."` when truncated.
///
/// Truncation respects UTF-8 char boundaries: if the target cut point lands
/// inside a multi-byte sequence it is moved back to the nearest boundary, so
/// the result is always valid UTF-8 and never splits a character.
///
/// - If `s` already fits within `max_len`, it is returned unchanged.
/// - If `max_len <= 3` there is no room for the ellipsis, so the string is
///   cut at a char boundary without any suffix.
pub fn truncate_string(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        return s.to_string();
    }

    if max_len <= 3 {
        let cut = floor_char_boundary(s, max_len);
        return s[..cut].to_string();
    }

    // Reserve 3 bytes for the ellipsis.
    let target = max_len - 3;
    let cut = floor_char_boundary(s, target);
    format!("{}...", &s[..cut])
}

/// Return the largest byte index `<= index` that is a UTF-8 char boundary.
///
/// `str::is_char_boundary` is stable; this helper walks backward from `index`
/// until a boundary is found. `index` is assumed to be `<= s.len()`.
fn floor_char_boundary(s: &str, index: usize) -> usize {
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_chain_single_error() {
        let err = std::io::Error::new(std::io::ErrorKind::Other, "solo");
        assert_eq!(format_error_chain(&err), "solo");
    }

    #[test]
    fn truncate_short_string_unchanged() {
        assert_eq!(truncate_string("hi", 10), "hi");
    }

    #[test]
    fn truncate_long_string_gets_ellipsis() {
        assert_eq!(truncate_string("hello world", 8), "hello...");
    }

    #[test]
    fn truncate_respects_char_boundary() {
        // "é" is 2 bytes; cutting at byte 1 must fall back to byte 0.
        // max_len 含省略号（"hello world",8 → "hello..." 总长 8）：预留 3 字节
        // 省略号后仅剩 1 字节，放不下 2 字节的 "é" → 截到边界 0，仅保留省略号。
        assert_eq!(truncate_string("éééé", 4), "...");
        // 预留后有整字符空间时保留前缀 + 省略号（总长不超过 max_len）
        assert_eq!(truncate_string("éééé", 5), "é...");
        // 截断点落在多字节序列中间 → 回退到最近字符边界
        assert_eq!(truncate_string("aééé", 4), "a...");
    }
}
