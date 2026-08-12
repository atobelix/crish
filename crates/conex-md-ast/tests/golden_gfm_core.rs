//! W2-A 后续 · gfm-core 结构 golden 加深（A-MD-01 方向 · **Table/TaskItem kind 加深**）。
//!
//! 输入：`tests/golden/gfm-core/**`
//!
//! # 诚实边界（强制）
//! - 本文件绿 = gfm-core **可点名结构类**加深可测（表 / 任务列表 / 删除线·autolink / 分割线·wiki plain /
//!   **任务嵌套表** 组合边 / **引用嵌套表 flatten** / **普通列表嵌套表**（表降 Paragraph 叶子，非 flatten））
//! - **≠ A-MD-01 全集关账**（§3.6 仍有未覆盖类；本包非全表）
//! - **≠ A-MD 全集** / **≠ EL-06**（见 `plans/08` / `acceptance/EL-dashboard`；**禁止** 本批 golden 关 EL）
//! - **≠ A-MD-03**（wiki 未建模，仅 plain 诚实）
//! - **kind 未入 collab**：`conex-doc-collab::BlockKind` **无** `Table` / `TaskItem`
//!   - 表 → Paragraph + `structure_note`（行列/对齐进 plain）
//!   - 任务 → BulletItem/OrderedItem + 勾选 plain + 列表级 `structure_note`
//!   - 任务项挂表：表降 Paragraph **叶子**挂 BulletItem 下（组合边 · 非真 Table kind 嵌套）
//! - 叶子 inline 全文 RT（强调边界 / 链接 URL 结构）**未**关闭（§2.2 分期）

use conex_md_ast::{
    document_to_md, parse_document, parse_document_detailed, serialize_tree, structure_eq, BlockId,
    BlockKind,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

/// 1) GFM 表格：识别 → 无 Table kind 时 Paragraph + structure_note；单元格 plain 可点名；旁路段落；P→S→P。
#[test]
fn golden_gfm_core_table_structure_note_and_cells() {
    let md = include_str!("golden/gfm-core/table.md");
    let out = parse_document_detailed(md).expect("parse gfm-core table");

    let table_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    assert_eq!(out.tree.root_children, vec![table_id, after_id]);

    let note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note")
        .expect("table must emit structure_note");
    assert!(
        note.detail.contains("表格") || note.detail.contains("Table"),
        "detail={:?}",
        note.detail
    );
    // W2-A 加深：note 诚实声明 kind 未入 collab + 可点名规模
    assert!(
        note.detail.contains("未入 collab") || note.detail.contains("Table"),
        "须诚实 kind 未入 collab: {:?}",
        note.detail
    );
    assert!(
        note.detail.contains("3×3") || note.detail.contains("3x3"),
        "3 行(含表头)×3 列可点名: {:?}",
        note.detail
    );

    let n_table = out.tree.get(&table_id).unwrap();
    assert_eq!(
        n_table.kind,
        BlockKind::Paragraph,
        "无 Table kind：表按段落保留（有损诚实）"
    );
    let snap = n_table.text_snapshot.as_deref().unwrap_or("");
    // 单元格内容可点名（lowering table_plain）
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
    assert!(snap.contains('|'), "须保留表格可读形态: {snap}");
    // W2-A 加深：对齐分隔行进 plain（左/中/右）
    assert!(
        snap.contains(":---") && snap.contains(":---:") && snap.contains("---:"),
        "对齐标记须进 plain: {snap}"
    );
    assert!(n_table.children.is_empty());
    assert_eq!(n_table.parent, None);

    let n_after = out.tree.get(&after_id).unwrap();
    assert_eq!(n_after.kind, BlockKind::Paragraph);
    assert_eq!(n_after.text_snapshot.as_deref(), Some("表后段落：结构旁路"));

    // 结构往返：表仍为 Paragraph + 旁路段（ID/父子/文本）
    let md2 = serialize_tree(&out.tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&out.tree, &tree2), "table RT md2=\n{md2}");
    assert_eq!(document_to_md(&out.tree), md2);
}

