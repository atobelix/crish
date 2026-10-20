//! hydrate / 杀进程同构测（**SD-52** 测拆）。
//!
//! 由 [`super`]（`projection_tests`）经 `#[path]` 接入。
//! **≠ 打开完成**；**≠ EL-04**；**≠** 重做 projection 实现。
//! 本测绿 = 落盘恢复联测绿；**禁止**宣称 EL 关闭 / A-INV-04 产品验收全关。

use super::*;

/// G-HYD-2 联测：apply → on_committed → load_doc → hydrate → 树同构（含 compact）。
#[test]
fn g_hyd_02_workspace_store_apply_persist_hydrate_isomorphic() {
    use conex_doc_collab::{structure_codec, BlockProps, Origin as O, PersistencePlugin};
    let (dir, db) = temp_db();
    let store = SharedWorkspaceStore::open(&db).unwrap();
    let mut session = DocSession::new("doc-hyd").with_persistence(Box::new(store.clone()));

    let id_a = BlockId::new();
    let id_b = BlockId::new();
    commit_ops(
        &mut session,
        &store,
        O::User,
        &[
            Op::Insert {
                id: id_a,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::Insert {
                id: id_b,
                parent: Some(id_a),
                order: "a0".into(),
                kind: BlockKind::BulletItem,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: id_a,
                start: 0,
                end: 0,
                insert: "store-hydrate-alpha".into(),
            },
        ],
    )
    .unwrap();

    let expected = session.tree().clone();
    let expected_rev = session.rev();

    // compact：强制 snapshot 路径（flush_doc）
    store.flush_doc("doc-hyd").unwrap();
    let blob = PersistencePlugin::load_doc(&store, "doc-hyd").unwrap();
    assert!(blob.snapshot.is_some());
    assert!(blob.pending.is_empty(), "compact 后 pending 应空");

    let restored = DocSession::hydrate("doc-hyd", blob).expect("hydrate after compact");
    assert!(
        structure_codec::structure_eq(restored.tree(), &expected),
        "杀进程模拟：compact snapshot 须可 hydrate 出同构树"
    );
    assert_eq!(restored.rev(), expected_rev);
    assert_eq!(restored.read_text(&id_a), "store-hydrate-alpha");
    assert_eq!(restored.tree().get(&id_b).unwrap().parent, Some(id_a));

    cleanup_dir(&dir);
}

/// A-INV-04 方向 / 落盘完成链（02 §0）：
/// `apply → on_committed → [杀进程] → load_doc → hydrate → 树+文本 ≡ 杀前`。
///
/// 模拟杀进程 = **drop session + drop store（关 SQLite）**，再 `SharedWorkspaceStore::open`
/// 重开同一 `workspace.db` → `load_doc` → **新** `DocSession::hydrate`。
///
/// 覆盖两条恢复路径：
/// 1. **pending-only**（未 compact）：从 `doc_updates` 重放末帧 CDCS 结构
/// 2. **compact/snapshot_tick**（`flush_doc`）：length-prefix snapshot 仍可 hydrate
///
/// **本测绿 =「落盘恢复联测绿」**；**禁止**宣称 EL 关闭 / A-INV-04 产品验收全关。
#[test]
fn a_inv_04_kill_process_reload_hydrate_isomorphic() {
    use conex_doc_collab::{structure_codec, PersistencePlugin};

    let (dir, db) = temp_db();
    let doc_id = "doc-a-inv-04";
    let id_p = BlockId::new();
    let id_c = BlockId::new();
    let text_p = "kill-reload-paragraph-alpha";
    let text_c = "kill-reload-child-beta";

    // ── Phase 1：写权威（pending 路径）+ 派生索引 ──────────────────
    let (expected_tree, expected_rev) = {
        let store = SharedWorkspaceStore::open(&db).unwrap();
        let mut session = DocSession::new(doc_id).with_persistence(Box::new(store.clone()));

        // 批 1：根段落 + 文本
        commit_ops(
            &mut session,
            &store,
            Origin::User,
            &[
                Op::Insert {
                    id: id_p,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: id_p,
                    start: 0,
                    end: 0,
                    insert: text_p.into(),
                },
            ],
        )
        .unwrap();

        // 批 2：子 bullet + 文本（多 rev / 多 pending）
        commit_ops(
            &mut session,
            &store,
            Origin::User,
            &[
                Op::Insert {
                    id: id_c,
                    parent: Some(id_p),
                    order: "a0".into(),
                    kind: BlockKind::BulletItem,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: id_c,
                    start: 0,
                    end: 0,
                    insert: text_c.into(),
                },
            ],
        )
        .unwrap();

        let tree = session.tree().clone();
        let rev = session.rev();
        assert!(rev >= 2, "两批 apply 后 session.rev 须 ≥ 2，got {rev}");
        assert_eq!(session.read_text(&id_p), text_p);
        assert_eq!(session.read_text(&id_c), text_c);
        // 投影索引旁证（非 hydrate 主路径）
        let hits = store
            .search_fulltext(doc_id, "kill-reload-paragraph", 10)
            .unwrap();
        assert_eq!(hits.len(), 1, "commit_ops 后 FTS 应命中父块文本");
        assert!(
            store.load_pending_count(doc_id).unwrap() >= 1,
            "未 compact 时须有 pending updates"
        );
        assert!(store.load_rev(doc_id).unwrap() >= 2);

        // 显式 drop = 杀进程：会话内存与 SQLite 连接全部释放
        drop(session);
        drop(store);
        (tree, rev)
    };

    // ── Phase 2：进程重启 — 重开 db → load_doc → 新 hydrate ────────
    {
        let store = SharedWorkspaceStore::open(&db).expect("杀进程后须能重开 workspace.db");
        let blob =
            PersistencePlugin::load_doc(&store, doc_id).expect("load_doc 须返回 snapshot⊕pending");
        assert!(
            blob.snapshot.is_some() || !blob.pending.is_empty(),
            "杀进程后权威 blob 不得空（表有行且须有可解码结构载荷）"
        );

        // 新会话：禁止 DocSession::new 空树冒充打开
        let restored = DocSession::hydrate(doc_id, blob).expect("pending 路径 hydrate 须成功");
        assert!(
            structure_codec::structure_eq(restored.tree(), &expected_tree),
            "A-INV-04：杀进程恢复树须同构（id/parent/order/kind/props/children/text_snapshot）"
        );
        assert_eq!(
            restored.rev(),
            expected_rev,
            "hydrate 后 rev 须与杀前 session.rev 一致"
        );
        assert_eq!(restored.read_text(&id_p), text_p);
        assert_eq!(restored.read_text(&id_c), text_c);
        assert_eq!(
            restored.tree().get(&id_p).unwrap().text_snapshot.as_deref(),
            Some(text_p),
            "父块 text_snapshot 须与杀前一致"
        );
        assert_eq!(
            restored.tree().get(&id_c).unwrap().text_snapshot.as_deref(),
            Some(text_c),
            "子块 text_snapshot 须与杀前一致"
        );
        assert_eq!(
            restored.tree().get(&id_c).unwrap().parent,
            Some(id_p),
            "父子关系须恢复"
        );
        // 冷登记可读（G-HYD-3 方向）
        assert!(restored.text_is_registered(&id_p));
        assert!(restored.text_is_registered(&id_c));
        drop(restored);
        drop(store);
    }

    // ── Phase 3：compact 后再杀进程，snapshot 路径仍可 hydrate ─────
    {
        let store = SharedWorkspaceStore::open(&db).unwrap();
        let blob = PersistencePlugin::load_doc(&store, doc_id).unwrap();
        let mut session = DocSession::hydrate(doc_id, blob)
            .unwrap()
            .with_persistence(Box::new(store.clone()));

        let id_extra = BlockId::new();
        commit_ops(
            &mut session,
            &store,
            Origin::User,
            &[
                Op::Insert {
                    id: id_extra,
                    parent: None,
                    order: "a1".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: id_extra,
                    start: 0,
                    end: 0,
                    insert: "after-compact-path".into(),
                },
            ],
        )
        .unwrap();

        let tree_after = session.tree().clone();
        let rev_after = session.rev();
        assert!(rev_after > expected_rev);

        // snapshot_tick 路径：flush 合并 pending → length-prefix snapshot
        store.flush_doc(doc_id).expect("flush_doc compact");
        assert_eq!(
            store.load_pending_count(doc_id).unwrap(),
            0,
            "compact 后 pending 须清空"
        );
        let pre_kill = PersistencePlugin::load_doc(&store, doc_id).unwrap();
        assert!(pre_kill.snapshot.is_some());
        assert!(pre_kill.pending.is_empty());

        drop(session);
        drop(store);

        // 再杀一次：仅 snapshot 字节
        let store2 = SharedWorkspaceStore::open(&db).unwrap();
        let blob2 = PersistencePlugin::load_doc(&store2, doc_id).unwrap();
        assert!(blob2.snapshot.is_some(), "compact 后须有 snapshot");
        assert!(blob2.pending.is_empty(), "compact 后 pending 应空");

        let restored2 =
            DocSession::hydrate(doc_id, blob2).expect("compact snapshot 杀进程后仍须可 hydrate");
        assert!(
            structure_codec::structure_eq(restored2.tree(), &tree_after),
            "compact 后杀进程：树须同构"
        );
        assert_eq!(restored2.rev(), rev_after);
        assert_eq!(restored2.read_text(&id_extra), "after-compact-path");
        assert_eq!(restored2.read_text(&id_p), text_p);
        assert_eq!(restored2.read_text(&id_c), text_c);
        assert_eq!(
            restored2
                .tree()
                .get(&id_extra)
                .unwrap()
                .text_snapshot
                .as_deref(),
            Some("after-compact-path")
        );
    }

    cleanup_dir(&dir);
}
