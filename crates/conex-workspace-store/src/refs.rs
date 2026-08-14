//! W2-F Strict：`block_refs` 物化表 + **投影同事务自动抽边**。
//!
//! # 模块内聚（SD-18 · 黄带体积切开）
//! - **本文件**：`KIND_*` / 类型 / `WorkspaceStore` 方法 / 抽边纯函数 / 连接级 SQL
//! - [`tests`]（`refs_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::refs::*` / `lib` `pub use`）
//!
//! # 角色
//! - 派生索引：可丢、可重建；权威仍为 snapshot+updates（**不得** hydrate 主路径）。
//! - 手工 [`WorkspaceStore::upsert_ref`] 保留给测试/抢救；**产品路径**走
//!   [`materialize_block_refs_conn`]（由 [`crate::WorkspaceStore::apply_projection_diff`] 调用）。
//!
//! # 第一刀语法（钉死 · 与 02 §2.5 / Logseq 方向对齐）
//! | 正文形态 | `kind` 常量 | `to_id` |
//! |----------|-------------|--------|
//! | `((target))` | [`KIND_BLOCK_REF`] | `target` trim 后（通常为 block UUID） |
//! | `[[page]]` / `[[page\|alias]]` | [`KIND_WIKILINK`] | `page` trim 后（`|` 前半） |
//!
//! 空 target / 含换行 / 未闭合括号 → 跳过，不写边。
//!
//! # 一致性
//! - **upsert**：先 `DELETE` 该块全部出边，再按 plain_text 全量重建（简单一致，无陈旧边）。
//! - **remove**：删出边 + 入边（见 projection）。
//!
//! # 诚实边界
//! - **SD-18** 仅为结构切开（体积/职责），**不**静默改抽边 / 物化语义
//! - **≠ EL-03**
//! - **≠ Wave 2 存储完成**（杀进程权威恢复 / P6 watcher 分属他包）
//! - **≠** 再切 os_watch / persist
//! - **≠** 完整 MD conex-ext wiki 节点解析（本波从 **plain_text 字面**抽边；AST 节点物化可后置）
//! - 手工 seed API 可保留，**不得**作为 A-QRY-01 唯一路径

use super::{StoreError, WorkspaceStore};
use rusqlite::{params, Connection};
use std::collections::BTreeSet;

/// Logseq 风格块引用 `((id))` 的 `block_refs.kind`。
pub const KIND_BLOCK_REF: &str = "block_ref";
/// Wiki / 页引用 `[[title]]` 的 `block_refs.kind`。
pub const KIND_WIKILINK: &str = "wikilink";

/// 单条块引用边（`block_refs` 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRef {
    pub from_id: String,
    pub to_id: String,
    /// 引用种类（如 [`KIND_BLOCK_REF`] / [`KIND_WIKILINK`]）；与 PK 组成唯一边。
    pub kind: String,
}

/// 从 plain_text 抽出的一条出边候选（尚未绑定 from_id）。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExtractedRef {
    pub to_id: String,
    pub kind: String,
}

impl WorkspaceStore {
    /// 幂等写入一条引用边（**手工 seed**；测试/抢救用）。
    ///
    /// 产品投影路径请走 [`materialize_block_refs_conn`]，勿依赖本 API 为唯一灌边手段。
    pub fn upsert_ref(
        &self,
        doc_id: &str,
        from_id: &str,
        to_id: &str,
        kind: &str,
    ) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        upsert_ref_conn(&conn, doc_id, from_id, to_id, kind)
    }

    /// 删除某块作为 `from_id` 的全部出链（重建 refs 时常用）。
    pub fn remove_refs_from(&self, doc_id: &str, from_id: &str) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        remove_refs_from_conn(&conn, doc_id, from_id)
    }

    /// 谁引用了 `to_id`（入边 / 反向链接）。
    pub fn refs_to(&self, doc_id: &str, to_id: &str) -> Result<Vec<BlockRef>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        refs_to_conn(&conn, doc_id, to_id)
    }

    /// `from_id` 引用了谁（出边）。
    pub fn refs_from(&self, doc_id: &str, from_id: &str) -> Result<Vec<BlockRef>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        refs_from_conn(&conn, doc_id, from_id)
    }

    /// 从 plain_text 自动物化该块出边（公开测/重建入口；与投影同语义）。
    pub fn materialize_block_refs(
        &self,
        doc_id: &str,
        from_id: &str,
        plain_text: &str,
    ) -> Result<(), StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        materialize_block_refs_conn(&conn, doc_id, from_id, plain_text)
    }
}

// ── 抽边（纯函数 · 可单测） ──────────────────────────────────────────────

/// 从块 plain_text 抽取引用边（`block_ref` + `wikilink`）。
///
/// 去重：同一 `(to_id, kind)` 只保留一条。顺序稳定：先全部 block_ref，再 wikilink，
/// 各自按出现序。
pub fn extract_refs_from_plain(plain: &str) -> Vec<ExtractedRef> {
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();
    let mut out: Vec<ExtractedRef> = Vec::new();

    extract_delimited(
        plain,
        "((",
        "))",
        KIND_BLOCK_REF,
        /*alias_sep=*/ None,
        &mut seen,
        &mut out,
    );
    extract_delimited(
        plain,
        "[[",
        "]]",
        KIND_WIKILINK,
        /*alias_sep=*/ Some('|'),
        &mut seen,
        &mut out,
    );

    out
}

