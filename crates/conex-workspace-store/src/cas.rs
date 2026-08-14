//! # W2-D-S · CAS 附件骨架（Skeleton）
//!
//! Content-addressed blob：`put` / `get` / `link` 最小 API 面。
//!
//! ## 不变量
//! - 附件 **不是** 第二文档权威；权威仍为 `doc_snapshots` ⊕ `doc_updates`。
//! - `blob_cas` 仅存字节/路径；块关联走 `block_attachments` 引用表。
//! - hash = SHA-256 hex（小写）；同内容 put 幂等。
//! - **默认不把附件字节写入 snapshot 热路径**（结构方向 A-PERF-11；见骨架测）。
//!
//! ## 诚实边界（-S · 强制）
//! - **≠ 生产就绪**：仅 put/get/link 骨架，**禁止**宣称 CAS「生产就绪」。
//! - **≠ GC 满关**：无未引用回收、无 `unlink` 产品路径、无外置 `blobs/` 阈值策略。
//! - **≠ EL** / **≠ A-PERF-11 数值满关** / **≠ Wave 2 存储完成**。
//! - Strict 包 **W2-D** 才扩：GC 最小 + 外置 path + 不进 snapshot 结构门满关。
//!
//! 文件域：`crates/conex-workspace-store/**`（02 钉死；不写 sessions / conex-db）。

use super::{StoreError, WorkspaceStore};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// 计算内容哈希（SHA-256 hex 小写）。
pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

impl WorkspaceStore {
    /// W2-D-S：写入 CAS，返回 content hash。同内容重复 put 幂等（不复制字节）。
    ///
    /// **≠** 生产就绪 / **≠** GC / **≠** 外置 `blobs/` 阈值。
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String, StoreError> {
        let hash = content_hash(bytes);
        let size = bytes.len() as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        put_blob_conn(&conn, &hash, bytes, size)?;
        Ok(hash)
    }

    /// W2-D-S：按 hash 读取 blob 字节；不存在返回 `None`。
    pub fn get_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        get_blob_conn(&conn, hash)
    }

    /// W2-D-S：将块与 CAS hash 关联（幂等）。**不**把附件塞进 snapshot。
    ///
    /// 缺 hash 行 → `StoreError::Persist`（须先 [`Self::put_blob`]）。
    /// **≠** 未引用 GC；unlink/GC 属 W2-D Strict。
    pub fn link_block_attachment(
        &self,
        doc_id: &str,
        block_id: &str,
        hash: &str,
    ) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        // 校验 hash 已存在
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM blob_cas WHERE hash = ?1 LIMIT 1",
                params![hash],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            return Err(StoreError::Persist(format!(
                "link_block_attachment: blob hash 不存在 `{hash}`"
            )));
        }
        conn.execute(
            r#"
            INSERT INTO block_attachments(doc_id, block_id, hash)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(doc_id, block_id, hash) DO NOTHING
            "#,
            params![doc_id, block_id, hash],
        )?;
        Ok(())
    }

    /// W2-D-S：列出块上关联的 attachment hash（诊断 / 测）。
    pub fn list_block_attachments(
        &self,
        doc_id: &str,
        block_id: &str,
    ) -> Result<Vec<String>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT hash FROM block_attachments WHERE doc_id = ?1 AND block_id = ?2 ORDER BY hash",
        )?;
        let rows = stmt.query_map(params![doc_id, block_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 诊断：blob_cas 行数（-S；非 GC 水位）。
    pub fn count_blobs(&self) -> Result<usize, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM blob_cas", [], |r| r.get(0))?;
        Ok(n as usize)
    }
}

/// 连接级 put（幂等）。W2-D-S：默认内联 `bytes`；`path` 空串（外置属 W2-D）。
pub fn put_blob_conn(
    conn: &Connection,
    hash: &str,
    bytes: &[u8],
    size: i64,
) -> Result<(), StoreError> {
    conn.execute(
        r#"
        INSERT INTO blob_cas(hash, size, bytes, path, created_at)
        VALUES (?1, ?2, ?3, '', strftime('%s','now'))
        ON CONFLICT(hash) DO NOTHING
        "#,
        params![hash, size, bytes],
    )?;
    Ok(())
}

