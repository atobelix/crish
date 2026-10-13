//! Markdown URL 安全清理、白名单校验与 CJK 智能断字。
//!
//! 直接移植自 apps/crish-desktop/src/api/markdown-render/markdownSanitizer.ts。
//! 任何变更必须先确认与 JS 实现行为一致。

use ammonia::Builder;
use once_cell::sync::Lazy;
use regex::Regex;
use std::borrow::Cow;

use crate::ammonia_config::AMMONIA_BUILDER;

/// 控制符 / BOM / 零宽 / bidi 覆盖字符, smuggle `javascript:` 等危险 scheme。
const SMUGGLE_CHARS: &str = "\u{0000}-\u{001f}\u{007f}\u{00ad}\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{feff}";

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

/// CJK 范围 (含扩展 A/兼容) — 仅用于 wrap_cjk_text_segment 内部 regex 字符类。
const CJK_CLASS: &str = r"\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}";

static CJK_BOUNDARY_RE: Lazy<Regex> = Lazy::new(|| {
    let pattern = format!(
        r"([{cjk}])([A-Za-z0-9@._/\\-])|([A-Za-z0-9@._/\\-])([{cjk}])",
        cjk = CJK_CLASS
    );
    Regex::new(&pattern).expect("valid cjk boundary regex")
});

/// 全局预热重用的 Sanitizer 配置（DEF-13）：
/// 聚合 HTML 清理器 `ammonia::Builder<'static>` 与全部 URL/文本安全校验正则，
/// 确保全局只构建一次并在所有清洗调用间零成本共享复用。
pub struct SanitizerConfig {
    pub html_builder: &'static Builder<'static>,
    pub smuggle_re: &'static Regex,
    pub has_whitespace_re: &'static Regex,
    pub http_scheme_re: &'static Regex,
    pub mailto_scheme_re: &'static Regex,
    pub any_scheme_re: &'static Regex,
    pub data_image_raster_re: &'static Regex,
    pub js_vbscript_data_re: &'static Regex,
    pub win_drive_re: &'static Regex,
    pub project_prefix_re: &'static Regex,
    pub code_ext_re: &'static Regex,
    pub titled_link_re: &'static Regex,
    pub cjk_boundary_re: &'static Regex,
}

impl SanitizerConfig {
    fn new() -> Self {
        Self {
            html_builder: &AMMONIA_BUILDER,
            smuggle_re: &SMUGGLE_RE,
            has_whitespace_re: &HAS_WHITESPACE_RE,
            http_scheme_re: &HTTP_SCHEME_RE,
            mailto_scheme_re: &MAILTO_SCHEME_RE,
            any_scheme_re: &ANY_SCHEME_RE,
            data_image_raster_re: &DATA_IMAGE_RASTER_RE,
            js_vbscript_data_re: &JS_VBSCRIPT_DATA_RE,
            win_drive_re: &WIN_DRIVE_RE,
            project_prefix_re: &PROJECT_PREFIX_RE,
            code_ext_re: &CODE_EXT_RE,
            titled_link_re: &TITLED_LINK_RE,
            cjk_boundary_re: &CJK_BOUNDARY_RE,
        }
    }

    /// 使用全局预热重用的 `ammonia::Builder` 清洗 HTML 片段（DEF-13）。
    #[inline]
    pub fn clean_html(&self, html: &str) -> String {
        self.html_builder.clean(html).to_string()
    }
}

/// 全局单例预热 Sanitizer 配置（DEF-13）。
pub static SANITIZER_CONFIG: Lazy<SanitizerConfig> = Lazy::new(SanitizerConfig::new);

/// 预热并获取全局共享的 `SanitizerConfig`，确保 HTML 清理器与安全规则单次初始化后永久重用（DEF-13）。
#[inline]
pub fn warmup_sanitizer() -> &'static SanitizerConfig {
    &SANITIZER_CONFIG
}

