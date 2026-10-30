//! 计数型 Store 包装（reserve_sequence 调用探针）。

use super::*;
use std::sync::atomic::{AtomicU32, Ordering};

/// 计数包装：reserve_sequence 调用计数（N1 / persist 探针共用）。
pub(super) struct CountingReserves {
    pub(super) inner: Arc<InMemoryStore>,
    pub(super) reserve_calls: AtomicU32,
}

#[async_trait::async_trait]
impl Store for CountingReserves {
    async fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: conex_db::RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> crate::persist::StoreResult<()> {
        self.inner
            .insert_run(run_id, session_id, status, end_reason, cursor)
            .await
    }

    async fn update_run_status(
        &self,
        run_id: &str,
        status: conex_db::RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> crate::persist::StoreResult<()> {
        self.inner
            .update_run_status(run_id, status, end_reason, cursor)
            .await
    }

    async fn reserve_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
        self.reserve_calls.fetch_add(1, Ordering::SeqCst);
        self.inner.reserve_sequence(session_id).await
    }

    async fn seed_sequence(
        &self,
        session_id: &str,
        next_sequence: u64,
    ) -> crate::persist::StoreResult<()> {
        self.inner.seed_sequence(session_id, next_sequence).await
    }

    async fn append_event(
        &self,
        session_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> crate::persist::StoreResult<()> {
        self.inner
            .append_event(session_id, sequence, event_type, payload, run_id)
            .await
    }

    async fn query_events(
        &self,
        session_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
        self.inner
            .query_events(session_id, after_sequence, limit)
            .await
    }

    async fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
        self.inner
            .query_events_by_run(session_id, run_id, after_sequence, limit)
            .await
    }

    async fn max_sequence(&self, session_id: &str) -> crate::persist::StoreResult<u64> {
        self.inner.max_sequence(session_id).await
    }

    async fn query_events_by_type(
        &self,
        session_id: &str,
        run_id: &str,
        event_type: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> crate::persist::StoreResult<Vec<crate::persist::PersistedEvent>> {
        self.inner
            .query_events_by_type(session_id, run_id, event_type, after_sequence, limit)
            .await
    }

    async fn query_runs(&self) -> crate::persist::StoreResult<Vec<conex_db::StoredRun>> {
        self.inner.query_runs().await
    }

    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> crate::persist::StoreResult<()> {
        self.inner
            .save_pending_input(id, session_id, run_id, payload)
            .await
    }

    async fn load_pending_inputs(
        &self,
        session_id: &str,
    ) -> crate::persist::StoreResult<Vec<conex_db::PendingInput>> {
        self.inner.load_pending_inputs(session_id).await
    }

    async fn delete_pending_input(&self, id: &str) -> crate::persist::StoreResult<bool> {
        self.inner.delete_pending_input(id).await
    }

    async fn touch_session(&self, session_id: &str) -> crate::persist::StoreResult<()> {
        self.inner.touch_session(session_id).await
    }

    fn get_run_usage(
        &self,
        run_id: &str,
    ) -> crate::persist::StoreResult<Option<conex_types::events::RunCacheStats>> {
        self.inner.get_run_usage(run_id)
    }

    fn save_run_usage(
        &self,
        run_id: &str,
        stats: conex_types::events::RunCacheStats,
    ) -> crate::persist::StoreResult<()> {
        self.inner.save_run_usage(run_id, stats)
    }

    async fn load_running_session_agent_rows(
        &self,
    ) -> crate::persist::StoreResult<Vec<conex_types::session_record::SessionAgent>> {
        self.inner.load_running_session_agent_rows().await
    }

    async fn mark_session_agent_interrupted(
        &self,
        parent_session_id: &str,
        subagent_run_id: &str,
        ended_at_ms: i64,
        summary: &str,
    ) -> crate::persist::StoreResult<usize> {
        self.inner
            .mark_session_agent_interrupted(
                parent_session_id,
                subagent_run_id,
                ended_at_ms,
                summary,
            )
            .await
    }

    async fn load_session_messages(
        &self,
        session_id: &str,
    ) -> crate::persist::StoreResult<Vec<conex_types::session_record::SessionMessage>> {
        self.inner.load_session_messages(session_id).await
    }

    async fn save_session_messages(
        &self,
        session_id: &str,
        messages: &[conex_types::session_record::SessionMessage],
    ) -> crate::persist::StoreResult<()> {
        self.inner.save_session_messages(session_id, messages).await
    }

    async fn insert_compression_block(
        &self,
        session_id: &str,
        record: &conex_types::tool::ContextCompressionRecord,
        sequence: u64,
    ) -> crate::persist::StoreResult<()> {
        self.inner
            .insert_compression_block(session_id, record, sequence)
            .await
    }

    fn update_compression_block_summary(
        &self,
        session_id: &str,
        block_id: &str,
        state: conex_db::BlockState,
        summary_json: Option<&str>,
        attempts: u32,
    ) -> crate::persist::StoreResult<()> {
        self.inner.update_compression_block_summary(
            session_id,
            block_id,
            state,
            summary_json,
            attempts,
        )
    }
}
