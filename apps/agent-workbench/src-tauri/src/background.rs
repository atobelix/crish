//! 后台任务注册表最小底座（G1 / T-AB-07）
//!
//! 职责（本轮）：
//! - [BackgroundTaskRegistry]：任务注册表（`task-<seq>` 命名空间独立于 pty id）、
//!   日志根（`host_paths::app_dir()/logs/tasks`）、保留时长（默认 30 分钟，可注入）；
//! - [TaskHandle]：任务句柄骨架（info + child + writer + sampler 空位）——
//!   writer 做「stdout/stderr → 内存预览 + 行计数」转发循环，落盘留 R-AB2 T-AB-09；
//! - 六方法 trait 实现：adopt / list / status 实装，read_log / send_input / kill
//!   占位（Unsupported 风格，任务卡明示占位行为）。
//!
//! 回收语义：run 结束不回收任务（会话级存活）；应用退出 → daemon Job 兜底全杀
//! （process.rs DAEMON_JOB_OBJECT，adopt 时接线，best-effort）。孤儿句柄：
//! adopt 转移时 `kill_on_drop(false)` 由 T-AB-02 保证，drop 不杀子进程。
//!
//! 命令面（T-AB-08）：workbench_list_background_tasks / workbench_get_background_task_output /
//! workbench_cancel_background_task 三条 Tauri 命令，薄包装本注册表；契约测试
//! 直调 [build_list_response] / [build_output_response]（构造注册表即构造 State，
//! 不依赖 Tauri runtime）。

use crate::core_error::CoreError;
use crate::process::now_millis;
use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskRef,
    BackgroundTaskStatus, KillResult, LogSlice, TaskState,
};
use agent_tools::definition::ToolError;
use conex_types::error::codes;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};
use tokio::process::{Child, ChildStderr, ChildStdout};
use tokio::task::JoinHandle;

// ============================================================================
// 契约来源说明（跨 Agent 冻结接口，只读消费）
// ----------------------------------------------------------------------------
// trait `BackgroundTaskManager` 与全部数据结构（TaskState / BackgroundTaskInfo /
// BackgroundTaskStatus / BackgroundAdoptRequest / BackgroundTaskRef / KillResult /
// LogSlice / ResourceSample）由 A1 在 `crates/agent-tools/src/background.rs` 落地
// （T-AB-02，形状与方案 §4.1 / §4.2 / §4.4 逐字一致），经 `agent_tools` crate
// 根导出。本文件只消费不修改——壳层实现（impl BackgroundTaskManager for
// BackgroundTaskRegistry）即契约的实现面。
// ============================================================================

// ============================================================================
// 注册表与任务句柄
// ============================================================================

/// 默认保留时长：任务终止后 30 分钟归档（清内存条目与 .meta.json，R-AB2 落地）
const DEFAULT_RETENTION: Duration = Duration::from_secs(30 * 60);

/// 内存预览行数上限（status.tail 取末 20 行，留余量）
const PREVIEW_MAX_LINES: usize = 200;
/// 内存预览字节上限（有界：长输出命令不驻留全量内存，落盘留 R-AB2）
const PREVIEW_MAX_BYTES: usize = 64 * 1024;

/// 后台任务注册表（G1 最小底座）
///
/// - `tasks`: 任务注册表（Arc<TaskHandle>，writer 与查询方共享）；
/// - `task_seq`: `task-<seq>` 命名（命名空间独立于 pty id `pty/mod.rs:104-111`）；
/// - `log_root`: 任务日志根（`host_paths::app_dir()` 同款，`process.rs:168-174`）；
/// - `retention`: 保留时长（默认 30 分钟，可注入便于测试；归档清理 R-AB2 落地）。
#[derive(Debug)]
pub struct BackgroundTaskRegistry {
    tasks: Mutex<HashMap<String, Arc<TaskHandle>>>,
    task_seq: AtomicU64,
    log_root: PathBuf,
    #[allow(dead_code)] // R-AB2 归档清理（保留语义）时消费
    retention: Duration,
}

/// 任务句柄骨架（所有权在托管方）
///
/// - `info`: 任务快照（冻结形状，writer 维护状态机字段）；
/// - `child`: 子进程所有权（Arc 共享给 writer 收尾 take + wait；drop 不杀——
///   kill_on_drop 已由 T-AB-02 关闭；R-AB2 kill 亦经此槽取句柄终止）；
/// - `writer`: 转发循环任务（stdout/stderr → 内存预览 + 行计数；落盘留 R-AB2）；
/// - `preview`: 内存预览（有界行缓冲，status.tail 消费）；
/// - `sampler`: 资源采样任务空位（R-AB3 填充）。
#[derive(Debug)]
pub(crate) struct TaskHandle {
    info: Arc<RwLock<BackgroundTaskInfo>>,
    #[allow(dead_code)] // R-AB2 kill（T-AB-11）经此槽 take 子进程终止；本轮 writer 走克隆
    child: Arc<Mutex<Option<Child>>>,
    #[allow(dead_code)] // R-AB2 归档清理（retention 到期）时 join 收口 writer
    writer: JoinHandle<()>,
    #[allow(dead_code)] // R-AB3 资源采样（A04）时消费
    sampler: Option<JoinHandle<()>>,
    preview: Arc<Mutex<OutputPreview>>,
}

