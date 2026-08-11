//! W2-F：`query_blocks` 组合查询（store 侧）。
//!
//! 对齐：
//! - `docs/block-workspace-architecture/plans/specs/query-blocks-tool-schema.md`
//! - `packages/block-paper-contract/src/query-blocks.ts`
//!
//! # 语义
//! - 过滤条件取**交集**（AND）：`text_match` → 非 CJK 走 FTS；含 CJK 走 `instr` 子串
//!   （A-FTS-ZH-01）；`kind_in` / `attrs_eq` / `ref_to` / `ref_from` → SQL 过滤
//!   （refs 走 `block_refs` EXISTS 半连接）。
//! - **禁止**任意 SQL 字符串入参；属性键仅 `[A-Za-z0-9_]`。
//! - `limit` 默认 50、硬上限 200；`truncated` 表示是否还有更多命中。
//!
//! # W4 接线
//! agent-tools 侧执行器接线留待 W4-A；本模块仅提供 store 查询实现。

use super::{
    StoreError, WorkspaceStore, build_fts_query, contains_cjk, is_safe_attr_key,
};
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};
use std::collections::BTreeMap;

/// limit 默认值（与 TS `QUERY_BLOCKS_LIMIT_DEFAULT` 对齐）。
pub const QUERY_BLOCKS_LIMIT_DEFAULT: usize = 50;
/// limit 硬上限（与 TS `QUERY_BLOCKS_LIMIT_MAX` 对齐）。
pub const QUERY_BLOCKS_LIMIT_MAX: usize = 200;

/// `query_blocks` 入参（工具 JSON 线格式字段名 snake_case）。
#[derive(Debug, Clone, Default)]
pub struct QueryBlocksParams {
    /// 目标文档（必填）。
    pub doc_id: String,
    /// 块 kind / flavour 白名单；`None` 或空 = 不按 kind 过滤。
    pub kind_in: Option<Vec<String>>,
    /// 属性等值组合（白名单键）；多键 AND。
    /// 值为 JSON 可序列化子集（string / number / bool / null）。
    pub attrs_eq: Option<BTreeMap<String, JsonValue>>,
    /// FTS 子串 / 短语。
    pub text_match: Option<String>,
    /// 引用目标 block_id：返回**引用了**该块的块（`block_refs.from_id`）。
    pub ref_to: Option<String>,
    /// 引用源 block_id：返回该块**引用的**块（`block_refs.to_id`）。
    pub ref_from: Option<String>,
    /// 结果上限；`None` → 50；实现强制 cap 200。
    pub limit: Option<usize>,
}

/// 单条命中块摘要（禁止默认回传全文）。
#[derive(Debug, Clone, PartialEq)]
pub struct QueryBlocksHit {
    pub id: String,
    pub kind: String,
    /// 检索摘要片段，非权威全文。
    pub snippet: String,
    /// 索引侧属性子集（解析自 props_json；非法 JSON 则为空对象）。
    pub attrs: Map<String, JsonValue>,
}

/// `query_blocks` 出参：`{ blocks, truncated }`。
#[derive(Debug, Clone, PartialEq)]
pub struct QueryBlocksResult {
    pub blocks: Vec<QueryBlocksHit>,
    /// 是否因 limit 截断。
    pub truncated: bool,
}

impl WorkspaceStore {
    /// 组合查询块投影（FTS ∩ kind ∩ attrs ∩ refs）。
    ///
    /// 无任何有效过滤（且无 text_match / ref_*）时，在 `doc_id` 索引下返回有序前缀
    ///（`LIMIT` 有界，走 `idx_blocks_doc`，非默认全表扫）。
    ///
    /// - `ref_to`：命中块 = 引用了该 id 的 `from_id`（入边反查）
    /// - `ref_from`：命中块 = 该 id 引用的 `to_id`（出边）
    /// - 空串与 `None` 均视为不过滤；与其它条件 **AND**。
    pub fn query_blocks(
        &self,
        params: &QueryBlocksParams,
    ) -> Result<QueryBlocksResult, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        query_blocks_conn(&conn, params)
    }
}

