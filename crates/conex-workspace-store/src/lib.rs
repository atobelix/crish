//! 工作区笔记库（独立 workspace.db）。W1-C / W1-D1 / W2-C / W2-D / W2-E / Round5：
//! schema + snapshot/updates + blocks 投影 + FTS5 + CAS + MD mirror + **store↔collab 投影管线**。
//!
//! # 模块拆分（SD-02 · 门面减负）
//! - [`migrate`]：schema 迁移 / `ensure_*`
//! - [`fts`]：blocks 投影 + FTS5 search/rebuild/CJK / reindex
//! - [`persist_plugin`]：`PersistencePlugin` load/on_committed/flush + compact
//! - [`mirror`] / [`mirror_os_watch`]：MD mirror 导出水位之上的 detect/三路/watcher（**不回退**）
//! - 本文件：`WorkspaceStore` 薄门面（open/meta/clock/export 地基）+ `pub use`
//!
//! # S1 落盘五条
//! 1. 权威 = SQLite snapshot + updates（+ RS 内存树）
//! 2. Conex-MD mirror = 人/git 视图，非第二写入口
//! 3. 工具默认读 = 即时 S(树) / 编码态导出
//! 4. 外部改 mirror = 检测+三路；禁静默盖 unpushed op
//! 5. mirror 延迟水位可观测
//!
//! # Snapshot 合并策略（W1 简单版，非真实 CRDT encode）
//! - 触发：`CommitBatch.snapshot_tick == true` **或** 该 doc 的 pending 条数 ≥ [`SNAPSHOT_UPDATE_THRESHOLD`]
//! - 步骤：
//!   1. 读现有 snapshot（可空）
//!   2. 读全部 pending updates（`ORDER BY seq ASC`）
//!   3. 用 length-prefix framing 合并为新 snapshot blob 并 UPSERT `doc_snapshots`
//!   4. `DELETE FROM doc_updates WHERE doc_id=?`（裁剪已并入的 updates）
//! - `load_doc`：返回 snapshot ⊕ 剩余 pending（compact 后 pending 为空）
//! - framing：`[u32_le chunk_len][chunk_bytes]...`；首段为旧 snapshot（若无则跳过），随后按 seq 追加每条 update.bytes
//!
//! # 推荐提交管线（Round5 · store↔collab 投影索引自动接线）
//! ```ignore
//! use conex_workspace_store::{SharedWorkspaceStore, commit_ops};
//! use conex_doc_collab::{DocSession, Origin};
//!
//! let store = SharedWorkspaceStore::open("workspace.db")?;
//! let mut session = DocSession::new("doc-1")
//!     .with_persistence(Box::new(store.clone())); // on_committed 写权威
//! let ev = commit_ops(&mut session, &store, Origin::User, &ops)?;
//! // 等价分步：session.apply → store.apply_projection_diff / index_after_apply
//! ```
//! - **权威落盘**：`DocSession::apply` 内 `PersistencePlugin::on_committed`（[`SharedWorkspaceStore`] 可 clone 共享）
//! - **派生索引**：[`WorkspaceStore::apply_projection_diff`]（以 `ProjectionDiff` 为准；
//!   结构 update 现为 rev 占位字节，**禁止**指望 decode CRDT 重建索引）
//! - 底层仍可测用 [`WorkspaceStore::reindex_block`]；生产路径应走管线
//!
//! # W2-C 派生索引（可丢、可重建；损坏不得导致文档不可开）
//! - `blocks` 投影表：块元数据 + `plain_text` + `props_json`
//! - `blocks_fts`：FTS5 全文（unicode61 英文；**CJK 走 `instr` 子串回退**，见 `search_fulltext` / A-FTS-ZH-01）
//! - **结构门**（A-PERF-10 / A-INV-06 索引侧）：英文走 FTS5 MATCH 计划；CJK 走 `instr`（非默认全表 `LIKE`）；
//!   投影与 FTS 行一致可测；`rebuild_fts` 可重建。测：`tests/w2c_structure_gate.rs`、`tests/fts_chinese.rs`。
//! - **诚实边界**：**≠ A-PERF-10 数值满关**（数值仅 W6-C）；**≠ EL-03**（EL-03 结构主责 W3-A / 数值 W6-C）；
//!   **≠ Wave 2「存储完成」**（杀进程权威恢复分属他包；mirror detect/三路见 W2-E 节，≠ 产品 watcher 满关）。
//!
//! # W2-D-S CAS 附件骨架（Skeleton）
//! - [`WorkspaceStore::put_blob`] / [`WorkspaceStore::get_blob`] / [`WorkspaceStore::link_block_attachment`]
//! - 表 `blob_cas` + `block_attachments`；**附件不是第二文档权威**；默认 **不**进 snapshot 热路径
//! - **诚实（-S）**：**≠ 生产就绪**；**≠ GC 满关**（无未引用回收 / 无产品 unlink）；
//!   **≠ EL** / **≠ A-PERF-11 数值**；Strict **W2-D** 才扩 GC+外置+结构门满关
//!
//! # W2-E MD mirror（人/git 契约视图，非权威）
//! ## W2-E-S 地基（已有）
//! - [`WorkspaceStore::export_md_mirror`]：`serialize_tree` → 原子写 `.md` + 更新 `mirror_meta`
//! - [`WorkspaceStore::note_authority_advanced`] / [`WorkspaceStore::mirror_lag`]：延迟水位
//! - 管线可选：[`commit_ops_with_mirror`] 在 lag ≥ threshold 时自动 export
//!
//! ## W2-E Strict 子集（P6 detect/三路 + watcher 方向）
//! - [`WorkspaceStore::detect_mirror_drift`]：hash/mtime vs `mirror_meta` → 三路分类
//! - [`WorkspaceStore::import_mirror_proposal`]：Op 批 **或** 冲突报告；禁静默盖 unpushed（X-05）
//! - [`ThreeWayStrategy`]：`RetainLocalAndReimport` | `DropUnacked` | `ConflictBlocks`
//! - **watcher 轮询子集**（进程内/可轮询；**≠** 用 poll 冒充 inotify 满关）：
//!   - [`MirrorWatchHandle`] / [`poll_mirror_once`]：指纹基线 + 单次 poll → 可观测分类
//!   - [`MirrorWatcher`] / [`MirrorWatcher::on_mirror_change`]：回调注册（上层 timer 驱动）
//! - **OS 事件 watcher 封装**（`notify`；见 [`mirror_os_watch`]）：
//!   - [`MirrorOsWatcher`] / [`MirrorOsEventSource`]：内核 FS 事件 → 通道
//!   - [`detect_if_os_event_hits_mirror`] / [`poll_on_os_hint`]：事件 hint → detect/poll（**不** apply）
//! - **诚实**：**≠ A-INV-02 产品 UI 满关**（无三路对话框）；**≠**「poll = inotify 满关」；
//!   OS 封装 **≠** 桌面产品订阅/IPC 全链路；**≠ EL-03**；**≠ Wave 2 存储完成**。
//!   详见 [`mirror`] / [`mirror_os_watch`] 模块头注释。
//!
//! - **不变量**：工具默认 **禁止** 读 mirror 当权威；本 API 仅人/git 契约视图。
//!
//! # 后续扩展点
//! - **W2-D Strict**：CAS GC / 外置 `blobs/` 大文件 path / A-PERF-11 结构门满关（W2-D-S 仅骨架）
//! - OS watcher **产品**接线（桌面 timer/IPC/三路 UI；本 crate 已交 notify 封装 + poll 入口）
//!
//! # W2-F Strict（refs 自动物化 + 受限 query）
//! - `WorkspaceStore::query_blocks` — FTS ∩ kind ∩ attrs ∩ refs 交集查询（agent-tools 接线见 W4）
//! - [`refs`]：`block_refs` 表 + **投影同事务**从 plain_text 抽 `((id))`/`[[page]]` 自动物化
//!   （`apply_projection_diff` → [`materialize_block_refs_conn`]）；手工 `upsert_ref` 仅测/抢救
//! - 验收方向：A-QRY-01 **无手工 seed**（`a_qry_01_query_blocks_ref_without_manual_seed`）
//! - **诚实**：**≠ Wave 2 存储完成**；**≠ EL-03**；**≠** 完整 MD AST wiki 节点解析

