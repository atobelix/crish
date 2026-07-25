use super::*;
use crate::daemon_discovery::*;
use crate::sidecar::pending::{
    pending_response_context, reject_all_pending_sidecar_responses,
    reject_pending_sidecar_response_by_request_id, resolve_pending_sidecar_response,
};
use crate::sidecar::run_stream::{
    mark_run_streams_disconnected, observe_run_stream_event, pending_disconnected_run_streams,
    register_run_stream_recovery, replay_cursor_from_run_events_response,
};
use crate::sidecar::supervisor::{
    record_sidecar_diagnostic, record_sidecar_disconnect, record_sidecar_launch_plan,
    sidecar_command_diagnostic, sidecar_supervisor_snapshot,
};
use crate::sidecar::types::{
    default_supervisor_snapshot, init_state, pending_sidecar_responses, sidecar_run_streams,
    sidecar_supervisor, PendingSidecarResponse, RunEventReplayCursor,
    SidecarCommandDiagnosticStatus, SIDECAR_ERROR_MESSAGE_LIMIT, SIDECAR_RECENT_DIAGNOSTICS_LIMIT,
};
use std::{
    env, fs,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

static TEST_LOCK: Mutex<()> = Mutex::new(());

struct TestDir {
    path: std::path::PathBuf,
}

impl TestDir {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let path = env::temp_dir().join(format!("conex-sidecar-{name}-{nanos}"));
        fs::create_dir_all(&path).expect("create test dir");
        Self { path }
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn write_test_file(path: &std::path::Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, "test").expect("write test file");
}

fn test_app_dir(root: &std::path::Path) -> std::path::PathBuf {
    let app_dir = root.join("apps").join("agent-workbench");
    fs::create_dir_all(&app_dir).expect("create app dir");
    app_dir
}

fn reset_pending_responses_for_test() {
    init_state();
    pending_sidecar_responses()
        .lock()
        .expect("pending response lock")
        .clear();
    sidecar_run_streams()
        .lock()
        .expect("run streams lock")
        .clear();
    if let Ok(mut snapshot) = sidecar_supervisor()
        .get_or_init(|| Mutex::new(default_supervisor_snapshot()))
        .lock()
    {
        snapshot.recent_diagnostics.clear();
    }
}

fn with_dev_runtime_preference<T>(value: Option<&str>, task: impl FnOnce() -> T) -> T {
    with_env_vars(&[("CONEX_DAEMON_DEV_RUNTIME", value)], task)
}

fn with_env_vars<T>(overrides: &[(&str, Option<&str>)], task: impl FnOnce() -> T) -> T {
    let previous = overrides
        .iter()
        .map(|(key, _)| (key.to_string(), env::var_os(key)))
        .collect::<Vec<_>>();
    for (key, value) in overrides {
        match value {
            Some(value) => env::set_var(key, value),
            None => env::remove_var(key),
        }
    }
    let result = task();
    for (key, value) in previous {
        match value {
            Some(value) => env::set_var(key, value),
            None => env::remove_var(key),
        }
    }
    result
}

#[test]
fn run_task_command_forwards_long_run_fields() {
    let request = WorkbenchRunTaskRequest {
        prompt: "ship it".to_string(),
        visible_goal: Some("visible ship goal".to_string()),
        session_id: Some("session_long".to_string()),
        run_id: Some("run_long".to_string()),
        mode: Some("long-run".to_string()),
        workspace_mode: Some("project".to_string()),
        budget_difficulty: Some("hard".to_string()),
        run_token_budget: Some(123_456),
        max_rounds: Some(8),
        max_stalled_rounds: Some(3),
        background_drain_timeout_ms: Some(9_000),
        cwd: Some("C:\\work".to_string()),
        permission_mode: Some("ask".to_string()),
    };

    let (cmd, run_id, session_id) = build_workbench_run_task_command(request, None);

    assert_eq!(run_id, "run_long");
    assert_eq!(session_id.as_deref(), Some("session_long"));
    assert_eq!(cmd["type"], "run-task");
    assert_eq!(cmd["runId"], "run_long");
    assert_eq!(cmd["prompt"], "ship it");
    assert_eq!(cmd["visibleGoal"], "visible ship goal");
    assert_eq!(cmd["mode"], "long-run");
    assert_eq!(cmd["workspaceMode"], "project");
    assert_eq!(cmd["budgetDifficulty"], "hard");
    assert_eq!(cmd["runTokenBudget"], 123_456);
    assert_eq!(cmd["maxRounds"], 8);
    assert_eq!(cmd["maxStalledRounds"], 3);
    assert_eq!(cmd["backgroundDrainTimeoutMs"], 9_000);
    assert_eq!(cmd["cwd"], "C:\\work");
    assert_eq!(cmd["permissionMode"], "ask");
}

#[test]
fn git_commands_forward_workspace_query_fields() {
    let status = build_git_status_command(Some("C:\\work".to_string()));
    assert_eq!(status["type"], "git-status");
    assert_eq!(status["cwd"], "C:\\work");

    let diff = build_git_diff_command(
        Some("C:\\work".to_string()),
        Some("src/main.ts".to_string()),
        Some(true),
    );
    assert_eq!(diff["type"], "git-diff");
    assert_eq!(diff["cwd"], "C:\\work");
    assert_eq!(diff["path"], "src/main.ts");
    assert_eq!(diff["staged"], true);
}

#[test]
fn read_session_events_command_forwards_paging_cursor_and_legacy_fields() {
    let cursor = serde_json::json!({
        "eventLogId": "log-session",
        "generation": 2,
        "schemaVersion": 1,
        "protocolVersion": 1,
        "afterSequence": 12,
        "lastEventId": "event-12",
    });

    let cmd = build_read_session_events_command(
        "session_events".to_string(),
        Some(7),
        Some("event-7".to_string()),
        Some(50),
        Some(cursor.clone()),
        Some(false),
    );

    assert_eq!(cmd["type"], "read-session-events");
    assert_eq!(cmd["sessionId"], "session_events");
    assert_eq!(cmd["afterSequence"], 7);
    assert_eq!(cmd["lastEventId"], "event-7");
    assert_eq!(cmd["maxEvents"], 50);
    assert_eq!(cmd["cursor"], cursor);
    assert_eq!(cmd["includeSnapshot"], false);
}

#[test]
fn read_run_events_command_forwards_paging_cursor_and_legacy_fields() {
    let cursor = serde_json::json!({
        "eventLogId": "log-run",
        "generation": 3,
        "schemaVersion": 1,
        "protocolVersion": 1,
        "afterSequence": 21,
        "lastEventId": "event-21",
    });

    let cmd = build_read_run_events_command(
        "run_events".to_string(),
        Some(9),
        Some("event-9".to_string()),
        Some(true),
        Some(25),
        Some(cursor.clone()),
    );

    assert_eq!(cmd["type"], "read-run-events");
    assert_eq!(cmd["runId"], "run_events");
    assert_eq!(cmd["afterSequence"], 9);
    assert_eq!(cmd["lastEventId"], "event-9");
    assert_eq!(cmd["includeSnapshot"], true);
    assert_eq!(cmd["maxEvents"], 25);
    assert_eq!(cmd["cursor"], cursor);
}

#[test]
fn development_launch_plan_uses_source_entry_by_default() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    with_dev_runtime_preference(None, || {
        let dir = TestDir::new("dev-source");
        let app_dir = test_app_dir(dir.path());
        let source_entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        let local_tsx = dir
            .path()
            .join("node_modules")
            .join(".bin")
            .join(tsx_executable_name());
        write_test_file(&source_entry);
        write_test_file(&local_tsx);

        let isolated_home = dir.path().to_string_lossy().to_string();
        let plan = with_env_vars(
            &[
                ("CONEX_BUN_BIN", None),
                ("BUN_BIN", None),
                ("USERPROFILE", Some(&isolated_home)),
                ("HOME", Some(&isolated_home)),
                ("PATH", Some("")),
            ],
            || resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan"),
        );

        assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentLocalTsx);
        assert_eq!(plan.launcher, local_tsx);
        assert_eq!(plan.entry.as_deref(), Some(source_entry.as_path()));

        assert_eq!(plan.args, source_runtime_args(&source_entry));
        assert_eq!(
            plan.selection_reason.as_deref(),
            Some("development mode uses the current daemon source protocol")
        );

        record_sidecar_launch_plan(&plan);
        let launch = sidecar_supervisor_snapshot()
            .launch
            .expect("launch snapshot");
        assert_eq!(launch.runtime_kind, "development-local-tsx");
        assert_eq!(launch.entry_path, source_entry.display().to_string());
        assert!(launch.command.contains(&source_entry.display().to_string()));
        assert_eq!(
            launch.selection_reason.as_deref(),
            Some("development mode uses the current daemon source protocol")
        );
    });
}

