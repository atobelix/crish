use super::super::shell_exec::terminate_process_tree;
use super::super::shell_invoke::build_shell_invocation;
use super::super::*;
use super::{ctx, tool};
use crate::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskRef, BackgroundTaskStatus,
    KillResult, LogSlice,
};
use crate::context::ToolContext;
use conex_test_utils::TempWorkspace;
use serde_json::json;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::process::Command as TokioCommand;
use tokio::time::Duration;

/// 平台无关睡眠命令（测试超时 / 转后台用）
fn sleep_cmd(secs: u32) -> String {
    if cfg!(windows) {
        format!("Start-Sleep -Seconds {secs}")
    } else {
        format!("sleep {secs}")
    }
}

// ===== T-AB-02：三模式 + trait 契约 =====

/// 记录式后台任务管理器（测试替身，参照 RunSubagentTool 测试的
/// RecordingSpawner 风格）：记录 adopt 请求标量字段并按序号应答
#[derive(Debug)]
struct RecordingBackgroundManager {
    adopts: Mutex<Vec<AdoptRecord>>,
    next_task_id: std::sync::atomic::AtomicUsize,
}

/// adopt 请求标量快照（Child 不可 Clone，只记录字段）
#[derive(Debug, Clone)]
struct AdoptRecord {
    command: String,
    cwd: PathBuf,
    is_daemon: bool,
    resource_monitor: bool,
    owner_run_id: Option<String>,
}

impl RecordingBackgroundManager {
    fn new() -> Self {
        Self {
            adopts: Mutex::new(Vec::new()),
            next_task_id: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn adopts(&self) -> usize {
        self.adopts.lock().unwrap().len()
    }

    fn adopts_requests(&self) -> Vec<AdoptRecord> {
        self.adopts.lock().unwrap().clone()
    }
}

#[async_trait]
impl BackgroundTaskManager for RecordingBackgroundManager {
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        let n = self
            .next_task_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let task_id = format!("task-{n}");
        self.adopts.lock().unwrap().push(AdoptRecord {
            command: req.command,
            cwd: req.cwd,
            is_daemon: req.is_daemon,
            resource_monitor: req.resource_monitor,
            owner_run_id: req.owner_run_id,
        });
        Ok(BackgroundTaskRef {
            task_id: task_id.clone(),
            log_path: PathBuf::from(format!("logs/tasks/{task_id}.log")),
        })
    }

    async fn list(&self, _include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        Ok(Vec::new())
    }

    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
        Err(ToolError::not_found(task_id))
    }

    async fn read_log(
        &self,
        task_id: &str,
        _start_line: Option<u64>,
        _max_lines: u64,
    ) -> Result<LogSlice, ToolError> {
        Err(ToolError::not_found(task_id))
    }

    async fn send_input(
        &self,
        _task_id: &str,
        _text: &str,
        _append_newline: bool,
    ) -> Result<(), ToolError> {
        Ok(())
    }

    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
        Err(ToolError::not_found(task_id))
    }
}

