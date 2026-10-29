//! 结构加深 golden：嵌套容器、围栏 info、callout / math / footnote、块首转义。
//!
//! 输入：`tests/golden/**`
//!
//! # 边界
//! - 本文件绿 = 已支持结构类的**无损**往返
//! - **≠ A-MD-01 全集**；inline 富文本仍折叠为 plain
//! - 链接定义 / frontmatter 仍记 `structure_note`

use conex_md_ast::{
    document_to_md, parse_document, parse_document_detailed, structure_eq, BlockId, BlockKind,
    BlockNode, BlockProps, BlockTree, CODE_LANG_ATTR, CODE_META_ATTR, FOOTNOTE_LABEL_ATTR,
    TASK_CHECKED_ATTR,
};
use std::collections::HashMap;
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

fn attr_str<'a>(node: &'a BlockNode, key: &str) -> Option<&'a str> {
    node.props
        .attrs
        .get(key)
        .and_then(serde_json::Value::as_str)
}

fn attr_bool(node: &BlockNode, key: &str) -> Option<bool> {
    node.props
        .attrs
        .get(key)
        .and_then(serde_json::Value::as_bool)
}

fn assert_roundtrip(tree: &BlockTree) -> String {
    let md = document_to_md(tree);
    let again = parse_document(&md).expect("parse serialized tree");
    assert!(structure_eq(tree, &again), "RT md=\n{md}");
    assert_eq!(document_to_md(&again), md, "S must stabilize");
    md
}

/// 任务项嵌套段落：TaskItem 父 + Paragraph 子；勾选态进 attr。
#[test]
fn golden_task_nested_paragraph_under_task_item() {
    let md = include_str!("golden/gfm-core/task_nested_paragraph.md");
    let out = parse_document_detailed(md).expect("parse task_nested_paragraph");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let child = bid("22222222-2222-4222-a222-222222222222");
    let sibling = bid("33333333-3333-4333-a333-333333333333");
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(n_parent.kind, BlockKind::TaskItem { ordered: false });
    assert_eq!(attr_bool(n_parent, TASK_CHECKED_ATTR), Some(true));
    assert_eq!(n_parent.text_snapshot.as_deref(), Some("父任务：容器项"));
    assert_eq!(n_parent.children, vec![child]);

    let n_child = tree.get(&child).unwrap();
    assert_eq!(n_child.kind, BlockKind::Paragraph);
    assert_eq!(n_child.parent, Some(parent));

    let n_sib = tree.get(&sibling).unwrap();
    assert_eq!(n_sib.kind, BlockKind::TaskItem { ordered: false });
    assert!(n_sib.children.is_empty());

    let serialized = assert_roundtrip(tree);
    assert!(serialized.contains("- [x] 父任务：容器项"), "{serialized}");
    assert!(serialized.contains("  子段落挂在任务项下"), "{serialized}");
}

/// 围栏 lang / meta 进 Code attrs，S 原样写回。
#[test]
fn golden_fenced_code_info_roundtrip() {
    let md = include_str!("golden/fenced_code_info.md");
    let out = parse_document_detailed(md).expect("parse fenced_code_info");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);

    let code_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(out.tree.root_children, vec![code_id, after_id]);

    let n = out.tree.get(&code_id).unwrap();
    assert_eq!(n.kind, BlockKind::Code);
    assert_eq!(attr_str(n, CODE_LANG_ATTR), Some("rust"));
    assert_eq!(attr_str(n, CODE_META_ATTR), Some("title=\"demo\""));
    assert_eq!(
        n.text_snapshot.as_deref(),
        Some("fn hello() {\n    println!(\"fence info\");\n}")
    );

    let serialized = assert_roundtrip(&out.tree);
    assert!(
        serialized.contains("```rust title=\"demo\""),
        "{serialized}"
    );
}