/// 输出内存预览（转发器维护；有界）
#[derive(Debug, Default)]
struct OutputPreview {
    /// 最近行环形缓冲（status.tail 取末 20 行）
    recent_lines: VecDeque<String>,
    /// 预览占用字节数（行级上限）
    recent_bytes: usize,
}

impl OutputPreview {
    fn push_line(&mut self, line: String) {
        self.recent_bytes += line.len();
        self.recent_lines.push_back(line);
        while self.recent_lines.len() > PREVIEW_MAX_LINES || self.recent_bytes > PREVIEW_MAX_BYTES
        {
            if let Some(popped) = self.recent_lines.pop_front() {
                self.recent_bytes = self.recent_bytes.saturating_sub(popped.len());
            }
        }
    }

    /// 取最近 max 行（不足则全量；空输出返回空数组）
    fn tail_lines(&self, max: usize) -> Vec<String> {
        let skip = self.recent_lines.len().saturating_sub(max);
        self.recent_lines.iter().skip(skip).cloned().collect()
    }
}

impl BackgroundTaskRegistry {
    /// 默认构造：日志根 = `host_paths::app_dir()/logs/tasks`（不可用时回退系统
    /// 临时目录，不阻断启动）；保留 30 分钟。Windows 侧同时初始化 daemon Job
    /// 兜底（best-effort）。
    pub fn new() -> Self {
        let log_root = crate::host_paths::app_dir()
            .map(|app| app.join("logs").join("tasks"))
            .unwrap_or_else(|e| {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "app_dir 不可用，任务日志根回退系统临时目录"
                );
                std::env::temp_dir().join("crish-background-tasks")
            });
        Self::with_log_root(log_root, DEFAULT_RETENTION)
    }

    /// 注入式构造（测试/嵌入场景）：显式日志根与保留时长。
    pub fn with_log_root(log_root: PathBuf, retention: Duration) -> Self {
        let registry = Self {
            tasks: Mutex::new(HashMap::new()),
            task_seq: AtomicU64::new(0),
            log_root,
            retention,
        };
        // Windows：daemon Job 兜底（应用退出 → 宿主句柄关闭 → 后台任务树全杀；
        // 与 PTY Job 相互隔离，见 process.rs Job Objects 段）
        #[cfg(windows)]
        if let Err(e) = crate::process::init_daemon_job_object() {
            tracing::warn!(
                target: "background",
                error = %e,
                "daemon job object init failed; 后台任务孤儿保护降级为显式 kill 兜底"
            );
        }
        registry
    }

    /// 任务是否命中终态（归档/过滤判定用）。
    fn is_terminal(state: TaskState) -> bool {
        matches!(state, TaskState::Completed | TaskState::Failed | TaskState::Killed)
    }

    /// 任务不存在统一错误（NotFound 风格，命令面透传为 CoreError::NotFound）。
    fn not_found(task_id: &str) -> ToolError {
        ToolError::new(
            codes::TOOL_NOT_FOUND,
            format!("后台任务不存在：{task_id}"),
        )
    }

    /// 未落地能力统一占位错误（Unsupported 风格；R-AB2/R-AB3 补齐后移除）。
    fn unsupported(what: impl Into<String>) -> ToolError {
        ToolError::new(codes::COMMON_UNSUPPORTED, what)
    }

    /// 取任务句柄（不存在 → NotFound）。
    fn get_handle(&self, task_id: &str) -> Result<Arc<TaskHandle>, ToolError> {
        let tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        tasks
            .get(task_id)
            .cloned()
            .ok_or_else(|| Self::not_found(task_id))
    }

    /// 命令摘要（前 64 字符）。
    fn summarize_command(command: &str) -> String {
        const MAX: usize = 64;
        if command.chars().count() <= MAX {
            command.to_string()
        } else {
            let truncated: String = command.chars().take(MAX).collect();
            format!("{truncated}…")
        }
    }
}

