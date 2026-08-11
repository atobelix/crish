//! W2-A golden：结构往返（ID / kind / 父子 / plain 文本）。
//! 输入：`tests/golden/*.md`

use conex_md_ast::{
    BlockId, BlockKind, BlockTree, parse_document, serialize_tree, structure_eq,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

#[test]
fn golden_flat_paragraphs() {
    let md = include_str!("golden/flat_paragraphs.md");
    let tree = parse_document(md).expect("parse flat");
    let a = bid("11111111-1111-4111-a111-111111111111");
    let b = bid("22222222-2222-4222-a222-222222222222");
    let c = bid("33333333-3333-4333-a333-333333333333");

    assert_eq!(tree.root_children, vec![a, b, c]);
    assert_eq!(tree.get(&a).unwrap().kind, BlockKind::Paragraph);
    assert_eq!(
        tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("第一段纯文本。")
    );
    assert_eq!(
        tree.get(&b).unwrap().text_snapshot.as_deref(),
        Some("第二段纯文本。")
    );
    assert_eq!(
        tree.get(&c).unwrap().text_snapshot.as_deref(),
        Some("第三段纯文本。")
    );
    for id in &[a, b, c] {
        assert_eq!(tree.get(id).unwrap().parent, None);
        assert!(tree.get(id).unwrap().children.is_empty());
    }

    // 结构往返
    let md2 = serialize_tree(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "roundtrip md2=\n{md2}");
}

#[test]
fn golden_nested_heading_paragraph() {
    let md = include_str!("golden/nested_heading_paragraph.md");
    let tree = parse_document(md).expect("parse nested");

    let h1 = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let p1 = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let h2 = bid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    let p2 = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let h1b = bid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    let p3 = bid("ffffffff-ffff-4fff-8fff-ffffffffffff");

    // 根：两个一级标题
    assert_eq!(tree.root_children, vec![h1, h1b]);

    let n_h1 = tree.get(&h1).unwrap();
    assert_eq!(n_h1.kind, BlockKind::Heading { level: 1 });
    assert_eq!(n_h1.text_snapshot.as_deref(), Some("父标题"));
    // 子：段落 + 二级标题
    assert_eq!(n_h1.children, vec![p1, h2]);

    let n_p1 = tree.get(&p1).unwrap();
    assert_eq!(n_p1.parent, Some(h1));
    assert_eq!(n_p1.kind, BlockKind::Paragraph);

    let n_h2 = tree.get(&h2).unwrap();
    assert_eq!(n_h2.parent, Some(h1));
    assert_eq!(n_h2.kind, BlockKind::Heading { level: 2 });
    assert_eq!(n_h2.children, vec![p2]);
    assert_eq!(tree.get(&p2).unwrap().parent, Some(h2));

    let n_h1b = tree.get(&h1b).unwrap();
    assert_eq!(n_h1b.parent, None);
    assert_eq!(n_h1b.children, vec![p3]);
    assert_eq!(tree.get(&p3).unwrap().parent, Some(h1b));

    let md2 = serialize_tree(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "roundtrip md2=\n{md2}");
}

#[test]
fn golden_serialize_matches_canonical_shape() {
    // 最小父子：序列化形状对齐 W0-B 规格示例
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题文本

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段落…
";
    let tree = parse_document(md).unwrap();
    let out = serialize_tree(&tree);
    assert_eq!(out, md);
}

/// 结构指纹辅助（调试失败时用）
#[allow(dead_code)]
fn dump_tree(tree: &BlockTree) -> String {
    let mut s = String::new();
    for id in &tree.root_children {
        dump_node(tree, id, 0, &mut s);
    }
    s
}

fn dump_node(tree: &BlockTree, id: &BlockId, depth: usize, s: &mut String) {
    let n = tree.get(id).unwrap();
    let pad = "  ".repeat(depth);
    s.push_str(&format!(
        "{pad}{id} {:?} {:?}\n",
        n.kind, n.text_snapshot
    ));
    for c in &n.children {
        dump_node(tree, c, depth + 1, s);
    }
}
