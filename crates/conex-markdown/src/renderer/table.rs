//! 表格渲染与分隔行补齐预处理。

use std::borrow::Cow;

use super::*;
use crate::table::{
    is_table_sep_line, normalize_alignments, split_table_cells, table_cell_align_attr, Align,
};

impl Renderer {
    pub(super) fn start_table(&mut self, alignments: Vec<pulldown_cmark::Alignment>) {
        let aligns: Vec<Align> = alignments
            .into_iter()
            .map(Align::from_pulldown)
            .collect();
        let col_count = aligns.len().max(1);
        self.table = Some(TableState {
            alignments: aligns,
            col_count,
            in_thead: false,
            cell_index: 0,
            has_body: false,
        });
        let html = format!(
            "<div class=\"md-table-wrap\" role=\"region\" data-md-table=\"true\"><table class=\"md-table\" style=\"--md-table-cols:{col_count}\">"
        );
        self.push_str(&html);
    }

    pub(super) fn end_table(&mut self) {
        let has_body = self
            .table
            .as_ref()
            .map(|table| table.has_body)
            .unwrap_or(false);
        if has_body {
            self.push_str("</tbody>");
        } else {
            self.push_str("<tbody></tbody>");
        }
        self.table = None;
        self.push_str("</table></div>");
    }

    pub(super) fn start_table_head(&mut self) {
        if let Some(table) = &mut self.table {
            table.in_thead = true;
            table.cell_index = 0;
        }
        self.push_str("<thead><tr class=\"md-tr\">");
    }

    pub(super) fn end_table_head(&mut self) {
        if let Some(table) = &mut self.table {
            table.in_thead = false;
            if table.cell_index > 0 {
                table.col_count = table.cell_index;
                table.alignments = normalize_alignments(&table.alignments, table.col_count);
            }
        }
        self.push_str("</tr></thead>");
    }

    pub(super) fn start_table_row(&mut self) {
        let mut open_tbody = false;
        let mut open_tr = false;
        if let Some(table) = &mut self.table {
            table.cell_index = 0;
            if !table.in_thead {
                open_tbody = !table.has_body;
                table.has_body = true;
                open_tr = true;
            }
        }
        if open_tbody {
            self.push_str("<tbody>");
        }
        if open_tr {
            self.push_str("<tr class=\"md-tr\">");
        }
    }

    pub(super) fn end_table_row(&mut self) {
        let mut padding: Vec<Align> = Vec::new();
        if let Some(table) = &mut self.table {
            if !table.in_thead {
                while table.cell_index < table.col_count {
                    let align = table
                        .alignments
                        .get(table.cell_index)
                        .copied()
                        .unwrap_or(Align::Left);
                    padding.push(align);
                    table.cell_index += 1;
                }
            }
        }
        for align in padding {
            self.push_str("<td class=\"md-td\"");
            self.push_str(table_cell_align_attr(align));
            self.push_str("></td>");
        }
        self.push_str("</tr>");
    }

    pub(super) fn start_table_cell(&mut self) {
        let (is_head, align) = match &self.table {
            Some(table) => (
                table.in_thead,
                table
                    .alignments
                    .get(table.cell_index)
                    .copied()
                    .unwrap_or(Align::Left),
            ),
            None => (false, Align::Left),
        };
        if is_head {
            self.push_str("<th class=\"md-th\" scope=\"col\"");
        } else {
            self.push_str("<td class=\"md-td\"");
        }
        self.push_str(table_cell_align_attr(align));
        self.push_str(">");
    }

    pub(super) fn end_table_cell(&mut self) {
        let is_head = self
            .table
            .as_ref()
            .map(|table| table.in_thead)
            .unwrap_or(false);
        self.push_str(if is_head { "</th>" } else { "</td>" });
        if let Some(table) = &mut self.table {
            table.cell_index += 1;
        }
    }
}

/// 表格预处理总入口。
///
/// pulldown-cmark 0.12 的表格解析不会忽略代码跨度内的 `|`，会把
/// `` `a | b` `` 拆成两列。这里在表格行内把 code span 的 `|` 替换为
/// 一个源文本中不存在的私有区占位符，渲染后再还原。占位符只可能由本函数
/// 插入，因此全局还原是安全的；非表格区域的 code span 不受影响。
pub(super) fn prepare_tables(md: &str) -> (Cow<'_, str>, Option<String>) {
    if !md.contains('|') || !md.contains('`') {
        return (normalize_table_separators(md), None);
    }

    let lines: Vec<&str> = md.lines().collect();
    let mut protected_lines: Vec<String> = Vec::with_capacity(lines.len());
    let mut changed = false;
    let mut placeholder: Option<String> = None;
    let mut i = 0usize;

    while i < lines.len() {
        let is_table_start =
            lines[i].contains('|') && i + 1 < lines.len() && is_table_sep_line(lines[i + 1]);
        if is_table_start {
            let mut end = i;
            while end < lines.len()
                && !lines[end].trim().is_empty()
                && lines[end].contains('|')
            {
                end += 1;
            }
            let token = placeholder.get_or_insert_with(|| choose_placeholder(md));
            for line in &lines[i..end] {
                let (protected, line_changed) = protect_code_span_pipes(line, token);
                changed |= line_changed;
                protected_lines.push(protected);
            }
            i = end;
            continue;
        }
        protected_lines.push(lines[i].to_string());
        i += 1;
    }

    if !changed {
        return (normalize_table_separators(md), None);
    }

    let mut rebuilt = protected_lines.join("\n");
    if md.ends_with('\n') {
        rebuilt.push('\n');
    }
    let padded = normalize_table_separators(&rebuilt);
    let text = match padded {
        Cow::Borrowed(_) => rebuilt,
        Cow::Owned(owned) => owned,
    };
    (Cow::Owned(text), placeholder)
}

