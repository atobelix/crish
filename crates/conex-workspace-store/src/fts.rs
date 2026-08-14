//! W2-C：blocks 投影 + FTS5 全文（unicode61 英文；CJK 走 `instr` 子串回退）。
//!
//! # 模块内聚（SD-16 · 黄带体积切开）
//! - **本文件**：公开类型 / `WorkspaceStore` 方法门面（reindex / search / rebuild / attr）
//! - [`search`]（`fts_search.rs`）：`build_fts_query` / `contains_cjk` / CJK `instr` 路径
//! - [`index`]（`fts_index.rs`）：`reindex_block_conn` / remove / `rebuild_fts_conn`
//! - [`tests`]（`fts_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::fts::*` / `lib` `pub use`）
//!
//! SD-02：自 `lib.rs` 门面拆出 search/rebuild/CJK/reindex。
//! **诚实**：**≠ A-PERF-10 数值满关**；**≠ EL-03**（本包仅为结构切开，不静默改查询语义）。

use crate::{StoreError, WorkspaceStore};
use rusqlite::{params, OptionalExtension};

/// 查询辅助：MATCH 表达式 / CJK 检测 / `instr` 路径（SD-16）。
#[path = "fts_search.rs"]
mod search;

/// 索引写路径：reindex / remove / rebuild（SD-16）。
#[path = "fts_index.rs"]
mod index;

// ── 子模 re-export：保持 `crate::fts::{…}` 与 `lib` `pub(crate) use` 路径稳定 ──
pub(crate) use index::{reindex_block_conn, remove_block_index_conn};
pub(crate) use search::{build_fts_query, contains_cjk, is_safe_attr_key};

use index::rebuild_fts_conn;
use search::search_fulltext_cjk_instr;

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

impl WorkspaceStore {
    // ── W2-C：blocks 投影 + FTS5 ──────────────────────────────────────────

    /// 写入/更新单块投影并同步 FTS（幂等 UPSERT）。
    ///
    /// 生产路径请走 [`Self::apply_projection_diff`] / [`crate::commit_ops`]；
    /// 本方法仍供测试、重建与细粒度修补。
    pub fn reindex_block(
        &self,
        doc_id: &str,
        block_id: &str,
        plain_text: &str,
        opts: ReindexBlockOpts,
    ) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        reindex_block_conn(&tx, doc_id, block_id, plain_text, &opts)?;
        tx.commit()?;
        Ok(())
    }

    /// 从投影与 FTS 中移除单块索引（文档权威不受影响）。
    pub fn remove_block_index(&self, doc_id: &str, block_id: &str) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        remove_block_index_conn(&tx, doc_id, block_id)?;
        tx.commit()?;
        Ok(())
    }

    /// 文档内全文检索。
    ///
    /// - **英文 / 非 CJK**：FTS5 `unicode61` + bm25（`build_fts_query` 短语转义）。
    /// - **含 CJK**（汉字/假名/韩文）：`blocks.plain_text` 上 `instr` 子串 AND
    ///   （unicode61 对无空格连续汉字整段成 token，子串 MATCH 为 known gap，见 A-FTS-ZH-01）。
    ///
    /// `query` 为空时返回空 vec。
    pub fn search_fulltext(
        &self,
        doc_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<BlockHit>, StoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.max(1).min(500) as i64;
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;

        if contains_cjk(q) {
            return search_fulltext_cjk_instr(&conn, doc_id, q, limit);
        }

        let fts_q = build_fts_query(q);
        if fts_q.is_empty() {
            return Ok(Vec::new());
        }
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

    /// **仅** FTS5 `MATCH`（unicode61），不做 CJK `instr` 回退。
    ///
    /// 供基准测试与诊断：连续汉字子串在 unicode61 下通常 **0 命中**（known gap）。
    /// 产品路径请用 [`Self::search_fulltext`]。
    pub fn search_fulltext_fts_only(
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        rebuild_fts_conn(&tx, doc_id)?;
        tx.commit()?;
        Ok(())
    }

    /// M5 方向 stub：按 `props_json` 顶层键等值过滤（无 attrs 时返回空）。
    ///
    /// 使用 `json_extract`；键名仅允许 `[A-Za-z0-9_]`，防止路径注入。
    /// 完整受限 query（kind_in / ref_to 等）见 W2-F / [`Self::query_blocks`]。
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
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;

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
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM blocks WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// 该 doc 在 `blocks_fts` 中的行数（W2-C 投影↔FTS 一致性诊断）。
    ///
    /// 正常路径下应与 [`Self::count_blocks`] 相等；不等 → 索引损坏或半写，走 [`Self::rebuild_fts`]。
    pub fn count_fts_blocks(&self, doc_id: &str) -> Result<usize, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM blocks_fts WHERE doc_id=?1",
            params![doc_id],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// 读单块投影 `plain_text`（缺行 → `None`；诊断 / 一致性断言用）。
    pub fn get_block_plain_text(
        &self,
        doc_id: &str,
        block_id: &str,
    ) -> Result<Option<String>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let t: Option<String> = conn
            .query_row(
                "SELECT plain_text FROM blocks WHERE doc_id=?1 AND block_id=?2",
                params![doc_id, block_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(t)
    }
}

#[cfg(test)]
#[path = "fts_tests.rs"]
mod tests;
