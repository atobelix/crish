//! 测试用内存 Store 实现（[InMemoryStore]）
//!
//! 编译门控：仅 `cfg(test)` 或 `feature = "test-support"` 下编入——
//! 本 crate 单测/集成测试直接使用，其他 crate 只能在 `[dev-dependencies]`
//! 启用 `test-support` 后使用；生产构建（普通 `[dependencies]`）不含本模块。
//!
//! - [InMemoryStore::set_append_delay] 模拟慢 store（持久化事件追加耗时，
//!   验证 delta 不阻塞 drive loop）；
//! - [InMemoryStore::fail_next_append] / [InMemoryStore::fail_all_appends]
//!   注入持久化故障（写失败 latch：一旦失败持续失败，与 conex-db 的
//!   failure latch 同构）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conex_db::{BlockState, CompactionBlockRow, PendingInput, RunStatus, StoredRun};
use conex_types::events::RunCacheStats;
use conex_types::session_record::{SessionAgent, SessionMessage};
use conex_types::tool::ContextCompressionRecord;

use super::{PersistedEvent, RecoveryForkTreeEntry, Store, StoreError, StoreResult};
use conex_shared::time::{Clock, SystemClock};

/// 内存实现（测试用）
///
/// - [Self::set_append_delay] 模拟慢 store（持久化事件追加耗时，验证
///   delta 不阻塞 drive loop）；
/// - [Self::fail_next_append] / [Self::fail_all_appends] 注入持久化故障
///   （写失败 latch：一旦失败持续失败，与 conex-db 的 failure latch 同构）。
#[derive(Debug, Clone)]
pub struct InMemoryStore {
    inner: Arc<Mutex<InMemoryInner>>,
}

#[derive(Debug, Default)]
struct InMemoryInner {
    runs: Vec<StoredRun>,
    events: Vec<PersistedEvent>,
    pending_inputs: Vec<PendingInput>,
    recovery_fork_tree_entries: HashMap<String, Vec<RecoveryForkTreeEntry>>,
    /// 会话 → 最近一次已分配 sequence（T08.12：会话级原子计数器的本地镜像）
    sequence_counters: HashMap<String, u64>,
    /// run → run 级缓存统计（runs 表 v5 列的等价内存表）
    run_usage: HashMap<String, RunCacheStats>,
    /// 会话 → 正文消息（session_messages 物化视图的等价内存表）
    session_messages: HashMap<String, Vec<SessionMessage>>,
    /// 子代理行（session_agents 的等价内存表）
    session_agents: Vec<SessionAgent>,
    /// 压缩块（compression_blocks 的等价内存表；按写入顺序保存）
    compression_blocks: Vec<CompactionBlockRow>,
    append_delay: Duration,
    fail_all_message: Option<String>,
    next_failures: Vec<String>,
}

mod fixtures;

