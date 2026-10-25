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
//! 3. 读路径纯读纪律（03 §3.3 / 重入死锁解耦，取代旧「读中自愈」契约）：
//!    - `get_blob` / `get_blob_meta` 为 ReaderPool **纯读**——禁止在读路径
//!      发起 `write_blocking`（若被写 Actor 间接调用会 100% 重入死锁）；
//!    - 隔离期内 Blob 依然可读；反隔离由显式写路径处理：重挂引用
//!      （`link_*` 连接级纯函数自带 `unquarantine_blob_conn`）或显式
//!      `unquarantine_blob`；隔离生命周期由独立 GC 任务裁决。

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
//
// D3-6 / D3-1：写路径一律经组提交 Writer（`write_blocking` 短临界区）；
// 纯读走 `read()`（ReaderPool / 主连接回退）；GC 扫描不得全程持主 Mutex。

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
        let bytes_owned = bytes.to_vec();
        let hash_owned = hash.clone();
        let storage_type = storage_type.to_string();
        let path_owned = path.to_string();
        self.write_blocking(move |conn| {
            put_blob_conn(
                conn,
                &hash_owned,
                size,
                &bytes_owned,
                &storage_type,
                &path_owned,
            )
            .map_err(|e| DbFailure {
                message: format!("put_blob: {e}"),
                kind: DbFailureKind::Other("put_blob".to_string()),
            })
        })?;
        Ok(hash)
    }

    /// 读 Blob 内容（ReaderPool 纯读，D-P/03 §3.3：**禁止**读中发起
    /// `write_blocking` 自愈——读闭包若在写 Actor 线程被间接调用会引发
    /// 100% 重入死锁）。隔离期内的 Blob 依然可读；反隔离由显式路径处理：
    /// 重挂引用（`link_*` 连接级纯函数自带 `unquarantine_blob_conn`）或
    /// 显式 [`Self::unquarantine_blob`]；隔离生命周期由独立 GC 任务
    /// （[`Self::run_cas_gc`] / [`Self::purge_expired_quarantined`]）裁决。
    pub fn get_blob(&self, hash: &str) -> Result<Option<Vec<u8>>, DbFailure> {
        let hash_owned = hash.to_string();
        self.read(move |conn| {
            conn.query_row(
                "SELECT bytes FROM blob_cas WHERE hash = ?1",
                params![hash_owned],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| DbFailure {
                message: format!("get_blob: {e}"),
                kind: DbFailureKind::Other("get_blob".to_string()),
            })
        })
    }

    /// 读元数据（ReaderPool 纯读，不自愈）。命中隔离行时
    /// `marked_for_delete_at` 原样返回——调用方据其判断
    /// `needing_unquarantine`；反隔离走 [`Self::unquarantine_blob`] 或
    /// 重挂引用路径。语义与 [`Self::peek_blob_meta`] 一致（保留双名兼容）。
    pub fn get_blob_meta(&self, hash: &str) -> Result<Option<CasBlobRow>, DbFailure> {
        let hash_owned = hash.to_string();
        self.read(move |conn| {
            get_blob_meta_conn(conn, &hash_owned, false).map_err(|e| DbFailure {
                message: format!("get_blob_meta: {e}"),
                kind: DbFailureKind::Other("get_blob_meta".to_string()),
            })
        })
    }

    /// 纯读元数据（不自愈），走 ReaderPool。
    pub fn peek_blob_meta(&self, hash: &str) -> Result<Option<CasBlobRow>, DbFailure> {
        let hash_owned = hash.to_string();
        self.read(move |conn| {
            get_blob_meta_conn(conn, &hash_owned, false).map_err(|e| DbFailure {
                message: format!("peek_blob_meta: {e}"),
                kind: DbFailureKind::Other("peek_blob_meta".to_string()),
            })
        })
    }

    pub fn unquarantine_blob(&self, hash: &str) -> Result<bool, DbFailure> {
        let hash_owned = hash.to_string();
        self.write_blocking(move |conn| {
            unquarantine_blob_conn(conn, &hash_owned).map_err(|e| DbFailure {
                message: format!("unquarantine_blob: {e}"),
                kind: DbFailureKind::Other("unquarantine_blob".to_string()),
            })
        })
    }

    pub fn pin_blob(&self, hash: &str, pinned: bool) -> Result<bool, DbFailure> {
        let hash_owned = hash.to_string();
        self.write_blocking(move |conn| {
            pin_blob_conn(conn, &hash_owned, pinned).map_err(|e| DbFailure {
                message: format!("pin_blob: {e}"),
                kind: DbFailureKind::Other("pin_blob".to_string()),
            })
        })
    }

    pub fn link_block_attachment(
        &self,
        doc_id: &str,
        block_id: &str,
        hash: &str,
    ) -> Result<(), DbFailure> {
        let doc_id = doc_id.to_string();
        let block_id = block_id.to_string();
        let hash = hash.to_string();
        self.write_blocking(move |conn| {
            link_block_attachment_conn(conn, &doc_id, &block_id, &hash).map_err(|e| DbFailure {
                message: format!("link_block_attachment: {e}"),
                kind: DbFailureKind::Other("link_block_attachment".to_string()),
            })
        })
    }

    pub fn unlink_block_attachment(
        &self,
        doc_id: &str,
        block_id: &str,
        hash: &str,
    ) -> Result<bool, DbFailure> {
        let doc_id = doc_id.to_string();
        let block_id = block_id.to_string();
        let hash = hash.to_string();
        self.write_blocking(move |conn| {
            unlink_block_attachment_conn(conn, &doc_id, &block_id, &hash).map_err(|e| DbFailure {
                message: format!("unlink_block_attachment: {e}"),
                kind: DbFailureKind::Other("unlink_block_attachment".to_string()),
            })
        })
    }

    pub fn list_block_attachments(
        &self,
        doc_id: &str,
        block_id: &str,
    ) -> Result<Vec<String>, DbFailure> {
        let doc_id = doc_id.to_string();
        let block_id = block_id.to_string();
        self.read(move |conn| {
            list_block_attachments_conn(conn, &doc_id, &block_id).map_err(|e| DbFailure {
                message: format!("list_block_attachments: {e}"),
                kind: DbFailureKind::Other("list_block_attachments".to_string()),
            })
        })
    }

    pub fn link_snapshot_attachment(
        &self,
        doc_id: &str,
        snapshot_id: &str,
        blob_hash: &str,
    ) -> Result<(), DbFailure> {
        let doc_id = doc_id.to_string();
        let snapshot_id = snapshot_id.to_string();
        let blob_hash = blob_hash.to_string();
        self.write_blocking(move |conn| {
            link_snapshot_attachment_conn(conn, &doc_id, &snapshot_id, &blob_hash).map_err(|e| {
                DbFailure {
                    message: format!("link_snapshot_attachment: {e}"),
                    kind: DbFailureKind::Other("link_snapshot_attachment".to_string()),
                }
            })
        })
    }

    pub fn link_undo_blob(
        &self,
        session_id: &str,
        undo_step_id: &str,
        blob_hash: &str,
    ) -> Result<(), DbFailure> {
        let session_id = session_id.to_string();
        let undo_step_id = undo_step_id.to_string();
        let blob_hash = blob_hash.to_string();
        self.write_blocking(move |conn| {
            link_undo_blob_conn(conn, &session_id, &undo_step_id, &blob_hash).map_err(|e| {
                DbFailure {
                    message: format!("link_undo_blob: {e}"),
                    kind: DbFailureKind::Other("link_undo_blob".to_string()),
                }
            })
        })
    }

    pub fn count_blobs(&self) -> Result<usize, DbFailure> {
        let count: i64 = self.read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM blob_cas", [], |r| r.get(0))
                .map_err(|e| DbFailure {
                    message: format!("count_blobs: {e}"),
                    kind: DbFailureKind::Other("count_blobs".to_string()),
                })
        })?;
        Ok(count as usize)
    }

    pub fn count_quarantined_blobs(&self) -> Result<usize, DbFailure> {
        let count: i64 = self.read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM blob_cas WHERE marked_for_delete_at IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .map_err(|e| DbFailure {
                message: format!("count_quarantined_blobs: {e}"),
                kind: DbFailureKind::Other("count_quarantined_blobs".to_string()),
            })
        })?;
        Ok(count as usize)
    }

    /// 扫描并标记孤儿 Blob 进入软删除隔离期（SEC-13 / SEC-18 清理出锁）：
    /// 1. 阶段一（锁外只读扫描）：经 `self.read` (ReaderPool) 执行 4 表 `NOT EXISTS` 候选扫描并过滤内存租约，零写锁占用；
    /// 2. 阶段二（按分片微事务更新）：无候选时直接返回（0 次写事务）；有候选时按 `CAS_GC_BATCH_CHUNK`
    ///    分片提交短写事务，写事务内仅按主键 `hash IN (...)` 校验引用并 `RETURNING hash`，消除长事务阻塞在线写入。
    pub fn mark_quarantine_orphans(&self, config: &CasGcConfig) -> Result<Vec<String>, DbFailure> {
        let cfg_scan = config.clone();
        let candidate_hashes = self.read(move |conn| {
            scan_quarantine_orphan_candidates_conn(conn, &cfg_scan).map_err(|e| DbFailure {
                message: format!("mark_quarantine_orphans_scan: {e}"),
                kind: DbFailureKind::Other("mark_quarantine_orphans".to_string()),
            })
        })?;

        let candidate_hashes: Vec<String> = candidate_hashes
            .into_iter()
            .filter(|h| !self.lease_guard.is_leased(h))
            .collect();

        if candidate_hashes.is_empty() {
            return Ok(Vec::new());
        }

        let mut marked = Vec::with_capacity(candidate_hashes.len());
        for chunk in candidate_hashes.chunks(CAS_GC_BATCH_CHUNK) {
            let chunk_vec = chunk.to_vec();
            let cfg_chunk = config.clone();
            let chunk_marked = self.write_blocking(move |conn| {
                mark_quarantine_chunk_conn(conn, &chunk_vec, &cfg_chunk).map_err(|e| DbFailure {
                    message: format!("mark_quarantine_orphans: {e}"),
                    kind: DbFailureKind::Other("mark_quarantine_orphans".to_string()),
                })
            })?;
            marked.extend(chunk_marked);
        }
        Ok(marked)
    }

    /// 扫描并物理清除已过隔离期的孤儿 Blob（SEC-13 / SEC-18 清理出锁）：
    /// 1. 阶段一（锁外只读扫描）：经 `self.read` (ReaderPool) 扫描过期隔离候选与过期租约存在性，不占写锁；
    /// 2. 阶段二（按分片微事务删除）：仅在存在待删候选或过期租约时发起短写事务，按主键校验并删除；
    /// 3. 阶段三（事务外磁盘清理）：写事务提交释放锁后，在事务边界外部执行外置文件 `remove_file`。
    pub fn purge_expired_quarantined(
        &self,
        config: &CasGcConfig,
    ) -> Result<Vec<String>, DbFailure> {
        let cfg_scan = config.clone();
        let (candidate_hashes, has_expired_leases) =
            self.read(move |conn| {
                let candidates = scan_expired_quarantined_candidates_conn(conn, &cfg_scan)
                    .map_err(|e| DbFailure {
                        message: format!("purge_expired_quarantined_scan: {e}"),
                        kind: DbFailureKind::Other("purge_expired_quarantined".to_string()),
                    })?;
                let expired_leases = has_expired_blob_leases_conn(conn).unwrap_or(false);
                Ok((candidates, expired_leases))
            })?;

        let candidate_hashes: Vec<String> = candidate_hashes
            .into_iter()
            .filter(|h| !self.lease_guard.is_leased(h))
            .collect();

        if candidate_hashes.is_empty() {
            if has_expired_leases {
                self.write_blocking(|conn| {
                    conn.execute(
                        "DELETE FROM active_blob_leases WHERE expires_at <= datetime('now')",
                        [],
                    )
                    .map_err(|e| DbFailure {
                        message: format!("purge_expired_quarantined_cleanup_leases: {e}"),
                        kind: DbFailureKind::Other("purge_expired_quarantined".to_string()),
                    })?;
                    Ok(())
                })?;
            }
            return Ok(Vec::new());
        }

        let mut purged = Vec::with_capacity(candidate_hashes.len());
        let mut files_to_delete = Vec::new();
        let chunks: Vec<Vec<String>> = candidate_hashes
            .chunks(CAS_GC_BATCH_CHUNK)
            .map(|c| c.to_vec())
            .collect();
        let total_chunks = chunks.len();

        for (idx, chunk_vec) in chunks.into_iter().enumerate() {
            let cfg_chunk = config.clone();
            let clean_leases = has_expired_leases && (idx + 1 == total_chunks);
            let (chunk_purged, chunk_files) = self.write_blocking(move |conn| {
                let res = purge_expired_quarantined_chunk_conn(conn, &chunk_vec, &cfg_chunk)
                    .map_err(|e| DbFailure {
                        message: format!("purge_expired_quarantined: {e}"),
                        kind: DbFailureKind::Other("purge_expired_quarantined".to_string()),
                    })?;
                if clean_leases {
                    conn.execute(
                        "DELETE FROM active_blob_leases WHERE expires_at <= datetime('now')",
                        [],
                    )
                    .map_err(|e| DbFailure {
                        message: format!("purge_expired_quarantined_cleanup_leases: {e}"),
                        kind: DbFailureKind::Other("purge_expired_quarantined".to_string()),
                    })?;
                }
                Ok(res)
            })?;
            purged.extend(chunk_purged);
            files_to_delete.extend(chunk_files);
        }

        remove_purged_external_files(&files_to_delete);
        Ok(purged)
    }

    /// 统计经 ReaderPool / 主连接回退；标记与物理清除各走一次 Writer 短事务
    /// （不在完整扫描期间持主 Mutex，D3-6 / 05-G2）。
    pub fn run_cas_gc(&self, config: &CasGcConfig) -> Result<GcScanStats, DbFailure> {
        let cfg = config.clone();
        let grace_param = format!("-{} seconds", cfg.creation_grace_secs);
        let (total_blobs_scanned, pinned_protected, lease_protected, reference_protected, grace_protected) =
            self.read(move |conn| -> Result<(usize, usize, usize, usize, usize), DbFailure> {
                let total: i64 = conn
                    .query_row("SELECT COUNT(*) FROM blob_cas", [], |r| r.get(0))
                    .map_err(|e| DbFailure {
                        message: format!("run_cas_gc total: {e}"),
                        kind: DbFailureKind::Other("run_cas_gc".to_string()),
                    })?;
                let pinned: i64 = conn
                    .query_row("SELECT COUNT(*) FROM blob_cas WHERE pinned = 1", [], |r| {
                        r.get(0)
                    })
                    .map_err(|e| DbFailure {
                        message: format!("run_cas_gc pinned: {e}"),
                        kind: DbFailureKind::Other("run_cas_gc".to_string()),
                    })?;
                let lease: i64 = conn
                    .query_row(
                        "SELECT COUNT(DISTINCT blob_hash) FROM active_blob_leases WHERE expires_at > datetime('now')",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let reference: i64 = conn
                    .query_row(
                        r#"
                        SELECT COUNT(DISTINCT b.hash) FROM blob_cas b
                        WHERE EXISTS (SELECT 1 FROM block_attachments a WHERE a.hash = b.hash)
                           OR EXISTS (SELECT 1 FROM doc_snapshots_attachments s WHERE s.blob_hash = b.hash)
                           OR EXISTS (SELECT 1 FROM session_undo_blobs u WHERE u.blob_hash = b.hash)
                        "#,
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let grace: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM blob_cas WHERE (pinned = 0 OR pinned IS NULL) AND created_at > datetime('now', ?1)",
                        params![grace_param],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                Ok((
                    total as usize,
                    pinned as usize,
                    lease as usize,
                    reference as usize,
                    grace as usize,
                ))
            })?;

        let quarantined_hashes = self.mark_quarantine_orphans(&cfg)?;
        let purged_hashes = self.purge_expired_quarantined(&cfg)?;

        Ok(GcScanStats {
            total_blobs_scanned,
            reference_protected,
            lease_protected,
            pinned_protected,
            grace_protected,
            quarantined_hashes,
            purged_hashes,
        })
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
    // 反隔离失败必须上抛：引用已登记但 blob 仍处于隔离期，若继续静默会
    // 在隔离期满后被 GC 物理清除，造成「有引用却被删」的数据丢失
    if !unquarantine_blob_conn(conn, hash)? {
        tracing::warn!(
            target: "conex_db",
            hash,
            "块附件引用登记后反隔离未命中任何 blob_cas 行（悬空引用：blob 缺失）"
        );
    }
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
    // 同 link_block_attachment_conn：反隔离失败上抛，避免引用中的 blob 被 GC 清除
    if !unquarantine_blob_conn(conn, blob_hash)? {
        tracing::warn!(
            target: "conex_db",
            blob_hash,
            "快照附件引用登记后反隔离未命中任何 blob_cas 行（悬空引用：blob 缺失）"
        );
    }
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
    // 同 link_block_attachment_conn：反隔离失败上抛，避免引用中的 blob 被 GC 清除
    if !unquarantine_blob_conn(conn, blob_hash)? {
        tracing::warn!(
            target: "conex_db",
            blob_hash,
            "Undo blob 引用登记后反隔离未命中任何 blob_cas 行（悬空引用：blob 缺失）"
        );
    }
    Ok(())
}

/// 批量标记 SQL 的 IN 列表分片大小（SQLite 变量上限友好）。
const CAS_GC_BATCH_CHUNK: usize = 200;

/// 为 `IN (?, ?, …)` 生成占位符串。
fn in_placeholders(n: usize) -> String {
    (0..n)
        .map(|_| "?".to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// 在事务边界外（ReaderPool 只读连接）扫描待进入软删除隔离期的候选孤儿 Hash（SEC-13 / SEC-18）。
pub(crate) fn scan_quarantine_orphan_candidates_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<Vec<String>, rusqlite::Error> {
    let grace_param = format!("-{} seconds", config.creation_grace_secs);
    let mut stmt = conn.prepare_cached(
        r#"
        SELECT b.hash FROM blob_cas b
        WHERE
            b.marked_for_delete_at IS NULL
            AND (b.pinned = 0 OR b.pinned IS NULL)
            AND b.created_at <= datetime('now', ?1)
            AND NOT EXISTS (
                SELECT 1 FROM block_attachments a WHERE a.hash = b.hash
            )
            AND NOT EXISTS (
                SELECT 1 FROM doc_snapshots_attachments s WHERE s.blob_hash = b.hash
            )
            AND NOT EXISTS (
                SELECT 1 FROM session_undo_blobs u WHERE u.blob_hash = b.hash
            )
            AND NOT EXISTS (
                SELECT 1 FROM active_blob_leases l
                WHERE l.blob_hash = b.hash AND l.expires_at > datetime('now')
            )
        "#,
    )?;
    let rows = stmt.query_map(params![grace_param], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// 针对单个候选分片，在写事务内按主键二次校验多源引用并原子标记软隔离（防 TOCTOU 竞态）。
pub(crate) fn mark_quarantine_chunk_conn(
    conn: &Connection,
    chunk: &[String],
    config: &CasGcConfig,
) -> Result<Vec<String>, rusqlite::Error> {
    if chunk.is_empty() {
        return Ok(Vec::new());
    }
    let grace_param = format!("-{} seconds", config.creation_grace_secs);
    let ph = in_placeholders(chunk.len());
    let grace_idx = chunk.len() + 1;
    let sql = format!(
        r#"
        UPDATE blob_cas
        SET marked_for_delete_at = CURRENT_TIMESTAMP, updated_at = datetime('now')
        WHERE hash IN ({ph})
          AND marked_for_delete_at IS NULL
          AND (pinned = 0 OR pinned IS NULL)
          AND created_at <= datetime('now', ?{grace_idx})
          AND NOT EXISTS (
              SELECT 1 FROM block_attachments a WHERE a.hash = blob_cas.hash
          )
          AND NOT EXISTS (
              SELECT 1 FROM doc_snapshots_attachments s WHERE s.blob_hash = blob_cas.hash
          )
          AND NOT EXISTS (
              SELECT 1 FROM session_undo_blobs u WHERE u.blob_hash = blob_cas.hash
          )
          AND NOT EXISTS (
              SELECT 1 FROM active_blob_leases l
              WHERE l.blob_hash = blob_cas.hash AND l.expires_at > datetime('now')
          )
        RETURNING hash
        "#
    );
    let mut params_vec: Vec<&dyn rusqlite::ToSql> =
        chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    params_vec.push(&grace_param);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_vec.as_slice(), |r| r.get::<_, String>(0))?;
    rows.collect()
}

pub fn mark_quarantine_orphans_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<Vec<String>, rusqlite::Error> {
    let candidate_hashes = scan_quarantine_orphan_candidates_conn(conn, config)?;
    let mut marked = Vec::with_capacity(candidate_hashes.len());
    for chunk in candidate_hashes.chunks(CAS_GC_BATCH_CHUNK) {
        marked.extend(mark_quarantine_chunk_conn(conn, chunk, config)?);
    }
    Ok(marked)
}

/// 在事务边界外（ReaderPool 只读连接）扫描隔离期已届满且无引用的待物理清除候选 Hash（SEC-13 / SEC-18）。
pub(crate) fn scan_expired_quarantined_candidates_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<Vec<String>, rusqlite::Error> {
    let quarantine_param = format!("-{} seconds", config.quarantine_duration_secs);
    let mut stmt = conn.prepare_cached(
        r#"
        SELECT b.hash FROM blob_cas b
        WHERE
            b.marked_for_delete_at IS NOT NULL
            AND b.marked_for_delete_at <= datetime('now', ?1)
            AND (b.pinned = 0 OR b.pinned IS NULL)
            AND NOT EXISTS (
                SELECT 1 FROM block_attachments a WHERE a.hash = b.hash
            )
            AND NOT EXISTS (
                SELECT 1 FROM doc_snapshots_attachments s WHERE s.blob_hash = b.hash
            )
            AND NOT EXISTS (
                SELECT 1 FROM session_undo_blobs u WHERE u.blob_hash = b.hash
            )
            AND NOT EXISTS (
                SELECT 1 FROM active_blob_leases l
                WHERE l.blob_hash = b.hash AND l.expires_at > datetime('now')
            )
        "#,
    )?;
    let rows = stmt.query_map(params![quarantine_param], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// 只读探测是否存在已过期的 `active_blob_leases` 记录。
pub(crate) fn has_expired_blob_leases_conn(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let exists: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM active_blob_leases WHERE expires_at <= datetime('now'))",
        [],
        |r| r.get(0),
    )?;
    Ok(exists != 0)
}

/// 针对单个候选分片，在写事务内按主键二次校验引用并物理删除过期隔离行（防 TOCTOU 竞态）。
pub(crate) fn purge_expired_quarantined_chunk_conn(
    conn: &Connection,
    chunk: &[String],
    config: &CasGcConfig,
) -> Result<(Vec<String>, Vec<String>), rusqlite::Error> {
    if chunk.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let quarantine_param = format!("-{} seconds", config.quarantine_duration_secs);
    let ph = in_placeholders(chunk.len());
    let quarantine_idx = chunk.len() + 1;
    let sql = format!(
        r#"
        DELETE FROM blob_cas
        WHERE hash IN ({ph})
          AND marked_for_delete_at IS NOT NULL
          AND marked_for_delete_at <= datetime('now', ?{quarantine_idx})
          AND (pinned = 0 OR pinned IS NULL)
          AND NOT EXISTS (
              SELECT 1 FROM block_attachments a WHERE a.hash = blob_cas.hash
          )
          AND NOT EXISTS (
              SELECT 1 FROM doc_snapshots_attachments s WHERE s.blob_hash = blob_cas.hash
          )
          AND NOT EXISTS (
              SELECT 1 FROM session_undo_blobs u WHERE u.blob_hash = blob_cas.hash
          )
          AND NOT EXISTS (
              SELECT 1 FROM active_blob_leases l
              WHERE l.blob_hash = blob_cas.hash AND l.expires_at > datetime('now')
          )
        RETURNING hash, path, storage_type
        "#
    );
    let mut params_vec: Vec<&dyn rusqlite::ToSql> =
        chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    params_vec.push(&quarantine_param);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_vec.as_slice(), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut purged = Vec::with_capacity(chunk.len());
    let mut files_to_delete = Vec::new();
    for r in rows {
        let (hash, path, storage_type) = r?;
        if storage_type != "inline" && !path.trim().is_empty() {
            files_to_delete.push(path);
        }
        purged.push(hash);
    }
    Ok((purged, files_to_delete))
}

// 豁免理由：CAS GC 物理清理已过期的外置隔离 Blob 文件（由 GC 状态机驱动，不进回收站）
#[allow(clippy::disallowed_methods)]
fn remove_purged_external_files(files_to_delete: &[String]) {
    for file_path in files_to_delete {
        let p = std::path::Path::new(file_path);
        if p.exists() {
            if let Err(e) = std::fs::remove_file(p) {
                tracing::warn!(target: "conex_db", "CAS GC 物理删除外置文件失败 `{file_path}`: {e}");
            } else {
                tracing::info!(target: "conex_db", "CAS GC 物理删除外置文件成功 `{file_path}`");
            }
        }
    }
}

/// 扫描 + 批量物理清除过期隔离 Blob。
///
/// 返回 `(purged_hashes, files_to_delete)`：外置文件的 `unlink` 由调用方在
/// 事务提交后执行（禁止在 Writer 事务内做磁盘 IO）。
/// 顺带（05-G6）：清除已过期的 `active_blob_leases` 行。
pub fn purge_expired_quarantined_conn(
    conn: &Connection,
    config: &CasGcConfig,
) -> Result<(Vec<String>, Vec<String>), rusqlite::Error> {
    let candidate_hashes = scan_expired_quarantined_candidates_conn(conn, config)?;
    let mut purged = Vec::with_capacity(candidate_hashes.len());
    let mut files_to_delete = Vec::new();
    for chunk in candidate_hashes.chunks(CAS_GC_BATCH_CHUNK) {
        let (chunk_purged, chunk_files) =
            purge_expired_quarantined_chunk_conn(conn, chunk, config)?;
        purged.extend(chunk_purged);
        files_to_delete.extend(chunk_files);
    }

    // 05-G6：顺带清除过期租约行（与 purge 同一短写事务）
    conn.execute(
        "DELETE FROM active_blob_leases WHERE expires_at <= datetime('now')",
        [],
    )?;

    Ok((purged, files_to_delete))
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
    let lease_protected: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT blob_hash) FROM active_blob_leases WHERE expires_at > datetime('now')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let reference_protected: i64 = conn
        .query_row(
            r#"
            SELECT COUNT(DISTINCT b.hash) FROM blob_cas b
            WHERE EXISTS (SELECT 1 FROM block_attachments a WHERE a.hash = b.hash)
               OR EXISTS (SELECT 1 FROM doc_snapshots_attachments s WHERE s.blob_hash = b.hash)
               OR EXISTS (SELECT 1 FROM session_undo_blobs u WHERE u.blob_hash = b.hash)
            "#,
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let grace_param = format!("-{} seconds", config.creation_grace_secs);
    let grace_protected: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM blob_cas WHERE (pinned = 0 OR pinned IS NULL) AND created_at > datetime('now', ?1)",
            params![grace_param],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let quarantined_hashes = mark_quarantine_orphans_conn(conn, config)?;
    let (purged_hashes, files_to_delete) = purge_expired_quarantined_conn(conn, config)?;
    remove_purged_external_files(&files_to_delete);

    Ok(GcScanStats {
        total_blobs_scanned: total_blobs_scanned as usize,
        reference_protected: reference_protected as usize,
        lease_protected: lease_protected as usize,
        pinned_protected: pinned_protected as usize,
        grace_protected: grace_protected as usize,
        quarantined_hashes,
        purged_hashes,
    })
}

/// 启动后台 CAS GC 守护循环。
///
/// 定期（如每 1 小时）执行一次轻量扫描；支持通过 cancel_rx 安全退出。
pub fn spawn_cas_gc_loop(
    db: LocalDb,
    interval: std::time::Duration,
    config: CasGcConfig,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(interval);
        loop {
            tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        tracing::info!(target: "conex_db", "CAS GC 调度器收到退出信号，安全终止");
                        break;
                    }
                }
                _ = timer.tick() => {
                    tracing::debug!(target: "conex_db", "开始执行周期性 CAS GC 扫描...");
                    // run_cas_gc 走 write_blocking（blocking_send）——必须 spawn_blocking，
                    // 禁止在 async 上下文直接调用（会 panic）。
                    let db = db.clone();
                    let config = config.clone();
                    match tokio::task::spawn_blocking(move || db.run_cas_gc(&config)).await {
                        Ok(Ok(stats)) => {
                            if !stats.quarantined_hashes.is_empty() || !stats.purged_hashes.is_empty() {
                                tracing::info!(
                                    target: "conex_db",
                                    "CAS GC 执行完成: 隔离 {} 个, 物理清除 {} 个, 租约保护 {}, 引用保护 {}",
                                    stats.quarantined_hashes.len(),
                                    stats.purged_hashes.len(),
                                    stats.lease_protected,
                                    stats.reference_protected
                                );
                            }
                        }
                        Ok(Err(e)) => {
                            tracing::error!(target: "conex_db", "CAS GC 执行失败: {e}");
                        }
                        Err(join_err) => {
                            tracing::error!(target: "conex_db", "CAS GC spawn_blocking join 失败: {join_err}");
                        }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gc_scan_without_candidates_does_not_acquire_writer_lock() {
        let db = LocalDb::open_in_memory().unwrap();
        let h1 = db.put_blob(b"protected-by-block").unwrap();
        db.link_block_attachment("doc-1", "blk-1", &h1).unwrap();

        let batches_before = db.writer().stats().total_batches;
        let reads_before = db.reader_pool().stats().total_acquisitions;

        // 执行零宽限 GC：h1 受引用保护，无任何孤儿或过期隔离候选
        let stats = db.run_cas_gc(&CasGcConfig::zero_grace()).unwrap();
        assert!(stats.quarantined_hashes.is_empty());
        assert!(stats.purged_hashes.is_empty());

        let batches_after = db.writer().stats().total_batches;
        let reads_after = db.reader_pool().stats().total_acquisitions;

        assert_eq!(
            batches_after, batches_before,
            "GC scan with zero candidates must not submit any write_blocking transactions"
        );
        assert!(
            reads_after >= reads_before + 3,
            "GC scan must execute candidate queries on ReaderPool"
        );
    }

    #[test]
    fn gc_chunk_update_and_delete_guard_against_toctou_concurrent_reference() {
        let db = LocalDb::open_in_memory().unwrap();
        let h1 = db.put_blob(b"toctou-blob-1").unwrap();
        let h2 = db.put_blob(b"toctou-blob-2").unwrap();
        let cfg = CasGcConfig::immediate_purge();

        // 模拟阶段一：在只读连接上扫描出 h1, h2 均为孤儿候选
        let candidates = db
            .read({
                let cfg = cfg.clone();
                move |conn| {
                    scan_quarantine_orphan_candidates_conn(conn, &cfg).map_err(|e| DbFailure {
                        message: e.to_string(),
                        kind: DbFailureKind::Other("test".to_string()),
                    })
                }
            })
            .unwrap();
        assert_eq!(candidates.len(), 2);

        // 模拟 TOCTOU 窗口：在阶段二写事务执行前，h1 被关联到 block_attachments
        db.link_block_attachment("doc-race", "blk-race", &h1)
            .unwrap();

        // 阶段二：将旧候选列表 [h1, h2] 送入写分片——h1 必须被写事务内 NOT EXISTS 拦截保护，仅 h2 被标记
        let marked = db
            .write_blocking({
                let cfg = cfg.clone();
                move |conn| {
                    mark_quarantine_chunk_conn(conn, &candidates, &cfg).map_err(|e| DbFailure {
                        message: e.to_string(),
                        kind: DbFailureKind::Other("test".to_string()),
                    })
                }
            })
            .unwrap();
        assert_eq!(marked, vec![h2.clone()]);
        assert!(db
            .peek_blob_meta(&h1)
            .unwrap()
            .unwrap()
            .marked_for_delete_at
            .is_none());
    }
}
