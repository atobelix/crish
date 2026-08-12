//! `query_blocks` 单元测（SD-12 外置；语义与拆前一致）。

use super::*;
use crate::{ReindexBlockOpts, WorkspaceStore};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-qb-{}-{}-{}",
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

fn seed_diverse(store: &WorkspaceStore) {
    // paragraph + hello
    store
        .reindex_block(
            "doc-q",
            "p1",
            "hello world alpha note",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                order_key: "a".into(),
                props_json: r#"{"status":"open","prio":1}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
    // heading + hello
    store
        .reindex_block(
            "doc-q",
            "h1",
            "hello heading beta",
            ReindexBlockOpts {
                kind: "heading".into(),
                order_key: "b".into(),
                props_json: r#"{"status":"open"}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
    // todo，无 hello
    store
        .reindex_block(
            "doc-q",
            "t1",
            "task without magic token",
            ReindexBlockOpts {
                kind: "todo".into(),
                order_key: "c".into(),
                props_json: r#"{"status":"done","prio":2}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
    // paragraph + hello 但 status=done
    store
        .reindex_block(
            "doc-q",
            "p2",
            "hello closed paragraph",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                order_key: "d".into(),
                props_json: r#"{"status":"done"}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
    // 另一 doc：不得串
    store
        .reindex_block(
            "doc-other",
            "ox",
            "hello only other",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                props_json: r#"{"status":"open"}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn kind_and_text_intersection() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_diverse(&store);

    // kind=paragraph ∩ text=hello → p1, p2（h1 是 heading）
    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-q".into(),
            kind_in: Some(vec!["paragraph".into()]),
            text_match: Some("hello".into()),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();

    let ids: Vec<_> = r.blocks.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"p1"), "p1 应命中: {ids:?}");
    assert!(ids.contains(&"p2"), "p2 应命中: {ids:?}");
    assert!(!ids.contains(&"h1"), "heading 不应命中: {ids:?}");
    assert!(!ids.contains(&"t1"), "无 hello 的 todo 不应命中");
    assert!(!ids.contains(&"ox"), "不得串 doc");
    assert!(!r.truncated);
    // 出参字段形状：id/kind/snippet/attrs
    for b in &r.blocks {
        assert!(!b.id.is_empty());
        assert_eq!(b.kind, "paragraph");
        assert!(!b.snippet.is_empty());
    }
    assert_eq!(r.blocks.len(), 2);
}

#[test]
fn kind_text_attrs_triple_and() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_diverse(&store);

    let mut attrs = BTreeMap::new();
    attrs.insert("status".into(), JsonValue::String("open".into()));

    // paragraph ∩ hello ∩ status=open → 仅 p1
    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-q".into(),
            kind_in: Some(vec!["paragraph".into()]),
            text_match: Some("hello".into()),
            attrs_eq: Some(attrs),
            ..Default::default()
        })
        .unwrap();

    assert_eq!(r.blocks.len(), 1);
    assert_eq!(r.blocks[0].id, "p1");
    assert_eq!(r.blocks[0].kind, "paragraph");
    assert_eq!(
        r.blocks[0].attrs.get("status"),
        Some(&JsonValue::String("open".into()))
    );
    // 数值属性回传
    assert_eq!(r.blocks[0].attrs.get("prio"), Some(&JsonValue::from(1)));
}

#[test]
fn attrs_only_and_numeric() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_diverse(&store);

    let mut attrs = BTreeMap::new();
    attrs.insert("prio".into(), JsonValue::from(1));

    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-q".into(),
            attrs_eq: Some(attrs),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r.blocks.len(), 1);
    assert_eq!(r.blocks[0].id, "p1");
}

#[test]
fn limit_truncated() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    // 写入 5 条可 FTS 命中
    for i in 0..5 {
        store
            .reindex_block(
                "doc-t",
                &format!("b{i}"),
                &format!("shared_token item {i}"),
                ReindexBlockOpts {
                    kind: "paragraph".into(),
                    order_key: format!("{i:02}"),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-t".into(),
            text_match: Some("shared_token".into()),
            limit: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r.blocks.len(), 2);
    assert!(r.truncated, "还有更多命中时应 truncated=true");

    // limit 盖住全部 → 不截断
    let r2 = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-t".into(),
            text_match: Some("shared_token".into()),
            limit: Some(50),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r2.blocks.len(), 5);
    assert!(!r2.truncated);
}

#[test]
fn limit_hard_cap_200() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    // 仅测 normalize：超大 limit 不 panic，且结果 ≤200
    for i in 0..3 {
        store
            .reindex_block(
                "doc-c",
                &format!("c{i}"),
                "cap_token",
                ReindexBlockOpts::default(),
            )
            .unwrap();
    }
    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-c".into(),
            text_match: Some("cap_token".into()),
            limit: Some(10_000), // 应 clamp 到 200
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r.blocks.len(), 3);
    assert!(!r.truncated);
    assert_eq!(normalize_limit(Some(10_000)), QUERY_BLOCKS_LIMIT_MAX);
    assert_eq!(normalize_limit(None), QUERY_BLOCKS_LIMIT_DEFAULT);
}

#[test]
fn reject_unsafe_attr_key() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    let mut attrs = BTreeMap::new();
    attrs.insert("status;drop".into(), JsonValue::String("x".into()));
    let err = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-q".into(),
            attrs_eq: Some(attrs),
            ..Default::default()
        })
        .unwrap_err();
    assert!(
        err.to_string().contains("非法属性键"),
        "err={err}"
    );
}

#[test]
fn empty_doc_id_errors() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    assert!(store
        .query_blocks(&QueryBlocksParams {
            doc_id: "".into(),
            ..Default::default()
        })
        .is_err());
}

#[test]
fn kind_only_no_text() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_diverse(&store);

    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-q".into(),
            kind_in: Some(vec!["todo".into(), "heading".into()]),
            ..Default::default()
        })
        .unwrap();
    let ids: Vec<_> = r.blocks.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&"t1"));
    assert!(ids.contains(&"h1"));
}

#[test]
fn text_match_empty_falls_back_to_sql() {
    let dir = TempDir::new();
    let store = WorkspaceStore::open(dir.db()).unwrap();
    seed_diverse(&store);

    // 空白 text_match 视为无 FTS 条件
    let r = store
        .query_blocks(&QueryBlocksParams {
            doc_id: "doc-q".into(),
            kind_in: Some(vec!["todo".into()]),
            text_match: Some("   ".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(r.blocks.len(), 1);
    assert_eq!(r.blocks[0].id, "t1");
}
