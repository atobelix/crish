//! Store 文档会话 hydrate / 冷热打开投影（**SD-06** 纵向切开）
//!
//! 从 `store_backend` 巨石抽出：
//! - [`ensure_session`]：`load_doc` → `DocSession::hydrate` → with_persistence
//! - [`StoreNoteBackend::hydrate_document_from_session`]：热/冷统一投影入口
//! - [`StoreNoteBackend::hydrate_document_cold`]：丢弃 session 后强制冷开
//!
//! # SD-06 边界
//! - **本模块职责**：session 确保 + DocSession 树投影 API
//! - **不**含 plan→collab / apply_md / outline / mirror detect
//! - **≠ EL-04 / EL-01**；真路径可测 **≠** 产品「打开完成」（G-HYD 全条件）
//! - **≠ EL-05**（本包结构切开不抬关）

use agent_tools::note_backend::NoteBackendError;
use conex_doc_collab::{DocSession, PersistencePlugin};
use conex_workspace_store::SharedWorkspaceStore;
use std::collections::HashMap;

use crate::hydrate_projection::{
    projection_from_session, DocSessionHydrateProjection, HYDRATE_PATH_DOC_SESSION,
};
use crate::store_backend::StoreNoteBackend;

/// 确保 doc 会话存在：`load_doc` → `DocSession::hydrate` → with_persistence（G-HYD-2）。
///
/// 结构 encode 为可逆 CDCS 整树 snapshot；空 blob（新文档）→ 空会话合法。
pub(crate) fn ensure_session(
    sessions: &mut HashMap<String, DocSession>,
    store: &SharedWorkspaceStore,
    doc_id: &str,
) -> Result<(), NoteBackendError> {
    if sessions.contains_key(doc_id) {
        return Ok(());
    }
    let blob = store.load_doc(doc_id).map_err(|e| {
        NoteBackendError::ApplyFailed(format!("load_doc: {e}"))
    })?;
    let session = DocSession::hydrate(doc_id.to_string(), blob)
        .map_err(|e| NoteBackendError::ApplyFailed(format!("hydrate: {e}")))?
        .with_persistence(Box::new(store.clone()));
    sessions.insert(doc_id.to_string(), session);
    Ok(())
}

impl StoreNoteBackend {
    /// 真 `DocSession::hydrate` / CDCS 树打开投影（G-HYD-2 方向）。
    ///
    /// # 路径
    /// `ensure_session`（`load_doc` → **`DocSession::hydrate`**）→ 文档序 DFS
    /// 投影；`hydrate_path` 恒 [`HYDRATE_PATH_DOC_SESSION`]。
    ///
    /// # 与 query 分轨
    /// **不是** `query_blocks` 映射；派生索引路径见
    /// [`HYDRATE_PATH_QUERY_BLOCKS`](crate::HYDRATE_PATH_QUERY_BLOCKS)。
    ///
    /// # 诚实边界
    /// - **≠** 产品「打开完成」（仍依赖 G-HYD-1…5 全条件）
    /// - **≠ EL-04 / EL-01**
    /// - 空 `doc_id` → `Invalid`；从未写入的 doc → 空投影合法（rev=0）
    pub fn hydrate_document_from_session(
        &self,
        doc_id: &str,
        limit: u32,
    ) -> Result<DocSessionHydrateProjection, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid(
                "doc_id must be non-empty".into(),
            ));
        }
        let limit = limit.clamp(1, 200) as usize;
        let mut sessions = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        ensure_session(&mut sessions, &self.store, doc_id)?;
        let session = sessions
            .get(doc_id)
            .expect("ensure_session just inserted or existing");
        let proj = projection_from_session(session, doc_id, limit);
        debug_assert_eq!(proj.hydrate_path, HYDRATE_PATH_DOC_SESSION);
        Ok(proj)
    }

    /// 强制冷路径：丢弃进程内 session 后重新 `load_doc` → hydrate → 投影。
    ///
    /// 集成测 / G-HYD-2 方向：模拟「新进程打开」；生产 IPC 默认走
    /// [`Self::hydrate_document_from_session`]（可复用热 session）。
    pub fn hydrate_document_cold(
        &self,
        doc_id: &str,
        limit: u32,
    ) -> Result<DocSessionHydrateProjection, NoteBackendError> {
        let doc_id = doc_id.trim();
        if doc_id.is_empty() {
            return Err(NoteBackendError::Invalid(
                "doc_id must be non-empty".into(),
            ));
        }
        {
            let mut sessions = self
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            sessions.remove(doc_id);
        }
        self.hydrate_document_from_session(doc_id, limit)
    }
}
