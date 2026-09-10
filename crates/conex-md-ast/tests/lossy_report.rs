//! Round6 · LossyReport 补测：pure-gfm 剥离、缺/重 ID、表格 note、禁止 HTML 反推。

use conex_md_ast::{
    encode_block_id_line, parse_document_detailed, strip_conex_id_comments_detailed, BlockKind,
};
use std::str::FromStr;

#[test]
fn strip_pure_gfm_lossy_codes() {
    let id = conex_md_ast::BlockId::from_str("11111111-1111-4111-a111-111111111111").unwrap();
    let md = format!(
        "前文\n{}\n段落后\n<!-- ordinary -->\n",
        encode_block_id_line(&id)
    );
    let (body, report) = strip_conex_id_comments_detailed(&md);
    assert!(body.contains("前文"));
    assert!(body.contains("段落后"));
    assert!(body.contains("<!-- ordinary -->"));
    assert!(!body.contains("<!--c:"));
    assert!(report.items.iter().any(|i| i.code == "stripped_block_ids"));
    assert!(report
        .items
        .iter()
        .any(|i| i.code == "stripped_block_ids_count"));
}

#[test]
fn parse_lossy_missing_and_duplicate() {
    let missing = parse_document_detailed("无ID段落\n").unwrap();
    assert!(missing
        .lossy
        .items
        .iter()
        .any(|i| i.code == "missing_block_id"));

    let dup_md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
A

<!--c:11111111-1111-4111-a111-111111111111-->
B
";
    let dup = parse_document_detailed(dup_md).unwrap();
    assert!(dup
        .lossy
        .items
        .iter()
        .any(|i| i.code == "duplicate_block_id"));
    assert_eq!(dup.tree.nodes.len(), 2);
}

#[test]
fn parse_lossy_table_structure_note() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
| col1 | col2 |
| ---- | ---- |
| x | y |
";
    let out = parse_document_detailed(md).unwrap();
    let note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note")
        .expect("table-like structure_note");
    assert!(note.detail.contains("表格") || note.detail.contains("段落"));
    assert_eq!(out.tree.root_children.len(), 1);
    assert_eq!(
        out.tree.get(&out.tree.root_children[0]).unwrap().kind,
        BlockKind::Paragraph
    );
}

#[test]
fn unknown_html_not_promoted_to_block_kind() {
    // A-MD-08 精神：禁止 HTML 快照/反推冒充结构；原文进 text_snapshot
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
<span data-x=\"1\">hello</span>

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
普通段
";
    let out = parse_document_detailed(md).unwrap();
    assert_eq!(out.tree.root_children.len(), 2);
    for id in &out.tree.root_children {
        let n = out.tree.get(id).unwrap();
        assert_eq!(n.kind, BlockKind::Paragraph);
        assert!(!matches!(n.kind, BlockKind::Unknown { .. }));
    }
    let html_id = out.tree.root_children[0];
    assert_eq!(
        out.tree.get(&html_id).unwrap().text_snapshot.as_deref(),
        Some("<span data-x=\"1\">hello</span>")
    );
}

#[test]
fn empty_lossy_when_well_formed_conex_md() {
    let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
干净段落
";
    let out = parse_document_detailed(md).unwrap();
    assert!(
        out.lossy.is_empty(),
        "well-formed conex-md should have empty lossy, got {:?}",
        out.lossy
    );
}
