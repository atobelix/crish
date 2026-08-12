//! `query_blocks` SQL 读路径（SD-12 分模）。
//!
//! 三路：FTS MATCH / CJK `instr` / 纯 SQL（kind·attrs·refs）。
//! 过滤器拼装与命中行解析；**不**改查询语义。
//!
//! 由父模 [`crate::query_blocks`] 经 `#[path]` 接入；**≠ EL-03**。

use super::QueryBlocksHit;
use crate::StoreError;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

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
        &mut sql,
        &mut bind,
        kinds,
        attrs,
        /*next_idx=*/ 3,
        /*col_prefix=*/ "b.",
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
    let tokens: Vec<&str> = query
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .collect();
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
        &mut sql,
        &mut bind,
        kinds,
        attrs,
        /*next_idx=*/ next_idx,
        /*col_prefix=*/ "",
    )?;
    append_ref_filters(
        &mut sql,
        &mut bind,
        doc_id,
        ref_to,
        ref_from,
        /*block_id_col=*/ "block_id",
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
        &mut sql,
        &mut bind,
        kinds,
        attrs,
        /*next_idx=*/ 2,
        /*col_prefix=*/ "",
    )?;
    append_ref_filters(
        &mut sql,
        &mut bind,
        doc_id,
        ref_to,
        ref_from,
        /*block_id_col=*/ "block_id",
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

/// `ref_to` / `ref_from` → EXISTS 半连接（避免多 kind 边导致行膨胀）。
///
/// - `ref_to=T`：命中块是引用 T 的 from_id
/// - `ref_from=F`：命中块是 F 引用的 to_id
fn append_ref_filters(
    sql: &mut String,
    bind: &mut Vec<rusqlite::types::Value>,
    doc_id: &str,
    ref_to: Option<&str>,
    ref_from: Option<&str>,
    block_id_col: &str,
) {
    if let Some(to) = ref_to {
        let idx_doc = bind.len() + 1;
        let idx_to = bind.len() + 2;
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM block_refs r \
             WHERE r.doc_id = ?{idx_doc} AND r.to_id = ?{idx_to} \
             AND r.from_id = {block_id_col})"
        ));
        bind.push(rusqlite::types::Value::Text(doc_id.to_string()));
        bind.push(rusqlite::types::Value::Text(to.to_string()));
    }
    if let Some(from) = ref_from {
        let idx_doc = bind.len() + 1;
        let idx_from = bind.len() + 2;
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM block_refs r \
             WHERE r.doc_id = ?{idx_doc} AND r.from_id = ?{idx_from} \
             AND r.to_id = {block_id_col})"
        ));
        bind.push(rusqlite::types::Value::Text(doc_id.to_string()));
        bind.push(rusqlite::types::Value::Text(from.to_string()));
    }
}

/// `col_prefix`：FTS JOIN 时用 `"b."` 限定 `blocks` 别名；纯 SQL 路径用 `""`。
fn append_kind_attrs_filters(
    sql: &mut String,
    bind: &mut Vec<rusqlite::types::Value>,
    kinds: Option<&[String]>,
    attrs: &[(&str, &JsonValue)],
    mut next_idx: usize,
    col_prefix: &str,
) -> Result<(), StoreError> {
    if let Some(ks) = kinds {
        // kind IN (?a, ?b, ...)
        sql.push_str(" AND ");
        sql.push_str(col_prefix);
        sql.push_str("kind IN (");
        for (i, k) in ks.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push('?');
            sql.push_str(&next_idx.to_string());
            bind.push(rusqlite::types::Value::Text(k.clone()));
            next_idx += 1;
        }
        sql.push(')');
    }

    for (key, val) in attrs {
        // 键已白名单，可拼入 json path；值绑定防注入
        sql.push_str(&format!(
            " AND json_extract({col_prefix}props_json, '$.{key}') = ?{next_idx}"
        ));
        bind.push(json_to_sql_value(val)?);
        next_idx += 1;
    }
    let _ = next_idx;
    Ok(())
}

fn push_limit(sql: &mut String, bind: &mut Vec<rusqlite::types::Value>, fetch_n: i64) {
    let idx = bind.len() + 1;
    sql.push_str(&format!(" LIMIT ?{idx}"));
    bind.push(rusqlite::types::Value::Integer(fetch_n));
}

fn run_hit_query(
    conn: &Connection,
    sql: &str,
    bind: Vec<rusqlite::types::Value>,
) -> Result<Vec<QueryBlocksHit>, StoreError> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(bind), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
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

/// JSON 属性值 → SQLite 绑定（对齐 json_extract 比较语义）。
fn json_to_sql_value(v: &JsonValue) -> Result<rusqlite::types::Value, StoreError> {
    use rusqlite::types::Value;
    Ok(match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(u) = n.as_u64() {
                if u <= i64::MAX as u64 {
                    Value::Integer(u as i64)
                } else {
                    Value::Real(u as f64)
                }
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                return Err(StoreError::Persist(
                    "query_blocks: 无法绑定数值属性".into(),
                ));
            }
        }
        JsonValue::String(s) => Value::Text(s.clone()),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            return Err(StoreError::Persist(
                "query_blocks: attrs_eq 值仅支持 string/number/boolean/null".into(),
            ));
        }
    })
}

fn parse_attrs(props_json: &str) -> Map<String, JsonValue> {
    match serde_json::from_str::<JsonValue>(props_json) {
        Ok(JsonValue::Object(m)) => m,
        _ => Map::new(),
    }
}

fn truncate_snippet(plain: &str) -> String {
    const MAX: usize = 64;
    if plain.chars().count() > MAX {
        let s: String = plain.chars().take(MAX).collect();
        format!("{s}…")
    } else {
        plain.to_string()
    }
}
