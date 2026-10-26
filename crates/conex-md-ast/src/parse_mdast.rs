//! markdown-rs（crate `markdown`）mdast → Conex `RawBlock` 序列。
//!
//! # 分层（plans/03 §3.2）
//! `mdast(库) → lowering → BlockIR`；**S 自研 raising**（不信任库 to_md 当契约）。
//!
//! # 诚实边界
//! - **已接线**：GFM P 主路径走 `markdown::to_mdast` + 本 lowering
//! - **未关**：**≠ A-MD-01 全集** / **≠ EL-06** / inline 富文本 yrs RT
//! - HTML **不升格**为 Unknown 结构块；进 plain `text_snapshot`（可记 `raw_html_as_text`）
//! - **Table / TaskItem kind 未入 collab IR**（`conex-doc-collab::BlockKind` 无变体；本 crate **禁止平行 IR**）
//!   - 表 → `Paragraph` + `structure_note`（行列/对齐进 plain；W2-A 加深）
//!   - 任务项 → `BulletItem`/`OrderedItem` + 勾选 plain 前缀 + 列表级 `structure_note`
//! - **围栏 Code**：kind 已入 collab；**lang/meta 未进载荷** → 有 info 时 `structure_note` 可点名；S 空 lang
//! - 嵌套 blockquote → 单 Quote 多行 plain（**无** 子 Quote 块）
//! - 同秩列表嵌套 → 扁平兄弟（容器栈秩=10）；真嵌套列表语义 **未** 关
//! - 任务项 trailing 表 → 表降 Paragraph 叶子挂容器（组合边；**≠** Table/TaskItem kind 关账 / **≠ EL-06**）
//! - 删除线 / 链接 / autolink：inline 剥为 plain（**≠** 叶子 inline RT 关账）
//! - wiki `[[…]]`：**未**建模；作 plain 文本保留（**≠** A-MD-03 / EL-06）

use crate::assemble::RawBlock;
use crate::{
    block_id_from_comment, BlockId, BlockKind, BlockProps, LossyReport, MdError,
    ORDERED_LIST_ITEM_NUMBER_ATTR,
};
use markdown::mdast::Node;
use markdown::{to_mdast, ParseOptions};
use std::collections::HashSet;

/// GFM 选项：`ParseOptions::gfm()`（表 / 删除线 / 任务列表等）。
fn gfm_parse_options() -> ParseOptions {
    ParseOptions::gfm()
}

/// 将 Conex-MD / plain GFM 经 markdown-rs 解析并 lowering 为 `RawBlock` 列表。
pub(crate) fn lower_md_to_raw_blocks(
    md: &str,
    lossy: &mut LossyReport,
) -> Result<Vec<RawBlock>, MdError> {
    let tree = to_mdast(md, &gfm_parse_options())
        .map_err(|e| MdError::Parse(format!("markdown-rs to_mdast 失败: {e}")))?;

    let children = match &tree {
        Node::Root(root) => &root.children,
        other => {
            return Err(MdError::Parse(format!(
                "markdown-rs 根节点非 Root: {other:?}"
            )));
        }
    };

    let mut blocks: Vec<RawBlock> = Vec::new();
    let mut seen_ids: HashSet<BlockId> = HashSet::new();
    let mut pending: Option<PendingId> = None;

    for child in children {
        lower_flow_node(child, &mut blocks, &mut seen_ids, &mut pending, lossy)?;
    }

    // 仅有 ID 无后续内容 → 空段落（与历史手写路径对齐）
    if let Some(p) = pending.take() {
        blocks.push(RawBlock {
            id: p.id,
            kind: BlockKind::Paragraph,
            text: String::new(),
            line: p.line,
            props: BlockProps::default(),
        });
    }

    Ok(blocks)
}

struct PendingId {
    id: BlockId,
    line: usize,
}

fn node_line(node: &Node) -> usize {
    node.position().map(|p| p.start.line).unwrap_or(1)
}

