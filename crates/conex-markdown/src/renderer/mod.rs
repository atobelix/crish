//! pulldown-cmark 事件流 → 语义 HTML 渲染器。
//!
//! # 设计
//!
//! - 面 A 的唯一渲染器：聊天消息、文档预览、技能详情都走这里。
//! - 开启 GFM 表格/任务列表/删除线、脚注、数学、GFM Alerts（Callout）、
//!   标题属性；智能标点保持关闭。
//! - raw HTML 在事件边界逐片段交给 `raw_html` 白名单清洗；渲染器自己生成的
//!   可信 HTML 不经过 ammonia。
//! - 标题与脚注定义使用 capture 栈收集内容，再在结束事件统一输出/归档。
//! - 软换行按 variant 决定：chat → `<br>`，document → 空格。
//! - 代码块按行输出 `.md-code-line`，行号由 CSS counter 生成，复制不污染。

mod blocks;
mod code;
mod emoji;
mod footnotes;
mod links;
mod math;
mod table;
mod text;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use pulldown_cmark::{BlockQuoteKind, Event, Options, Parser, Tag, TagEnd};

use crate::cache::{get_render_cached, insert_render_cached};
use crate::table::Align;
use crate::types::{RenderOptions, RenderResult};
use crate::MAX_MARKDOWN_INPUT;

pub use emoji::{
    lookup_gfm_emoji, translate_gfm_emoji, translate_gfm_emoji_cow, translate_gfm_emoji_with,
    translate_gfm_emoji_with_cow, GFM_EMOJI_SHORTCODES_DEFAULT,
};

/// 列表种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ListKind {
    Unordered,
    Ordered,
}

/// 列表层状态。
pub(super) struct ListState {
    pub(super) kind: ListKind,
    /// 当前 li 内已输出的直接段落数：0=首段，≥1=续段。
    pub(super) item_paragraph_count: usize,
    /// 当前 li 是否处于打开状态。
    pub(super) item_open: bool,
}

/// 表格状态。
pub(super) struct TableState {
    pub(super) alignments: Vec<Align>,
    pub(super) col_count: usize,
    pub(super) in_thead: bool,
    pub(super) cell_index: usize,
    pub(super) has_body: bool,
}

/// fence 代码块状态。
pub(super) struct FenceState {
    pub(super) lang: String,
    pub(super) file_path: Option<String>,
    pub(super) highlight_lines: Vec<(usize, usize)>,
    pub(super) buffer: String,
}

/// 标题捕获（收集完标题内容后再生成 id 与标签）。
pub(super) struct HeadingCapture {
    pub(super) level: u8,
    pub(super) explicit_id: Option<String>,
    pub(super) html: String,
    pub(super) plain: String,
}

/// 脚注定义捕获。
pub(super) struct FootnoteCapture {
    pub(super) name: String,
    pub(super) html: String,
}

/// capture 栈：标题/脚注定义的内容先收集，结束事件时再合并到父缓冲区。
pub(super) enum Capture {
    Heading(HeadingCapture),
    Footnote(FootnoteCapture),
}

/// 脚注存储。
#[derive(Default)]
pub(super) struct FootnoteStore {
    /// 首次引用或定义时分配的编号顺序。
    pub(super) order: Vec<String>,
    pub(super) numbers: HashMap<String, usize>,
    pub(super) definitions: HashMap<String, String>,
    pub(super) reference_counts: HashMap<String, usize>,
}

/// 链接种类（用于结束事件决定闭标签）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LinkKind {
    Anchor,
    PathLink,
    Unsafe,
    /// 图片 alt 内的链接：只收集文本，不输出标签。
    Suppressed,
}

/// 图片状态（栈以容忍畸形嵌套）。
pub(super) struct ImageState {
    pub(super) safe_url: Option<String>,
    pub(super) title: String,
    pub(super) alt: String,
}

/// raw HTML 跨事件捕获（开标签 / 文本 / 闭标签可能分属多个事件）。
pub(super) struct RawHtmlCapture {
    pub(super) buffer: String,
    pub(super) depth: i32,
    pub(super) block: bool,
}

