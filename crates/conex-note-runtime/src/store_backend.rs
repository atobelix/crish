//! [`StoreNoteBackend`]：真实 store + DocSession 管线实现 `NoteBackend`。
//!
//! # SD-06 纵向切开（薄 facade）
//! 本文件为 **门面 + 公开构造 + NoteBackend trait 接线**；业务实现分模：
//! - [`crate::store_plan_ops`]：`plan_block_ops_to_collab`（plan→collab）
//! - [`crate::store_hydrate`]：`ensure_session` / hydrate 冷热投影
//! - [`crate::store_apply_md`]：`apply_md_fragment` 真路径 + lossy
//! - [`crate::store_outline`]：大纲 DFS / 投影表
//! - [`store_backend_tests`]：集成测旁挂（`#[cfg(test)]`）
//!
//! # hydrate 投影（与 query 分轨）
//! - [`Self::hydrate_document_from_session`]：`load_doc` → **`DocSession::hydrate`**
//!   → CDCS 树 DFS 投影（`hydrate_path=doc-session`）
//! - `query_blocks`：派生索引读路径（`hydrate_path=query-blocks` 若被映射为打开投影）
//! - **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04 / EL-01**
//!
//! # 诚实边界
//! - **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**
//! - SD-06 **仅结构切开**，不抬关任何 EL / A-AGT

use agent_tools::note_backend::{
    NoteApplyMdRequest, NoteApplyMdResult, NoteBackend, NoteBackendError, NoteBatchTokens,
    NoteBlockBatchRequest, NoteBlockBatchResult, NoteOutline, NoteQueryBlockHit,
    NoteQueryBlocksParams, NoteQueryBlocksResult,
};
use async_trait::async_trait;
use conex_doc_collab::{BlockTree, DocSession, Origin};
use conex_workspace_store::{
    commit_ops, ImportMirrorOpts, ImportMirrorResult, MirrorDriftReport, QueryBlocksParams,
    SharedWorkspaceStore, StoreError, ThreeWayStrategy,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::store_hydrate::ensure_session;
use crate::store_plan_ops::plan_block_ops_to_collab;

/// 真实笔记后端：SharedWorkspaceStore + 进程内 DocSession 表 + intent 幂等。
///
/// # 不变量
/// - 写路径仅 `apply_md_fragment` / [`Self::apply_block_ops`] → Ops → `commit_ops`
///   （权威 updates + 投影索引）；**禁止** fs.write 当权威
/// - 读路径即时投影 / session 树 / `document_to_md`；**不**读 MD mirror 文件
/// - 同 `intent_id` 二次调用返回首次结果（`idempotent=true`, `inserted=0`）
/// - batch token：内嵌 [`NoteBatchTokens`]（与 Memory 后端同语义）
/// - **W4-A**：`ApplyReport.lossy` → [`NoteApplyMdResult::lossy`]（工具 result 可观测；
///   **禁止**只写 ops 丢 lossy）。**≠ EL-05 / ≠ A-AGT 满表**。
/// - **W4-F 余量**：`apply_block_ops` 真路径（dryRun 零写 / 原子 commit /
///   `force_execution_unknown` 不半写）。**≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表**。
pub struct StoreNoteBackend {
    pub(crate) store: SharedWorkspaceStore,
    /// 进程内打开的文档会话（唯一写入口持有者）。
    pub(crate) sessions: Mutex<HashMap<String, DocSession>>,
    /// intent_id → 首次 apply 结果（send_to_note 幂等）
    pub(crate) intents: Mutex<HashMap<String, NoteApplyMdResult>>,
    pub(crate) batch_tokens: NoteBatchTokens,
}

impl std::fmt::Debug for StoreNoteBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let n_sessions = self
            .sessions
            .lock()
            .map(|m| m.len())
            .unwrap_or(0);
        let n_intents = self
            .intents
            .lock()
            .map(|m| m.len())
            .unwrap_or(0);
        f.debug_struct("StoreNoteBackend")
            .field("path", &self.store.path())
            .field("open_sessions", &n_sessions)
            .field("intent_cache", &n_intents)
            .finish()
    }
}

