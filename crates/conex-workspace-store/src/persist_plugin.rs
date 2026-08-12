//! `PersistencePlugin`：load / on_committed / flush + snapshot compact。
//!
//! SD-02：自 `lib.rs` 门面拆出权威落盘路径。
//! **诚实**：**≠ EL-03**（恢复/打开产品叙事分属 W3 等）。

use crate::{SNAPSHOT_UPDATE_THRESHOLD, StoreError, WorkspaceStore};
use conex_doc_collab::{
    CommitBatch, EncodedUpdate, HydrateBlob, PersistError, PersistencePlugin,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::Arc;

impl PersistencePlugin for WorkspaceStore {
    fn load_doc(&self, doc_id: &str) -> Result<HydrateBlob, PersistError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistError::Io(e.to_string()))?;

        let snap: Option<Vec<u8>> = conn
            .query_row(
                "SELECT blob FROM doc_snapshots WHERE doc_id=?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| PersistError::Io(e.to_string()))?;

        // 全部 pending 按 seq 升序
        let mut stmt = conn
            .prepare(
                "SELECT blob, kind FROM doc_updates WHERE doc_id=?1 ORDER BY seq ASC",
            )
            .map_err(|e| PersistError::Io(e.to_string()))?;
        let pending = stmt
            .query_map(params![doc_id], |r| {
                let blob: Vec<u8> = r.get(0)?;
                let kind: String = r.get(1)?;
                Ok((blob, kind))
            })
            .map_err(|e| PersistError::Io(e.to_string()))?
            .map(|row| {
                let (blob, kind) = row.map_err(|e| PersistError::Io(e.to_string()))?;
                decode_encoded_update(blob, &kind)
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(HydrateBlob {
            snapshot: snap,
            pending,
        })
    }

    fn on_committed(&self, doc_id: &str, commit: &CommitBatch) -> Result<(), PersistError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistError::Io(e.to_string()))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PersistError::Io(e.to_string()))?;

        let tx_s = format!("{:?}", commit.tx_id);

        // 抬升 rev；确保 meta 行存在
        tx.execute(
            r#"
            INSERT INTO doc_meta(doc_id, rev, updated_at)
            VALUES (?1, 1, strftime('%s','now'))
            ON CONFLICT(doc_id) DO UPDATE SET
                rev = rev + 1,
                updated_at = strftime('%s','now')
            "#,
            params![doc_id],
        )
        .map_err(|e| PersistError::Io(e.to_string()))?;

        // 追加 updates（seq 单调）
        for u in &commit.updates {
            let seq: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM doc_updates WHERE doc_id=?1",
                    params![doc_id],
                    |r| r.get(0),
                )
                .map_err(|e| PersistError::Io(e.to_string()))?;
            let kind = kind_to_str(&u.kind);
            tx.execute(
                "INSERT INTO doc_updates(doc_id, seq, blob, kind, tx_id) VALUES (?1,?2,?3,?4,?5)",
                params![doc_id, seq, u.bytes, kind, tx_s],
            )
            .map_err(|e| PersistError::Io(e.to_string()))?;
        }

        let pending_count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM doc_updates WHERE doc_id=?1",
                params![doc_id],
                |r| r.get(0),
            )
            .map_err(|e| PersistError::Io(e.to_string()))?;

        let should_snapshot =
            commit.snapshot_tick || (pending_count as usize) >= SNAPSHOT_UPDATE_THRESHOLD;

        if should_snapshot {
            compact_snapshot(&tx, doc_id).map_err(|e| PersistError::Io(e.to_string()))?;
        }

        tx.commit().map_err(|e| PersistError::Io(e.to_string()))?;
        Ok(())
    }

    fn flush_hint(&self, doc_id: &str) -> Result<(), PersistError> {
        // 安全：先尝试合并该 doc；再 WAL checkpoint（PASSIVE，不阻塞写）
        if let Err(e) = self.flush_doc(doc_id) {
            // 无 pending / 无 snapshot 时 compact 仍成功；其它错误上抛
            return Err(PersistError::Io(e.to_string()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistError::Io(e.to_string()))?;
        // checkpoint 失败不视为致命（磁盘满等由上层感知）
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        Ok(())
    }
}

/// 可共享的 `WorkspaceStore` 句柄：同时充当 `PersistencePlugin` 与投影索引入口。
///
/// 因 orphan rule 不能直接 `impl PersistencePlugin for Arc<WorkspaceStore>`，
/// 用本地 newtype 包装。推荐：
/// ```ignore
/// let shared = SharedWorkspaceStore::open("workspace.db")?;
/// let mut session = DocSession::new("d").with_persistence(Box::new(shared.clone()));
/// commit_ops(&mut session, &shared, Origin::User, &ops)?;
/// ```
#[derive(Clone)]
pub struct SharedWorkspaceStore(pub Arc<WorkspaceStore>);

impl SharedWorkspaceStore {
    pub fn new(store: WorkspaceStore) -> Self {
        Self(Arc::new(store))
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Ok(Self::new(WorkspaceStore::open(path)?))
    }

    pub fn store(&self) -> &WorkspaceStore {
        &self.0
    }

    pub fn arc(&self) -> Arc<WorkspaceStore> {
        Arc::clone(&self.0)
    }
}

impl std::ops::Deref for SharedWorkspaceStore {
    type Target = WorkspaceStore;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl PersistencePlugin for SharedWorkspaceStore {
    fn load_doc(&self, doc_id: &str) -> Result<HydrateBlob, PersistError> {
        self.0.load_doc(doc_id)
    }

    fn on_committed(&self, doc_id: &str, commit: &CommitBatch) -> Result<(), PersistError> {
        self.0.on_committed(doc_id, commit)
    }

    fn flush_hint(&self, doc_id: &str) -> Result<(), PersistError> {
        self.0.flush_hint(doc_id)
    }
}

/// 将 pending updates 合并进 snapshot 并删除 updates 行。
pub(crate) fn compact_snapshot(conn: &Connection, doc_id: &str) -> Result<(), StoreError> {
    let old_snap: Option<Vec<u8>> = conn
        .query_row(
            "SELECT blob FROM doc_snapshots WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )
        .optional()?;

    let mut stmt = conn.prepare(
        "SELECT blob FROM doc_updates WHERE doc_id=?1 ORDER BY seq ASC",
    )?;
    let chunks: Vec<Vec<u8>> = stmt
        .query_map(params![doc_id], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut merged = Vec::new();
    if let Some(s) = old_snap {
        if !s.is_empty() {
            append_chunk(&mut merged, &s);
        }
    }
    for c in &chunks {
        append_chunk(&mut merged, c);
    }

    // 即使两边皆空也写一行，标记 doc 已 snapshot 过
    conn.execute(
        r#"
        INSERT INTO doc_snapshots(doc_id, blob, updated_at)
        VALUES (?1, ?2, strftime('%s','now'))
        ON CONFLICT(doc_id) DO UPDATE SET
            blob = excluded.blob,
            updated_at = excluded.updated_at
        "#,
        params![doc_id, merged],
    )?;

    conn.execute(
        "DELETE FROM doc_updates WHERE doc_id=?1",
        params![doc_id],
    )?;

    Ok(())
}

fn append_chunk(buf: &mut Vec<u8>, chunk: &[u8]) {
    let len = chunk.len() as u32;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(chunk);
}

/// UpdateKind → 存库字符串（不依赖 re-export，用 serde 形状）。
fn kind_to_str(kind: &impl serde::Serialize) -> String {
    match serde_json::to_value(kind) {
        Ok(serde_json::Value::String(s)) => s,
        _ => "combined".to_string(),
    }
}

fn decode_encoded_update(blob: Vec<u8>, kind: &str) -> Result<EncodedUpdate, PersistError> {
    serde_json::from_value(serde_json::json!({
        "bytes": blob,
        "kind": kind,
    }))
    .map_err(|e| PersistError::Corrupt(format!("encoded update: {e}")))
}

#[cfg(test)]
mod tests {
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
        store
            .on_committed("doc-b", &batch(vec![], true))
            .unwrap();

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
                .map(|i| {
                    make_update(vec![(r * batch_size + i) as u8], "combined")
                })
                .collect();
            store
                .on_committed("doc-c", &batch(ups, false))
                .unwrap();
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
            .on_committed(
                "doc-d",
                &batch(vec![make_update(vec![8], "text")], false),
            )
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
}
