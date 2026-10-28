use std::sync::Arc;

use agent_tools::tools::subagent::{SubagentSpawner, SubagentState};
use orchestrator::flow_graph::{
    FlowDeclaration, FlowNode, FlowNodeState, FlowReportKind, FlowScheduler, FLOW_STATE_KEY,
};
use orchestrator::persist::LocalDbStore;
use orchestrator::subagent_events::SubagentEventEmitter;

use super::{setup_main_run, test_rig, ImmediateTerminalLauncher};
use crate::subagent_spawner::types::SubagentRunLauncher;

// ── DAG 端到端（T-D-13 验收：declare_flow → spawn 节点 run → 终态推进）──
// 契约层等价面：FlowScheduler（orchestrator 公共 API）+ 生产 spawner
// （SubagentSpawnerImpl，mock launcher 注入）——对齐
// orchestrator/tests/multi_agent.rs:777 注释的「引擎侧驱动环」等价面：
// 调度器经 spawner.spawn（flow_node_id 回显）启动节点 run，终态事件
// 经 on_subagent_terminal 回传推进。

#[tokio::test]
async fn dag_flow_scheduler_with_production_spawner_end_to_end() {
    let (spawner, launcher, db, _, _) = test_rig();
    setup_main_run(&spawner);
    // FlowScheduler 装配（LocalDb 即 FlowMetaStore；会话级 meta 读写）
    let mut scheduler = FlowScheduler::new(
        "sess-main",
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        Arc::new(db.clone()),
    )
    .expect("调度器创建");
    // 声明编排：A（无依赖）→ B（依赖 A）
    let decl = FlowDeclaration {
        tasks: vec![
            FlowNode {
                id: "node-a".to_string(),
                task: "调研模块 A".to_string(),
                depends_on: Vec::new(),
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "node-b".to_string(),
                task: "调研模块 B".to_string(),
                depends_on: vec!["node-a".to_string()],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
        ],
        planner_run_id: Some("run-main".to_string()),
    };
    let advance = scheduler.declare_flow(&decl).await.expect("声明编排成功");

    // 首波推进：A spawn（B 被 A 阻塞）
    assert_eq!(advance.started.len(), 1, "A 应启动");
    assert_eq!(advance.started[0].node_id, "node-a");
    let run_a = advance.started[0].subagent_run_id.clone();
    assert!(!advance.flow_terminal);
    // spawner 侧：flow 路径请求携带 parent_run_id = planner_run_id
    let launches = launcher.launches();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].parent_run_id.as_deref(), Some("run-main"));
    let rows = db.load_session_agents("sess-main").expect("行");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].parent_run_id, "run-main");

    // A 终态回传 → 推进：B spawn
    let advance_b = scheduler
        .on_subagent_terminal(&run_a, SubagentState::Completed)
        .await
        .expect("终态推进");
    assert_eq!(advance_b.started.len(), 1, "B 应启动");
    assert_eq!(advance_b.started[0].node_id, "node-b");
    assert_eq!(
        scheduler.node_state("node-a"),
        Some(FlowNodeState::Completed)
    );
    assert_eq!(scheduler.node_state("node-b"), Some(FlowNodeState::Running));
    let run_b = advance_b.started[0].subagent_run_id.clone();

    // B 终态回传 → 编排完成
    let advance_final = scheduler
        .on_subagent_terminal(&run_b, SubagentState::Completed)
        .await
        .expect("终态推进");
    assert!(advance_final.flow_terminal, "全部节点终态 → 编排完成");
    assert_eq!(
        scheduler.node_state("node-b"),
        Some(FlowNodeState::Completed)
    );
    // 幂等：同 run 重复终态通知忽略（不重复推进）
    let again = scheduler
        .on_subagent_terminal(&run_b, SubagentState::Completed)
        .await
        .expect("幂等通知");
    assert!(again.started.is_empty(), "重复终态不重复 spawn");
    // 两个子代理行（A、B）
    assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 2);
}

