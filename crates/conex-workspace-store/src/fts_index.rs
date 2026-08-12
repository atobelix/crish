//! FTS / blocks 投影索引写路径：reindex / remove / rebuild。
//!
//! 由父模 [`crate::fts`] 经 `#[path]` 接入（**SD-16** 黄带切开）。
//! **诚实**：**≠ EL-03**；**不**静默改索引语义。

use super::ReindexBlockOpts;
use crate::StoreError;
use rusqlite::{Connection, params};

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
pub(super) fn rebuild_fts_conn(conn: &Connection, doc_id: Option<&str>) -> Result<(), StoreError> {
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
