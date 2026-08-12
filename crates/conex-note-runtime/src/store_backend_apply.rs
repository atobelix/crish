//! Store apply / query / 产品 IPC 长实现（**SD-29** 再切）
//!
//! 从 `store_backend` 门面抽出：
//! - [`StoreNoteBackend::apply_collab_ops_json`]（CONN-B3 collab wire）
//! - [`StoreNoteBackend::apply_block_ops_inner`]（W4-F 批 apply）
//! - [`StoreNoteBackend::query_blocks_inner`]（投影索引读）
//! - [`StoreNoteBackend::document_to_md`]（即时 S）
//! - detect / import 提案 / export 基线（A-INV-02 / W2-E）
//!
//! # SD-29 边界
//! - **本模块职责**：写路径 apply + 读路径 query + 镜像产品入口的长实现
//! - **不**重做 [`crate::store_plan_ops`] / [`crate::store_hydrate`] /
//!   [`crate::store_apply_md`] / [`crate::store_outline`]（SD-06 已切，禁止整包）
//! - **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 满表**
//! - **≠ EL-01 / EL-03 / EL-04**；本包只切结构，不抬关

use agent_tools::note_backend::{
    NoteBackendError, NoteBlockBatchRequest, NoteBlockBatchResult, NoteQueryBlockHit,
    NoteQueryBlocksParams, NoteQueryBlocksResult,
};
use conex_doc_collab::BlockTree;
use conex_workspace_store::{
    commit_ops, ImportMirrorOpts, ImportMirrorResult, MirrorDriftReport, QueryBlocksParams,
    ThreeWayStrategy,
};
use std::path::Path;

