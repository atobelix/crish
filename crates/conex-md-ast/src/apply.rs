//! MD 片段 → Op 列表（W2-B）。
//!
//! # 不变量
//! - **只产出 `Vec<Op>`，不 mutate `target`**（零半树；写树由调用方 `DocSession::apply`）
//! - 失败返回 `Err`，不泄漏部分 Op（`Result` 语义：`Ok` 才持有完整列表）
//!
//! # ID 策略（钉死）
//! - 片段内合法 `<!--c:UUID-->` **复用**该 ID
//! - **文档（target）内已存在的 ID → 整批失败**（`MdError::IdConflict`）
//! - 缺 ID / 片段内重复 ID：交给 `parse`（生成新 ID 并记 lossy；本函数不透出 lossy）

use crate::{BlockId, BlockTree, MdError, Op, parse_document};
use std::collections::HashSet;

/// 将 MD 片段解析为可挂到 `parent` 下的 Op 列表。
///
/// - `parent = None`：挂到文档根
/// - `parent = Some(id)`：id 必须已在 `target` 中，否则 `UnknownParent`
/// - 不修改 `target`
pub fn apply_md_fragment(
    target: &BlockTree,
    parent: Option<BlockId>,
    md: &str,
) -> Result<Vec<Op>, MdError> {
    // 1. 未知父：整批失败（在解析前即可判定，避免无意义工作）
    if let Some(pid) = parent {
        if target.get(&pid).is_none() {
            return Err(MdError::UnknownParent(pid.to_string()));
        }
    }

    // 2. 结构子集解析（复用 parse）
    let frag = parse_document(md)?;

    // 空片段：合法，零 Op
    if frag.root_children.is_empty() {
        return Ok(Vec::new());
    }

    // 3. ID 冲突：片段内任一 ID 已在 target → 整批失败
    for id in frag.nodes.keys() {
        if target.nodes.contains_key(id) {
            return Err(MdError::IdConflict(id.to_string()));
        }
    }

    // 4. 生成 Op（先父后子；Insert + 可选 TextEdit）
    let base_seq = sibling_base_seq(target, parent);
    let mut ops = Vec::new();
    for (i, root_id) in frag.root_children.iter().enumerate() {
        let order = format!("a{:04}", base_seq + i as u32);
        emit_subtree(&frag, *root_id, parent, order, &mut ops)?;
    }

    // 防御：Op 列表内 ID 不得重复（parse 已保证；再钉一次）
    assert_ops_ids_unique(&ops);

    Ok(ops)
}

/// 目标父下已有兄弟数量，作为新 order 序号起点。
fn sibling_base_seq(target: &BlockTree, parent: Option<BlockId>) -> u32 {
    match parent {
        Some(pid) => target
            .get(&pid)
            .map(|n| n.children.len() as u32)
            .unwrap_or(0),
        None => target.root_children.len() as u32,
    }
}

/// 先序发出子树：Insert →（非空文本则）TextEdit → 递归子块。
fn emit_subtree(
    frag: &BlockTree,
    id: BlockId,
    parent: Option<BlockId>,
    order: String,
    ops: &mut Vec<Op>,
) -> Result<(), MdError> {
    let node = frag.get(&id).ok_or_else(|| {
        MdError::Parse(format!("内部错误：片段节点 {id} 缺失"))
    })?;

    ops.push(Op::Insert {
        id,
        parent,
        order,
        kind: node.kind.clone(),
        props: node.props.clone(),
    });

    // 可选 TextEdit：Insert 后文本为空，非空快照写回叶子
    if let Some(text) = node.text_snapshot.as_deref() {
        if !text.is_empty() {
            ops.push(Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: text.to_string(),
            });
        }
    }

    for (i, child) in node.children.iter().enumerate() {
        let child_order = format!("a{i:04}");
        emit_subtree(frag, *child, Some(id), child_order, ops)?;
    }
    Ok(())
}

