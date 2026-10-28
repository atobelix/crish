//! run IPC 的壳层集成测试：验证真实 Tauri 侧注册表与远程 run 装配。
#![allow(clippy::disallowed_methods)]
#![allow(clippy::await_holding_lock)]

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_provider::config::Endpoint;
use agent_tools::background::{BackgroundAdoptRequest, BackgroundTaskManager, TaskState};
use conex_run::core_event_bridge::{Emitter, EventBridge};
use conex_run::run::{run_control_impl, run_task_impl, CoreRunState, RunTaskOptions};
use conex_run::status_diagnostics::StatusDiagnostics;
use orchestrator::persist::LocalDbStore;
use session_loop::provider::ProviderCall;
use session_loop::stream::{ProviderStreamEvent, StopReason};
use session_loop::testing::TestProvider;
use session_loop::tool_events::ApprovalDecision;
use tokio::process::Child;

use crate::background::BackgroundTaskRegistry;
use crate::core_backend::CoreStateBackend;
use crate::server::backend::ApiBackend;

static RUN_IPC_TEST_SEQ: AtomicU64 = AtomicU64::new(0);
static BG_TEST_SEQ: AtomicU64 = AtomicU64::new(0);
static L3_CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default)]
struct RecordingEmitter(std::sync::Mutex<Vec<String>>);

impl Emitter for RecordingEmitter {
    fn emit(&self, _channel: &str, payload: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(payload.to_string());
    }
}

fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
    let emitter = Arc::new(RecordingEmitter::default());
    let bridge = EventBridge::new(
        "workbench-run-event",
        Arc::clone(&emitter) as Arc<dyn Emitter>,
    );
    (bridge, emitter)
}

fn test_session_entry(id: &str) -> conex_types::SessionIndexEntry {
    conex_types::SessionIndexEntry {
        id: id.to_string(),
        title: format!("会话 {id}"),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: None,
        hydrated_from_engine: Some(true),
    }
}

fn test_registry() -> Arc<BackgroundTaskRegistry> {
    let seq = BG_TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "crish-run-ipc-background-{}-{seq}",
        std::process::id()
    ));
    BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(30 * 60))
}

fn test_state(
    registry: Option<Arc<BackgroundTaskRegistry>>,
    provider: Option<Arc<dyn ProviderCall>>,
    sessions: &[&str],
) -> (Arc<CoreRunState>, conex_db::LocalDb, Arc<RecordingEmitter>) {
    let (bridge, emitter) = recording_bridge();
    let db = conex_db::LocalDb::open_in_memory().expect("内存库");
    for session_id in sessions {
        db.upsert_session_entry(&test_session_entry(session_id))
            .expect("会话条目");
    }
    let seq = RUN_IPC_TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "crish_run_ipc_{}_{}_snapshot.json",
            std::process::id(),
            seq
        ))),
    );
    let background = registry.map(|value| value as Arc<dyn BackgroundTaskManager>);
    let state = Arc::new(CoreRunState::new(
        Arc::new(LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        background,
    ));
    state.finalize_subagent_spawner();
    if let Some(provider) = provider {
        let config = conex_run::engine_provider::EngineProviderConfig {
            base_url: "http://test.local/v1".to_string(),
            api_key: "test-key".to_string(),
            model: "deepseek-v4-flash".to_string(),
            endpoint: Endpoint::ChatCompletions,
            stream: true,
            extra: std::collections::BTreeMap::new(),
            ..Default::default()
        };
        state.engine().inject_provider_for_test(provider, config);
    }
    (state, db, emitter)
}

fn stop_script(text: &str) -> Vec<ProviderStreamEvent> {
    vec![
        ProviderStreamEvent::text(text),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]
}

fn run_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
    RunTaskOptions {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        prompt: Some(prompt.to_string()),
        mode: Some("task".to_string()),
        cwd: None,
        permission_mode: Some("full".to_string()),
        client_message_id: None,
        assistant_client_message_id: None,
        system_prompt: None,
        history: None,
        context_window: None,
        parent_run_id: None,
        subagent_config: None,
        visible_goal: None,
        max_rounds: None,
        max_stalled_rounds: None,
        reasoning_effort: None,
        context_state: None,
        content: None,
        has_images: None,
        max_turns: None,
    }
}

