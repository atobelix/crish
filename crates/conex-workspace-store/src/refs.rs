//! W2-F+：`block_refs` 物化表 API（块引用 / 反向链接骨架）。
//!
//! 派生索引：可丢、可重建；权威仍为 snapshot+updates。
//! 本波次仅 upsert/query 骨架；正文解析抽边留给后续 indexer。

use super::{StoreError, WorkspaceStore};
use rusqlite::{Connection, params};

/// 单条块引用边（`block_refs` 行）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRef {
    pub from_id: String,
    pub to_id: String,
    /// 引用种类（如 `block` / `page` / 空串）；与 PK 组成唯一边。
    pub kind: String,
}

impl WorkspaceStore {
    /// 幂等写入一条引用边。
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

// ── 测试 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use crate::query_blocks::QueryBlocksParams;
    use crate::{ReindexBlockOpts, SCHEMA_VERSION, WorkspaceStore};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let p = std::env::temp_dir().join(format!(
                "conex-refs-{}-{}-{}",
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

    #[test]
    fn schema_v5_has_block_refs() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(SCHEMA_VERSION >= 5);

        let conn = rusqlite::Connection::open(dir.db()).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='block_refs'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);

        // 索引存在
        let idx: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_block_refs_to','idx_block_refs_from')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 2);
    }

    #[test]
    fn upsert_refs_to_refs_from_and_remove() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();

        store
            .upsert_ref("doc-a", "b1", "target", "block")
            .unwrap();
        store
            .upsert_ref("doc-a", "b2", "target", "block")
            .unwrap();
        store
            .upsert_ref("doc-a", "b1", "other", "page")
            .unwrap();
        // 幂等：同边再写不炸
        store
            .upsert_ref("doc-a", "b1", "target", "block")
            .unwrap();
        // 另一 doc 不得串
        store
            .upsert_ref("doc-b", "b1", "target", "block")
            .unwrap();

        let to = store.refs_to("doc-a", "target").unwrap();
        assert_eq!(to.len(), 2);
        assert_eq!(to[0].from_id, "b1");
        assert_eq!(to[1].from_id, "b2");
        assert!(to.iter().all(|r| r.to_id == "target" && r.kind == "block"));

        let from = store.refs_from("doc-a", "b1").unwrap();
        assert_eq!(from.len(), 2);
        let tos: Vec<_> = from.iter().map(|r| r.to_id.as_str()).collect();
        assert!(tos.contains(&"target"));
        assert!(tos.contains(&"other"));

        // remove_refs_from：仅清 b1 出链
        store.remove_refs_from("doc-a", "b1").unwrap();
        assert!(store.refs_from("doc-a", "b1").unwrap().is_empty());
        // b2 → target 仍在
        let to2 = store.refs_to("doc-a", "target").unwrap();
        assert_eq!(to2.len(), 1);
        assert_eq!(to2[0].from_id, "b2");
        // doc-b 不受影响
        assert_eq!(store.refs_to("doc-b", "target").unwrap().len(), 1);
    }

    #[test]
    fn query_blocks_ref_to_and_ref_from() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();

        // 块投影
        for (id, text) in [
            ("src-a", "source a text"),
            ("src-b", "source b text"),
            ("tgt", "target block"),
            ("leaf", "leaf only"),
        ] {
            store
                .reindex_block(
                    "doc-r",
                    id,
                    text,
                    ReindexBlockOpts {
                        kind: "paragraph".into(),
                        order_key: id.into(),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        // src-a → tgt, src-b → tgt, src-a → leaf
        store.upsert_ref("doc-r", "src-a", "tgt", "block").unwrap();
        store.upsert_ref("doc-r", "src-b", "tgt", "block").unwrap();
        store.upsert_ref("doc-r", "src-a", "leaf", "block").unwrap();

        // ref_to=tgt → 谁引用了 tgt：src-a, src-b
        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-r".into(),
                ref_to: Some("tgt".into()),
                ..Default::default()
            })
            .unwrap();
        let ids: Vec<_> = r.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "ids={ids:?}");
        assert!(ids.contains(&"src-a"));
        assert!(ids.contains(&"src-b"));
        assert!(!ids.contains(&"tgt"));
        assert!(!ids.contains(&"leaf"));

        // ref_from=src-a → src-a 引用了谁：tgt, leaf（结果块是 to 侧）
        let r2 = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-r".into(),
                ref_from: Some("src-a".into()),
                ..Default::default()
            })
            .unwrap();
        let ids2: Vec<_> = r2.blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids2.len(), 2, "ids2={ids2:?}");
        assert!(ids2.contains(&"tgt"));
        assert!(ids2.contains(&"leaf"));

        // ref_to ∩ kind（AND）
        let r3 = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-r".into(),
                ref_to: Some("tgt".into()),
                kind_in: Some(vec!["paragraph".into()]),
                text_match: Some("source".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r3.blocks.len(), 2);

        // 无匹配的 ref_to → 空（不再忽略）
        let r4 = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-r".into(),
                ref_to: Some("no-such".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(r4.blocks.is_empty());
    }
}
