//! GFM 表格辅助：对齐属性、分隔行识别与 code-span 感知的单元格切分。
//!
//! 主渲染由 pulldown-cmark 完成；本模块只服务两件事：
//! 1. 渲染器的对齐 style 生成；
//! 2. 预处理：LLM 常输出分隔行列数少于表头列数的“短分隔行”，
//!    pulldown-cmark 会因此不识别为表格，需要补齐。
//!
//! 单元格切分必须识别反引号代码跨度：`` `a | b` `` 中的 `|` 不是列分隔符。

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

/// 生成对齐 style 属性。Left 是默认值，不输出 style。
pub fn table_cell_align_attr(align: Align) -> &'static str {
    match align {
        Align::Center => " style=\"text-align:center\"",
        Align::Right => " style=\"text-align:right\"",
        Align::Left => "",
    }
}

/// 对齐数组对齐到 col_count（缺列补 Left，多余截断）。
pub fn normalize_alignments(aligns: &[Align], col_count: usize) -> Vec<Align> {
    let mut out = Vec::with_capacity(col_count);
    for i in 0..col_count {
        out.push(aligns.get(i).copied().unwrap_or(Align::Left));
    }
    out
}

/// 切分表格单元格。
///
/// - 支持 `\|` 转义管道（计入单元格正文，不作为列界）；
/// - 支持 `` `...` `` / ``` ``...`` ``` 代码跨度：跨度内的 `|` 不是列界；
/// - 行首/行尾的可选 `|` 是分隔符，不产生额外空单元格；
/// - 每个单元格 trim。
pub fn split_table_cells(line: &str) -> Vec<String> {
    let t = line.trim();
    let bytes = t.as_bytes();
    let mut i = 0usize;

    // 行首可选分隔符
    if i < bytes.len() && bytes[i] == b'|' {
        i += 1;
    }

    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut code_ticks = 0usize;
    let mut ended_with_delimiter = false;

    while i < bytes.len() {
        let b = bytes[i];
        if b == b'`' {
            let mut run = 0usize;
            while i + run < bytes.len() && bytes[i + run] == b'`' {
                run += 1;
            }
            if code_ticks == 0 {
                code_ticks = run;
            } else if run == code_ticks {
                code_ticks = 0;
            }
            for _ in 0..run {
                cur.push('`');
            }
            i += run;
            ended_with_delimiter = false;
            continue;
        }

        if code_ticks == 0 && b == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'|' {
            cur.push('|');
            i += 2;
            ended_with_delimiter = false;
            continue;
        }

        if code_ticks == 0 && b == b'|' {
            cells.push(cur.trim().to_string());
            cur.clear();
            ended_with_delimiter = true;
            i += 1;
            continue;
        }

        let ch_len = t[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        cur.push_str(&t[i..i + ch_len]);
        i += ch_len;
        ended_with_delimiter = false;
    }

    if !ended_with_delimiter || cells.is_empty() {
        cells.push(cur.trim().to_string());
    }
    cells
}

/// 检测是否为表格分隔行：至少两列，且每列都满足 `^:?-{2,}:?$`。
///
/// 用与渲染一致的单元格切分，避免 `\|` 或代码跨度造成误判。
pub fn is_table_sep_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || !t.contains('|') {
        return false;
    }
    let cells = split_table_cells(t);
    if cells.len() < 2 {
        return false;
    }
    cells.iter().all(|cell| is_sep_cell(cell))
}

#[inline]
fn is_sep_cell(cell: &str) -> bool {
    let s = cell.strip_prefix(':').unwrap_or(cell);
    let s = s.strip_suffix(':').unwrap_or(s);
    s.len() >= 2 && s.bytes().all(|b| b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sep_line_detects_min_two_cols() {
        assert!(is_table_sep_line("| --- | --- |"));
        assert!(is_table_sep_line(":---|---:"));
        assert!(!is_table_sep_line("---"));
        assert!(!is_table_sep_line("not a sep"));
    }

    #[test]
    fn split_handles_escaped_pipe() {
        let cells = split_table_cells("| a \\| b | c |");
        assert_eq!(cells, vec!["a | b".to_string(), "c".to_string()]);
    }

    #[test]
    fn split_handles_pipe_inside_code_span() {
        let cells = split_table_cells("| `a | b` | `x` |");
        assert_eq!(cells, vec!["`a | b`".to_string(), "`x`".to_string()]);
    }

    #[test]
    fn split_handles_double_backtick_code_span() {
        let cells = split_table_cells("| ``a | b`` | c |");
        assert_eq!(cells, vec!["``a | b``".to_string(), "c".to_string()]);
    }

    #[test]
    fn split_keeps_empty_cells_between_delimiters() {
        assert_eq!(split_table_cells("| | |"), vec!["".to_string(), "".to_string()]);
        assert_eq!(split_table_cells("||"), vec!["".to_string()]);
    }

    #[test]
    fn split_without_outer_pipes() {
        assert_eq!(
            split_table_cells("a | b"),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(
            split_table_cells("a | b |"),
            vec!["a".to_string(), "b".to_string()]
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
}
