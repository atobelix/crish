//! W2-A 续加深 · golden/kind（A-MD-01 方向子集 · **≠ 全集 / ≠ EL-06**）。
//!
//! 输入：`tests/golden/**`（task nested / fence info / nested blockquote / nested list 扁平模型）
//!
//! # 诚实边界（强制）
//! - 本文件绿 = 可点名结构类 **续加深** 可测（任务嵌套段落 / 围栏 lang·meta /
//!   嵌套引用扁平 / 同秩列表扁平）
//! - **≠ A-MD-01 全集关账**（§3.6 仍有未覆盖类；本包非全表）
//! - **≠ EL-06**（见 `plans/08` / `acceptance/EL-dashboard`；**禁止** 本批 golden 关 EL）
//! - **≠ W2-B**（不改 ApplyReport / lossy 透出契约）
//! - 列表 **同秩** BulletItem/OrderedItem 不互挂父子（容器栈秩=10 弹出）；真嵌套列表语义 **未** 关
//! - 围栏 **lang/meta** 未进 `BlockKind::Code` 载荷；S 输出空 info；有 info 时 `structure_note` 可点名
//! - 嵌套 blockquote 在 mdast 内扁平进 Quote plain（**无** 子 Quote 块）

use conex_md_ast::{
    document_to_md, parse_document, parse_document_detailed, serialize_tree, structure_eq, BlockId,
    BlockKind,
};
use std::str::FromStr;

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

// ── 1) 任务列表嵌套段落（task nested · 叶子挂容器） ──

/// GFM 任务项作容器：勾选 plain + 子段落父子 + TaskItem 缺席 note + P→S→P。
///
/// **≠** 同秩任务列表真嵌套（缩进 `- [ ]` 子任务仍扁平为兄弟，见 nested_list 模型）。
#[test]
fn golden_task_nested_paragraph_under_task_item() {
    let md = include_str!("golden/gfm-core/task_nested_paragraph.md");
    let out = parse_document_detailed(md).expect("parse task_nested_paragraph");
    let tree = &out.tree;

    let parent = bid("11111111-1111-4111-a111-111111111111");
    let child = bid("22222222-2222-4222-a222-222222222222");
    let sibling = bid("33333333-3333-4333-a333-333333333333");

    // 根：父任务 + 兄弟任务（子段落挂在父任务下，不在 root）
    assert_eq!(tree.root_children, vec![parent, sibling]);

    let n_parent = tree.get(&parent).unwrap();
    assert_eq!(n_parent.kind, BlockKind::BulletItem, "TaskItem 未入 collab");
    assert_eq!(
        n_parent.text_snapshot.as_deref(),
        Some("[x] 父任务：容器项")
    );
    assert_eq!(n_parent.children, vec![child]);
    assert_eq!(tree.get(&child).unwrap().parent, Some(parent));
    assert_eq!(tree.get(&child).unwrap().kind, BlockKind::Paragraph);
    assert_eq!(
        tree.get(&child).unwrap().text_snapshot.as_deref(),
        Some("子段落挂在任务项下（task nested · 叶子挂容器）")
    );

    let n_sib = tree.get(&sibling).unwrap();
    assert_eq!(n_sib.kind, BlockKind::BulletItem);
    assert_eq!(n_sib.text_snapshot.as_deref(), Some("[ ] 兄弟未完成任务"));
    assert!(n_sib.children.is_empty());

    // TaskItem kind 缺席诚实 note
    let task_note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note" && i.detail.contains("TaskItem"))
        .expect("task nested 须 TaskItem structure_note");
    assert!(
        task_note.detail.contains("未入 collab"),
        "detail={:?}",
        task_note.detail
    );

    // S 保留任务语法；结构往返
    let md2 = serialize_tree(tree);
    assert!(
        md2.contains("- [x] 父任务：容器项") && md2.contains("- [ ] 兄弟未完成任务"),
        "S 任务项: {md2}"
    );
    assert!(md2.contains("子段落挂在任务项下"), "S 子段落: {md2}");
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(tree, &tree2), "task nested RT md2=\n{md2}");

    // RT-3 双次稳定
    let s1 = serialize_tree(tree);
    let s2 = serialize_tree(&parse_document(&s1).unwrap());
    assert_eq!(s1, s2, "RT-3 task nested");
}