#[test]
fn development_launch_plan_rejects_forced_dist_runtime() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    with_dev_runtime_preference(Some("dist"), || {
        let dir = TestDir::new("dev-dist-rejected");
        let app_dir = test_app_dir(dir.path());
        let source_entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        write_test_file(&source_entry);

        let error = resolve_daemon_launch_plan_inner(&app_dir, false).expect_err("dist disabled");
        let diagnostic = error.diagnostic();

        assert_eq!(error.code, "development-runtime-unsupported");
        assert!(diagnostic.contains("unsupported CONEX_DAEMON_DEV_RUNTIME value: dist"));
        assert!(diagnostic.contains("development runtime must be auto, bun, tsx, or npx"));
    });
}

#[test]
fn development_launch_plan_prefers_bun_source_entry() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    with_dev_runtime_preference(Some("bun"), || {
        let dir = TestDir::new("dev-bun");
        let app_dir = test_app_dir(dir.path());
        let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        let local_bun = dir
            .path()
            .join("node_modules")
            .join(".bin")
            .join(bun_executable_names()[0]);
        let local_tsx = dir
            .path()
            .join("node_modules")
            .join(".bin")
            .join(tsx_executable_name());
        write_test_file(&entry);
        write_test_file(&local_bun);
        write_test_file(&local_tsx);
        let isolated_home = dir.path().to_string_lossy().to_string();

        let plan = with_env_vars(
            &[
                ("CONEX_BUN_BIN", None),
                ("BUN_BIN", None),
                ("USERPROFILE", Some(&isolated_home)),
                ("HOME", Some(&isolated_home)),
                ("PATH", Some("")),
            ],
            || resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan"),
        );

        assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentBun);
        assert_eq!(plan.launcher, local_bun);
        assert_eq!(plan.entry.as_deref(), Some(entry.as_path()));
        assert_eq!(plan.work_dir, dir.path());
        assert_eq!(plan.args, source_runtime_args(&entry));
        assert_eq!(
            plan.selection_reason.as_deref(),
            Some("CONEX_DAEMON_DEV_RUNTIME selected a development source runtime")
        );
    });
}

