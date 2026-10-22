//! F11b（T-D-12）：get_flow_snapshot 只读快照查询。

use std::collections::HashMap;

use super::super::flow::build_flow_snapshot;
use super::*;
use orchestrator::flow_graph::{
    FailStrategy, FlowDeclaration, FlowNodeRuntime, FLOW_DECLARATION_KEY, FLOW_ON_FAILED_KEY,
    FLOW_STATE_KEY,
};

// ── F11b（T-D-12）：get_flow_snapshot 只读快照查询 ──

/// 测试用编排声明（与 persist_declaration 同形状写库：camelCase JSON）
fn write_declaration(db: &LocalDb, tasks: Vec<FlowNode>) {
    let decl = FlowDeclaration {
        tasks,
        planner_run_id: Some("run-main".into()),
    };
    let json = serde_json::to_string(&decl).unwrap();
    db.set_session_meta(FLOW_DECLARATION_KEY, &json).unwrap();
}

/// 测试用 flow_state（与 persist_runtime 同形状写库：FlowNodeRuntime 数组）
fn write_flow_state(db: &LocalDb, runtimes: Vec<FlowNodeRuntime>) {
    let json = serde_json::to_string(&runtimes).unwrap();
    db.set_session_meta(FLOW_STATE_KEY, &json).unwrap();
}

/// 测试用 session_agents 行（仅 status / subagent_run_id 参与拼装）
fn sample_agent(run_id: &str, status: &str) -> SessionAgent {
    SessionAgent {
        id: format!("a-{run_id}"),
        subagent_run_id: run_id.to_string(),
        parent_session_id: "s1".to_string(),
        parent_run_id: "run-main".to_string(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "analysis".to_string(),
        status: status.to_string(),
        summary: None,
        messages: Vec::new(),
        started_at: 100,
        ended_at: None,
        depth: Some(0),
        subagent_path_json: None,
        task_type: Some("analysis".to_string()),
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    }
}

/// 直接从库读取原始 flow 键（模拟命令侧读取面）
fn read_raw_flow(
    db: &LocalDb,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<SessionAgent>,
) {
    (
        db.get_session_meta(FLOW_DECLARATION_KEY).unwrap(),
        db.get_session_meta(FLOW_STATE_KEY).unwrap(),
        db.get_session_meta(FLOW_ON_FAILED_KEY).unwrap(),
        db.load_session_agents("s1").unwrap(),
    )
}

/// 空态：无 flow 声明 → 返回空 nodes（不报错）
#[test]
fn flow_snapshot_empty_nodes_without_declaration() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    // 无任何 flow_* 键（也未写 flow_state / 无子代理行）
    let (decl, state, on_failed, agents) = read_raw_flow(&db);
    let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
    assert!(snap.nodes.is_empty(), "空态应返回空 nodes");
}

