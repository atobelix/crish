//! 探索文档配额的内存测试替身（X-06 T3：仅 test / test-support 编译）。

use super::{ExploreDocsQuotaSnapshot, ExploreDocsQuotaStore};
use crate::poison::POISON_RECOVERIES;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

/// 内存版存储（测试替身：进程内计数，跨进程重启不恢复——持久化语义由
/// 引擎侧 session_meta 后端承担）。
#[derive(Debug, Default)]
pub struct InMemoryExploreDocsQuotaStore {
    pub(super) inner: Mutex<HashMap<String, ExploreDocsQuotaSnapshot>>,
}

impl InMemoryExploreDocsQuotaStore {
    /// 新建空存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl ExploreDocsQuotaStore for InMemoryExploreDocsQuotaStore {
    fn snapshot(&self, session_id: &str) -> ExploreDocsQuotaSnapshot {
        let map = self.inner.lock().unwrap_or_else(|e| {
            tracing::error!("探索文档配额快照读 inner 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        map.get(session_id).cloned().unwrap_or_default()
    }

    fn consume(&self, session_id: &str, run_id: &str) -> Result<ExploreDocsQuotaSnapshot, String> {
        let mut map = self.inner.lock().unwrap_or_else(|e| {
            tracing::error!("探索文档配额消耗 inner 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let entry = map.entry(session_id.to_string()).or_default();
        entry.consumed = entry.consumed.saturating_add(1);
        entry.last_consumer_run_id = Some(run_id.to_string());
        Ok(entry.clone())
    }

    fn try_consume(
        &self,
        session_id: &str,
        run_id: &str,
        quota: u32,
    ) -> Result<ExploreDocsQuotaSnapshot, String> {
        // F3 #9：互斥内读改写——检查与占用原子（并发调用只放行恰好
        // quota 份，无 check-then-consume 竞态窗口）
        let mut map = self.inner.lock().unwrap_or_else(|e| {
            tracing::error!("探索文档配额原子占用 inner 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        let entry = map.entry(session_id.to_string()).or_default();
        if entry.consumed >= quota {
            return Err(format!(
                "配额已用尽（consumed={}，quota={quota}）",
                entry.consumed
            ));
        }
        entry.consumed = entry.consumed.saturating_add(1);
        entry.last_consumer_run_id = Some(run_id.to_string());
        Ok(entry.clone())
    }

    fn release(&self, session_id: &str, _run_id: &str) {
        // 补偿：reserve 后写盘失败回滚占用（下限 0，不产生负计数）
        let mut map = self.inner.lock().unwrap_or_else(|e| {
            tracing::error!("探索文档配额释放 inner 锁中毒，按恢复模式继续：{e}");
            POISON_RECOVERIES.fetch_add(1, Ordering::Relaxed);
            e.into_inner()
        });
        if let Some(entry) = map.get_mut(session_id) {
            entry.consumed = entry.consumed.saturating_sub(1);
        }
    }
}
