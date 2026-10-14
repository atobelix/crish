//! pulldown-cmark 事件流 → HTML 渲染器。
//!
//! 设计:
//! - pulldown-cmark 启用 ENABLE_TABLES / ENABLE_TASKLISTS / ENABLE_STRIKETHROUGH
//! - 启用 ENABLE_HTML,但 Event::Html 中只透传 `<img ...>`,其他 raw HTML 手动 escape
//!   (这是为了通过 `escapes_script_tag` + `passes_img_tags_through` 两个测试)
//! - ammonia 兜底移除 `<img onerror=...>` 的危险属性
//!
//! 输出 byte-for-byte 兼容现有 CSS 选择器 (`md-rendered` / `code-fence` / `md-tr-alt` 等)。

use once_cell::sync::Lazy;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::borrow::Cow;
use std::sync::Arc;

use crate::ammonia_config;
use crate::cache::{get_render_cached, insert_render_cached};
use crate::highlight::highlight_code;
use crate::sanitizer::{
    is_local_path_ref, is_safe_href, is_safe_img_src, link_destination_url, sanitize_url_candidate,
    wrap_cjk_text_segment,
};
use crate::table::{normalize_alignments, stripe_class, table_cell_align_attr, Align};
use crate::MAX_MARKDOWN_INPUT;

/// 思考占位 / "本轮总结" 噪音标题行(标题/粗体/方括号/裸行)。
const RE_ROUND_SUMMARY_ZH: &str = r"本(?:轮|回合)(?:工作|内容|完成)?(?:总结|小结|回顾)";
const RE_ROUND_SUMMARY_EN: &str = r"(?:Round|Session|Turn)\s+summary";

static MULTI_BLANK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\n{3,}").expect("valid multi blank regex"));
static THOUGHT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(正在思考中[….\s]{0,50}|正在处理[….\s]{0,50}){1,50}")
        .expect("valid thought regex")
});
static ZH_HEADING_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?m)^#{{1,6}}\s*{}\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_ZH
    ))
    .expect("valid zh heading regex")
});
static ZH_BOLD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?m)^\*{{1,2}}\s*{}\s*[:：]?\s*\*{{1,2}}\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_ZH
    ))
    .expect("valid zh bold regex")
});
static ZH_BRACKET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?m)^[【\[]\s*{}\s*[】\]]\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_ZH
    ))
    .expect("valid zh bracket regex")
});
static ZH_BARE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r"(?m)^{}\s*[:：·.\-—–]*\s*$", RE_ROUND_SUMMARY_ZH))
        .expect("valid zh bare regex")
});
static EN_HEADING_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?im)^#{{1,6}}\s*{}\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_EN
    ))
    .expect("valid en heading regex")
});
static EN_BOLD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r"(?im)^\*{{1,2}}\s*{}\s*[:：]?\s*\*{{1,2}}\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_EN
    ))
    .expect("valid en bold regex")
});
static EN_BARE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r"(?im)^{}\s*[:：·.\-—–]*\s*$", RE_ROUND_SUMMARY_EN))
        .expect("valid en bare regex")
});
static FENCE_FILE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\bfile=(?:"([^"]*)"|(\S+))"#).expect("valid file regex"));
static BR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<br>").expect("valid br regex"));
static IMG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"<img(?:[^a-zA-Z>][^>]*)?>").expect("valid img regex"));

/// 列表种类(用于 li 渲染)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Unordered,
    Ordered,
}

/// 列表层状态。
struct ListState {
    kind: ListKind,
    /// 当前 li 内已输出的段落数: 0=首段, ≥1=续段。
    item_paragraph_count: usize,
    /// 当前 li 是否为任务列表项。
    item_is_task: bool,
    /// 当前 li 是否已勾选。
    item_checked: bool,
    /// li 已结束(等待 Tag::End(Item))。
    item_open: bool,
}

impl ListState {
    fn new(kind: ListKind) -> Self {
        Self {
            kind,
            item_paragraph_count: 0,
            item_is_task: false,
            item_checked: false,
            item_open: false,
        }
    }
}

/// 表格状态。
struct TableState {
    /// 列对齐(已对齐到 col_count)。
    alignments: Vec<Align>,
    /// 基准列数 C(以表头列数为准)。
    col_count: usize,
    /// 是否在 thead 阶段。
    in_thead: bool,
    /// tbody 行索引(0-based),用于斑马纹。
    body_row_index: usize,
    /// 当前行已收集的单元格数。
    cell_index: usize,
    /// 是否已输出至少一个 tbody 行(用于 header-only 表格补 <tbody></tbody>)。
    has_body: bool,
}

/// fence 代码块状态。
struct FenceState {
    /// 已规范化的语言 id(如 "typescript" / "cpp" / "" 表示无语言)。
    lang: String,
    /// fence info 中提取的 file="..." 属性值。
    file_path: Option<String>,
    /// 收集的代码内容。
    buffer: String,
}

pub struct Renderer {
    output: String,
    list_stack: Vec<ListState>,
    table: Option<TableState>,
    fence: Option<FenceState>,
    // inline 处理采用即时输出策略: 在 Event::Text 时直接 escape + wbr。
    current_heading_level: Option<usize>,
    link_kind: Option<LinkKind>,
    image_safe_url: Option<String>,
    image_alt: String,
    image_unsafe: bool,
    /// 流式模式: 代码块跳过 syntect 高亮,直接输出 plain text (escaped HTML)。
    /// 默认 false。流式渲染期间设为 true 避免每 chunk 重复高亮的开销,
    /// 完成态切换回 false 走完整高亮。两种模式输出相同 HTML 外壳,无视觉跳变。
    stream_mode: bool,
}

impl Renderer {
    #[allow(dead_code)]
    fn new() -> Self {
        Self::with_capacity(0)
    }

    fn with_capacity(capacity: usize) -> Self {
        Self {
            output: String::with_capacity(capacity),
            list_stack: Vec::new(),
            table: None,
            fence: None,
            current_heading_level: None,
            link_kind: None,
            image_safe_url: None,
            image_alt: String::new(),
            image_unsafe: false,
            stream_mode: false,
        }
    }

    /// 主渲染入口: 接收预处理后的 markdown 文本,输出 HTML。
    fn render(&mut self, text: &str) -> String {
        // 不启用 ENABLE_SMART_PUNCTUATION:
        // JS 实现是自研 regex parser,不做 smart quote / em-dash 转换;
        // 启用会破坏 byte-for-byte 兼容(如 `"` → `"`/`"` 导致 `&quot;` 期望落空)。
        let options =
            Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS | Options::ENABLE_STRIKETHROUGH;
        let parser = Parser::new_ext(text, options);

        for event in parser {
            self.handle_event(event);
        }

        // 软闭合未闭合 fence:
        // 若文本以未闭合的 ``` 结尾,pulldown-cmark 可能不发出 End(CodeBlock),
        // 此时 fence buffer 仍在 self.fence 中。flush_fence 确保其内容被输出为 HTML,
        // 而非随 Renderer drop 被丢弃。
        self.flush_fence();

        // 不对全量输出做 ammonia 兜底:
        // 渲染器已 escape 所有 raw HTML(仅顶级 `<img>` 在 handle_html 内单独 sanitize),
        // 全量 ammonia 会 parse+reserialize,把 `&#39;`/`&quot;` 等实体按 HTML5 规则
        // un-escape (双引号属性中的 `'`、文本中的 `"` 不需要转义),破坏 byte-for-byte 兼容。
        // void 元素归一化仍需处理 handle_html 内 ammonia 输出的 `<img>` (HTML5 风格)。
        post_process_void_elements(std::mem::take(&mut self.output))
    }

