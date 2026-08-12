//! `persist_plugin` 单元测（**SD-21** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::persist_plugin`] 经 `#[path]` 接入。
//! **≠ EL-04**；**≠ EL-03**；不静默改 snapshot / updates 语义。

use super::*;
use conex_doc_collab::{Origin, TxId};
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
            "conex-ws-pp-{}-{}-{}",
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

fn make_update(bytes: Vec<u8>, kind: &str) -> EncodedUpdate {
    serde_json::from_value(serde_json::json!({
        "bytes": bytes,
        "kind": kind,
    }))
    .expect("EncodedUpdate")
}

fn batch(updates: Vec<EncodedUpdate>, snapshot_tick: bool) -> CommitBatch {
    CommitBatch {
        tx_id: TxId::new(),
        origin: Origin::User,
        updates,
        snapshot_tick,
    }
}

#[test]
fn on_committed_pending_ordered_on_load() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    store
        .on_committed(
            "doc-a",
            &batch(
                vec![
                    make_update(vec![0x01], "structure"),
                    make_update(vec![0x02, 0x03], "text"),
                ],
                false,
            ),
        )
        .unwrap();
    store
        .on_committed(
            "doc-a",
            &batch(vec![make_update(vec![0x04], "combined")], false),
        )
        .unwrap();

    assert_eq!(store.load_pending_count("doc-a").unwrap(), 3);
    assert_eq!(store.load_rev("doc-a").unwrap(), 2);

    let h = store.load_doc("doc-a").unwrap();
    assert!(h.snapshot.is_none());
    assert_eq!(h.pending.len(), 3);
    assert_eq!(h.pending[0].bytes, vec![0x01]);
    assert_eq!(h.pending[1].bytes, vec![0x02, 0x03]);
    assert_eq!(h.pending[2].bytes, vec![0x04]);
    // kind 经 serde 回环
    let k0 = serde_json::to_value(&h.pending[0].kind).unwrap();
    assert_eq!(k0, serde_json::json!("structure"));
    let k1 = serde_json::to_value(&h.pending[1].kind).unwrap();
    assert_eq!(k1, serde_json::json!("text"));
}

#[test]
fn snapshot_tick_compacts_and_clears_pending() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    store
        .on_committed(
            "doc-b",
            &batch(vec![make_update(b"aaa".to_vec(), "combined")], false),
        )
        .unwrap();
    store
        .on_committed(
            "doc-b",
            &batch(vec![make_update(b"bbb".to_vec(), "combined")], false),
        )
        .unwrap();
    assert_eq!(store.load_pending_count("doc-b").unwrap(), 2);

    // snapshot_tick → 合并 + 裁剪
    store.on_committed("doc-b", &batch(vec![], true)).unwrap();

    assert_eq!(store.load_pending_count("doc-b").unwrap(), 0);
    let h = store.load_doc("doc-b").unwrap();
    assert!(h.pending.is_empty());
    let snap = h.snapshot.expect("snapshot after tick");
    // framing: [3][aaa][3][bbb]
    assert_eq!(&snap[0..4], &3u32.to_le_bytes());
    assert_eq!(&snap[4..7], b"aaa");
    assert_eq!(&snap[7..11], &3u32.to_le_bytes());
    assert_eq!(&snap[11..14], b"bbb");
}

#[test]
fn threshold_triggers_auto_snapshot() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    // 分批写入，最后一条使总数达到阈值
    let batch_size = 25;
    let rounds = SNAPSHOT_UPDATE_THRESHOLD / batch_size;
    for r in 0..rounds {
        let ups: Vec<_> = (0..batch_size)
            .map(|i| make_update(vec![(r * batch_size + i) as u8], "combined"))
            .collect();
        store.on_committed("doc-c", &batch(ups, false)).unwrap();
    }
    // 恰好 100 → 自动 compact
    assert_eq!(
        store.load_pending_count("doc-c").unwrap(),
        0,
        "达到阈值后 pending 应被裁剪"
    );
    let h = store.load_doc("doc-c").unwrap();
    assert!(h.snapshot.is_some());
    assert!(h.pending.is_empty());
}

#[test]
fn flush_doc_and_flush_hint() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    store
        .on_committed(
            "doc-d",
            &batch(vec![make_update(vec![9], "structure")], false),
        )
        .unwrap();
    assert_eq!(store.load_pending_count("doc-d").unwrap(), 1);

    store.flush_doc("doc-d").unwrap();
    assert_eq!(store.load_pending_count("doc-d").unwrap(), 0);
    assert!(store.load_doc("doc-d").unwrap().snapshot.is_some());

    // 再写一条后 flush_hint
    store
        .on_committed("doc-d", &batch(vec![make_update(vec![8], "text")], false))
        .unwrap();
    store.flush_hint("doc-d").unwrap();
    assert_eq!(store.load_pending_count("doc-d").unwrap(), 0);
}

#[test]
fn open_migrate_and_commit_smoke() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    let batch = CommitBatch {
        tx_id: TxId::new(),
        origin: Origin::System,
        updates: vec![make_update(vec![1, 2, 3], "combined")],
        snapshot_tick: true,
    };
    store.on_committed("doc-a", &batch).unwrap();
    let h = store.load_doc("doc-a").unwrap();
    assert!(h.snapshot.is_some());
    assert!(h.pending.is_empty());
    assert!(store.load_rev("doc-a").unwrap() >= 1);
}
