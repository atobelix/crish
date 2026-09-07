//! Markdown URL 安全清理、白名单校验与 CJK 智能断字。
//!
//! 直接移植自 apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts。
//! 任何变更必须先确认与 JS 实现行为一致。

use once_cell::sync::Lazy;
use regex::Regex;

/// 控制符 / BOM / 零宽 / bidi 覆盖字符, smuggle `javascript:` 等危险 scheme。
const SMUGGLE_CHARS: &str = "\u{0000}-\u{001f}\u{007f}\u{00ad}\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{feff}";

static SMUGGLE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!("[{}]", SMUGGLE_CHARS)).expect("valid smuggle regex")
});

static HAS_WHITESPACE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\s\u{00a0}\u{3000}]").expect("valid whitespace regex"));

static HTTP_SCHEME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^https?://").expect("valid http scheme regex"));

static MAILTO_SCHEME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^mailto:").expect("valid mailto scheme regex"));

static ANY_SCHEME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").expect("valid scheme regex"));

static DATA_IMAGE_RASTER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^data:image/(png|jpe?g|gif|webp|avif|bmp)[;,]").expect("valid data image regex")
});

static JS_VBSCRIPT_DATA_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(javascript|vbscript|data):").expect("valid unsafe scheme regex"));

static WIN_DRIVE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("valid windows drive regex"));

static PROJECT_PREFIX_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(apps|packages|src|docs)/").expect("valid project prefix regex"));

static CODE_EXT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\.(ts|tsx|js|jsx|css|md|json|rs|py|toml|yml|yaml)$").expect("valid code ext regex")
});

/// CJK 范围 (含扩展 A/兼容) — 仅用于 wrap_cjk_text_segment 内部 regex 字符类。
const CJK_CLASS: &str = r"\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}";

/// 剥控制符 / BOM / 零宽 / bidi 覆盖, 防止 smuggle `javascript:` 等危险 scheme。
/// 用于 href/src 安全判定前的归一化(不改变展示用原文 escape 路径)。
pub fn sanitize_url_candidate(url: &str) -> String {
    SMUGGLE_RE.replace_all(url, "").trim().to_string()
}

/// 生成 scheme 判定用变体: 原文 + 至多 2 次 decode。
/// 捕获 `javascript%3A` / `java%09script:` 等百分号走私;
/// 写入属性仍用调用方 sanitize 后的原文。
pub fn url_safety_variants(url: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |s: String| {
        let cleaned = sanitize_url_candidate(&s);
        if cleaned.is_empty() || seen.contains(&cleaned) {
            return;
        }
        seen.insert(cleaned.clone());
        out.push(cleaned);
    };
    add(url.to_string());

    let mut cur = url.to_string();
    for _ in 0..2 {
        match percent_decode(&cur) {
            Some(decoded) if decoded != cur => {
                add(decoded.clone());
                cur = decoded;
            }
            _ => break,
        }
    }
    out
}

