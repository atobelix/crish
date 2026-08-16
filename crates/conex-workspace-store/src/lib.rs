//! 工作区笔记库（独立 workspace.db）。W1-C / W1-D1 / W2-C / W2-D / W2-E / Round5：
//! schema + snapshot/updates + blocks 投影 + FTS5 + CAS + MD mirror + **store↔collab 投影管线**。
//!
//! # 模块拆分（SD-02 · 门面减负 / **SD-27** 测旁挂 / **SD-38** export/lag）
//! - [`migrate`]：schema 迁移 / `ensure_*`
//! - [`fts`]：blocks 投影 + FTS5 search/rebuild/CJK / reindex
//! - [`persist_plugin`]：`PersistencePlugin` load/on_committed/flush + compact
//! - [`mirror`]（薄门面）+ `mirror_detect` / `mirror_import` / `mirror_poll` / [`mirror_os_watch`]：
//!   MD mirror detect/三路/轮询/OS watcher（**不回退**；SD-10 内聚）
//! - [`mirror_export`]：`export_md_mirror` / lag / `safe_doc_id`（**SD-38**；方法仍挂 [`WorkspaceStore`]）
//! - 本文件：`WorkspaceStore` 薄门面（open/meta/clock）+ `pub use`
//! - [`tests`]（`lib_tests.rs`）：门面测外置（`#[path]`；无孤儿）
//!
//! **诚实（SD-27 / SD-38）**：**≠ EL-03**；**≠ Wave 2「存储完成」**。
//! 测旁挂 / 实现再抽 ≠ 假关恢复 / ≠ 存储完成。
//!
//! # S1 落盘五条
//! 1. 权威 = SQLite snapshot + updates（+ RS 内存树）
//! 2. Conex-MD mirror = 人/git 视图，非第二写入口
//! 3. 工具默认读 = 即时 S(树) / 编码态导出
//! 4. 外部改 mirror = 检测+三路；禁静默盖 unpushed op
//! 5. mirror 延迟水位可观测
//!
//! # Snapshot 合并策略（W1 简单版，非真实 CRDT encode）
//! - 触发：`CommitBatch.snapshot_tick == true` **或** pending ≥ [`SNAPSHOT_UPDATE_THRESHOLD`]
//! - 步骤：读 snapshot → pending updates（`ORDER BY seq ASC`）→ length-prefix framing 合并
//!   UPSERT `doc_snapshots` → `DELETE FROM doc_updates WHERE doc_id=?`
//! - `load_doc`：snapshot ⊕ 剩余 pending（compact 后 pending 为空）
//! - framing：`[u32_le chunk_len][chunk_bytes]...`；首段旧 snapshot（若无则跳过），随后按 seq 追加
//!
//! # 推荐提交管线（Round5）
//! ```ignore
//! use conex_workspace_store::{SharedWorkspaceStore, commit_ops};
//! use conex_doc_collab::{DocSession, Origin};
//! let store = SharedWorkspaceStore::open("workspace.db")?;
//! let mut session = DocSession::new("doc-1")
//!     .with_persistence(Box::new(store.clone()));
//! let ev = commit_ops(&mut session, &store, Origin::User, &ops)?;
//! ```
//! - **权威落盘**：`DocSession::apply` 内 `PersistencePlugin::on_committed`（[`SharedWorkspaceStore`] 可 clone）
//! - **派生索引**：[`WorkspaceStore::apply_projection_diff`]（以 `ProjectionDiff` 为准；
//!   结构 update 现为 rev 占位字节，**禁止**指望 decode CRDT 重建索引）
//! - 底层仍可测用 [`WorkspaceStore::reindex_block`]；生产路径应走管线
//!
//! # W2-C / W2-D-S / W2-E / W2-F（诚实边界）
//! - W2-C：`blocks` + `blocks_fts`；CJK `instr`（A-FTS-ZH-01）；**≠ A-PERF-10 数值满关**；
//!   测 `tests/structure_gate.rs`、`tests/fts_chinese.rs`。损坏不得导致文档不可开。
//! - W2-D-S：[`WorkspaceStore::put_blob`] / [`WorkspaceStore::get_blob`] / [`WorkspaceStore::link_block_attachment`]；
//!   **≠ 生产 / ≠ GC 满关 / ≠ EL / ≠ A-PERF-11**（Strict **W2-D** 才扩）
//! - W2-E：[`WorkspaceStore::export_md_mirror`] / [`WorkspaceStore::note_authority_advanced`] / [`WorkspaceStore::mirror_lag`] + detect/三路/poll/OS；
//!   **≠ A-INV-02 产品 UI**；**≠ poll=inotify 满关**；工具默认**禁止**读 mirror 当权威
//! - W2-F：[`query_blocks`] + [`refs`] 投影同事务物化；手工 `upsert_ref` 仅测/抢救；
//!   A-QRY-01 **无手工 seed**；**≠** 完整 MD AST wiki 节点解析
//! - 总钉：**≠ EL-03**（结构主责 W3-A / 数值 W6-C）；**≠ Wave 2「存储完成」**
//!
//! # 后续扩展点
//! - **W2-D Strict**：CAS GC / 外置 `blobs/` / A-PERF-11 结构门满关（W2-D-S 仅骨架）
//! - OS watcher **产品**接线（桌面 timer/IPC/三路 UI）