fn assert_ops_ids_unique(ops: &[Op]) {
    let mut seen = HashSet::new();
    for op in ops {
        if let Op::Insert { id, .. } = op {
            assert!(
                seen.insert(*id),
                "apply_md_fragment 内部不变量：Insert ID 重复 {id}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockKind, BlockNode, BlockProps, structure_eq};
    use conex_doc_collab::{DocSession, Origin};
    use std::collections::HashMap;
    use std::str::FromStr;

    fn bid(s: &str) -> BlockId {
        BlockId::from_str(s).unwrap()
    }

    fn empty_tree() -> BlockTree {
        BlockTree::default()
    }

    /// 片段两段 → 恰好 2 个 Insert（+ 对应 TextEdit）。
    #[test]
    fn fragment_two_paragraphs_two_inserts() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
alpha

<!--c:22222222-2222-4222-a222-222222222222-->
beta
";
        let ops = apply_md_fragment(&empty_tree(), None, md).unwrap();
        let inserts: Vec<_> = ops
            .iter()
            .filter(|o| matches!(o, Op::Insert { .. }))
            .collect();
        assert_eq!(inserts.len(), 2);

        let a = bid("11111111-1111-4111-a111-111111111111");
        let b = bid("22222222-2222-4222-a222-222222222222");
        match &ops[0] {
            Op::Insert {
                id,
                parent,
                kind,
                order,
                ..
            } => {
                assert_eq!(*id, a);
                assert_eq!(*parent, None);
                assert_eq!(*kind, BlockKind::Paragraph);
                assert_eq!(order, "a0000");
            }
            other => panic!("期望 Insert，得到 {other:?}"),
        }
        // 非空文本 → TextEdit
        match &ops[1] {
            Op::TextEdit {
                id,
                start,
                end,
                insert,
            } => {
                assert_eq!(*id, a);
                assert_eq!((*start, *end), (0, 0));
                assert_eq!(insert, "alpha");
            }
            other => panic!("期望 TextEdit，得到 {other:?}"),
        }
        match &ops[2] {
            Op::Insert {
                id, parent, order, ..
            } => {
                assert_eq!(*id, b);
                assert_eq!(*parent, None);
                assert_eq!(order, "a0001");
            }
            other => panic!("期望 Insert，得到 {other:?}"),
        }
    }

    /// 嵌套 heading → 父子 Insert（父 parent=挂点，子 parent=父 id）。
    #[test]
    fn nested_heading_parent_child_inserts() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落
";
        let hang = bid("99999999-9999-4999-8999-999999999999");
        // target 仅有挂点
        let mut nodes = HashMap::new();
        nodes.insert(
            hang,
            BlockNode {
                id: hang,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some(String::new()),
                children: vec![],
            },
        );
        let target = BlockTree {
            root_children: vec![hang],
            nodes,
        };

        let ops = apply_md_fragment(&target, Some(hang), md).unwrap();
        let h = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let p = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

        let inserts: Vec<&Op> = ops
            .iter()
            .filter(|o| matches!(o, Op::Insert { .. }))
            .collect();
        assert_eq!(inserts.len(), 2);

        match inserts[0] {
            Op::Insert { id, parent, kind, .. } => {
                assert_eq!(*id, h);
                assert_eq!(*parent, Some(hang));
                assert_eq!(*kind, BlockKind::Heading { level: 1 });
            }
            _ => unreachable!(),
        }
        match inserts[1] {
            Op::Insert { id, parent, kind, .. } => {
                assert_eq!(*id, p);
                assert_eq!(*parent, Some(h));
                assert_eq!(*kind, BlockKind::Paragraph);
            }
            _ => unreachable!(),
        }

        // target 未被 mutate
        assert_eq!(target.root_children, vec![hang]);
        assert!(target.get(&h).is_none());
    }

    /// 文档内 ID 冲突 → 整批失败，无 Op 泄漏。
    #[test]
    fn id_conflict_fails_whole_batch() {
        let existing = bid("11111111-1111-4111-a111-111111111111");
        let mut nodes = HashMap::new();
        nodes.insert(
            existing,
            BlockNode {
                id: existing,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("old".into()),
                children: vec![],
            },
        );
        let target = BlockTree {
            root_children: vec![existing],
            nodes,
        };

        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
new text
";
        let err = apply_md_fragment(&target, None, md).unwrap_err();
        match err {
            MdError::IdConflict(s) => assert!(s.contains("11111111")),
            other => panic!("期望 IdConflict，得到 {other}"),
        }
        // target 仍只有原节点
        assert_eq!(target.nodes.len(), 1);
        assert_eq!(
            target.get(&existing).unwrap().text_snapshot.as_deref(),
            Some("old")
        );
    }

    /// 未知父 → Err。
    #[test]
    fn unknown_parent_fails() {
        let missing = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
x
";
        let err = apply_md_fragment(&empty_tree(), Some(missing), md).unwrap_err();
        assert!(matches!(err, MdError::UnknownParent(_)));
    }

    /// 空 md → 空 Op。
    #[test]
    fn empty_md_zero_ops() {
        let ops = apply_md_fragment(&empty_tree(), None, "").unwrap();
        assert!(ops.is_empty());
        let ops = apply_md_fragment(&empty_tree(), None, "\n\n").unwrap();
        assert!(ops.is_empty());
    }

    /// 不 mutate：调用前后 structure 指纹不变。
    #[test]
    fn does_not_mutate_target() {
        let a = bid("11111111-1111-4111-a111-111111111111");
        let mut nodes = HashMap::new();
        nodes.insert(
            a,
            BlockNode {
                id: a,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("keep".into()),
                children: vec![],
            },
        );
        let target = BlockTree {
            root_children: vec![a],
            nodes,
        };
        let before = target.clone();

        let md = "\
<!--c:22222222-2222-4222-a222-222222222222-->
new
";
        let _ops = apply_md_fragment(&target, None, md).unwrap();
        assert!(structure_eq(&before, &target));
    }

    /// 与 DocSession::apply 联测：apply ops 后树形状对齐 parse 结果（根挂 parent=None）。
    #[test]
    fn integration_session_apply_matches_parse() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落
";
        let expected = parse_document(md).unwrap();
        let ops = apply_md_fragment(&empty_tree(), None, md).unwrap();

        let mut session = DocSession::new("test-md-frag");
        session
            .apply(Origin::Agent, &ops)
            .expect("apply ops");

        // 结构：ID / kind / 父子
        assert_eq!(session.tree.root_children, expected.root_children);
        for (id, en) in &expected.nodes {
            let sn = session.tree.get(id).expect("id present after apply");
            assert_eq!(sn.parent, en.parent, "parent of {id}");
            assert_eq!(sn.kind, en.kind, "kind of {id}");
            assert_eq!(sn.children, en.children, "children of {id}");
            // 文本经 TextEngine
            let text = session.read_text(id);
            assert_eq!(
                Some(text.as_str()),
                en.text_snapshot.as_deref(),
                "text of {id}"
            );
        }
    }

    /// 挂到已有父下：order 接在已有兄弟之后。
    #[test]
    fn order_appends_after_existing_siblings() {
        let parent = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        let child0 = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        let mut nodes = HashMap::new();
        nodes.insert(
            parent,
            BlockNode {
                id: parent,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::Heading { level: 1 },
                props: BlockProps::default(),
                text_snapshot: Some("父".into()),
                children: vec![child0],
            },
        );
        nodes.insert(
            child0,
            BlockNode {
                id: child0,
                parent: Some(parent),
                order: "a0000".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("旧子".into()),
                children: vec![],
            },
        );
        let target = BlockTree {
            root_children: vec![parent],
            nodes,
        };

        let md = "\
<!--c:cccccccc-cccc-4ccc-8ccc-cccccccccccc-->
新段
";
        let ops = apply_md_fragment(&target, Some(parent), md).unwrap();
        match &ops[0] {
            Op::Insert { order, parent: p, .. } => {
                assert_eq!(*p, Some(parent));
                // 已有 1 个兄弟 → 新 order a0001
                assert_eq!(order, "a0001");
            }
            other => panic!("{other:?}"),
        }
    }
}
