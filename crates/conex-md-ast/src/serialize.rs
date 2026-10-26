//! Conex-MD 序列化：`BlockTree` → 契约字符串。
//!
//! # 结构-only S（自研 raising）
//! - 每个块：独占行 `<!--c:UUID-->` + 内容行；子块紧随父内容之后（DFS）。
//! - 文本取自 `text_snapshot`（plain）；**不含** yrs 富文本往返。
//! - **P** 已接线 markdown-rs（见 [`crate::parse`]）；**S 不走库 to_md**（plans/03 §3.2）。
//!
//! # Agent 读路径
//! [`document_to_md`] / [`serialize_tree`] 即契约 **S(树)**：`get_md` / Agent 读必须走
//! **即时序列化**，禁止默认读陈旧 exports / mirror（见 `plans/03-MD契约.md` §S1 / §2）。

use crate::{BlockId, BlockKind, BlockProps, BlockTree, ORDERED_LIST_ITEM_NUMBER_ATTR};

/// 将整棵块树序列化为 Conex-MD 文本（含块 ID 注释）。
///
/// 与 [`document_to_md`] 语义相同；保留此名以对齐 P/S 记号 `S(t)`。
pub fn serialize_tree(tree: &BlockTree) -> String {
    document_to_md(tree)
}

/// Agent / 工具 **`get_md` / `document_get_md` 读路径**：对当前权威块树做 **即时 S**。
///
/// - 输出 = Conex-MD 契约字符串（`<!--c:UUID-->` 独占行 + 内容 DFS）
/// - **不是** 读磁盘 mirror / `exports/**` 陈旧快照
/// - 实现上与 [`serialize_tree`] 为同一路径（别名封装，便于工具面命名对齐）
///
/// 对应不变量：A-MD 读侧；`plans/03-MD契约.md`「Agent `get_md` = 即时 S(树)」。
pub fn document_to_md(tree: &BlockTree) -> String {
    let mut out = String::new();
    let mut roots = tree.root_children.clone();
    tree.sort_sibling_ids(&mut roots);

    for (i, id) in roots.iter().enumerate() {
        if i > 0 {
            // 根级兄弟之间空一行，便于 diff / 人工阅读
            out.push('\n');
        }
        serialize_node(tree, id, &mut out);
    }
    out
}

fn serialize_node(tree: &BlockTree, id: &BlockId, out: &mut String) {
    let Some(node) = tree.get(id) else {
        return;
    };

    out.push_str(&node.id.to_html_comment());
    out.push('\n');
    out.push_str(&format_block_content(
        &node.kind,
        node.text_snapshot.as_deref(),
        &node.props,
    ));
    out.push('\n');

    let mut children = node.children.clone();
    tree.sort_sibling_ids(&mut children);
    for child in &children {
        out.push('\n');
        serialize_node(tree, child, out);
    }
}

/// 按 kind 写出块「自身」内容（不含子块）。
fn format_block_content(kind: &BlockKind, text: Option<&str>, props: &BlockProps) -> String {
    let text = text.unwrap_or("");
    match kind {
        BlockKind::Heading { level } => {
            let n = (*level).clamp(1, 6) as usize;
            let hashes: String = std::iter::repeat_n('#', n).collect();
            if text.is_empty() {
                hashes
            } else {
                format!("{hashes} {text}")
            }
        }
        BlockKind::BulletItem => {
            if text.is_empty() {
                "-".to_string()
            } else {
                format!("- {text}")
            }
        }
        BlockKind::OrderedItem => {
            let number = props
                .attrs
                .get(ORDERED_LIST_ITEM_NUMBER_ATTR)
                .and_then(serde_json::Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(1);
            if text.is_empty() {
                format!("{number}.")
            } else {
                format!("{number}. {text}")
            }
        }
        BlockKind::Code => {
            // 结构-only：围栏代码，语言标签暂空
            format!("```\n{text}\n```")
        }
        BlockKind::Quote => {
            if text.is_empty() {
                ">".to_string()
            } else {
                // 多行 quote：每行前加 >
                text.lines()
                    .map(|l| format!("> {l}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        BlockKind::Divider => "---".to_string(),
        BlockKind::Paragraph | BlockKind::Unknown { .. } => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockNode, BlockProps};
    use std::collections::HashMap;
    use std::str::FromStr;

    fn id(s: &str) -> BlockId {
        BlockId::from_str(s).unwrap()
    }

    fn node(
        id: BlockId,
        parent: Option<BlockId>,
        order: &str,
        kind: BlockKind,
        text: &str,
        children: Vec<BlockId>,
    ) -> BlockNode {
        BlockNode {
            id,
            parent,
            order: order.into(),
            kind,
            props: BlockProps::default(),
            text_snapshot: Some(text.into()),
            children,
        }
    }

    #[test]
    fn serialize_flat_paragraphs() {
        let a = id("11111111-1111-4111-a111-111111111111");
        let b = id("22222222-2222-4222-a222-222222222222");
        let mut nodes = HashMap::new();
        nodes.insert(
            a,
            node(a, None, "a0", BlockKind::Paragraph, "第一段", vec![]),
        );
        nodes.insert(
            b,
            node(b, None, "a1", BlockKind::Paragraph, "第二段", vec![]),
        );
        let tree = BlockTree {
            root_children: vec![a, b],
            nodes,
        };
        let md = serialize_tree(&tree);
        assert!(md.contains("<!--c:11111111-1111-4111-a111-111111111111-->"));
        assert!(md.contains("第一段"));
        assert!(md.contains("第二段"));
        // ID 独占行：注释行后换行再内容
        assert!(md
            .lines()
            .any(|l| l == "<!--c:11111111-1111-4111-a111-111111111111-->"));
    }

    #[test]
    fn serialize_heading_with_child() {
        let h = id("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let p = id("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        let mut nodes = HashMap::new();
        nodes.insert(
            h,
            node(
                h,
                None,
                "a0",
                BlockKind::Heading { level: 1 },
                "标题",
                vec![p],
            ),
        );
        nodes.insert(
            p,
            node(p, Some(h), "a0", BlockKind::Paragraph, "子段落", vec![]),
        );
        let tree = BlockTree {
            root_children: vec![h],
            nodes,
        };
        let md = serialize_tree(&tree);
        let expect = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落
";
        assert_eq!(md, expect);
    }

    #[test]
    fn document_to_md_aliases_serialize_tree() {
        let a = id("11111111-1111-4111-a111-111111111111");
        let mut nodes = HashMap::new();
        nodes.insert(
            a,
            node(a, None, "a0", BlockKind::Paragraph, "即时S", vec![]),
        );
        let tree = BlockTree {
            root_children: vec![a],
            nodes,
        };
        assert_eq!(document_to_md(&tree), serialize_tree(&tree));
        assert!(document_to_md(&tree).contains("即时S"));
    }
}