impl StoreNoteBackend {
    /// 打开（或创建）workspace.db。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Ok(Self::from_store(SharedWorkspaceStore::open(path)?))
    }

    /// 从已有共享 store 构造。
    pub fn from_store(store: SharedWorkspaceStore) -> Self {
        Self {
            store,
            sessions: Mutex::new(HashMap::new()),
            intents: Mutex::new(HashMap::new()),
            batch_tokens: NoteBatchTokens::new(),
        }
    }

    /// 自定义 batch TTL（测试）。
    pub fn with_batch_ttl(mut self, ttl: Duration) -> Self {
        self.batch_tokens = NoteBatchTokens::with_ttl(ttl);
        self
    }

    /// 暴露 batch token 管理（测试 / 会话装配）。
    pub fn batch_tokens(&self) -> &NoteBatchTokens {
        &self.batch_tokens
    }

    /// 底层 store 句柄。
    pub fn store(&self) -> &SharedWorkspaceStore {
        &self.store
    }

    /// 同步版即时 S（测试 / 进程内）；语义同 [`NoteBackend::get_md`]。
    ///
    /// - 有 session：`document_to_md`（含 `<!--c:UUID-->`）
    /// - 无 session / 空树：`Ok("")`（对齐 trait 探测语义，**不**读 mirror）
    pub fn document_to_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
            return Err(NoteBackendError::Invalid(
                "doc_id must be non-empty".into(),
            ));
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
            return Err(NoteBackendError::Invalid(
                "doc_id must be non-empty".into(),
            ));
        }
        let rev = self.resolve_authority_rev(doc_id, authority_rev)?;

        // 先克隆树，再释放 sessions 锁，避免与 store I/O 长持锁
        let tree_owned: Option<BlockTree> = if use_session_tree {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
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
            return Err(NoteBackendError::Invalid(
                "doc_id must be non-empty".into(),
            ));
        }
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

    /// 同步校验 batch token（apply_md / apply_block_ops 共用）。
    pub(crate) fn validate_batch_token_sync(
        &self,
        batch_id: Option<&str>,
    ) -> Result<(), NoteBackendError> {
        match batch_id {
            None => Ok(()),
            Some(id) => self.batch_tokens.validate(id),
        }
    }
}

// ── 跨模块错误 / Origin 映射（pub(crate)）──────────────────────────

/// StoreError → NoteBackendError。
pub(crate) fn map_store_err(e: StoreError) -> NoteBackendError {
    NoteBackendError::ApplyFailed(format!("store: {e}"))
}

/// CommitPipelineError → NoteBackendError。
pub(crate) fn map_commit_err(e: conex_workspace_store::CommitPipelineError) -> NoteBackendError {
    use conex_workspace_store::CommitPipelineError;
    match e {
        CommitPipelineError::Apply(ae) => {
            let s = ae.to_string();
            if s.contains("not found") {
                NoteBackendError::NotFound(s)
            } else if s.contains("id") && s.to_lowercase().contains("conflict") {
                NoteBackendError::IdConflict(s)
            } else {
                NoteBackendError::ApplyFailed(s)
            }
        }
        CommitPipelineError::Store(se) => map_store_err(se),
    }
}

/// 从 apply_md 请求取 Origin。
pub(crate) fn origin_from_req(req: &NoteApplyMdRequest) -> Origin {
    origin_from_str(req.origin.as_deref())
}

/// origin 字符串 → collab Origin。
pub(crate) fn origin_from_str(origin: Option<&str>) -> Origin {
    match origin.map(str::trim) {
        Some("agent") | Some("Agent") => Origin::Agent,
        Some("remote") | Some("Remote") => Origin::Remote,
        Some("system") | Some("System") => Origin::System,
        _ => Origin::User,
    }
}

// ── NoteBackend trait ───────────────────────────────────────────────

#[async_trait]
impl NoteBackend for StoreNoteBackend {
    async fn query_blocks(
        &self,
        params: NoteQueryBlocksParams,
    ) -> Result<NoteQueryBlocksResult, NoteBackendError> {
        if params.doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }

        // 读投影索引 / FTS——**禁止** mirror 文件
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

    async fn document_outline(
        &self,
        doc_id: &str,
        max_depth: Option<u32>,
    ) -> Result<NoteOutline, NoteBackendError> {
        if doc_id.trim().is_empty() {
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let max_depth = max_depth.unwrap_or(6).clamp(1, 16);

        // 优先 session 树（文档序 DFS）；否则投影表
        {
            let sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(session) = sessions.get(doc_id) {
                return Ok(Self::build_outline_from_session(session, max_depth));
            }
        }
        self.build_outline_from_store(doc_id, max_depth)
    }

    async fn get_md(&self, doc_id: &str) -> Result<String, NoteBackendError> {
        // 即时 S：委托同步 `document_to_md`（禁止 mirror）
        self.document_to_md(doc_id)
    }

    async fn apply_md_fragment(
        &self,
        req: NoteApplyMdRequest,
    ) -> Result<NoteApplyMdResult, NoteBackendError> {
        self.apply_md_fragment_inner(req).await
    }

    async fn validate_batch_token(&self, batch_id: Option<&str>) -> Result<(), NoteBackendError> {
        self.validate_batch_token_sync(batch_id)
    }

    /// W4-F 余量：Store 真路径批 apply 块 ops（非默认 trait 拒写）。
    ///
    /// - dryRun：规划 preview，**零写**（不 `commit_ops`）
    /// - 实写：`plan` → 单次 `commit_ops`（原子；失败零半树）
    /// - `force_execution_unknown`：commit 前失败 → `note.execution_unknown`
    ///
    /// **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 全表关闭**。
    async fn apply_block_ops(
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
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

// hydrate / apply_md / outline 方法由兄弟模块 `impl StoreNoteBackend` 提供。
// 强制链接：本 crate 内 `mod store_*` 已在 lib.rs 声明。

#[cfg(test)]
#[path = "store_backend_tests.rs"]
mod tests;