/// 使用全局预热的 HTML 清理器配置清洗 HTML（避免每次清洗重复构建 `ammonia::Builder`）（DEF-13）。
#[inline]
pub fn sanitize_html(html: &str) -> String {
    SANITIZER_CONFIG.clean_html(html)
}

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
    match SANITIZER_CONFIG.smuggle_re.replace_all(url, "") {
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

/// 剥控制符 / BOM / 零宽 / bidi 覆盖, 防止 smuggle `javascript:` 等危险 scheme。
/// 用于 href/src 安全判定前的归一化(不改变展示用原文 escape 路径)。
pub fn sanitize_url_candidate(url: &str) -> String {
    sanitize_url_candidate_cow(url).into_owned()
}

/// 栈上最多 3 个 URL 安全判定变体（原文 + 至多 2 次 percent-decode），
/// 消除每次调用构造 `HashSet` 与重复克隆 `String` 的开销（DEF-13）。
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

/// 生成 scheme 判定用变体: 原文 + 至多 2 次 decode。
/// 捕获 `javascript%3A` / `java%09script:` 等百分号走私;
/// 写入属性仍用调用方 sanitize 后的原文。
pub fn url_safety_variants(url: &str) -> Vec<String> {
    let variants = SmallUrlVariants::from_url(url);
    let mut out = Vec::with_capacity(variants.len);
    for item in variants.items.into_iter().take(variants.len).flatten() {
        out.push(item.into_owned());
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
    if t.is_ascii() {
        return t.bytes().any(|b| b.is_ascii_whitespace());
    }
    SANITIZER_CONFIG.has_whitespace_re.is_match(t)
}

/// 危险 scheme: javascript: / data:text/html / vbscript: 等不得写入 href/src。
/// 允许: http(s)、mailto、相对/本地路径(无 scheme 或 # 锚点)。
/// 任一 decode 变体含危险 scheme 或内嵌空白 → 拒绝。
pub fn is_safe_href(url: &str) -> bool {
    let cfg = &*SANITIZER_CONFIG;
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
        if cfg.http_scheme_re.is_match(t) || cfg.mailto_scheme_re.is_match(t) {
            return true;
        }
    }
    // 任意变体带其它 scheme(含 javascript: / data: / vbscript: / 百分号解码后)一律拒绝
    for t in variants.iter() {
        if cfg.any_scheme_re.is_match(t) {
            return false;
        }
    }
    true
}

/// 图片 src: http(s) / 相对路径 / 光栅 data:image(png/jpeg/gif/webp/avif/bmp)。
/// 拒绝 data:text/html、data:image/svg+xml(可内嵌脚本)及其它 scheme。
/// 百分号解码变体参与判定, 防止 data%3Aimage/svg+xml 等走私。
pub fn is_safe_img_src(url: &str) -> bool {
    let cfg = &*SANITIZER_CONFIG;
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
        if cfg.http_scheme_re.is_match(t) {
            return true;
        }
        // 仅安全光栅; 分号或逗号起 payload(;base64, / ,raw)
        if cfg.data_image_raster_re.is_match(t) {
            return true;
        }
    }
    for t in variants.iter() {
        if cfg.any_scheme_re.is_match(t) {
            return false;
        }
    }
    true
}

pub fn is_local_path_ref(s: &str) -> bool {
    let cfg = &*SANITIZER_CONFIG;
    let variants = SmallUrlVariants::from_url(s);
    let fallback = sanitize_url_candidate_cow(s);
    let t = variants
        .first_str()
        .filter(|first| !first.is_empty())
        .unwrap_or_else(|| fallback.as_ref());
    if t.is_empty() {
        return false;
    }
    // 任一变体已是 http(s)/mailto 或危险 scheme → 非本地路径
    for v in variants.iter() {
        if cfg.http_scheme_re.is_match(v) || cfg.mailto_scheme_re.is_match(v) {
            return false;
        }
        if cfg.js_vbscript_data_re.is_match(v) {
            return false;
        }
    }
    if cfg.win_drive_re.is_match(t) {
        return true;
    }
    if t.starts_with('/') || t.starts_with("~/") || t.starts_with("./") || t.starts_with("../") {
        return true;
    }
    if cfg.project_prefix_re.is_match(t) {
        return true;
    }
    if cfg.code_ext_re.is_match(t) && !t.contains("://") {
        return true;
    }
    false
}

/// 窄屏 CJK 断行: 在标签外文本插入 `<wbr>`。
/// - CJK ↔ 拉丁/数字/路径字符边界插入 `<wbr>`
/// - 纯 CJK 长文本不再强插 `<wbr>`，交由现代 CSS 引擎接管，杜绝表格单元格列宽畸变。
pub fn wrap_cjk_text_segment(text: &str) -> String {
    if text.is_ascii() {
        return text.to_string();
    }

    let re = SANITIZER_CONFIG.cjk_boundary_re;
    let mut matches = re.find_iter(text);
    let Some(first) = matches.next() else {
        return text.to_string();
    };

    let mut out = String::with_capacity(text.len() + 32);
    let mut last_end = 0usize;

    let mut push_match = |m: regex::Match<'_>| {
        let s = m.as_str();
        let split = if s.as_bytes()[0].is_ascii() {
            1
        } else {
            s.len() - 1
        };
        out.push_str(&text[last_end..m.start() + split]);
        out.push_str("<wbr>");
        out.push_str(&s[split..]);
        last_end = m.end();
    };

    push_match(first);
    for m in matches {
        push_match(m);
    }
    out.push_str(&text[last_end..]);
    out
}

/// 从 markdown 链目标字符串取出 URL(去掉可选 title;支持尖括号)。
pub fn link_destination_url(raw: &str) -> String {
    let mut dest = raw.trim();
    if dest.is_empty() {
        return String::new();
    }
    // <http://...> 或残缺 `<javascript:alert(1`(无闭合 > 时仍剥开头 <,避免当相对路径放行)
    if let Some(after_lt) = dest.strip_prefix('<') {
        if let Some(end) = after_lt.find('>') {
            return after_lt[..end].trim().to_string();
        }
        dest = after_lt.trim();
    }
    // url "title" / url 'title'
    if dest.contains('"') || dest.contains('\'') {
        if let Some(caps) = SANITIZER_CONFIG.titled_link_re.captures(dest) {
            return caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| dest.to_string());
        }
    }
    // 无 title: 整段(可含 alert(1) 的括号)视为 URL,仅在空白处截断首 token
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

    #[test]
    fn sanitizer_config_reuses_global_prewarmed_instance() {
        let cfg1 = warmup_sanitizer();
        let cfg2 = warmup_sanitizer();
        assert!(std::ptr::eq(cfg1, cfg2));
        assert!(std::ptr::eq(cfg1.html_builder, cfg2.html_builder));
        let cleaned = sanitize_html("<img src=\"a.png\" onerror=\"alert(1)\">");
        assert!(cleaned.contains("<img"));
        assert!(!cleaned.contains("onerror"));
    }
}