/// 2) GFM 任务列表：勾选编入 plain（无 TaskItem kind）；与普通 bullet 并存；P→S→P 守恒。
#[test]
fn golden_gfm_core_task_list_checkbox_in_plain() {
    let md = include_str!("golden/gfm-core/task_list.md");
    let out = parse_document_detailed(md).expect("parse gfm-core task_list");
    let tree = &out.tree;

    let done = bid("11111111-1111-4111-a111-111111111111");
    let todo = bid("22222222-2222-4222-a222-222222222222");
    let plain = bid("33333333-3333-4333-a333-333333333333");

    assert_eq!(tree.root_children, vec![done, todo, plain]);

    let n_done = tree.get(&done).unwrap();
    assert_eq!(n_done.kind, BlockKind::BulletItem);
    assert_eq!(
        n_done.text_snapshot.as_deref(),
        Some("[x] 已完成任务"),
        "checked=true 须编入 [x] 前缀"
    );
    assert!(n_done.children.is_empty());
    assert_eq!(n_done.parent, None);

    let n_todo = tree.get(&todo).unwrap();
    assert_eq!(n_todo.kind, BlockKind::BulletItem);
    assert_eq!(
        n_todo.text_snapshot.as_deref(),
        Some("[ ] 未完成任务"),
        "checked=false 须编入 [ ] 前缀"
    );

    let n_plain = tree.get(&plain).unwrap();
    assert_eq!(n_plain.kind, BlockKind::BulletItem);
    assert_eq!(
        n_plain.text_snapshot.as_deref(),
        Some("普通无序项"),
        "非任务项不得误加 checkbox 前缀"
    );

    // W2-A 加深：列表级 structure_note 诚实 TaskItem 未入 collab
    let task_note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note" && i.detail.contains("TaskItem"))
        .expect("task list must emit TaskItem-absent structure_note");
    assert!(
        task_note.detail.contains("未入 collab"),
        "detail={:?}",
        task_note.detail
    );

    // S 须产出 GFM 任务列表语法，便于再 parse
    let md2 = serialize_tree(tree);
    assert!(md2.contains("- [x] 已完成任务"), "S 任务完成项: {md2}");
    assert!(md2.contains("- [ ] 未完成任务"), "S 任务未完成项: {md2}");
    assert!(md2.contains("- 普通无序项"), "S 普通 bullet: {md2}");

    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(tree, &tree2), "task list RT md2=\n{md2}");

    // RT-3 双次稳定（任务列表子集）
    let s1 = serialize_tree(tree);
    let s2 = serialize_tree(&parse_document(&s1).unwrap());
    assert_eq!(s1, s2, "RT-3 task list");
}

