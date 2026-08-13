//! `query_blocks` SQL 读路径（SD-12 分模；**SD-50** 再抽滤器）。
//!
//! 三路：FTS MATCH / CJK `instr` / 纯 SQL（kind·attrs·refs）。
//! 过滤器拼装与命中行解析见 [`filters`]；**不**改查询语义。
//!
//! 由父模 [`crate::query_blocks`] 经 `#[path]` 接入。
//! **诚实**：**≠ EL-03**；**≠** 占 SD-12/16；**≠** A-PERF 数值。

use super::QueryBlocksHit;
use crate::StoreError;
use rusqlite::Connection;
use serde_json::Value as JsonValue;

/// kind / attrs / refs 滤器 + 命中行解析（**SD-50** 再抽）。
#[path = "query_blocks_sql_filters.rs"]
mod filters;

use filters::{
    append_kind_attrs_filters, append_ref_filters, parse_attrs, push_limit, run_hit_query,
    truncate_snippet,
};

/// FTS 候选 + SQL 侧 kind/attrs/refs 过滤（交集）。
#[allow(clippy::too_many_arguments)]
pub(super) fn query_with_fts(
    conn: &Connection,
    doc_id: &str,
    fts_q: &str,
    kinds: Option<&[String]>,
    attrs: &[(&str, &JsonValue)],
    ref_to: Option<&str>,
    ref_from: Option<&str>,
    fetch_n: i64,
) -> Result<Vec<QueryBlocksHit>, StoreError> {
    let mut sql = String::from(
        r#"
        SELECT
            blocks_fts.block_id,
            COALESCE(b.kind, ''),
            snippet(blocks_fts, 0, '', '', '…', 32),
            COALESCE(b.props_json, '{}')
        FROM blocks_fts
        INNER JOIN blocks b
            ON b.doc_id = blocks_fts.doc_id AND b.block_id = blocks_fts.block_id
        WHERE blocks_fts.doc_id = ?1 AND blocks_fts MATCH ?2
        "#,
    );

    let mut bind: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(doc_id.to_string()),
        rusqlite::types::Value::Text(fts_q.to_string()),
    ];
    append_kind_attrs_filters(
        &mut sql, &mut bind, kinds, attrs, /*next_idx=*/ 3, /*col_prefix=*/ "b.",
    )?;
    append_ref_filters(
        &mut sql,
        &mut bind,
        doc_id,
        ref_to,
        ref_from,
        /*block_id_col=*/ "b.block_id",
    );
    sql.push_str(" ORDER BY bm25(blocks_fts)");
    push_limit(&mut sql, &mut bind, fetch_n);

    run_hit_query(conn, &sql, bind)
}

/// CJK 子串路径：`instr(plain_text, token)` AND 各空白分词 + kind/attrs/refs。
///
/// 与 [`crate::WorkspaceStore::search_fulltext`] 同源策略（A-FTS-ZH-01）。
#[allow(clippy::too_many_arguments)]
pub(super) fn query_with_cjk_instr(
    conn: &Connection,
    doc_id: &str,
    query: &str,
    kinds: Option<&[String]>,
    attrs: &[(&str, &JsonValue)],
    ref_to: Option<&str>,
    ref_from: Option<&str>,
    fetch_n: i64,
) -> Result<Vec<QueryBlocksHit>, StoreError> {
    let tokens: Vec<&str> = query.split_whitespace().filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return query_sql_only(conn, doc_id, kinds, attrs, ref_to, ref_from, fetch_n);
    }

    let mut sql = String::from(
        r#"
        SELECT
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
    let next_idx = bind.len() + 1;
    append_kind_attrs_filters(
        &mut sql, &mut bind, kinds, attrs, /*next_idx=*/ next_idx, /*col_prefix=*/ "",
    )?;
    append_ref_filters(
        &mut sql, &mut bind, doc_id, ref_to, ref_from, /*block_id_col=*/ "block_id",
    );
    sql.push_str(" ORDER BY order_key ASC, block_id ASC");
    push_limit(&mut sql, &mut bind, fetch_n);

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        let plain: String = r.get(2)?;
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            truncate_snippet(&plain),
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, snippet, props_json) = row?;
        out.push(QueryBlocksHit {
            id,
            kind,
            snippet,
            attrs: parse_attrs(&props_json),
        });
    }
    Ok(out)
}

/// 无 text_match：仅 blocks 表 + kind/attrs/refs。
pub(super) fn query_sql_only(
    conn: &Connection,
    doc_id: &str,
    kinds: Option<&[String]>,
    attrs: &[(&str, &JsonValue)],
    ref_to: Option<&str>,
    ref_from: Option<&str>,
    fetch_n: i64,
) -> Result<Vec<QueryBlocksHit>, StoreError> {
    let mut sql = String::from(
        r#"
        SELECT
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
    append_kind_attrs_filters(
        &mut sql, &mut bind, kinds, attrs, /*next_idx=*/ 2, /*col_prefix=*/ "",
    )?;
    append_ref_filters(
        &mut sql, &mut bind, doc_id, ref_to, ref_from, /*block_id_col=*/ "block_id",
    );
    // 稳定序：order_key 再 block_id
    sql.push_str(" ORDER BY order_key ASC, block_id ASC");
    push_limit(&mut sql, &mut bind, fetch_n);

    // plain_text 列作 snippet 源
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        let plain: String = r.get(2)?;
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            truncate_snippet(&plain),
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, snippet, props_json) = row?;
        out.push(QueryBlocksHit {
            id,
            kind,
            snippet,
            attrs: parse_attrs(&props_json),
        });
    }
    Ok(out)
}
