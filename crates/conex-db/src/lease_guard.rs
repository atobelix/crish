//! CAS Blob 活数据保护租约（30 分钟上传/编辑租约与并发防误杀守卫）。
//!
//! 设计契约（Batch 2 Unit 2.2 + ROUND-3-IMPROVEMENT-02 §3.2）：
//! - [BlobLeaseGuard]：内存高速只读探测与 TTL 自然过期；
//! - `active_blob_leases` 表：持久化活跃租约，联合 GC 扫描排除；
//! - 默认租约时长 [DEFAULT_LEASE_DURATION] 为 30 分钟（1800 秒），
//!   防止用户正在上传、编辑或待合入的大附件被并发 GC 误杀；
//! - 支持按 hash / lease_id 续期、主动释放、过期自动清理（sweep）。

use super::{DbFailure, DbFailureKind, LocalDb};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 默认活数据保护租约时长：30 分钟（1800 秒）。
pub const DEFAULT_LEASE_DURATION: Duration = Duration::from_secs(1800);
/// 默认活数据保护租约时长（秒数）。
pub const DEFAULT_LEASE_DURATION_SECS: i64 = 1800;

static LEASE_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 生成全局唯一租约 ID。
pub fn generate_lease_id() -> String {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let count = LEASE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("lease-{now_ms:x}-{count:x}")
}

/// 活跃 Blob 租约记录（对应 `active_blob_leases` 表行）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ActiveBlobLease {
    /// 租约唯一标识
    pub lease_id: String,
    /// 目标 Blob 内容哈希
    pub blob_hash: String,
    /// 租约持有者标识（如 session_id, agent_id, upload_ticket 等）
    pub holder: String,
    /// 租约到期时间（SQLite datetime 格式，如 `YYYY-MM-DD HH:MM:SS`）
    pub expires_at: String,
    /// 租约创建时间
    pub created_at: String,
}

/// 内存高速活数据租约守卫（提供微秒级非阻塞 `is_leased` 判定）。
#[derive(Debug)]
pub struct BlobLeaseGuard {
    leases: RwLock<HashMap<String, Instant>>,
}

impl Default for BlobLeaseGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl BlobLeaseGuard {
    /// 创建新的内存租约守卫。
    pub fn new() -> Self {
        Self {
            leases: RwLock::new(HashMap::new()),
        }
    }

    /// 获取或续期一个 Blob 内存租约（默认 30 分钟）。
    pub fn acquire_lease(&self, hash: &str) {
        self.acquire_lease_with_duration(hash, DEFAULT_LEASE_DURATION);
    }

    /// 获取或续期一个指定时长的 Blob 内存租约。
    pub fn acquire_lease_with_duration(&self, hash: &str, duration: Duration) {
        let mut map = self.leases.write().unwrap_or_else(|p| p.into_inner());
        let expiry = Instant::now() + duration;
        map.insert(hash.to_string(), expiry);
    }

    /// 主动释放 Blob 内存租约。
    pub fn release_lease(&self, hash: &str) {
        let mut map = self.leases.write().unwrap_or_else(|p| p.into_inner());
        map.remove(hash);
    }

    /// 检查指定 Hash 是否处于活跃内存租约保护中。
    pub fn is_leased(&self, hash: &str) -> bool {
        let map = self.leases.read().unwrap_or_else(|p| p.into_inner());
        if let Some(expiry) = map.get(hash) {
            Instant::now() < *expiry
        } else {
            false
        }
    }

    /// 清理已过期的内存租约。
    pub fn sweep(&self) {
        let mut map = self.leases.write().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        map.retain(|_, expiry| *expiry > now);
    }

    /// 当前保护的活跃租约数量。
    pub fn active_count(&self) -> usize {
        let map = self.leases.read().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        map.values().filter(|&&exp| exp > now).count()
    }

    /// 列出所有当前受保护的 Hash 清单。
    pub fn leased_hashes(&self) -> Vec<String> {
        let map = self.leases.read().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        map.iter()
            .filter(|(_, &exp)| exp > now)
            .map(|(k, _)| k.clone())
            .collect()
    }
}