    fn handle_event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => self.handle_start(tag),
            Event::End(end) => self.handle_end(end),
            Event::Text(t) => self.handle_text(&t),
            Event::Code(c) => self.handle_inline_code(&c),
            Event::Html(html) => self.handle_html(&html),
            Event::InlineHtml(html) => self.handle_inline_html(&html),
            Event::SoftBreak | Event::HardBreak => self.handle_break(),
            Event::Rule => self.handle_rule(),
            Event::TaskListMarker(checked) => self.handle_task_marker(checked),
            Event::FootnoteReference(_) => {} // 不支持脚注
            _ => {}
        }
    }

    fn handle_start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => self.start_paragraph(),
            Tag::Heading { level, .. } => self.start_heading(level),
            Tag::CodeBlock(kind) => self.start_code_block(kind),
            Tag::List(start) => self.start_list(start),
            Tag::Item => self.start_item(),
            Tag::Emphasis => self.output.push_str("<em>"),
            Tag::Strong => self.output.push_str("<strong>"),
            Tag::Strikethrough => self.output.push_str("<del>"),
            Tag::Link { dest_url, .. } => self.start_link(&dest_url),
            Tag::Image {
                dest_url, title, ..
            } => self.start_image(&dest_url, &title),
            Tag::Table(alignments) => self.start_table(alignments),
            Tag::TableHead => self.start_table_head(),
            Tag::TableRow => self.start_table_row(),
            Tag::TableCell => self.start_table_cell(),
            Tag::BlockQuote(_) => self.output.push_str("<blockquote class=\"md-quote\">"),
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
            TagEnd::Emphasis => self.output.push_str("</em>"),
            TagEnd::Strong => self.output.push_str("</strong>"),
            TagEnd::Strikethrough => self.output.push_str("</del>"),
            TagEnd::Link => self.end_link(),
            TagEnd::Image => self.end_image(),
            TagEnd::Table => self.end_table(),
            TagEnd::TableHead => self.end_table_head(),
            TagEnd::TableRow => self.end_table_row(),
            TagEnd::TableCell => self.end_table_cell(),
            TagEnd::BlockQuote(_) => self.output.push_str("</blockquote>"),
            _ => {}
        }
    }

    fn handle_text(&mut self, text: &str) {
        // 在 fence code block 内,累积内容
        if let Some(fence) = &mut self.fence {
            fence.buffer.push_str(text);
            return;
        }
        // 图片上下文: 累积 alt 文本(不输出),在 end_image 时统一输出 <img>
        if self.image_safe_url.is_some() || self.image_unsafe {
            self.image_alt.push_str(text);
            return;
        }
        // 链接/图片上下文不在此分支处理（image 分支已覆盖）
        // 裸路径自动链接: 扫描文本中的 `apps/` / `src/` / `packages/` / 盘符路径 / 绝对路径,
        // 包装为 `<button class="md-path-link">` (对齐 JS markdownPlugins.ts:517-525)。
        // - Rust regex crate 不支持 lookbehind, 改用 find_iter + 检查前一个字符的方式
        //   实现 `(?<!["`>])` 等效语义 (避免在 HTML 属性内识别路径)。
        // - 路径段输出 button, 非路径段走 escape_html + wrap_cjk_text_segment。
        let emoji_translated = translate_gfm_emoji_cow(text);
        wrap_bare_paths_and_escape_into(&emoji_translated, &mut self.output);
    }

    fn handle_inline_code(&mut self, code: &str) {
        self.output.push_str("<code class=\"md-inline-code\">");
        escape_html_into(code, &mut self.output);
        self.output.push_str("</code>");
    }

    fn handle_html(&mut self, html: &str) {
        let trimmed = html.trim_start();
        // 仅顶级 `<img ...>` 透传给 ammonia 单独 sanitize(剥离 onerror 等危险属性);
        // 其他块级 raw HTML 手动 escape。
        // 列表项/标题内的 `<img>` 也 escape — 与 JS 实现一致
        // (JS 实现仅放行行首 `<img ` 的块级行,列表项内的 `<img>` 不是块级行)。
        let in_list_or_heading =
            !self.list_stack.is_empty() || self.current_heading_level.is_some();
        if !in_list_or_heading && (trimmed.starts_with("<img") || trimmed.starts_with("<IMG")) {
            // ammonia 单独清理此 `<img>` 标签: strip onerror 等危险属性。
            // 不对全量输出做 ammonia(见 render()),以保留 escape 实体的 byte-for-byte 兼容。
            let sanitized = ammonia_config::sanitize(html);
            self.output.push_str(&sanitized);
        } else {
            escape_html_into(html, &mut self.output);
        }
    }

    /// 内联 raw HTML (段落/列表内的 `<script>`/`<img>`/`<em>` 等) 一律 escape。
    fn handle_inline_html(&mut self, html: &str) {
        escape_html_into(html, &mut self.output);
    }

    fn handle_break(&mut self) {
        if self.fence.is_some() {
            // fence 内的 SoftBreak 是代码换行
            if let Some(fence) = &mut self.fence {
                fence.buffer.push('\n');
            }
            return;
        }
        self.output.push_str("<br />");
    }

    fn handle_rule(&mut self) {
        self.output.push_str("<hr class=\"md-hr\" />");
    }

    fn handle_task_marker(&mut self, checked: bool) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_is_task = true;
            list.item_checked = checked;
        }
        // pulldown-cmark 事件顺序: Start(Item) → [Start(Paragraph)] → TaskListMarker → ...
        // start_item 已在 self.output 尾部输出 `<li class="md-li[ md-ol-item]">`,
        // 通过 rfind("<li") 从尾部 O(1) 定位当前刚打开的最后一个 <li> 标签，原位替换并追加 checkbox。
        if let Some(pos) = self.output.rfind("<li") {
            if let Some(rel_end) = self.output[pos..].find('>') {
                let end = pos + rel_end + 1;
                let li_new = if checked {
                    "<li class=\"md-li md-task-item done\">"
                } else {
                    "<li class=\"md-li md-task-item\">"
                };
                self.output.replace_range(pos..end, li_new);
                if checked {
                    self.output
                        .push_str("<span class=\"md-task-box checked\" aria-checked=\"true\"></span>");
                } else {
                    self.output
                        .push_str("<span class=\"md-task-box\" aria-checked=\"false\"></span>");
                }
            }
        }
    }

    // ── 段落 / 标题 / 代码块 ──────────────────────────────────────

    fn start_paragraph(&mut self) {
        // li 内的段落: 不输出 <p>,但续段前输出 <br />
        if let Some(list) = self.list_stack.last_mut() {
            if list.item_open {
                if list.item_paragraph_count > 0 {
                    self.output.push_str("<br />");
                }
                list.item_paragraph_count += 1;
                return;
            }
        }
        // 顶层段落: 不输出 <p>(JS 实现在最后统一包 <p>,我们改为在 end_paragraph 时包)
        // 但我们需要标记段落开始,以便 end_paragraph 包 <p>
        // 简化: 直接输出 <p class="md-p">
        self.output.push_str("<p class=\"md-p\">");
    }

    fn end_paragraph(&mut self) {
        if let Some(list) = self.list_stack.last() {
            if list.item_open {
                // li 内的段落: 不输出 </p>
                return;
            }
        }
        self.output.push_str("</p>");
    }

    fn start_heading(&mut self, level: pulldown_cmark::HeadingLevel) {
        let n = match level {
            pulldown_cmark::HeadingLevel::H1 => 1,
            pulldown_cmark::HeadingLevel::H2 => 2,
            pulldown_cmark::HeadingLevel::H3 => 3,
            pulldown_cmark::HeadingLevel::H4 => 4,
            pulldown_cmark::HeadingLevel::H5 => 4, // 渲染到 H4
            pulldown_cmark::HeadingLevel::H6 => 4,
        };
        // JS: level = Math.min(hashes.length, 4)
        match n {
            1 => self.output.push_str("<h1 class=\"md-h1\">"),
            2 => self.output.push_str("<h2 class=\"md-h2\">"),
            3 => self.output.push_str("<h3 class=\"md-h3\">"),
            _ => self.output.push_str("<h4 class=\"md-h4\">"),
        }
        // 记录当前 heading level 用于 end
        self.current_heading_level = Some(n);
    }

    fn end_heading(&mut self) {
        if let Some(n) = self.current_heading_level.take() {
            match n {
                1 => self.output.push_str("</h1>"),
                2 => self.output.push_str("</h2>"),
                3 => self.output.push_str("</h3>"),
                _ => self.output.push_str("</h4>"),
            }
        }
    }

    fn start_code_block(&mut self, kind: CodeBlockKind) {
        let (lang, file_path) = match kind {
            CodeBlockKind::Fenced(info) => {
                let info_str = info.as_ref();
                let lang = lang_from_fence_info(info_str);
                let file_path = extract_file_path_from_fence_info(info_str);
                (lang, file_path)
            }
            CodeBlockKind::Indented => (String::new(), None),
        };
        self.fence = Some(FenceState {
            lang,
            file_path,
            buffer: String::new(),
        });
    }

    fn end_code_block(&mut self) {
        self.flush_fence();
    }

    /// 把当前 fence buffer 刷出为 HTML 并追加到 output。
    /// 根据 stream_mode 选择高亮路径:
    ///   - false → build_code_fence_html_into (syntect 高亮)
    ///   - true  → build_code_fence_html_streaming_into (plain text, 跳过 syntect)
    ///
    /// 单一派发点,被 end_code_block (正常闭合) 和 render() 末尾 (软闭合未闭合 fence) 共用。
    fn flush_fence(&mut self) {
        if let Some(fence) = self.fence.take() {
            if self.stream_mode {
                build_code_fence_html_streaming_into(
                    &fence.buffer,
                    &fence.lang,
                    fence.file_path.as_deref(),
                    &mut self.output,
                );
            } else {
                build_code_fence_html_into(
                    &fence.buffer,
                    &fence.lang,
                    fence.file_path.as_deref(),
                    &mut self.output,
                );
            }
        }
    }

    // ── 列表 / 列表项 ─────────────────────────────────────────────

    fn start_list(&mut self, start: Option<u64>) {
        let kind = match start {
            Some(_) => ListKind::Ordered,
            None => ListKind::Unordered,
        };
        let start_val = start.unwrap_or(1);
        let depth = self.list_stack.len();
        self.list_stack.push(ListState::new(kind));

        let (tag, class) = match (kind, depth) {
            (ListKind::Ordered, 0) => ("ol", "md-ol"),
            (ListKind::Ordered, _) => ("ol", "md-ol md-ol-nested"),
            (ListKind::Unordered, 0) => ("ul", "md-ul"),
            (ListKind::Unordered, _) => ("ul", "md-ul md-ul-nested"),
        };
        self.output.push('<');
        self.output.push_str(tag);
        self.output.push_str(" class=\"");
        self.output.push_str(class);
        self.output.push('"');
        if matches!(kind, ListKind::Ordered) && start_val > 1 {
            use std::fmt::Write;
            let _ = write!(self.output, " start=\"{}\"", start_val);
        }
        self.output.push('>');
    }

    fn end_list(&mut self) {
        if let Some(list) = self.list_stack.pop() {
            let tag = match list.kind {
                ListKind::Ordered => "</ol>",
                ListKind::Unordered => "</ul>",
            };
            self.output.push_str(tag);
        }
    }

    fn start_item(&mut self) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_open = true;
            list.item_paragraph_count = 0;
            list.item_is_task = false;
            list.item_checked = false;
        }
        let li_class = match self.list_stack.last().map(|l| l.kind) {
            Some(ListKind::Ordered) => "<li class=\"md-li md-ol-item\">",
            _ => "<li class=\"md-li\">",
        };
        self.output.push_str(li_class);
    }

    fn end_item(&mut self) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_open = false;
        }
        self.output.push_str("</li>");
    }

    // ── 链接 / 图片 ────────────────────────────────────────────────

    /// 链接开始: 我们在 start_link 时不知道链接文本(在后续 Text 事件中)。
    /// 策略: 收集 link text 到 buffer,在 end_link 时输出完整 <a> 或 <span> 或 <button>。
    /// 但这破坏了 inline 嵌套(如 `[**bold**](url)` 中 bold 在 link 内)。
    /// 改用: 在 start_link 时根据 dest 决定输出 <a>/<span>/<button> 的开标签,
    /// 在 end_link 时输出闭标签。
    fn start_link(&mut self, dest: &str) {
        let url = link_destination_url(dest);
        if is_local_path_ref(&url) {
            let path = sanitize_url_candidate(&url);
            self.output
                .push_str("<button type=\"button\" class=\"md-path-link\" data-path=\"");
            escape_html_into(&path, &mut self.output);
            self.output.push_str("\" title=\"");
            escape_html_into(&path, &mut self.output);
            self.output.push_str("\">");
            self.link_kind = Some(LinkKind::PathLink);
            return;
        }
        if !is_safe_href(&url) {
            self.output.push_str("<span class=\"md-a-unsafe\">");
            self.link_kind = Some(LinkKind::Unsafe);
            return;
        }
        let safe = sanitize_url_candidate(&url);
        self.output
            .push_str("<a class=\"md-a\" href=\"");
        escape_html_attr_into(&safe, &mut self.output);
        self.output
            .push_str("\" target=\"_blank\" rel=\"noreferrer\">");
        self.link_kind = Some(LinkKind::Anchor);
    }

    fn end_link(&mut self) {
        match self.link_kind.take() {
            Some(LinkKind::Anchor) => self.output.push_str("</a>"),
            Some(LinkKind::PathLink) => self.output.push_str("</button>"),
            Some(LinkKind::Unsafe) => self.output.push_str("</span>"),
            None => {}
        }
    }

    /// 图片: alt 文本在后续 Text 事件中。我们用 image_alt buffer 收集。
    fn start_image(&mut self, dest: &str, _title: &str) {
        let url = link_destination_url(dest);
        if !is_safe_img_src(&url) {
            // 不安全图片: 降级为文本(alt),不输出 <img>
            self.image_unsafe = true;
            return;
        }
        let safe = sanitize_url_candidate(&url);
        self.image_safe_url = Some(safe);
    }

    fn end_image(&mut self) {
        if let Some(url) = self.image_safe_url.take() {
            let alt = std::mem::take(&mut self.image_alt);
            self.output.push_str("<img class=\"md-img\" src=\"");
            escape_html_attr_into(&url, &mut self.output);
            self.output.push_str("\" alt=\"");
            escape_html_attr_into(&alt, &mut self.output);
            self.output.push_str("\" loading=\"lazy\" />");
        } else if self.image_unsafe {
            // 不安全图片: 降级输出 alt 文本
            let alt = std::mem::take(&mut self.image_alt);
            let escaped = escape_html(&alt);
            let wrapped = wrap_cjk_text_segment(&escaped);
            self.output.push_str(&wrapped);
        }
        self.image_unsafe = false;
    }

    // ── 表格 ────────────────────────────────────────────────────

    fn start_table(&mut self, alignments: Vec<pulldown_cmark::Alignment>) {
        let aligns: Vec<Align> = alignments
            .iter()
            .map(|a| Align::from_pulldown(*a))
            .collect();
        let col_count = aligns.len();
        self.table = Some(TableState {
            alignments: aligns,
            col_count,
            in_thead: false,
            body_row_index: 0,
            cell_index: 0,
            has_body: false,
        });
        self.output.push_str(
            "<div class=\"md-table-wrap\" role=\"region\" data-md-table=\"true\" aria-label=\"Table\"><table class=\"md-table\">",
        );
    }

    fn end_table(&mut self) {
        // header-only 表格: pulldown-cmark 不输出 tbody 行事件,
        // 但测试契约要求 <tbody></tbody> 占位。
        // 有 body 行时: start_table_row 已开 <tbody>,这里闭 </tbody>。
        let needs_empty_tbody = self.table.as_ref().map(|t| !t.has_body).unwrap_or(false);
        if needs_empty_tbody {
            self.output.push_str("<tbody></tbody>");
        } else {
            self.output.push_str("</tbody>");
        }
        self.table = None;
        self.output.push_str("</table></div>");
    }

    fn start_table_head(&mut self) {
        if let Some(t) = &mut self.table {
            t.in_thead = true;
            t.cell_index = 0;
        }
        self.output.push_str("<thead><tr class=\"md-tr\">");
    }

    fn end_table_head(&mut self) {
        if let Some(t) = &mut self.table {
            t.in_thead = false;
            if t.cell_index > 0 {
                t.col_count = t.cell_index;
                t.alignments = normalize_alignments(&t.alignments, t.col_count);
            }
        }
        self.output.push_str("</tr></thead>");
    }

    fn start_table_row(&mut self) {
        if let Some(t) = &mut self.table {
            t.cell_index = 0;
            if !t.in_thead {
                // 首个 body 行: 开 <tbody>(header-only 表格不开,由 end_table 补空 tbody)
                if t.body_row_index == 0 {
                    self.output.push_str("<tbody>");
                }
                t.has_body = true;
                let stripe = stripe_class(t.body_row_index);
                self.output.push_str("<tr class=\"md-tr");
                self.output.push_str(stripe);
                self.output.push_str("\">");
            }
        }
    }

    fn end_table_row(&mut self) {
        if let Some(t) = &mut self.table {
            if !t.in_thead {
                while t.cell_index < t.col_count {
                    let align = t
                        .alignments
                        .get(t.cell_index)
                        .copied()
                        .unwrap_or(Align::Left);
                    let align_attr = table_cell_align_attr(align);
                    self.output.push_str("<td class=\"md-td\"");
                    self.output.push_str(align_attr);
                    self.output.push_str("></td>");
                    t.cell_index += 1;
                }
                t.body_row_index += 1;
            }
        }
        self.output.push_str("</tr>");
    }

    fn start_table_cell(&mut self) {
        let (is_head, align) = match &self.table {
            Some(t) => (
                t.in_thead,
                t.alignments
                    .get(t.cell_index)
                    .copied()
                    .unwrap_or(Align::Left),
            ),
            None => (false, Align::Left),
        };
        let align_attr = table_cell_align_attr(align);
        if is_head {
            self.output.push_str("<th class=\"md-th\" scope=\"col\"");
            self.output.push_str(align_attr);
            self.output.push('>');
        } else {
            self.output.push_str("<td class=\"md-td\"");
            self.output.push_str(align_attr);
            self.output.push('>');
        }
    }

    fn end_table_cell(&mut self) {
        let is_head = self.table.as_ref().map(|t| t.in_thead).unwrap_or(false);
        if is_head {
            self.output.push_str("</th>");
        } else {
            self.output.push_str("</td>");
        }
        if let Some(t) = &mut self.table {
            t.cell_index += 1;
        }
    }
}

