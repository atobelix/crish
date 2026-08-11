//! Conex-MD 解析：契约字符串 → `BlockTree`。
//!
//! # 结构-only（W2-A）手写行解析
//! 钉死 ID 落位 + Heading / Paragraph / BulletItem 骨架与父子守恒。
//! **W2 后续**可换完整 `markdown-rs` 基座；本模块保持 P/S 对外契约不变。
//!
//! # 嵌套规则（容器栈）
//! - **容器**：`Heading{level}`（秩=level）、`BulletItem` / `OrderedItem` / `Quote`（秩=10）
//! - **叶子**：`Paragraph`、`Code`、`Divider`、`Unknown` —— 挂到当前栈顶，不入栈
//! - 新容器：弹出栈中秩 ≥ 自身的容器后，挂到新栈顶（或根），再入栈
//! - 与 `serialize` 的 DFS 落位对齐，保证 `P(S(t))` 在 ID/kind/父子/plain 文本上守恒
//!   （限：树中不在叶子 kind 下挂子节点；golden / 往返测遵守此模型）

use crate::{
    BlockId, BlockKind, BlockNode, BlockProps, BlockTree, LossyItem, LossyReport, MdError,
    block_id_from_comment,
};
use std::collections::{HashMap, HashSet};

/// 解析 Conex-MD（或可容忍的 plain GFM 子集）为块树。
pub fn parse_document(md: &str) -> Result<BlockTree, MdError> {
    Ok(parse_document_detailed(md)?.tree)
}

