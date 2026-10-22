use std::sync::atomic::Ordering;
use std::sync::Arc;

use agent_tools::tools::subagent::{SubagentSpawnError, SubagentSpawner, SubagentState, TaskType};
use conex_db::LocalDb;

use super::{
    request, setup_main_run, test_rig, FailSecondLauncher, PanickingLauncher, RecordingLauncher,
};
use crate::subagent_spawner::lifecycle::{RunLaunchLifecycle, StartedEventCompletionGuard};
use crate::subagent_spawner::spawner::SubagentSpawnerImpl;
use crate::subagent_spawner::types::{SubagentRunConfig, SubagentRunLauncher};

// ── 单发端到端（落库 v6 列 / 启动装配 / 结果信封）──────────────

#[tokio::test]
async fn spawn_single_persists_row_and_launches_run() {
    let (spawner, launcher, db, _, _) = test_rig();
    setup_main_run(&spawner);

    let result = spawner
        .spawn(&request("完成调研 A", Some(TaskType::Analysis)))
        .await
        .expect("spawn 应成功");

    // 结果信封：id / run id / 会话 / running / display_label 回显
    assert!(result.subagent_id.starts_with("sub-1-"));
    assert!(result.subagent_run_id.starts_with("sub-run-1-"));
    assert!(result.session_id.starts_with("sub-sess-1-"));
    assert_eq!(result.status, SubagentState::Running);
    assert_eq!(result.display_label.as_deref(), Some("调研员"));

    // session_agents 落库（v6 新列 task_type / display_label /
    // allowed_write_paths_json + parent 链 + depth）
    let rows = db.load_session_agents("sess-main").expect("读行");
    assert_eq!(rows.len(), 1, "恰好一行");
    let row = &rows[0];
    assert_eq!(row.id, result.subagent_id);
    assert_eq!(row.subagent_run_id, result.subagent_run_id);
    assert_eq!(row.parent_session_id, "sess-main");
    assert_eq!(row.parent_run_id, "run-main");
    assert_eq!(row.parent_tool_call_id.as_deref(), Some("call-1"));
    assert_eq!(row.status, "running", "pending 首写即 running");
    assert_eq!(row.depth, Some(1), "直接子代理深度 1");
    assert_eq!(row.task_type.as_deref(), Some("analysis"));
    assert_eq!(row.display_label.as_deref(), Some("调研员"));
    let paths: Vec<String> =
        serde_json::from_str(row.allowed_write_paths_json.as_deref().unwrap()).unwrap();
    assert_eq!(paths, vec!["docs/"]);
    assert!(row.started_at > 0);
    // D-02 LK-04：反向导航键行级落库（子会话 id = sub-sess-{depth}-{n}）
    assert_eq!(
        row.sub_session_id.as_deref(),
        Some(result.session_id.as_str()),
        "行 sub_session_id == 子会话 id（子会话 → session_agents 行反查）"
    );

    // D-02 LK-04：subagent-started 事件体信封携带子会话 id（跨会话导航
    // 键：父会话三事件视图 → 子会话事件流）
    let events = db
        .query_events("sess-main", 0, Some(100))
        .expect("事件查询");
    let started: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "subagent-started")
        .collect();
    assert_eq!(started.len(), 1, "subagent-started 必达落库");
    let started_value: serde_json::Value =
        serde_json::from_str(&started[0].payload).expect("payload 应为 JSON");
    assert_eq!(
        started_value["subagentSessionId"].as_str(),
        Some(result.session_id.as_str()),
        "started 事件体信封 subagentSessionId == 子会话 id"
    );

    // 独立 run 启动：launcher 收到 subagent_config（task_type / started_at
    // / parent_run_id 透传；产出目录缺省 None）
    let launches = launcher.launches();
    assert_eq!(launches.len(), 1);
    let options = &launches[0];
    assert_eq!(options.run_id, result.subagent_run_id);
    assert_eq!(options.session_id, result.session_id);
    assert_eq!(options.parent_run_id.as_deref(), Some("run-main"));
    let config = options.subagent_config.as_ref().expect("子代理配置");
    assert_eq!(config.subagent_id, result.subagent_id);
    assert_eq!(config.subagent_run_id, result.subagent_run_id);
    assert_eq!(config.parent_session_id, "sess-main");
    assert_eq!(config.task_type.as_deref(), Some("analysis"));
    assert_eq!(
        config.started_at_ms, row.started_at,
        "started_at 与落库同源（C2）"
    );
    assert!(config.output_dir.is_none());
}