#![allow(missing_docs)]

mod cas;
mod fts;
mod in_flight_guard;
mod migrate;
mod mirror;
mod mirror_detect;
mod mirror_export;
mod mirror_import;
mod mirror_os_watch;
mod mirror_poll;
mod persist_plugin;
mod projection;
mod query_blocks;
mod refs;

pub use cas::{content_hash, get_blob_conn, put_blob_conn};
pub use fts::{BlockHit, ReindexBlockOpts};
pub use in_flight_guard::{
    InFlightEntry, InFlightExportGuard, InFlightPhase, InFlightSuppressVerdict,
};
pub use migrate::migrate;
pub use mirror::{
    poll_mirror_once, ConflictBlockInfo, ImportMirrorOpts, ImportMirrorResult, MirrorDriftClass,
    MirrorDriftReport, MirrorFileFingerprint, MirrorWatchHandle, MirrorWatchPollResult,
    MirrorWatcher, ThreeWayStrategy,
};
pub use mirror_os_watch::{
    detect_if_os_event_hits_mirror, poll_on_os_hint, FakeMirrorOsEventSource, MirrorOsEvent,
    MirrorOsEventKind, MirrorOsEventSource, MirrorOsWatchError, MirrorOsWatcher,
};
pub use persist_plugin::SharedWorkspaceStore;
pub use projection::{
    block_kind_to_store_str, commit_ops, commit_ops_with_mirror, export_mirror_now,
    index_after_apply, maybe_export_mirror, CommitMirrorOpts, CommitPipelineError,
    DEFAULT_MIRROR_EXPORT_LAG_THRESHOLD,
};
pub use query_blocks::{
    query_blocks_conn, QueryBlocksHit, QueryBlocksParams, QueryBlocksResult,
    QUERY_BLOCKS_LIMIT_DEFAULT, QUERY_BLOCKS_LIMIT_MAX,
};
pub use refs::{
    extract_refs_from_plain, materialize_block_refs_conn, refs_from_conn, refs_to_conn,
    remove_refs_from_conn, upsert_ref_conn, BlockRef, ExtractedRef, KIND_BLOCK_REF, KIND_WIKILINK,
};

// 子模块间 pub(crate) 路径保持稳定（projection / query_blocks 等仍 `use crate::…`）
pub(crate) use fts::{
    build_fts_query, contains_cjk, is_safe_attr_key, reindex_block_conn, remove_block_index_conn,
};
pub(crate) use mirror_export::note_authority_advanced_conn;
#[cfg(test)]
pub(crate) use mirror_export::safe_doc_id;

use conex_doc_collab::PersistError;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thiserror::Error;

/// pending updates 达到该条数时自动触发 snapshot 合并（与 snapshot_tick 并列）。
pub const SNAPSHOT_UPDATE_THRESHOLD: usize = 100;

