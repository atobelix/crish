//! Round6 · 列表 / 有序 / 引用 golden：结构 + plain 文本往返。

use conex_md_ast::{
    BlockId, BlockKind, document_to_md, parse_document, serialize_tree, structure_eq,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
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
fn golden_blockquote_structure_and_text() {
    let md = include_str!("golden/blockquote.md");
    let tree = parse_document(md).expect("parse blockquote");

    let d = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let e = bid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

    assert_eq!(tree.root_children, vec![d, e]);

    let n_d = tree.get(&d).unwrap();
    assert_eq!(n_d.kind, BlockKind::Quote);
    assert_eq!(
        n_d.text_snapshot.as_deref(),
        Some("单行引用：契约视图")
    );

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

/// 列表项作为容器：后续段落挂为子块（秩=10 容器模型）。
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
