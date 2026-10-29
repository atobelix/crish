//! Markdown URL 安全判定、本地路径识别与 `file:///` 转换。
//!
//! 本模块**不负责 HTML 清洗**：不可信 raw HTML 的清洗在 `raw_html.rs`，
//! 由 ammonia 白名单完成。这里只做 scheme/路径层面的安全判定，供链接、
//! 图片与 raw HTML 属性过滤共同使用。

use once_cell::sync::Lazy;
use regex::Regex;
use std::borrow::Cow;

/// 控制符 / BOM / 零宽 / bidi 覆盖字符，用于防止 smuggle `javascript:` 等危险
/// scheme（例如 `java\u{200b}script:`）。
const SMUGGLE_CHARS: &str =
    "\u{0000}-\u{001f}\u{007f}\u{00ad}\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{feff}";

static SMUGGLE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(&format!("[{}]", SMUGGLE_CHARS)).expect("valid smuggle regex"));

static HAS_WHITESPACE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\s\u{00a0}\u{3000}]").expect("valid whitespace regex"));

static HTTP_SCHEME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^https?://").expect("valid http scheme regex"));

static MAILTO_SCHEME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^mailto:").expect("valid mailto scheme regex"));

static ANY_SCHEME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").expect("valid scheme regex"));

static DATA_IMAGE_RASTER_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^data:image/(png|jpe?g|gif|webp|avif|bmp)[;,]")
        .expect("valid data image regex")
});

static JS_VBSCRIPT_DATA_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^(javascript|vbscript|data):").expect("valid unsafe scheme regex")
});

static WIN_DRIVE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z]:[\\/]").expect("valid windows drive regex"));

static PROJECT_PREFIX_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(apps|packages|src|docs)/").expect("valid project prefix regex"));

static CODE_EXT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\.(ts|tsx|js|jsx|css|md|json|rs|py|toml|yml|yaml)$")
        .expect("valid code ext regex")
});

static TITLED_LINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"^(\S+)\s+["'][\s\S]*["']\s*$"#).expect("valid titled regex"));

/// 快速预检：纯 ASCII 且不含控制字符时无需执行 `SMUGGLE_RE` 正则扫描。
#[inline]
fn may_contain_smuggle_chars(s: &str) -> bool {
    s.bytes().any(|b| b <= 0x1f || b >= 0x7f)
}

/// 零拷贝版 URL 候选清洗：不含控制符/零宽字符时直接借用 trim 切片。
#[inline]
pub fn sanitize_url_candidate_cow(url: &str) -> Cow<'_, str> {
    if !may_contain_smuggle_chars(url) {
        return Cow::Borrowed(url.trim());
    }
    match SMUGGLE_RE.replace_all(url, "") {
        Cow::Borrowed(s) => Cow::Borrowed(s.trim()),
        Cow::Owned(s) => {
            let trimmed = s.trim();
            if trimmed.len() == s.len() {
                Cow::Owned(s)
            } else {
                Cow::Owned(trimmed.to_string())
            }
        }
    }
}

/// 剥控制符 / BOM / 零宽 / bidi 覆盖，防止 smuggle 危险 scheme。
pub fn sanitize_url_candidate(url: &str) -> String {
    sanitize_url_candidate_cow(url).into_owned()
}

/// 栈上最多 3 个 URL 安全判定变体（原文 + 至多 2 次 percent-decode），
/// 消除每次调用构造 `HashSet` 与重复克隆 `String` 的开销。
struct SmallUrlVariants<'a> {
    items: [Option<Cow<'a, str>>; 3],
    len: usize,
}

impl<'a> SmallUrlVariants<'a> {
    #[inline]
    fn from_url(url: &'a str) -> Self {
        let mut v = Self {
            items: [None, None, None],
            len: 0,
        };
        v.push_cleaned(sanitize_url_candidate_cow(url));
        if url.contains('%') {
            let mut cur: Cow<'a, str> = Cow::Borrowed(url);
            for _ in 0..2 {
                match percent_decode(&cur) {
                    Some(decoded) if decoded != cur.as_ref() => {
                        let cleaned = sanitize_url_candidate(&decoded);
                        v.push_cleaned(Cow::Owned(cleaned));
                        cur = Cow::Owned(decoded);
                    }
                    _ => break,
                }
            }
        }
        v
    }

