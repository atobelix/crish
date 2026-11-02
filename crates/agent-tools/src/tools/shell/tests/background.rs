use super::super::shell_exec::terminate_process_tree;
use super::super::shell_invoke::build_shell_invocation;
use super::super::*;
use super::{ctx, tool};
use crate::audit::NoopAuditSink;
use crate::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskRef, BackgroundTaskStatus,
    KillResult, LogSlice, TaskState,
};
use crate::context::ToolContext;
use crate::streaming::ToolStreamItem;
use conex_test_utils::TempWorkspace;
use futures_util::StreamExt;
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

// ===== BG4：sync 内部促进（超窗 adopt 转后台）=====

/// 保留式后台任务管理器（BG4 测试替身）：真实持有 adopt 的 Child，
/// status 按 try_wait 实时判定、kill 真终止进程树——用于断言「进程在
/// manager 中存活、后续经管理面可查可终止」（生产实现在壳层 registry）
#[derive(Debug)]
struct RetainingBackgroundManager {
    tasks: Mutex<std::collections::HashMap<String, RetainedTask>>,
    next_task_id: std::sync::atomic::AtomicUsize,
}

/// adopt 后保留的任务条目（Child 所有权在本替身，与生产 registry 同构）
#[derive(Debug)]
struct RetainedTask {
    child: tokio::process::Child,
    pid: Option<u32>,
    command: String,
    cwd: PathBuf,
    is_daemon: bool,
    killed: bool,
}

impl RetainingBackgroundManager {
    fn new() -> Self {
        Self {
            tasks: Mutex::new(std::collections::HashMap::new()),
            next_task_id: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn adopt_count(&self) -> usize {
        self.tasks.lock().unwrap().len()
    }

    fn pid_of(&self, task_id: &str) -> Option<u32> {
        self.tasks.lock().unwrap().get(task_id).and_then(|t| t.pid)
    }
}

#[async_trait]
impl BackgroundTaskManager for RetainingBackgroundManager {
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        let n = self
            .next_task_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let task_id = format!("task-{n}");
        let pid = req.child.id();
        self.tasks.lock().unwrap().insert(
            task_id.clone(),
            RetainedTask {
                child: req.child,
                pid,
                command: req.command,
                cwd: req.cwd,
                is_daemon: req.is_daemon,
                killed: false,
            },
        );
        Ok(BackgroundTaskRef {
            task_id: task_id.clone(),
            log_path: PathBuf::from(format!("logs/tasks/{task_id}.log")),
        })
    }

    async fn list(&self, _include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        let tasks = self.tasks.lock().unwrap();
        Ok(tasks
            .iter()
            .map(|(task_id, task)| BackgroundTaskInfo {
                task_id: task_id.clone(),
                command: task.command.clone(),
                cwd: task.cwd.display().to_string(),
                status: if task.killed {
                    TaskState::Killed
                } else {
                    TaskState::Running
                },
                started_at_ms: 0,
                duration_ms: 0,
                finished_at_ms: None,
                exit_code: None,
                log_path: format!("logs/tasks/{task_id}.log"),
                line_count: 0,
                last_output_at_ms: 0,
                is_daemon: task.is_daemon,
                resource: None,
                prompt: None,
                owner_run_id: None,
                suspicious: false,
            })
            .collect())
    }

    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
        let mut tasks = self.tasks.lock().unwrap();
        let task = match tasks.get_mut(task_id) {
            Some(t) => t,
            None => return Err(ToolError::not_found(task_id)),
        };
        let (state, exit_code) = if task.killed {
            (TaskState::Killed, None)
        } else {
            match task.child.try_wait() {
                Ok(Some(status)) => (
                    if status.success() {
                        TaskState::Completed
                    } else {
                        TaskState::Failed
                    },
                    status.code(),
                ),
                Ok(None) => (TaskState::Running, None),
                Err(_) => (TaskState::Failed, None),
            }
        };
        Ok(BackgroundTaskStatus {
            task_id: task_id.to_string(),
            status: state,
            exit_code,
            log_path: format!("logs/tasks/{task_id}.log"),
            duration_ms: 0,
            line_count: 0,
            last_output_at_ms: 0,
            resource: None,
            tail: String::new(),
            prompt: None,
            termination_diagnostics: Vec::new(),
        })
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
        // 先摘出条目再终止/回收（不持锁 await），完成后回填 killed 标记
        let mut task = {
            let mut tasks = self.tasks.lock().unwrap();
            match tasks.remove(task_id) {
                Some(t) => t,
                None => return Err(ToolError::not_found(task_id)),
            }
        };
        if task.killed {
            let code = task
                .child
                .try_wait()
                .ok()
                .flatten()
                .and_then(|s| s.code());
            self.tasks.lock().unwrap().insert(task_id.to_string(), task);
            return Ok(KillResult::AlreadyExited {
                task_id: task_id.to_string(),
                exit_code: code,
            });
        }
        if let Ok(Some(status)) = task.child.try_wait() {
            self.tasks.lock().unwrap().insert(task_id.to_string(), task);
            return Ok(KillResult::AlreadyExited {
                task_id: task_id.to_string(),
                exit_code: status.code(),
            });
        }
        if let Some(pid) = task.pid {
            let _ = terminate_process_tree(pid);
        }
        let _ = task.child.wait().await;
        task.killed = true;
        self.tasks.lock().unwrap().insert(task_id.to_string(), task);
        Ok(KillResult::Killed {
            task_id: task_id.to_string(),
            via_force: true,
        })
    }
}

