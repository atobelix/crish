//! GFM 表格辅助函数: 对齐属性生成、单元格切分、斑马纹计算。
//!
//! 直接移植自 apps/crish-desktop/src/api/markdown-render/markdownTable.ts。
//! pulldown-cmark 自动解析表格语法,本模块提供对齐 style / 行斑马纹 / 单元格切分工具。

use once_cell::sync::Lazy;
use regex::Regex;

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

static TABLE_SEP_CELL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^:?-{2,}:?$").expect("valid sep cell regex"));

/// 检测是否为表格分隔行: 至少两列分隔,避免把 `---` 水平线当表。
pub fn is_table_sep_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let core = t.strip_prefix('|').unwrap_or(t);
    let core = core.strip_suffix('|').unwrap_or(core);
    let cells: Vec<&str> = core
        .split('|')
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();
    if cells.len() < 2 {
        return false;
    }
    cells.iter().all(|c| TABLE_SEP_CELL_RE.is_match(c))
}

/// 切分表格单元格;支持 `\|` 转义管道(计入单元格正文,不作为列界)。
pub fn split_table_cells(line: &str) -> Vec<String> {
    let mut t = line.trim().to_string();
    if t.starts_with('|') {
        t = t[1..].to_string();
    }
    if t.ends_with('|') {
        t = t[..t.len() - 1].to_string();
    }
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let bytes: Vec<char> = t.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '\\' && i + 1 < bytes.len() && bytes[i + 1] == '|' {
            cur.push('|');
            i += 2;
            continue;
        }
        if bytes[i] == '|' {
            cells.push(cur.trim().to_string());
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(bytes[i]);
        i += 1;
    }
    cells.push(cur.trim().to_string());
    cells
}

/// 从 GFM 分隔行解析列对齐: `---` / `:---` / `---:` / `:---:`
pub fn parse_table_alignments(sep_line: &str) -> Vec<Align> {
    split_table_cells(sep_line)
        .iter()
        .map(|c| {
            let norm: String = c.chars().filter(|ch| *ch != '\\').collect();
            let left = norm.starts_with(':');
            let right = norm.ends_with(':');
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
