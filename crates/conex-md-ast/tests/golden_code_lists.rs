//! W2-A 扩表 · golden：围栏代码 + 列表/引用加深。
//!
//! 诚实：**≠ A-MD-01 全集** / **≠ EL-06**；本文件仅加深可点名结构类。
//! 围栏 lang/meta 诚实与 task nested 续加深见 `golden_deepen.rs`（仍 ≠ EL-06）。

use conex_md_ast::{
    document_to_md, parse_document, serialize_tree, structure_eq, BlockId, BlockKind,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

/// 围栏代码：plain + 带 lang 正文进 snapshot；旁路段落；P→S→P 结构幂等。
#[test]
fn golden_fenced_code_structure_and_text() {
    let md = include_str!("golden/fenced_code.md");
    let tree = parse_document(md).expect("parse fenced_code");

    let c1 = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let c2 = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let p = bid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");

    assert_eq!(tree.root_children, vec![c1, c2, p]);

    let n1 = tree.get(&c1).unwrap();
    assert_eq!(n1.kind, BlockKind::Code);
    assert_eq!(n1.text_snapshot.as_deref(), Some("plain fence body\nline2"));
    assert!(n1.children.is_empty());
    assert_eq!(n1.parent, None);

    let n2 = tree.get(&c2).unwrap();
    assert_eq!(n2.kind, BlockKind::Code);
    // 语言标签不进 kind 载荷（结构-only；有 lang 时 lossy structure_note 见 deepen 包）；正文守恒
    assert_eq!(
        n2.text_snapshot.as_deref(),
        Some("fn main() {\n    println!(\"hi\");\n}")
    );

    let n_p = tree.get(&p).unwrap();
    assert_eq!(n_p.kind, BlockKind::Paragraph);
    assert_eq!(n_p.text_snapshot.as_deref(), Some("旁路段落：码块之后"));

    let md2 = serialize_tree(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "code RT md2=\n{md2}");
    assert_eq!(document_to_md(&tree), md2);
}

/// 列表项容器 + 子段落 + 根级引用：加深列表/引用一类。
#[test]
fn golden_nested_list_paragraph_and_quote() {
    let md = include_str!("golden/nested_list_paragraph.md");
    let tree = parse_document(md).expect("parse nested_list_paragraph");

    let b1 = bid("11111111-1111-4111-a111-111111111111");
    let child = bid("22222222-2222-4222-a222-222222222222");
    let b2 = bid("33333333-3333-4333-a333-333333333333");
    let q = bid("44444444-4444-4444-a444-444444444444");

    // 根：bullet1, bullet2, quote（child 挂在 bullet1 下）
    assert_eq!(tree.root_children, vec![b1, b2, q]);

    let n_b1 = tree.get(&b1).unwrap();
    assert_eq!(n_b1.kind, BlockKind::BulletItem);
    assert_eq!(n_b1.text_snapshot.as_deref(), Some("父无序项：中文"));
    assert_eq!(n_b1.children, vec![child]);
    assert_eq!(tree.get(&child).unwrap().parent, Some(b1));
    assert_eq!(
        tree.get(&child).unwrap().text_snapshot.as_deref(),
        Some("子段落挂在列表项下（容器秩模型）")
    );

    let n_b2 = tree.get(&b2).unwrap();
    assert_eq!(n_b2.kind, BlockKind::BulletItem);
    assert_eq!(n_b2.text_snapshot.as_deref(), Some("兄弟无序项 emoji 🔥"));
    assert!(n_b2.children.is_empty());

    let n_q = tree.get(&q).unwrap();
    assert_eq!(n_q.kind, BlockKind::Quote);
    assert_eq!(
        n_q.text_snapshot.as_deref(),
        Some("引用块接在列表后（根级）")
    );

    let again = parse_document(&document_to_md(&tree)).unwrap();
    assert!(structure_eq(&tree, &again));
}

/// 双次稳定：S(P(S(P(md)))) = S(P(md))（码块类 RT-3 子集）。
#[test]
fn fenced_code_double_stable_serialize() {
    let md = include_str!("golden/fenced_code.md");
    let t1 = parse_document(md).unwrap();
    let s1 = serialize_tree(&t1);
    let t2 = parse_document(&s1).unwrap();
    let s2 = serialize_tree(&t2);
    assert_eq!(s1, s2, "RT-3 双次稳定（码）");
    assert!(structure_eq(&t1, &t2));
}