impl Default for BackgroundTaskRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl BackgroundTaskManager for BackgroundTaskRegistry {
    /// adopt：登记任务 + 接线 daemon Job（Windows，best-effort）+ 启动转发循环。
    ///
    /// 诚实边界：Windows 8+ 支持嵌套 Job，本机实测分配成功（宿主 Job 包裹不阻断）；
    /// 若宿主 Job 禁止嵌套，分配会返回拒绝——接线失败仅 warn 降级（孤儿保护退化
    /// 为显式 kill 路径），不阻断注册。调用方契约（T-AB-02）：child 必须以
    /// `kill_on_drop(false)` spawn。
    async fn adopt(&self, req: BackgroundAdoptRequest) -> Result<BackgroundTaskRef, ToolError> {
        let task_id = format!("task-{}", self.task_seq.fetch_add(1, Ordering::Relaxed));
        let log_path = self.log_root.join(format!("{task_id}.log"));
        let started_at_ms = now_millis() as u64;
        let command = Self::summarize_command(&req.command);
        let cwd = req.cwd.display().to_string();

        // Windows：daemon Job 接线（best-effort；失败降级不阻断）
        #[cfg(windows)]
        if let Some(pid) = req.child.id() {
            if let Err(e) = crate::process::assign_pid_to_daemon_job(pid) {
                tracing::warn!(
                    target: "background",
                    task_id = %task_id,
                    pid,
                    error = %e,
                    "assign daemon task to job failed; 孤儿保护降级（显式 kill 路径兜底）"
                );
            }
        }

        let mut child = req.child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let info = Arc::new(RwLock::new(BackgroundTaskInfo {
            task_id: task_id.clone(),
            command,
            cwd,
            status: TaskState::Running,
            started_at_ms,
            duration_ms: 0,
            finished_at_ms: None,
            exit_code: None,
            log_path: log_path.display().to_string(),
            line_count: 0,
            last_output_at_ms: started_at_ms,
            is_daemon: req.is_daemon,
            resource: None, // R-AB3 采样
            prompt: None,   // R-AB2 B03
            owner_run_id: req.owner_run_id,
        }));
        let child_slot = Arc::new(Mutex::new(Some(child)));
        let preview = Arc::new(Mutex::new(OutputPreview::default()));

        // 转发循环：双流 → 内存预览 + 行计数；EOF 全闭后收尾（wait + 状态机）。
        // Arc 循环安全：writer 持 shared 克隆，任务完成即释放，无泄漏。
        let writer = tokio::spawn({
            let info = Arc::clone(&info);
            let child_slot = Arc::clone(&child_slot);
            let preview = Arc::clone(&preview);
            async move {
                forward_streams(&info, &preview, stdout, stderr).await;
                finish_task(&info, &child_slot).await;
            }
        });

        let handle = Arc::new(TaskHandle {
            info,
            child: child_slot,
            writer,
            sampler: None,
            preview,
        });
        self.tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(task_id.clone(), Arc::clone(&handle));

        Ok(BackgroundTaskRef { task_id, log_path })
    }

