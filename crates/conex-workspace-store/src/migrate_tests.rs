//! `migrate` 单元测（**SD-31** 外置；语义与拆前一致）。
//!
//! 由父模 [`crate::migrate`] 经 `#[path]` 接入。
//! **≠ EL-03**；**≠ Wave 2 存储完成**；不静默改 schema。

use super::*;
use crate::WorkspaceStore;
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
            "conex-ws-mig-{}-{}-{}",
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
fn migrate_idempotent_and_v3_tables() {
    let (_dir, db) = temp_db();
    let store = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

    // 二次 open + 再 migrate 幂等
    let store2 = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store2.schema_version().unwrap(), SCHEMA_VERSION);
    drop(store2);

    // 独立连接：重复 migrate + 验表
    {
        let conn = Connection::open(&db).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('blocks','blocks_fts')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 2);
        // 升版路径：手工把 version 压到 2
        conn.execute("UPDATE schema_version SET version = 2", [])
            .unwrap();
    }
    let store3 = WorkspaceStore::open(&db).unwrap();
    assert_eq!(store3.schema_version().unwrap(), SCHEMA_VERSION);

    // v4 mirror_meta + v5 block_refs + v6 blob_cas / block_attachments
    {
        let conn = Connection::open(&db).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('mirror_meta','block_refs','blob_cas','block_attachments')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 4);
    }
}
