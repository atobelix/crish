//! GFM 表格辅助函数: 对齐属性生成、单元格切分、斑马纹计算。
//!
//! 直接移植自 apps/crish-desktop/src/api/markdown-render/markdownTable.ts。
//! pulldown-cmark 自动解析表格语法,本模块提供对齐 style / 行斑马纹 / 单元格切分工具。

use std::borrow::Cow;

/// 列对齐方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    /// 从 pulldown-cmark 的 Alignment 转换。
    pub fn from_pulldown(a: pulldown_cmark::Alignment) -> Self {
        match a {
            pulldown_cmark::Alignment::None => Align::Left,
            pulldown_cmark::Alignment::Left => Align::Left,
            pulldown_cmark::Alignment::Center => Align::Center,
            pulldown_cmark::Alignment::Right => Align::Right,
        }
    }
}

/// 生成对齐 style 属性。Left 是默认值,不输出 style。
pub fn table_cell_align_attr(align: Align) -> &'static str {
    match align {
        Align::Center => " style=\"text-align:center\"",
        Align::Right => " style=\"text-align:right\"",
        Align::Left => "",
    }
}

/// 对齐数组对齐到 col_count(缺列补 Left,多余截断)。
pub fn normalize_alignments(aligns: &[Align], col_count: usize) -> Vec<Align> {
    let mut out = Vec::with_capacity(col_count);
    for i in 0..col_count {
        out.push(aligns.get(i).copied().unwrap_or(Align::Left));
    }
    out
}

/// 计算斑马纹 class: 偶数索引行(0-based: 0, 2, 4...)无,奇数索引行有 `md-tr-alt`。
pub fn stripe_class(row_index_zero_based: usize) -> &'static str {
    if row_index_zero_based % 2 == 1 {
        " md-tr-alt"
    } else {
        ""
    }
}

// ── 兼容旧版 markdownTable.ts 的纯函数(用于 fallback / 测试) ──

/// 零分配判定单个分隔单元格是否满足 `^:?-{2,}:?$`（DEF-09）。
#[inline]
fn is_sep_cell(cell: &str) -> bool {
    let s = cell.strip_prefix(':').unwrap_or(cell);
    let s = s.strip_suffix(':').unwrap_or(s);
    s.len() >= 2 && s.bytes().all(|b| b == b'-')
}

/// 检测是否为表格分隔行: 至少两列分隔,避免把 `---` 水平线当表。
///
/// 采用流式切片扫描，零 Vec / String 堆分配（DEF-09）。
pub fn is_table_sep_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let core = t.strip_prefix('|').unwrap_or(t);
    let core = core.strip_suffix('|').unwrap_or(core);
    let mut count = 0usize;
    for cell in core.split('|').map(str::trim).filter(|c| !c.is_empty()) {
        if !is_sep_cell(cell) {
            return false;
        }
        count += 1;
    }
    count >= 2
}

/// 零拷贝流式表格单元格切分迭代器（DEF-09）。
///
/// 对不含 `\|` 转义管道的常规单元格直接返回 `Cow::Borrowed` 切片，
/// 仅在单元格含 `\|` 时按需构造解转义后的 `Cow::Owned` 字符串。
pub struct TableCells<'a> {
    rest: &'a str,
    done: bool,
}

impl<'a> TableCells<'a> {
    #[inline]
    pub fn new(line: &'a str) -> Self {
        let t = line.trim();
        let t = t.strip_prefix('|').unwrap_or(t);
        let t = t.strip_suffix('|').unwrap_or(t);
        Self {
            rest: t,
            done: false,
        }
    }
}

#[inline]
fn unescape_cell_cow(raw_cell: &str, has_escaped_pipe: bool) -> Cow<'_, str> {
    let trimmed = raw_cell.trim();
    if !has_escaped_pipe {
        return Cow::Borrowed(trimmed);
    }
    let bytes = trimmed.as_bytes();
    let mut out = String::with_capacity(trimmed.len());
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'|' {
            out.push_str(&trimmed[last..i]);
            out.push('|');
            i += 2;
            last = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&trimmed[last..]);
    Cow::Owned(out)
}

