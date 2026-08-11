//! Loro 对照 oracle（dev-only 集成测试骨架，W0-L / H1 逃生门 + M1 树规则）。
//!
//! # 边界
//! - **仅** `cargo test` 路径编译链接 `loro`（见 `Cargo.toml` `[dev-dependencies]`）。
//! - 生产 [`conex_doc_collab::DocSession`] **不得** 依赖 loro；本文件不 `use` 生产 apply 路径的 loro 绑定。
//! - 对照失败时：修自研规则（`concurrent-move-rules.md`），**不**默默切主路径到 Loro（A-SWAP 另议）。
//!
//! # 骨架范围（占位，后续属性测扩展）
//! - movable tree：insert + move 无环
//! - movable tree：本地 move 入子孙 → `CyclicMoveError`
//! - movable list：insert + mov 顺序可观测（并发合并对照的入口）
//!
//! 规格锚点：
//! - `docs/block-workspace-architecture/18-实现波前待决锁定-H1H2H3M1.md` §H1 逃生门 / §M1 Loro 对照
//! - `docs/block-workspace-architecture/plans/specs/concurrent-move-rules.md`

use loro::{LoroDoc, LoroError, LoroTreeError, TreeParentId};

/// 从 `start` 沿 parent 上溯到 Root，检测是否无环且有穷终止。
fn path_to_root_is_acyclic(tree: &loro::LoroTree, start: loro::TreeID) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut cur = start;
    // 节点数上界：visited 超 nodes 必环
    let bound = tree.nodes().len().saturating_mul(2).max(8);
    for _ in 0..bound {
        if !seen.insert(cur) {
            return false;
        }
        match tree.parent(cur) {
            Some(TreeParentId::Root) | None => return true,
            Some(TreeParentId::Node(p)) => cur = p,
            Some(TreeParentId::Deleted) => return true, // 删除侧视为终止
            // 未来枚举扩展时保守失败，避免静默放过环
            Some(_) => return false,
        }
    }
    false
}

/// ORACLE-TREE-01：基本 create + mov，父子关系正确且无环。
///
/// 对照用途：自研 `Op::Move` 落地后，同形状操作应得到等价无环森林。
#[test]
fn oracle_movable_tree_insert_and_move_no_cycle() {
    let doc = LoroDoc::new();
    let tree = doc.get_tree("blocks");
    // fractional index 与 M1 规则表 order 语义对齐（siblings 有序）
    tree.enable_fractional_index(0);

    let a = tree.create(None).expect("root a");
    let b = tree.create(None).expect("root b");
    // b 移到 a 下
    tree.mov(b, a).expect("mov b under a");
    doc.commit();

    assert_eq!(
        tree.parent(a),
        Some(TreeParentId::Root),
        "a 仍为根"
    );
    assert_eq!(
        tree.parent(b),
        Some(TreeParentId::Node(a)),
        "b 的 parent 为 a"
    );
    let kids = tree.children(a).expect("a children");
    assert!(kids.contains(&b), "a.children 含 b: {kids:?}");

    assert!(
        path_to_root_is_acyclic(&tree, a),
        "从 a 上溯无环"
    );
    assert!(
        path_to_root_is_acyclic(&tree, b),
        "从 b 上溯无环"
    );
}

/// ORACLE-TREE-02：本地将祖先 move 到子孙下 → Loro 拒绝（CyclicMoveError）。
///
/// 对照用途：自研 MV-04（move 到自身子孙）应拒或破环；本 oracle 记录 Loro 本地拒语义。
#[test]
fn oracle_movable_tree_cyclic_move_rejected() {
    let doc = LoroDoc::new();
    let tree = doc.get_tree("blocks");
    tree.enable_fractional_index(0);

    let a = tree.create(None).expect("a");
    let b = tree.create(a).expect("b under a");
    let c = tree.create(b).expect("c under b");

    // a → 挂到 c 下会成环
    let err = tree.mov(a, c).expect_err("成环 move 应失败");
    match err {
        LoroError::TreeError(LoroTreeError::CyclicMoveError) => {}
        other => panic!("期望 CyclicMoveError，得到: {other:?}"),
    }

    // 树形态不变
    assert_eq!(tree.parent(a), Some(TreeParentId::Root));
    assert_eq!(tree.parent(b), Some(TreeParentId::Node(a)));
    assert_eq!(tree.parent(c), Some(TreeParentId::Node(b)));
    assert!(path_to_root_is_acyclic(&tree, c));
}

/// ORACLE-LIST-01：movable list insert + mov（并发 order 对照入口占位）。
#[test]
fn oracle_movable_list_insert_and_mov() {
    let doc = LoroDoc::new();
    let list = doc.get_movable_list("order");
    list.insert(0, "x").expect("insert x");
    list.insert(1, "y").expect("insert y");
    list.insert(2, "z").expect("insert z");
    // 将索引 0 的 x 移到末位（to=2 → [y,z,x] 语义以 loro 为准）
    list.mov(0, 2).expect("mov 0→2");
    doc.commit();

    let v = list.get_value();
    let arr = v.into_list().expect("list value");
    assert_eq!(arr.len(), 3);
    // 仅断言长度与元素集合；具体顺序作为后续并发用例的 baseline 钩子
    let texts: Vec<String> = arr
        .iter()
        .map(|x| x.as_string().map(|s| s.to_string()).unwrap_or_default())
        .collect();
    assert!(texts.contains(&"x".into()));
    assert!(texts.contains(&"y".into()));
    assert!(texts.contains(&"z".into()));
}

/// 文档锚：生产路径无 loro 符号（编译期靠 dev-dep 隔离；运行时轻量断言 crate 可独立构造 DocSession）。
#[test]
fn production_doc_session_constructs_without_loro() {
    // 若本测试能链上 DocSession，说明生产 API 不需要 loro 类型出现在签名中。
    let _s = conex_doc_collab::DocSession::new("oracle-smoke");
}
