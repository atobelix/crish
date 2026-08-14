//! W2-F：`query_blocks` 组合查询（store 侧）。
//!
//! 对齐：
//! - `docs/block-workspace-architecture/plans/specs/query-blocks-tool-schema.md`
//! - `packages/block-paper-contract/src/query-blocks.ts`
//!
//! # 模块内聚（SD-12 · 黄带体积切开；**SD-50** 再抽滤器）
//! - **本文件**：公开类型 / `WorkspaceStore::query_blocks` / [`query_blocks_conn`] 调度门面
//! - [`sql`]（`query_blocks_sql.rs`）：FTS / CJK `instr` / 纯 SQL 三路
//! - 滤器兄弟模：`query_blocks_sql_filters.rs`（挂在 `sql` 下，`#[path]`）
//! - [`tests`]（`query_blocks_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::query_blocks::*` / `lib` `pub use`）
//!
//! # 语义（不变）
//! - 过滤条件取**交集**（AND）：`text_match` → 非 CJK 走 FTS；含 CJK 走 `instr` 子串
//!   （A-FTS-ZH-01）；`kind_in` / `attrs_eq` / `ref_to` / `ref_from` → SQL 过滤
//!   （refs 走 `block_refs` EXISTS 半连接）。
//! - **禁止**任意 SQL 字符串入参；属性键仅 `[A-Za-z0-9_]`。
//! - `limit` 默认 50、硬上限 200；`truncated` 表示是否还有更多命中。
//!
//! # W4 接线
//! agent-tools 侧执行器接线留待 W4-A；本模块仅提供 store 查询实现。
//!
//! # 诚实边界
//! - **≠ EL-03**（恢复/打开叙事属 G-HYD / W3 等，不在本模块）。
//! - **≠ Wave 2 存储完成**；**≠** A-PERF-10 数值满关。
//! - 本包仅为 **结构切开**（体积/职责），**不**静默改查询语义。

use super::{build_fts_query, contains_cjk, is_safe_attr_key, StoreError, WorkspaceStore};
use rusqlite::Connection;
use serde_json::{Map, Value as JsonValue};
use std::collections::BTreeMap;

/// SQL 三路读路径（SD-12；滤器 **SD-50** 再抽）。
#[path = "query_blocks_sql.rs"]
mod sql;

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
        return Err(StoreError::Persist("query_blocks: doc_id 不能为空".into()));
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
    let kinds: Option<&[String]> = params.kind_in.as_deref().filter(|k| !k.is_empty());

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
            sql::query_with_cjk_instr(conn, doc_id, raw, kinds, &attrs, ref_to, ref_from, fetch_n)?
        }
        Some(raw) => {
            let fq = build_fts_query(raw);
            if fq.is_empty() {
                sql::query_sql_only(conn, doc_id, kinds, &attrs, ref_to, ref_from, fetch_n)?
            } else {
                sql::query_with_fts(conn, doc_id, &fq, kinds, &attrs, ref_to, ref_from, fetch_n)?
            }
        }
        None => sql::query_sql_only(conn, doc_id, kinds, &attrs, ref_to, ref_from, fetch_n)?,
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

#[cfg(test)]
#[path = "query_blocks_tests.rs"]
mod tests;
