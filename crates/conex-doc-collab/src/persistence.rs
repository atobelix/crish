//! PersistencePlugin 冻结形状（W0-D / plans/interfaces/00）。

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
}

/// 01↔02 闸门接口。实现放在 conex-workspace-store。
pub trait PersistencePlugin: Send + Sync {
    fn load_doc(&self, doc_id: &str) -> Result<HydrateBlob, PersistError>;
    fn on_committed(&self, doc_id: &str, commit: &CommitBatch) -> Result<(), PersistError>;
    fn flush_hint(&self, doc_id: &str) -> Result<(), PersistError>;
}

/// 内存 mock：契约测用。
#[derive(Default)]
#[allow(dead_code)]
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