/// 任务卡验收：waitMsBeforeAsync 窗口内完成的命令——无 adopt 调用、
/// 返回同步结果（timedOut=false 且无 taskId）
#[tokio::test]
async fn background_window_completed_no_adopt() {
    let ws = TempWorkspace::new("bg_window_ok");
    let manager = Arc::new(RecordingBackgroundManager::new());
    let ctx = ToolContext {
        background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(&ws)
    };
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output fast-done"
    } else {
        "echo fast-done"
    };
    // 窗口取 60s：断言语义是「快速命令在窗口内完成」——窗口只须足够大，
    // 并行全量跑时 PowerShell 冷启动可能超过 5s（曾导致误转后台 flaky）
    let out = t
        .execute(
            &ctx,
            json!({ "command": command, "mode": "auto-background", "waitMsBeforeAsync": 60000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["mode"], "sync");
    assert!(out.get("taskId").is_none(), "窗口内完成不得产生 taskId");
    assert_eq!(manager.adopts(), 0, "窗口内完成不得调用 adopt");
    assert!(out["stdout"].as_str().unwrap().contains("fast-done"));
}

/// 任务卡验收：窗口超时的命令——adopt 恰好一次、参数含 command/cwd/
/// isDaemon 正确值、返回 taskId
#[tokio::test]
async fn background_window_expired_adopts_once() {
    let ws = TempWorkspace::new("bg_window_expire");
    ws.write_file("sub/.keep", "");
    let manager = Arc::new(RecordingBackgroundManager::new());
    let ctx = ToolContext {
        background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(&ws)
    };
    let t = tool();
    let out = t
        .execute(
            &ctx,
            json!({
                "command": sleep_cmd(3),
                "mode": "auto-background",
                "waitMsBeforeAsync": 300,
                "cwd": "sub",
                "resourceMonitor": true
            }),
        )
        .await
        .unwrap();
    assert_eq!(out["mode"], "background");
    let task_id = out["taskId"].as_str().unwrap().to_string();
    assert!(task_id.starts_with("task-"), "taskId 命名风格 task-<seq>");
    assert!(
        out["logPath"].as_str().unwrap().contains(&task_id),
        "logPath 应含 taskId"
    );
    assert!(
        out["text"]
            .as_str()
            .unwrap()
            .contains(&format!("task {task_id}")),
        "text 应提示任务 id"
    );
    // adopt 恰好一次，参数正确
    assert_eq!(manager.adopts(), 1, "adopt 必须恰好调用一次");
    let reqs = manager.adopts_requests();
    assert_eq!(reqs[0].cwd, ws.path().join("sub"), "adopt 参数 cwd 正确");
    assert!(!reqs[0].is_daemon, "auto-background 非 daemon");
    assert!(reqs[0].resource_monitor, "resourceMonitor 透传");
    assert_eq!(
        reqs[0].owner_run_id, None,
        "R-AB1 不携带 run 关联（R-AB3 接线）"
    );
    assert!(reqs[0].command.len() <= 64, "命令摘要前 64 字符");
}

/// 任务卡验收：background=None 时窗口超时仍走树杀
/// （回归 shell_timeout_kills_and_marks 语义）
#[tokio::test]
async fn background_none_keeps_tree_kill() {
    let ws = TempWorkspace::new("bg_none");
    let t = tool();
    let out = t
        .execute(
            &ctx(&ws),
            json!({ "command": sleep_cmd(10), "mode": "auto-background", "timeoutMs": 2000 }),
        )
        .await
        .unwrap();
    assert_eq!(out["timedOut"], true, "未接线时超时仍走树杀");
    assert_eq!(out["mode"], "sync");
    assert!(out["stderr"].as_str().unwrap().contains("超时"));
}

/// 任务卡验收：模式 3（daemon）立即 adopt（不经过等待窗口，is_daemon=true）
#[tokio::test]
async fn daemon_mode_adopts_immediately() {
    let ws = TempWorkspace::new("bg_daemon");
    let manager = Arc::new(RecordingBackgroundManager::new());
    let ctx = ToolContext {
        background: Some(Arc::clone(&manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(&ws)
    };
    let t = tool();
    let out = t
        .execute(&ctx, json!({ "command": sleep_cmd(3), "mode": "daemon" }))
        .await
        .unwrap();
    assert_eq!(out["mode"], "background");
    assert!(out["taskId"].as_str().is_some());
    assert_eq!(manager.adopts(), 1, "daemon 模式立即 adopt");
    assert!(manager.adopts_requests()[0].is_daemon, "is_daemon 必须置位");
}

/// 任务卡验收：kill_on_drop(false) 生效——spawn 后 drop 掉 Child 引用，
/// 进程仍存活（用 Start-Sleep 类命令断言 pid 存活）
// G2 禁令豁免：测试直接 spawn 探测 kill_on_drop 语义（非命令门禁执行面）
#[allow(clippy::disallowed_methods)]
#[tokio::test]
async fn kill_on_drop_false_child_survives_drop() {
    let (program, args, _) = build_shell_invocation(&sleep_cmd(10)).expect("invocation 构造失败");
    let mut child_cmd = TokioCommand::new(&program);
    child_cmd
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = child_cmd.spawn().expect("spawn 失败");
    let pid = child.id().expect("pid 缺失");
    drop(child);
    // 等 600ms 后进程应仍存活（kill_on_drop(false) 下 drop 不杀）
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(
        process_alive(pid),
        "kill_on_drop(false) 下 drop Child 不得杀进程"
    );
    // 清理：树杀（避免测试残留进程）
    let _ = terminate_process_tree(pid);
}

/// 进程存活探测（Windows tasklist / Unix /proc）
fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}
