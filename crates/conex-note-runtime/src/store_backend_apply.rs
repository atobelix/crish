//! Store apply 写路径长实现（**SD-29** 再切；**SD-49** 抽出 query/镜像）
//!
//! 本文件保留：
//! - [`StoreNoteBackend::apply_collab_ops_json`]（CONN-B3 collab wire）
//! - [`StoreNoteBackend::apply_block_ops_inner`]（W4-F 批 apply）
//!
//! 读路径 / 镜像产品入口见 [`crate::store_backend_query`]（**SD-49**）。
//!
//! # 边界
//! - **不**重做 [`crate::store_plan_ops`] / [`crate::store_hydrate`] /
//!   [`crate::store_apply_md`] / [`crate::store_outline`]（SD-06 已切，禁止整包）
//! - **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 满表**
//! - **≠ EL-01 / EL-03 / EL-04**；本包只切结构，不抬关
//! - 保留 dry_run 零写 / `force_execution_unknown` 不半写

use agent_tools::note_backend::{
    NoteBackendError, NoteBlockBatchRequest, NoteBlockBatchResult, NoteRedoResult, NoteUndoResult,
};
use conex_doc_collab::BlockId;
use conex_workspace_store::commit_ops;
use std::sync::atomic::Ordering;

use crate::poison::POISON_RECOVERIES;
use crate::store_backend::{map_commit_err, origin_from_str, SlowPathProbe, StoreNoteBackend};
use crate::store_plan_ops::plan_block_ops_to_collab;

/// `apply_collab_ops_json` 成功结果（IPC / 测断言）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApplyCollabOpsOutcome {
    /// apply 后会话 rev
    pub rev: u64,
    /// 本批 ops 条数
    pub applied: u32,
}

