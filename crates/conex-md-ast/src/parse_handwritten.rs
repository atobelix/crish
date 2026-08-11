//! **退役**手写行解析（W2-A 前主路径）。
//!
//! # 状态
//! - **非默认**：权威 P 为 `markdown-rs`（见 [`crate::parse`] / [`crate::PARSE_BACKEND`]）
//! - 保留用途：回归对照、调试、必要时显式回退
//! - **禁止**双 P 长期并存叙事：本模块不得重新标为默认
//!
//! # 嵌套规则
//! 与主路径共用 [`crate::assemble`] 容器栈。

use crate::assemble::{RawBlock, assemble_tree};
use crate::{
    BlockId, BlockKind, BlockTree, LossyReport, MdError, ParseOutput, block_id_from_comment,
};
use std::collections::HashSet;

/// 退役手写 P：解析为块树。
///
/// 请使用 [`crate::parse_document`]（markdown-rs 主路径）。
#[deprecated(note = "手写行解析已退役；默认 parse_document 走 markdown-rs（W2-A）")]
#[allow(deprecated)]
pub fn parse_document_handwritten(md: &str) -> Result<BlockTree, MdError> {
    Ok(parse_document_detailed_handwritten(md)?.tree)
}

/// 退役手写 P：解析并附带有损报告。
#[deprecated(note = "手写行解析已退役；默认 parse_document_detailed 走 markdown-rs（W2-A）")]
pub fn parse_document_detailed_handwritten(md: &str) -> Result<ParseOutput, MdError> {
    let lines: Vec<&str> = md.lines().collect();
    let mut lossy = LossyReport::default();
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut i = 0usize;
    let mut seen_ids: HashSet<BlockId> = HashSet::new();

    while i < lines.len() {
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }

        let line_no = i + 1;
        let mut id = None;

        if let Some(bid) = block_id_from_comment(lines[i].trim()) {
            if !seen_ids.insert(bid) {
                let fresh = BlockId::new();
                lossy.push(
                    "duplicate_block_id",
                    format!("line {line_no}: 重复 ID {bid} → 重分配为 {fresh}"),
                    Some(line_no),
                );
                id = Some(fresh);
            } else {
                id = Some(bid);
            }
            i += 1;
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
        } else {
            lossy.push(
                "missing_block_id",
                format!("line {line_no}: 块缺少 <!--c:UUID-->，已生成新 ID"),
                Some(line_no),
            );
        }

        if i >= lines.len() {
            let bid = id.unwrap_or_else(BlockId::new);
            blocks.push(RawBlock {
                id: bid,
                kind: BlockKind::Paragraph,
                text: String::new(),
                line: line_no,
            });
            break;
        }

        let (kind, text, consumed, note) = take_block_content(&lines, i);
        if let Some(n) = note {
            lossy.push("structure_note", n, Some(i + 1));
        }
        let bid = id.unwrap_or_else(BlockId::new);
        if id.is_none() {
            seen_ids.insert(bid);
        }
        blocks.push(RawBlock {
            id: bid,
            kind,
            text,
            line: line_no,
        });
        i += consumed;
    }

    let tree = assemble_tree(&blocks)?;
    Ok(ParseOutput { tree, lossy })
}