#[test]
fn development_launch_plan_prefers_local_tsx_source_entry() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    with_dev_runtime_preference(Some("tsx"), || {
        let dir = TestDir::new("dev-local-tsx");
        let app_dir = test_app_dir(dir.path());
        let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        let local_tsx = dir
            .path()
            .join("node_modules")
            .join(".bin")
            .join(tsx_executable_name());
        write_test_file(&entry);
        write_test_file(&local_tsx);

        let plan = resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan");

        assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentLocalTsx);
        assert_eq!(plan.launcher, local_tsx);
        assert_eq!(plan.entry.as_deref(), Some(entry.as_path()));
        assert_eq!(plan.work_dir, dir.path());
        assert_eq!(plan.args, source_runtime_args(&entry));
    });
}

#[test]
fn development_launch_plan_uses_npx_source_runtime_when_requested() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    with_dev_runtime_preference(Some("npx"), || {
        let dir = TestDir::new("dev-npx");
        let app_dir = test_app_dir(dir.path());
        let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        write_test_file(&entry);

        let plan = resolve_daemon_launch_plan_inner(&app_dir, false).expect("launch plan");

        assert_eq!(plan.mode, DaemonLaunchMode::DevelopmentNpx);
        assert_eq!(plan.launcher, std::path::PathBuf::from(npx_executable_name()));
        assert_eq!(
            plan.args,
            npx_tsx_source_runtime_args(&entry)
        );
        assert_eq!(plan.work_dir, dir.path());
    });
}

