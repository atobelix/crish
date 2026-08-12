//! store ↔ collab 投影索引自动接线（Round5）。
//!
//! # 模块内聚（SD-17 · 黄带体积切开）
//! - **本文件**：公开类型 / `apply_projection_diff` / commit 管线门面
//! - [`tests`]（`projection_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::projection::*` / `lib` `pub use`）
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
//!
//! # 诚实边界
//! - **SD-17** · **≠ EL-03** · **≠ Wave 2 存储完成**
//! - 本包仅为 **结构切开**（体积/职责），**不**静默改投影/FTS 语义
//! - **≠** 再切 refs / os_watch（留给后续 SD）

use crate::cas::remove_block_attachments_conn;
use crate::refs::{materialize_block_refs_conn, remove_refs_from_conn};
use crate::{
    note_authority_advanced_conn, reindex_block_conn, remove_block_index_conn, ReindexBlockOpts,
    StoreError, WorkspaceStore,
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
#[path = "projection_tests.rs"]
mod tests;
