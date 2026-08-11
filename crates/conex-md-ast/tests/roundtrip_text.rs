//! Round6 · plain text 往返加深（A-MD / RT 文本侧）
//!
//! 不变量：非空段落 `text_snapshot` 经 `document_to_md`/`serialize_tree` → `parse` 后
//! plain 文本相等（多段、中文、emoji）。结构-only；无 yrs inline 富文本。

use conex_md_ast::{
    BlockId, BlockKind, BlockNode, BlockProps, BlockTree, document_to_md, parse_document,
    serialize_tree, structure_eq,
};
use std::collections::HashMap;
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

fn para(id: BlockId, order: &str, text: &str) -> BlockNode {
    BlockNode {
        id,
        parent: None,
        order: order.into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
        text_snapshot: Some(text.into()),
        children: vec![],
    }
}

/// 从非空 text_snapshot 建树 → S → P → 文本与结构守恒。
#[test]
fn plain_text_rt_multi_para_zh_emoji() {
    let a = bid("11111111-1111-4111-a111-111111111111");
    let b = bid("22222222-2222-4222-a222-222222222222");
    let c = bid("33333333-3333-4333-a333-333333333333");

    let texts = [
        "第一段纯中文。",
        "第二段：emoji 🎉🔥 与中文混排。",
        "Third 段 mixed ASCII 与 汉字。",
    ];

    let mut nodes = HashMap::new();
    nodes.insert(a, para(a, "a0000", texts[0]));
    nodes.insert(b, para(b, "a0001", texts[1]));
    nodes.insert(c, para(c, "a0002", texts[2]));
    let tree = BlockTree {
        root_children: vec![a, b, c],
        nodes,
    };

    // get_md 路径 = 即时 S
    let md = document_to_md(&tree);
    assert_eq!(md, serialize_tree(&tree));
    assert!(md.contains("🎉"));
    assert!(md.contains("汉字"));

    let tree2 = parse_document(&md).expect("parse after S");
    assert!(structure_eq(&tree, &tree2), "md=\n{md}");

    for (id, expect) in [(a, texts[0]), (b, texts[1]), (c, texts[2])] {
        assert_eq!(
            tree2.get(&id).unwrap().text_snapshot.as_deref(),
            Some(expect),
            "text mismatch for {id}"
        );
        assert!(!expect.is_empty());
        assert_eq!(tree2.get(&id).unwrap().kind, BlockKind::Paragraph);
    }
}

/// golden 文件：中文 + emoji 多段 parse → S → P 文本相等。
#[test]
fn plain_text_rt_from_golden_file() {
    let md = include_str!("golden/plain_text_zh_emoji.md");
    let tree = parse_document(md).expect("parse golden plain");
    assert_eq!(tree.root_children.len(), 3);

    let a = bid("11111111-1111-4111-a111-111111111111");
    let b = bid("22222222-2222-4222-a222-222222222222");
    let c = bid("33333333-3333-4333-a333-333333333333");

    assert_eq!(
        tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("第一段：你好世界。")
    );
    assert_eq!(
        tree.get(&b).unwrap().text_snapshot.as_deref(),
        Some("第二段含 emoji：🎉 烟花与中文混排。")
    );
    assert_eq!(
        tree.get(&c).unwrap().text_snapshot.as_deref(),
        Some("第三段：纯 ASCII line with 中文尾。")
    );

    let md2 = document_to_md(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "roundtrip md2=\n{md2}");

    // 文本快照逐块相等（非空）
    for id in [a, b, c] {
        let t1 = tree.get(&id).unwrap().text_snapshot.as_deref().unwrap();
        let t2 = tree2.get(&id).unwrap().text_snapshot.as_deref().unwrap();
        assert!(!t1.is_empty());
        assert_eq!(t1, t2);
    }
}

/// 双次稳定：S(P(S(P(md)))) 结构与文本不振荡。
#[test]
fn plain_text_double_stable() {
    let md = include_str!("golden/plain_text_zh_emoji.md");
    let t1 = parse_document(md).unwrap();
    let s1 = document_to_md(&t1);
    let t2 = parse_document(&s1).unwrap();
    let s2 = document_to_md(&t2);
    let t3 = parse_document(&s2).unwrap();
    assert!(structure_eq(&t1, &t2));
    assert!(structure_eq(&t2, &t3));
    assert_eq!(s1, s2, "serialize must be idempotent after first normalize");
}

/// 空 text_snapshot 段落仍可 S→P（空串守恒）。
#[test]
fn empty_paragraph_text_roundtrip() {
    let a = bid("11111111-1111-4111-a111-111111111111");
    let mut nodes = HashMap::new();
    nodes.insert(a, para(a, "a0000", ""));
    let tree = BlockTree {
        root_children: vec![a],
        nodes,
    };
    let md = document_to_md(&tree);
    let tree2 = parse_document(&md).unwrap();
    // 仅有 ID 无内容时 parse 也会产出空段落
    assert_eq!(
        tree2.get(&a).unwrap().text_snapshot.as_deref(),
        Some("")
    );
}