#[tokio::test]
async fn flow_started_event_is_attempted_before_fast_terminal_event() {
    let (spawner, _, db, stream, queue) = test_rig();
    let launcher = Arc::new(ImmediateTerminalLauncher::default());
    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    launcher.attach(&spawner);
    setup_main_run(&spawner);

    let emitter = SubagentEventEmitter::new(Arc::new(LocalDbStore::new(db.clone())));
    let mut scheduler = FlowScheduler::new(
        "sess-main",
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        Arc::new(db.clone()),
    )
    .expect("FlowScheduler")
    .with_subagent_event_emitter(emitter);
    let declaration = FlowDeclaration {
        tasks: vec![FlowNode {
            id: "fast-node".to_string(),
            task: "立即结束的 flow task".to_string(),
            depends_on: Vec::new(),
            parallel: true,
            on_failed: None,
            is_composite: false,
        }],
        planner_run_id: Some("run-main".to_string()),
    };

    let advance = scheduler
        .declare_flow(&declaration)
        .await
        .expect("flow 应启动");
    let run_id = advance.started[0].subagent_run_id.clone();
    launcher.wait_for_terminal().await;
    scheduler
        .on_subagent_terminal(&run_id, SubagentState::Completed)
        .await
        .expect("flow 终态应收口");

    let lifecycle: Vec<String> = db
        .query_events("sess-main", 0, Some(100))
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.payload.contains(&run_id)
                && (event.event_type == "subagent-started" || event.event_type == "subagent-ended")
        })
        .map(|event| event.event_type)
        .collect();
    assert_eq!(lifecycle, vec!["subagent-started", "subagent-ended"]);
    assert_eq!(spawner.active_count_for_test(), 0);
}

#[tokio::test]
async fn flow_without_event_emitter_keeps_zero_lifecycle_events() {
    let (spawner, _, db, stream, queue) = test_rig();
    let launcher = Arc::new(ImmediateTerminalLauncher::default());
    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    launcher.attach(&spawner);
    setup_main_run(&spawner);

    let mut scheduler = FlowScheduler::new(
        "sess-main",
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        Arc::new(db.clone()),
    )
    .expect("FlowScheduler");
    let declaration = FlowDeclaration {
        tasks: vec![FlowNode {
            id: "quiet-node".to_string(),
            task: "不发事件的 flow task".to_string(),
            depends_on: Vec::new(),
            parallel: true,
            on_failed: None,
            is_composite: false,
        }],
        planner_run_id: Some("run-main".to_string()),
    };

    let advance = scheduler
        .declare_flow(&declaration)
        .await
        .expect("flow 应启动");
    let run_id = advance.started[0].subagent_run_id.clone();
    launcher.wait_for_terminal().await;
    scheduler
        .on_subagent_terminal(&run_id, SubagentState::Completed)
        .await
        .expect("flow 终态应收口");

    let lifecycle_events: Vec<_> = db
        .query_events("sess-main", 0, Some(100))
        .unwrap()
        .into_iter()
        .filter(|event| {
            event.payload.contains(&run_id)
                && (event.event_type == "subagent-started" || event.event_type == "subagent-ended")
        })
        .collect();
    assert!(
        lifecycle_events.is_empty(),
        "未配置 emitter 时 flow 不发事件"
    );
    assert_eq!(spawner.active_count_for_test(), 0);
}