/// 渲染器。
pub(super) struct Renderer {
    output: String,
    options: RenderOptions,
    stream_mode: bool,
    capture_stack: Vec<Capture>,
    list_stack: Vec<ListState>,
    blockquote_stack: Vec<Option<BlockQuoteKind>>,
    table: Option<TableState>,
    fence: Option<FenceState>,
    link_stack: Vec<LinkKind>,
    image_stack: Vec<ImageState>,
    raw_html: Option<RawHtmlCapture>,
    footnotes: FootnoteStore,
    heading_ids: HashSet<String>,
    paragraph_open: bool,
    paragraph_in_list_item: bool,
}

impl Renderer {
    fn new(options: RenderOptions, stream_mode: bool, capacity: usize) -> Self {
        Self {
            output: String::with_capacity(capacity),
            options,
            stream_mode,
            capture_stack: Vec::new(),
            list_stack: Vec::new(),
            blockquote_stack: Vec::new(),
            table: None,
            fence: None,
            link_stack: Vec::new(),
            image_stack: Vec::new(),
            raw_html: None,
            footnotes: FootnoteStore::default(),
            heading_ids: HashSet::new(),
            paragraph_open: false,
            paragraph_in_list_item: false,
        }
    }

    fn render(&mut self, text: &str) -> String {
        let parser = Parser::new_ext(text, parser_options());
        for event in parser {
            self.handle_event(event);
        }
        self.finish_raw_html_capture();
        self.flush_fence();
        self.flush_captures();
        self.render_footnotes_section();
        std::mem::take(&mut self.output)
    }

    fn handle_event(&mut self, event: Event<'_>) {
        if self.raw_html.is_some() && self.capture_raw_html_event(&event) {
            return;
        }
        match event {
            Event::Start(tag) => self.handle_start(tag),
            Event::End(end) => self.handle_end(end),
            Event::Text(t) => self.handle_text(&t),
            Event::Code(c) => self.handle_inline_code(&c),
            Event::Html(html) => self.handle_raw_html(&html, true),
            Event::InlineHtml(html) => self.handle_raw_html(&html, false),
            Event::SoftBreak => self.handle_soft_break(),
            Event::HardBreak => self.handle_hard_break(),
            Event::Rule => self.handle_rule(),
            Event::TaskListMarker(checked) => self.handle_task_marker(checked),
            Event::FootnoteReference(name) => self.handle_footnote_reference(&name),
            Event::InlineMath(tex) => self.handle_inline_math(&tex),
            Event::DisplayMath(tex) => self.handle_display_math(&tex),
        }
    }