    async fn list(&self, include_finished: bool) -> Result<Vec<BackgroundTaskInfo>, ToolError> {
        let tasks = self
            .tasks
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let now = now_millis() as u64;
        let mut out: Vec<BackgroundTaskInfo> = Vec::with_capacity(tasks.len());
        for handle in tasks.values() {
            let mut info = handle
                .info
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .clone();
            if !include_finished && Self::is_terminal(info.status) {
                continue;
            }
            // 运行中任务：duration 实时计算（终态由 writer 固化）
            if info.finished_at_ms.is_none() {
                info.duration_ms = now.saturating_sub(info.started_at_ms);
            }
            out.push(info);
        }
        // 稳定序：started_at 降序（新在前，前端 sortBackgroundTasksByStartedAt 同口径）
        out.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms));
        Ok(out)
    }

    async fn status(&self, task_id: &str) -> Result<BackgroundTaskStatus, ToolError> {
        let handle = self.get_handle(task_id)?;
        let info = handle
            .info
            .read()
            .unwrap_or_else(|p| p.into_inner());
        let tail = {
            let preview = handle
                .preview
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            preview.tail_lines(20).join("\n")
        };
        let now = now_millis() as u64;
        Ok(BackgroundTaskStatus {
            task_id: info.task_id.clone(),
            status: info.status,
            exit_code: info.exit_code,
            log_path: info.log_path.clone(),
            duration_ms: info
                .finished_at_ms
                .map(|f| f.saturating_sub(info.started_at_ms))
                .unwrap_or_else(|| now.saturating_sub(info.started_at_ms)),
            line_count: info.line_count,
            last_output_at_ms: info.last_output_at_ms,
            resource: info.resource.clone(),
            tail,
            prompt: info.prompt.clone(),
            termination_diagnostics: Vec::new(), // R-AB2 两阶段终止留痕
        })
    }

    /// 占位（R-AB2 T-AB-09 落地：落盘 + 行号范围读取）。任务不存在仍返回
    /// 结构化 NotFound；任务存在返回 Unsupported。
    async fn read_log(
        &self,
        task_id: &str,
        _start_line: Option<u64>,
        _max_lines: u64,
    ) -> Result<LogSlice, ToolError> {
        self.get_handle(task_id)?;
        Err(Self::unsupported(format!(
            "read_log 待 R-AB2 T-AB-09 落地（任务 {task_id}）"
        )))
    }

    /// 占位（R-AB2 T-AB-10 落地：stdin 管道改造 + 写入）。任务不存在仍返回
    /// 结构化 NotFound；任务存在返回 Unsupported。
    async fn send_input(
        &self,
        task_id: &str,
        _text: &str,
        _append_newline: bool,
    ) -> Result<(), ToolError> {
        self.get_handle(task_id)?;
        Err(Self::unsupported(format!(
            "send_input 待 R-AB2 T-AB-10 落地（任务 {task_id}）"
        )))
    }

    /// 占位 kill（R-AB2 T-AB-11 填真实两阶段终止：优雅 → 5s → 强制）。
    /// 本轮语义：任务不存在 → NotFound；终态任务 → AlreadyExited（真实可答）；
    /// 运行中任务 → Unsupported（不假装已终止，命令面透传结构化错误）。
    async fn kill(&self, task_id: &str) -> Result<KillResult, ToolError> {
        let handle = self.get_handle(task_id)?;
        let info = handle
            .info
            .read()
            .unwrap_or_else(|p| p.into_inner());
        if Self::is_terminal(info.status) {
            return Ok(KillResult::AlreadyExited {
                task_id: task_id.to_string(),
                exit_code: info.exit_code,
            });
        }
        Err(Self::unsupported(format!(
            "两阶段终止（优雅→5s→强制）待 R-AB2 T-AB-11 落地（任务 {task_id}）"
        )))
    }
}

// ── 转发循环与收尾 ───────────────────────────────────────────────────────────

/// 单流读取 helper：`reader` 为 None（未接管道）时返回 EOF（Ok(0)）。
async fn read_buf<R: AsyncBufRead + Unpin>(
    reader: Option<&mut R>,
    buf: &mut Vec<u8>,
) -> std::io::Result<usize> {
    match reader {
        Some(r) => r.read_until(b'\n', buf).await,
        None => Ok(0),
    }
}

/// stdout/stderr → 内存预览 + 行计数 转发循环（双流并行，管道满不死锁；
/// EOF 全闭即返回）。落盘留 R-AB2 T-AB-09。
async fn forward_streams(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    preview: &Arc<Mutex<OutputPreview>>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
) {
    let mut out = stdout.map(tokio::io::BufReader::new);
    let mut err = stderr.map(tokio::io::BufReader::new);
    let mut out_line = Vec::with_capacity(4096);
    let mut err_line = Vec::with_capacity(4096);

    loop {
        let out_open = out.is_some();
        let err_open = err.is_some();
        if !out_open && !err_open {
            break;
        }
        tokio::select! {
            r = read_buf(out.as_mut(), &mut out_line), if out_open => {
                match r {
                    Ok(0) => { out = None; }
                    Ok(_) => { append_output_line(info, preview, &mut out_line); }
                    Err(e) => {
                        tracing::debug!(target: "background", error = %e, "stdout 读取失败，提前 EOF");
                        out = None;
                    }
                }
            }
            r = read_buf(err.as_mut(), &mut err_line), if err_open => {
                match r {
                    Ok(0) => { err = None; }
                    Ok(_) => { append_output_line(info, preview, &mut err_line); }
                    Err(e) => {
                        tracing::debug!(target: "background", error = %e, "stderr 读取失败，提前 EOF");
                        err = None;
                    }
                }
            }
        }
    }
}

/// 行级累积：剥离行尾 \r\n → 预览 + 行计数 + 最近输出时间。
fn append_output_line(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    preview: &Arc<Mutex<OutputPreview>>,
    raw: &mut Vec<u8>,
) {
    while matches!(raw.last(), Some(b'\n') | Some(b'\r')) {
        raw.pop();
    }
    // 空行也是行（行计数语义），不跳过
    let line = String::from_utf8_lossy(raw).into_owned();
    let now = now_millis() as u64;
    if let Ok(mut info_guard) = info.write() {
        info_guard.line_count += 1;
        info_guard.last_output_at_ms = now;
    }
    if let Ok(mut preview_guard) = preview.lock() {
        preview_guard.push_line(line);
    }
    raw.clear();
}

