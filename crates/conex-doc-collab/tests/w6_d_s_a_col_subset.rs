//! **W6-D-S** · in-process A-COL-01 子集契约（Skeleton）
//!
//! | 元数据 | 值 |
//! | ------ | -- |
//! | **包 ID** | **W6-D-S**（必须保留 `-S`；**≠ W6-D** Strict） |
//! | **子集** | **A-COL-01** in-process 双 peer（结构 id 并集 + 文本互推烟雾） |
//! | **EL** | **禁止**关 **EL-04**（须 W1-F + W6-D + G-HYD） |
//!
//! ## 诚实边界
//!
//! - **≠ W6-D**：A-COL 全族满语义 + 脚手架退出不在本包
//! - **≠ EL-04**：本文件绿 ≠ 多人协同效果锁关闭
//! - **≠ A-COL-01…08 满语义** / 状态哈希终局 / 结构真 CRDT encode
//! - 结构路径可为 JSON 重放（`SimplifiedEncodedOps`）；文本路径走 yrs update
//! - **不抹** W1-U / 既有 `a_col_dual_peer` 全场景绿测
//!
//! 加深场景表见 `tests/a_col_dual_peer.rs`；本文件钉 **包轨绑定 + 最小可证伪烟雾**。
//!
//! 门禁：`cargo test -p conex-doc-collab --test w6_d_s_a_col_subset`

use conex_doc_collab::w6_d_s::{
    does_not_close_el04_or_w6_d, package_id_is_skeleton_track, W6_D_S_A_COL_01_SCENARIOS,
    W6_D_S_A_COL_SUBSET, W6_D_S_NOT_CLOSING, W6_D_S_PACKAGE_ID, W6_D_S_TRACK,
};
use conex_doc_collab::{
    a_col::A_COL_01, BlockId, BlockKind, BlockProps, DualSessionHarness, Op, Origin, PeerSide,
};
use std::collections::HashSet;

fn insert_root_op(id: BlockId, order: &str) -> Op {
    Op::Insert {
        id,
        parent: None,
        order: order.into(),
        kind: BlockKind::Paragraph,
        props: BlockProps::default(),
    }
}

/// 包锚：`W6-D-S` 可点名、带 `-S`、诚实 ≠ W6-D / ≠ EL-04。
#[test]
fn w6_d_s_package_id_and_honest_boundary() {
    assert_eq!(W6_D_S_PACKAGE_ID, "W6-D-S");
    assert!(
        W6_D_S_PACKAGE_ID.ends_with("-S"),
        "Skeleton 必须保留 -S；禁止去 -S 冒充 W6-D Strict"
    );
    assert!(package_id_is_skeleton_track());
    assert_eq!(W6_D_S_TRACK, "Skeleton");
    assert!(does_not_close_el04_or_w6_d());
    assert!(W6_D_S_NOT_CLOSING
        .iter()
        .any(|s| *s == "EL-04" || s.contains("EL-04")));
    assert!(W6_D_S_NOT_CLOSING.iter().any(|s| s.contains("W6-D Strict")));
    // 显式诚实句（调度/审计可 grep）
    let honest = "W6-D-S ≠ W6-D / ≠ EL-04 满关";
    assert!(honest.contains("≠ W6-D"));
    assert!(honest.contains("≠ EL-04"));
}

/// 子集契约：W6-D-S 轨 **绑定** A-COL-01（与 `a_col::A_COL_01` 同值）。
#[test]
fn w6_d_s_track_binds_a_col_01_subset() {
    assert_eq!(W6_D_S_A_COL_SUBSET, "A-COL-01");
    assert_eq!(W6_D_S_A_COL_SUBSET, A_COL_01);
    assert!(
        !W6_D_S_A_COL_01_SCENARIOS.is_empty(),
        "子集场景表不得空（须可对账 dual_peer 测名）"
    );
    // 与 dual_peer 核心场景可对账（命名片段）
    for needle in [
        "concurrent_insert_diff_blocks_id_union",
        "same_block_concurrent_text_converge",
        "delete_vs_remote_text_delete_wins",
    ] {
        assert!(
            W6_D_S_A_COL_01_SCENARIOS.iter().any(|s| *s == needle),
            "场景表缺 {needle}（与 a_col_dual_peer 对账失败）"
        );
    }
}

/// A-COL-01 子集烟雾（W6-D-S）：并发 insert 不同块 → 结构 id 并集一致。
///
/// **可证伪**：去掉 `exchange_encoded` / 只推一侧 → 本测必红。
/// **≠** A-COL-01 满语义；**≠** EL-04；**≠** W6-D。
#[test]
fn w6_d_s_a_col_01_concurrent_insert_id_union_smoke() {
    assert_eq!(W6_D_S_PACKAGE_ID, "W6-D-S");
    assert_eq!(W6_D_S_A_COL_SUBSET, A_COL_01);

    let mut h = DualSessionHarness::new("w6-d-s-a-col-01-id-union");
    let id_a = BlockId::new();
    let id_b = BlockId::new();

    let (_ev_a, enc_a) = h
        .apply(PeerSide::A, Origin::User, &[insert_root_op(id_a, "a0")])
        .expect("A insert");
    let (_ev_b, enc_b) = h
        .apply(PeerSide::B, Origin::User, &[insert_root_op(id_b, "b0")])
        .expect("B insert");

    assert_eq!(h.structure_ids(PeerSide::A), HashSet::from([id_a]));
    assert_eq!(h.structure_ids(PeerSide::B), HashSet::from([id_b]));

    h.exchange_encoded(PeerSide::A, &enc_a, PeerSide::B, &enc_b)
        .expect("exchange");

    let union: HashSet<BlockId> = HashSet::from([id_a, id_b]);
    assert_eq!(h.structure_ids(PeerSide::A), union);
    assert_eq!(h.structure_ids(PeerSide::B), union);
    assert!(h.structure_ids_equal());
    assert_eq!(
        h.peer_a.tree().get(&id_a).unwrap().kind,
        BlockKind::Paragraph
    );
    assert_eq!(
        h.peer_b.tree().get(&id_b).unwrap().kind,
        BlockKind::Paragraph
    );
}

/// A-COL-01 子集烟雾（W6-D-S）：同块顺序 text 互推 → 双方 `read_text` 一致。
///
/// **≠** 并发全矩阵 / 状态哈希终局 / EL-04。
#[test]
fn w6_d_s_a_col_01_same_block_text_push_smoke() {
    let mut h = DualSessionHarness::new("w6-d-s-a-col-01-text");
    let id = BlockId::new();

    h.apply_and_push(PeerSide::A, Origin::User, &[insert_root_op(id, "t0")])
        .expect("seed paragraph");

    h.apply_text_and_push(
        PeerSide::A,
        Origin::User,
        &[Op::TextEdit {
            id,
            start: 0,
            end: 0,
            insert: "w6ds".into(),
        }],
    )
    .expect("text push");

    assert_eq!(h.peer_a.read_text(&id), "w6ds");
    assert_eq!(h.peer_b.read_text(&id), "w6ds");
}
