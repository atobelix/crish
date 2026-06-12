use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    ffi::c_void,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchPerformanceSnapshot {
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
pub(crate) fn workbench_performance_snapshot() -> WorkbenchPerformanceSnapshot {
    let memory = current_process_memory_snapshot();
    let active_runs: Vec<_> = active_run_pids()
        .into_iter()
        .filter(|(_, pid)| *pid > 0) // Skip PID=0 from sidecar mode.
        .map(|(run_id, pid)| {
            let memory = process_memory_snapshot(pid);
            let tree_memory = process_tree_memory_snapshot(pid);
            ActiveRunPerformanceSnapshot {
                run_id,
                pid,
                working_set_mb: memory
                    .as_ref()
                    .map(|s| bytes_to_mb(s.working_set_size as u64)),
                peak_working_set_mb: memory
                    .as_ref()
                    .map(|s| bytes_to_mb(s.peak_working_set_size as u64)),
                pagefile_usage_mb: memory
                    .as_ref()
                    .map(|s| bytes_to_mb(s.pagefile_usage as u64)),
                tree_process_count: tree_memory.process_count,
                tree_working_set_mb: optional_mb(tree_memory.working_set_size),
                tree_peak_working_set_mb: optional_mb(tree_memory.peak_working_set_size),
                tree_pagefile_usage_mb: optional_mb(tree_memory.pagefile_usage),
            }
        })
        .collect();
    let active_run_tree_working_set = active_runs
        .iter()
        .filter_map(|r| r.tree_working_set_mb)
        .sum::<f64>();
    let active_run_tree_pagefile_usage = active_runs
        .iter()
        .filter_map(|r| r.tree_pagefile_usage_mb)
        .sum::<f64>();
    WorkbenchPerformanceSnapshot {
        pid: std::process::id(),
        recorded_at: now_millis().to_string(),
        uptime_ms: current_uptime_ms(),
        working_set_mb: memory
            .as_ref()
            .map(|s| bytes_to_mb(s.working_set_size as u64)),
        peak_working_set_mb: memory
            .as_ref()
            .map(|s| bytes_to_mb(s.peak_working_set_size as u64)),
        pagefile_usage_mb: memory
            .as_ref()
            .map(|s| bytes_to_mb(s.pagefile_usage as u64)),
        active_run_tree_working_set_mb: non_zero_mb(active_run_tree_working_set),
        active_run_tree_pagefile_usage_mb: non_zero_mb(active_run_tree_pagefile_usage),
        active_runs,
    }
}

fn active_runs() -> &'static Mutex<HashMap<String, u32>> {
    static ACTIVE_RUNS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    ACTIVE_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn active_run_pid(run_id: &str) -> Option<u32> {
    active_runs()
        .lock()
        .ok()
        .and_then(|runs| runs.get(run_id).copied())
}

pub(crate) fn register_active_run(run_id: &str, pid: u32) {
    if let Ok(mut runs) = active_runs().lock() {
        runs.insert(run_id.to_string(), pid);
    }
}

pub(crate) fn unregister_active_run(run_id: &str) {
    if let Ok(mut runs) = active_runs().lock() {
        runs.remove(run_id);
    }
}

fn active_run_pids() -> Vec<(String, u32)> {
    active_runs()
        .lock()
        .map(|runs| runs.iter().map(|(id, pid)| (id.clone(), *pid)).collect())
        .unwrap_or_default()
}

// ==================== Windows Memory Monitoring ====================

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
            sz_exe_file: [0u16; MAX_PATH],
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

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
fn current_uptime_ms() -> u128 {
    now_millis().saturating_sub(process_started_at_millis())
}
fn process_started_at_millis() -> u128 {
    static STARTED_AT: std::sync::OnceLock<u128> = std::sync::OnceLock::new();
    *STARTED_AT.get_or_init(now_millis)
}

// ==================== Process Termination ====================

#[cfg(target_os = "windows")]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start taskkill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to start kill: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