// ── 2) 围栏代码 info（lang + meta）诚实 ──

/// 围栏 lang/meta：P 可识别 → structure_note 可点名；kind=Code；正文守恒；S 空 info；旁路段。
///
/// **≠** 围栏 info 进 kind 载荷 / S 保 lang（A-MD-01 围栏语言未关）。
#[test]
fn golden_fenced_code_info_lang_meta_structure_note() {
    let md = include_str!("golden/fenced_code_info.md");
    let out = parse_document_detailed(md).expect("parse fenced_code_info");

    let code_id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let after_id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert_eq!(out.tree.root_children, vec![code_id, after_id]);

    let n = out.tree.get(&code_id).unwrap();
    assert_eq!(n.kind, BlockKind::Code);
    // exhaustiveness：Code 无 lang 字段可匹配
    match &n.kind {
        BlockKind::Code => {}
        other => panic!("须为 Code，得 {other:?}"),
    }
    assert_eq!(
        n.text_snapshot.as_deref(),
        Some("fn hello() {\n    println!(\"fence info\");\n}")
    );
    assert!(n.children.is_empty());

    // 有 lang/meta → structure_note 可点名丢弃的 info
    let note = out
        .lossy
        .items
        .iter()
        .find(|i| i.code == "structure_note" && i.detail.contains("围栏代码 info"))
        .expect("fence info structure_note");
    assert!(
        note.detail.contains("lang=rust"),
        "须点名 lang=rust: {:?}",
        note.detail
    );
    // meta 视 markdown-rs 是否拆出 title=…；有则点名，无则至少 lang 已诚实
    assert!(
        note.detail.contains("丢弃") || note.detail.contains("不进"),
        "须诚实声明不进 Code 载荷: {:?}",
        note.detail
    );

    assert_eq!(
        out.tree.get(&after_id).unwrap().text_snapshot.as_deref(),
        Some("旁路段落：围栏 info 之后")
    );

    // S：围栏 info 空；正文仍在；P→S→P 结构幂等
    let md2 = serialize_tree(&out.tree);
    assert!(
        md2.contains("```\nfn hello()") || md2.contains("```\r\nfn hello()"),
        "S 须空 lang 围栏: {md2}"
    );
    assert!(
        !md2.contains("```rust"),
        "S 不得保留 lang（当前契约）: {md2}"
    );
    assert!(md2.contains("println!(\"fence info\")"), "正文: {md2}");
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&out.tree, &tree2), "fence info RT md2=\n{md2}");
    assert_eq!(document_to_md(&out.tree), md2);
}

// ── 3) 嵌套 blockquote 扁平进 plain ──

/// mdast 内嵌套 `>` 扁平为单 Quote 多行 plain；无子 Quote 块；旁路独立 Quote；RT。
///
/// **≠** 嵌套 Quote 树状 kind（子引用不单独建块）。
#[test]
fn golden_nested_blockquote_flatten_to_plain() {
    let md = include_str!("golden/nested_blockquote.md");
    let tree = parse_document(md).expect("parse nested_blockquote");

    let nested_id = bid("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    let plain_q = bid("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    assert_eq!(tree.root_children, vec![nested_id, plain_q]);

    let n = tree.get(&nested_id).unwrap();
    assert_eq!(n.kind, BlockKind::Quote);
    let snap = n.text_snapshot.as_deref().unwrap_or("");
    // 外层 / 内层 / 续行均进同一 Quote plain（blockquote_plain 扁平）
    assert!(snap.contains("外层引用"), "outer: {snap}");
    assert!(snap.contains("内层嵌套引用"), "inner: {snap}");
    assert!(
        snap.contains("外层续行") && snap.contains("✨"),
        "续行 emoji: {snap}"
    );
    // 无子 Quote 块
    assert!(
        n.children.is_empty(),
        "嵌套引用不建子 Quote 块，children={:?}",
        n.children
    );
    // 不得残留 `>` 字面进 plain
    assert!(!snap.contains('>'), "plain 不应残留 > : {snap}");

    let n2 = tree.get(&plain_q).unwrap();
    assert_eq!(n2.kind, BlockKind::Quote);
    assert_eq!(n2.text_snapshot.as_deref(), Some("独立单层引用旁路"));

    let md2 = serialize_tree(&tree);
    assert!(md2.contains("> 外层引用"), "S: {md2}");
    assert!(md2.contains("> 内层嵌套引用"), "S 扁平行: {md2}");
    assert!(md2.contains("> 独立单层引用旁路"), "S 旁路: {md2}");
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "nested quote RT md2=\n{md2}");
}