fn long_command() -> &'static str {
    if cfg!(windows) {
        "Start-Sleep -Seconds 20"
    } else {
        "sleep 20"
    }
}

fn output_command() -> &'static str {
    if cfg!(windows) {
        "1..40 | ForEach-Object { Write-Output ('line ' + $_); Start-Sleep -Milliseconds 100 }"
    } else {
        "i=0; while [ $i -lt 40 ]; do echo line $i; i=$((i+1)); sleep 0.1; done"
    }
}

fn build_test_command(command: &str) -> tokio::process::Command {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-Command", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", command]);
        c
    };
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    cmd
}

fn spawn_test_child(command: &str) -> Child {
    let mut cmd = build_test_command(command);
    cmd.stdin(Stdio::null());
    cmd.spawn().expect("spawn test child")
}

fn adopt_request(
    child: Child,
    command: &str,
    is_daemon: bool,
    resource_monitor: bool,
) -> BackgroundAdoptRequest {
    BackgroundAdoptRequest {
        child,
        command: command.to_string(),
        cwd: PathBuf::from("."),
        is_daemon,
        resource_monitor,
        owner_run_id: None,
    }
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .expect("tasklist must run");
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
fn pid_is_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

async fn wait_task_terminal(registry: &BackgroundTaskRegistry, task_id: &str, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let status = registry.status(task_id).await.expect("status");
        if status.status != TaskState::Running {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "任务 {task_id} 未终态"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_run_finished(state: &CoreRunState, run_id: &str, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let active = state
            .active_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(run_id);
        let owns_background_context = current_background_run(state).as_deref() == Some(run_id);
        if !active && !owns_background_context {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run {run_id} 未收口"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

fn current_background_run(state: &CoreRunState) -> Option<String> {
    state
        .background()
        .current_run_id
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

async fn resolve_all_pending_approvals(state: &CoreRunState, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let runs = state
            .active_runs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        if runs.is_empty() {
            return;
        }
        for run in runs {
            let call_ids = run
                .approval
                .pending_registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            for call_id in call_ids {
                run.approval
                    .resolve(&call_id, ApprovalDecision::Approved)
                    .await
                    .expect("审批放行");
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "活动 run 未在窗口内收口"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

async fn wait_approval_requested(
    emitter: &Arc<RecordingEmitter>,
    tool_name: &str,
    window: Duration,
) -> usize {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let hits = payloads
            .iter()
            .filter(|payload| payload.contains("approval-requested"))
            .filter_map(|payload| {
                let value: serde_json::Value = serde_json::from_str(payload).ok()?;
                let name = value.get("request")?.get("toolName")?.as_str()?;
                (name == tool_name).then_some(())
            })
            .count();
        if hits > 0 {
            return hits;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "approval-requested（{tool_name}）未触发"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test]
async fn adopt_records_owner_run() {
    let registry = test_registry();
    let (state, _db, _emitter) = test_state(Some(Arc::clone(&registry)), None, &[]);

    let child = spawn_test_child(long_command());
    let r0 = state
        .background()
        .adopt(adopt_request(child, "no-run", false, false))
        .await
        .expect("adopt");
    let listed = registry.list(true).await.expect("list");
    assert_eq!(
        listed
            .iter()
            .find(|task| task.task_id == r0.task_id)
            .unwrap()
            .owner_run_id,
        None
    );

    state.background().set_current_run("run-owner-1");
    let child = spawn_test_child(long_command());
    let r1 = state
        .background()
        .adopt(adopt_request(child, "in-run", false, false))
        .await
        .expect("adopt");
    let listed = registry.list(true).await.expect("list");
    assert_eq!(
        listed
            .iter()
            .find(|task| task.task_id == r1.task_id)
            .unwrap()
            .owner_run_id
            .as_deref(),
        Some("run-owner-1")
    );

    let child = spawn_test_child(long_command());
    let mut request = adopt_request(child, "explicit", false, false);
    request.owner_run_id = Some("run-other".to_string());
    let r2 = state.background().adopt(request).await.expect("adopt");
    let listed = registry.list(true).await.expect("list");
    assert_eq!(
        listed
            .iter()
            .find(|task| task.task_id == r2.task_id)
            .unwrap()
            .owner_run_id
            .as_deref(),
        Some("run-other")
    );

    state.background().clear_current_run("run-owner-1");
    assert_eq!(current_background_run(&state), None);
    let child = spawn_test_child(long_command());
    let r3 = state
        .background()
        .adopt(adopt_request(child, "after-run", false, false))
        .await
        .expect("adopt");
    let listed = registry.list(true).await.expect("list");
    assert_eq!(
        listed
            .iter()
            .find(|task| task.task_id == r3.task_id)
            .unwrap()
            .owner_run_id,
        None
    );
    for task in [r0, r1, r2, r3] {
        let _ = registry.kill(&task.task_id).await;
    }
}

#[tokio::test]
async fn run_end_daemon_survives() {
    let registry = test_registry();
    let provider = Arc::new(TestProvider::new(stop_script("run complete")));
    let (state, _db, _emitter) = test_state(
        Some(Arc::clone(&registry)),
        Some(provider),
        &["session-daemon"],
    );
    state.run_restore().await;
    state.background().set_current_run("run-daemon-1");
    let child = spawn_test_child(output_command());
    let pid = child.id().expect("spawned pid");
    let task = state
        .background()
        .adopt(adopt_request(child, "run-daemon", true, false))
        .await
        .expect("adopt");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if registry
            .status(&task.task_id)
            .await
            .expect("status")
            .line_count
            > 0
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "守护任务迟迟无输出");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    run_task_impl(
        Arc::clone(&state),
        run_options("run-daemon-1", "session-daemon", "结束 run"),
    )
    .await
    .expect("run 发起");
    wait_run_finished(&state, "run-daemon-1", Duration::from_secs(15)).await;

    let status = registry.status(&task.task_id).await.expect("status");
    assert_eq!(status.status, TaskState::Running, "守护任务必须存活");
    assert!(pid_is_alive(pid), "守护任务进程必须存活");
    let line_count = status.line_count;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let next = registry.status(&task.task_id).await.expect("status");
        if next.line_count > line_count {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run 终态后日志未累积"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(current_background_run(&state), None);
    let _ = registry.kill(&task.task_id).await;
}

#[tokio::test]
async fn run_end_normal_task_survives_no_cascade() {
    let registry = test_registry();
    let provider = Arc::new(TestProvider::new(stop_script("run complete")));
    let (state, _db, _emitter) = test_state(
        Some(Arc::clone(&registry)),
        Some(provider),
        &["session-normal"],
    );
    state.run_restore().await;
    state.background().set_current_run("run-normal-1");
    let child = spawn_test_child(long_command());
    let pid = child.id().expect("spawned pid");
    let task = state
        .background()
        .adopt(adopt_request(child, "run-normal-task", false, false))
        .await
        .expect("adopt");

    run_task_impl(
        Arc::clone(&state),
        run_options("run-normal-1", "session-normal", "结束 run"),
    )
    .await
    .expect("run 发起");
    wait_run_finished(&state, "run-normal-1", Duration::from_secs(15)).await;
    assert!(pid_is_alive(pid), "普通任务不得被 run 终态级联杀");
    assert_eq!(
        registry.status(&task.task_id).await.expect("status").status,
        TaskState::Running
    );
    assert_eq!(current_background_run(&state), None);
    let _ = registry.kill(&task.task_id).await;
}

#[tokio::test]
async fn l3_force_cancel_keeps_tasks() {
    let _guard = L3_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var("CONEX_RUN_CONTROL_L3_TASK_CANCEL");
    let registry = test_registry();
    let provider = Arc::new(
        TestProvider::with_scripts(vec![stop_script("run complete")]).with_pause(0, 5_000),
    );
    let (state, _db, _emitter) = test_state(
        Some(Arc::clone(&registry)),
        Some(provider),
        &["session-l3-default"],
    );
    state.run_restore().await;
    state.background().set_current_run("run-l3-default");
    let child = spawn_test_child(long_command());
    let pid = child.id().expect("spawned pid");
    let task = state
        .background()
        .adopt(adopt_request(child, "l3-normal", false, false))
        .await
        .expect("adopt");
    run_task_impl(
        Arc::clone(&state),
        run_options("run-l3-default", "session-l3-default", "保持运行"),
    )
    .await
    .expect("run 发起");
    run_control_impl(
        &state,
        "run-l3-default",
        "force_cancel",
        None,
        Some("测试".to_string()),
        None,
    )
    .await
    .expect("force_cancel");
    wait_run_finished(&state, "run-l3-default", Duration::from_secs(15)).await;

    assert_eq!(
        registry.status(&task.task_id).await.expect("status").status,
        TaskState::Running,
        "L3 默认不得触碰任务"
    );
    assert!(pid_is_alive(pid), "任务进程必须存活");
    let _ = registry.kill(&task.task_id).await;
}

#[tokio::test]
async fn l3_force_cancel_kills_normal_tasks_when_enabled() {
    let _guard = L3_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("CONEX_RUN_CONTROL_L3_TASK_CANCEL", "1");
    let registry = test_registry();
    let provider = Arc::new(
        TestProvider::with_scripts(vec![stop_script("run complete")]).with_pause(0, 5_000),
    );
    let (state, _db, _emitter) = test_state(
        Some(Arc::clone(&registry)),
        Some(provider),
        &["session-l3-enabled"],
    );
    state.run_restore().await;
    state.background().set_current_run("run-l3-on");
    let normal = state
        .background()
        .adopt(adopt_request(
            spawn_test_child(long_command()),
            "l3-normal-kill",
            false,
            false,
        ))
        .await
        .expect("adopt normal");
    let daemon_child = spawn_test_child(long_command());
    let daemon_pid = daemon_child.id().expect("spawned pid");
    let daemon = state
        .background()
        .adopt(adopt_request(daemon_child, "l3-daemon-keep", true, false))
        .await
        .expect("adopt daemon");
    run_task_impl(
        Arc::clone(&state),
        run_options("run-l3-on", "session-l3-enabled", "保持运行"),
    )
    .await
    .expect("run 发起");
    run_control_impl(
        &state,
        "run-l3-on",
        "force_cancel",
        None,
        Some("测试".to_string()),
        None,
    )
    .await
    .expect("force_cancel");

    wait_task_terminal(&registry, &normal.task_id, Duration::from_secs(30)).await;
    assert_eq!(
        registry
            .status(&normal.task_id)
            .await
            .expect("status")
            .status,
        TaskState::Killed
    );
    assert_eq!(
        registry
            .status(&daemon.task_id)
            .await
            .expect("status")
            .status,
        TaskState::Running
    );
    assert!(pid_is_alive(daemon_pid));
    let _ = registry.kill(&daemon.task_id).await;
}

#[tokio::test]
async fn get_status_reports_tasks() {
    let registry = test_registry();
    let (state, _db, _emitter) = test_state(Some(Arc::clone(&registry)), None, &[]);
    state.background().set_current_run("run-status-1");
    let daemon = state
        .background()
        .adopt(adopt_request(
            spawn_test_child(long_command()),
            "status-daemon",
            true,
            false,
        ))
        .await
        .expect("adopt daemon");
    let normal = state
        .background()
        .adopt(adopt_request(
            spawn_test_child(long_command()),
            "status-normal",
            false,
            false,
        ))
        .await
        .expect("adopt normal");
    let finished = state
        .background()
        .adopt(adopt_request(
            spawn_test_child("exit 0"),
            "status-finished",
            false,
            false,
        ))
        .await
        .expect("adopt finished");
    wait_task_terminal(&registry, &finished.task_id, Duration::from_secs(30)).await;

    let summary = state.background_tasks_summary().await;
    assert_eq!(summary.active_count, 2);
    assert_eq!(summary.daemon_count, 1);
    let last = summary.last_finished.as_ref().expect("最近终态存在");
    assert_eq!(last.task_id, finished.task_id);
    assert_eq!(last.status, "completed");
    let json = serde_json::to_value(&summary).unwrap();
    assert_eq!(json["activeCount"], 2);
    assert_eq!(json["daemonCount"], 1);
    assert_eq!(json["lastFinished"]["taskId"], finished.task_id);
    assert_eq!(json["lastFinished"]["status"], "completed");
    for task in [daemon, normal] {
        let _ = registry.kill(&task.task_id).await;
    }
}

#[tokio::test]
async fn session_switch_keeps_tasks() {
    let registry = test_registry();
    let provider = Arc::new(TestProvider::with_scripts(vec![
        stop_script("session A complete"),
        stop_script("session B complete"),
    ]));
    let (state, _db, _emitter) = test_state(
        Some(Arc::clone(&registry)),
        Some(provider),
        &["session-a", "session-b"],
    );
    state.run_restore().await;
    state.background().set_current_run("run-sess-a");
    let child = spawn_test_child(long_command());
    let pid = child.id().expect("spawned pid");
    let task = state
        .background()
        .adopt(adopt_request(child, "sess-a-task", true, false))
        .await
        .expect("adopt");

    run_task_impl(
        Arc::clone(&state),
        run_options("run-sess-a", "session-a", "会话 A"),
    )
    .await
    .expect("会话 A run 发起");
    wait_run_finished(&state, "run-sess-a", Duration::from_secs(15)).await;
    run_task_impl(
        Arc::clone(&state),
        run_options("run-sess-b", "session-b", "会话 B"),
    )
    .await
    .expect("会话 B run 发起");
    wait_run_finished(&state, "run-sess-b", Duration::from_secs(15)).await;

    assert!(pid_is_alive(pid), "会话切换后任务必须存活");
    assert_eq!(
        registry.status(&task.task_id).await.expect("status").status,
        TaskState::Running
    );
    let _ = registry.kill(&task.task_id).await;
}

#[tokio::test]
async fn task_completion_wakes_main_agent_e2e() {
    let registry = test_registry();
    let (state, _db, emitter) = test_state(Some(Arc::clone(&registry)), None, &[]);
    let bridge = state.event_bridge();
    registry.set_task_event_consumer(state.task_events());
    registry.set_event_bridge(bridge, String::new());
    state.background().set_current_run("run-e2e5");

    let child = spawn_test_child("exit 0");
    let adopted = state
        .background()
        .adopt(adopt_request(child, "e2e5-cmd", false, true))
        .await
        .expect("adopt");
    let task_id = adopted.task_id.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let queue = state.steering_queue();
        let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = queue.peek() {
            assert!(entry
                .text
                .contains(&format!("任务 {task_id} 已完成，退出码 0")));
            assert_eq!(
                entry.group_id.as_deref(),
                Some(orchestrator::task_events::TASK_WAKE_GROUP_ID)
            );
            queue.clear();
            break;
        }
        drop(queue);
        assert!(tokio::time::Instant::now() < deadline, "任务唤醒未入队");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let audits = payloads
            .iter()
            .filter(|payload| {
                let value: serde_json::Value =
                    serde_json::from_str(payload).ok().unwrap_or_default();
                value["type"] == "security-audit" && value["operation"] == "command-exec"
            })
            .collect::<Vec<_>>();
        if audits.len() >= 2 {
            assert!(audits
                .iter()
                .any(|payload| payload.contains(&format!("\"{task_id}\""))));
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "command-exec 审计未完成"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn t08_remote_run_ask_mode_dangerous_tool_gated() {
    let provider = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("写文件。"),
            ProviderStreamEvent::tool_call(
                Some("c1".to_string()),
                "write_file",
                serde_json::json!({ "path": "../escape-r110.md", "content": "x" }),
            ),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        stop_script("写文件结果已收到。"),
        stop_script("兜底。"),
    ]));
    let (state, _db, emitter) = test_state(None, Some(provider), &["sess-main"]);
    state.run_restore().await;

    let backend = CoreStateBackend::new(Arc::clone(&state));
    backend
        .run_task(conex_types::device::RunTaskParams {
            session_id: Some("sess-main".to_string()),
            prompt: "远程 run（申报 ask 模式）".to_string(),
            prompt_ref: None,
            mode: Some("task".to_string()),
            cwd: None,
            permission_mode: Some(conex_types::device::PermissionMode::Ask),
            history: None,
            client_message_id: None,
        })
        .await
        .expect("远程 run 发起");

    let hits = wait_approval_requested(&emitter, "write_file", Duration::from_secs(15)).await;
    assert!(
        hits >= 1,
        "远程 ask 模式下，write_file 必须触发审批"
    );
    resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
}
