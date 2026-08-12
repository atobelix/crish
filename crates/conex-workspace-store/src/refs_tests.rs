//! `refs` 单元测（**SD-18** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::refs`] 经 `#[path]` 接入。**≠ EL-03**；**≠ Wave 2 存储完成**；
//! 不静默改抽边 / 物化语义。

use super::*;
use crate::projection::commit_ops;
use crate::query_blocks::QueryBlocksParams;
use crate::{ReindexBlockOpts, SCHEMA_VERSION, SharedWorkspaceStore, WorkspaceStore};
use conex_doc_collab::{BlockId, BlockKind, BlockProps, DocSession, Op, Origin, ProjectionDiff};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-refs-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn db(&self) -> PathBuf {
        self.0.join("workspace.db")
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn extract_block_ref_and_wikilink() {
    let tgt = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    let plain = format!("see (({tgt})) and [[My Page|alias]] plus [[Other]]");
    let edges = extract_refs_from_plain(&plain);
    assert_eq!(edges.len(), 3);
    assert_eq!(edges[0].kind, KIND_BLOCK_REF);
    assert_eq!(edges[0].to_id, tgt);
    assert_eq!(edges[1].kind, KIND_WIKILINK);
    assert_eq!(edges[1].to_id, "My Page");
    assert_eq!(edges[2].to_id, "Other");
    // 去重
    let again = extract_refs_from_plain(&format!("(({tgt})) (({tgt}))"));
    assert_eq!(again.len(), 1);
    // 空 / 跨行跳过
    assert!(extract_refs_from_plain("((  )) [[  ]]").is_empty());
    assert!(extract_refs_from_plain("((a\nb))").is_empty());
}

#[test]
fn schema_v5_has_block_refs() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    assert!(SCHEMA_VERSION >= 5);

    let conn = rusqlite::Connection::open(dir.db()).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='block_refs'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);

    // 索引存在
    let idx: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_block_refs_to','idx_block_refs_from')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(idx, 2);
}

#[test]
fn upsert_refs_to_refs_from_and_remove() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();

    store
        .upsert_ref("doc-a", "b1", "target", "block")
        .unwrap();
    store
        .upsert_ref("doc-a", "b2", "target", "block")
        .unwrap();
    store
        .upsert_ref("doc-a", "b1", "other", "page")
        .unwrap();
    // 幂等：同边再写不炸
    store
        .upsert_ref("doc-a", "b1", "target", "block")
        .unwrap();
    // 另一 doc 不得串
    store
        .upsert_ref("doc-b", "b1", "target", "block")
        .unwrap();

    let to = store.refs_to("doc-a", "target").unwrap();
    assert_eq!(to.len(), 2);
    assert_eq!(to[0].from_id, "b1");
    assert_eq!(to[1].from_id, "b2");
    assert!(to.iter().all(|r| r.to_id == "target" && r.kind == "block"));

    let from = store.refs_from("doc-a", "b1").unwrap();
    assert_eq!(from.len(), 2);
    let tos: Vec<_> = from.iter().map(|r| r.to_id.as_str()).collect();
    assert!(tos.contains(&"target"));
    assert!(tos.contains(&"other"));

    // remove_refs_from：仅清 b1 出链
    store.remove_refs_from("doc-a", "b1").unwrap();
    assert!(store.refs_from("doc-a", "b1").unwrap().is_empty());
    // b2 → target 仍在
    let to2 = store.refs_to("doc-a", "target").unwrap();
    assert_eq!(to2.len(), 1);
    assert_eq!(to2[0].from_id, "b2");
    // doc-b 不受影响
    assert_eq!(store.refs_to("doc-b", "target").unwrap().len(), 1);
}

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
    assert!(store.refs_from("doc-u", &src.to_string()).unwrap().is_empty());
    assert!(store.refs_to("doc-u", &t2s).unwrap().is_empty());
}

/// A-QRY-01 refs 路：**无手工 upsert_ref seed**。
/// insert 带 `((target))` 的块 → commit_ops / 投影 → query_blocks(ref_to)。
#[test]
fn a_qry_01_query_blocks_ref_without_manual_seed() {
    let dir = TempDir::new();
    let store = SharedWorkspaceStore::open(dir.db()).unwrap();
    let mut session =
        DocSession::new("doc-aqry").with_persistence(Box::new(store.clone()));

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
