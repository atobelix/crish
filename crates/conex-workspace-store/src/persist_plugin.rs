//! `PersistencePlugin`：load / on_committed / flush + snapshot compact。
//!
//! SD-02：自 `lib.rs` 门面拆出权威落盘路径。
//!
//! # 模块内聚（**SD-21** · 黄带体积切开）
//! - **本文件**：`PersistencePlugin for WorkspaceStore` / `SharedWorkspaceStore` / compact
//! - [`tests`]（`persist_plugin_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::persist_plugin::*` / `lib` `pub use`）
//!
//! **诚实**：**≠ EL-04**（本包只切 persist 体积，不关 EL）；**≠ EL-03**（恢复/打开产品叙事分属 W3 等）。
//! 不静默改 snapshot / updates 语义；**≠** 切 refs / os_watch。
//!
//! # CT-01 CAS（乐观锁 · 版本期望比对）
//! - `on_committed_expect`：`expect_rev = Some(期望)` 时，UPSERT 的 UPDATE 分支带
//!   `WHERE doc_meta.rev = ?期望` 条件——受影响行数 = 0（行存在但 rev ≠ 期望）→
//!   [`PersistError::Conflict`]（tx 未 commit 随 drop 回滚，rev/updates 零副作用）。
//!   INSERT 分支恒 1 行（行不存在 = 无争用史，无条件放行）；`None` 走原 SQL 原样（旧 LWW）。
//! - **CAS = 检测并报错，不自动合并**；与 [`crate::cas`]（blob 内容 SHA-256 去重）
//!   是两回事——去重管存储空间，CAS 管版本争用。

use crate::{StoreError, WorkspaceStore, SNAPSHOT_UPDATE_THRESHOLD};
use conex_doc_collab::{CommitBatch, EncodedUpdate, HydrateBlob, PersistError, PersistencePlugin};
use rusqlite::{params, Connection, OptionalExtension};
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
            .prepare("SELECT blob, kind FROM doc_updates WHERE doc_id=?1 ORDER BY seq ASC")
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
        // CT-01：旧 LWW 面收敛为无条件版本（None）委托，行为与现状逐字节一致
        self.on_committed_expect(doc_id, commit, None)
    }

    fn on_committed_expect(
        &self,
        doc_id: &str,
        commit: &CommitBatch,
        expect_rev: Option<u64>,
    ) -> Result<(), PersistError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| PersistError::Io(e.to_string()))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| PersistError::Io(e.to_string()))?;

        let tx_s = format!("{:?}", commit.tx_id);

        // 抬升 rev；确保 meta 行存在。CT-01：Some(expect) → UPDATE 分支带
        // WHERE doc_meta.rev = ?2（期望版本比对）；受影响行数 = 0 → 陈旧写冲突。
        // INSERT 分支恒 1 行（行不存在 = 无争用史，无条件放行，首写 rev=1 语义不变）。
        let affected = match expect_rev {
            Some(expect) => tx.execute(
                r#"
                INSERT INTO doc_meta(doc_id, rev, updated_at)
                VALUES (?1, 1, (strftime('%s','now') * 1000))
                ON CONFLICT(doc_id) DO UPDATE SET
                    rev = rev + 1,
                    updated_at = (strftime('%s','now') * 1000)
                WHERE doc_meta.rev = ?2
                "#,
                params![doc_id, expect as i64],
            ),
            None => tx.execute(
                r#"
                INSERT INTO doc_meta(doc_id, rev, updated_at)
                VALUES (?1, 1, (strftime('%s','now') * 1000))
                ON CONFLICT(doc_id) DO UPDATE SET
                    rev = rev + 1,
                    updated_at = (strftime('%s','now') * 1000)
                "#,
                params![doc_id],
            ),
        }
        .map_err(|e| PersistError::Io(e.to_string()))?;

        if affected == 0 {
            // 陈旧写：行存在但 rev ≠ 期望。tx 未 commit 随 drop 自动回滚——
            // doc_meta.rev 保持原值、doc_updates 零追加（D-06 D2/D6）。
            return Err(PersistError::Conflict {
                expect: expect_rev.unwrap_or(0),
            });
        }

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
        // checkpoint 失败不视为致命（磁盘满等由上层感知），但不得静默：留痕后继续
        if let Err(e) = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);") {
            eprintln!("[conex-workspace-store] WAL checkpoint(PASSIVE) 失败（不阻塞写）：{e}");
        }
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

    /// CT-01：**必须**覆写转发（生产会话挂的是 SharedWorkspaceStore）。
    /// 若不覆写，trait 默认方法会经 `on_committed` 静默回退纯 LWW——CAS 在生产路径失效。
    fn on_committed_expect(
        &self,
        doc_id: &str,
        commit: &CommitBatch,
        expect_rev: Option<u64>,
    ) -> Result<(), PersistError> {
        self.0.on_committed_expect(doc_id, commit, expect_rev)
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

    let mut stmt = conn.prepare("SELECT blob FROM doc_updates WHERE doc_id=?1 ORDER BY seq ASC")?;
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

    conn.execute("DELETE FROM doc_updates WHERE doc_id=?1", params![doc_id])?;

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
#[path = "persist_plugin_tests.rs"]
mod tests;