#[test]
fn development_launch_plan_reports_forced_bun_missing() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    with_dev_runtime_preference(Some("bun"), || {
        let dir = TestDir::new("dev-bun-missing");
        let app_dir = test_app_dir(dir.path());
        let entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
        write_test_file(&entry);
        let isolated_home = dir.path().to_string_lossy().to_string();

        let error = with_env_vars(
            &[
                ("CONEX_BUN_BIN", None),
                ("BUN_BIN", None),
                ("USERPROFILE", Some(&isolated_home)),
                ("HOME", Some(&isolated_home)),
                ("PATH", Some("")),
            ],
            || resolve_daemon_launch_plan_inner(&app_dir, false).expect_err("missing bun"),
        );

        assert_eq!(error.code, "development-bun-missing");
        assert_eq!(error.mode, DaemonLaunchMode::DevelopmentBun);
        assert!(error.diagnostic().contains("forced to bun"));
    });
}

#[test]
fn production_launch_plan_prefers_bundled_executable() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    let dir = TestDir::new("prod-bundled");
    let app_dir = test_app_dir(dir.path());
    let launcher = app_dir
        .join("resources")
        .join(production_daemon_executable_names()[0]);
    write_test_file(&launcher);

    let plan = resolve_daemon_launch_plan_inner(&app_dir, true).expect("launch plan");

    assert_eq!(plan.mode, DaemonLaunchMode::ProductionBundled);
    assert_eq!(plan.launcher, launcher);
    assert!(plan.args.is_empty());
    assert!(plan.entry.is_none());
    assert_eq!(plan.work_dir, app_dir.join("resources"));
}

#[test]
fn production_launch_plan_rejects_loose_javascript_entry() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    let dir = TestDir::new("prod-loose-js");
    let app_dir = test_app_dir(dir.path());
    let loose_entry = app_dir
        .join("resources")
        .join("agent-daemon")
        .join("dist")
        .join("index.js");
    write_test_file(&loose_entry);

    let error = resolve_daemon_launch_plan_inner(&app_dir, true).expect_err("loose JS rejected");
    let diagnostic = error.diagnostic();

    assert_eq!(error.code, "packaging-missing");
    assert!(diagnostic.contains("release sidecar requires a bundled daemon executable"));
    assert!(!diagnostic.contains(&loose_entry.display().to_string()));
}

#[test]
fn production_launch_plan_reports_packaging_missing_without_source_or_npx_runtime() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    let dir = TestDir::new("prod-missing");
    let app_dir = test_app_dir(dir.path());
    let source_entry = dir.path().join(DAEMON_ENTRY_RELATIVE);
    write_test_file(&source_entry);

    let error = resolve_daemon_launch_plan_inner(&app_dir, true).expect_err("missing package");
    let diagnostic = error.diagnostic();

    assert_eq!(error.code, "packaging-missing");
    assert!(diagnostic.contains("runtime_kind: production-bundled-daemon"));
    assert!(diagnostic.contains("code: packaging-missing"));
    assert!(diagnostic.contains("command: (unresolved)"));
    assert!(diagnostic.contains(
        "selection_reason: release mode requires a bundled daemon executable"
    ));
    assert!(diagnostic.contains("launcher_candidates"));
    assert!(diagnostic.contains("entry_candidates"));
    assert!(!diagnostic.contains(npx_executable_name()));
    assert!(!diagnostic.contains(DAEMON_ENTRY_RELATIVE));
}