/// 连接级实现（可测；无锁）。
pub fn query_blocks_conn(
    conn: &Connection,
    params: &QueryBlocksParams,
) -> Result<QueryBlocksResult, StoreError> {
    let doc_id = params.doc_id.as_str();
    if doc_id.is_empty() {
        return Err(StoreError::Persist(
            "query_blocks: doc_id 不能为空".into(),
        ));
    }

    let limit = normalize_limit(params.limit);
    // 多取 1 条用于 truncated 判定
    let fetch_n = (limit + 1) as i64;

    // text_match：trim 后空视为无文本条件；含 CJK → instr 子串（unicode61 known gap）
    let text_raw = params
        .text_match
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // kind_in：Some(空) 与 None 均视为「不过滤 kind」；非空则 IN
    let kinds: Option<&[String]> = params
        .kind_in
        .as_deref()
        .filter(|k| !k.is_empty());

    // 校验 attrs 键并收集
    let attrs: Vec<(&str, &JsonValue)> = match &params.attrs_eq {
        None => Vec::new(),
        Some(m) => {
            let mut out = Vec::with_capacity(m.len());
            for (k, v) in m {
                if !is_safe_attr_key(k) {
                    return Err(StoreError::Persist(format!(
                        "query_blocks: 非法属性键 `{k}`（仅允许字母数字下划线）"
                    )));
                }
                out.push((k.as_str(), v));
            }
            out
        }
    };

    // ref_*：空串视为不过滤
    let ref_to = params
        .ref_to
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let ref_from = params
        .ref_from
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut hits = match text_raw {
        Some(raw) if contains_cjk(raw) => {
            query_with_cjk_instr(conn, doc_id, raw, kinds, &attrs, ref_to, ref_from, fetch_n)?
        }
        Some(raw) => {
            let fq = build_fts_query(raw);
            if fq.is_empty() {
                query_sql_only(conn, doc_id, kinds, &attrs, ref_to, ref_from, fetch_n)?
            } else {
                query_with_fts(conn, doc_id, &fq, kinds, &attrs, ref_to, ref_from, fetch_n)?
            }
        }
        None => query_sql_only(conn, doc_id, kinds, &attrs, ref_to, ref_from, fetch_n)?,
    };

    let truncated = hits.len() > limit;
    if truncated {
        hits.truncate(limit);
    }

    Ok(QueryBlocksResult {
        blocks: hits,
        truncated,
    })
}

fn normalize_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(QUERY_BLOCKS_LIMIT_DEFAULT)
        .clamp(1, QUERY_BLOCKS_LIMIT_MAX)
}