use crate::store_backend::{map_commit_err, map_store_err, origin_from_str, StoreNoteBackend};
use crate::store_hydrate::ensure_session;
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
    /// 同步版即时 S（测试 / 进程内）；语义同 [`agent_tools::note_backend::NoteBackend::get_md`]。
    ///
    /// - 有 session：`document_to_md`（含 `<!--c:UUID-->`）
    /// - 无 session / 空树：`Ok("")`（对齐 trait 探测语义，**不**读 mirror）
    pub fn document_to_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        match sessions.get(doc_id) {
            Some(session) if !session.tree().root_children.is_empty() => {
                Ok(conex_md_ast::document_to_md(session.tree()))
            }
            // 无 session 或空树：与 NoteBackend::get_md 契约一致
            _ => Ok(String::new()),
        }
    }

    // ── A-INV-02 / W2-E 产品 IPC 装配（detect / import 提案）──────────
    //
    // 纪律：
    // - 仅暴露 store detect / import_mirror_proposal；**不** apply
    // - **不**实现 poll timer / OS watcher 双开（≠ EL-03 / ≠ inotify 满关）
    // - X-05：unpushed>0 且非 DropUnacked → Conflict + silent_overwrite_blocked

    /// 解析权威 rev：显式入参 → session.rev → store.load_rev → 0。
    fn resolve_authority_rev(
        &self,
        doc_id: &str,
        authority_rev: Option<u64>,
    ) -> Result<u64, NoteBackendError> {
        if let Some(r) = authority_rev {
            return Ok(r);
        }
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = sessions.get(doc_id) {
            return Ok(session.rev());
        }
        drop(sessions);
        let loaded = self.store.load_rev(doc_id).map_err(map_store_err)?;
        Ok(if loaded < 0 { 0 } else { loaded as u64 })
    }

    /// detect：mtime/hash vs `mirror_meta` → 三路分类报告。
    ///
    /// `authority_rev=None` 时取 session / store 水位。
    /// **≠** poll/inotify 产品满关；本 API 是可点名 IPC 入口。
    pub fn detect_mirror_drift(
        &self,
        doc_id: &str,
        authority_rev: Option<u64>,
    ) -> Result<MirrorDriftReport, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let rev = self.resolve_authority_rev(doc_id, authority_rev)?;
        self.store
            .detect_mirror_drift(doc_id, rev)
            .map_err(map_store_err)
    }

    /// import 提案：Op 批 **或** 冲突；**永不** apply / **禁**静默盖 unpushed（X-05）。
    ///
    /// - `use_session_tree=true`（默认）：从 DocSession 取权威树做块级 diff
    /// - 无 session 时树为 `None` → store 侧可返回 Conflict（缺 authority_tree）
    pub fn import_mirror_proposal(
        &self,
        doc_id: &str,
        strategy: ThreeWayStrategy,
        unpushed_op_count: usize,
        authority_rev: Option<u64>,
        use_session_tree: bool,
    ) -> Result<ImportMirrorResult, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let rev = self.resolve_authority_rev(doc_id, authority_rev)?;

        // 先克隆树，再释放 sessions 锁，避免与 store I/O 长持锁
        let tree_owned: Option<BlockTree> = if use_session_tree {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            // 尽量 ensure：有 blob 则 hydrate；失败不阻断（import 仍可 Conflict）
            let _ = ensure_session(&mut sessions, &self.store, doc_id);
            sessions.get(doc_id).map(|s| s.tree().clone())
        } else {
            None
        };

        let opts = ImportMirrorOpts {
            strategy,
            unpushed_op_count,
            authority_tree: tree_owned.as_ref(),
        };
        self.store
            .import_mirror_proposal(doc_id, rev, &opts)
            .map_err(map_store_err)
    }

    /// 将当前 session 树 export 到 `mirror_root`（写 fingerprint + mirror_meta）。
    ///
    /// 供 detect/import 产品链路与 IPC 集成测建立基线；**不是** 读权威路径。
    /// `rev=None` 时用 session.rev。
    pub fn export_md_mirror_from_session(
        &self,
        doc_id: &str,
        mirror_root: &Path,
        rev: Option<u64>,
    ) -> Result<std::path::PathBuf, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        ensure_session(&mut sessions, &self.store, doc_id)?;
        let session = sessions
            .get(doc_id)
            .ok_or_else(|| NoteBackendError::NotFound(format!("no session: {doc_id}")))?;
        let export_rev = rev.unwrap_or_else(|| session.rev());
        let tree = session.tree().clone();
        drop(sessions);
        self.store
            .export_md_mirror(doc_id, &tree, export_rev, mirror_root)
            .map_err(map_store_err)
    }

    /// 投影索引读（由 [`agent_tools::note_backend::NoteBackend::query_blocks`] 委托）。
    ///
    /// 读投影索引 / FTS——**禁止** mirror 文件。
    pub(crate) fn query_blocks_inner(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        if params.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        let store_params = QueryBlocksParams {
            doc_id: params.doc_id,
            kind_in: params.kind_in,
            attrs_eq: params.attrs_eq.map(|m| m.into_iter().collect()),
            text_match: params.text_match,
            ref_to: params.ref_to,
            ref_from: params.ref_from,
            limit: params.limit.map(|n| n as usize),
        };

        let result = self
            .store
            .query_blocks(&store_params)
            .map_err(map_store_err)?;

        Ok(NoteQueryBlocksResult {
            blocks: result
                .blocks
                .into_iter()
                .map(|h| NoteQueryBlockHit {
                    id: h.id,
                    kind: h.kind,
                    snippet: h.snippet,
                    attrs: h.attrs,
                })
                .collect(),
            truncated: result.truncated,
        })
    }

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
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        ensure_session(&mut sessions, &self.store, doc_id)?;
        let session = sessions
            .get_mut(doc_id)
            .expect("ensure_session just inserted or existing");
        if ops.is_empty() {
            return Ok(ApplyCollabOpsOutcome {
                rev: session.rev(),
                applied: 0,
            });
        }
        commit_ops(session, &self.store, origin, &ops).map_err(map_commit_err)?;
        Ok(ApplyCollabOpsOutcome {
            rev: session.rev(),
            applied: ops.len() as u32,
        })
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
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        ensure_session(&mut sessions, &self.store, &req.doc_id)?;
        let session = sessions
            .get_mut(&req.doc_id)
            .expect("ensure_session just inserted");

        let plan = plan_block_ops_to_collab(session, &req.ops)?;
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

        commit_ops(session, &self.store, origin, &plan.collab_ops).map_err(map_commit_err)?;

        Ok(NoteBlockBatchResult {
            dry_run: false,
            applied,
            block_ids,
            preview,
        })
    }
}
