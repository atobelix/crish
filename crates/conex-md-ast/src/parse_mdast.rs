//! markdown-rs（crate `markdown`）mdast → Conex `BlockTree`。
//!
//! # 分层（plans/03 §3.2）
//! `mdast(库) → lowering → BlockIR`；**S 自研 raising**（不信任库 to_md 当契约）。
//!
//! # 嵌套模型
//! - **标题**：Conex 章节约定——后续同/低级块回到上级；更高级标题挂在上一标题下。
//! - **列表项**：mdast 显式嵌套 → 子块挂在列表项节点下（不再扁平化）。
//! - **引用**：mdast 显式嵌套 → 子块挂在引用节点下；GFM alert 升为 `Callout`。
//! - 首段文本进入容器节点 `text_snapshot`，其余子节点成为子块。
//!
//! # 载荷
//! - 围栏语言 / meta → `BlockKind::Code` + `CODE_LANG_ATTR` / `CODE_META_ATTR`
//! - 任务勾选 → `BlockKind::TaskItem` + `TASK_CHECKED_ATTR`
//! - 表格正文 → `BlockKind::Table` + 规范化表格源
//! - 块级数学 → `BlockKind::Math` + 公式源
//! - 脚注定义 → `BlockKind::FootnoteDefinition` + `FOOTNOTE_LABEL_ATTR`
//!
//! # 诚实边界
//! - inline 富文本（emphasis / code span / 链接目标）仍折叠为 plain；inline RT 另行立项
//! - 链接定义（`[x]: url`）与 frontmatter 无块级承载 → `structure_note`
//! - HTML 不升格为结构块；进 plain `text_snapshot`（`raw_html_as_text`）

use crate::{
    block_id_from_comment, BlockId, BlockKind, BlockProps, BlockTree, LossyReport, MdError,
    CODE_LANG_ATTR, CODE_META_ATTR, FOOTNOTE_LABEL_ATTR, ORDERED_LIST_ITEM_NUMBER_ATTR,
    TASK_CHECKED_ATTR,
};
use markdown::mdast::{Blockquote, List, ListItem, Node};
use markdown::{to_mdast, ParseOptions};
use std::collections::{HashMap, HashSet};

/// 将 Conex-MD / plain GFM 经 markdown-rs 解析并 lowering 为 `BlockTree`。
pub(crate) fn lower_md_to_tree(md: &str, lossy: &mut LossyReport) -> Result<BlockTree, MdError> {
    let tree = to_mdast(md, &parse_options())
        .map_err(|e| MdError::Parse(format!("markdown-rs to_mdast 失败: {e}")))?;

    let children = match &tree {
        Node::Root(root) => &root.children,
        other => {
            return Err(MdError::Parse(format!(
                "markdown-rs 根节点非 Root: {other:?}"
            )));
        }
    };

    let mut lowerer = Lowerer {
        tree: BlockTree::default(),
        seen_ids: HashSet::new(),
        order_seq: HashMap::new(),
        lossy,
    };
    lowerer.lower_children(children, None)?;
    Ok(lowerer.tree)
}

struct PendingId {
    id: BlockId,
    line: usize,
}

/// GFM + 块级 / 行内数学（mdast `Math` / `InlineMath`）。
fn parse_options() -> ParseOptions {
    let mut options = ParseOptions::gfm();
    options.constructs.math_flow = true;
    options.constructs.math_text = true;
    options
}

struct Lowerer<'a> {
    tree: BlockTree,
    seen_ids: HashSet<BlockId>,
    order_seq: HashMap<Option<BlockId>, u32>,
    lossy: &'a mut LossyReport,
}