/// 工具直调路径（parent_run_id 恒 None）：按发起会话的当前活动 run 补齐
#[tokio::test]
async fn spawn_resolves_parent_run_from_current_session() {
    let (spawner, _, db, _, _) = test_rig();
    setup_main_run(&spawner);

    let mut req = request("调研", None);
    req.parent_run_id = None; // 工具直调路径：请求不携带父 run
    let result = spawner.spawn(&req).await.expect("spawn 应成功");
    let _ = result;

    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows[0].parent_run_id, "run-main", "发起 run 按会话补齐");
}

/// 默认模型继承（REQ-D03）：spawn 未携带模型覆盖 → 子代理 run 的
/// provider 装配面与主 agent 一致（同一 engine provider 全局单例）；
/// model_override 恒 None 且无消费逻辑（构造点显式 None 编译器强制，
/// 引擎侧读取即编译断裂——此处断言请求携带值也不影响装配）
#[tokio::test]
async fn spawn_model_inheritance_and_override_never_consumed() {
    let (spawner, launcher, _, _, _) = test_rig();
    setup_main_run(&spawner);

    let mut req = request("调研", None);
    req.model_override = Some("grok-3".to_string());
    let _ = spawner.spawn(&req).await.expect("spawn 应成功");
    let launches = launcher.launches();
    assert_eq!(launches.len(), 1);
    // subagent_config 不含任何模型字段（模型走 engine provider 全局单例；
    // Debug 面断言字段集，编译期构造点恒 None 为强制面）
    let config = launches[0].subagent_config.as_ref().unwrap();
    assert!(!format!("{config:?}").contains("model"));
}

// ── 启动失败兜底（行归一 failed；灾难性失败路径）──────────────

#[tokio::test]
async fn spawn_launch_failure_marks_row_failed() {
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
    // 行已落库但归一 failed（防僵尸 running）
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "failed");
    assert!(rows[0].ended_at.is_some());
    assert_eq!(spawner.active_count_for_test(), 0, "启动失败须释放预留");
}

#[tokio::test]
async fn spawn_launcher_panic_marks_row_failed_and_releases_capacity() {
    let (spawner, _, db, _, _) = test_rig();
    let launcher = Arc::new(PanickingLauncher);
    spawner.init(
        Some(launcher as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        None,
        None,
    );
    setup_main_run(&spawner);

    let err = spawner
        .spawn(&request("启动器 panic", None))
        .await
        .expect_err("启动器 panic 必须归一为启动失败");
    assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, "failed");
    assert!(rows[0].ended_at.is_some());
    assert_eq!(spawner.active_count_for_test(), 0, "panic 后必须释放容量");

    let terminal_events: Vec<_> = db
        .query_events("sess-main", 0, Some(100))
        .unwrap()
        .into_iter()
        .filter(|event| event.event_type == "subagent-ended")
        .collect();
    assert_eq!(terminal_events.len(), 1, "panic 收口只发一条 failed 终态");
    assert!(terminal_events[0].payload.contains("failed"));
}

#[tokio::test]
async fn started_event_completion_guard_unblocks_terminal_after_panic() {
    let lifecycle = Arc::new(RunLaunchLifecycle::new());
    lifecycle.mark_launch_succeeded(false);
    let event_lifecycle = Arc::clone(&lifecycle);
    let task = tokio::spawn(async move {
        let _completion = StartedEventCompletionGuard(event_lifecycle);
        panic!("simulated started emitter panic");
    });
    assert!(task.await.is_err(), "模拟发射任务应 panic");

    let terminal = tokio::time::timeout(std::time::Duration::from_millis(100), async {
        lifecycle.stage_terminal(SubagentState::Completed);
        lifecycle.wait_until_terminal_ready().await
    })
    .await
    .expect("emitter panic 后终态等待不得卡住");
    assert_eq!(terminal, Some(SubagentState::Completed));
}