// ===== LocalDb 持久化租约方法面 =====

impl LocalDb {
    /// 获取持久化活数据保护租约（向 `active_blob_leases` 写入行，默认 30 分钟）。
    /// 经组提交 Writer。
    pub fn acquire_blob_lease(
        &self,
        blob_hash: &str,
        holder: Option<&str>,
        duration: Option<Duration>,
    ) -> Result<ActiveBlobLease, DbFailure> {
        let blob_hash = blob_hash.to_string();
        let holder = holder.map(|s| s.to_string());
        self.write_blocking(move |conn| {
            acquire_blob_lease_conn(conn, &blob_hash, holder.as_deref(), duration).map_err(|e| {
                DbFailure {
                    message: format!("acquire_blob_lease: {e}"),
                    kind: DbFailureKind::Other("acquire_blob_lease".to_string()),
                }
            })
        })
    }

    /// 续期指定租约（延长指定时长或默认 30 分钟）。经组提交 Writer。
    pub fn renew_blob_lease(
        &self,
        lease_id: &str,
        duration: Option<Duration>,
    ) -> Result<bool, DbFailure> {
        let lease_id = lease_id.to_string();
        self.write_blocking(move |conn| {
            renew_blob_lease_conn(conn, &lease_id, duration).map_err(|e| DbFailure {
                message: format!("renew_blob_lease: {e}"),
                kind: DbFailureKind::Other("renew_blob_lease".to_string()),
            })
        })
    }

    /// 释放指定租约 ID。经组提交 Writer。
    pub fn release_blob_lease(&self, lease_id: &str) -> Result<bool, DbFailure> {
        let lease_id = lease_id.to_string();
        self.write_blocking(move |conn| {
            release_blob_lease_conn(conn, &lease_id).map_err(|e| DbFailure {
                message: format!("release_blob_lease: {e}"),
                kind: DbFailureKind::Other("release_blob_lease".to_string()),
            })
        })
    }

    /// 释放某个 Hash 下的所有租约（在附件合入 `block_attachments` 后调用）。经组提交 Writer。
    pub fn release_blob_leases_for_hash(&self, blob_hash: &str) -> Result<usize, DbFailure> {
        let blob_hash = blob_hash.to_string();
        self.write_blocking(move |conn| {
            release_blob_leases_for_hash_conn(conn, &blob_hash).map_err(|e| DbFailure {
                message: format!("release_blob_leases_for_hash: {e}"),
                kind: DbFailureKind::Other("release_blob_leases_for_hash".to_string()),
            })
        })
    }

    /// 检查持久化表中 Hash 是否处于有效租约保护期内。读路径经 [`LocalDb::read`]。
    pub fn is_blob_leased(&self, blob_hash: &str) -> Result<bool, DbFailure> {
        let blob_hash = blob_hash.to_string();
        self.read(move |conn| {
            is_blob_leased_conn(conn, &blob_hash).map_err(|e| DbFailure {
                message: format!("is_blob_leased: {e}"),
                kind: DbFailureKind::Other("is_blob_leased".to_string()),
            })
        })
    }

    /// 清理持久化表中所有已过期的租约记录，返回清理行数。经组提交 Writer。
    pub fn sweep_expired_blob_leases(&self) -> Result<usize, DbFailure> {
        self.write_blocking(move |conn| {
            sweep_expired_blob_leases_conn(conn).map_err(|e| DbFailure {
                message: format!("sweep_expired_blob_leases: {e}"),
                kind: DbFailureKind::Other("sweep_expired_blob_leases".to_string()),
            })
        })
    }

    /// 列出当前所有未过期的活跃持久化租约。读路径经 [`LocalDb::read`]。
    pub fn list_active_blob_leases(&self) -> Result<Vec<ActiveBlobLease>, DbFailure> {
        self.read(|conn| {
            list_active_blob_leases_conn(conn).map_err(|e| DbFailure {
                message: format!("list_active_blob_leases: {e}"),
                kind: DbFailureKind::Other("list_active_blob_leases".to_string()),
            })
        })
    }
}

// ===== 连接级纯函数实现 =====

