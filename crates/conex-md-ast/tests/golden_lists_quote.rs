//! Round6 · 列表 / 有序 / 引用 golden：结构 + plain 文本往返。

use conex_doc_collab::{BlockProps, DocSession, Op, Origin};
use conex_md_ast::{
    document_to_md, parse_document, serialize_tree, structure_eq, BlockId, BlockKind, BlockTree,
    ORDERED_LIST_ITEM_NUMBER_ATTR,
};
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

fn ordered_item_number(tree: &BlockTree, text: &str) -> Option<u64> {
    tree.nodes
        .values()
        .find(|node| node.text_snapshot.as_deref() == Some(text))?
        .props
        .attrs
        .get(ORDERED_LIST_ITEM_NUMBER_ATTR)
        .and_then(serde_json::Value::as_u64)
}

#[test]
fn golden_bullet_list_structure_and_text() {
    let md = include_str!("golden/bullet_list.md");
    let tree = parse_document(md).expect("parse bullet_list");

    let a = bid("11111111-1111-4111-a111-111111111111");
    let b = bid("22222222-2222-4222-a222-222222222222");
    let c = bid("33333333-3333-4333-a333-333333333333");

    assert_eq!(tree.root_children, vec![a, b, c]);
    for id in [a, b, c] {
        let n = tree.get(&id).unwrap();
        assert_eq!(n.kind, BlockKind::BulletItem);
        assert_eq!(n.parent, None);
        assert!(n.children.is_empty());
    }
    assert_eq!(
        tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("无序甲：中文与 plain")
    );
    assert_eq!(
        tree.get(&b).unwrap().text_snapshot.as_deref(),
        Some("无序乙 emoji 🔥")
    );
    assert_eq!(
        tree.get(&c).unwrap().text_snapshot.as_deref(),
        Some("无序丙")
    );

    let md2 = serialize_tree(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "rt md2=\n{md2}");
    // get_md 同源
    assert_eq!(document_to_md(&tree), md2);
}

#[test]
fn golden_ordered_list_structure_and_text() {
    let md = include_str!("golden/ordered_list.md");
    let tree = parse_document(md).expect("parse ordered_list");

    let a = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let b = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let c = bid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    assert_eq!(tree.root_children, vec![a, b, c]);
    for id in [a, b, c] {
        let n = tree.get(&id).unwrap();
        assert_eq!(n.kind, BlockKind::OrderedItem);
        assert_eq!(n.parent, None);
    }
    assert_eq!(
        tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("有序第一项")
    );
    assert_eq!(
        tree.get(&b).unwrap().text_snapshot.as_deref(),
        Some("有序第二项：中文")
    );
    assert_eq!(
        tree.get(&c).unwrap().text_snapshot.as_deref(),
        Some("有序第三项 🚀")
    );

    let md2 = document_to_md(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "rt md2=\n{md2}");
}

#[test]
fn ordered_list_start_values_survive_parse_serialize_parse() {
    let md = "\
5. 起始编号五
6. 连续编号六

列表分隔段落

- 无序列表甲
- 无序列表乙

1. 默认起始一
2. 默认连续二
";
    let tree = parse_document(md).expect("parse list starts");

    for (text, number) in [
        ("起始编号五", 5),
        ("连续编号六", 6),
        ("默认起始一", 1),
        ("默认连续二", 2),
    ] {
        assert_eq!(
            ordered_item_number(&tree, text),
            Some(number),
            "parsed number for {text}"
        );
    }

    let paragraph = tree
        .nodes
        .values()
        .find(|node| node.text_snapshot.as_deref() == Some("列表分隔段落"))
        .expect("paragraph separating lists");
    assert_eq!(paragraph.kind, BlockKind::Paragraph);
    assert_eq!(
        paragraph.parent, None,
        "GFM：列表后的未缩进段落是根兄弟，不挂列表项"
    );
    for text in ["无序列表甲", "无序列表乙"] {
        let unordered = tree
            .nodes
            .values()
            .find(|node| node.text_snapshot.as_deref() == Some(text))
            .expect("unordered list item");
        assert_eq!(unordered.kind, BlockKind::BulletItem);
        assert_eq!(unordered.parent, None);
        assert!(!unordered
            .props
            .attrs
            .contains_key(ORDERED_LIST_ITEM_NUMBER_ATTR));
    }
    assert_eq!(tree.root_children.len(), 7, "全部块均为根兄弟");
    assert!(tree
        .root_children
        .iter()
        .all(|id| tree.get(id).is_some_and(|node| node.parent.is_none())));

    let serialized = document_to_md(&tree);
    for marker in [
        "5. 起始编号五",
        "6. 连续编号六",
        "列表分隔段落",
        "- 无序列表甲",
        "- 无序列表乙",
        "1. 默认起始一",
        "2. 默认连续二",
    ] {
        assert!(
            serialized.lines().any(|line| line == marker),
            "missing {marker:?} in:\n{serialized}"
        );
    }

    let reparsed = parse_document(&serialized).expect("reparse serialized list starts");
    for (text, number) in [
        ("起始编号五", 5),
        ("连续编号六", 6),
        ("默认起始一", 1),
        ("默认连续二", 2),
    ] {
        assert_eq!(
            ordered_item_number(&reparsed, text),
            Some(number),
            "reparsed number for {text}"
        );
    }
    assert_eq!(reparsed.root_children.len(), 7);
    assert!(reparsed
        .root_children
        .iter()
        .all(|id| reparsed.get(id).is_some_and(|node| node.parent.is_none())));
    assert_eq!(
        document_to_md(&reparsed),
        serialized,
        "serialization must stabilize"
    );
}

