//! W2-A：证明默认 P 走 markdown-rs（非手写主路径）。
//!
//! 诚实边界：本文件绿 = 接线可证伪；**≠** A-MD-01 全表 / EL-06 关闭。

use conex_md_ast::{parse_document, parse_document_detailed, BlockId, BlockKind, PARSE_BACKEND};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

#[test]
fn parse_backend_constant() {
    assert_eq!(PARSE_BACKEND, "markdown-rs");
}

/// GFM 删除线：仅 markdown-rs/GFM 构造会剥 `~~` 得 plain；手写行解析会原样保留。
#[test]
fn gfm_strikethrough_proves_mdast_path() {
    let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
before ~~gone~~ after
";
    let tree = parse_document(md).expect("parse");
    let id = bid("11111111-1111-4111-a111-111111111111");
    assert_eq!(
        tree.get(&id).unwrap().text_snapshot.as_deref(),
        Some("before gone after"),
        "markdown-rs GFM 应 lowering 删除线为 plain 文本"
    );
}

#[test]
fn gfm_table_structure_note_via_mdast() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
| h1 | h2 |
| --- | --- |
| c1 | c2 |
";
    let out = parse_document_detailed(md).unwrap();
    assert!(out
        .lossy
        .items
        .iter()
        .any(|i| i.code == "structure_note" && i.detail.contains("表格")));
    assert_eq!(
        out.tree.get(&out.tree.root_children[0]).unwrap().kind,
        BlockKind::Paragraph
    );
}

#[test]
fn fenced_code_and_heading_core() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
```
code body
```
";
    let tree = parse_document(md).unwrap();
    let h = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let c = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(tree.get(&h).unwrap().kind, BlockKind::Heading { level: 1 });
    assert_eq!(tree.get(&c).unwrap().kind, BlockKind::Code);
    assert_eq!(
        tree.get(&c).unwrap().text_snapshot.as_deref(),
        Some("code body")
    );
    // 容器栈：code 挂在 heading 下
    assert_eq!(tree.get(&h).unwrap().children, vec![c]);
}