    #[inline]
    fn push_cleaned(&mut self, cleaned: Cow<'a, str>) {
        if cleaned.is_empty() || self.len >= 3 {
            return;
        }
        for i in 0..self.len {
            if self.items[i].as_deref() == Some(cleaned.as_ref()) {
                return;
            }
        }
        self.items[self.len] = Some(cleaned);
        self.len += 1;
    }

    #[inline]
    fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline]
    fn first_str(&self) -> Option<&str> {
        self.items[0].as_deref()
    }

    #[inline]
    fn iter(&self) -> impl Iterator<Item = &str> {
        self.items[..self.len].iter().filter_map(|x| x.as_deref())
    }
}

/// 生成 scheme 判定用变体：原文 + 至多 2 次 decode。
pub fn url_safety_variants(url: &str) -> Vec<String> {
    let variants = SmallUrlVariants::from_url(url);
    let mut out = Vec::with_capacity(variants.len);
    for item in variants.items.into_iter().take(variants.len).flatten() {
        out.push(item.into_owned());
    }
    out
}

/// 简单 percent-decode（RFC 3986）— 不依赖外部 crate。
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

/// percent-decode，但即使不含 `%` 也返回 owned String；用于 `file:///` 路径。
fn percent_decode_owned(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
    percent_decode(s)
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
    if t.is_ascii() {
        return t.bytes().any(|b| b.is_ascii_whitespace());
    }
    HAS_WHITESPACE_RE.is_match(t)
}

/// 危险 scheme：javascript: / data:text/html / vbscript: 等不得写入 href/src。
/// 允许：http(s)、mailto、相对/本地路径（无 scheme 或 # 锚点）。
/// 任一 decode 变体含危险 scheme 或内嵌空白 → 拒绝。
pub fn is_safe_href(url: &str) -> bool {
    let variants = SmallUrlVariants::from_url(url);
    if variants.is_empty() {
        return false;
    }
    for t in variants.iter() {
        if has_embedded_url_whitespace(t) {
            return false;
        }
    }
    if let Some(primary) = variants.first_str() {
        if primary.starts_with('#') {
            return true;
        }
    }
    for t in variants.iter() {
        if HTTP_SCHEME_RE.is_match(t) || MAILTO_SCHEME_RE.is_match(t) {
            return true;
        }
    }
    // 任意变体带其它 scheme（含 javascript: / data: / vbscript: / 百分号解码后）一律拒绝
    for t in variants.iter() {
        if ANY_SCHEME_RE.is_match(t) {
            return false;
        }
    }
    true
}

/// 图片 src：http(s) / 相对路径 / 光栅 data:image(png/jpeg/gif/webp/avif/bmp)。
/// 拒绝 data:text/html、data:image/svg+xml（可内嵌脚本）及其它 scheme。
pub fn is_safe_img_src(url: &str) -> bool {
    let variants = SmallUrlVariants::from_url(url);
    if variants.is_empty() {
        return false;
    }
    for t in variants.iter() {
        if has_embedded_url_whitespace(t) {
            return false;
        }
    }
    for t in variants.iter() {
        if HTTP_SCHEME_RE.is_match(t) {
            return true;
        }
        if DATA_IMAGE_RASTER_RE.is_match(t) {
            return true;
        }
    }
    for t in variants.iter() {
        if ANY_SCHEME_RE.is_match(t) {
            return false;
        }
    }
    true
}

