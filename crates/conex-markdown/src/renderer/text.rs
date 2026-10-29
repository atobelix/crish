//! 文本、行内代码、软/硬换行、raw HTML 与裸路径自动链接。

use once_cell::sync::Lazy;
use regex::Regex;

use super::*;
use crate::html::escape_html;
use crate::raw_html;

/// 裸路径自动链接 regex。
///
/// 匹配：
/// - 盘符路径 `C:\foo\bar.ts` / `C:/foo/bar.ts`
/// - 绝对路径 `/foo/bar.ts`
/// - Home 路径 `~/foo/bar.ts`
/// - 相对路径 `./foo/bar.ts` / `../foo/bar.ts`
/// - 项目路径 `apps/foo/bar.ts` / `packages/foo/bar.ts` / `src/foo/bar.ts`
/// - 路径体 2–160 字符，不含空白与 `` `"'<>| ``
/// - 扩展名 `.[A-Za-z0-9]{1,12}`
static BARE_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?:[A-Za-z]:[\\/]|/|~/|\.\.?/|apps/|packages/|src/)[^\s`"'<>|]{2,160}\.[A-Za-z0-9]{1,12}"#,
    )
    .expect("valid bare path regex")
});

enum PathSegment<'a> {
    Text(&'a str),
    Path(&'a str),
}

impl Renderer {
    pub(super) fn handle_text(&mut self, text: &str) {
        if let Some(fence) = &mut self.fence {
            fence.buffer.push_str(text);
            return;
        }
        if let Some(image) = self.image_stack.last_mut() {
            image.alt.push_str(text);
            return;
        }

        self.push_plain(text);
        let translated = translate_gfm_emoji(text);
        let translated = translated.as_ref();
        // 链接标签内不得再生成路径按钮（避免 button 嵌套 / 双跳转入口）。
        if matches!(
            self.link_stack.last(),
            Some(LinkKind::Anchor | LinkKind::PathLink | LinkKind::Unsafe)
        ) {
            self.push_escaped(translated);
            return;
        }
        for_each_bare_path_segment(translated, |segment| match segment {
            PathSegment::Text(segment) => self.push_escaped(segment),
            PathSegment::Path(path) => self.push_path_button(path),
        });
    }

    pub(super) fn handle_inline_code(&mut self, code: &str) {
        if let Some(image) = self.image_stack.last_mut() {
            image.alt.push_str(code);
            return;
        }
        self.push_str("<code class=\"md-inline-code\">");
        self.push_escaped(code);
        self.push_str("</code>");
        self.push_plain(code);
    }

    pub(super) fn handle_raw_html(&mut self, html: &str, block: bool) {
        // 图片 alt 只收纯文本；raw HTML 不进入 alt。
        if !self.image_stack.is_empty() {
            return;
        }
        let depth = raw_html::html_tag_delta(html);
        if depth > 0 {
            self.raw_html = Some(RawHtmlCapture {
                buffer: html.to_string(),
                depth,
                block,
            });
            return;
        }
        let sanitized = raw_html::sanitize_fragment(html);
        if !sanitized.is_empty() {
            self.push_str(&sanitized);
        }
    }

    /// raw HTML 捕获期间的事件处理：文本转义后并入片段，标签保持原样，
    /// 闭合后统一交给 ammonia，避免逐事件清洗把文本挤到标签外。
    pub(super) fn capture_raw_html_event(&mut self, event: &Event<'_>) -> bool {
        let Some(capture) = self.raw_html.as_ref() else {
            return false;
        };
        let inline_capture = !capture.block;

        match event {
            Event::Html(html) | Event::InlineHtml(html) => {
                self.append_raw_html(html);
            }
            Event::Text(text) => {
                self.append_raw_text(&escape_html(text));
            }
            Event::Code(code) => {
                let escaped = escape_html(code);
                self.append_raw_text(&format!("<code>{escaped}</code>"));
            }
            Event::SoftBreak | Event::HardBreak => self.append_raw_text("\n"),
            Event::InlineMath(tex) => {
                let escaped = escape_html(tex);
                self.append_raw_text(&format!("${escaped}$"));
            }
            Event::DisplayMath(tex) => {
                let escaped = escape_html(tex);
                self.append_raw_text(&format!("$${escaped}$$"));
            }
            Event::FootnoteReference(name) => {
                let escaped = escape_html(name);
                self.append_raw_text(&format!("[^{escaped}]"));
            }
            Event::Start(Tag::Emphasis) => self.append_raw_text("<em>"),
            Event::End(TagEnd::Emphasis) => self.append_raw_text("</em>"),
            Event::Start(Tag::Strong) => self.append_raw_text("<strong>"),
            Event::End(TagEnd::Strong) => self.append_raw_text("</strong>"),
            Event::Start(Tag::Strikethrough) => self.append_raw_text("<del>"),
            Event::End(TagEnd::Strikethrough) => self.append_raw_text("</del>"),
            Event::End(end)
                if inline_capture
                    && matches!(
                        end,
                        TagEnd::Paragraph
                            | TagEnd::Heading(_)
                            | TagEnd::TableCell
                            | TagEnd::Item
                            | TagEnd::BlockQuote(_)
                    ) =>
            {
                self.finish_raw_html_capture();
            }
            _ => {}
        }
        true
    }

    fn append_raw_html(&mut self, html: &str) {
        let depth_delta = raw_html::html_tag_delta(html);
        let should_finish = match self.raw_html.as_mut() {
            Some(capture) => {
                capture.buffer.push_str(html);
                capture.depth += depth_delta;
                capture.depth <= 0
            }
            None => false,
        };
        if should_finish {
            self.finish_raw_html_capture();
        }
    }

    fn append_raw_text(&mut self, text: &str) {
        if let Some(capture) = self.raw_html.as_mut() {
            capture.buffer.push_str(text);
        }
    }

    pub(super) fn finish_raw_html_capture(&mut self) {
        let Some(capture) = self.raw_html.take() else {
            return;
        };
        if capture.buffer.is_empty() {
            return;
        }
        let sanitized = raw_html::sanitize_fragment(&capture.buffer);
        if !sanitized.is_empty() {
            self.push_str(&sanitized);
        }
    }

    pub(super) fn handle_soft_break(&mut self) {
        if let Some(fence) = &mut self.fence {
            fence.buffer.push('\n');
            return;
        }
        if let Some(image) = self.image_stack.last_mut() {
            image.alt.push(' ');
            return;
        }
        if self.options.variant.soft_break_as_br() {
            self.push_str("<br>");
        } else {
            self.push_str(" ");
        }
    }

    pub(super) fn handle_hard_break(&mut self) {
        if let Some(fence) = &mut self.fence {
            fence.buffer.push('\n');
            return;
        }
        if let Some(image) = self.image_stack.last_mut() {
            image.alt.push(' ');
            return;
        }
        self.push_str("<br>");
    }
}

/// 扫描裸路径并把文本/路径分段交给调用方。
///
/// 不使用 lookbehind（regex crate 不支持），改为检查匹配前一个字符，
/// 避免在 HTML 属性/代码片段内部误识别路径。
fn for_each_bare_path_segment<'a, F>(text: &'a str, mut emit: F)
where
    F: FnMut(PathSegment<'a>),
{
    if !text.contains('.') || (!text.contains('/') && !text.contains('\\') && !text.contains('~')) {
        emit(PathSegment::Text(text));
        return;
    }

    let mut last_end = 0usize;
    let mut found = false;

    for matched in BARE_PATH_RE.find_iter(text) {
        let start = matched.start();
        let end = matched.end();
        let prev = text[..start].chars().last();
        if matches!(prev, Some('"') | Some('`') | Some('>')) {
            continue;
        }
        if start > last_end {
            emit(PathSegment::Text(&text[last_end..start]));
        }
        emit(PathSegment::Path(matched.as_str()));
        last_end = end;
        found = true;
    }

    if !found {
        emit(PathSegment::Text(text));
        return;
    }
    if last_end < text.len() {
        emit(PathSegment::Text(&text[last_end..]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(text: &str) -> String {
        render_markdown(text, RenderOptions::chat()).html
    }

    #[test]
    fn bare_paths_become_path_links() {
        let html = render("打开 apps/crish-desktop/src/main.ts 查看");
        assert!(html.contains("md-path-link"));
        assert!(html.contains("data-path=\"apps/crish-desktop/src/main.ts\""));
    }

    #[test]
    fn paths_inside_inline_code_are_not_linked() {
        let html = render("`apps/crish-desktop/src/main.ts`");
        assert!(html.contains("md-inline-code"));
        assert!(!html.contains("md-path-link"));
    }

    #[test]
    fn soft_break_is_variant_dependent() {
        let chat = render_markdown("a\nb", RenderOptions::chat()).html;
        let doc = render_markdown("a\nb", RenderOptions::document()).html;
        assert!(chat.contains("<br>"));
        assert!(!doc.contains("<br>"));
    }
}