/// 注入 RetainingBackgroundManager 的测试上下文
fn bg_ctx(ws: &TempWorkspace, manager: &Arc<RetainingBackgroundManager>) -> ToolContext {
    ToolContext {
        background: Some(Arc::clone(manager) as Arc<dyn BackgroundTaskManager>),
        ..ctx(ws)
    }
}

/// 构造带自定义促进窗口系统默认的工具（把 20s 系统默认换成小值以便
/// 验证缺省路径，不改生产默认数值）
fn tool_with_promote_default(promote_default_ms: u64) -> ShellCommandTool {
    ShellCommandTool::with_background_manager(
        30_000,
        200_000,
        None,
        Arc::new(NoopAuditSink),
        None,
        promote_default_ms,
    )
}

/// BG4 验收（execute 路径）：sync（缺省模式）+ 显式促进窗口——窗口
/// 到点返回 background 信封（不等命令跑完）、adopt 恰好一次、进程在
/// manager 中存活且状态可查、kill 可终止（进程消失、状态转 Killed）
#[tokio::test]
async fn sync_promote_explicit_window_adopts_and_task_survives() {
    let ws = TempWorkspace::new("bg4_sync_promote");
    let manager = Arc::new(RetainingBackgroundManager::new());
    let ctx = bg_ctx(&ws, &manager);
    let t = tool();
    let started = std::time::Instant::now();
    let out = t
        .execute(
            &ctx,
            json!({
                "command": sleep_cmd(30),
                "waitMsBeforeAsync": 300,
                "timeoutMs": 30000
            }),
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(out["mode"], "background", "sync 超窗应转后台：{out}");
    assert!(
        out.get("timedOut").is_none(),
        "转后台信封不得带 timedOut：{out}"
    );
    let task_id = out["taskId"].as_str().unwrap().to_string();
    assert!(task_id.starts_with("task-"), "taskId 命名风格 task-<seq>");
    assert!(
        elapsed < Duration::from_secs(20),
        "应在促进窗口到点即返回而非等 30s 命令跑完，实际 {elapsed:?}"
    );
    assert_eq!(manager.adopt_count(), 1, "adopt 必须恰好调用一次");
    // 进程在 manager 中存活、状态可查
    let pid = manager.pid_of(&task_id).expect("adopt 应记录 pid");
    assert!(process_alive(pid), "转后台后进程必须存活");
    let status = manager.status(&task_id).await.unwrap();
    assert_eq!(status.status, TaskState::Running, "任务应处于运行中");
    // 可终止：kill 后进程消失、状态转 Killed
    let killed = manager.kill(&task_id).await.unwrap();
    assert!(
        matches!(killed, KillResult::Killed { .. }),
        "kill 应成功终止：{killed:?}"
    );
    for _ in 0..50 {
        if !process_alive(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!process_alive(pid), "kill 后进程必须消失");
    let status = manager.status(&task_id).await.unwrap();
    assert_eq!(status.status, TaskState::Killed, "终止后状态应为 Killed");
}

/// BG4 验收：sync + 未传 waitMsBeforeAsync——走系统默认促进窗口
/// （本测试经构造注入小值验证缺省路径，生产默认 20s 不变）
#[tokio::test]
async fn sync_promote_system_default_window_adopts() {
    let ws = TempWorkspace::new("bg4_sync_promote_default");
    let manager = Arc::new(RetainingBackgroundManager::new());
    let ctx = bg_ctx(&ws, &manager);
    let t = tool_with_promote_default(300);
    let out = t
        .execute(
            &ctx,
            json!({ "command": sleep_cmd(30), "timeoutMs": 30000 }),
        )
        .await
        .unwrap();
    assert_eq!(
        out["mode"], "background",
        "系统默认促进窗口到点应转后台：{out}"
    );
    assert_eq!(manager.adopt_count(), 1, "adopt 必须恰好调用一次");
    let task_id = out["taskId"].as_str().unwrap().to_string();
    let _ = manager.kill(&task_id).await;
}

/// BG4 验收：显式 timeoutMs 小于促进窗口——窗口与 timeoutMs 重合，
/// 到点即契约超时本身：仍树杀 + timedOut，绝不 adopt
#[tokio::test]
async fn sync_small_timeout_ms_keeps_contract_timeout() {
    let ws = TempWorkspace::new("bg4_sync_small_timeout");
    let manager = Arc::new(RetainingBackgroundManager::new());
    let ctx = bg_ctx(&ws, &manager);
    let t = tool();
    let out = t
        .execute(
            &ctx,
            json!({ "command": sleep_cmd(10), "timeoutMs": 800 }),
        )
        .await
        .unwrap();
    assert_eq!(
        out["timedOut"], true,
        "timeoutMs 小于促进窗口时到点即契约超时：{out}"
    );
    assert_eq!(out["mode"], "sync");
    assert_eq!(manager.adopt_count(), 0, "契约超时不得 adopt");
}

/// BG4 验收：manager 不在场——促进窗口不生效，sync 按 timeoutMs
/// 全程等待后树杀 + timedOut（现行语义零回归；若误在 300ms 窗口
/// 收口，本测试耗时断言会失败）
#[tokio::test]
async fn sync_without_manager_promote_window_ignored() {
    let ws = TempWorkspace::new("bg4_sync_no_manager");
    let t = tool();
    let started = std::time::Instant::now();
    let out = t
        .execute(
            &ctx(&ws),
            json!({
                "command": sleep_cmd(30),
                "waitMsBeforeAsync": 300,
                "timeoutMs": 4000
            }),
        )
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(out["timedOut"], true, "未接线时超时仍走树杀：{out}");
    assert_eq!(out["mode"], "sync");
    assert!(
        elapsed >= Duration::from_millis(3000),
        "manager 不在场时促进窗口不得生效，应按 timeoutMs 等待后收口，实际 {elapsed:?}"
    );
}

/// BG4 验收（流式路径 execute_stream）：sync 流式等待超促进窗口——
/// Terminal 为 background 信封、adopt 恰好一次（生产链路经
/// execute_stream 消费，本路径与 execute 同口径）
#[tokio::test]
async fn stream_sync_promote_adopts() {
    let ws = TempWorkspace::new("bg4_stream_promote");
    let manager = Arc::new(RetainingBackgroundManager::new());
    let ctx = bg_ctx(&ws, &manager);
    let t = tool();
    let mut stream = t
        .execute_stream(
            &ctx,
            json!({
                "command": sleep_cmd(30),
                "waitMsBeforeAsync": 300,
                "timeoutMs": 30000
            }),
        )
        .await;
    let mut terminal = None;
    while let Some(item) = stream.next().await {
        if let ToolStreamItem::Terminal(result) = item {
            terminal = Some(result);
            break;
        }
    }
    let out = terminal
        .expect("流必须产出 Terminal")
        .expect("促进收口不得为 Err");
    assert_eq!(out["mode"], "background", "流式 sync 超窗应转后台：{out}");
    assert!(out["taskId"].as_str().is_some(), "信封应含 taskId");
    assert_eq!(manager.adopt_count(), 1, "adopt 必须恰好调用一次");
    let task_id = out["taskId"].as_str().unwrap().to_string();
    let _ = manager.kill(&task_id).await;
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