/// 3) GFM 删除线 + autolink：inline 剥为 plain；URL 文本可点名；结构 P→S→P。
///
/// 叶子 inline 富文本 yrs / 链接目标结构 RT **未**关闭（plans/03 §2.2）。
#[test]
fn golden_gfm_core_strikethrough_and_autolink_plain() {
    let md = include_str!("golden/gfm-core/strikethrough_autolink.md");
    let tree = parse_document(md).expect("parse gfm-core strikethrough_autolink");

    let strike_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let link_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    assert_eq!(tree.root_children, vec![strike_id, link_id]);

    let n_strike = tree.get(&strike_id).unwrap();
    assert_eq!(n_strike.kind, BlockKind::Paragraph);
    assert_eq!(
        n_strike.text_snapshot.as_deref(),
        Some("before deleted after"),
        "删除线 ~~ 须被 markdown-rs GFM 剥除进 plain"
    );
    // 不得把标记字面保留（接线可证伪）
    assert!(
        !n_strike
            .text_snapshot
            .as_deref()
            .unwrap_or("")
            .contains("~~"),
        "不得保留 ~~ 字面"
    );

    let n_link = tree.get(&link_id).unwrap();
    assert_eq!(n_link.kind, BlockKind::Paragraph);
    let link_text = n_link.text_snapshot.as_deref().unwrap_or("");
    // autolink / bare URL：结构-only 下 URL 串进 plain（children 文本）
    assert!(
        link_text.contains("https://example.com/gfm") || link_text.contains("example.com"),
        "bare/autolink URL 应出现在 plain: {link_text}"
    );
    assert!(
        link_text.contains("https://example.org") || link_text.contains("example.org"),
        "尖括号 autolink 应出现在 plain: {link_text}"
    );
    // 尖括号语法本身通常不进 plain
    assert!(
        !link_text.contains('<') && !link_text.contains('>'),
        "autolink 尖括号不应残留: {link_text}"
    );

    let md2 = document_to_md(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(
        structure_eq(&tree, &tree2),
        "strike/autolink RT md2=\n{md2}"
    );
}

/// 4) 分割线 kind=Divider + wiki 语法作 plain（无 Wiki kind）诚实占位。
///
/// **≠ A-MD-03** / **≠ EL-06**；wiki 结构化解析属 W2-A-ext。
#[test]
fn golden_gfm_core_divider_and_wiki_plain_honesty() {
    let md = include_str!("golden/gfm-core/divider_and_wiki_plain.md");
    let out = parse_document_detailed(md).expect("parse gfm-core divider_and_wiki_plain");

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
    // 不得升格 Unknown{flavour: wiki…}
    assert!(!matches!(n_wiki.kind, BlockKind::Unknown { .. }));
    // 本路径不伪报 wiki_or_ref_lossy（扩展未接线）；差集属 A-MD-03
    assert!(
        !out.lossy
            .items
            .iter()
            .any(|i| i.code == "wiki_or_ref_lossy"),
        "wiki 未建模时不应假装已做 pure-gfm 引用降级码: {:?}",
        out.lossy
    );

    let md2 = serialize_tree(&out.tree);
    assert!(md2.contains("---"), "Divider S: {md2}");
    assert!(md2.contains("[[wiki-page|别名]]"), "wiki plain S: {md2}");
    let tree2 = parse_document(&md2).unwrap();
    assert!(
        structure_eq(&out.tree, &tree2),
        "divider/wiki RT md2=\n{md2}"
    );
}

/// 任务列表 + 有序任务项：ordered + checked 编入 plain 前缀（等价结构测）。
#[test]
fn gfm_core_ordered_task_item_checkbox_plain() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
1. [x] 有序已完成

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
1. [ ] 有序未完成
";
    let tree = parse_document(md).unwrap();
    let a = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let b = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(tree.get(&a).unwrap().kind, BlockKind::OrderedItem);
    assert_eq!(
        tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("[x] 有序已完成")
    );
    assert_eq!(tree.get(&b).unwrap().kind, BlockKind::OrderedItem);
    assert_eq!(
        tree.get(&b).unwrap().text_snapshot.as_deref(),
        Some("[ ] 有序未完成")
    );
    let again = parse_document(&document_to_md(&tree)).unwrap();
    assert!(structure_eq(&tree, &again));
}

// ── W2-A 加深：Table / TaskItem kind 方向（collab 无变体 → structure_note + 可点名） ──
// 本段绿 ≠ EL-06 / ≠ A-MD-01 全集；仅证 kind 未入 collab 时的诚实加深可测。

