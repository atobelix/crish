#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::c_void,
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliStatusOutput {
    status: Value,
    snapshot: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkbenchRunTaskRequest {
    prompt: String,
    visible_goal: Option<String>,
    run_id: Option<String>,
    mode: Option<String>,
    budget_difficulty: Option<String>,
    run_token_budget: Option<u64>,
    max_rounds: Option<u64>,
    max_stalled_rounds: Option<u64>,
    background_drain_timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkbenchCliRunResult {
    ok: bool,
    command: String,
    cwd: String,
    stdout: String,
    stderr: String,
    status: Option<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkbenchCancelRunResult {
    ok: bool,
    run_id: String,
    pid: Option<u32>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkbenchPerformanceSnapshot {
    pid: u32,
    recorded_at: String,
    uptime_ms: u128,
    working_set_mb: Option<f64>,
    peak_working_set_mb: Option<f64>,
    pagefile_usage_mb: Option<f64>,
    active_run_tree_working_set_mb: Option<f64>,
    active_run_tree_pagefile_usage_mb: Option<f64>,
    active_runs: Vec<ActiveRunPerformanceSnapshot>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveRunPerformanceSnapshot {
    run_id: String,
    pid: u32,
    working_set_mb: Option<f64>,
    peak_working_set_mb: Option<f64>,
    pagefile_usage_mb: Option<f64>,
    tree_process_count: usize,
    tree_working_set_mb: Option<f64>,
    tree_peak_working_set_mb: Option<f64>,
    tree_pagefile_usage_mb: Option<f64>,
}

#[derive(Default)]
struct ProcessTreeMemorySnapshot {
    process_count: usize,
    working_set_size: u64,
    peak_working_set_size: u64,
    pagefile_usage: u64,
}

#[tauri::command]
fn workbench_status() -> Result<Value, String> {
    let output = run_workbench_cli_json("status", Vec::new())?;
    let parsed: CliStatusOutput = serde_json::from_value(output).map_err(|error| error.to_string())?;
    Ok(parsed.status)
}

#[tauri::command]
fn workbench_task_snapshot() -> Result<Value, String> {
    let output = run_workbench_cli_json("status", Vec::new())?;
    let parsed: CliStatusOutput = serde_json::from_value(output).map_err(|error| error.to_string())?;
    Ok(parsed.snapshot)
}

#[tauri::command]
fn workbench_bootstrap() -> Result<Value, String> {
    run_workbench_cli_json("status", Vec::new())
}

#[tauri::command]
fn workbench_continuation(prompt: Option<String>) -> Result<Value, String> {
    let mut args = Vec::new();
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        args.push(format!("--prompt={prompt}"));
    }
    run_workbench_cli_json("continue", args)
}

#[tauri::command]
fn workbench_background_demo(prompt: Option<String>) -> Result<Value, String> {
    let mut args = Vec::new();
    if let Some(prompt) = prompt.filter(|value| !value.trim().is_empty()) {
        args.push(format!("--prompt={prompt}"));
    }
    run_workbench_cli_json("background-demo", args)
}

#[tauri::command]
fn workbench_run_task(request: WorkbenchRunTaskRequest) -> Result<Value, String> {
    run_workbench_cli_json("run-json", run_task_extra_args(&request))
}

#[tauri::command]
fn workbench_run_task_stream(app: tauri::AppHandle, request: WorkbenchRunTaskRequest) -> Result<Value, String> {
    run_workbench_cli_stream(&app, "run", run_task_extra_args(&request), request.run_id.clone())
}

#[tauri::command]
fn workbench_run_goal(request: WorkbenchRunTaskRequest) -> Result<Value, String> {
    run_workbench_cli_json("goal-json", run_task_extra_args(&request))
}

#[tauri::command]
fn workbench_run_goal_stream(app: tauri::AppHandle, request: WorkbenchRunTaskRequest) -> Result<Value, String> {
    run_workbench_cli_stream(&app, "goal-run", run_task_extra_args(&request), request.run_id.clone())
}

#[tauri::command]
fn workbench_cancel_run(run_id: String) -> WorkbenchCancelRunResult {
    let pid = active_runs().lock().ok().and_then(|runs| runs.get(&run_id).copied());
    let Some(pid) = pid else {
        return WorkbenchCancelRunResult {
            ok: false,
            run_id,
            pid: None,
            message: "没有找到正在运行的任务".to_string(),
        };
    };
    match terminate_process_tree(pid) {
        Ok(()) => {
            unregister_active_run(&run_id);
            WorkbenchCancelRunResult {
            ok: true,
            run_id,
            pid: Some(pid),
            message: "已请求取消当前任务".to_string(),
            }
        }
        Err(error) => WorkbenchCancelRunResult {
            ok: false,
            run_id,
            pid: Some(pid),
            message: error,
        },
    }
}

#[tauri::command]
fn workbench_performance_snapshot() -> WorkbenchPerformanceSnapshot {
    let memory = current_process_memory_snapshot();
    let active_runs: Vec<_> = active_run_pids()
        .into_iter()
        .map(|(run_id, pid)| {
            let memory = process_memory_snapshot(pid);
            let tree_memory = process_tree_memory_snapshot(pid);
            ActiveRunPerformanceSnapshot {
                run_id,
                pid,
                working_set_mb: memory.as_ref().map(|snapshot| bytes_to_mb(snapshot.working_set_size as u64)),
                peak_working_set_mb: memory
                    .as_ref()
                    .map(|snapshot| bytes_to_mb(snapshot.peak_working_set_size as u64)),
                pagefile_usage_mb: memory.as_ref().map(|snapshot| bytes_to_mb(snapshot.pagefile_usage as u64)),
                tree_process_count: tree_memory.process_count,
                tree_working_set_mb: optional_mb(tree_memory.working_set_size),
                tree_peak_working_set_mb: optional_mb(tree_memory.peak_working_set_size),
                tree_pagefile_usage_mb: optional_mb(tree_memory.pagefile_usage),
            }
        })
        .collect();
    let active_run_tree_working_set = active_runs
        .iter()
        .filter_map(|run| run.tree_working_set_mb)
        .sum::<f64>();
    let active_run_tree_pagefile_usage = active_runs
        .iter()
        .filter_map(|run| run.tree_pagefile_usage_mb)
        .sum::<f64>();
    WorkbenchPerformanceSnapshot {
        pid: std::process::id(),
        recorded_at: now_millis().to_string(),
        uptime_ms: current_uptime_ms(),
        working_set_mb: memory.as_ref().map(|snapshot| bytes_to_mb(snapshot.working_set_size as u64)),
        peak_working_set_mb: memory
            .as_ref()
            .map(|snapshot| bytes_to_mb(snapshot.peak_working_set_size as u64)),
        pagefile_usage_mb: memory.as_ref().map(|snapshot| bytes_to_mb(snapshot.pagefile_usage as u64)),
        active_run_tree_working_set_mb: non_zero_mb(active_run_tree_working_set),
        active_run_tree_pagefile_usage_mb: non_zero_mb(active_run_tree_pagefile_usage),
        active_runs,
    }
}

#[tauri::command]
fn workbench_cli_probe(command: String) -> Result<WorkbenchCliRunResult, String> {
    run_workbench_cli_raw(&command, Vec::new())
}

fn run_workbench_cli_json(command: &str, args: Vec<String>) -> Result<Value, String> {
    let raw = run_workbench_cli_raw(command, args)?;
    if !raw.ok {
        return Err(format!(
            "agent-workbench CLI failed: status={:?}, stderr={}",
            raw.status, raw.stderr
        ));
    }
    serde_json::from_str(&raw.stdout).map_err(|error| {
        format!(
            "agent-workbench CLI returned invalid JSON: {error}; stdout={}",
            raw.stdout
        )
    })
}

fn run_workbench_cli_raw(command: &str, extra_args: Vec<String>) -> Result<WorkbenchCliRunResult, String> {
    if !matches!(command, "status" | "continue" | "background-demo" | "run" | "run-json" | "goal-run" | "goal-json") {
        return Err(format!("unsupported workbench CLI command: {command}"));
    }

    let app_dir = app_dir()?;
    let root_dir = workspace_root(&app_dir);
    let cwd = env::current_dir().unwrap_or_else(|_| root_dir.clone());
    let mut args = workbench_cli_npm_args(command, &cwd);
    args.extend(extra_args);

    let output = Command::new(npm_command())
        .args(&args)
        .current_dir(&root_dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("failed to start agent-workbench CLI: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok(WorkbenchCliRunResult {
        ok: output.status.success(),
        command: command.to_string(),
        cwd: cwd.display().to_string(),
        stdout: strip_npm_banner(&stdout).trim().to_string(),
        stderr,
        status: output.status.code(),
    })
}

fn run_workbench_cli_stream(
    app: &tauri::AppHandle,
    command: &str,
    extra_args: Vec<String>,
    run_id: Option<String>,
) -> Result<Value, String> {
    if !matches!(command, "run" | "goal-run") {
        return Err(format!("unsupported streaming workbench CLI command: {command}"));
    }

    let app_dir = app_dir()?;
    let root_dir = workspace_root(&app_dir);
    let cwd = env::current_dir().unwrap_or_else(|_| root_dir.clone());
    let mut args = workbench_cli_npm_args(command, &cwd);
    args.extend(extra_args);

    let run_id = run_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("run-{}", now_millis()));
    let mut child = Command::new(npm_command())
        .args(&args)
        .current_dir(&root_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start agent-workbench CLI: {error}"))?;
    let child_pid = child.id();
    register_active_run(&run_id, child_pid);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "agent-workbench CLI stdout was not captured".to_string())?;
    let stderr = child.stderr.take();
    let stderr_reader = stderr.map(|stream| thread::spawn(move || read_stream_to_string(stream)));

    let mut events = Vec::new();
    let mut goal_events = Vec::new();
    let mut snapshot: Option<Value> = None;
    let mut decision: Option<Value> = None;
    let mut goal_end: Option<Value> = None;
    let reader = BufReader::new(stdout);
    for line_result in reader.lines() {
        let line = line_result.map_err(|error| format!("failed reading agent-workbench CLI output: {error}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() || !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
            continue;
        }
        let value = serde_json::from_str::<Value>(trimmed).map_err(|error| {
            format!("agent-workbench CLI returned invalid NDJSON line: {error}; line={trimmed}")
        })?;
        let emitted_value = with_run_id(value.clone(), &run_id);
        if value.get("type").and_then(Value::as_str) == Some("snapshot") {
            snapshot = value.get("snapshot").cloned();
            app.emit("workbench-run-snapshot", &emitted_value)
                .map_err(|error| format!("failed to emit workbench snapshot: {error}"))?;
            continue;
        }
        if value.get("type").and_then(Value::as_str) == Some("continuation") {
            decision = value.get("decision").cloned();
            app.emit("workbench-run-continuation", &emitted_value)
                .map_err(|error| format!("failed to emit workbench continuation: {error}"))?;
            continue;
        }
        if value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|event_type| event_type.starts_with("goal-"))
        {
            if value.get("type").and_then(Value::as_str) == Some("goal-end") {
                if let Some(final_snapshot) = value.get("snapshot").cloned() {
                    snapshot = Some(final_snapshot);
                }
                if let Some(final_decision) = value.get("decision").cloned() {
                    decision = Some(final_decision);
                }
                goal_end = Some(emitted_value.clone());
            }
            app.emit("workbench-goal-event", &emitted_value)
                .map_err(|error| format!("failed to emit workbench goal event: {error}"))?;
            goal_events.push(emitted_value);
            continue;
        }
        app.emit("workbench-run-event", &emitted_value)
            .map_err(|error| format!("failed to emit workbench event: {error}"))?;
        events.push(emitted_value);
    }

    let status = child
        .wait()
        .map_err(|error| format!("failed waiting for agent-workbench CLI: {error}"))?;
    unregister_active_run(&run_id);
    let stderr = stderr_reader
        .map(|handle| handle.join().unwrap_or_else(|_| "failed to join stderr reader".to_string()))
        .unwrap_or_default();
    let result = serde_json::json!({
        "runId": run_id,
        "events": events,
        "goalEvents": goal_events,
        "goalEnd": goal_end,
        "snapshot": snapshot,
        "decision": decision,
        "stderr": stderr,
        "status": status.code()
    });
    if !status.success() {
        return Err(format!(
            "agent-workbench CLI failed: status={:?}, stderr={}",
            status.code(),
            stderr
        ));
    }
    Ok(result)
}

fn run_task_extra_args(request: &WorkbenchRunTaskRequest) -> Vec<String> {
    let mut args = Vec::new();
    args.push(format!("--prompt={}", request.prompt));
    if let Some(goal) = request.visible_goal.as_ref().filter(|value| !value.trim().is_empty()) {
        args.push(format!("--visible-goal={goal}"));
    }
    if let Some(mode) = request.mode.as_ref().filter(|value| !value.trim().is_empty()) {
        args.push(format!("--mode={mode}"));
    }
    if let Some(difficulty) = request
        .budget_difficulty
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        args.push(format!("--budget-difficulty={difficulty}"));
    }
    if let Some(budget) = request.run_token_budget {
        args.push(format!("--run-token-budget={budget}"));
    }
    if let Some(rounds) = request.max_rounds {
        args.push(format!("--max-rounds={rounds}"));
    }
    if let Some(rounds) = request.max_stalled_rounds {
        args.push(format!("--max-stalled-rounds={rounds}"));
    }
    if let Some(timeout) = request.background_drain_timeout_ms {
        args.push(format!("--background-drain-timeout-ms={timeout}"));
    }
    args
}

fn workbench_cli_npm_args(command: &str, cwd: &Path) -> Vec<String> {
    vec![
        "--workspace".to_string(),
        "@crish/agent-workbench".to_string(),
        "run".to_string(),
        "cli".to_string(),
        "--".to_string(),
        command.to_string(),
        format!("--cwd={}", cwd.display()),
    ]
}

fn read_stream_to_string<T: Read>(mut stream: T) -> String {
    let mut output = String::new();
    let _ = stream.read_to_string(&mut output);
    output
}

fn app_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(parent) = manifest_dir.parent() {
        if parent.join("package.json").exists() {
            return Ok(parent.to_path_buf());
        }
    }

    env::current_dir()
        .map_err(|error| error.to_string())
        .and_then(|cwd| find_agent_workbench_dir(&cwd).ok_or_else(|| {
            format!(
                "could not locate apps/agent-workbench from current directory: {}",
                cwd.display()
            )
        }))
}

fn workspace_root(app_dir: &Path) -> PathBuf {
    app_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_dir.to_path_buf())
}

