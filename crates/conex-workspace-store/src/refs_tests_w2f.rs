//! refs 测 · W2-F 投影自动物化（**SD-53** 测拆）。
//!
//! 由 [`crate::refs::tests`] 经 `#[path]` 接入。
//! **≠ 占 SD-18**（不改 `refs.rs` 实现）；**≠ EL-03**。

use super::*;

/// W2-F：投影 upsert 从 plain_text **自动**物化 refs（无手工 upsert_ref）。
#[test]
fn w2f_auto_materialize_refs_on_projection_upsert() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    let src = BlockId::new();
    let tgt = BlockId::new();
    let tgt_s = tgt.to_string();
    let plain = format!("link to (({tgt_s})) and [[Wiki Home]]");

    let diff = ProjectionDiff {
        doc_id: "doc-auto".into(),
        rev: 1,
        upserts: vec![conex_doc_collab::BlockUpsert {
            id: src,
            kind: BlockKind::Paragraph,
            props: BlockProps::default(),
            children: vec![],
            order: "a0".into(),
            parent: None,
            plain_text: plain,
        }],
        removes: vec![],
        text_touches: vec![],
        full_rebuild: false,
    };
    // **禁止** 先 store.upsert_ref —— 仅靠投影
    store.apply_projection_diff("doc-auto", &diff).unwrap();

    let from = store.refs_from("doc-auto", &src.to_string()).unwrap();
    assert_eq!(from.len(), 2, "from={from:?}");
    let block_edge = from
        .iter()
        .find(|r| r.kind == KIND_BLOCK_REF)
        .expect("block_ref edge");
    assert_eq!(block_edge.to_id, tgt_s);
    let wiki = from
        .iter()
        .find(|r| r.kind == KIND_WIKILINK)
        .expect("wikilink edge");
    assert_eq!(wiki.to_id, "Wiki Home");

    let to = store.refs_to("doc-auto", &tgt_s).unwrap();
    assert_eq!(to.len(), 1);
    assert_eq!(to[0].from_id, src.to_string());
    assert_eq!(to[0].kind, KIND_BLOCK_REF);
}

/// 更新 plain_text 后出边重建一致；删除块后出边+入边清空。
#[test]
fn w2f_refs_rebuild_on_update_and_clear_on_remove() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    let src = BlockId::new();
    let t1 = BlockId::new();
    let t2 = BlockId::new();
    let t1s = t1.to_string();
    let t2s = t2.to_string();

    store
        .apply_projection_diff(
            "doc-u",
            &ProjectionDiff {
                doc_id: "doc-u".into(),
                rev: 1,
                upserts: vec![conex_doc_collab::BlockUpsert {
                    id: src,
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                    children: vec![],
                    order: "a0".into(),
                    parent: None,
                    plain_text: format!("(({t1s}))"),
                }],
                removes: vec![],
                text_touches: vec![],
                full_rebuild: false,
            },
        )
        .unwrap();
    assert_eq!(store.refs_to("doc-u", &t1s).unwrap().len(), 1);
    assert!(store.refs_to("doc-u", &t2s).unwrap().is_empty());

    // 更新：t1 → t2
    store
        .apply_projection_diff(
            "doc-u",
            &ProjectionDiff {
                doc_id: "doc-u".into(),
                rev: 2,
                upserts: vec![conex_doc_collab::BlockUpsert {
                    id: src,
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                    children: vec![],
                    order: "a0".into(),
                    parent: None,
                    plain_text: format!("now (({t2s})) only"),
                }],
                removes: vec![],
                text_touches: vec![],
                full_rebuild: false,
            },
        )
        .unwrap();
    assert!(
        store.refs_to("doc-u", &t1s).unwrap().is_empty(),
        "旧边须清除"
    );
    let to2 = store.refs_to("doc-u", &t2s).unwrap();
    assert_eq!(to2.len(), 1);
    assert_eq!(to2[0].from_id, src.to_string());

    // 删除 src：出边 + 作为 to 的入边均清
    store
        .apply_projection_diff(
            "doc-u",
            &ProjectionDiff {
                doc_id: "doc-u".into(),
                rev: 3,
                upserts: vec![],
                removes: vec![src],
                text_touches: vec![],
                full_rebuild: false,
            },
        )
        .unwrap();
    assert!(store
        .refs_from("doc-u", &src.to_string())
        .unwrap()
        .is_empty());
    assert!(store.refs_to("doc-u", &t2s).unwrap().is_empty());
}