/// 新测 1) 表对齐：左/中/右分隔符进 plain；structure_note 含规模与 collab 诚实句。
#[test]
fn gfm_core_table_align_markers_and_kind_absent_note() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
| L | C | R |
| :-- | :-: | --: |
| 1 | 2 | 3 |
";
    let out = parse_document_detailed(md).expect("parse align table");
    let id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let n = out.tree.get(&id).unwrap();
    assert_eq!(n.kind, BlockKind::Paragraph, "Table kind 未入 collab");
    // exhaustiveness 诚实：当前 BlockKind 仅有这些变体，无 Table
    match &n.kind {
        BlockKind::Paragraph
        | BlockKind::Heading { .. }
        | BlockKind::BulletItem
        | BlockKind::OrderedItem
        | BlockKind::Code
        | BlockKind::Quote
        | BlockKind::Divider
        | BlockKind::Unknown { .. } => {}
    }
    let snap = n.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snap.contains("| L |") || snap.contains("| L | C | R |") || snap.contains("L"),
        "header: {snap}"
    );
    assert!(
        snap.contains(":---") && snap.contains(":---:") && snap.contains("---:"),
        "左/中/右对齐须进 plain: {snap}"
    );
    assert!(
        snap.contains("1") && snap.contains("2") && snap.contains("3"),
        "body: {snap}"
    );

    let note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note")
        .expect("structure_note");
    assert!(
        note.detail.contains("未入 collab"),
        "须声明 Table kind 未入 collab: {:?}",
        note.detail
    );
    assert!(
        note.detail.contains("2×3") || note.detail.contains("2x3"),
        "2 行×3 列: {:?}",
        note.detail
    );

    let tree2 = parse_document(&serialize_tree(&out.tree)).unwrap();
    assert!(structure_eq(&out.tree, &tree2));
}

/// 新测 2) 空单元格可点名 + 旁路段不吞；表仍 Paragraph。
#[test]
fn gfm_core_table_empty_cell_nameable_and_bypass_para() {
    let md = include_str!("golden/gfm-core/table_empty_cell.md");
    let out = parse_document_detailed(md).expect("parse empty-cell table");
    let table_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(out.tree.root_children, vec![table_id, after_id]);

    let n = out.tree.get(&table_id).unwrap();
    assert_eq!(n.kind, BlockKind::Paragraph);
    let snap = n.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snap.contains("有") && snap.contains("空中"),
        "cells: {snap}"
    );
    // 空单元格：中间列 body 为空，仍保留管道分隔形态
    assert!(
        snap.lines().any(|l| {
            let parts: Vec<_> = l.split('|').map(str::trim).collect();
            // | 有 |  | 空中 |  → 中间 cell 空
            parts.iter().filter(|p| !p.is_empty()).count() >= 2 && l.matches('|').count() >= 3
        }),
        "空单元格须保留 | 形态: {snap}"
    );
    assert!(
        out.lossy
            .items
            .iter()
            .any(|i| i.code == "structure_note" && i.detail.contains("表格")),
        "empty-cell 表仍须 structure_note: {:?}",
        out.lossy
    );
    assert_eq!(
        out.tree.get(&after_id).unwrap().text_snapshot.as_deref(),
        Some("空格表后旁路")
    );
    let again = parse_document(&document_to_md(&out.tree)).unwrap();
    assert!(structure_eq(&out.tree, &again));
}

/// 新测 3) TaskItem kind 未入 collab：仅 BulletItem/OrderedItem；列表级 structure_note 可点名。
#[test]
fn gfm_core_taskitem_kind_absent_structure_note() {
    let md = include_str!("golden/gfm-core/task_list.md");
    let out = parse_document_detailed(md).unwrap();

    // 所有节点 kind ∈ 已有 collab 变体；无 TaskItem（编译期亦无此变体可匹配）
    for n in out.tree.nodes.values() {
        match &n.kind {
            BlockKind::BulletItem | BlockKind::OrderedItem | BlockKind::Paragraph => {}
            other => panic!("task_list 意外 kind: {other:?}"),
        }
        // 不得伪装 Unknown{flavour: task…}
        if let BlockKind::Unknown { flavour } = &n.kind {
            assert!(
                !flavour.to_lowercase().contains("task"),
                "不得用 Unknown 冒充 TaskItem: {flavour}"
            );
        }
    }

    let notes: Vec<_> = out
        .lossy
        .items
        .iter()
        .filter(|i| i.code == "structure_note" && i.detail.contains("TaskItem"))
        .collect();
    assert!(
        !notes.is_empty(),
        "须至少一条 TaskItem 未入 collab 的 structure_note: {:?}",
        out.lossy
    );
    assert!(
        notes
            .iter()
            .any(|n| n.detail.contains("BulletItem") || n.detail.contains("plain")),
        "note 须点名降级目标: {:?}",
        notes
    );

    // 勾选仍可点名（kind 加深不破坏既有 plain 契约）
    let done = bid("11111111-1111-4111-a111-111111111111");
    assert_eq!(
        out.tree.get(&done).unwrap().text_snapshot.as_deref(),
        Some("[x] 已完成任务")
    );
}

