//! 子代理准入策略与祖先链死锁检测（纯函数）。
//!
//! 与旧实现的本质区别：深度/并发不是编译期常量，而是 [SpawnPolicy] 字段；
//! 主 agent 可经 `configure_agents` 调整会话策略，守卫只负责按策略判定。

use conex_types::error::codes;
use serde::{Deserialize, Serialize};

/// 子代理派遣策略（会话级，主 agent 可调）。
///
/// 默认值 = 扁平协作（depth 1、禁止子代理再派发、数量不限）：
/// - `max_depth=None` 表示不限制代数；`Some(1)` = 只允许主 agent 直接派发；
/// - `allow_child_spawn` 是嵌套开关，与 `max_depth` 同时满足才允许子代理派发；
/// - 数量默认 `None`（不限），由主 agent 按服务商压力自行设置软上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpawnPolicy {
    /// 最大代数（主 agent = 0，直接子代理 = 1；None = 不限）
    pub max_depth: Option<usize>,
    /// 是否允许子代理继续派发（默认 false；只有主 agent 可打开）
    pub allow_child_spawn: bool,
    /// 同父未终态子代理上限（None = 不限）
    pub max_active_per_parent: Option<usize>,
    /// 全会话未终态子代理上限（None = 不限）
    pub max_active_per_session: Option<usize>,
}

impl Default for SpawnPolicy {
    fn default() -> Self {
        Self::DEFAULT
    }
}

impl SpawnPolicy {
    /// 唯一权威默认值（禁止在其他模块重复硬编码）
    pub const DEFAULT: Self = Self {
        max_depth: Some(1),
        allow_child_spawn: false,
        max_active_per_parent: None,
        max_active_per_session: None,
    };
}

/// 默认策略常量（供需要 const 上下文的调用点使用）
pub const DEFAULT_SPAWN_POLICY: SpawnPolicy = SpawnPolicy::DEFAULT;

/// 守卫判定输入快照（由引擎侧采集）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecursionGuardSnapshot {
    /// 新会话沿 parent_id 链的深度（主会话的直接子代理 = 1）
    pub depth: usize,
    /// 父 run 下未终态的子代理数（含本次请求）
    pub active_siblings: usize,
    /// 全会话未终态的子代理 run 数（含本次请求）
    pub active_concurrent: usize,
}

/// 守卫拒绝原因（结构化错误载荷）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecursionGuardRejection {
    /// 递归深度超限
    DepthExceeded { current: usize, max: usize },
    /// 嵌套派发未开启（子代理无派发能力）
    NestingDenied { current: usize, max: usize },
    /// 同父并发超限
    SiblingsExceeded { current: usize, max: usize },
    /// 全会话并发超限
    ConcurrentExceeded { current: usize, max: usize },
    /// 祖先链死锁（目标会话已在祖先链上）
    DeadlockDetected { target_session_id: String },
}

impl RecursionGuardRejection {
    /// 错误码（沿用 subagent 域正式码；策略类超限复用 depth_exceeded）
    pub fn code(&self) -> &'static str {
        match self {
            Self::DepthExceeded { .. }
            | Self::SiblingsExceeded { .. }
            | Self::ConcurrentExceeded { .. } => codes::SUBAGENT_DEPTH_EXCEEDED,
            Self::NestingDenied { .. } => codes::SUBAGENT_NESTING_DENIED,
            Self::DeadlockDetected { .. } => codes::SUBAGENT_DEADLOCK_DETECTED,
        }
    }

    /// 结构化错误文案（含可执行指引）
    pub fn message(&self) -> String {
        match self {
            Self::DepthExceeded { current, max } => format!(
                "子代理代数超限（当前 {current}，策略上限 {max}）：请减少层级，\
                 或由主 agent 调整 configure_agents.maxDepth"
            ),
            Self::NestingDenied { current, max } => format!(
                "你没有创建子 Agent 的能力（当前代数 {current}，策略上限 {max}）：\
                 子代理派发默认关闭，所有子 Agent 由主 Agent 分配；\
                 请通过消息向主 Agent 请求派发，或由主 agent 调整 configure_agents"
            ),
            Self::SiblingsExceeded { current, max } => format!(
                "同父并发超过会话策略（当前 {current}，上限 {max}）：\
                 请等待部分子代理完成，或由主 agent 调整 configure_agents.maxActivePerParent"
            ),
            Self::ConcurrentExceeded { current, max } => format!(
                "全会话并发超过会话策略（当前 {current}，上限 {max}）：\
                 请等待部分子代理完成，或由主 agent 调整 configure_agents.maxActivePerSession"
            ),
            Self::DeadlockDetected { target_session_id } => {
                format!("子代理死锁：目标会话已在祖先链上（{target_session_id}）：请终止循环调用链")
            }
        }
    }
}