/// 链接种类(用于 end_link 决定闭标签)。
#[derive(Debug, Clone, Copy)]
enum LinkKind {
    Anchor,
    PathLink,
    Unsafe,
}

// ── 公共 API ──────────────────────────────────────────────────

/// 渲染 markdown 为 HTML。
pub fn render_markdown(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // 检查缓存（DEF-05：零拷贝 &str 引用查表，仅在未命中且写入缓存时分配 String key）
    if let Some(cached) = get_render_cached(text) {
        return (*cached).clone();
    }

    let html = render_markdown_uncached(text);

    insert_render_cached(text, Arc::new(html.clone()));
    html
}

/// 批量渲染 markdown。
pub fn render_markdown_batch(texts: Vec<String>) -> Vec<String> {
    texts.into_iter().map(|t| render_markdown(&t)).collect()
}

/// 流式渲染 markdown。
///
/// 与 [`render_markdown`] 的区别:
/// - 不走缓存: 流式 chunk 唯一,缓存无收益
/// - `stream_mode=true` 时代码块跳过 syntect 高亮,直接输出 plain text (escaped HTML),
///   避免每个 chunk 重复高亮的开销;HTML 外壳与完成态一致,切换时无视觉跳变
/// - `stream_mode=false` 时行为与 [`render_markdown`] 一致 (但绕过缓存)
///
/// 典型用法: 流式输出期间 `stream_mode=true`,最终完成态 `stream_mode=false` 走完整高亮。
pub fn render_markdown_stream(text: &str, stream_mode: bool) -> String {
    let mut renderer = Renderer::with_capacity(text.len() + 256);
    renderer.stream_mode = stream_mode;
    renderer.render(text)
}