impl<'a> Iterator for TableCells<'a> {
    type Item = Cow<'a, str>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        let bytes = self.rest.as_bytes();
        let mut i = 0;
        let mut has_escaped_pipe = false;
        while i < bytes.len() {
            if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'|' {
                has_escaped_pipe = true;
                i += 2;
                continue;
            }
            if bytes[i] == b'|' {
                let raw_cell = &self.rest[..i];
                self.rest = &self.rest[i + 1..];
                return Some(unescape_cell_cow(raw_cell, has_escaped_pipe));
            }
            i += 1;
        }
        self.done = true;
        let raw_cell = self.rest;
        self.rest = "";
        Some(unescape_cell_cow(raw_cell, has_escaped_pipe))
    }
}

/// 返回流式零拷贝表格单元格迭代器（DEF-09）。
#[inline]
pub fn split_table_cells_iter(line: &str) -> TableCells<'_> {
    TableCells::new(line)
}

/// 切分表格单元格（零拷贝 `Cow` 版）：常规单元格零 String 分配（DEF-09）。
pub fn split_table_cells_cow(line: &str) -> Vec<Cow<'_, str>> {
    split_table_cells_iter(line).collect()
}

/// 切分表格单元格;支持 `\|` 转义管道(计入单元格正文,不作为列界)。
///
/// 内部复用流式切片状态机，消除行首尾剥离、`Vec<char>` 与中间累积缓冲区的连续堆分配（DEF-09）。
pub fn split_table_cells(line: &str) -> Vec<String> {
    split_table_cells_iter(line).map(Cow::into_owned).collect()
}

/// 从 GFM 分隔行解析列对齐: `---` / `:---` / `---:` / `:---:`
///
/// 直接在流式单元格切片上按字节扫描首尾对齐冒号，实现零 String 堆分配（DEF-09）。
pub fn parse_table_alignments(sep_line: &str) -> Vec<Align> {
    split_table_cells_iter(sep_line)
        .map(|c| {
            let bytes = c.as_bytes();
            let left = bytes.iter().copied().find(|&b| b != b'\\') == Some(b':');
            let right = bytes.iter().copied().rfind(|&b| b != b'\\') == Some(b':');
            if left && right {
                Align::Center
            } else if right {
                Align::Right
            } else {
                Align::Left
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sep_line_detects_min_two_cols() {
        assert!(is_table_sep_line("| --- | --- |"));
        assert!(is_table_sep_line(":---|---:"));
        assert!(!is_table_sep_line("---")); // 单列不算表
        assert!(!is_table_sep_line("not a sep"));
    }

    #[test]
    fn split_handles_escaped_pipe() {
        let cells = split_table_cells("| a \\| b | c |");
        assert_eq!(cells, vec!["a | b".to_string(), "c".to_string()]);
    }

    #[test]
    fn split_cow_borrows_unescaped_cells_without_allocation() {
        let cells = split_table_cells_cow("| col1 | col2 | a \\| b |");
        assert!(matches!(cells[0], Cow::Borrowed("col1")));
        assert!(matches!(cells[1], Cow::Borrowed("col2")));
        assert!(matches!(cells[2], Cow::Owned(_)));
        assert_eq!(cells[2].as_ref(), "a | b");
    }

    #[test]
    fn parse_alignments_handles_all_variants() {
        let aligns = parse_table_alignments("|:---|:---:|---:|---|");
        assert_eq!(
            aligns,
            vec![Align::Left, Align::Center, Align::Right, Align::Left]
        );
    }

    #[test]
    fn normalize_pads_and_truncates() {
        let aligns = vec![Align::Left, Align::Right];
        let normalized = normalize_alignments(&aligns, 4);
        assert_eq!(
            normalized,
            vec![Align::Left, Align::Right, Align::Left, Align::Left]
        );
    }

    #[test]
    fn stripe_class_marks_odd_rows() {
        assert_eq!(stripe_class(0), "");
        assert_eq!(stripe_class(1), " md-tr-alt");
        assert_eq!(stripe_class(2), "");
        assert_eq!(stripe_class(3), " md-tr-alt");
    }
}