#![allow(missing_docs)]

mod cas;
mod fts;
mod migrate;
mod mirror;
mod mirror_os_watch;
mod persist_plugin;
mod projection;
mod query_blocks;
mod refs;

pub use cas::{content_hash, get_blob_conn, put_blob_conn};
pub use fts::{BlockHit, ReindexBlockOpts};
pub use migrate::migrate;
pub use mirror::{
    poll_mirror_once, ConflictBlockInfo, ImportMirrorOpts, ImportMirrorResult,
    MirrorDriftClass, MirrorDriftReport, MirrorFileFingerprint, MirrorWatchHandle,
    MirrorWatchPollResult, MirrorWatcher, ThreeWayStrategy,
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
    QUERY_BLOCKS_LIMIT_DEFAULT, QUERY_BLOCKS_LIMIT_MAX, QueryBlocksHit, QueryBlocksParams,
    QueryBlocksResult, query_blocks_conn,
};
pub use refs::{
    extract_refs_from_plain, materialize_block_refs_conn, refs_from_conn, refs_to_conn,
    remove_refs_from_conn, upsert_ref_conn, BlockRef, ExtractedRef, KIND_BLOCK_REF, KIND_WIKILINK,
};

// 子模块间 pub(crate) 路径保持稳定（projection / query_blocks 等仍 `use crate::…`）
pub(crate) use fts::{
    build_fts_query, contains_cjk, is_safe_attr_key, reindex_block_conn, remove_block_index_conn,
};