/// 渲染(不走缓存) — 内部实现。
fn render_markdown_uncached(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    // 1. 长度截断（C-01：CJK 多字节字符在非 char boundary 处切片会 panic，
    //    回退到前一个字符边界，保证截断后首尾字符完整、不产生半个字符）
    let truncated = if raw.len() > MAX_MARKDOWN_INPUT {
        let end = raw.floor_char_boundary(MAX_MARKDOWN_INPUT);
        &raw[..end]
    } else {
        raw
    };
    // 2. CRLF 归一化（不含 \r 时零拷贝借用）
    let normalized: Cow<'_, str> = if truncated.contains('\r') {
        Cow::Owned(truncated.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(truncated)
    };
    // 3. strip thought placeholders（零成本快速预检 + Cow 零拷贝通路）
    let stripped = strip_thought_placeholders_cow(&normalized);
    if stripped.is_empty() {
        return String::new();
    }
    // 4. 压缩 3+ 空行为 2 空（不含 \n\n\n 时跳过）
    let compact: Cow<'_, str> = if stripped.contains("\n\n\n") {
        Cow::Owned(MULTI_BLANK_RE.replace_all(&stripped, "\n\n").into_owned())
    } else {
        stripped
    };
    if compact.trim().is_empty() {
        return String::new();
    }
    // 6. 表格分隔行补齐: pulldown-cmark 要求分隔行列数 ≥ 表头列数,
    //    否则不解析为表格。JS 实现会自动补齐,这里对齐行为。
    let table_padded = normalize_table_separators(&compact);

    let mut renderer = Renderer::with_capacity(table_padded.len() + 256);
    renderer.render(&table_padded)
}

/// 零成本快速预检：判断输入文本是否可能包含思考占位或“本轮总结”特征子串。
/// 若均不包含，可直接跳过全部 8 个业务正则扫描与级联堆拷贝。
#[inline]
fn may_contain_thought_or_summary(s: &str) -> bool {
    s.contains("<thought")
        || s.contains("[thought")
        || s.contains("<!--")
        || s.contains("本轮总结")
        || s.contains("本轮")
        || s.contains("本回合")
        || s.contains("正在思考")
        || s.contains("正在处理")
        || s.as_bytes()
            .windows(7)
            .any(|w| w.eq_ignore_ascii_case(b"summary"))
}

