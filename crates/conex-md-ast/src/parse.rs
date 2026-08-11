//! Conex-MD 解析：契约字符串 → `BlockTree`。
//!
//! # W2-A · markdown-rs 接线（主路径）
//! - **默认 P**：`markdown`（markdown-rs）`to_mdast` + `parse_mdast` lowering → 容器栈组装
//! - **S**：仍为自研 [`crate::serialize`]（不信任库 to_md 当契约）
//! - **手写行解析**：[`crate::parse_handwritten`] 已退役为非默认对照/回退，**禁止**当作权威 P
//!
//! # 诚实边界
//! - **已交付**：GFM P 主路径接线 + 结构 golden 子集 + ID 注释 lowering
//! - **mode / N**：见 [`crate::parse_md`] / [`crate::normalize_md`]（W2-A 扩表）
//! - **gfm-core 加深**：`tests/golden/gfm-core/**`（表/任务列表/删除线·autolink/Divider·wiki plain）
//! - **未关闭**：**≠ A-MD-01 全集** / **≠ EL-06** / 表格专用 kind / gfm-core 目录全集
//!
//! # 嵌套规则（容器栈 · 与 S DFS 对齐）
//! - **容器**：`Heading{level}`（秩=level）、`BulletItem` / `OrderedItem` / `Quote`（秩=10）
//! - **叶子**：`Paragraph`、`Code`、`Divider`、`Unknown`
//! - 限：树中不在叶子 kind 下挂子节点；golden / 往返测遵守此模型

use crate::assemble::assemble_tree;
use crate::{BlockTree, LossyReport, MdError};

/// 解析后端标识（接线验收 / 测试断言用）。
///
/// `"markdown-rs"` = 默认主路径已走 crate `markdown`；**≠** A-MD / EL-06 关闭。
pub const PARSE_BACKEND: &str = "markdown-rs";

/// 解析 Conex-MD（或可容忍的 plain GFM）为块树。
///
/// **主路径**：markdown-rs GFM mdast → lowering → BlockTree。
pub fn parse_document(md: &str) -> Result<BlockTree, MdError> {
    Ok(parse_document_detailed(md)?.tree)
}

/// 解析并附带有损点报告。
pub fn parse_document_detailed(md: &str) -> Result<ParseOutput, MdError> {
    let mut lossy = LossyReport::default();
    let blocks = crate::parse_mdast::lower_md_to_raw_blocks(md, &mut lossy)?;
    let tree = assemble_tree(&blocks)?;
    Ok(ParseOutput { tree, lossy })
}

/// 解析结果（树 + 有损报告）。
#[derive(Debug, Clone)]
pub struct ParseOutput {
    pub tree: BlockTree,
    pub lossy: LossyReport,
}

/// 供测试：从固定 UUID 字符串建 ID。
#[cfg(test)]
pub fn bid(s: &str) -> crate::BlockId {
    use std::str::FromStr;
    crate::BlockId::from_str(s).expect("valid uuid")
}

#[cfg(test)]
mod tests {
    #![allow(deprecated)]

    use super::*;
    use crate::parse_handwritten::{
        parse_document_detailed_handwritten, parse_document_handwritten,
    };
    use crate::serialize_tree;
    use crate::{BlockKind, structure_eq};

    #[test]
    fn parse_backend_is_markdown_rs() {
        assert_eq!(PARSE_BACKEND, "markdown-rs");
    }

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
        assert!(structure_eq(&tree, &tree2), "md2=\n{md2}");
    }

    #[test]
    fn lossy_missing_block_id() {
        let out = parse_document_detailed("裸段落无 ID\n").unwrap();
        assert_eq!(out.tree.root_children.len(), 1);
        let item = out
            .lossy
            .items
            .iter()
            .find(|i| i.code == "missing_block_id")
            .expect("missing_block_id");
        assert_eq!(item.line, Some(1));
        assert_eq!(
            out.tree
                .get(&out.tree.root_children[0])
                .unwrap()
                .text_snapshot
                .as_deref(),
            Some("裸段落无 ID")
        );
    }

    #[test]
    fn lossy_duplicate_block_id() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
第一

