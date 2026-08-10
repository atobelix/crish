//! 敏感物脱敏纯函数库（D5 §6.3 M-REDACT 打码铁律）。
//!
//! 职责：敏感物 → 展示安全摘要。日志/审计面只允许以下形态：
//!
//! | 敏感物 | 允许形态 | 依据 |
//! |--------|----------|------|
//! | 设备令牌 | `sha256(token)` 前 12 hex | D5 §6.3：禁止明文/last8/完整哈希 |
//! | 配对码 | `sha256(code)` 前 12 hex | D5 §6.3：禁止明文 |
//! | Provider key | 末 4 字符 | D5 §6.3：维持 K-05（last4）不变 |
//!
//! 与 `agent-tools/audit.rs` 构造器配合：构造器接收「已打码」字符串，
//! 审计面不接触明文（D5 §6.3 实现落点）。[`redact_text`] /
//! [`scan_sensitive`] 是日志扫描（grep 式）测试与运行期日志文本兜底
//! 过滤的通用入口，扫描口径（D5 §6.3 验证）：43 字符 base64url 令牌
//! 形态 / 完整 sha256 hex / CXN 12 字符 base32 配对码形态 / `sk-` 前缀
//! 密钥形态。
//!
//! 本模块是纯函数库：不读写日志、不接触 tracing，只做确定性字符串
//! 变换（T-06/T-09 测试与运行期接线均直接调用本模块）。

use sha2::{Digest, Sha256};

/// 敏感形态扫描命中类型（T-06/T-09 日志与事件流扫描断言用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveKind {
    /// 令牌形态：连续 [A-Za-z0-9_-] 运行 ≥ 43 字符（覆盖 32 字节
    /// base64url 无填充形态与完整 sha256 hex——D5 §6.3 验证口径）
    Token,
    /// 配对码形态：`CXN-XXXX-XXXX-XXXX` 显示形态（D5 §6.3 验证口径）
    PairCode,
    /// Provider key 形态：`sk-` 前缀 + ≥ 4 位 [A-Za-z0-9_-]（T-09）
    ProviderKey,
}

/// 日志文本脱敏占位（对齐 `conex-browser-tools::helpers::redact_url_query`
/// 先例——同类打码职责用同一占位形态，便于日志检索）。
const REDACTED: &str = "<redacted>";

/// SHA-256 前 12 位小写 hex（M-REDACT 允许的唯一令牌/配对码日志形态）。
///
/// 契约：任意字节串 → 恒 12 位小写 hex；确定性（同输入同输出）。
pub fn sha256_prefix_12(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    hex::encode(digest)[..12].to_string()
}

/// 设备令牌脱敏：`sha256(token)` 前 12 hex（D5 §6.3）。
///
/// 契约：输入 = 令牌原文（任意长度）；输出 = 恒 12 位小写 hex，且输出
/// 不含输入的任何原文子串——短输入/空串同样只出哈希前缀，绝不回吐
/// 明文（「禁止明文/last8」铁律对边界输入同样生效）。
pub fn redact_token(token: &str) -> String {
    sha256_prefix_12(token)
}

/// 配对码脱敏：标准化后 `sha256(code)` 前 12 hex（D5 §6.3）。
///
/// 契约：输入 = 配对码（容错形态：`CXN-XXXX-XXXX-XXXX` / 裸 12 位 /
/// 小写 / 带空白或分隔符，标准化规则与
/// [`conex_types::device::PairCode::normalize`] 同源）；输出 = 恒 12 位
/// 小写 hex。同一码的不同输入形态 → 同一前缀（审计对账友好）；
/// 标准化失败（非法字符/长度）时仍对原始输入哈希——任何情况下不回吐
/// 明文（fail-safe）。
pub fn redact_pair_code(code: &str) -> String {
    let normalized = conex_types::device::PairCode::normalize(code)
        .map(|c| c.as_str().to_string())
        .unwrap_or_else(|_| code.to_string());
    sha256_prefix_12(&normalized)
}

/// Provider key 脱敏：末 4 字符（K-05 先例，D5 §6.3 维持不变）。
///
/// 契约：输入 = Provider key 原文；输出 = 末 4 个字符（空串 → 空串）。
/// 长度 ≤ 4 时原样返回——与既有 `config/resolution.rs::last4`（K-05
/// 展示面）语义一致；长度 > 4 时只留末 4 位，`sk-` 前缀等形态整体消失。
pub fn redact_provider_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

