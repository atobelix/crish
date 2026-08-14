//! CAS 活数据垃圾回收（GC）与多源联合引用扫描。
//!
//! 设计契约（Batch 2 Unit 2.2 + ROUND-3-IMPROVEMENT-02 §3）：
//! 1. 多源联合引用安全网：
//!    - `block_attachments`（当前 Head 视图块引用）
//!    - `doc_snapshots_attachments`（CRDT 历史快照引用）
//!    - `session_undo_blobs`（Undo/Redo 栈历史附件引用）
//!    - `active_blob_leases`（未过期的活数据保护租约）
//!    - `pinned` 置顶保护（pinned = 1 永不回收）
//! 2. 两阶段软删除隔离（Soft-Delete / Quarantine）：
//!    - 阶段 1：无全域引用的孤儿仅标记 `marked_for_delete_at = CURRENT_TIMESTAMP`，
//!      进入 7 天隔离期，**严禁即时物理删除**；
//!    - 阶段 2：仅当处于隔离期超过 7 天（可配置）且依然无引用的孤儿，才执行物理删除；
//! 3. 读取阶段反隔离自愈（Un-quarantine on Read）：
//!    - 任何读取（`get_blob`）若命中处于软删除隔离期的 Blob，
//!      原子清除 `marked_for_delete_at = NULL` 恢复为正常状态。

use super::schema::create_v5_schema;
use super::{DbFailure, DbFailureKind, LocalDb};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// 默认软删除隔离期：7 天（7 * 86400 秒）。
pub const DEFAULT_QUARANTINE_SECS: i64 = 7 * 86400;
/// 默认新建 Blob 宽限保护期：5 分钟（300 秒）。
pub const DEFAULT_CREATION_GRACE_SECS: i64 = 300;

/// CAS Blob 行元数据。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CasBlobRow {
    pub hash: String,
    pub size: i64,
    pub bytes: Option<Vec<u8>>,
    pub path: String,
    pub storage_type: String,
    pub pinned: bool,
    pub marked_for_delete_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// CAS GC 运行配置。
#[derive(Debug, Clone)]
pub struct CasGcConfig {
    /// 软删除隔离期时长（秒，默认 7 天）。超过该时长未自愈的孤儿将被物理清除。
    pub quarantine_duration_secs: i64,
    /// 新创建 Blob 保护宽限期（秒，默认 5 分钟）。在此期间内新上传的 Blob 不进入隔离。
    pub creation_grace_secs: i64,
}

impl Default for CasGcConfig {
    fn default() -> Self {
        Self {
            quarantine_duration_secs: DEFAULT_QUARANTINE_SECS,
            creation_grace_secs: DEFAULT_CREATION_GRACE_SECS,
        }
    }
}

impl CasGcConfig {
    pub fn new_default() -> Self {
        Self::default()
    }
    /// 7 天隔离期 + 0 秒新建宽限（用于即时进入软删除隔离期，但保留 7 天不物理清除）
    pub fn zero_grace() -> Self {
        Self {
            quarantine_duration_secs: DEFAULT_QUARANTINE_SECS,
            creation_grace_secs: 0,
        }
    }
    /// 0 秒隔离期 + 0 秒宽限（用于测试两阶段全链路即时物理清理）
    pub fn immediate_purge() -> Self {
        Self {
            quarantine_duration_secs: 0,
            creation_grace_secs: 0,
        }
    }
    pub fn with_quarantine_secs(quarantine_secs: i64) -> Self {
        Self {
            quarantine_duration_secs: quarantine_secs,
            creation_grace_secs: 0,
        }
    }
}

/// CAS 垃圾回收执行统计报告。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GcScanStats {
    pub total_blobs_scanned: usize,
    pub reference_protected: usize,
    pub lease_protected: usize,
    pub pinned_protected: usize,
    pub grace_protected: usize,
    pub quarantined_hashes: Vec<String>,
    pub purged_hashes: Vec<String>,
}

/// 计算内容的 SHA-256 16进制小写哈希（基于标准 sha2 crate 与 hex 编码）。
pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 确保 CAS 表结构就绪（幂等创建）。
pub fn ensure_cas_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(create_v5_schema())
}

// ===== LocalDb CAS GC 方法面 =====

impl LocalDb {
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String, DbFailure> {
        self.put_blob_with_options(bytes, "inline", "")
    }

    pub fn put_blob_with_options(
        &self,
        bytes: &[u8],
        storage_type: &str,
        path: &str,
    ) -> Result<String, DbFailure> {
        let hash = compute_sha256_hex(bytes);
        let size = bytes.len() as i64;
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        put_blob_conn(&conn, &hash, size, bytes, storage_type, path)
            .map_err(|e| self.latch_error("put_blob", e))?;
        Ok(hash)
    }