/// 简单 percent-decode (RFC 3986) — 不依赖外部 crate。
fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut changed = false;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_digit(bytes[i + 1])?;
            let lo = hex_digit(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
            changed = true;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    if !changed {
        return None;
    }
    String::from_utf8(out).ok()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub fn has_embedded_url_whitespace(t: &str) -> bool {
    HAS_WHITESPACE_RE.is_match(t)
}

/// 危险 scheme: javascript: / data:text/html / vbscript: 等不得写入 href/src。
/// 允许: http(s)、mailto、相对/本地路径(无 scheme 或 # 锚点)。
/// 任一 decode 变体含危险 scheme 或内嵌空白 → 拒绝。
pub fn is_safe_href(url: &str) -> bool {
    let variants = url_safety_variants(url);
    if variants.is_empty() {
        return false;
    }
    for t in &variants {
        if has_embedded_url_whitespace(t) {
            return false;
        }
    }
    let primary = variants[0].as_str();
    if primary.starts_with('#') {
        return true;
    }
    for t in &variants {
        if HTTP_SCHEME_RE.is_match(t) || MAILTO_SCHEME_RE.is_match(t) {
            return true;
        }
    }
    // 任意变体带其它 scheme(含 javascript: / data: / vbscript: / 百分号解码后)一律拒绝
    for t in &variants {
        if ANY_SCHEME_RE.is_match(t) {
            return false;
        }
    }
    true
}

/// 图片 src: http(s) / 相对路径 / 光栅 data:image(png/jpeg/gif/webp/avif/bmp)。
/// 拒绝 data:text/html、data:image/svg+xml(可内嵌脚本)及其它 scheme。
/// 百分号解码变体参与判定, 防止 data%3Aimage/svg+xml 等走私。
pub fn is_safe_img_src(url: &str) -> bool {
    let variants = url_safety_variants(url);
    if variants.is_empty() {
        return false;
    }
    for t in &variants {
        if has_embedded_url_whitespace(t) {
            return false;
        }
    }
    for t in &variants {
        if HTTP_SCHEME_RE.is_match(t) {
            return true;
        }
        // 仅安全光栅; 分号或逗号起 payload(;base64, / ,raw)
        if DATA_IMAGE_RASTER_RE.is_match(t) {
            return true;
        }
    }
    for t in &variants {
        if ANY_SCHEME_RE.is_match(t) {
            return false;
        }
    }
    true
}

pub fn is_local_path_ref(s: &str) -> bool {
    let variants = url_safety_variants(s);
    let fallback = sanitize_url_candidate(s);
    let t_owned = variants.first().cloned().unwrap_or_else(|| fallback.clone());
    let t = if t_owned.is_empty() { fallback.as_str() } else { t_owned.as_str() };
    if t.is_empty() {
        return false;
    }
    // 任一变体已是 http(s)/mailto 或危险 scheme → 非本地路径
    for v in &variants {
        if HTTP_SCHEME_RE.is_match(v) || MAILTO_SCHEME_RE.is_match(v) {
            return false;
        }
        if JS_VBSCRIPT_DATA_RE.is_match(v) {
            return false;
        }
    }
    if WIN_DRIVE_RE.is_match(t) {
        return true;
    }
    if t.starts_with('/')
        || t.starts_with("~/")
        || t.starts_with("./")
        || t.starts_with("../")
    {
        return true;
    }
    if PROJECT_PREFIX_RE.is_match(t) {
        return true;
    }
    if CODE_EXT_RE.is_match(t) && !t.contains("://") {
        return true;
    }
    false
}

/// 窄屏 CJK 断行: 在标签外文本插入 `<wbr>`。
/// - CJK ↔ 拉丁/数字/路径字符边界插入 `<wbr>`
/// - 纯 CJK 长文本不再强插 `<wbr>`，交由现代 CSS 引擎接管，杜绝表格单元格列宽畸变。
pub fn wrap_cjk_text_segment(text: &str) -> String {
    use std::sync::OnceLock;
    static BOUNDARY_RE: OnceLock<Regex> = OnceLock::new();
    let boundary_re = BOUNDARY_RE.get_or_init(|| {
        let pattern = format!(
            r"([{cjk}])([A-Za-z0-9@._/\\-])|([A-Za-z0-9@._/\\-])([{cjk}])",
            cjk = CJK_CLASS
        );
        Regex::new(&pattern).expect("valid cjk boundary regex")
    });

    boundary_re
        .replace_all(text, |caps: &regex::Captures| {
            // 1+2 or 3+4 — 任一匹配
            if let (Some(a), Some(b)) = (caps.get(1), caps.get(2)) {
                format!("{}<wbr>{}", a.as_str(), b.as_str())
            } else if let (Some(a), Some(b)) = (caps.get(3), caps.get(4)) {
                format!("{}<wbr>{}", a.as_str(), b.as_str())
            } else {
                String::new()
            }
        })
        .to_string()
}

/// 从 markdown 链目标字符串取出 URL(去掉可选 title;支持尖括号)。
pub fn link_destination_url(raw: &str) -> String {
    let mut dest = raw.trim().to_string();
    if dest.is_empty() {
        return String::new();
    }
    // <http://...> 或残缺 `<javascript:alert(1`(无闭合 > 时仍剥开头 <,避免当相对路径放行)
    if dest.starts_with('<') {
        if let Some(end) = dest.find('>') {
            if end > 0 {
                return dest[1..end].trim().to_string();
            }
        }
        dest = dest[1..].trim().to_string();
    }
    // url "title" / url 'title'
    let titled_re = Lazy::new(|| Regex::new(r#"^(\S+)\s+["'][\s\S]*["']\s*$"#).expect("valid titled regex"));
    if let Some(caps) = titled_re.captures(&dest) {
        return caps.get(1).map(|m| m.as_str().to_string()).unwrap_or(dest);
    }
    // 无 title: 整段(可含 alert(1) 的括号)视为 URL,仅在空白处截断首 token
    if !dest.chars().any(|c| c.is_whitespace()) {
        return dest;
    }
    dest.split_whitespace()
        .next()
        .unwrap_or(&dest)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_zero_width() {
        assert_eq!(sanitize_url_candidate("java\u{200b}script:x"), "javascript:x");
    }

    #[test]
    fn safe_href_allows_http() {
        assert!(is_safe_href("https://example.com/a"));
        assert!(is_safe_href("mailto:a@b.com"));
    }

    #[test]
    fn safe_href_blocks_javascript() {
        assert!(!is_safe_href("javascript:alert(1)"));
        assert!(!is_safe_href("javascript%3Aalert(1)"));
    }

    #[test]
    fn safe_img_blocks_svg() {
        assert!(!is_safe_img_src("data:image/svg+xml;base64,PHN2Zy9+"));
        assert!(is_safe_img_src("data:image/png;base64,iVBOR"));
    }

    #[test]
    fn link_destination_handles_angle_brackets() {
        assert_eq!(link_destination_url("<https://ex.com>"), "https://ex.com");
    }

    #[test]
    fn wrap_cjk_does_not_insert_wbr_in_pure_cjk() {
        let text = "这是一段非常非常长的连续纯中文字符串用于断言绝不强插断字标签";
        let wrapped = wrap_cjk_text_segment(text);
        assert_eq!(wrapped, text);
    }

    #[test]
    fn wrap_cjk_inserts_wbr_at_latin_cjk_boundary() {
        let text = "修复Bug完成";
        let wrapped = wrap_cjk_text_segment(text);
        assert_eq!(wrapped, "修复<wbr>Bug<wbr>完成");
    }
}
