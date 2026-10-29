//! `fts` 单元测（**SD-16** 外置；语义不变）。

use super::*;
use crate::SCHEMA_VERSION;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_db() -> (TempDir, PathBuf) {
    let dir = TempDir::new();
    let db = dir.path().join("workspace.db");
    (dir, db)
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-ws-fts-{}-{}-{}",
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
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn reindex_two_blocks_search_hits() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

    store
        .reindex_block(
            "doc-s",
            "b1",
            "hello world alpha",
            ReindexBlockOpts {
                kind: "paragraph".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .reindex_block(
            "doc-s",
            "b2",
            "beta gamma hello",
            ReindexBlockOpts {
                kind: "heading".into(),
                props_json: r#"{"status":"todo"}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
    // 另一文档：不应串 doc
    store
        .reindex_block(
            "doc-other",
            "b9",
            "hello only in other doc",
            ReindexBlockOpts::default(),
        )
        .unwrap();

    assert_eq!(store.count_blocks("doc-s").unwrap(), 2);

    let hits = store.search_fulltext("doc-s", "hello", 50).unwrap();
    assert_eq!(hits.len(), 2, "两条均含 hello 应命中");
    let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
    assert!(ids.contains(&"b1"));
    assert!(ids.contains(&"b2"));

    // 仅 b1 含 alpha
    let hits_a = store.search_fulltext("doc-s", "alpha", 10).unwrap();
    assert_eq!(hits_a.len(), 1);
    assert_eq!(hits_a[0].block_id, "b1");
    assert_eq!(hits_a[0].kind, "paragraph");

    // 空查询
    assert!(store
        .search_fulltext("doc-s", "   ", 10)
        .unwrap()
        .is_empty());
}

#[test]
fn remove_block_index_no_longer_hits() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    store
        .reindex_block(
            "doc-r",
            "keep",
            "unique_keep_token",
            ReindexBlockOpts::default(),
        )
        .unwrap();
    store
        .reindex_block(
            "doc-r",
            "drop",
            "unique_drop_token",
            ReindexBlockOpts::default(),
        )
        .unwrap();

    assert_eq!(
        store
            .search_fulltext("doc-r", "unique_drop_token", 10)
            .unwrap()
            .len(),
        1
    );

    store.remove_block_index("doc-r", "drop").unwrap();

    assert!(
        store
            .search_fulltext("doc-r", "unique_drop_token", 10)
            .unwrap()
            .is_empty(),
        "remove 后不应再命中"
    );
    // 另一块仍可搜
    assert_eq!(
        store
            .search_fulltext("doc-r", "unique_keep_token", 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(store.count_blocks("doc-r").unwrap(), 1);
}

#[test]
fn rebuild_fts_from_blocks_after_clear() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    store
        .reindex_block(
            "doc-f",
            "x1",
            "rebuildable_token_one",
            ReindexBlockOpts::default(),
        )
        .unwrap();
    store
        .reindex_block(
            "doc-f",
            "x2",
            "rebuildable_token_two",
            ReindexBlockOpts::default(),
        )
        .unwrap();
    assert_eq!(
        store
            .search_fulltext("doc-f", "rebuildable_token_one", 10)
            .unwrap()
            .len(),
        1
    );

    // 模拟 FTS 损坏/清空（blocks 投影仍在；另开连接避免碰私有字段）
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute("DELETE FROM blocks_fts", []).unwrap();
    }
    assert!(store
        .search_fulltext("doc-f", "rebuildable_token_one", 10)
        .unwrap()
        .is_empty());

    // 从 blocks 重建
    store.rebuild_fts(Some("doc-f")).unwrap();
    let hits = store
        .search_fulltext("doc-f", "rebuildable_token_one", 10)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, "x1");

    // 整库 rebuild 也可用
    store.rebuild_fts(None).unwrap();
    assert_eq!(
        store
            .search_fulltext("doc-f", "rebuildable_token_two", 10)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn reindex_upsert_updates_fts() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    store
        .reindex_block("d", "b", "old_token_xyz", ReindexBlockOpts::default())
        .unwrap();
    store
        .reindex_block("d", "b", "new_token_uvw", ReindexBlockOpts::default())
        .unwrap();
    assert!(store
        .search_fulltext("d", "old_token_xyz", 10)
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .search_fulltext("d", "new_token_uvw", 10)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(store.count_blocks("d").unwrap(), 1);
}

#[test]
fn query_blocks_by_attr_simple() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    store
        .reindex_block(
            "doc-a",
            "t1",
            "task one",
            ReindexBlockOpts {
                kind: "todo".into(),
                props_json: r#"{"status":"todo","prio":"1"}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .reindex_block(
            "doc-a",
            "t2",
            "task two",
            ReindexBlockOpts {
                kind: "todo".into(),
                props_json: r#"{"status":"done"}"#.into(),
                ..Default::default()
            },
        )
        .unwrap();

    // 空 attrs → 空
    assert!(store
        .query_blocks_by_attr("doc-a", &[], 50)
        .unwrap()
        .is_empty());

    let hits = store
        .query_blocks_by_attr("doc-a", &[("status", "todo")], 50)
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].block_id, "t1");

    // 非法键
    assert!(store
        .query_blocks_by_attr("doc-a", &[("status;drop", "x")], 10)
        .is_err());
}
