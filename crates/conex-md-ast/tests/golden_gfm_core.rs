//! gfm-core 结构 golden：Table / TaskItem / Callout / Math / Footnote 等无损往返。
//!
//! 输入：`tests/golden/gfm-core/**`
//!
//! # 边界
//! - 本文件绿 = 已支持的 GFM 块级结构 **结构无损**往返
//! - **≠ A-MD-01 全集**；inline 富文本（强调 / 代码 span / 链接目标）仍折叠为 plain
//! - HTML 不升格结构块；链接定义 / frontmatter 仍记 `structure_note`

use conex_md_ast::{
    document_to_md, parse_document, parse_document_detailed, structure_eq, BlockId, BlockKind,
    BlockTree, ORDERED_LIST_ITEM_NUMBER_ATTR, TASK_CHECKED_ATTR,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

fn assert_roundtrip(tree: &BlockTree) -> String {
    let md = document_to_md(tree);
    let again = parse_document(&md).expect("parse serialized tree");
    assert!(structure_eq(tree, &again), "RT md=\n{md}");
    assert_eq!(document_to_md(&again), md, "S must stabilize");
    md
}

fn attr_bool(node: &conex_md_ast::BlockNode, key: &str) -> Option<bool> {
    node.props
        .attrs
        .get(key)
        .and_then(serde_json::Value::as_bool)
}

fn attr_u64(node: &conex_md_ast::BlockNode, key: &str) -> Option<u64> {
    node.props
        .attrs
        .get(key)
        .and_then(serde_json::Value::as_u64)
}

/// GFM 表格 → `BlockKind::Table`，对齐与单元格进规范化表格源；旁路段落为根兄弟。
#[test]
fn golden_gfm_core_table_kind_and_cells() {
    let md = include_str!("golden/gfm-core/table.md");
    let out = parse_document_detailed(md).expect("parse gfm-core table");
    assert!(out.lossy.is_empty(), "table is lossless: {:?}", out.lossy);

    let table_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(out.tree.root_children, vec![table_id, after_id]);

    let n_table = out.tree.get(&table_id).unwrap();
    assert_eq!(n_table.kind, BlockKind::Table);
    let snap = n_table.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snap.contains("左") && snap.contains("中") && snap.contains("右"),
        "header: {snap}"
    );
    assert!(
        snap.contains("a1") && snap.contains("b1") && snap.contains("c1"),
        "row1: {snap}"
    );
    assert!(
        snap.contains("a2") && snap.contains("b2") && snap.contains("c2"),
        "row2: {snap}"
    );
    assert!(
        snap.contains(":---") && snap.contains(":---:") && snap.contains("---:"),
        "alignment: {snap}"
    );
    assert!(n_table.children.is_empty());
    assert_eq!(n_table.parent, None);

    let n_after = out.tree.get(&after_id).unwrap();
    assert_eq!(n_after.kind, BlockKind::Paragraph);
    assert_eq!(n_after.text_snapshot.as_deref(), Some("表后段落：结构旁路"));

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("| 左 | 中 | 右 |"), "{serialized}");
    assert!(serialized.contains("| :--- | :---: | ---: |"), "{serialized}");
}

/// GFM 任务列表 → `TaskItem` + `TASK_CHECKED_ATTR`；普通 bullet 不受影响。
#[test]
fn golden_gfm_core_task_list_kind_and_attrs() {
    let md = include_str!("golden/gfm-core/task_list.md");
    let out = parse_document_detailed(md).expect("parse task_list");
    assert!(out.lossy.is_empty(), "task list is lossless: {:?}", out.lossy);

    let done = bid("11111111-1111-4111-a111-111111111111");
    let todo = bid("22222222-2222-4222-a222-222222222222");
    let plain = bid("33333333-3333-4333-a333-333333333333");
    assert_eq!(out.tree.root_children, vec![done, todo, plain]);

    let n_done = out.tree.get(&done).unwrap();
    assert_eq!(n_done.kind, BlockKind::TaskItem { ordered: false });
    assert_eq!(attr_bool(n_done, TASK_CHECKED_ATTR), Some(true));
    assert_eq!(n_done.text_snapshot.as_deref(), Some("已完成任务"));
    assert!(n_done.children.is_empty());

    let n_todo = out.tree.get(&todo).unwrap();
    assert_eq!(n_todo.kind, BlockKind::TaskItem { ordered: false });
    assert_eq!(attr_bool(n_todo, TASK_CHECKED_ATTR), Some(false));

    let n_plain = out.tree.get(&plain).unwrap();
    assert_eq!(n_plain.kind, BlockKind::BulletItem);
    assert_eq!(n_plain.text_snapshot.as_deref(), Some("普通无序项"));

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("- [x] 已完成任务"), "{serialized}");
    assert!(serialized.contains("- [ ] 未完成任务"), "{serialized}");
    assert!(serialized.contains("- 普通无序项"), "{serialized}");
}

