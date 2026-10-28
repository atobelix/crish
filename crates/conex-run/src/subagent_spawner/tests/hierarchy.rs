use agent_tools::tools::subagent::{
    check_ancestor_chain, DeadlockCheckInput, RecursionGuardRejection, SubagentSpawnError,
    SubagentSpawner,
};

use super::{request, setup_main_run, test_rig};

// ── 嵌套拒绝（T-D-02：子 Agent 无派发能力，结构化错误）────────

#[tokio::test]
async fn spawn_nesting_denied_from_subagent_run() {
    let (spawner, _, _, _, _) = test_rig();
    setup_main_run(&spawner);
    // 真实场景：主 agent 先 spawn 出子代理 A，A 作为发起者再派发
    let first = spawner
        .spawn(&request("子代理 A 的任务", None))
        .await
        .expect("主 agent 派发应成功");
    spawner.set_current_run("sess-main", &first.subagent_run_id);

    let mut req = request("再派发", None);
    req.parent_run_id = None; // 工具路径：按会话解析 → 子代理 run 为发起者
    let err = spawner.spawn(&req).await.expect_err("嵌套发起必须拒绝");
    // 专用变体 + 专用错误码（T-D-02 验收）
    match &err {
        SubagentSpawnError::NestingDenied(rejection) => {
            assert_eq!(rejection.code(), "subagent.nesting_denied");
            assert!(rejection.message().contains("所有子 Agent 由主 Agent 分配"));
        }
        other => panic!("必须为 NestingDenied，实际 {other:?}"),
    }
    assert_eq!(err.code(), "subagent.nesting_denied");
    // 零 run：无新增行
    assert_eq!(
        spawner
            .db
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .load_session_agents("sess-main")
            .unwrap()
            .len(),
        1
    );
}

// ── 祖先链死锁检查（防循环 fork）─────────────────────────────

#[tokio::test]
async fn deadlock_ancestor_chain_rejected() {
    let (spawner, _, _, _, _) = test_rig();
    // 构造链：run-main → sub-run-1（会话 sub-sess-1）→ sub-run-2（会话
    // sub-sess-2）；祖先会话作为目标 → DeadlockDetected
    spawner.register_run("run-main", "sess-main", None);
    spawner.register_run("sub-run-1", "sub-sess-1", Some("run-main".to_string()));
    spawner.register_run("sub-run-2", "sub-sess-2", Some("sub-run-1".to_string()));

    // check_ancestor_chain 纯函数单测：目标 = 祖先会话
    let input = DeadlockCheckInput {
        target_session_id: "sub-sess-1".to_string(),
        ancestor_session_ids: vec![
            "sub-sess-2".to_string(),
            "sub-sess-1".to_string(),
            "sess-main".to_string(),
        ],
    };
    let rejection = check_ancestor_chain(&input).expect_err("祖先链命中必须拒绝");
    assert!(matches!(
        rejection,
        RecursionGuardRejection::DeadlockDetected { target_session_id }
            if target_session_id == "sub-sess-1"
    ));
    // 非祖先链：放行
    let ok_input = DeadlockCheckInput {
        target_session_id: "fresh-sess".to_string(),
        ancestor_session_ids: vec!["sess-main".to_string()],
    };
    assert!(check_ancestor_chain(&ok_input).is_ok());
}

/// 祖先链会话收集（spawn 路径集成）：沿 parent_run_id 链从父到根
#[tokio::test]
async fn ancestor_chain_collection_follows_parent_links() {
    let (spawner, _, _, _, _) = test_rig();
    spawner.register_run("run-main", "sess-main", None);
    spawner.register_run("sub-run-1", "sub-sess-1", Some("run-main".to_string()));
    spawner.register_run("sub-run-2", "sub-sess-2", Some("sub-run-1".to_string()));

    let chain = spawner.ancestor_sessions(Some("sub-run-2"));
    assert_eq!(
        chain,
        vec![
            "sub-sess-2".to_string(),
            "sub-sess-1".to_string(),
            "sess-main".to_string()
        ],
        "沿 parent_run_id 链从父到根"
    );
    // 未知 run：空链（数据异常不 panic）
    assert!(spawner.ancestor_sessions(Some("ghost-run")).is_empty());
}

/// F-013 接线回归：非 flow 路径（工具直调）description 语义不受影响
/// ——row_for 仅当 flow_node_id 存在时承载之，普通描述文本原样落库
#[tokio::test]
async fn non_flow_spawn_preserves_user_description() {
    let (spawner, _, db, _, _) = test_rig();
    setup_main_run(&spawner);
    let result = spawner
        .spawn(&request("调研", None))
        .await
        .expect("spawn 应成功");
    let _ = result;
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(
        rows[0].description, "调研",
        "非 flow 路径 description 原样保留（接线不破坏既有语义）"
    );
}