fn find_agent_workbench_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join("apps").join("agent-workbench");
        if candidate.join("package.json").exists() {
            return Some(candidate);
        }
        if dir.ends_with(Path::new("apps").join("agent-workbench")) && dir.join("package.json").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn npm_command() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn strip_npm_banner(stdout: &str) -> String {
    let mut json_started = false;
    let mut lines = Vec::new();
    for line in stdout.lines() {
        if !json_started {
            let trimmed = line.trim_start();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                json_started = true;
                lines.push(line);
            }
            continue;
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn active_runs() -> &'static Mutex<HashMap<String, u32>> {
    static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_active_run(run_id: &str, pid: u32) {
    if let Ok(mut runs) = active_runs().lock() {
        runs.insert(run_id.to_string(), pid);
    }
}

fn unregister_active_run(run_id: &str) {
    if let Ok(mut runs) = active_runs().lock() {
        runs.remove(run_id);
    }
}

fn active_run_pids() -> Vec<(String, u32)> {
    active_runs()
        .lock()
        .map(|runs| runs.iter().map(|(run_id, pid)| (run_id.clone(), *pid)).collect())
        .unwrap_or_default()
}

fn with_run_id(mut value: Value, run_id: &str) -> Value {
    if let Value::Object(ref mut object) = value {
        object.insert("runId".to_string(), Value::String(run_id.to_string()));
    }
    value
}

#[cfg(target_os = "windows")]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("failed to start taskkill: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("failed to start kill: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; MAX_PATH],
}

#[cfg(target_os = "windows")]
#[link(name = "psapi")]
extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut c_void,
        counters: *mut ProcessMemoryCounters,
        size: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut c_void;
    fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
}