/// 新测 4) 有序任务列表：OrderedItem + TaskItem 缺席 note + 勾选 plain + RT-3。
#[test]
fn gfm_core_ordered_task_kind_absent_note_and_rt3() {
    let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
1. [x] 有序完成

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
1. [ ] 有序待办
";
    let out = parse_document_detailed(md).unwrap();
    let a = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let b = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(out.tree.get(&a).unwrap().kind, BlockKind::OrderedItem);
    assert_eq!(out.tree.get(&b).unwrap().kind, BlockKind::OrderedItem);
    assert_eq!(
        out.tree.get(&a).unwrap().text_snapshot.as_deref(),
        Some("[x] 有序完成")
    );
    assert_eq!(
        out.tree.get(&b).unwrap().text_snapshot.as_deref(),
        Some("[ ] 有序待办")
    );

    let note = out
        .lossy
        .items
        .iter()
        .find(|i| {
            i.code == "structure_note"
                && i.detail.contains("TaskItem")
                && i.detail.contains("OrderedItem")
        })
        .expect("ordered task list structure_note");
    assert!(
        note.detail.contains("未入 collab"),
        "detail={:?}",
        note.detail
    );

    let s1 = serialize_tree(&out.tree);
    assert!(
        s1.contains("1. [x] 有序完成") && s1.contains("1. [ ] 有序待办"),
        "{s1}"
    );
    let s2 = serialize_tree(&parse_document(&s1).unwrap());
    assert_eq!(s1, s2, "RT-3 ordered task");
}

// ── A-MD 诚实加深 · 任务项嵌套 GFM 表（组合边 · ≠ EL-06 / ≠ A-MD 全集） ──
// 本段绿 = 可点名：TaskItem 缺席 + Table 缺席 + 叶子挂容器 + 兄弟旁路 + P→S→P。
// **禁止** 将本测解读为 EL-06 关账或 A-MD-01 全集完成。