/// 外层引用含子 Quote：父子关系与子 ID 均保留。
#[test]
fn golden_nested_blockquote_keeps_child_block() {
    let md = include_str!("golden/nested_blockquote.md");
    let out = parse_document_detailed(md).expect("parse nested_blockquote");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let tree = &out.tree;

    let outer = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let inner = bid("11111111-2222-4333-8444-555555555555");
    let plain_q = bid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    assert_eq!(tree.root_children, vec![outer, plain_q]);

    let n_outer = tree.get(&outer).unwrap();
    assert_eq!(n_outer.kind, BlockKind::Quote);
    assert_eq!(n_outer.text_snapshot.as_deref(), Some("外层引用"));
    assert_eq!(n_outer.children, vec![inner]);

    let n_inner = tree.get(&inner).unwrap();
    assert_eq!(n_inner.kind, BlockKind::Quote);
    assert_eq!(n_inner.parent, Some(outer));
    assert_eq!(
        n_inner.text_snapshot.as_deref(),
        Some("内层嵌套引用\n外层续行 emoji ✨")
    );
    assert!(n_inner.children.is_empty());

    let serialized = assert_roundtrip(tree);
    assert!(serialized.contains("> > 内层嵌套引用"), "{serialized}");
    assert!(serialized.contains("> 独立单层引用旁路"), "{serialized}");
}

/// 真嵌套列表：缩进子项父子；未缩进项仍为根兄弟。
#[test]
fn golden_nested_list_true_nesting_and_siblings() {
    let md = include_str!("golden/gfm-core/list_nested_true.md");
    let tree = parse_document(md).expect("parse list_nested_true");

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let child_a = bid("22222222-2222-4222-a222-222222222222");
    let child_b = bid("33333333-3333-4333-a333-333333333333");
    let sibling = bid("44444444-4444-4444-a444-444444444444");
    assert_eq!(tree.root_children, vec![parent, sibling]);
    assert_eq!(tree.get(&parent).unwrap().children, vec![child_a, child_b]);
    assert_eq!(tree.get(&sibling).unwrap().parent, None);

    // 未缩进项：模型 sibling（回归防静默拍平）
    let sibling_model = include_str!("golden/nested_list_sibling_model.md");
    let tree = parse_document(sibling_model).expect("parse sibling model");
    for id in [
        bid("11111111-1111-4111-a111-111111111111"),
        bid("22222222-2222-4222-a222-222222222222"),
        bid("33333333-3333-4333-a333-333333333333"),
    ] {
        let n = tree.get(&id).expect("sibling id");
        assert_eq!(n.parent, None);
        assert!(n.children.is_empty());
    }
    assert_roundtrip(&tree);
}

/// 列表项 + 缩进围栏代码：Code 子块 + lang attr。
#[test]
fn list_item_nests_code_leaf_child() {
    let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
- 列表父含码

  <!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
  ```python
  print(1)
  ```
";
    let out = parse_document_detailed(md).expect("parse list+code");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);
    let bullet = bid("11111111-1111-4111-a111-111111111111");
    let code = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert_eq!(out.tree.root_children, vec![bullet]);
    let bn = out.tree.get(&bullet).unwrap();
    assert_eq!(bn.children, vec![code]);
    let cn = out.tree.get(&code).unwrap();
    assert_eq!(cn.kind, BlockKind::Code);
    assert_eq!(cn.parent, Some(bullet));
    assert_eq!(cn.text_snapshot.as_deref(), Some("print(1)"));
    assert_eq!(attr_str(cn, CODE_LANG_ATTR), Some("python"));

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("  ```python"), "{serialized}");
}