#[cfg(target_os = "windows")]
const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
#[cfg(target_os = "windows")]
const PROCESS_VM_READ: u32 = 0x0010;
#[cfg(target_os = "windows")]
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
#[cfg(target_os = "windows")]
const MAX_PATH: usize = 260;

#[cfg(target_os = "windows")]
fn current_process_memory_snapshot() -> Option<ProcessMemoryCounters> {
    process_memory_snapshot_from_handle(unsafe { GetCurrentProcess() })
}

#[cfg(target_os = "windows")]
fn process_memory_snapshot(pid: u32) -> Option<ProcessMemoryCounters> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return None;
        }
        let snapshot = process_memory_snapshot_from_handle(handle);
        let _ = CloseHandle(handle);
        snapshot
    }
}

#[cfg(target_os = "windows")]
fn process_memory_snapshot_from_handle(handle: *mut c_void) -> Option<ProcessMemoryCounters> {
    unsafe {
        let mut counters = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        let ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        if ok == 0 {
            return None;
        }
        Some(counters)
    }
}

#[cfg(target_os = "windows")]
fn process_tree_memory_snapshot(root_pid: u32) -> ProcessTreeMemorySnapshot {
    let pids = process_tree_pids(root_pid);
    let mut snapshot = ProcessTreeMemorySnapshot {
        process_count: pids.len(),
        ..ProcessTreeMemorySnapshot::default()
    };

    for pid in pids {
        if let Some(memory) = process_memory_snapshot(pid) {
            snapshot.working_set_size = snapshot
                .working_set_size
                .saturating_add(memory.working_set_size as u64);
            snapshot.peak_working_set_size = snapshot
                .peak_working_set_size
                .saturating_add(memory.peak_working_set_size as u64);
            snapshot.pagefile_usage = snapshot
                .pagefile_usage
                .saturating_add(memory.pagefile_usage as u64);
        }
    }

    snapshot
}