/// 取 pending ID 或生成新 ID（并记 missing / 处理 duplicate 已在 set_pending）。
fn take_block_id(
    pending: &mut Option<PendingId>,
    seen_ids: &mut HashSet<BlockId>,
    lossy: &mut LossyReport,
    line: usize,
) -> BlockId {
    if let Some(p) = pending.take() {
        return p.id;
    }
    let id = BlockId::new();
    seen_ids.insert(id);
    lossy.push(
        "missing_block_id",
        format!("line {line}: 块缺少 <!--c:UUID-->，已生成新 ID"),
        Some(line),
    );
    id
}

fn set_pending_id(
    pending: &mut Option<PendingId>,
    seen_ids: &mut HashSet<BlockId>,
    lossy: &mut LossyReport,
    bid: BlockId,
    line: usize,
    blocks: &mut Vec<RawBlock>,
) {
    // 连续两个 ID 注释：前者落空段落
    if let Some(prev) = pending.take() {
        blocks.push(RawBlock {
            id: prev.id,
            kind: BlockKind::Paragraph,
            text: String::new(),
            line: prev.line,
            props: BlockProps::default(),
        });
    }
    if !seen_ids.insert(bid) {
        let fresh = BlockId::new();
        seen_ids.insert(fresh);
        lossy.push(
            "duplicate_block_id",
            format!("line {line}: 重复 ID {bid} → 重分配为 {fresh}"),
            Some(line),
        );
        *pending = Some(PendingId { id: fresh, line });
    } else {
        *pending = Some(PendingId { id: bid, line });
    }
}

fn push_block(
    blocks: &mut Vec<RawBlock>,
    pending: &mut Option<PendingId>,
    seen_ids: &mut HashSet<BlockId>,
    lossy: &mut LossyReport,
    kind: BlockKind,
    text: String,
    line: usize,
) {
    BlockWriter::new(blocks, pending, seen_ids, lossy).push(kind, text, line);
}

struct BlockWriter<'a> {
    blocks: &'a mut Vec<RawBlock>,
    pending: &'a mut Option<PendingId>,
    seen_ids: &'a mut HashSet<BlockId>,
    lossy: &'a mut LossyReport,
}

impl<'a> BlockWriter<'a> {
    fn new(
        blocks: &'a mut Vec<RawBlock>,
        pending: &'a mut Option<PendingId>,
        seen_ids: &'a mut HashSet<BlockId>,
        lossy: &'a mut LossyReport,
    ) -> Self {
        Self {
            blocks,
            pending,
            seen_ids,
            lossy,
        }
    }

    fn push(&mut self, kind: BlockKind, text: String, line: usize) {
        self.push_with_props(kind, text, line, BlockProps::default());
    }

    fn push_with_props(&mut self, kind: BlockKind, text: String, line: usize, props: BlockProps) {
        let id = take_block_id(self.pending, self.seen_ids, self.lossy, line);
        self.blocks.push(RawBlock {
            id,
            kind,
            text,
            line,
            props,
        });
    }
}

