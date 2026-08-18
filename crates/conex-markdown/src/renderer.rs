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
use std::sync::Arc;

use crate::ammonia_config;
use crate::cache::{entry_within_budget, render_cache};
use crate::highlight::highlight_code;
use crate::sanitizer::{
    is_local_path_ref, is_safe_href, is_safe_img_src, link_destination_url, sanitize_url_candidate,
    wrap_cjk_text_segment,
};
use crate::table::{stripe_class, table_cell_align_attr, Align};
use crate::MAX_MARKDOWN_INPUT;

/// 思考占位 / "本轮总结" 噪音标题行(标题/粗体/方括号/裸行)。
const RE_ROUND_SUMMARY_ZH: &str = r"本(?:轮|回合)(?:工作|内容|完成)?(?:总结|小结|回顾)";
const RE_ROUND_SUMMARY_EN: &str = r"(?:Round|Session|Turn)\s+summary";

static HR_LINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[ \t]*(-{3,}|_{3,}|\*{3,})[ \t]*$").expect("valid hr regex"));
static MULTI_BLANK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\n{3,}").expect("valid multi blank regex"));
static THOUGHT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(正在思考中[….\s]{0,50}|正在处理[….\s]{0,50}){1,50}").expect("valid thought regex")
});

// 思考占位 / "本轮总结" 标题行由 strip_thought_placeholders 手写处理,不依赖此 regex。

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
    fn new() -> Self {
        Self {
            output: String::new(),
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
        let options = Options::ENABLE_TABLES
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_STRIKETHROUGH;
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
        post_process_void_elements(&self.output)
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
            Tag::Image { dest_url, title, .. } => self.start_image(&dest_url, &title),
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
        let html = wrap_bare_paths_and_escape(text);
        self.output.push_str(&html);
    }

    fn handle_inline_code(&mut self, code: &str) {
        let escaped = escape_html(code);
        self.output
            .push_str(&format!("<code class=\"md-inline-code\">{}</code>", escaped));
    }

    fn handle_html(&mut self, html: &str) {
        let trimmed = html.trim_start();
        // 仅顶级 `<img ...>` 透传给 ammonia 单独 sanitize(剥离 onerror 等危险属性);
        // 其他块级 raw HTML 手动 escape。
        // 列表项/标题内的 `<img>` 也 escape — 与 JS 实现一致
        // (JS 实现仅放行行首 `<img ` 的块级行,列表项内的 `<img>` 不是块级行)。
        let in_list_or_heading =
            !self.list_stack.is_empty() || self.current_heading_level.is_some();
        if !in_list_or_heading
            && (trimmed.starts_with("<img") || trimmed.starts_with("<IMG"))
        {
            // ammonia 单独清理此 `<img>` 标签: strip onerror 等危险属性。
            // 不对全量输出做 ammonia(见 render()),以保留 escape 实体的 byte-for-byte 兼容。
            let sanitized = ammonia_config::sanitize(html);
            self.output.push_str(&sanitized);
        } else {
            self.output.push_str(&escape_html(html));
        }
    }

    /// 内联 raw HTML (段落/列表内的 `<script>`/`<img>`/`<em>` 等) 一律 escape。
    fn handle_inline_html(&mut self, html: &str) {
        self.output.push_str(&escape_html(html));
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
        // JS 实现删除 HR(测试期望 render("---") 返回 "")
        // pulldown-cmark 把 --- 解析为 Rule 事件
    }

    fn handle_task_marker(&mut self, checked: bool) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_is_task = true;
            list.item_checked = checked;
        }
        // pulldown-cmark 事件顺序: Start(Item) → TaskListMarker → Start(Paragraph) → ...
        // start_item 已输出 `<li class="md-li[ md-ol-item]">`,这里回退替换为 task-item 版本
        // 并插入 checkbox。用正则查找**最后一个** `<li class="md-li[^"]*">` (当前 li) 以兼容两种初始 class。
        use std::sync::OnceLock;
        static LI_TAG_RE: OnceLock<Regex> = OnceLock::new();
        let li_re = LI_TAG_RE
            .get_or_init(|| Regex::new(r#"<li class="md-li[^"]*">"#).expect("valid li tag regex"));
        // find_iter().last() 取最后一个匹配,避免替换到前一个 li
        if let Some(m) = li_re.find_iter(&self.output).last() {
            let pos = m.start();
            let end = m.end();
            let mut new_out = String::with_capacity(self.output.len() + 64);
            // 替换 li 的 class 为 task 版本
            let li_new = if checked {
                "<li class=\"md-li md-task-item done\">"
            } else {
                "<li class=\"md-li md-task-item\">"
            };
            new_out.push_str(&self.output[..pos]);
            new_out.push_str(li_new);
            new_out.push_str(&self.output[end..]);
            // 插入 task box
            if checked {
                new_out.push_str("<span class=\"md-task-box checked\" aria-checked=\"true\"></span>");
            } else {
                new_out.push_str("<span class=\"md-task-box\" aria-checked=\"false\"></span>");
            }
            self.output = new_out;
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
        self.output
            .push_str(&format!("<h{} class=\"md-h{}\">", n, n));
        // 记录当前 heading level 用于 end
        self.current_heading_level = Some(n);
    }

    fn end_heading(&mut self) {
        if let Some(n) = self.current_heading_level.take() {
            self.output.push_str(&format!("</h{}>", n));
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
    ///   - false → build_code_fence_html (syntect 高亮)
    ///   - true  → build_code_fence_html_streaming (plain text, 跳过 syntect)
    ///
    /// 单一派发点,被 end_code_block (正常闭合) 和 render() 末尾 (软闭合未闭合 fence) 共用。
    fn flush_fence(&mut self) {
        if let Some(fence) = self.fence.take() {
            let html = if self.stream_mode {
                build_code_fence_html_streaming(&fence.buffer, &fence.lang, fence.file_path.as_deref())
            } else {
                build_code_fence_html(&fence.buffer, &fence.lang, fence.file_path.as_deref())
            };
            self.output.push_str(&html);
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
        let start_attr = match kind {
            ListKind::Ordered if start_val > 1 => format!(" start=\"{}\"", start_val),
            _ => String::new(),
        };
        self.output
            .push_str(&format!("<{} class=\"{}\"{}>", tag, class, start_attr));
    }

    fn end_list(&mut self) {
        if let Some(list) = self.list_stack.pop() {
            let tag = match list.kind {
                ListKind::Ordered => "ol",
                ListKind::Unordered => "ul",
            };
            self.output
                .push_str(&format!("</{}>", tag));
        }
    }

    fn start_item(&mut self) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_open = true;
            list.item_paragraph_count = 0;
            list.item_is_task = false;
            list.item_checked = false;
        }
        // li 的初始 class 取决于列表类型:
        //   - 有序列表项: `md-li md-ol-item` (对齐 JS markdownPlugins.ts:148/289/331)
        //   - 无序列表项: `md-li`
        //   - 任务列表项: pulldown-cmark 的 TaskListMarker 事件在 start_item 紧后触发,
        //     handle_task_marker 会把刚输出的 li 标签替换为 `md-li md-task-item[ done]`。
        //
        // 设计理由: pulldown-cmark 不暴露 lookahead,无法在 start_item 时知道是否是 task。
        // 改为在 start_item 时输出按 list.kind 决定的初始 li 标签,handle_task_marker 用
        // 正则 rfind 替换最后一个 `<li class="md-li[^"]*">` 为 task 版本。
        let li_class = match self.list_stack.last().map(|l| l.kind) {
            Some(ListKind::Ordered) => "md-li md-ol-item",
            _ => "md-li",
        };
        self.output.push_str(&format!("<li class=\"{}\">", li_class));
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
            self.output.push_str(&format!(
                "<button type=\"button\" class=\"md-path-link\" data-path=\"{}\" title=\"{}\">",
                escape_html(&path),
                escape_html(&path)
            ));
            self.link_kind = Some(LinkKind::PathLink);
            return;
        }
        if !is_safe_href(&url) {
            self.output.push_str("<span class=\"md-a-unsafe\">");
            self.link_kind = Some(LinkKind::Unsafe);
            return;
        }
        let safe = sanitize_url_candidate(&url);
        self.output.push_str(&format!(
            "<a class=\"md-a\" href=\"{}\" target=\"_blank\" rel=\"noreferrer\">",
            escape_html_attr(&safe)
        ));
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
            self.output.push_str(&format!(
                "<img class=\"md-img\" src=\"{}\" alt=\"{}\" loading=\"lazy\" />",
                escape_html_attr(&url),
                escape_html_attr(&alt)
            ));
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
        let aligns: Vec<Align> = alignments.iter().map(|a| Align::from_pulldown(*a)).collect();
        self.table = Some(TableState {
            alignments: aligns,
            in_thead: false,
            body_row_index: 0,
            cell_index: 0,
            has_body: false,
        });
        self.output.push_str(
            "<div class=\"md-table-wrap\" role=\"region\" aria-label=\"表格\"><table class=\"md-table\">",
        );
    }

    fn end_table(&mut self) {
        // header-only 表格: pulldown-cmark 不输出 tbody 行事件,
        // 但测试契约要求 <tbody></tbody> 占位。
        // 有 body 行时: start_table_row 已开 <tbody>,这里闭 </tbody>。
        let needs_empty_tbody = self
            .table
            .as_ref()
            .map(|t| !t.has_body)
            .unwrap_or(false);
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
                self.output
                    .push_str(&format!("<tr class=\"md-tr{}\">", stripe));
            }
        }
    }

    fn end_table_row(&mut self) {
        if let Some(t) = &mut self.table {
            if !t.in_thead {
                t.body_row_index += 1;
            }
        }
        self.output.push_str("</tr>");
    }

    fn start_table_cell(&mut self) {
        let (is_head, align) = match &self.table {
            Some(t) => (t.in_thead, t.alignments.get(t.cell_index).copied().unwrap_or(Align::Left)),
            None => (false, Align::Left),
        };
        let align_attr = table_cell_align_attr(align);
        if is_head {
            self.output
                .push_str(&format!("<th class=\"md-th\" scope=\"col\"{}>", align_attr));
        } else {
            self.output
                .push_str(&format!("<td class=\"md-td\"{}>", align_attr));
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
    // 检查缓存
    let cache_key = text.to_string();
    if let Some(cached) = render_cache().get(&cache_key) {
        return (*cached).clone();
    }

    let html = render_markdown_uncached(text);

    if entry_within_budget(text, &html) {
        render_cache().insert(cache_key, Arc::new(html.clone()));
    }
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
    let mut renderer = Renderer::new();
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
    // 2. CRLF 归一化
    let normalized = truncated.replace("\r\n", "\n").replace('\r', "\n");
    // 3. strip thought placeholders
    let stripped = strip_thought_placeholders(&normalized);
    if stripped.is_empty() {
        return String::new();
    }
    // 4. 删除 HR 行(JS 实现行为)
    let no_hr = HR_LINE_RE.replace_all(&stripped, "").to_string();
    // 5. 压缩 3+ 空行为 2 空
    let compact = MULTI_BLANK_RE.replace_all(&no_hr, "\n\n").to_string();
    if compact.trim().is_empty() {
        return String::new();
    }
    // 6. 表格分隔行补齐: pulldown-cmark 要求分隔行列数 ≥ 表头列数,
    //    否则不解析为表格。JS 实现会自动补齐,这里对齐行为。
    let table_padded = normalize_table_separators(&compact);

    let mut renderer = Renderer::new();
    renderer.render(&table_padded)
}

/// 剥离"正在思考"占位与"本轮总结"类噪音标题行。
pub fn strip_thought_placeholders(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    if text.trim().is_empty() {
        return String::new();
    }

    // soft trim: 去首尾空行/BOM,但保留行尾有意义空格
    let soft_trimmed = soft_trim_markdown(text);

    // 1. 剥"正在思考中…"/"正在处理…" 等独立行
    let after_thought = THOUGHT_RE.replace_all(&soft_trimmed, "").to_string();

    // 2. 剥"本轮总结" 类标题行(中英)
    let zh_pat = format!(r"(?m)^#{{1,6}}\s*{}\s*[:：·.\-—–]*\s*$", RE_ROUND_SUMMARY_ZH);
    let re_zh_h = Regex::new(&zh_pat).expect("valid zh heading regex");
    let after_zh_h = re_zh_h.replace_all(&after_thought, "").to_string();

    let zh_bold_pat = format!(
        r"(?m)^\*{{1,2}}\s*{}\s*[:：]?\s*\*{{1,2}}\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_ZH
    );
    let re_zh_b = Regex::new(&zh_bold_pat).expect("valid zh bold regex");
    let after_zh_b = re_zh_b.replace_all(&after_zh_h, "").to_string();

    let zh_bracket_pat = format!(
        r"(?m)^[【\[]\s*{}\s*[】\]]\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_ZH
    );
    let re_zh_br = Regex::new(&zh_bracket_pat).expect("valid zh bracket regex");
    let after_zh_br = re_zh_br.replace_all(&after_zh_b, "").to_string();

    let zh_bare_pat = format!(r"(?m)^{}\s*[:：·.\-—–]*\s*$", RE_ROUND_SUMMARY_ZH);
    let re_zh_bar = Regex::new(&zh_bare_pat).expect("valid zh bare regex");
    let after_zh_bar = re_zh_bar.replace_all(&after_zh_br, "").to_string();

    // 英文 Round/Session/Turn summary
    let en_h_pat = format!(r"(?im)^#{{1,6}}\s*{}\s*[:：·.\-—–]*\s*$", RE_ROUND_SUMMARY_EN);
    let re_en_h = Regex::new(&en_h_pat).expect("valid en heading regex");
    let after_en_h = re_en_h.replace_all(&after_zh_bar, "").to_string();

    let en_bold_pat = format!(
        r"(?im)^\*{{1,2}}\s*{}\s*[:：]?\s*\*{{1,2}}\s*[:：·.\-—–]*\s*$",
        RE_ROUND_SUMMARY_EN
    );
    let re_en_b = Regex::new(&en_bold_pat).expect("valid en bold regex");
    let after_en_b = re_en_b.replace_all(&after_en_h, "").to_string();

    let en_bare_pat = format!(r"(?im)^{}\s*[:：·.\-—–]*\s*$", RE_ROUND_SUMMARY_EN);
    let re_en_bar = Regex::new(&en_bare_pat).expect("valid en bare regex");
    let after_en_bar = re_en_bar.replace_all(&after_en_b, "").to_string();

    // 压缩 3+ 空行为 2 空
    let compact = MULTI_BLANK_RE.replace_all(&after_en_bar, "\n\n").to_string();

    soft_trim_markdown(&compact)
}

/// 去首尾空行/BOM,但保留行尾有意义空格(如 `- ` 空列表项)。
fn soft_trim_markdown(s: &str) -> String {
    let trimmed_start: &str = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    // 去尾部空行 + 行尾空白
    let mut out = String::from(trimmed_start);
    while out.ends_with('\n') || out.ends_with(' ') || out.ends_with('\t') || out.ends_with('\r') {
        out.pop();
    }
    out
}

/// 预处理: 检测 GFM 表格中分隔行列数少于表头列数的情况,自动补齐 `---` 列。
///
/// pulldown-cmark 要求分隔行列数 ≥ 表头列数才会解析为表格。
/// JS 实现自动补齐,这里对齐行为。仅处理 `|` 管道表格。
fn normalize_table_separators(md: &str) -> String {
    use crate::table::{is_table_sep_line, split_table_cells};
    let lines: Vec<&str> = md.lines().collect();
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
    out
}

// ── 辅助函数 ──────────────────────────────────────────────────

/// 把 ammonia 输出的 HTML5 void 元素恢复为 XHTML 自闭合形式。
///
/// html5ever 序列化 `<br>` `<img ...>` (无斜杠);
/// 现有 CSS 契约与 JS DOMPurify 输出均为 `<br />` `<img ... />`。
/// 仅处理渲染器产出的 void 元素: br / img。wbr 已是无斜杠形式,保持不变。
fn post_process_void_elements(html: &str) -> String {
    use std::sync::OnceLock;
    static BR_RE: OnceLock<Regex> = OnceLock::new();
    static IMG_RE: OnceLock<Regex> = OnceLock::new();
    let br_re = BR_RE.get_or_init(|| Regex::new(r"<br>").expect("valid br regex"));
    // Rust `regex` crate 不支持 look-around,故用字符类替代 `(?![a-zA-Z])`:
    // `<img>` (空)、`<img/>`、`<img src=...>` 均匹配;`<image>` 等不匹配。
    // `(?:[^a-zA-Z>][^>]*)?` 允许 `<img>` 紧接 `>` 的情形(可选组为空)。
    let img_re = IMG_RE
        .get_or_init(|| Regex::new(r"<img(?:[^a-zA-Z>][^>]*)?>").expect("valid img regex"));

    // <br> → <br />
    let s = br_re.replace_all(html, "<br />").to_string();
    // <img ...> → <img ... />  (仅在尚未自闭合时)
    let s = img_re
        .replace_all(&s, |caps: &regex::Captures| {
            let tag = caps.get(0).unwrap().as_str();
            if tag.ends_with("/>") {
                tag.to_string()
            } else {
                let inner = &tag[..tag.len() - 1]; // 去掉末尾 '>'
                format!("{} />", inner)
            }
        })
        .to_string();
    s
}

/// HTML 正文/属性转义。
pub fn escape_html(s: &str) -> String {
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

/// HTML 属性值转义(双引号包裹的属性值)。
pub fn escape_html_attr(s: &str) -> String {
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

/// 扫描文本中的裸路径, 包装为 `<button class="md-path-link">`。
///
/// 流程:
/// 1. 用 `BARE_PATH_RE` 找出所有候选路径
/// 2. 对每个候选, 检查前一个字符是否为 `"` / `` ` `` / `>` (JS 的 `(?<!["`>])` 等效)
///    - 若是, 跳过该匹配 (避免在 HTML 属性内识别路径)
/// 3. 路径段输出 button (path 经 escape_html_attr 转义)
/// 4. 非路径段走 escape_html + wrap_cjk_text_segment
///
/// 与 JS 实现一致的行为:
/// - 路径长度 > 160 不包装 (regex 已限制 {2,160}, 不会匹配超长路径)
/// - 路径必须以 `.[A-Za-z0-9]{1,12}` 结尾 (必须有扩展名)
fn wrap_bare_paths_and_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
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

        // 输出路径段包装为 button (path 经 escape_html_attr 转义属性值, escape_html 转义文本)
        out.push_str(&format!(
            "<button type=\"button\" class=\"md-path-link\" data-path=\"{}\" title=\"{}\">{}</button>",
            escape_html_attr(path),
            escape_html_attr(path),
            escape_html(path),
        ));

        last_end = end;
    }

    // 输出剩余文本
    if last_end < text.len() {
        let rest = &text[last_end..];
        let escaped = escape_html(rest);
        let wrapped = wrap_cjk_text_segment(&escaped);
        out.push_str(&wrapped);
    }

    out
}

/// fence info string → 语言 id(首 token;c++ 等别名归一)。
/// 与 markdownPlugins.ts::langFromFenceInfo 一致。
pub fn lang_from_fence_info(info: &str) -> String {
    let trimmed = info.trim();
    let first_token = trimmed.split_whitespace().next().unwrap_or("");
    let stripped = first_token
        .strip_prefix("language-")
        .or_else(|| first_token.strip_prefix('.'))
        .unwrap_or(first_token);
    if stripped.is_empty() {
        return String::new();
    }
    let lower = stripped.to_lowercase();
    match lower.as_str() {
        "c++" => "cpp".to_string(),
        "c#" | "cs" => "csharp".to_string(),
        "js" | "jsx" => "javascript".to_string(),
        "kt" => "kotlin".to_string(),
        "ts" | "tsx" => "typescript".to_string(),
        "py" => "python".to_string(),
        "rb" => "ruby".to_string(),
        "rs" => "rust".to_string(),
        "sh" | "shell" | "zsh" | "ps1" | "powershell" => "bash".to_string(),
        "yml" => "yaml".to_string(),
        "md" => "markdown".to_string(),
        other => other.to_string(),
    }
}

/// 从 fence info string 提取 file="..." 属性值。
pub fn extract_file_path_from_fence_info(info: &str) -> Option<String> {
    let re = Lazy::new(|| Regex::new(r#"\bfile=(?:"([^"]*)"|(\S+))"#).expect("valid file regex"));
    re.captures(info).map(|c| {
        c.get(1)
            .or_else(|| c.get(2))
            .map(|m| m.as_str().to_string())
            .unwrap_or_default()
    })
}

/// 构建 fence 代码块的 HTML。
/// 与 markdownPlugins.ts::buildCodeFenceHtml 一致。
pub fn build_code_fence_html(body_raw: &str, lang: &str, file_path: Option<&str>) -> String {
    // 去尾部单个换行
    let body = body_raw.strip_suffix('\n').unwrap_or(body_raw);
    let inner = highlight_code(body, if lang.is_empty() { None } else { Some(lang) });
    build_code_fence_html_shell(lang, file_path, inner)
}

/// 构建 fence 代码块的 HTML (流式模式)。
/// 保持与 build_code_fence_html 相同的 HTML 外壳,
/// 但内部 code 内容用 escape_html 而非 syntect 高亮。
/// 这样流式期和完成态的 HTML 结构一致,切换时无视觉跳变。
fn build_code_fence_html_streaming(body_raw: &str, lang: &str, file_path: Option<&str>) -> String {
    let body = body_raw.strip_suffix('\n').unwrap_or(body_raw);
    let inner = escape_html(body);
    build_code_fence_html_shell(lang, file_path, inner)
}

/// 构建 fence 代码块的 HTML 外壳 (lang 徽章 / file 面包屑 / copy 按钮 / pre>code 结构)。
/// `inner` 为已高亮或已 escape 的 code 内容。
/// 高亮路径 (syntect) 与流式路径 (plain text) 共用此外壳,
/// 确保两种模式输出结构一致,切换 stream_mode 时无视觉跳变。
fn build_code_fence_html_shell(lang: &str, file_path: Option<&str>, inner: String) -> String {
    let lang_badge = if lang.is_empty() {
        String::new()
    } else {
        format!(
            "<span class=\"md-code-lang\" data-lang=\"{}\" aria-label=\"{}\">{}</span>",
            escape_html(lang),
            escape_html(lang),
            escape_html(lang)
        )
    };
    let block_attr = if lang.is_empty() {
        String::new()
    } else {
        format!(" data-lang=\"{}\"", escape_html(lang))
    };

    let breadcrumb = if let Some(fp) = file_path {
        let segments: Vec<&str> = fp.split('/').collect();
        let parts: Vec<String> = segments
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let is_last = i == segments.len() - 1;
                let cls = if is_last {
                    "md-code-breadcrumb-file"
                } else {
                    "md-code-breadcrumb-segment"
                };
                format!("<span class=\"{}\">{}</span>", cls, escape_html(s))
            })
            .collect();
        format!(
            "<span class=\"md-code-breadcrumb\">{}</span>",
            parts.join("<span class=\"md-code-breadcrumb-separator\">/</span>")
        )
    } else {
        String::new()
    };

    format!(
        "<div class=\"md-code-block\"{}>{}{}<button type=\"button\" class=\"md-code-copy\" title=\"复制\" aria-label=\"复制代码\">复制</button><pre class=\"md-code-pre hljs\"><code class=\"language-{}\">{}</code></pre></div>",
        block_attr,
        breadcrumb,
        lang_badge,
        escape_html(lang),
        inner
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
}