#[cfg(target_os = "windows")]
fn process_tree_pids(root_pid: u32) -> Vec<u32> {
    let parent_map = process_parent_map();
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent_pid) in parent_map {
        children_by_parent.entry(parent_pid).or_default().push(pid);
    }

    let mut pids = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root_pid]);
    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        pids.push(pid);
        if let Some(children) = children_by_parent.get(&pid) {
            for child in children {
                queue.push_back(*child);
            }
        }
    }

    pids
}

#[cfg(target_os = "windows")]
fn process_parent_map() -> HashMap<u32, u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot as isize == -1 {
            return HashMap::new();
        }

        let mut entry = ProcessEntry32W {
            dw_size: std::mem::size_of::<ProcessEntry32W>() as u32,
            cnt_usage: 0,
            th32_process_id: 0,
            th32_default_heap_id: 0,
            th32_module_id: 0,
            cnt_threads: 0,
            th32_parent_process_id: 0,
            pc_pri_class_base: 0,
            dw_flags: 0,
            sz_exe_file: [0; MAX_PATH],
        };
        let mut parents = HashMap::new();

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                parents.insert(entry.th32_process_id, entry.th32_parent_process_id);
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        parents
    }
}

#[cfg(not(target_os = "windows"))]
fn current_process_memory_snapshot() -> Option<ProcessMemoryCounters> {
    None
}

