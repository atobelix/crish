//! store ↔ collab 投影索引自动接线（Round5）。
//!
//! # 推荐管线
//! ```ignore
//! use conex_workspace_store::{SharedWorkspaceStore, commit_ops};
//! use conex_doc_collab::{DocSession, Origin};
//!
//! let store = SharedWorkspaceStore::open("workspace.db")?;
//! let mut session = DocSession::new("doc-1")
//!     .with_persistence(Box::new(store.clone()));
//! // apply → on_committed（权威 updates）→ apply_projection_diff（blocks/FTS + mirror lag）
//! let ev = commit_ops(&mut session, &store, Origin::User, &ops)?;
//! ```
//!
//! - **权威落盘**：`DocSession::apply` 内 `PersistencePlugin::on_committed`（snapshot+updates）
//! - **派生索引**：`WorkspaceStore::apply_projection_diff`（以 `ProjectionDiff` / 树为准，
//!   **不能**指望 decode 结构 update 占位字节）
//! - **可选 MD mirror**：`commit_ops_with_mirror` 在 `mirror_lag >= threshold` 时 export

use crate::cas::remove_block_attachments_conn;
use crate::refs::{materialize_block_refs_conn, remove_refs_from_conn};
use crate::{
    StoreError, WorkspaceStore, note_authority_advanced_conn, reindex_block_conn,
    remove_block_index_conn, ReindexBlockOpts,
};
use conex_doc_collab::{
    ApplyError, BlockKind, BlockTree, DocEvent, DocSession, Op, Origin, ProjectionDiff,
};
use rusqlite::params;
use std::path::{Path, PathBuf};
use thiserror::Error;

// ─── 错误 ───────────────────────────────────────────────────────────────