/// FTS 候选 + SQL 侧 kind/attrs/refs 过滤（交集）。
#[allow(clippy::too_many_arguments)]
fn query_with_fts(
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
fn query_with_cjk_instr(
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
fn query_sql_only(
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

// ── 测试 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ReindexBlockOpts, WorkspaceStore};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!(
                "conex-qb-{}-{}-{}",
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
        fn db(&self) -> PathBuf {
            self.0.join("workspace.db")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn seed_diverse(store: &WorkspaceStore) {
        // paragraph + hello
        store
            .reindex_block(
                "doc-q",
                "p1",
                "hello world alpha note",
                ReindexBlockOpts {
                    kind: "paragraph".into(),
                    order_key: "a".into(),
                    props_json: r#"{"status":"open","prio":1}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        // heading + hello
        store
            .reindex_block(
                "doc-q",
                "h1",
                "hello heading beta",
                ReindexBlockOpts {
                    kind: "heading".into(),
                    order_key: "b".into(),
                    props_json: r#"{"status":"open"}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        // todo，无 hello
        store
            .reindex_block(
                "doc-q",
                "t1",
                "task without magic token",
                ReindexBlockOpts {
                    kind: "todo".into(),
                    order_key: "c".into(),
                    props_json: r#"{"status":"done","prio":2}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        // paragraph + hello 但 status=done
        store
            .reindex_block(
                "doc-q",
                "p2",
                "hello closed paragraph",
                ReindexBlockOpts {
                    kind: "paragraph".into(),
                    order_key: "d".into(),
                    props_json: r#"{"status":"done"}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
        // 另一 doc：不得串
        store
            .reindex_block(
                "doc-other",
                "ox",
                "hello only other",
                ReindexBlockOpts {
                    kind: "paragraph".into(),
                    props_json: r#"{"status":"open"}"#.into(),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    #[test]
    fn kind_and_text_intersection() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        seed_diverse(&store);

        // kind=paragraph ∩ text=hello → p1, p2（h1 是 heading）
        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-q".into(),
                kind_in: Some(vec!["paragraph".into()]),
                text_match: Some("hello".into()),
                limit: Some(50),
                ..Default::default()
            })
            .unwrap();

        let ids: Vec<_> = r.blocks.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"p1"), "p1 应命中: {ids:?}");
        assert!(ids.contains(&"p2"), "p2 应命中: {ids:?}");
        assert!(!ids.contains(&"h1"), "heading 不应命中: {ids:?}");
        assert!(!ids.contains(&"t1"), "无 hello 的 todo 不应命中");
        assert!(!ids.contains(&"ox"), "不得串 doc");
        assert!(!r.truncated);
        // 出参字段形状：id/kind/snippet/attrs
        for b in &r.blocks {
            assert!(!b.id.is_empty());
            assert_eq!(b.kind, "paragraph");
            assert!(!b.snippet.is_empty());
        }
        assert_eq!(r.blocks.len(), 2);
    }

    #[test]
    fn kind_text_attrs_triple_and() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        seed_diverse(&store);

        let mut attrs = BTreeMap::new();
        attrs.insert("status".into(), JsonValue::String("open".into()));

        // paragraph ∩ hello ∩ status=open → 仅 p1
        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-q".into(),
                kind_in: Some(vec!["paragraph".into()]),
                text_match: Some("hello".into()),
                attrs_eq: Some(attrs),
                ..Default::default()
            })
            .unwrap();

        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].id, "p1");
        assert_eq!(r.blocks[0].kind, "paragraph");
        assert_eq!(
            r.blocks[0].attrs.get("status"),
            Some(&JsonValue::String("open".into()))
        );
        // 数值属性回传
        assert_eq!(r.blocks[0].attrs.get("prio"), Some(&JsonValue::from(1)));
    }

    #[test]
    fn attrs_only_and_numeric() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        seed_diverse(&store);

        let mut attrs = BTreeMap::new();
        attrs.insert("prio".into(), JsonValue::from(1));

        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-q".into(),
                attrs_eq: Some(attrs),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].id, "p1");
    }

    #[test]
    fn limit_truncated() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        // 写入 5 条可 FTS 命中
        for i in 0..5 {
            store
                .reindex_block(
                    "doc-t",
                    &format!("b{i}"),
                    &format!("shared_token item {i}"),
                    ReindexBlockOpts {
                        kind: "paragraph".into(),
                        order_key: format!("{i:02}"),
                        ..Default::default()
                    },
                )
                .unwrap();
        }

        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-t".into(),
                text_match: Some("shared_token".into()),
                limit: Some(2),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r.blocks.len(), 2);
        assert!(r.truncated, "还有更多命中时应 truncated=true");

        // limit 盖住全部 → 不截断
        let r2 = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-t".into(),
                text_match: Some("shared_token".into()),
                limit: Some(50),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r2.blocks.len(), 5);
        assert!(!r2.truncated);
    }

    #[test]
    fn limit_hard_cap_200() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        // 仅测 normalize：超大 limit 不 panic，且结果 ≤200
        for i in 0..3 {
            store
                .reindex_block(
                    "doc-c",
                    &format!("c{i}"),
                    "cap_token",
                    ReindexBlockOpts::default(),
                )
                .unwrap();
        }
        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-c".into(),
                text_match: Some("cap_token".into()),
                limit: Some(10_000), // 应 clamp 到 200
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r.blocks.len(), 3);
        assert!(!r.truncated);
        assert_eq!(normalize_limit(Some(10_000)), QUERY_BLOCKS_LIMIT_MAX);
        assert_eq!(normalize_limit(None), QUERY_BLOCKS_LIMIT_DEFAULT);
    }

    #[test]
    fn reject_unsafe_attr_key() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        let mut attrs = BTreeMap::new();
        attrs.insert("status;drop".into(), JsonValue::String("x".into()));
        let err = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-q".into(),
                attrs_eq: Some(attrs),
                ..Default::default()
            })
            .unwrap_err();
        assert!(
            err.to_string().contains("非法属性键"),
            "err={err}"
        );
    }

    #[test]
    fn empty_doc_id_errors() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        assert!(store
            .query_blocks(&QueryBlocksParams {
                doc_id: "".into(),
                ..Default::default()
            })
            .is_err());
    }

    #[test]
    fn kind_only_no_text() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        seed_diverse(&store);

        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-q".into(),
                kind_in: Some(vec!["todo".into(), "heading".into()]),
                ..Default::default()
            })
            .unwrap();
        let ids: Vec<_> = r.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"t1"));
        assert!(ids.contains(&"h1"));
    }

    #[test]
    fn text_match_empty_falls_back_to_sql() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        seed_diverse(&store);

        // 空白 text_match 视为无 FTS 条件
        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-q".into(),
                kind_in: Some(vec!["todo".into()]),
                text_match: Some("   ".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0].id, "t1");
    }
}