/// gfm-core 组合边：任务项作容器挂 **表降 Paragraph 叶子**；双 structure_note；兄弟任务旁路。
///
/// - 父：`BulletItem` + `[x]` plain（TaskItem kind **未入** collab）
/// - 子：表 → `Paragraph` + 行列/对齐 plain + `structure_note`（Table kind **未入** collab）
/// - 根兄弟：另一任务项不吞并
/// - **≠** 真 `Table`/`TaskItem` 树状 kind；**≠ EL-06**；**≠ A-MD 全集**
#[test]
fn golden_gfm_core_task_nested_table_paragraph_child() {
    let md = include_str!("golden/gfm-core/task_nested_table.md");
    let out = parse_document_detailed(md).expect("parse task_nested_table");
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let table = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let sibling = bid("33333333-3333-4333-a333-333333333333");

    // 根：父任务 + 兄弟任务（表挂在父任务下，不在 root）
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(
        n_parent.kind,
        BlockKind::BulletItem,
        "TaskItem 未入 collab → BulletItem"
    );
    assert_eq!(
        n_parent.text_snapshot.as_deref(),
        Some("[x] 父任务：嵌套表容器")
    );
    assert_eq!(n_parent.children, vec![table]);
    assert_eq!(n_parent.parent, None);

    let n_table = tree.get(&table).unwrap();
    assert_eq!(
        n_table.kind,
        BlockKind::Paragraph,
        "Table kind 未入 collab → Paragraph 叶子挂任务下"
    );
    assert_eq!(n_table.parent, Some(parent));
    assert!(n_table.children.is_empty(), "表降级后仍为叶子");
    let snap = n_table.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snap.contains("左") && snap.contains("右") && snap.contains("甲") && snap.contains("乙"),
        "单元格 plain 可点名: {snap}"
    );
    assert!(
        snap.contains(":---") && snap.contains("---:"),
        "左/右对齐须进 plain: {snap}"
    );
    assert!(snap.contains('|'), "须保留表格可读形态: {snap}");

    let n_sib = tree.get(&sibling).unwrap();
    assert_eq!(n_sib.kind, BlockKind::BulletItem);
    assert_eq!(n_sib.text_snapshot.as_deref(), Some("[ ] 兄弟未完成任务"));
    assert!(n_sib.children.is_empty());
    assert_eq!(n_sib.parent, None);

    // 双 structure_note：TaskItem 缺席 + Table 缺席（组合边可点名）
    let task_note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note" && i.detail.contains("TaskItem"))
        .expect("task_nested_table 须 TaskItem structure_note");
    assert!(
        task_note.detail.contains("未入 collab"),
        "TaskItem note: {:?}",
        task_note.detail
    );
    let table_note = out
        .lossy
        .items
        .iter()
        .find(|i| {
            i.code == "structure_note" && (i.detail.contains("表格") || i.detail.contains("Table"))
        })
        .expect("task_nested_table 须 Table structure_note");
    assert!(
        table_note.detail.contains("未入 collab"),
        "Table note: {:?}",
        table_note.detail
    );
    assert!(
        table_note.detail.contains("2×2") || table_note.detail.contains("2x2"),
        "2 行×2 列可点名: {:?}",
        table_note.detail
    );

    // S 保留任务语法 + 表 plain；结构往返
    let md2 = serialize_tree(tree);
    assert!(
        md2.contains("- [x] 父任务：嵌套表容器") && md2.contains("- [ ] 兄弟未完成任务"),
        "S 任务项: {md2}"
    );
    assert!(
        md2.contains("左") && md2.contains("甲"),
        "S 表单元格: {md2}"
    );
    let tree2 = parse_document(&md2).unwrap();
    assert!(
        structure_eq(tree, &tree2),
        "task nested table RT md2=\n{md2}"
    );

    // RT-3 双次稳定
    let s1 = serialize_tree(tree);
    let s2 = serialize_tree(&parse_document(&s1).unwrap());
    assert_eq!(s1, s2, "RT-3 task nested table");
    assert_eq!(document_to_md(tree), s1);
}

// ── A-MD 诚实加深 · 引用内嵌套 GFM 表（flatten · ≠ EL-06 / ≠ A-MD 全集 / ≠ task_nested_table） ──
// 本段绿 = 可点名：Quote + 表单元格进 Quote plain（blockquote_plain / mdast to_string）。
// **禁止** 将本测解读为 EL-06 关账、A-MD-01 全集、或「Quote 子树保留 Table」。

