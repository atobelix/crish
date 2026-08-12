//! 真实笔记运行时：`NoteBackend` ← DocSession + WorkspaceStore + apply_md_fragment。
//!
//! # 管线
//! ```ignore
//! apply_md_fragment(req)
//!   → NoteBatchTokens 校验（可选 batch_id）
//!   → intent_id 幂等表
//!   → conex_md_ast::apply_md_fragment(session.tree(), parent, md) → ApplyReport{ops,lossy,..}
//!   → commit_ops(session, store, origin, &ops)  // apply + projection 索引
//!   → NoteApplyMdResult { block_ids, inserted, idempotent, lossy }  // W4-A：lossy 进工具 result
//!
//! apply_block_ops(req)  // W4-F 余量：块级 ops 真路径
//!   → plan NoteBlockOp → collab Op
//!   → dryRun? preview 零写 : commit_ops 原子批
//! ```
//!
//! # 诚实边界（W4-A / W4-F）
//! - **已交付**：Store 路径映射 `ApplyReport.lossy` → 工具契约 `NoteLossyReport`
//! - **已交付**：`StoreNoteBackend::apply_block_ops` 真写入（非默认 trait 拒写）
//! - **≠ EL-05**；**≠ A-AGT 满表**；**≠ W6-E**
//!
//! # 会话策略
//! 进程内 `Mutex<HashMap<doc_id, DocSession>>`：
//! - 首次打开：`load_doc` → `DocSession::hydrate`（G-HYD-2 可逆结构 snapshot）
//!   + `with_persistence(SharedWorkspaceStore)`。
//! - 同进程后续写走同一 session 树（零半树由 collab 原子 apply 保证）。
//! - **读路径**（`query_blocks` / 大纲 / `get_md`）走 store 投影 / FTS /
//!   session 树即时 `document_to_md`，**禁止**读 MD mirror 文件。
//! - **打开投影**：[`StoreNoteBackend::hydrate_document_from_session`] 走真
//!   `DocSession::hydrate` + CDCS 树投影（`hydrate_path=doc-session`）；
//!   **≠** `query_blocks` 派生（`hydrate_path=query-blocks`）。
//!
//! # 诚实边界（hydrate 投影）
//! - 真路径可测 **≠** 产品「打开完成」（G-HYD 全条件）
//! - **≠ EL-04 / EL-01**；禁止静默把 query 结果标成 full hydrate
//!
//! # 工厂
//! [`NoteRuntime::open`] / [`StoreNoteBackend::open`] 供 workbench engine 挂载
//! （见 engine.rs「R6 挂点」注释）。

#![allow(missing_docs)]

mod hydrate_projection;
mod store_backend;

pub use hydrate_projection::{
    project_session_tree, projection_from_session, DocSessionHydrateBlock,
    DocSessionHydrateProjection, HYDRATE_PATH_DOC_SESSION, HYDRATE_PATH_QUERY_BLOCKS,
};
pub use store_backend::StoreNoteBackend;

use agent_tools::note_backend::NoteBackendHandle;
use std::path::Path;
use std::sync::Arc;

/// 笔记运行时工厂（engine / 测试装配入口）。
pub struct NoteRuntime;

impl NoteRuntime {
    /// 打开（或创建）workspace.db 上的真实 [`StoreNoteBackend`]。
    ///
    /// 返回 `Arc<dyn NoteBackend>`，可直接注入
    /// `ToolContext.note_backend` / `ToolExecCtx.note_backend` /
    /// `SessionLoopOptions.note_backend`。
    pub fn open(path: impl AsRef<Path>) -> Result<NoteBackendHandle, conex_workspace_store::StoreError> {
        Ok(Arc::new(StoreNoteBackend::open(path)?) as NoteBackendHandle)
    }

    /// 从已有 [`conex_workspace_store::SharedWorkspaceStore`] 构造。
    pub fn from_store(store: conex_workspace_store::SharedWorkspaceStore) -> NoteBackendHandle {
        Arc::new(StoreNoteBackend::from_store(store)) as NoteBackendHandle
    }
}