/// 连接级获取持久化租约。
pub fn acquire_blob_lease_conn(
    conn: &Connection,
    blob_hash: &str,
    holder: Option<&str>,
    duration: Option<Duration>,
) -> Result<ActiveBlobLease, rusqlite::Error> {
    let lease_id = generate_lease_id();
    let holder_str = holder.unwrap_or("");
    let secs = duration
        .map(|d| d.as_secs() as i64)
        .unwrap_or(DEFAULT_LEASE_DURATION_SECS);
    let duration_param = format!("+{secs} seconds");

    conn.execute(
        r#"
        INSERT INTO active_blob_leases (lease_id, blob_hash, holder, expires_at, created_at)
        VALUES (?1, ?2, ?3, datetime('now', ?4), datetime('now'))
        "#,
        params![lease_id, blob_hash, holder_str, duration_param],
    )?;

    let lease = conn.query_row(
        r#"
        SELECT lease_id, blob_hash, holder, expires_at, created_at
        FROM active_blob_leases WHERE lease_id = ?1
        "#,
        params![lease_id],
        |r| {
            Ok(ActiveBlobLease {
                lease_id: r.get(0)?,
                blob_hash: r.get(1)?,
                holder: r.get(2)?,
                expires_at: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )?;

    Ok(lease)
}

/// 连接级续期持久化租约。
pub fn renew_blob_lease_conn(
    conn: &Connection,
    lease_id: &str,
    duration: Option<Duration>,
) -> Result<bool, rusqlite::Error> {
    let secs = duration
        .map(|d| d.as_secs() as i64)
        .unwrap_or(DEFAULT_LEASE_DURATION_SECS);
    let duration_param = format!("+{secs} seconds");

    let changed = conn.execute(
        r#"
        UPDATE active_blob_leases
        SET expires_at = datetime('now', ?1)
        WHERE lease_id = ?2
        "#,
        params![duration_param, lease_id],
    )?;

    Ok(changed > 0)
}

/// 连接级释放指定持久化租约。
pub fn release_blob_lease_conn(conn: &Connection, lease_id: &str) -> Result<bool, rusqlite::Error> {
    let changed = conn.execute(
        "DELETE FROM active_blob_leases WHERE lease_id = ?1",
        params![lease_id],
    )?;
    Ok(changed > 0)
}

/// 连接级释放某 Hash 下的所有持久化租约。
pub fn release_blob_leases_for_hash_conn(
    conn: &Connection,
    blob_hash: &str,
) -> Result<usize, rusqlite::Error> {
    let changed = conn.execute(
        "DELETE FROM active_blob_leases WHERE blob_hash = ?1",
        params![blob_hash],
    )?;
    Ok(changed)
}

/// 连接级检查 Hash 是否处于持久化活跃租约保护中。
pub fn is_blob_leased_conn(conn: &Connection, blob_hash: &str) -> Result<bool, rusqlite::Error> {
    let active: Option<i64> = conn
        .query_row(
            r#"
            SELECT 1 FROM active_blob_leases
            WHERE blob_hash = ?1 AND expires_at > datetime('now')
            LIMIT 1
            "#,
            params![blob_hash],
            |r| r.get(0),
        )
        .optional()?;
    Ok(active.is_some())
}

/// 连接级清理过期持久化租约。
pub fn sweep_expired_blob_leases_conn(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let changed = conn.execute(
        "DELETE FROM active_blob_leases WHERE expires_at <= datetime('now')",
        [],
    )?;
    Ok(changed)
}

/// 连接级列出所有活跃持久化租约。
pub fn list_active_blob_leases_conn(
    conn: &Connection,
) -> Result<Vec<ActiveBlobLease>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"
        SELECT lease_id, blob_hash, holder, expires_at, created_at
        FROM active_blob_leases
        WHERE expires_at > datetime('now')
        ORDER BY expires_at ASC
        "#,
    )?;

    let rows = stmt.query_map([], |r| {
        Ok(ActiveBlobLease {
            lease_id: r.get(0)?,
            blob_hash: r.get(1)?,
            holder: r.get(2)?,
            expires_at: r.get(3)?,
            created_at: r.get(4)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}
