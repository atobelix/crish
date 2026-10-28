//! 子代理活动等待拓扑注册表（W2-T3 / REQ-D08 / 02-approval §五）
//!
//! 职责：
//! - [SubagentWaitRegistry]：维护活动的等待关系图——记录当前哪个父 Run 正在等待哪些子代理 Run / 子代理 ID；
//! - [WaitScopeGuard]：RAII 等待作用域守卫——进入等待时自动入表，退出作用域（正常完成、超时、异常 panic 或取消）时自动出表，零泄漏；
//! - 0ms 死锁检测：提供 [SubagentWaitRegistry::is_parent_waiting_subagent]，供子代理审批门检测父 Run 是否正处于阻塞等待态。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// 子代理活动等待拓扑注册表
///
/// 记录“当前哪个父 Run 正在阻塞等待哪些子代理”。
/// 当主 Agent 调用 `wait_subagents` 时标记 entry，离开等待时移除。
/// 子代理触发审批时，审批门经此快速查询父 Run 是否处于等待本子代理的状态，
/// 从而在 0ms 内识别潜在死锁，打破 120s 刚性超时。
#[derive(Debug, Default)]
pub struct SubagentWaitRegistry {
    /// parent_run_id -> HashSet<subagent_id / subagent_run_id>
    waits: Mutex<HashMap<String, HashSet<String>>>,
    /// 双向别名索引（subagent_run_id <-> subagent_id 互相映射，支持双向无缝匹配）
    aliases: Mutex<HashMap<String, HashSet<String>>>,
}

impl SubagentWaitRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self {
            waits: Mutex::new(HashMap::new()),
            aliases: Mutex::new(HashMap::new()),
        }
    }

    /// 注册等待关系并返回 RAII 守卫
    pub fn register_wait(
        self: &Arc<Self>,
        parent_run_id: String,
        subagent_ids: Vec<String>,
    ) -> WaitScopeGuard {
        {
            let mut guard = self.waits.lock().unwrap_or_else(|e| e.into_inner());
            let entry = guard.entry(parent_run_id.clone()).or_default();
            for sub_id in &subagent_ids {
                entry.insert(sub_id.clone());
            }
        }
        tracing::info!(
            target: "wait_registry",
            parent_run_id = %parent_run_id,
            subagents = ?subagent_ids,
            "注册父子等待拓扑关系"
        );
        WaitScopeGuard {
            registry: Arc::clone(self),
            parent_run_id,
            subagent_ids,
        }
    }

    /// 关联别名（例如将 subagent_id 与 subagent_run_id 互相绑定）
    pub fn register_alias(&self, id_a: &str, id_b: &str) {
        let mut guard = self.aliases.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entry(id_a.to_string())
            .or_default()
            .insert(id_b.to_string());
        guard
            .entry(id_b.to_string())
            .or_default()
            .insert(id_a.to_string());
    }

    /// 判定父 Run 是否正在等待该子代理
    pub fn is_parent_waiting_subagent(&self, parent_run_id: &str, subagent_run_id: &str) -> bool {
        let guard = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        let Some(subs) = guard.get(parent_run_id) else {
            return false;
        };
        if subs.contains(subagent_run_id) {
            return true;
        }
        // 查别名索引
        let aliases_guard = self.aliases.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(alias_set) = aliases_guard.get(subagent_run_id) {
            if alias_set.iter().any(|alias| subs.contains(alias)) {
                return true;
            }
        }
        false
    }

    /// 移除指定父 Run 的等待子代理项（内部由 Guard drop 调用）
    pub(crate) fn unregister_subagents(&self, parent_run_id: &str, subagent_ids: &[String]) {
        let mut guard = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.get_mut(parent_run_id) {
            for id in subagent_ids {
                entry.remove(id);
            }
            if entry.is_empty() {
                guard.remove(parent_run_id);
            }
        }
        tracing::info!(
            target: "wait_registry",
            parent_run_id = %parent_run_id,
            subagents = ?subagent_ids,
            "解除父子等待拓扑关系"
        );
    }

    /// 清空指定父 Run 的全部等待关系
    pub fn unregister(&self, parent_run_id: &str) {
        let mut guard = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(parent_run_id);
        tracing::info!(
            target: "wait_registry",
            parent_run_id = %parent_run_id,
            "清空父 Run 全部等待拓扑关系"
        );
    }

    /// 当前等待中的父 Run 数量（观测 / 测试用）
    pub fn waiting_parents_count(&self) -> usize {
        let guard = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        guard.len()
    }

    /// 获取指定父 Run 当前等待的所有子代理 ID 集合
    pub fn waiting_subagents_of(&self, parent_run_id: &str) -> HashSet<String> {
        let guard = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(parent_run_id).cloned().unwrap_or_default()
    }
}

