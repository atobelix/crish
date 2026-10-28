use std::sync::atomic::Ordering;
use std::sync::Arc;

use agent_tools::tools::subagent::{SubagentSpawnError, SubagentSpawner, SubagentState};
use conex_db::LocalDb;

use super::{
    request, setup_main_run, test_rig, GateLauncher, ImmediateTerminalLauncher, RecordingLauncher,
};
use crate::subagent_spawner::spawner::SubagentSpawnerImpl;
use crate::subagent_spawner::types::{SubagentRunConfig, SubagentRunLauncher};

#[tokio::test]
async fn cancelled_spawn_keeps_launched_run_owned_until_terminal() {
    let (spawner, _, db, stream, queue) = test_rig();
    let gate = Arc::new(GateLauncher::new());
    spawner.init(
        Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    setup_main_run(&spawner);

    let task_spawner = Arc::clone(&spawner);
    let task =
        tokio::spawn(async move { task_spawner.spawn(&request("取消中的单发", None)).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), gate.started.acquire())
        .await
        .expect("单发应进入 launcher")
        .expect("started semaphore remains open")
        .forget();

    assert_eq!(spawner.active_count_for_test(), 1);
    task.abort();
    let _ = task.await;

    assert_eq!(
        spawner.active_count_for_test(),
        1,
        "启动操作仍在后台运行，容量继续占用"
    );
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "running", "调用方取消不应伪造子代理失败");

    gate.resume(1);
    let lifecycle = spawner
        .launch_lifecycle(&rows[0].subagent_run_id)
        .expect("后台启动任务应保留生命周期");
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        lifecycle.wait_until_started_event_complete(),
    )
    .await
    .expect("后台启动任务应继续完成 started 事件");
    let cfg = SubagentRunConfig {
        subagent_id: rows[0].id.clone(),
        subagent_run_id: rows[0].subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: rows[0].started_at,
        permission_mode: None,
        capability_mode: None,
        model_override: None,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Completed)
        .await;
    assert_eq!(spawner.active_count_for_test(), 0, "真实终态释放启动预留");
    let ended = db.load_session_agents("sess-main").unwrap();
    assert_eq!(ended[0].status, "completed");
    assert!(ended[0].ended_at.is_some());
}

#[tokio::test]
async fn cancelled_batch_keeps_launched_run_and_releases_unstarted_reservations() {
    let (spawner, _, db, stream, queue) = test_rig();
    let gate = Arc::new(GateLauncher::new());
    spawner.init(
        Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    setup_main_run(&spawner);

    let requests: Vec<_> = (0..3)
        .map(|index| request(&format!("取消中的批量 {index}"), None))
        .collect();
    let task_spawner = Arc::clone(&spawner);
    let task = tokio::spawn(async move { task_spawner.spawn_many(&requests).await });
    tokio::time::timeout(std::time::Duration::from_secs(3), gate.started.acquire())
        .await
        .expect("批量首项应进入 launcher")
        .expect("started semaphore remains open")
        .forget();

    assert_eq!(spawner.active_count_for_test(), 3, "整批容量在启动前预留");
    task.abort();
    let _ = task.await;

    assert_eq!(
        spawner.active_count_for_test(),
        1,
        "仅当前后台启动项保留容量"
    );
    assert_eq!(gate.launches.load(Ordering::SeqCst), 1);
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 1, "仅尝试的首项有落库行");
    assert_eq!(rows[0].status, "running");

    gate.resume(1);
    let lifecycle = spawner
        .launch_lifecycle(&rows[0].subagent_run_id)
        .expect("后台启动任务应保留生命周期");
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        lifecycle.wait_until_started_event_complete(),
    )
    .await
    .expect("后台启动任务应继续完成 started 事件");
    let cfg = SubagentRunConfig {
        subagent_id: rows[0].id.clone(),
        subagent_run_id: rows[0].subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: rows[0].started_at,
        permission_mode: None,
        capability_mode: None,
        model_override: None,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Completed)
        .await;
    assert_eq!(spawner.active_count_for_test(), 0, "真实终态释放活动项");
    assert_eq!(
        db.load_session_agents("sess-main").unwrap()[0].status,
        "completed"
    );
}

