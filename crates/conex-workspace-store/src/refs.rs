//! W2-F Strict：`block_refs` 物化表 + **投影同事务自动抽边**。
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
//! - **≠ Wave 2 存储完成**（杀进程权威恢复 / P6 watcher 分属他包）
//! - **≠ EL-03**
//! - **≠** 完整 MD conex-ext wiki 节点解析（本波从 **plain_text 字面**抽边；AST 节点物化可后置）
//! - 手工 seed API 可保留，**不得**作为 A-QRY-01 唯一路径

use super::{StoreError, WorkspaceStore};
use rusqlite::{Connection, params};
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

// ── 测试 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projection::commit_ops;
    use crate::query_blocks::QueryBlocksParams;
    use crate::{ReindexBlockOpts, SCHEMA_VERSION, SharedWorkspaceStore, WorkspaceStore};
    use conex_doc_collab::{BlockId, BlockKind, BlockProps, DocSession, Op, Origin, ProjectionDiff};
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
    fn extract_block_ref_and_wikilink() {
        let tgt = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let plain = format!("see (({tgt})) and [[My Page|alias]] plus [[Other]]");
        let edges = extract_refs_from_plain(&plain);
        assert_eq!(edges.len(), 3);
        assert_eq!(edges[0].kind, KIND_BLOCK_REF);
        assert_eq!(edges[0].to_id, tgt);
        assert_eq!(edges[1].kind, KIND_WIKILINK);
        assert_eq!(edges[1].to_id, "My Page");
        assert_eq!(edges[2].to_id, "Other");
        // 去重
        let again = extract_refs_from_plain(&format!("(({tgt})) (({tgt}))"));
        assert_eq!(again.len(), 1);
        // 空 / 跨行跳过
        assert!(extract_refs_from_plain("((  )) [[  ]]").is_empty());
        assert!(extract_refs_from_plain("((a\nb))").is_empty());
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

    /// W2-F：投影 upsert 从 plain_text **自动**物化 refs（无手工 upsert_ref）。
    #[test]
    fn w2f_auto_materialize_refs_on_projection_upsert() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        let src = BlockId::new();
        let tgt = BlockId::new();
        let tgt_s = tgt.to_string();
        let plain = format!("link to (({tgt_s})) and [[Wiki Home]]");

        let diff = ProjectionDiff {
            doc_id: "doc-auto".into(),
            rev: 1,
            upserts: vec![conex_doc_collab::BlockUpsert {
                id: src,
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                children: vec![],
                order: "a0".into(),
                parent: None,
                plain_text: plain,
            }],
            removes: vec![],
            text_touches: vec![],
            full_rebuild: false,
        };
        // **禁止** 先 store.upsert_ref —— 仅靠投影
        store.apply_projection_diff("doc-auto", &diff).unwrap();

        let from = store.refs_from("doc-auto", &src.to_string()).unwrap();
        assert_eq!(from.len(), 2, "from={from:?}");
        let block_edge = from
            .iter()
            .find(|r| r.kind == KIND_BLOCK_REF)
            .expect("block_ref edge");
        assert_eq!(block_edge.to_id, tgt_s);
        let wiki = from
            .iter()
            .find(|r| r.kind == KIND_WIKILINK)
            .expect("wikilink edge");
        assert_eq!(wiki.to_id, "Wiki Home");

        let to = store.refs_to("doc-auto", &tgt_s).unwrap();
        assert_eq!(to.len(), 1);
        assert_eq!(to[0].from_id, src.to_string());
        assert_eq!(to[0].kind, KIND_BLOCK_REF);
    }

    /// 更新 plain_text 后出边重建一致；删除块后出边+入边清空。
    #[test]
    fn w2f_refs_rebuild_on_update_and_clear_on_remove() {
        let dir = TempDir::new();
        let store = WorkspaceStore::open(dir.db()).unwrap();
        let src = BlockId::new();
        let t1 = BlockId::new();
        let t2 = BlockId::new();
        let t1s = t1.to_string();
        let t2s = t2.to_string();

        store
            .apply_projection_diff(
                "doc-u",
                &ProjectionDiff {
                    doc_id: "doc-u".into(),
                    rev: 1,
                    upserts: vec![conex_doc_collab::BlockUpsert {
                        id: src,
                        kind: BlockKind::Paragraph,
                        props: BlockProps::default(),
                        children: vec![],
                        order: "a0".into(),
                        parent: None,
                        plain_text: format!("(({t1s}))"),
                    }],
                    removes: vec![],
                    text_touches: vec![],
                    full_rebuild: false,
                },
            )
            .unwrap();
        assert_eq!(store.refs_to("doc-u", &t1s).unwrap().len(), 1);
        assert!(store.refs_to("doc-u", &t2s).unwrap().is_empty());

        // 更新：t1 → t2
        store
            .apply_projection_diff(
                "doc-u",
                &ProjectionDiff {
                    doc_id: "doc-u".into(),
                    rev: 2,
                    upserts: vec![conex_doc_collab::BlockUpsert {
                        id: src,
                        kind: BlockKind::Paragraph,
                        props: BlockProps::default(),
                        children: vec![],
                        order: "a0".into(),
                        parent: None,
                        plain_text: format!("now (({t2s})) only"),
                    }],
                    removes: vec![],
                    text_touches: vec![],
                    full_rebuild: false,
                },
            )
            .unwrap();
        assert!(
            store.refs_to("doc-u", &t1s).unwrap().is_empty(),
            "旧边须清除"
        );
        let to2 = store.refs_to("doc-u", &t2s).unwrap();
        assert_eq!(to2.len(), 1);
        assert_eq!(to2[0].from_id, src.to_string());

        // 删除 src：出边 + 作为 to 的入边均清
        store
            .apply_projection_diff(
                "doc-u",
                &ProjectionDiff {
                    doc_id: "doc-u".into(),
                    rev: 3,
                    upserts: vec![],
                    removes: vec![src],
                    text_touches: vec![],
                    full_rebuild: false,
                },
            )
            .unwrap();
        assert!(store.refs_from("doc-u", &src.to_string()).unwrap().is_empty());
        assert!(store.refs_to("doc-u", &t2s).unwrap().is_empty());
    }

    /// A-QRY-01 refs 路：**无手工 upsert_ref seed**。
    /// insert 带 `((target))` 的块 → commit_ops / 投影 → query_blocks(ref_to)。
    #[test]
    fn a_qry_01_query_blocks_ref_without_manual_seed() {
        let dir = TempDir::new();
        let store = SharedWorkspaceStore::open(dir.db()).unwrap();
        let mut session =
            DocSession::new("doc-aqry").with_persistence(Box::new(store.clone()));

        let id_tgt = BlockId::new();
        let id_src = BlockId::new();
        let tgt_s = id_tgt.to_string();

        // 目标块 + 源块（源正文含块引用语法）
        commit_ops(
            &mut session,
            &store,
            Origin::User,
            &[
                Op::Insert {
                    id: id_tgt,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: id_tgt,
                    start: 0,
                    end: 0,
                    insert: "target body searchable".into(),
                },
                Op::Insert {
                    id: id_src,
                    parent: None,
                    order: "a1".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: id_src,
                    start: 0,
                    end: 0,
                    insert: format!("see (({tgt_s})) in notes"),
                },
            ],
        )
        .unwrap();

        // 旁证：自动物化边存在（仍无手工 seed）
        let edges = store.refs_to("doc-aqry", &tgt_s).unwrap();
        assert_eq!(
            edges.len(),
            1,
            "commit 后须自动物化 block_ref，got {edges:?}"
        );
        assert_eq!(edges[0].from_id, id_src.to_string());
        assert_eq!(edges[0].kind, KIND_BLOCK_REF);

        // A-QRY：ref_to 查回引用方
        let r = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-aqry".into(),
                ref_to: Some(tgt_s.clone()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r.blocks.len(), 1, "blocks={:?}", r.blocks);
        assert_eq!(r.blocks[0].id, id_src.to_string());
        assert_eq!(r.blocks[0].kind, "paragraph");

        // ref_from：源引用了谁 → 目标块在结果中（目标须已投影）
        let r2 = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-aqry".into(),
                ref_from: Some(id_src.to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r2.blocks.len(), 1);
        assert_eq!(r2.blocks[0].id, tgt_s);

        // 组合：ref_to ∩ text_match
        let r3 = store
            .query_blocks(&QueryBlocksParams {
                doc_id: "doc-aqry".into(),
                ref_to: Some(tgt_s),
                text_match: Some("see".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(r3.blocks.len(), 1);
        assert_eq!(r3.blocks[0].id, id_src.to_string());
    }
}