fn extract_delimited(
    plain: &str,
    open: &str,
    close: &str,
    kind: &str,
    alias_sep: Option<char>,
    seen: &mut BTreeSet<(String, String)>,
    out: &mut Vec<ExtractedRef>,
) {
    let open_len = open.len();
    let close_len = close.len();
    let mut rest = plain;
    while let Some(start) = rest.find(open) {
        let after_open = &rest[start + open_len..];
        // 禁止跨行：关闭符之前若含换行则本开括号作废，从开括号后继续扫
        if let Some(end) = after_open.find(close) {
            let raw = &after_open[..end];
            if raw.contains('\n') || raw.contains('\r') {
                rest = &after_open[1..]; // 跳过开括号后一字节，继续
                continue;
            }
            // block_ref：内容不得再含未配对 `(` 以免 `((a(b))` 歧义；wiki 允许 `/` 等
            if kind == KIND_BLOCK_REF && (raw.contains('(') || raw.contains(')')) {
                rest = &after_open[end + close_len..];
                continue;
            }
            if kind == KIND_WIKILINK && (raw.contains('[') || raw.contains(']')) {
                rest = &after_open[end + close_len..];
                continue;
            }
            let mut target = raw.trim();
            if let Some(sep) = alias_sep {
                if let Some((head, _)) = target.split_once(sep) {
                    target = head.trim();
                }
            }
            if !target.is_empty() {
                let key = (target.to_string(), kind.to_string());
                if seen.insert(key) {
                    out.push(ExtractedRef {
                        to_id: target.to_string(),
                        kind: kind.to_string(),
                    });
                }
            }
            rest = &after_open[end + close_len..];
        } else {
            break;
        }
    }
}

// ── 连接级写路径 ────────────────────────────────────────────────────────

/// 连接级：按 plain_text **重建**某块全部出边（删旧 + 抽边 upsert）。
///
/// 与 `apply_projection_diff` 同事务调用；失败由调用方回滚。
pub fn materialize_block_refs_conn(
    conn: &Connection,
    doc_id: &str,
    from_id: &str,
    plain_text: &str,
) -> Result<(), StoreError> {
    remove_refs_from_conn(conn, doc_id, from_id)?;
    for er in extract_refs_from_plain(plain_text) {
        upsert_ref_conn(conn, doc_id, from_id, &er.to_id, &er.kind)?;
    }
    Ok(())
}

/// 连接级 UPSERT（可测；无锁）。
pub fn upsert_ref_conn(
    conn: &Connection,
    doc_id: &str,
    from_id: &str,
    to_id: &str,
    kind: &str,
) -> Result<(), StoreError> {
    conn.execute(
        r#"
        INSERT INTO block_refs(doc_id, from_id, to_id, kind)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(doc_id, from_id, to_id, kind) DO NOTHING
        "#,
        params![doc_id, from_id, to_id, kind],
    )?;
    Ok(())
}

/// 连接级：删除 from 侧全部出链。
pub fn remove_refs_from_conn(
    conn: &Connection,
    doc_id: &str,
    from_id: &str,
) -> Result<(), StoreError> {
    conn.execute(
        "DELETE FROM block_refs WHERE doc_id = ?1 AND from_id = ?2",
        params![doc_id, from_id],
    )?;
    Ok(())
}

/// 连接级：入边查询。
pub fn refs_to_conn(
    conn: &Connection,
    doc_id: &str,
    to_id: &str,
) -> Result<Vec<BlockRef>, StoreError> {
    let mut stmt = conn.prepare(
        r#"
        SELECT from_id, to_id, kind
        FROM block_refs
        WHERE doc_id = ?1 AND to_id = ?2
        ORDER BY from_id ASC, kind ASC
        "#,
    )?;
    let rows = stmt.query_map(params![doc_id, to_id], |r| {
        Ok(BlockRef {
            from_id: r.get(0)?,
            to_id: r.get(1)?,
            kind: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 连接级：出边查询。
pub fn refs_from_conn(
    conn: &Connection,
    doc_id: &str,
    from_id: &str,
) -> Result<Vec<BlockRef>, StoreError> {
    let mut stmt = conn.prepare(
        r#"
        SELECT from_id, to_id, kind
        FROM block_refs
        WHERE doc_id = ?1 AND from_id = ?2
        ORDER BY to_id ASC, kind ASC
        "#,
    )?;
    let rows = stmt.query_map(params![doc_id, from_id], |r| {
        Ok(BlockRef {
            from_id: r.get(0)?,
            to_id: r.get(1)?,
            kind: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ── 测试（SD-18 外置） ─────────────────────────────────────────────────────

#[cfg(test)]
#[path = "refs_tests.rs"]
mod tests;