fn push_pending_response_for_test(
    id: u64,
    request_id: &str,
    expected_type: &str,
) -> tokio::sync::oneshot::Receiver<Result<Value, String>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    pending_sidecar_responses()
        .lock()
        .expect("pending response lock")
        .push_back(PendingSidecarResponse {
            id,
            request_id: request_id.to_string(),
            expected_type: expected_type.to_string(),
            command_type: "test-query".to_string(),
            command_size_bytes: 2,
            started_at_ms: crate::process::now_millis(),
            key_field: None,
            key_value: None,
            context: pending_response_context(expected_type, None, None),
            sender,
        });
    receiver
}

#[test]
fn daemon_error_with_request_id_rejects_only_matching_pending_response() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();
    let mut first = push_pending_response_for_test(1, "q1", "status-response");
    let mut second = push_pending_response_for_test(2, "q2", "run-snapshot");

    let handled = resolve_pending_sidecar_response(&serde_json::json!({
        "type": "error",
        "requestId": "q2",
        "message": "run missing"
    }));

    assert!(handled);
    assert!(matches!(
        first.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(
        second.try_recv(),
        Ok(Err(
            "run missing (requestId: q2, expectedType: run-snapshot, context: query expectedType=run-snapshot)"
                .to_string()
        ))
    );

    let pending = pending_sidecar_responses()
        .lock()
        .expect("pending response lock");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].request_id, "q1");
}

#[test]
fn daemon_error_without_request_id_does_not_reject_pending_response() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();
    let mut receiver = push_pending_response_for_test(1, "q1", "error");

    let handled = resolve_pending_sidecar_response(&serde_json::json!({
        "type": "error",
        "message": "broadcast failure"
    }));

    assert!(!handled);
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(
        pending_sidecar_responses()
            .lock()
            .expect("pending response lock")
            .len(),
        1
    );
}

#[test]
fn disconnect_rejects_all_pending_responses_with_request_diagnostics() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();
    let mut first = push_pending_response_for_test(1, "q1", "status-response");
    let mut second = push_pending_response_for_test(2, "q2", "run-snapshot");

    let rejected =
        reject_all_pending_sidecar_responses("Sidecar disconnected: test".to_string());

    assert_eq!(rejected, 2);
    assert_eq!(
        first.try_recv(),
        Ok(Err(
            "Sidecar disconnected: test (requestId: q1, expectedType: status-response, context: query expectedType=status-response)"
                .to_string()
        ))
    );
    assert_eq!(
        second.try_recv(),
        Ok(Err(
            "Sidecar disconnected: test (requestId: q2, expectedType: run-snapshot, context: query expectedType=run-snapshot)"
                .to_string()
        ))
    );
    assert_eq!(
        pending_sidecar_responses()
            .lock()
            .expect("pending response lock")
            .len(),
        0
    );
}

#[test]
fn sidecar_disconnect_snapshot_records_reason_and_rejected_count() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    init_state();
    let before = sidecar_supervisor_snapshot().disconnect_count;

    record_sidecar_disconnect(42, "Daemon WebSocket read error: test", 3);
    let snapshot = sidecar_supervisor_snapshot();

    assert_eq!(snapshot.disconnect_count, before + 1);
    let disconnect = snapshot.last_disconnect.expect("last disconnect");
    assert_eq!(disconnect.generation, 42);
    assert_eq!(disconnect.message, "Daemon WebSocket read error: test");
    assert_eq!(disconnect.rejected_pending_responses, 3);
    assert!(!disconnect.disconnected_at.is_empty());
}

