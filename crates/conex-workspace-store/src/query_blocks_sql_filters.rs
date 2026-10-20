//! `query_blocks` SQL 滤器拼装与命中行解析（**SD-50** 再抽）。
//!
//! 由父模 `query_blocks_sql`（`query_blocks_sql.rs`）经 `#[path]` 接入。
//! **诚实**：**≠ EL-03**；**≠** 占 SD-12/16；**不**改交集 / CJK→instr / kind·attrs·refs / limit 语义。

use super::super::QueryBlocksHit;
use crate::StoreError;
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};

/// `ref_to` / `ref_from` → EXISTS 半连接（避免多 kind 边导致行膨胀）。
///
/// - `ref_to=T`：命中块是引用 T 的 from_id
/// - `ref_from=F`：命中块是 F 引用的 to_id
pub(super) fn append_ref_filters(
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
///
/// 占位符序号**唯一来源**是 `bind.len() + 1`（与 [`append_ref_filters`] 同口径），
/// 不再由调用方传入起始序号——避免序号与绑定参数数量漂移。
pub(super) fn append_kind_attrs_filters(
    sql: &mut String,
    bind: &mut Vec<rusqlite::types::Value>,
    kinds: Option<&[String]>,
    attrs: &[(&str, &JsonValue)],
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
            let idx = bind.len() + 1;
            sql.push('?');
            sql.push_str(&idx.to_string());
            bind.push(rusqlite::types::Value::Text(k.clone()));
        }
        sql.push(')');
    }

    for (key, val) in attrs {
        // 键已白名单，可拼入 json path；值绑定防注入
        let idx = bind.len() + 1;
        sql.push_str(&format!(
            " AND json_extract({col_prefix}props_json, '$.{key}') = ?{idx}"
        ));
        bind.push(json_to_sql_value(val)?);
    }
    Ok(())
}

pub(super) fn push_limit(sql: &mut String, bind: &mut Vec<rusqlite::types::Value>, fetch_n: i64) {
    let idx = bind.len() + 1;
    sql.push_str(&format!(" LIMIT ?{idx}"));
    bind.push(rusqlite::types::Value::Integer(fetch_n));
}

pub(super) fn run_hit_query(
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
                return Err(StoreError::Persist("query_blocks: 无法绑定数值属性".into()));
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

pub(super) fn parse_attrs(props_json: &str) -> Map<String, JsonValue> {
    match serde_json::from_str::<JsonValue>(props_json) {
        Ok(JsonValue::Object(m)) => m,
        _ => Map::new(),
    }
}

pub(super) fn truncate_snippet(plain: &str) -> String {
    const MAX: usize = 64;
    if plain.chars().count() > MAX {
        let s: String = plain.chars().take(MAX).collect();
        format!("{s}…")
    } else {
        plain.to_string()
    }
}