impl Lowerer<'_> {
    /// 逐块 lowering 一组 mdast 兄弟节点；父节点由调用方给定。
    fn lower_children(&mut self, nodes: &[Node], parent: Option<BlockId>) -> Result<(), MdError> {
        let mut pending: Option<PendingId> = None;
        // 标题章节栈：更高级标题成为上一标题的子块。
        let mut headings: Vec<(u8, BlockId)> = Vec::new();

        for node in nodes {
            let line = node_line(node);

            if let Node::Html(html) = node {
                if let Some(bid) = block_id_from_comment(html.value.trim()) {
                    let section_parent = headings.last().map(|(_, id)| *id).or(parent);
                    self.set_pending(&mut pending, bid, line, section_parent)?;
                    continue;
                }
            }

            if let Node::Heading(h) = node {
                let level = h.depth.clamp(1, 6);
                while headings.last().is_some_and(|(l, _)| *l >= level) {
                    headings.pop();
                }
                let heading_parent = headings.last().map(|(_, id)| *id).or(parent);
                let id = self.create_block(
                    BlockKind::Heading { level },
                    inline_plain(&h.children),
                    BlockProps::default(),
                    heading_parent,
                    line,
                    &mut pending,
                )?;
                headings.push((level, id));
                continue;
            }

            let effective_parent = headings.last().map(|(_, id)| *id).or(parent);
            self.lower_block(node, effective_parent, &mut pending)?;
        }

        if let Some(p) = pending.take() {
            let section_parent = headings.last().map(|(_, id)| *id).or(parent);
            self.create_block(
                BlockKind::Paragraph,
                String::new(),
                BlockProps::default(),
                section_parent,
                p.line,
                &mut Some(p),
            )?;
        }
        Ok(())
    }

    fn lower_block(
        &mut self,
        node: &Node,
        parent: Option<BlockId>,
        pending: &mut Option<PendingId>,
    ) -> Result<(), MdError> {
        let line = node_line(node);
        match node {
            Node::Paragraph(p) => {
                self.create_block(
                    BlockKind::Paragraph,
                    inline_plain(&p.children),
                    BlockProps::default(),
                    parent,
                    line,
                    pending,
                )?;
            }
            Node::Code(code) => {
                let mut props = BlockProps::default();
                if let Some(lang) = code.lang.as_deref().filter(|s| !s.is_empty()) {
                    props
                        .attrs
                        .insert(CODE_LANG_ATTR.to_string(), serde_json::json!(lang));
                }
                if let Some(meta) = code.meta.as_deref().filter(|s| !s.is_empty()) {
                    props
                        .attrs
                        .insert(CODE_META_ATTR.to_string(), serde_json::json!(meta));
                }
                self.create_block(
                    BlockKind::Code,
                    code.value.clone(),
                    props,
                    parent,
                    line,
                    pending,
                )?;
            }
            Node::ThematicBreak(_) => {
                self.create_block(
                    BlockKind::Divider,
                    String::new(),
                    BlockProps::default(),
                    parent,
                    line,
                    pending,
                )?;
            }
            Node::Blockquote(bq) => {
                self.lower_blockquote(bq, parent, line, pending)?;
            }
            Node::List(list) => {
                self.lower_list(list, parent, pending)?;
            }
            Node::Table(table) => {
                self.create_block(
                    BlockKind::Table,
                    table_plain(table),
                    BlockProps::default(),
                    parent,
                    line,
                    pending,
                )?;
            }
            Node::Math(math) => {
                self.create_block(
                    BlockKind::Math,
                    math.value.clone(),
                    BlockProps::default(),
                    parent,
                    line,
                    pending,
                )?;
            }
            Node::FootnoteDefinition(fd) => {
                self.lower_footnote_definition(fd, parent, line, pending)?;
            }
            Node::Definition(_) => {
                self.lossy.push(
                    "structure_note",
                    format!("line {line}: 链接定义无块级承载，已跳过"),
                    Some(line),
                );
            }
            Node::Yaml(_) | Node::Toml(_) => {
                self.lossy.push(
                    "structure_note",
                    format!("line {line}: frontmatter 未升格为结构块"),
                    Some(line),
                );
            }
            Node::Html(html) => {
                self.lossy.push(
                    "raw_html_as_text",
                    format!("line {line}: 原始 HTML 按文本保留，未升格为结构块"),
                    Some(line),
                );
                self.create_block(
                    BlockKind::Paragraph,
                    html.value.clone(),
                    BlockProps::default(),
                    parent,
                    line,
                    pending,
                )?;
            }
            other => {
                if let Some(children) = other.children() {
                    self.lower_children(children, parent)?;
                } else {
                    let text = other.to_string();
                    if !text.trim().is_empty() {
                        self.lossy.push(
                            "structure_note",
                            format!("line {line}: 未映射 mdast 节点，按段落保留"),
                            Some(line),
                        );
                        self.create_block(
                            BlockKind::Paragraph,
                            text,
                            BlockProps::default(),
                            parent,
                            line,
                            pending,
                        )?;
                    }
                }
            }
        }
        Ok(())
    }

    fn lower_blockquote(
        &mut self,
        bq: &Blockquote,
        parent: Option<BlockId>,
        line: usize,
        pending: &mut Option<PendingId>,
    ) -> Result<(), MdError> {
        let mut trailing: &[Node] = &bq.children;
        let mut kind = BlockKind::Quote;
        let mut text = String::new();

        if let Some(Node::Paragraph(p)) = bq.children.first() {
            trailing = &bq.children[1..];
            let raw = inline_plain(&p.children);
            if let Some((callout, body)) = detect_callout(&raw) {
                kind = BlockKind::Callout { kind: callout };
                text = body;
            } else {
                text = raw;
            }
        }

        let id = self.create_block(kind, text, BlockProps::default(), parent, line, pending)?;
        self.lower_children(trailing, Some(id))
    }

    fn lower_list(
        &mut self,
        list: &List,
        parent: Option<BlockId>,
        pending: &mut Option<PendingId>,
    ) -> Result<(), MdError> {
        let ordered = list.ordered;
        let start = list.start.unwrap_or(1);
        let mut item_index: u32 = 0;
        // 调用方 pending 只属于本列表首项（序列化时 ID 行在列表项之前）。
        let mut list_pending = pending.take();

        for child in &list.children {
            let Node::ListItem(li) = child else {
                if let Node::Html(html) = child {
                    if let Some(bid) = block_id_from_comment(html.value.trim()) {
                        let line = node_line(child);
                        self.set_pending(&mut list_pending, bid, line, parent)?;
                    }
                }
                continue;
            };

            let line = node_line(child);
            let (text, trailing) = split_list_item(li);
            let number = start
                .checked_add(item_index)
                .ok_or_else(|| MdError::Parse(format!("line {line}: 有序列表项序号超过支持范围")))?;
            item_index += 1;

            let mut props = BlockProps::default();
            if ordered {
                props
                    .attrs
                    .insert(ORDERED_LIST_ITEM_NUMBER_ATTR.to_string(), number.into());
            }
            let kind = match li.checked {
                Some(checked) => {
                    props
                        .attrs
                        .insert(TASK_CHECKED_ATTR.to_string(), checked.into());
                    BlockKind::TaskItem { ordered }
                }
                None if ordered => BlockKind::OrderedItem,
                None => BlockKind::BulletItem,
            };

            let id = self.create_block(kind, text, props, parent, line, &mut list_pending)?;
            self.lower_children(trailing, Some(id))?;
        }

        Ok(())
    }

    fn lower_footnote_definition(
        &mut self,
        fd: &markdown::mdast::FootnoteDefinition,
        parent: Option<BlockId>,
        line: usize,
        pending: &mut Option<PendingId>,
    ) -> Result<(), MdError> {
        let mut trailing: &[Node] = &fd.children;
        let mut text = String::new();
        if let Some(Node::Paragraph(p)) = fd.children.first() {
            trailing = &fd.children[1..];
            text = inline_plain(&p.children);
        }
        let mut props = BlockProps::default();
        props.attrs.insert(
            FOOTNOTE_LABEL_ATTR.to_string(),
            fd.identifier.clone().into(),
        );
        let id = self.create_block(
            BlockKind::FootnoteDefinition,
            text,
            props,
            parent,
            line,
            pending,
        )?;
        self.lower_children(trailing, Some(id))
    }

    fn set_pending(
        &mut self,
        pending: &mut Option<PendingId>,
        bid: BlockId,
        line: usize,
        parent: Option<BlockId>,
    ) -> Result<(), MdError> {
        if let Some(prev) = pending.take() {
            self.create_block(
                BlockKind::Paragraph,
                String::new(),
                BlockProps::default(),
                parent,
                prev.line,
                &mut Some(prev),
            )?;
        }

        if !self.seen_ids.insert(bid) {
            let fresh = BlockId::new();
            self.seen_ids.insert(fresh);
            self.lossy.push(
                "duplicate_block_id",
                format!("line {line}: 重复 ID {bid} → 重分配为 {fresh}"),
                Some(line),
            );
            *pending = Some(PendingId { id: fresh, line });
        } else {
            *pending = Some(PendingId { id: bid, line });
        }
        Ok(())
    }

    fn create_block(
        &mut self,
        kind: BlockKind,
        text: String,
        props: BlockProps,
        parent: Option<BlockId>,
        line: usize,
        pending: &mut Option<PendingId>,
    ) -> Result<BlockId, MdError> {
        let id = match pending.take() {
            Some(p) => p.id,
            None => {
                let id = BlockId::new();
                self.seen_ids.insert(id);
                self.lossy.push(
                    "missing_block_id",
                    format!("line {line}: 块缺少 <!--c:UUID-->，已生成新 ID"),
                    Some(line),
                );
                id
            }
        };
        self.insert_node(id, kind, text, props, parent, line)?;
        Ok(id)
    }

    fn insert_node(
        &mut self,
        id: BlockId,
        kind: BlockKind,
        text: String,
        props: BlockProps,
        parent: Option<BlockId>,
        line: usize,
    ) -> Result<(), MdError> {
        let seq = self.order_seq.entry(parent).or_insert(0);
        let order = format!("a{seq:04}");
        *seq += 1;

        self.tree.nodes.insert(
            id,
            crate::BlockNode {
                id,
                parent,
                order,
                kind,
                props,
                text_snapshot: Some(text),
                children: Vec::new(),
            },
        );
        match parent {
            Some(pid) => {
                let Some(p) = self.tree.nodes.get_mut(&pid) else {
                    return Err(MdError::Parse(format!(
                        "line {line}: 内部错误：父节点 {pid} 不存在"
                    )));
                };
                p.children.push(id);
            }
            None => self.tree.root_children.push(id),
        }
        Ok(())
    }
}

