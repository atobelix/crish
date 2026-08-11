//! 工作区笔记库（独立 workspace.db）。W1-C / W1-D1 / W2-C / W2-E：
//! schema + snapshot/updates + blocks 投影 + FTS5 + MD mirror 导出与延迟水位。
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
//! # W2-C 派生索引（可丢、可重建；损坏不得导致文档不可开）
//! - `blocks` 投影表：块元数据 + `plain_text` + `props_json`
//! - `blocks_fts`：FTS5 全文（unicode61；**中文召回基准后置 / 可换 tantivy**）
//! - 本波次：测用直接 `reindex_block`；**不**接 DocSession 事件总线
//!
//! # W2-E MD mirror（人/git 契约视图，非权威）
//! - [`WorkspaceStore::export_md_mirror`]：`serialize_tree` → 原子写 `.md` + 更新 `mirror_meta`
//! - [`WorkspaceStore::note_authority_advanced`] / [`WorkspaceStore::mirror_lag`]：延迟水位骨架
//! - **不变量**：工具默认 **禁止** 读 mirror 当权威；本 API 仅人/git 契约视图。
//!   工具默认读 = 即时 S(树) / 编码态导出（S1 第 3 条）。
//!
//! # 后续扩展点
//! - CAS `blobs/` 附件引用与 GC
//! - refs 物化 + 受限 query（W2-F / M5；组合查询见 [`query_blocks`]）
//! - 外部改 mirror watcher + 三路合并（P6）
//!
//! # W2-F
//! `WorkspaceStore::query_blocks` — FTS ∩ kind ∩ attrs 交集查询（agent-tools 接线见 W4）。

#![allow(missing_docs)]

mod query_blocks;

pub use query_blocks::{
    QUERY_BLOCKS_LIMIT_DEFAULT, QUERY_BLOCKS_LIMIT_MAX, QueryBlocksHit, QueryBlocksParams,
    QueryBlocksResult, query_blocks_conn,
};

use conex_doc_collab::{
    BlockTree, CommitBatch, EncodedUpdate, HydrateBlob, PersistError, PersistencePlugin,
};
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
pub const SCHEMA_VERSION: i64 = 4;

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