    pub fn get_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        get_blob_conn(&conn, hash).map_err(|e| self.latch_error("get_blob", e))
    }

    pub fn get_blob_meta(&self, hash: &str) -> Result<Option<CasBlobRow>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        get_blob_meta_conn(&conn, hash, true).map_err(|e| self.latch_error("get_blob_meta", e))
    }

    pub fn peek_blob_meta(&self, hash: &str) -> Result<Option<CasBlobRow>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        get_blob_meta_conn(&conn, hash, false).map_err(|e| self.latch_error("peek_blob_meta", e))
    }

    pub fn unquarantine_blob(&self, hash: &str) -> Result<bool, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        unquarantine_blob_conn(&conn, hash).map_err(|e| self.latch_error("unquarantine_blob", e))
    }

    pub fn pin_blob(&self, hash: &str, pinned: bool) -> Result<bool, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        pin_blob_conn(&conn, hash, pinned).map_err(|e| self.latch_error("pin_blob", e))
    }

    pub fn link_block_attachment(
        &self,
        doc_id: &str,
        block_id: &str,
        hash: &str,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        link_block_attachment_conn(&conn, doc_id, block_id, hash)
            .map_err(|e| self.latch_error("link_block_attachment", e))
    }

    pub fn unlink_block_attachment(
        &self,
        doc_id: &str,
        block_id: &str,
        hash: &str,
    ) -> Result<bool, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        unlink_block_attachment_conn(&conn, doc_id, block_id, hash)
            .map_err(|e| self.latch_error("unlink_block_attachment", e))
    }

    pub fn list_block_attachments(
        &self,
        doc_id: &str,
        block_id: &str,
    ) -> Result<Vec<String>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        list_block_attachments_conn(&conn, doc_id, block_id)
            .map_err(|e| self.latch_error("list_block_attachments", e))
    }

    pub fn link_snapshot_attachment(
        &self,
        doc_id: &str,
        snapshot_id: &str,
        blob_hash: &str,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        link_snapshot_attachment_conn(&conn, doc_id, snapshot_id, blob_hash)
            .map_err(|e| self.latch_error("link_snapshot_attachment", e))
    }

    pub fn link_undo_blob(
        &self,
        session_id: &str,
        undo_step_id: &str,
        blob_hash: &str,
    ) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        link_undo_blob_conn(&conn, session_id, undo_step_id, blob_hash)
            .map_err(|e| self.latch_error("link_undo_blob", e))
    }

    pub fn count_blobs(&self) -> Result<usize, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM blob_cas", [], |r| r.get(0))
            .map_err(|e| self.latch_error("count_blobs", e))?;
        Ok(count as usize)
    }

    pub fn count_quarantined_blobs(&self) -> Result<usize, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM blob_cas WHERE marked_for_delete_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error("count_quarantined_blobs", e))?;
        Ok(count as usize)
    }

    pub fn mark_quarantine_orphans(&self, config: &CasGcConfig) -> Result<Vec<String>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        mark_quarantine_orphans_conn(&conn, config)
            .map_err(|e| self.latch_error("mark_quarantine_orphans", e))
    }

    pub fn purge_expired_quarantined(
        &self,
        config: &CasGcConfig,
    ) -> Result<Vec<String>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        purge_expired_quarantined_conn(&conn, config)
            .map_err(|e| self.latch_error("purge_expired_quarantined", e))
    }

    pub fn run_cas_gc(&self, config: &CasGcConfig) -> Result<GcScanStats, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        run_cas_gc_conn(&conn, config).map_err(|e| self.latch_error("run_cas_gc", e))
    }
}

// ===== 连接级核心实现 =====

pub fn put_blob_conn(
    conn: &Connection,
    hash: &str,
    size: i64,
    bytes: &[u8],
    storage_type: &str,
    path: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        r#"
        INSERT INTO blob_cas (hash, size, bytes, path, storage_type, pinned, marked_for_delete_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, datetime('now'), datetime('now'))
        ON CONFLICT(hash) DO UPDATE SET
            marked_for_delete_at = NULL,
            updated_at = datetime('now')
        "#,
        params![hash, size, bytes, path, storage_type],
    )?;
    Ok(())
}