<!--c:11111111-1111-4111-a111-111111111111-->
重复ID块
";
        let out = parse_document_detailed(md).unwrap();
        assert_eq!(out.tree.root_children.len(), 2);
        let dup = out
            .lossy
            .items
            .iter()
            .find(|i| i.code == "duplicate_block_id")
            .expect("duplicate_block_id");
        assert!(dup.detail.contains("重分配"));
        let first = bid("11111111-1111-4111-a111-111111111111");
        assert_eq!(out.tree.root_children[0], first);
        assert_ne!(out.tree.root_children[1], first);
        assert_eq!(
            out.tree.get(&first).unwrap().text_snapshot.as_deref(),
            Some("第一")
        );
    }

    #[test]
    fn lossy_structure_note_table_like() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
| a | b |
| --- | --- |
| 1 | 2 |
";
        let out = parse_document_detailed(md).unwrap();
        let note = out
            .lossy
            .items
            .iter()
            .find(|i| i.code == "structure_note")
            .expect("structure_note for table");
        assert!(note.detail.contains("表格"));
        let id = &out.tree.root_children[0];
        assert_eq!(out.tree.get(id).unwrap().kind, BlockKind::Paragraph);
        assert!(
            out.tree
                .get(id)
                .unwrap()
                .text_snapshot
                .as_deref()
                .unwrap()
                .contains('|')
        );
    }

    #[test]
    fn lossy_raw_html_kept_as_paragraph_not_tree() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
<div class=\"x\">inner</div>
";
        let out = parse_document_detailed(md).unwrap();
        assert_eq!(out.tree.root_children.len(), 1);
        let n = out.tree.get(&out.tree.root_children[0]).unwrap();
        assert_eq!(n.kind, BlockKind::Paragraph);
        assert_eq!(
            n.text_snapshot.as_deref(),
            Some("<div class=\"x\">inner</div>")
        );
        for node in out.tree.nodes.values() {
            assert!(!matches!(node.kind, BlockKind::Unknown { .. }));
        }
    }

    #[test]
    fn parse_ordered_and_quote_kinds() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
1. 有序甲

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
> 引用正文
";
        let tree = parse_document(md).unwrap();
        let o = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let q = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        assert_eq!(tree.get(&o).unwrap().kind, BlockKind::OrderedItem);
        assert_eq!(tree.get(&o).unwrap().text_snapshot.as_deref(), Some("有序甲"));
        assert_eq!(tree.get(&q).unwrap().kind, BlockKind::Quote);
        assert_eq!(
            tree.get(&q).unwrap().text_snapshot.as_deref(),
            Some("引用正文")
        );
        let again = parse_document(&serialize_tree(&tree)).unwrap();
        assert!(structure_eq(&tree, &again));
    }

    /// 证明默认路径走 markdown-rs：GFM 删除线被 lowering 为 plain（非字面 `~~`）。
    #[test]
    fn markdown_rs_gfm_strikethrough_lowered_to_plain() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
a ~~strike~~ b
";
        let tree = parse_document(md).unwrap();
        let id = bid("11111111-1111-4111-a111-111111111111");
        assert_eq!(
            tree.get(&id).unwrap().text_snapshot.as_deref(),
            Some("a strike b")
        );
    }

    /// 围栏代码 + 语言：正文进 snapshot（lang 暂不进 kind）。
    #[test]
    fn markdown_rs_fenced_code_body() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
```rust
fn main() {}
```
";
        let tree = parse_document(md).unwrap();
        let id = bid("11111111-1111-4111-a111-111111111111");
        let n = tree.get(&id).unwrap();
        assert_eq!(n.kind, BlockKind::Code);
        assert_eq!(n.text_snapshot.as_deref(), Some("fn main() {}"));
    }

    /// 默认主路径与退役手写路径对结构子集同构（对照，非双主）。
    #[test]
    fn markdown_rs_matches_handwritten_on_nested_heading() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落
";
        let a = parse_document(md).unwrap();
        let b = parse_document_handwritten(md).unwrap();
        assert!(structure_eq(&a, &b));
    }

    #[test]
    fn handwritten_is_not_default_but_still_callable() {
        let out = parse_document_detailed_handwritten("裸段\n").unwrap();
        assert_eq!(out.tree.root_children.len(), 1);
        assert!(
            out.lossy
                .items
                .iter()
                .any(|i| i.code == "missing_block_id")
        );
    }

    #[test]
    fn empty_md_empty_tree() {
        let tree = parse_document("").unwrap();
        assert!(tree.root_children.is_empty());
        let tree = parse_document("\n\n").unwrap();
        assert!(tree.root_children.is_empty());
    }
}
