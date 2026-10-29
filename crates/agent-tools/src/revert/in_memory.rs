//! 回退计数的内存测试替身（X-06 T4：仅测试编译）。

use super::{RevertCounterSnapshot, RevertCounterStore};

/// 内存版计数存储（测试替身：进程内计数；不跨重启持久化）。
#[derive(Debug, Default)]
pub struct InMemoryRevertCounterStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, RevertCounterSnapshot>>,
}

impl InMemoryRevertCounterStore {
    /// 新建空存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl RevertCounterStore for InMemoryRevertCounterStore {
    fn load(&self, session_id: &str) -> RevertCounterSnapshot {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
            .unwrap_or_default()
    }

    fn save(&self, session_id: &str, snapshot: RevertCounterSnapshot) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), snapshot);
    }
}