fn take_block_content(lines: &[&str], start: usize) -> (BlockKind, String, usize, Option<String>) {
    let first = lines[start];
    let trimmed = first.trim_end();

    if let Some(rest) = trimmed.strip_prefix("```") {
        let _lang = rest.trim();
        let mut body: Vec<&str> = Vec::new();
        let mut j = start + 1;
        while j < lines.len() {
            if lines[j].trim_start().starts_with("```") {
                j += 1;
                break;
            }
            body.push(lines[j]);
            j += 1;
        }
        let text = body.join("\n");
        return (BlockKind::Code, text, j - start, None);
    }

    if let Some((level, text)) = parse_atx_heading(trimmed) {
        return (BlockKind::Heading { level }, text, 1, None);
    }

    if is_thematic_break(trimmed) {
        return (BlockKind::Divider, String::new(), 1, None);
    }

    if let Some(text) = strip_bullet_marker(trimmed) {
        let (extra, n) = take_continuation(lines, start + 1);
        let mut full = text;
        if !extra.is_empty() {
            full.push('\n');
            full.push_str(&extra);
        }
        return (BlockKind::BulletItem, full, 1 + n, None);
    }
    if let Some(text) = strip_ordered_marker(trimmed) {
        let (extra, n) = take_continuation(lines, start + 1);
        let mut full = text;
        if !extra.is_empty() {
            full.push('\n');
            full.push_str(&extra);
        }
        return (BlockKind::OrderedItem, full, 1 + n, None);
    }

    if let Some(text) = strip_quote_marker(trimmed) {
        let mut parts = vec![text];
        let mut j = start + 1;
        while j < lines.len() {
            let t = lines[j].trim_end();
            if t.is_empty() || block_id_from_comment(t.trim()).is_some() {
                break;
            }
            if let Some(q) = strip_quote_marker(t) {
                parts.push(q);
                j += 1;
            } else {
                break;
            }
        }
        return (BlockKind::Quote, parts.join("\n"), j - start, None);
    }

    let mut parts: Vec<&str> = vec![trimmed];
    let mut j = start + 1;
    let mut note = None;
    while j < lines.len() {
        let t = lines[j];
        if t.trim().is_empty() {
            break;
        }
        if block_id_from_comment(t.trim()).is_some() {
            break;
        }
        if looks_like_block_start(t.trim_end()) {
            break;
        }
        parts.push(t.trim_end());
        j += 1;
    }
    let joined = parts.join("\n");
    if joined.contains('|') && parts.len() >= 2 {
        note = Some("可能含表格；结构-only 按段落保留原文".into());
    }
    (BlockKind::Paragraph, joined, j - start, note)
}

fn take_continuation(lines: &[&str], start: usize) -> (String, usize) {
    let mut parts: Vec<&str> = Vec::new();
    let mut j = start;
    while j < lines.len() {
        let t = lines[j];
        if t.trim().is_empty() {
            break;
        }
        if block_id_from_comment(t.trim()).is_some() {
            break;
        }
        if looks_like_block_start(t.trim_end()) {
            break;
        }
        parts.push(t.trim_end());
        j += 1;
    }
    (parts.join("\n"), j - start)
}

fn looks_like_block_start(line: &str) -> bool {
    parse_atx_heading(line).is_some()
        || strip_bullet_marker(line).is_some()
        || strip_ordered_marker(line).is_some()
        || line.trim_start().starts_with("```")
        || is_thematic_break(line)
        || strip_quote_marker(line).is_some()
}

fn parse_atx_heading(line: &str) -> Option<(u8, String)> {
    let mut n = 0usize;
    let bytes = line.as_bytes();
    while n < bytes.len() && bytes[n] == b'#' {
        n += 1;
    }
    if n == 0 || n > 6 {
        return None;
    }
    if n < bytes.len() && bytes[n] != b' ' && bytes[n] != b'\t' {
        return None;
    }
    let text = line[n..].trim().to_string();
    Some((n as u8, text))
}

fn strip_bullet_marker(line: &str) -> Option<String> {
    let t = line.trim_start();
    for prefix in ["- ", "* ", "+ "] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return Some(rest.to_string());
        }
    }
    if matches!(t, "-" | "*" | "+") {
        return Some(String::new());
    }
    None
}

fn strip_ordered_marker(line: &str) -> Option<String> {
    let t = line.trim_start();
    let mut i = 0usize;
    let b = t.as_bytes();
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    if i < b.len() && b[i] == b'.' {
        let rest = &t[i + 1..];
        if rest.is_empty() {
            return Some(String::new());
        }
        if rest.starts_with(' ') || rest.starts_with('\t') {
            return Some(rest.trim_start().to_string());
        }
    }
    None
}

fn strip_quote_marker(line: &str) -> Option<String> {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix("> ") {
        return Some(rest.to_string());
    }
    if t == ">" {
        return Some(String::new());
    }
    None
}

fn is_thematic_break(line: &str) -> bool {
    let t = line.trim();
    if t.len() < 3 {
        return false;
    }
    let chars: Vec<char> = t.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.len() < 3 {
        return false;
    }
    let c0 = chars[0];
    if !matches!(c0, '-' | '*' | '_') {
        return false;
    }
    chars.iter().all(|&c| c == c0)
}