/// 收尾：双流 EOF 后取 child 收口（wait），状态机推进到终态
/// （Completed / Failed / Killed）。锁不在 await 点持有。
async fn finish_task(
    info: &Arc<RwLock<BackgroundTaskInfo>>,
    child: &Arc<Mutex<Option<Child>>>,
) {
    let child = child
        .lock()
        .map(|mut guard| guard.take())
        .unwrap_or(None);
    let (state, exit_code) = match child {
        Some(mut child) => match child.wait().await {
            Ok(status) => {
                if status.success() {
                    (TaskState::Completed, status.code())
                } else {
                    (TaskState::Failed, status.code())
                }
            }
            Err(e) => {
                tracing::warn!(
                    target: "background",
                    error = %e,
                    "wait 子进程收口失败，按 Failed 收场"
                );
                (TaskState::Failed, None)
            }
        },
        // child 被 kill 提前取走（本轮占位 kill 不会发生；R-AB2 消费）
        None => (TaskState::Killed, None),
    };
    let finished_at_ms = now_millis() as u64;
    if let Ok(mut info_guard) = info.write() {
        info_guard.status = state;
        info_guard.exit_code = exit_code;
        info_guard.finished_at_ms = Some(finished_at_ms);
        info_guard.duration_ms = finished_at_ms.saturating_sub(info_guard.started_at_ms);
    }
}

// ============================================================================
// 命令面（T-AB-08：三条 Tauri 命令恢复）
// ============================================================================

/// list 命令响应：`{ tasks: [...] }`（对齐前端 extractBackgroundTaskArray 取
/// `root.tasks` 的解析面）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskListResponse {
    pub(crate) tasks: Vec<BackgroundTaskWire>,
}

/// 列表条目 wire 形状：字段对齐前端 parseBackgroundTask（taskId/command/
/// startedAt/duration/status/logPath；serde camelCase）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskWire {
    pub(crate) task_id: String,
    pub(crate) command: String,
    /// kebab-case 状态（前端 normalizeBackgroundTaskState 容错映射）
    pub(crate) status: TaskState,
    /// 毫秒时间戳（parseBackgroundTaskStartedAt 直读）
    pub(crate) started_at: u64,
    /// 毫秒
    pub(crate) duration: u64,
    pub(crate) finished_at: Option<u64>,
    pub(crate) exit_code: Option<i32>,
    pub(crate) log_path: String,
    pub(crate) line_count: u64,
    pub(crate) last_output_at: u64,
    pub(crate) is_daemon: bool,
    pub(crate) owner_run_id: Option<String>,
}

impl BackgroundTaskWire {
    fn from_info(info: &BackgroundTaskInfo) -> Self {
        Self {
            task_id: info.task_id.clone(),
            command: info.command.clone(),
            status: info.status,
            started_at: info.started_at_ms,
            duration: info.duration_ms,
            finished_at: info.finished_at_ms,
            exit_code: info.exit_code,
            log_path: info.log_path.clone(),
            line_count: info.line_count,
            last_output_at: info.last_output_at_ms,
            is_daemon: info.is_daemon,
            owner_run_id: info.owner_run_id.clone(),
        }
    }
}

/// get_output 命令响应：`{ output, ...status 全字段 }`——`output` 字段供前端
/// parseBackgroundTaskOutput 直通取用（`o.output` 优先级最高）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskOutputResponse {
    /// 输出预览（= status.tail；前端 parseBackgroundTaskOutput 直读）
    pub(crate) output: String,
    /// 任务状态快照（flatten 展开为顶层字段）
    #[serde(flatten)]
    pub(crate) status: BackgroundTaskStatus,
}

/// ToolError → CoreError（命令面统一错误协议；NotFound 保形，其余 Internal 兜底，
/// 不静默吞错）。
fn tool_err_to_core(err: ToolError) -> CoreError {
    if err.code() == codes::TOOL_NOT_FOUND {
        CoreError::NotFound(err.to_string())
    } else {
        CoreError::Internal(err.to_string())
    }
}

/// list 命令契约体（测试直调，不依赖 Tauri runtime）。
pub(crate) async fn build_list_response(
    registry: &BackgroundTaskRegistry,
) -> Result<BackgroundTaskListResponse, CoreError> {
    let infos = registry.list(true).await.map_err(tool_err_to_core)?;
    let tasks = infos.iter().map(BackgroundTaskWire::from_info).collect();
    Ok(BackgroundTaskListResponse { tasks })
}

/// get_output 命令契约体（测试直调，不依赖 Tauri runtime）。
pub(crate) async fn build_output_response(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
) -> Result<BackgroundTaskOutputResponse, CoreError> {
    let status = registry.status(task_id).await.map_err(tool_err_to_core)?;
    Ok(BackgroundTaskOutputResponse {
        output: status.tail.clone(),
        status,
    })
}

