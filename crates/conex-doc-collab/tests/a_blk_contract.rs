//! A-BLK 契约/属性抽样（Round9 · W6-A）。
//!
//! **本文件 ≠ 关闭 EL-01 / A-BLK 全表**：只钉 create/move/delete 后 `block_id` 稳定、
//! 单次 `Op::Move` 重排 order、以及 indent/nest 的 Move 半覆盖。
//!
//! 权威：`docs/block-workspace-architecture/round-D-stack/07-技术栈矩阵裁决.md` §5.1
//! 进度：`docs/block-workspace-architecture/plans/acceptance/A-BLK-progress.md`

use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, DocSession, Op, Origin,
};

fn insert_root(s: &mut DocSession, id: BlockId, order: &str) {
    s.apply(
        Origin::User,
        &[Op::Insert {
            id,
            parent: None,
            order: order.into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect("insert root");
}

/// A-BLK-01：create / move / delete 后 `block_id` 稳定可解析。
///
/// - create：Insert 后节点 id 与调用方预分配 id 相同
/// - move：移动后 id 不变，parent/order 更新，引用仍可 `tree.get`
/// - delete：被删 id 从树消失；未删兄弟 id 不变
///
/// 撤销（undo）结构 API 尚未暴露 → 本测不覆盖；进度表 A-BLK-01 撤销列为 W6-A 余量。
#[test]
fn a_blk_01_block_id_stable_after_create_move_delete() {
    let mut s = DocSession::new("a-blk-01");
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();

    // create：预分配 id 即权威 id
    insert_root(&mut s, a, "a0");
    insert_root(&mut s, b, "a1");
    insert_root(&mut s, c, "a2");
    assert!(s.tree().nodes.contains_key(&a));
    assert!(s.tree().nodes.contains_key(&b));
    assert!(s.tree().nodes.contains_key(&c));
    assert_eq!(s.tree().get(&a).unwrap().id, a);
    assert_eq!(s.tree().get(&b).unwrap().id, b);
    assert_eq!(s.tree().get(&c).unwrap().id, c);

    // move：b 移到 a 下；b 的 BlockId 不变
    s.apply(
        Origin::User,
        &[Op::Move {
            id: b,
            new_parent: Some(a),
            order: "a0".into(),
        }],
    )
    .expect("move b under a");
    assert_eq!(s.tree().get(&b).unwrap().id, b, "move 后 block_id 必须稳定");
    assert_eq!(s.tree().get(&b).unwrap().parent, Some(a));
    assert!(
        s.tree().get(&a).unwrap().children.contains(&b),
        "父 children 仍以原 block_id 引用"
    );
    // a、c 的 id 不受 move 影响
    assert_eq!(s.tree().get(&a).unwrap().id, a);
    assert_eq!(s.tree().get(&c).unwrap().id, c);
    assert_eq!(s.tree().get(&c).unwrap().parent, None);

    // delete：删 c；a/b 仍可解析且 id 不变
    s.apply(Origin::User, &[Op::Delete { id: c }])
        .expect("delete c");
    assert!(!s.tree().nodes.contains_key(&c));
    assert_eq!(s.tree().get(&a).unwrap().id, a);
    assert_eq!(s.tree().get(&b).unwrap().id, b);
    assert_eq!(s.tree().get(&b).unwrap().parent, Some(a));

    // 合并场景的半覆盖：同批再插 d 再删 a（级联子 b）后 d 的 id 仍稳定
    let d = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: d,
            parent: None,
            order: "a9".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .expect("insert d");
    assert_eq!(s.tree().get(&d).unwrap().id, d);
    s.apply(Origin::User, &[Op::Delete { id: a }])
        .expect("delete a cascade");
    assert!(!s.tree().nodes.contains_key(&a));
    assert!(!s.tree().nodes.contains_key(&b), "删 a 应级联释放子 b");
    assert_eq!(
        s.tree().get(&d).unwrap().id,
        d,
        "未受影响块 block_id 在删合并后仍稳定"
    );
}

/// A-BLK-04 半：`Op::Move` 单次重排兄弟 order 正确（不含拖拽落点线 e2e）。
///
/// 对齐既有 MV-01 order 语义；本测以 `a_blk_04_*` 命名显式挂 A-BLK-04 抽样。
#[test]
fn a_blk_04_move_single_reorder_order() {
    let mut s = DocSession::new("a-blk-04");
    let x = BlockId::new();
    let y = BlockId::new();
    let z = BlockId::new();
    insert_root(&mut s, x, "a0");
    insert_root(&mut s, y, "a1");
    insert_root(&mut s, z, "a2");
    assert_eq!(
        s.tree().root_children,
        vec![x, y, z],
        "初始 order a0<a1<a2"
    );

    // 单次 Move：将 z 重排到 x 之前。
    // 字典序注意：`"a00" > "a0"`（前缀更短更小），故用 `"a"` 才 < `"a0"`。
    s.apply(
        Origin::User,
        &[Op::Move {
            id: z,
            new_parent: None,
            order: "a".into(), // "a" < "a0" < "a1"
        }],
    )
    .expect("reorder z");
    assert_eq!(
        s.tree().root_children,
        vec![z, x, y],
        "单次 Move 后根兄弟 order 全序应正确"
    );
    assert_eq!(s.tree().get(&z).unwrap().order, "a");
    assert_eq!(s.tree().get(&z).unwrap().id, z, "重排不改 block_id");

    // 再 Move：y 夹到 z 与 x 之间（"a" < "a/" < "a0"，'/' < '0'）
    s.apply(
        Origin::User,
        &[Op::Move {
            id: y,
            new_parent: None,
            order: "a/".into(),
        }],
    )
    .expect("reorder y between z and x");
    assert_eq!(
        s.tree().root_children,
        vec![z, y, x],
        "二次 Move 后顺序应为 z,y,x"
    );
    // 校验 order 字典全序与 children 一致
    let roots = &s.tree().root_children;
    let o0 = s.tree().get(&roots[0]).unwrap().order.as_str();
    let o1 = s.tree().get(&roots[1]).unwrap().order.as_str();
    let o2 = s.tree().get(&roots[2]).unwrap().order.as_str();
    assert!(
        o0 <= o1 && o1 <= o2,
        "children 必须按 order 升序: {o0},{o1},{o2}"
    );
}

/// A-BLK-06 半：indent / nest 通过 `Op::Move` 改 parent 实现（无独立 Indent Op）。
///
/// 钉：把块移到另一块下 = 嵌套；再移回根 = 反缩进。
/// 列表 schema（BulletItem 缩进级、有序编号）与 MD 前缀语义 → W6-A 余量（进度黄）。
#[test]
fn a_blk_06_indent_nest_via_move_parent() {
    let mut s = DocSession::new("a-blk-06");
    let parent = BlockId::new();
    let child = BlockId::new();
    let sibling = BlockId::new();
    insert_root(&mut s, parent, "a0");
    insert_root(&mut s, child, "a1");
    insert_root(&mut s, sibling, "a2");

    // indent：child 嵌到 parent 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: child,
            new_parent: Some(parent),
            order: "a0".into(),
        }],
    )
    .expect("indent nest under parent");
    assert_eq!(s.tree().get(&child).unwrap().parent, Some(parent));
    assert!(s.tree().get(&parent).unwrap().children.contains(&child));
    assert!(!s.tree().root_children.contains(&child));
    assert_eq!(s.tree().get(&child).unwrap().id, child);

    // 更深一层：sibling 嵌到 child 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: sibling,
            new_parent: Some(child),
            order: "a0".into(),
        }],
    )
    .expect("deeper nest");
    assert_eq!(s.tree().get(&sibling).unwrap().parent, Some(child));
    assert!(s.tree().get(&child).unwrap().children.contains(&sibling));

    // outdent：sibling 回到 parent 下（仍嵌套一层）
    s.apply(
        Origin::User,
        &[Op::Move {
            id: sibling,
            new_parent: Some(parent),
            order: "a1".into(),
        }],
    )
    .expect("partial outdent");
    assert_eq!(s.tree().get(&sibling).unwrap().parent, Some(parent));
    assert_eq!(
        s.tree().get(&parent).unwrap().children,
        vec![child, sibling],
        "parent 下 children 按 order 排列"
    );

    // 全出：child 回根；sibling 仍在 parent 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: child,
            new_parent: None,
            order: "a5".into(),
        }],
    )
    .expect("outdent child to root");
    assert_eq!(s.tree().get(&child).unwrap().parent, None);
    assert!(s.tree().root_children.contains(&child));
    // 所有 id 全程稳定
    assert_eq!(s.tree().get(&parent).unwrap().id, parent);
    assert_eq!(s.tree().get(&child).unwrap().id, child);
    assert_eq!(s.tree().get(&sibling).unwrap().id, sibling);
}

/// A-BLK-01 补强：同批 create + move 后 id 仍可解析（属性向）。
#[test]
fn a_blk_01_same_batch_insert_then_move_keeps_id() {
    let mut s = DocSession::new("a-blk-01-batch");
    let host = BlockId::new();
    let leaf = BlockId::new();
    insert_root(&mut s, host, "a0");

    s.apply(
        Origin::User,
        &[
            Op::Insert {
                id: leaf,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Move {
                id: leaf,
                new_parent: Some(host),
                order: "a0".into(),
            },
        ],
    )
    .expect("same-batch insert+move");

    assert_eq!(s.tree().get(&leaf).unwrap().id, leaf);
    assert_eq!(s.tree().get(&leaf).unwrap().parent, Some(host));
    assert!(s.tree().get(&host).unwrap().children.contains(&leaf));
}