/// 提取列表项首段文本；其余节点作为子块继续 lowering。
fn split_list_item(li: &ListItem) -> (String, &[Node]) {
    if let Some(Node::Paragraph(p)) = li.children.first() {
        (inline_plain(&p.children), &li.children[1..])
    } else {
        (String::new(), &li.children[..])
    }
}

/// GitHub alert 标记 → (小写 kind, 去掉标记的正文)。
///
/// mdast 把 `[!NOTE]` 与后续行解析为同一段落软换行，故正文可能以换行开头。
fn detect_callout(text: &str) -> Option<(String, String)> {
    let mut rest = text.strip_prefix("[!")?;
    let end = rest.find(']')?;
    let kind = rest[..end].trim().to_ascii_lowercase();
    rest = &rest[end + 1..];
    if !matches!(
        kind.as_str(),
        "note" | "tip" | "important" | "warning" | "caution"
    ) {
        return None;
    }
    if let Some(first) = rest.chars().next() {
        if !first.is_whitespace() {
            return None;
        }
    }
    Some((kind, rest.trim_start().to_string()))
}

fn node_line(node: &Node) -> usize {
    node.position().map(|p| p.start.line).unwrap_or(1)
}

/// inline 子节点 → plain 文本。
///
/// 行内格式（强调 / 代码 span / 链接目标）折叠为可见文本；脚注引用保留
/// `[^label]` 标记，便于定义块往返。
fn inline_plain(children: &[Node]) -> String {
    let mut out = String::new();
    for c in children {
        match c {
            Node::Text(t) => out.push_str(&t.value),
            Node::Break(_) => out.push('\n'),
            Node::InlineCode(c) => out.push_str(&c.value),
            Node::InlineMath(m) => {
                out.push('$');
                out.push_str(&m.value);
                out.push('$');
            }
            Node::Html(h) => out.push_str(&h.value),
            Node::Emphasis(e) => out.push_str(&inline_plain(&e.children)),
            Node::Strong(s) => out.push_str(&inline_plain(&s.children)),
            Node::Delete(d) => out.push_str(&inline_plain(&d.children)),
            Node::Link(l) => out.push_str(&inline_plain(&l.children)),
            Node::LinkReference(l) => out.push_str(&inline_plain(&l.children)),
            Node::Image(i) => out.push_str(&i.alt),
            Node::ImageReference(i) => out.push_str(&i.alt),
            Node::FootnoteReference(f) => {
                out.push_str("[^");
                out.push_str(&f.identifier);
                out.push(']');
            }
            Node::MdxTextExpression(e) => out.push_str(&e.value),
            other => out.push_str(&other.to_string()),
        }
    }
    out
}