pub fn get_blob_conn(conn: &Connection, hash: &str) -> Result<Option<Vec<u8>>, rusqlite::Error> {
    let row: Option<(Option<Vec<u8>>, Option<String>)> = conn
        .query_row(
            "SELECT bytes, marked_for_delete_at FROM blob_cas WHERE hash = ?1",
            params![hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    let Some((bytes, marked_for_delete_at)) = row else {
        return Ok(None);
    };
    if marked_for_delete_at.is_some() {
        conn.execute(
            "UPDATE blob_cas SET marked_for_delete_at = NULL, updated_at = datetime('now') WHERE hash = ?1",
            params![hash],
        )?;
    }
    Ok(bytes)
}

pub fn get_blob_meta_conn(
    conn: &Connection,
    hash: &str,
    heal_on_read: bool,
) -> Result<Option<CasBlobRow>, rusqlite::Error> {
    let row = conn
        .query_row(
            r#"
            SELECT hash, size, bytes, path, storage_type, pinned, marked_for_delete_at, created_at, updated_at
            FROM blob_cas WHERE hash = ?1
            "#,
            params![hash],
            |r| {
                Ok(CasBlobRow {
                    hash: r.get(0)?,
                    size: r.get(1)?,
                    bytes: r.get(2)?,
                    path: r.get(3)?,
                    storage_type: r.get(4)?,
                    pinned: r.get::<_, i64>(5)? != 0,
                    marked_for_delete_at: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            },
        )
        .optional()?;

    let Some(mut meta) = row else {
        return Ok(None);
    };
    if heal_on_read && meta.marked_for_delete_at.is_some() {
        conn.execute(
            "UPDATE blob_cas SET marked_for_delete_at = NULL, updated_at = datetime('now') WHERE hash = ?1",
            params![hash],
        )?;
        meta.marked_for_delete_at = None;
    }
    Ok(Some(meta))
}

pub fn unquarantine_blob_conn(conn: &Connection, hash: &str) -> Result<bool, rusqlite::Error> {
    let count = conn.execute(
        "UPDATE blob_cas SET marked_for_delete_at = NULL, updated_at = datetime('now') WHERE hash = ?1",
        params![hash],
    )?;
    Ok(count > 0)
}

pub fn pin_blob_conn(conn: &Connection, hash: &str, pinned: bool) -> Result<bool, rusqlite::Error> {
    let pinned_val = if pinned { 1 } else { 0 };
    let count = conn.execute(
        "UPDATE blob_cas SET pinned = ?1, updated_at = datetime('now') WHERE hash = ?2",
        params![pinned_val, hash],
    )?;
    Ok(count > 0)
}

pub fn link_block_attachment_conn(
    conn: &Connection,
    doc_id: &str,
    block_id: &str,
    hash: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        r#"
        INSERT INTO block_attachments (doc_id, block_id, hash, created_at)
        VALUES (?1, ?2, ?3, datetime('now'))
        ON CONFLICT(doc_id, block_id, hash) DO NOTHING
        "#,
        params![doc_id, block_id, hash],
    )?;
    let _ = unquarantine_blob_conn(conn, hash);
    Ok(())
}

pub fn unlink_block_attachment_conn(
    conn: &Connection,
    doc_id: &str,
    block_id: &str,
    hash: &str,
) -> Result<bool, rusqlite::Error> {
    let count = conn.execute(
        "DELETE FROM block_attachments WHERE doc_id = ?1 AND block_id = ?2 AND hash = ?3",
        params![doc_id, block_id, hash],
    )?;
    Ok(count > 0)
}

pub fn list_block_attachments_conn(
    conn: &Connection,
    doc_id: &str,
    block_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT hash FROM block_attachments WHERE doc_id = ?1 AND block_id = ?2 ORDER BY hash ASC",
    )?;
    let rows = stmt.query_map(params![doc_id, block_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn link_snapshot_attachment_conn(
    conn: &Connection,
    doc_id: &str,
    snapshot_id: &str,
    blob_hash: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        r#"
        INSERT INTO doc_snapshots_attachments (doc_id, snapshot_id, blob_hash, created_at)
        VALUES (?1, ?2, ?3, datetime('now'))
        ON CONFLICT(doc_id, snapshot_id, blob_hash) DO NOTHING
        "#,
        params![doc_id, snapshot_id, blob_hash],
    )?;
    let _ = unquarantine_blob_conn(conn, blob_hash);
    Ok(())
}

pub fn link_undo_blob_conn(
    conn: &Connection,
    session_id: &str,
    undo_step_id: &str,
    blob_hash: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        r#"
        INSERT INTO session_undo_blobs (session_id, undo_step_id, blob_hash, created_at)
        VALUES (?1, ?2, ?3, datetime('now'))
        ON CONFLICT(session_id, undo_step_id, blob_hash) DO NOTHING
        "#,
        params![session_id, undo_step_id, blob_hash],
    )?;
    let _ = unquarantine_blob_conn(conn, blob_hash);
    Ok(())
}

pub fn mark_quarantine_orphans_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<Vec<String>, rusqlite::Error> {
    let grace_param = format!("-{} seconds", config.creation_grace_secs);
    let mut stmt = conn.prepare(
        r#"
        SELECT b.hash FROM blob_cas b
        WHERE
            b.marked_for_delete_at IS NULL
            AND (b.pinned = 0 OR b.pinned IS NULL)
            AND b.created_at <= datetime('now', ?1)
            AND b.hash NOT IN (
                SELECT DISTINCT hash FROM block_attachments WHERE hash IS NOT NULL
            )
            AND b.hash NOT IN (
                SELECT DISTINCT blob_hash FROM doc_snapshots_attachments WHERE blob_hash IS NOT NULL
            )
            AND b.hash NOT IN (
                SELECT DISTINCT blob_hash FROM session_undo_blobs WHERE blob_hash IS NOT NULL
            )
            AND b.hash NOT IN (
                SELECT DISTINCT blob_hash FROM active_blob_leases WHERE expires_at > datetime('now')
            )
        "#,
    )?;
    let rows = stmt.query_map(params![grace_param], |r| r.get::<_, String>(0))?;
    let mut candidate_hashes = Vec::new();
    for r in rows {
        candidate_hashes.push(r?);
    }
    drop(stmt);

    let mut marked = Vec::new();
    for hash in candidate_hashes {
        let count = conn.execute(
            r#"
            UPDATE blob_cas
            SET marked_for_delete_at = CURRENT_TIMESTAMP, updated_at = datetime('now')
            WHERE hash = ?1 AND marked_for_delete_at IS NULL
            "#,
            params![hash],
        )?;
        if count > 0 {
            marked.push(hash);
        }
    }
    Ok(marked)
}

pub fn purge_expired_quarantined_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<Vec<String>, rusqlite::Error> {
    let quarantine_param = format!("-{} seconds", config.quarantine_duration_secs);
    let mut stmt = conn.prepare(
        r#"
        SELECT b.hash, b.path, b.storage_type FROM blob_cas b
        WHERE
            b.marked_for_delete_at IS NOT NULL
            AND b.marked_for_delete_at <= datetime('now', ?1)
            AND (b.pinned = 0 OR b.pinned IS NULL)
            AND b.hash NOT IN (
                SELECT DISTINCT hash FROM block_attachments WHERE hash IS NOT NULL
            )
            AND b.hash NOT IN (
                SELECT DISTINCT blob_hash FROM doc_snapshots_attachments WHERE blob_hash IS NOT NULL
            )
            AND b.hash NOT IN (
                SELECT DISTINCT blob_hash FROM session_undo_blobs WHERE blob_hash IS NOT NULL
            )
            AND b.hash NOT IN (
                SELECT DISTINCT blob_hash FROM active_blob_leases WHERE expires_at > datetime('now')
            )
        "#,
    )?;
    let rows = stmt.query_map(params![quarantine_param], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut to_purge = Vec::new();
    let mut files_to_delete = Vec::new();
    for r in rows {
        let (hash, path, storage_type) = r?;
        if storage_type != "inline" && !path.trim().is_empty() {
            files_to_delete.push(path);
        }
        to_purge.push(hash);
    }
    drop(stmt);

    let mut purged = Vec::new();
    for hash in to_purge {
        let count = conn.execute("DELETE FROM blob_cas WHERE hash = ?1", params![hash])?;
        if count > 0 {
            purged.push(hash);
        }
    }

    // 物理 unlink 孤儿外置文件，彻底根除外置文件物理泄漏
    for file_path in files_to_delete {
        let p = std::path::Path::new(&file_path);
        if p.exists() {
            if let Err(e) = std::fs::remove_file(p) {
                tracing::warn!(target: "conex_db", "CAS GC 物理删除外置文件失败 `{file_path}`: {e}");
            } else {
                tracing::info!(target: "conex_db", "CAS GC 物理删除外置文件成功 `{file_path}`");
            }
        }
    }

    Ok(purged)
}

pub fn run_cas_gc_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<GcScanStats, rusqlite::Error> {
    let total_blobs_scanned: i64 =
        conn.query_row("SELECT COUNT(*) FROM blob_cas", [], |r| r.get(0))?;
    let pinned_protected: i64 =
        conn.query_row("SELECT COUNT(*) FROM blob_cas WHERE pinned = 1", [], |r| {
            r.get(0)
        })?;
    let quarantined_hashes = mark_quarantine_orphans_conn(conn, config)?;
    let purged_hashes = purge_expired_quarantined_conn(conn, config)?;

    Ok(GcScanStats {
        total_blobs_scanned: total_blobs_scanned as usize,
        reference_protected: 0,
        lease_protected: 0,
        pinned_protected: pinned_protected as usize,
        grace_protected: 0,
        quarantined_hashes,
        purged_hashes,
    })
}