/// gfm-core 组合边：blockquote **内含** GFM 表 → 本引擎 **flatten** 进单 Quote plain。
///
/// 实际树语义（禁止说成「保留 Quote 子树挂 Table」）：
/// - `lower_flow` 遇 `Node::Blockquote` 只建 **一个** `Quote`；子节点走 `blockquote_plain`
///   （表走 mdast `to_string()` 单元格连写，**不**走 `table_plain`，**无** `|` / 对齐行）
/// - **不**建 Table/Paragraph 子块；**不**发 Table `structure_note`（表未进 `Node::Table` lowering）
/// - 源级后续普通段落因 Quote 秩=10 挂为 **Quote 子叶子**（assemble 容器栈；不是表子树）
/// - Table kind **未入** collab；**≠ EL-06**；**≠ A-MD-01 全集**；**≠** `task_nested_table` 重做
#[test]
fn golden_gfm_core_blockquote_nested_table_structure_or_plain() {
    let md = include_str!("golden/gfm-core/blockquote_nested_table.md");
    let out = parse_document_detailed(md).expect("parse blockquote_nested_table");
    let tree = &out.tree;

    let quote = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    // 根只有 Quote；表不是根级 Paragraph（对比 table.md / task_nested_table）
    assert_eq!(tree.root_children, vec![quote]);

    let n_quote = tree.get(&quote).unwrap();
    assert_eq!(n_quote.kind, BlockKind::Quote, "blockquote → Quote 容器");
    assert_eq!(n_quote.parent, None);
    // 表 flatten 进 Quote.plain：导语 + 单元格连写（左右甲乙），无管道/对齐
    assert_eq!(
        n_quote.text_snapshot.as_deref(),
        Some("引用导语：嵌套表扁平进 Quote plain\n左右甲乙")
    );
    let snap = n_quote.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snap.contains("左") && snap.contains("右") && snap.contains("甲") && snap.contains("乙"),
        "表单元格须可点名进 Quote plain: {snap}"
    );
    assert!(
        !snap.contains('|') && !snap.contains(":---") && !snap.contains("---:"),
        "flatten 走 to_string 非整表 table_plain: {snap}"
    );
    // 源级旁路段挂 Quote 下；children 里没有「表降 Paragraph」
    assert_eq!(
        n_quote.children,
        vec![after],
        "旁路段因秩=10 挂 Quote；表不建子块"
    );

    let n_after = tree.get(&after).unwrap();
    assert_eq!(n_after.kind, BlockKind::Paragraph);
    assert_eq!(n_after.parent, Some(quote));
    assert!(n_after.children.is_empty());
    assert_eq!(n_after.text_snapshot.as_deref(), Some("引用后旁路段落"));

    // 引用内表未走 Node::Table lowering → 无 Table structure_note（诚实：不是漏检「保留子树」）
    assert!(
        !out.lossy.items.iter().any(|i| {
            i.code == "structure_note" && (i.detail.contains("表格") || i.detail.contains("Table"))
        }),
        "blockquote 内表 flatten，不应假装已发 Table note: {:?}",
        out.lossy
    );

    // S：Quote 多行 `>`；单元格已是连写 plain。结构往返（P→S→P）
    let md2 = serialize_tree(tree);
    assert!(
        md2.contains("> 引用导语：嵌套表扁平进 Quote plain") && md2.contains("> 左右甲乙"),
        "S Quote 扁平行: {md2}"
    );
    assert!(md2.contains("引用后旁路段落"), "S 旁路段: {md2}");
    let tree2 = parse_document(&md2).unwrap();
    assert!(
        structure_eq(tree, &tree2),
        "blockquote nested table flatten RT md2=\n{md2}"
    );

    // RT-3 双次稳定
    let s1 = serialize_tree(tree);
    let s2 = serialize_tree(&parse_document(&s1).unwrap());
    assert_eq!(s1, s2, "RT-3 blockquote nested table flatten");
    assert_eq!(document_to_md(tree), s1);
}

// ── A-MD 诚实加深 · 普通列表内嵌套 GFM 表（表降 Paragraph 叶子 · ≠ flatten / ≠ EL-06 / ≠ 旧 golden 重做） ──
// 本段绿 = 可点名：普通 BulletItem 容器 + 表走 Node::Table lowering 降 Paragraph 叶子 + Table note + 兄弟旁路。
// **禁止** 将本测解读为 EL-06 关账、A-MD-01 全集、「保留 Table 子树」、或 Quote/任务项套表重做。