impl StoreNoteBackend {
    /// CONN-B3：collab wire JSON → 真 `DocSession::apply`（经 `commit_ops`）。
    ///
    /// 对齐 TS `createCollabApplySink` / `ApplyOpsAdapter`：
    /// `ops_json` 为 collab Op 数组（`ops_from_json` / `collabOpsToJson` 形状）。
    ///
    /// `origin`：`user` | `agent` | `remote` | `system`；缺省 / 未知 → User。
    ///
    /// # 诚实边界
    /// - 桌面 IPC 入口见 workbench `note_apply_ops`
    /// - **≠ EL-01**；本路径可测 **≠** A-BLK 全表 e2e / 打开完成
    pub fn apply_collab_ops_json(
        &self,
        doc_id: &str,
        ops_json: &str,
        origin: Option<&str>,
    ) -> Result<ApplyCollabOpsOutcome, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        if ops_json.trim().is_empty() {
            return Err(NoteBackendError::Invalid(
                "ops_json must be non-empty".into(),
            ));
        }
        let ops = conex_doc_collab::ops_from_json_str(ops_json)
            .map_err(|e| NoteBackendError::Invalid(format!("ops_json parse: {e}")))?;
        let origin = origin_from_str(origin);
        // B3：per-doc 锁——doc 锁持写全程（ensure 在 map 锁短临界内完成）
        let arc = self.session_handle(doc_id)?;
        // S3 埋点：获取点前发起计时（锁外），acquire 返回后立即结束；告警锁外析构
        let mut probe = SlowPathProbe::start(doc_id);
        let mut session = arc.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
            tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        probe.finish_lock();
        if ops.is_empty() {
            let outcome = ApplyCollabOpsOutcome {
                rev: session.rev(),
                applied: 0,
            };
            drop(session);
            return Ok(outcome);
        }
        commit_ops(&mut session, &self.store, origin, &ops).map_err(map_commit_err)?;
        let outcome = ApplyCollabOpsOutcome {
            rev: session.rev(),
            applied: ops.len() as u32,
        };
        drop(session);
        Ok(outcome)
    }

    /// W4-F 余量：Store 真路径批 apply 块 ops（由 trait 委托）。
    ///
    /// - dryRun：规划 preview，**零写**（不 `commit_ops`）
    /// - 实写：`plan` → 单次 `commit_ops`（原子；失败零半树）
    /// - `force_execution_unknown`：commit 前失败 → `note.execution_unknown`
    ///
    /// **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表关闭**。
    pub(crate) fn apply_block_ops_inner(
        &self,
        req: NoteBlockBatchRequest,
    ) -> Result<NoteBlockBatchResult, NoteBackendError> {
        if req.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        self.validate_batch_token_sync(req.batch_id.as_deref())?;

        // A-AGT-07：写中断协议——在任何变异前失败，保证零半写
        if req.force_execution_unknown && !req.dry_run {
            return Err(NoteBackendError::ExecutionUnknown(
                "write interrupted before commit; execution state unknown — do not auto-retry write"
                    .into(),
            ));
        }

        let origin = origin_from_str(req.origin.as_deref());
        // B3：per-doc 锁——plan + dry_run/commit 全程持 doc 锁（原子性不变）
        let arc = self.session_handle(&req.doc_id)?;
        // S3 埋点：获取点前发起计时（锁外），acquire 返回后立即结束；告警锁外析构
        let mut probe = SlowPathProbe::start(&req.doc_id);
        let mut session = arc.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
            tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        probe.finish_lock();

        let plan = plan_block_ops_to_collab(&session, &req.ops)?;
        let applied = plan.previews.len() as u32;
        let preview = plan.previews;
        let block_ids = plan.block_ids;

        if req.dry_run {
            return Ok(NoteBlockBatchResult {
                dry_run: true,
                applied,
                block_ids,
                preview,
            });
        }

        // 空 ops：合法，零写
        if plan.collab_ops.is_empty() {
            return Ok(NoteBlockBatchResult {
                dry_run: false,
                applied: 0,
                block_ids,
                preview,
            });
        }

        commit_ops(&mut session, &self.store, origin, &plan.collab_ops).map_err(map_commit_err)?;

        Ok(NoteBlockBatchResult {
            dry_run: false,
            applied,
            block_ids,
            preview,
        })
    }

    /// 对指定文档的目标块执行 CRDT 文本因果撤销
    pub async fn undo_text_inner(
        &self,
        doc_id: &str,
        block_id: &str,
    ) -> Result<NoteUndoResult, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let bid = BlockId::parse(block_id)
            .map_err(|e| NoteBackendError::Invalid(format!("invalid block_id: {e}")))?;

        let arc = self.session_handle(doc_id)?;
        let mut probe = SlowPathProbe::start(doc_id);
        let mut session = arc.lock().unwrap_or_else(|e| {
            tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        probe.finish_lock();

        let rev_before = session.rev();
        match session.text_undo(bid) {
            Ok(new_text) => Ok(NoteUndoResult {
                doc_id: doc_id.to_string(),
                block_id: block_id.to_string(),
                rev: session.rev(),
                text: new_text,
                is_noop: false,
            }),
            Err(conex_doc_collab::ApplyError::Undo(conex_doc_collab::UndoError::Empty)) => {
                let current_text = session
                    .tree()
                    .nodes
                    .get(&bid)
                    .and_then(|n| n.text_snapshot.clone())
                    .unwrap_or_default();
                Ok(NoteUndoResult {
                    doc_id: doc_id.to_string(),
                    block_id: block_id.to_string(),
                    rev: rev_before,
                    text: current_text,
                    is_noop: true,
                })
            }
            Err(e) => Err(NoteBackendError::ApplyFailed(e.to_string())),
        }
    }

    /// 对指定文档的目标块执行 CRDT 文本因果重做
    pub async fn redo_text_inner(
        &self,
        doc_id: &str,
        block_id: &str,
    ) -> Result<NoteRedoResult, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let bid = BlockId::parse(block_id)
            .map_err(|e| NoteBackendError::Invalid(format!("invalid block_id: {e}")))?;

        let arc = self.session_handle(doc_id)?;
        let mut probe = SlowPathProbe::start(doc_id);
        let mut session = arc.lock().unwrap_or_else(|e| {
            tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        probe.finish_lock();

        let rev_before = session.rev();
        match session.text_redo(bid) {
            Ok(new_text) => Ok(NoteRedoResult {
                doc_id: doc_id.to_string(),
                block_id: block_id.to_string(),
                rev: session.rev(),
                text: new_text,
                is_noop: false,
            }),
            Err(conex_doc_collab::ApplyError::Undo(conex_doc_collab::UndoError::Empty)) => {
                let current_text = session
                    .tree()
                    .nodes
                    .get(&bid)
                    .and_then(|n| n.text_snapshot.clone())
                    .unwrap_or_default();
                Ok(NoteRedoResult {
                    doc_id: doc_id.to_string(),
                    block_id: block_id.to_string(),
                    rev: rev_before,
                    text: current_text,
                    is_noop: true,
                })
            }
            Err(e) => Err(NoteBackendError::ApplyFailed(e.to_string())),
        }
    }
}