/// 节点状态与 flow_state + session_agents 拼装一致（含状态映射 +
/// stopped 归一 failed + run 缺失行 fail-open；未知 DB 值宽容归一 failed
/// 由 DB CHECK 约束挡在写面之外，agent-tools 侧已测）
#[test]
fn flow_snapshot_matches_persisted_states() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    write_declaration(
        &db,
        vec![
            FlowNode {
                id: "t1".into(),
                task: "分析内核".into(),
                depends_on: vec![],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "t2".into(),
                task: "实现组件".into(),
                depends_on: vec!["t1".into()],
                parallel: false,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "t3".into(),
                task: "评审验收".into(),
                depends_on: vec!["t1".into(), "t2".into()],
                parallel: false,
                on_failed: None,
                is_composite: true,
            },
            FlowNode {
                id: "t4".into(),
                task: "安全审计".into(),
                depends_on: vec!["t2".into()],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
        ],
    );
    write_flow_state(
        &db,
        vec![
            FlowNodeRuntime {
                node_id: "t1".into(),
                subagent_run_id: Some("run-1".into()),
                subagent_id: Some("a-run-1".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            },
            FlowNodeRuntime {
                node_id: "t2".into(),
                subagent_run_id: Some("run-2".into()),
                subagent_id: Some("a-run-2".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            },
            FlowNodeRuntime {
                node_id: "t3".into(),
                subagent_run_id: Some("run-3".into()),
                subagent_id: Some("a-run-3".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            },
            // t4：run 映射存在但 session_agents 无行 → fail-open 按失败处理
            FlowNodeRuntime {
                node_id: "t4".into(),
                subagent_run_id: Some("run-4".into()),
                subagent_id: None,
                subagent_session_id: None,
                wakeup_sent: false,
            },
        ],
    );
    db.save_session_agents(
        "s1",
        &[
            sample_agent("run-1", "completed"),
            sample_agent("run-2", "running"),
            // stopped 归一 failed（读回宽容，subagent.rs:458-465）
            sample_agent("run-3", "stopped"),
        ],
    )
    .unwrap();

    let (decl, state, on_failed, agents) = read_raw_flow(&db);
    let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
    assert_eq!(snap.nodes.len(), 4, "节点数 = 声明任务数");
    let by_id: HashMap<&str, &FlowSnapshotNode> =
        snap.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    // 状态与持久化数据一致（flow_state + session_agents 拼装）
    assert_eq!(by_id["t1"].state, "completed");
    assert_eq!(by_id["t1"].subagent_run_id.as_deref(), Some("run-1"));
    assert_eq!(by_id["t2"].state, "running");
    assert_eq!(by_id["t2"].subagent_run_id.as_deref(), Some("run-2"));
    assert_eq!(by_id["t3"].state, "failed", "stopped 归一 failed");
    assert_eq!(by_id["t4"].state, "failed", "run 记录缺失 fail-open");
    assert_eq!(by_id["t4"].subagent_run_id.as_deref(), Some("run-4"));
    // 声明字段透传（含依赖边）
    assert_eq!(by_id["t1"].depends_on, Vec::<String>::new());
    assert_eq!(
        by_id["t3"].depends_on,
        vec!["t1".to_string(), "t2".to_string()]
    );
    assert!(by_id["t1"].parallel);
    assert!(by_id["t3"].is_composite);
    assert!(!by_id["t2"].is_composite);
    assert_eq!(by_id["t3"].task, "评审验收");
}

/// Block 传播：前置 failed（生效策略 Block）→ 后置 blocked（含传递阻塞）
#[test]
fn flow_snapshot_propagates_blocked_transitively() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    write_declaration(
        &db,
        vec![
            FlowNode {
                id: "a".into(),
                task: "任务 A".into(),
                depends_on: vec![],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "b".into(),
                task: "任务 B".into(),
                depends_on: vec!["a".into()],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "c".into(),
                task: "任务 C".into(),
                depends_on: vec!["b".into()],
                parallel: false,
                on_failed: None,
                is_composite: false,
            },
        ],
    );
    write_flow_state(
        &db,
        vec![FlowNodeRuntime {
            node_id: "a".into(),
            subagent_run_id: Some("run-a".into()),
            subagent_id: Some("a-run-a".into()),
            subagent_session_id: None,
            wakeup_sent: false,
        }],
    );
    db.save_session_agents("s1", &[sample_agent("run-a", "failed")])
        .unwrap();

    // 无 flow_on_failed 键 → 会话级默认 Block：b、c 传递阻塞
    let (decl, state, on_failed, agents) = read_raw_flow(&db);
    let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
    let by_id: HashMap<&str, &FlowSnapshotNode> =
        snap.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    assert_eq!(by_id["a"].state, "failed");
    assert_eq!(by_id["b"].state, "blocked");
    assert_eq!(by_id["c"].state, "blocked", "Block 传递阻塞");
    assert!(by_id["b"].subagent_run_id.is_none(), "阻塞节点不会被 spawn");
}

/// 失败策略放宽：flow_on_failed = skip → 前置 failed 不阻塞后置（保持 pending）
#[test]
fn flow_snapshot_skip_strategy_does_not_block() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    write_declaration(
        &db,
        vec![
            FlowNode {
                id: "a".into(),
                task: "任务 A".into(),
                depends_on: vec![],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "b".into(),
                task: "任务 B".into(),
                depends_on: vec!["a".into()],
                parallel: false,
                on_failed: None,
                is_composite: false,
            },
        ],
    );
    write_flow_state(
        &db,
        vec![FlowNodeRuntime {
            node_id: "a".into(),
            subagent_run_id: Some("run-a".into()),
            subagent_id: Some("a-run-a".into()),
            subagent_session_id: None,
            wakeup_sent: false,
        }],
    );
    db.save_session_agents("s1", &[sample_agent("run-a", "failed")])
        .unwrap();
    db.set_session_meta(FLOW_ON_FAILED_KEY, "skip").unwrap();

    let (decl, state, on_failed, agents) = read_raw_flow(&db);
    let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
    let by_id: HashMap<&str, &FlowSnapshotNode> =
        snap.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    assert_eq!(by_id["a"].state, "failed");
    assert_eq!(
        by_id["b"].state, "pending",
        "Skip 策略：失败视为满足，不阻塞"
    );
}

/// 节点级策略覆盖：失败节点的节点级 on_failed 放宽（Report）→ 其依赖者
/// 不被阻塞（生效策略取**失败节点**的覆盖 ?? 会话级默认，对齐 effective_strategy）
#[test]
fn flow_snapshot_node_level_strategy_override() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    write_declaration(
        &db,
        vec![
            FlowNode {
                id: "a".into(),
                task: "任务 A".into(),
                depends_on: vec![],
                parallel: true,
                on_failed: Some(FailStrategy::Report),
                is_composite: false,
            },
            FlowNode {
                id: "b".into(),
                task: "任务 B".into(),
                depends_on: vec!["a".into()],
                parallel: false,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "d".into(),
                task: "任务 D".into(),
                depends_on: vec![],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "c".into(),
                task: "任务 C".into(),
                depends_on: vec!["d".into()],
                parallel: false,
                on_failed: None,
                is_composite: false,
            },
        ],
    );
    write_flow_state(
        &db,
        vec![
            FlowNodeRuntime {
                node_id: "a".into(),
                subagent_run_id: Some("run-a".into()),
                subagent_id: Some("a-run-a".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            },
            FlowNodeRuntime {
                node_id: "d".into(),
                subagent_run_id: Some("run-d".into()),
                subagent_id: Some("a-run-d".into()),
                subagent_session_id: None,
                wakeup_sent: false,
            },
        ],
    );
    db.save_session_agents(
        "s1",
        &[
            sample_agent("run-a", "failed"),
            sample_agent("run-d", "failed"),
        ],
    )
    .unwrap();

    let (decl, state, on_failed, agents) = read_raw_flow(&db);
    let snap = build_flow_snapshot(decl, state, on_failed, &agents).unwrap();
    let by_id: HashMap<&str, &FlowSnapshotNode> =
        snap.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    assert_eq!(by_id["a"].state, "failed");
    assert_eq!(
        by_id["b"].state, "pending",
        "失败节点 a 的 Report 覆盖会话级 Block"
    );
    assert_eq!(by_id["d"].state, "failed");
    assert_eq!(
        by_id["c"].state, "blocked",
        "失败节点 d 未覆盖 → 按会话级 Block 阻塞"
    );
}

/// 损坏 JSON 显式报错（与 FlowScheduler::load 的解析失败语义一致）
#[test]
fn flow_snapshot_parse_failure_errors() {
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&sample_entry("s1")).unwrap();
    db.set_session_meta(FLOW_DECLARATION_KEY, "{corrupt")
        .unwrap();
    let (decl, state, on_failed, agents) = read_raw_flow(&db);
    let err = build_flow_snapshot(decl, state, on_failed, &agents).expect_err("损坏 JSON 应报错");
    match err {
        CoreError::Internal(msg) => assert!(msg.contains("flow_declaration 解析失败")),
        other => panic!("expected Internal, got {other:?}"),
    }
}

