//! 代码高亮：syntect + two-face 语法集 + class style + LRU 缓存。
//!
//! - 语法集使用 `two-face` 的 bat 语法包，补齐 syntect 默认包缺失的
//!   TypeScript / TOML / Dockerfile / Kotlin / Swift / Dart 等现代语言。
//! - 输出按行切分：每个元素是一行的高亮 HTML（不含行号，不含外层行 span），
//!   由渲染器负责包裹 `.md-code-line` 与行高亮。
//! - syntect 的 `ClassedHTMLGenerator` 会跨行保持 open span；本模块在换行处
//!   关闭并在下一行重新打开这些 span，保证每一行都是独立、平衡的 HTML。

use moka::sync::Cache;
use once_cell::sync::Lazy;
use std::borrow::{Borrow, Cow};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

use crate::cache::CACHE_ENTRY_MAX_BYTES;
use crate::html::escape_html;

/// 全局 SyntaxSet（two-face bat 语法集，带 newline 模式）。
static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(two_face::syntax::extra_newlines);

/// 高亮缓存复合键（仅在缓存未命中插入时分配 String）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightCacheKey {
    pub lang: String,
    pub code: String,
}

impl Hash for HighlightCacheKey {
    #[inline]
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.lang.as_str().hash(state);
        self.code.as_str().hash(state);
    }
}

/// 支持以 `(&str, &str)` 切片零堆分配查询高亮缓存的借用抽象。
pub trait HighlightKey {
    fn lang(&self) -> &str;
    fn code(&self) -> &str;
}

impl HighlightKey for HighlightCacheKey {
    #[inline]
    fn lang(&self) -> &str {
        &self.lang
    }

    #[inline]
    fn code(&self) -> &str {
        &self.code
    }
}

impl HighlightKey for (String, String) {
    #[inline]
    fn lang(&self) -> &str {
        &self.0
    }

    #[inline]
    fn code(&self) -> &str {
        &self.1
    }
}

impl HighlightKey for (&str, &str) {
    #[inline]
    fn lang(&self) -> &str {
        self.0
    }

    #[inline]
    fn code(&self) -> &str {
        self.1
    }
}

impl<'a> PartialEq for dyn HighlightKey + 'a {
    #[inline]
    fn eq(&self, other: &Self) -> bool {
        self.lang() == other.lang() && self.code() == other.code()
    }
}

impl<'a> Eq for dyn HighlightKey + 'a {}

impl<'a> Hash for dyn HighlightKey + 'a {
    #[inline]
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.lang().hash(state);
        self.code().hash(state);
    }
}

impl<'a> Borrow<dyn HighlightKey + 'a> for HighlightCacheKey {
    #[inline]
    fn borrow(&self) -> &(dyn HighlightKey + 'a) {
        self
    }
}

type HighlightEntry = Arc<Vec<String>>;

/// 全局代码高亮缓存（支持 `(&str, &str)` 零堆分配借用查表）。
static HIGHLIGHT_CACHE: Lazy<Cache<HighlightCacheKey, HighlightEntry>> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(CACHE_ENTRY_MAX_BYTES as u64 * 32)
        .weigher(|k: &HighlightCacheKey, v: &HighlightEntry| -> u32 {
            let line_bytes: usize = v.iter().map(String::len).sum();
            let bytes = (k.lang.len() + k.code.len() + line_bytes + v.len() * 16) * 2;
            bytes.try_into().unwrap_or(u32::MAX)
        })
        .build()
});

#[inline]
fn get_highlight_cached(key: (&str, &str)) -> Option<HighlightEntry> {
    HIGHLIGHT_CACHE.get(&key as &dyn HighlightKey)
}

#[inline]
fn insert_highlight_cached(key: (&str, &str), lines: HighlightEntry) -> bool {
    let line_bytes: usize = lines.iter().map(String::len).sum();
    let bytes = (key.0.len() + key.1.len() + line_bytes + lines.len() * 16) * 2;
    if bytes <= CACHE_ENTRY_MAX_BYTES as usize {
        HIGHLIGHT_CACHE.insert(
            HighlightCacheKey {
                lang: key.0.to_string(),
                code: key.1.to_string(),
            },
            lines,
        );
        true
    } else {
        false
    }
}