/// 列出全部后台任务（含已结束），`{ tasks: [...] }`。
#[tauri::command]
pub(crate) async fn workbench_list_background_tasks(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
) -> Result<BackgroundTaskListResponse, CoreError> {
    build_list_response(state.inner()).await
}

/// 查询单任务状态与输出（运行中同样可读；未知 taskId → CoreError::NotFound）。
#[tauri::command]
pub(crate) async fn workbench_get_background_task_output(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
) -> Result<BackgroundTaskOutputResponse, CoreError> {
    build_output_response(state.inner(), &task_id).await
}

/// 取消后台任务（本轮接线到 registry 占位 kill；R-AB2 填真实两阶段终止，
/// 返回 KillResult 形状）。
#[tauri::command]
pub(crate) async fn workbench_cancel_background_task(
    state: tauri::State<'_, Arc<BackgroundTaskRegistry>>,
    task_id: String,
) -> Result<KillResult, CoreError> {
    state.inner().kill(&task_id).await.map_err(tool_err_to_core)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::Path;
    use std::process::Stdio;

    const LONG_COMMAND: &str = if cfg!(windows) {
        "Start-Sleep -Seconds 20"
    } else {
        "sleep 20"
    };
    /// 持续产出输出（~4s，每 100ms 一行；tail 增长断言用）
    const OUTPUT_COMMAND: &str = if cfg!(windows) {
        "1..40 | ForEach-Object { Write-Output ('line ' + $_); Start-Sleep -Milliseconds 100 }"
    } else {
        "i=0; while [ $i -lt 40 ]; do echo line $i; i=$((i+1)); sleep 0.1; done"
    };

    /// 真实 spawn 测试子进程（kill_on_drop=false + 双管道，对齐 T-AB-02 契约）。
    fn spawn_test_child(command: &str) -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = tokio::process::Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", command]);
            c
        } else {
            let mut c = tokio::process::Command::new("bash");
            c.args(["-c", command]);
            c
        };
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        cmd.spawn().expect("spawn test child")
    }

    fn test_registry() -> BackgroundTaskRegistry {
        let root = std::env::temp_dir().join(format!("crish-bg-test-{}", std::process::id()));
        BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(30 * 60))
    }

    fn adopt_request(
        child: Child,
        command: &str,
        cwd: &Path,
        is_daemon: bool,
        owner_run_id: Option<String>,
    ) -> BackgroundAdoptRequest {
        BackgroundAdoptRequest {
            child,
            command: command.to_string(),
            cwd: cwd.to_path_buf(),
            is_daemon,
            resource_monitor: false,
            owner_run_id,
        }
    }

    /// 轮询至终态（窗口内未到则 panic）。
    async fn wait_for_terminal(
        registry: &BackgroundTaskRegistry,
        task_id: &str,
        window: Duration,
    ) -> BackgroundTaskStatus {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let status = registry.status(task_id).await.expect("status");
            if BackgroundTaskRegistry::is_terminal(status.status) {
                return status;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务 {task_id} 未在窗口内进入终态：{status:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 轮询至 tail 非空（输出命令断言用）。
    async fn wait_until_tail_non_empty(
        registry: &BackgroundTaskRegistry,
        task_id: &str,
        window: Duration,
    ) -> BackgroundTaskStatus {
        let deadline = tokio::time::Instant::now() + window;
        loop {
            let status = registry.status(task_id).await.expect("status");
            if !status.tail.is_empty() {
                return status;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "任务 {task_id} 迟迟无输出"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .expect("tasklist must run");
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    #[cfg(not(windows))]
    fn pid_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// T-AB-07 验收：adopt 真实长命令 → list 可见、status Running、pid 存活。
    #[tokio::test]
    async fn registry_adopt_and_list() {
        let registry = test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");

        let task_ref = registry
            .adopt(adopt_request(child, "long-run", Path::new("."), false, None))
            .await
            .expect("adopt");
        assert!(task_ref.task_id.starts_with("task-"));
        assert!(
            task_ref
                .log_path
                .to_string_lossy()
                .ends_with(&format!("{}.log", task_ref.task_id)),
            "log_path 应为 <log_root>/<task_id>.log"
        );
        assert!(pid_is_alive(pid), "adopt 后进程必须存活");

        let infos = registry.list(false).await.expect("list");
        assert_eq!(infos.len(), 1, "活跃列表应含刚 adopt 的任务");
        assert_eq!(infos[0].task_id, task_ref.task_id);
        assert_eq!(infos[0].status, TaskState::Running);

        let status = registry.status(&task_ref.task_id).await.expect("status");
        assert_eq!(status.status, TaskState::Running);
        assert!(status.tail.is_empty(), "长命令尚未产出输出");

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-07 验收（注册表侧语义）：同步完成的命令即使「迟到 adopt」，状态机
    /// 也能正确收敛到 Completed（exit_code=0），不产生 Running 僵尸条目。
    /// 「等待窗口内完成不调用 adopt、不产生条目」由 A1 层（T-AB-02）保证——
    /// 注册表只在 adopt 被调用时登记。
    #[tokio::test]
    async fn registry_no_entry_on_sync_complete() {
        let registry = test_registry();
        let child = spawn_test_child("echo sync-done");
        // 等待自然退出后再 adopt（模拟窗口内已完成的命令）
        tokio::time::sleep(Duration::from_millis(700)).await;

        let task_ref = registry
            .adopt(adopt_request(child, "sync", Path::new("."), false, None))
            .await
            .expect("adopt");
        let status = wait_for_terminal(&registry, &task_ref.task_id, Duration::from_secs(5)).await;
        assert_eq!(status.status, TaskState::Completed);
        assert_eq!(status.exit_code, Some(0));
        // 同步命令不应停留在 Running
        let infos = registry.list(false).await.expect("list");
        assert!(
            infos.is_empty(),
            "同步完成的命令不应出现在活跃列表（终态过滤）"
        );
    }

    /// T-AB-07 验收：自然退出 → Completed（exit 0）／Failed（exit != 0）且
    /// exitCode / duration 正确。
    #[tokio::test]
    async fn registry_state_machine() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // Completed 路径
        let child = spawn_test_child("exit 0");
        let r1 = registry
            .adopt(adopt_request(child, "ok-cmd", &cwd, false, None))
            .await
            .expect("adopt ok");
        let s1 = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(5)).await;
        assert_eq!(s1.status, TaskState::Completed);
        assert_eq!(s1.exit_code, Some(0));
        // 终态固化：list 快照含 finishedAtMs，且不早于 startedAtMs
        let all = registry.list(true).await.expect("list");
        let fin1 = all
            .iter()
            .find(|i| i.task_id == r1.task_id)
            .expect("完成条目存在");
        let finished1 = fin1.finished_at_ms.expect("终态应有 finishedAtMs");
        assert!(finished1 >= fin1.started_at_ms, "finishedAtMs 不应早于 startedAtMs");

        // Failed 路径
        let child = spawn_test_child("exit 7");
        let r2 = registry
            .adopt(adopt_request(child, "fail-cmd", &cwd, false, None))
            .await
            .expect("adopt fail");
        let s2 = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(5)).await;
        assert_eq!(s2.status, TaskState::Failed);
        assert_eq!(s2.exit_code, Some(7));
        let all = registry.list(true).await.expect("list");
        let fin2 = all
            .iter()
            .find(|i| i.task_id == r2.task_id)
            .expect("失败条目存在");
        assert!(
            fin2.finished_at_ms.is_some(),
            "Failed 终态同样固化 finishedAtMs"
        );
        assert!(fin2.duration_ms > 0, "Failed 计时合理（exit 7 经 wait 收口）");
    }

    /// T-AB-07 验收：任务 id 唯一且带 task- 前缀（命名空间独立于 pty id）。
    #[tokio::test]
    async fn task_ids_are_unique_and_prefixed() {
        let registry = test_registry();
        let mut seen = HashSet::new();
        for i in 0..3 {
            let child = spawn_test_child(LONG_COMMAND);
            let pid = child.id().expect("spawned pid");
            let task_ref = registry
                .adopt(adopt_request(child, &format!("cmd-{i}"), Path::new("."), false, None))
                .await
                .expect("adopt");
            assert!(task_ref.task_id.starts_with("task-"), "id 格式: {}", task_ref.task_id);
            assert!(
                seen.insert(task_ref.task_id.clone()),
                "重复 task id: {}",
                task_ref.task_id
            );
            let _ = crate::process::terminate_process_tree(pid);
        }
        assert_eq!(seen.len(), 3, "连续 adopt 不得产生重复 id");
    }

    /// 占位方法的结构化语义：NotFound（未知 id）／Unsupported（已知 id），
    /// 不静默返回空值。
    #[tokio::test]
    async fn registry_placeholder_methods_are_structured() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // 未知 id → NotFound
        let err = registry.read_log("task-nope", None, 100).await.expect_err("read_log");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
        let err = registry
            .send_input("task-nope", "hi", true)
            .await
            .expect_err("send_input");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);

        // 已知 id → Unsupported（R-AB2 补齐前不假装实现）
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r = registry
            .adopt(adopt_request(child, "placeholder", &cwd, false, None))
            .await
            .expect("adopt");
        let err = registry.read_log(&r.task_id, None, 100).await.expect_err("read_log");
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);
        let err = registry
            .send_input(&r.task_id, "hi", true)
            .await
            .expect_err("send_input");
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-08 验收：list 契约——`{ tasks: [...] }`，每条含 taskId/command/
    /// startedAt/duration/status/logPath（命令直调，构造 registry 即构造 State）。
    #[tokio::test]
    async fn workbench_list_background_tasks_contract() {
        let registry = test_registry();
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        registry
            .adopt(adopt_request(child, "list-contract", Path::new("."), false, None))
            .await
            .expect("adopt");

        let response = build_list_response(&registry).await.expect("build_list_response");
        let json = serde_json::to_value(&response).expect("serialize");
        assert!(json.get("tasks").is_some(), "响应必须含 tasks 数组");
        let tasks = json["tasks"].as_array().expect("tasks 数组");
        assert_eq!(tasks.len(), 1, "应恰有 1 条任务");

        let task = &tasks[0];
        for key in ["taskId", "command", "startedAt", "duration", "status", "logPath"] {
            assert!(
                task.get(key).is_some(),
                "列表条目缺字段 {key}: {task}"
            );
        }
        assert_eq!(task["status"], "running", "运行中任务 status=running");
        assert_eq!(task["command"], "list-contract");
        assert!(
            task["startedAt"].as_u64().unwrap() > 0,
            "startedAt 为毫秒时间戳"
        );

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-08 验收：get_output 契约——运行中任务返回非空 tail 且随输出增长；
    /// 未知 taskId → NotFound 风格错误（结构化，非 null 非静默）。
    #[tokio::test]
    async fn workbench_get_background_task_output_contract() {
        let registry = test_registry();
        let child = spawn_test_child(OUTPUT_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r = registry
            .adopt(adopt_request(child, "output-contract", Path::new("."), false, None))
            .await
            .expect("adopt");

        let first = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(5)).await;
        assert!(!first.tail.is_empty(), "运行中任务 tail 必须非空");
        let first_lines = first.line_count;
        assert!(first_lines > 0, "行计数应 > 0");

        // 输出随运行增长
        tokio::time::sleep(Duration::from_millis(700)).await;
        let second = registry.status(&r.task_id).await.expect("status");
        assert!(
            second.line_count > first_lines,
            "输出应随运行增长：{first_lines} -> {}",
            second.line_count
        );

        // output 字段（前端 parseBackgroundTaskOutput 直通取 output）
        let response = build_output_response(&registry, &r.task_id).await.expect("build_output_response");
        assert_eq!(response.output, second.tail, "output 应等于最新 tail");
        let json = serde_json::to_value(&response).expect("serialize");
        assert_eq!(json["output"], second.tail, "wire 面 output 直通");
        assert_eq!(json["taskId"], r.task_id);

        // 未知 taskId → NotFound 风格错误
        let err = build_output_response(&registry, "task-999999").await.expect_err("unknown id");
        assert!(
            matches!(err, CoreError::NotFound(_)),
            "未知 taskId 应返回 NotFound，实际 {err:?}"
        );

        let _ = crate::process::terminate_process_tree(pid);
    }

    /// T-AB-08 验收：cancel 契约——未知 → NotFound；运行中 → Unsupported 占位
    /// （不静默）；终态 → AlreadyExited（真实可答，KillResult 形状）。
    #[tokio::test]
    async fn workbench_cancel_background_task_contract() {
        let registry = test_registry();
        let cwd = std::env::current_dir().expect("cwd");

        // 未知 → NotFound
        let err = registry.kill("task-nope").await.expect_err("kill unknown");
        assert_eq!(err.code(), codes::TOOL_NOT_FOUND);

        // 运行中 → Unsupported（占位；R-AB2 填真实两阶段终止）
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        let r1 = registry
            .adopt(adopt_request(child, "cancel-running", &cwd, false, None))
            .await
            .expect("adopt");
        let err = registry.kill(&r1.task_id).await.expect_err("kill running");
        assert_eq!(err.code(), codes::COMMON_UNSUPPORTED);

        // 终态 → AlreadyExited（KillResult 形状）
        let child = spawn_test_child("exit 0");
        let r2 = registry
            .adopt(adopt_request(child, "cancel-finished", &cwd, false, None))
            .await
            .expect("adopt");
        let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(5)).await;
        let result = registry.kill(&r2.task_id).await.expect("kill terminal");
        match result {
            KillResult::AlreadyExited { task_id, exit_code } => {
                assert_eq!(task_id, r2.task_id);
                assert_eq!(exit_code, Some(0));
            }
            other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
        }

        let _ = crate::process::terminate_process_tree(pid);
    }
}