fn lower_flow_node(
    node: &Node,
    blocks: &mut Vec<RawBlock>,
    seen_ids: &mut HashSet<BlockId>,
    pending: &mut Option<PendingId>,
    lossy: &mut LossyReport,
) -> Result<(), MdError> {
    let line = node_line(node);

    match node {
        // 块 ID 注释 / 原始 HTML（flow）
        Node::Html(html) => {
            let trimmed = html.value.trim();
            if let Some(bid) = block_id_from_comment(trimmed) {
                set_pending_id(pending, seen_ids, lossy, bid, line, blocks);
                return Ok(());
            }
            // 非 ID 的 flow HTML：进 plain 段落，不升格结构
            lossy.push(
                "raw_html_as_text",
                format!("line {line}: 原始 HTML 按文本保留，未升格为结构块"),
                Some(line),
            );
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Paragraph,
                html.value.clone(),
                line,
            );
        }
        Node::Paragraph(_) => {
            let text = node.to_string();
            // 段内若含 HTML 标签原文，to_string 已保留标签；可选记 note
            if text.contains('<') && text.contains('>') {
                // 仅当看起来像标签时提示（不强制；避免误伤比较符）
                if text.contains("</") || text.contains("/>") || text.contains('<') {
                    // 已有 inline HTML：纪律上等同 raw_html，但不重复刷屏；
                    // 仅当整段几乎是 HTML 时记一条（可选）。结构测不依赖此码。
                }
            }
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Paragraph,
                text,
                line,
            );
        }
        Node::Heading(h) => {
            let level = h.depth.clamp(1, 6);
            let text = phrasing_plain(&h.children);
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Heading { level },
                text,
                line,
            );
        }
        Node::Code(code) => {
            // 结构-only：`BlockKind::Code` 已入 collab，但 **lang/meta 载荷未建模**
            // （S 侧围栏 info 仍空）；正文进 snapshot。
            // W2-A 加深：有 lang/meta 时记 structure_note，可点名丢弃的 info（≠ A-MD-01 围栏 kind 满关）。
            let lang = code.lang.as_deref().filter(|s| !s.is_empty());
            let meta = code.meta.as_deref().filter(|s| !s.is_empty());
            if lang.is_some() || meta.is_some() {
                let mut parts = Vec::new();
                if let Some(l) = lang {
                    parts.push(format!("lang={l}"));
                }
                if let Some(m) = meta {
                    parts.push(format!("meta={m}"));
                }
                lossy.push(
                    "structure_note",
                    format!(
                        "line {line}: 围栏代码 info（{}）经 markdown-rs 识别后丢弃不进 BlockKind::Code 载荷（S 输出空 lang；正文 plain 守恒）",
                        parts.join(" ")
                    ),
                    Some(line),
                );
            }
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Code,
                code.value.clone(),
                line,
            );
        }
        Node::ThematicBreak(_) => {
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Divider,
                String::new(),
                line,
            );
        }
        Node::Blockquote(bq) => {
            let text = blockquote_plain(bq);
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Quote,
                text,
                line,
            );
            // 引用内嵌套块（除已并入 text 的段落）暂不二次展开；
            // 复杂嵌套留 A-MD 扩表波次。
        }
        Node::List(list) => {
            lower_list(list, blocks, seen_ids, pending, lossy)?;
        }
        Node::Table(table) => {
            // BlockKind::Table **未入 collab IR**：段落降级 + structure_note（≠ A-MD-01 表 kind 关账）
            let text = table_plain(table);
            let (nrows, ncols) = table_dims(table);
            lossy.push(
                "structure_note",
                format!(
                    "line {line}: GFM 表格 {nrows}×{ncols} 经 markdown-rs 识别后按 Paragraph 保留（BlockKind::Table 未入 collab IR；行列/对齐进 plain）"
                ),
                Some(line),
            );
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Paragraph,
                text,
                line,
            );
        }
        Node::Definition(_) | Node::FootnoteDefinition(_) => {
            // 链接定义 / 脚注定义：结构-only 吞为有损 note，不建块
            lossy.push(
                "structure_note",
                format!("line {line}: 跳过 definition/footnote_definition（结构-only）"),
                Some(line),
            );
        }
        Node::Yaml(_) | Node::Toml(_) => {
            lossy.push(
                "structure_note",
                format!("line {line}: frontmatter 未升格为结构块"),
                Some(line),
            );
        }
        Node::Math(m) => {
            // 数学块：按代码块近似保留原文
            lossy.push(
                "structure_note",
                format!("line {line}: math flow 按 Code 近似保留"),
                Some(line),
            );
            push_block(
                blocks,
                pending,
                seen_ids,
                lossy,
                BlockKind::Code,
                m.value.clone(),
                line,
            );
        }
        // 其余 flow 容器：尝试 children 或 to_string 段落
        other => {
            if let Some(children) = other.children() {
                for c in children {
                    lower_flow_node(c, blocks, seen_ids, pending, lossy)?;
                }
            } else {
                let text = other.to_string();
                if !text.trim().is_empty() {
                    lossy.push(
                        "structure_note",
                        format!("line {line}: 未映射 mdast 节点，按段落保留"),
                        Some(line),
                    );
                    push_block(
                        blocks,
                        pending,
                        seen_ids,
                        lossy,
                        BlockKind::Paragraph,
                        text,
                        line,
                    );
                }
            }
        }
    }
    Ok(())
}

