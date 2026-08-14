//! apply 主路径 / MV-01…04 测试（SR-06g · 拆分 · 测外置 · ≠ EL）。
//!
//! 经 [`super`]（`session_tests`）接入：`use super::super::*` 取会话私有面，
//! `use super::*` 取公共助手（`insert_root` / `insert_child`）。
use super::super::*;
use super::*;
use crate::ir::{cmp_order, BlockKind, BlockProps};
use crate::persistence::MemoryPersistence;
use std::cmp::Ordering;

#[test]
fn insert_and_text_edit_single_tx() {
    let mut s = DocSession::new("d1").with_persistence(Box::new(MemoryPersistence::default()));
    let id = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    s.apply(
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "hi".into(),
        }],
    )
    .unwrap();
    assert_eq!(
        s.tree.get(&id).unwrap().text_snapshot.as_deref(),
        Some("hi")
    );
    assert_eq!(s.read_text(&id), "hi");
    assert!(s.text_is_hot(&id));
}

#[test]
fn batch_fails_atomically_on_missing_parent() {
    let mut s = DocSession::new("d1");
    let id = BlockId::new();
    let missing = BlockId::new();
    let err = s
        .apply(
            Origin::Agent,
            &[Op::Insert {
                id,
                parent: Some(missing),
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::NotFound(_)));
    assert!(s.tree.nodes.is_empty());
}

#[test]
fn delete_releases_node_a_inv_09c() {
    let mut s = DocSession::new("d1");
    let id = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    s.apply(Origin::User, &[Op::Delete { id }]).unwrap();
    assert!(s.tree.nodes.is_empty());
    assert!(!s.text_is_registered(&id));
}

/// MV-01：同父并发 order 插入 → 全序稳定（字典序），无环。
#[test]
fn mv01_same_parent_order_inserts_stable() {
    let mut s = DocSession::new("d1");
    let parent = BlockId::new();
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();
    insert_root(&mut s, parent, "a0");

    // 同批乱序 order 插入：应用后兄弟应按 fractional 字典序排列
    s.apply(
        Origin::User,
        &[
            Op::Insert {
                id: b,
                parent: Some(parent),
                order: "a2".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Insert {
                id: a,
                parent: Some(parent),
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Insert {
                id: c,
                parent: Some(parent),
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
        ],
    )
    .unwrap();

    let children = &s.tree.get(&parent).unwrap().children;
    assert_eq!(children, &[a, c, b], "order a0 < a1 < a2 决定全序");
    assert_eq!(cmp_order("a0", "a1"), Ordering::Less);
    // 无环：子节点 parent 均为 parent
    for id in children {
        assert_eq!(s.tree.get(id).unwrap().parent, Some(parent));
    }
}

/// MV-02 基础：A→B 子 与 反向会成环时拒（单端 apply 路径）。
#[test]
fn mv02_cross_parent_cycle_rejected() {
    let mut s = DocSession::new("d1");
    let a = BlockId::new();
    let b = BlockId::new();
    insert_root(&mut s, a, "a0");
    insert_child(&mut s, b, a, "a0"); // B under A

    // 再把 A 移到 B 下 → 成环
    let err = s
        .apply(
            Origin::Remote,
            &[Op::Move {
                id: a,
                new_parent: Some(b),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::Invariant(_)));
    // 树未变
    assert_eq!(s.tree.get(&a).unwrap().parent, None);
    assert_eq!(s.tree.get(&b).unwrap().parent, Some(a));
}

/// MV-03：同批 delete(A) + move(B under A) → 删胜；整批 NotFound，原子回滚。
#[test]
fn mv03_same_batch_delete_wins_over_move_under_deleted() {
    let mut s = DocSession::new("d1");
    let a = BlockId::new();
    let b = BlockId::new();
    insert_root(&mut s, a, "a0");
    insert_root(&mut s, b, "a1");
    let rev_before = s.rev;
    let nodes_before = s.tree.nodes.len();

    // 顺序：先 delete 后 move；预校验展开删除闭包后 move 目标 NotFound
    let err = s
        .apply(
            Origin::Remote,
            &[
                Op::Delete { id: a },
                Op::Move {
                    id: b,
                    new_parent: Some(a),
                    order: "a0".into(),
                },
            ],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::NotFound(_)));
    assert_eq!(s.rev, rev_before, "失败不增 rev");
    assert_eq!(s.tree.nodes.len(), nodes_before, "整批原子：节点数不变");
    assert!(s.tree.nodes.contains_key(&a));
    assert_eq!(s.tree.get(&b).unwrap().parent, None);

    // 反序 ops 同样整批失败（删闭包与顺序无关）
    let err2 = s
        .apply(
            Origin::Remote,
            &[
                Op::Move {
                    id: b,
                    new_parent: Some(a),
                    order: "a0".into(),
                },
                Op::Delete { id: a },
            ],
        )
        .unwrap_err();
    assert!(matches!(err2, ApplyError::NotFound(_)));
    assert!(s.tree.nodes.contains_key(&a));
    assert_eq!(s.tree.get(&b).unwrap().parent, None);
}

/// MV-03 变体：跨事务 delete 后再 move → NotFound（目标不存在）。
#[test]
fn mv03_sequential_delete_then_move_not_found() {
    let mut s = DocSession::new("d1");
    let a = BlockId::new();
    let b = BlockId::new();
    insert_root(&mut s, a, "a0");
    insert_root(&mut s, b, "a1");
    s.apply(Origin::User, &[Op::Delete { id: a }]).unwrap();

    let err = s
        .apply(
            Origin::Remote,
            &[Op::Move {
                id: b,
                new_parent: Some(a),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::NotFound(_)));
    assert_eq!(s.tree.get(&b).unwrap().parent, None);
}

/// MV-04：move 到自身子孙 → 拒。
#[test]
fn mv04_move_under_descendant_rejected() {
    let mut s = DocSession::new("d1");
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();
    insert_root(&mut s, a, "a0");
    insert_child(&mut s, b, a, "a0");
    insert_child(&mut s, c, b, "a0"); // A → B → C

    // A 移到 C 下（子孙）
    let err = s
        .apply(
            Origin::User,
            &[Op::Move {
                id: a,
                new_parent: Some(c),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(matches!(err, ApplyError::Invariant(_)));

    // 自身作为 parent
    let err_self = s
        .apply(
            Origin::User,
            &[Op::Move {
                id: a,
                new_parent: Some(a),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(matches!(err_self, ApplyError::Invariant(_)));

    // 合法：C 移到根下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: c,
            new_parent: None,
            order: "a9".into(),
        }],
    )
    .unwrap();
    assert_eq!(s.tree.get(&c).unwrap().parent, None);
    assert!(s.tree.root_children.contains(&c));
}
