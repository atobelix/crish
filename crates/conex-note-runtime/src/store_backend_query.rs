//! Store query / 即时 S / 镜像产品入口（**SD-49** 再切）
//!
//! 从 [`crate::store_backend_apply`] 抽出读路径与镜像产品 IPC：
//! - [`StoreNoteBackend::query_blocks_inner`]（投影索引读）
//! - [`StoreNoteBackend::document_to_md`]（即时 S）
//! - detect / import 提案 / export 基线（A-INV-02 / W2-E）
//!
//! # SD-49 边界
//! - **本模块职责**：读路径 query + 即时 S + 镜像 detect/import/export
//! - **不**重做 [`crate::store_backend_apply`] 写路径（apply_collab / apply_block_ops）
//! - **不**重做 SD-06 / SD-29 / SD-39
//! - **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 满表**
//! - **≠** 产品「打开完成」

use agent_tools::note_backend::{
    NoteBackendError, NoteQueryBlockHit, NoteQueryBlocksParams, NoteQueryBlocksResult,
};
use conex_doc_collab::BlockTree;
use conex_workspace_store::{
    ImportMirrorOpts, ImportMirrorResult, MirrorDriftReport, QueryBlocksParams, ThreeWayStrategy,
};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::store_backend::{map_store_err, StoreNoteBackend};

/// 毒丸恢复计数（B1-1 观测化：本文件 sessions 索引锁 / per-doc 锁中毒恢复次数；
/// 对齐 registry.rs「tracing::error! 成对 + 计数」样板，零新依赖）
static POISON_RECOVERIES: AtomicU64 = AtomicU64::new(0);

/// 毒丸恢复计数读取（毒化测断言用；S3 埋点消费面就绪后解除 cfg(test)）
#[cfg(test)]
pub(crate) fn poison_recovery_count() -> u64 {
    POISON_RECOVERIES.load(Ordering::Relaxed)
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
        // B3：map 锁短临界取句柄，doc 锁持读（不同 doc 的 get_md 互不串行）
        let arc = self
            .sessions
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(doc_id)
            .cloned();
        match arc {
            Some(arc) => {
                let session = arc.lock().unwrap_or_else(|e| {
                    // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                    tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
                    POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    e.into_inner()
                });
                if session.tree().root_children.is_empty() {
                    // 无 session 或空树：与 NoteBackend::get_md 契约一致
                    Ok(String::new())
                } else {
                    Ok(conex_md_ast::document_to_md(session.tree()))
                }
            }
            // 无 session 或空树：与 NoteBackend::get_md 契约一致
            None => Ok(String::new()),
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
        // B3：map 锁短临界取句柄，doc 锁持读
        let arc = self
            .sessions
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(doc_id)
            .cloned();
        if let Some(arc) = arc {
            let session = arc.lock().unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
            return Ok(session.rev());
        }
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

        // 先克隆树，再释放 doc 锁，避免与 store I/O 长持锁
        let tree_owned: Option<BlockTree> = if use_session_tree {
            // 尽量 ensure：有 blob 则 hydrate；失败不阻断（import 仍可 Conflict）
            match self.session_handle(doc_id) {
                Ok(arc) => {
                    let session = arc.lock().unwrap_or_else(|e| {
                        // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                        tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
                        POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                        e.into_inner()
                    });
                    Some(session.tree().clone())
                }
                Err(_) => None,
            }
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
        let arc = self.session_handle(doc_id)?;
        let session = arc.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
            tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let export_rev = rev.unwrap_or_else(|| session.rev());
        let tree = session.tree().clone();
        drop(session);
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
}