#[tokio::test]
async fn spawn_persist_failure_releases_reservation() {
    let (spawner, launcher, db, stream, queue) = test_rig();
    setup_main_run(&spawner);
    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        None,
        Some(Arc::clone(&stream)),
        Some(Arc::clone(&queue)),
    );

    let err = spawner
        .spawn(&request("存储未接线", None))
        .await
        .expect_err("缺少存储时应失败");
    assert!(matches!(err, SubagentSpawnError::PersistFailed(_)));
    assert_eq!(spawner.active_count_for_test(), 0, "落库失败须释放预留");
    assert!(launcher.launches().is_empty(), "落库失败不得启动 run");

    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        Some(db),
        Some(stream),
        Some(queue),
    );
    spawner
        .spawn(&request("存储恢复后", None))
        .await
        .expect("落库失败后容量应可复用");
    assert_eq!(spawner.active_count_for_test(), 1);
}

#[tokio::test]
async fn spawn_many_launch_failure_keeps_success_and_releases_rest() {
    let (spawner, _, db, stream, queue) = test_rig();
    let launcher = Arc::new(FailSecondLauncher::default());
    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    setup_main_run(&spawner);
    let requests: Vec<_> = (0..3)
        .map(|index| request(&format!("部分批量 {index}"), None))
        .collect();

    let err = spawner
        .spawn_many(&requests)
        .await
        .expect_err("第二次启动失败应上抛");
    assert!(matches!(err, SubagentSpawnError::SpawnFailed(_)));
    assert_eq!(launcher.attempts.load(Ordering::SeqCst), 2);
    assert_eq!(spawner.active_count_for_test(), 1, "保留首个成功 run 槽");

    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 2, "第三项未尝试，因此无落库行");
    assert_eq!(rows[0].status, "running");
    assert_eq!(rows[1].status, "failed");

    let first = &rows[0];
    let cfg = SubagentRunConfig {
        subagent_id: first.id.clone(),
        subagent_run_id: first.subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: first.started_at,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Completed)
        .await;
    assert_eq!(spawner.active_count_for_test(), 0);
}

// ── 终态处理（记账释放 / 行更新 / 事件 / wait feed / steering）──

#[tokio::test]
async fn terminal_releases_accounting_and_notifies() {
    let (spawner, _, db, stream, queue) = test_rig();
    setup_main_run(&spawner);
    // 订阅 wait 通道（终态事件 feed 断言）
    let mut rx = stream.subscribe();

    let result = spawner
        .spawn(&request("调研", Some(TaskType::Analysis)))
        .await
        .expect("spawn 应成功");
    let cfg = SubagentRunConfig {
        subagent_id: result.subagent_id.clone(),
        subagent_run_id: result.subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: Some("analysis".to_string()),
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Completed)
        .await;

    // 1. 行终态更新（status/ended_at/summary）
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows[0].status, "completed");
    assert!(rows[0].ended_at.is_some());
    assert!(rows[0].summary.is_some());

    // 2. subagent-ended 落库（父会话事件流，M14 唯一发射方）
    let events = db
        .query_events("sess-main", 0, Some(100))
        .expect("事件查询");
    let ended: Vec<_> = events
        .iter()
        .filter(|e| e.event_type == "subagent-ended")
        .collect();
    assert_eq!(ended.len(), 1, "subagent-ended 必达落库");
    assert!(ended[0].payload.contains(&result.subagent_run_id));

    // 3. wait 通道 feed（订阅者实时收到终态事件）
    let terminal = tokio::time::timeout(std::time::Duration::from_secs(3), rx.recv())
        .await
        .expect("wait 通道事件应在窗口内到达")
        .expect("通道未关闭");
    assert_eq!(terminal.subagent_id, result.subagent_id);
    assert_eq!(terminal.status, SubagentState::Completed);

    // 4. steering 通知（主 agent 下一 run 唤醒条目）
    let entries = {
        let mut q = queue.lock().unwrap();
        q.dequeue_all()
    };
    assert_eq!(entries.len(), 1);
    assert!(entries[0].is_steering);
    assert!(
        entries[0].text.contains("子代理"),
        "摘要模板：{}",
        entries[0].text
    );
    assert!(entries[0].text.contains("成功"));
    assert!(entries[0].text.contains(&result.subagent_id));
}
