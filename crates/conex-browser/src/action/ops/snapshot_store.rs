//! 快照存储真实实现（BrowserSnapshotStore）与会话解析辅助。

use std::sync::Arc;

use async_trait::async_trait;

use crate::action::{ActionError, ActionErrorKind, ElementMeta, SnapshotStore};
use crate::cdp::bus::VersionReason;
use crate::cdp::version::{Stale, TabId};
use crate::snapshot::budget::BudgetConfig;
use crate::snapshot::SnapshotManager;
use crate::BrowserSession;

/// 标签 → 会话解析器（引擎侧维度 15 标签管理注入；MVP 可用 session_for_active 兜底）。
pub type SessionResolver = Arc<dyn Fn(&TabId) -> Option<String> + Send + Sync>;

/// 快照存储真实实现（维度 11/13 门面包装；R-1 per-tab 签名）。
///
/// 会话解析经注入闭包 `session_for`（引擎侧维度 15 标签管理提供）；
/// 密码标记（is_password）由快照文档携带（M2：redact 同源判定），
/// 密码输入目标在工具面走 insertText/长度比对路径（§4.4）。
/// **内部持单一 `SnapshotManager` 实例**：`take_snapshot` 的提交与
/// `element_by_index` 的读取必须共享同一缓存——每次调用新建 manager 会
/// 让重快照后的索引解析永远落空（联调 E3 根因，mock 面未暴露）。
pub struct BrowserSnapshotStore {
    session: Arc<BrowserSession>,
    session_for: SessionResolver,
    manager: SnapshotManager,
}

impl BrowserSnapshotStore {
    pub fn new(
        session: Arc<BrowserSession>,
        session_for: SessionResolver,
        budgets: BudgetConfig,
    ) -> Self {
        let manager = session.snapshot_manager(budgets);
        BrowserSnapshotStore {
            session,
            session_for,
            manager,
        }
    }

    fn manager(&self) -> &SnapshotManager {
        &self.manager
    }
}

#[async_trait]
impl SnapshotStore for BrowserSnapshotStore {
    fn snapshot_version(&self, tab_id: &TabId) -> u64 {
        self.session.snapshot_version(tab_id)
    }

    fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale> {
        self.session.validate_snapshot(tab_id, version)
    }

    async fn take_snapshot(&self, tab_id: &TabId) -> Result<u64, ActionError> {
        let session = (self.session_for)(tab_id).ok_or_else(|| {
            ActionError::new(
                ActionErrorKind::InvalidInput,
                format!("标签 {tab_id} 无可用会话（维度 15 标签管理接线）"),
            )
        })?;
        let doc = self
            .manager()
            .capture(tab_id, &session, true)
            .await
            .map_err(|e| match e {
                crate::snapshot::SnapshotError::Timeout(_) => ActionError::new(
                    ActionErrorKind::Timeout,
                    format!("重快照超时（12s 硬超时，T-1）：{e}"),
                ),
                crate::snapshot::SnapshotError::Stale(stale) => ActionError::new(
                    ActionErrorKind::VersionInvalid,
                    format!("重快照版本竞态（M-5）：{stale:?}"),
                ),
                other => {
                    ActionError::new(ActionErrorKind::NodeStale, format!("重快照失败：{other}"))
                }
            })?;
        Ok(doc.meta.snapshot_version)
    }

    fn element_by_index(&self, tab_id: &TabId, version: u64, index: usize) -> Option<ElementMeta> {
        let doc = self.manager().get_cached(tab_id, version)?;
        let node_ref = doc.selector_map.get(&(index as u32))?;
        Some(ElementMeta {
            backend_node_id: node_ref.backend_node_id,
            // M2：快照文档敏感输入集合（redact 同源判定）
            is_password: doc.password_backend_ids.contains(&node_ref.backend_node_id),
        })
    }

    fn note_action_done(&self, tab_id: &TabId) {
        self.session.bump(tab_id, VersionReason::ActionDone);
    }
}

/// 会话解析辅助（引擎侧注入的简单实现样例：活动标签兜底）。
pub fn session_for_active(session: Arc<BrowserSession>) -> SessionResolver {
    Arc::new(move |_tab_id: &TabId| session.current_session().ok().map(|r| r.session.clone()))
}

/// 会话解析辅助（P1 多标签）：按 tab_id（targetId 语义）经 `tab_session`
/// 路由到对应 CDP 会话——重快照/动作路由与工具面 `resolve_tab` 同一口径。
pub fn session_for_tab(session: Arc<BrowserSession>) -> SessionResolver {
    Arc::new(move |tab_id: &TabId| session.tab_session(tab_id).map(|r| r.session))
}
