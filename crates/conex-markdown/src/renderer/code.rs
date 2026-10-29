//! 代码围栏：语言/文件/行高亮解析、逐行 HTML、复制/折行/折叠动作外壳。

use once_cell::sync::Lazy;
use pulldown_cmark::CodeBlockKind;
use regex::Regex;

use super::*;
use crate::highlight::highlight_code_lines;
use crate::html::{escape_html, escape_html_attr};

static FENCE_FILE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\bfile=(?:"([^"]*)"|(\S+))"#).expect("valid file regex"));

#[derive(Debug, Default)]
struct FenceInfo {
    lang: String,
    file_path: Option<String>,
    highlight_lines: Vec<(usize, usize)>,
}

impl Renderer {
    pub(super) fn start_code_block(&mut self, kind: CodeBlockKind<'_>) {
        let info = match kind {
            CodeBlockKind::Fenced(info) => parse_fence_info(info.as_ref()),
            CodeBlockKind::Indented => FenceInfo::default(),
        };
        self.fence = Some(FenceState {
            lang: info.lang,
            file_path: info.file_path,
            highlight_lines: info.highlight_lines,
            buffer: String::new(),
        });
    }

    pub(super) fn end_code_block(&mut self) {
        self.flush_fence();
    }

    /// 单一派发点：正常闭合与 EOF 软闭合共用。
    pub(super) fn flush_fence(&mut self) {
        if let Some(fence) = self.fence.take() {
            let html = build_code_block_html(&fence, self.stream_mode);
            self.push_str(&html);
        }
    }
}

fn parse_fence_info(info: &str) -> FenceInfo {
    FenceInfo {
        lang: extract_lang(info),
        file_path: FENCE_FILE_RE
            .captures(info)
            .and_then(|caps| caps.get(1).or_else(|| caps.get(2)))
            .map(|m| m.as_str().to_string()),
        highlight_lines: parse_line_ranges(info),
    }
}

fn extract_lang(info: &str) -> String {
    for token in info.split_whitespace() {
        if token.contains('=') {
            continue;
        }
        if token.starts_with('{') && token.ends_with('}') {
            let inner = &token[1..token.len() - 1];
            for part in inner.split_whitespace() {
                if let Some(lang) = part.strip_prefix('.') {
                    if !lang.is_empty() && !is_line_spec(lang) {
                        return lang.to_string();
                    }
                }
            }
            continue;
        }
        if is_line_spec(token) {
            continue;
        }
        let stripped = token
            .strip_prefix("language-")
            .or_else(|| token.strip_prefix('.'))
            .unwrap_or(token);
        if !stripped.is_empty() {
            return stripped.to_string();
        }
    }
    String::new()
}

fn is_line_spec(token: &str) -> bool {
    !token.is_empty()
        && token
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c == '-')
}

fn parse_line_ranges(info: &str) -> Vec<(usize, usize)> {
    for token in info.split_whitespace() {
        let Some(inner) = token.strip_prefix('{').and_then(|t| t.strip_suffix('}')) else {
            continue;
        };
        if !inner
            .chars()
            .all(|c| c.is_ascii_digit() || c == ',' || c == '-' || c.is_whitespace())
        {
            continue;
        }
        let mut ranges = Vec::new();
        for part in inner.split([',', ' ']).filter(|part| !part.is_empty()) {
            if let Some((start, end)) = part.split_once('-') {
                if let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) {
                    if start > 0 && end >= start {
                        ranges.push((start, end));
                    }
                }
            } else if let Ok(line) = part.parse::<usize>() {
                if line > 0 {
                    ranges.push((line, line));
                }
            }
        }
        if !ranges.is_empty() {
            return ranges;
        }
    }
    Vec::new()
}

fn build_code_block_html(fence: &FenceState, stream_mode: bool) -> String {
    let body = fence
        .buffer
        .strip_suffix('\n')
        .unwrap_or(fence.buffer.as_str());
    let lines = if stream_mode {
        escape_lines(body)
    } else {
        highlight_code_lines(
            body,
            if fence.lang.is_empty() {
                None
            } else {
                Some(fence.lang.as_str())
            },
        )
    };

    let is_mermaid = fence.lang.eq_ignore_ascii_case("mermaid");
    let collapsible = lines.len() > 30;
    let lang = fence.lang.as_str();

    let mut out = String::with_capacity(body.len() * 2 + 512);
    out.push_str("<div class=\"md-code-block\"");
    if !lang.is_empty() {
        out.push_str(" data-lang=\"");
        out.push_str(&escape_html_attr(lang));
        out.push('"');
    }
    if is_mermaid {
        out.push_str(" data-md-island=\"mermaid\"");
    }
    if collapsible {
        out.push_str(" data-collapsible=\"true\"");
    }
    out.push('>');

    out.push_str("<div class=\"md-code-header\"><div class=\"md-code-header-left\">");
    if let Some(file_path) = fence.file_path.as_deref() {
        push_breadcrumb(&mut out, file_path);
    } else if !lang.is_empty() {
        push_lang_label(&mut out, lang);
    }
    out.push_str("</div><div class=\"md-code-actions\">");
    if fence.file_path.is_some() && !lang.is_empty() {
        push_lang_label(&mut out, lang);
    }

    push_action_button(
        &mut out,
        "md-code-copy",
        "copy",
        "markdown.code.copy",
        ICON_COPY,
        "",
    );
    push_action_button(
        &mut out,
        "md-code-wrap",
        "toggle-wrap",
        "markdown.code.wrap",
        ICON_WRAP,
        " aria-pressed=\"false\"",
    );
    if collapsible {
        push_action_button(
            &mut out,
            "md-code-fold",
            "toggle-fold",
            "markdown.code.fold",
            ICON_FOLD,
            " aria-expanded=\"true\"",
        );
    }
    out.push_str("</div></div>");

    out.push_str("<pre class=\"md-code-pre\"><code");
    if !lang.is_empty() {
        out.push_str(" class=\"language-");
        out.push_str(&escape_html_attr(lang));
        out.push('"');
    }
    out.push('>');

    for (index, line) in lines.iter().enumerate() {
        let line_number = index + 1;
        let highlighted = fence
            .highlight_lines
            .iter()
            .any(|(start, end)| line_number >= *start && line_number <= *end);
        out.push_str("<span class=\"md-code-line");
        if highlighted {
            out.push_str(" md-code-line-highlight");
        }
        out.push_str("\" data-line=\"");
        out.push_str(&line_number.to_string());
        out.push_str("\">");
        out.push_str(line);
        out.push_str("</span>");
    }

    out.push_str("</code></pre>");
    if is_mermaid {
        out.push_str(
            "<div class=\"md-island-slot\" data-island-slot=\"mermaid\"></div>",
        );
    }
    out.push_str("</div>");
    out
}