/// gfm-core 组合边：普通列表（**非 task**）**内含** GFM 表。
///
/// 实际树语义（禁止说成 flatten，也禁止说成「保留 Table 子树」）：
/// - **不是** blockquote 那种 flatten：表 **不** 并进 `BulletItem.plain`，**不** 走 `to_string()` 单元格连写
/// - `lower_list` 首段 → 项文本；表在 trailing / 后续 flow 中走 `Node::Table` lowering
///   → `Paragraph` + `table_plain`（`|` / 对齐行）+ Table `structure_note`（kind **未入** collab）
/// - assemble 容器栈：`BulletItem` 秩=10，表降级叶子挂父项下（与 `task_nested_table` 同挂法，但无勾选 / 无 TaskItem note）
/// - 根兄弟另一普通项不吞并
/// - **≠ EL-06**；**≠ A-MD-01 全集**；**≠** `task_nested_table` / `blockquote_nested_table` 重做
#[test]
fn golden_gfm_core_list_nested_table_paragraph_child() {
    let md = include_str!("golden/gfm-core/list_nested_table.md");
    let out = parse_document_detailed(md).expect("parse list_nested_table");
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let table = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let sibling = bid("33333333-3333-4333-a333-333333333333");

    // 根：父普通项 + 兄弟普通项（表挂在父项下，不在 root）
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(n_parent.kind, BlockKind::BulletItem, "普通无序项");
    assert_eq!(
        n_parent.text_snapshot.as_deref(),
        Some("父无序项：嵌套表容器"),
        "非 task：plain 不得带 [x]/[ ]"
    );
    assert!(
        !n_parent
            .text_snapshot
            .as_deref()
            .unwrap_or("")
            .contains('[')
            && !n_parent
                .text_snapshot
                .as_deref()
                .unwrap_or("")
                .contains(']'),
        "普通列表不得编入 checkbox: {:?}",
        n_parent.text_snapshot
    );
    assert_eq!(n_parent.children, vec![table], "表降 Paragraph 叶子挂父项，非 flatten");
    assert_eq!(n_parent.parent, None);

    let n_table = tree.get(&table).unwrap();
    assert_eq!(
        n_table.kind,
        BlockKind::Paragraph,
        "Table kind 未入 collab → Paragraph 叶子（不是 Table 子树）"
    );
    assert_eq!(n_table.parent, Some(parent));
    assert!(n_table.children.is_empty(), "表降级后仍为叶子");
    let snap = n_table.text_snapshot.as_deref().unwrap_or("");
    assert!(
        snap.contains("左") && snap.contains("右") && snap.contains("甲") && snap.contains("乙"),
        "单元格 plain 可点名: {snap}"
    );
    assert!(
        snap.contains(":---") && snap.contains("---:") && snap.contains('|'),
        "须走 table_plain（| / 对齐），不是 to_string 连写 flatten: {snap}"
    );

    let n_sib = tree.get(&sibling).unwrap();
    assert_eq!(n_sib.kind, BlockKind::BulletItem);
    assert_eq!(n_sib.text_snapshot.as_deref(), Some("兄弟无序项"));
    assert!(n_sib.children.is_empty());
    assert_eq!(n_sib.parent, None);

    // 仅 Table 缺席 note；普通列表不得假装 TaskItem 列表
    assert!(
        !out.lossy
            .items
            .iter()
            .any(|i| i.code == "structure_note" && i.detail.contains("TaskItem")),
        "非 task 列表不应发 TaskItem note: {:?}",
        out.lossy
    );
    let table_note = out
        .lossy
        .items
        .iter()
        .find(|i| {
            i.code == "structure_note" && (i.detail.contains("表格") || i.detail.contains("Table"))
        })
        .expect("list_nested_table 须 Table structure_note（证明走了 Node::Table，不是 flatten）");
    assert!(
        table_note.detail.contains("未入 collab"),
        "Table note: {:?}",
        table_note.detail
    );
    assert!(
        table_note.detail.contains("2×2") || table_note.detail.contains("2x2"),
        "2 行×2 列可点名: {:?}",
        table_note.detail
    );

    // S：普通 bullet + 表 plain；结构往返
    let md2 = serialize_tree(tree);
    assert!(
        md2.contains("- 父无序项：嵌套表容器") && md2.contains("- 兄弟无序项"),
        "S 普通列表项: {md2}"
    );
    assert!(
        !md2.contains("- [") && !md2.contains("[x]") && !md2.contains("[ ]"),
        "S 不得编成任务列表: {md2}"
    );
    assert!(
        md2.contains("左") && md2.contains("甲") && md2.contains('|'),
        "S 表单元格: {md2}"
    );
    let tree2 = parse_document(&md2).unwrap();
    assert!(
        structure_eq(tree, &tree2),
        "list nested table RT md2=\n{md2}"
    );

    // RT-3 双次稳定
    let s1 = serialize_tree(tree);
    let s2 = serialize_tree(&parse_document(&s1).unwrap());
    assert_eq!(s1, s2, "RT-3 list nested table");
    assert_eq!(document_to_md(tree), s1);
}