/// DAG 失败推进：节点失败（Block 策略默认）→ 依赖节点阻塞 + 上报
#[tokio::test]
async fn dag_failed_node_blocks_dependents() {
    let (spawner, _, db, _, _) = test_rig();
    setup_main_run(&spawner);
    let mut scheduler = FlowScheduler::new(
        "sess-main",
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        Arc::new(db.clone()),
    )
    .expect("调度器创建");
    let decl = FlowDeclaration {
        tasks: vec![
            FlowNode {
                id: "node-a".to_string(),
                task: "任务 A".to_string(),
                depends_on: Vec::new(),
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
            FlowNode {
                id: "node-b".to_string(),
                task: "任务 B".to_string(),
                depends_on: vec!["node-a".to_string()],
                parallel: true,
                on_failed: None,
                is_composite: false,
            },
        ],
        planner_run_id: Some("run-main".to_string()),
    };
    let advance = scheduler.declare_flow(&decl).await.expect("声明编排成功");
    let run_a = advance.started[0].subagent_run_id.clone();

    // A 失败 → Block 策略：B 阻塞 + 失败上报（不 spawn B）；
    // Blocked 为终态（all_terminal 含 Blocked）→ 编排收敛
    let advance_fail = scheduler
        .on_subagent_terminal(&run_a, SubagentState::Failed)
        .await
        .expect("失败推进");
    assert!(advance_fail.started.is_empty(), "B 被阻塞不得 spawn");
    assert!(
        advance_fail.flow_terminal,
        "A failed + B blocked → 编排收敛"
    );
    assert!(
        advance_fail.reports.iter().any(|r| r.node_id == "node-b"),
        "Block 传播上报：{reports:?}",
        reports = advance_fail.reports
    );
    assert_eq!(scheduler.node_state("node-b"), Some(FlowNodeState::Blocked));
}

// ── F-013 接线（生产 spawner 落库 flow_node_id，双防线②数据源）──

/// F-013 红测试（生产 spawner 形态）：flow 调度请求 description=None +
/// flow_node_id 存在 → 落库行 description 必须承载 flow_node_id，使
/// load() 反向校验（双防线②，flow_graph.rs:1409-1442 读 row.description
/// 定位节点）在生产域可命中。修复前：row_for 写 description =
/// req.description（flow 请求恒 None → 空串），反向校验不命中，崩溃
/// 窗口形态节点保持 Pending → 重启 advance 会重复 spawn（孤儿双跑）。
#[tokio::test]
async fn flow_spawn_row_carries_flow_node_id_for_load_reverse_check() {
    let (spawner, _, db, _, _) = test_rig();
    setup_main_run(&spawner);
    let mut scheduler = FlowScheduler::new(
        "sess-main",
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        Arc::new(db.clone()),
    )
    .expect("调度器创建");
    let decl = FlowDeclaration {
        tasks: vec![FlowNode {
            id: "node-a".to_string(),
            task: "调研模块 A".to_string(),
            depends_on: Vec::new(),
            parallel: true,
            on_failed: None,
            is_composite: false,
        }],
        planner_run_id: Some("run-main".to_string()),
    };
    let advance = scheduler.declare_flow(&decl).await.expect("声明编排成功");
    assert_eq!(advance.started.len(), 1, "a 应启动");
    let run_a = advance.started[0].subagent_run_id.clone();

    // 断言 1（数据源落库）：run 行 description 承载 flow_node_id
    // （load 反向校验以 row.description 为节点定位载体）
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].description, "node-a",
        "flow 路径行 description 应承载 flow_node_id（修复前为空串）"
    );

    // 崩溃窗口模拟（T3.4 形态 B）：run 已落库、flow_state 置空 →
    // 重启 load 反向校验须命中并置 Failed（防重复 spawn）
    db.set_session_meta(FLOW_STATE_KEY, "[]").unwrap();
    drop(scheduler);

    let rows = db.load_session_agents("sess-main").unwrap();
    let mut restored = FlowScheduler::load(
        "sess-main",
        Arc::clone(&spawner) as Arc<dyn SubagentSpawner>,
        Arc::new(db.clone()),
        &rows,
    )
    .expect("load 应成功");

    // 断言 2（反向校验命中）：a = Failed（修复前保持 Pending）
    assert_eq!(
        restored.node_state("node-a"),
        Some(FlowNodeState::Failed),
        "反向校验：生产 spawner 落库后 flow_state 无映射 → a = Failed"
    );
    // 断言 3（防双跑核心）：advance 不再 spawn a（DataInconsistent
    // 上报带出 + started 为空）
    let adv = restored.advance().await.expect("advance 应成功");
    assert!(
        adv.reports
            .iter()
            .any(|r| r.kind == FlowReportKind::DataInconsistent && r.node_id == "node-a"),
        "restart_reports 应含 DataInconsistent：{:?}",
        adv.reports
    );
    assert!(adv.started.is_empty(), "a 已按 Failed 处理，不得重复 spawn");
    // 防双跑：run 行数量不变（load + advance 未新增 spawn）
    assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 1);
    let _ = run_a;
}