use conex_doc_collab::{BlockTree, PersistError};
use conex_md_ast::serialize_tree;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
/// 方法分布（SD-02）：
/// - 本文件：open / meta / clock / flush / MD mirror 导出地基
/// - [`fts`]：reindex / search / rebuild
/// - [`persist_plugin`]：`PersistencePlugin` + [`SharedWorkspaceStore`]
/// - [`mirror`]：detect / import 提案 / poll watcher
/// - [`cas`] / [`query_blocks`] / [`refs`] / [`projection`]：各域扩展
pub struct WorkspaceStore {
    path: PathBuf,
    /// 子模块 `impl WorkspaceStore` 写路径共用（crate 内可见）。
    pub(crate) conn: Mutex<Connection>,
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
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 当前库 schema_version。
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let v: i64 = conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |r| {
            r.get(0)
        })?;
        Ok(v)
    }

    /// 该 doc 的 pending updates 条数。
    pub fn load_pending_count(&self, doc_id: &str) -> Result<usize, StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM doc_updates WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// 该 doc 的 rev（无记录则 0）。
    pub fn load_rev(&self, doc_id: &str) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
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
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        persist_plugin::compact_snapshot(&tx, doc_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 读/写 peer clock（W1 表就绪；CRDT 接线后由上层填充）。
    pub fn upsert_clock(&self, doc_id: &str, peer_id: &str, clock: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
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
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let c: Option<i64> = conn
            .query_row(
                "SELECT clock FROM doc_clocks WHERE doc_id=?1 AND peer_id=?2",
                params![doc_id, peer_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(c)
    }

    // ── W2-E：MD mirror 导出 + 延迟水位 ───────────────────────────────────
    //
    // **不变量（S1）**：
    // - Conex-MD mirror = 人/git 契约视图，**非**第二写入口、**非**权威。
    // - 工具默认 **禁止** 读 mirror 文件当权威；工具默认读 = 即时 S(树) / 编码态导出。
    // - 本 API 仅服务人/git 可 diff 契约；延迟水位 [`mirror_lag`] 可观测。
    // - **无**「读 mirror 当权威」API（detect/import 仅提案；见 [`mirror`]）。

    /// 将 `tree` 序列化为 Conex-MD 并原子写入 `mirror_root/{safe_doc_id}.md`。
    ///
    /// - 内容来自 [`serialize_tree`]（含 `<!--c:UUID-->` 块 ID 注释）
    /// - 原子写：tmp + rename（Windows 上若目标已存在先 remove）
    /// - 更新 `mirror_meta`：`last_export_rev = rev`、`pending_lag = 0`、
    ///   `content_hash`（SHA-256）+ `file_mtime_ms`（供 [`Self::detect_mirror_drift`]）
    ///
    /// **勿**将写出路径作为工具默认读源（见模块不变量）。
    pub fn export_md_mirror(
        &self,
        doc_id: &str,
        tree: &BlockTree,
        rev: u64,
        mirror_root: &Path,
    ) -> Result<PathBuf, StoreError> {
        std::fs::create_dir_all(mirror_root)?;

        let safe = safe_doc_id(doc_id);
        let final_path = mirror_root.join(format!("{safe}.md"));
        let md = serialize_tree(tree);
        let hash = content_hash(md.as_bytes());

        // 原子写：先写临时文件再 rename 到目标
        let tmp_name = format!(
            "{safe}.md.tmp.{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let tmp_path = mirror_root.join(tmp_name);
        std::fs::write(&tmp_path, md.as_bytes())?;
        // Windows：目标存在时 rename 会失败，先删再换
        if final_path.exists() {
            let _ = std::fs::remove_file(&final_path);
        }
        std::fs::rename(&tmp_path, &final_path)?;

        let mtime = mirror::file_mtime_ms(&final_path);
        let path_str = final_path.to_string_lossy().to_string();
        let rev_i = rev as i64;
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            r#"
            INSERT INTO mirror_meta(
                doc_id, path, last_export_rev, last_export_at, pending_lag,
                content_hash, file_mtime_ms
            )
            VALUES (?1, ?2, ?3, strftime('%s','now'), 0, ?4, ?5)
            ON CONFLICT(doc_id) DO UPDATE SET
                path = excluded.path,
                last_export_rev = excluded.last_export_rev,
                last_export_at = excluded.last_export_at,
                pending_lag = 0,
                content_hash = excluded.content_hash,
                file_mtime_ms = excluded.file_mtime_ms
            "#,
            params![doc_id, path_str, rev_i, hash, mtime],
        )?;

        Ok(final_path)
    }

    /// 权威 rev 前进时更新 mirror 延迟水位。
    ///
    /// `pending_lag = |new_rev - last_export_rev|`（以 i64 差的绝对值）。
    /// 若该 doc 尚无 `mirror_meta` 行（从未 export），则插入骨架行：
    /// `last_export_rev=0`、`path=''`、`pending_lag = new_rev`。
    pub fn note_authority_advanced(&self, doc_id: &str, new_rev: u64) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        note_authority_advanced_conn(&conn, doc_id, new_rev)
    }

    /// 可观测 mirror 延迟水位（`pending_lag`）。
    ///
    /// 无 `mirror_meta` 行时返回 `None`（尚未有 export / advance 记录）。
    pub fn mirror_lag(&self, doc_id: &str) -> Result<Option<i64>, StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let lag: Option<i64> = conn
            .query_row(
                "SELECT pending_lag FROM mirror_meta WHERE doc_id=?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(lag)
    }
}

/// 将 doc_id 转为可作为文件名的安全片段（路径分隔符等替换为 `_`）。
pub(crate) fn safe_doc_id(doc_id: &str) -> String {
    let s: String = doc_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "_empty".into()
    } else {
        s
    }
}