fn lower_list(
    list: &markdown::mdast::List,
    blocks: &mut Vec<RawBlock>,
    seen_ids: &mut HashSet<BlockId>,
    pending: &mut Option<PendingId>,
    lossy: &mut LossyReport,
) -> Result<(), MdError> {
    let ordered = list.ordered;
    // 列表级诚实 note：任意项带 GFM checked → TaskItem kind 未入 collab
    let list_has_task = list
        .children
        .iter()
        .any(|item| matches!(item, Node::ListItem(li) if li.checked.is_some()));
    if list_has_task {
        // 优先首项行号（List 自身 position 偶发缺失时更稳）
        let line = list.children.first().map(node_line).unwrap_or(1);
        lossy.push(
            "structure_note",
            format!(
                "line {line}: GFM 任务列表勾选编入 {} plain 前缀（BlockKind::TaskItem 未入 collab IR；无独立 TaskItem kind）",
                if ordered {
                    "OrderedItem"
                } else {
                    "BulletItem"
                }
            ),
            Some(line),
        );
    }

    let start = list.start.unwrap_or(1);
    let mut item_index = 0usize;
    for item in &list.children {
        let Node::ListItem(li) = item else {
            continue;
        };
        let line = node_line(item);
        let (mut item_text, trailing) = split_list_item_contents(li);

        // GFM 任务列表：无 TaskItem kind（IR 未建模）；勾选编入 plain 前缀，
        // 使 S 产出 `- [x] …` / `- [ ] …`，P→S→P 结构+勾选可守恒（结构-only）。
        // **≠** A-MD-01 任务列表专用 kind 关账。
        if let Some(checked) = li.checked {
            item_text = encode_task_checkbox(checked, &item_text);
        }

        let (kind, props) = if ordered {
            let item_offset = u32::try_from(item_index)
                .map_err(|_| MdError::Parse(format!("line {line}: 有序列表项序号超过支持范围")))?;
            let number = start.checked_add(item_offset).ok_or_else(|| {
                MdError::Parse(format!("line {line}: 有序列表项编号超过支持范围"))
            })?;
            item_index += 1;
            let mut props = BlockProps::default();
            props.attrs.insert(
                ORDERED_LIST_ITEM_NUMBER_ATTR.to_string(),
                serde_json::Value::from(number),
            );
            (BlockKind::OrderedItem, props)
        } else {
            (BlockKind::BulletItem, BlockProps::default())
        };
        BlockWriter::new(blocks, pending, seen_ids, lossy)
            .push_with_props(kind, item_text, line, props);

        // 列表项内后续块作为后续 RawBlock；叶子内容由容器栈挂到当前项，
        // 同秩嵌套列表项按既有容器规则扁平为兄弟（真嵌套语义未实现）。
        for t in trailing {
            lower_flow_node(t, blocks, seen_ids, pending, lossy)?;
        }
    }
    Ok(())
}

/// 将 GFM 任务勾选编入列表项 plain（无独立 TaskItem kind）。
fn encode_task_checkbox(checked: bool, body: &str) -> String {
    let mark = if checked { "[x]" } else { "[ ]" };
    if body.is_empty() {
        mark.to_string()
    } else {
        format!("{mark} {body}")
    }
}