/// 最小可用 schema 迁移（幂等；CREATE IF NOT EXISTS + 版本抬升）。
///
/// 已建：doc_meta / doc_snapshots / doc_updates / doc_clocks / **blocks** / **blocks_fts** / **mirror_meta**。
/// 后续扩展点（本函数暂不建）：
/// - CAS：`blob_refs` + 工作区 `blobs/` 目录
/// - refs 物化表（W2-F 后续；`query_blocks` 的 ref_to/ref_from 暂忽略）
pub fn migrate(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

        -- 版本登记（可空实现：仅一行 version）
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS doc_meta (
            doc_id TEXT PRIMARY KEY,
            rev INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS doc_snapshots (
            doc_id TEXT PRIMARY KEY,
            blob BLOB,
            updated_at INTEGER NOT NULL
        );

        -- seq 单调、UNIQUE(doc_id,seq) 保证有序加载 pending
        CREATE TABLE IF NOT EXISTS doc_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            doc_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            blob BLOB NOT NULL,
            kind TEXT NOT NULL DEFAULT 'combined',
            tx_id TEXT,
            UNIQUE(doc_id, seq)
        );

        -- CRDT peer clock（可空实现：表在、行可无）
        CREATE TABLE IF NOT EXISTS doc_clocks (
            doc_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            clock INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (doc_id, peer_id)
        );

        -- W2-C：块投影（派生，可丢；权威仍为 snapshot+updates）
        -- 复合主键：同 workspace 内 block_id 可跨 doc 碰撞
        CREATE TABLE IF NOT EXISTS blocks (
            doc_id TEXT NOT NULL,
            block_id TEXT NOT NULL,
            parent_id TEXT,
            kind TEXT NOT NULL DEFAULT '',
            order_key TEXT NOT NULL DEFAULT '',
            plain_text TEXT NOT NULL DEFAULT '',
            props_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            PRIMARY KEY (doc_id, block_id)
        );

        -- W2-E：MD mirror 元数据（人/git 契约视图水位；**非**权威）
        -- path：最近一次导出的绝对/相对路径；pending_lag：权威 rev − last_export_rev
        CREATE TABLE IF NOT EXISTS mirror_meta (
            doc_id TEXT PRIMARY KEY,
            path TEXT NOT NULL DEFAULT '',
            last_export_rev INTEGER NOT NULL DEFAULT 0,
            last_export_at INTEGER NOT NULL DEFAULT 0,
            pending_lag INTEGER NOT NULL DEFAULT 0
        );

        -- W2 后续（勿在此 CREATE）：
        --   CREATE TABLE blob_refs (...);
        --   CREATE TABLE refs (...);
        "#,
    )?;

    // 兼容 W1 早期表（无 kind 列）：幂等加列
    ensure_column(conn, "doc_updates", "kind", "TEXT NOT NULL DEFAULT 'combined'")?;
    // 兼容早期 doc_meta 无 updated_at
    ensure_column(
        conn,
        "doc_meta",
        "updated_at",
        "INTEGER NOT NULL DEFAULT 0",
    )?;

    // 有序加载 / 投影辅助索引
    conn.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_doc_updates_doc_seq
            ON doc_updates(doc_id, seq);
        CREATE INDEX IF NOT EXISTS idx_doc_clocks_doc
            ON doc_clocks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_doc
            ON blocks(doc_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_doc_parent
            ON blocks(doc_id, parent_id);
        "#,
    )?;

    // FTS5 全文虚表（bundled SQLite 已 SQLITE_ENABLE_FTS5）。
    // tokenize=unicode61：英文/数字可用；**中文召回基准后置 / 可换 tantivy**。
    // 与 blocks 手动同步（非 content= 外部表）：reindex/remove 维护；损坏走 rebuild_fts。
    ensure_blocks_fts(conn)?;

    // 登记 / 抬升 schema_version
    let current: Option<i64> = conn
        .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
        .optional()?;
    match current {
        None => {
            conn.execute(
                "INSERT INTO schema_version(version) VALUES (?1)",
                params![SCHEMA_VERSION],
            )?;
        }
        Some(v) if v < SCHEMA_VERSION => {
            conn.execute("UPDATE schema_version SET version = ?1", params![SCHEMA_VERSION])?;
        }
        Some(_) => {}
    }

    Ok(())
}

/// 幂等创建 `blocks_fts`（FTS5 虚表；已存在则跳过）。
fn ensure_blocks_fts(conn: &Connection) -> Result<(), StoreError> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='blocks_fts' LIMIT 1",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        return Ok(());
    }
    // plain_text 可检索；block_id / doc_id 仅存值（UNINDEXED）便于过滤与回表
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE blocks_fts USING fts5(
            plain_text,
            block_id UNINDEXED,
            doc_id UNINDEXED,
            tokenize = 'unicode61'
        );
        "#,
    )?;
    Ok(())
}

