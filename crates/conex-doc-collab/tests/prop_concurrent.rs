//! A-COL-06 骨架：并发结构 Op 属性测（固定种子伪随机）。
//!
//! # 范围（骨架，完整属性测后续加深）
//! - 两序列结构 Op（insert / move / delete）交替或乱序 apply 到双 session 再互推
//! - 或单树多次回放
//! - **至少断言**：无环（parent 链不循环）、删后无悬挂子引用
//!
//! # 非目标（本文件不强制）
//! - proptest 全家桶（未引入依赖）
//! - 真 CRDT 结构合并语义（M1 全文）；当前结构互推仍为 op 日志重放
//!
//! 规格锚点：
//! - `docs/block-workspace-architecture/18-实现波前待决锁定-H1H2H3M1.md` §M1
//! - `docs/block-workspace-architecture/plans/09-执行任务包索引.md` W1-E

use conex_doc_collab::{
    BlockId, BlockKind, BlockProps, BlockTree, DocSession, DualSessionHarness, Op, Origin, PeerSide,
};
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// 树不变量（A-COL-06 核心断言）
// ---------------------------------------------------------------------------

/// 父链无环：从每个节点沿 parent 上溯必达根（None），且步数 ≤ 节点数。
fn assert_no_parent_cycles(tree: &BlockTree) {
    let n = tree.nodes.len();
    for &start in tree.nodes.keys() {
        let mut seen = HashSet::new();
        let mut cur = Some(start);
        let mut steps = 0usize;
        while let Some(id) = cur {
            assert!(
                seen.insert(id),
                "parent 链成环：从 {start} 途经 {id} 再次出现"
            );
            steps += 1;
            assert!(
                steps <= n + 1,
                "parent 链过长（可能环）：start={start}, steps={steps}"
            );
            cur = tree.nodes.get(&id).and_then(|node| node.parent);
        }
    }
}

/// 无悬挂：children 引用的 id 必须存在；子节点 parent 指针必须回指父（或根列表一致）。
fn assert_no_dangling_child_refs(tree: &BlockTree) {
    // 根列表
    for cid in &tree.root_children {
        let child = tree
            .nodes
            .get(cid)
            .unwrap_or_else(|| panic!("根 children 悬挂：{cid} 不在 nodes"));
        assert_eq!(
            child.parent, None,
            "根子 {cid} 的 parent 应为 None，实际 {:?}",
            child.parent
        );
    }
    // 各节点 children
    for (pid, node) in &tree.nodes {
        for cid in &node.children {
            let child = tree
                .nodes
                .get(cid)
                .unwrap_or_else(|| panic!("悬挂子引用：父 {pid} → 子 {cid} 不在 nodes"));
            assert_eq!(
                child.parent,
                Some(*pid),
                "父子反向不一致：父 {pid} 列子 {cid}，但子.parent={:?}",
                child.parent
            );
        }
    }
    // 每个有 parent 的节点必须出现在父的 children 或（若 parent 缺失则已由上覆盖）
    for (id, node) in &tree.nodes {
        if let Some(pid) = node.parent {
            let parent = tree
                .nodes
                .get(&pid)
                .unwrap_or_else(|| panic!("parent 悬挂：{id} → parent {pid} 不在 nodes"));
            assert!(
                parent.children.contains(id),
                "子 {id} 声称 parent={pid}，但父 children 未包含该子"
            );
        } else {
            assert!(
                tree.root_children.contains(id),
                "根节点 {id} parent=None 但不在 root_children"
            );
        }
    }
}

fn assert_tree_invariants(tree: &BlockTree) {
    assert_no_parent_cycles(tree);
    assert_no_dangling_child_refs(tree);
}

fn assert_session_invariants(s: &DocSession) {
    assert_tree_invariants(&s.tree());
}

// ---------------------------------------------------------------------------
// 固定种子 LCG（无外部依赖）
// ---------------------------------------------------------------------------

/// 简单 LCG：确定性伪随机（种子固定可复现）。
struct Lcg(u64);

impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed | 1) // 避免全 0 退化
    }

    fn next_u64(&mut self) -> u64 {
        // Numerical Recipes LCG
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0
    }

    fn gen_range(&mut self, lo: usize, hi: usize) -> usize {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() as usize % (hi - lo))
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() {
            None
        } else {
            Some(&items[self.gen_range(0, items.len())])
        }
    }
}

// ---------------------------------------------------------------------------
// 确定性用例（≥3）
// ---------------------------------------------------------------------------

/// DET-1：单端 insert 子树 + delete 祖先 → 无悬挂、无环。
#[test]
fn a_col_06_det_delete_ancestor_no_dangling() {
    let mut s = DocSession::new("det-1");
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: a,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: b,
            parent: Some(a),
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    s.apply(
        Origin::User,
        &[Op::Insert {
            id: c,
            parent: Some(b),
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    assert_session_invariants(&s);

    // 删祖先 a → 子树全清
    s.apply(Origin::User, &[Op::Delete { id: a }]).unwrap();
    assert!(s.tree().nodes.is_empty());
    assert!(s.tree().root_children.is_empty());
    assert_session_invariants(&s);
}

/// DET-2：合法 move 重挂 + 拒环 move 后树不变且仍满足不变量。
#[test]
fn a_col_06_det_move_and_reject_cycle() {
    let mut s = DocSession::new("det-2");
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();
    for (id, parent, order) in [
        (a, None, "a0"),
        (b, Some(a), "a0"),
        (c, Some(a), "a1"),
    ] {
        s.apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent,
                order: order.into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }],
        )
        .unwrap();
    }
    // c 挂到 b 下
    s.apply(
        Origin::User,
        &[Op::Move {
            id: c,
            new_parent: Some(b),
            order: "a0".into(),
        }],
    )
    .unwrap();
    assert_eq!(s.tree().get(&c).unwrap().parent, Some(b));
    assert_session_invariants(&s);

    // a → c 会成环，拒
    let err = s
        .apply(
            Origin::Remote,
            &[Op::Move {
                id: a,
                new_parent: Some(c),
                order: "a0".into(),
            }],
        )
        .unwrap_err();
    assert!(matches!(err, conex_doc_collab::ApplyError::Invariant(_)));
    assert_session_invariants(&s);
}

