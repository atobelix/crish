//! W2-C：blocks 投影 + FTS5 全文（unicode61 英文；CJK 走 `instr` 子串回退）。
//!
//! SD-02：自 `lib.rs` 门面拆出 search/rebuild/CJK/reindex。
//! **诚实**：**≠ A-PERF-10 数值满关**；**≠ EL-03**。

use crate::{StoreError, WorkspaceStore};
use rusqlite::{Connection, OptionalExtension, params};

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
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;

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
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
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

    /// 该 doc 在 `blocks_fts` 中的行数（W2-C 投影↔FTS 一致性诊断）。
    ///
    /// 正常路径下应与 [`Self::count_blocks`] 相等；不等 → 索引损坏或半写，走 [`Self::rebuild_fts`]。
    pub fn count_fts_blocks(&self, doc_id: &str) -> Result<usize, StoreError> {
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
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
        let conn = self.conn.lock().map_err(|e| StoreError::Lock(e.to_string()))?;
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

/// 是否含 CJK 脚本字符（统一汉字 / 兼容汉字 / 假名 / 韩文音节）。
///
/// unicode61 将这些字归为 Letter，**无空格连续汉字整段成一个 FTS token**，
/// 子串 `"工作区"` MATCH 无法命中整段 token → 产品路径改走 `instr` 回退。
pub(crate) fn contains_cjk(s: &str) -> bool {
    s.chars().any(is_cjk_char)
}

fn is_cjk_char(c: char) -> bool {
    matches!(
        c,
        '\u{3400}'..='\u{4DBF}' // CJK Ext A
            | '\u{4E00}'..='\u{9FFF}' // CJK Unified
            | '\u{F900}'..='\u{FAFF}' // CJK Compatibility Ideographs
            | '\u{3040}'..='\u{309F}' // Hiragana
            | '\u{30A0}'..='\u{30FF}' // Katakana
            | '\u{AC00}'..='\u{D7AF}' // Hangul Syllables
    )
}

/// 含 CJK 时的子串检索：对每个空白分词要求 `instr(plain_text, token) > 0`（AND）。
///
/// 使用 `instr` 而非 `LIKE %q%`，避免 `%`/`_` 转义问题；不依赖 FTS tokenizer。
fn search_fulltext_cjk_instr(
    conn: &Connection,
    doc_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<BlockHit>, StoreError> {
    let tokens: Vec<&str> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    let mut sql = String::from(
        r#"
        SELECT
            doc_id,
            block_id,
            kind,
            plain_text,
            props_json
        FROM blocks
        WHERE doc_id = ?1
        "#,
    );
    let mut bind: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(doc_id.to_string())];
    for t in &tokens {
        let idx = bind.len() + 1;
        sql.push_str(&format!(" AND instr(plain_text, ?{idx}) > 0"));
        bind.push(rusqlite::types::Value::Text((*t).to_string()));
    }
    // 稳定序；rank 固定 0（非 bm25）
    sql.push_str(" ORDER BY order_key ASC, block_id ASC");
    let lim_idx = bind.len() + 1;
    sql.push_str(&format!(" LIMIT ?{lim_idx}"));
    bind.push(rusqlite::types::Value::Integer(limit));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        let plain: String = r.get(3)?;
        Ok(BlockHit {
            doc_id: r.get(0)?,
            block_id: r.get(1)?,
            kind: r.get(2)?,
            snippet: truncate_plain_snippet(&plain),
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

/// plain_text 截断作 snippet（CJK 路径 / 无 FTS snippet 时）。
fn truncate_plain_snippet(plain: &str) -> String {
    const MAX: usize = 64;
    if plain.chars().count() > MAX {
        let s: String = plain.chars().take(MAX).collect();
        format!("{s}…")
    } else {
        plain.to_string()
    }
}

/// 事务内：UPSERT blocks + 同步 FTS。
pub(crate) fn reindex_block_conn(
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
pub(crate) fn remove_block_index_conn(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SCHEMA_VERSION;
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
                "conex-ws-fts-{}-{}-{}",
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