/// 事务内：权威 rev 前进 → 更新 `mirror_meta.pending_lag`（投影管线同事务调用）。
pub(crate) fn note_authority_advanced_conn(
    conn: &Connection,
    doc_id: &str,
    new_rev: u64,
) -> Result<(), StoreError> {
    let new_rev_i = new_rev as i64;
    let existing: Option<i64> = conn
        .query_row(
            "SELECT last_export_rev FROM mirror_meta WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(last) => {
            let lag = (new_rev_i - last).abs();
            conn.execute(
                "UPDATE mirror_meta SET pending_lag = ?1 WHERE doc_id = ?2",
                params![lag, doc_id],
            )?;
        }
        None => {
            conn.execute(
                r#"
                INSERT INTO mirror_meta(doc_id, path, last_export_rev, last_export_at, pending_lag)
                VALUES (?1, '', 0, 0, ?2)
                "#,
                params![doc_id, new_rev_i],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree};
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> (TempDir, PathBuf) {
        let dir = TempDir::new();
        let db = dir.path().join("workspace.db");
        (dir, db)
    }

    /// 极简 tempfile 目录，避免额外依赖。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!(
                "conex-ws-{}-{}-{}",
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
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn open_migrate_schema_version() {
        let (_dir, db) = temp_db();
        // 路径必须是独立 workspace.db，绝不碰 sessions
        assert!(db.ends_with("workspace.db"));
        let store = WorkspaceStore::open(&db).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        // 二次 open 幂等
        let store2 = WorkspaceStore::open(&db).unwrap();
        assert_eq!(store2.schema_version().unwrap(), SCHEMA_VERSION);
        // 表存在：doc_clocks 可写
        store.upsert_clock("d1", "peer-a", 3).unwrap();
        assert_eq!(store.load_clock("d1", "peer-a").unwrap(), Some(3));
    }

    #[test]
    fn separate_from_sessions_path() {
        // 验收：用 tempfile 路径，文件名 workspace.db，不触碰 sessions.db
        let (_dir, db) = temp_db();
        assert!(
            !db.to_string_lossy().contains("sessions"),
            "不得使用 sessions 库路径"
        );
        let store = WorkspaceStore::open(&db).unwrap();
        assert_eq!(store.path(), db.as_path());
    }

    fn sample_tree() -> BlockTree {
        let id = BlockId::from_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let mut nodes = HashMap::new();
        nodes.insert(
            id,
            BlockNode {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some("mirror hello".into()),
                children: vec![],
            },
        );
        BlockTree {
            root_children: vec![id],
            nodes,
        }
    }

    #[test]
    fn export_md_mirror_writes_conex_comments_and_lag_cycle() {
        let (dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        let mirror_root = dir.path().join("mirrors");
        let tree = sample_tree();

        // 尚未 export / advance → lag 不可观测
        assert_eq!(store.mirror_lag("doc-m").unwrap(), None);

        // 导出 rev=1：文件含 <!--c:，pending_lag=0
        let out = store
            .export_md_mirror("doc-m", &tree, 1, &mirror_root)
            .unwrap();
        assert!(out.ends_with("doc-m.md"));
        assert!(out.exists());
        let content = std::fs::read_to_string(&out).unwrap();
        assert!(
            content.contains("<!--c:"),
            "Conex-MD 必须含块 ID 注释，got:\n{content}"
        );
        assert!(content.contains("mirror hello"));
        assert_eq!(store.mirror_lag("doc-m").unwrap(), Some(0));

        // 权威前进 → lag > 0
        store.note_authority_advanced("doc-m", 5).unwrap();
        let lag = store.mirror_lag("doc-m").unwrap().unwrap();
        assert!(lag > 0, "advance 后 lag 应 > 0，got {lag}");
        assert_eq!(lag, 4); // |5 - 1|

        // 再 export 到最新 rev → lag 清零
        let out2 = store
            .export_md_mirror("doc-m", &tree, 5, &mirror_root)
            .unwrap();
        assert_eq!(out2, out);
        assert_eq!(store.mirror_lag("doc-m").unwrap(), Some(0));

        // 原子写可覆盖：二次内容仍可读
        let content2 = std::fs::read_to_string(&out2).unwrap();
        assert!(content2.contains("<!--c:"));
    }

    #[test]
    fn safe_doc_id_sanitizes_path_chars() {
        assert_eq!(safe_doc_id("a/b\\c:d"), "a_b_c_d");
        assert_eq!(safe_doc_id("plain-id_1"), "plain-id_1");
    }
}