#[test]
fn patch_attrs_preserves_ordered_ordinal_through_markdown_roundtrip() {
    let parsed = parse_document("5. patched item\n").expect("parse non-default ordinal");
    let id = *parsed
        .root_children
        .first()
        .expect("one parsed ordered item");
    let parsed_node = parsed.get(&id).expect("parsed ordered item");
    assert_eq!(parsed_node.kind, BlockKind::OrderedItem);
    assert_eq!(ordered_item_number(&parsed, "patched item"), Some(5));

    let text = parsed_node.text_snapshot.clone().expect("parsed item text");
    let props: BlockProps = parsed_node.props.clone();
    let mut session = DocSession::new("patch-attrs-ordered-ordinal-roundtrip");
    session
        .apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0000".into(),
                kind: BlockKind::OrderedItem,
                props,
            }],
        )
        .expect("insert parsed ordered item into collab session");
    session
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: text,
            }],
        )
        .expect("write parsed item text");
    session
        .apply(
            Origin::Agent,
            &[Op::PatchAttrs {
                id,
                set: BTreeMap::from([(String::from("collapsed"), serde_json::json!(true))]),
                remove: BTreeSet::new(),
            }],
        )
        .expect("patch a non-ordinal attr");

    assert_eq!(ordered_item_number(session.tree(), "patched item"), Some(5));
    assert_eq!(
        session
            .tree()
            .get(&id)
            .expect("ordered item after patch")
            .props
            .attrs
            .get("collapsed")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
    let serialized = serialize_tree(session.tree());
    assert!(
        serialized.lines().any(|line| line == "5. patched item"),
        "serialized Markdown lost the ordinal:\n{serialized}"
    );
    let reparsed = parse_document(&serialized).expect("reparse patched Markdown");
    assert_eq!(ordered_item_number(&reparsed, "patched item"), Some(5));
}

#[test]
fn golden_blockquote_structure_and_text() {
    let md = include_str!("golden/blockquote.md");
    let tree = parse_document(md).expect("parse blockquote");

    let d = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let e = bid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

    assert_eq!(tree.root_children, vec![d, e]);

    let n_d = tree.get(&d).unwrap();
    assert_eq!(n_d.kind, BlockKind::Quote);
    assert_eq!(n_d.text_snapshot.as_deref(), Some("单行引用：契约视图"));

    let n_e = tree.get(&e).unwrap();
    assert_eq!(n_e.kind, BlockKind::Quote);
    assert_eq!(
        n_e.text_snapshot.as_deref(),
        Some("多行引用第一行\n多行引用第二行 emoji ✨")
    );

    let md2 = serialize_tree(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "rt md2=\n{md2}");
}

/// 列表项作为容器：缩进段落挂为子块。
#[test]
fn bullet_item_nests_following_paragraph() {
    let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
- 父列表项

  <!--c:22222222-2222-4222-a222-222222222222-->
  子段落挂在列表项下
";
    let tree = parse_document(md).unwrap();
    let bullet = bid("11111111-1111-4111-a111-111111111111");
    let child = bid("22222222-2222-4222-a222-222222222222");
    assert_eq!(tree.root_children, vec![bullet]);
    let bn = tree.get(&bullet).unwrap();
    assert_eq!(bn.kind, BlockKind::BulletItem);
    assert_eq!(bn.children, vec![child]);
    assert_eq!(tree.get(&child).unwrap().parent, Some(bullet));
    assert_eq!(
        tree.get(&child).unwrap().text_snapshot.as_deref(),
        Some("子段落挂在列表项下")
    );
    let again = parse_document(&document_to_md(&tree)).unwrap();
    assert!(structure_eq(&tree, &again));
}