#[test]
fn rejected_pending_response_records_sanitized_recent_diagnostic() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();
    let mut receiver = push_pending_response_for_test(1, "q1", "run-snapshot");

    let handled = reject_pending_sidecar_response_by_request_id(
        "q1",
        format!("daemon failed with secret {}", "x".repeat(400)),
    );

    assert!(handled);
    assert!(matches!(receiver.try_recv(), Ok(Err(_))));
    let snapshot = sidecar_supervisor_snapshot();
    let diagnostic = snapshot
        .recent_diagnostics
        .last()
        .expect("recent diagnostic");
    assert_eq!(diagnostic.request_id, "q1");
    assert_eq!(diagnostic.command_type, "test-query");
    assert_eq!(diagnostic.command_size_bytes, 2);
    assert_eq!(diagnostic.status, SidecarCommandDiagnosticStatus::Error);
    let error = diagnostic.error.as_ref().expect("error diagnostic");
    assert_eq!(error.layer, "daemon-response");
    assert!(error.message.len() <= SIDECAR_ERROR_MESSAGE_LIMIT + 3);
}

#[test]
fn recent_diagnostics_are_bounded() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();

    for index in 0..(SIDECAR_RECENT_DIAGNOSTICS_LIMIT + 3) {
        record_sidecar_diagnostic(sidecar_command_diagnostic(
            format!("q{index}"),
            "status".to_string(),
            16,
            None,
            crate::process::now_millis(),
            SidecarCommandDiagnosticStatus::Ok,
            None,
        ));
    }

    let snapshot = sidecar_supervisor_snapshot();
    assert_eq!(
        snapshot.recent_diagnostics.len(),
        SIDECAR_RECENT_DIAGNOSTICS_LIMIT
    );
    assert_eq!(snapshot.recent_diagnostics[0].request_id, "q3");
}

#[test]
fn replay_cursor_falls_back_to_event_log_and_next_sequence() {
    let response = serde_json::json!({
        "type": "run-events",
        "runId": "run_replay",
        "events": [
            { "id": "event-8", "sequence": 8, "type": "runtime-event", "sessionId": "session_replay", "runId": "run_replay", "timestamp": "2026-01-01T00:00:00Z", "payload": {} }
        ],
        "eventLog": {
            "eventLogId": "eventlog_replay",
            "generation": 4,
            "schemaVersion": 1,
            "protocolVersion": 1
        },
        "nextAfterSequence": 8
    });

    let cursor = replay_cursor_from_run_events_response(&response).expect("cursor");

    assert_eq!(
        cursor,
        RunEventReplayCursor {
            event_log_id: "eventlog_replay".to_string(),
            generation: 4,
            schema_version: 1,
            protocol_version: 1,
            after_sequence: 8,
            last_event_id: Some("event-8".to_string()),
        }
    );
}

#[test]
fn run_stream_disconnect_marks_registered_daemon_owned_runs() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();

    register_run_stream_recovery("run_live", Some("session_live"));
    mark_run_streams_disconnected(7, "Daemon WebSocket read error: test");

    let streams = pending_disconnected_run_streams();
    assert_eq!(streams.len(), 1);
    assert_eq!(streams[0].run_id, "run_live");
    assert_eq!(streams[0].session_id.as_deref(), Some("session_live"));
    assert_eq!(streams[0].disconnected_generation, Some(7));
    assert_eq!(
        streams[0].disconnect_message.as_deref(),
        Some("Daemon WebSocket read error: test")
    );
}

#[test]
fn terminal_run_event_clears_stream_recovery_state() {
    let _guard = TEST_LOCK.lock().expect("test lock");
    reset_pending_responses_for_test();

    register_run_stream_recovery("run_done", Some("session_done"));
    observe_run_stream_event(&serde_json::json!({
        "id": "event-9",
        "sequence": 9,
        "type": "run-completed",
        "sessionId": "session_done",
        "runId": "run_done",
        "timestamp": "2026-01-01T00:00:00Z",
        "payload": {}
    }));

    assert!(sidecar_run_streams()
        .lock()
        .expect("run streams lock")
        .is_empty());
}