#[cfg(not(target_os = "windows"))]
fn process_memory_snapshot(_pid: u32) -> Option<ProcessMemoryCounters> {
    None
}

#[cfg(not(target_os = "windows"))]
fn process_tree_memory_snapshot(_root_pid: u32) -> ProcessTreeMemorySnapshot {
    ProcessTreeMemorySnapshot::default()
}

#[cfg(not(target_os = "windows"))]
struct ProcessMemoryCounters {
    working_set_size: usize,
    peak_working_set_size: usize,
    pagefile_usage: usize,
}

fn bytes_to_mb(value: u64) -> f64 {
    ((value as f64 / 1024.0 / 1024.0) * 100.0).round() / 100.0
}

fn optional_mb(value: u64) -> Option<f64> {
    if value == 0 {
        None
    } else {
        Some(bytes_to_mb(value))
    }
}

fn non_zero_mb(value: f64) -> Option<f64> {
    if value > 0.0 {
        Some(((value * 100.0).round()) / 100.0)
    } else {
        None
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn current_uptime_ms() -> u128 {
    now_millis().saturating_sub(process_started_at_millis())
}

fn process_started_at_millis() -> u128 {
    static STARTED_AT: std::sync::OnceLock<u128> = std::sync::OnceLock::new();
    *STARTED_AT.get_or_init(now_millis)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            workbench_status,
            workbench_task_snapshot,
            workbench_bootstrap,
            workbench_continuation,
            workbench_background_demo,
            workbench_run_task,
            workbench_run_task_stream,
            workbench_run_goal,
            workbench_run_goal_stream,
            workbench_cancel_run,
            workbench_performance_snapshot,
            workbench_cli_probe
        ])
        .run(tauri::generate_context!())
        .expect("failed to run agent workbench");
}