/// 序列化形状：冻结载荷形状逐键断言（camelCase；subagentRunId 缺省省略；
/// dependsOn 恒输出数组）
#[test]
fn flow_snapshot_serializes_frozen_camel_case_shape() {
    let snap = FlowSnapshot {
        nodes: vec![
            FlowSnapshotNode {
                id: "t1".into(),
                task: "分析".into(),
                depends_on: vec![],
                parallel: true,
                is_composite: false,
                state: "completed".into(),
                subagent_run_id: Some("run-1".into()),
            },
            FlowSnapshotNode {
                id: "t3".into(),
                task: "评审".into(),
                depends_on: vec!["t1".into(), "t2".into()],
                parallel: false,
                is_composite: true,
                state: "pending".into(),
                subagent_run_id: None,
            },
        ],
    };
    let json = serde_json::to_value(&snap).unwrap();
    assert!(json.get("nodes").is_some(), "根键 nodes（冻结形状）");
    let n0 = &json["nodes"][0];
    assert_eq!(n0["id"], "t1");
    assert_eq!(n0["task"], "分析");
    assert_eq!(n0["dependsOn"], serde_json::json!([]), "空依赖恒输出数组");
    assert_eq!(n0["parallel"], true);
    assert_eq!(n0["isComposite"], false);
    assert_eq!(n0["state"], "completed");
    assert_eq!(n0["subagentRunId"], "run-1");
    let n1 = &json["nodes"][1];
    assert_eq!(n1["dependsOn"], serde_json::json!(["t1", "t2"]));
    assert!(
        n1.get("subagentRunId").is_none(),
        "未启动节点省略 subagentRunId"
    );
    // 不得出现 snake_case 键
    assert!(n0.get("depends_on").is_none());
    assert!(n0.get("is_composite").is_none());
    assert!(n0.get("subagent_run_id").is_none());
}