fn escape_lines(body: &str) -> Vec<String> {
    if body.is_empty() {
        return Vec::new();
    }
    body.split('\n').map(escape_html).collect()
}

fn push_lang_label(out: &mut String, lang: &str) {
    let escaped = escape_html(lang);
    out.push_str("<span class=\"md-code-lang\" data-lang=\"");
    out.push_str(&escape_html_attr(lang));
    out.push_str("\">");
    out.push_str(&escaped);
    out.push_str("</span>");
}

fn push_breadcrumb(out: &mut String, path: &str) {
    out.push_str("<span class=\"md-code-breadcrumb\">");
    let segments: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect();
    for (index, segment) in segments.iter().enumerate() {
        if index > 0 {
            out.push_str("<span class=\"md-code-breadcrumb-separator\">/</span>");
        }
        let is_last = index + 1 == segments.len();
        let class = if is_last {
            "md-code-breadcrumb-file"
        } else {
            "md-code-breadcrumb-segment"
        };
        out.push_str("<span class=\"");
        out.push_str(class);
        out.push_str("\">");
        out.push_str(&escape_html(segment));
        out.push_str("</span>");
    }
    out.push_str("</span>");
}

fn push_action_button(
    out: &mut String,
    class: &str,
    action: &str,
    tooltip_key: &str,
    icon: &str,
    extra_attrs: &str,
) {
    out.push_str("<button type=\"button\" class=\"");
    out.push_str(class);
    out.push_str("\" data-action=\"");
    out.push_str(action);
    out.push_str("\" data-tooltip-key=\"");
    out.push_str(tooltip_key);
    out.push('"');
    out.push_str(extra_attrs);
    out.push('>');
    out.push_str(icon);
    out.push_str("</button>");
}

const ICON_COPY: &str = r#"<svg class="md-code-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4" d="M5.5 5.5V3.6c0-.6.4-1 1-1h6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H10.5M3.5 5.5h6c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1h-6c-.6 0-1-.4-1-1v-6c0-.6.4-1 1-1Z"/></svg>"#;

const ICON_WRAP: &str = r#"<svg class="md-code-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4" d="M3 4h10M3 8h7a2 2 0 1 1 0 4H8m0 0 1.5-1.5M8 12l1.5 1.5M3 12h2"/></svg>"#;

const ICON_FOLD: &str = r#"<svg class="md-code-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4" d="m4 6 4 4 4-4"/></svg>"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn render(text: &str) -> String {
        render_markdown(text, RenderOptions::chat()).html
    }

    #[test]
    fn code_block_has_line_spans_and_no_hardcoded_copy_text() {
        let html = render("```ts\nconst x = 1;\nconst y = 2;\n```");
        assert!(html.contains("md-code-block"));
        assert!(html.contains("md-code-line"));
        assert!(html.contains("data-line=\"1\""));
        assert!(html.contains("data-line=\"2\""));
        assert!(html.contains("data-tooltip-key=\"markdown.code.copy\""));
        assert!(!html.contains(">Copy<"));
    }

    #[test]
    fn fence_info_parses_file_and_highlight_ranges() {
        let html = render("```ts file=\"src/index.ts\" {1,3-5}\nconst a = 1;\nconst b = 2;\n```");
        assert!(html.contains(">src<"));
        assert!(html.contains("index.ts"));
        assert!(html.contains("md-code-line-highlight"));
    }

    #[test]
    fn mermaid_gets_island_marker_and_slot() {
        let html = render("```mermaid\ngraph TD\nA-->B\n```");
        assert!(html.contains("data-md-island=\"mermaid\""));
        assert!(html.contains("data-island-slot=\"mermaid\""));
    }

    #[test]
    fn long_code_is_collapsible() {
        let mut md = String::from("```ts\n");
        for i in 0..31 {
            md.push_str(&format!("const x{i} = {i};\n"));
        }
        md.push_str("```");
        let html = render(&md);
        assert!(html.contains("data-collapsible=\"true\""));
        assert!(html.contains("data-action=\"toggle-fold\""));
    }

    #[test]
    fn stream_mode_does_not_emit_syntax_classes() {
        let html = render_markdown_stream("```ts\nconst x = 1;\n```", RenderOptions::chat()).html;
        assert!(html.contains("md-code-line"));
        assert!(!html.contains("<span class=\"source"));
        assert!(!html.contains("<span class=\"keyword"));
    }
}
