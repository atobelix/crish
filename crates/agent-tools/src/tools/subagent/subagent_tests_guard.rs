//! `subagent` 递归守卫域测试（SR-06a 拆分）：守卫纯函数 / 守卫拒绝经工具出站。
//!
//! 全部既有测试原样迁移（零删除）；`use super::*` 经父模命名空间取共享替身与门面 re-export。

#![allow(clippy::disallowed_methods)]

use super::*;

use crate::context::create_mock_tool_context;
use crate::definition::Tool;
use conex_types::error::codes;

// ── 递归守卫纯函数 ────────────────────────────────────────────

#[test]
fn guard_depth_exceeded_rejected() {
    let config = DEFAULT_SPAWN_POLICY;
    let snapshot = RecursionGuardSnapshot {
        depth: 2,
        active_siblings: 0,
        active_concurrent: 0,
    };
    let err = check_recursion_guard(snapshot, config).unwrap_err();
    // T-D-01 验收：depth=2/max=1 被拒。maxDepth=1 下「新会话深度 2」
    // 即嵌套违规（发起者是子 Agent），T-D-02 语义优先命中 NestingDenied
    // 专用变体（DepthExceeded 语义保留由 guard_depth_exceeded_semantics_
    // preserved 覆盖——max>1 配置下深度超限仍返回 DepthExceeded）
    assert_eq!(
        err.code(),
        codes::SUBAGENT_NESTING_DENIED,
        "max=1 下新会话深度 2 = 嵌套违规，拒绝 spawn"
    );
    assert!(err.message().contains("所有子 Agent 由主 Agent 分配"));
    assert_eq!(
        err,
        RecursionGuardRejection::NestingDenied { current: 2, max: 1 }
    );
}

#[test]
fn guard_depth_exceeded_semantics_preserved() {
    // DepthExceeded 语义保留：非 1 的 maxDepth 配置下，新会话深度超过
    // 界限仍按 DepthExceeded 拒绝（max=2：深度 3 拒绝、深度 2 通过）
    let config = SpawnPolicy {
        max_depth: Some(2),
        allow_child_spawn: true,
        ..SpawnPolicy::default()
    };
    let err = check_recursion_guard(
        RecursionGuardSnapshot {
            depth: 3,
            active_siblings: 0,
            active_concurrent: 0,
        },
        config,
    )
    .unwrap_err();
    assert_eq!(err.code(), codes::SUBAGENT_DEPTH_EXCEEDED);
    assert!(err.message().contains("子代理代数超限"));
    assert_eq!(
        err,
        RecursionGuardRejection::DepthExceeded { current: 3, max: 2 }
    );
    // 边界深度（2 = max）通过
    assert!(check_recursion_guard(
        RecursionGuardSnapshot {
            depth: 2,
            active_siblings: 0,
            active_concurrent: 0,
        },
        config,
    )
    .is_ok());
}

#[test]
fn guard_nesting_denied() {
    // T-D-02 验收（守卫层最终防线）：子 Agent 发起 spawn（新会话深度 2，
    // 发起者自身深度 1）→ NestingDenied 专用变体 + 专用错误码
    // subagent.nesting_denied + 编排指引文案
    let config = DEFAULT_SPAWN_POLICY;
    let snapshot = RecursionGuardSnapshot {
        depth: 2,
        active_siblings: 0,
        active_concurrent: 0,
    };
    let err = check_recursion_guard(snapshot, config).unwrap_err();
    assert_eq!(
        err.code(),
        codes::SUBAGENT_NESTING_DENIED,
        "嵌套禁止使用专用错误码（不复用 depth_exceeded，避免前端文案歧义）"
    );
    assert!(
        err.message().contains("你没有创建子 Agent 的能力"),
        "文案必须声明子 Agent 无派发能力"
    );
    assert!(
        err.message().contains("所有子 Agent 由主 Agent 分配"),
        "文案必须带「所有子 Agent 由主 Agent 分配」指引"
    );
    assert!(
        err.message().contains("请通过消息"),
        "文案必须带上报指引"
    );
    assert_eq!(
        err,
        RecursionGuardRejection::NestingDenied { current: 2, max: 1 }
    );
}

#[test]
fn guard_siblings_exceeded_rejected() {
    let config = SpawnPolicy {
        max_active_per_parent: Some(16),
        ..SpawnPolicy::default()
    };
    let snapshot = RecursionGuardSnapshot {
        depth: 1,
        active_siblings: 17,
        active_concurrent: 1,
    };
    let err = check_recursion_guard(snapshot, config).unwrap_err();
    assert_eq!(
        err.code(),
        codes::SUBAGENT_DEPTH_EXCEEDED,
        "兄弟并发超限拒绝 spawn（复用 subagent 域永久码，语义见 message）"
    );
    assert!(err.message().contains("同父并发超过会话策略"));
    assert_eq!(
        err,
        RecursionGuardRejection::SiblingsExceeded {
            current: 17,
            max: 16
        }
    );
}