/// 语言别名 → 标准 scope 语言名。
fn normalize_lang(raw: &str) -> Cow<'_, str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Cow::Borrowed("");
    }
    let lower: Cow<'_, str> = if trimmed.bytes().any(|b| b.is_ascii_uppercase()) {
        Cow::Owned(trimmed.to_ascii_lowercase())
    } else {
        Cow::Borrowed(trimmed)
    };
    let stripped = lower
        .strip_prefix("language-")
        .or_else(|| lower.strip_prefix('.'))
        .unwrap_or(&lower);
    if stripped.is_empty() {
        return Cow::Borrowed("");
    }
    match stripped {
        "c++" => Cow::Borrowed("cpp"),
        "c#" | "cs" => Cow::Borrowed("csharp"),
        "js" | "jsx" | "mjs" | "cjs" => Cow::Borrowed("javascript"),
        "kt" => Cow::Borrowed("kotlin"),
        "ts" | "tsx" => Cow::Borrowed("typescript"),
        "py" => Cow::Borrowed("python"),
        "rb" => Cow::Borrowed("ruby"),
        "rs" => Cow::Borrowed("rust"),
        "sh" | "shell" | "zsh" => Cow::Borrowed("bash"),
        // PowerShell 是独立语言，绝不映射到 bash。若 two-face fancy 变体
        // 未包含该语法，find_syntax 返回 None，后续会安全降级为纯文本。
        "ps1" | "powershell" | "pwsh" => Cow::Borrowed("powershell"),
        "yml" => Cow::Borrowed("yaml"),
        "md" | "mdx" => Cow::Borrowed("markdown"),
        "docker" => Cow::Borrowed("dockerfile"),
        "proto" => Cow::Borrowed("protobuf"),
        // 已是标准名：若原本即为小写则零拷贝借用，否则保留已转换的小写 String。
        other => match lower {
            Cow::Borrowed(_) => {
                let borrowed = trimmed
                    .strip_prefix("language-")
                    .or_else(|| trimmed.strip_prefix('.'))
                    .unwrap_or(trimmed);
                Cow::Borrowed(borrowed)
            }
            Cow::Owned(_) => Cow::Owned(other.to_string()),
        },
    }
}

/// 在 SyntaxSet 中查找语言。
fn find_syntax(lang: &str) -> Option<&'static syntect::parsing::SyntaxReference> {
    if lang.is_empty() {
        return None;
    }
    let ss = &*SYNTAX_SET;
    ss.find_syntax_by_token(lang)
        .or_else(|| ss.find_syntax_by_extension(lang))
        .or_else(|| ss.find_syntax_by_name(lang))
}

/// 高亮代码并按行返回。
///
/// - 已知语言：每行是 syntect class style 的平衡 HTML；
/// - 未知/无语言/高亮失败：每行是 HTML 转义后的纯文本。
///
/// 空代码返回空 Vec；末尾单个 `\n` 被剥离（代码块外壳自己负责换行）。
pub fn highlight_code_lines(code: &str, lang: Option<&str>) -> Vec<String> {
    let normalized: Cow<'_, str> = if code.contains("\r\n") {
        Cow::Owned(code.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(code)
    };
    let raw = normalized.as_ref();
    let raw = raw.strip_suffix('\n').unwrap_or(raw);
    if raw.is_empty() {
        return Vec::new();
    }

    let lang_norm: Cow<'_, str> = lang.map(normalize_lang).unwrap_or(Cow::Borrowed(""));
    let lookup_key: (&str, &str) = (lang_norm.as_ref(), raw);

    if let Some(cached) = get_highlight_cached(lookup_key) {
        return (*cached).clone();
    }

    let lines = match find_syntax(&lang_norm) {
        Some(syntax) => {
            render_lines_with_syntect(raw, syntax).unwrap_or_else(|_| escape_lines(raw))
        }
        None => escape_lines(raw),
    };

    insert_highlight_cached(lookup_key, Arc::new(lines.clone()));
    lines
}

/// 高亮代码并返回单段 HTML（行之间用 `\n` 连接）。
///
/// 供非 Markdown 代码面与既有测试使用；Markdown 渲染器使用
/// [`highlight_code_lines`] 以便包裹行号/行高亮。
pub fn highlight_code(code: &str, lang: Option<&str>) -> String {
    highlight_code_lines(code, lang).join("\n")
}

fn escape_lines(code: &str) -> Vec<String> {
    code.split('\n').map(escape_html).collect()
}