/// 首段 → 项文本；其余 flow 子节点原样返回供后续 lowering。
fn split_list_item_contents(li: &markdown::mdast::ListItem) -> (String, Vec<&Node>) {
    let mut text = String::new();
    let mut took_first_para = false;
    let mut trailing: Vec<&Node> = Vec::new();

    for child in &li.children {
        match child {
            Node::Paragraph(_) if !took_first_para => {
                text = child.to_string();
                took_first_para = true;
            }
            Node::Paragraph(_) => {
                // 多项段落：并入项文本（结构-only 续行语义）
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&child.to_string());
            }
            other => trailing.push(other),
        }
    }
    (text, trailing)
}

fn blockquote_plain(bq: &markdown::mdast::Blockquote) -> String {
    let mut parts: Vec<String> = Vec::new();
    for child in &bq.children {
        match child {
            Node::Paragraph(_) => parts.push(child.to_string()),
            Node::Blockquote(inner) => parts.push(blockquote_plain(inner)),
            other => {
                let s = other.to_string();
                if !s.is_empty() {
                    parts.push(s);
                }
            }
        }
    }
    parts.join("\n")
}

fn phrasing_plain(children: &[Node]) -> String {
    let mut out = String::new();
    for c in children {
        match c {
            Node::Text(t) => out.push_str(&t.value),
            Node::Break(_) => out.push('\n'),
            Node::Html(h) => out.push_str(&h.value),
            Node::InlineCode(c) => out.push_str(&c.value),
            Node::InlineMath(m) => out.push_str(&m.value),
            Node::Emphasis(e) => out.push_str(&phrasing_plain(&e.children)),
            Node::Strong(s) => out.push_str(&phrasing_plain(&s.children)),
            Node::Delete(d) => out.push_str(&phrasing_plain(&d.children)),
            Node::Link(l) => out.push_str(&phrasing_plain(&l.children)),
            Node::LinkReference(l) => out.push_str(&phrasing_plain(&l.children)),
            Node::Image(i) => out.push_str(&i.alt),
            Node::ImageReference(i) => out.push_str(&i.alt),
            Node::FootnoteReference(_) => {}
            other => out.push_str(&other.to_string()),
        }
    }
    out
}

/// 表格行列规模（行=TableRow 数；列=align 长或首行单元格数）。
fn table_dims(table: &markdown::mdast::Table) -> (usize, usize) {
    let nrows = table
        .children
        .iter()
        .filter(|n| matches!(n, Node::TableRow(_)))
        .count();
    let ncols_from_header = table
        .children
        .iter()
        .find_map(|n| match n {
            Node::TableRow(row) => Some(row.children.len()),
            _ => None,
        })
        .unwrap_or(0);
    let ncols = table.align.len().max(ncols_from_header);
    (nrows, ncols)
}

/// GFM 列对齐 → 分隔格文本（W2-A 加深：对齐进 plain，非丢弃为统一 `---`）。
fn align_sep(kind: markdown::mdast::AlignKind) -> &'static str {
    use markdown::mdast::AlignKind;
    match kind {
        AlignKind::Left => ":---",
        AlignKind::Center => ":---:",
        AlignKind::Right => "---:",
        AlignKind::None => "---",
    }
}

/// 表格 → 可读 plain（含 `|` 与对齐分隔行）；**非**字节级源还原。
///
/// 单元格内容 + 对齐可点名；`BlockKind::Table` **未入 collab**，故挂在 Paragraph 快照。
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
                Node::TableCell(cell) => phrasing_plain(&cell.children),
                other => other.to_string(),
            })
            .collect();
        rows.push(format!("| {} |", cells.join(" | ")));
        // 首行后插入对齐分隔行（优先 mdast.align；缺省 `---`）
        if ri == 0 {
            let seps: Vec<&str> = if table.align.is_empty() {
                cells.iter().map(|_| "---").collect()
            } else {
                (0..cells.len())
                    .map(|i| table.align.get(i).copied().map(align_sep).unwrap_or("---"))
                    .collect()
            };
            rows.push(format!("| {} |", seps.join(" | ")));
        }
    }
    rows.join("\n")
}