#[test]
fn guard_concurrent_exceeded_rejected() {
    let config = SpawnPolicy {
        max_active_per_session: Some(16),
        ..SpawnPolicy::default()
    };
    let snapshot = RecursionGuardSnapshot {
        depth: 1,
        active_siblings: 0,
        active_concurrent: 17,
    };
    let err = check_recursion_guard(snapshot, config).unwrap_err();
    assert_eq!(
        err.code(),
        codes::SUBAGENT_DEPTH_EXCEEDED,
        "全局并发超限拒绝 spawn（复用 subagent 域永久码，语义见 message）"
    );
    assert!(err.message().contains("全会话并发超过会话策略"));
    assert_eq!(
        err,
        RecursionGuardRejection::ConcurrentExceeded {
            current: 17,
            max: 16
        },
    );
}

#[test]
fn default_policy_is_flat_and_unlimited() {
    let policy = DEFAULT_SPAWN_POLICY;
    assert_eq!(policy.max_depth, Some(1), "默认扁平：仅主 Agent 可派发");
    assert!(!policy.allow_child_spawn, "默认禁止子代理再派发");
    assert_eq!(
        policy.max_active_per_parent, None,
        "数量默认不限（由主 agent 按压力配置）"
    );
    assert_eq!(policy.max_active_per_session, None);
}

#[test]
fn guard_within_limits_allowed() {
    let config = DEFAULT_SPAWN_POLICY;
    // 默认策略下数量不限；深度 1 通过、深度 2 拒绝。
    let snapshot = RecursionGuardSnapshot {
        depth: 1,
        active_siblings: 16,
        active_concurrent: 16,
    };
    assert!(check_recursion_guard(snapshot, config).is_ok());
    let snapshot = RecursionGuardSnapshot {
        depth: 1,
        active_siblings: 10_000,
        active_concurrent: 10_000,
    };
    assert!(
        check_recursion_guard(snapshot, config).is_ok(),
        "默认不限制子代理数量"
    );
    let snapshot = RecursionGuardSnapshot {
        depth: 0,
        active_siblings: 0,
        active_concurrent: 0,
    };
    assert!(check_recursion_guard(snapshot, config).is_ok());
    // 深度 2（子 Agent 发起）拒绝：嵌套判定优先命中，即使兄弟/并发
    // 未超限也拒绝
    let snapshot = RecursionGuardSnapshot {
        depth: 2,
        active_siblings: 0,
        active_concurrent: 0,
    };
    assert_eq!(
        check_recursion_guard(snapshot, config),
        Err(RecursionGuardRejection::NestingDenied { current: 2, max: 1 }),
        "depth=2 必须拒绝（嵌套禁止优先于深度/兄弟/并发判定）"
    );
}

#[test]
fn ancestor_chain_deadlock_rejected() {
    let input = DeadlockCheckInput {
        target_session_id: "sess-a".to_string(),
        ancestor_session_ids: vec![
            "sess-main".to_string(),
            "sess-a".to_string(),
            "sess-b".to_string(),
        ],
    };
    let err = check_ancestor_chain(&input).unwrap_err();
    assert_eq!(err.code(), codes::SUBAGENT_DEADLOCK_DETECTED);
    assert!(err.message().contains("祖先链"));
    // 复杂度语义：O(depth) 祖先链查找命中即拒
    assert_eq!(
        err,
        RecursionGuardRejection::DeadlockDetected {
            target_session_id: "sess-a".to_string()
        }
    );
}

#[test]
fn ancestor_chain_without_cycle_allows() {
    let input = DeadlockCheckInput {
        target_session_id: "sess-new".to_string(),
        ancestor_session_ids: vec![
            "sess-main".to_string(),
            "sess-a".to_string(),
            "sess-b".to_string(),
        ],
    };
    assert!(check_ancestor_chain(&input).is_ok());
}

// ── 守卫拒绝经工具出站（超限拒绝 spawn 且零 run）──────────────

#[tokio::test]
async fn guard_rejection_maps_to_structured_tool_error() {
    let spawner = Arc::new(RecordingSpawner::rejecting(
        RecursionGuardRejection::ConcurrentExceeded { current: 7, max: 6 },
    ));
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), codes::SUBAGENT_DEPTH_EXCEEDED);
    assert!(err.to_string().contains("全会话并发超过会话策略"));
    // spawner 已校验但未产出 run（零 run 语义由引擎侧保证，见落库测试）
    assert_eq!(spawner.requests().len(), 1);
}

#[tokio::test]
async fn nesting_denied_maps_to_structured_tool_error() {
    // T-D-02 验收（工具出站）：嵌套禁止经 SubagentSpawnError::NestingDenied
    // 原样映射为 ToolError——错误码 subagent.nesting_denied、文案带
    // 「所有子 Agent 由主 Agent 分配」指引
    let spawner = Arc::new(RecordingSpawner::rejecting_nesting(
        RecursionGuardRejection::NestingDenied { current: 2, max: 1 },
    ));
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap_err();
    assert_eq!(
        err.code(),
        codes::SUBAGENT_NESTING_DENIED,
        "嵌套禁止错误码必须为 subagent.nesting_denied"
    );
    assert!(
        err.to_string().contains("所有子 Agent 由主 Agent 分配"),
        "文案必须带「所有子 Agent 由主 Agent 分配」指引"
    );
    assert!(
        err.to_string().contains("请通过消息"),
        "文案必须带上报指引"
    );
}

#[tokio::test]
async fn main_agent_spawn_regression_via_tool() {
    // 主 Agent（深度 0）spawn 回归：工具直调路径不受嵌套禁止影响
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .expect("主 Agent spawn 必须成功");
    assert_eq!(out["status"], "running");
    assert_eq!(spawner.requests().len(), 1);
}