/// GFM 列对齐 → 分隔格文本。
fn align_sep(kind: markdown::mdast::AlignKind) -> &'static str {
    use markdown::mdast::AlignKind;
    match kind {
        AlignKind::Left => ":---",
        AlignKind::Center => ":---:",
        AlignKind::Right => "---:",
        AlignKind::None => "---",
    }
}

/// GFM 表格单元格文本：转义反斜杠与管道，避免单元格内容被拆列。
fn escape_table_cell(text: &str) -> String {
    text.replace('\\', "\\\\").replace('|', "\\|")
}

/// 表格 → 规范化 GFM 表格源（含对齐分隔行）；**非**字节级源还原。
fn table_plain(table: &markdown::mdast::Table) -> String {
    let mut rows: Vec<String> = Vec::new();
    for (ri, row_node) in table.children.iter().enumerate() {
        let Node::TableRow(row) = row_node else {
            continue;
        };
        let cells: Vec<String> = row
            .children
            .iter()
            .map(|c| match c {
                Node::TableCell(cell) => escape_table_cell(&inline_plain(&cell.children)),
                other => other.to_string(),
            })
            .collect();
        rows.push(format!("| {} |", cells.join(" | ")));
        if ri == 0 {
            let seps: Vec<&str> = if table.align.is_empty() {
                cells.iter().map(|_| "---").collect()
            } else {
                (0..cells.len())
                    .map(|i| {
                        table
                            .align
                            .get(i)
                            .copied()
                            .map(align_sep)
                            .unwrap_or("---")
                    })
                    .collect()
            };
            rows.push(format!("| {} |", seps.join(" | ")));
        }
    }
    rows.join("\n")
}
