//! 会话级子代理策略服务：加载/补丁持久化 + spawner 内存策略同步。
//!
//! 持久化键：`{session_id}:agent_policy`（`session_meta`），缺省读
//! `AgentPolicy::default()`；补丁经 [AgentPolicy::apply_patch] 深度合并。

use std::sync::Arc;

use agent_tools::tools::configure_agents::AgentPolicyChannel;
use agent_tools::tools::subagent::SubagentSpawner;
use conex_agents::policy::AgentPolicy;
use conex_db::LocalDb;

use crate::run::session_meta_key_of;

/// session_meta 中的策略键名
pub const AGENT_POLICY_KEY: &str = "agent_policy";

/// 策略服务（进程级共享；无 DB 的测试路径不注入）
#[derive(Clone)]
pub struct AgentPolicyService {
    db: LocalDb,
    spawner: Option<Arc<dyn SubagentSpawner>>,
}

impl std::fmt::Debug for AgentPolicyService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentPolicyService")
            .field("has_spawner", &self.spawner.is_some())
            .finish()
    }
}

impl AgentPolicyService {
    /// 构造服务（spawner 可为 None：仅持久化，不驱动准入）
    pub fn new(db: LocalDb, spawner: Option<Arc<dyn SubagentSpawner>>) -> Self {
        Self { db, spawner }
    }

    fn key(session_id: &str) -> String {
        session_meta_key_of(session_id, AGENT_POLICY_KEY)
    }

    /// 读取会话策略（缺失/损坏 → 默认）
    pub fn load(&self, session_id: &str) -> AgentPolicy {
        let raw = self
            .db
            .get_session_meta(&Self::key(session_id))
            .ok()
            .flatten();
        AgentPolicy::from_json(raw.as_deref())
    }

    /// 把持久化策略装入 spawner（run 启动时调用一次）
    pub fn install(&self, session_id: &str) {
        let policy = self.load(session_id);
        if let Some(spawner) = self.spawner.as_ref() {
            spawner.set_session_policy(session_id, policy.spawn);
        }
    }

    /// 应用字段级补丁并持久化（主 agent `configure_agents` 入口）
    pub fn apply_patch(
        &self,
        session_id: &str,
        patch: &serde_json::Value,
    ) -> Result<AgentPolicy, String> {
        let current = self.load(session_id);
        let next = current.apply_patch(patch)?;
        self.db
            .set_session_meta(&Self::key(session_id), &next.to_json())
            .map_err(|error| format!("agent_policy 落库失败：{error}"))?;
        if let Some(spawner) = self.spawner.as_ref() {
            spawner.set_session_policy(session_id, next.spawn);
        }
        Ok(next)
    }

    /// 当前策略 JSON（工具返回面）
    pub fn load_json(&self, session_id: &str) -> serde_json::Value {
        serde_json::to_value(self.load(session_id)).unwrap_or(serde_json::Value::Null)
    }
}

impl AgentPolicyChannel for AgentPolicyService {
    fn apply(&self, session_id: &str, patch: serde_json::Value) -> Result<serde_json::Value, String> {
        let policy = self.apply_patch(session_id, &patch)?;
        serde_json::to_value(policy).map_err(|error| format!("agent_policy 序列化失败：{error}"))
    }

    fn describe(&self, session_id: &str) -> Result<serde_json::Value, String> {
        Ok(self.load_json(session_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn service() -> (AgentPolicyService, LocalDb) {
        let db = LocalDb::open_in_memory().expect("内存 DB");
        db.insert_session("s1", "s1").expect("会话行");
        (AgentPolicyService::new(db.clone(), None), db)
    }

    #[test]
    fn patch_persists_and_reloads_with_defaults() {
        let (service, _db) = service();
        let next = service
            .apply_patch(
                "s1",
                &serde_json::json!({ "spawn": { "maxActivePerSession": 8 } }),
            )
            .expect("补丁应成功");
        assert_eq!(next.spawn.max_active_per_session, Some(8));
        let loaded = service.load("s1");
        assert_eq!(loaded.spawn.max_active_per_session, Some(8));
        assert_eq!(loaded.spawn.max_depth, Some(1), "未涉及字段保持默认");
    }

    #[test]
    fn install_pushes_policy_to_spawner() {
        let db = LocalDb::open_in_memory().expect("内存 DB");
        db.insert_session("s1", "s1").expect("会话行");
        let spawner = Arc::new(crate::subagent_spawner::SubagentSpawnerImpl::new());
        let service = AgentPolicyService::new(
            db.clone(),
            Some(Arc::clone(&spawner) as Arc<dyn SubagentSpawner>),
        );
        service
            .apply_patch(
                "s1",
                &serde_json::json!({ "spawn": { "maxActivePerParent": 3 } }),
            )
            .expect("补丁应成功");
        service.install("s1");
        assert_eq!(
            spawner.policy_for("s1").max_active_per_parent,
            Some(3),
            "持久化策略应装入 spawner"
        );
        assert_eq!(
            spawner.policy_for("other").max_active_per_parent,
            None,
            "其他会话不受影响"
        );
    }

    #[test]
    fn invalid_patch_is_rejected_without_persisting() {
        let (service, _db) = service();
        assert!(service
            .apply_patch("s1", &serde_json::json!({ "spawn": { "maxDepth": "many" } }))
            .is_err());
        assert_eq!(service.load("s1"), AgentPolicy::default());
    }
}
