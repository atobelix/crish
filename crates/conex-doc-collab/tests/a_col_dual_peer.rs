//! **W6-D-S** · A-COL-01 双 peer 加深（in-process [`DualSessionHarness`]，无真实网络）。
//!
//! # 轨与诚实边界
//! - 包 ID：**W6-D-S**（Skeleton；常量 [`conex_doc_collab::W6_D_S_PACKAGE_ID`]）
//! - **≠ W6-D** Strict（A-COL 全族满语义 + 脚手架退出）
//! - **≠ EL-04**（须 W1-F + W6-D + G-HYD；禁止本文件绿关效果锁）
//! - 结构侧可为 JSON 重放；文本侧 yrs update；**≠** 状态哈希终局叙事
//!
//! # 覆盖的 A-COL ID
//! | ID | 场景 | 本文件用例 |
//! |----|------|-----------|
//! | **A-COL-01** | 双 peer 并发 insert 不同块 → 结构 id 并集一致 | `a_col_01_concurrent_insert_diff_blocks_id_union` |
//! | **A-COL-01** | 双 peer 同块 text 后互推 → 文本一致 | `a_col_01_same_block_concurrent_text_converge` / `a_col_01_same_block_sequential_text_converge` |
//! | **A-COL-01** + **M1 删胜** | delete ∥ 远端 update（TextEdit / UpdateProps）→ 删胜、不复活 | `a_col_01_delete_vs_remote_text_delete_wins` / `a_col_01_delete_vs_remote_props_delete_wins` / `a_col_01_delete_then_lagged_text_not_found` |
//!
//! 规格锚点：
//! - `docs/block-workspace-architecture/18-实现波前待决锁定-H1H2H3M1.md` §M1（删胜）
//! - `docs/block-workspace-architecture/plans/specs/concurrent-move-rules.md` MV-03
//! - W1-F harness：`DualSessionHarness`（结构 JSON 重放 + yrs 文本 update）
//! - 包轨契约：`tests/w6_d_s_a_col_subset.rs` + `src/w6_d_s.rs`

use conex_doc_collab::{
    ApplyError, BlockId, BlockKind, BlockProps, DualSessionHarness, Op, Origin, PeerSide,
    W6_D_S_PACKAGE_ID,
};
use std::collections::HashSet;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn insert_root_op(id: BlockId, order: &str) -> Op {
    Op::Insert {
        id,
        parent: None,
        order: order.into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    }
}

/// 双方结构已共享同一根段落。
fn seed_shared_paragraph(h: &mut DualSessionHarness, id: BlockId, order: &str) {
    h.apply_and_push(PeerSide::A, Origin::User, &[insert_root_op(id, order)])
        .expect("seed shared paragraph");
    assert!(h.peer_a.tree().get(&id).is_some());
    assert!(h.peer_b.tree().get(&id).is_some());
}

// ---------------------------------------------------------------------------
// 包轨钉（W6-D-S · 与子集文件互证；不关 EL-04）
// ---------------------------------------------------------------------------

/// 本 dual_peer 文件挂在 **W6-D-S** Skeleton 轨；**≠ W6-D** / **≠ EL-04**。
#[test]
fn a_col_dual_peer_package_track_is_w6_d_s_skeleton() {
    assert_eq!(W6_D_S_PACKAGE_ID, "W6-D-S");
    assert!(
        W6_D_S_PACKAGE_ID.ends_with("-S"),
        "必须保留 -S；禁止叙事为 W6-D Strict"
    );
    let _ = "W6-D-S ≠ W6-D / ≠ EL-04 满关";
}

// ---------------------------------------------------------------------------
// A-COL-01 · 并发 insert 不同块 → 结构 id 并集一致
// ---------------------------------------------------------------------------

