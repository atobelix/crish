//! Store 文档会话 hydrate / 冷热打开投影（**SD-06** 纵向切开）
//!
//! 从 `store_backend` 巨石抽出：
//! - [`StoreNoteBackend::session_handle`]：**B3 per-doc 分片锁**（map 锁短临界
//!   索引 + doc 锁长临界）+ `load_doc` → `DocSession::hydrate` → with_persistence
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
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use crate::hydrate_projection::{
    projection_from_session, DocSessionHydrateProjection, HYDRATE_PATH_DOC_SESSION,
};
use crate::poison::POISON_RECOVERIES;
use crate::store_backend::{SlowPathProbe, StoreNoteBackend};

impl StoreNoteBackend {
    /// 取 doc 会话锁句柄（**B3 per-doc 分片锁** + **C2 首开 TOCTOU 去重**）。
    ///
    /// - 快路径：map 锁内 `get`（短临界，不持 doc 锁）；命中直接返回
    /// - 慢路径（仅首次打开）：取 per-doc **hydrate 许可锁**串行化同 doc 首开，
    ///   仅持许可者做一次 `load_doc` → `DocSession::hydrate`（I/O 出 map 锁），
    ///   然后锁内查插（复用先插者的 session）；并发等待许可者在许可释放后
    ///   命中快路径或复用已插 session——**不重复 I/O**。不同 doc 的首次打开
    ///   互不串行。同 doc 单写者不变式由 per-doc 锁保证（G-HYD-2）
    pub(crate) fn session_handle(
        &self,
        doc_id: &str,
    ) -> Result<Arc<Mutex<DocSession>>, NoteBackendError> {
        // 快路径：map 锁短临界（索引 get）
        if let Some(arc) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(doc_id)
            .cloned()
        {
            return Ok(arc);
        }
        // C2：慢路径去重——取 per-doc hydrate 许可锁（不同 doc 互不串行）
        let permit = {
            let mut hydrating = self
                .hydrating
                .lock()
                .unwrap_or_else(|e| {
                    tracing::error!(target: "conex_note_runtime", "hydrating 索引锁中毒，按恢复模式继续：{e}");
                    POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                    e.into_inner()
                });
            hydrating
                .entry(doc_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        // 持许可锁：同 doc 并发首开在此串行，仅持许可者进入下方 hydrate
        let _permit_guard = permit.lock().unwrap_or_else(|e| {
            tracing::error!(target: "conex_note_runtime", "hydrating 许可锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        // double-checked：持许可后重新检查 sessions——另一线程可能已完成 hydrate
        if let Some(arc) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .get(doc_id)
            .cloned()
        {
            return Ok(arc);
        }
        // 慢路径（首次打开）：load_doc + hydrate 不持 map 锁（I/O 出锁）
        let blob = self
            .store
            .load_doc(doc_id)
            .map_err(|e| NoteBackendError::ApplyFailed(format!("load_doc: {e}")))?;
        let session = DocSession::hydrate(doc_id.to_string(), blob)
            .map_err(|e| NoteBackendError::ApplyFailed(format!("hydrate: {e}")))?
            .with_persistence(Box::new(self.store.clone()));
        // map 锁内查插原子性：并发 ensure 同 doc 时复用已在表中的会话
        let mut map = self
            .sessions
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
        Ok(match map.entry(doc_id.to_string()) {
            std::collections::hash_map::Entry::Occupied(e) => e.get().clone(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let arc = Arc::new(Mutex::new(session));
                e.insert(arc.clone());
                arc
            }
        })
    }

    /// 冷开：从索引摘除 doc 会话；排空旧会话在途写后返回。
    ///
    /// 排空保证同 doc 单写者不变式——新会话随后从**已提交**状态 hydrate，
    /// 不出现新旧双会话分叉。
    pub(crate) fn remove_session_for_cold(&self, doc_id: &str) {
        let old = self
            .sessions
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .remove(doc_id);
        // C2：同步清理 per-doc hydrate 许可条目（冷开摘除后无并发首开在途）
        self.hydrating
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "conex_note_runtime", "hydrating 索引锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            })
            .remove(doc_id);
        if let Some(old) = old {
            // 排空旧会话在途写（doc 锁长临界）；随后 hydrate 读到最新已提交状态
            // S3 埋点：获取点前发起计时（锁外），acquire 返回后立即结束；告警锁外析构
            let mut probe = SlowPathProbe::start(doc_id);
            let _guard = old.lock().unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
            probe.finish_lock();
        }
    }

    /// 真 `DocSession::hydrate` / CDCS 树打开投影（G-HYD-2 方向）。
    ///
    /// # 路径
    /// [`Self::session_handle`]（`load_doc` → **`DocSession::hydrate`**）→ 文档序
    /// DFS 投影；`hydrate_path` 恒 [`HYDRATE_PATH_DOC_SESSION`]。
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
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        let limit = limit.clamp(1, 200) as usize;
        let arc = self.session_handle(doc_id)?;
        // S3 埋点：获取点前发起计时（锁外），acquire 返回后立即结束；告警锁外析构
        let mut probe = SlowPathProbe::start(doc_id);
        let session = arc
            .lock()
            .unwrap_or_else(|e| {
                // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续（B1-1 观测化）
                tracing::error!(target: "conex_note_runtime", "sessions per-doc 锁中毒，按恢复模式继续：{e}");
                POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
                e.into_inner()
            });
        probe.finish_lock();
        let proj = projection_from_session(&session, doc_id, limit);
        drop(session);
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
            return Err(NoteBackendError::Invalid("doc_id must be non-empty".into()));
        }
        self.remove_session_for_cold(doc_id);
        self.hydrate_document_from_session(doc_id, limit)
    }
}