#[inline]
fn replace_cow<'a>(re: &Regex, input: Cow<'a, str>, rep: &str) -> Cow<'a, str> {
    match re.replace_all(&input, rep) {
        Cow::Borrowed(_) => input,
        Cow::Owned(s) => Cow::Owned(s),
    }
}

/// 内部零拷贝版本：在无占位符特征且无多余空行时直接返回 `Cow::Borrowed` 切片。
fn strip_thought_placeholders_cow(text: &str) -> Cow<'_, str> {
    if text.is_empty() {
        return Cow::Borrowed("");
    }
    let soft_trimmed = soft_trim_markdown_slice(text);
    if soft_trimmed.is_empty() {
        return Cow::Borrowed("");
    }

    // 快速预检：若不含 "<thought"、"[thought"、"<!--"、"本轮总结" 等特征子串，直接走零拷贝通路
    if !may_contain_thought_or_summary(soft_trimmed) {
        if !soft_trimmed.contains("\n\n\n") {
            return Cow::Borrowed(soft_trimmed);
        }
        let compact = MULTI_BLANK_RE.replace_all(soft_trimmed, "\n\n");
        return Cow::Owned(soft_trim_markdown_slice(&compact).to_string());
    }

    // 1. 剥"正在思考中…"/"正在处理…" 等独立行
    let cur = replace_cow(&THOUGHT_RE, Cow::Borrowed(soft_trimmed), "");

    // 2. 剥"本轮总结" 类标题行(中英)，全部复用模块级 static Lazy<Regex>
    let cur = replace_cow(&ZH_HEADING_RE, cur, "");
    let cur = replace_cow(&ZH_BOLD_RE, cur, "");
    let cur = replace_cow(&ZH_BRACKET_RE, cur, "");
    let cur = replace_cow(&ZH_BARE_RE, cur, "");
    let cur = replace_cow(&EN_HEADING_RE, cur, "");
    let cur = replace_cow(&EN_BOLD_RE, cur, "");
    let cur = replace_cow(&EN_BARE_RE, cur, "");

    // 3. 压缩 3+ 空行为 2 空
    let cur = if cur.contains("\n\n\n") {
        replace_cow(&MULTI_BLANK_RE, cur, "\n\n")
    } else {
        cur
    };

    match cur {
        Cow::Borrowed(s) => Cow::Borrowed(soft_trim_markdown_slice(s)),
        Cow::Owned(s) => {
            let trimmed = soft_trim_markdown_slice(&s);
            if trimmed.len() == s.len() {
                Cow::Owned(s)
            } else {
                Cow::Owned(trimmed.to_string())
            }
        }
    }
}

/// 剥离"正在思考"占位与"本轮总结"类噪音标题行。
pub fn strip_thought_placeholders(text: &str) -> String {
    strip_thought_placeholders_cow(text).into_owned()
}

/// 去首尾空行/BOM,但保留行尾有意义空格(如 `- ` 空列表项) —— 零拷贝切片版。
#[inline]
fn soft_trim_markdown_slice(s: &str) -> &str {
    let trimmed_start = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    trimmed_start.trim_end_matches(['\n', ' ', '\t', '\r'])
}

/// 预处理: 检测 GFM 表格中分隔行列数少于表头列数的情况,自动补齐 `---` 列。
///
/// pulldown-cmark 要求分隔行列数 ≥ 表头列数才会解析为表格。
/// JS 实现自动补齐,这里对齐行为。仅处理 `|` 管道表格。
fn normalize_table_separators<'a>(md: &'a str) -> Cow<'a, str> {
    if !md.contains('|') {
        return Cow::Borrowed(md);
    }
    use crate::table::{is_table_sep_line, split_table_cells};
    let lines: Vec<&str> = md.lines().collect();
    let mut needs_padding = false;
    for i in 0..lines.len().saturating_sub(1) {
        let cur = lines[i];
        if cur.contains('|') && is_table_sep_line(lines[i + 1]) {
            let header_cells = split_table_cells(cur);
            let sep_cells = split_table_cells(lines[i + 1]);
            if header_cells.len() > sep_cells.len() && header_cells.len() >= 2 {
                needs_padding = true;
                break;
            }
        }
    }
    if !needs_padding {
        return Cow::Borrowed(md);
    }

    let mut out = String::with_capacity(md.len() + 32);
    let mut i = 0;
    while i < lines.len() {
        let cur = lines[i];
        // 检查: 当前行是潜在表头(含 `|`),下一行是分隔行
        if i + 1 < lines.len() && cur.contains('|') && is_table_sep_line(lines[i + 1]) {
            let header_cells = split_table_cells(cur);
            let sep_cells = split_table_cells(lines[i + 1]);
            let header_count = header_cells.len();
            let sep_count = sep_cells.len();
            if header_count > sep_count && header_count >= 2 {
                // 补齐分隔行: 缺失列用 `---` (left-align)
                let mut new_sep = String::from("|");
                for (j, _) in header_cells.iter().enumerate().take(header_count) {
                    if j < sep_count {
                        new_sep.push_str(sep_cells[j].as_str());
                    } else {
                        new_sep.push_str(" --- ");
                    }
                    new_sep.push('|');
                }
                out.push_str(cur);
                out.push('\n');
                out.push_str(&new_sep);
                if i + 1 < lines.len() {
                    out.push('\n');
                }
                i += 2;
                continue;
            }
        }
        out.push_str(cur);
        if i + 1 < lines.len() {
            out.push('\n');
        }
        i += 1;
    }
    // lines() 不保留尾部换行,如果原文以 \n 结尾需补回
    if md.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    Cow::Owned(out)
}

// ── 辅助函数 ──────────────────────────────────────────────────

/// 把 ammonia 输出的 HTML5 void 元素恢复为 XHTML 自闭合形式。
///
/// html5ever 序列化 `<br>` `<img ...>` (无斜杠);
/// 现有 CSS 契约与 JS DOMPurify 输出均为 `<br />` `<img ... />`。
/// 仅处理渲染器产出的 void 元素: br / img。wbr 已是无斜杠形式,保持不变。
fn post_process_void_elements(html: String) -> String {
    let has_br = html.contains("<br>");
    let has_img = html.contains("<img");
    if !has_br && !has_img {
        return html;
    }
    // <br> → <br />
    let s: Cow<'_, str> = if has_br {
        BR_RE.replace_all(&html, "<br />")
    } else {
        Cow::Borrowed(&html)
    };
    // <img ...> → <img ... />  (仅在尚未自闭合时)
    if s.contains("<img") {
        IMG_RE
            .replace_all(&s, |caps: &regex::Captures| {
                let tag = caps.get(0).unwrap().as_str();
                if tag.ends_with("/>") {
                    tag.to_string()
                } else {
                    let inner = &tag[..tag.len() - 1]; // 去掉末尾 '>'
                    format!("{} />", inner)
                }
            })
            .into_owned()
    } else {
        s.into_owned()
    }
}

/// HTML 正文/属性转义到目标 String 缓冲区，消除中间临时堆分配。
#[inline]
pub fn escape_html_into(s: &str, out: &mut String) {
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
}

/// HTML 属性值转义到目标 String 缓冲区。
#[inline]
pub fn escape_html_attr_into(s: &str, out: &mut String) {
    escape_html_into(s, out);
}

/// HTML 正文/属性转义。
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_html_into(s, &mut out);
    out
}

