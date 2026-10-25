//! 代码高亮: syntect + class style + LRU 缓存。
//!
//! 用 syntect 替代 highlight.js,避免 JS 主线程同步高亮的卡顿。
//! 输出 `<span class="keyword">…</span>` 风格,前端 CSS 可继续兼容 hljs-* 类。
//!
//! 直接对应 apps/crish-desktop/src/api/codeHighlight.ts。

use moka::sync::Cache;
use once_cell::sync::Lazy;
use std::borrow::{Borrow, Cow};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;

use crate::cache::{highlight_cache, render_cache, CACHE_BUDGET_BYTES, CACHE_ENTRY_MAX_BYTES};

/// 全局 SyntaxSet (内置语法,带 newline 模式)。
/// 用 `load_defaults_newlines` 才能正确按行高亮含 `\n` 的代码。
static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(SyntaxSet::load_defaults_newlines);

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

/// 支持以 `(&str, &str)` 切片零堆分配查询 `HIGHLIGHT_CACHE` 的借用抽象（DEF-03）。
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

/// 全局语法高亮缓存（支持 `(&str, &str)` 零堆分配借用查表）。
static HIGHLIGHT_CACHE: Lazy<Cache<HighlightCacheKey, Arc<String>>> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(CACHE_BUDGET_BYTES as u64)
        .weigher(|k: &HighlightCacheKey, v: &Arc<String>| -> u32 {
            let bytes = (k.lang.len() + k.code.len() + v.len()) * 2;
            bytes.try_into().unwrap_or(u32::MAX)
        })
        .build()
});

/// 使用 `(&str, &str)` 切片对 `HIGHLIGHT_CACHE` 执行零堆分配查询（DEF-03）。
#[inline]
pub fn get_highlight_cached(key: (&str, &str)) -> Option<Arc<String>> {
    HIGHLIGHT_CACHE.get(&key as &dyn HighlightKey)
}

/// 仅在缓存未命中且满足单条目字节预算时，克隆 `String` 插入 `HIGHLIGHT_CACHE`（DEF-03）。
#[inline]
pub fn insert_highlight_cached(key: (&str, &str), html: Arc<String>) -> bool {
    let bytes = (key.0.len() + key.1.len() + html.len()) * 2;
    if bytes <= CACHE_ENTRY_MAX_BYTES as usize {
        HIGHLIGHT_CACHE.insert(
            HighlightCacheKey {
                lang: key.0.to_string(),
                code: key.1.to_string(),
            },
            html,
        );
        true
    } else {
        false
    }
}

/// 语言别名 → 标准 scope 语言名。
/// 与 markdownPlugins.ts::langFromFenceInfo 一致。
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
        "sh" | "shell" | "zsh" | "ps1" | "powershell" => Cow::Borrowed("bash"),
        "yml" => Cow::Borrowed("yaml"),
        "md" | "mdx" => Cow::Borrowed("markdown"),
        // 已是标准名: 若原本即为小写则零拷贝借用，否则保留已转换的小写 String
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

/// 在 SyntaxSet 中查找语言。先按 extension,再按 name。
fn find_syntax(lang: &str) -> Option<&'static syntect::parsing::SyntaxReference> {
    if lang.is_empty() {
        return None;
    }
    let ss = &*SYNTAX_SET;
    // find_syntax_by_token 检查 name + extensions + scope
    ss.find_syntax_by_token(lang)
        .or_else(|| ss.find_syntax_by_extension(lang))
        .or_else(|| ss.find_syntax_by_name(lang))
}

/// HTML 转义(用于无语言或高亮失败时的 plain text 渲染)。
pub fn escape_html_plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last = 0;
    for (i, b) in s.bytes().enumerate() {
        let rep = match b {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            b'\'' => "&#39;",
            _ => continue,
        };
        out.push_str(&s[last..i]);
        out.push_str(rep);
        last = i + 1;
    }
    out.push_str(&s[last..]);
    out
}

/// 高亮代码,返回 HTML 片段(不含 `<code>` 包装)。
///
/// - 已知语言: syntect class style 输出 `<span class="...">`
/// - 未知/无语言: HTML escape
///
/// 缓存键: `(lang, code)` 借用切片零拷贝查询，仅未命中插入时分配 String。
pub fn highlight_code(code: &str, lang: Option<&str>) -> String {
    let raw: Cow<'_, str> = if code.contains("\r\n") {
        Cow::Owned(code.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(code)
    };
    let lang_norm: Cow<'_, str> = lang.map(normalize_lang).unwrap_or(Cow::Borrowed(""));
    let lookup_key: (&str, &str) = (lang_norm.as_ref(), raw.as_ref());

    if let Some(cached) = get_highlight_cached(lookup_key) {
        return (*cached).clone();
    }

    let html = match find_syntax(&lang_norm) {
        Some(syntax) => {
            render_with_syntect(&raw, syntax).unwrap_or_else(|_| escape_html_plain(&raw))
        }
        None => escape_html_plain(&raw),
    };

    // 缓存 — 单条目字节预算超出时不入缓存（DEF-03：仅未命中插入时分配 String 键）
    insert_highlight_cached(lookup_key, Arc::new(html.clone()));
    html
}

/// 用 syntect 渲染高亮 HTML (class style)。
fn render_with_syntect(
    code: &str,
    syntax: &'static syntect::parsing::SyntaxReference,
) -> Result<String, String> {
    let ss = &*SYNTAX_SET;
    let mut generator = ClassedHTMLGenerator::new_with_class_style(syntax, ss, ClassStyle::Spaced);
    for line in syntect::util::LinesWithEndings::from(code) {
        generator
            .parse_html_for_line_which_includes_newline(line)
            .map_err(|e| e.to_string())?;
    }
    Ok(generator.finalize())
}

/// 清空缓存（1C-8：分离后高亮与渲染缓存独立，测试隔离需同时清两者；
/// 高亮缓存是主要消费者，渲染缓存一并清空以保持原 clear_cache 的
/// 「全量重置」语义，避免测试间残留命中）。
pub fn clear_cache() {
    HIGHLIGHT_CACHE.invalidate_all();
    highlight_cache().invalidate_all();
    render_cache().invalidate_all();
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
        assert_eq!(normalize_lang(""), "");
    }

    #[test]
    fn highlight_known_language_returns_spans() {
        let html = highlight_code("const x = 1;", Some("ts"));
        // syntect class style 输出 <span class="..."> 或转义文本
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
    fn highlight_caches_repeated_calls() {
        let a = highlight_code("const x = 1;", Some("ts"));
        let b = highlight_code("const x = 1;", Some("ts"));
        assert_eq!(a, b);
    }

    #[test]
    fn highlight_cache_supports_borrowed_tuple_lookup() {
        let key: (&str, &str) = ("rust", "let borrowed_tuple_lookup_test = 42;");
        assert!(get_highlight_cached(key).is_none());
        assert!(insert_highlight_cached(
            key,
            Arc::new("<span>let</span>".to_string())
        ));
        let got = get_highlight_cached(("rust", "let borrowed_tuple_lookup_test = 42;"));
        assert_eq!(got.as_deref().map(|s| s.as_str()), Some("<span>let</span>"));
    }
}