// ── 4) 同秩嵌套列表 → 扁平兄弟模型（诚实可测） ──

/// 缩进「嵌套」列表项：容器栈同秩弹出 → **根级兄弟**，非父子。
///
/// 诚实：真嵌套列表语义 **未** 关闭（A-MD-01 嵌套列表类）；本测钉死当前模型，防静默改栈。
#[test]
fn golden_nested_list_same_rank_flattens_to_siblings() {
    let md = include_str!("golden/nested_list_sibling_model.md");
    let tree = parse_document(md).expect("parse nested_list_sibling_model");

    let parentish = bid("11111111-1111-4111-a111-111111111111");
    let nested = bid("22222222-2222-4222-a222-222222222222");
    let sibling = bid("33333333-3333-4333-a333-333333333333");

    // 三者均在 root，无父子
    assert_eq!(
        tree.root_children,
        vec![parentish, nested, sibling],
        "同秩列表项须扁平为根兄弟"
    );
    for id in [parentish, nested, sibling] {
        let n = tree.get(&id).unwrap();
        assert_eq!(n.kind, BlockKind::BulletItem);
        assert_eq!(n.parent, None, "{id} 不得挂父");
        assert!(
            n.children.is_empty(),
            "{id} 同秩嵌套不进 children: {:?}",
            n.children
        );
    }
    assert_eq!(
        tree.get(&parentish).unwrap().text_snapshot.as_deref(),
        Some("父无序项")
    );
    assert_eq!(
        tree.get(&nested).unwrap().text_snapshot.as_deref(),
        Some("缩进嵌套子项（同秩容器 → 扁平兄弟，非父子）")
    );
    assert_eq!(
        tree.get(&sibling).unwrap().text_snapshot.as_deref(),
        Some("根级兄弟项")
    );

    // 对照：叶子段落仍可挂列表项（既有容器模型，防本测误伤）
    // 结构往返：扁平兄弟保持
    let md2 = document_to_md(&tree);
    let tree2 = parse_document(&md2).unwrap();
    assert!(structure_eq(&tree, &tree2), "flat list RT md2=\n{md2}");
}

/// 列表项 + 码块子叶：叶子 Code 可挂 BulletItem（与同秩列表扁平对照）。
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
    let out = parse_document_detailed(md).unwrap();
    let bullet = bid("11111111-1111-4111-a111-111111111111");
    let code = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert_eq!(out.tree.root_children, vec![bullet]);
    let bn = out.tree.get(&bullet).unwrap();
    assert_eq!(bn.kind, BlockKind::BulletItem);
    assert_eq!(bn.children, vec![code]);
    let cn = out.tree.get(&code).unwrap();
    assert_eq!(cn.kind, BlockKind::Code);
    assert_eq!(cn.parent, Some(bullet));
    assert_eq!(cn.text_snapshot.as_deref(), Some("print(1)"));
    // python lang → fence info note
    assert!(
        out.lossy
            .items
            .iter()
            .any(|i| i.code == "structure_note" && i.detail.contains("lang=python")),
        "list+code 的 fence info note: {:?}",
        out.lossy
    );
    let again = parse_document(&document_to_md(&out.tree)).unwrap();
    assert!(structure_eq(&out.tree, &again));
}