/// 提交管线错误（apply 或索引）。
#[derive(Debug, Error)]
pub enum CommitPipelineError {
    #[error("apply: {0}")]
    Apply(#[from] ApplyError),
    #[error("store: {0}")]
    Store(#[from] StoreError),
}

// ─── mirror 自动导出选项 ────────────────────────────────────────────────

/// 默认：`mirror_lag >= 1` 即触发 export（有 mirror_root 时）。
/// 设为 `0` 关闭自动 export。
pub const DEFAULT_MIRROR_EXPORT_LAG_THRESHOLD: i64 = 1;

/// 可选 MD mirror 自动导出配置。
#[derive(Debug, Clone)]
pub struct CommitMirrorOpts {
    pub mirror_root: PathBuf,
    /// `pending_lag >= lag_threshold` 时调用 `export_md_mirror`；`0` = 关闭。
    pub lag_threshold: i64,
}

impl CommitMirrorOpts {
    pub fn new(mirror_root: impl Into<PathBuf>) -> Self {
        Self {
            mirror_root: mirror_root.into(),
            lag_threshold: DEFAULT_MIRROR_EXPORT_LAG_THRESHOLD,
        }
    }

    pub fn with_lag_threshold(mut self, lag_threshold: i64) -> Self {
        self.lag_threshold = lag_threshold;
        self
    }
}

// ─── WorkspaceStore：投影 diff 应用 ─────────────────────────────────────

impl WorkspaceStore {
    /// 将 `ProjectionDiff` 投影到 blocks / FTS / refs / mirror lag（**同事务原子**）。
    ///
    /// - `upserts` → `reindex_block` + **refs 自动物化**（从 `plain_text` 抽 `((id))` / `[[page]]`，见 [`crate::refs`]）
    /// - `removes` → 删 blocks 行 + FTS + 出边/入边 refs + attachment 链接
    /// - 末尾 [`crate::WorkspaceStore::note_authority_advanced`] 抬升 mirror lag
    /// - `full_rebuild == true`：先清空该 doc 全部投影再 upsert（refs 随 clear 清空后由 upsert 重建）
    ///
    /// 失败整批回滚。索引必须以 diff/树为准，**不** decode CRDT 结构占位字节。
    ///
    /// # W2-F
    /// refs 与 blocks/FTS **同事务**；**禁止**依赖手工 `upsert_ref` 作为产品唯一灌边路径。
    /// **≠ Wave 2 存储完成**；**≠ EL-03**。
    pub fn apply_projection_diff(
        &self,
        doc_id: &str,
        diff: &ProjectionDiff,
    ) -> Result<(), StoreError> {
        // diff.doc_id 与调用方不一致时以参数为准（调用方权威），但记录 Persist 便于排查
        if !diff.doc_id.is_empty() && diff.doc_id != doc_id {
            return Err(StoreError::Persist(format!(
                "apply_projection_diff: doc_id 不匹配 arg=`{doc_id}` diff=`{}`",
                diff.doc_id
            )));
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let tx = conn.unchecked_transaction()?;

        if diff.full_rebuild {
            clear_doc_projection_conn(&tx, doc_id)?;
        }

        for id in &diff.removes {
            let bid = id.to_string();
            remove_block_index_conn(&tx, doc_id, &bid)?;
            remove_refs_from_conn(&tx, doc_id, &bid)?;
            // 入边：被删块不再作为 to
            tx.execute(
                "DELETE FROM block_refs WHERE doc_id = ?1 AND to_id = ?2",
                params![doc_id, bid],
            )?;
            remove_block_attachments_conn(&tx, doc_id, &bid)?;
        }

        for u in &diff.upserts {
            let bid = u.id.to_string();
            let plain = u.plain_text.as_str(); // 缺省字段 serde default → ""
            let opts = ReindexBlockOpts {
                parent_id: u.parent.map(|p| p.to_string()),
                kind: block_kind_to_store_str(&u.kind),
                order_key: u.order.clone(),
                props_json: serde_json::to_string(&u.props).unwrap_or_else(|_| "{}".into()),
            };
            reindex_block_conn(&tx, doc_id, &bid, plain, &opts)?;
            // W2-F：同事务重建出边（plain 无引用语法 → 出边清空）
            materialize_block_refs_conn(&tx, doc_id, &bid, plain)?;
        }

        // 权威 rev 前进 → mirror lag 抬升（同事务）
        note_authority_advanced_conn(&tx, doc_id, diff.rev)?;

        tx.commit()?;
        Ok(())
    }
}

/// 清空某 doc 的全部投影索引（full_rebuild 用；**不**动 snapshot/updates 权威）。
fn clear_doc_projection_conn(conn: &rusqlite::Connection, doc_id: &str) -> Result<(), StoreError> {
    conn.execute(
        "DELETE FROM blocks_fts WHERE doc_id = ?1",
        params![doc_id],
    )?;
    conn.execute("DELETE FROM blocks WHERE doc_id = ?1", params![doc_id])?;
    conn.execute(
        "DELETE FROM block_refs WHERE doc_id = ?1",
        params![doc_id],
    )?;
    conn.execute(
        "DELETE FROM block_attachments WHERE doc_id = ?1",
        params![doc_id],
    )?;
    Ok(())
}

/// BlockKind → 投影表 kind 字符串（稳定、可过滤）。
pub fn block_kind_to_store_str(kind: &BlockKind) -> String {
    match kind {
        BlockKind::Paragraph => "paragraph".into(),
        BlockKind::Heading { level } => format!("heading:{level}"),
        BlockKind::BulletItem => "bullet_item".into(),
        BlockKind::OrderedItem => "ordered_item".into(),
        BlockKind::Code => "code".into(),
        BlockKind::Quote => "quote".into(),
        BlockKind::Divider => "divider".into(),
        BlockKind::Unknown { flavour } => {
            if flavour.is_empty() {
                "unknown".into()
            } else {
                flavour.clone()
            }
        }
    }
}

// ─── 模块级 glue ────────────────────────────────────────────────────────

/// 对 `DocEvent::Projection` 调用 [`WorkspaceStore::apply_projection_diff`]；其它事件 no-op。
pub fn index_after_apply(store: &WorkspaceStore, event: &DocEvent) -> Result<(), StoreError> {
    match event {
        DocEvent::Projection { diff } => store.apply_projection_diff(&diff.doc_id, diff),
        DocEvent::Reject { .. } | DocEvent::Awareness { .. } => Ok(()),
    }
}

/// 完整提交管线：`session.apply` → 投影索引。
///
/// **前置**：`session` 应已 `with_persistence(Box::new(shared.clone()))`
///（[`crate::SharedWorkspaceStore`]），以便 apply 内 `on_committed` 写权威 updates
///（本函数不再重复写）。
///
/// 若未挂 plugin，apply 仍成功，但权威落盘不会发生——调用方责任。
pub fn commit_ops(
    session: &mut DocSession,
    store: &WorkspaceStore,
    origin: Origin,
    ops: &[Op],
) -> Result<DocEvent, CommitPipelineError> {
    let ev = session.apply(origin, ops)?;
    index_after_apply(store, &ev)?;
    Ok(ev)
}

/// 同 [`commit_ops`]，并在 `mirror_lag >= threshold` 时自动 `export_md_mirror`。
///
/// - `mirror = None`：与 `commit_ops` 等价
/// - `lag_threshold = 0`：关闭自动 export（仍会 advance lag）
/// - export 使用 `session.tree()` 与 diff.rev；成功后 lag → 0
pub fn commit_ops_with_mirror(
    session: &mut DocSession,
    store: &WorkspaceStore,
    origin: Origin,
    ops: &[Op],
    mirror: Option<&CommitMirrorOpts>,
) -> Result<DocEvent, CommitPipelineError> {
    let ev = commit_ops(session, store, origin, ops)?;
    if let Some(opts) = mirror {
        maybe_export_mirror(session, store, &ev, opts)?;
    }
    Ok(ev)
}

/// 若 lag 达阈值则 export；供测试与上层细粒度调用。
pub fn maybe_export_mirror(
    session: &DocSession,
    store: &WorkspaceStore,
    event: &DocEvent,
    opts: &CommitMirrorOpts,
) -> Result<(), StoreError> {
    if opts.lag_threshold <= 0 {
        return Ok(());
    }
    let DocEvent::Projection { diff } = event else {
        return Ok(());
    };
    let lag = store.mirror_lag(&diff.doc_id)?.unwrap_or(0);
    if lag >= opts.lag_threshold {
        store.export_md_mirror(
            &diff.doc_id,
            session.tree(),
            diff.rev,
            opts.mirror_root.as_path(),
        )?;
    }
    Ok(())
}

/// 辅助：仅 export 清 lag（测试/手动 flush 契约）。
pub fn export_mirror_now(
    store: &WorkspaceStore,
    doc_id: &str,
    tree: &BlockTree,
    rev: u64,
    mirror_root: &Path,
) -> Result<PathBuf, StoreError> {
    store.export_md_mirror(doc_id, tree, rev, mirror_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SharedWorkspaceStore;
    use conex_doc_collab::{BlockId, BlockKind, BlockProps, BlockUpsert};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_db() -> (PathBuf, PathBuf) {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "conex-proj-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("workspace.db");
        (dir, db)
    }

    #[test]
    fn apply_projection_diff_upsert_search_and_remove() {
        let (dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        let id1 = BlockId::new();
        let id2 = BlockId::new();

        let diff = ProjectionDiff {
            doc_id: "doc-p".into(),
            rev: 1,
            upserts: vec![
                BlockUpsert {
                    id: id1,
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                    children: vec![],
                    order: "a0".into(),
                    parent: None,
                    plain_text: "alpha searchable_token_one".into(),
                },
                BlockUpsert {
                    id: id2,
                    kind: BlockKind::Heading { level: 2 },
                    props: BlockProps::default(),
                    children: vec![],
                    order: "a1".into(),
                    parent: None,
                    plain_text: "beta searchable_token_two".into(),
                },
            ],
            removes: vec![],
            text_touches: vec![],
            full_rebuild: false,
        };
        store.apply_projection_diff("doc-p", &diff).unwrap();

        assert_eq!(store.count_blocks("doc-p").unwrap(), 2);
        let hits = store
            .search_fulltext("doc-p", "searchable_token_one", 10)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, id1.to_string());
        assert_eq!(hits[0].kind, "paragraph");

        let hits2 = store
            .search_fulltext("doc-p", "searchable_token_two", 10)
            .unwrap();
        assert_eq!(hits2[0].kind, "heading:2");

        // lag 已抬升
        assert_eq!(store.mirror_lag("doc-p").unwrap(), Some(1));

        // remove id1
        let diff2 = ProjectionDiff {
            doc_id: "doc-p".into(),
            rev: 2,
            upserts: vec![],
            removes: vec![id1],
            text_touches: vec![],
            full_rebuild: false,
        };
        store.apply_projection_diff("doc-p", &diff2).unwrap();
        assert!(
            store
                .search_fulltext("doc-p", "searchable_token_one", 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.count_blocks("doc-p").unwrap(), 1);
        assert_eq!(store.mirror_lag("doc-p").unwrap(), Some(2));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// G-HYD-2 联测：apply → on_committed → load_doc → hydrate → 树同构（含 compact）。
    #[test]
    fn g_hyd_02_workspace_store_apply_persist_hydrate_isomorphic() {
        use conex_doc_collab::{structure_codec, BlockProps, Origin as O, PersistencePlugin};
        let (dir, db) = temp_db();
        let store = SharedWorkspaceStore::open(&db).unwrap();
        let mut session =
            DocSession::new("doc-hyd").with_persistence(Box::new(store.clone()));

        let id_a = BlockId::new();
        let id_b = BlockId::new();
        commit_ops(
            &mut session,
            &store,
            O::User,
            &[
                Op::Insert {
                    id: id_a,
                    parent: None,
                    order: "a0".into(),
                    kind: BlockKind::Paragraph,
                    props: BlockProps::default(),
                },
                Op::Insert {
                    id: id_b,
                    parent: Some(id_a),
                    order: "a0".into(),
                    kind: BlockKind::BulletItem,
                    props: BlockProps::default(),
                },
                Op::TextEdit {
                    id: id_a,
                    start: 0,
                    end: 0,
                    insert: "store-hydrate-alpha".into(),
                },
            ],
        )
        .unwrap();

        let expected = session.tree().clone();
        let expected_rev = session.rev();

        // compact：强制 snapshot 路径（flush_doc）
        store.flush_doc("doc-hyd").unwrap();
        let blob = PersistencePlugin::load_doc(&store, "doc-hyd").unwrap();
        assert!(blob.snapshot.is_some());
        assert!(blob.pending.is_empty(), "compact 后 pending 应空");

        let restored = DocSession::hydrate("doc-hyd", blob).expect("hydrate after compact");
        assert!(
            structure_codec::structure_eq(restored.tree(), &expected),
            "杀进程模拟：compact snapshot 须可 hydrate 出同构树"
        );
        assert_eq!(restored.rev(), expected_rev);
        assert_eq!(restored.read_text(&id_a), "store-hydrate-alpha");
        assert_eq!(restored.tree().get(&id_b).unwrap().parent, Some(id_a));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// A-INV-04 方向 / 落盘完成链（02 §0）：
    /// `apply → on_committed → [杀进程] → load_doc → hydrate → 树+文本 ≡ 杀前`。
    ///
    /// 模拟杀进程 = **drop session + drop store（关 SQLite）**，再 `SharedWorkspaceStore::open`
    /// 重开同一 `workspace.db` → `load_doc` → **新** `DocSession::hydrate`。
    ///
    /// 覆盖两条恢复路径：
    /// 1. **pending-only**（未 compact）：从 `doc_updates` 重放末帧 CDCS 结构
    /// 2. **compact/snapshot_tick**（`flush_doc`）：length-prefix snapshot 仍可 hydrate
    ///
    /// **本测绿 =「落盘恢复联测绿」**；**禁止**宣称 EL 关闭 / A-INV-04 产品验收全关。
    #[test]
    fn a_inv_04_kill_process_reload_hydrate_isomorphic() {
        use conex_doc_collab::{structure_codec, PersistencePlugin};

        let (dir, db) = temp_db();
        let doc_id = "doc-a-inv-04";
        let id_p = BlockId::new();
        let id_c = BlockId::new();
        let text_p = "kill-reload-paragraph-alpha";
        let text_c = "kill-reload-child-beta";

        // ── Phase 1：写权威（pending 路径）+ 派生索引 ──────────────────
        let (expected_tree, expected_rev) = {
            let store = SharedWorkspaceStore::open(&db).unwrap();
            let mut session =
                DocSession::new(doc_id).with_persistence(Box::new(store.clone()));

            // 批 1：根段落 + 文本
            commit_ops(
                &mut session,
                &store,
                Origin::User,
                &[
                    Op::Insert {
                        id: id_p,
                        parent: None,
                        order: "a0".into(),
                        kind: BlockKind::Paragraph,
                        props: BlockProps::default(),
                    },
                    Op::TextEdit {
                        id: id_p,
                        start: 0,
                        end: 0,
                        insert: text_p.into(),
                    },
                ],
            )
            .unwrap();

            // 批 2：子 bullet + 文本（多 rev / 多 pending）
            commit_ops(
                &mut session,
                &store,
                Origin::User,
                &[
                    Op::Insert {
                        id: id_c,
                        parent: Some(id_p),
                        order: "a0".into(),
                        kind: BlockKind::BulletItem,
                        props: BlockProps::default(),
                    },
                    Op::TextEdit {
                        id: id_c,
                        start: 0,
                        end: 0,
                        insert: text_c.into(),
                    },
                ],
            )
            .unwrap();

            let tree = session.tree().clone();
            let rev = session.rev();
            assert!(rev >= 2, "两批 apply 后 session.rev 须 ≥ 2，got {rev}");
            assert_eq!(session.read_text(&id_p), text_p);
            assert_eq!(session.read_text(&id_c), text_c);
            // 投影索引旁证（非 hydrate 主路径）
            let hits = store
                .search_fulltext(doc_id, "kill-reload-paragraph", 10)
                .unwrap();
            assert_eq!(hits.len(), 1, "commit_ops 后 FTS 应命中父块文本");
            assert!(
                store.load_pending_count(doc_id).unwrap() >= 1,
                "未 compact 时须有 pending updates"
            );
            assert!(store.load_rev(doc_id).unwrap() >= 2);

            // 显式 drop = 杀进程：会话内存与 SQLite 连接全部释放
            drop(session);
            drop(store);
            (tree, rev)
        };

        // ── Phase 2：进程重启 — 重开 db → load_doc → 新 hydrate ────────
        {
            let store =
                SharedWorkspaceStore::open(&db).expect("杀进程后须能重开 workspace.db");
            let blob = PersistencePlugin::load_doc(&store, doc_id)
                .expect("load_doc 须返回 snapshot⊕pending");
            assert!(
                blob.snapshot.is_some() || !blob.pending.is_empty(),
                "杀进程后权威 blob 不得空（表有行且须有可解码结构载荷）"
            );

            // 新会话：禁止 DocSession::new 空树冒充打开
            let restored =
                DocSession::hydrate(doc_id, blob).expect("pending 路径 hydrate 须成功");
            assert!(
                structure_codec::structure_eq(restored.tree(), &expected_tree),
                "A-INV-04：杀进程恢复树须同构（id/parent/order/kind/props/children/text_snapshot）"
            );
            assert_eq!(
                restored.rev(),
                expected_rev,
                "hydrate 后 rev 须与杀前 session.rev 一致"
            );
            assert_eq!(restored.read_text(&id_p), text_p);
            assert_eq!(restored.read_text(&id_c), text_c);
            assert_eq!(
                restored.tree().get(&id_p).unwrap().text_snapshot.as_deref(),
                Some(text_p),
                "父块 text_snapshot 须与杀前一致"
            );
            assert_eq!(
                restored.tree().get(&id_c).unwrap().text_snapshot.as_deref(),
                Some(text_c),
                "子块 text_snapshot 须与杀前一致"
            );
            assert_eq!(
                restored.tree().get(&id_c).unwrap().parent,
                Some(id_p),
                "父子关系须恢复"
            );
            // 冷登记可读（G-HYD-3 方向）
            assert!(restored.text_is_registered(&id_p));
            assert!(restored.text_is_registered(&id_c));
            drop(restored);
            drop(store);
        }

        // ── Phase 3：compact 后再杀进程，snapshot 路径仍可 hydrate ─────
        {
            let store = SharedWorkspaceStore::open(&db).unwrap();
            let blob = PersistencePlugin::load_doc(&store, doc_id).unwrap();
            let mut session = DocSession::hydrate(doc_id, blob)
                .unwrap()
                .with_persistence(Box::new(store.clone()));

            let id_extra = BlockId::new();
            commit_ops(
                &mut session,
                &store,
                Origin::User,
                &[
                    Op::Insert {
                        id: id_extra,
                        parent: None,
                        order: "a1".into(),
                        kind: BlockKind::Paragraph,
                        props: BlockProps::default(),
                    },
                    Op::TextEdit {
                        id: id_extra,
                        start: 0,
                        end: 0,
                        insert: "after-compact-path".into(),
                    },
                ],
            )
            .unwrap();

            let tree_after = session.tree().clone();
            let rev_after = session.rev();
            assert!(rev_after > expected_rev);

            // snapshot_tick 路径：flush 合并 pending → length-prefix snapshot
            store.flush_doc(doc_id).expect("flush_doc compact");
            assert_eq!(
                store.load_pending_count(doc_id).unwrap(),
                0,
                "compact 后 pending 须清空"
            );
            let pre_kill = PersistencePlugin::load_doc(&store, doc_id).unwrap();
            assert!(pre_kill.snapshot.is_some());
            assert!(pre_kill.pending.is_empty());

            drop(session);
            drop(store);

            // 再杀一次：仅 snapshot 字节
            let store2 = SharedWorkspaceStore::open(&db).unwrap();
            let blob2 = PersistencePlugin::load_doc(&store2, doc_id).unwrap();
            assert!(blob2.snapshot.is_some(), "compact 后须有 snapshot");
            assert!(blob2.pending.is_empty(), "compact 后 pending 应空");

            let restored2 = DocSession::hydrate(doc_id, blob2)
                .expect("compact snapshot 杀进程后仍须可 hydrate");
            assert!(
                structure_codec::structure_eq(restored2.tree(), &tree_after),
                "compact 后杀进程：树须同构"
            );
            assert_eq!(restored2.rev(), rev_after);
            assert_eq!(restored2.read_text(&id_extra), "after-compact-path");
            assert_eq!(restored2.read_text(&id_p), text_p);
            assert_eq!(restored2.read_text(&id_c), text_c);
            assert_eq!(
                restored2.tree().get(&id_extra).unwrap().text_snapshot.as_deref(),
                Some("after-compact-path")
            );
        }

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_ops_session_shared_store_end_to_end() {
        let (dir, db) = temp_db();
        let store = SharedWorkspaceStore::open(&db).unwrap();
        let mut session =
            DocSession::new("doc-e2e").with_persistence(Box::new(store.clone()));

        let id_a = BlockId::new();
        let id_b = BlockId::new();
        let ops = [
            Op::Insert {
                id: id_a,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: id_a,
                start: 0,
                end: 0,
                insert: "pipeline_hit_alpha".into(),
            },
            Op::Insert {
                id: id_b,
                parent: None,
                order: "a1".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id: id_b,
                start: 0,
                end: 0,
                insert: "pipeline_hit_beta".into(),
            },
        ];

        let ev = commit_ops(&mut session, &store, Origin::User, &ops).unwrap();
        match &ev {
            DocEvent::Projection { diff } => {
                assert_eq!(diff.doc_id, "doc-e2e");
                assert!(diff.rev >= 1);
                assert!(!diff.upserts.is_empty());
            }
            other => panic!("expected Projection, got {other:?}"),
        }

        // 权威 updates 已写
        assert!(store.load_rev("doc-e2e").unwrap() >= 1);
        assert!(store.load_pending_count("doc-e2e").unwrap() >= 1);

        // 索引可搜
        let hits = store
            .search_fulltext("doc-e2e", "pipeline_hit_alpha", 10)
            .unwrap();
        assert_eq!(hits.len(), 1, "Insert+TextEdit 后应命中 plain_text");
        assert_eq!(hits[0].block_id, id_a.to_string());

        let hits_b = store
            .search_fulltext("doc-e2e", "pipeline_hit_beta", 10)
            .unwrap();
        assert_eq!(hits_b.len(), 1);

        // rev 前进 → mirror lag 非 0
        let lag = store.mirror_lag("doc-e2e").unwrap().unwrap();
        assert!(lag > 0, "advance 后 lag 应 > 0，got {lag}");

        // Delete → 索引消失
        let del = [Op::Delete { id: id_b }];
        commit_ops(&mut session, &store, Origin::User, &del).unwrap();
        assert!(
            store
                .search_fulltext("doc-e2e", "pipeline_hit_beta", 10)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .search_fulltext("doc-e2e", "pipeline_hit_alpha", 10)
                .unwrap()
                .len(),
            1
        );

        // export 清 lag
        let mirror_root = dir.join("mirrors");
        store
            .export_md_mirror("doc-e2e", session.tree(), session.rev(), &mirror_root)
            .unwrap();
        assert_eq!(store.mirror_lag("doc-e2e").unwrap(), Some(0));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn commit_ops_with_mirror_auto_export_clears_lag() {
        let (dir, db) = temp_db();
        let store = SharedWorkspaceStore::open(&db).unwrap();
        let mut session =
            DocSession::new("doc-m2").with_persistence(Box::new(store.clone()));

        let id = BlockId::new();
        let mirror = CommitMirrorOpts::new(dir.join("mirrors")).with_lag_threshold(1);
        let ops = [
            Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
            },
            Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "auto mirror body".into(),
            },
        ];
        commit_ops_with_mirror(&mut session, &store, Origin::User, &ops, Some(&mirror))
            .unwrap();

        // 自动 export 后 lag 清零
        assert_eq!(store.mirror_lag("doc-m2").unwrap(), Some(0));
        let md = dir.join("mirrors").join("doc-m2.md");
        assert!(md.exists());
        let content = std::fs::read_to_string(&md).unwrap();
        assert!(content.contains("auto mirror body") || content.contains("<!--c:"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn index_after_apply_reject_is_noop() {
        let (dir, db) = temp_db();
        let store = WorkspaceStore::open(&db).unwrap();
        let ev = DocEvent::Reject {
            intent_id: "i1".into(),
            reason: "test".into(),
        };
        index_after_apply(&store, &ev).unwrap();
        assert_eq!(store.count_blocks("any").unwrap(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
