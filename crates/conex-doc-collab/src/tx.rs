use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 跨引擎同源事务 id（A-INV-09b）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TxId(Uuid);

impl TxId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TxId {
    fn default() -> Self {
        Self::new()
    }
}

/// 事务守卫：结构与文本必须同批提交/回滚（A-INV-09a）。
#[derive(Debug)]
pub struct TxGuard {
    pub id: TxId,
    open: bool,
}

impl TxGuard {
    pub fn begin() -> Self {
        Self {
            id: TxId::new(),
            open: true,
        }
    }

    pub fn id(&self) -> TxId {
        self.id
    }

    pub fn commit(mut self) {
        self.open = false;
    }

    pub fn rollback(mut self) {
        self.open = false;
    }

    pub fn is_open(&self) -> bool {
        self.open
    }
}
