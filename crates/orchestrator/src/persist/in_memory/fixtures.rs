//! InMemoryStore 构造与测试观测/注入辅助（不承载 Store 契约实现）。

use super::*;

impl InMemoryStore {
    /// 新建空的内存存储
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(InMemoryInner::default())),
        }
    }

    /// 注入持久化事件追加延迟（模拟慢 store；仅测试用）
    pub fn set_append_delay(&self, delay: Duration) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.append_delay = delay;
        }
    }

    /// 注入一次追加失败（每次 append 消费一条；耗尽后恢复正常）
    pub fn fail_next_append(&self, message: impl Into<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.next_failures.push(message.into());
        }
    }

    /// 注入持续追加失败（模拟 store 彻底损坏，写失败 latch）
    pub fn fail_all_appends(&self, message: impl Into<String>) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.fail_all_message = Some(message.into());
        }
    }

    /// 当前全部 run 记录快照（断言用）
    pub fn runs(&self) -> Vec<StoredRun> {
        self.inner
            .lock()
            .map(|guard| guard.runs.clone())
            .unwrap_or_default()
    }

    /// 当前已落库事件快照（断言用）
    pub fn events(&self) -> Vec<PersistedEvent> {
        self.inner
            .lock()
            .map(|guard| guard.events.clone())
            .unwrap_or_default()
    }

    /// 直接注入待处理输入（测试用，可指定 created_at 精确控制 FIFO 顺序）
    pub fn seed_pending_inputs(&self, inputs: Vec<PendingInput>) {
        if let Ok(mut guard) = self.inner.lock() {
            for input in inputs {
                guard.pending_inputs.retain(|p| p.id != input.id);
                guard.pending_inputs.push(input);
            }
        }
    }

    /// Seed Recovery fork tree entries for restore and snapshot tests.
    pub fn seed_recovery_fork_tree_entry(&self, session_id: &str, entry: RecoveryForkTreeEntry) {
        if let Ok(mut guard) = self.inner.lock() {
            let entries = guard
                .recovery_fork_tree_entries
                .entry(session_id.to_string())
                .or_default();
            entries.retain(|existing| existing.entry.id != entry.entry.id);
            entries.push(entry);
            entries.sort_by_key(|entry| entry.event_sequence);
        }
    }

    /// 读回已落库的压缩块（断言用；与 LocalDb::get_block 同形）
    pub fn compression_block(
        &self,
        session_id: &str,
        block_id: &str,
    ) -> Option<CompactionBlockRow> {
        self.inner
            .lock()
            .ok()?
            .compression_blocks
            .iter()
            .find(|block| block.session_id == session_id && block.block_id == block_id)
            .cloned()
    }

    /// 预置子代理行（测试/恢复对账夹具；等价 session_agents 表 seed）。
    pub fn seed_session_agent(&self, agent: SessionAgent) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.session_agents.push(agent);
        }
    }

    /// 读回子代理行（断言用）。
    pub fn session_agents(&self) -> Vec<SessionAgent> {
        self.inner
            .lock()
            .map(|guard| guard.session_agents.clone())
            .unwrap_or_default()
    }
}