    fn handle_start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.start_paragraph(),
            Tag::Heading { level, id, .. } => self.start_heading(level, id.as_deref()),
            Tag::CodeBlock(kind) => self.start_code_block(kind),
            Tag::List(start) => self.start_list(start),
            Tag::Item => self.start_item(),
            Tag::Emphasis => self.start_inline_tag("<em>"),
            Tag::Strong => self.start_inline_tag("<strong>"),
            Tag::Strikethrough => self.start_inline_tag("<del>"),
            Tag::Link { dest_url, .. } => self.start_link(&dest_url),
            Tag::Image {
                dest_url, title, ..
            } => self.start_image(&dest_url, &title),
            Tag::Table(alignments) => self.start_table(alignments),
            Tag::TableHead => self.start_table_head(),
            Tag::TableRow => self.start_table_row(),
            Tag::TableCell => self.start_table_cell(),
            Tag::BlockQuote(kind) => self.start_blockquote(kind),
            Tag::FootnoteDefinition(name) => self.start_footnote_definition(&name),
            _ => {}
        }
    }

    fn handle_end(&mut self, end: TagEnd) {
        match end {
            TagEnd::Paragraph => self.end_paragraph(),
            TagEnd::Heading(_) => self.end_heading(),
            TagEnd::CodeBlock => self.end_code_block(),
            TagEnd::List(_) => self.end_list(),
            TagEnd::Item => self.end_item(),
            TagEnd::Emphasis => self.end_inline_tag("</em>"),
            TagEnd::Strong => self.end_inline_tag("</strong>"),
            TagEnd::Strikethrough => self.end_inline_tag("</del>"),
            TagEnd::Link => self.end_link(),
            TagEnd::Image => self.end_image(),
            TagEnd::Table => self.end_table(),
            TagEnd::TableHead => self.end_table_head(),
            TagEnd::TableRow => self.end_table_row(),
            TagEnd::TableCell => self.end_table_cell(),
            TagEnd::BlockQuote(_) => self.end_blockquote(),
            TagEnd::FootnoteDefinition => self.end_footnote_definition(),
            _ => {}
        }
    }

    // ── 缓冲区 ───────────────────────────────────────────────────

    fn current_buffer_mut(&mut self) -> &mut String {
        match self.capture_stack.last_mut() {
            Some(Capture::Heading(h)) => &mut h.html,
            Some(Capture::Footnote(f)) => &mut f.html,
            None => &mut self.output,
        }
    }

    fn push_str(&mut self, s: &str) {
        self.current_buffer_mut().push_str(s);
    }

    fn push_escaped(&mut self, s: &str) {
        crate::html::escape_html_into(s, self.current_buffer_mut());
    }

    fn push_escaped_attr(&mut self, s: &str) {
        crate::html::escape_html_attr_into(s, self.current_buffer_mut());
    }

    /// 标题捕获期间同步收集纯文本，用于生成 slug id。
    fn push_plain(&mut self, s: &str) {
        if let Some(Capture::Heading(h)) = self.capture_stack.last_mut() {
            h.plain.push_str(s);
        }
    }

    // ── 标题 ─────────────────────────────────────────────────────

    fn emit_heading(&mut self, cap: HeadingCapture) {
        let level = cap.level.clamp(1, 6);
        let base = cap
            .explicit_id
            .as_deref()
            .and_then(normalize_explicit_id)
            .unwrap_or_else(|| slugify_heading(&cap.plain));
        let id = self.unique_heading_id(&base);
        let html = format!(
            "<h{level} class=\"md-h{level}\" id=\"{}\">{}</h{level}>",
            crate::html::escape_html_attr(&id),
            cap.html
        );
        self.push_str(&html);
    }

    fn unique_heading_id(&mut self, base: &str) -> String {
        if self.heading_ids.insert(base.to_string()) {
            return base.to_string();
        }
        let mut n = 1usize;
        loop {
            let candidate = format!("{base}-{n}");
            if self.heading_ids.insert(candidate.clone()) {
                return candidate;
            }
            n += 1;
        }
    }

    fn flush_captures(&mut self) {
        while let Some(capture) = self.capture_stack.pop() {
            match capture {
                Capture::Heading(cap) => self.emit_heading(cap),
                Capture::Footnote(cap) => {
                    self.footnotes.ensure_number(&cap.name);
                    self.footnotes.definitions.insert(cap.name, cap.html);
                }
            }
        }
    }
}

fn parser_options() -> Options {
    // 不启用 ENABLE_SMART_PUNCTUATION：默认关闭是项目既有纪律（MD 契约 I6），
    // 避免把 `--`/`...`/直引号改写成智能标点，改变内容语义。
    Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH
        | Options::ENABLE_GFM
        | Options::ENABLE_HEADING_ATTRIBUTES
}

fn truncate_input(raw: &str) -> (&str, bool) {
    if raw.len() > MAX_MARKDOWN_INPUT {
        let end = raw.floor_char_boundary(MAX_MARKDOWN_INPUT);
        (&raw[..end], true)
    } else {
        (raw, false)
    }
}

fn render_uncached(raw: &str, options: RenderOptions, stream_mode: bool) -> RenderResult {
    let (truncated_text, truncated) = truncate_input(raw);
    let normalized: Cow<'_, str> = if truncated_text.contains('\r') {
        Cow::Owned(
            truncated_text
                .replace("\r\n", "\n")
                .replace('\r', "\n"),
        )
    } else {
        Cow::Borrowed(truncated_text)
    };
    let text = normalized
        .strip_prefix('\u{feff}')
        .unwrap_or(normalized.as_ref());
    if text.trim().is_empty() {
        return RenderResult {
            html: String::new(),
            truncated,
        };
    }

    let (table_prepared, pipe_placeholder) = table::prepare_tables(text);
    let mut renderer = Renderer::new(options, stream_mode, table_prepared.len() + 256);
    let html = renderer.render(&table_prepared);
    let html = match pipe_placeholder {
        Some(placeholder) => html.replace(&placeholder, "|"),
        None => html,
    };
    RenderResult { html, truncated }
}

/// 渲染 Markdown 为 HTML（带缓存）。
pub fn render_markdown(text: &str, options: RenderOptions) -> RenderResult {
    if text.is_empty() {
        return RenderResult::empty();
    }
    if let Some(cached) = get_render_cached(options.variant, text) {
        return (*cached).clone();
    }
    let result = render_uncached(text, options, false);
    insert_render_cached(options.variant, text, Arc::new(result.clone()));
    result
}

