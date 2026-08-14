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

// ─── CT-01 CAS（乐观锁）· T1–T4 ────────────────────────────────────────

/// T1 · 期望不匹配 → Conflict + rev 保持 + updates 零追加。
#[test]
fn cas_expected_mismatch_conflicts_and_preserves_rev() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    // 无行首写：INSERT 分支无条件放行，rev=1
    store
        .on_committed_expect(
            "doc-cas-t1",
            &batch(vec![make_update(vec![0x11], "structure")], false),
            Some(0),
        )
        .unwrap();
    assert_eq!(store.load_rev("doc-cas-t1").unwrap(), 1);
    assert_eq!(store.load_pending_count("doc-cas-t1").unwrap(), 1);

    // 陈旧期望（行已存在且 rev=1 ≠ 0）→ Conflict{expect:0}
    let err = store
        .on_committed_expect(
            "doc-cas-t1",
            &batch(vec![make_update(vec![0x12], "structure")], false),
            Some(0),
        )
        .unwrap_err();
    assert!(matches!(err, PersistError::Conflict { expect: 0 }));

    // 副作用断言：rev 不被覆盖、updates 零追加
    assert_eq!(store.load_rev("doc-cas-t1").unwrap(), 1);
    assert_eq!(store.load_pending_count("doc-cas-t1").unwrap(), 1);
}

/// T2 · 期望匹配 → 单调前进；再冲突。
#[test]
fn cas_expected_match_advances_then_conflicts() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    store
        .on_committed_expect(
            "doc-cas-t2",
            &batch(vec![make_update(vec![1], "structure")], false),
            Some(0),
        )
        .unwrap();
    assert_eq!(store.load_rev("doc-cas-t2").unwrap(), 1);
    store
        .on_committed_expect(
            "doc-cas-t2",
            &batch(vec![make_update(vec![2], "structure")], false),
            Some(1),
        )
        .unwrap();
    assert_eq!(store.load_rev("doc-cas-t2").unwrap(), 2);

    let err = store
        .on_committed_expect(
            "doc-cas-t2",
            &batch(vec![make_update(vec![3], "structure")], false),
            Some(1),
        )
        .unwrap_err();
    assert!(matches!(err, PersistError::Conflict { expect: 1 }));
    assert_eq!(store.load_rev("doc-cas-t2").unwrap(), 2);
    assert_eq!(store.load_pending_count("doc-cas-t2").unwrap(), 2);
}

/// T3 · None 兼容 = 旧 LWW 行为（回归护栏）。
#[test]
fn cas_none_preserves_lww_behavior() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    // on_committed 直调两次（None 路径）→ rev=2（与现状完全一致）
    store
        .on_committed(
            "doc-cas-t3",
            &batch(vec![make_update(vec![1], "structure")], false),
        )
        .unwrap();
    store
        .on_committed(
            "doc-cas-t3",
            &batch(vec![make_update(vec![2], "structure")], false),
        )
        .unwrap();
    assert_eq!(store.load_rev("doc-cas-t3").unwrap(), 2);

    // on_committed_expect(None) 同理（委托同路径）
    store
        .on_committed_expect(
            "doc-cas-t3",
            &batch(vec![make_update(vec![3], "structure")], false),
            None,
        )
        .unwrap();
    assert_eq!(store.load_rev("doc-cas-t3").unwrap(), 3);
    assert_eq!(store.load_pending_count("doc-cas-t3").unwrap(), 3);
}

/// T4 · seq 不空洞：冲突事务零追加，后续成功写从原 max 继续。
#[test]
fn cas_conflict_leaves_no_seq_hole() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();

    // A：Some(0) 首写 Ok（2 条 update，seq=1,2）
    store
        .on_committed_expect(
            "doc-cas-t4",
            &batch(
                vec![
                    make_update(vec![1], "structure"),
                    make_update(vec![2], "text"),
                ],
                false,
            ),
            Some(0),
        )
        .unwrap();

    // B：Some(0) 陈旧 → Err（零追加，tx 回滚）
    let err = store
        .on_committed_expect(
            "doc-cas-t4",
            &batch(vec![make_update(vec![3], "structure")], false),
            Some(0),
        )
        .unwrap_err();
    assert!(matches!(err, PersistError::Conflict { expect: 0 }));

    // C：Some(1) Ok（seq=3，紧接 max+1，无空洞）
    store
        .on_committed_expect(
            "doc-cas-t4",
            &batch(vec![make_update(vec![4], "structure")], false),
            Some(1),
        )
        .unwrap();

    assert_eq!(store.load_pending_count("doc-cas-t4").unwrap(), 3);

    // 直接读 seq 列验证 [1,2,3]（无空洞）
    let conn = Connection::open(&db).unwrap();
    let mut stmt = conn
        .prepare("SELECT seq FROM doc_updates WHERE doc_id=?1 ORDER BY seq ASC")
        .unwrap();
    let seqs: Vec<i64> = stmt
        .query_map(params!["doc-cas-t4"], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(seqs, vec![1, 2, 3]);
}
