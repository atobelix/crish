//! refs 测 · `query_blocks` ref_to/ref_from + A-QRY-01（**SD-53** 测拆）。
//!
//! 由 [`crate::refs::tests`] 经 `#[path]` 接入。
//! **≠ 占 SD-18**（不改 `refs.rs` 实现）；**≠ EL-03**。
//! **不丢** `a_qry_01_*` 无手工 `upsert_ref` seed 断言。

use super::*;

#[test]
fn query_blocks_ref_to_and_ref_from() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();

    // 块投影
    for (id, text) in [
        ("src-a", "source a text"),
        ("src-b", "source b text"),
        ("tgt", "target block"),
        ("leaf", "leaf only"),
    ] {
        store
            .reindex_block(
                "doc-r",
                id,
                text,
                ReindexBlockOpts {
                    kind: "paragraph".into(),
                    order_key: id.into(),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    // src-a → tgt, src-b → tgt, src-a → leaf
    store.upsert_ref("doc-r", "src-a", "tgt", "block").unwrap();
    store.upsert_ref("doc-r", "src-b", "tgt", "block").unwrap();
    store.upsert_ref("doc-r", "src-a", "leaf", "block").unwrap();

    // ref_to=tgt → 谁引用了 tgt：src-a, src-b
    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-r".into(),
            ref_to: Some("tgt".into()),
            ..Default::default()
        })
        .unwrap();
    let ids: Vec<_> = r.blocks.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids.len(), 2, "ids={ids:?}");
    assert!(ids.contains(&"src-a"));
    assert!(ids.contains(&"src-b"));
    assert!(!ids.contains(&"tgt"));
    assert!(!ids.contains(&"leaf"));

    // ref_from=src-a → src-a 引用了谁：tgt, leaf（结果块是 to 侧）
    let r2 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-r".into(),
            ref_from: Some("src-a".into()),
            ..Default::default()
        })
        .unwrap();
    let ids2: Vec<_> = r2.blocks.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids2.len(), 2, "ids2={ids2:?}");
    assert!(ids2.contains(&"tgt"));
    assert!(ids2.contains(&"leaf"));

    // ref_to ∩ kind（AND）
    let r3 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-r".into(),
            ref_to: Some("tgt".into()),
            kind_in: Some(vec!["paragraph".into()]),
            text_match: Some("source".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r3.blocks.len(), 2);

    // 无匹配的 ref_to → 空（不再忽略）
    let r4 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-r".into(),
            ref_to: Some("no-such".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(r4.blocks.is_empty());
}

/// A-QRY-01 refs 路：**无手工 upsert_ref seed**。
/// insert 带 `((target))` 的块 → commit_ops / 投影 → query_blocks(ref_to)。
#[test]
fn a_qry_01_query_blocks_ref_without_manual_seed() {
    let dir = TempDir::new();
    let store = SharedWorkspaceStore::open(dir.db()).unwrap();
    let mut session = DocSession::new("doc-aqry").with_persistence(Box::new(store.clone()));

    let id_tgt = BlockId::new();
    let id_src = BlockId::new();
    let tgt_s = id_tgt.to_string();

    // 目标块 + 源块（源正文含块引用语法）
    commit_ops(
        &mut session,
        &store,
        Origin::User,
        &[
            Op::Insert {
                id: id_tgt,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: id_tgt,
                start: 0,
                end: 0,
                insert: "target body searchable".into(),
            },
            Op::Insert {
                id: id_src,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: id_src,
                start: 0,
                end: 0,
                insert: format!("see (({tgt_s})) in notes"),
            },
        ],
    )
    .unwrap();

    // 旁证：自动物化边存在（仍无手工 seed）
    let edges = store.refs_to("doc-aqry", &tgt_s).unwrap();
    assert_eq!(
        edges.len(),
        1,
        "commit 后须自动物化 block_ref，got {edges:?}"
    );
    assert_eq!(edges[0].from_id, id_src.to_string());
    assert_eq!(edges[0].kind, KIND_BLOCK_REF);

    // A-QRY：ref_to 查回引用方
    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-aqry".into(),
            ref_to: Some(tgt_s.clone()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r.blocks.len(), 1, "blocks={:?}", r.blocks);
    assert_eq!(r.blocks[0].id, id_src.to_string());
    assert_eq!(r.blocks[0].kind, "paragraph");

    // ref_from：源引用了谁 → 目标块在结果中（目标须已投影）
    let r2 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-aqry".into(),
            ref_from: Some(id_src.to_string()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r2.blocks.len(), 1);
    assert_eq!(r2.blocks[0].id, tgt_s);

    // 组合：ref_to ∩ text_match
    let r3 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-aqry".into(),
            ref_to: Some(tgt_s),
            text_match: Some("see".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r3.blocks.len(), 1);
    assert_eq!(r3.blocks[0].id, id_src.to_string());
}