/// HTML 属性值转义(双引号包裹的属性值)。
pub fn escape_html_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_html_attr_into(s, &mut out);
    out
}

/// 裸路径自动链接 regex (对齐 JS markdownPlugins.ts:518)。
///
/// 匹配:
/// - 盘符路径 `C:\foo\bar.ts` / `C:/foo/bar.ts`
/// - 绝对路径 `/foo/bar.ts`
/// - Home 路径 `~/foo/bar.ts`
/// - 相对路径 `./foo/bar.ts` / `../foo/bar.ts`
/// - 项目路径 `apps/foo/bar.ts` / `packages/foo/bar.ts` / `src/foo/bar.ts`
/// - 路径体: 2-160 字符, 不含空白和 `"'<>|`
/// - 扩展名: `.[A-Za-z0-9]{1,12}`
///
/// Rust regex crate 不支持 lookbehind `(?<!["`>])`, 改用 `find_iter` +
/// 检查前一个字符的方式实现等效语义 (见 `wrap_bare_paths_and_escape`)。
static BARE_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?:[A-Za-z]:[\\/]|/|~/|\.\.?/|apps/|packages/|src/)[^\s`"'<>|]{2,160}\.[A-Za-z0-9]{1,12}"#,
    )
    .expect("valid bare path regex")
});

/// 扫描文本中的裸路径, 包装为 `<button class="md-path-link">` 并直接写入缓冲区。
fn wrap_bare_paths_and_escape_into(text: &str, out: &mut String) {
    if !text.contains('.')
        || (!text.contains('/') && !text.contains('\\') && !text.contains('~'))
    {
        let escaped = escape_html(text);
        let wrapped = wrap_cjk_text_segment(&escaped);
        out.push_str(&wrapped);
        return;
    }

    let mut last_end = 0usize;

    for m in BARE_PATH_RE.find_iter(text) {
        let start = m.start();
        let end = m.end();
        let path = m.as_str();

        // lookbehind 等效: 前一个字符不能是 " ` > (避免在 HTML 属性内识别路径)
        let prev_char = text[..start].chars().last();
        let forbidden_prev = matches!(prev_char, Some('"') | Some('`') | Some('>'));
        if forbidden_prev {
            continue;
        }

        // 输出 [last_end, start) 之间的文本 (escape + CJK wbr)
        if start > last_end {
            let prefix_text = &text[last_end..start];
            let escaped = escape_html(prefix_text);
            let wrapped = wrap_cjk_text_segment(&escaped);
            out.push_str(&wrapped);
        }

        // 输出路径段包装为 button (path 经 escape_html_attr_into 转义属性值, escape_html_into 转义文本)
        out.push_str("<button type=\"button\" class=\"md-path-link\" data-path=\"");
        escape_html_attr_into(path, out);
        out.push_str("\" title=\"");
        escape_html_attr_into(path, out);
        out.push_str("\">");
        escape_html_into(path, out);
        out.push_str("</button>");

        last_end = end;
    }

    // 输出剩余文本
    if last_end < text.len() {
        let rest = &text[last_end..];
        let escaped = escape_html(rest);
        let wrapped = wrap_cjk_text_segment(&escaped);
        out.push_str(&wrapped);
    }
}

/// 扫描文本中的裸路径, 包装为 `<button class="md-path-link">`。
#[allow(dead_code)]
fn wrap_bare_paths_and_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    wrap_bare_paths_and_escape_into(text, &mut out);
    out
}

/// fence info string → 语言 id(首 token;c++ 等别名归一)。
/// 与 markdownPlugins.ts::langFromFenceInfo 一致。
pub fn lang_from_fence_info(info: &str) -> String {
    lang_from_fence_info_cow(info).into_owned()
}

/// fence info string → 语言 id(首 token;c++ 等别名归一) — 零拷贝 Cow 版。
pub fn lang_from_fence_info_cow(info: &str) -> Cow<'_, str> {
    let trimmed = info.trim();
    let first_token = trimmed.split_whitespace().next().unwrap_or("");
    let stripped = first_token
        .strip_prefix("language-")
        .or_else(|| first_token.strip_prefix('.'))
        .unwrap_or(first_token);
    if stripped.is_empty() {
        return Cow::Borrowed("");
    }
    match stripped {
        "c++" | "C++" => Cow::Borrowed("cpp"),
        "c#" | "cs" | "C#" | "CS" => Cow::Borrowed("csharp"),
        "js" | "jsx" | "JS" | "JSX" => Cow::Borrowed("javascript"),
        "kt" | "KT" => Cow::Borrowed("kotlin"),
        "ts" | "tsx" | "TS" | "TSX" => Cow::Borrowed("typescript"),
        "py" | "PY" => Cow::Borrowed("python"),
        "rb" | "RB" => Cow::Borrowed("ruby"),
        "rs" | "RS" => Cow::Borrowed("rust"),
        "sh" | "shell" | "zsh" | "ps1" | "powershell"
        | "SH" | "SHELL" | "ZSH" | "PS1" | "POWERSHELL" => Cow::Borrowed("bash"),
        "yml" | "YML" => Cow::Borrowed("yaml"),
        "md" | "MD" => Cow::Borrowed("markdown"),
        other => {
            if other.bytes().all(|b| !b.is_ascii_uppercase()) {
                Cow::Borrowed(other)
            } else {
                let lower = other.to_lowercase();
                match lower.as_str() {
                    "c++" => Cow::Borrowed("cpp"),
                    "c#" | "cs" => Cow::Borrowed("csharp"),
                    "js" | "jsx" => Cow::Borrowed("javascript"),
                    "kt" => Cow::Borrowed("kotlin"),
                    "ts" | "tsx" => Cow::Borrowed("typescript"),
                    "py" => Cow::Borrowed("python"),
                    "rb" => Cow::Borrowed("ruby"),
                    "rs" => Cow::Borrowed("rust"),
                    "sh" | "shell" | "zsh" | "ps1" | "powershell" => Cow::Borrowed("bash"),
                    "yml" => Cow::Borrowed("yaml"),
                    "md" => Cow::Borrowed("markdown"),
                    _ => Cow::Owned(lower),
                }
            }
        }
    }
}

/// 从 fence info string 提取 file="..." 属性值。
pub fn extract_file_path_from_fence_info(info: &str) -> Option<String> {
    extract_file_path_from_fence_info_str(info).map(|s| s.to_string())
}

/// 从 fence info string 提取 file="..." 属性值 — 零拷贝切片版。
#[inline]
pub fn extract_file_path_from_fence_info_str(info: &str) -> Option<&str> {
    if !info.contains("file=") {
        return None;
    }
    FENCE_FILE_RE.captures(info).and_then(|c| {
        c.get(1).or_else(|| c.get(2)).map(|m| m.as_str())
    })
}

/// 构建 fence 代码块的 HTML。
/// 与 markdownPlugins.ts::buildCodeFenceHtml 一致。
pub fn build_code_fence_html(body_raw: &str, lang: &str, file_path: Option<&str>) -> String {
    let mut out = String::new();
    build_code_fence_html_into(body_raw, lang, file_path, &mut out);
    out
}

fn build_code_fence_html_into(
    body_raw: &str,
    lang: &str,
    file_path: Option<&str>,
    out: &mut String,
) {
    let body = body_raw.strip_suffix('\n').unwrap_or(body_raw);
    let inner = highlight_code(body, if lang.is_empty() { None } else { Some(lang) });
    build_code_fence_html_shell_into(lang, file_path, &inner, out);
}