/// 解析并附带有损点报告。
pub fn parse_document_detailed(md: &str) -> Result<ParseOutput, MdError> {
    let lines: Vec<&str> = md.lines().collect();
    let mut lossy = LossyReport::default();
    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut i = 0usize;
    let mut seen_ids: HashSet<BlockId> = HashSet::new();

    while i < lines.len() {
        // 跳过块之间的空行
        if lines[i].trim().is_empty() {
            i += 1;
            continue;
        }

        let line_no = i + 1;
        let mut id = None;

        if let Some(bid) = block_id_from_comment(lines[i].trim()) {
            if !seen_ids.insert(bid) {
                // 重复 ID：后者分配新 ID 并记 lossy（规格 §4.2）
                let fresh = BlockId::new();
                lossy.items.push(LossyItem {
                    code: "duplicate_block_id".into(),
                    detail: format!("line {line_no}: 重复 ID {bid} → 重分配为 {fresh}"),
                    line: Some(line_no),
                });
                id = Some(fresh);
            } else {
                id = Some(bid);
            }
            i += 1;
            // ID 行后允许紧跟空行再内容
            while i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
        } else {
            lossy.items.push(LossyItem {
                code: "missing_block_id".into(),
                detail: format!("line {line_no}: 块缺少 <!--c:UUID-->，已生成新 ID"),
                line: Some(line_no),
            });
        }

        if i >= lines.len() {
            // 仅有 ID 无内容：空段落
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
            lossy.items.push(LossyItem {
                code: "structure_note".into(),
                detail: n,
                line: Some(i + 1),
            });
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

/// 解析结果（树 + 有损报告）。
#[derive(Debug, Clone)]
pub struct ParseOutput {
    pub tree: BlockTree,
    pub lossy: LossyReport,
}

struct RawBlock {
    id: BlockId,
    kind: BlockKind,
    text: String,
    #[allow(dead_code)]
    line: usize,
}

/// 从 `start` 起消费一个块的内容行，返回 (kind, text, 消费行数, 可选 note)。
fn take_block_content(lines: &[&str], start: usize) -> (BlockKind, String, usize, Option<String>) {
    let first = lines[start];
    let trimmed = first.trim_end();

    // 围栏代码（结构-only 轻量识别）
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

    // ATX 标题
    if let Some((level, text)) = parse_atx_heading(trimmed) {
        return (BlockKind::Heading { level }, text, 1, None);
    }

    // 分割线
    if is_thematic_break(trimmed) {
        return (BlockKind::Divider, String::new(), 1, None);
    }

    // 无序/有序列表项（单行内容；续行暂并入 text）
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

    // 引用
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

    // 默认段落：读到空行或下一 ID 行
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
        // 若遇到明显新块起始标记，结束当前段落
        if looks_like_block_start(t.trim_end()) {
            break;
        }
        parts.push(t.trim_end());
        j += 1;
    }
    // 探测未支持结构的粗提示
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
        // 列表续行通常缩进；结构-only 原样吞入
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
    // 需空白分隔或行尾（空标题）
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
    // 单独 "-" 空项
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

/// 容器秩：越小越高；叶子返回 None。
fn container_rank(kind: &BlockKind) -> Option<u8> {
    match kind {
        BlockKind::Heading { level } => Some((*level).clamp(1, 6)),
        BlockKind::BulletItem | BlockKind::OrderedItem | BlockKind::Quote => Some(10),
        _ => None,
    }
}

fn assemble_tree(blocks: &[RawBlock]) -> Result<BlockTree, MdError> {
    let mut nodes: HashMap<BlockId, BlockNode> = HashMap::new();
    let mut root_children: Vec<BlockId> = Vec::new();
    // 栈：(id, rank)
    let mut stack: Vec<(BlockId, u8)> = Vec::new();
    // 各父下已分配的子序号（用于 order 字符串）
    let mut sibling_seq: HashMap<Option<BlockId>, u32> = HashMap::new();

    for b in blocks {
        // 弹出秩 ≥ 当前容器秩 的容器
        if let Some(rank) = container_rank(&b.kind) {
            while stack
                .last()
                .map(|(_, r)| *r >= rank)
                .unwrap_or(false)
            {
                stack.pop();
            }
        }

        let parent = stack.last().map(|(id, _)| *id);
        let seq = sibling_seq.entry(parent).or_insert(0);
        let order = format!("a{seq:04}");
        *seq += 1;

        let node = BlockNode {
            id: b.id,
            parent,
            order,
            kind: b.kind.clone(),
            props: BlockProps::default(),
            text_snapshot: Some(b.text.clone()),
            children: Vec::new(),
        };
        nodes.insert(b.id, node);

        match parent {
            Some(pid) => {
                if let Some(p) = nodes.get_mut(&pid) {
                    p.children.push(b.id);
                } else {
                    return Err(MdError::Parse(format!(
                        "内部错误：父节点 {pid} 不存在"
                    )));
                }
            }
            None => root_children.push(b.id),
        }

        if let Some(rank) = container_rank(&b.kind) {
            stack.push((b.id, rank));
        }
    }

    Ok(BlockTree {
        root_children,
        nodes,
    })
}

/// 供测试：从固定 UUID 字符串建 ID。
#[cfg(test)]
pub fn bid(s: &str) -> BlockId {
    use std::str::FromStr;
    BlockId::from_str(s).expect("valid uuid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize_tree;

    #[test]
    fn parse_flat_two_paragraphs() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
alpha

<!--c:22222222-2222-4222-a222-222222222222-->
beta
";
        let tree = parse_document(md).unwrap();
        assert_eq!(tree.root_children.len(), 2);
        let a = bid("11111111-1111-4111-a111-111111111111");
        let b = bid("22222222-2222-4222-a222-222222222222");
        assert_eq!(tree.root_children, vec![a, b]);
        assert_eq!(tree.get(&a).unwrap().kind, BlockKind::Paragraph);
        assert_eq!(tree.get(&a).unwrap().text_snapshot.as_deref(), Some("alpha"));
        assert_eq!(tree.get(&b).unwrap().parent, None);
    }

    #[test]
    fn parse_nested_heading_paragraph() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落
";
        let tree = parse_document(md).unwrap();
        let h = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let p = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        assert_eq!(tree.root_children, vec![h]);
        let hn = tree.get(&h).unwrap();
        assert_eq!(hn.kind, BlockKind::Heading { level: 1 });
        assert_eq!(hn.children, vec![p]);
        let pn = tree.get(&p).unwrap();
        assert_eq!(pn.parent, Some(h));
        assert_eq!(pn.text_snapshot.as_deref(), Some("子段落"));
    }

    #[test]
    fn structure_roundtrip_nested() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落

<!--c:cccccccc-cccc-4ccc-8ccc-cccccccccccc-->
## 二级

<!--c:dddddddd-dddd-4ddd-8ddd-dddddddddddd-->
二级下的段
";
        let tree = parse_document(md).unwrap();
        let md2 = serialize_tree(&tree);
        let tree2 = parse_document(&md2).unwrap();
        assert_structure_eq(&tree, &tree2);
    }

    fn assert_structure_eq(a: &BlockTree, b: &BlockTree) {
        assert_eq!(a.root_children, b.root_children, "root_children");
        assert_eq!(a.nodes.len(), b.nodes.len(), "node count");
        for (id, na) in &a.nodes {
            let nb = b.get(id).expect("id present");
            assert_eq!(na.parent, nb.parent, "parent of {id}");
            assert_eq!(na.kind, nb.kind, "kind of {id}");
            assert_eq!(na.children, nb.children, "children of {id}");
            assert_eq!(
                na.text_snapshot, nb.text_snapshot,
                "text of {id}"
            );
        }
    }
}