/// GFM alert → Callout；块级数学 → Math；脚注定义 → FootnoteDefinition。
#[test]
fn golden_alerts_math_footnote() {
    let md = include_str!("golden/gfm-core/alerts_math_footnote.md");
    let out = parse_document_detailed(md).expect("parse alerts_math_footnote");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);

    let note = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let warning = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let math = bid("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    let para = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let footnote = bid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    assert_eq!(
        out.tree.root_children,
        vec![note, warning, math, para, footnote]
    );

    assert_eq!(
        out.tree.get(&note).unwrap().kind,
        BlockKind::Callout {
            kind: "note".into()
        }
    );
    assert_eq!(
        out.tree.get(&note).unwrap().text_snapshot.as_deref(),
        Some("提示正文")
    );
    assert_eq!(
        out.tree.get(&warning).unwrap().kind,
        BlockKind::Callout {
            kind: "warning".into()
        }
    );
    assert_eq!(
        out.tree.get(&warning).unwrap().text_snapshot.as_deref(),
        Some("警告首行\n第二行")
    );

    let n_math = out.tree.get(&math).unwrap();
    assert_eq!(n_math.kind, BlockKind::Math);
    assert_eq!(n_math.text_snapshot.as_deref(), Some("x^2 + y^2"));

    assert_eq!(
        out.tree.get(&para).unwrap().text_snapshot.as_deref(),
        Some("脚注引用[^a]")
    );

    let n_fn = out.tree.get(&footnote).unwrap();
    assert_eq!(n_fn.kind, BlockKind::FootnoteDefinition);
    assert_eq!(attr_str(n_fn, FOOTNOTE_LABEL_ATTR), Some("a"));
    assert_eq!(n_fn.text_snapshot.as_deref(), Some("脚注正文"));

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("> [!NOTE] 提示正文"), "{serialized}");
    assert!(serialized.contains("> [!WARNING] 警告首行"), "{serialized}");
    assert!(serialized.contains("$$\nx^2 + y^2\n$$"), "{serialized}");
    assert!(serialized.contains("[^a]: 脚注正文"), "{serialized}");
}

/// 表格单元格内的管道必须转义，避免重解析时拆列。
#[test]
fn golden_table_code_span_pipe_roundtrip() {
    let md = include_str!("golden/gfm-core/table_code_pipe.md");
    let out = parse_document_detailed(md).expect("parse table_code_pipe");
    assert!(out.lossy.is_empty(), "lossy={:?}", out.lossy);

    let id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let node = out.tree.get(&id).expect("table id");
    assert_eq!(node.kind, BlockKind::Table);
    let snapshot = node.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snapshot.contains("x \\| y"),
        "code-span pipe must be escaped: {snapshot}"
    );

    let serialized = assert_roundtrip(&out.tree);
    assert!(serialized.contains("| x \\| y | z |"), "{serialized}");
}

/// 非任务列表项文本以 `[x]` 开头时，S 必须转义，不能伪装成任务项。
#[test]
fn literal_task_marker_in_plain_list_roundtrip() {
    let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
- \\[x] literal checkbox text
";
    let out = parse_document_detailed(md).expect("parse literal task marker");
    let id = bid("11111111-1111-4111-a111-111111111111");
    let node = out.tree.get(&id).expect("bullet id");
    assert_eq!(node.kind, BlockKind::BulletItem);
    assert_eq!(
        node.text_snapshot.as_deref(),
        Some("[x] literal checkbox text")
    );

    let serialized = assert_roundtrip(&out.tree);
    assert!(
        serialized.contains("- \\[x] literal checkbox text"),
        "{serialized}"
    );
}

/// plain 文本行首若形似块级结构，S 必须转义以保证文本与结构双重往返。
#[test]
fn plain_text_block_start_escape_roundtrip() {
    let cases = [
        "# not heading",
        "- not list",
        "> not quote",
        "1. not ordered",
        "``` not fence",
        "__not emphasis__",
        "<!--c:not-an-id-->",
        "[^not]: not footnote",
        "[!NOTE] not callout",
    ];
    let mut nodes = HashMap::new();
    let mut roots = Vec::new();
    for (i, text) in cases.iter().enumerate() {
        let id = bid(&format!("00000000-0000-4000-8000-{i:012}"));
        nodes.insert(
            id,
            BlockNode {
                id,
                parent: None,
                order: format!("a{i:04}"),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some((*text).into()),
                children: vec![],
            },
        );
        roots.push(id);
    }
    let tree = BlockTree {
        root_children: roots,
        nodes,
    };

    let md = assert_roundtrip(&tree);
    assert!(md.contains("\\# not heading"), "{md}");
    assert!(md.contains("\\- not list"), "{md}");
    assert!(md.contains("\\> not quote"), "{md}");
    assert!(md.contains("1\\. not ordered"), "{md}");
    assert!(md.contains("&#95;&#95;not emphasis__"), "{md}");
    assert!(md.contains("\\<!--c:not-an-id-->"), "{md}");
    assert!(md.contains("\\[^not]: not footnote"), "{md}");
    assert!(md.contains("\\[!NOTE] not callout"), "{md}");
}