/// 构建 fence 代码块的 HTML (流式模式)。
#[allow(dead_code)]
fn build_code_fence_html_streaming(body_raw: &str, lang: &str, file_path: Option<&str>) -> String {
    let mut out = String::new();
    build_code_fence_html_streaming_into(body_raw, lang, file_path, &mut out);
    out
}

fn build_code_fence_html_streaming_into(
    body_raw: &str,
    lang: &str,
    file_path: Option<&str>,
    out: &mut String,
) {
    let body = body_raw.strip_suffix('\n').unwrap_or(body_raw);
    let mut inner = String::with_capacity(body.len());
    escape_html_into(body, &mut inner);
    build_code_fence_html_shell_into(lang, file_path, &inner, out);
}

/// 构建 fence 代码块的 HTML 外壳 (lang 徽章 / file 面包屑 / copy 按钮 / pre>code 结构)。
/// `inner` 为已高亮或已 escape 的 code 内容。
#[allow(dead_code)]
fn build_code_fence_html_shell(lang: &str, file_path: Option<&str>, inner: String) -> String {
    let mut out = String::new();
    build_code_fence_html_shell_into(lang, file_path, &inner, &mut out);
    out
}

fn build_code_fence_html_shell_into(
    lang: &str,
    file_path: Option<&str>,
    inner: &str,
    out: &mut String,
) {
    let lang_escaped = if lang.is_empty() {
        String::new()
    } else {
        escape_html(lang)
    };

    out.push_str("<div class=\"md-code-block\"");
    if !lang.is_empty() {
        out.push_str(" data-lang=\"");
        out.push_str(&lang_escaped);
        out.push('"');
    }
    out.push_str("><div class=\"md-code-header\"><div class=\"md-code-header-left\">");

    if let Some(fp) = file_path {
        out.push_str("<span class=\"md-code-breadcrumb\">");
        let segments: Vec<&str> = fp.split('/').collect();
        for (i, s) in segments.iter().enumerate() {
            if i > 0 {
                out.push_str("<span class=\"md-code-breadcrumb-separator\">/</span>");
            }
            let is_last = i == segments.len() - 1;
            let cls = if is_last {
                "md-code-breadcrumb-file"
            } else {
                "md-code-breadcrumb-segment"
            };
            out.push_str("<span class=\"");
            out.push_str(cls);
            out.push_str("\">");
            escape_html_into(s, out);
            out.push_str("</span>");
        }
        out.push_str("</span>");
    } else if !lang.is_empty() {
        out.push_str("<span class=\"md-code-lang\" data-lang=\"");
        out.push_str(&lang_escaped);
        out.push_str("\" aria-label=\"");
        out.push_str(&lang_escaped);
        out.push_str("\">");
        out.push_str(&lang_escaped);
        out.push_str("</span>");
    }

    out.push_str("</div><div class=\"md-code-actions\">");
    if file_path.is_some() && !lang.is_empty() {
        out.push_str("<span class=\"md-code-lang\" data-lang=\"");
        out.push_str(&lang_escaped);
        out.push_str("\" aria-label=\"");
        out.push_str(&lang_escaped);
        out.push_str("\">");
        out.push_str(&lang_escaped);
        out.push_str("</span>");
    }
    out.push_str("<button type=\"button\" class=\"md-code-copy\" data-copy-button=\"true\" title=\"Copy\" aria-label=\"Copy code\">Copy</button></div></div><pre class=\"md-code-pre hljs\"><code class=\"language-");
    if !lang.is_empty() {
        out.push_str(&lang_escaped);
    }
    out.push_str("\">");
    out.push_str(inner);
    out.push_str("</code></pre></div>");
}

// ── GFM Emoji 短代码转义 ────────────────────────────────────────

/// AGENTS §21 / SCOUT §7.3：GFM emoji 短码翻译默认关闭（与 JS `GFM_EMOJI_SHORTCODES_DEFAULT` 对齐）。
/// 若产品日后坚持短码，两端须共读同一默认；禁止仅一端开启。
pub const GFM_EMOJI_SHORTCODES_DEFAULT: bool = false;