/// 连接级 get。
pub fn get_blob_conn(conn: &Connection, hash: &str) -> Result<Option<Vec<u8>>, StoreError> {
    let blob: Option<Vec<u8>> = conn
        .query_row(
            "SELECT bytes FROM blob_cas WHERE hash = ?1",
            params![hash],
            |r| r.get(0),
        )
        .optional()?;
    Ok(blob)
}

/// 事务内：删除某块的全部 attachment **链接**（投影 remove 时用）。
///
/// **≠ GC**：只清 `block_attachments` 行，**不**删 `blob_cas` 字节（孤儿留给 W2-D GC）。
pub(crate) fn remove_block_attachments_conn(
    conn: &Connection,
    doc_id: &str,
    block_id: &str,
) -> Result<(), StoreError> {
    conn.execute(
        "DELETE FROM block_attachments WHERE doc_id = ?1 AND block_id = ?2",
        params![doc_id, block_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! W2-D-S 骨架测：put/get/link + 不进 snapshot 结构烟雾。
    //! **≠** 生产就绪 / **≠** GC 满关 / **≠** EL / **≠** A-PERF-11 数值。
    use super::*;
    use rusqlite::params;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> (PathBuf, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conex-cas-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("workspace.db");
        (dir, db)
    }

    /// put/get 往返 + 同内容幂等（单行 blob_cas）。
    #[test]
    fn put_get_blob_roundtrip_and_idempotent() {
        let (dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        assert!(store.schema_version().unwrap() >= 6);

        let data = b"hello cas attachment bytes";
        let h1 = store.put_blob(data).unwrap();
        assert_eq!(h1, content_hash(data));
        assert_eq!(h1.len(), 64); // sha256 hex

        let h2 = store.put_blob(data).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(store.count_blobs().unwrap(), 1);

        let got = store.get_blob(&h1).unwrap().expect("blob");
        assert_eq!(got, data);

        assert!(store.get_blob("deadbeef").unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// link 须先有 hash；重复 link 幂等。
    #[test]
    fn link_block_attachment_requires_existing_hash() {
        let (dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();

        assert!(store
            .link_block_attachment("d1", "b1", "no_such_hash")
            .is_err());

        let h = store.put_blob(b"img-bytes").unwrap();
        store.link_block_attachment("d1", "b1", &h).unwrap();
        store.link_block_attachment("d1", "b1", &h).unwrap(); // 幂等
        let links = store.list_block_attachments("d1", "b1").unwrap();
        assert_eq!(links, vec![h]);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A-PERF-11 结构烟雾（-S）：put/link 不写 `doc_snapshots` / `doc_updates`。
    ///
    /// **≠** A-PERF-11 数值满关；**≠** 生产就绪；仅断言附件不落权威表。
    #[test]
    fn put_link_does_not_touch_doc_snapshots_or_updates() {
        let (dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();

        let payload = b"attachment-must-not-enter-snapshot-hot-path";
        let h = store.put_blob(payload).unwrap();
        store
            .link_block_attachment("doc-cas", "block-img", &h)
            .unwrap();

        let conn = store.conn.lock().unwrap();
        let snap_n: i64 = conn
            .query_row("SELECT COUNT(*) FROM doc_snapshots", [], |r| r.get(0))
            .unwrap();
        let upd_n: i64 = conn
            .query_row("SELECT COUNT(*) FROM doc_updates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(snap_n, 0, "put/link 不得写入 doc_snapshots");
        assert_eq!(upd_n, 0, "put/link 不得写入 doc_updates");

        // 附件只在 CAS 表；snapshot 行内亦不得含 payload（双保险）
        let cas_n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM blob_cas WHERE hash = ?1",
                params![h],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cas_n, 1);
        drop(conn);

        let got = store.get_blob(&h).unwrap().expect("cas row");
        assert_eq!(got, payload);

        let _ = std::fs::remove_dir_all(dir);
    }
}