/// DET-3：双 session 各插节点 + 一侧 delete + 互推 → 双方无环、无悬挂。
#[test]
fn a_col_06_det_dual_session_push_invariants() {
    let mut h = DualSessionHarness::new("det-3");
    let a = BlockId::new();
    let b = BlockId::new();
    let c = BlockId::new();

    h.apply_and_push(
        PeerSide::A,
        Origin::User,
        &[Op::Insert {
            id: a,
            parent: None,
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    h.apply_and_push(
        PeerSide::A,
        Origin::User,
        &[Op::Insert {
            id: b,
            parent: Some(a),
            order: "a0".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    // B 侧再插兄弟 c
    h.apply_and_push(
        PeerSide::B,
        Origin::User,
        &[Op::Insert {
            id: c,
            parent: Some(a),
            order: "a1".into(),
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
        }],
    )
    .unwrap();
    // A 删 b 并推
    h.apply_and_push(PeerSide::A, Origin::User, &[Op::Delete { id: b }])
        .unwrap();

    assert_session_invariants(&h.peer_a);
    assert_session_invariants(&h.peer_b);
    assert!(!h.peer_a.tree().nodes.contains_key(&b));
    assert!(!h.peer_b.tree().nodes.contains_key(&b));
    assert!(h.peer_a.tree().nodes.contains_key(&c));
    assert!(h.peer_b.tree().nodes.contains_key(&c));
}

// ---------------------------------------------------------------------------
// 小随机循环（50 种子）：生成结构 Op，双 session 交替 apply+互推，始终无环无悬挂
// ---------------------------------------------------------------------------

/// 在已知 live 集合上生成一条「大概率合法」的结构 Op；校验失败则跳过（不崩不变量）。
fn gen_struct_op(rng: &mut Lcg, live: &[BlockId]) -> Op {
    let kind = rng.gen_range(0, 3);
    match kind {
        0 => {
            // Insert：父可为 None 或 live 中任一点
            let parent = if live.is_empty() || rng.gen_range(0, 3) == 0 {
                None
            } else {
                rng.pick(live).copied()
            };
            let order = format!("o{}", rng.next_u64() % 10_000);
            Op::Insert {
                id: BlockId::new(),
                parent,
                order,
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }
        }
        1 if live.len() >= 2 => {
            // Move：挑 id 与可能不同的 new_parent
            let id = *rng.pick(live).unwrap();
            let new_parent = if rng.gen_range(0, 4) == 0 {
                None
            } else {
                let p = *rng.pick(live).unwrap();
                if p == id {
                    None
                } else {
                    Some(p)
                }
            };
            let order = format!("m{}", rng.next_u64() % 10_000);
            Op::Move {
                id,
                new_parent,
                order,
            }
        }
        _ if !live.is_empty() => {
            let id = *rng.pick(live).unwrap();
            Op::Delete { id }
        }
        _ => {
            // live 空：强制 insert 根
            Op::Insert {
                id: BlockId::new(),
                parent: None,
                order: format!("r{}", rng.next_u64() % 1000),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            }
        }
    }
}

fn live_ids(s: &DocSession) -> Vec<BlockId> {
    s.tree().nodes.keys().copied().collect()
}

/// A-COL-06：50 个固定种子，每种子最多 12 步双端交替结构 op；成功 apply 后互推并检不变量。
#[test]
fn a_col_06_random_50_seeds_no_cycle_no_dangling() {
    const SEEDS: u64 = 50;
    const STEPS: usize = 12;

    for seed in 0..SEEDS {
        let mut rng = Lcg::new(0xA_C01_06_00 + seed * 9973);
        let mut h = DualSessionHarness::new(format!("prop-{seed}"));

        for step in 0..STEPS {
            let side = if step % 2 == 0 {
                PeerSide::A
            } else {
                PeerSide::B
            };
            let live = live_ids(h.session(side));
            let op = gen_struct_op(&mut rng, &live);
            // apply 可能因环/NotFound 失败 —— 失败不改状态；成功则推对端
            match h.apply(side, Origin::User, &[op]) {
                Ok((_ev, encoded)) => {
                    // 互推：对端可能因本地状态差异失败（如删已删）；失败则跳过推
                    let _ = h.push(side.other(), &encoded);
                }
                Err(_) => {
                    // 预校验拒：状态未变
                }
            }
            assert_session_invariants(h.session(PeerSide::A));
            assert_session_invariants(h.session(PeerSide::B));
        }

        // 终态再检
        assert_session_invariants(&h.peer_a);
        assert_session_invariants(&h.peer_b);
    }
}

/// 单树乱序回放骨架：同批确定性 ops 以两种顺序 apply（能成功的路径）后均无环。
#[test]
fn a_col_06_single_tree_two_replay_orders_acyclic() {
    let p = BlockId::new();
    let a = BlockId::new();
    let b = BlockId::new();

    let insert_p = Op::Insert {
        id: p,
        parent: None,
        order: "a0".into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    };
    let insert_a = Op::Insert {
        id: a,
        parent: Some(p),
        order: "a0".into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    };
    let insert_b = Op::Insert {
        id: b,
        parent: Some(p),
        order: "a1".into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    };

    // 顺序 1：p, a, b
    let mut s1 = DocSession::new("replay-1");
    for op in [&insert_p, &insert_a, &insert_b] {
        s1.apply(Origin::User, std::slice::from_ref(op)).unwrap();
        assert_session_invariants(&s1);
    }

    // 顺序 2：p, b, a
    let mut s2 = DocSession::new("replay-2");
    for op in [&insert_p, &insert_b, &insert_a] {
        s2.apply(Origin::User, std::slice::from_ref(op)).unwrap();
        assert_session_invariants(&s2);
    }

    assert_eq!(s1.tree().nodes.len(), 3);
    assert_eq!(s2.tree().nodes.len(), 3);
    // 兄弟全序由 order 决定，两序终态 children 一致
    assert_eq!(
        s1.tree().get(&p).unwrap().children,
        s2.tree().get(&p).unwrap().children
    );
}