/// GFM Emoji 短代码核心字典映射（编译期常量跳转表）
#[inline(always)]
pub fn lookup_gfm_emoji(name: &str) -> Option<&'static str> {
    match name {
        // 状态与检查（工程高频）
        "white_check_mark" => Some("✅"),
        "heavy_check_mark" => Some("✔️"),
        "check" => Some("✓"),
        "x" => Some("❌"),
        "negative_squared_cross_mark" => Some("❎"),
        "ballot_box_with_check" => Some("☑️"),
        "warning" => Some("⚠️"),
        "rotating_light" => Some("🚨"),
        "stop_sign" => Some("🛑"),
        "exclamation" => Some("❗"),
        "question" => Some("❓"),
        "bulb" => Some("💡"),
        "bug" => Some("🐛"),
        "wrench" => Some("🔧"),
        "gear" => Some("⚙️"),
        "package" => Some("📦"),
        "rocket" => Some("🚀"),
        "tada" => Some("🎉"),
        "sparkles" => Some("✨"),
        "fire" => Some("🔥"),
        "zap" => Some("⚡"),
        "memo" | "pencil" => Some("📝"),
        "pencil2" => Some("✏️"),
        "bookmark" => Some("🔖"),
        "link" => Some("🔗"),
        "lock" => Some("🔒"),
        "unlock" => Some("🔓"),
        "info" => Some("ℹ️"),

        // 反馈与评审
        "+1" | "thumbsup" => Some("👍"),
        "-1" | "thumbsdown" => Some("👎"),
        "heart" => Some("❤️"),
        "star" => Some("⭐"),
        "star2" => Some("🌟"),
        "100" => Some("💯"),
        "eyes" => Some("👀"),
        "speech_balloon" => Some("💬"),

        // 状态圆圈指示器
        "white_circle" => Some("⚪"),
        "black_circle" => Some("⚫"),
        "red_circle" => Some("🔴"),
        "blue_circle" | "large_blue_circle" => Some("🔵"),
        "green_circle" => Some("🟢"),
        "yellow_circle" => Some("🟡"),

        // 箭头与方向
        "arrow_right" => Some("➡️"),
        "arrow_left" => Some("⬅️"),
        "arrow_up" => Some("⬆️"),
        "arrow_down" => Some("⬇️"),
        "soon" => Some("🔜"),
        "top" => Some("🔝"),

        // 设备与环境
        "computer" => Some("💻"),
        "hourglass" => Some("⌛"),
        "hourglass_flowing_sand" => Some("⏳"),
        "apple" => Some("🍎"),
        "penguin" => Some("🐧"),

        _ => None,
    }
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符（受默认开关约束）。
/// 默认关闭，对齐 AGENTS §21；显式开启请用 [`translate_gfm_emoji_with`]。
pub fn translate_gfm_emoji(text: &str) -> String {
    translate_gfm_emoji_cow(text).into_owned()
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符 — 零拷贝 Cow 版。
pub fn translate_gfm_emoji_cow<'a>(text: &'a str) -> Cow<'a, str> {
    translate_gfm_emoji_with_cow(text, GFM_EMOJI_SHORTCODES_DEFAULT)
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符。
/// `enabled=false` 时原样返回；保证 O(N) 复杂度，无短代码时零额外分配路径。
pub fn translate_gfm_emoji_with(text: &str, enabled: bool) -> String {
    translate_gfm_emoji_with_cow(text, enabled).into_owned()
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符 — 零拷贝 Cow 版。
pub fn translate_gfm_emoji_with_cow<'a>(text: &'a str, enabled: bool) -> Cow<'a, str> {
    if !enabled || !text.contains(':') {
        return Cow::Borrowed(text);
    }

    let mut out = String::with_capacity(text.len());
    let mut last_idx = 0;
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b':' {
            let start = i;
            let mut j = i + 1;
            let mut valid = false;
            // 短代码最大限制 32 字节，只允许小写英文字母、数字、下划线、加号、减号
            while j < len && (j - start) <= 33 {
                let b = bytes[j];
                if b == b':' {
                    if j > start + 1 {
                        valid = true;
                    }
                    break;
                }
                if !(b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'_'
                    || b == b'+'
                    || b == b'-')
                {
                    break;
                }
                j += 1;
            }

            if valid && j < len && bytes[j] == b':' {
                let key = &text[start + 1..j];
                if let Some(emoji) = lookup_gfm_emoji(key) {
                    out.push_str(&text[last_idx..start]);
                    out.push_str(emoji);
                    i = j + 1;
                    last_idx = i;
                    continue;
                }
            }
        }
        i += 1;
    }

    if last_idx == 0 {
        return Cow::Borrowed(text);
    }

    if last_idx < len {
        out.push_str(&text[last_idx..]);
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gfm_emoji_shortcodes_default_is_off() {
        assert!(!GFM_EMOJI_SHORTCODES_DEFAULT);
        // 默认 API / 渲染路径保留短码文本，不插入 Unicode Emoji
        assert_eq!(
            translate_gfm_emoji("hello :white_check_mark: world"),
            "hello :white_check_mark: world"
        );
        assert_eq!(translate_gfm_emoji(":rocket::tada:"), ":rocket::tada:");
        let html = render_markdown("Status: :white_check_mark: and :rocket:");
        assert!(html.contains(":white_check_mark:"));
        assert!(html.contains(":rocket:"));
        assert!(!html.contains("✅"));
        assert!(!html.contains("🚀"));
    }

    #[test]
    fn gfm_emoji_translation_and_lookup_when_enabled() {
        assert_eq!(
            translate_gfm_emoji_with("hello :white_check_mark: world", true),
            "hello ✅ world"
        );
        assert_eq!(translate_gfm_emoji_with(":x:", true), "❌");
        assert_eq!(
            translate_gfm_emoji_with("no emoji here", true),
            "no emoji here"
        );
        assert_eq!(
            translate_gfm_emoji_with("http://foo.bar", true),
            "http://foo.bar"
        );
        assert_eq!(translate_gfm_emoji_with(":::", true), ":::");
        assert_eq!(
            translate_gfm_emoji_with(":unknown_code:", true),
            ":unknown_code:"
        );
        assert_eq!(translate_gfm_emoji_with(":rocket::tada:", true), "🚀🎉");
        assert_eq!(
            translate_gfm_emoji_with("中文:rocket:测试", true),
            "中文🚀测试"
        );
        assert_eq!(translate_gfm_emoji_with(":rocket:", false), ":rocket:");
        assert_eq!(lookup_gfm_emoji("fire"), Some("🔥"));
        assert_eq!(lookup_gfm_emoji("nonexistent"), None);
    }

    /// C-01：CJK 多字节字符在非 char boundary 处截断会 panic；
    /// `floor_char_boundary` 回退到前一个字符边界，截断后首尾字符完整。
    #[test]
    fn cjk_truncation_does_not_panic_on_non_char_boundary() {
        // 单个 CJK 字符占 3 字节（UTF-8），构造长度刚好越过 MAX_MARKDOWN_INPUT
        // 且截断点落在某 CJK 字符中间的字节位置。
        let prefix = "正文开始\n\n";
        // 重复 CJK 字符直到总字节数越过上限（每个「字」3 字节）
        let unit = "字";
        let unit_bytes = unit.len();
        let need = MAX_MARKDOWN_INPUT + unit_bytes - prefix.len() + 1;
        let count = need / unit_bytes + 1;
        let raw = format!("{prefix}{}", unit.repeat(count));
        assert!(raw.len() > MAX_MARKDOWN_INPUT, "构造输入应越过截断阈值");

        // 不应 panic；截断后首字符（prefix 首字）与末字符都应是完整字符边界
        let html = render_markdown(&raw);
        // 渲染结果应包含 prefix 首字的 HTML（非半个字符乱码）
        assert!(html.contains("正"), "截断后首字符应完整保留");
    }

    /// 截断点回退后首尾字符完整：构造截断点恰好落在 CJK 字符首字节处，
    /// `floor_char_boundary` 应回退到该字符之前的边界。
    #[test]
    fn floor_char_boundary_keeps_complete_chars() {
        let s = "abc字def";
        // 「字」起始于字节 3，长度 3；floor_char_boundary(4) 应回退到 3
        assert_eq!(s.floor_char_boundary(4), 3);
        assert_eq!(s.floor_char_boundary(5), 3);
        assert_eq!(s.floor_char_boundary(6), 6);
        // 边界本身不变
        assert_eq!(s.floor_char_boundary(3), 3);
    }

    #[test]
    fn strip_thought_placeholders_fast_path_returns_borrowed_without_copy() {
        let clean = "### 标题\n\n普通正文内容，不含任何思考占位或总结噪音。";
        let res = strip_thought_placeholders_cow(clean);
        assert!(
            matches!(res, Cow::Borrowed(_)),
            "常规无噪音文本应走零拷贝 Cow::Borrowed 快速预检分支"
        );
        assert_eq!(res.as_ref(), clean);
    }

    #[test]
    fn handle_task_marker_o1_in_place_renders_large_task_list_accurately() {
        let mut md = String::new();
        for i in 0..50 {
            if i % 2 == 0 {
                md.push_str(&format!("- [ ] task item {i}\n"));
            } else {
                md.push_str(&format!("- [x] task item {i}\n"));
            }
        }
        let html = render_markdown(&md);
        assert_eq!(html.matches("md-task-item").count(), 50);
        assert_eq!(html.matches("md-task-item done").count(), 25);
        assert_eq!(html.matches("md-task-box checked").count(), 25);
    }

    #[test]
    fn normalize_table_separators_returns_borrowed_when_no_pipe_or_padding_needed() {
        let no_pipe = "# 标题\n\n正文段落，没有表格。";
        assert!(matches!(
            normalize_table_separators(no_pipe),
            Cow::Borrowed(_)
        ));

        let valid_table = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        assert!(matches!(
            normalize_table_separators(valid_table),
            Cow::Borrowed(_)
        ));

        let short_sep_table = "| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |\n";
        let padded = normalize_table_separators(short_sep_table);
        assert!(matches!(padded, Cow::Owned(_)));
        assert!(padded.contains(" --- |"));
    }

    #[test]
    fn post_process_void_elements_returns_original_string_when_no_void_tags() {
        let clean_html = "<div class=\"md-p\"><p>普通内容</p></div>".to_string();
        let ptr = clean_html.as_ptr();
        let processed = post_process_void_elements(clean_html);
        assert_eq!(processed.as_ptr(), ptr, "无 void 元素时不重新分配");
    }

    #[test]
    fn fence_info_cow_returns_borrowed_for_standard_languages() {
        assert_eq!(lang_from_fence_info_cow("rust"), Cow::Borrowed("rust"));
        assert_eq!(lang_from_fence_info_cow("typescript"), Cow::Borrowed("typescript"));
        assert_eq!(lang_from_fence_info_cow("ts"), Cow::Borrowed("typescript"));
        assert_eq!(lang_from_fence_info_cow("c++"), Cow::Borrowed("cpp"));

        let info_with_file = "ts file=\"src/index.ts\"";
        assert_eq!(
            extract_file_path_from_fence_info_str(info_with_file),
            Some("src/index.ts")
        );
    }
}