/// 通用日志文本脱敏（T-06 日志扫描零命中 / 运行期日志兜底入口）。
///
/// 在自由文本中把敏感形态替换为 [`REDACTED`] 占位；形态判定规则：
///
/// | 形态 | 规则 | 依据 |
/// |------|------|------|
/// | 令牌 | 连续 [A-Za-z0-9_-] 运行 ≥ 43 字符（覆盖 base64url 无填充形态与完整 hex） | D5 §6.3 验证口径 |
/// | 配对码 | `CXN-XXXX-XXXX-XXXX` 显示形态（大小写不敏感，字符集 = D3 §4.1 base32 子集） | D5 §6.3 验证口径 |
/// | Provider key | `sk-` 前缀 + ≥ 4 位 [A-Za-z0-9_-] | D5 §6.3 / T-09 |
///
/// 契约：
/// - 无敏感形态的普通文本原样通过（逐字节不变式）；
/// - 铁律允许的 12 hex 前缀形态（`sha256` 前缀）不在替换范围；
/// - 过度脱敏安全优先：43+ 字符连续标识符 / 64 hex 哈希运行一律打码
///   （对齐 `redact_url_query` 的「过度脱敏安全优先」注释）；
/// - 长运行整体按令牌形态处理（运行内含 `sk-`/`CXN-` 时同样整段打码，
///   扫描断言不受影响——零命中语义恒成立）。
///
/// 非 ASCII 文本（中文日志）按 UTF-8 逐字符原样保留，绝不切分多字节
/// 字符；敏感形态判定只针对 ASCII 字节。
pub fn redact_text(text: &str) -> String {
    let matches = sensitive_matches(text);
    if matches.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for (start, end, _kind) in matches {
        out.push_str(&text[cursor..start]);
        out.push_str(REDACTED);
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// 敏感形态扫描（grep 式；T-06 日志扫描 / T-09 事件流快照扫描断言用）。
///
/// 返回文本中命中的敏感形态（每种形态至多出现一次，按命中顺序）；
/// 空返回 = 零命中。判定规则与 [`redact_text`] 完全一致——保证
/// 「redact_text 后扫描零命中」测试的同源闭环。
pub fn scan_sensitive(text: &str) -> Vec<SensitiveKind> {
    let mut seen = Vec::new();
    for (_start, _end, kind) in sensitive_matches(text) {
        if !seen.contains(&kind) {
            seen.push(kind);
        }
    }
    seen
}

/// 敏感形态命中表：字节区间 + 形态（`redact_text` 与 `scan_sensitive`
/// 共用核心；命中区间互不重叠、按序排列）。
fn sensitive_matches(text: &str) -> Vec<(usize, usize, SensitiveKind)> {
    let bytes = text.as_bytes();
    let mut matches = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if let Some((end, kind)) = match_at(bytes, i) {
            matches.push((i, end, kind));
            i = end;
            continue;
        }
        // 未命中：按 UTF-8 字符边界前进一个字符（保证中文等不切分）
        i += char_len(bytes[i]);
    }
    matches
}

/// 在指定字节位置判定敏感形态；命中返回（末端字节偏移, 形态）。
///
/// 判定顺序：令牌运行（≥ 43 字符整体消费，长运行在此终结，避免
/// 逐字节重复扫描的平方复杂度）→ `sk-` 前缀 → CXN 显示形态。
fn match_at(bytes: &[u8], i: usize) -> Option<(usize, SensitiveKind)> {
    // 令牌形态（优先）：连续 [A-Za-z0-9_-] 运行 ≥ 43 字符
    if let Some(end) = token_run_end(bytes, i) {
        return Some((end, SensitiveKind::Token));
    }
    // Provider key 形态：sk- 前缀 + ≥ 4 位 [A-Za-z0-9_-]
    if is_ascii_ci(bytes, i, b"sk-") {
        let mut j = i + 3;
        while j < bytes.len() && is_token_byte(bytes[j]) {
            j += 1;
        }
        if j - (i + 3) >= 4 {
            return Some((j, SensitiveKind::ProviderKey));
        }
    }
    // 配对码形态：CXN-XXXX-XXXX-XXXX（大小写不敏感，字符集校验）
    if pair_code_display_end(bytes, i) {
        return Some((i + PAIR_CODE_DISPLAY_LEN, SensitiveKind::PairCode));
    }
    None
}

/// 配对码显示形态总长（`CXN-` + 4 + `-` + 4 + `-` + 4 = 18 字节）。
const PAIR_CODE_DISPLAY_LEN: usize = 18;

/// 配对码有效字符集（与 `conex_types::device::PAIR_CODE_ALPHABET` 同源：
/// D3 §4.1 base32 子集，去 0/O/1/I 混淆字符；含 L——以 Rust 侧常量
/// 唯一真源为准，参考 tests/fixtures/device-protocol 对拍记录）。
const PAIR_CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// 从 i 起连续 [A-Za-z0-9_-] 运行：长度 ≥ 43 返回运行末端（含），
/// 否则返回 None（短运行交由后续形态判定）。
fn token_run_end(bytes: &[u8], i: usize) -> Option<usize> {
    if !is_token_byte(bytes[i]) {
        return None;
    }
    let mut j = i + 1;
    while j < bytes.len() && is_token_byte(bytes[j]) {
        j += 1;
    }
    (j - i >= 43).then_some(j)
}

/// 令牌形态字符集：[A-Za-z0-9_-]（base64url 无填充形态字符集）。
fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// 校验 i 起是否为 `CXN-XXXX-XXXX-XXXX` 显示形态（前缀与字符集均
/// 大小写不敏感；组间必须恰一个 `-`）。
fn pair_code_display_end(bytes: &[u8], i: usize) -> bool {
    if i + PAIR_CODE_DISPLAY_LEN > bytes.len() || !is_ascii_ci(bytes, i, b"cxn-") {
        return false;
    }
    let mut j = i + 4;
    for group in 0..3 {
        for _ in 0..4 {
            if !is_pair_code_char(bytes[j]) {
                return false;
            }
            j += 1;
        }
        if group < 2 {
            if bytes[j] != b'-' {
                return false;
            }
            j += 1;
        }
    }
    true
}

/// 配对码字符集判定（大小写不敏感）。
///
/// 注意不能用 `is_ascii_uppercase()` 预筛——字符集含数字 2-9，
/// 数字字符不满足 ASCII 大写判定（曾因此漏过含数字的配对码）。
fn is_pair_code_char(b: u8) -> bool {
    let upper = b.to_ascii_uppercase();
    PAIR_CODE_ALPHABET.contains(upper as char)
}

/// 大小写不敏感前缀比较（仅 ASCII）。
fn is_ascii_ci(bytes: &[u8], i: usize, pat: &[u8]) -> bool {
    i + pat.len() <= bytes.len() && bytes[i..i + pat.len()].eq_ignore_ascii_case(pat)
}

/// UTF-8 首字节 → 该字符字节数（有效 UTF-8 下不会命中续字节分支；
/// 续字节落入 `_` 按 1 字节前进，仅为畸形输入兜底不 panic）。
fn char_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xFF => 4,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 43 字符 base64url 令牌样例（32 字节无填充形态，D5 §6.3 验证口径）。
    const TOKEN_43: &str = "9Gm7X2pQ8tR4vY6nW0cB3kL5zD1hF8aJ4uS7eT2wxyz";

    /// 64 字符 hex 令牌样例（auth.rs 实际签发形态：32B CSPRNG hex）。
    const TOKEN_HEX64: &str = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";

    /// 配对码显示形态样例（pair.rs 测试同款合法码）。
    const PAIR_DISPLAY: &str = "CXN-7K4P-Q2MB-9XRT";

    /// Provider key 样例（sk- 前缀形态，短于 43 字符以命中 ProviderKey 判定）。
    const KEY_SK: &str = "sk-proj-ABCDEF123456";

    #[test]
    fn redact_token_masks_full() {
        // D5 §9.4 `redact_token_masks_full`：43 字符令牌 → 12 hex 前缀，无原文子串
        let out = redact_token(TOKEN_43);
        assert_eq!(out.len(), 12);
        assert!(out.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!TOKEN_43.contains(out.as_str()), "输出不得为原文子串");
        assert_ne!(out, TOKEN_43);
    }

    #[test]
    fn redact_token_masks_64hex_workbench_shape() {
        // 实际签发形态（auth.rs：32B CSPRNG hex 64 字符）同样只出 12 hex
        let out = redact_token(TOKEN_HEX64);
        assert_eq!(out.len(), 12);
        assert!(out.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!TOKEN_HEX64.contains(out.as_str()), "输出不得为原文子串");
    }

    #[test]
    fn redact_token_short_and_empty_never_plaintext() {
        // 边界：短输入/空串也绝不回吐明文（铁律对边界输入同样生效）
        assert_eq!(redact_token("ab").len(), 12);
        assert_ne!(redact_token("ab"), "ab");
        assert_eq!(redact_token("").len(), 12);
        assert_ne!(redact_token(""), "");
    }

    #[test]
    fn redact_token_deterministic() {
        assert_eq!(redact_token(TOKEN_HEX64), redact_token(TOKEN_HEX64));
    }

    #[test]
    fn redact_pair_code_masks_display_form() {
        // D5 §9.4 `redact_pairing_code_masks`：显示形态 → 哈希前缀，无原文子串
        let out = redact_pair_code(PAIR_DISPLAY);
        assert_eq!(out.len(), 12);
        assert!(out.chars().all(|c| c.is_ascii_hexdigit()));
        let body = PAIR_DISPLAY.replace('-', "");
        assert!(!body.contains(out.as_str()), "输出不得为原文子串");
    }

    #[test]
    fn redact_pair_code_equivalent_forms_same_prefix() {
        // 同一码的不同输入形态（裸 12 位 / 小写 / 带分隔）→ 同一前缀（审计对账友好）
        let display = redact_pair_code(PAIR_DISPLAY);
        assert_eq!(redact_pair_code("7K4PQ2MB9XRT"), display);
        assert_eq!(redact_pair_code("cxn-7k4p-q2mb-9xrt"), display);
    }

    #[test]
    fn redact_pair_code_invalid_never_plaintext() {
        // 非法形态（含混淆字符 O / 长度不足 / 空串）→ 仍出哈希前缀，绝不回吐明文
        let invalid = "CXN-7K4P-Q2MB-9XRO";
        let out = redact_pair_code(invalid);
        assert_eq!(out.len(), 12);
        assert!(out.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(out, invalid);
        assert_eq!(redact_pair_code("SHORT").len(), 12);
        assert_ne!(redact_pair_code("SHORT"), "SHORT");
        assert_eq!(redact_pair_code("").len(), 12);
    }

    #[test]
    fn redact_provider_key_last4() {
        // D5 §6.3：Provider key 维持 K-05（last4）；sk- 前缀整体消失
        assert_eq!(redact_provider_key(KEY_SK), "3456");
    }

    #[test]
    fn redact_provider_key_short_and_empty() {
        // 边界：短输入按 K-05 语义返回尾部（与 resolution.rs::last4 一致），不 panic
        assert_eq!(redact_provider_key(""), "");
        assert_eq!(redact_provider_key("a"), "a");
        assert_eq!(redact_provider_key("abcd"), "abcd");
    }

    #[test]
    fn redact_text_masks_all_three_forms() {
        let line = format!(
            "2026-08-11T10:00:00Z  INFO ws: 连接注册 conn_id=3 token={} code={} api_key={}",
            TOKEN_HEX64, PAIR_DISPLAY, KEY_SK
        );
        let out = redact_text(&line);
        assert!(!out.contains(TOKEN_HEX64));
        assert!(!out.contains(PAIR_DISPLAY));
        assert!(!out.contains(KEY_SK));
        assert_eq!(out.matches("<redacted>").count(), 3, "三处敏感形态应各打码一次：{out}");
        assert!(out.contains("连接注册"), "非敏感中文正文必须原样保留");
    }

    #[test]
    fn redact_text_plain_text_passthrough() {
        // 无敏感形态 → 原样通过（逐字节不变式）
        let line = "2026-08-11T10:00:00Z  INFO server: 令牌库已加载 tokens=1";
        assert_eq!(redact_text(line), line);
    }

    #[test]
    fn redact_text_allowed_12_hex_prefix_stays() {
        // 铁律允许形态（sha256 前缀 12 hex）不在替换范围
        let line = "2026-08-11T10:00:00Z  INFO ws: 连接注册 conn_id=3 token_prefix=0a1b2c3d4e5f";
        assert_eq!(redact_text(line), line);
    }

    #[test]
    fn redact_text_43_base64url_and_64_hex_runs() {
        let line = format!("token={TOKEN_43} hash={TOKEN_HEX64}");
        let out = redact_text(&line);
        assert!(!out.contains(&TOKEN_43[..8]));
        assert!(!out.contains(&TOKEN_HEX64[..8]));
        assert_eq!(out.matches("<redacted>").count(), 2);
    }

    #[test]
    fn redact_text_utf8_chinese_survives() {
        // 中文（多字节 UTF-8）与敏感形态混排：中文原样，敏感形态打码
        let line = format!("认证失败：token={}，请重新配对", TOKEN_HEX64);
        let out = redact_text(&line);
        assert!(out.starts_with("认证失败：token="));
        assert!(out.ends_with("，请重新配对"));
        assert!(!out.contains(TOKEN_HEX64));
    }

    #[test]
    fn scan_sensitive_detects_each_kind() {
        let text = format!(
            "token={} code={} api_key={}",
            TOKEN_HEX64, PAIR_DISPLAY, KEY_SK
        );
        let hits = scan_sensitive(&text);
        assert!(hits.contains(&SensitiveKind::Token));
        assert!(hits.contains(&SensitiveKind::PairCode));
        assert!(hits.contains(&SensitiveKind::ProviderKey));
    }

    #[test]
    fn scan_sensitive_empty_on_clean_and_redacted() {
        assert!(scan_sensitive("普通日志行，无敏感形态").is_empty());
        let line = format!("token={TOKEN_HEX64}");
        assert!(!scan_sensitive(&line).is_empty());
        let redacted = redact_text(&line);
        assert!(
            scan_sensitive(&redacted).is_empty(),
            "redact 后必须零命中：{redacted}"
        );
    }
}
