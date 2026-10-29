//! 块级结构：段落、标题、列表/任务项、引用/Callout、分割线。

use pulldown_cmark::{BlockQuoteKind, HeadingLevel};

use super::*;

impl Renderer {
    // ── 段落 ─────────────────────────────────────────────────────

    pub(super) fn start_paragraph(&mut self) {
        // 直接挂在列表项下的段落不包 <p>（保持既有列表 DOM 契约）；
        // 列表项内再嵌 blockquote 的段落属于 blockquote，需要正常 <p>。
        let direct_list_item = self.blockquote_stack.is_empty()
            && self
                .list_stack
                .last()
                .map(|list| list.item_open)
                .unwrap_or(false);

        if direct_list_item {
            let mut need_break = false;
            if let Some(list) = self.list_stack.last_mut() {
                need_break = list.item_paragraph_count > 0;
                list.item_paragraph_count += 1;
            }
            if need_break {
                self.push_str("<br>");
            }
            self.paragraph_in_list_item = true;
            self.paragraph_open = false;
            return;
        }

        self.paragraph_in_list_item = false;
        self.paragraph_open = true;
        self.push_str("<p class=\"md-p\">");
    }

    pub(super) fn end_paragraph(&mut self) {
        if self.paragraph_in_list_item {
            self.paragraph_in_list_item = false;
            return;
        }
        if self.paragraph_open {
            self.push_str("</p>");
            self.paragraph_open = false;
        }
    }

    // ── 行内标签 ─────────────────────────────────────────────────

    pub(super) fn start_inline_tag(&mut self, tag: &str) {
        if !self.image_stack.is_empty() {
            return;
        }
        self.push_str(tag);
    }

    pub(super) fn end_inline_tag(&mut self, tag: &str) {
        if !self.image_stack.is_empty() {
            return;
        }
        self.push_str(tag);
    }

    // ── 标题 ─────────────────────────────────────────────────────

    pub(super) fn start_heading(&mut self, level: HeadingLevel, explicit_id: Option<&str>) {
        self.capture_stack.push(Capture::Heading(HeadingCapture {
            level: heading_level(level),
            explicit_id: explicit_id.map(str::to_string),
            html: String::new(),
            plain: String::new(),
        }));
    }

    pub(super) fn end_heading(&mut self) {
        if let Some(Capture::Heading(cap)) = self.capture_stack.pop() {
            self.emit_heading(cap);
        }
    }

    // ── 列表 / 任务项 ─────────────────────────────────────────────

    pub(super) fn start_list(&mut self, start: Option<u64>) {
        let kind = match start {
            Some(_) => ListKind::Ordered,
            None => ListKind::Unordered,
        };
        let start_val = start.unwrap_or(1);
        let depth = self.list_stack.len();
        self.list_stack.push(ListState {
            kind,
            item_paragraph_count: 0,
            item_open: false,
        });

        let (tag, class) = match (kind, depth) {
            (ListKind::Ordered, 0) => ("ol", "md-ol"),
            (ListKind::Ordered, _) => ("ol", "md-ol md-ol-nested"),
            (ListKind::Unordered, 0) => ("ul", "md-ul"),
            (ListKind::Unordered, _) => ("ul", "md-ul md-ul-nested"),
        };
        self.push_str("<");
        self.push_str(tag);
        self.push_str(" class=\"");
        self.push_str(class);
        self.push_str("\"");
        if matches!(kind, ListKind::Ordered) && start_val > 1 {
            self.push_str(&format!(" start=\"{start_val}\""));
        }
        self.push_str(">");
    }

    pub(super) fn end_list(&mut self) {
        if let Some(list) = self.list_stack.pop() {
            self.push_str(match list.kind {
                ListKind::Ordered => "</ol>",
                ListKind::Unordered => "</ul>",
            });
        }
    }

    pub(super) fn start_item(&mut self) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_open = true;
            list.item_paragraph_count = 0;
        }
        let li_class = match self.list_stack.last().map(|list| list.kind) {
            Some(ListKind::Ordered) => "<li class=\"md-li md-ol-item\">",
            _ => "<li class=\"md-li\">",
        };
        self.push_str(li_class);
    }

    pub(super) fn end_item(&mut self) {
        if let Some(list) = self.list_stack.last_mut() {
            list.item_open = false;
        }
        self.push_str("</li>");
    }

    pub(super) fn handle_task_marker(&mut self, checked: bool) {
        // 把刚打开的当前 <li> 原地替换为任务项，再输出 checkbox。
        let replacement = "<li class=\"md-li md-task-item\">";
        let buffer = self.current_buffer_mut();
        if let Some(pos) = buffer.rfind("<li") {
            if let Some(rel_end) = buffer[pos..].find('>') {
                let end = pos + rel_end + 1;
                buffer.replace_range(pos..end, replacement);
            }
        }

        if checked {
            self.push_str(
                "<input type=\"checkbox\" class=\"md-task-checkbox\" checked disabled>",
            );
        } else {
            self.push_str("<input type=\"checkbox\" class=\"md-task-checkbox\" disabled>");
        }
    }

    // ── 引用 / Callout ───────────────────────────────────────────

    pub(super) fn start_blockquote(&mut self, kind: Option<BlockQuoteKind>) {
        self.blockquote_stack.push(kind);
        match kind {
            None => self.push_str("<blockquote class=\"md-quote\">"),
            Some(kind) => {
                let name = callout_name(kind);
                let html = format!(
                    "<div class=\"md-callout md-callout-{name}\"><div class=\"md-callout-title\" data-callout-title=\"{name}\"></div><div class=\"md-callout-body\">"
                );
                self.push_str(&html);
            }
        }
    }

    pub(super) fn end_blockquote(&mut self) {
        match self.blockquote_stack.pop() {
            Some(None) => self.push_str("</blockquote>"),
            Some(Some(_)) => self.push_str("</div></div>"),
            None => {}
        }
    }

    pub(super) fn handle_rule(&mut self) {
        self.push_str("<hr class=\"md-hr\">");
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn callout_name(kind: BlockQuoteKind) -> &'static str {
    match kind {
        BlockQuoteKind::Note => "note",
        BlockQuoteKind::Tip => "tip",
        BlockQuoteKind::Important => "important",
        BlockQuoteKind::Warning => "warning",
        BlockQuoteKind::Caution => "caution",
    }
}