fn choose_placeholder(source: &str) -> String {
    let mut candidate = String::from('\u{E000}');
    while source.contains(&candidate) {
        candidate.push('\u{E000}');
    }
    candidate
}

/// 把一行中 code span 内的 `|` 替换为占位符。返回 (新行, 是否变化)。
fn protect_code_span_pipes(line: &str, placeholder: &str) -> (String, bool) {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    let mut code_ticks = 0usize;
    let mut changed = false;

    while i < bytes.len() {
        if bytes[i] == b'`' {
            if code_ticks == 0 && is_escaped(bytes, i) {
                out.push('`');
                i += 1;
                continue;
            }
            let mut run = 0usize;
            while i + run < bytes.len() && bytes[i + run] == b'`' {
                run += 1;
            }
            if code_ticks == 0 {
                code_ticks = run;
            } else if run == code_ticks {
                code_ticks = 0;
            }
            out.push_str(&line[i..i + run]);
            i += run;
            continue;
        }

        if code_ticks > 0 && bytes[i] == b'|' {
            out.push_str(placeholder);
            changed = true;
            i += 1;
            continue;
        }

        let ch_len = line[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        out.push_str(&line[i..i + ch_len]);
        i += ch_len;
    }

    (out, changed)
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let mut backslashes = 0usize;
    let mut i = index;
    while i > 0 && bytes[i - 1] == b'\\' {
        backslashes += 1;
        i -= 1;
    }
    backslashes % 2 == 1
}

/// 预处理：分隔行列数少于表头列数时补齐 `---`，避免 pulldown-cmark
/// 直接退化为普通段落（LLM 输出常见短分隔行）。
fn normalize_table_separators(md: &str) -> Cow<'_, str> {
    if !md.contains('|') {
        return Cow::Borrowed(md);
    }

    let lines: Vec<&str> = md.lines().collect();
    let mut needs_padding = false;
    for i in 0..lines.len().saturating_sub(1) {
        let current = lines[i];
        if current.contains('|') && is_table_sep_line(lines[i + 1]) {
            let header_cells = split_table_cells(current);
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
    let mut i = 0usize;
    while i < lines.len() {
        let current = lines[i];
        if i + 1 < lines.len() && current.contains('|') && is_table_sep_line(lines[i + 1]) {
            let header_cells = split_table_cells(current);
            let sep_cells = split_table_cells(lines[i + 1]);
            if header_cells.len() > sep_cells.len() && header_cells.len() >= 2 {
                let indent: String = current
                    .chars()
                    .take_while(|c| *c == ' ' || *c == '\t')
                    .collect();
                let mut new_sep = indent;
                new_sep.push('|');
                for (index, _) in header_cells.iter().enumerate() {
                    new_sep.push(' ');
                    if index < sep_cells.len() {
                        new_sep.push_str(sep_cells[index].as_str());
                    } else {
                        new_sep.push_str("---");
                    }
                    new_sep.push(' ');
                    new_sep.push('|');
                }
                out.push_str(current);
                out.push('\n');
                out.push_str(&new_sep);
                if i + 1 < lines.len() {
                    out.push('\n');
                }
                i += 2;
                continue;
            }
        }
        out.push_str(current);
        if i + 1 < lines.len() {
            out.push('\n');
        }
        i += 1;
    }

    if md.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(text: &str) -> String {
        render_markdown(text, RenderOptions::chat()).html
    }

    #[test]
    fn code_span_pipe_does_not_tear_columns() {
        let html = render("| expr | desc |\n| --- | --- |\n| `a | b` | bitwise |");
        assert_eq!(html.matches("<th class=\"md-th\"").count(), 2);
        assert_eq!(html.matches("<td class=\"md-td\"").count(), 2);
        assert!(html.contains("md-inline-code"));
        assert!(html.contains("a | b"));
    }

    #[test]
    fn short_separator_is_padded_so_table_parses() {
        let html = render("| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |");
        assert!(html.contains("<table"));
        assert_eq!(html.matches("<th class=\"md-th\"").count(), 3);
    }

    #[test]
    fn header_only_table_has_empty_tbody() {
        let html = render("| A | B |\n| --- | --- |");
        assert!(html.contains("<tbody></tbody>"));
    }

    #[test]
    fn short_row_is_padded_to_column_count() {
        let html = render("| A | B | C |\n| --- | --- | --- |\n| 1 |");
        assert!(html.contains("<td class=\"md-td\"></td>"));
        assert_eq!(html.matches("<td class=\"md-td\"").count(), 3);
    }

    #[test]
    fn alignment_attributes_are_emitted() {
        let html = render("| A | B |\n| :--- | ---: |\n| 1 | 2 |");
        assert!(html.contains("style=\"text-align:right\""));
    }

    #[test]
    fn table_wrapper_has_column_count_variable() {
        let html = render("| A | B |\n| --- | --- |\n| 1 | 2 |");
        assert!(html.contains("--md-table-cols:2"));
    }
}