/// 有序任务列表：`TaskItem { ordered: true }` + 序号 attr。
#[test]
fn golden_gfm_core_ordered_task_item_attrs() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
3. [x] 有序已完成

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
3. [ ] 有序未完成
";
    let out = parse_document_detailed(md).expect("parse ordered task");
    assert!(out.lossy.is_empty());

    let a = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let b = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let na = out.tree.get(&a).unwrap();
    assert_eq!(na.kind, BlockKind::TaskItem { ordered: true });
    assert_eq!(attr_bool(na, TASK_CHECKED_ATTR), Some(true));
    assert_eq!(attr_u64(na, ORDERED_LIST_ITEM_NUMBER_ATTR), Some(3));
    assert_eq!(na.text_snapshot.as_deref(), Some("有序已完成"));

    let nb = out.tree.get(&b).unwrap();
    assert_eq!(nb.kind, BlockKind::TaskItem { ordered: true });
    assert_eq!(attr_u64(nb, ORDERED_LIST_ITEM_NUMBER_ATTR), Some(3));

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("3. [x] 有序已完成"), "{serialized}");
    assert!(serialized.contains("3. [ ] 有序未完成"), "{serialized}");
}

/// 空单元格表格仍为 `Table`，不丢空列。
#[test]
fn golden_gfm_core_table_empty_cell() {
    let md = include_str!("golden/gfm-core/table_empty_cell.md");
    let out = parse_document_detailed(md).expect("parse empty-cell table");
    assert!(out.lossy.is_empty());

    let table_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(out.tree.root_children, vec![table_id, after_id]);

    let n = out.tree.get(&table_id).unwrap();
    assert_eq!(n.kind, BlockKind::Table);
    let snap = n.text_snapshot.as_deref().unwrap_or("");
    assert!(snap.contains("有") && snap.contains("空中"), "cells: {snap}");
    assert!(
        snap.lines().any(|l| l.matches('|').count() >= 3),
        "empty cell keeps table shape: {snap}"
    );
    assert_eq!(
        out.tree.get(&after_id).unwrap().text_snapshot.as_deref(),
        Some("空格表后旁路")
    );
    assert_roundtrip(&out.tree);
}

/// 删除线 / autolink：inline 仍折叠为 plain（诚实边界），结构往返。
#[test]
fn golden_gfm_core_strikethrough_and_autolink_plain() {
    let md = include_str!("golden/gfm-core/strikethrough_autolink.md");
    let tree = parse_document(md).expect("parse strikethrough_autolink");

    let strike_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let link_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(tree.root_children, vec![strike_id, link_id]);

    let n_strike = tree.get(&strike_id).unwrap();
    assert_eq!(n_strike.kind, BlockKind::Paragraph);
    assert_eq!(
        n_strike.text_snapshot.as_deref(),
        Some("before deleted after")
    );

    let n_link = tree.get(&link_id).unwrap();
    let link_text = n_link.text_snapshot.as_deref().unwrap_or("");
    assert!(
        link_text.contains("https://example.com/gfm") || link_text.contains("example.com"),
        "bare URL: {link_text}"
    );
    assert!(
        link_text.contains("https://example.org") || link_text.contains("example.org"),
        "autolink: {link_text}"
    );
    assert!(!link_text.contains('<') && !link_text.contains('>'));

    assert_roundtrip(&tree);
}

/// 分割线 + wiki 语法作 plain（不升格 Unknown / 不发 lossy）。
#[test]
fn golden_gfm_core_divider_and_wiki_plain() {
    let md = include_str!("golden/gfm-core/divider_and_wiki_plain.md");
    let out = parse_document_detailed(md).expect("parse divider_and_wiki");

    let div_id = bid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    let wiki_id = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    assert_eq!(out.tree.root_children, vec![div_id, wiki_id]);

    let n_div = out.tree.get(&div_id).unwrap();
    assert_eq!(n_div.kind, BlockKind::Divider);
    assert_eq!(n_div.text_snapshot.as_deref(), Some(""));
    assert!(n_div.children.is_empty());

    let n_wiki = out.tree.get(&wiki_id).unwrap();
    assert_eq!(n_wiki.kind, BlockKind::Paragraph);
    assert_eq!(
        n_wiki.text_snapshot.as_deref(),
        Some("[[wiki-page|别名]] 仍为 plain，无 Wiki kind")
    );
    assert!(!matches!(n_wiki.kind, BlockKind::Unknown { .. }));
    assert!(!out
        .lossy
        .items
        .iter()
        .any(|i| i.code == "wiki_or_ref_lossy"));

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("---"), "{serialized}");
    assert!(serialized.contains("[[wiki-page|别名]]"), "{serialized}");
}