/// 递归守卫检查（纯函数）：嵌套 → 深度 → 同父并发 → 全会话并发。
pub fn check_recursion_guard(
    snapshot: RecursionGuardSnapshot,
    policy: SpawnPolicy,
) -> Result<(), RecursionGuardRejection> {
    if snapshot.depth > 1 && !policy.allow_child_spawn {
        return Err(RecursionGuardRejection::NestingDenied {
            current: snapshot.depth,
            max: policy.max_depth.unwrap_or(1),
        });
    }
    if let Some(max) = policy.max_depth {
        if snapshot.depth > max {
            return Err(RecursionGuardRejection::DepthExceeded {
                current: snapshot.depth,
                max,
            });
        }
    }
    if let Some(max) = policy.max_active_per_parent {
        if snapshot.active_siblings > max {
            return Err(RecursionGuardRejection::SiblingsExceeded {
                current: snapshot.active_siblings,
                max,
            });
        }
    }
    if let Some(max) = policy.max_active_per_session {
        if snapshot.active_concurrent > max {
            return Err(RecursionGuardRejection::ConcurrentExceeded {
                current: snapshot.active_concurrent,
                max,
            });
        }
    }
    Ok(())
}

/// 死锁检测输入
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeadlockCheckInput {
    /// 目标会话 id（即将 spawn 出的新会话）
    pub target_session_id: String,
    /// 祖先会话 id 链（从父到根）
    pub ancestor_session_ids: Vec<String>,
}

/// 祖先链死锁检查：目标会话已在祖先链上 → 拒绝（O(depth)）
pub fn check_ancestor_chain(input: &DeadlockCheckInput) -> Result<(), RecursionGuardRejection> {
    if input
        .ancestor_session_ids
        .contains(&input.target_session_id)
    {
        return Err(RecursionGuardRejection::DeadlockDetected {
            target_session_id: input.target_session_id.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(depth: usize, siblings: usize, concurrent: usize) -> RecursionGuardSnapshot {
        RecursionGuardSnapshot {
            depth,
            active_siblings: siblings,
            active_concurrent: concurrent,
        }
    }

    #[test]
    fn default_policy_is_flat_and_unlimited_in_quantity() {
        let policy = SpawnPolicy::default();
        assert!(check_recursion_guard(snapshot(1, 1_000, 10_000), policy).is_ok());
        assert!(matches!(
            check_recursion_guard(snapshot(2, 1, 1), policy),
            Err(RecursionGuardRejection::NestingDenied { .. })
        ));
    }

    #[test]
    fn nested_spawn_requires_explicit_switch_and_depth_budget() {
        let policy = SpawnPolicy {
            max_depth: Some(2),
            allow_child_spawn: true,
            ..SpawnPolicy::default()
        };
        assert!(check_recursion_guard(snapshot(2, 0, 0), policy).is_ok());
        assert!(matches!(
            check_recursion_guard(snapshot(3, 0, 0), policy),
            Err(RecursionGuardRejection::DepthExceeded { current: 3, max: 2 })
        ));
    }

    #[test]
    fn quantity_limits_are_applied_only_when_policy_sets_them() {
        let policy = SpawnPolicy {
            max_active_per_parent: Some(3),
            max_active_per_session: Some(5),
            ..SpawnPolicy::default()
        };
        assert!(check_recursion_guard(snapshot(1, 3, 5), policy).is_ok());
        assert!(matches!(
            check_recursion_guard(snapshot(1, 4, 5), policy),
            Err(RecursionGuardRejection::SiblingsExceeded { current: 4, max: 3 })
        ));
        assert!(matches!(
            check_recursion_guard(snapshot(1, 3, 6), policy),
            Err(RecursionGuardRejection::ConcurrentExceeded { current: 6, max: 5 })
        ));
    }

    #[test]
    fn ancestor_cycle_is_rejected() {
        let input = DeadlockCheckInput {
            target_session_id: "sub-sess-1".to_string(),
            ancestor_session_ids: vec!["main".to_string(), "sub-sess-1".to_string()],
        };
        assert!(matches!(
            check_ancestor_chain(&input),
            Err(RecursionGuardRejection::DeadlockDetected { .. })
        ));
    }
}
