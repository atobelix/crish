//! Memory 后端极简 MD 行解析（SD-01 纵向切开）
//!
//! **≠** 真 md-ast / P 路径；仅 dev/test Memory 伪实现用。
//! **≠ EL-05**；不宣称 Store 解析完成。

/// 极简 MD 行 → 块草案（kind, text, level）
pub(crate) fn parse_md_lines(markdown: &str) -> Vec<(String, String, u32)> {
    let mut out = Vec::new();
    for line in markdown.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            continue;
        }
        if let Some(level) = parse_atx_heading(trimmed) {
            let title = trimmed.trim_start_matches('#').trim().to_string();
            out.push(("heading".to_string(), title, level));
        } else {
            out.push(("paragraph".to_string(), trimmed.to_string(), 0));
        }
    }
    // 空 markdown → 不插块（合法 no-op 插入 0）
    out
}

/// 解析 ATX 标题级别（1..=6）；非 ATX → None
pub(crate) fn parse_atx_heading(line: &str) -> Option<u32> {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && bytes[i] == b'#' {
        i += 1;
    }
    if i == 0 || i > 6 {
        return None;
    }
    // ATX 后须空白或行尾
    if i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'\t' {
        return None;
    }
    Some(i as u32)
}

/// seed 时 level 由调用方 kind 决定；此处兜底 1
pub(crate) fn parse_heading_level_from_text(_text: &str) -> Option<u32> {
    Some(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_atx_levels_and_paragraph() {
        let lines = parse_md_lines("# H1\n\nbody\n## H2");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], ("heading".into(), "H1".into(), 1));
        assert_eq!(lines[1], ("paragraph".into(), "body".into(), 0));
        assert_eq!(lines[2], ("heading".into(), "H2".into(), 2));
    }

    #[test]
    fn empty_markdown_is_noop() {
        assert!(parse_md_lines("").is_empty());
        assert!(parse_md_lines("\n\n  \n").is_empty());
    }
}