/// 当前 schema 版本号（写入 `schema_version` 表）。
/// - v1/v2：doc_meta / snapshots / updates / clocks
/// - v3：blocks 投影 + blocks_fts（W2-C）
/// - v4：mirror_meta（W2-E MD mirror 导出水位）
/// - v5：block_refs 物化（W2-F+ 块引用 / 反向链接）
/// - v6：blob_cas + block_attachments（**W2-D-S** CAS 附件骨架；≠ 生产 / ≠ GC）
/// - v7：mirror_meta.content_hash + file_mtime_ms（W2-E P6 detect 指纹）
pub const SCHEMA_VERSION: i64 = 7;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("persist: {0}")]
    Persist(String),
    #[error("lock poisoned: {0}")]
    Lock(String),
}

impl From<StoreError> for PersistError {
    fn from(e: StoreError) -> Self {
        PersistError::Io(e.to_string())
    }
}

/// 独立 workspace.db 上的笔记权威存储（不与 sessions 混库）。
///
/// 方法分布（SD-02 / SD-38）：
/// - 本文件：open / meta / clock / flush
/// - [`mirror_export`]：MD mirror 导出 / lag / `safe_doc_id`
/// - [`fts`]：reindex / search / rebuild
/// - [`persist_plugin`]：`PersistencePlugin` + [`SharedWorkspaceStore`]
/// - [`mirror`]：detect / import 提案 / poll watcher（SD-10：`mirror_detect` / `mirror_import` / `mirror_poll`）
/// - [`cas`] / [`query_blocks`] / [`refs`] / [`projection`]：各域扩展
pub struct WorkspaceStore {
    path: PathBuf,
    /// 子模块 `impl WorkspaceStore` 写路径共用（crate 内可见）。
    pub(crate) conn: Mutex<Connection>,
    /// 导出落盘在途守卫（代际令牌 + 1000ms 自然 TTL + 瞬态假删除压制）
    pub export_guard: Arc<InFlightExportGuard>,
}

impl WorkspaceStore {
    /// 打开（或创建）workspace.db 并 migrate。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(&path)?;
        migrate(&conn)?;
        Ok(Self {
            path,
            conn: Mutex::new(conn),
            export_guard: Arc::new(InFlightExportGuard::new()),
        })
    }

    /// 获取关联的导出在途守卫
    pub fn export_guard(&self) -> &Arc<InFlightExportGuard> {
        &self.export_guard
    }

    /// 注入自定义在途守卫实例
    pub fn with_export_guard(mut self, guard: Arc<InFlightExportGuard>) -> Self {
        self.export_guard = guard;
        self
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 当前库 schema_version。
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let v: i64 = conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |r| {
            r.get(0)
        })?;
        Ok(v)
    }

    /// 该 doc 的 pending updates 条数。
    pub fn load_pending_count(&self, doc_id: &str) -> Result<usize, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM doc_updates WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// 该 doc 的 rev（无记录则 0）。
    pub fn load_rev(&self, doc_id: &str) -> Result<i64, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let rev: Option<i64> = conn
            .query_row(
                "SELECT rev FROM doc_meta WHERE doc_id=?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(rev.unwrap_or(0))
    }

    /// 强制将该 doc 的 pending updates 合并进 snapshot 并裁剪 updates。
    pub fn flush_doc(&self, doc_id: &str) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        persist_plugin::compact_snapshot(&tx, doc_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 读/写 peer clock（W1 表就绪；CRDT 接线后由上层填充）。
    pub fn upsert_clock(&self, doc_id: &str, peer_id: &str, clock: i64) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            r#"
            INSERT INTO doc_clocks(doc_id, peer_id, clock) VALUES (?1, ?2, ?3)
            ON CONFLICT(doc_id, peer_id) DO UPDATE SET clock = excluded.clock
            "#,
            params![doc_id, peer_id, clock],
        )?;
        Ok(())
    }

    pub fn load_clock(&self, doc_id: &str, peer_id: &str) -> Result<Option<i64>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let c: Option<i64> = conn
            .query_row(
                "SELECT clock FROM doc_clocks WHERE doc_id=?1 AND peer_id=?2",
                params![doc_id, peer_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(c)
    }
}

// ── 测试（SD-27 外置） ─────────────────────────────────────────────────────

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