impl Default for InMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Store for InMemoryStore {
    async fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> StoreResult<()> {
        let now = SystemClock.now_ms();
        let run = StoredRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            status,
            end_reason: end_reason.map(str::to_string),
            cursor,
            created_at: now,
            updated_at: now,
        };
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        guard.runs.retain(|r| r.run_id != run_id);
        guard.runs.push(run);
        Ok(())
    }

    async fn update_run_status(
        &self,
        run_id: &str,
        status: RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let run = guard
            .runs
            .iter_mut()
            .find(|r| r.run_id == run_id)
            .ok_or_else(|| StoreError::new("update_run_status", format!("run 不存在: {run_id}")))?;
        run.status = status;
        if end_reason.is_some() {
            run.end_reason = end_reason.map(str::to_string);
        }
        if cursor.is_some() {
            run.cursor = cursor.unwrap_or_default();
        }
        run.updated_at = SystemClock.now_ms();
        Ok(())
    }

    async fn reserve_sequence(&self, session_id: &str) -> StoreResult<u64> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        // store 彻底损坏（写失败 latch）时取号同样失败
        if let Some(message) = &guard.fail_all_message {
            return Err(StoreError::new("reserve_sequence", message.clone()));
        }
        // 首次取号：以已落库 max(sequence) 对齐（T08.12 隐式预热，Q24/Q23 兜底）
        let max_persisted = guard
            .events
            .iter()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.sequence)
            .max()
            .unwrap_or(0);
        let counter = guard
            .sequence_counters
            .entry(session_id.to_string())
            .and_modify(|v| *v = (*v).max(max_persisted))
            .or_insert(max_persisted);
        *counter += 1;
        Ok(*counter)
    }

    async fn seed_sequence(&self, session_id: &str, next_sequence: u64) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let counter = guard
            .sequence_counters
            .entry(session_id.to_string())
            .or_insert(0);
        // MAX 语义：只抬高不回退（与 conex-db seed_sequence 一致）
        *counter = (*counter).max(next_sequence.saturating_sub(1));
        Ok(())
    }

    async fn append_event(
        &self,
        session_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> StoreResult<()> {
        // 模拟慢 store 的持久化耗时（delta 路径不会走到这里）
        let delay = self
            .inner
            .lock()
            .map(|guard| guard.append_delay)
            .unwrap_or_default();
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        if let Some(message) = &guard.fail_all_message {
            return Err(StoreError::new("append_event", message.clone()));
        }
        if !guard.next_failures.is_empty() {
            return Err(StoreError::new(
                "append_event",
                guard.next_failures.remove(0),
            ));
        }
        // 对齐 events 表的 UNIQUE(session_id, sequence) 约束
        if guard
            .events
            .iter()
            .any(|e| e.session_id == session_id && e.sequence == sequence)
        {
            return Err(StoreError::new(
                "append_event",
                format!("sequence 重复: {sequence}"),
            ));
        }
        guard.events.push(PersistedEvent {
            session_id: session_id.to_string(),
            sequence,
            event_type: event_type.to_string(),
            payload: payload.to_string(),
            run_id: run_id.map(str::to_string),
            created_at: SystemClock.now_ms().to_string(),
        });
        Ok(())
    }

    async fn query_events(
        &self,
        session_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut events: Vec<PersistedEvent> = guard
            .events
            .iter()
            .filter(|e| e.session_id == session_id && e.sequence > after_sequence)
            .cloned()
            .collect();
        events.sort_by_key(|e| e.sequence);
        if let Some(limit) = limit {
            events.truncate(limit as usize);
        }
        Ok(events)
    }

    async fn load_recovery_fork_tree_entries(
        &self,
        session_id: &str,
    ) -> StoreResult<Vec<RecoveryForkTreeEntry>> {
        self.inner
            .lock()
            .map(|guard| {
                guard
                    .recovery_fork_tree_entries
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default()
            })
            .map_err(|error| StoreError::new("lock", error.to_string()))
    }

    async fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut events: Vec<PersistedEvent> = guard
            .events
            .iter()
            .filter(|e| {
                e.session_id == session_id
                    && e.run_id.as_deref() == Some(run_id)
                    && e.sequence > after_sequence
            })
            .cloned()
            .collect();
        events.sort_by_key(|e| e.sequence);
        if let Some(limit) = limit {
            events.truncate(limit as usize);
        }
        Ok(events)
    }

    async fn max_sequence(&self, session_id: &str) -> StoreResult<u64> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        Ok(guard
            .events
            .iter()
            .filter(|e| e.session_id == session_id)
            .map(|e| e.sequence)
            .max()
            .unwrap_or(0))
    }

    async fn query_events_by_type(
        &self,
        session_id: &str,
        run_id: &str,
        event_type: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> StoreResult<Vec<PersistedEvent>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut events: Vec<PersistedEvent> = guard
            .events
            .iter()
            .filter(|e| {
                e.session_id == session_id
                    && e.run_id.as_deref() == Some(run_id)
                    && e.sequence > after_sequence
                    && e.event_type == event_type
            })
            .cloned()
            .collect();
        events.sort_by_key(|e| e.sequence);
        if let Some(limit) = limit {
            events.truncate(limit as usize);
        }
        Ok(events)
    }

    async fn query_runs(&self) -> StoreResult<Vec<StoredRun>> {
        self.inner
            .lock()
            .map(|guard| guard.runs.clone())
            .map_err(|e| StoreError::new("lock", e.to_string()))
    }

    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let input = PendingInput {
            id: id.to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.map(str::to_string),
            payload: payload.to_string(),
            created_at: SystemClock.now_ms(),
        };
        guard.pending_inputs.retain(|p| p.id != id);
        guard.pending_inputs.push(input);
        Ok(())
    }

    async fn load_pending_inputs(&self, session_id: &str) -> StoreResult<Vec<PendingInput>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut inputs: Vec<PendingInput> = guard
            .pending_inputs
            .iter()
            .filter(|p| p.session_id == session_id)
            .cloned()
            .collect();
        // FIFO：创建时间升序，含 id 决胜（对齐 conex-db load_pending_inputs）
        inputs.sort_by_key(|p| (p.created_at, p.id.clone()));
        Ok(inputs)
    }

    async fn delete_pending_input(&self, id: &str) -> StoreResult<bool> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let before = guard.pending_inputs.len();
        guard.pending_inputs.retain(|p| p.id != id);
        Ok(guard.pending_inputs.len() != before)
    }

    async fn touch_session(&self, _session_id: &str) -> StoreResult<()> {
        // 内存实现无 sessions 表：touch 是「刷新 updated_at」的持久化语义，
        // 内存表没有对应事实，显式实现为空操作（不是 trait 默认兜底）。
        Ok(())
    }

    fn get_run_usage(&self, run_id: &str) -> StoreResult<Option<RunCacheStats>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        Ok(guard.run_usage.get(run_id).cloned())
    }

    fn save_run_usage(&self, run_id: &str, stats: RunCacheStats) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        guard.run_usage.insert(run_id.to_string(), stats);
        Ok(())
    }

    async fn load_running_session_agent_rows(&self) -> StoreResult<Vec<SessionAgent>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        Ok(guard
            .session_agents
            .iter()
            .filter(|agent| agent.status == "running")
            .cloned()
            .collect())
    }

    async fn mark_session_agent_interrupted(
        &self,
        parent_session_id: &str,
        subagent_run_id: &str,
        ended_at_ms: i64,
        summary: &str,
    ) -> StoreResult<usize> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        let mut affected = 0;
        for agent in guard.session_agents.iter_mut().filter(|agent| {
            agent.parent_session_id == parent_session_id
                && agent.subagent_run_id == subagent_run_id
                && agent.status == "running"
        }) {
            agent.status = "failed".to_string();
            agent.ended_at = Some(ended_at_ms);
            agent.summary = Some(summary.to_string());
            agent.resumable = true;
            affected += 1;
        }
        Ok(affected)
    }

    async fn load_session_messages(&self, session_id: &str) -> StoreResult<Vec<SessionMessage>> {
        let guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        Ok(guard
            .session_messages
            .get(session_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn save_session_messages(
        &self,
        session_id: &str,
        messages: &[SessionMessage],
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        guard
            .session_messages
            .insert(session_id.to_string(), messages.to_vec());
        Ok(())
    }

    async fn insert_compression_block(
        &self,
        session_id: &str,
        record: &ContextCompressionRecord,
        sequence: u64,
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        // generation 兜底 = 会话内压缩事件计数（含本次，与 drive 落库顺序一致）
        let generation = record
            .details
            .as_ref()
            .and_then(|details| details.get("generation"))
            .and_then(serde_json::Value::as_u64)
            .map(|generation| generation as u32)
            .unwrap_or_else(|| {
                guard
                    .events
                    .iter()
                    .filter(|event| {
                        event.session_id == session_id
                            && event.event_type == "context-compression-end"
                    })
                    .count() as u32
            })
            .max(1);
        // prev 兜底 = 链尾块（generation 最大者；对齐 list_blocks 首条）
        let prev_block_id = record
            .details
            .as_ref()
            .and_then(|details| details.get("prevBlockId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                guard
                    .compression_blocks
                    .iter()
                    .filter(|block| block.session_id == session_id)
                    .max_by_key(|block| block.generation)
                    .map(|block| block.block_id.clone())
            });
        let row =
            crate::blocks::build_block_row(session_id, record, sequence, generation, prev_block_id);
        // INSERT OR IGNORE 语义：同 (session_id, block_id) 重放不重复行
        if !guard
            .compression_blocks
            .iter()
            .any(|block| block.session_id == row.session_id && block.block_id == row.block_id)
        {
            guard.compression_blocks.push(row);
        }
        Ok(())
    }

    fn update_compression_block_summary(
        &self,
        session_id: &str,
        block_id: &str,
        state: BlockState,
        summary_json: Option<&str>,
        attempts: u32,
    ) -> StoreResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| StoreError::new("lock", e.to_string()))?;
        // 行不存在 → Ok 无操作（对齐 LocalDb::update_block_state）
        if let Some(block) = guard
            .compression_blocks
            .iter_mut()
            .find(|block| block.session_id == session_id && block.block_id == block_id)
        {
            block.state = state;
            block.summary_json = summary_json.map(str::to_string);
            block.attempts = attempts;
            block.updated_at = SystemClock.now_ms();
        }
        Ok(())
    }
}

#[async_trait]
impl session_loop::input::PendingInputStore for InMemoryStore {
    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> Result<(), String> {
        <Self as Store>::save_pending_input(self, id, session_id, run_id, payload)
            .await
            .map_err(|e| e.message)
    }

    async fn delete_pending_input(&self, id: &str) -> Result<bool, String> {
        <Self as Store>::delete_pending_input(self, id)
            .await
            .map_err(|e| e.message)
    }
}