#[tokio::test]
async fn terminal_before_launcher_return_releases_once_and_preserves_event_order() {
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

    let result = spawner
        .spawn(&request("启动期间立即终态", None))
        .await
        .expect("快速终态不应使 launch 返回失败");
    launcher.wait_for_terminal().await;
    assert_eq!(spawner.active_count_for_test(), 0);
    assert!(!spawner
        .tracking
        .runs
        .lock()
        .unwrap()
        .contains_key(&result.subagent_run_id));
    assert!(!spawner
        .tracking
        .run_depths
        .lock()
        .unwrap()
        .contains_key(&result.subagent_run_id));

    let cfg = SubagentRunConfig {
        subagent_id: result.subagent_id.clone(),
        subagent_run_id: result.subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1,
        permission_mode: None,
        capability_mode: None,
        model_override: None,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Completed)
        .await;
    assert_eq!(spawner.active_count_for_test(), 0, "重复终态不得二次释放");

    let events = db.query_events("sess-main", 0, Some(100)).unwrap();
    let lifecycle: Vec<&str> = events
        .iter()
        .filter(|event| {
            event.payload.contains(&result.subagent_run_id)
                && (event.event_type == "subagent-started" || event.event_type == "subagent-ended")
        })
        .map(|event| event.event_type.as_str())
        .collect();
    assert_eq!(lifecycle, vec!["subagent-started", "subagent-ended"]);

    let mut flow_request = request("flow 快速终态", None);
    flow_request.flow_node_id = Some("flow-node-fast".to_string());
    let flow_result = spawner
        .spawn(&flow_request)
        .await
        .expect("flow 快速终态应成功");
    launcher.wait_for_terminal().await;
    assert_eq!(spawner.active_count_for_test(), 0);
    assert!(!spawner
        .tracking
        .flow_nodes
        .lock()
        .unwrap()
        .contains_key(&flow_result.subagent_run_id));
    let events = db.query_events("sess-main", 0, Some(100)).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| {
                event.event_type == "subagent-ended"
                    && event.payload.contains(&flow_result.subagent_run_id)
            })
            .count(),
        0,
        "flow 快速终态由 FlowScheduler 发射，不应误走工具 ended 路径"
    );

    // 顺序完成的 run 可重复利用槽位，且每个均在 launcher 返回前回收。
    for index in 0..16 {
        spawner
            .spawn(&request(&format!("快速终态 {index}"), None))
            .await
            .expect("owner token 应在快速终态时被一次性释放");
        launcher.wait_for_terminal().await;
        assert_eq!(spawner.active_count_for_test(), 0);
    }
}

// ── LK-07（R-14 死路径收口：spawn 失败补 ended(failed) + 双发幂等）──

/// spawn 启动失败补发 subagent-ended(status=failed)：行已归一 failed
/// 但事件链为空（「行存在但无终态事件」断链）——launch 失败后事件表
/// 必须含 failed 终态（信封 runId = 父 run）
#[tokio::test]
async fn spawn_launch_failure_emits_ended_failed() {
    let launcher = Arc::new(RecordingLauncher::failing());
    let db = LocalDb::open_in_memory().unwrap();
    db.upsert_session_entry(&conex_types::SessionIndexEntry {
        id: "sess-main".to_string(),
        title: "主会话".to_string(),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: Some("run-main".to_string()),
        hydrated_from_engine: Some(true),
    })
    .unwrap();
    let spawner = Arc::new(SubagentSpawnerImpl::new());
    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        None,
        None,
    );
    spawner.register_run("run-main", "sess-main", None);
    spawner.set_current_run("sess-main", "run-main");

    let err = spawner
        .spawn(&request("调研", None))
        .await
        .expect_err("启动失败必须上抛 SpawnFailed");
    assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));

    // 事件链补齐：行 failed + ended(failed) 落库（此前断链——有行无事件）
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows[0].status, "failed");
    let events = db
        .query_events("sess-main", 0, Some(100))
        .expect("事件查询");
    let ended: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "subagent-ended")
        .collect();
    assert_eq!(ended.len(), 1, "启动失败补发 ended(failed)");
    assert!(
        ended[0].payload.contains("\"status\":\"failed\""),
        "failed 终态：{}",
        ended[0].payload
    );
    assert_eq!(
        ended[0].run_id.as_deref(),
        Some("run-main"),
        "信封 runId = 父 run"
    );
}

/// 双发幂等（LK-07 R-14）：kill 命令面已直发 ended(cancelled)（lifecycle
/// kill_all/kill_subagent 落库）后，run 收口兜底 on_subagent_terminal
/// 不再重复发射 ended——按「同一父 run 归属性已落库 subagent-ended」
/// 跳过落库发射（wait 通道仍以本地副本 feed）
#[tokio::test]
async fn terminal_skips_ended_when_kill_already_emitted() {
    let (spawner, _, db, stream, _) = test_rig();
    setup_main_run(&spawner);
    let mut rx = stream.subscribe();

    let result = spawner
        .spawn(&request("调研", None))
        .await
        .expect("spawn 应成功");

    // 模拟 kill 直发（lifecycle emit_killed_ended 同构）：父 run 归属
    // 落一条 subagent-ended(cancelled)
    let seq = db.reserve_sequence("sess-main").unwrap();
    db.append_event(
        "sess-main",
        seq,
        "subagent-ended",
        &format!(r#"{{"type":"subagent-ended","runId":"run-main","subagentId":"{}","status":"cancelled"}}"#, result.subagent_id),
        Some("run-main"),
    )
    .expect("kill 直发落库");

    // 收口兜底：kill 已直发 → 不再落库发射（双发消灭）
    let cfg = SubagentRunConfig {
        subagent_id: result.subagent_id.clone(),
        subagent_run_id: result.subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1,
        permission_mode: None,
        capability_mode: None,
        model_override: None,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Completed)
        .await;

    let events = db
        .query_events("sess-main", 0, Some(100))
        .expect("事件查询");
    let ended: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "subagent-ended")
        .collect();
    assert_eq!(ended.len(), 1, "kill 直发后收口兜底不重复发 ended");

    // wait 通道仍收到终态（订阅者收口不丢）
    let terminal = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
        .await
        .expect("wait 通道事件应在窗口内到达")
        .expect("通道未关闭");
    assert_eq!(terminal.subagent_id, result.subagent_id);
}
