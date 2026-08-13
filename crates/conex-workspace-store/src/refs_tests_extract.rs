//! refs 测 · 抽边 / schema_v5 / 手工 upsert（**SD-53** 测拆）。
//!
//! 由 [`crate::refs::tests`] 经 `#[path]` 接入。
//! **≠ 占 SD-18**（不改 `refs.rs` 实现）；**≠ EL-03**。

use super::*;

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

    store.upsert_ref("doc-a", "b1", "target", "block").unwrap();
    store.upsert_ref("doc-a", "b2", "target", "block").unwrap();
    store.upsert_ref("doc-a", "b1", "other", "page").unwrap();
    // 幂等：同边再写不炸
    store.upsert_ref("doc-a", "b1", "target", "block").unwrap();
    // 另一 doc 不得串
    store.upsert_ref("doc-b", "b1", "target", "block").unwrap();

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
