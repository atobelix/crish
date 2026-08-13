//! PersistencePlugin 冻结形状（W0-D / plans/interfaces/00）。
//!
//! **CT-01 CAS**：`on_committed_expect` = 版本期望比对的条件提交。
//! **CAS = 检测并报错，不自动合并**；跨进程陈旧写与同进程双会话写同一 doc
//! 均受保护（版本不符 → [`PersistError::Conflict`]）。默认实现忽略期望值
//!（委托 `on_committed`，旧 LWW 行为），既有实现者零改动。

use crate::op::Origin;
use crate::tx::TxId;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncodedUpdate {
    pub bytes: Vec<u8>,
    pub kind: UpdateKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind {
    Structure,
    Text,
    Combined,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitBatch {
    pub tx_id: TxId,
    pub origin: Origin,
    pub updates: Vec<EncodedUpdate>,
    pub snapshot_tick: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HydrateBlob {
    pub snapshot: Option<Vec<u8>>,
    pub pending: Vec<EncodedUpdate>,
}

#[derive(Debug, Error)]
pub enum PersistError {
    #[error("not found")]
    NotFound,
    #[error("io: {0}")]
    Io(String),
    #[error("corrupt: {0}")]
    Corrupt(String),
    /// CT-01 CAS：期望版本不匹配（陈旧写被拦截）。Display 含稳定 `conflict` 标识，
    /// 供既有错误透传链（ApplyError → CommitPipelineError → NoteBackendError）识别。
    #[error("conflict: rev 已前进，期望 {expect} 不匹配")]
    Conflict { expect: u64 },
}

/// 01↔02 闸门接口。实现放在 conex-workspace-store。
pub trait PersistencePlugin: Send + Sync {
    fn load_doc(&self, doc_id: &str) -> Result<HydrateBlob, PersistError>;
    fn on_committed(&self, doc_id: &str, commit: &CommitBatch) -> Result<(), PersistError>;
    fn flush_hint(&self, doc_id: &str) -> Result<(), PersistError>;

    /// CT-01 CAS 版 `on_committed`：`expect_rev = Some(期望)` 时按期望版本条件更新，
    /// 版本不符 → [`PersistError::Conflict`]。**CAS = 检测并报错，不自动合并**。
    /// 默认实现忽略期望值（委托 `on_committed`，旧 LWW 行为），既有实现者零改动。
    fn on_committed_expect(
        &self,
        doc_id: &str,
        commit: &CommitBatch,
        expect_rev: Option<u64>,
    ) -> Result<(), PersistError> {
        let _ = expect_rev;
        self.on_committed(doc_id, commit)
    }
}

/// 内存 mock：契约测 / G-HYD 往返用。
///
/// `on_committed` 会把 **Structure** 更新写入 `blob.snapshot`（整树可逆载荷），
/// 并清空 pending（结构 snapshot 已含 `text_snapshot`，足够 hydrate）。
#[derive(Default)]
#[allow(dead_code)] // 公共 mock；生产路径用 WorkspaceStore，单测直接构造
pub struct MemoryPersistence {
    pub last_commit: std::sync::Mutex<Option<CommitBatch>>,
    pub blob: std::sync::Mutex<HydrateBlob>,
}

impl PersistencePlugin for MemoryPersistence {
    fn load_doc(&self, _doc_id: &str) -> Result<HydrateBlob, PersistError> {
        Ok(self.blob.lock().expect("lock").clone())
    }

    fn on_committed(&self, _doc_id: &str, commit: &CommitBatch) -> Result<(), PersistError> {
        *self.last_commit.lock().expect("lock") = Some(commit.clone());
        let mut blob = self.blob.lock().expect("lock");
        for u in &commit.updates {
            match u.kind {
                // 整树 snapshot：最新结构即完整权威（G-HYD-1）
                UpdateKind::Structure | UpdateKind::Combined => {
                    blob.snapshot = Some(u.bytes.clone());
                    // 文本已嵌在 tree.text_snapshot；清空 pending 避免无限增长
                    blob.pending.clear();
                }
                UpdateKind::Text => {
                    // 无结构帧时仍可累积文本 pending（稀有路径）
                    blob.pending.push(u.clone());
                }
            }
        }
        Ok(())
    }

    fn flush_hint(&self, _doc_id: &str) -> Result<(), PersistError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::op::Origin;
    use crate::tx::TxId;

    #[test]
    fn memory_plugin_roundtrip_empty() {
        let p = MemoryPersistence::default();
        let h = p.load_doc("d1").unwrap();
        assert!(h.snapshot.is_none());
        assert!(h.pending.is_empty());
        let batch = CommitBatch {
            tx_id: TxId::new(),
            origin: Origin::User,
            updates: vec![],
            snapshot_tick: true,
        };
        p.on_committed("d1", &batch).unwrap();
        assert!(p.last_commit.lock().unwrap().is_some());
    }
}