/// 批量渲染（每条独立享受缓存）。
pub fn render_markdown_batch(texts: Vec<String>, options: RenderOptions) -> Vec<RenderResult> {
    texts
        .into_iter()
        .map(|text| render_markdown(&text, options))
        .collect()
}

/// 流式渲染：跳过 syntect 高亮、不写缓存；HTML 外壳与完成态一致。
pub fn render_markdown_stream(text: &str, options: RenderOptions) -> RenderResult {
    render_uncached(text, options, true)
}

fn slugify_heading(text: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
        } else if ch.is_whitespace() || ch == '-' || ch == '_' {
            pending_dash = true;
        }
    }
    if out.is_empty() {
        "section".to_string()
    } else {
        out
    }
}

fn normalize_explicit_id(id: &str) -> Option<String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cleaned: String = trimmed
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(text: &str) -> String {
        render_markdown(text, RenderOptions::chat()).html
    }

    #[test]
    fn heading_levels_are_not_clamped() {
        let html = render("# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6");
        for level in 1..=6 {
            assert!(
                html.contains(&format!("<h{level} class=\"md-h{level}\"")),
                "missing h{level}: {html}"
            );
            assert!(html.contains(&format!("</h{level}>")));
        }
    }

    #[test]
    fn heading_ids_are_generated_and_deduplicated() {
        let html = render("# Hello World\n\n# Hello World\n\n# 中文标题");
        assert!(html.contains("id=\"hello-world\""));
        assert!(html.contains("id=\"hello-world-1\""));
        assert!(html.contains("id=\"中文标题\""));
    }

    #[test]
    fn footnotes_render_reference_and_section() {
        let html = render("正文[^1]\n\n[^1]: 脚注内容");
        assert!(html.contains("md-footnote-ref"));
        assert!(html.contains("href=\"#fn-1\""));
        assert!(html.contains("md-footnotes"));
        assert!(html.contains("id=\"fn-1\""));
        assert!(html.contains("md-footnote-backref"));
    }

    #[test]
    fn callouts_are_rendered_from_gfm_alerts() {
        let html = render("> [!NOTE]\n> 注意");
        assert!(html.contains("md-callout md-callout-note"));
        assert!(html.contains("data-callout-title=\"note\""));
        assert!(html.contains("md-callout-body"));
    }

    #[test]
    fn math_events_become_islands() {
        let html = render("行内 $E=mc^2$\n\n$$\n\\int_0^1 x dx\n$$");
        assert!(html.contains("data-md-island=\"math\""));
        assert!(html.contains("data-tex=\"E=mc^2\""));
        assert!(html.contains("md-math-block"));
    }

    #[test]
    fn raw_html_safe_tags_survive_and_scripts_are_removed() {
        let html = render("<details><summary>日志</summary><kbd>Ctrl</kbd></details>\n\n<script>alert(1)</script>");
        assert!(html.contains("<summary>日志</summary>"));
        assert!(html.contains("<kbd>Ctrl</kbd>"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn raw_html_nesting_survives_split_events() {
        let html = render("<details>\n<summary>More</summary>\n\ndetails body\n\n</details>");
        let open = html.find("<details>").expect("open details");
        let close = html.find("</details>").expect("close details");
        let body = html.find("details body").expect("body");
        assert!(open < body && body < close, "details not nested: {html}");
        assert!(html.contains("<summary>More</summary>"));

        let inline = render("<kbd>Ctrl</kbd> + <mark>高亮</mark>");
        assert!(inline.contains("<kbd>Ctrl</kbd>"));
        assert!(inline.contains("<mark>高亮</mark>"));
    }

    #[test]
    fn document_variant_uses_space_for_soft_break() {
        let chat = render_markdown("a\nb", RenderOptions::chat()).html;
        let doc = render_markdown("a\nb", RenderOptions::document()).html;
        assert!(chat.contains("<br>"));
        assert!(!doc.contains("<br>"));
        assert!(doc.contains("a b"));
    }

    #[test]
    fn truncated_flag_is_reported() {
        let big = "x".repeat(MAX_MARKDOWN_INPUT + 16);
        let result = render_markdown(&big, RenderOptions::chat());
        assert!(result.truncated);
    }
}