/// 双 peer **离线并发**各 insert 不同块，再 `exchange_encoded` 互推：
/// 双方 structure id 集合相等，且等于本地并集。
#[test]
fn a_col_01_concurrent_insert_diff_blocks_id_union() {
    let mut h = DualSessionHarness::new("a-col-01-id-union");
    let id_a = BlockId::new();
    let id_b = BlockId::new();

    // 并发：先各自本地 apply，**暂不**推对端
    let (_ev_a, enc_a) = h
        .apply(PeerSide::A, Origin::User, &[insert_root_op(id_a, "a0")])
        .unwrap();
    let (_ev_b, enc_b) = h
        .apply(PeerSide::B, Origin::User, &[insert_root_op(id_b, "b0")])
        .unwrap();

    // 离线后双方仅有本地块
    assert_eq!(h.structure_ids(PeerSide::A), HashSet::from([id_a]));
    assert_eq!(h.structure_ids(PeerSide::B), HashSet::from([id_b]));

    // 互推（无网络；A 编码先到 B，B 编码再到 A）
    h.exchange_encoded(PeerSide::A, &enc_a, PeerSide::B, &enc_b)
        .unwrap();

    let ids_a = h.structure_ids(PeerSide::A);
    let ids_b = h.structure_ids(PeerSide::B);
    let union: HashSet<BlockId> = HashSet::from([id_a, id_b]);

    assert_eq!(ids_a, union, "A 应含双方 insert 的 id 并集");
    assert_eq!(ids_b, union, "B 应含双方 insert 的 id 并集");
    assert!(h.structure_ids_equal());
    // 节点 kind 一致
    assert_eq!(
        h.peer_a.tree().get(&id_a).unwrap().kind,
        BlockKind::Paragraph
    );
    assert_eq!(
        h.peer_b.tree().get(&id_a).unwrap().kind,
        BlockKind::Paragraph
    );
    assert_eq!(
        h.peer_a.tree().get(&id_b).unwrap().kind,
        BlockKind::Paragraph
    );
    assert_eq!(
        h.peer_b.tree().get(&id_b).unwrap().kind,
        BlockKind::Paragraph
    );
}

// ---------------------------------------------------------------------------
// A-COL-01 · 同块 text 互推 → 文本一致
// ---------------------------------------------------------------------------

/// 扩展场景：两侧**并发**改同一块文本，仅用 yrs update 互推 → `read_text` 双方相等。
#[test]
fn a_col_01_same_block_concurrent_text_converge() {
    let mut h = DualSessionHarness::new("a-col-01-same-text-concurrent");
    let id = BlockId::new();
    seed_shared_paragraph(&mut h, id, "t0");

    // 并发本地 TextEdit（不推）
    h.session_mut(PeerSide::A)
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "alpha".into(),
            }],
        )
        .unwrap();
    let updates_a = h.peer_a.last_commit_text_updates().to_vec();

    h.session_mut(PeerSide::B)
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "beta".into(),
            }],
        )
        .unwrap();
    let updates_b = h.peer_b.last_commit_text_updates().to_vec();

    assert_eq!(h.peer_a.read_text(&id), "alpha");
    assert_eq!(h.peer_b.read_text(&id), "beta");

    // 互推 yrs state（真实 CRDT 合入）
    h.push_text_updates(PeerSide::B, &updates_a).unwrap();
    h.push_text_updates(PeerSide::A, &updates_b).unwrap();

    let ta = h.peer_a.read_text(&id);
    let tb = h.peer_b.read_text(&id);
    assert_eq!(ta, tb, "并发同块 text 互推后双方文本必须一致");
    // 双方插入均应保留（yrs 并发 insert 合并；顺序由 client 序决定）
    assert!(
        ta.contains("alpha") && ta.contains("beta"),
        "合并结果应含两侧插入，实际={ta:?}"
    );
}

/// 扩展场景：同块顺序写字 + 互推（A 写推 B，B 追加推 A）→ 收敛。
#[test]
fn a_col_01_same_block_sequential_text_converge() {
    let mut h = DualSessionHarness::new("a-col-01-same-text-seq");
    let id = BlockId::new();
    seed_shared_paragraph(&mut h, id, "s0");

    h.apply_text_and_push(
        PeerSide::A,
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "hello".into(),
        }],
    )
    .unwrap();
    assert_eq!(h.peer_a.read_text(&id), "hello");
    assert_eq!(h.peer_b.read_text(&id), "hello");

    // B 在已收敛文本末尾追加
    let end = h.peer_b.read_text(&id).chars().count() as u32;
    h.apply_text_and_push(
        PeerSide::B,
        Origin::User,
        &[Op::TextEdit {
            id,
            start: end,
            end,
            insert: " world".into(),
        }],
    )
    .unwrap();

    assert_eq!(h.peer_a.read_text(&id), "hello world");
    assert_eq!(h.peer_b.read_text(&id), "hello world");
}

// ---------------------------------------------------------------------------
// A-COL-01 + M1 · 删除 vs 远端 update：删胜
// ---------------------------------------------------------------------------