/// RAII 等待作用域守卫：离开作用域时自动解除等待拓扑，零泄漏
pub struct WaitScopeGuard {
    registry: Arc<SubagentWaitRegistry>,
    parent_run_id: String,
    subagent_ids: Vec<String>,
}

impl Drop for WaitScopeGuard {
    fn drop(&mut self) {
        self.registry
            .unregister_subagents(&self.parent_run_id, &self.subagent_ids);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wait_registry_lifecycle_and_raii() {
        let registry = Arc::new(SubagentWaitRegistry::new());
        assert_eq!(registry.waiting_parents_count(), 0);

        // 1. 作用域内注册等待
        {
            let _guard = registry.register_wait(
                "parent-run-1".to_string(),
                vec!["sub-run-a".to_string(), "sub-run-b".to_string()],
            );

            assert_eq!(registry.waiting_parents_count(), 1);
            assert!(registry.is_parent_waiting_subagent("parent-run-1", "sub-run-a"));
            assert!(registry.is_parent_waiting_subagent("parent-run-1", "sub-run-b"));
            assert!(!registry.is_parent_waiting_subagent("parent-run-1", "sub-run-c"));
            assert!(!registry.is_parent_waiting_subagent("parent-run-2", "sub-run-a"));

            let waiting = registry.waiting_subagents_of("parent-run-1");
            assert_eq!(waiting.len(), 2);
            assert!(waiting.contains("sub-run-a"));
            assert!(waiting.contains("sub-run-b"));
        }

        // 2. 作用域结束 Guard 析构自动解除
        assert_eq!(registry.waiting_parents_count(), 0);
        assert!(!registry.is_parent_waiting_subagent("parent-run-1", "sub-run-a"));
        assert!(!registry.is_parent_waiting_subagent("parent-run-1", "sub-run-b"));
        assert!(registry.waiting_subagents_of("parent-run-1").is_empty());
    }

    #[test]
    fn test_wait_registry_alias_matching() {
        let registry = Arc::new(SubagentWaitRegistry::new());

        // 绑定别名：subagent_id <-> subagent_run_id
        registry.register_alias("sub-1-1", "run-sub-1-1");

        let _guard = registry.register_wait("parent-main".to_string(), vec!["sub-1-1".to_string()]);

        // 查询原始 id
        assert!(registry.is_parent_waiting_subagent("parent-main", "sub-1-1"));
        // 查询别名 id
        assert!(registry.is_parent_waiting_subagent("parent-main", "run-sub-1-1"));
        // 不相关的 id
        assert!(!registry.is_parent_waiting_subagent("parent-main", "other-run"));
    }

    #[test]
    fn test_wait_registry_multi_parent_isolation() {
        let registry = Arc::new(SubagentWaitRegistry::new());

        let guard1 = registry.register_wait("parent-1".to_string(), vec!["sub-a".to_string()]);
        let guard2 = registry.register_wait("parent-2".to_string(), vec!["sub-b".to_string()]);

        assert_eq!(registry.waiting_parents_count(), 2);
        assert!(registry.is_parent_waiting_subagent("parent-1", "sub-a"));
        assert!(!registry.is_parent_waiting_subagent("parent-1", "sub-b"));
        assert!(registry.is_parent_waiting_subagent("parent-2", "sub-b"));
        assert!(!registry.is_parent_waiting_subagent("parent-2", "sub-a"));

        drop(guard1);
        assert_eq!(registry.waiting_parents_count(), 1);
        assert!(!registry.is_parent_waiting_subagent("parent-1", "sub-a"));
        assert!(registry.is_parent_waiting_subagent("parent-2", "sub-b"));

        drop(guard2);
        assert_eq!(registry.waiting_parents_count(), 0);
    }
}