/// `file:///C:/foo` / `file://server/share` / `file:/home/user` → 本地路径。
///
/// 返回 None 表示不是 file URL、路径为空或含控制字符。路径只做 percent-decode，
/// 不做规范化/存在性检查（存在性与可执行后缀由前端/宿主侧守卫）。
pub fn file_url_to_path(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (rest, is_authority_form) = if lower.starts_with("file://") {
        (&trimmed[7..], true)
    } else if lower.starts_with("file:") {
        (&trimmed[5..], false)
    } else {
        return None;
    };
    if rest.is_empty() {
        return None;
    }
    let decoded = percent_decode_owned(rest)?;
    if decoded.is_empty() || decoded.chars().any(|c| c.is_control()) {
        return None;
    }

    let path = if is_authority_form {
        if let Some(after_slash) = decoded.strip_prefix('/') {
            // file:///C:/foo 或 file:///home/user
            if is_windows_drive_prefix(after_slash) {
                after_slash.to_string()
            } else {
                decoded.clone()
            }
        } else {
            // file://server/share：UNC / 网络路径
            if cfg!(windows) {
                format!("\\\\{}", decoded.replace('/', "\\"))
            } else {
                format!("//{decoded}")
            }
        }
    } else {
        decoded
    };

    Some(path)
}

fn is_windows_drive_prefix(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// 本地路径引用（Markdown 裸路径 / 链接）。
pub fn is_local_path_ref(s: &str) -> bool {
    let variants = SmallUrlVariants::from_url(s);
    let fallback = sanitize_url_candidate_cow(s);
    let t = variants
        .first_str()
        .filter(|first| !first.is_empty())
        .unwrap_or_else(|| fallback.as_ref());
    if t.is_empty() {
        return false;
    }

    if file_url_to_path(s).is_some() {
        return true;
    }

    // 任一变体已是 http(s)/mailto 或危险 scheme → 非本地路径
    for v in variants.iter() {
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
    if t.starts_with('/') || t.starts_with("~/") || t.starts_with("./") || t.starts_with("../") {
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

/// 从 markdown 链目标字符串取出 URL（去掉可选 title；支持尖括号）。
pub fn link_destination_url(raw: &str) -> String {
    let mut dest = raw.trim();
    if dest.is_empty() {
        return String::new();
    }
    // <http://...> 或残缺 `<javascript:alert(1`（无闭合 > 时仍剥开头 <，避免当相对路径放行）
    if let Some(after_lt) = dest.strip_prefix('<') {
        if let Some(end) = after_lt.find('>') {
            return after_lt[..end].trim().to_string();
        }
        dest = after_lt.trim();
    }
    // url "title" / url 'title'
    if dest.contains('"') || dest.contains('\'') {
        if let Some(caps) = TITLED_LINK_RE.captures(dest) {
            return caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| dest.to_string());
        }
    }
    dest.split_whitespace().next().unwrap_or(dest).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_zero_width() {
        assert_eq!(
            sanitize_url_candidate("java\u{200b}script:x"),
            "javascript:x"
        );
    }

    #[test]
    fn safe_href_allows_http_and_mailto() {
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
    fn file_url_to_path_handles_windows_and_unix_forms() {
        assert_eq!(
            file_url_to_path("file:///C:/Workspace/docs/design.pdf").as_deref(),
            Some("C:/Workspace/docs/design.pdf")
        );
        assert_eq!(
            file_url_to_path("file:///home/user/a%20b.md").as_deref(),
            Some("/home/user/a b.md")
        );
        assert_eq!(
            file_url_to_path("file:/home/user/a.md").as_deref(),
            Some("/home/user/a.md")
        );
    }

    #[test]
    fn file_url_is_local_path_ref() {
        assert!(is_local_path_ref("file:///C:/Workspace/a.md"));
        assert!(is_local_path_ref("C:\\Workspace\\a.md"));
        assert!(is_local_path_ref("./docs/a.md"));
        assert!(!is_local_path_ref("https://example.com/a.md"));
    }

    #[test]
    fn file_url_rejects_empty_and_control_chars() {
        assert_eq!(file_url_to_path("file://"), None);
        assert_eq!(file_url_to_path("file:///%00evil"), None);
    }
}