/// A 删块、B 并发 TextEdit；互推后双方均无该块；滞后文本 update 不复活（删胜）。
#[test]
fn a_col_01_delete_vs_remote_text_delete_wins() {
    let mut h = DualSessionHarness::new("a-col-01-del-vs-text");
    let id = BlockId::new();
    seed_shared_paragraph(&mut h, id, "d0");

    // 并发：A Delete，B TextEdit（均未推）
    let (_ev_del, enc_del) = h
        .apply(PeerSide::A, Origin::User, &[Op::Delete { id }])
        .unwrap();
    let (_ev_txt, enc_txt) = h
        .apply(
            PeerSide::B,
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "should-not-survive".into(),
            }],
        )
        .unwrap();
    let text_updates_b = h.peer_b.last_commit_text_updates().to_vec();
    assert!(!text_updates_b.is_empty());

    // 先推 Delete → B（B 丢弃本地文本，块移除）
    h.push(PeerSide::B, &enc_del).unwrap();
    assert!(
        !h.peer_b.tree().nodes.contains_key(&id),
        "B 收到 Delete 后块应消失（删胜）"
    );
    assert!(!h.peer_b.text_is_registered(&id));

    // 滞后 TextEdit op 推到 A：A 已删 → NotFound → 删胜 no-op
    let applied = h.push_delete_wins(PeerSide::A, &enc_txt).unwrap();
    assert!(
        applied.is_none(),
        "已删块上的远端 TextEdit 应为删胜 no-op（NotFound）"
    );

    // 滞后 yrs 文本 update 推到 A：不得复活
    let n = h
        .push_text_updates_delete_wins(PeerSide::A, &text_updates_b)
        .unwrap();
    assert_eq!(n, 0, "删胜：已删块的 yrs update 应全部 skip");

    // 最终：双方均无该块
    assert!(!h.peer_a.tree().nodes.contains_key(&id));
    assert!(!h.peer_b.tree().nodes.contains_key(&id));
    assert!(h.structure_ids_equal());
    assert!(!h.peer_a.text_is_registered(&id));
    assert!(!h.peer_b.text_is_registered(&id));
}

/// A 删块、B 并发 UpdateProps；Delete 推到 B 后块消失；滞后 props 推 A → 删胜。
#[test]
fn a_col_01_delete_vs_remote_props_delete_wins() {
    let mut h = DualSessionHarness::new("a-col-01-del-vs-props");
    let id = BlockId::new();
    seed_shared_paragraph(&mut h, id, "p0");

    let mut props = BlockProps::default();
    props
        .attrs
        .insert("color".into(), serde_json::json!("red"));

    let (_ev_del, enc_del) = h
        .apply(PeerSide::A, Origin::User, &[Op::Delete { id }])
        .unwrap();
    let (_ev_up, enc_up) = h
        .apply(
            PeerSide::B,
            Origin::User,
            &[Op::UpdateProps {
                id,
                props: props.clone(),
            }],
        )
        .unwrap();

    // B 本地已改 props
    assert_eq!(
        h.peer_b
            .tree()
            .get(&id)
            .unwrap()
            .props
            .attrs
            .get("color")
            .and_then(|v| v.as_str()),
        Some("red")
    );

    // Delete → B：删胜
    h.push(PeerSide::B, &enc_del).unwrap();
    assert!(!h.peer_b.tree().nodes.contains_key(&id));

    // 滞后 UpdateProps → A：NotFound / 删胜
    let applied = h.push_delete_wins(PeerSide::A, &enc_up).unwrap();
    assert!(applied.is_none());
    assert!(!h.peer_a.tree().nodes.contains_key(&id));
    assert!(h.structure_ids_equal());
}

/// 严格错误面：已删块上 `apply_remote_text_update` 返回 `NotFound`（可观测删胜）。
#[test]
fn a_col_01_delete_then_lagged_text_not_found() {
    let mut h = DualSessionHarness::new("a-col-01-del-lag-nf");
    let id = BlockId::new();
    seed_shared_paragraph(&mut h, id, "n0");

    // B 先写字并拿到 payload，再 A 删并推 B
    h.session_mut(PeerSide::B)
        .apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "lag".into(),
            }],
        )
        .unwrap();
    let payload = h.peer_b.last_commit_text_updates().to_vec();
    assert_eq!(payload.len(), 1);

    h.apply_and_push(PeerSide::A, Origin::User, &[Op::Delete { id }])
        .unwrap();
    assert!(!h.peer_a.tree().nodes.contains_key(&id));
    assert!(!h.peer_b.tree().nodes.contains_key(&id));

    // 硬错误面（非 delete_wins 包装）：调用方可见 NotFound
    let err = h
        .peer_a
        .apply_remote_text_update(payload[0].block_id, &payload[0].bytes)
        .unwrap_err();
    assert!(
        matches!(err, ApplyError::NotFound(_)),
        "已删块远端文本 update 必须 NotFound，实际={err:?}"
    );
}