/// 若表上不存在某列则 ADD COLUMN（SQLite 无 IF NOT EXISTS 语法时的兼容路径）。
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), StoreError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !names.iter().any(|n| n == column) {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

/// 全文 / 属性查询命中（对齐 query_blocks 工具出参骨架）。
#[derive(Debug, Clone, PartialEq)]
pub struct BlockHit {
    pub doc_id: String,
    pub block_id: String,
    pub kind: String,
    /// 命中摘要（FTS snippet 或 plain_text 截断）。
    pub snippet: String,
    /// bm25 排名（越小越相关；属性查询时为 0）。
    pub rank: f64,
    /// 原始 props_json 字符串（可能为 `{}`）。
    pub props_json: String,
}

/// `reindex_block` 可选字段（缺省写空串 / None）。
#[derive(Debug, Clone, Default)]
pub struct ReindexBlockOpts {
    pub parent_id: Option<String>,
    pub kind: String,
    pub order_key: String,
    /// JSON 对象字符串；非法时仍原样入库（过滤侧按字符串处理）。
    pub props_json: String,
}

/// 独立 workspace.db 上的笔记权威存储（不与 sessions 混库）。
pub struct WorkspaceStore {
    path: PathBuf,
    conn: Mutex<Connection>,
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
        compact_snapshot(&tx, doc_id)?;
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

    // ── W2-C：blocks 投影 + FTS5 ──────────────────────────────────────────

    /// 写入/更新单块投影并同步 FTS（幂等 UPSERT）。
    ///
    /// 本波次由测试/上层直接调用；**不**挂 DocSession 事件总线（下波接线）。
    pub fn reindex_block(
        &self,
        doc_id: &str,
        block_id: &str,
        plain_text: &str,
        opts: ReindexBlockOpts,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        reindex_block_conn(&tx, doc_id, block_id, plain_text, &opts)?;
        tx.commit()?;
        Ok(())
    }

    /// 从投影与 FTS 中移除单块索引（文档权威不受影响）。
    pub fn remove_block_index(&self, doc_id: &str, block_id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        remove_block_index_conn(&tx, doc_id, block_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 文档内 FTS 全文检索。
    ///
    /// `query` 为空时返回空 vec。特殊字符会做短语转义，避免 MATCH 语法错误。
    pub fn search_fulltext(
        &self,
        doc_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<BlockHit>, StoreError> {
        let fts_q = build_fts_query(query);
        if fts_q.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.max(1).min(500) as i64;
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        // MATCH 与 snippet/bm25 均直接用表名（FTS5 对别名支持因版本而异）
        let mut stmt = conn.prepare(
            r#"
            SELECT
                blocks_fts.doc_id,
                blocks_fts.block_id,
                COALESCE(b.kind, ''),
                snippet(blocks_fts, 0, '', '', '…', 32),
                bm25(blocks_fts),
                COALESCE(b.props_json, '{}')
            FROM blocks_fts
            LEFT JOIN blocks b
                ON b.doc_id = blocks_fts.doc_id AND b.block_id = blocks_fts.block_id
            WHERE blocks_fts.doc_id = ?1 AND blocks_fts MATCH ?2
            ORDER BY bm25(blocks_fts)
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![doc_id, fts_q, limit], |r| {
            Ok(BlockHit {
                doc_id: r.get(0)?,
                block_id: r.get(1)?,
                kind: r.get(2)?,
                snippet: r.get(3)?,
                rank: r.get(4)?,
                props_json: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 从 `blocks` 表重建 FTS（整库或单 doc）。
    ///
    /// 索引损坏可重建铁律：删/坏 FTS 后调用本方法即可恢复搜索；
    /// **文档 snapshot/updates 权威不受影响，文档仍可开**。
    ///
    /// - `doc_id = None`：重建全部 FTS
    /// - `doc_id = Some(id)`：仅重建该文档的 FTS 行
    pub fn rebuild_fts(&self, doc_id: Option<&str>) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        rebuild_fts_conn(&tx, doc_id)?;
        tx.commit()?;
        Ok(())
    }

    /// M5 方向 stub：按 `props_json` 顶层键等值过滤（无 attrs 时返回空）。
    ///
    /// 使用 `json_extract`；键名仅允许 `[A-Za-z0-9_]`，防止路径注入。
    /// 完整受限 query（kind_in / ref_to 等）见 W2-F。
    pub fn query_blocks_by_attr(
        &self,
        doc_id: &str,
        attrs_eq: &[(&str, &str)],
        limit: usize,
    ) -> Result<Vec<BlockHit>, StoreError> {
        if attrs_eq.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.max(1).min(500) as i64;
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;

        // 动态 AND json_extract 条件（键已白名单，可安全拼入 json path）
        let mut sql = String::from(
            "SELECT doc_id, block_id, kind, plain_text, props_json FROM blocks WHERE doc_id = ?1",
        );
        let mut bind_vals: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(doc_id.to_string())];
        for (i, (key, val)) in attrs_eq.iter().enumerate() {
            if !is_safe_attr_key(key) {
                return Err(StoreError::Persist(format!(
                    "query_blocks_by_attr: 非法属性键 `{key}`（仅允许字母数字下划线）"
                )));
            }
            sql.push_str(&format!(
                " AND json_extract(props_json, '$.{key}') = ?{}",
                i + 2
            ));
            bind_vals.push(rusqlite::types::Value::Text((*val).to_string()));
        }
        sql.push_str(&format!(" LIMIT ?{}", attrs_eq.len() + 2));
        bind_vals.push(rusqlite::types::Value::Integer(limit));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(bind_vals), |r| {
            let plain: String = r.get(3)?;
            let snippet = if plain.chars().count() > 64 {
                let s: String = plain.chars().take(64).collect();
                format!("{s}…")
            } else {
                plain
            };
            Ok(BlockHit {
                doc_id: r.get(0)?,
                block_id: r.get(1)?,
                kind: r.get(2)?,
                snippet,
                rank: 0.0,
                props_json: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// 该 doc 已投影的块数量（测试 / 诊断）。
    pub fn count_blocks(&self, doc_id: &str) -> Result<usize, StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM blocks WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    // ── W2-E：MD mirror 导出 + 延迟水位 ───────────────────────────────────
    //
    // **不变量（S1）**：
    // - Conex-MD mirror = 人/git 契约视图，**非**第二写入口、**非**权威。
    // - 工具默认 **禁止** 读 mirror 文件当权威；工具默认读 = 即时 S(树) / 编码态导出。
    // - 本 API 仅服务人/git 可 diff 契约；延迟水位 [`mirror_lag`] 可观测。

    /// 将 `tree` 序列化为 Conex-MD 并原子写入 `mirror_root/{safe_doc_id}.md`。
    ///
    /// - 内容来自 [`serialize_tree`]（含 `<!--c:UUID-->` 块 ID 注释）
    /// - 原子写：tmp + rename（Windows 上若目标已存在先 remove）
    /// - 更新 `mirror_meta`：`last_export_rev = rev`、`pending_lag = 0`
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

        let path_str = final_path.to_string_lossy().to_string();
        let rev_i = rev as i64;
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
        conn.execute(
            r#"
            INSERT INTO mirror_meta(doc_id, path, last_export_rev, last_export_at, pending_lag)
            VALUES (?1, ?2, ?3, strftime('%s','now'), 0)
            ON CONFLICT(doc_id) DO UPDATE SET
                path = excluded.path,
                last_export_rev = excluded.last_export_rev,
                last_export_at = excluded.last_export_at,
                pending_lag = 0
            "#,
            params![doc_id, path_str, rev_i],
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
fn safe_doc_id(doc_id: &str) -> String {
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

/// 属性键白名单：仅字母数字下划线（`query_blocks` 子模块复用）。
pub(crate) fn is_safe_attr_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// 将用户查询转为 FTS5 MATCH 表达式（空格分词 AND；词加引号防语法注入）。
pub(crate) fn build_fts_query(query: &str) -> String {
    let q = query.trim();
    if q.is_empty() {
        return String::new();
    }
    q.split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| {
            // 短语转义：双引号翻倍
            let escaped = t.replace('\"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 事务内：UPSERT blocks + 同步 FTS。
fn reindex_block_conn(
    conn: &Connection,
    doc_id: &str,
    block_id: &str,
    plain_text: &str,
    opts: &ReindexBlockOpts,
) -> Result<(), StoreError> {
    let props = if opts.props_json.is_empty() {
        "{}"
    } else {
        opts.props_json.as_str()
    };
    let parent = opts.parent_id.as_deref();

    conn.execute(
        r#"
        INSERT INTO blocks(doc_id, block_id, parent_id, kind, order_key, plain_text, props_json, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s','now'))
        ON CONFLICT(doc_id, block_id) DO UPDATE SET
            parent_id = excluded.parent_id,
            kind = excluded.kind,
            order_key = excluded.order_key,
            plain_text = excluded.plain_text,
            props_json = excluded.props_json,
            updated_at = excluded.updated_at
        "#,
        params![
            doc_id,
            block_id,
            parent,
            opts.kind,
            opts.order_key,
            plain_text,
            props
        ],
    )?;

    // FTS：先删旧行再插（按 doc_id+block_id 定位）
    fts_delete_block(conn, doc_id, block_id)?;
    conn.execute(
        "INSERT INTO blocks_fts(plain_text, block_id, doc_id) VALUES (?1, ?2, ?3)",
        params![plain_text, block_id, doc_id],
    )?;
    Ok(())
}

/// 事务内：删 blocks 行 + FTS 行。
fn remove_block_index_conn(
    conn: &Connection,
    doc_id: &str,
    block_id: &str,
) -> Result<(), StoreError> {
    fts_delete_block(conn, doc_id, block_id)?;
    conn.execute(
        "DELETE FROM blocks WHERE doc_id=?1 AND block_id=?2",
        params![doc_id, block_id],
    )?;
    Ok(())
}

/// 删除 FTS 中匹配 doc_id+block_id 的全部行。
///
/// FTS5 无普通 WHERE DELETE；先查 rowid 再用 delete 命令删除。
fn fts_delete_block(conn: &Connection, doc_id: &str, block_id: &str) -> Result<(), StoreError> {
    // FTS5 支持按 UNINDEXED 列 WHERE DELETE
    conn.execute(
        "DELETE FROM blocks_fts WHERE doc_id = ?1 AND block_id = ?2",
        params![doc_id, block_id],
    )?;
    Ok(())
}

/// 从 blocks 表重建 FTS（损坏可重建）。
fn rebuild_fts_conn(conn: &Connection, doc_id: Option<&str>) -> Result<(), StoreError> {
    match doc_id {
        None => {
            // 整表清空 FTS 后全量回填
            conn.execute("DELETE FROM blocks_fts", [])?;
            conn.execute(
                r#"
                INSERT INTO blocks_fts(plain_text, block_id, doc_id)
                SELECT plain_text, block_id, doc_id FROM blocks
                "#,
                [],
            )?;
        }
        Some(did) => {
            // 仅该 doc：先删 FTS 中该 doc 行，再从 blocks 回填
            conn.execute("DELETE FROM blocks_fts WHERE doc_id = ?1", params![did])?;
            conn.execute(
                r#"
                INSERT INTO blocks_fts(plain_text, block_id, doc_id)
                SELECT plain_text, block_id, doc_id FROM blocks WHERE doc_id = ?1
                "#,
                params![did],
            )?;
        }
    }
    Ok(())
}

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

/// 将 pending updates 合并进 snapshot 并删除 updates 行。
fn compact_snapshot(conn: &Connection, doc_id: &str) -> Result<(), StoreError> {
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> (tempfile_dir::Dir, PathBuf) {
        let dir = tempfile_dir::Dir::new();
        let db = dir.path().join("workspace.db");
        (dir, db)
    }

    /// 极简 tempfile 目录，避免额外依赖。
    mod tempfile_dir {
        use super::*;
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
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
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
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

    // ── W2-C：blocks 投影 + FTS5 ──────────────────────────────────────────

    #[test]
    fn reindex_two_blocks_search_hits() {
        let (_dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

        store
            .reindex_block(
                "doc-s",
                "b1",
                "hello world alpha",
                ReindexBlockOpts {
                    kind: "paragraph".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .reindex_block(
                "doc-s",
                "b2",
                "beta gamma hello",
                ReindexBlockOpts {
                    kind: "heading".into(),
                    props_json: r#"{"status":"todo"}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        // 另一文档：不应串 doc
        store
            .reindex_block(
                "doc-other",
                "b9",
                "hello only in other doc",
                ReindexBlockOpts::default(),
            )
            .unwrap();

        assert_eq!(store.count_blocks("doc-s").unwrap(), 2);

        let hits = store.search_fulltext("doc-s", "hello", 50).unwrap();
        assert_eq!(hits.len(), 2, "两条均含 hello 应命中");
        let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
        assert!(ids.contains(&"b1"));
        assert!(ids.contains(&"b2"));

        // 仅 b1 含 alpha
        let hits_a = store.search_fulltext("doc-s", "alpha", 10).unwrap();
        assert_eq!(hits_a.len(), 1);
        assert_eq!(hits_a[0].block_id, "b1");
        assert_eq!(hits_a[0].kind, "paragraph");

        // 空查询
        assert!(store.search_fulltext("doc-s", "   ", 10).unwrap().is_empty());
    }

    #[test]
    fn remove_block_index_no_longer_hits() {
        let (_dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();

        store
            .reindex_block(
                "doc-r",
                "keep",
                "unique_keep_token",
                ReindexBlockOpts::default(),
            )
            .unwrap();
        store
            .reindex_block(
                "doc-r",
                "drop",
                "unique_drop_token",
                ReindexBlockOpts::default(),
            )
            .unwrap();

        assert_eq!(
            store
                .search_fulltext("doc-r", "unique_drop_token", 10)
                .unwrap()
                .len(),
            1
        );

        store.remove_block_index("doc-r", "drop").unwrap();

        assert!(
            store
                .search_fulltext("doc-r", "unique_drop_token", 10)
                .unwrap()
                .is_empty(),
            "remove 后不应再命中"
        );
        // 另一块仍可搜
        assert_eq!(
            store
                .search_fulltext("doc-r", "unique_keep_token", 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(store.count_blocks("doc-r").unwrap(), 1);
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

        // v4 mirror_meta 表存在
        {
            let conn = Connection::open(&db).unwrap();
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='mirror_meta'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1);
        }
    }

    // ── W2-E：MD mirror 导出 + 延迟水位 ───────────────────────────────────

    fn sample_tree() -> BlockTree {
        use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps};
        use std::collections::HashMap;
        use std::str::FromStr;

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

    #[test]
    fn rebuild_fts_from_blocks_after_clear() {
        let (_dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();

        store
            .reindex_block(
                "doc-f",
                "x1",
                "rebuildable_token_one",
                ReindexBlockOpts::default(),
            )
            .unwrap();
        store
            .reindex_block(
                "doc-f",
                "x2",
                "rebuildable_token_two",
                ReindexBlockOpts::default(),
            )
            .unwrap();
        assert_eq!(
            store
                .search_fulltext("doc-f", "rebuildable_token_one", 10)
                .unwrap()
                .len(),
            1
        );

        // 模拟 FTS 损坏/清空（blocks 投影仍在；另开连接避免碰私有字段）
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute("DELETE FROM blocks_fts", []).unwrap();
        }
        assert!(
            store
                .search_fulltext("doc-f", "rebuildable_token_one", 10)
                .unwrap()
                .is_empty()
        );

        // 从 blocks 重建
        store.rebuild_fts(Some("doc-f")).unwrap();
        let hits = store
            .search_fulltext("doc-f", "rebuildable_token_one", 10)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "x1");

        // 整库 rebuild 也可用
        store.rebuild_fts(None).unwrap();
        assert_eq!(
            store
                .search_fulltext("doc-f", "rebuildable_token_two", 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn reindex_upsert_updates_fts() {
        let (_dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        store
            .reindex_block("d", "b", "old_token_xyz", ReindexBlockOpts::default())
            .unwrap();
        store
            .reindex_block("d", "b", "new_token_uvw", ReindexBlockOpts::default())
            .unwrap();
        assert!(
            store
                .search_fulltext("d", "old_token_xyz", 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .search_fulltext("d", "new_token_uvw", 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(store.count_blocks("d").unwrap(), 1);
    }

    #[test]
    fn query_blocks_by_attr_simple() {
        let (_dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        store
            .reindex_block(
                "doc-a",
                "t1",
                "task one",
                ReindexBlockOpts {
                    kind: "todo".into(),
                    props_json: r#"{"status":"todo","prio":"1"}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .reindex_block(
                "doc-a",
                "t2",
                "task two",
                ReindexBlockOpts {
                    kind: "todo".into(),
                    props_json: r#"{"status":"done"}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();

        // 空 attrs → 空
        assert!(store
            .query_blocks_by_attr("doc-a", &[], 50)
            .unwrap()
            .is_empty());

        let hits = store
            .query_blocks_by_attr("doc-a", &[("status", "todo")], 50)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "t1");

        // 非法键
        assert!(store
            .query_blocks_by_attr("doc-a", &[("status;drop", "x")], 10)
            .is_err());
    }
}