/// 用 syntect 渲染整段代码，再切分为逐行平衡 HTML。
fn render_lines_with_syntect(
    code: &str,
    syntax: &'static syntect::parsing::SyntaxReference,
) -> Result<Vec<String>, String> {
    let ss = &*SYNTAX_SET;
    let mut generator = ClassedHTMLGenerator::new_with_class_style(syntax, ss, ClassStyle::Spaced);
    for line in LinesWithEndings::from(code) {
        generator
            .parse_html_for_line_which_includes_newline(line)
            .map_err(|e| e.to_string())?;
    }
    Ok(split_highlighted_html_lines(&generator.finalize()))
}

/// 把 `ClassedHTMLGenerator` 的整段 HTML 在换行处切成平衡的逐行 HTML。
///
/// 生成器的 `<span>` 可以跨行；这里在换行处关闭当前打开的 span，并在下一行
/// 重新打开同一组 span，使每一行都能独立放进 `.md-code-line`。
fn split_highlighted_html_lines(html: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut open_spans: Vec<String> = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0usize;

    while i < bytes.len() {
        match bytes[i] {
            b'<' => {
                if let Some(rel_end) = html[i..].find('>') {
                    let end = i + rel_end + 1;
                    let tag = &html[i..end];
                    if tag.starts_with("</span") {
                        open_spans.pop();
                    } else if tag.starts_with("<span") {
                        open_spans.push(tag.to_string());
                    }
                    current.push_str(tag);
                    i = end;
                } else {
                    current.push('<');
                    i += 1;
                }
            }
            b'\n' => {
                for _ in 0..open_spans.len() {
                    current.push_str("</span>");
                }
                lines.push(std::mem::take(&mut current));
                for tag in &open_spans {
                    current.push_str(tag);
                }
                i += 1;
            }
            _ => {
                let ch_len = html[i..]
                    .chars()
                    .next()
                    .map(char::len_utf8)
                    .unwrap_or(1);
                current.push_str(&html[i..i + ch_len]);
                i += ch_len;
            }
        }
    }

    if !current.is_empty() || lines.is_empty() {
        lines.push(current);
    }
    lines
}

/// 清空高亮与渲染缓存（测试隔离和设置变更时使用）。
pub fn clear_cache() {
    HIGHLIGHT_CACHE.invalidate_all();
    crate::cache::clear_render_caches();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lang_aliases() {
        assert_eq!(normalize_lang("ts"), "typescript");
        assert_eq!(normalize_lang("py"), "python");
        assert_eq!(normalize_lang("c++"), "cpp");
        assert_eq!(normalize_lang("Language-TS"), "typescript");
        assert_eq!(normalize_lang(".ts"), "typescript");
        assert_eq!(normalize_lang("ps1"), "powershell");
        assert_eq!(normalize_lang("powershell"), "powershell");
        assert_eq!(normalize_lang(""), "");
    }

    #[test]
    fn highlight_typescript_returns_classed_spans() {
        let html = highlight_code("const x: number = 1;", Some("ts"));
        assert!(html.contains("<span class=\""), "expected classed spans: {html}");
        assert!(html.contains("const"));
    }

    #[test]
    fn highlight_unknown_language_returns_escaped_text() {
        let html = highlight_code("plain <text>", Some("nonsense_xyz"));
        assert!(html.contains("&lt;text&gt;"));
    }

    #[test]
    fn highlight_no_language_returns_escaped_text() {
        let html = highlight_code("a < b & c", None);
        assert!(html.contains("&lt;"));
        assert!(html.contains("&amp;"));
    }

    #[test]
    fn highlight_lines_are_balanced_and_reopen_cross_line_spans() {
        let lines = highlight_code_lines("let a = 1;\nlet b = 2;", Some("rs"));
        assert_eq!(lines.len(), 2);
        for line in &lines {
            let opens = line.matches("<span").count();
            let closes = line.matches("</span>").count();
            assert_eq!(opens, closes, "line must be balanced: {line}");
        }
    }

    #[test]
    fn empty_code_returns_no_lines() {
        assert!(highlight_code_lines("", Some("rs")).is_empty());
        assert!(highlight_code_lines("\n", Some("rs")).is_empty());
    }

    #[test]
    fn highlight_caches_repeated_calls() {
        let a = highlight_code("const x = 1;", Some("ts"));
        let b = highlight_code("const x = 1;", Some("ts"));
        assert_eq!(a, b);
    }

    #[test]
    fn splitter_keeps_one_line_for_single_line_html() {
        let lines = split_highlighted_html_lines("<span class=\"keyword\">let</span> x");
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("let"));
    }
}
