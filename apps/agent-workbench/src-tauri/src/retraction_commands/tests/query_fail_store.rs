//! 查询失败 Store 桩（撤回计划错误路径测试）。

use super::*;

pub(super) struct QueryFailStore;

#[async_trait::async_trait]
impl orchestrator::persist::Store for QueryFailStore {
    async fn insert_run(
        &self,
        _: &str,
        _: &str,
        _: RunStatus,
        _: Option<&str>,
        _: i64,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn update_run_status(
        &self,
        _: &str,
        _: RunStatus,
        _: Option<&str>,
        _: Option<i64>,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn reserve_sequence(&self, _: &str) -> orchestrator::persist::StoreResult<u64> {
        unreachable!()
    }
    async fn seed_sequence(&self, _: &str, _: u64) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn append_event(
        &self,
        _: &str,
        _: u64,
        _: &str,
        _: &str,
        _: Option<&str>,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn query_events(
        &self,
        _: &str,
        _: u64,
        _: Option<u64>,
    ) -> orchestrator::persist::StoreResult<Vec<orchestrator::persist::PersistedEvent>> {
        Err(orchestrator::persist::StoreError::new(
            "query_events",
            "injected failure",
        ))
    }
    async fn query_events_by_run(
        &self,
        _: &str,
        _: &str,
        _: u64,
        _: Option<u64>,
    ) -> orchestrator::persist::StoreResult<Vec<orchestrator::persist::PersistedEvent>> {
        unreachable!()
    }
    async fn max_sequence(&self, _: &str) -> orchestrator::persist::StoreResult<u64> {
        unreachable!()
    }
    async fn query_events_by_type(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: u64,
        _: Option<u64>,
    ) -> orchestrator::persist::StoreResult<Vec<orchestrator::persist::PersistedEvent>> {
        unreachable!()
    }
    async fn query_runs(&self) -> orchestrator::persist::StoreResult<Vec<conex_db::StoredRun>> {
        unreachable!()
    }
    async fn save_pending_input(
        &self,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: &str,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn load_pending_inputs(
        &self,
        _: &str,
    ) -> orchestrator::persist::StoreResult<Vec<conex_db::PendingInput>> {
        unreachable!()
    }
    async fn delete_pending_input(&self, _: &str) -> orchestrator::persist::StoreResult<bool> {
        unreachable!()
    }
    async fn touch_session(&self, _: &str) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    fn get_run_usage(
        &self,
        _: &str,
    ) -> orchestrator::persist::StoreResult<Option<conex_types::events::RunCacheStats>> {
        unreachable!()
    }
    fn save_run_usage(
        &self,
        _: &str,
        _: conex_types::events::RunCacheStats,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn load_running_session_agent_rows(
        &self,
    ) -> orchestrator::persist::StoreResult<Vec<conex_types::session_record::SessionAgent>> {
        unreachable!()
    }
    async fn mark_session_agent_interrupted(
        &self,
        _: &str,
        _: &str,
        _: i64,
        _: &str,
    ) -> orchestrator::persist::StoreResult<usize> {
        unreachable!()
    }
    async fn load_session_messages(
        &self,
        _: &str,
    ) -> orchestrator::persist::StoreResult<Vec<conex_types::session_record::SessionMessage>> {
        unreachable!()
    }
    async fn save_session_messages(
        &self,
        _: &str,
        _: &[conex_types::session_record::SessionMessage],
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    async fn insert_compression_block(
        &self,
        _: &str,
        _: &conex_types::tool::ContextCompressionRecord,
        _: u64,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
    fn update_compression_block_summary(
        &self,
        _: &str,
        _: &str,
        _: conex_db::BlockState,
        _: Option<&str>,
        _: u32,
    ) -> orchestrator::persist::StoreResult<()> {
        unreachable!()
    }
}