/// 任务项嵌套表：TaskItem 父 + Table 子（真嵌套）；兄弟任务不被吞并。
#[test]
fn golden_gfm_core_task_nested_table_child() {
    let md = include_str!("golden/gfm-core/task_nested_table.md");
    let out = parse_document_detailed(md).expect("parse task_nested_table");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let table = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let sibling = bid("33333333-3333-4333-a333-333333333333");
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(n_parent.kind, BlockKind::TaskItem { ordered: false });
    assert_eq!(attr_bool(n_parent, TASK_CHECKED_ATTR), Some(true));
    assert_eq!(n_parent.text_snapshot.as_deref(), Some("父任务：嵌套表容器"));
    assert_eq!(n_parent.children, vec![table]);

    let n_table = tree.get(&table).unwrap();
    assert_eq!(n_table.kind, BlockKind::Table);
    assert_eq!(n_table.parent, Some(parent));
    assert!(n_table.children.is_empty());
    assert!(n_table
        .text_snapshot
        .as_deref()
        .unwrap_or("")
        .contains('|'));

    let n_sib = tree.get(&sibling).unwrap();
    assert_eq!(n_sib.kind, BlockKind::TaskItem { ordered: false });
    assert_eq!(attr_bool(n_sib, TASK_CHECKED_ATTR), Some(false));
    assert!(n_sib.children.is_empty());

    let serialized = assert_roundtrip(tree);
    assert!(serialized.contains("  <!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->"));
    assert!(serialized.contains("  | 左 | 右 |"));
}

/// 引用内嵌套表：Quote 父 + Table 子；引用后段落是根兄弟（非 Quote 子块）。
#[test]
fn golden_gfm_core_blockquote_nested_table_child() {
    let md = include_str!("golden/gfm-core/blockquote_nested_table.md");
    let out = parse_document_detailed(md).expect("parse blockquote_nested_table");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let tree = &out.tree;

    let quote = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(tree.root_children, vec![quote, after]);

    let n_quote = tree.get(&quote).unwrap();
    assert_eq!(n_quote.kind, BlockKind::Quote);
    assert_eq!(
        n_quote.text_snapshot.as_deref(),
        Some("引用导语：嵌套表扁平进 Quote plain")
    );
    assert_eq!(n_quote.children.len(), 1);
    let table_id = bid("11111111-2222-4333-8444-666666666666");
    assert_eq!(n_quote.children, vec![table_id]);
    let n_table = tree.get(&table_id).unwrap();
    assert_eq!(n_table.kind, BlockKind::Table);
    assert_eq!(n_table.parent, Some(quote));
    assert!(n_table
        .text_snapshot
        .as_deref()
        .unwrap_or("")
        .contains(":---"));

    let n_after = tree.get(&after).unwrap();
    assert_eq!(n_after.kind, BlockKind::Paragraph);
    assert_eq!(n_after.parent, None, "引用后段落不吞进 Quote");
    assert_eq!(n_after.text_snapshot.as_deref(), Some("引用后旁路段落"));

    let serialized = assert_roundtrip(tree);
    assert!(serialized.contains("> <!--c:"), "{serialized}");
    assert!(serialized.contains("> | 左 | 右 |"), "{serialized}");
}

/// 普通列表内嵌表：Bullet 父 + Table 子；非任务列表不得生成 task 标记。
#[test]
fn golden_gfm_core_list_nested_table_child() {
    let md = include_str!("golden/gfm-core/list_nested_table.md");
    let out = parse_document_detailed(md).expect("parse list_nested_table");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let table = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let sibling = bid("33333333-3333-4333-a333-333333333333");
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(n_parent.kind, BlockKind::BulletItem);
    assert_eq!(
        n_parent.text_snapshot.as_deref(),
        Some("父无序项：嵌套表容器")
    );
    assert_eq!(n_parent.children, vec![table]);

    let n_table = tree.get(&table).unwrap();
    assert_eq!(n_table.kind, BlockKind::Table);
    assert_eq!(n_table.parent, Some(parent));

    let n_sib = tree.get(&sibling).unwrap();
    assert_eq!(n_sib.kind, BlockKind::BulletItem);
    assert_eq!(n_sib.text_snapshot.as_deref(), Some("兄弟无序项"));

    let serialized = assert_roundtrip(tree);
    assert!(
        !serialized.contains("[x]") && !serialized.contains("[ ]"),
        "non-task list must not gain checkbox: {serialized}"
    );
}

/// 真嵌套列表：缩进子项成为父项子块；兄弟项回根级。
#[test]
fn golden_gfm_core_true_nested_list() {
    let md = include_str!("golden/gfm-core/list_nested_true.md");
    let out = parse_document_detailed(md).expect("parse list_nested_true");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let child_a = bid("22222222-2222-4222-a222-222222222222");
    let child_b = bid("33333333-3333-4333-a333-333333333333");
    let sibling = bid("44444444-4444-4444-a444-444444444444");
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(n_parent.children, vec![child_a, child_b]);
    for id in [child_a, child_b] {
        let n = tree.get(&id).unwrap();
        assert_eq!(n.kind, BlockKind::BulletItem);
        assert_eq!(n.parent, Some(parent));
    }
    assert_eq!(tree.get(&sibling).unwrap().parent, None);

    let serialized = assert_roundtrip(tree);
    assert!(serialized.contains("  - 子项甲"), "{serialized}");
}
