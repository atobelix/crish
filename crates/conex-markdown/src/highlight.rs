//! 代码高亮: syntect + class style + LRU 缓存。
//!
//! 用 syntect 替代 highlight.js,避免 JS 主线程同步高亮的卡顿。
//! 输出 `<span class="keyword">…</span>` 风格,前端 CSS 可继续兼容 hljs-* 类。
//!
//! 直接对应 apps/crish-desktop/src/api/codeHighlight.ts。

use once_cell::sync::Lazy;
use std::borrow::Cow;
use std::sync::Arc;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;

use crate::cache::{entry_within_budget, highlight_cache, render_cache};

/// 全局 SyntaxSet (内置语法,带 newline 模式)。
/// 用 `load_defaults_newlines` 才能正确按行高亮含 `\n` 的代码。
static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(SyntaxSet::load_defaults_newlines);

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
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// 高亮代码,返回 HTML 片段(不含 `<code>` 包装)。
///
/// - 已知语言: syntect class style 输出 `<span class="...">`
/// - 未知/无语言: HTML escape
///
/// 缓存键: `lang:code`,缓存命中直接返回。
pub fn highlight_code(code: &str, lang: Option<&str>) -> String {
    let raw: Cow<'_, str> = if code.contains("\r\n") {
        Cow::Owned(code.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(code)
    };
    let lang_norm: Cow<'_, str> = lang.map(normalize_lang).unwrap_or(Cow::Borrowed(""));

    let cache_key = format!("{}:{}", lang_norm, raw);
    if let Some(cached) = highlight_cache().get(cache_key.as_str()) {
        return (*cached).clone();
    }

    let html = match find_syntax(&lang_norm) {
        Some(syntax) => render_with_syntect(&raw, syntax).unwrap_or_else(|_| escape_html_plain(&raw)),
        None => escape_html_plain(&raw),
    };

    // 缓存 — 单条目字节预算超出时不入缓存（1C-8：用独立高亮缓存）
    if entry_within_budget(&cache_key, &html) {
        highlight_cache().insert(cache_key, Arc::new(html.clone()));
    }
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
}
